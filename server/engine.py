"""Thin wrappers around the skill's analysis scripts, imported as modules.

Every heavy computation here is the SAME code the skill runs — we just call the
importable functions directly (no subprocess, no --json text parsing) and hand
back dicts. Nothing about the terrain/road/effort logic is reimplemented.
"""
import sys
import json
from datetime import date

from . import config

# Make the shared engine importable, exactly as the skill's own scripts do.
sys.path.insert(0, str(config.ENGINE_DIR))

import analyze_gpx as L1            # noqa: E402
import score_route as L2           # noqa: E402
import workout_windows as WW       # noqa: E402
import suggest_workout as SUG      # noqa: E402
import build_map_widget as MW      # noqa: E402

try:
    import osm_enrich as L3        # noqa: E402
except Exception:                   # noqa: BLE001
    L3 = None


# ---------------------------------------------------------------- analysis ---
def analyze_route(gpx_path: str) -> dict:
    """Layer 1 — terrain + geometry (effort_blocks, per-km continuity/gradient)."""
    return L1.analyze(gpx_path)


def score_roads(gpx_path: str) -> dict | None:
    """Layer 2 — ride-history road quality + stop hotspots. None if no cache."""
    if not config.ROAD_DB.exists():
        return None
    try:
        return L2.score(gpx_path, str(config.ROAD_DB))
    except Exception as e:  # noqa: BLE001
        return {"error": f"{type(e).__name__}: {e}"}


def score_effort(gpx_path: str) -> dict | None:
    """Layer 5 — proven effort corridors. None if no cache."""
    if not config.EFFORT_DB.exists():
        return None
    try:
        return L2.score_effort(gpx_path, str(config.EFFORT_DB))
    except Exception as e:  # noqa: BLE001
        return {"error": f"{type(e).__name__}: {e}"}


def enrich_osm(gpx_path: str, save_path: str, priority: bool = False) -> dict:
    """Layer 3 — OSM hazards. Cached-first, degrades to {'available': False}.

    priority defaults False here: the live turn-priority Overpass fetch is slow
    (~20 s) and usually blocked in this environment; the base hazard cache is
    what matters. Result is persisted to save_path for fast map rebuilds.
    """
    if L3 is None:
        return {"available": False, "hazards": [], "note": "osm_enrich unavailable"}
    try:
        res = L3.enrich(gpx_path, use_cache=True, priority=priority)
    except Exception as e:  # noqa: BLE001
        res = {"available": False, "hazards": [], "note": f"{type(e).__name__}: {e}"}
    try:
        with open(save_path, "w", encoding="utf-8") as f:
            json.dump(res, f)
    except OSError:
        pass
    return res


# ------------------------------------------------------------- suggestion ---
def _bank():
    return json.load(open(config.WORKOUT_BANK, encoding="utf-8")).get("workouts", [])


def rank_objectives(tsb: float, phase: str, last: str | None,
                    terrain: str, route_km: float) -> dict:
    """Deterministic objective ranking (suggest_workout.select_category) plus a
    seed session per candidate. Returns the ranked list the menu is built from."""
    top, cand, reason = SUG.select_category(tsb, phase, last, terrain)
    minutes = route_km / config.REF_SPEED_KMH * 60
    bank = _bank()
    out = []
    for cat in cand:
        w = SUG.pick(bank, cat, minutes, 0)
        out.append({
            "objective": cat,
            "seed": None if not w else {
                "name": w.get("name"), "plan": w.get("plan", ""),
                "structure": w.get("structure"), "duration_min": w.get("duration_min"),
            },
        })
    return {"top": top, "reason": reason, "candidates": out}


def bank_candidates(route_km: float) -> dict:
    """Per-category renderable interval sessions (reuses the widget's own picker
    source), each with reps/work/rest and a body length that fits the route."""
    return MW.build_candidates(str(config.WORKOUT_BANK), route_km)


_CAT_ORDER = ["vo2max", "threshold", "sweetspot", "tempo", "anaerobic", "sprint", "endurance"]


def _mid_pct(pct):
    s = str(pct)
    if "-" in s:
        lo, hi = s.split("-", 1)
        try:
            return round((float(lo) + float(hi)) / 2)
        except ValueError:
            return s
    return s


def list_workouts(route_km: float) -> list[dict]:
    """Flat, ordered, search-ready workout list for the app's picker. Each item
    carries a stable id (category:index within its category), a compact structure
    string, an estimated duration, and a lowercase search blob."""
    cands = bank_candidates(route_km)
    out = []
    for cat in _CAT_ORDER:
        for i, c in enumerate(cands.get(cat, [])):
            name = c.get("name") or cat
            plan = c.get("plan", "")
            tokens = [cat, name, plan]
            if c.get("steady"):
                structure = "Steady Z2 endurance"
                body = round(c.get("body_min", route_km / config.REF_SPEED_KMH * 60))
                tokens += ["steady", "z2", "endurance"]
            else:
                reps, wm = c.get("reps"), c.get("work_min")
                wm_s = f"{int(wm)}" if wm and abs(wm - round(wm)) < 0.05 else f"{wm:g}"
                structure = f"{reps}× {wm_s}min @ {_mid_pct(c.get('work_pct'))}% FTP"
                body = round(c.get("body_min", 0))
                # search-friendly tokens: "4x8", "4x8min", "8min"
                tokens += [structure, f"{reps}x{wm_s}", f"{reps}x{wm_s}min", f"{wm_s}min"]
            item = {
                "id": f"{cat}:{i}", "category": cat, "index": i,
                "name": name, "plan": plan, "structure": structure,
                "reps": c.get("reps"), "work_min": c.get("work_min"), "body_min": body,
                "search": " ".join(str(t) for t in tokens).lower(),
            }
            out.append(item)
    return out


def get_workout(route_km: float, category: str, index: int) -> dict | None:
    """Resolve a picker selection (category, index) back to the concrete bank
    candidate the designer needs."""
    cands = bank_candidates(route_km).get(category, [])
    if 0 <= index < len(cands):
        return cands[index]
    return None


# ----------------------------------------------- composite effort scoring ---
def composite_scores(gpx_path: str, l1: dict, l2: dict | None,
                     l3: dict | None, l5: dict | None, cleared_km=None):
    """Fuse all layers into the per-km 'can I hold an effort here' score and the
    ranked placement blocks — the SAME functions that colour the map, so the
    designer and the map agree by construction.

    Returns (scores[1-based list], blocks, cont, grad, qual, stops, haz, corridor).
    """
    import math
    pts = L1.parse_points(gpx_path)
    cum = MW.cumdist(pts)
    nkm = max(1, math.ceil(cum[-1] / 1000))

    def pt_at_km(k):
        m = k * 1000
        for i in range(len(cum)):
            if cum[i] >= m:
                return [round(pts[i][0], 5), round(pts[i][1], 5)]
        return [round(pts[-1][0], 5), round(pts[-1][1], 5)]

    qual, stops = {}, []
    if l2 and "per_km_road_quality" in l2:
        qual = {q["km"]: q["quality"] for q in l2["per_km_road_quality"]}
        stops = [{"km": round(h["km"], 2), "pos": pt_at_km(h["km"]),
                  "stop_rate": h.get("stop_rate"), "passes": h.get("passes")}
                 for h in l2["stop_hotspots"]]

    haz = []
    if l3 and l3.get("available"):
        haz = [{"km": round(h["km"], 2), "t": h["type"], "pos": pt_at_km(h["km"]),
                "c": h.get("confidence"), "turn": h.get("turn")}
               for h in l3["hazards"]]

    corridor = {}
    if l5 and "per_km_effort" in l5:
        corridor = {r["km"]: r for r in l5["per_km_effort"]}

    # Athlete overrides: drop cleared km before scoring (mirrors --clear).
    if cleared_km:
        keep = lambda k: all(abs(k - c) > 0.2 for c in cleared_km)
        haz = [h for h in haz if keep(h["km"])]
        stops = [s for s in stops if keep(s["km"])]

    scores, cont, grad = MW.compute_effort(l1, qual, haz, stops, nkm, corridor)
    blocks = MW.placement_blocks(l1, scores, grad, nkm)
    return {
        "scores": scores, "blocks": blocks, "cont": cont, "grad": grad,
        "qual": qual, "stops": stops, "haz": haz, "corridor": corridor, "nkm": nkm,
    }


# ------------------------------------------------------------- recent load ---
def _zone(if_pct):
    if if_pct is None:
        return "?"
    if if_pct < 60:
        return "recovery"
    if if_pct < 76:
        return "endurance"
    if if_pct < 88:
        return "tempo/SS"
    if if_pct < 95:
        return "threshold-"
    return "hard"


def _field(a: dict, *names):
    """First present, non-None value among alternative field names. The raw
    intervals.icu REST API prefixes many fields with icu_ (icu_training_load,
    icu_intensity, moving_time, distance); the MCP used un-prefixed aliases."""
    for n in names:
        if a.get(n) is not None:
            return a[n]
    return None


def summarize_load(activities: list[dict], days: int = 14) -> dict:
    """Compact 14-day load/recency summary (mirrors recent_load.py's numbers) for
    the context panel and the TSB/last-stimulus inputs to objective ranking."""
    def _date(a):
        return (a.get("start_date_local") or a.get("start_date") or "")
    acts = [a for a in activities if _date(a)]
    acts.sort(key=_date, reverse=True)
    if not acts:
        return {"rows": [], "load7": 0, "load14": 0, "last_quality_days": None,
                "last_stimulus": None, "headroom": True}
    newest = _date(acts[0])[:10]
    y, m, d = map(int, newest.split("-"))
    cutoff = date(y, m, d).toordinal() - days
    rows, load7, load14, hard = [], 0.0, 0.0, []
    for a in acts:
        dd = _date(a)[:10]
        yy, mm, ddd = map(int, dd.split("-"))
        o = date(yy, mm, ddd).toordinal()
        if o < cutoff:
            break
        age = date(y, m, d).toordinal() - o
        load = _field(a, "icu_training_load", "training_load", "power_load") or 0
        ifp = _field(a, "icu_intensity", "intensity_factor")
        moving = _field(a, "moving_time", "moving_time_seconds") or 0
        z = _zone(ifp)
        rows.append({"age": age, "date": dd, "type": a.get("type", "?"),
                     "min": round(moving / 60),
                     "load": round(load), "if": round(ifp) if ifp is not None else None,
                     "stimulus": z, "name": a.get("name", "")})
        load14 += load
        if age < 7:
            load7 += load
        if z in ("threshold-", "hard") and a.get("type") in ("Ride", "VirtualRide", "Run"):
            hard.append((age, z, a.get("name", "")))
    last_q = min(hard)[0] if hard else None
    # last stimulus category (coarse) for the novelty rule in objective ranking
    last_stim = None
    if rows:
        top = rows[0]["stimulus"]
        last_stim = {"tempo/SS": "sweetspot", "threshold-": "threshold",
                     "hard": "vo2max"}.get(top)
    return {"rows": rows, "load7": round(load7), "load14": round(load14),
            "last_quality_days": last_q, "quality_days": len(hard),
            "last_stimulus": last_stim, "headroom": not hard}
