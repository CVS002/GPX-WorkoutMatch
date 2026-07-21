# Maintaining the caches (road knowledge, OSM, streets, workout bank)

Read this when a cache needs building or refreshing — it is not needed during
a normal design session. The day-to-day flow only touches these when
`score_route.py` reports low coverage (when a route scores low coverage) or the
athlete asks for a refresh.

## Layer 2 — ride-history road DB (`data/cache/road_db.json`)

The ride-history cache is what makes road scoring good, and it improves with
more history. Build or refresh it when the athlete asks, or offer to when a
route scores low coverage.

**Build/refresh (via the MCP — the streams API cannot do this):**

1. List rides: `icu_get_activities_by_date` over a wide window (a whole season
   gives far better coverage than the last two weeks). Keep only entries with
   `type == "Ride"` (drop `Run`, `VirtualRide`/indoor, and `type: null`) that
   have a `distance_meters` (i.e. GPS). Prioritise rides in the athlete's home
   area (see `known-roads.md` for this athlete's area) — distant one-off trips
   (training camps, events) add cells that will never match a local route, so
   they are low value to download.
2. For each ride, download its GPX to `data/history/<id>.gpx`:
   `icu_download_gpx_file` with `output_path` set. **Do not use
   `icu_get_activity_streams` for GPS** — this MCP's `latlng` stream returns
   latitude only (longitude is dropped), and the `streams` filter param can't
   be passed through the MCP bridge at all. The GPX export is the only reliable
   source, and it carries full coordinates, timestamps, and speed. (Downloads
   save straight to disk, so they never bloat the conversation. Rides without
   GPS return HTTP 422 — expected; skip them.)
3. Build the cache: `python scripts/build_road_db.py data/history`. It is
   incremental and idempotent — already-cached rides are skipped, so you can
   drop in new GPX files and re-run cheaply. A brand-new cache derives its
   ~50 m grid from the rides' own latitude (portable to any region); an
   existing cache always keeps its stored grid.

A cell counts a "stop" sample on a full stop (< 1.5 m/s) **or a sudden
slowdown** — a hard brake to below ~16 km/h that is also < 55 % of the recent
cruising speed (a give-way or sharp turn the athlete rolls but never fully
halts at). This widened rule only affects rides parsed *after* it was added:
because the cache stores aggregates, applying it to older rides needs a
**full rebuild from a complete history re-pull** (an incremental run skips
already-cached rides and changes nothing).

**Direction-aware (cache v2, 8-way).** Each cell also stores passes and stops
per compass heading bin (`dpass[8]` / `dstop[8]`). `score_route.py` computes the
new route's heading at each point and judges a stop from only the rides that
went *that* way through the cell (heading bin ± 1), falling back to the
sample-rate when a direction is thin. So a give-way that only bites in one
travel direction no longer penalises the reverse direction on an out-and-back.
A schema change from v1 needs a full rebuild (the builder upgrades old cells to
empty direction bins in place, but only a rebuild fills them).

**Workout-aware stops (needs `workout_rides.json`).** For rides listed in
`data/cache/workout_rides.json` (days a structured workout was planned), a
near-stop that lands within ~180 m *after* a sustained fast effort ends is read
as "segment done, I stopped" and is **not** counted as a road stop — the athlete
could have kept riding, the interval was simply over. See Layer 6 below for how
that manifest is built.

Coverage is deliberately conservative: a km counts as "known" only where two or
more separate rides have passed. A handful of rides covers only the most
repeated loops; load a season for broad coverage.

## Layer 5 — effort-corridor cache (`data/cache/effort_db.json`)

The positive mirror of Layer 2: where the athlete has repeatedly *sustained* a
hard effort. Build it from the same GPX history, reusing road_db's grid so the
cells line up:

```bash
python scripts/build_effort_db.py data/history        # grid taken from road_db.json
```

A GPS sample counts as "in effort" when heart rate is above an absolute floor
(**> 165 bpm**, the athlete's own hard-effort HR) AND speed is genuinely fast
(≥ 8.6 m/s ≈ **31 km/h**). This athlete's terrain is flat with no climbs, so a
real hard effort shows up as speed; the two floors together exclude easy tempo
and late-ride HR drift. It qualifies only when the condition holds continuously
for **≥ 90 s** on real timestamps AND is **steady** — the run's speed
coefficient-of-variation must be ≤ `STEADY_CV` (0.22), i.e. "fast *without large
changes in velocity*", a road you could hold rather than a surge-and-coast. Per
cell it stores how many separate rides sustained an effort through it, **plus
8-way direction bins** (`dpass[8]`): `score_effort()` only counts a corridor in
the heading the new route actually travels, so an out-and-back effort road is
credited per direction. `HR_ABS_MIN`, `SPD_FLOOR`, `STEADY_CV` at the top of
`build_effort_db.py` are the knobs to retune if fitness or terrain changes.
`score_route.score_effort()` reads it and `build_map_widget.py` turns it into a
small capped bonus in the composite (`--no-effort` disables). HR is required —
the handful of GPX without HR (old Strava imports) contribute nothing here but
still feed Layer 2.

Like Layer 2 the cache stores aggregates, so widening the effort definition or
adding history means a **full rebuild from a complete re-pull** (the build is
incremental — already-cached activity ids are skipped). Delete the cache first
to rebuild from scratch.

## Layer 6 — learn from planned workouts

The rides that most deserve trust are the days the athlete rode a *planned*
structured workout: the fast, steady stretches are real efforts (not random
sprints), and their stops are usually "segment done" rather than road hazards.
This flow folds those rides in. It is two steps — building the manifest, then
rebuilding the caches.

**Step A — extend `data/cache/workout_rides.json`.**

1. `icu_get_calendar_events` over a wide `days_back` window; keep entries with
   `category == "WORKOUT"` that are outdoor rides (skip indoor turbo sessions —
   ramp / ERG / "%FTP for Nm" structures with no GPS). Each gives a date.
2. For each workout date, find the ride actually done that day
   (`icu_get_activities_by_date` / recent activities → the GPS `Ride`, usually
   the longest that day) and `icu_download_gpx_file` it to `data/history/<id>.gpx`.
3. Record it in `workout_rides.json` under `rides` keyed by activity id
   (`{"date","planned","activity_name"}`), and bump `synced_through`.

The manifest is the only thing that marks a ride "workout"; the GPX itself also
feeds Layers 2 and 5 normally.

**Step B — rebuild the caches.** So the direction bins and workout-aware
suppression apply to the whole history (including older rides), do a full
rebuild of both caches rather than an incremental run:

```bash
python scripts/build_road_db.py data/history       # workout-aware, reads workout_rides.json
python scripts/build_effort_db.py data/history      # grid taken from road_db.json
```

`build_effort_db.py` reads `road_db`'s grid, so build `road_db` first. Both
builds are incremental (already-cached ids are skipped), so to force the
workout-aware stops and direction bins onto old rides, **delete the cache files
first** and rebuild from scratch. Back up each cache to `*.bak` beforehand if
you want a fallback.

**Proposing dossier entries (Layer 4).** Learned corridors enrich the caches
automatically, but `known-roads.md` stays athlete-confirmed: when a designed
route runs along a strong effort corridor (a "⚡ corridor N×" the athlete didn't
already confirm), *offer* to add it to the dossier — don't write it unasked.

## Layer 3 — OSM hazard cache (`data/cache/osm_hazards.json`)

Refresh when you rebuild the road DB or when lights change on the ground:

```bash
python scripts/build_osm_cache.py --radius-km 60    # this athlete's box — USE THIS
python scripts/build_osm_cache.py --bbox S,W,N,E    # or an explicit box
```

**Warning: the bare command defaults to a 40 km radius.** This athlete's box
was deliberately extended to **60 km** — running it without `--radius-km 60`
silently shrinks the cached box (this has happened; it costs a rebuild to
undo). Always pass the radius the athlete is on.

It derives the home box automatically from the densest ride cluster in
`road_db.json`, fetches every traffic signal / level crossing / roundabout /
give-way / stop sign in that box from Overpass once, and writes the cache.
Needs internet only for this build. Afterwards `osm_enrich.py` uses it offline
for any route inside the box; routes outside it still fall back to a live query.
(The turn/priority analysis — `yield_left` / `right_before_left` — is always a
live per-route query and is not part of this cache.)

## Layer 3b — street basemap cache (`data/cache/osm_streets.json`)

Rebuild alongside the hazard cache so the map widget's `--streets` works
offline:

```bash
python scripts/build_street_cache.py                 # arterials in the hazard box
python scripts/build_street_cache.py --classes primary,secondary,tertiary,unclassified,residential,cycleway   # denser (much larger)
```

It reuses the hazard-cache box, fetches road ways once, decimates them, and
writes the cache. That file is large (~13 MB for the arterial skeleton) so it
is **kept local** — rebuild it after installing elsewhere. The widget reads
only the near-route subset, so its size
never bloats the widget itself.

## Workout bank (`data/cache/workout_bank.json`)

2,149 structures from open `.zwo` repos (`build_workout_bank.py`) +
whatsonzwift.com (`build_workout_bank_woz.py` — numeric training facts only).
Category labels and one-line `structure` summaries are heuristic and often
disagree (~49% of entries); every consumer re-validates entries through
`scripts/workout_windows.py` before using them, so refreshing the bank is
optional. To refresh: run either builder; they merge + dedupe.

## Layer 4 — the dossier (`references/known-roads.md`)

Accumulates the athlete's confirmed judgments and outranks every inferred
layer. Keep appending as they confirm, veto, or report back after riding.
