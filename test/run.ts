/**
 * Parity test: replay the requests the ORIGINAL Python app answered
 * (test/parity/oracle.py → py_out.json) against the TypeScript port and diff
 * every response, the caches the jobs build, the stored ride records, and a
 * few unit outputs. Run via test/parity/run.sh.
 *
 *   node test/.build/run.mjs <fixtures_dir> <work_dir> <icu_port> <overpass_port>
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeRide, parseHistoryGpx } from "../src/lib/gpx.js";
import { homeBBox } from "../src/engine/build/osmCaches.js";
import { classifyBouts, parseZwo, summarize } from "../src/engine/build/workoutBank.js";
import { selectCategory } from "../src/engine/suggest.js";
import type { RoadDb } from "../src/engine/score.js";
import { handle, setInvoker } from "../src/server/api.js";
import * as jobs from "../src/server/jobs.js";
import { getJSON, kv, memoryKV, useStores, type KV, type StoreName } from "../src/server/store.js";

const [FIX, WORK, ICU_PORT, OVP_PORT] = process.argv.slice(2);
Object.assign(process.env, {
  ICU_BASE: `http://127.0.0.1:${ICU_PORT}`, ICU_API_KEY: "testkey", ICU_ATHLETE_ID: "i0", APP_TZ: "UTC",
  OVERPASS_URLS: `http://127.0.0.1:${OVP_PORT}/api/interpreter,http://127.0.0.1:${OVP_PORT}/api/interpreter`,
});
delete process.env.APP_PASSWORD;

const stores = new Map<StoreName, KV>();
useStores((n) => {
  let s = stores.get(n);
  if (!s) stores.set(n, (s = memoryKV()));
  return s;
});
// jobs run inline (and chain inline) instead of via the background function
const inline: jobs.Invoke = async (b) => jobs.run(b, inline);
setInvoker(() => inline);

const py = JSON.parse(readFileSync(join(WORK, "py_out.json"), "utf8"));

// ------------------------------------------------------------- compare ---
type Diff = string;
let noise = 0;
function cmp(a: unknown, b: unknown, path: string, out: Diff[], tol = 1e-9) {
  if (out.length > 12) return;
  if (typeof a === "number" && typeof b === "number") {
    if (a === b || (Number.isNaN(a) && Number.isNaN(b))) return;
    if (Math.abs(a - b) <= tol * Math.max(1, Math.abs(a))) {
      noise++;
      if (process.env.SHOW_NOISE && noise <= 12) console.log(`  ~ ${path}: py=${a} ts=${b}`);
      return;
    }
    out.push(`${path}: py=${a} ts=${b}`);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}: length py=${a.length} ts=${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) cmp(a[i], b[i], `${path}[${i}]`, out, tol);
    return;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    for (const k of new Set([...ka, ...kb])) {
      const va = (a as Record<string, unknown>)[k];
      const vb = (b as Record<string, unknown>)[k];
      if (va === undefined && vb === null) continue;          // Python omitted a None we serialise
      if (!(k in (a as object))) out.push(`${path}.${k}: only in ts (${JSON.stringify(vb)?.slice(0, 80)})`);
      else if (!(k in (b as object))) out.push(`${path}.${k}: only in py (${JSON.stringify(va)?.slice(0, 80)})`);
      else cmp(va, vb, `${path}.${k}`, out, tol);
    }
    return;
  }
  if (a !== b) out.push(`${path}: py=${JSON.stringify(a)?.slice(0, 160)} ts=${JSON.stringify(b)?.slice(0, 160)}`);
}

/** Responses that differ on purpose (environment, not behaviour). */
const EXPECTED: [RegExp, (p: any, t: any) => void][] = [
  // ElementTree's parser message vs ours for non-XML input — status is what matters
  [/upload broken\.gpx/, (p, t) => { p.detail = t.detail = "<parse error>"; }],
];

// --------------------------------------------------------------- replay ---
const tsRid = new Map<string, string>();    // token → ts rid
const ridTok = new Map<string, string>();   // ts rid → token
const jobTok = new Map<string, string>();
const tokRe = /\$R\d+/g;

function untok(x: unknown): unknown {
  return x === null || x === undefined ? x : JSON.parse(JSON.stringify(x).replace(tokRe, (m) => tsRid.get(m) ?? m));
}
function retok(x: unknown): unknown {
  let s = JSON.stringify(x);
  for (const [rid, t] of ridTok) s = s.split(rid).join(t);
  for (const [jid, t] of jobTok) s = s.split(jid).join(t);
  return JSON.parse(s);
}

const results: { label: string; diffs: Diff[] }[] = [];
let pyJob = 0;
const t0 = Date.now();
for (const st of py.steps) {
  const path = untok(st.path) as string;
  let req: Request;
  const url = `http://localhost${path}`;
  if (st.upload) {
    const content = st.upload === "route.txt" ? "<gpx></gpx>" : readFileSync(join(FIX, "routes", st.upload));
    const fd = new FormData();
    fd.append("file", new File([content], st.upload, { type: "application/gpx+xml" }));
    req = new Request(url, { method: "POST", body: fd });
  } else if (st.method === "GET") {
    req = new Request(url);
  } else {
    req = new Request(url, { method: "POST", headers: { "content-type": "application/json" },
                             body: st.body === null ? undefined : JSON.stringify(untok(st.body)) });
  }
  const res = await handle(req);
  const txt = await res.text();
  let data: any;
  try {
    data = JSON.parse(txt);
  } catch {
    data = { _text: txt };
  }
  if (data && typeof data.route_id === "string" && !ridTok.has(data.route_id)) {
    const t = `$R${ridTok.size + 1}`;
    ridTok.set(data.route_id, t);
    tsRid.set(t, data.route_id);
  }
  if (data && typeof data.job_id === "string") {
    pyJob++;
    jobTok.set(data.job_id, `job${pyJob}`);
  }
  let p = st.resp;
  let t = retok(data) as any;
  if (/: final$/.test(st.label)) {                       // job lists: compare outcomes, not logs/timestamps
    const strip = (j: any) => j.jobs.map((x: any) => ({ id: x.id, label: x.label, status: x.status, error: x.error }));
    p = { jobs: strip(p) };
    t = { jobs: strip(t) };
  }
  p = JSON.parse(JSON.stringify(p));
  for (const [re, fix] of EXPECTED) if (re.test(st.label)) fix(p, t);
  const diffs: Diff[] = [];
  if (st.status !== res.status) diffs.push(`status py=${st.status} ts=${res.status}`);
  cmp(p, t, "$", diffs);
  results.push({ label: st.label, diffs });
}
const replayMs = Date.now() - t0;

// --------------------------------------------------------------- caches ---
const cacheDiffs: Record<string, Diff[]> = {};
for (const [key, pv] of Object.entries(py.caches as Record<string, any>)) {
  let tv: any;
  if (key.endsWith(".md")) tv = (await kv("cache").getText(key))?.data ?? "";
  else tv = await getJSON("cache", key);
  let a = pv;
  let b = tv;
  if (key === "ride_index.json" && a && b) {
    const strip = (x: Record<string, any>) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, { ...v, mtime: 0 }]));
    a = strip(a);
    b = strip(b);
  }
  if (a?.meta?.generated) a.meta.generated = b?.meta?.generated;
  const d: Diff[] = [];
  cmp(a, b, key, d, 1e-12);
  cacheDiffs[key] = d;
}

// ------------------------------------------------------- history records ---
const recDiffs: Diff[] = [];
let nRec = 0;
for (const f of readdirSync(py.history_dir).filter((x: string) => x.endsWith(".gpx")).sort()) {
  const want = parseHistoryGpx(readFileSync(join(py.history_dir, f), "utf8"), f.slice(0, -4));
  const got = await kv("history").getBytes(f.slice(0, -4));
  if (!got) {
    recDiffs.push(`${f}: missing in ts history`);
    continue;
  }
  nRec++;
  cmp(want, decodeRide(got), f, recDiffs, 0);
}
const tsKeys = (await kv("history").list()).map((b) => b.key);
if (tsKeys.length !== nRec) recDiffs.push(`history count py=${nRec} ts=${tsKeys.length}`);

// ---------------------------------------------------------------- units ---
const unitDiffs: Diff[] = [];
const zwo = JSON.parse(readFileSync(join(FIX, "zwo.json"), "utf8")) as string[];
zwo.forEach((z, i) => {
  const p = parseZwo(z);
  const got = p ? { name: p[0], bouts: p[1], total: p[2], cat: classifyBouts(p[1]), summary: summarize(p[1]) } : null;
  cmp(py.units.zwo[i], got, `zwo[${i}]`, unitDiffs, 0);
});
for (const u of py.units.select) {
  const [tsb, ph, last, terrain] = u.in;
  cmp(u.out, selectCategory(tsb, ph, last, terrain), `select(${u.in})`, unitDiffs, 0);
}
const road = await getJSON<RoadDb>("cache", "road_db.json");
for (const u of py.units.home) {
  let got: unknown;
  try {
    got = { r: u.r, out: homeBBox(road as RoadDb, u.r) };
  } catch {
    got = { r: u.r, error: "ValueError" };
  }
  cmp(u, got, `home_bbox(${u.r})`, unitDiffs, 1e-12);
}

// --------------------------------------------------------------- report ---
const bad = results.filter((r) => r.diffs.length);
console.log(`replayed ${results.length} requests in ${(replayMs / 1000).toFixed(1)} s — ${results.length - bad.length} identical, ${bad.length} differ`
  + (noise ? ` (${noise} values within 1e-9 relative)` : ""));
for (const r of bad.slice(0, 40)) console.log(`  ✗ ${r.label}\n      ${r.diffs.slice(0, 6).join("\n      ")}`);
for (const [k, d] of Object.entries(cacheDiffs)) console.log(`${d.length ? "  ✗" : "  ✓"} cache ${k}${d.length ? `\n      ${d.slice(0, 6).join("\n      ")}` : ""}`);
console.log(`${recDiffs.length ? "  ✗" : "  ✓"} ${nRec} ride records vs Python history GPX${recDiffs.length ? `\n      ${recDiffs.slice(0, 6).join("\n      ")}` : ""}`);
console.log(`${unitDiffs.length ? "  ✗" : "  ✓"} units (zwo ${zwo.length}, select ${py.units.select.length}, home ${py.units.home.length})`
  + (unitDiffs.length ? `\n      ${unitDiffs.slice(0, 8).join("\n      ")}` : ""));
const failed = bad.length + Object.values(cacheDiffs).filter((d) => d.length).length + (recDiffs.length ? 1 : 0) + (unitDiffs.length ? 1 : 0);
process.exit(failed ? 1 : 0);
