#!/usr/bin/env python3
"""Rebuild the road-knowledge + effort caches from the current ride history and
repackage the skill -- the non-MCP half of "add my latest workouts and update
the skill".

Usage:
    python scripts/update_skill.py [--out <path.skill>] [--no-package]

The full "learn from my latest workouts" flow is two steps:

  1. (MCP, done by the assistant in a Claude Code / app session) Pull the days
     that had a *planned* workout on the intervals.icu calendar, match each to
     the ride actually done that day, download its GPX into data/history/, and
     record the activity ids in data/cache/workout_rides.json. See
     references/maintenance.md -> "Layer 6 (learn from workouts)".
  2. (this script) Rebuild both caches from data/history so the new rides, the
     8-way direction bins, and the workout-aware effort-end-stop suppression are
     applied consistently to every ride, then repackage the .skill.

Both caches are rebuilt FROM SCRATCH (old ones backed up next to themselves as
*.bak) so the workout-aware / directional logic is applied to the whole history,
not just newly-added rides. Stdlib only.
"""
import os
import sys
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import build_road_db as ROAD      # noqa: E402
import build_effort_db as EFFORT  # noqa: E402
import package_skill as PKG       # noqa: E402

HISTORY = os.path.join(ROOT, "data", "history")
ROAD_DB = os.path.join(ROOT, "data", "cache", "road_db.json")
EFFORT_DB = os.path.join(ROOT, "data", "cache", "effort_db.json")
WORKOUTS = os.path.join(ROOT, "data", "cache", "workout_rides.json")


def _fresh(path):
    """Back up an existing cache to <path>.bak and remove it for a clean rebuild."""
    if os.path.exists(path):
        shutil.copy2(path, path + ".bak")
        os.remove(path)


def main():
    argv = sys.argv[1:]
    do_pkg = "--no-package" not in argv
    out = argv[argv.index("--out") + 1] if "--out" in argv else \
        os.path.join(os.path.dirname(ROOT), PKG.SKILL_NAME + ".skill")

    n_gpx = len([f for f in os.listdir(HISTORY) if f.endswith(".gpx")])
    wk = 0
    if os.path.exists(WORKOUTS):
        import json
        wk = len((json.load(open(WORKOUTS, encoding="utf-8")).get("rides") or {}))
    print(f"History: {n_gpx} ride GPX | workout-tagged rides: {wk}\n")

    print("[1/3] Rebuilding road_db (direction + workout-aware) ...")
    _fresh(ROAD_DB)
    ROAD.build(HISTORY, ROAD_DB, WORKOUTS if os.path.exists(WORKOUTS) else None)

    print("\n[2/3] Rebuilding effort_db (steady + direction) ...")
    _fresh(EFFORT_DB)
    EFFORT.build(HISTORY, EFFORT_DB, ROAD_DB)   # grid taken from road_db

    if do_pkg:
        print("\n[3/3] Repackaging skill ...")
        PKG.build(os.path.abspath(out))
    else:
        print("\n[3/3] Skipped packaging (--no-package).")
    print("\nDone. Re-upload the .skill to the Claude app to pick up the refreshed roads.")


if __name__ == "__main__":
    main()
