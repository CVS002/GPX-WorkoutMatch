#!/usr/bin/env python3
"""Pick a workout objective + a concrete session from the bank, per the coaching
engine's rules. Also the re-roll engine behind the map widget's buttons, and a
variety self-check.

This encodes the deterministic part of `references/coaching-engine.md`
(TSB gate + phase bias + novelty) so session choice is reproducible and can be
re-rolled. It is a helper for the design step, not a replacement — the agent
still reshapes the chosen type to the route's terrain.

Usage:
    python suggest_workout.py --tsb -5 --phase build [--last threshold]
        [--terrain flat] [--minutes 120 | --route-km 40] [--nth 0]
    python suggest_workout.py --selftest      # prove it rotates stimulus

Stdlib only; reads data/cache/workout_bank.json.
"""
import os
import sys
import json

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from workout_windows import valid_session  # noqa: E402

BANK = os.path.join(HERE, "..", "data", "cache", "workout_bank.json")
CATS = ["sprint", "anaerobic", "vo2max", "threshold", "sweetspot", "tempo", "endurance"]

# phase -> favoured objectives, most-specific first (from coaching-engine.md)
PHASE_FAV = {
    "base":     ["endurance", "tempo", "sweetspot"],
    "build":    ["threshold", "sweetspot", "vo2max"],
    "peak":     ["vo2max", "anaerobic", "sprint", "threshold"],
    "taper":    ["vo2max", "sprint", "endurance"],
    "recovery": ["endurance"],
}
# Soft preference by terrain (re-ranks candidates; does not exclude). Flat hosts
# almost anything; only "urban" is genuinely restrictive.
TERRAIN_FIT = {
    "flat":    ["threshold", "tempo", "sweetspot", "endurance", "vo2max", "anaerobic", "sprint"],
    "rolling": ["sweetspot", "threshold", "vo2max", "tempo", "endurance"],
    "climbs":  ["threshold", "vo2max", "sweetspot"],
    "punchy":  ["anaerobic", "vo2max", "sprint"],
    "urban":   ["endurance"],
}


def arg(flag, d=None):
    return sys.argv[sys.argv.index(flag) + 1] if flag in sys.argv else d


def tsb_pool(tsb):
    """Which objectives are allowed at this freshness."""
    if tsb < -20:
        return ["endurance"]                      # recovery only
    if tsb < -10:
        return ["endurance", "tempo", "sweetspot"]
    if tsb <= 5:
        return list(CATS)                          # any quality
    return ["vo2max", "threshold", "anaerobic", "sprint"]  # fresh -> key hard


def select_category(tsb, phase, last=None, terrain=None):
    phase = (phase or "build").lower()
    pool = tsb_pool(tsb)
    if phase == "recovery":
        # A recovery week avoids almost all intensity regardless of freshness
        # (coaching-engine.md phase table) — being fresh is the POINT of the
        # week, not a licence to go hard.
        pool = ["endurance"]
    fav = PHASE_FAV.get(phase, ["threshold", "sweetspot", "endurance"])
    cand = [c for c in fav if c in pool]
    if not cand:
        # Pool and phase favourites clash. The direction of the fallback
        # matters: fatigue gates are hard limits (pool wins when tired), but
        # freshness is only permission, not an obligation (phase wins when
        # fresh — e.g. TSB +10 in base still means tempo/SS, not VO2max).
        cand = list(pool) if tsb <= 5 else list(fav)
    if last and len(cand) > 1:                     # novelty first: don't repeat last stimulus
        cand = [c for c in cand if c != last] or cand
    if terrain in TERRAIN_FIT and len(cand) > 1:   # then re-rank (soft) by terrain fit
        order = TERRAIN_FIT[terrain]
        cand = sorted(cand, key=lambda c: order.index(c) if c in order else 99)
    reason = (f"TSB {tsb:+.0f} -> pool {pool[:3]}{'...' if len(pool) > 3 else ''}; "
              f"phase {phase} favours {fav[0]}"
              + (f"; terrain {terrain}" if terrain else "")
              + (f"; avoided last={last}" if last else ""))
    return cand[0], cand, reason


def pick(bank, category, minutes=None, nth=0, avoid=()):
    # Re-validate structure against the category window (workout_windows) —
    # ~49% of bank entries carry a structure line that mismatches their
    # category label, and those make useless suggestions.
    pool = [w for w in bank if w.get("category") == category
            and w.get("structure") not in avoid
            and valid_session(w)]
    # No explicit duration -> aim for a solid ~90 min session, never "the
    # shortest stub in the category" (ascending sort picked 10-min fillers).
    minutes = minutes or 90
    pool.sort(key=lambda w: abs((w.get("duration_min") or 0) - minutes))
    if not pool:
        return None
    return pool[nth % len(pool)]


def main():
    bank = json.load(open(os.path.abspath(BANK), encoding="utf-8")).get("workouts", [])

    if "--selftest" in sys.argv:
        print("Variety self-check: objective chosen per (TSB x phase), last=threshold\n")
        print(f"{'TSB':>5} | " + " | ".join(f"{p:9}" for p in PHASE_FAV))
        seen = set()
        grid = {}
        for tsb in (-25, -15, -3, 10):
            cells = []
            for ph in PHASE_FAV:
                cat, _, _ = select_category(tsb, ph, last="threshold", terrain="flat")
                cells.append(cat)
                seen.add(cat)
                grid[(tsb, ph)] = cat
            print(f"{tsb:>5} | " + " | ".join(f"{c:9}" for c in cells))
        ok = len(seen) >= 4
        print(f"\ndistinct objectives across scenarios: {len(seen)} ({', '.join(sorted(seen))})")
        print("PASS: engine rotates stimulus" if ok else "FAIL: not enough variety")
        # Guardrails (regression checks for the fresh-TSB / phase clash bug):
        # recovery week and deep fatigue must NEVER yield intensity.
        rec_ok = all(grid[(t, "recovery")] == "endurance" for t in (-25, -15, -3, 10))
        tired_ok = all(grid[(-25, p)] == "endurance" for p in PHASE_FAV)
        fresh_base = grid[(10, "base")] in PHASE_FAV["base"]
        print("recovery phase -> endurance at every TSB:", "PASS" if rec_ok else "FAIL")
        print("TSB -25 -> endurance in every phase:     ", "PASS" if tired_ok else "FAIL")
        print("fresh (TSB+10) in base stays in base favourites:", "PASS" if fresh_base else "FAIL")
        # the VALIDATED bank must still serve each objective
        counts = {c: sum(1 for w in bank if w.get("category") == c and valid_session(w))
                  for c in CATS}
        missing = [c for c, n in counts.items() if n == 0]
        print("validated bank per category:", counts)
        print("bank covers all 7 objectives" if not missing else f"bank MISSING: {missing}")
        sys.exit(0 if ok and rec_ok and tired_ok and fresh_base and not missing else 1)

    tsb = float(arg("--tsb", "0"))
    phase = arg("--phase", "build")
    last = arg("--last")
    terrain = arg("--terrain")
    minutes = float(arg("--minutes")) if arg("--minutes") else None
    if minutes is None and arg("--route-km"):
        # derive the duration target from the route at the 30 km/h reference
        minutes = float(arg("--route-km")) / 30 * 60
    nth = int(arg("--nth", "0"))

    cat, cand, reason = select_category(tsb, phase, last, terrain)
    w = pick(bank, cat, minutes, nth)
    print(f"objective: {cat}")
    print(f"why: {reason}")
    print(f"alternatives if re-rolled to another type: {[c for c in cand if c != cat] or '(none)'}")
    if w:
        plan = f" [{w['plan']}]" if w.get("plan") else ""
        print(f"session: {w['name']}{plan} - {w['duration_min']} min - {w['structure']}")
    else:
        print(f"session: (no {cat} workout in bank)")


if __name__ == "__main__":
    main()
