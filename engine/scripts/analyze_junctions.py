#!/usr/bin/env python3
"""Layer 3c: priority / give-way analysis at the junctions a route passes.

The base OSM layer (osm_enrich.py) finds signals, crossings and roundabouts.
This adds the interruptions those miss: places where the rider must *yield* even
with no light -- most importantly a LEFT turn (right-hand traffic) that crosses
or joins a road where traffic from the right / oncoming has priority.

Three signals, decreasing confidence:
  1. give-way / stop signs   -> handled in osm_enrich (OSM highway=give_way|stop
                                 nodes); reliable where mapped.
  2. yield_left (medium)     -> the route turns LEFT onto / across a road of
                                 equal-or-higher class than the one it is on.
  3. right_before_left (low) -> an uncontrolled junction of ~equal roads with a
                                 side road entering from the rider's right.

This module is PURE geometry: it takes route points + the raw Overpass `way`
elements (fetched by the caller, so this stays offline-testable) and returns
junction hazards mapped to route km. No network here.
"""
import math

# highway class -> importance rank (bigger = more major / more likely priority)
RANK = {
    "motorway": 8, "motorway_link": 8, "trunk": 7, "trunk_link": 7,
    "primary": 6, "primary_link": 6, "secondary": 5, "secondary_link": 5,
    "tertiary": 4, "tertiary_link": 4, "unclassified": 3, "residential": 3,
    "road": 3, "living_street": 2, "service": 2,
    "track": 1, "cycleway": 1, "path": 1, "footway": 1, "pedestrian": 1,
}
ALIGN_DEG = 35.0     # a branch within this of the travel line is "the route road"
TURN_DEG = 25.0      # |turn| beyond this counts as a real left/right turn
NEAR_M = 18.0        # junction must be this close to the route to count
YIELD_MIN_RANK = 4   # cross road must be at least tertiary to bother flagging


def _bearing(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    dlo = lo2 - lo1
    x = math.sin(dlo) * math.cos(la2)
    y = math.cos(la1) * math.sin(la2) - math.sin(la1) * math.cos(la2) * math.cos(dlo)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


def _hav(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 6371000 * math.asin(min(1, math.sqrt(h)))


def _norm180(d):
    return ((d + 540) % 360) - 180


def _rank(cls):
    return RANK.get(cls, 3)


def _route_bearings(pts, cum, i, span_m=14.0):
    """Incoming (into) and outgoing (out of) travel bearing at route index i,
    measured over ~span_m each side so a single noisy point can't flip it."""
    jb = i
    while jb > 0 and cum[i] - cum[jb] < span_m:
        jb -= 1
    jf = i
    while jf < len(pts) - 1 and cum[jf] - cum[i] < span_m:
        jf += 1
    inc = _bearing(pts[jb], pts[i]) if jb < i else _bearing(pts[i], pts[min(i + 1, len(pts) - 1)])
    out = _bearing(pts[i], pts[jf]) if jf > i else inc
    return inc, out


def _nearest_route(node, pts, cum):
    best_d, best_i = float("inf"), 0
    for i, p in enumerate(pts):
        d = _hav(node, (p[0], p[1]))
        if d < best_d:
            best_d, best_i = d, i
    return best_i, best_d


def _branches_by_node(ways):
    """From raw Overpass ways (with `nodes` ids + parallel `geometry`), return
    {node_id: {"coord": (lat,lon), "br": [(bearing, class), ...]}} where each
    branch is a road segment leaving that node."""
    nodes = {}
    for w in ways:
        cls = w.get("tags", {}).get("highway")
        ids = w.get("nodes") or []
        geom = w.get("geometry") or []
        if len(ids) != len(geom) or len(ids) < 2:
            continue
        for k, nid in enumerate(ids):
            here = (geom[k]["lat"], geom[k]["lon"])
            slot = nodes.setdefault(nid, {"coord": here, "br": [], "ways": 0})
            slot["ways"] += 1
            if k + 1 < len(geom):
                slot["br"].append((_bearing(here, (geom[k + 1]["lat"], geom[k + 1]["lon"])), cls))
            if k - 1 >= 0:
                slot["br"].append((_bearing(here, (geom[k - 1]["lat"], geom[k - 1]["lon"])), cls))
    return nodes


def analyze(pts, cum, ways, controlled_km=None, near_m=NEAR_M):
    """Return a list of junction hazards: {type, km, offset_m, turn, confidence}.
    `controlled_km` is a list of route-km that already have a signal/roundabout,
    so we don't second-guess a controlled junction with a right-before-left."""
    controlled_km = controlled_km or []
    nodes = _branches_by_node(ways)
    # a junction = a node where >=2 road segments meet from >=2 ways
    out = []
    seen = set()
    for nid, info in nodes.items():
        if info["ways"] < 2 or len(info["br"]) < 3:
            continue
        i, d = _nearest_route(info["coord"], pts, cum)
        if d > near_m:
            continue
        km = round(cum[i] / 1000, 2)
        key = round(km, 1)
        if key in seen:
            continue
        inc, outb = _route_bearings(pts, cum, i)
        turn = _norm180(outb - inc)
        # classify branches into route-path vs side roads
        route_ranks, side = [], []
        for (b, cls) in info["br"]:
            d_out = abs(_norm180(b - outb))
            d_back = abs(_norm180(b - (inc + 180)))
            if d_out <= ALIGN_DEG or d_back <= ALIGN_DEG:
                route_ranks.append(_rank(cls))
            else:
                side.append((b, cls))
        if not side:
            continue
        route_rank = max(route_ranks) if route_ranks else 3
        cross_rank = max(_rank(c) for _, c in side)
        # is a side road entering from the rider's RIGHT? (rel bearing 20..160)
        right_side = any(20 <= _norm180(b - inc) <= 160 for b, _ in side)
        controlled = any(abs(km - ck) < 0.05 for ck in controlled_km)

        haz = None
        if turn < -TURN_DEG and cross_rank >= route_rank and cross_rank >= YIELD_MIN_RANK:
            # LEFT turn onto/across an equal-or-bigger road: expect to yield
            haz = {"type": "yield_left", "confidence": "medium",
                   "note": "left turn onto/across a priority road"}
        elif (not controlled and right_side and cross_rank >= route_rank
              and cross_rank >= YIELD_MIN_RANK and abs(turn) < 120):
            # Only when a genuinely bigger road (tertiary+) enters from the right
            # at an uncontrolled junction -- residential-vs-residential is left to
            # the history layer / give-way signs, to keep this from swarming.
            haz = {"type": "right_before_left", "confidence": "low",
                   "note": "uncontrolled junction, bigger road entering from the right"}
        if haz:
            haz.update({"km": km, "offset_m": round(d),
                        "turn": "left" if turn < -TURN_DEG else ("right" if turn > TURN_DEG else "straight")})
            out.append(haz)
            seen.add(key)
    out.sort(key=lambda h: h["km"])
    return out
