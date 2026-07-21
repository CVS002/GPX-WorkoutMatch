#!/usr/bin/env python3
"""Summarise the last N days of training into a load / recency table for Step 1.

Feed it the JSON that `icu_get_recent_activities` returns (save the MCP result to
a file, or pipe it on stdin). It prints a per-day table and the numbers the
coaching engine needs: 7- and 14-day load totals, days since the last quality
(hard) day, and what that stimulus roughly was — so session choice is grounded
in the actual block instead of eyeballed. Stdlib only; no MCP or network.

Usage:
    icu result saved to file:   python recent_load.py recent.json
    piped:                      <mcp output> | python recent_load.py
    options:                    [--days 14] [--ftp 300]
"""
import sys
import json


def load_activities(text):
    """Accept the raw MCP envelope, the inner data object, or a bare list."""
    obj = json.loads(text)
    if isinstance(obj, dict) and isinstance(obj.get("result"), str):
        obj = json.loads(obj["result"])
    if isinstance(obj, dict):
        obj = obj.get("data", obj)
    if isinstance(obj, dict):
        obj = obj.get("activities", obj)
    return obj if isinstance(obj, list) else []


def day(s):
    return (s or "")[:10]


def zone(if_pct):
    """Rough stimulus label from intensity factor (stored as % e.g. 80.0)."""
    if if_pct is None:
        return "?"
    v = if_pct
    if v < 60:
        return "recovery"
    if v < 76:
        return "endurance"
    if v < 88:
        return "tempo/SS"
    if v < 95:
        return "threshold-"
    return "hard"


def main():
    args = sys.argv[1:]
    days = int(args[args.index("--days") + 1]) if "--days" in args else 14
    paths = [a for a in args if not a.startswith("--")
             and a not in {str(days)}]
    text = open(paths[0], encoding="utf-8").read() if paths else sys.stdin.read()
    if not text.strip():
        print(__doc__.strip())
        return
    try:
        acts = load_activities(text)
    except (json.JSONDecodeError, ValueError):
        print("input is not valid JSON — feed it the saved icu_get_recent_activities result")
        return
    if not acts:
        print("no activities found in input")
        return

    acts = [a for a in acts if a.get("start_date")]
    acts.sort(key=lambda a: a["start_date"], reverse=True)
    newest = day(acts[0]["start_date"])
    # keep within N days of the newest entry (string compare works on ISO dates
    # for the coarse cutoff; good enough for a 14-day window)
    from datetime import date
    y, m, d = map(int, newest.split("-"))
    cutoff = date(y, m, d).toordinal() - days

    rows, load7 = [], 0.0
    load14 = 0.0
    hard_days = []
    for a in acts:
        dd = day(a["start_date"])
        yy, mm, ddd = map(int, dd.split("-"))
        o = date(yy, mm, ddd).toordinal()
        if o < cutoff:
            break
        age = date(y, m, d).toordinal() - o
        load = a.get("training_load") or 0
        ifp = a.get("intensity_factor")
        typ = a.get("type", "?")
        dur = (a.get("moving_time_seconds") or 0) / 60
        z = zone(ifp)
        rows.append((age, dd, typ, dur, load, ifp, z, a.get("name", "")))
        load14 += load
        if age < 7:
            load7 += load
        if z in ("threshold-", "hard") and typ in ("Ride", "VirtualRide", "Run"):
            hard_days.append((age, z, a.get("name", "")))

    print(f"Last {days} days (newest {newest}) - {len(rows)} activities\n")
    print(f"{'d-ago':>5} {'date':10} {'type':11} {'min':>4} {'load':>4} {'IF':>4}  stimulus")
    for age, dd, typ, dur, load, ifp, z, nm in rows:
        ifs = f"{ifp:.0f}" if ifp is not None else "-"
        print(f"{age:>5} {dd:10} {typ[:11]:11} {dur:>4.0f} {load:>4.0f} {ifs:>4}  {z:<10} {nm[:28]}")

    print(f"\nLoad: 7-day {load7:.0f} | {days}-day {load14:.0f}")
    if hard_days:
        last = min(hard_days)  # smallest age = most recent
        print(f"Last quality day: {last[0]} days ago ({last[1]}) - {last[2][:40]}")
        print(f"Quality days in window: {len(hard_days)}")
        if last[0] <= 1:
            print("NOTE: a hard day was yesterday/today - avoid stacking quality; "
                  "lean recovery/endurance or place quality 1-2 days out.")
    else:
        print(f"No quality (IF>=88%) day in the last {days} days - headroom for a key session.")


if __name__ == "__main__":
    main()
