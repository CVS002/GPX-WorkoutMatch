#!/usr/bin/env python3
"""Deterministic synthetic fixtures for the Python ↔ TypeScript parity test.

    python test/parity/fixtures.py <out_dir>

Writes routes (GPX in several dialects), an intervals.icu world (activities,
wellness, athlete, per-ride /map latlngs + /streams) and an OpenStreetMap world
(hazard nodes, roundabout ways, street ways) that the mock servers serve. Rides
follow the routes with GPS noise, stops at signalled junctions, sustained
efforts, missing streams, dropouts, reversed and partial passes — every branch
the engine has. No real personal data.
"""
import json
import math
import os
import random
import sys

R = random.Random(20261026)
OUT = sys.argv[1]
LAT0, LON0 = 51.4400, 5.4700
WORKOUT_IDS = ["i164994198", "i165409425", "i165713903"]   # planned-workout rides in workout_rides.json


def offset(lat, lon, dn, de):
    return lat + dn / 111320.0, lon + de / (111320.0 * math.cos(math.radians(lat)))


def walk(start, legs, step=5.0):
    """legs: (bearing_deg, length_m, wiggle_deg) → dense polyline every `step` m."""
    lat, lon = start
    pts = [(lat, lon)]
    for brg, length, wiggle in legs:
        n = max(1, int(length / step))
        for i in range(n):
            b = brg + (wiggle * math.sin(i / 9.0) if wiggle else 0.0)
            lat, lon = offset(lat, lon, step * math.cos(math.radians(b)), step * math.sin(math.radians(b)))
            pts.append((lat, lon))
    return pts


def hav(a, b):
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp, dl = p2 - p1, math.radians(b[1] - a[1])
    x = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371000.0 * math.asin(math.sqrt(x))


def cum(pts):
    c = [0.0]
    for i in range(1, len(pts)):
        c.append(c[-1] + hav(pts[i - 1], pts[i]))
    return c


def at(pts, c, d):
    """Interpolated point at along-track distance d."""
    d = max(0.0, min(c[-1], d))
    lo, hi = 0, len(c) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if c[mid] <= d:
            lo = mid
        else:
            hi = mid
    seg = (c[hi] - c[lo]) or 1.0
    f = (d - c[lo]) / seg
    return (pts[lo][0] + (pts[hi][0] - pts[lo][0]) * f, pts[lo][1] + (pts[hi][1] - pts[lo][1]) * f)


def resample(pts, spacing):
    c = cum(pts)
    out, d = [], 0.0
    while d < c[-1]:
        out.append(at(pts, c, d))
        d += spacing
    out.append(pts[-1])
    return out


def elev(d, climbs):
    e = 18.0 + 4.0 * math.sin(d / 3100.0)
    for (s, l, h) in climbs:
        if s <= d <= s + l:
            e += h * (d - s) / l
        elif s + l < d <= s + l + 900:
            e += h * (1 - (d - s - l) / 900)
    return e


# ------------------------------------------------------------------ routes ---
# R1: 62 km loop — long straights (effort blocks), a twisty town, climbs.
r1_base = walk((LAT0, LON0), [
    (88, 9000, 0), (178, 2500, 6), (100, 1500, 40), (180, 6000, 0), (268, 3000, 25),
    (270, 9500, 0), (0, 2000, 70), (355, 7000, 0), (45, 1800, 35), (90, 4500, 0),
    (10, 3000, 3), (300, 2200, 50), (180, 1900, 0), (95, 7000, 2),
])
# R2: 36 km out-and-back-ish, coarse komoot-style spacing, no elevation.
r2_base = walk(offset(LAT0, LON0, 900, -1800), [
    (200, 6000, 0), (120, 4000, 15), (90, 5000, 0), (30, 3500, 45), (330, 6000, 0),
    (260, 4500, 10), (240, 6500, 0),
])
# R3: starts well outside the home box (cache miss → live Overpass path).
r3_base = walk(offset(LAT0, LON0, -95000, 60000), [(60, 7000, 0), (150, 5000, 20), (240, 9000, 0)])
r4_base = walk(offset(LAT0, LON0, 300, 300), [(45, 800, 0)])
r5_base = walk(offset(LAT0, LON0, -1500, 2500), [(10, 4000, 0), (100, 5200, 30), (190, 3000, 0)])

R1 = resample(r1_base, 10.0)
R2 = resample(r2_base, 75.0)
R3 = resample(r3_base, 25.0)
R4 = resample(r4_base, 12.0)
R5 = resample(r5_base, 20.0)
R1_CLIMBS = [(5200, 1400, 32), (21000, 800, 14), (40000, 2200, 45), (55000, 600, 9)]


def noisy(lat, lon, m):
    return offset(lat, lon, R.gauss(0, m), R.gauss(0, m))


def write_gpx(path, pts, ele=None, dialect="trk"):
    c = cum(pts)
    rows = []
    for i, (la, lo) in enumerate(pts):
        e = ele(c[i], i) if ele else None
        tag = "rtept" if dialect == "rte" else ("gpx:trkpt" if dialect == "prefixed" else "trkpt")
        inner = f"<ele>{e:.1f}</ele>" if e is not None else ""
        if dialect == "prefixed" and inner:
            inner = f"<gpx:ele>{e:.1f}</gpx:ele>"
        rows.append(f'<{tag} lat="{la:.6f}" lon="{lo:.6f}">{inner}</{tag}>')
    if dialect == "rte":
        body = "<rte><name>R</name>\n" + "\n".join(rows) + "\n</rte>"
    elif dialect == "prefixed":
        body = "<gpx:trk><gpx:trkseg>\n" + "\n".join(rows) + "\n</gpx:trkseg></gpx:trk>"
    else:
        body = "<trk><name>R</name><trkseg>\n<!-- exported <trkpt lat='0' lon='0'/> -->\n" + "\n".join(rows) + "\n</trkseg></trk>"
    root = ('<gpx:gpx xmlns:gpx="http://www.topografix.com/GPX/1/1" version="1.1">' if dialect == "prefixed"
            else '<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1" creator="fixture">')
    close = "</gpx:gpx>" if dialect == "prefixed" else "</gpx>"
    with open(path, "w", encoding="utf-8") as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n' + root + "\n" + body + "\n" + close + "\n")


os.makedirs(os.path.join(OUT, "routes"), exist_ok=True)
write_gpx(os.path.join(OUT, "routes", "loop62.gpx"), R1, lambda d, i: elev(d, R1_CLIMBS) + R.gauss(0, 0.25))
write_gpx(os.path.join(OUT, "routes", "komoot36.gpx"), R2, None, "rte")
write_gpx(os.path.join(OUT, "routes", "away21.gpx"), R3, lambda d, i: 40 + 12 * math.sin(d / 900.0))
write_gpx(os.path.join(OUT, "routes", "tiny.gpx"), R4, lambda d, i: 12.0)
write_gpx(os.path.join(OUT, "routes", "prefixed12.gpx"), R5, lambda d, i: None if i % 97 == 5 else 30 + d / 400.0, "prefixed")
with open(os.path.join(OUT, "routes", "broken.gpx"), "w") as f:
    f.write("this is not xml")

# ------------------------------------------------------------- junctions ---
def junctions(route, every_m):
    c = cum(route)
    out, d = [], every_m * 0.6
    while d < c[-1] - 200:
        out.append((d, at(route, c, d)))
        d += every_m * R.uniform(0.7, 1.4)
    return out


J1 = junctions(R1, 4200)
J2 = junctions(R2, 3800)

# ------------------------------------------------------------------- rides ---
def ride(route, section, reverse, stops, opts):
    """Simulate one ride along a route section: 1 Hz streams."""
    c = cum(route)
    d0, d1 = section[0] * c[-1], section[1] * c[-1]
    stop_at = sorted(d for d, _ in stops if d0 < d < d1)
    if reverse:
        stop_at = sorted((d0 + d1 - d for d in stop_at))
    efforts = []
    for _ in range(opts.get("efforts", 0)):
        s = R.uniform(d0 + 500, max(d0 + 600, d1 - 4000))
        efforts.append((s, s + R.uniform(1300, 3500)))
    t, d, v = 0, d0, 7.5
    lat, lon, tt, vel, hr, pw, alt = [], [], [], [], [], [], []
    pending = list(stop_at)
    hold = 0
    while d < d1 and t < 5 * 3600:
        dist_on_route = (d0 + d1 - d) if reverse else d
        in_eff = any(a <= d <= b for a, b in efforts)
        if hold > 0:
            v = 0.0 if hold > 2 else 1.0
            hold -= 1
        else:
            target = R.uniform(9.6, 10.4) if in_eff else R.uniform(7.0, 8.4)
            v += (target - v) * 0.25 + R.gauss(0, 0.15)
            if pending and d >= pending[0] - 30:
                if R.random() < opts.get("stop_p", 0.8):
                    hold = R.randint(8, 35)
                else:
                    v = min(v, 3.0)
                pending.pop(0)
        v = max(0.0, v)
        p = at(route, c, dist_on_route)
        la, lo = noisy(p[0], p[1], opts.get("noise", 2.5))
        lat.append(la); lon.append(lo); tt.append(t); vel.append(round(v, 4))
        hr.append(int(172 + R.gauss(0, 2)) if in_eff else int(138 + R.gauss(0, 5)))
        pw.append(int(310 + R.gauss(0, 15)) if in_eff else int(190 + R.gauss(0, 25)))
        alt.append(round(elev(dist_on_route, opts.get("climbs", [])) + R.gauss(0, 0.4), 2))
        d += v
        t += 1
    latlngs = [[a, b] for a, b in zip(lat, lon)]
    for k in opts.get("dropouts", []):
        if k < len(latlngs):
            latlngs[k] = None if k % 2 else [latlngs[k][0]]
    streams = [{"type": "time", "data": tt}]
    if opts.get("speed", True):
        streams.append({"type": "velocity_smooth", "data": vel})
    if opts.get("hr", True):
        streams.append({"type": "heartrate", "data": hr})
    if opts.get("alt", True):
        streams.append({"type": "altitude", "data": alt})
    if opts.get("power", True):
        streams.append({"type": "watts", "data": pw})
    return latlngs, streams, d - d0, t


acts, ride_data = [], {}
plan = []
for k in range(30):
    sec = (R.uniform(0, 0.25), R.uniform(0.75, 1.0)) if k % 4 else (0.0, 1.0)
    plan.append(("R1", sec, k % 3 == 2, {"efforts": R.randint(0, 3), "power": k % 5 != 0, "hr": k % 7 != 3,
                                          "speed": k % 9 != 4, "alt": k % 6 != 1, "climbs": R1_CLIMBS,
                                          "dropouts": [40, 41, 300] if k == 8 else [], "stop_p": 0.85}))
for k in range(12):
    plan.append(("R2", (0.0, 1.0) if k % 2 else (0.3, 0.9), k % 4 == 1,
                 {"efforts": R.randint(0, 2), "power": k % 3 != 0, "hr": True, "speed": True, "stop_p": 0.7}))
for k in range(3):
    plan.append(("R3", (0.0, 1.0), False, {"efforts": 1}))
routes = {"R1": (R1, J1), "R2": (R2, J2), "R3": (R3, [])}

base_day = 20000
for n, (rname, sec, rev, opts) in enumerate(plan):
    aid = WORKOUT_IDS[n] if n < len(WORKOUT_IDS) else f"i{170000000 + n * 7919}"
    route, js = routes[rname]
    latlngs, streams, dist, secs = ride(route, sec, rev, js, opts)
    day = base_day + n * 13
    y, m, d = 2024 + (n * 13) // 365, 1 + ((n * 13) % 365) // 31, 1 + ((n * 13) % 31) % 28
    start = f"{y:04d}-{m:02d}-{d:02d}T{7 + n % 10:02d}:{(n * 7) % 60:02d}:0{n % 10}"
    ride_data[aid] = {"map": {"latlngs": latlngs}, "streams": streams}
    acts.append({"id": aid, "type": "Ride", "distance": round(dist, 1), "start_date_local": start,
                 "name": f"Fixture ride {n}", "moving_time": secs,
                 "icu_training_load": R.randint(30, 160), "icu_intensity": round(R.uniform(55, 102), 1)})

# edge cases: no geometry, a run, a zero-distance ride, a virtual ride
ride_data["i199000001"] = {"map": {"latlngs": [[51.44, 5.47]]}, "streams": [{"type": "time", "data": [0]}]}
acts.append({"id": "i199000001", "type": "Ride", "distance": 1200, "start_date_local": "2026-06-01T10:00:00",
             "name": "GPS failed", "moving_time": 600})
acts.append({"id": "i199000002", "type": "Run", "distance": 8000, "start_date_local": "2026-06-02T10:00:00",
             "name": "Run", "moving_time": 2400, "icu_training_load": 40, "icu_intensity": 80})
acts.append({"id": "i199000003", "type": "Ride", "distance": 0, "start_date_local": "2026-06-03T10:00:00",
             "name": "Trainer", "moving_time": 2400})
acts.append({"id": "i199000004", "type": "VirtualRide", "distance": 30000, "start_date_local": "2026-06-04T10:00:00",
             "name": "Zwift", "moving_time": 3600, "icu_training_load": 70, "icu_intensity": 91})

# recent load (14 d window ends at the newest activity)
recent = []
for i in range(16):
    recent.append({"id": f"r{i}", "type": ["Ride", "Run", "VirtualRide", "Ride"][i % 4],
                   "start_date_local": f"2026-10-{25 - i:02d}T08:00:00", "name": f"Session {i}",
                   "moving_time": 3600 + 60 * i, "icu_training_load": 40 + 7 * i,
                   "icu_intensity": [62, 79, 92, 101, 55, 70, None, 96][i % 8]})

icu = {
    "activities_history": acts, "activities_recent": recent,
    "wellness": [{"id": f"2026-10-{20 + i}", "ctl": 61.2 + i, "atl": 70.07 - 2 * i} for i in range(6)] + [{"id": "2026-10-26", "ctl": None}],
    "athlete": {"id": "i0", "sportSettings": [{"types": ["Run"], "ftp": 250}, {"types": ["Ride", "VirtualRide"], "ftp": 287, "lthr": 171}]},
    "events": [{"id": 900, "start_date_local": "2026-10-27T00:00:00", "name": "Club ride", "category": "WORKOUT"},
               {"id": 901, "start_date_local": "2026-10-29T00:00:00", "name": None, "category": "NOTE"}],
    "created_event": {"id": 4242, "icu_training_load": 91, "icu_intensity": 83.4},
}
os.makedirs(os.path.join(OUT, "icu"), exist_ok=True)
json.dump(icu, open(os.path.join(OUT, "icu", "world.json"), "w"))
json.dump(ride_data, open(os.path.join(OUT, "icu", "rides.json"), "w"))

# --------------------------------------------------------------------- osm ---
nodes, ways = [], []
nid = 1000
for route, js in ((R1, J1), (R2, J2)):
    for k, (d, p) in enumerate(js):
        nid += 1
        tag = [{"highway": "traffic_signals"}, {"highway": "give_way"}, {"railway": "level_crossing"},
               {"highway": "stop"}, {"highway": "mini_roundabout"}, {"highway": "traffic_signals", "crossing": "x"}][k % 6]
        la, lo = noisy(p[0], p[1], 6)
        nodes.append({"type": "node", "id": nid, "lat": round(la, 7), "lon": round(lo, 7), "tags": tag})
        if k % 3 == 0:                       # a duplicate a few metres on (dedupe path)
            nid += 1
            la2, lo2 = offset(la, lo, 12, 8)
            nodes.append({"type": "node", "id": nid, "lat": round(la2, 7), "lon": round(lo2, 7), "tags": tag})
for _ in range(400):                         # scattered regional hazards
    nid += 1
    la, lo = offset(LAT0, LON0, R.uniform(-40000, 40000), R.uniform(-40000, 40000))
    nodes.append({"type": "node", "id": nid, "lat": round(la, 7), "lon": round(lo, 7),
                  "tags": R.choice([{"highway": "traffic_signals"}, {"highway": "give_way"}, {"highway": "stop"}])})
for i in range(60):                          # roundabouts (ways → out center)
    wid = 50000 + i
    route = R1 if i % 2 else R2
    p = route[R.randrange(len(route))] if i % 3 == 0 else offset(LAT0, LON0, R.uniform(-30000, 30000), R.uniform(-30000, 30000))
    ways.append({"type": "way", "id": wid, "center": {"lat": round(p[0] + 0.00012, 7), "lon": round(p[1], 7)},
                 "tags": {"junction": "roundabout", "highway": "tertiary"}})
for route, js in ((R3, []),):
    p = route[len(route) // 3]
    nid += 1
    nodes.append({"type": "node", "id": nid, "lat": p[0], "lon": p[1], "tags": {"highway": "traffic_signals"}})

streets = []
sid = 700000
classes = ["residential", "tertiary", "cycleway", "path", "track", "service", "primary", "unclassified",
           "footway", "secondary", "living_street", "primary_link"]
def add_street(pts, cls, tags=None):
    global sid
    sid += R.randint(1, 5)
    t = {"highway": cls}
    t.update(tags or {})
    streets.append({"type": "way", "id": sid, "tags": t,
                    "geometry": [{"lat": round(a, 7), "lon": round(b, 7)} for a, b in pts]})
for route in (R1, R2, R5):
    c = cum(route)
    d = 0.0
    while d < c[-1]:
        seg = [at(route, c, x) for x in [d + 15 * k for k in range(R.randint(8, 60))] if x < c[-1]]
        if len(seg) >= 2:
            add_street([offset(a, b, 4, -3) for a, b in seg], R.choice(classes),
                       R.choice([{}, {}, {"bicycle": "designated"}, {"cyclestreet": "yes"}, {"bicycle": "no"}]))
        d += R.uniform(150, 900)
for _ in range(2600):                        # dense regional grid
    la, lo = offset(LAT0, LON0, R.uniform(-30000, 30000), R.uniform(-30000, 30000))
    brg = R.uniform(0, 360)
    pts = [(la, lo)]
    for _k in range(R.randint(2, 70)):
        la, lo = offset(la, lo, 14 * math.cos(math.radians(brg)), 14 * math.sin(math.radians(brg)))
        brg += R.gauss(0, 8)
        pts.append((la, lo))
    add_street(pts, R.choice(classes), R.choice([{}, {"bicycle": "yes"}, {"bicycle_road": "yes"}, {}]))
add_street([(LAT0 + 0.01, LON0)], "residential")          # single-node way (skipped)
streets.sort(key=lambda w: w["id"])
os.makedirs(os.path.join(OUT, "osm"), exist_ok=True)
json.dump({"nodes": nodes, "ways": ways, "streets": streets}, open(os.path.join(OUT, "osm", "world.json"), "w"))

# ---------------------------------------------------------------- zwo bank ---
zwo = [
    '<workout_file><name>Over &amp; Unders</name><workout><Warmup Duration="600" PowerLow="0.5" PowerHigh="0.75"/>'
    '<IntervalsT Repeat="4" OnDuration="480" OffDuration="240" OnPower="1.0" OffPower="0.6"/>'
    '<Cooldown Duration="600" PowerLow="0.6" PowerHigh="0.4"/></workout></workout_file>',
    '<workout_file><name>VO2 30/30</name><workout><SteadyState Duration="900" Power="0.6"/>'
    '<IntervalsT Repeat="10" OnDuration="30" OffDuration="30" OnPower="1.25" OffPower="0.5"/></workout></workout_file>',
    '<workout_file><name>Sprints</name><workout><SteadyState Duration="600" Power="0.6"/>'
    '<MaxEffort Duration="15"/><SteadyState Duration="300" Power="0.55"/><MaxEffort Duration="15"/>'
    '<SteadyState Duration="300" Power="0.55"/></workout></workout_file>',
    '<workout_file><name>  Z2  </name><workout><SteadyState Duration="5400" Power="0.65"/><FreeRide Duration="600"/></workout></workout_file>',
    '<workout_file><name>Tempo</name><workout><SteadyState Duration="1200" Power="0.82"/><SteadyState Duration="1200" Power="0.29"/>'
    '<Ramp Duration="300" PowerLow="0.9" PowerHigh="1.1"/></workout></workout_file>',
    '<workout_file><name>short</name><workout><SteadyState Duration="200" Power="0.6"/></workout></workout_file>',
    '<workout_file><workout><SteadyState Duration="1200" Power="0.91"/><SteadyState Duration="1200" Power="0.91"/></workout></workout_file>',
    '<workout_file><name>broken</name><workout><SteadyState Duration="x" Power=""/></workout>',
]
json.dump(zwo, open(os.path.join(OUT, "zwo.json"), "w"))
print(f"fixtures: {len(acts)} activities, {len(ride_data)} ride streams, {len(nodes)} nodes, "
      f"{len(ways)} roundabouts, {len(streets)} streets -> {OUT}")
