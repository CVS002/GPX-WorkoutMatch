#!/usr/bin/env python3
"""Package this skill into a .skill zip, with the caches but without the bulky
rebuild-only inputs.

Usage:
    python scripts/package_skill.py [--out <path.skill>]

Includes everything under the skill root EXCEPT:
  - data/history/*.gpx   (270 MB of raw ride GPX; rebuild-only, see
                          data/history/README.md — the built cache ships instead)
  - __pycache__/, *.pyc
  - any existing .skill

It KEEPS data/cache/ (road_db.json + effort_db.json + osm_hazards.json) so
Layers 2, 3 and 5 ship populated. (The previous packaging lost the data dir;
this script does not.)
Stdlib only.
"""
import os
import sys
import zipfile

SKILL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKILL_NAME = os.path.basename(SKILL_ROOT)


def excluded(rel):
    parts = rel.replace("\\", "/").split("/")
    if "__pycache__" in parts:
        return True
    if rel.endswith(".pyc") or rel.endswith(".skill") or rel.endswith(".bak"):
        return True
    # data/history/*.gpx  (keep README.md and _manifest.csv there)
    if parts[:2] == ["data", "history"] and rel.endswith(".gpx"):
        return True
    # osm_streets.json: 13 MB regional road-geometry cache — rebuildable with
    # build_street_cache.py; kept local, not shipped (road_db/osm_hazards/
    # workout_bank caches DO ship).
    if parts[-1] == "osm_streets.json":
        return True
    # generated route maps live under data/ but are per-route outputs, not skill assets
    if parts[:1] == ["data"] and rel.endswith(".html"):
        return True
    return False


def build(out_path):
    entries = []
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as z:
        for dp, dn, fn in os.walk(SKILL_ROOT):
            dn[:] = [d for d in dn if d != "__pycache__"]
            for f in fn:
                full = os.path.join(dp, f)
                rel = os.path.relpath(full, SKILL_ROOT)
                if excluded(rel) or os.path.abspath(full) == os.path.abspath(out_path):
                    continue
                arc = (SKILL_NAME + "/" + rel).replace(os.sep, "/")
                z.write(full, arc)
                entries.append(arc)
    size = os.path.getsize(out_path) / 1e6
    print(f"wrote {out_path}  ({size:.2f} MB, {len(entries)} files)")
    for a in sorted(entries):
        print("  ", a)


if __name__ == "__main__":
    argv = sys.argv[1:]
    out = argv[argv.index("--out") + 1] if "--out" in argv else \
        os.path.join(os.path.dirname(SKILL_ROOT), SKILL_NAME + ".skill")
    build(os.path.abspath(out))
