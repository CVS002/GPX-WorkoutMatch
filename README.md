# GPX Workout Designer — standalone local web app

A no-LLM, standalone version of the `gpx-workout-designer-v2` Claude skill. Runs
as a small local server; you drive it from your browser. It reuses the skill's
own analysis engine and data caches, and talks to intervals.icu over its REST
API. **No Anthropic API key and no MCP are needed at runtime.**

Build/maintain it (and handle judgement-heavy sessions) with Claude Code on your
subscription; the running app itself is fully deterministic.

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
- `SKILL_DIR` — only if the skill isn't at the default
  `~/.claude/skills/gpx-workout-designer-v2` (used only as the sync source).

The app is **self-contained**: it vendors its own copy of the engine, caches,
map template and dossier under `engine/`, so its caches can grow bigger than the
packaged skill's. Pull code improvements from the skill with the Maintenance
page's **“Sync engine code from skill”** button. See [SYNC.md](SYNC.md) for the
full model of what lives where and how changes propagate.

## Run

```bash
python run.py        # starts the server and opens the browser
```

Then follow the wizard (strict order — the map comes before any date):

1. **Route** — drop a `.gpx`. Runs terrain/geometry (L1), ride-history road
   quality + stop hotspots (L2), OSM hazards (L3, offline cache).
2. **Form & load** — pulls 14-day load, CTL/ATL/TSB and FTP from intervals.icu
   (or enter FTP manually). Pick your training phase.
3. **Session type** — a menu ranked by `suggest_workout` (TSB gate + phase bias
   + novelty), each with a seed session.
4. **Design & map** — the deterministic designer places the interval body on the
   cleanest blocks that fit (reusing the skill's `compute_effort` /
   `placement_blocks`), assembles warm-up/bridges/cooldown with +5 km lap-button
   padding, and renders the interactive map in an iframe. Drag bands / swap the
   session / tick misclassified stops on the map, then hit its **Send… to Claude**
   buttons — the app catches them (via a `sendPrompt`→`postMessage` bridge),
   re-validates, and rebuilds. Road corrections can be saved to your dossier.
5. **Schedule** — only now pick a date. Creates the `WORKOUT` event on
   intervals.icu, shows nearby calendar items, and reports the parsed load.

**Maintenance** (bottom of the page): one-click cache rebuilds — refresh ride
history + rebuild road/effort DB, OSM hazards (60 km box), **dense** street
basemap (arterial + residential + cycleway, since a local app has no `.skill`
size budget), workout bank — plus **Sync engine code from skill**. These wrap
the skill's builder scripts and write into the app's own `engine/data/cache/`.

The map is rendered at **full route resolution** with a denser near-route street
budget (the app serves a file, so it isn't bound by the inline-widget size cap
the skill lives under). Rebuild the dense street cache once (needs internet) to
get the richer basemap; the full-res route line works immediately.

## Architecture

```
server/
  config.py    paths (.env) + shared-skill locations
  engine.py    thin wrappers over the skill's importable functions (L1/L2/L3/L5,
               objective ranking, bank candidates, composite scoring, load summary)
  designer.py  deterministic session designer (choose → place → assemble → render)
  syntax.py    segments → intervals.icu distance syntax + guardrail validator
  mapbuild.py  runs build_map_widget.py, injects the sendPrompt bridge shim
  feedback.py  parse adjusted-plan / road-corrections text from the map
  icu.py       intervals.icu REST client (Basic auth; GPX download, never streams)
  jobs.py      background maintenance jobs + sync-from-skill + dossier append
  main.py      FastAPI routes + in-memory route sessions
web/           single-page wizard (vanilla JS, no build step)
engine/        vendored copy of the skill (scripts + data caches + template + refs)
```

See [SYNC.md](SYNC.md) for how the vendored `engine/` stays in step with the skill.

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
