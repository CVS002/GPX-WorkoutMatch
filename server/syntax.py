"""Segments -> intervals.icu distance-based workout syntax, plus the guardrail
validator that every design and every map adjustment must pass before it can
reach the calendar.

A segment is {name, a, b, pct, kind, buf}:
  a, b  = route km (contiguous, tiling 0..route_km)
  pct   = intensity as a %FTP range string ("111-115") or single number
  kind  = warmup | work | rest | tt | cooldown
  buf   = True for structural buffers that get +BUFFER_KM lap-button padding
"""
from . import config
from . import engine

WW = engine.WW  # workout_windows: CAT_WIN, valid_session, parse_struct


def _fmt_km(km: float) -> str:
    km = round(km, 1)
    if abs(km - round(km)) < 0.05:
        return f"{int(round(km))}km"
    return f"{km:g}km"


def _pct_str(pct) -> str:
    return str(pct).strip().rstrip("%")


def written_distance_km(seg: dict) -> float:
    """Ridden->written distance: structural buffers are written BUFFER_KM longer
    than the road they cover (the athlete ends them with the lap button)."""
    d = seg["b"] - seg["a"]
    if seg.get("buf"):
        d += config.BUFFER_KM
    return d


def _fmt_min(m: float) -> str:
    """Time step in intervals.icu's documented tokens: whole minutes as `Nm`
    (its minute unit), fractional as seconds (`90s`). Our distance steps always
    use `km`, so `m` is never ambiguous with metres."""
    if abs(m - round(m)) < 0.02:
        return f"{int(round(m))}m"
    return f"{int(round(m * 60))}s"


def to_syntax(segs: list[dict], unit: str = "km") -> str:
    """One line per segment: `- <name> <amount> <pct>% power=3s`.

    unit="km": distance-based (route workouts), structural buffers padded.
    unit="min": time-based (no-route workouts) — plain durations, no padding.

    Explicit per-step (not collapsed into `Nx` repeats) — matches the athlete's
    own convention ("Lap 1 / Lap 2 / Lap 3").
    """
    lines = []
    for s in segs:
        if unit == "min":
            amount = _fmt_min(s["b"] - s["a"])
        else:
            amount = _fmt_km(written_distance_km(s))
        lines.append(f"- {s['name']} {amount} {_pct_str(s['pct'])}% power=3s")
    return "\n".join(lines)


def total_written_km(segs: list[dict]) -> float:
    return round(sum(written_distance_km(s) for s in segs), 1)


def _pct_lo_hi(pct):
    s = _pct_str(pct)
    try:
        if "-" in s:
            lo, hi = s.split("-", 1)
            return float(lo), float(hi)
        return float(s), float(s)
    except ValueError:      # hand-typed garbage — let the no-intensity check report it
        return 0.0, 0.0


def _pct_valid(pct) -> bool:
    """True if pct is a parseable number or lo-hi range (what to_syntax emits)."""
    s = _pct_str(pct) if pct not in (None, "") else ""
    if not s:
        return False
    try:
        [float(x) for x in (s.split("-", 1) if "-" in s else [s])]
        return True
    except ValueError:
        return False


def validate(segs: list[dict], route_km: float, category: str,
             stops: list[dict], haz: list[dict]) -> list[dict]:
    """Deterministic guardrails. Returns a list of {level, msg}; level is
    'error' (blocks push) or 'warn' (surfaced, non-blocking)."""
    issues: list[dict] = []
    if not segs:
        return [{"level": "error", "msg": "no segments"}]

    # 1. Contiguity: bands must tile 0..route_km without gaps/overlap.
    if abs(segs[0]["a"]) > 0.15:
        issues.append({"level": "warn",
                       "msg": f"first band starts at km {segs[0]['a']}, not 0"})
    for p, n in zip(segs, segs[1:]):
        if abs(n["a"] - p["b"]) > 0.15:
            issues.append({"level": "warn",
                           "msg": f"gap/overlap between '{p['name']}' and '{n['name']}' "
                                  f"(km {p['b']} -> {n['a']})"})
    if abs(segs[-1]["b"] - route_km) > 1.0:
        issues.append({"level": "warn",
                       "msg": f"last band ends at km {segs[-1]['b']}, route is {route_km} km"})

    # 2. Buffer padding: written distance must be route + BUFFER_KM per buffer.
    nbuf = sum(1 for s in segs if s.get("buf"))
    expect = route_km + config.BUFFER_KM * nbuf
    got = total_written_km(segs)
    if abs(got - expect) > max(2.0, 0.05 * expect):
        issues.append({"level": "warn",
                       "msg": f"written distance {got} km vs expected ~{round(expect,1)} km "
                              f"({nbuf} padded buffer(s)) — padding may be wrong"})
    # only structural sections get padded; work/rest never
    for s in segs:
        if s.get("buf") and s["kind"] not in ("warmup", "rest", "cooldown"):
            issues.append({"level": "warn",
                           "msg": f"'{s['name']}' is padded but is a {s['kind']} step "
                                  "(only warm-up/bridge/cooldown should be padded)"})

    # 3. Work-step intensities within the category's physiological window.
    #    Per-segment issues carry the segment index ("seg") so the UI can mark
    #    the exact row (name matching is ambiguous — "Float" repeats).
    win = WW.CAT_WIN.get(category)
    if win:
        for i, s in enumerate(segs):
            if s["kind"] in ("work", "tt") and _pct_valid(s.get("pct")):
                lo, hi = _pct_lo_hi(s["pct"])
                mid = (lo + hi) / 2
                if not (win["pct"][0] - 1 <= mid <= win["pct"][1] + 1):
                    issues.append({"level": "warn", "seg": i,
                                   "msg": f"'{s['name']}' @ {s['pct']}% is outside the "
                                          f"{category} window {win['pct'][0]}-{win['pct'][1]}%"})

    # 4. No work-step START on a known stop / hazard (within 300 m), and no
    #    danger point in the MIDDLE of an effort — the placement engine avoids
    #    crossings, but a manual nudge can drag an interval across a stop.
    danger = [s["km"] for s in stops] + [h["km"] for h in haz
                                         if h.get("t") != "right_before_left"]
    for i, s in enumerate(segs):
        if s["kind"] in ("work", "tt"):
            near = [d for d in danger if abs(d - s["a"]) <= 0.3]
            if near:
                issues.append({"level": "error", "seg": i,
                               "msg": f"'{s['name']}' starts at km {round(s['a'],1)} on/near a "
                                      f"stop or junction (km {round(near[0],2)}) — move it"})
            inside = [d for d in danger if s["a"] + 0.3 < d < s["b"] - 0.05]
            if inside:
                issues.append({"level": "warn", "seg": i,
                               "msg": f"'{s['name']}' crosses a stop or junction mid-effort "
                                      f"(km {round(inside[0],2)}) — consider moving or "
                                      "splitting it"})

    # 5. Every step parses to name + range + power=3s (generator guarantees it,
    #    but re-check in case segs came from a hand-edited plan paste).
    for i, s in enumerate(segs):
        if not str(s.get("name", "")).strip():
            issues.append({"level": "warn", "seg": i, "msg": "a segment has no name"})
        if not _pct_valid(s.get("pct")):
            issues.append({"level": "error", "seg": i,
                           "msg": f"'{s.get('name')}' has no readable intensity"})
    return issues


def validate_blank(segs: list[dict], category: str) -> list[dict]:
    """Guardrails for a no-route (time-based) workout: intensities in the
    category window, every step has a target, sane durations. No terrain/stop/
    buffer checks (there's no route)."""
    issues: list[dict] = []
    if not segs:
        return [{"level": "error", "msg": "no segments — add at least one"}]
    win = WW.CAT_WIN.get(category)
    for i, s in enumerate(segs):
        if not _pct_valid(s.get("pct")):
            issues.append({"level": "error", "seg": i,
                           "msg": f"'{s.get('name')}' has no readable intensity"})
        if (s["b"] - s["a"]) <= 0:
            issues.append({"level": "error", "seg": i,
                           "msg": f"'{s.get('name')}' has zero/negative duration"})
        if win and s["kind"] in ("work", "tt") and _pct_valid(s.get("pct")):
            lo, hi = _pct_lo_hi(s["pct"])
            mid = (lo + hi) / 2
            if not (win["pct"][0] - 1 <= mid <= win["pct"][1] + 1):
                issues.append({"level": "warn", "seg": i,
                               "msg": f"'{s['name']}' @ {s['pct']}% is outside the "
                                      f"{category} window {win['pct'][0]}-{win['pct'][1]}%"})
    return issues
