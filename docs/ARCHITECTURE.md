# Architecture

The reference for maintainers. Start with [README.md](../README.md) for setup/run
and [ROADMAP.md](ROADMAP.md) for proposed features. This file explains *how the
pieces fit together* so a change lands in the right place.

## 10-second mental model

A **local, single-user, no-LLM web app**. A Python (FastAPI) server analyses a GPX
route, deterministically designs a structured cycling workout that places its hard
intervals on the *cleanest, effort-ready* stretches of road, renders it on a native
SVG map you can adjust, and pushes it to intervals.icu as a calendar event. All the
"is this stretch of road good for an effort?" intelligence lives in the local
**analysis engine** (`engine/`). Nothing calls an LLM at runtime.

```
browser (web/)  ──HTTP /api/*──▶  FastAPI (server/)  ──imports──▶  engine/ (analysis)
      ▲                                  │                              scripts + caches
      │  native SVG map, wizard          │  REST (httpx, Basic auth)
      └──────────────────────────────────┴────────────────────▶  intervals.icu
```

## The analysis-layer model (the heart of it)

"Which segment of the route can hold an effort?" is answered by fusing independent
evidence layers. Every layer is computed by a vendored engine script and cached under
`engine/data/cache/`. Understanding these is the key to understanding the whole app —
the designer and the map are both just consumers of the fused per-km score.

| Layer | Source | What it contributes | Engine script |
|---|---|---|---|
| **L1 Terrain/geometry** | the GPX itself | effort blocks (straight, stable-gradient stretches), per-km continuity + gradient, climbs | `analyze_gpx.py` |
| **L2 Road-history quality** | your past ride GPX | per-cell stop hotspots (give-ways/junctions you actually brake at), coverage | `build_road_db.py` → `score_route.py` |
| **L3 OSM hazards** | OpenStreetMap (Overpass, cached) | signals, level crossings, roundabouts, give-way/stop signs, turn priority | `build_osm_cache.py` → `osm_enrich.py` |
| **L4 Dossier** | you (confirmed) | athlete-confirmed corrections; **outranks every inferred layer** | `references/known-roads.md` |
| **L5 Effort corridors** | your past ride GPX | where you have repeatedly *sustained* a hard, steady effort (HR + speed) | `build_effort_db.py` → `score_route.score_effort()` |
| **L6 Workout-aware** | planned-workout ride manifest | treats "segment done, I stopped" near-stops as non-hazards | `workout_rides.json` |

`composite_scores()` ([server/engine.py](../server/engine.py)) fuses these into a
per-km score + a ranked list of **placement blocks** (via the engine's
`compute_effort` / `placement_blocks`). Green road on the map == high composite
score == where the designer will try to land an interval. Athlete overrides
(`cleared_km`, from the map's "I ride through this") drop danger points before fusion.

See [engine/references/maintenance.md](../engine/references/maintenance.md) for how
each cache is built/refreshed, and [coaching-engine.md](../engine/references/coaching-engine.md)
for the objective→phase→terrain decision logic the ranking encodes.

## Request/data flow (one design session)

```
1. POST /api/route      upload GPX → L1 + L2 + L3 → route summary; session created
2. GET  /api/context    intervals.icu CTL/ATL/TSB + FTP/FTHR + 14-day load (3 calls, concurrent)
3. POST /api/objectives rank workout categories (TSB gate + phase bias + novelty + terrain)
4. POST /api/workouts   workout bank filtered/renderable for this route length
5. POST /api/select     build a design from the chosen workout  ─┐
   POST /api/design      (auto-pick variant)                     ├─▶ designer.design()
6. GET  /api/mapdata/{id} route geometry + per-km tiers + hazards/stops/streets → native map
7. POST /api/segments   re-validate after a native segment edit (drag/nudge/kind/%)
   POST /api/veto        "I ride through this" → drop km, re-fuse, re-design
   POST /api/rides/*     overlay how fast you actually rode here (past-ride speed)
8. POST /api/push        create the WORKOUT event on intervals.icu (only after review)
```

Strict order is intentional: **the map is reviewed before any date is picked**.
`_estimate_load` / validation run on every edit so the push button only ever sends a
design that already passed the guardrails.

### Server-side session state

`SESSIONS: dict[route_id → dict]` in [server/main.py](../server/main.py) is the only
mutable state — in-memory, single-user, **lost on restart** (by design). Per session:
`gpx`, `haz`, `l1`, `cleared_km`, `design`, `ftp`, `objective`, `title`, plus two
caches keyed on `tuple(cleared_km)`: `_ctx` (analysis layers) and `_mapdata` (native
map JSON). Re-designs and workout browsing reuse `_ctx` instead of re-parsing the GPX.
A `mode: "blank"` session is a no-route, time-based workout (no GPX, no map).

## Module map

### `server/` — FastAPI backend (no LLM)

| Module | Responsibility |
|---|---|
| [main.py](../server/main.py) | FastAPI routes, in-memory `SESSIONS`, per-session `_ctx`/`_mapdata` caches, the `_no_store` + gzip middleware. |
| [config.py](../server/config.py) | All filesystem paths, a hand-rolled `.env` parser, intervals.icu creds, and design constants (`REF_SPEED_KMH`, `KM_PER_MIN`, `BUFFER_KM`). Importing it creates `ROUTES_DIR`. |
| [engine.py](../server/engine.py) | Thin in-process wrappers over the vendored engine scripts (imported as modules, not shelled out): `analyze_route` (L1), `score_roads` (L2), `enrich_osm` (L3), `score_effort` (L5), `composite_scores` (fuse), `rank_objectives`, `bank_candidates`/`list_workouts`/`get_workout`, `summarize_load`. `_field()` tolerates both raw REST (`icu_*`) and old MCP field names. |
| [designer.py](../server/designer.py) | The deterministic designer: `route_context` (run layers once, cached), `design` (route-based), `design_blank` (time-based). Placement logic — `_choose_session`, `_plan_placement`, `_cap`, `_avoid_start` — lands each effort inside a clean block, never on a junction. `_estimate_load` gives TSS/IF/minutes from `REF_SPEED_KMH`. |
| [syntax.py](../server/syntax.py) | Segments → intervals.icu distance syntax (`to_syntax`) + the **guardrail validators** (`validate`, `validate_blank`). See "Guardrails" below. |
| [mapdata.py](../server/mapdata.py) | Reshapes the cached `route_context` into the JSON the native SVG map draws: downsampled polyline, per-km tiers, hazards, stops, top blocks, near-route streets. No heavy compute — reads the session cache. |
| [rides.py](../server/rides.py) | Matches past-ride history GPX against the current route via a ~110 m spatial cell index (`matches`), and serves a downsampled speed `track` for the overlay. Path-traversal guarded (basename + `.gpx` only). |
| [icu.py](../server/icu.py) | intervals.icu REST client (httpx, Basic auth, username literal `"API_KEY"`). `recent_activities`, `fitness`, `sport_settings`, `events`, `create_workout`, and `download_gpx` — which **reconstructs** GPX by fusing `/map` (has longitude) with `/streams` because intervals.icu's `latlng` stream drops longitude and there is no `/gpx` export. |
| [jobs.py](../server/jobs.py) | Background maintenance (daemon threads, in-memory log the UI polls): cache rebuilds, `start_history_refresh` (download ride GPX + rebuild road/effort DBs), `append_known_roads` (L4 dossier writer). Runs builders with `cwd=ENGINE_ROOT`. **Job state is lost on restart.** |

### `web/` — vanilla-JS single-page app (no build step)

| File | Responsibility |
|---|---|
| [index.html](../web/index.html) | Static scaffold for the 4-step wizard (`#s1` Route, `#s2` Form & workout, `#s4` Design & map, `#s5` Schedule) + `#maint` panel + Street View modal. All content injected at runtime. |
| [app.js](../web/app.js) | The controller and **sole caller of `/api/*`**. Central `state` object; `applyDesign` is the render dispatcher (route vs blank mode); native segment editor (`renderSegTable`, `nudgeSeg`, drag `renderTimeline`) debounced through `pushSegments`; past-ride overlay; maintenance polling. |
| [map.js](../web/map.js) | `window.WDMap` — self-contained SVG map. Equirectangular projection, route coloured by road tier, thick effort bands, hazard/stop markers with popovers, past-ride speed overlay, wheel-zoom/pan. Owns **no** HTTP — fires `onVeto`/`onStreetView` callbacks back into app.js. |
| [app.css](../web/app.css) | Theming (light + `prefers-color-scheme: dark`), card layout, resizable map, timeline, content-sized segment table. |

### `engine/` — the analysis engine

The local analysis engine: builder + analysis scripts (`scripts/`), the data caches
(`data/cache/`), the ride-history GPX (`data/history/`), and the reference dossier
(`references/`). This is what actually runs. The caches grow here as ride history and
map corrections accumulate; rebuild them from the Maintenance panel or the CLI (see
[engine/references/maintenance.md](../engine/references/maintenance.md)).

## Guardrails (why a bad design can't reach the calendar)

`syntax.validate()` runs on every design and every edit; `/api/push` refuses to send
if any `error`-level issue remains. It checks:

1. **Contiguity** — segments tile `0..route_km` with no gaps/overlaps.
2. **Buffer padding** — total written distance = route + `BUFFER_KM` per padded buffer; only warm-up/rest/cool-down may be padded (the +5 km lap-button convention).
3. **Intensity window** — every work step's %FTP sits inside the objective's physiological window (`workout_windows.CAT_WIN`, ±1% slop).
4. **No effort starts on a hazard** — a work step starting within 300 m of a known stop/junction is a blocking **error**; merely crossing one mid-effort is a **warn**.
5. **Well-formed** — every step has a name and a readable intensity range.

`validate_blank()` is the reduced set for no-route workouts (no terrain/stop/buffer
checks).

## Conventions & gotchas

- **No LLM at runtime.** Every recommendation is deterministic. Build/maintain the logic with Claude Code; the running app makes no model calls.
- **km ↔ minutes** conversion everywhere uses `REF_SPEED_KMH` (default 30). Load/duration are *estimates*, not real ride time. The front-end reads these constants from `/api/health` — never hardcode them in JS.
- **intervals.icu field drift.** `create_workout` field names mirror what the old MCP sent; verify against <https://intervals.icu/api-docs.html> on first push. `_field()`/`_get` tolerate both `icu_*` and un-prefixed names.
- **The longitude bug** ([icu.py](../server/icu.py) `download_gpx`): intervals.icu's `latlng` stream returns latitude only, and there's no `/gpx` export — history refresh must reconstruct GPX from `/map` + `/streams`.
- **OSM turn-priority** (`yield_left` / `right_before_left`) needs a live ~20 s Overpass fetch and is skipped when offline (`priority=False`); base hazards still load from cache.
- **Windows ARM64**: use plain `uvicorn` (in requirements.txt); `uvicorn[standard]` pulls `httptools`, which has no ARM64 wheel.

## Where to make a change

| I want to… | Edit |
|---|---|
| Change how efforts are placed on the route | `server/designer.py` (`_plan_placement`, `_choose_session`, `_avoid_start`) |
| Change what makes a design invalid | `server/syntax.py` (`validate`) |
| Change the objective→phase→terrain ranking | `engine/scripts/suggest_workout.py` / `engine/references/coaching-engine.md` |
| Change how a segment scores (add/weight a layer) | `compute_effort` in `engine/scripts/build_map_widget.py`; surfaced via `server/engine.py::composite_scores` |
| Add/adjust a wizard step or map interaction | `web/app.js` (+ `web/index.html` for markup, `web/map.js` for the map) |
| Add a maintenance job | `server/jobs.py` (`COMMANDS`) + a button in `web/index.html` |
