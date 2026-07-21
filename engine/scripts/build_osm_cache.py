#!/usr/bin/env python3
"""Layer 3 (build): pre-fetch OSM hazards for the athlete's home area into a
regional cache, so osm_enrich.py works offline / instantly on local routes.

Usage:
    python build_osm_cache.py [--cache <road_db.json>] [--out <osm_hazards.json>]
                              [--radius-km N] [--bbox S,W,N,E]

Without --bbox, the home area is derived automatically from the road-knowledge
cache (build_road_db.py output): the densest ride cluster is taken as "home",
and a box of --radius-km (default 40) around it becomes the cached region.
Distant one-off trips (training camps, events elsewhere) fall outside the box
and are left to live Overpass at score time -- the box stays compact.

The result (data/cache/osm_hazards.json) is a flat list of every traffic
signal, level crossing, and roundabout in the region. osm_enrich.py snaps a
route against it locally, no network needed. Rebuild occasionally to pick up
new lights. Requires internet only for this build. Stdlib only.
"""
import sys
import os
import json
import math
import time
import urllib.request
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from osm_enrich import OVERPASS_URLS, classify  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CACHE = os.path.join(HERE, "..", "data", "cache", "road_db.json")
DEFAULT_OUT = os.path.join(HERE, "..", "data", "cache", "osm_hazards.json")
CACHE_VERSION = 1


def home_bbox(road_db_path, radius_km):
    """Densest ride cluster in the road DB -> (home_lat, home_lon, bbox)."""
    with open(road_db_path, encoding="utf-8") as f:
        db = json.load(f)
    cl = db["meta"]["cell_lat"]
    co = db["meta"]["cell_lon"]
    cells = []
    for key, v in db["cells"].items():
        i, j = key.split(",")
        cells.append((int(i) * cl, int(j) * co, v[0]))  # lat, lon, passes
    if not cells:
        raise SystemExit("road DB has no cells; build_road_db.py first")

    # home = densest 0.05 deg bin, weighted by passes
    BIN = 0.05
    hist = {}
    for la, lo, p in cells:
        k = (round(la / BIN), round(lo / BIN))
        hist[k] = hist.get(k, 0) + p
    (hi, hj) = max(hist, key=hist.get)
    home_lat, home_lon = hi * BIN, hj * BIN

    def dist(la, lo):
        return math.hypot((la - home_lat) * 111.0,
                          (lo - home_lon) * 111.0 * math.cos(math.radians(home_lat)))

    kept = [(la, lo) for la, lo, _ in cells if dist(la, lo) <= radius_km]
    lats = [la for la, _ in kept]
    lons = [lo for _, lo in kept]
    # one cell of margin
    bbox = (min(lats) - cl, min(lons) - co, max(lats) + cl, max(lons) + co)
    return home_lat, home_lon, bbox, len(kept)


def build_query(bbox):
    s, w, n, e = bbox
    b = f"{s:.5f},{w:.5f},{n:.5f},{e:.5f}"
    return f"""[out:json][timeout:180];
(
  node[highway=traffic_signals]({b});
  node[railway=level_crossing]({b});
  node[highway=mini_roundabout]({b});
  node[highway=give_way]({b});
  node[highway=stop]({b});
  way[junction=roundabout]({b});
);
out center;
"""


def run_overpass(query):
    data = query.encode("utf-8")
    last_err = None
    for url in OVERPASS_URLS:
        try:
            req = urllib.request.Request(
                url, data=data,
                headers={"User-Agent": "gpx-workout-designer-v2/2.0"})
            with urllib.request.urlopen(req, timeout=185) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, urllib.error.HTTPError,
                TimeoutError, OSError) as e:
            last_err = e
            time.sleep(2)
            continue
    raise last_err if last_err else RuntimeError("Overpass unreachable")


def build(road_db_path, out_path, radius_km, bbox_override):
    if bbox_override:
        bbox = bbox_override
        home_lat = (bbox[0] + bbox[2]) / 2
        home_lon = (bbox[1] + bbox[3]) / 2
        n_cells = None
    else:
        home_lat, home_lon, bbox, n_cells = home_bbox(road_db_path, radius_km)

    s, w, n, e = bbox
    hkm = (n - s) * 111.0
    wkm = (e - w) * 111.0 * math.cos(math.radians((s + n) / 2))
    print(f"home ~ {home_lat:.3f},{home_lon:.3f}  "
          f"bbox {wkm:.0f}x{hkm:.0f} km  "
          f"lat[{s:.4f},{n:.4f}] lon[{w:.4f},{e:.4f}]")

    raw = run_overpass(build_query(bbox))
    hazards = []
    for el in raw.get("elements", []):
        if "lat" in el and "lon" in el:
            lat, lon = el["lat"], el["lon"]
        elif "center" in el:
            lat, lon = el["center"]["lat"], el["center"]["lon"]
        else:
            continue
        hazards.append({"type": classify(el),
                        "lat": round(lat, 6), "lon": round(lon, 6)})

    counts = {}
    for h in hazards:
        counts[h["type"]] = counts.get(h["type"], 0) + 1

    out = {
        "meta": {
            "version": CACHE_VERSION,
            "home": [round(home_lat, 5), round(home_lon, 5)],
            "radius_km": radius_km if not bbox_override else None,
            "bbox": [round(x, 5) for x in bbox],
            "generated": time.strftime("%Y-%m-%d"),
            "source": "OpenStreetMap via Overpass API",
            "home_cells": n_cells,
            "counts": counts,
        },
        "hazards": hazards,
    }
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f)
    summ = ", ".join(f"{v} {k}" for k, v in sorted(counts.items()))
    print(f"OSM cache: {len(hazards)} hazards ({summ}) -> {out_path}")


if __name__ == "__main__":
    argv = sys.argv[1:]

    def opt(name, default=None):
        return argv[argv.index(name) + 1] if name in argv else default

    cache = os.path.abspath(opt("--cache", DEFAULT_CACHE))
    out = os.path.abspath(opt("--out", DEFAULT_OUT))
    radius = float(opt("--radius-km", "40"))
    bbox_override = None
    if "--bbox" in argv:
        parts = [float(x) for x in opt("--bbox").split(",")]
        if len(parts) != 4:
            raise SystemExit("--bbox needs S,W,N,E")
        bbox_override = tuple(parts)
    build(cache, out, radius, bbox_override)
