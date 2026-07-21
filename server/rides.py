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
    """Stream-parse a history GPX -> ([(lat, lon, speed_ms|None, time|None)],
    activity_id|None). keep_every subsamples for the cheap indexing pass."""
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
                spd = tm = None
                for c in e:
                    ct = c.tag.rsplit("}", 1)[-1]
                    if ct == "speed" and c.text:
                        try:
                            spd = float(c.text)
                        except ValueError:
                            pass
                    elif ct == "time" and c.text:
                        tm = c.text
                pts.append((la, lo, spd, tm))
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
    for la, lo, _, tm in pts:
        ts = _ts(tm)
        spd = None
        if prev and ts and prev[2] and ts > prev[2]:
            d = engine.L1.haversine_m(prev[0], prev[1], la, lo)
            spd = d / (ts - prev[2])
        out.append((la, lo, spd, tm))
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
            "date": (pts[0][3] or "")[:10] if pts else "",
            "distance_km": round(dist, 1),
            "avg_kmh": round(sum(spds) / len(spds) * 3.6, 1) if spds else None,
            "max_kmh": round(max(spds) * 3.6, 1) if spds else None,
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
          for la, lo, spd, _ in pts[::step]]
    return {"track": tr, "activity_id": act, "points": len(tr)}
