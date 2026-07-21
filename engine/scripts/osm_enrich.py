#!/usr/bin/env python3
"""Layer 3: OpenStreetMap enrichment for a GPX route (Overpass API).

Usage: python osm_enrich.py <file.gpx> [--json]

Finds the interruptions that flat, straight roads can still hide: traffic
signals, signalised/level crossings, and roundabouts within ~30 m of the
route. Each is mapped to the route kilometre it sits on, so the workout
designer can avoid starting an effort right where a light is.

Requires internet access to the Overpass API. If the network is unavailable
(sandboxed run, offline, Overpass down), it prints a graceful note and exits
0 with an empty result -- this layer is enrichment, never a hard dependency.
"""
import sys
import os
import json
import math
import urllib.request
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from analyze_gpx import parse_points, haversine_m  # noqa: E402

OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

DEFAULT_OSM_CACHE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "data", "cache", "osm_hazards.json")


def cumdist(pts):
    cum = [0.0]
    for i in range(1, len(pts)):
        cum.append(cum[-1] + haversine_m(pts[i - 1][0], pts[i - 1][1],
                                         pts[i][0], pts[i][1]))
    return cum


def downsample(pts, cum, step_m=100.0):
    """Thin the route to ~one coord per step_m for a compact Overpass query."""
    keep = [0]
    last = 0
    for i in range(1, len(pts)):
        if cum[i] - cum[last] >= step_m:
            keep.append(i)
            last = i
    if keep[-1] != len(pts) - 1:
        keep.append(len(pts) - 1)
    return [pts[i] for i in keep]


def build_query(route_pts, radius_m=30):
    coords = ",".join(f"{la:.5f},{lo:.5f}" for la, lo, _ in route_pts)
    around = f"around:{radius_m},{coords}"
    return f"""[out:json][timeout:90];
(
  node({around})[highway=traffic_signals];
  node({around})[railway=level_crossing];
  node({around})[highway=mini_roundabout];
  node({around})[highway=give_way];
  node({around})[highway=stop];
  way({around})[junction=roundabout];
);
out center;
"""


def build_ways_query(route_pts, radius_m=22):
    """Road ways near the route, with geometry AND node ids, for the priority
    analysis (Layer 3c). `out geom` returns both a `geometry` list and the
    parallel `nodes` id list, which is what analyze_junctions needs to find
    shared junction nodes."""
    coords = ",".join(f"{la:.5f},{lo:.5f}" for la, lo, _ in route_pts)
    cls = ("motorway|trunk|primary|secondary|tertiary|unclassified|"
           "residential|living_street|service|road")
    return (f'[out:json][timeout:40];'
            f'way(around:{radius_m},{coords})["highway"~"^({cls})(_link)?$"];'
            f'out geom;')


def run_overpass(query, timeout=95):
    data = query.encode("utf-8")
    last_err = None
    for url in OVERPASS_URLS:
        try:
            req = urllib.request.Request(url, data=data,
                                         headers={"User-Agent": "gpx-workout-designer-v2/2.0"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as e:
            last_err = e
            continue
    raise last_err if last_err else RuntimeError("Overpass unreachable")


def nearest_km(lat, lon, pts, cum):
    best_d = float("inf")
    best_m = 0.0
    for i, (la, lo, _) in enumerate(pts):
        d = haversine_m(lat, lon, la, lo)
        if d < best_d:
            best_d, best_m = d, cum[i]
    return round(best_m / 1000, 2), round(best_d)


def classify(el):
    tags = el.get("tags", {})
    if tags.get("highway") == "traffic_signals":
        return "traffic_signal"
    if tags.get("railway") == "level_crossing":
        return "level_crossing"
    if tags.get("junction") == "roundabout" or tags.get("highway") == "mini_roundabout":
        return "roundabout"
    if tags.get("highway") == "give_way":
        return "give_way"
    if tags.get("highway") == "stop":
        return "stop_sign"
    return "other"


def route_bbox(pts):
    lats = [p[0] for p in pts]
    lons = [p[1] for p in pts]
    return min(lats), min(lons), max(lats), max(lons)


def bbox_contains(outer, inner):
    """True if inner bbox (s,w,n,e) lies entirely within outer bbox."""
    return (inner[0] >= outer[0] and inner[1] >= outer[1]
            and inner[2] <= outer[2] and inner[3] <= outer[3])


def load_regional_cache(cache_path):
    if not cache_path or not os.path.exists(cache_path):
        return None
    try:
        with open(cache_path, encoding="utf-8") as f:
            return json.load(f)
    except (ValueError, OSError):
        return None


def snap_cached_hazards(cache, pts, cum, radius_m=30):
    """Map every cached hazard near the route to its route km, offline.

    Pre-filters cached hazards to the route bounding box (plus a small margin)
    before the nearest-point search, so a nationwide-sized cache still scores a
    route quickly."""
    s, w, n, e = route_bbox(pts)
    m = radius_m / 111000.0 + 0.001  # deg margin (~radius + 100 m)
    hazards = []
    for h in cache.get("hazards", []):
        la, lo = h["lat"], h["lon"]
        if not (s - m <= la <= n + m and w - m <= lo <= e + m):
            continue
        km, dist = nearest_km(la, lo, pts, cum)
        if dist <= radius_m:
            hazards.append({"type": h["type"], "km": km, "offset_m": dist})
    return hazards


def _dedupe_and_summarize(result, hazards, total_km):
    """Shared post-processing for both the cache and live paths."""
    hazards.sort(key=lambda h: (h["km"], h["type"]))
    deduped = []
    for h in hazards:
        if deduped and h["type"] == deduped[-1]["type"] and abs(h["km"] - deduped[-1]["km"]) < 0.04:
            continue
        deduped.append(h)
    result["hazards"] = deduped

    n_km = max(1, math.ceil(total_km))
    per_km = [0] * n_km
    for h in deduped:
        k = min(int(h["km"]), n_km - 1)
        per_km[k] += 1
    result["per_km_hazards"] = [{"km": i + 1, "count": c} for i, c in enumerate(per_km)]
    counts = {}
    for h in deduped:
        counts[h["type"]] = counts.get(h["type"], 0) + 1
    result["summary"] = counts
    return result


def _add_priority(result, pts, cum, hazards):
    """Layer 3c: live ways fetch + priority/give-way junction analysis, merged
    into `hazards`. Always a live query (turn direction is per-route, so it
    can't be pre-cached); skips gracefully with a note if offline."""
    try:
        route = downsample(pts, cum, step_m=80.0)
        # bounded timeout: a healthy fetch takes ~20 s, so 40 s gives headroom
        # while a slow Overpass degrades to "skipped" in <~80 s total (2
        # mirrors), not minutes.
        ways_raw = run_overpass(build_ways_query(route), timeout=40)
    except Exception as e:  # noqa: BLE001
        result["priority_note"] = (f"priority/give-way analysis skipped "
                                    f"({type(e).__name__}); no turn/priority data")
        return
    import analyze_junctions as L3c
    # explicit signs + signals resolve the priority question -> suppress the
    # inferred junction flags at those km so we don't double-mark.
    resolved = [h["km"] for h in hazards
                if h["type"] in ("traffic_signal", "roundabout", "give_way", "stop_sign")]
    jh = L3c.analyze(pts, cum, ways_raw.get("elements", []), controlled_km=resolved)
    for h in jh:
        if any(abs(h["km"] - r) < 0.06 for r in resolved):
            continue
        hazards.append({k: h[k] for k in ("type", "km", "offset_m") } |
                       {"turn": h.get("turn"), "confidence": h.get("confidence"),
                        "note": h.get("note")})
    result["priority_source"] = "live_overpass"


def enrich(path, cache_path=DEFAULT_OSM_CACHE, use_cache=True, priority=True):
    pts = parse_points(path)
    if len(pts) < 2:
        raise SystemExit("GPX contains fewer than 2 track/route points")
    cum = cumdist(pts)
    total_km = cum[-1] / 1000

    result = {"distance_km": round(total_km, 2), "hazards": [], "available": False}
    hazards = []
    got_base = False

    # Layer 3a: regional cache (offline) when the route lies inside the cached
    # home box. Distant routes fall through to the live query below.
    if use_cache:
        cache = load_regional_cache(cache_path)
        if cache and bbox_contains(cache["meta"]["bbox"], route_bbox(pts)):
            result["available"] = True
            result["source"] = "regional_cache"
            result["cache_generated"] = cache["meta"].get("generated")
            hazards = snap_cached_hazards(cache, pts, cum)
            got_base = True

    # Layer 3b: live Overpass (route outside the cache, or no cache present).
    if not got_base:
        route = downsample(pts, cum, step_m=100.0)
        try:
            raw = run_overpass(build_query(route))
        except Exception as e:  # noqa: BLE001 - graceful fallback is the whole point
            result["note"] = (f"OSM enrichment unavailable ({type(e).__name__}); "
                              "proceeding without junction data.")
            return result
        result["available"] = True
        result["source"] = "live_overpass"
        for el in raw.get("elements", []):
            if "lat" in el and "lon" in el:
                lat, lon = el["lat"], el["lon"]
            elif "center" in el:
                lat, lon = el["center"]["lat"], el["center"]["lon"]
            else:
                continue
            km, dist = nearest_km(lat, lon, pts, cum)
            hazards.append({"type": classify(el), "km": km, "offset_m": dist})

    # Layer 3c: priority / give-way turn analysis (always live; graceful skip).
    if priority:
        _add_priority(result, pts, cum, hazards)

    return _dedupe_and_summarize(result, hazards, total_km)


def fmt_text(r):
    lines = [f"Route: {r['distance_km']} km"]
    if not r.get("available"):
        lines.append(r.get("note", "OSM enrichment unavailable."))
        return "\n".join(lines)
    if not r["hazards"]:
        lines.append("No signals, crossings, roundabouts, give-ways or yield turns near the route.")
        if r.get("priority_note"):
            lines.append(f"  ({r['priority_note']})")
        return "\n".join(lines)
    src = {"regional_cache": "cached OSM", "live_overpass": "live Overpass"}.get(
        r.get("source"), r.get("source", ""))
    summ = ", ".join(f"{v} {k}" for k, v in r["summary"].items())
    lines.append(f"Interruptions on route ({src}): {summ}")
    for h in r["hazards"]:
        extra = ""
        if h.get("confidence"):
            extra = f" [{h['confidence']} confidence: {h.get('note', '')}]"
        elif h.get("turn"):
            extra = f" [{h['turn']} turn]"
        lines.append(f"  km {h['km']:>6}: {h['type']} ({h['offset_m']} m off route){extra}")
    if r.get("priority_note"):
        lines.append(f"  ({r['priority_note']})")
    return "\n".join(lines)


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        raise SystemExit(__doc__)
    res = enrich(args[0], use_cache="--no-cache" not in sys.argv,
                 priority="--no-priority" not in sys.argv)
    if "--save" in sys.argv:
        # Persist the full result so build_map_widget.py --haz <path> can reuse
        # it across finalize-loop rebuilds without re-hitting Overpass.
        save_path = sys.argv[sys.argv.index("--save") + 1]
        with open(save_path, "w", encoding="utf-8") as f:
            json.dump(res, f)
        print(f"saved -> {save_path}")
    if "--json" in sys.argv:
        print(json.dumps(res, indent=2))
    else:
        print(fmt_text(res))
