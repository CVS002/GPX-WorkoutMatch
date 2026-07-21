"""FastAPI app — the wizard backend.

Flow (strict order; the map is reviewed BEFORE any date):
  upload -> analysis + context -> objective menu -> design + map + adjust loop
  -> date + push. No LLM anywhere; intervals.icu via REST.
"""
import uuid
import traceback
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import config, engine, designer, mapdata, icu, jobs, rides

app = FastAPI(title="GPX Workout Designer")
# The map HTML is multi-MB of SVG/JSON and compresses ~10x — worth it even on
# localhost (the browser parses sooner).
app.add_middleware(GZipMiddleware, minimum_size=1024)


@app.middleware("http")
async def _no_store(request, call_next):
    """Local single-user app: never cache the UI assets or the map, so edits show
    up on a plain reload (no stale app.css/app.js/map from the browser cache)."""
    resp = await call_next(request)
    p = request.url.path
    if p == "/" or p.endswith((".css", ".js", ".html")):
        resp.headers["Cache-Control"] = "no-store, must-revalidate"
    return resp


# route_id -> session state (in-memory; single-user local app)
SESSIONS: dict[str, dict] = {}


def _sess(route_id: str) -> dict:
    s = SESSIONS.get(route_id)
    if not s:
        raise HTTPException(404, "unknown session — upload a GPX or start a no-route workout")
    import os
    if s.get("mode") != "blank" and not os.path.exists(s["gpx"]):
        raise HTTPException(410, "the uploaded route file is no longer available — "
                                 "please re-upload the GPX")
    return s


def _route_ctx(s: dict) -> dict:
    """Analysis layers for the session's route, cached per (cleared_km). Workout
    browsing and re-designs reuse it instead of re-parsing the GPX every click."""
    key = tuple(s["cleared_km"])
    c = s.get("_ctx")
    if not c or c["key"] != key:
        c = {"key": key, "ctx": designer.route_context(s["gpx"], s["haz"], s["cleared_km"])}
        s["_ctx"] = c
        s.pop("_mapdata", None)   # colours/markers change with cleared_km
    return c["ctx"]


def _mapdata(s: dict) -> dict:
    """Native-map JSON, cached per (cleared_km). Streets are the slow part and
    only change when the route does, so this is a near-instant read after the
    first build."""
    key = tuple(s["cleared_km"])
    md = s.get("_mapdata")
    if not md or md["key"] != key:
        md = {"key": key, "data": mapdata.build(s["gpx"], _route_ctx(s))}
        s["_mapdata"] = md
    return md["data"]


# ------------------------------------------------------------------ health ---
@app.get("/api/health")
def health():
    return {"missing_engine": config.missing_engine_bits(),
            "icu_configured": config.icu_configured(),
            # design constants the front-end must agree on (never hardcode there)
            "buffer_km": config.BUFFER_KM,
            "ref_speed_kmh": config.REF_SPEED_KMH}


# ----------------------------------------------------------------- upload ----
@app.post("/api/route")
async def upload_route(file: UploadFile = File(...)):
    if not file.filename.lower().endswith(".gpx"):
        raise HTTPException(400, "please upload a .gpx file")
    rid = uuid.uuid4().hex[:12]
    gpx_path = str(config.ROUTES_DIR / f"{rid}.gpx")
    with open(gpx_path, "wb") as f:
        f.write(await file.read())
    haz_path = str(config.ROUTES_DIR / f"{rid}_haz.json")
    try:
        l1 = engine.analyze_route(gpx_path)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"could not parse GPX: {e}")
    l2 = engine.score_roads(gpx_path)
    l3 = engine.enrich_osm(gpx_path, haz_path, priority=False)

    SESSIONS[rid] = {"gpx": gpx_path, "haz": haz_path, "l1": l1,
                     "cleared_km": [], "map_version": 0, "design": None,
                     "filename": file.filename}
    blocks = [f"km {b['start_km']}-{b['end_km']} ({b['length_km']}km, "
              f"{b.get('character','')}, cont {b['avg_continuity']})"
              for b in l1.get("effort_blocks", [])[:6]]
    return {
        "route_id": rid, "filename": file.filename,
        "distance_km": l1["distance_km"], "has_elevation": l1.get("has_elevation"),
        "elevation_gain_m": l1.get("elevation_gain_m"),
        "climbs": len(l1.get("climbs", [])),
        "effort_blocks": blocks,
        "coverage_pct": (l2 or {}).get("route_coverage_pct") if isinstance(l2, dict) else None,
        "stop_hotspots": [{"km": h["km"], "stop_rate": h.get("stop_rate")}
                          for h in (l2 or {}).get("stop_hotspots", [])] if isinstance(l2, dict) else [],
        "osm": {"available": l3.get("available"), "hazards": len(l3.get("hazards", [])),
                "source": l3.get("source")},
    }


# ---------------------------------------------------------------- context ----
@app.get("/api/context")
def context():
    if not config.icu_configured():
        return {"configured": False,
                "note": "Set ICU_API_KEY and ICU_ATHLETE_ID in .env to pull "
                        "recent load, form and FTP. You can still design by "
                        "entering FTP manually."}
    out = {"configured": True, "errors": []}
    # Three independent intervals.icu round-trips — run them concurrently so the
    # panel appears in one RTT instead of three.
    with ThreadPoolExecutor(max_workers=3) as ex:
        futs = {"activities": ex.submit(icu.recent_activities, 14),
                "fitness": ex.submit(icu.fitness),
                "sport settings": ex.submit(icu.sport_settings)}
    for name, fut in futs.items():
        try:
            res = fut.result()
            if name == "activities":
                out["load"] = engine.summarize_load(res, 14)
            elif name == "fitness":
                out["fitness"] = res
            else:
                out["sport"] = res
        except icu.IcuError as e:
            out["errors"].append(f"{name}: {e}")
    return out


# -------------------------------------------------------------- objectives ---
class ObjReq(BaseModel):
    route_id: str
    tsb: float | None = None
    phase: str = "build"
    last: str | None = None


@app.post("/api/objectives")
def objectives(req: ObjReq):
    s = _sess(req.route_id)
    rkm = s["l1"]["distance_km"]
    blocks = s["l1"].get("effort_blocks", [])
    chars = [b.get("character") for b in blocks]
    terrain = "flat" if (not chars or chars.count("flat") >= len(chars) / 2) else "rolling"
    tsb = req.tsb if req.tsb is not None else 0.0
    ranked = engine.rank_objectives(tsb, req.phase, req.last, terrain, rkm)
    return {"terrain": terrain, "tsb": tsb, **ranked}


# ------------------------------------------------------------------ design ---
class DesignReq(BaseModel):
    route_id: str
    objective: str
    ftp: int = 300


def _build_and_store(s: dict, rid: str, ftp: int, objective: str):
    d = designer.design(s["gpx"], objective, ftp, s["haz"],
                        cleared_km=s["cleared_km"], title=s.get("title"),
                        ctx=_route_ctx(s))
    s["design"] = d
    s["ftp"] = ftp
    s["objective"] = objective
    s["title"] = d["title"]
    return d


@app.post("/api/design")
def design_route(req: DesignReq):
    s = _sess(req.route_id)
    try:
        d = _build_and_store(s, req.route_id, req.ftp, req.objective)
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        raise HTTPException(500, f"design failed: {e}")
    return _design_public(d)


@app.get("/api/mapdata/{route_id}")
def get_mapdata(route_id: str):
    """The native map's data (route geometry, per-km tiers, hazards, stops,
    streets). Fetched by the front-end whenever a route design is shown; cached
    server-side so it's near-instant after the first call per route."""
    s = _sess(route_id)
    if s.get("mode") == "blank":
        raise HTTPException(400, "no route in this session")
    return _mapdata(s)


def _design_public(d: dict) -> dict:
    out = {k: d.get(k) for k in ("objective", "session_name", "session_plan", "title",
                                 "syntax", "segs", "written_km", "route_km", "ftp",
                                 "load_estimate", "if_estimate", "duration_min",
                                 "evidence", "issues", "reps_placed", "reps_requested")}
    out["mode"] = d.get("mode", "route")
    out["has_map"] = d.get("mode", "route") != "blank"
    out["total_min"] = d.get("total_min")
    # timeline data: elevation backdrop + stop/junction tick positions
    out["profile"] = d.get("profile")
    out["stops_km"] = [s["km"] for s in d.get("stops") or []]
    out["haz_km"] = [h["km"] for h in d.get("haz") or []
                     if h.get("t") != "right_before_left"]
    return out


# --------------------------------------------------- no-route workout --------
@app.post("/api/blank")
def blank_workout():
    """Start a structured workout with no GPX — time-based, editable in the table."""
    rid = uuid.uuid4().hex[:12]
    d = designer.design_blank("threshold", 300)
    SESSIONS[rid] = {"mode": "blank", "gpx": None, "haz": None,
                     "l1": {"distance_km": 60}, "cleared_km": [], "map_version": 0,
                     "design": d, "ftp": 300, "objective": d["objective"], "title": d["title"]}
    return {"route_id": rid, **_design_public(d)}


@app.post("/api/workouts")
def workouts(req: dict):
    s = _sess(req["route_id"])
    return {"workouts": engine.list_workouts(s["l1"]["distance_km"])}


class SelectReq(BaseModel):
    route_id: str
    category: str
    index: int
    ftp: int | None = None


@app.post("/api/select")
def select_workout(req: SelectReq):
    s = _sess(req.route_id)
    sess = engine.get_workout(s["l1"]["distance_km"], req.category, req.index)
    if not sess:
        raise HTTPException(404, "workout not found")
    ftp = req.ftp or s.get("ftp", 300)
    try:
        if s.get("mode") == "blank":
            d = designer.design_blank(req.category, ftp, session=sess)
        else:
            d = designer.design(s["gpx"], req.category, ftp, s["haz"],
                                cleared_km=s["cleared_km"], session=sess,
                                ctx=_route_ctx(s))
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        raise HTTPException(500, f"design failed: {e}")
    s["design"], s["ftp"], s["objective"], s["title"] = d, ftp, req.category, d["title"]
    return _design_public(d)


class TitleReq(BaseModel):
    route_id: str
    title: str


@app.post("/api/title")
def set_title(req: TitleReq):
    """Rename the workout before pushing."""
    s = _sess(req.route_id)
    t = req.title.strip()
    if not t:
        raise HTTPException(400, "title cannot be empty")
    s["title"] = t
    if s.get("design"):
        s["design"]["title"] = t
    return {"title": t}


class SegmentsReq(BaseModel):
    route_id: str
    segs: list[dict]


@app.post("/api/segments")
def set_segments(req: SegmentsReq):
    """Rebuild syntax/validation/load from segments edited natively in the app
    (nudge buttons / kind / pct / name / delete). The map isn't touched here —
    the front-end redraws its effort bands from the same segs client-side."""
    s = _sess(req.route_id)
    from . import syntax as SX
    d = s.get("design") or {}
    segs = req.segs
    ftp = s.get("ftp", 300)
    if s.get("mode") == "blank":
        txt = SX.to_syntax(segs, unit="min")
        issues = SX.validate_blank(segs, s.get("objective", ""))
        load = designer._estimate_load(segs, ftp, unit="min")
        d = {**d, "segs": segs, "syntax": txt, "issues": issues, "written_km": None,
             "total_min": round(segs[-1]["b"] - segs[0]["a"], 1) if segs else 0,
             "load_estimate": load["tss"], "if_estimate": load["if"], "duration_min": load["minutes"]}
        s["design"] = d
        return _design_public(d)
    rkm = s["l1"]["distance_km"]
    txt = SX.to_syntax(segs)
    issues = SX.validate(segs, rkm, s.get("objective", ""), d.get("stops", []), d.get("haz", []))
    load = designer._estimate_load(segs, ftp)
    d = {**d, "segs": segs, "syntax": txt, "issues": issues,
         "written_km": SX.total_written_km(segs), "load_estimate": load["tss"],
         "if_estimate": load["if"], "duration_min": load["minutes"]}
    s["design"] = d
    return _design_public(d)


# ------------------------------------------------- past-ride speed overlay ---
class RideMatchReq(BaseModel):
    route_id: str


@app.post("/api/rides/matches")
def ride_matches(req: RideMatchReq):
    """Past rides (local history) that were mostly on this route."""
    s = _sess(req.route_id)
    if s.get("mode") == "blank":
        raise HTTPException(400, "no route in this session")
    return {"matches": rides.matches(s["gpx"])}


class RideTrackReq(BaseModel):
    route_id: str
    file: str


@app.post("/api/rides/track")
def ride_track(req: RideTrackReq):
    """Speed track of one matched ride, for the map overlay."""
    _sess(req.route_id)
    try:
        return rides.track(req.file)
    except FileNotFoundError:
        raise HTTPException(404, "ride file not found — refresh ride history in Maintenance")


class RideFastReq(BaseModel):
    route_id: str
    threshold: float = 33.0


@app.post("/api/rides/fast")
def ride_fast(req: RideFastReq):
    """Fastest speed ever ridden at each stretch of the route, aggregated across
    all overlapping history rides, plus the segments clearing the threshold."""
    s = _sess(req.route_id)
    if s.get("mode") == "blank":
        raise HTTPException(400, "no route in this session")
    return rides.fast_overview(s["gpx"], threshold_kmh=req.threshold)


class RidePowerReq(BaseModel):
    route_id: str
    threshold: float = 200.0


@app.post("/api/rides/power")
def ride_power(req: RidePowerReq):
    """Best average power sustained over each stretch of the route, across the
    overlapping rides that recorded power, plus the segments clearing the
    threshold (watts). n_rides = 0 means no stored ride here has power yet —
    refresh ride history so the GPX includes it."""
    s = _sess(req.route_id)
    if s.get("mode") == "blank":
        raise HTTPException(400, "no route in this session")
    return rides.power_overview(s["gpx"], threshold_w=req.threshold)


# ------------------------------------------------- road corrections (veto) ---
class VetoReq(BaseModel):
    route_id: str
    km: float
    persist: bool = False


@app.post("/api/veto")
def veto(req: VetoReq):
    """'I ride through this' from a hazard/stop popover on the map: drop the km
    from scoring so it stops penalising the route, optionally remember it in the
    dossier, and re-design. The front-end refetches /api/mapdata (cleared_km
    changed → colours + markers update)."""
    s = _sess(req.route_id)
    if s.get("mode") == "blank":
        raise HTTPException(400, "no route in this session")
    km = round(float(req.km), 2)
    s["cleared_km"] = sorted(set(s["cleared_km"]) | {km})
    if req.persist:
        jobs.append_known_roads([{"km": km}])
    d = _build_and_store(s, req.route_id, s.get("ftp", 300), s.get("objective", "endurance"))
    return {"cleared_km": s["cleared_km"], "persisted": req.persist, **_design_public(d)}


# -------------------------------------------------------------------- push ---
class PushReq(BaseModel):
    route_id: str
    date: str  # YYYY-MM-DD


@app.post("/api/push")
def push(req: PushReq):
    s = _sess(req.route_id)
    d = s.get("design")
    if not d:
        raise HTTPException(400, "design first")
    errors = [i for i in d["issues"] if i["level"] == "error"]
    if errors:
        raise HTTPException(400, {"msg": "design has blocking issues", "errors": errors})
    if not config.icu_configured():
        raise HTTPException(400, "intervals.icu not configured (.env) — cannot push")
    conflicts = []
    try:
        for e in icu.events(req.date, 2):
            conflicts.append({"date": e.get("start_date_local", "")[:10],
                              "name": e.get("name"), "category": e.get("category")})
    except icu.IcuError:
        pass
    try:
        dist_m = (d.get("route_km") or 0) * 1000 or None   # None for no-route workouts
        created = icu.create_workout(req.date, d["title"], d["syntax"],
                                     distance_meters=dist_m,
                                     duration_seconds=d["duration_min"] * 60)
    except icu.IcuError as e:
        raise HTTPException(502, f"create failed: {e}")
    verify = {}
    ev_id = created.get("id")
    if ev_id:
        try:
            ev = icu.get_event(ev_id)
            verify = {"id": ev_id,
                      "parsed_load": ev.get("icu_training_load") or ev.get("training_load"),
                      "parsed_if": ev.get("icu_intensity") or ev.get("intensity_factor")}
        except icu.IcuError:
            verify = {"id": ev_id, "note": "created but could not fetch back"}
    return {"created": True, "event": verify, "estimated_load": d["load_estimate"],
            "conflicts": conflicts, "date": req.date, "title": d["title"]}


# ------------------------------------------------------------ maintenance ----
class JobReq(BaseModel):
    kind: str


@app.get("/api/maint/jobs")
def maint_jobs():
    return {"jobs": jobs.status()}


@app.post("/api/maint/run")
def maint_run(req: JobReq):
    try:
        jid = jobs.start(req.kind)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"job_id": jid}


@app.post("/api/maint/history")
def maint_history():
    if not config.icu_configured():
        raise HTTPException(400, "intervals.icu not configured (.env)")
    return {"job_id": jobs.start_history_refresh()}


# --------------------------------------------------------------- static UI ---
@app.get("/")
def index():
    return FileResponse(str(config.APP_ROOT / "web" / "index.html"))


app.mount("/", StaticFiles(directory=str(config.APP_ROOT / "web")), name="web")


@app.exception_handler(Exception)
def _unhandled(_req, exc):
    traceback.print_exc()
    return JSONResponse(status_code=500, content={"detail": str(exc)})
