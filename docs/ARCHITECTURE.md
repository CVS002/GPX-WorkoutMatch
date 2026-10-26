# Architecture

The reference for maintainers. Start with [README.md](../README.md) for setup and
[DEPLOY.md](DEPLOY.md) for hosting; [ROADMAP.md](ROADMAP.md) lists proposed
features. This file explains *how the pieces fit together* so a change lands in
the right place.

## 10-second mental model

A **single-user, no-LLM web app on Netlify**. Netlify Functions (TypeScript)
analyse a GPX route, deterministically design a structured cycling workout that
places its hard intervals on the *cleanest, effort-ready* stretches of road,
serve a native SVG map you can adjust, and push the result to intervals.icu as
a calendar event. All the "is this stretch of road good for an effort?"
intelligence lives in the **analysis engine** (`src/engine/`). State lives in
**Netlify Blobs**. Nothing calls an LLM at runtime.

```
browser (web/)  ──HTTP /api/*──▶  Netlify Function "api"  ──▶  src/server → src/engine
      ▲                                 │      │                         │
      │  native SVG map, wizard         │      │ POST                    ▼
      │                                 │      ▼                   Netlify Blobs
      │                                 │  "maint-background"      (caches, ride
      │                                 │   (cache rebuilds) ─────▶ history, routes,
      └─────────────────────────────────┴──── REST ──▶ intervals.icu   jobs)
```

## The analysis-layer model (the heart of it)

"Which segment of the route can hold an effort?" is answered by fusing
independent evidence layers. The designer and the map are both consumers of the
fused per-km score.

| Layer | Source | What it contributes | Code |
|---|---|---|---|
| **L1 Terrain/geometry** | the GPX itself | effort blocks, per-km continuity + gradient, climbs | `src/engine/analyze.ts` |
| **L2 Road-history quality** | your past rides | per-cell stop hotspots (junctions you actually brake at), coverage | `build/roadDb.ts` → `score.ts` |
| **L3 OSM hazards** | OpenStreetMap (Overpass, cached) | signals, level crossings, roundabouts, give-way/stop signs | `build/osmCaches.ts` → `osm.ts` |
| **L4 Dossier** | you (confirmed) | "I ride through this" corrections | `engine/references/known-roads.md` + the `known-roads-corrections.md` blob |
| **L5 Effort corridors** | your past rides | where you have repeatedly *sustained* a hard, steady effort (HR + speed) | `build/effortDb.ts` → `score.ts` (`scoreEffort`) |
| **L6 Workout-aware** | planned-workout ride manifest | treats "segment done, I stopped" near-stops as non-hazards | `engine/data/cache/workout_rides.json` |

`compositeScores()` (`src/server/engine.ts`) fuses these into a per-km score + a
ranked list of **placement blocks** (`computeEffort` / `placementBlocks` in
`src/engine/mapwidget.ts`). Green road on the map == high composite score ==
where the designer will try to land an interval. Athlete overrides
(`cleared_km`) drop danger points before fusion.

See [engine/references/maintenance.md](../engine/references/maintenance.md) for
the cache semantics and
[coaching-engine.md](../engine/references/coaching-engine.md) for the
objective→phase→terrain logic the ranking encodes.

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
   POST /api/rides/*     past-ride matches, speed track, best-500 m speed/power overlays
8. POST /api/push        create the WORKOUT event on intervals.icu (only after review)
```

Strict order is intentional: **the map is reviewed before any date is picked**.
Validation runs on every edit, so the push button only ever sends a design that
already passed the guardrails.

### State (Netlify Blobs)

Functions are stateless; everything persistent is a blob (`src/server/store.ts`):

| Store | Keys | Notes |
|---|---|---|
| `routes` | `<rid>/session`, `/pts`, `/haz`, `/ctx`, `/map`, `/cap` | Mutable wizard state is kept apart from derived caches (analysis per `cleared_km`, map payload, learned capability) so a concurrent request can't clobber an edit. Route ids start with a base-36 timestamp; routes older than 14 days are pruned on upload. |
| `cache` | `road_db.json`, `effort_db.json`, `osm_hazards.json`, `osm_streets.json`, `ride_index.json`, `workout_bank.json` (only after a refresh — otherwise the committed bank is bundled), `known-roads-corrections.md` | Memoised per warm function instance and revalidated by ETag. |
| `history` | one gzipped ride record per intervals.icu activity id | Replaces `history/*.gpx`: the same values the engine's GPX would carry (lat/lon 6 dp, ele 1 dp, speed 3 dp, whole-second times), without an XML parse per read. |
| `jobs` | one record per maintenance job | Status + log the UI polls; the 10 newest are kept. |

All stores are site-wide and strongly consistent. A `mode: "blank"` session is
a no-route, time-based workout (no points, no map).

### Maintenance jobs

`POST /api/maint/run` / `/api/maint/history` create a job record and hand it to
the **`maint-background`** function (15-minute limit), which streams log lines
into the record. Long work (the first two-year history download, a big road DB
rebuild, the ride index) saves its progress and re-invokes the function before
the limit, so it completes across invocations. The hand-off forwards the
caller's cookie/Authorization header so it passes Netlify's visitor protection,
and a per-job nonce stops anyone else from triggering runs. A job whose function
died past its deadline is reported as failed.

## Module map

### `netlify/functions/`

| File | Responsibility |
|---|---|
| `api.mts` | Every `/api/*` route → `src/server/api.ts`. |
| `maint-background.mts` | Background function running/resuming maintenance jobs → `src/server/jobs.ts`. |

### `src/server/` — the wizard backend

| Module | Responsibility |
|---|---|
| `api.ts` | Routes, request validation (pydantic-compatible 422s), Blob-backed sessions and their caches, optional `APP_PASSWORD` Basic auth. |
| `config.ts` | Environment variables + design constants (`REF_SPEED_KMH`, `KM_PER_MIN`, `BUFFER_KM`), `APP_TZ` for "today". |
| `store.ts` | Blob stores, ETag-memoised cache reads, an in-memory backend for tests. |
| `engine.ts` | Wrappers over the engine: `scoreRoads` (L2), `enrichOsm` (L3), `scoreEffortLayer` (L5), `compositeScores`, `rankObjectives`, `bankCandidates`/`listWorkouts`/`getWorkout`, `summarizeLoad`. |
| `designer.ts` | `routeContext`, `design` (route), `designBlank` (time-based). Placement — `chooseSession`, `planPlacement`, `cap`, `avoidStart` — gated by the learned capability from your rides. |
| `syntax.ts` | Segments → intervals.icu syntax + the **guardrail validators**. |
| `mapdata.ts` | The JSON the native SVG map draws. |
| `rides.ts` | Ride index, route matches, speed tracks, best-500 m speed/power overlays (one pass over history for both). |
| `icu.ts` | intervals.icu REST client; `downloadRide` fuses `/map` (has longitude) with `/streams` because the `latlng` stream drops longitude and there is no `/gpx` export. |
| `jobs.ts` | Job records, the resumable runner, the dossier writer. |

### `src/engine/` — the analysis engine

`analyze.ts` (L1), `score.ts` (L2/L5 apply), `osm.ts` (L3 + Overpass client),
`mapwidget.ts` (composite scoring, placement blocks, street basemap, bank
candidates), `windows.ts` (category windows), `suggest.ts` (objective ranking),
`build/` (road DB, effort DB, OSM hazard + street caches, workout bank).
`src/lib/` holds geometry, GPX parsing / ride records, and `py.ts`.

### `web/` — vanilla-JS single-page app (no build step, unchanged)

| File | Responsibility |
|---|---|
| [index.html](../web/index.html) | Static scaffold for the wizard + `#maint` panel. |
| [app.js](../web/app.js) | Controller and **sole caller of `/api/*`**. |
| [map.js](../web/map.js) | `window.WDMap` — self-contained SVG map; owns no HTTP. |
| [app.css](../web/app.css) | Theming (light + dark), layout. |

## Guardrails (why a bad design can't reach the calendar)

`validate()` runs on every design and every edit; `/api/push` refuses to send if
any `error`-level issue remains. It checks:

1. **Contiguity** — segments tile `0..route_km` with no gaps/overlaps.
2. **Buffer padding** — total written distance = route + `BUFFER_KM` per padded buffer; only warm-up/rest/cool-down may be padded.
3. **Intensity window** — every work step's %FTP sits inside the objective's window (`CAT_WIN`, ±1% slop).
4. **No effort starts on a hazard** — a work step starting within 300 m of a known stop/junction is a blocking **error**; crossing one mid-effort is a **warn**.
5. **Well-formed** — every step has a name and a readable intensity range.

`validateBlank()` is the reduced set for no-route workouts.

## The Python reference implementation

The original Python app (`server/`, `engine/scripts/`, `run.py`) is kept as the
reference the port was verified against. **`src/lib/py.ts` exists to make the
TypeScript produce byte-identical results**: Python's half-even `round()`,
`repr()`/`:g`/`:.Nf` formatting, `//` and `%`, and CPython ≥ 3.12's
compensated `sum()` all differ from plain JavaScript in ways that change
rounded scores and km labels. Use those helpers for anything you round or print.

`sh test/parity/run.sh` replays the Python app's answers to a full synthetic
wizard scenario (≈630 requests, every maintenance job, mock intervals.icu and
Overpass servers) against the port and diffs everything — responses, built
caches, stored ride records. Run it after changing shared logic in both; once
the Python is retired, the TypeScript is the source of truth.

Two Python bugs are reproduced on purpose (so the port's behaviour is
identical) and are worth fixing in both: routes shorter than ~1 km make the
endurance layout produce negative spans (`design failed: type complex doesn't
define __round__ method`), and a route your rides only graze makes the
history-gated placement format a missing speed bar (`… NoneType.__format__`).

## Conventions & gotchas

- **No LLM at runtime.** Every recommendation is deterministic.
- **km ↔ minutes** conversion uses `REF_SPEED_KMH` (default 30). The front-end reads these constants from `/api/health` — never hardcode them in JS.
- **Function limits.** Synchronous functions stop at 60 s, so live Overpass fallbacks (route outside the cached home box) are bounded (2 × 18 s for hazards, 30 s for streets). Request bodies cap at ~4.5 MB of GPX.
- **intervals.icu field drift.** `createWorkout` field names mirror what the old MCP sent; verify against <https://intervals.icu/api-docs.html> on first push.
- **Workout-bank refresh replaces the bank** with the GitHub-sourced entries only (as the Python did) — the committed bank also carries ~2,100 whatsonzwift entries that a refresh drops.

## Where to make a change

| I want to… | Edit |
|---|---|
| Change how efforts are placed on the route | `src/server/designer.ts` (`planPlacement`, `chooseSession`, `avoidStart`) |
| Change what makes a design invalid | `src/server/syntax.ts` (`validate`) |
| Change the objective→phase→terrain ranking | `src/engine/suggest.ts` / `engine/references/coaching-engine.md` |
| Change how a segment scores (add/weight a layer) | `computeEffort` in `src/engine/mapwidget.ts`; surfaced via `compositeScores` |
| Add/adjust a wizard step or map interaction | `web/app.js` (+ `web/index.html`, `web/map.js`) |
| Add a maintenance job | `src/server/jobs.ts` (`COMMANDS` + `runSingle`) + a button in `web/index.html` |
