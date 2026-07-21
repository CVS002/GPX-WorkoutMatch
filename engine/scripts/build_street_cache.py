#!/usr/bin/env python3
"""Build a regional STREET-geometry cache so the map widget can draw a road
basemap offline, aligned to the same home box as the OSM hazard cache.

Usage:
    python build_street_cache.py [--out <osm_streets.json>]
        [--from-hazards <osm_hazards.json>] [--cache <road_db.json>]
        [--radius-km N] [--bbox S,W,N,E]
        [--classes primary,secondary,...] [--step-m 40]

By default the box is taken from the existing hazard cache (osm_hazards.json)
so both caches cover the same region; falls back to deriving it from the road
DB. Fetches every road way of the chosen classes in the box from Overpass once,
decimates each to ~step-m spacing, and writes data/cache/osm_streets.json.
Default classes are the arterial skeleton (primary/secondary/tertiary + links) —
bounded and shippable; add residential/unclassified/cycleway via --classes for a
denser grid (much larger). Needs internet only for this build. Stdlib only.
"""
import sys
import os
import json
import math
import time
import urllib.request
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from analyze_gpx import haversine_m            # noqa: E402
from osm_enrich import OVERPASS_URLS           # noqa: E402
import build_osm_cache as BOC                  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUT = os.path.join(HERE, "..", "data", "cache", "osm_streets.json")
DEFAULT_HAZ = os.path.join(HERE, "..", "data", "cache", "osm_hazards.json")
DEFAULT_DB = os.path.join(HERE, "..", "data", "cache", "road_db.json")
ARTERIAL = ["primary", "secondary", "tertiary",
            "primary_link", "secondary_link", "tertiary_link", "unclassified"]
CACHE_VERSION = 1


def run_overpass(query):
    data = query.encode("utf-8")
    last = None
    for url in OVERPASS_URLS:
        try:
            req = urllib.request.Request(url, data=data,
                                         headers={"User-Agent": "gpx-workout-designer-v2/2.0"})
            with urllib.request.urlopen(req, timeout=185) as r:
                return json.loads(r.read().decode("utf-8"))
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as e:
            last = e
            time.sleep(2)
    raise last if last else RuntimeError("Overpass unreachable")


def decimate(geom, step_m):
    poly = [[round(geom[0]["lat"], 5), round(geom[0]["lon"], 5)]]
    acc = 0.0
    for a, b in zip(geom, geom[1:]):
        acc += haversine_m(a["lat"], a["lon"], b["lat"], b["lon"])
        if acc >= step_m:
            poly.append([round(b["lat"], 5), round(b["lon"], 5)])
            acc = 0.0
    last = [round(geom[-1]["lat"], 5), round(geom[-1]["lon"], 5)]
    if poly[-1] != last:
        poly.append(last)
    return poly


def main():
    argv = sys.argv[1:]

    def opt(name, d=None):
        return argv[argv.index(name) + 1] if name in argv else d

    out = os.path.abspath(opt("--out", DEFAULT_OUT))
    step_m = float(opt("--step-m", "40"))
    classes = (opt("--classes").split(",") if opt("--classes") else ARTERIAL)

    # resolve the box: explicit --bbox, else the hazard cache's box, else road DB
    bbox = None
    if "--bbox" in argv:
        bbox = tuple(float(x) for x in opt("--bbox").split(","))
    else:
        haz = os.path.abspath(opt("--from-hazards", DEFAULT_HAZ))
        if os.path.exists(haz):
            bbox = tuple(json.load(open(haz, encoding="utf-8"))["meta"]["bbox"])
            print(f"using hazard-cache bbox from {os.path.basename(haz)}")
    if bbox is None:
        cache = os.path.abspath(opt("--cache", DEFAULT_DB))
        _, _, bbox, _ = BOC.home_bbox(cache, float(opt("--radius-km", "40")))

    s, w, n, e = bbox
    wkm = (e - w) * 111.0 * math.cos(math.radians((s + n) / 2))
    hkm = (n - s) * 111.0
    print(f"box {wkm:.0f}x{hkm:.0f} km  classes={classes}")

    cls = "|".join(classes)
    q = (f"[out:json][timeout:180];way[highway~\"^({cls})$\"]"
         f"({s:.5f},{w:.5f},{n:.5f},{e:.5f});out geom;")
    raw = run_overpass(q)

    ways, npts = [], 0
    for el in raw.get("elements", []):
        g = el.get("geometry")
        if not g or len(g) < 2:
            continue
        cl = el.get("tags", {}).get("highway", "road")
        poly = decimate(g, step_m)
        ways.append({"c": cl, "g": poly})
        npts += len(poly)

    payload = {
        "meta": {"version": CACHE_VERSION, "bbox": [round(x, 5) for x in bbox],
                 "generated": time.strftime("%Y-%m-%d"), "classes": classes,
                 "step_m": step_m, "count_ways": len(ways), "count_pts": npts,
                 "source": "OpenStreetMap via Overpass API"},
        "ways": ways,
    }
    os.makedirs(os.path.dirname(out), exist_ok=True)
    json.dump(payload, open(out, "w", encoding="utf-8"), separators=(",", ":"))
    mb = os.path.getsize(out) / 1e6
    print(f"street cache: {len(ways)} ways, {npts} pts, {mb:.2f} MB -> {out}")


if __name__ == "__main__":
    main()
