#!/usr/bin/env python3
"""Run the ORIGINAL Python app through the full wizard scenario and record
every request + response, the caches it builds and a few unit outputs.

    python test/parity/oracle.py <fixtures_dir> <work_dir> <icu_port> <overpass_port>

The TypeScript side (test/run.ts) replays the recorded requests against the
Netlify port and diffs the responses. Route ids are recorded as tokens ($R1…)
so each side substitutes its own.
"""
import json
import os
import re
import shutil
import sys
import time

FIX, WORK = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
ICU_PORT, OVP_PORT = sys.argv[3], sys.argv[4]
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OVP = f"http://127.0.0.1:{OVP_PORT}/api/interpreter"

# --- an engine copy wired to the mock Overpass, with empty caches -----------
shutil.rmtree(WORK, ignore_errors=True)
eng = os.path.join(WORK, "engine")
shutil.copytree(os.path.join(REPO, "engine"), eng,
                ignore=shutil.ignore_patterns("history", "__pycache__", "road_db.json", "effort_db.json",
                                              "osm_*.json", "ride_index.json"))
for f, old, new in [
    ("osm_enrich.py", '"https://overpass-api.de/api/interpreter",\n    "https://overpass.kumi.systems/api/interpreter",',
     f'"{OVP}",\n    "{OVP}",'),
    ("build_map_widget.py", '"https://overpass-api.de/api/interpreter"', f'"{OVP}"'),
]:
    p = os.path.join(eng, "scripts", f)
    s = open(p).read()
    assert old in s, (f, old)
    open(p, "w").write(s.replace(old, new))

os.environ.update({
    "ENGINE_ROOT": eng, "APP_DATA": os.path.join(WORK, "appdata"),
    "ICU_BASE": f"http://127.0.0.1:{ICU_PORT}", "ICU_API_KEY": "testkey", "ICU_ATHLETE_ID": "i0",
})
os.environ.pop("APP_PASSWORD", None)
for k in ("HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "ALL_PROXY", "all_proxy"):
    os.environ.pop(k, None)
os.environ["NO_PROXY"] = "127.0.0.1,localhost"
sys.path.insert(0, REPO)

from fastapi.testclient import TestClient  # noqa: E402
from server import main as M  # noqa: E402

client = TestClient(M.app, raise_server_exceptions=False)
steps = []
rid_tok = {}


def tok(obj):
    s = json.dumps(obj)
    for rid, t in rid_tok.items():
        s = s.replace(rid, t)
    return json.loads(s)


def jsish(x):
    """Encode like a browser's JSON.stringify: whole-number floats become ints."""
    if isinstance(x, float) and x.is_integer():
        return int(x)
    if isinstance(x, list):
        return [jsish(v) for v in x]
    if isinstance(x, dict):
        return {k: jsish(v) for k, v in x.items()}
    return x


def call(label, method, path, body=None, upload=None):
    body = jsish(body) if body is not None else None
    if upload:
        name, content = upload
        r = client.post(path, files={"file": (name, content, "application/gpx+xml")})
    elif method == "GET":
        r = client.get(path)
    else:
        r = client.post(path, json=body) if body is not None else client.post(path)
    try:
        data = r.json()
    except Exception:  # noqa: BLE001
        data = {"_text": r.text}
    if isinstance(data, dict) and isinstance(data.get("route_id"), str) and data["route_id"] not in rid_tok:
        rid_tok[data["route_id"]] = f"$R{len(rid_tok) + 1}"
    steps.append({"label": label, "method": method, "path": tok(path), "body": tok(body) if body is not None else None,
                  "upload": upload[0] if upload else None, "status": r.status_code, "resp": tok(data)})
    return r.status_code, data


def wait_jobs(label):
    t0 = time.time()
    while time.time() - t0 < 900:
        _, j = call(f"{label}: poll", "GET", "/api/maint/jobs")
        steps.pop()                                    # polls aren't compared, only the final state
        if j["jobs"] and all(x["status"] != "running" for x in j["jobs"]):
            break
        time.sleep(0.3)
    call(f"{label}: final", "GET", "/api/maint/jobs")


def nudge(segs, i, d):
    out = [dict(s) for s in segs]
    out[i]["a"] = round(out[i]["a"] + d, 1)
    out[i]["b"] = round(out[i]["b"] + d, 1)
    if i > 0:
        out[i - 1]["b"] = out[i]["a"]
    if i + 1 < len(out):
        out[i + 1]["a"] = out[i]["b"]
    return out


def edits(rid, segs, tag):
    """Client-side edits the UI makes, posted to /api/segments."""
    work = [i for i, s in enumerate(segs) if s["kind"] in ("work", "tt")]
    variants = [("as-is", [dict(s) for s in segs])]
    if work:
        variants.append(("nudge+", nudge(segs, work[0], 0.5)))
        variants.append(("nudge-", nudge(segs, work[-1], -1.0)))
        v = [dict(s) for s in segs]
        v[work[0]]["pct"] = "130-135"
        v[work[0]]["kind"] = "tt"
        variants.append(("pct+kind", v))
    v = [dict(s) for s in segs]
    if len(v) > 2:
        v[0]["b"] = v[1]["b"]
        del v[1]
    variants.append(("delete", v))
    v = [dict(s) for s in segs]
    v[0]["a"] = 1
    v[-1]["b"] = int(v[-1]["b"]) + 3
    v[-1]["name"] = ""
    v[-1]["pct"] = "abc"
    v[0]["buf"] = True
    if len(v) > 1:
        v[1]["buf"] = True
        v[1]["kind"] = "work"
    variants.append(("junk", v))
    for name, sg in variants:
        call(f"{tag} segments {name}", "POST", "/api/segments", {"route_id": rid, "segs": sg})


def scenario(phase):
    call(f"{phase} health", "GET", "/api/health")
    rids = []
    for name in ["loop62.gpx", "komoot36.gpx", "away21.gpx", "tiny.gpx", "prefixed12.gpx", "broken.gpx"]:
        content = open(os.path.join(FIX, "routes", name), "rb").read()
        st, d = call(f"{phase} upload {name}", "POST", "/api/route", upload=(name, content))
        if st == 200:
            rids.append((name, d["route_id"]))
    call(f"{phase} upload notgpx", "POST", "/api/route", upload=("route.txt", b"<gpx></gpx>"))

    for n, (name, rid) in enumerate(rids):
        tag = f"{phase} {name}"
        for tsb, ph, last in [(None, "build", None), (-25, "base", None), (-12, "build", "threshold"), (3, "peak", "vo2max"),
                              (9.6, "base", None), (12, "taper", "sprint"), (-3, "recovery", None), (0, "weird", "endurance")]:
            call(f"{tag} objectives {tsb}/{ph}/{last}", "POST", "/api/objectives",
                 {"route_id": rid, "tsb": tsb, "phase": ph, "last": last})
        _, wl = call(f"{tag} workouts", "POST", "/api/workouts", {"route_id": rid})
        _, md = call(f"{tag} mapdata", "GET", f"/api/mapdata/{rid}")
        ws = wl.get("workouts", [])
        pick = ws if n == 0 else ws[:: max(1, len(ws) // 8)]
        last_design = None
        for w in pick:
            st, d = call(f"{tag} select {w['id']}", "POST", "/api/select",
                         {"route_id": rid, "category": w["category"], "index": w["index"], "ftp": 300 if w["index"] % 2 else 255})
            if st == 200:
                last_design = d
                if w["index"] == 1 and w["category"] in ("threshold", "vo2max", "endurance", "anaerobic"):
                    edits(rid, d["segs"], f"{tag} {w['id']}")
        for obj in ["vo2max", "threshold", "sweetspot", "tempo", "anaerobic", "sprint", "endurance", "made_up"]:
            call(f"{tag} design {obj}", "POST", "/api/design", {"route_id": rid, "objective": obj, "ftp": 280})
        call(f"{tag} select bad index", "POST", "/api/select", {"route_id": rid, "category": "threshold", "index": 999})
        call(f"{tag} title", "POST", "/api/title", {"route_id": rid, "title": "  My route workout  "})
        call(f"{tag} title empty", "POST", "/api/title", {"route_id": rid, "title": "   "})
        _, mt = call(f"{tag} rides/matches", "POST", "/api/rides/matches", {"route_id": rid})
        for m in (mt.get("matches") or [])[:2]:
            call(f"{tag} rides/track {m['file']}", "POST", "/api/rides/track", {"route_id": rid, "file": m["file"]})
        call(f"{tag} rides/track missing", "POST", "/api/rides/track", {"route_id": rid, "file": "../etc/passwd"})
        for th in (33.0, 29.5):
            call(f"{tag} rides/fast {th}", "POST", "/api/rides/fast", {"route_id": rid, "threshold": th})
        for th in (200.0, 265.0):
            call(f"{tag} rides/power {th}", "POST", "/api/rides/power", {"route_id": rid, "threshold": th})
        hz = (md.get("haz") or []) + (md.get("stops") or [])
        for k, h in enumerate(hz[:2]):
            call(f"{tag} veto {k}", "POST", "/api/veto", {"route_id": rid, "km": h["km"], "persist": n == 0 and k == 0})
        call(f"{tag} mapdata after veto", "GET", f"/api/mapdata/{rid}")
        call(f"{tag} push", "POST", "/api/push", {"route_id": rid, "date": "2026-10-28"})

    st, d = call(f"{phase} blank", "POST", "/api/blank")
    brid = d["route_id"]
    call(f"{phase} blank mapdata", "GET", f"/api/mapdata/{brid}")
    call(f"{phase} blank matches", "POST", "/api/rides/matches", {"route_id": brid})
    _, wl = call(f"{phase} blank workouts", "POST", "/api/workouts", {"route_id": brid})
    for w in wl["workouts"][::3]:
        st, dd = call(f"{phase} blank select {w['id']}", "POST", "/api/select",
                      {"route_id": brid, "category": w["category"], "index": w["index"]})
        if st == 200 and w["index"] == 0:
            edits(brid, dd["segs"], f"{phase} blank {w['id']}")
    call(f"{phase} blank push", "POST", "/api/push", {"route_id": brid, "date": "2026-10-30"})
    call(f"{phase} context", "GET", "/api/context")
    call(f"{phase} unknown session", "POST", "/api/objectives", {"route_id": "nope"})
    call(f"{phase} missing field", "POST", "/api/select", {"route_id": brid})


scenario("A")
call("job unknown", "POST", "/api/maint/run", {"kind": "nope"})
call("job history", "POST", "/api/maint/history")
wait_jobs("job history")
for kind in ("osm_hazards", "streets", "road_db", "effort_db"):
    call(f"job {kind}", "POST", "/api/maint/run", {"kind": kind})
    wait_jobs(f"job {kind}")
scenario("B")

# --- caches + units ----------------------------------------------------------
cache = os.path.join(eng, "data", "cache")
caches = {}
for f in ("road_db.json", "effort_db.json", "osm_hazards.json", "osm_streets.json"):
    p = os.path.join(cache, f)
    caches[f] = json.load(open(p)) if os.path.exists(p) else None
ri = os.path.join(WORK, "appdata", "ride_index.json")
caches["ride_index.json"] = json.load(open(ri)) if os.path.exists(ri) else None
known = open(os.path.join(eng, "references", "known-roads.md")).read()
orig = open(os.path.join(REPO, "engine", "references", "known-roads.md")).read()
caches["known-roads-corrections.md"] = known[len(orig):]

sys.path.insert(0, os.path.join(eng, "scripts"))
import build_osm_cache as BOC  # noqa: E402
import build_workout_bank as BWB  # noqa: E402
import suggest_workout as SUG  # noqa: E402

units = {"zwo": [], "select": [], "home": []}
for z in json.load(open(os.path.join(FIX, "zwo.json"))):
    p = BWB.parse_zwo(z)
    units["zwo"].append(None if not p else {"name": p[0], "bouts": p[1], "total": p[2],
                                            "cat": BWB.classify(p[1]), "summary": BWB.summarize(p[1])})
for tsb in (-30, -20, -15, -10.5, -5, 0, 4.6, 5, 5.4, 7, 20):
    for ph in ("base", "build", "peak", "taper", "recovery", "foo", None):
        for last in (None, "threshold", "endurance", "vo2max"):
            for terrain in (None, "flat", "rolling", "climbs", "urban", "x"):
                units["select"].append({"in": [tsb, ph, last, terrain], "out": list(SUG.select_category(tsb, ph, last, terrain))})
for r in (60, 40, 5):
    try:
        units["home"].append({"r": r, "out": list(BOC.home_bbox(os.path.join(cache, "road_db.json"), r))})
    except BaseException as e:  # noqa: BLE001
        units["home"].append({"r": r, "error": type(e).__name__})

hist = os.path.join(eng, "data", "history")
json.dump({"steps": steps, "caches": caches, "units": units, "history_dir": hist,
           "rides_pushed": None}, open(os.path.join(WORK, "py_out.json"), "w"))
print(f"oracle: {len(steps)} steps recorded, history files: {len(os.listdir(hist)) if os.path.isdir(hist) else 0}")
