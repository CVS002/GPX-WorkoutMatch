# GPX Workout Designer

A no-LLM web app that designs structured cycling workouts matched to a specific
route, running entirely on **Netlify**: a static wizard UI, a TypeScript API as
Netlify Functions, maintenance jobs as a background function, and your ride
history and caches in Netlify Blobs. It talks to intervals.icu over its REST
API. **No Anthropic API key and no LLM are needed at runtime — every
recommendation is deterministic.**

## Deploy

See **[docs/DEPLOY.md](docs/DEPLOY.md)**. In short:

1. Connect this repo to a Netlify project (`netlify.toml` configures it).
2. Set `ICU_API_KEY` and `ICU_ATHLETE_ID` in the project's environment variables
   (plus visitor protection or `APP_PASSWORD` — the app holds your key).
3. Open the app → **Maintenance** → *Refresh ride history*, *OSM hazards*,
   *Street basemap*.

Local development: `npm install`, then `npx netlify-cli dev` (http://localhost:8888).

## Use

Follow the 4-step wizard (strict order — the map comes before any date):

1. **Route** — drop a `.gpx`. Runs terrain/geometry (L1), ride-history road
   quality + stop hotspots (L2) and OSM hazards (L3, regional cache, live
   Overpass outside it). *Or* start a **no-route, time-based workout**.
2. **Your form & workout** — pulls 14-day load, CTL/ATL/TSB and FTP from
   intervals.icu (or enter FTP manually), pick your phase, then choose from a
   **searchable workout picker** ranked by TSB gate + phase bias + novelty +
   terrain and filtered to workouts that fit the route.
3. **Design & map** — the deterministic designer places the interval body on the
   cleanest blocks that fit (gated by where your own rides show you hold the
   effort), assembles warm-up/bridges/cooldown with +5 km lap-button padding,
   and renders a **native SVG map**. Drag/nudge segments, rename the workout,
   click a hazard for Street View or mark it *"I ride through this"* (re-scores
   and re-designs), and overlay how fast / how hard you actually rode here.
   Every edit re-validates server-side.
4. **Schedule** — pick a date; creates the `WORKOUT` event on intervals.icu,
   shows nearby calendar items and the parsed load.

**Maintenance** (bottom of the page): refresh ride history (+ road/effort DB),
OSM hazards (60 km box), dense street basemap, workout bank. Long jobs continue
across background-function runs; the log shows progress.

## Architecture

```
web/                 single-page wizard (vanilla JS, no build step); SVG map in map.js
netlify/functions/   api.mts (all /api/* routes), maint-background.mts (jobs)
src/server/          wizard backend: routes + sessions, designer, syntax/guardrails,
                     map payload, ride overlays, intervals.icu client, jobs, Blobs
src/engine/          analysis engine: L1 terrain, L2/L5 scoring, L3 OSM, composite
                     scoring + placement, objective ranking, cache builders
src/lib/             geometry, GPX + ride records, Python-exact numerics (py.ts)
engine/              bundled workout bank, workout-ride manifest, reference dossier
                     (+ the original Python engine scripts)
server/, run.py      the original Python (FastAPI) app — the port's reference
test/parity/         Python ↔ TypeScript parity test (mock intervals.icu + Overpass)
```

**Full maintainer reference: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — the
analysis-layer model (L1–L6), request/data flow, Blob layout, jobs, the
guardrails, and a "where to make a change" table. See
[docs/ROADMAP.md](docs/ROADMAP.md) for proposed features.

### Guardrails
Every design and every map adjustment is validated before it can reach the
calendar: step distances sum to route + 5 km per padded buffer; work
intensities within the objective's window; **no work step starts on a known
stop/junction**; buffers padded and floats not; every step carries a range +
`power=3s`. Blocking issues prevent the push.

## The original Python app

The TypeScript port reproduces the Python app's results exactly — verified by
`sh test/parity/run.sh`, which replays ~630 wizard requests and every
maintenance job against both. The Python still runs locally if you want it:

```bash
python -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env      # ICU_API_KEY, ICU_ATHLETE_ID
python run.py             # http://127.0.0.1:8712
```

It keeps its own data under `engine/data/` and `appdata/` (not shared with the
Netlify app).

## Notes / limits
- intervals.icu REST field names (create-event especially) mirror what the MCP
  sent; verify against https://intervals.icu/api-docs.html on first push.
- The turn-priority OSM analysis (`yield_left` / `right_before_left`) is not
  run by the app (as before); base hazards come from the cache or live Overpass.
- GPX uploads are limited to ~4.5 MB (Netlify function request size).
