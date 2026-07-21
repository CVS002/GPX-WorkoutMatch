#!/usr/bin/env python3
"""Shared per-category interval windows + bank-entry validation.

The workout bank's `category` and one-line `structure` are heuristic and often
disagree (the category comes from the highest-intensity band with >=90 s of
work; the structure line shows the *most repeated* bout — ~49% of entries
mismatch). Everything that consumes the bank must therefore re-validate an
entry's parsed structure against the physiological window of its category
before showing or suggesting it. This module is that single source of truth:
`build_map_widget.py` (offline picker candidates) and `suggest_workout.py`
(session seeding) both import it. Stdlib only.
"""
import re

_STRUCT = re.compile(r"^\s*(\d+)\s*x\s*(\d+)\s*(s|sec|min)\s*@\s*(\d+)\s*%", re.I)

# pct window, work-minutes window, reps window
CAT_WIN = {
    "vo2max":    {"pct": (108, 125), "work": (2.0, 5.0),   "reps": (3, 10)},
    "threshold": {"pct": (95, 106),  "work": (6.0, 20.0),  "reps": (2, 5)},
    "sweetspot": {"pct": (84, 95),   "work": (8.0, 20.0),  "reps": (2, 4)},
    "tempo":     {"pct": (76, 90),   "work": (10.0, 30.0), "reps": (1, 3)},
    "anaerobic": {"pct": (118, 160), "work": (0.3, 1.6),   "reps": (6, 15)},
    "sprint":    {"pct": (140, 260), "work": (0.12, 0.55), "reps": (5, 12)},
}
REST_MIN = {  # recovery minutes as a function of work minutes
    "vo2max":    lambda w: round(w, 1),
    "threshold": lambda w: round(max(2.0, w * 0.4), 1),
    "sweetspot": lambda w: 4.0,
    "tempo":     lambda w: 5.0,
    "anaerobic": lambda w: round(max(1.0, w * 2), 1),
    "sprint":    lambda w: round(max(2.0, w * 6), 1),
}
REST_PCT = {"vo2max": "55-62", "threshold": "58-64", "sweetspot": "60-66",
            "tempo": "60-66", "anaerobic": "50-58", "sprint": "50-58"}


def parse_struct(s):
    """Parse a bank 'Nx Ds @ P%' structure line -> (reps, work_min, pct) or None."""
    m = _STRUCT.match(s or "")
    if not m:
        return None
    reps, num, unit, pct = int(m.group(1)), int(m.group(2)), m.group(3).lower(), int(m.group(4))
    work_min = num / 60.0 if unit in ("s", "sec") else float(num)
    return reps, work_min, pct


def valid_session(w):
    """True if a bank entry's parsed structure is consistent with its category.

    Endurance is special: steady rides usually have no parseable interval line
    ('steady aerobic'), and moderate tempo surges inside a Z2 ride are fine —
    reject only entries whose headline interval is clearly hard (>88% FTP)."""
    cat = w.get("category")
    p = parse_struct(w.get("structure", ""))
    if cat == "endurance":
        return p is None or p[2] <= 88
    win = CAT_WIN.get(cat)
    if not win or not p:
        return False
    reps, work_min, pct = p
    return (win["pct"][0] <= pct <= win["pct"][1]
            and win["work"][0] <= work_min <= win["work"][1]
            and win["reps"][0] <= reps <= win["reps"][1])
