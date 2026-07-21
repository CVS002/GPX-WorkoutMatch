# Keeping the skill and the app in sync

The app is **self-contained**: it runs entirely off its own vendored copy under
`engine/`, so its caches can grow bigger than the packaged skill's without
affecting it. Nothing is read live from the skill during a session.

```
workout-designer/
  engine/                 ← the app's OWN copy (what actually runs)
    scripts/*.py            engine + builder scripts
    assets/map_widget_template.html
    references/*.md          coaching-engine, workout-library, known-roads (grows here), …
    data/cache/*.json        road_db, effort_db, osm_hazards, osm_streets, workout_bank
    data/history/*.gpx       downloaded ride GPX (for rebuilds)
```

The external skill (`SKILL_DIR`, default `~/.claude/skills/gpx-workout-designer-v2`)
is only referenced as the **sync source**.

## What lives where

| Thing | Authoritative copy | Notes |
|---|---|---|
| Engine + builder scripts (`.py`) | `engine/scripts/` | vendored; edits here don't touch the skill |
| Map template | `engine/assets/` | app also re-labels buttons at serve time (mapbuild.py) |
| Caches (road/effort/OSM/streets/bank) | `engine/data/cache/` | **app owns these** — usually LARGER than the skill's (denser streets, full history) |
| Ride history GPX | `engine/data/history/` | app-only; downloaded via intervals.icu |
| Road dossier (`known-roads.md`) | `engine/references/` | **grows in the app** (map corrections); sync never overwrites it |
| App server + UI | `server/`, `web/` | app-only; no skill equivalent |

## Propagating changes

### Skill → app  (you improved a script/template in Claude Code)
Maintenance page → **“↺ Sync engine code from skill”**. Copies `scripts/*.py`,
the map template, and reference docs from `SKILL_DIR` into `engine/`. It does
**not** touch caches or your local `known-roads.md`. Tick *“also overwrite app
caches”* only if you deliberately want the skill's (smaller) caches — normally
leave it off.

CLI equivalent:
```bash
curl -X POST localhost:8712/api/maint/sync -H "Content-Type: application/json" -d "{}"
```

### App → skill  (you improved a script here and want it back in the skill)
Manual, deliberate (rarer). Copy the changed file back, then repackage the skill:
```bash
copy engine\scripts\<file>.py  %USERPROFILE%\.claude\skills\gpx-workout-designer-v2\scripts\
# in the skill dir, repackage for re-upload to the Claude app:
python scripts/update_skill.py --out <path>\gpx-workout-designer_V2.skill
```
Keep the skill the source of truth for *code you want in both*; treat the app's
`engine/scripts` as a working copy you occasionally push back.

### Caches
Rebuild them in **whichever place you want them big**. The app's Maintenance
page rebuilds into `engine/data/cache/` (denser streets, full ride history). The
skill's caches stay lean for packaging. They're independent by design — don't
sync caches unless you have a specific reason.

## Rule of thumb
- Changing **logic/coaching/template** → edit in the skill, then *Sync engine
  code from skill* in the app. One source of truth, one button.
- Growing **data** (streets, history, corrections) → do it in the app; it's
  meant to accumulate here.
