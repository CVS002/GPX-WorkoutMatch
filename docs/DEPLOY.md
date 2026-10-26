# Deploying on Netlify

The whole app runs on Netlify: the UI in `web/` is served as static files, the
API runs as Netlify Functions, maintenance jobs run as a background function,
and everything persistent (ride history, caches, sessions, job logs) lives in
Netlify Blobs. No other host or database is needed. Netlify Database isn't used,
because the app's data is files and caches, not relational records.

## 1. Connect the repo

Netlify → **Add new project → Import an existing project** → this GitHub repo.
If the project already exists, nothing changes here. `netlify.toml` sets
everything:

- publish directory `web`
- functions in `netlify/functions`
- build command `npm run typecheck`, so a type error fails the deploy instead of
  shipping

Netlify installs the npm dependencies itself.

## 2. Environment variables

Under **Project configuration → Environment variables**. Give each variable the
**Functions** scope, or "All".

| key | value | secret? |
|---|---|---|
| `ICU_API_KEY` | intervals.icu → Settings → Developer | yes |
| `ICU_ATHLETE_ID` | your athlete id (`i…`) | no |
| `APP_PASSWORD` | optional: makes every API call ask for this password (any username) | yes |
| `APP_TZ` | optional, default `Europe/Amsterdam`: the zone "today" is computed in | no |

Values are fixed per deploy, so **redeploy after changing them**.

**Who can use the app.** The app holds your intervals.icu key, so don't leave it
open to the internet. Pick one of these:

- Netlify's own visitor protection (**Project configuration → Access & security
  → Visitor access**, team login or password).
- `APP_PASSWORD`.
- Both.

## 3. Fill the caches (once)

A fresh site has only the bundled workout library. Open the app, expand
**Maintenance** and run, in this order:

1. **Refresh ride history**: downloads ~2 years of rides from intervals.icu,
   then builds the road-knowledge and effort-corridor databases and the ride
   index. The first run takes a while and continues across background-function
   invocations; its log says so.
2. **OSM hazards**: the 60 km home box from your densest ride area.
3. **Street basemap**: fetched in ~25 km tiles to stay within function memory.

Rerun them when you want newer rides or map data. **Refresh workout bank**
replaces the bank with GitHub-sourced workouts only, which drops the ~2,100
whatsonzwift entries in the committed bank, so only run it if you mean to.

## Limits worth knowing

- **Uploads:** GPX files up to about 4.5 MB (the function request limit).
- **Live OpenStreetMap lookups:** a route outside the cached home box queries
  Overpass live, and that has to finish inside the 60 s request limit. If
  Overpass is slow, the route just shows without junction data, as the Python
  app did offline.
- **Storage:** ride history takes roughly 100 KB per ride in Blobs, so about
  120 MB for 1,200 rides.

## Local development

```bash
npm install
npx netlify-cli dev          # UI + functions + a local Blobs sandbox on :8888
npm run typecheck
sh test/parity/run.sh        # Python ↔ TypeScript parity (needs python3 + fastapi + httpx)
```

`netlify dev` reads the same environment variables from your shell or a linked
site. The original Python app still runs with `python run.py` (see README);
the two don't share data.
