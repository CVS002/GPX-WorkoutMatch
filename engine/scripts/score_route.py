#!/usr/bin/env python3
"""Layer 2 (apply): score a new route against your road-knowledge cache.

Usage:
    python score_route.py <route.gpx> [--cache <cache.json>] [--json]

Reads the cache built by build_road_db.py and, for each kilometre of the new
route, reports:
  - coverage: how much of that km you have ridden before (0-1)
  - road quality: known-clear (ridden, never slow), known-stop (a spot you
    repeatedly crawl through -> light/junction), or unknown (little history)
  - stop hotspots: exact km positions of recurring near-stops

This is the "certified good block" signal: a stretch you have ridden many
times and never slowed on is safe to place a hard effort on; a known-stop km
is a bad place to start an interval. Where coverage is low, the route is new
to you and geometry/OSM layers carry more weight. Stdlib only.
"""
import sys
import os
import json
import math
import xml.etree.ElementTree as ET

MIN_PASSES = 2       # need >=2 separate rides through a cell to trust it
STOP_RATE = 0.12     # cell where >=12% of samples are near-stopped -> junction/light
DIR_MIN_PASSES = 2   # directional passes needed before a cell's heading bin is trusted
DIR_STOP_RATE = 0.30 # >=30% of rides *in this direction* stopped here -> directional stop
NDIR = 8


def strip_ns(tag):
    return tag.split('}')[-1] if '}' in tag else tag


def haversine_m(lat1, lon1, lat2, lon2):
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def bearing_deg(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def dir_bin(bearing):
    return int(((bearing + 360.0 / NDIR / 2) % 360.0) / (360.0 / NDIR)) % NDIR


def _dir_window(dpass, dstop, rb):
    """Sum directional passes/stops over the route heading bin +/- 1 (a 135 deg
    arc), so a small heading wobble or a coarse bin edge doesn't lose the match."""
    dp = ds = 0
    for d in (-1, 0, 1):
        b = (rb + d) % NDIR
        dp += dpass[b]; ds += dstop[b]
    return dp, ds


def parse_points(path):
    tree = ET.parse(path)
    pts = []
    for el in tree.getroot().iter():
        if strip_ns(el.tag) in ('trkpt', 'rtept'):
            try:
                pts.append((float(el.get('lat')), float(el.get('lon'))))
            except (TypeError, ValueError):
                continue
    return pts


def load_cache(cache_path):
    with open(cache_path, encoding="utf-8") as f:
        return json.load(f)


def score(route_path, cache_path):
    cache = load_cache(cache_path)
    meta, cells = cache["meta"], cache["cells"]
    cl, co = meta["cell_lat"], meta["cell_lon"]
    n_rides = len(meta.get("activities", []))

    pts = parse_points(route_path)
    if len(pts) < 2:
        raise SystemExit("Route GPX has fewer than 2 points")
    cum = [0.0]
    for i in range(1, len(pts)):
        cum.append(cum[-1] + haversine_m(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]))
    total_m = cum[-1]
    n_km = max(1, math.ceil(total_m / 1000))

    def best_cell(lat, lon):
        """Most-ridden cell in the 3x3 neighbourhood of this point.

        Hard grid binning misses roads ridden with a small GPS offset, so a
        point matches history if any adjacent cell (within ~one cell, ~50 m)
        has been ridden. Returns the neighbour with the most passes."""
        ci = int(round(lat / cl))
        cj = int(round(lon / co))
        best = None
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                c = cells.get(f"{ci + di},{cj + dj}")
                if c and (best is None or c[0] > best[0]):
                    best = c
        return best

    # route heading at each point (from the previous point), for direction match
    brg = [0.0] * len(pts)
    for i in range(1, len(pts)):
        brg[i] = bearing_deg(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1])
    brg[0] = brg[1] if len(pts) > 1 else 0.0

    buckets = [{"known": 0, "total": 0, "stops": 0, "sum_pass": 0} for _ in range(n_km)]
    hotspots = []
    for i, (lat, lon) in enumerate(pts):
        k = min(int(cum[i] / 1000), n_km - 1)
        b = buckets[k]
        b["total"] += 1
        c = best_cell(lat, lon)
        if c and c[0] >= MIN_PASSES:
            passes, samples, stop_samples = c[0], c[1], c[2]
            b["known"] += 1
            b["sum_pass"] += passes
            # Directional decision first (v2 cells): use only the rides that went
            # THIS way through the cell. Falls back to the sample rate when the
            # heading bin is too thin to trust.
            stopped = None
            rate = None
            if len(c) >= 7:
                dp, ds = _dir_window(c[5], c[6], dir_bin(brg[i]))
                if dp >= DIR_MIN_PASSES:
                    rate = ds / dp
                    stopped = rate >= DIR_STOP_RATE
            if stopped is None:
                rate = (stop_samples / samples) if samples else 0.0
                stopped = rate >= STOP_RATE
            if stopped:
                b["stops"] += 1
                hotspots.append({"km": round(cum[i] / 1000, 2), "passes": passes,
                                 "stop_rate": round(rate, 2)})

    # collapse hotspots that sit within 150 m of each other
    hotspots.sort(key=lambda h: h["km"])
    merged = []
    for h in hotspots:
        if merged and h["km"] - merged[-1]["km"] < 0.15:
            continue
        merged.append(h)

    per_km = []
    for k, b in enumerate(buckets):
        cov = b["known"] / b["total"] if b["total"] else 0.0
        if cov < 0.3:
            quality = "unknown"
        elif b["stops"] > 0:
            quality = "known-stop"
        else:
            quality = "known-clear"
        per_km.append({
            "km": k + 1,
            "coverage": round(cov, 2),
            "avg_passes": round(b["sum_pass"] / b["known"], 1) if b["known"] else 0,
            "quality": quality,
        })

    covered = sum(1 for r in per_km if r["coverage"] >= 0.3)
    return {
        "route_km": round(total_m / 1000, 2),
        "rides_in_cache": n_rides,
        "route_coverage_pct": round(100 * covered / n_km),
        "per_km_road_quality": per_km,
        "stop_hotspots": merged,
    }


EFF_MIN_PASSES = 2      # need >=2 rides' efforts through a cell to call it a corridor


def score_effort(route_path, effort_cache_path):
    """Layer 5 (apply): score a route against the effort-corridor cache
    (build_effort_db.py). For each km, how strongly has the athlete historically
    SUSTAINED hard efforts along it — breadth (share of the km on a corridor
    cell) and repetition (how many rides). This is the positive complement of
    the stop map; compute_effort turns it into a small bonus."""
    cache = load_cache(effort_cache_path)
    meta, cells = cache["meta"], cache["cells"]
    cl, co = meta["cell_lat"], meta["cell_lon"]

    pts = parse_points(route_path)
    if len(pts) < 2:
        return {"per_km_effort": [], "corridor_km": 0}
    cum = [0.0]
    for i in range(1, len(pts)):
        cum.append(cum[-1] + haversine_m(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]))
    n_km = max(1, math.ceil(cum[-1] / 1000))

    def best_cell(lat, lon):
        ci, cj = int(round(lat / cl)), int(round(lon / co))
        best = None
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                c = cells.get(f"{ci + di},{cj + dj}")
                if c and (best is None or c[0] > best[0]):
                    best = c
        return best

    # route heading at each point, for direction-matched corridors
    brg = [0.0] * len(pts)
    for i in range(1, len(pts)):
        brg[i] = bearing_deg(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1])
    brg[0] = brg[1] if len(pts) > 1 else 0.0

    buckets = [{"total": 0, "hit": 0, "sum_pass": 0} for _ in range(n_km)]
    for i, (lat, lon) in enumerate(pts):
        k = min(int(cum[i] / 1000), n_km - 1)
        b = buckets[k]
        b["total"] += 1
        c = best_cell(lat, lon)
        if not c:
            continue
        # directional effort-passes (v2): only efforts ridden THIS way count as a
        # corridor here; fall back to the aggregate for old cells.
        if len(c) >= 3:
            rb = dir_bin(brg[i])
            passes = sum(c[2][(rb + d) % NDIR] for d in (-1, 0, 1))
        else:
            passes = c[0]
        if passes >= EFF_MIN_PASSES:
            b["hit"] += 1
            b["sum_pass"] += passes

    per_km = []
    for k, b in enumerate(buckets):
        frac = b["hit"] / b["total"] if b["total"] else 0.0
        avg = b["sum_pass"] / b["hit"] if b["hit"] else 0.0
        per_km.append({"km": k + 1, "corridor_frac": round(frac, 2),
                       "avg_passes": round(avg, 1)})
    return {"per_km_effort": per_km,
            "corridor_km": sum(1 for r in per_km if r["corridor_frac"] >= 0.5)}


def fmt_text(r):
    lines = [f"Route: {r['route_km']} km scored against {r['rides_in_cache']} past rides",
             f"Coverage: {r['route_coverage_pct']}% of kilometres ridden before"]
    if r["stop_hotspots"]:
        lines.append(f"Known stop hotspots (recurring near-stops): {len(r['stop_hotspots'])}")
        for h in r["stop_hotspots"]:
            lines.append(f"  km {h['km']:>6}: stopped ~{int(h['stop_rate']*100)}% of the time "
                         f"(across {h['passes']} rides, direction-matched)")
    else:
        lines.append("No recurring stop hotspots on the covered sections.")
    q = "".join({"known-clear": ".", "known-stop": "X", "unknown": "?"}[x["quality"]]
                for x in r["per_km_road_quality"])
    lines.append(f"Per-km quality (.=clear X=stop ?=new): {q}")
    return "\n".join(lines)


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        raise SystemExit(__doc__)
    route = args[0]
    cache = None
    if "--cache" in sys.argv:
        cache = sys.argv[sys.argv.index("--cache") + 1]
    if not cache:
        here = os.path.dirname(os.path.abspath(__file__))
        cache = os.path.join(here, "..", "data", "cache", "road_db.json")
    cache = os.path.abspath(cache)
    if not os.path.exists(cache):
        print(json.dumps({"error": "no road_db cache; run build_road_db.py first",
                          "cache_path": cache}) if "--json" in sys.argv
              else f"No road DB cache at {cache}; run build_road_db.py first.")
        raise SystemExit(0)
    res = score(route, cache)
    print(json.dumps(res, indent=2) if "--json" in sys.argv else fmt_text(res))
