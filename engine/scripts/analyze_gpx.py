#!/usr/bin/env python3
"""Analyze a GPX file for route-based workout design.

Usage: python analyze_gpx.py <file.gpx> [--json]

Outputs a terrain summary: total distance, elevation gain/loss,
detected climbs (start km, length, avg/max gradient, gain), and a
per-km gradient profile. Stdlib only — no gpxpy required.

The per-km profile is the key output for workout design: it lets you
map workout segments (efforts, floats, TT sections) onto the actual
terrain, e.g. placing threshold efforts on climbs and a TT block on a
sustained flat section.
"""
import sys
import json
import math
import xml.etree.ElementTree as ET


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
    """Initial compass bearing from point 1 to point 2, in degrees [0, 360)."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def turn_angle(b1, b2):
    """Absolute heading change between two bearings, in degrees [0, 180]."""
    d = abs(b2 - b1) % 360
    return d if d <= 180 else 360 - d


def resample(pts, cum, step_m=40.0):
    """Resample the polyline to a UNIFORM arc-length spacing by interpolation.

    Turn detection must use a fixed chord length or it is not comparable across
    files: dense GPX (~10 m/pt) and coarse komoot exports (~75 m/pt) would score
    the same road differently — coarse chords cut across curves and inflate the
    apparent turn angle, tanking continuity. Interpolating to a constant step
    (both down- and UP-sampling) makes the geometry density-independent.
    Returns [(lat, lon, dist_m), ...] including the exact final point."""
    total = cum[-1]
    out = []
    d, j = 0.0, 0
    while d <= total:
        while j < len(cum) - 2 and cum[j + 1] < d:
            j += 1
        seg = (cum[j + 1] - cum[j]) or 1.0
        f = min(max((d - cum[j]) / seg, 0.0), 1.0)
        la = pts[j][0] + (pts[j + 1][0] - pts[j][0]) * f
        lo = pts[j][1] + (pts[j + 1][1] - pts[j][1]) * f
        out.append((la, lo, d))
        d += step_m
    if not out or out[-1][2] < total - 1:
        out.append((pts[-1][0], pts[-1][1], total))
    return out


def parse_points(path):
    """Return list of (lat, lon, ele) from trkpt or rtept elements."""
    tree = ET.parse(path)
    root = tree.getroot()
    pts = []
    for el in root.iter():
        if strip_ns(el.tag) in ('trkpt', 'rtept'):
            try:
                lat = float(el.get('lat'))
                lon = float(el.get('lon'))
            except (TypeError, ValueError):
                continue
            ele = None
            for child in el:
                if strip_ns(child.tag) == 'ele' and child.text:
                    try:
                        ele = float(child.text)
                    except ValueError:
                        pass
                    break
            pts.append((lat, lon, ele))
    return pts


def compute_geometry(pts, cum, total_m):
    """Per-km road geometry from coordinates alone (no elevation needed).

    For each kilometre bucket returns:
      - sinuosity: ridden distance / straight-line distance (1.0 = arrow-straight)
      - turns_45 / turns_90: count of heading changes over 45 deg / 90 deg
      - continuity: 0-100 "can I hold steady power here" score. High = long
        straight road with few junctions; low = twisty / lots of corners.
    Also returns effort-ready blocks: contiguous runs of high-continuity km,
    the raw material for TT and steady-effort placement.
    """
    rs = resample(pts, cum, step_m=40.0)   # uniform 40 m chords, density-independent
    # Bearings along the uniform polyline, and the turn at each interior vertex.
    bearings = [bearing_deg(rs[a][0], rs[a][1], rs[a + 1][0], rs[a + 1][1])
                for a in range(len(rs) - 1)]
    # turn[k] is the heading change at vertex rs[k] (between seg k-1 and k)
    turns = [0.0] + [turn_angle(bearings[k - 1], bearings[k])
                     for k in range(1, len(bearings))] + [0.0]

    n_km = max(1, math.ceil(total_m / 1000))
    km_geo = []
    for k in range(n_km):
        start_m, end_m = k * 1000, min((k + 1) * 1000, total_m)
        # resampled vertices whose arc position falls in this bucket
        t45 = t90 = 0
        first = last = None
        for a in range(len(rs)):
            pos = rs[a][2]
            if start_m <= pos < end_m or (k == n_km - 1 and pos <= end_m):
                if first is None:
                    first = rs[a]
                last = rs[a]
                if turns[a] >= 90:
                    t90 += 1
                elif turns[a] >= 45:
                    t45 += 1
        if first is None or last is None or first is last:
            sinu = 1.0
        else:
            ridden = last[2] - first[2]
            straight = haversine_m(first[0], first[1], last[0], last[1])
            sinu = ridden / straight if straight > 1 else 1.0
        # continuity score: start at 100, dock for corners and wandering
        turn_pen = t90 * 22 + t45 * 7
        sinu_pen = max(0.0, sinu - 1.02) * 250
        continuity = max(0, round(100 - turn_pen - sinu_pen))
        km_geo.append({
            "km": k + 1,
            "sinuosity": round(sinu, 3),
            "turns_45": t45,
            "turns_90": t90,
            "continuity": continuity,
        })

    # Effort-ready blocks: runs of >= 2 km with continuity >= 65.
    blocks = []
    run_start = None
    for k, g in enumerate(km_geo):
        good = g["continuity"] >= 65
        if good and run_start is None:
            run_start = k
        if (not good or k == len(km_geo) - 1) and run_start is not None:
            run_end = k if good else k - 1
            length = run_end - run_start + 1
            if length >= 2:
                seg = km_geo[run_start:run_end + 1]
                blocks.append({
                    "start_km": run_start + 1,
                    "end_km": run_end + 1,
                    "length_km": length,
                    "avg_continuity": round(sum(s["continuity"] for s in seg) / length),
                    "total_turns_90": sum(s["turns_90"] for s in seg),
                })
            run_start = None
    blocks.sort(key=lambda b: (b["avg_continuity"], b["length_km"]), reverse=True)
    return {"per_km_geometry": km_geo, "effort_blocks": blocks}


def smooth(values, window=5):
    if not values:
        return values
    half = window // 2
    out = []
    for i in range(len(values)):
        lo, hi = max(0, i - half), min(len(values), i + half + 1)
        out.append(sum(values[lo:hi]) / (hi - lo))
    return out


def analyze(path):
    pts = parse_points(path)
    if len(pts) < 2:
        raise SystemExit("GPX contains fewer than 2 track/route points")

    has_ele = all(p[2] is not None for p in pts)
    # Cumulative distance per point
    cum = [0.0]
    for i in range(1, len(pts)):
        cum.append(cum[-1] + haversine_m(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]))
    total_m = cum[-1]

    result = {
        "points": len(pts),
        "distance_km": round(total_m / 1000, 2),
        "has_elevation": has_ele,
    }

    # Layer 1: geometry works from coordinates alone, so compute it regardless
    # of whether the file carries elevation.
    geo = compute_geometry(pts, cum, total_m)
    result.update(geo)

    if not has_ele:
        result["note"] = "No elevation data; treat route as flat unless the user says otherwise."
        return result

    eles = smooth([p[2] for p in pts], window=7)

    gain = loss = 0.0
    for i in range(1, len(eles)):
        d = eles[i] - eles[i - 1]
        if d > 0:
            gain += d
        else:
            loss -= d
    result["elevation_gain_m"] = round(gain)
    result["elevation_loss_m"] = round(loss)
    result["min_ele_m"] = round(min(eles))
    result["max_ele_m"] = round(max(eles))

    # Per-km profile: avg gradient per kilometer bucket
    km_profile = []
    n_km = max(1, math.ceil(total_m / 1000))
    idx = 0
    for k in range(n_km):
        start_m, end_m = k * 1000, min((k + 1) * 1000, total_m)
        # find indices spanning the bucket
        i0 = idx
        while idx < len(cum) - 1 and cum[idx + 1] < end_m:
            idx += 1
        i1 = min(idx + 1, len(pts) - 1)
        dist = max(cum[i1] - cum[i0], 1.0)
        grad = (eles[i1] - eles[i0]) / dist * 100
        km_profile.append({"km": k + 1, "avg_gradient_pct": round(grad, 1)})
    result["per_km_gradient"] = km_profile

    # Climb detection: contiguous stretches with gradient >= 2% over >= 300 m,
    # allowing brief (<200 m) dips below threshold.
    climbs = []
    i = 0
    while i < len(pts) - 1:
        seg_d = max(cum[i + 1] - cum[i], 0.01)
        g = (eles[i + 1] - eles[i]) / seg_d * 100
        if g >= 2.0:
            start = i
            j = i
            slack = 0.0
            while j < len(pts) - 1:
                d = max(cum[j + 1] - cum[j], 0.01)
                gj = (eles[j + 1] - eles[j]) / d * 100
                if gj >= 2.0:
                    slack = 0.0
                    j += 1
                else:
                    slack += d
                    if slack > 200:
                        break
                    j += 1
            length = cum[j] - cum[start]
            rise = eles[j] - eles[start]
            if length >= 300 and rise >= 8:
                grads = []
                for a in range(start, j):
                    dd = max(cum[a + 1] - cum[a], 0.01)
                    grads.append((eles[a + 1] - eles[a]) / dd * 100)
                climbs.append({
                    "start_km": round(cum[start] / 1000, 2),
                    "end_km": round(cum[j] / 1000, 2),
                    "length_m": round(length),
                    "gain_m": round(rise),
                    "avg_gradient_pct": round(rise / length * 100, 1),
                    "max_gradient_pct": round(max(grads), 1),
                })
            i = j + 1
        else:
            i += 1
    result["climbs"] = climbs

    # Longest reasonably flat stretch (|avg gradient| < 1.5% per km) — TT candidate
    best_start = best_len = cur_start = cur_len = 0
    for k, row in enumerate(km_profile):
        if abs(row["avg_gradient_pct"]) < 1.5:
            if cur_len == 0:
                cur_start = k
            cur_len += 1
            if cur_len > best_len:
                best_start, best_len = cur_start, cur_len
        else:
            cur_len = 0
    if best_len:
        result["longest_flat_stretch"] = {
            "start_km": best_start + 1, "end_km": best_start + best_len,
            "length_km": best_len,
        }

    # Fuse geometry with gradient: give every effort-ready block a terrain
    # character, and tag each climb with how interruptible it is.
    def grad_for_range(start_km, end_km):
        rows = [row["avg_gradient_pct"] for row in km_profile
                if start_km <= row["km"] <= end_km]
        return round(sum(rows) / len(rows), 1) if rows else 0.0

    def character(g):
        if g >= 1.5:
            return "climbing"
        if g <= -1.5:
            return "descending"
        if abs(g) < 0.8:
            return "flat"
        return "rolling"

    for b in result["effort_blocks"]:
        b["avg_gradient_pct"] = grad_for_range(b["start_km"], b["end_km"])
        b["character"] = character(b["avg_gradient_pct"])

    for c in climbs:
        seg = [g["continuity"] for g in result["per_km_geometry"]
               if c["start_km"] <= g["km"] <= c["end_km"] + 1]
        c["avg_continuity"] = round(sum(seg) / len(seg)) if seg else None

    return result


def fmt_effort_blocks(r):
    lines = []
    blocks = r.get("effort_blocks", [])
    if blocks:
        lines.append(f"Effort-ready blocks (straight, few junctions): {len(blocks)}")
        for b in blocks:
            char = b.get("character", "")
            char = f" [{char}]" if char else ""
            lines.append(f"  km {b['start_km']}-{b['end_km']} ({b['length_km']} km){char}: "
                         f"continuity {b['avg_continuity']}/100, "
                         f"{b['total_turns_90']} sharp turns")
    else:
        lines.append("No clean effort-ready blocks (route is twisty / junction-heavy throughout).")
    return lines


def fmt_text(r):
    lines = [
        f"Distance: {r['distance_km']} km ({r['points']} points)",
    ]
    if not r.get("has_elevation"):
        lines.append("No elevation data in file; geometry-only analysis.")
        lines += fmt_effort_blocks(r)
        cont = " ".join(f"{g['continuity']:>3}" for g in r["per_km_geometry"])
        lines.append(f"Per-km continuity (0-100): {cont}")
        return "\n".join(lines)
    lines.append(f"Elevation: +{r['elevation_gain_m']} m / -{r['elevation_loss_m']} m "
                 f"(range {r['min_ele_m']}-{r['max_ele_m']} m)")
    if r["climbs"]:
        lines.append(f"Climbs detected: {len(r['climbs'])}")
        for c in r["climbs"]:
            cont = c.get("avg_continuity")
            cont = f", continuity {cont}/100" if cont is not None else ""
            lines.append(f"  km {c['start_km']}-{c['end_km']}: {c['length_m']} m long, "
                         f"+{c['gain_m']} m, avg {c['avg_gradient_pct']}% (max {c['max_gradient_pct']}%){cont}")
    else:
        lines.append("No significant climbs (>=2% for >=300 m) detected.")
    if "longest_flat_stretch" in r:
        f = r["longest_flat_stretch"]
        lines.append(f"Longest flat stretch: km {f['start_km']}-{f['end_km']} ({f['length_km']} km) -- TT candidate")
    lines += fmt_effort_blocks(r)
    prof = " ".join(f"{row['avg_gradient_pct']:+.0f}" for row in r["per_km_gradient"])
    lines.append(f"Per-km gradient (%): {prof}")
    cont = " ".join(f"{g['continuity']:>3}" for g in r["per_km_geometry"])
    lines.append(f"Per-km continuity (0-100): {cont}")
    return "\n".join(lines)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    res = analyze(sys.argv[1])
    if "--json" in sys.argv:
        print(json.dumps(res, indent=2))
    else:
        print(fmt_text(res))
