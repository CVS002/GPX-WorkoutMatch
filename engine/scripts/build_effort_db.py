#!/usr/bin/env python3
"""Layer 5 (build): mine where the athlete SUSTAINS hard efforts, from past-ride GPX.

Usage:
    python build_effort_db.py <history_dir> [--cache <effort_db.json>] [--grid <road_db.json>]

Layer 2 (road_db) mines the *negative* signal — where the athlete stops or
slows (junctions, lights, give-ways) — and penalises those cells. This layer
mines the *positive* signal: the road stretches where the athlete has actually
held a hard, uninterrupted effort. Those places are, by revealed preference,
suitable for a workout block — long enough, open enough, and safe enough that
you already went hard there. It is the complement of the stop map.

A GPS sample counts as "in effort" when heart rate is above an absolute
hard-effort floor (> HR_ABS_MIN bpm, the athlete's own hard-effort HR) AND
speed is genuinely fast (>= SPD_FLOOR). On the flat terrain this athlete rides
(no climbs) a real hard effort shows up as speed, so the floor is set at
~31 km/h: together with the HR floor that excludes easy tempo and late-ride HR
drift, keeping only stretches actually ridden hard. Isolated surges do not
count: a sample only qualifies when it sits inside a continuous in-effort
stretch lasting >= EFFORT_MIN_S seconds (measured on real timestamps, so a
mid-ride pause never bridges two efforts).

Per cell the cache stores how many separate rides sustained an effort through
it (effort_passes) and the sample count. score_route.py / build_map_widget.py
read it to award a small positive bonus to cells that are proven effort
corridors. HR is required; the ~8/148 rides without HR contribute nothing here
(they still feed Layer 2). Grid is taken from road_db so cells line up exactly.
Stdlib only.
"""
import sys
import os
import json
import math
import glob
import xml.etree.ElementTree as ET
from collections import deque

HR_ABS_MIN = 165        # bpm: absolute hard-effort HR floor (athlete's own number)
SPD_FLOOR = 8.6         # m/s (~31 km/h): flat-terrain hard effort, not easy tempo
EFFORT_MIN_S = 90.0     # a qualifying effort must be sustained at least this long
STEADY_CV = 0.22        # max speed coeff-of-variation over a run: "no large velocity changes"
# grid defaults (overridden by --grid road_db.json meta so cells align)
CELL_LAT = 0.00045
CELL_LON = 0.00072
CACHE_VERSION = 2       # v2 adds steadiness gate + 8-way direction bins per cell
NDIR = 8


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
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def dir_bin(bearing):
    return int(((bearing + 360.0 / NDIR / 2) % 360.0) / (360.0 / NDIR)) % NDIR


def _sec(ts):
    # 'YYYY-MM-DDTHH:MM:SSZ' -> epoch-ish seconds (naive, monotonic within a ride)
    from datetime import datetime, timezone
    try:
        return datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()
    except Exception:
        return None


def parse_ride(path):
    """Yield (lat, lon, hr, speed_ms, t_sec) per trackpoint. Returns [] if the
    ride carries no HR (this layer needs HR)."""
    tree = ET.parse(path)
    root = tree.getroot()
    aid = None
    for el in root.iter():
        if strip_ns(el.tag) == 'link' and el.get('href'):
            aid = el.get('href').rstrip('/').split('/')[-1]
            break
    pts = []
    any_hr = False
    for el in root.iter():
        if strip_ns(el.tag) != 'trkpt':
            continue
        try:
            lat = float(el.get('lat')); lon = float(el.get('lon'))
        except (TypeError, ValueError):
            continue
        hr = spd = t = None
        for sub in el.iter():
            tg = strip_ns(sub.tag)
            if tg == 'hr' and sub.text:
                try: hr = float(sub.text); any_hr = True
                except ValueError: pass
            elif tg == 'speed' and sub.text:
                try: spd = float(sub.text)
                except ValueError: pass
            elif tg == 'time' and sub.text:
                t = _sec(sub.text.strip())
        pts.append([lat, lon, hr, spd, t])
    if not any_hr:
        return aid, []
    # fill missing speed by finite diff (assume ~1 Hz where time missing)
    for i in range(len(pts)):
        if pts[i][3] is None:
            if i > 0:
                pts[i][3] = haversine_m(pts[i-1][0], pts[i-1][1], pts[i][0], pts[i][1])
            else:
                pts[i][3] = 0.0
    return aid, pts


def _cv(vals):
    """Coefficient of variation (std/mean) of a list; 0 if degenerate."""
    if len(vals) < 2:
        return 0.0
    m = sum(vals) / len(vals)
    if m <= 0:
        return 1.0
    var = sum((v - m) ** 2 for v in vals) / len(vals)
    return math.sqrt(var) / m


def effort_flags(pts):
    """Per-point flag: part of a sustained hard effort. HR above an absolute
    hard-effort floor AND genuinely fast (flat terrain), held continuously for
    >= EFFORT_MIN_S, AND steady (speed coeff-of-variation <= STEADY_CV, i.e.
    'fast without large changes in velocity' -- a road you could hold, not a
    surge-and-coast)."""
    n = len(pts)
    # raw candidate: HR > 165 bpm AND fast (>= 31 km/h)
    cand = [(p[2] is not None and p[2] > HR_ABS_MIN and (p[3] or 0) >= SPD_FLOOR) for p in pts]
    flags = [False] * n
    i = 0
    while i < n:
        if not cand[i]:
            i += 1
            continue
        j = i
        while j + 1 < n and cand[j + 1]:
            j += 1
        # [i..j] is a maximal candidate run; measure its wall-clock span
        t0, t1 = pts[i][4], pts[j][4]
        span = (t1 - t0) if (t0 is not None and t1 is not None) else (j - i)
        speeds = [pts[k][3] or 0.0 for k in range(i, j + 1)]
        if span >= EFFORT_MIN_S and _cv(speeds) <= STEADY_CV:
            for k in range(i, j + 1):
                flags[k] = True
        i = j + 1
    return flags


def cell_key(lat, lon, cl, co):
    return f"{int(round(lat / cl))},{int(round(lon / co))}"


def build(history_dir, cache_path, grid_path):
    cl, co = CELL_LAT, CELL_LON
    if grid_path and os.path.exists(grid_path):
        gm = json.load(open(grid_path, encoding="utf-8")).get("meta", {})
        cl = gm.get("cell_lat", cl); co = gm.get("cell_lon", co)

    cache = {"meta": {"version": CACHE_VERSION, "cell_lat": cl, "cell_lon": co,
                      "hr_abs_min": HR_ABS_MIN, "effort_min_s": EFFORT_MIN_S,
                      "spd_floor": SPD_FLOOR, "steady_cv": STEADY_CV, "ndir": NDIR,
                      "activities": []},
             "cells": {}}
    if os.path.exists(cache_path):
        cache = json.load(open(cache_path, encoding="utf-8"))
        cache.setdefault("meta", {}).setdefault("activities", [])
        cache["meta"]["version"] = CACHE_VERSION; cache["meta"].setdefault("ndir", NDIR)
        cl = cache["meta"].get("cell_lat", cl); co = cache["meta"].get("cell_lon", co)

    done = set(cache["meta"]["activities"])
    cells = cache["cells"]     # key -> [effort_passes, effort_samples, dpass[8]]
    files = sorted(glob.glob(os.path.join(history_dir, "*.gpx")))
    added = no_hr = 0
    for path in files:
        stem = os.path.splitext(os.path.basename(path))[0]
        aid, pts = parse_ride(path)
        aid = aid or stem
        if aid in done:
            continue
        if not pts:            # no HR -> nothing for this layer
            no_hr += 1
            cache["meta"]["activities"].append(aid); done.add(aid)
            continue
        flags = effort_flags(pts)
        percell = {}           # key -> {bin: count} of headings while in effort
        for i, p in enumerate(pts):
            if not flags[i]:
                continue
            key = cell_key(p[0], p[1], cl, co)
            c = cells.get(key)
            if c is None:
                c = cells[key] = [0, 0, [0] * NDIR]
            elif len(c) < 3:
                c = cells[key] = list(c) + [[0] * NDIR]
            c[1] += 1
            e = percell.setdefault(key, {})
            if i > 0:
                b = dir_bin(bearing_deg(pts[i - 1][0], pts[i - 1][1], p[0], p[1]))
                e[b] = e.get(b, 0) + 1
        for key, bins in percell.items():
            c = cells[key]
            c[0] += 1                              # one effort-pass per ride per cell
            if bins:
                c[2][max(bins, key=bins.get)] += 1  # directional effort-pass
        cache["meta"]["activities"].append(aid); done.add(aid)
        added += 1
        if percell:
            print(f"  + {aid}: {len(pts)} pts, {len(percell)} effort cells")

    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    json.dump(cache, open(cache_path, "w", encoding="utf-8"))
    print(f"Effort cache: {len(cells)} cells from {len(done)} rides "
          f"(+{added} mined, {no_hr} had no HR) -> {cache_path}")


if __name__ == "__main__":
    pos = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not pos:
        raise SystemExit(__doc__)
    history = pos[0]
    here = os.path.dirname(os.path.abspath(__file__))
    cache = sys.argv[sys.argv.index("--cache") + 1] if "--cache" in sys.argv \
        else os.path.join(here, "..", "data", "cache", "effort_db.json")
    grid = sys.argv[sys.argv.index("--grid") + 1] if "--grid" in sys.argv \
        else os.path.join(here, "..", "data", "cache", "road_db.json")
    build(history, os.path.abspath(cache), os.path.abspath(grid))
