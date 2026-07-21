"""Deterministic session designer.

Given a route + an objective + athlete context, produce a terrain-matched,
road-aware structured workout — with NO LLM. It:
  1. runs the analysis layers (engine.composite_scores) to get the ranked clean
     blocks and the per-km danger map,
  2. picks a concrete session from the workout bank for the objective, RESHAPED
     to the route (each effort must fit a clean block),
  3. places the interval body on the cleanest blocks that fit, avoiding stops,
  4. assembles warm-up / bridges / cooldown with lap-button buffer padding,
  5. renders segments + intervals.icu syntax + a load estimate + evidence.

The placement math and block ranking are the skill's own functions
(build_map_widget.compute_effort / placement_blocks), so the design lands where
the map colours the road green.
"""
import json
import os

from . import config
from . import engine
from . import syntax

WW = engine.WW

WARMUP_PCT = "55-75"
BRIDGE_PCT = "62-68"
ENDUR_PCT = "63-70"
COOLDOWN_PCT = "55-60"
SURGE_PCT = "82-88"

# Typical total work-minutes per objective — the dose we aim the session at,
# subject to each effort fitting a clean block (reshaping to terrain).
TARGET_WORK_MIN = {"vo2max": 15, "threshold": 36, "sweetspot": 45, "tempo": 45,
                   "anaerobic": 8, "sprint": 4, "endurance": 0}


def _km(minutes: float) -> float:
    return minutes * config.KM_PER_MIN


def _danger(comp) -> list[float]:
    return ([s["km"] for s in comp["stops"]]
            + [h["km"] for h in comp["haz"] if h.get("t") != "right_before_left"])


def _real_blocks(blocks, rkm):
    """High-score placement blocks, excluding the whole-route long fallback."""
    return [b for b in blocks if b["len_km"] < 0.9 * rkm]


def _fallback_session(cat: str) -> dict:
    win = WW.CAT_WIN.get(cat)
    if not win:
        return {"name": "Steady Z2", "category": "endurance", "steady": True,
                "work_pct": ENDUR_PCT}
    work_min = round(sum(win["work"]) / 2, 1)
    reps = round(sum(win["reps"]) / 2)
    pct = round(sum(win["pct"]) / 2)
    rest_min = WW.REST_MIN[cat](work_min)
    return {"name": f"{cat} {reps}x{work_min:g}min", "category": cat, "reps": reps,
            "work_min": work_min, "work_pct": f"{pct-2}-{pct+2}",
            "rest_min": rest_min, "rest_pct": WW.REST_PCT[cat],
            "body_min": reps * work_min + (reps - 1) * rest_min}


def _choose_session(cat: str, rkm: float, blocks: list[dict]) -> dict:
    """Pick the bank candidate for this objective whose SINGLE effort fits a clean
    block (so no effort has to cross a junction), nearest the objective's dose."""
    cands = engine.bank_candidates(rkm).get(cat, [])
    if cat == "endurance":
        return cands[0] if cands else _fallback_session(cat)
    if not cands:
        return _fallback_session(cat)
    real = _real_blocks(blocks, rkm)
    longest = max([b["len_km"] for b in real], default=rkm)
    target = TARGET_WORK_MIN.get(cat, 20)

    def fits(c):
        return _km(c["work_min"]) <= longest + 0.5

    def dose_err(c):
        return abs(c["reps"] * c["work_min"] - target)

    pool = [c for c in cands if fits(c)] or cands
    pool.sort(key=lambda c: (dose_err(c), -c["reps"]))
    return pool[0]


def _cap(block, work_km, rest_km, limit=None):
    """Max whole efforts that fit in a block (work + inter-effort rests)."""
    avail = block["end_km"] - block["start_km"]
    r = 0
    while (r + 1) * work_km + r * rest_km <= avail + 1e-6:
        r += 1
        if limit and r >= limit:
            break
    return r


def _overlap(a, b):
    return not (a["end_km"] <= b["start_km"] or b["end_km"] <= a["start_km"])


def _plan_placement(blocks, rkm, reps, work_km, rest_km):
    """Return groups [(block, reps_in_group)] — non-overlapping, in route order,
    at most 2 groups. A single coherent cluster is preferred; a route whose best
    block can't hold the whole body splits into two clean blocks; anything left
    over is absorbed into the last group (the cluster extends), never a 3rd bridge.
    """
    real = [b for b in _real_blocks(blocks, rkm)
            if (b["end_km"] - b["start_km"]) >= work_km * 0.9]
    ranked = sorted(real, key=lambda b: (-b["score"], -b["len_km"]))

    for b in ranked:                       # a single block that holds everything
        if _cap(b, work_km, rest_km) >= reps:
            return [(b, reps)]

    chosen, placed = [], 0                 # otherwise up to 2 non-overlapping blocks
    for b in ranked:
        if len(chosen) >= 2:
            break
        if any(_overlap(b, c) for c, _ in chosen):
            continue
        r = min(_cap(b, work_km, rest_km), reps - placed)
        if r >= 1:
            chosen.append([b, r])
            placed += r
    if not chosen:                         # nothing fit even one effort -> best available
        base = ranked[0] if ranked else (blocks[0] if blocks else
                                         {"start_km": 1, "end_km": rkm, "len_km": rkm, "score": 40})
        return [(base, reps)]
    if placed < reps:                      # absorb remainder into the last group
        chosen[-1][1] += reps - placed
    chosen.sort(key=lambda x: x[0]["start_km"])
    return [(b, r) for b, r in chosen]


def _avoid_start(a, danger, block_end=None):
    """Nudge an effort's start forward off a danger km (validator forbids a work
    step starting within 300 m of a stop/junction). Small, bounded search."""
    shifted = 0.0
    while any(abs(a - d) <= 0.32 for d in danger) and shifted < 1.25:
        a += 0.25
        shifted += 0.25
    return round(a, 2)


def route_context(gpx_path: str, haz_file: str, cleared_km=None) -> dict:
    """Run all analysis layers for a route ONCE. The result depends only on the
    GPX + the athlete's cleared corrections, so callers cache it per session —
    browsing workouts / re-designing then skips the expensive re-analysis."""
    l1 = engine.analyze_route(gpx_path)
    l2 = engine.score_roads(gpx_path)
    l5 = engine.score_effort(gpx_path)
    l3 = None
    if haz_file and os.path.exists(haz_file):
        try:
            l3 = json.load(open(haz_file, encoding="utf-8"))
        except Exception:  # noqa: BLE001
            l3 = None
    comp = engine.composite_scores(gpx_path, l1, l2, l3, l5, cleared_km)
    return {"l1": l1, "comp": comp, "profile": _elev_profile(gpx_path, l1)}


def _elev_profile(gpx_path: str, l1: dict, n: int = 240) -> list | None:
    """Downsampled [km, ele_m] pairs — the elevation backdrop for the app's
    native timeline. None when the GPX carries no elevation."""
    if not l1.get("has_elevation"):
        return None
    pts = engine.L1.parse_points(gpx_path)
    cum = engine.MW.cumdist(pts)
    total = cum[-1]
    if total <= 0:
        return None
    prof, j = [], 0
    for k in range(n + 1):
        target = total * k / n
        while j < len(cum) - 1 and cum[j] < target:
            j += 1
        if pts[j][2] is not None:
            prof.append([round(cum[j] / 1000, 2), round(pts[j][2], 1)])
    return prof


def design(gpx_path: str, objective: str, ftp: int, haz_file: str,
           cleared_km=None, title: str | None = None, session: dict | None = None,
           ctx: dict | None = None) -> dict:
    # An explicitly chosen bank session (from the app's picker) overrides the
    # automatic pick and sets the category used for validation/naming.
    if session:
        objective = session.get("category", objective)
    ctx = ctx or route_context(gpx_path, haz_file, cleared_km)
    l1, comp = ctx["l1"], ctx["comp"]
    rkm = l1["distance_km"]
    blocks = comp["blocks"]
    danger = _danger(comp)

    sess = session or _choose_session(objective, rkm, blocks)
    segs: list[dict] = []
    rep_no = 0
    is_steady = sess.get("steady") or "reps" not in sess

    if objective == "endurance" and is_steady:
        wu = round(min(5.0, rkm * 0.08), 1)
        cd = round(min(8.0, max(4.0, rkm * 0.12)), 1)
        segs = [
            {"name": "Warm-up", "a": 0.0, "b": wu, "pct": WARMUP_PCT, "kind": "warmup"},
            {"name": "Endurance Z2", "a": wu, "b": round(rkm - cd, 1), "pct": ENDUR_PCT, "kind": "rest"},
            {"name": "Cooldown", "a": round(rkm - cd, 1), "b": round(rkm, 1), "pct": COOLDOWN_PCT, "kind": "cooldown"},
        ]
        placed = reps = overflow = 0
    else:
        reps = int(sess["reps"])
        work_km = _km(sess["work_min"])
        rest_km = _km(sess.get("rest_min", sess["work_min"]))
        work_pct = sess["work_pct"] if objective != "endurance" else SURGE_PCT
        rest_pct = sess.get("rest_pct", BRIDGE_PCT)

        groups = _plan_placement(blocks, rkm, reps, work_km, rest_km)
        placed = sum(r for _, r in groups)
        # reps the last group absorbed beyond its block's clean capacity spill
        # past the block end onto unvetted road — surfaced as a warning below
        overflow = max(0, groups[-1][1] - _cap(groups[-1][0], work_km, rest_km))

        starts = [(_avoid_start(float(b["start_km"]), danger), b, r) for b, r in groups]
        first_start = starts[0][0]
        segs.append({"name": "Warm-up", "a": 0.0, "b": round(first_start, 1),
                     "pct": WARMUP_PCT, "kind": "warmup", "buf": True})
        prev_end = None
        for gi, (start, _b, n) in enumerate(starts):
            if gi > 0:
                segs.append({"name": f"Endurance bridge {gi}", "a": round(prev_end, 1),
                             "b": round(start, 1), "pct": BRIDGE_PCT, "kind": "rest", "buf": True})
            a = start
            for i in range(n):
                a = _avoid_start(a, danger)
                rep_no += 1
                wb = a + work_km
                segs.append({"name": f"{_short(objective)} {rep_no} @{work_pct}%",
                             "a": round(a, 2), "b": round(wb, 2), "pct": work_pct, "kind": "work"})
                a = wb
                if i < n - 1:
                    rb = a + rest_km
                    segs.append({"name": "Float", "a": round(a, 2), "b": round(rb, 2),
                                 "pct": rest_pct, "kind": "rest"})
                    a = rb
            prev_end = a
        tail = rkm - prev_end
        if tail > 10:
            cd = min(8.0, max(5.0, tail * 0.25))
            segs.append({"name": "Endurance home", "a": round(prev_end, 1),
                         "b": round(rkm - cd, 1), "pct": ENDUR_PCT, "kind": "cooldown"})
            segs.append({"name": "Cooldown", "a": round(rkm - cd, 1), "b": round(rkm, 1),
                         "pct": COOLDOWN_PCT, "kind": "cooldown"})
        elif tail > 0.3:
            segs.append({"name": "Cooldown", "a": round(prev_end, 1), "b": round(rkm, 1),
                         "pct": COOLDOWN_PCT, "kind": "cooldown"})

    segs[0]["a"] = 0.0
    segs[-1]["b"] = round(rkm, 1)

    txt = syntax.to_syntax(segs)
    issues = syntax.validate(segs, rkm, objective, comp["stops"], comp["haz"])
    if overflow:
        lb = groups[-1][0]
        issues.append({"level": "warn",
                       "msg": f"{overflow} effort(s) don't fit inside the clean block "
                              f"km {lb['start_km']}-{lb['end_km']} and extend beyond it — "
                              "check the map before pushing"})
    load = _estimate_load(segs, ftp)
    evidence = _evidence(segs, comp)
    if not title:
        title = _title(objective, sess, reps if not is_steady else 0)

    return {
        "objective": objective, "session_name": sess.get("name"),
        "session_plan": sess.get("plan", ""),
        "reps_placed": placed if not is_steady else 0,
        "reps_requested": reps if not is_steady else 0,
        "title": title, "segs": segs, "syntax": txt,
        "written_km": syntax.total_written_km(segs), "route_km": rkm, "ftp": ftp,
        "load_estimate": load["tss"], "if_estimate": load["if"],
        "duration_min": load["minutes"], "evidence": evidence, "issues": issues,
        "blocks": blocks[:6], "stops": comp["stops"], "haz": comp["haz"],
        "profile": ctx.get("profile"),
    }


def _short(objective: str) -> str:
    return {"vo2max": "VO2", "threshold": "Thr", "sweetspot": "SS", "tempo": "Tempo",
            "anaerobic": "Ana", "sprint": "Sprint", "endurance": "Surge"}.get(objective, "Effort")


def _title(objective: str, sess: dict, reps: int, prefix: bool = True) -> str:
    label = {"vo2max": "VO2max", "threshold": "Threshold", "sweetspot": "Sweet Spot",
             "tempo": "Tempo", "anaerobic": "Anaerobic", "sprint": "Sprint",
             "endurance": "Endurance"}.get(objective, objective.title())
    if reps and sess.get("work_min"):
        wm = sess["work_min"]
        wm = f"{int(wm)}min" if abs(wm - round(wm)) < 0.05 else f"{wm:g}min"
        core = f"{label} {reps}x{wm}"
    else:
        core = label
    return f"Prodrive 65 - {core} v1" if prefix else core


def _estimate_load(segs, ftp, unit="km") -> dict:
    tot_h = acc = 0.0
    for s in segs:
        span = s["b"] - s["a"]
        h = span / 60.0 if unit == "min" else span / config.REF_SPEED_KMH
        lo, hi = syntax._pct_lo_hi(s["pct"])
        intensity = min(1.25, (lo + hi) / 2 / 100.0)
        acc += intensity ** 2 * h
        tot_h += h
    if_est = (acc / tot_h) ** 0.5 if tot_h else 0.0
    return {"tss": round(acc * 100), "if": round(if_est, 2), "minutes": round(tot_h * 60)}


# ------------------------------------------------ no-route (time-based) ------
WARMUP_MIN = 15.0
COOLDOWN_MIN = 10.0


def design_blank(objective: str, ftp: int, session: dict | None = None,
                 title: str | None = None) -> dict:
    """Build a structured workout with NO route — time-based, no terrain/map.
    Warm-up + the chosen session's intervals + cool-down, in minutes. This is
    the starting point the athlete then edits/drags in the segment table.
    """
    if session:
        objective = session.get("category", objective)
    sess = session or _fallback_session(objective)
    segs: list[dict] = [{"name": "Warm-up", "a": 0.0, "b": WARMUP_MIN, "pct": WARMUP_PCT, "kind": "warmup"}]
    a = WARMUP_MIN
    reps = 0
    is_steady = sess.get("steady") or "reps" not in sess

    if objective == "endurance" and is_steady:
        segs.append({"name": "Endurance Z2", "a": a, "b": round(a + 45, 1), "pct": ENDUR_PCT, "kind": "rest"})
        a += 45
    else:
        reps = int(sess["reps"])
        wm = float(sess["work_min"])
        rm = float(sess.get("rest_min", wm))
        wp = sess["work_pct"] if objective != "endurance" else SURGE_PCT
        rp = sess.get("rest_pct", BRIDGE_PCT)
        for i in range(reps):
            b = a + wm
            segs.append({"name": f"{_short(objective)} {i+1} @{wp}%", "a": round(a, 2),
                         "b": round(b, 2), "pct": wp, "kind": "work"})
            a = b
            if i < reps - 1:
                b = a + rm
                segs.append({"name": "Float", "a": round(a, 2), "b": round(b, 2), "pct": rp, "kind": "rest"})
                a = b
    segs.append({"name": "Cool-down", "a": round(a, 1), "b": round(a + COOLDOWN_MIN, 1),
                 "pct": COOLDOWN_PCT, "kind": "cooldown"})
    total = segs[-1]["b"]

    txt = syntax.to_syntax(segs, unit="min")
    issues = syntax.validate_blank(segs, objective)
    load = _estimate_load(segs, ftp, unit="min")
    if not title:
        title = _title(objective, sess, reps, prefix=False)
    return {
        "mode": "blank", "objective": objective, "session_name": sess.get("name"),
        "session_plan": sess.get("plan", ""), "reps_placed": reps, "reps_requested": reps,
        "title": title, "segs": segs, "syntax": txt, "written_km": None,
        "route_km": None, "total_min": total, "ftp": ftp,
        "load_estimate": load["tss"], "if_estimate": load["if"], "duration_min": load["minutes"],
        "evidence": [], "issues": issues, "blocks": [], "stops": [], "haz": [],
        "profile": None,
    }


def _evidence(segs, comp) -> list[dict]:
    cont, qual, corridor = comp["cont"], comp["qual"], comp["corridor"]
    out = []
    for s in segs:
        if s["kind"] not in ("work", "tt"):
            continue
        a, b = s["a"], s["b"]
        kms = range(int(a) + 1, int(b) + 2)
        cvals = [cont.get(k) for k in kms if cont.get(k) is not None]
        avg_cont = round(sum(cvals) / len(cvals)) if cvals else None
        quals = [qual.get(k, "unknown") for k in kms]
        clear = sum(1 for q in quals if q == "known-clear")
        stop = sum(1 for q in quals if q == "known-stop")
        corr = max([(corridor.get(k) or {}).get("avg_passes", 0) for k in kms] or [0])
        note = []
        if avg_cont is not None:
            note.append(f"continuity {avg_cont}")
        if clear:
            note.append(f"ridden clean ({clear} km)")
        if stop:
            note.append(f"{stop} known-stop km!")
        if corr >= 2:
            note.append(f"corridor {round(corr)}x")
        out.append({"name": s["name"], "km": f"{round(a,1)}-{round(b,1)}",
                    "note": ", ".join(note) or "no history — geometry only"})
    return out
