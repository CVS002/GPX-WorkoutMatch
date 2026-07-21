#!/usr/bin/env python3
"""Build the interactive route-editor widget from a GPX + the analysis layers.

Usage:
    python build_map_widget.py <route.gpx> --out <file.html> \
        [--cache <road_db.json>] [--ftp 300] [--title "..."] \
        [--segs <segs.json>] [--no-osm]

Produces a single self-contained HTML file: the route drawn and coloured by
road quality (Layer 1 geometry + Layer 2 history), junction/stop markers
(Layer 2/3), the proposed effort blocks as draggable bands (500 m snapping),
and a workout table that recomputes live. A "Send adjusted plan to Claude"
button posts the fine-tuned boundaries back via the widget host's sendPrompt.

Render the output with the visualize `show_widget` tool (pass the file's
contents as widget_code) or just open it in a browser. Stdlib only; the OSM
layer is skipped gracefully if --no-osm is set or the network is unavailable.

--segs takes a JSON list of {name, a, b, pct, kind, buf}; kind is one of
warmup/work/rest/tt/cooldown. If omitted, a sensible v3-style template is
scaled to the route length so the widget is still usable.
"""
import sys
import os
import json
import math

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import analyze_gpx as L1          # noqa: E402
import score_route as L2          # noqa: E402


def arg(flag, default=None):
    return sys.argv[sys.argv.index(flag) + 1] if flag in sys.argv else default


def cumdist(pts):
    cum = [0.0]
    for i in range(1, len(pts)):
        cum.append(cum[-1] + L1.haversine_m(pts[i - 1][0], pts[i - 1][1],
                                            pts[i][0], pts[i][1]))
    return cum


def fetch_streets(pts, buffer_m=250, max_points=9000):
    """Fetch nearby OSM road geometry from Overpass and return simplified
    polylines [[lat,lon],...] to draw as a street basemap behind the route.

    Retrieved live at build time (no cache) and embedded as vector data, so the
    widget stays self-contained and needs no network when rendered. Returns []
    on any network error — streets are a nicety, never a hard dependency."""
    import urllib.request
    # thin the route to ~150 m so the around-filter coordinate list stays small
    keep, last = [0], 0
    cum = cumdist(pts)
    for i in range(1, len(pts)):
        if cum[i] - cum[last] >= 150:
            keep.append(i); last = i
    coords = ",".join(f"{pts[i][0]:.5f},{pts[i][1]:.5f}" for i in keep)
    roads = ("primary|secondary|tertiary|unclassified|residential|living_street|"
             "primary_link|secondary_link|tertiary_link|cycleway|track|road")
    q = (f"[out:json][timeout:60];way(around:{buffer_m},{coords})"
         f'["highway"~"^({roads})$"];out geom;')
    try:
        req = urllib.request.Request("https://overpass-api.de/api/interpreter",
                                     data=q.encode("utf-8"),
                                     headers={"User-Agent": "gpx-workout-designer-v2/2.0"})
        with urllib.request.urlopen(req, timeout=90) as r:
            raw = json.loads(r.read().decode("utf-8"))
    except Exception as e:  # noqa: BLE001
        print(f"  (streets skipped: {type(e).__name__})")
        return []
    lines, n = [], 0
    for el in raw.get("elements", []):
        g = el.get("geometry")
        if not g or len(g) < 2:
            continue
        # distance-decimate each way: keep a point every ~25 m
        poly = [[round(g[0]["lat"], 5), round(g[0]["lon"], 5)]]
        acc = 0.0
        for a, b in zip(g, g[1:]):
            acc += L1.haversine_m(a["lat"], a["lon"], b["lat"], b["lon"])
            if acc >= 25:
                poly.append([round(b["lat"], 5), round(b["lon"], 5)]); acc = 0.0
        if poly[-1] != [round(g[-1]["lat"], 5), round(g[-1]["lon"], 5)]:
            poly.append([round(g[-1]["lat"], 5), round(g[-1]["lon"], 5)])
        lines.append(poly); n += len(poly)
    if n > max_points:  # too dense — drop shortest ways until under budget
        lines.sort(key=len, reverse=True)
        out, tot = [], 0
        for p in lines:
            if tot + len(p) > max_points:
                break
            out.append(p); tot += len(p)
        lines = out
        print(f"  (streets capped to {tot} pts across {len(lines)} ways)")
    print(f"  streets: {len(lines)} ways, {sum(len(p) for p in lines)} pts")
    return lines


DEFAULT_STREET_CACHE = os.path.join(HERE, "..", "data", "cache", "osm_streets.json")


def _route_bbox(pts):
    la = [p[0] for p in pts]
    lo = [p[1] for p in pts]
    return min(la), min(lo), max(la), max(lo)


def streets_from_cache(cache, pts, buffer_m, max_points):
    """Select cached ways within the route's bounding box (+ buffer), offline.
    Returns None if the route isn't fully inside the cached box (caller then
    falls back to a live fetch)."""
    s, w, n, e = _route_bbox(pts)
    cb = cache["meta"]["bbox"]                       # [s, w, n, e]
    if not (s >= cb[0] and w >= cb[1] and n <= cb[2] and e <= cb[3]):
        return None
    m = buffer_m / 111000.0 + 0.003
    box = (s - m, w - m, n + m, e + m)
    lines = [way["g"] for way in cache["ways"]
             if any(box[0] <= p[0] <= box[2] and box[1] <= p[1] <= box[3] for p in way["g"])]
    if sum(len(p) for p in lines) > max_points:
        lines.sort(key=len, reverse=True)
        out, tot = [], 0
        for p in lines:
            if tot + len(p) > max_points:
                break
            out.append(p); tot += len(p)
        lines = out
    print(f"  streets: {len(lines)} ways from cache ({sum(len(p) for p in lines)} pts)")
    return lines


def get_streets(pts, buffer_m, max_points, use_cache=True):
    """Street basemap: read the regional cache first (offline), else live Overpass."""
    if use_cache and os.path.exists(DEFAULT_STREET_CACHE):
        try:
            cache = json.load(open(DEFAULT_STREET_CACHE, encoding="utf-8"))
            got = streets_from_cache(cache, pts, buffer_m, max_points)
            if got is not None:
                return got
            print("  (route outside street cache box; live fetch)")
        except Exception as e:  # noqa: BLE001
            print(f"  (street cache unreadable: {type(e).__name__}; live fetch)")
    return fetch_streets(pts, buffer_m=buffer_m, max_points=max_points)


# --- Offline workout picker: candidate interval bodies embedded per category ---
# Parsed from the workout bank so the HTML can switch sessions with no round-trip
# to Claude. The per-category windows (shared with suggest_workout.py via
# workout_windows.py) keep each category's shapes physiologically sane; REST/PCT
# supply the recovery the bank's one-line summary omits.
from workout_windows import CAT_WIN, REST_MIN, REST_PCT, parse_struct as _parse_struct  # noqa: E402


def build_candidates(bank_path, rkm):
    """Per-category list of concrete, renderable interval sessions from the bank.
    Steady endurance is generated canonically (the bank's summary line can't
    describe a pure Z2 ride). body_min must plausibly fit the route."""
    try:
        bank = json.load(open(os.path.abspath(bank_path), encoding="utf-8")).get("workouts", [])
    except Exception as e:  # noqa: BLE001
        print(f"  (candidates skipped: {type(e).__name__})")
        return {}
    max_body = max(6.0, (rkm - 4) * 2)          # 30 km/h -> minutes that fit + wu/cd
    out = {}
    for cat, win in CAT_WIN.items():
        seen, cand = set(), []
        for w in bank:
            if w.get("category") != cat:
                continue
            p = _parse_struct(w.get("structure", ""))
            if not p:
                continue
            reps, work_min, pct = p
            if not (win["pct"][0] <= pct <= win["pct"][1]):
                continue
            if not (win["work"][0] <= work_min <= win["work"][1]):
                continue
            if not (win["reps"][0] <= reps <= win["reps"][1]):
                continue
            rest_min = REST_MIN[cat](work_min)
            body = reps * work_min + (reps - 1) * rest_min
            if body > max_body:
                continue
            key = (reps, round(work_min, 2), pct)
            if key in seen:
                continue
            seen.add(key)
            lo, hi = max(50, pct - 2), min(300, pct + 2)
            cand.append({
                "name": w.get("name", cat), "plan": w.get("plan", ""),
                "category": cat, "reps": reps,
                "work_min": round(work_min, 2), "work_pct": f"{lo}-{hi}",
                "rest_min": rest_min, "rest_pct": REST_PCT[cat],
                "body_min": round(body, 1),
            })
        cand.sort(key=lambda c: (c["reps"], c["work_min"]))
        # spread the list so the dropdown shows variety, not 8 near-identical sets
        if len(cand) > 8:
            step = len(cand) / 8.0
            cand = [cand[int(i * step)] for i in range(8)]
        out[cat] = cand
    out["endurance"] = [
        {"name": "Steady Z2", "category": "endurance", "steady": True,
         "work_pct": "63-70", "body_min": max_body},
        {"name": "Z2 + 3x8 tempo surges", "category": "endurance", "reps": 3,
         "work_min": 8.0, "work_pct": "82-88", "rest_min": 6.0, "rest_pct": "63-70",
         "body_min": 3 * 8 + 2 * 6},
        {"name": "Z2 + 2x15 tempo", "category": "endurance", "reps": 2,
         "work_min": 15.0, "work_pct": "80-86", "rest_min": 8.0, "rest_pct": "63-70",
         "body_min": 2 * 15 + 8},
    ]
    n = sum(len(v) for v in out.values())
    print(f"  candidates: {n} sessions across {len(out)} categories")
    return out


# Hazard severity weights for the composite score / crossing penalty. A traffic
# light forces a full stop; a low-confidence right-before-left rarely does.
HAZ_SEVERITY = {
    "traffic_signal": 3.0, "level_crossing": 3.0, "roundabout": 2.0,
    "stop_sign": 2.5, "give_way": 2.0, "yield_left": 2.0,
    "right_before_left": 0.6,
}
STOP_SEVERITY = 2.5           # a recurring ride-history near-stop
# per-km history multiplier: a proven-clean km is worth more, a known-stop far less
QUAL_MULT = {"known-clear": 1.12, "unknown": 1.0, "known-stop": 0.5}


def _haz_km_bucket(km, nkm):
    """km label (1-based) a hazard at route-position km falls in."""
    return min(nkm, max(1, int(km) + 1))


EFF_CAP = 12.0        # most an effort-corridor bonus can add to a km's score
EFF_W = 12.0          # weight on (breadth x repetition) of past sustained efforts


def _eff_bonus(rec):
    """Layer 5: positive bonus for a km the athlete has proven holds an effort.
    Needs both breadth (share of the km on a corridor) and repetition (rides).
    Full bonus at frac=1 and >=5 rides; nothing below 2 rides / no coverage."""
    if not rec:
        return 0.0
    frac = rec.get("corridor_frac", 0.0)
    strength = max(0.0, min(1.0, (rec.get("avg_passes", 0.0) - 1.0) / 4.0))
    return min(EFF_CAP, EFF_W * frac * strength)


def compute_effort(l1, qual, haz, stops, nkm, corridor=None):
    """Per-km composite 'can I hold an effort here' score fusing all layers:
    geometry continuity (L1) x history quality (L2) minus severity-weighted
    hazard/stop density (L3) plus a proven-effort-corridor bonus (L5).
    Returns (scores[list, 1-based], cont, grad)."""
    cont = {g["km"]: g["continuity"] for g in l1.get("per_km_geometry", [])}
    grad = {g["km"]: g["avg_gradient_pct"] for g in l1.get("per_km_gradient", [])}
    corridor = corridor or {}
    hz = [0.0] * (nkm + 1)
    for h in haz:
        hz[_haz_km_bucket(h["km"], nkm)] += HAZ_SEVERITY.get(h["t"], 1.5)
    for s in stops:
        hz[_haz_km_bucket(s["km"], nkm)] += STOP_SEVERITY
    scores = []
    for k in range(1, nkm + 1):
        c = cont.get(k, 0)
        qm = QUAL_MULT.get(qual.get(k, "unknown"), 1.0)
        pen = min(70.0, hz[k] * 18.0)
        bonus = _eff_bonus(corridor.get(k))
        scores.append(max(0.0, round(c * qm - pen + bonus, 1)))
    return scores, cont, grad


def score_tier(s):
    return "g" if s >= 68 else ("m" if s >= 42 else "p")


def placement_blocks(l1, scores, grad, nkm, thresh=58):
    """Ranked stretches for auto-placing an interval body, best first — now off
    the composite effort score (not geometry alone), so a straight-but-known-stop
    stretch no longer outranks a proven-clean one."""
    def character(g):
        if g >= 1.5:
            return "climbing"
        if g <= -1.5:
            return "descending"
        return "flat" if abs(g) < 0.8 else "rolling"

    blocks = []
    run = None
    for k in range(1, nkm + 1):
        good = scores[k - 1] >= thresh
        if good and run is None:
            run = k
        if (not good or k == nkm) and run is not None:
            end = k if good else k - 1
            if end - run + 1 >= 2:
                seg = scores[run - 1:end]
                cavg = sum(seg) / len(seg)
                gs = [grad.get(kk, 0.0) for kk in range(run, end + 1)]
                blocks.append({"start_km": run, "end_km": end, "len_km": end - run + 1,
                               "score": round(cavg), "cont": round(cavg),
                               "character": character(sum(gs) / len(gs))})
            run = None
    # low-scoring long fallback so a big body (e.g. 2x20) still has somewhere to
    # land when no high-scoring block is long enough.
    lf = l1.get("longest_flat_stretch")
    if lf and lf.get("length_km", 0) >= 3:
        a, b = lf["start_km"], lf["end_km"]
        seg = scores[a - 1:b] or [40]
        blocks.append({"start_km": a, "end_km": b, "len_km": lf["length_km"],
                       "score": round(sum(seg) / len(seg)), "cont": round(sum(seg) / len(seg)),
                       "character": "flat (long)"})
    blocks.sort(key=lambda x: (-x["score"], -x["len_km"]))
    return blocks


def default_segs(rkm):
    """v3-style template (approach / 3 laps / chill / TT / cooldown) scaled to route."""
    approach = round(rkm * 0.16)
    lap = max(6, round(rkm * 0.11))
    chill = max(8, round(rkm * 0.12))
    tt = min(10, max(6, round(rkm * 0.11)))
    a = approach
    segs = [{"name": "Approach Z2", "a": 0, "b": a, "pct": "67-72", "kind": "warmup", "buf": True}]
    for i, p in enumerate(["88-92", "95-97", "98-102"]):
        segs.append({"name": f"Lap {i+1}", "a": a, "b": a + lap, "pct": p, "kind": "work"})
        a += lap
    segs.append({"name": "Chill eat+drink", "a": a, "b": a + chill, "pct": "60-67", "kind": "rest", "buf": True})
    a += chill
    segs.append({"name": "TT", "a": a, "b": a + tt, "pct": "100-103", "kind": "tt"})
    a += tt
    segs.append({"name": "Cooldown Z2", "a": a, "b": round(rkm), "pct": "65-70", "kind": "cooldown"})
    return segs


def build():
    gpx = [a for a in sys.argv[1:] if not a.startswith("--")][0]
    out = arg("--out", os.path.join(HERE, "..", "data", "route_editor.html"))
    ftp = int(arg("--ftp", "300"))
    title = arg("--title", os.path.splitext(os.path.basename(gpx))[0] + " - route editor")
    cache = arg("--cache", os.path.join(HERE, "..", "data", "cache", "road_db.json"))

    pts = L1.parse_points(gpx)
    if len(pts) < 2:
        raise SystemExit("route GPX has fewer than 2 points")
    cum = cumdist(pts)
    rkm = round(cum[-1] / 1000, 1)

    def pt_at_km(k):
        m = k * 1000
        for i in range(len(cum)):
            if cum[i] >= m:
                return [round(pts[i][0], 5), round(pts[i][1], 5)]
        return [round(pts[-1][0], 5), round(pts[-1][1], 5)]

    l1 = L1.analyze(gpx)
    cont = {g["km"]: g["continuity"] for g in l1.get("per_km_geometry", [])}

    # Layer 2 (optional — needs the cache)
    qual = {}
    coverage = 0
    stops = []
    if os.path.exists(os.path.abspath(cache)):
        try:
            l2 = L2.score(gpx, os.path.abspath(cache))
            qual = {q["km"]: q["quality"] for q in l2["per_km_road_quality"]}
            coverage = l2["route_coverage_pct"]
            stops = [{"km": round(h["km"], 2), "pos": pt_at_km(h["km"])} for h in l2["stop_hotspots"]]
        except Exception as e:  # noqa: BLE001
            print(f"  (layer 2 skipped: {e})")

    # Layer 3 (optional — needs network). During the finalize loop the map is
    # rebuilt many times; pass --haz <file> (a result saved by
    # `osm_enrich.py --save`) to reuse Step 1c's analysis instead of re-hitting
    # Overpass (the live priority ways-fetch costs ~20 s per call). --no-priority
    # keeps the base hazards but skips that live turn/priority analysis.
    haz = []
    hazfile = arg("--haz")
    l3 = None
    if hazfile and os.path.exists(hazfile):
        try:
            l3 = json.load(open(hazfile, encoding="utf-8"))
            print(f"  layer 3: reused {hazfile}")
        except Exception as e:  # noqa: BLE001
            print(f"  (saved hazards unreadable: {type(e).__name__}; running enrich)")
    if l3 is None and "--no-osm" not in sys.argv:
        try:
            import osm_enrich as L3
            l3 = L3.enrich(gpx, priority="--no-priority" not in sys.argv)
        except Exception as e:  # noqa: BLE001
            print(f"  (layer 3 skipped: {e})")
    if l3 and l3.get("available"):
        haz = [{"km": round(h["km"], 2), "t": h["type"], "pos": pt_at_km(h["km"]),
                "c": h.get("confidence"), "turn": h.get("turn")}
               for h in l3["hazards"]]

    # Athlete overrides: --clear "17.3,29.6" drops hazards/stops the athlete has
    # told us are not real stops for them (they ride through). Applied before
    # scoring so the good-segment map reflects their correction, and mirrored
    # into references/known-roads.md by the design step.
    clr = arg("--clear")
    if clr:
        clrkm = [float(x) for x in clr.replace(" ", "").split(",") if x]
        keep = lambda k: all(abs(k - c) > 0.2 for c in clrkm)
        haz = [h for h in haz if keep(h["km"])]
        stops = [s for s in stops if keep(s["km"])]
        print(f"  cleared {len(clrkm)} athlete-override km: {clrkm}")

    # Layer 5 (optional — needs effort_db): where the athlete has SUSTAINED hard
    # efforts before. A positive corridor bonus in the composite.
    corridor = {}
    eff_cache = os.path.join(HERE, "..", "data", "cache", "effort_db.json")
    if os.path.exists(eff_cache) and "--no-effort" not in sys.argv:
        try:
            le = L2.score_effort(gpx, os.path.abspath(eff_cache))
            corridor = {r["km"]: r for r in le["per_km_effort"]}
        except Exception as e:  # noqa: BLE001
            print(f"  (layer 5 skipped: {e})")

    nkm = max(1, math.ceil(cum[-1] / 1000))
    # Composite effort score fuses geometry + history + severity-weighted
    # hazards + proven effort corridors; it drives colouring and block ranking.
    scores, cont, grad = compute_effort(l1, qual, haz, stops, nkm, corridor)
    QCODE = {"known-clear": "clear", "known-stop": "stop", "unknown": "new"}
    perkm = [{"km": k, "tier": score_tier(scores[k - 1]), "score": scores[k - 1],
              "cont": cont.get(k, 0), "ql": QCODE.get(qual.get(k, "unknown"), "new"),
              "corr": (corridor.get(k) or {}).get("avg_passes", 0),
              "eb": round(_eff_bonus(corridor.get(k)), 1)}
             for k in range(1, nkm + 1)]

    # Downsample route points so the embedded data stays small. An inline
    # show_widget with a very large single-line data blob gets truncated on
    # render (breaking the whole script), so cap the route to ~200 points by
    # default; --route-step overrides.
    rstep = int(arg("--route-step", "0"))
    if rstep <= 0:
        rstep = max(1, len(pts) // 200)
    route = [[round(pts[i][0], 5), round(pts[i][1], 5), round(cum[i] / 1000, 3)]
             for i in range(0, len(pts), rstep)]

    segs_arg = arg("--segs")
    if segs_arg and os.path.exists(segs_arg):
        segs = json.load(open(segs_arg, encoding="utf-8"))
    else:
        segs = default_segs(rkm)

    streets = []
    if "--streets" in sys.argv:
        streets = get_streets(pts, buffer_m=int(arg("--street-buffer", "220")),
                              max_points=int(arg("--street-max", "9000")),
                              use_cache="--no-street-cache" not in sys.argv)

    CATS = ["endurance", "tempo", "sweetspot", "threshold", "vo2max", "anaerobic", "sprint"]
    candidates = build_candidates(
        arg("--bank", os.path.join(HERE, "..", "data", "cache", "workout_bank.json")), rkm)
    blocks = placement_blocks(l1, scores, grad, nkm)
    data = {"route": route, "perkm": perkm, "haz": haz, "stops": stops, "segs": segs,
            "ftp": ftp, "route_km": rkm, "coverage": coverage, "title": title,
            "streets": streets,
            "category": arg("--category", ""), "categories": CATS,
            "candidates": candidates, "blocks": blocks}

    tpl = open(os.path.join(HERE, "..", "assets", "map_widget_template.html"), encoding="utf-8").read()
    body = tpl.replace("__DATA__", json.dumps(data))
    # Wrap the fragment in a full UTF-8 document. Opened standalone (file:// or
    # served), a bare fragment has no charset, so the browser mis-decodes the
    # em-dashes and marker glyphs (mojibake). The charset meta fixes that.
    safe_title = title.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    html = ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<title>{safe_title}</title></head><body>\n{body}\n</body></html>')
    out = os.path.abspath(out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    open(out, "w", encoding="utf-8").write(html)
    print(f"Wrote {out} ({len(html)} bytes) | {rkm} km | coverage {coverage}% | "
          f"{len(haz)} junctions | {len(stops)} stops | {len(segs)} segments | "
          f"{len(streets)} street ways")
    if "--open" in sys.argv:
        import webbrowser
        uri = "file:///" + out.replace("\\", "/")
        webbrowser.open(uri)
        print(f"opened in default browser: {uri}")


if __name__ == "__main__":
    if len([a for a in sys.argv[1:] if not a.startswith("--")]) < 1:
        raise SystemExit(__doc__)
    build()
