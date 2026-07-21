"""Build the JSON the native in-app map renders from.

Everything here is derived from the SAME cached analysis the designer uses
(engine.composite_scores via designer.route_context) plus the OSM street
basemap. The browser no longer runs the packaged widget in an iframe — it
draws the SVG itself from this payload, so the map, legend, hazard popovers
and Street View are all first-class app UI.

The heavy bits (street fetch, per-km fusion) are computed once and cached on
the session; a veto (cleared_km change) invalidates and recomputes.
"""
import math

from . import engine

MW = engine.MW
QCODE = {"known-clear": "clear", "known-stop": "stop", "unknown": "new"}


def _perkm(comp: dict) -> list[dict]:
    """Per-km road verdict + final composite tier (the map's route colouring).
    Scoring is already fused server-side (geometry + history + hazards +
    corridors), so the client only draws — no live re-scoring needed."""
    scores = comp["scores"]
    cont, qual, corridor = comp["cont"], comp["qual"], comp["corridor"]
    out = []
    for k in range(1, comp["nkm"] + 1):
        s = scores[k - 1]
        out.append({
            "km": k, "tier": MW.score_tier(s), "score": round(s),
            "cont": round(cont.get(k, 0)),
            "ql": QCODE.get(qual.get(k, "unknown"), "new"),
            "corr": round((corridor.get(k) or {}).get("avg_passes", 0), 1),
        })
    return out


def _route_line(gpx_path: str, max_pts: int = 900) -> tuple[list, list]:
    """[[lat,lon,km], ...] downsampled for the base polyline, plus bounds."""
    pts = engine.L1.parse_points(gpx_path)
    cum = MW.cumdist(pts)
    step = max(1, len(pts) // max_pts)
    line = [[round(pts[i][0], 5), round(pts[i][1], 5), round(cum[i] / 1000, 3)]
            for i in range(0, len(pts), step)]
    # always include the final point so the line closes on the real finish
    last = [round(pts[-1][0], 5), round(pts[-1][1], 5), round(cum[-1] / 1000, 3)]
    if line[-1][2] != last[2]:
        line.append(last)
    lats = [p[0] for p in line]
    lons = [p[1] for p in line]
    bounds = {"minLa": min(lats), "maxLa": max(lats),
              "minLo": min(lons), "maxLo": max(lons)}
    return line, bounds


def _streets(gpx_path: str) -> list:
    """Near-route OSM street basemap (faint context lines). Cached-backed;
    returns [] when the street cache is absent."""
    try:
        pts = engine.L1.parse_points(gpx_path)
        return MW.get_streets(pts, buffer_m=280, max_points=18000, use_cache=True)
    except Exception:  # noqa: BLE001
        return []


def build(gpx_path: str, ctx: dict) -> dict:
    """Assemble the full map payload from a cached route context."""
    comp = ctx["comp"]
    line, bounds = _route_line(gpx_path)
    return {
        "route": line,
        "bounds": bounds,
        "route_km": ctx["l1"]["distance_km"],
        "perkm": _perkm(comp),
        "haz": comp["haz"],       # [{km,t,pos,c,turn}]
        "stops": comp["stops"],   # [{km,pos,stop_rate,passes}]
        "blocks": comp["blocks"][:6],
        "streets": _streets(gpx_path),
    }
