/**
 * The wizard backend (main.py): upload → analysis + context → objective menu →
 * design + map + adjust loop → date + push. Same routes, request and response
 * shapes as the FastAPI app; sessions live in Blobs instead of a process dict.
 *
 * Per route id the "routes" store holds:
 *   <rid>/session  mutable wizard state (design, ftp, title, cleared km)
 *   <rid>/pts      parsed route points        <rid>/haz  saved Layer 3 result
 *   <rid>/ctx      analysis cache per cleared km   <rid>/map  map payload cache
 *   <rid>/cap      learned capability (ride-history scan), computed once
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { parseGpxPoints, type RoutePt } from "../lib/gpx.js";
import { pyRound } from "../lib/py.js";
import { analyze, type L1 } from "../engine/analyze.js";
import type { L3 } from "../engine/osm.js";
import { cfg, icuConfigured } from "./config.js";
import * as designer from "./designer.js";
import * as engine from "./engine.js";
import * as icu from "./icu.js";
import * as jobs from "./jobs.js";
import * as mapdata from "./mapdata.js";
import * as rides from "./rides.js";
import { getJSON, kv, setJSON } from "./store.js";
import * as SX from "./syntax.js";

export class HttpError extends Error {
  constructor(public status: number, public detail: unknown) {
    super(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

interface Session {
  mode?: "blank" | "route";
  filename?: string;
  cleared_km: number[];
  map_version: number;
  design: designer.Design | null;
  ftp?: number;
  objective?: string;
  title?: string;
  l1: L1 | { distance_km: number; effort_blocks?: never[] };
}

const ROUTE_TTL_MS = 14 * 24 * 3600 * 1000;

function newRouteId(): string {
  const t = Date.now().toString(36).padStart(8, "0");
  return (t + crypto.randomUUID().replace(/-/g, "")).slice(0, 12);
}

async function sess(rid: string): Promise<Session> {
  const s = await getJSON<Session>("routes", `${rid}/session`);
  if (!s) throw new HttpError(404, "unknown session — upload a GPX or start a no-route workout");
  return s;
}
const saveSess = (rid: string, s: Session) => setJSON("routes", `${rid}/session`, s);

async function routePts(rid: string): Promise<RoutePt[]> {
  const p = await getJSON<RoutePt[]>("routes", `${rid}/pts`);
  if (!p) throw new HttpError(410, "the uploaded route file is no longer available — please re-upload the GPX");
  return p;
}

const ctxKey = (s: Session) => JSON.stringify(s.cleared_km);

/** Analysis layers for the route, cached per cleared_km (designer.route_context). */
async function routeCtx(rid: string, s: Session, pts: RoutePt[]): Promise<designer.RouteCtx> {
  const key = ctxKey(s);
  const c = await getJSON<{ key: string; ctx: designer.RouteCtx }>("routes", `${rid}/ctx`);
  if (c && c.key === key) return c.ctx;
  const l3 = await getJSON<L3>("routes", `${rid}/haz`);
  const ctx = await designer.routeContext(pts, l3, s.cleared_km);
  await setJSON("routes", `${rid}/ctx`, { key, ctx });
  await kv("routes").delete(`${rid}/map`);          // colours/markers change with cleared_km
  return ctx;
}

/** Learned capability, scanned once per route (the Python memoised it per GPX). */
function capFor(rid: string, pts: RoutePt[]) {
  return async () => {
    const c = await getJSON<designer.Capability>("routes", `${rid}/cap`);
    if (c) return c;
    const cap = await designer.capability(pts);
    await setJSON("routes", `${rid}/cap`, cap);
    return cap;
  };
}

function designPublic(d: designer.Design) {
  const keys = ["objective", "session_name", "session_plan", "title", "syntax", "segs", "written_km", "route_km", "ftp",
                "load_estimate", "if_estimate", "duration_min", "evidence", "issues", "reps_placed", "reps_requested"];
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = d[k] ?? null;
  const mode = (d.mode as string | undefined) ?? "route";
  out.mode = mode;
  out.has_map = mode !== "blank";
  out.total_min = d.total_min ?? null;
  out.profile = d.profile ?? null;
  out.stops_km = ((d.stops as { km: number }[] | undefined) || []).map((x) => x.km);
  out.haz_km = ((d.haz as { km: number; t?: string }[] | undefined) || []).filter((h) => h.t !== "right_before_left").map((h) => h.km);
  return out;
}

async function buildAndStore(rid: string, s: Session, ftp: number, objective: string) {
  const pts = await routePts(rid);
  const ctx = await routeCtx(rid, s, pts);
  const d = await designer.design(ctx, objective, ftp, capFor(rid, pts), { title: s.title ?? null });
  s.design = d;
  s.ftp = ftp;
  s.objective = objective;
  s.title = d.title;
  return d;
}

// ------------------------------------------------------------ validation ---
type Body = Record<string, unknown>;

type Kind = "str" | "int" | "float" | "bool" | "list";
type Spec = Record<string, [Kind, { optional?: boolean; dflt?: unknown }?]>;

/** pydantic-style model parse: coerces, applies defaults, reports every bad field (422). */
function model(b: Body, spec: Spec): Record<string, any> {
  const out: Record<string, any> = {};
  const errs: Record<string, unknown>[] = [];
  for (const [name, [kind, opts = {}]] of Object.entries(spec)) {
    const v = b[name];
    if (v === undefined) {
      if (opts.optional || "dflt" in opts) out[name] = opts.dflt ?? null;
      else errs.push({ type: "missing", loc: ["body", name], msg: "Field required", input: b });
      continue;
    }
    if (v === null && opts.optional) {
      out[name] = null;
      continue;
    }
    const bad = (t: string, label: string) => errs.push({ type: `${t}_type`, loc: ["body", name], msg: `Input should be a valid ${label}`, input: v });
    switch (kind) {
      case "str":
        if (typeof v === "string") out[name] = v;
        else bad("string", "string");
        break;
      case "int": {
        const n = typeof v === "string" && /^\s*[+-]?\d+\s*$/.test(v) ? Number(v) : v;
        if (typeof n === "number" && Number.isInteger(n)) out[name] = n;
        else bad("int", "integer");
        break;
      }
      case "float": {
        const n = typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)) ? Number(v) : v;
        if (typeof n === "number" && !Number.isNaN(n)) out[name] = n;
        else bad("float", "number");
        break;
      }
      case "bool":
        if (typeof v === "boolean") out[name] = v;
        else bad("bool", "boolean");
        break;
      case "list":
        if (Array.isArray(v)) out[name] = v;
        else bad("list", "list");
        break;
    }
  }
  if (errs.length) throw new HttpError(422, errs);
  return out;
}

async function readJSON(req: Request): Promise<Body> {
  try {
    const b = await req.json();
    if (b && typeof b === "object" && !Array.isArray(b)) return b as Body;
  } catch {
    /* fall through */
  }
  throw new HttpError(422, [{ type: "json_invalid", loc: ["body"], msg: "JSON decode error" }]);
}

// ------------------------------------------------------------- handlers ---

async function uploadRoute(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new HttpError(422, [{ type: "missing", loc: ["body", "file"], msg: "Field required" }]);
  }
  const file = form.get("file");
  if (!file || typeof file === "string") throw new HttpError(422, [{ type: "missing", loc: ["body", "file"], msg: "Field required" }]);
  const filename = (file as File).name || "";
  if (!filename.toLowerCase().endsWith(".gpx")) throw new HttpError(400, "please upload a .gpx file");
  let pts: RoutePt[];
  let l1: L1;
  try {
    pts = parseGpxPoints(await (file as File).text());
    l1 = analyze(pts);
  } catch (e) {
    throw new HttpError(400, `could not parse GPX: ${e instanceof Error ? e.message : String(e)}`);
  }
  const rid = newRouteId();
  const [l2, l3] = await Promise.all([engine.scoreRoads(pts), engine.enrichOsm(pts)]);
  await Promise.all([
    setJSON("routes", `${rid}/pts`, pts),
    setJSON("routes", `${rid}/haz`, l3),
    saveSess(rid, { cleared_km: [], map_version: 0, design: null, filename, l1 }),
  ]);
  await pruneRoutes(rid);
  const blocks = (l1.effort_blocks || []).slice(0, 6).map((b) =>
    `km ${b.start_km}-${b.end_km} (${b.length_km}km, ${b.character ?? ""}, cont ${b.avg_continuity})`);
  const l2d = l2 && typeof l2 === "object" ? l2 : null;
  return {
    route_id: rid, filename, distance_km: l1.distance_km, has_elevation: l1.has_elevation,
    elevation_gain_m: l1.elevation_gain_m ?? null, climbs: (l1.climbs || []).length, effort_blocks: blocks,
    coverage_pct: l2d && "route_coverage_pct" in l2d ? l2d.route_coverage_pct : null,
    stop_hotspots: l2d && "stop_hotspots" in l2d ? l2d.stop_hotspots.map((h) => ({ km: h.km, stop_rate: h.stop_rate ?? null })) : [],
    osm: { available: l3.available ?? null, hazards: (l3.hazards || []).length, source: l3.source ?? null },
  };
}

/** Drop routes older than two weeks (the Python lost sessions on restart). */
async function pruneRoutes(keep: string) {
  const cutoff = Date.now() - ROUTE_TTL_MS;
  const keys = (await kv("routes").list()).map((b) => b.key);
  const old = keys.filter((k) => {
    const rid = k.split("/")[0];
    const t = parseInt(rid.slice(0, 8), 36);
    return rid !== keep && Number.isFinite(t) && t < cutoff;
  });
  await rides.mapLimit(old, 8, (k) => kv("routes").delete(k));
}

async function context() {
  if (!icuConfigured()) {
    return { configured: false, note: "Set ICU_API_KEY and ICU_ATHLETE_ID in the Netlify site's environment variables to pull "
      + "recent load, form and FTP. You can still design by entering FTP manually." };
  }
  const out: Record<string, unknown> = { configured: true, errors: [] as string[] };
  const [acts, fit, sport] = await Promise.allSettled([icu.recentActivities(14), icu.fitness(), icu.sportSettings()]);
  const names = ["activities", "fitness", "sport settings"];
  [acts, fit, sport].forEach((r, i) => {
    if (r.status === "fulfilled") {
      if (i === 0) out.load = engine.summarizeLoad(r.value as Record<string, unknown>[], 14);
      else if (i === 1) out.fitness = r.value;
      else out.sport = r.value;
    } else if (r.reason instanceof icu.IcuError) {
      (out.errors as string[]).push(`${names[i]}: ${r.reason.message}`);
    } else {
      throw r.reason;
    }
  });
  return out;
}

async function objectives(b: Body) {
  const { route_id: rid, tsb: tsbIn, phase, last } = model(b, {
    route_id: ["str"], tsb: ["float", { optional: true }], phase: ["str", { dflt: "build" }], last: ["str", { optional: true }],
  });
  const s = await sess(rid);
  const rkm = s.l1.distance_km;
  const chars = ((s.l1 as L1).effort_blocks || []).map((x) => x.character);
  const terrain = !chars.length || chars.filter((c) => c === "flat").length >= chars.length / 2 ? "flat" : "rolling";
  const tsb = tsbIn !== null ? tsbIn : 0.0;
  const ranked = await engine.rankObjectives(tsb, phase, last, terrain, rkm);
  return { terrain, tsb, ...ranked };
}

async function designRoute(b: Body) {
  const { route_id: rid, objective, ftp } = model(b, { route_id: ["str"], objective: ["str"], ftp: ["int", { dflt: 300 }] });
  const s = await sess(rid);
  let d: designer.Design;
  try {
    d = await buildAndStore(rid, s, ftp, objective);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(500, `design failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  await saveSess(rid, s);
  return designPublic(d);
}

async function getMapdata(rid: string) {
  const s = await sess(rid);
  if (s.mode === "blank") throw new HttpError(400, "no route in this session");
  const key = ctxKey(s);
  const cached = await getJSON<{ key: string; data: unknown }>("routes", `${rid}/map`);
  if (cached && cached.key === key) return cached.data;
  const pts = await routePts(rid);
  const data = await mapdata.build(pts, await routeCtx(rid, s, pts));
  await setJSON("routes", `${rid}/map`, { key, data });
  return data;
}

async function blank() {
  const rid = newRouteId();
  const d = designer.designBlank("threshold", 300);
  await saveSess(rid, { mode: "blank", cleared_km: [], map_version: 0, l1: { distance_km: 60 }, design: d, ftp: 300,
                        objective: d.objective, title: d.title });
  return { route_id: rid, ...designPublic(d) };
}

async function workouts(b: Body) {
  if (!("route_id" in b)) throw new HttpError(500, "'route_id'");
  const s = await sess(String(b.route_id));
  return { workouts: await engine.listWorkouts(s.l1.distance_km) };
}

async function select(b: Body) {
  const { route_id: rid, category, index, ftp: ftpIn } = model(b, {
    route_id: ["str"], category: ["str"], index: ["int"], ftp: ["int", { optional: true }],
  });
  const s = await sess(rid);
  const w = await engine.getWorkout(s.l1.distance_km, category, index);
  if (!w) throw new HttpError(404, "workout not found");
  const ftp = ftpIn || s.ftp || 300;
  let d: designer.Design;
  try {
    if (s.mode === "blank") {
      d = designer.designBlank(category, ftp, w);
    } else {
      const pts = await routePts(rid);
      d = await designer.design(await routeCtx(rid, s, pts), category, ftp, capFor(rid, pts), { session: w });
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(500, `design failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  Object.assign(s, { design: d, ftp, objective: category, title: d.title });
  await saveSess(rid, s);
  return designPublic(d);
}

async function setTitle(b: Body) {
  const { route_id: rid, title } = model(b, { route_id: ["str"], title: ["str"] });
  const t = (title as string).trim();
  const s = await sess(rid);
  if (!t) throw new HttpError(400, "title cannot be empty");
  s.title = t;
  if (s.design) s.design.title = t;
  await saveSess(rid, s);
  return { title: t };
}

async function setSegments(b: Body) {
  const { route_id: rid, segs } = model(b, { route_id: ["str"], segs: ["list"] }) as { route_id: string; segs: SX.Seg[] };
  const s = await sess(rid);
  let d = (s.design || {}) as designer.Design;
  const ftp = s.ftp ?? 300;
  if (s.mode === "blank") {
    const load = designer.estimateLoad(segs, ftp, "min");
    d = { ...d, segs, syntax: SX.toSyntax(segs, "min"), issues: SX.validateBlank(segs, s.objective ?? ""), written_km: null,
          total_min: segs.length ? pyRound(segs[segs.length - 1].b - segs[0].a, 1) : 0,
          load_estimate: load.tss, if_estimate: load.if, duration_min: load.minutes };
  } else {
    const rkm = s.l1.distance_km;
    const issues = SX.validate(segs, rkm, s.objective ?? "", (d.stops as { km: number }[]) || [],
                               (d.haz as { km: number; t: string }[]) || [], SX.CLIENT_NUM);
    const load = designer.estimateLoad(segs, ftp);
    d = { ...d, segs, syntax: SX.toSyntax(segs), issues, written_km: SX.totalWrittenKm(segs, true),
          load_estimate: load.tss, if_estimate: load.if, duration_min: load.minutes };
  }
  s.design = d;
  await saveSess(rid, s);
  return designPublic(d);
}

async function routeOnly(b: Body): Promise<[string, Session]> {
  const { route_id: rid } = model(b, { route_id: ["str"] });
  const s = await sess(rid);
  if (s.mode === "blank") throw new HttpError(400, "no route in this session");
  return [rid, s];
}

async function veto(b: Body) {
  const { route_id: rid, km: km0, persist } = model(b, { route_id: ["str"], km: ["float"], persist: ["bool", { dflt: false }] });
  const s = await sess(rid);
  if (s.mode === "blank") throw new HttpError(400, "no route in this session");
  const km = pyRound(km0, 2);
  s.cleared_km = [...new Set([...s.cleared_km, km])].sort((x, y) => x - y);
  if (persist) await jobs.appendKnownRoads([{ km }]);
  const d = await buildAndStore(rid, s, s.ftp ?? 300, s.objective ?? "endurance");
  await saveSess(rid, s);
  return { cleared_km: s.cleared_km, persisted: persist, ...designPublic(d) };
}

async function push(b: Body) {
  const { route_id: rid, date } = model(b, { route_id: ["str"], date: ["str"] });
  const s = await sess(rid);
  const d = s.design;
  if (!d) throw new HttpError(400, "design first");
  const errors = d.issues.filter((i) => i.level === "error");
  if (errors.length) throw new HttpError(400, { msg: "design has blocking issues", errors });
  if (!icuConfigured()) throw new HttpError(400, "intervals.icu not configured (site environment variables) — cannot push");
  const conflicts: Record<string, unknown>[] = [];
  try {
    for (const e of await icu.events(date, 2)) {
      conflicts.push({ date: String(e.start_date_local || "").slice(0, 10), name: e.name ?? null, category: e.category ?? null });
    }
  } catch (e) {
    if (!(e instanceof icu.IcuError)) throw e;
  }
  let created: Record<string, unknown>;
  try {
    const distM = ((d.route_km as number | null) || 0) * 1000 || null;
    created = await icu.createWorkout(date, d.title, d.syntax, distM, d.duration_min * 60);
  } catch (e) {
    if (e instanceof icu.IcuError) throw new HttpError(502, `create failed: ${e.message}`);
    throw e;
  }
  let verify: Record<string, unknown> = {};
  const evId = created.id;
  if (evId) {
    try {
      const ev = await icu.getEvent(evId);
      verify = { id: evId, parsed_load: (ev.icu_training_load || ev.training_load) ?? null,
                 parsed_if: (ev.icu_intensity || ev.intensity_factor) ?? null };
    } catch (e) {
      if (!(e instanceof icu.IcuError)) throw e;
      verify = { id: evId, note: "created but could not fetch back" };
    }
  }
  return { created: true, event: verify, estimated_load: d.load_estimate, conflicts, date, title: d.title };
}

// --------------------------------------------------------------- router ---

function authorized(req: Request): boolean {
  const pw = cfg.APP_PASSWORD;
  if (!pw) return true;
  const h = req.headers.get("authorization") || "";
  if (h.slice(0, 6).toLowerCase() !== "basic ") return false;
  const dec = Buffer.from(h.slice(6).trim(), "base64").toString("utf8");
  const given = dec.includes(":") ? dec.slice(dec.indexOf(":") + 1) : "";
  const digest = (x: string) => createHash("sha256").update(x).digest();
  return timingSafeEqual(digest(given), digest(pw));            // any username
}

/** Headers an internal call must carry to pass the site's own visitor protection. */
function forwardHeaders(req: Request): jobs.FwdHeaders {
  const out: jobs.FwdHeaders = {};
  for (const h of ["cookie", "authorization"]) {
    const v = req.headers.get(h);
    if (v) out[h] = v;
  }
  return out;
}

let invokerOverride: ((origin: string) => jobs.Invoke) | null = null;

/** Tests: run jobs in-process instead of calling the background function. */
export function setInvoker(f: ((origin: string) => jobs.Invoke) | null): void {
  invokerOverride = f;
}

export function invoker(origin: string): jobs.Invoke {
  if (invokerOverride) return invokerOverride(origin);
  return async (body) => {
    const r = await fetch(`${origin}/.netlify/functions/maint-background`, {
      method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...body.fwd },
    });
    if (r.status >= 400) throw new Error(`could not start the background job (HTTP ${r.status})`);
  };
}

export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  const m = req.method;
  if (path !== "/api/health" && !authorized(req)) {
    return new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Basic realm="GPX Workout Designer"' } });
  }
  try {
    if (m === "GET" && path === "/api/health") {
      return json({ missing_engine: [], icu_configured: icuConfigured(), buffer_km: cfg.BUFFER_KM, ref_speed_kmh: cfg.REF_SPEED_KMH });
    }
    if (m === "POST" && path === "/api/route") return json(await uploadRoute(req));
    if (m === "GET" && path === "/api/context") return json(await context());
    const mm = /^\/api\/mapdata\/([^/]+)$/.exec(path);
    if (m === "GET" && mm) return json(await getMapdata(decodeURIComponent(mm[1])));
    if (m === "GET" && path === "/api/maint/jobs") return json({ jobs: await jobs.status() });
    if (m === "POST") {
      switch (path) {
        case "/api/blank":
          return json(await blank());
        case "/api/maint/run": {
          const b = await readJSON(req);
          const { kind } = model(b, { kind: ["str"] });
          try {
            return json({ job_id: await jobs.start(kind, invoker(url.origin), forwardHeaders(req)) });
          } catch (e) {
            if (e instanceof RangeError) throw new HttpError(400, e.message);
            throw e;
          }
        }
        case "/api/maint/history":
          if (!icuConfigured()) throw new HttpError(400, "intervals.icu not configured (site environment variables)");
          return json({ job_id: await jobs.startHistoryRefresh(invoker(url.origin), forwardHeaders(req)) });
      }
      const b = await readJSON(req);
      switch (path) {
        case "/api/objectives": return json(await objectives(b));
        case "/api/design": return json(await designRoute(b));
        case "/api/workouts": return json(await workouts(b));
        case "/api/select": return json(await select(b));
        case "/api/title": return json(await setTitle(b));
        case "/api/segments": return json(await setSegments(b));
        case "/api/veto": return json(await veto(b));
        case "/api/push": return json(await push(b));
        case "/api/rides/matches": {
          const [rid] = await routeOnly(b);
          return json({ matches: await rides.matches(await routePts(rid)) });
        }
        case "/api/rides/track": {
          const { route_id: rid, file } = model(b, { route_id: ["str"], file: ["str"] });
          await sess(rid);
          try {
            return json(await rides.track(file));
          } catch (e) {
            if (e instanceof rides.NotFound) throw new HttpError(404, "ride file not found — refresh ride history in Maintenance");
            throw e;
          }
        }
        case "/api/rides/fast": {
          const { threshold: th } = model(b, { route_id: ["str"], threshold: ["float", { dflt: 33.0 }] });
          const [rid] = await routeOnly(b);
          return json((await rides.overviews(await routePts(rid), { speed: th })).speed);
        }
        case "/api/rides/power": {
          const { threshold: th } = model(b, { route_id: ["str"], threshold: ["float", { dflt: 200.0 }] });
          const [rid] = await routeOnly(b);
          return json((await rides.overviews(await routePts(rid), { power: th })).power);
        }
      }
    }
    return json({ detail: "Not Found" }, 404);
  } catch (e) {
    if (e instanceof HttpError) return json({ detail: e.detail }, e.status);
    console.error(e);
    return json({ detail: e instanceof Error ? e.message : String(e) }, 500);
  }
}
