"""Match past rides against the current route + extract speed tracks.

The ride history (engine/data/history/*.gpx, written by the history-refresh
job) carries per-point <speed> from the intervals.icu streams fusion. We index
each ride once into ~110 m lat/lon cells (appdata/ride_index.json, mtime-keyed)
so "which rides were mostly on this route?" is a set-overlap question, and we
serve a downsampled [lat, lon, km/h] track for the map's speed overlay.
"""
import json
import re
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path

from . import config
from . import engine

HISTORY_DIR = config.DATA_DIR / "history"
INDEX_FILE = config.APP_DATA / "ride_index.json"

# 1e-3 deg ≈ 111 m N-S (~70 m E-W at NL latitude); with the 1-cell neighbour
# expansion below, "on the route" means within roughly 150-200 m of it.
CELL = 1000


def _cell(lat: float, lon: float) -> str:
    return f"{round(lat * CELL)}:{round(lon * CELL)}"


def parse_ride(path, keep_every: int = 1):
    """Stream-parse a history GPX -> ([(lat, lon, speed_ms|None, power_w|None,
    time|None)], activity_id|None). Power is present only for rides recorded with
    a power meter. keep_every subsamples for the cheap indexing pass."""
    pts, act_id, i = [], None, 0
    for _, e in ET.iterparse(str(path)):
        tag = e.tag.rsplit("}", 1)[-1]
        if tag == "link":
            m = re.search(r"/activities/(\w+)", e.get("href") or "")
            if m:
                act_id = m.group(1)
        elif tag == "trkpt":
            if i % keep_every == 0:
                try:
                    la, lo = float(e.get("lat")), float(e.get("lon"))
                except (TypeError, ValueError):
                    i += 1
                    e.clear()
                    continue
                spd = pwr = tm = None
                for c in e:
                    ct = c.tag.rsplit("}", 1)[-1]
                    if ct == "speed" and c.text:
                        try:
                            spd = float(c.text)
                        except ValueError:
                            pass
                    elif ct == "power" and c.text:
                        try:
                            pwr = float(c.text)
                        except ValueError:
                            pass
                    elif ct == "time" and c.text:
                        tm = c.text
                pts.append((la, lo, spd, pwr, tm))
            i += 1
            e.clear()
    return pts, act_id


def _derive_speeds(pts):
    """Fallback for GPX without <speed>: v = distance/time between samples."""
    def _ts(s):
        try:
            return datetime.strptime(s[:19], "%Y-%m-%dT%H:%M:%S").timestamp()
        except (ValueError, TypeError):
            return None
    out, prev = [], None
    for la, lo, _, pwr, tm in pts:
        ts = _ts(tm)
        spd = None
        if prev and ts and prev[2] and ts > prev[2]:
            d = engine.L1.haversine_m(prev[0], prev[1], la, lo)
            spd = d / (ts - prev[2])
        out.append((la, lo, spd, pwr, tm))
        prev = (la, lo, ts)
    return out


def _index() -> dict:
    """Load the ride index, (re)indexing new/changed files. First run over a
    full history takes ~10-30 s; after that it's a JSON read."""
    idx = {}
    if INDEX_FILE.exists():
        try:
            idx = json.loads(INDEX_FILE.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            idx = {}
    changed = False
    seen = set()
    for f in sorted(HISTORY_DIR.glob("*.gpx")):
        seen.add(f.name)
        mt = f.stat().st_mtime
        if f.name in idx and idx[f.name].get("mtime") == mt:
            continue
        try:
            pts, act = parse_ride(f, keep_every=6)
        except ET.ParseError:
            continue
        spds = [p[2] for p in pts if p[2] is not None]
        dist = 0.0
        if len(pts) > 1:
            dist = engine.MW.cumdist([(p[0], p[1]) for p in pts])[-1] / 1000
        idx[f.name] = {
            "mtime": mt,
            "cells": sorted({_cell(p[0], p[1]) for p in pts}),
            "activity_id": act,
            "date": (pts[0][4] or "")[:10] if pts else "",
            "distance_km": round(dist, 1),
            "avg_kmh": round(sum(spds) / len(spds) * 3.6, 1) if spds else None,
            "max_kmh": round(max(spds) * 3.6, 1) if spds else None,
            "has_power": any(p[3] is not None for p in pts),
        }
        changed = True
    for k in list(idx):
        if k not in seen:
            del idx[k]
            changed = True
    if changed:
        INDEX_FILE.write_text(json.dumps(idx), encoding="utf-8")
    return idx


def _neigh(cells):
    return {(a + da, b + db) for (a, b) in cells
            for da in (-1, 0, 1) for db in (-1, 0, 1)}


def matches(route_gpx: str, top: int = 12, min_coverage: float = 0.5) -> list[dict]:
    """Rides that were 'mostly on this route', best match first.
    coverage = fraction of the ROUTE the ride touches; on_route = fraction of
    the RIDE that lies on the route (commute detours lower it)."""
    rpts = engine.L1.parse_points(route_gpx)
    rcells = {(round(p[0] * CELL), round(p[1] * CELL)) for p in rpts[::3]}
    if not rcells:
        return []
    rtol = _neigh(rcells)
    out = []
    for name, m in _index().items():
        cells = [tuple(map(int, c.split(":"))) for c in m.get("cells", [])]
        if not cells:
            continue
        on = sum(1 for c in cells if c in rtol) / len(cells)
        ridetol = _neigh(set(cells))
        cov = sum(1 for c in rcells if c in ridetol) / len(rcells)
        if cov < min_coverage:
            continue
        out.append({"file": name, "coverage_pct": round(cov * 100),
                    "on_route_pct": round(on * 100),
                    "score": round(cov * (0.5 + 0.5 * on), 3),
                    **{k: m.get(k) for k in
                       ("activity_id", "date", "distance_km", "avg_kmh", "max_kmh")}})
    out.sort(key=lambda x: -x["score"])
    return out[:top]


def track(name: str, max_pts: int = 1600) -> dict:
    """Full-resolution speed track for one history ride, downsampled to
    ~max_pts [lat, lon, kmh|None] triples for the overlay."""
    p = HISTORY_DIR / Path(name).name          # basename only — no traversal
    if p.suffix != ".gpx" or not p.exists():
        raise FileNotFoundError(name)
    pts, act = parse_ride(p, keep_every=1)
    if pts and all(x[2] is None for x in pts):
        pts = _derive_speeds(pts)
    step = max(1, len(pts) // max_pts)
    tr = [[round(la, 5), round(lo, 5),
           round(spd * 3.6, 1) if spd is not None else None]
          for la, lo, spd, _pwr, _tm in pts[::step]]
    return {"track": tr, "activity_id": act, "points": len(tr)}


_SPEED = (lambda p: p[2], 3.6, "km/h")   # value_of, scale, unit
_POWER = (lambda p: p[3], 1.0, "W")


def fast_overview(route_gpx: str, threshold_kmh: float = 33.0, **kw) -> dict:
    """Best average SPEED (km/h) sustained over any 500 m stretch, per ride,
    across all overlapping rides — plus the power averaged over the same stretch
    by the ride that set it (when it had a power meter). See _window_overview."""
    return _window_overview(route_gpx, threshold_kmh, _SPEED, _POWER,
                            metric="speed", **kw)


def power_overview(route_gpx: str, threshold_w: float = 200.0, **kw) -> dict:
    """Best average POWER (W) sustained over any 500 m stretch, per ride, across
    the overlapping rides that HAVE power — plus the speed over the same stretch.
    Rides with no power contribute nothing and aren't counted. See _window_overview."""
    return _window_overview(route_gpx, threshold_w, _POWER, _SPEED,
                            metric="power", **kw)


def _window_overview(route_gpx, threshold, primary, companion, metric,
                     win_m: int = 500, sub_m: int = 100, near_m: float = 120.0) -> dict:
    """Across EVERY past ride that overlaps this route, the best *average* value
    (speed or power) sustained over any win_m stretch of the route.

    A SLIDING win_m window is run along each ride (not fixed buckets), so a fast
    stretch is caught wherever it sits — never split across a bin boundary. Each
    window position's value is that ride's mean sample there (time-weighted, ≈
    distance/time for speed). We record, per fine sub_m sub-bin, the highest
    window average that covered it across all rides (with the date that set it),
    plus the COMPANION metric averaged over that same winning window/ride (speed
    for the power view, power for the speed view — None if that ride lacked it).
    A sub-bin is coloured when that best window average clears the threshold —
    i.e. some single ride *averaged* at or above threshold over a win_m stretch
    through here. Rides with no usable primary samples don't count."""
    value_of, scale, unit = primary
    comp_of, cscale, comp_unit = companion
    rpts = engine.L1.parse_points(route_gpx)
    bin_km, win_km = sub_m / 1000, win_m / 1000
    empty = {"bins": [], "segments": [], "bin_km": bin_km, "win_km": win_km,
             "threshold": threshold, "n_rides": 0, "route_km": 0,
             "unit": unit, "metric": metric, "comp_unit": comp_unit}
    if len(rpts) < 2:
        return empty
    cum = engine.MW.cumdist(rpts)                # metres, aligned to rpts
    total_m = cum[-1]
    nsub = int(total_m // sub_m) + 1
    WIN = max(1, round(win_m / sub_m))           # sub-bins per sliding window
    COV = max(1, int(WIN * 0.7))                 # min covered sub-bins to trust a window

    # spatial index of route points by cell, for cheap nearest-point lookup
    rindex: dict[str, list[int]] = {}
    for i, p in enumerate(rpts):
        rindex.setdefault(_cell(p[0], p[1]), []).append(i)
    rtol_cells = _neigh({tuple(map(int, c.split(":"))) for c in rindex})

    best: list = [None] * nsub                   # (win_avg, comp_avg|None, date)
    n_rides = 0
    for name, m in _index().items():
        overlap = sum(1 for c in m.get("cells", [])
                      if tuple(map(int, c.split(":"))) in rtol_cells)
        if overlap < 3:                          # barely touches the route — skip
            continue
        if metric == "power" and m.get("has_power") is False:
            continue                             # cheap skip of no-power rides
        try:
            pts, _ = parse_ride(HISTORY_DIR / name, keep_every=1)
        except ET.ParseError:
            continue
        if pts and all(x[2] is None for x in pts):
            pts = _derive_speeds(pts)            # so companion speed exists too
        date = m.get("date") or ""
        vsum = [0.0] * nsub                      # primary sum / sub-bin
        vcnt = [0] * nsub
        csum = [0.0] * nsub                      # companion sum / sub-bin
        ccnt = [0] * nsub
        for p in pts:
            v = value_of(p)
            if v is None:
                continue
            la, lo = p[0], p[1]
            ca, cb = round(la * CELL), round(lo * CELL)
            bd = bi = None
            for da in (-1, 0, 1):
                for db in (-1, 0, 1):
                    for i in rindex.get(f"{ca + da}:{cb + db}", ()):
                        d = engine.L1.haversine_m(la, lo, rpts[i][0], rpts[i][1])
                        if bd is None or d < bd:
                            bd, bi = d, i
            if bi is None or bd > near_m:
                continue
            k = min(nsub - 1, int(cum[bi] // sub_m))
            vsum[k] += v
            vcnt[k] += 1
            cv = comp_of(p)
            if cv is not None:
                csum[k] += cv
                ccnt[k] += 1
        if not any(vcnt):
            continue
        n_rides += 1
        # slide a WIN-wide window; its average = mean of its samples. Mark every
        # sub-bin the window covers with the max window average seen (any ride),
        # recording the companion average over the same window.
        run_s = sum(vsum[:WIN]); run_c = sum(vcnt[:WIN])
        run_cs = sum(csum[:WIN]); run_cc = sum(ccnt[:WIN])
        run_cov = sum(1 for k in range(min(WIN, nsub)) if vcnt[k])
        for s in range(0, nsub - WIN + 1):
            if s > 0:
                out_, in_ = s - 1, s + WIN - 1
                run_s += vsum[in_] - vsum[out_]; run_c += vcnt[in_] - vcnt[out_]
                run_cs += csum[in_] - csum[out_]; run_cc += ccnt[in_] - ccnt[out_]
                run_cov += (1 if vcnt[in_] else 0) - (1 if vcnt[out_] else 0)
            if run_c and run_cov >= COV:
                wavg = run_s / run_c * scale
                for k in range(s, s + WIN):
                    if best[k] is None or wavg > best[k][0]:
                        comp = round(run_cs / run_cc * cscale, 1) if run_cc else None
                        best[k] = (wavg, comp, date)

    bins = [{"km": round(k * bin_km, 3),
             "val": round(best[k][0], 1) if best[k] else None,
             "comp": best[k][1] if best[k] else None,
             "date": best[k][2] if best[k] else None}
            for k in range(nsub)]

    segments = _fast_segments(best, bin_km, threshold)
    return {"bins": bins, "bin_km": round(bin_km, 3), "win_km": round(win_km, 3),
            "route_km": round(total_m / 1000, 2), "threshold": threshold,
            "n_rides": n_rides, "segments": segments,
            "unit": unit, "metric": metric, "comp_unit": comp_unit}


# Contiguous stretches clearing the threshold, bridging gaps up to GAP sub-bins
# so a brief dip doesn't fragment a stretch. Mirrored client-side (computeFastSegments)
# so the threshold slider re-slices identically without a server round-trip.
_SEG_GAP = 2


def _fast_segments(best: list, bin_km: float, threshold: float) -> list:
    n = len(best)
    over = [bool(best[k]) and best[k][0] >= threshold for k in range(n)]
    segments, i = [], 0
    while i < n:
        if not over[i]:
            i += 1
            continue
        j = i
        while True:
            nxt = -1
            for g in range(1, _SEG_GAP + 2):
                if j + g < n and over[j + g]:
                    nxt = j + g
                    break
            if nxt < 0:
                break
            j = nxt
        seg = max((k for k in range(i, j + 1) if over[k]),
                  key=lambda k: best[k][0])
        segments.append({
            "km_start": round(i * bin_km, 2),
            "km_end": round((j + 1) * bin_km, 2),
            "length_km": round((j + 1 - i) * bin_km, 2),
            "peak": round(best[seg][0], 1),
            "comp": best[seg][1],
            "date": best[seg][2],
        })
        i = j + 1
    return segments
