# GPX Workout Designer — standalone local web app

A no-LLM, self-contained web app that designs structured cycling workouts matched
to a specific route. It runs as a small local server; you drive it from your
browser. All the terrain/road/effort analysis runs locally under `engine/`, and it
talks to intervals.icu over its REST API. **No Anthropic API key and no LLM are
needed at runtime — every recommendation is deterministic.**

## Setup

```bash
cd C:\Claude\workout-designer
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt      # plain uvicorn (no C build on ARM64)
copy .env.example .env                              # then edit .env
```

Fill in `.env`:
- `ICU_API_KEY` — intervals.icu → Settings → Developer.
- `ICU_ATHLETE_ID` — your athlete id (the `i…` value or number).

The app is **self-contained**: the analysis engine, data caches and road dossier
all live under `engine/`, and the caches grow there as your ride history and
corrections accumulate. Rebuild or refresh them from the Maintenance panel.

## Run

```bash
python run.py        # starts the server and opens the browser
```

Then follow the 4-step wizard (strict order — the map comes before any date):

1. **Route** — drop a `.gpx`. Runs terrain/geometry (L1), ride-history road
   quality + stop hotspots (L2), OSM hazards (L3, offline cache). *Or* start a
   **no-route, time-based workout** (no GPX, no map) with the button below.
2. **Your form & workout** — pulls 14-day load, CTL/ATL/TSB and FTP from
   intervals.icu (or enter FTP manually), pick your phase, then choose from a
   **searchable workout picker** ranked by `suggest_workout` (TSB gate + phase
   bias + novelty + terrain) and filtered to workouts that fit the route.
3. **Design & map** — the deterministic designer places the interval body on the
   cleanest blocks that fit (via the engine's `compute_effort` /
   `placement_blocks`), assembles warm-up/bridges/cooldown with +5 km lap-button
   padding, and renders a **native SVG map** (no iframe). Adjust it in-app:
   drag/nudge segments in the timeline & table, rename the workout, click a
   hazard to open Street View or mark it *"I ride through this"* (a veto that
   re-scores and re-designs), and overlay **how fast you actually rode here**
   from a past ride. Every edit re-validates server-side. Road corrections can
   be saved to your dossier.
4. **Schedule** — only now pick a date: tap one of the **next-7-days** chips
   (defaults to today) or choose a later date in the picker. Creates the
   `WORKOUT` event on intervals.icu, shows nearby calendar items, and reports
   the parsed load.

**Maintenance** (bottom of the page): one-click cache rebuilds — refresh ride
history + rebuild road/effort DB, OSM hazards (60 km box), **dense** street
basemap (arterial + residential + cycleway), and the workout bank. These run the
engine's builder scripts and write into `engine/data/cache/`.

The map is drawn natively in the browser (`web/map.js`) at **full route
resolution** with a dense near-route street basemap. Rebuild the street cache
once (needs internet) to get the richer basemap; the full-res route line works
immediately.

## Architecture

```
server/            FastAPI backend (no LLM)
  config.py    paths (.env) + engine/cache locations + design constants
  engine.py    thin in-process wrappers over the analysis engine scripts
               (L1/L2/L3/L5, objective ranking, bank candidates, composite scoring)
  designer.py  deterministic session designer (choose → place → assemble → render)
  syntax.py    segments → intervals.icu distance syntax + guardrail validator
  mapdata.py   reshapes cached analysis into JSON for the native SVG map
  rides.py     matches past-ride history to the route; serves speed tracks (overlay)
  icu.py       intervals.icu REST client (Basic auth; reconstructs GPX, never streams)
  jobs.py      background maintenance jobs (cache rebuilds) + dossier append
  main.py      FastAPI routes + in-memory route sessions
web/           single-page wizard (vanilla JS, no build step); native SVG map in map.js
engine/        the analysis engine — scripts + data caches + references dossier
```

**Full maintainer reference: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — the
analysis-layer model (L1–L6), request/data flow, module responsibilities, the
guardrails, and a "where to make a change" table. See
[docs/ROADMAP.md](docs/ROADMAP.md) for proposed features.

### Guardrails
Every design and every map adjustment is validated before it can reach the
calendar: step distances sum to route + 5 km per padded buffer; work
intensities within the objective's window; **no work step starts on a known
stop/junction**; buffers padded and floats not; every step carries a range +
`power=3s`. Blocking issues prevent the push.

## Notes / limits
- intervals.icu REST field names (create-event especially) mirror what the MCP
  sent; verify against https://intervals.icu/api-docs.html on first push.
- The turn-priority OSM analysis (`yield_left` / `right_before_left`) needs a
  live Overpass fetch and is skipped when offline — base hazards still load from
  the cache.
- On Windows ARM64 use plain `uvicorn` (in requirements.txt); `uvicorn[standard]`
  pulls `httptools`, which has no ARM64 wheel.
