#!/usr/bin/env python3
"""Layer 2 (build): turn a folder of past-ride GPX files into a road-knowledge cache.

Usage:
    python build_road_db.py <history_dir> [--cache <cache.json>]
                            [--workout-rides <workout_rides.json>]

Your own ride history encodes where the roads are good: places you cruise
through without ever slowing are clean; places you repeatedly drop to a
crawl are junctions, lights, or bad crossings. This script bins every GPS
sample from your past rides into a ~50 m spatial grid and records, per cell,
how many separate rides passed through, your typical speed, and how often
you were nearly stopped there.

Two refinements make the stop signal directional and workout-aware:
  * DIRECTION (8-way): each cell also counts passes and stops per compass
    heading bin, so a give-way that only bites in one travel direction does
    not penalise the reverse direction on an out-and-back road.
  * WORKOUT-AWARE stops: for rides listed in workout_rides.json (days a
    structured workout was planned), a near-stop that lands just after a
    sustained hard effort is read as "segment done, I stopped" and is NOT
    counted as a road stop -- you could have kept riding, the interval was
    simply over.

The result is a compact JSON cache (data/cache/road_db.json by default).
score_route.py reads it to annotate a new route with historical road quality.

Build is incremental and idempotent: activities already in the cache
(matched by the <link> activity id, else the filename stem) are skipped, so
you can drop new GPX files in and re-run cheaply. Stdlib only.
"""
import sys
import os
import json
import math
import glob
import xml.etree.ElementTree as ET

# ~50 m cells. CELL_LAT is latitude-independent; CELL_LON must widen with
# latitude (lon degrees shrink towards the poles). A NEW cache derives cell_lon
# from its first ride's latitude; an EXISTING cache keeps its stored grid.
CELL_LAT = 0.00045
CELL_LON = 0.00072
STOP_MS = 1.5   # < 1.5 m/s (~5.4 km/h) counts as "nearly stopped"
# A sudden slowdown also flags a stop / sharp turn even without a full stop.
SLOWDOWN_CEIL_MS = 4.5     # only below ~16 km/h counts (ignore easing mid-effort)
SLOWDOWN_FRAC = 0.55       # ...and below 55% of recent cruising speed
SLOWDOWN_WIN_M = 120.0     # window over which "recent cruising speed" is measured
# Workout-aware effort-end-stop suppression (only for rides in workout_rides.json):
EFFORT_FAST_MS = 8.6       # sustained speed that marks a hard effort (~31 km/h)
EFFORT_MIN_S = 90.0        # ...held at least this long to count as an effort
ENDSTOP_WIN_M = 180.0      # a stop within this far AFTER an effort ends = "segment done"
CACHE_VERSION = 2          # v2 adds 8-way direction bins per cell
NDIR = 8                   # compass heading bins (N, NE, E, ... 45 deg each)


def cell_lon_for(lat_deg):
    """Longitude cell size giving ~50 m width at this latitude."""
    return round(CELL_LAT / max(0.2, math.cos(math.radians(lat_deg))), 8)


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
    """Compass bearing (0-360, 0=N) of travel from point 1 to point 2."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def dir_bin(bearing):
    """Heading -> 0..NDIR-1 (bin 0 centred on North)."""
    return int(((bearing + 360.0 / NDIR / 2) % 360.0) / (360.0 / NDIR)) % NDIR


def _sec(ts):
    from datetime import datetime, timezone
    try:
        return datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()
    except Exception:
        return None


def stopish_flags(pts):
    """Per-point flag: near-stopped OR a sudden slowdown (give-way / corner)."""
    from collections import deque
    n = len(pts)
    flags = [False] * n
    win = deque()   # (cum_dist_m, speed)
    cum = 0.0
    for i in range(n):
        if i > 0:
            cum += haversine_m(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1])
        spd = pts[i][2] or 0.0
        win.append((cum, spd))
        while win and cum - win[0][0] > SLOWDOWN_WIN_M:
            win.popleft()
        recent_max = max(s for _, s in win) if win else spd
        flags[i] = (spd < STOP_MS) or (spd < SLOWDOWN_CEIL_MS and recent_max > 0
                                       and spd < SLOWDOWN_FRAC * recent_max)
    return flags


def effort_end_mask(pts, times):
    """True for stop samples that fall just AFTER a sustained fast effort ends
    (workout rides only): 'the interval was over, so I stopped'. These should
    not count as road stops. Uses speed + time only (road_db has no HR)."""
    n = len(pts)
    cum = [0.0] * n
    for i in range(1, n):
        cum[i] = cum[i - 1] + haversine_m(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1])
    fast = [(p[2] or 0.0) >= EFFORT_FAST_MS for p in pts]
    end_pos = []                    # cumulative-dist positions where an effort ended
    i = 0
    while i < n:
        if not fast[i]:
            i += 1
            continue
        j = i
        while j + 1 < n and fast[j + 1]:
            j += 1
        span = (times[j] - times[i]) if (times[i] is not None and times[j] is not None) else (j - i)
        if span >= EFFORT_MIN_S:
            end_pos.append(cum[j])
        i = j + 1
    mask = [False] * n
    for i in range(n):
        for e in end_pos:
            if 0 <= cum[i] - e <= ENDSTOP_WIN_M:   # within the trailing window after an effort
                mask[i] = True
                break
    return mask


def parse_ride(path):
    """Return (activity_id, pts, times) where pts=[lat,lon,speed_ms], times=[epoch|None]."""
    tree = ET.parse(path)
    root = tree.getroot()
    activity_id = None
    for el in root.iter():
        if strip_ns(el.tag) == 'link' and el.get('href'):
            activity_id = el.get('href').rstrip('/').split('/')[-1]
            break
    raw, times = [], []
    for el in root.iter():
        if strip_ns(el.tag) != 'trkpt':
            continue
        try:
            lat = float(el.get('lat')); lon = float(el.get('lon'))
        except (TypeError, ValueError):
            continue
        spd = t = None
        for sub in el.iter():
            tg = strip_ns(sub.tag)
            if tg == 'speed' and sub.text:
                try: spd = float(sub.text)
                except ValueError: pass
            elif tg == 'time' and sub.text:
                t = _sec(sub.text.strip())
        raw.append([lat, lon, spd]); times.append(t)
    for i in range(len(raw)):
        if raw[i][2] is None:
            if 0 < i < len(raw):
                raw[i][2] = haversine_m(raw[i - 1][0], raw[i - 1][1], raw[i][0], raw[i][1])
            else:
                raw[i][2] = 0.0
    return activity_id, raw, times


def cell_key(lat, lon, cl=CELL_LAT, co=CELL_LON):
    return f"{int(round(lat / cl))},{int(round(lon / co))}"


def new_cell():
    # [passes, samples, stop_samples, sum_speed, min_speed, dpass[8], dstop[8]]
    return [0, 0, 0, 0.0, 1e9, [0] * NDIR, [0] * NDIR]


def _upgrade(c):
    """Old v1 cell (len 5) -> v2 (adds empty direction bins)."""
    if len(c) < 7:
        return list(c) + [[0] * NDIR, [0] * NDIR]
    return c


def build(history_dir, cache_path, workout_path=None):
    cache = {"meta": {"version": CACHE_VERSION, "cell_lat": CELL_LAT,
                      "cell_lon": CELL_LON, "stop_ms": STOP_MS, "ndir": NDIR,
                      "activities": []},
             "cells": {}}
    if os.path.exists(cache_path):
        with open(cache_path, encoding="utf-8") as f:
            cache = json.load(f)
        cache.setdefault("meta", {}).setdefault("activities", [])
        cache["meta"]["version"] = CACHE_VERSION
        cache["meta"].setdefault("ndir", NDIR)

    workout_ids = set()
    if workout_path is None:
        workout_path = os.path.join(os.path.dirname(cache_path), "workout_rides.json")
    if os.path.exists(workout_path):
        try:
            wr = json.load(open(workout_path, encoding="utf-8"))
            workout_ids = set((wr.get("rides") or {}).keys())
        except Exception as e:  # noqa: BLE001
            print(f"  (workout_rides unreadable: {type(e).__name__})")
    if workout_ids:
        print(f"  workout-aware for {len(workout_ids)} planned-workout rides")

    done = set(cache["meta"]["activities"])
    cells = cache["cells"]
    cl = cache["meta"].get("cell_lat", CELL_LAT)
    co = cache["meta"].get("cell_lon", CELL_LON)
    files = sorted(glob.glob(os.path.join(history_dir, "*.gpx")))
    added = 0
    for path in files:
        stem = os.path.splitext(os.path.basename(path))[0]
        aid, pts, times = parse_ride(path)
        aid = aid or stem
        if aid in done:
            continue
        if len(pts) < 2:
            continue
        if not cells and not cache["meta"]["activities"]:
            co = cell_lon_for(pts[0][0])
            cache["meta"]["cell_lon"] = co

        flags = stopish_flags(pts)
        is_wk = aid in workout_ids
        if is_wk:                                    # drop "segment done" stops
            endmask = effort_end_mask(pts, times)
            flags = [f and not endmask[i] for i, f in enumerate(flags)]

        percell = {}     # key -> {"bins": {bin:count}, "stop": bool}
        for i, (lat, lon, spd) in enumerate(pts):
            key = cell_key(lat, lon, cl, co)
            c = cells.get(key)
            if c is None:
                c = cells[key] = new_cell()
            else:
                c = cells[key] = _upgrade(c)
            c[1] += 1
            if flags[i]:
                c[2] += 1
            c[3] += spd
            if spd < c[4]:
                c[4] = spd
            b = dir_bin(bearing_deg(pts[i - 1][0], pts[i - 1][1], lat, lon)) if i > 0 else None
            e = percell.setdefault(key, {"bins": {}, "stop": False})
            if b is not None:
                e["bins"][b] = e["bins"].get(b, 0) + 1
            if flags[i]:
                e["stop"] = True
        for key, e in percell.items():
            c = cells[key]
            c[0] += 1                                # one pass per activity per cell
            if e["bins"]:
                dom = max(e["bins"], key=e["bins"].get)
                c[5][dom] += 1                       # directional pass
                if e["stop"]:
                    c[6][dom] += 1                   # directional stop
        done.add(aid)
        cache["meta"]["activities"].append(aid)
        added += 1
        print(f"  + {aid}: {len(pts)} points, {len(percell)} cells" + ("  [workout]" if is_wk else ""))

    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    with open(cache_path, "w", encoding="utf-8") as f:
        json.dump(cache, f)
    print(f"Cache v{CACHE_VERSION}: {len(cells)} cells from {len(done)} rides "
          f"(+{added} this run) -> {cache_path}")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        raise SystemExit(__doc__)
    history = args[0]
    here = os.path.dirname(os.path.abspath(__file__))
    cache = sys.argv[sys.argv.index("--cache") + 1] if "--cache" in sys.argv \
        else os.path.join(here, "..", "data", "cache", "road_db.json")
    workout = sys.argv[sys.argv.index("--workout-rides") + 1] if "--workout-rides" in sys.argv else None
    build(history, os.path.abspath(cache), os.path.abspath(workout) if workout else None)
