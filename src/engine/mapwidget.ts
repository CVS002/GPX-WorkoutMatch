/**
 * Composite effort scoring, placement blocks, the street basemap and the
 * workout-bank candidate builder (build_map_widget.py). The designer and the
 * map both score through computeEffort/placementBlocks, so the design lands
 * where the map colours the road green.
 */
import { cumdist, haversineM, type LatLon } from "../lib/geo.js";
import { pyFixed, pyRound, sortBy, sortByDesc, sum } from "../lib/py.js";
import type { L1 } from "./analyze.js";
import { errName, overpassUrls, routeBBox } from "./osm.js";
import { CAT_WIN, parseStruct, REST_MIN, REST_PCT, type BankWorkout } from "./windows.js";

// ------------------------------------------------------------ streets ----
export interface Way { g: number[][]; k: string }
export interface StreetCache { meta: { bbox: number[]; [k: string]: unknown }; ways: { g: number[][]; k?: string; c?: string }[] }

/** Trim ways to a point budget, keeping a road/cycleway mix (longest first). */
export function capWays(ways: Way[], maxPoints: number, cycleFrac = 0.45): Way[] {
  if (sum(ways.map((w) => w.g.length)) <= maxPoints) return ways;
  const byLen = (ws: Way[]) => sortByDesc(ws.slice(), (w) => w.g.length);
  const cyc = byLen(ways.filter((w) => w.k === "cycle"));
  const road = byLen(ways.filter((w) => w.k !== "cycle"));
  const cycBudget = Math.trunc(maxPoints * cycleFrac);
  const chosen: Way[] = [];
  const seen = new Set<Way>();
  let used = 0;
  const fill = (src: Way[], budget: number) => {
    let spent = 0;
    for (const w of src) {
      const n = w.g.length;
      if (spent + n <= budget) {
        chosen.push(w);
        seen.add(w);
        spent += n;
        used += n;
      }
    }
  };
  fill(road, maxPoints - cycBudget);
  fill(cyc, cycBudget);
  for (const w of byLen(ways)) {
    if (!seen.has(w) && used + w.g.length <= maxPoints) {
      chosen.push(w);
      seen.add(w);
      used += w.g.length;
    }
  }
  return chosen;
}

/** Cached ways near the route; null if the route isn't inside the cached box. */
export function streetsFromCache(cache: StreetCache, pts: readonly LatLon[], bufferM: number, maxPoints: number): Way[] | null {
  const [s, w, n, e] = routeBBox(pts);
  const cb = cache.meta.bbox;
  if (!(s >= cb[0] && w >= cb[1] && n <= cb[2] && e <= cb[3])) return null;
  const m = bufferM / 111000.0 + 0.003;
  const box = [s - m, w - m, n + m, e + m];
  const kind = (way: StreetCache["ways"][number]) => way.k || (way.c === "cycleway" ? "cycle" : "road");
  const lines: Way[] = [];
  for (const way of cache.ways) {
    if (way.g.some((p) => box[0] <= p[0] && p[0] <= box[2] && box[1] <= p[1] && p[1] <= box[3])) {
      lines.push({ g: way.g, k: kind(way) });
    }
  }
  return capWays(lines, maxPoints);
}

export function wayKind(tags: Record<string, string>): string {
  const hw = tags.highway || "";
  if (hw === "cycleway" || tags.bicycle === "designated" || tags.bicycle === "yes"
      || tags.cyclestreet === "yes" || tags.bicycle_road === "yes") return "cycle";
  return "road";
}

/** Live Overpass street fetch near the route; [] on any error. */
export async function fetchStreets(pts: readonly LatLon[], bufferM = 250, maxPoints = 9000, timeoutS = 90): Promise<Way[]> {
  const keep = [0];
  let last = 0;
  const cum = cumdist(pts);
  for (let i = 1; i < pts.length; i++) {
    if (cum[i] - cum[last] >= 150) {
      keep.push(i);
      last = i;
    }
  }
  const coords = keep.map((i) => `${pyFixed(pts[i][0], 5)},${pyFixed(pts[i][1], 5)}`).join(",");
  const roads = "primary|secondary|tertiary|unclassified|residential|living_street|"
    + "primary_link|secondary_link|tertiary_link|service|cycleway|track|path|road";
  const q = `[out:json][timeout:60];way(around:${bufferM},${coords})["highway"~"^(${roads})$"];out geom;`;
  let raw: { elements?: { geometry?: { lat: number; lon: number }[]; tags?: Record<string, string> }[] };
  try {
    const r = await fetch(overpassUrls()[0], {
      method: "POST", body: q,
      headers: { "User-Agent": "gpx-workout-designer-v2/2.0", "Content-Type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(timeoutS * 1000),
    });
    if (!r.ok) throw new Error(`HTTP Error ${r.status}`);
    raw = await r.json();
  } catch (e) {
    console.log(`  (streets skipped: ${errName(e)})`);
    return [];
  }
  const lines: Way[] = [];
  for (const el of raw.elements || []) {
    const g = el.geometry;
    if (!g || g.length < 2) continue;
    const poly = [[pyRound(g[0].lat, 5), pyRound(g[0].lon, 5)]];
    let acc = 0.0;
    for (let i = 1; i < g.length; i++) {
      acc += haversineM(g[i - 1].lat, g[i - 1].lon, g[i].lat, g[i].lon);
      if (acc >= 25) {
        poly.push([pyRound(g[i].lat, 5), pyRound(g[i].lon, 5)]);
        acc = 0.0;
      }
    }
    const end = [pyRound(g[g.length - 1].lat, 5), pyRound(g[g.length - 1].lon, 5)];
    const pl = poly[poly.length - 1];
    if (pl[0] !== end[0] || pl[1] !== end[1]) poly.push(end);
    lines.push({ g: poly, k: wayKind(el.tags || {}) });
  }
  return capWays(lines, maxPoints);
}

/** Street basemap: the regional cache first, else live Overpass. */
export async function getStreets(pts: readonly LatLon[], bufferM: number, maxPoints: number,
                                 cache: StreetCache | null, liveTimeoutS = 90): Promise<Way[]> {
  if (cache) {
    try {
      const got = streetsFromCache(cache, pts, bufferM, maxPoints);
      if (got !== null) return got;
    } catch {
      /* unreadable cache → live fetch */
    }
  }
  return fetchStreets(pts, bufferM, maxPoints, liveTimeoutS);
}

// --------------------------------------------------- workout candidates ----
export interface Candidate {
  name: string; plan?: string; category: string; steady?: boolean; reps?: number;
  work_min?: number; work_pct: string; rest_min?: number; rest_pct?: string; body_min: number;
}

/** Per-category renderable interval sessions from the bank that fit the route. */
export function buildCandidates(bank: BankWorkout[], rkm: number): Record<string, Candidate[]> {
  const maxBody = Math.max(6.0, (rkm - 4) * 2);
  const out: Record<string, Candidate[]> = {};
  for (const [cat, win] of Object.entries(CAT_WIN)) {
    const seen = new Set<string>();
    let cand: Candidate[] = [];
    for (const w of bank) {
      if (w.category !== cat) continue;
      const p = parseStruct(w.structure ?? "");
      if (!p) continue;
      const [reps, workMin, pct] = p;
      if (!(win.pct[0] <= pct && pct <= win.pct[1])) continue;
      if (!(win.work[0] <= workMin && workMin <= win.work[1])) continue;
      if (!(win.reps[0] <= reps && reps <= win.reps[1])) continue;
      const restMin = REST_MIN[cat](workMin);
      const body = reps * workMin + (reps - 1) * restMin;
      if (body > maxBody) continue;
      const key = `${reps}|${pyRound(workMin, 2)}|${pct}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const lo = Math.max(50, pct - 2);
      const hi = Math.min(300, pct + 2);
      cand.push({
        name: w.name ?? cat, plan: w.plan ?? "", category: cat, reps,
        work_min: pyRound(workMin, 2), work_pct: `${lo}-${hi}`,
        rest_min: restMin, rest_pct: REST_PCT[cat], body_min: pyRound(body, 1),
      });
    }
    sortBy(cand, (c) => [c.reps as number, c.work_min as number]);
    if (cand.length > 8) {                      // spread for variety
      const step = cand.length / 8.0;
      cand = Array.from({ length: 8 }, (_, i) => cand[Math.trunc(i * step)]);
    }
    out[cat] = cand;
  }
  out.endurance = [
    { name: "Steady Z2", category: "endurance", steady: true, work_pct: "63-70", body_min: maxBody },
    { name: "Z2 + 3x8 tempo surges", category: "endurance", reps: 3, work_min: 8.0, work_pct: "82-88",
      rest_min: 6.0, rest_pct: "63-70", body_min: 3 * 8 + 2 * 6 },
    { name: "Z2 + 2x15 tempo", category: "endurance", reps: 2, work_min: 15.0, work_pct: "80-86",
      rest_min: 8.0, rest_pct: "63-70", body_min: 2 * 15 + 8 },
  ];
  return out;
}

// ----------------------------------------------------- composite scoring ----
export const HAZ_SEVERITY: Record<string, number> = {
  traffic_signal: 3.0, level_crossing: 3.0, roundabout: 2.0,
  stop_sign: 2.5, give_way: 2.0, yield_left: 2.0, right_before_left: 0.6,
};
const STOP_SEVERITY = 2.5;
const QUAL_MULT: Record<string, number> = { "known-clear": 1.12, unknown: 1.0, "known-stop": 0.5 };
const EFF_CAP = 12.0;
const EFF_W = 12.0;

const hazKmBucket = (km: number, nkm: number) => Math.min(nkm, Math.max(1, Math.trunc(km) + 1));

export interface CorridorRec { km: number; corridor_frac?: number; avg_passes?: number }

export function effBonus(rec: CorridorRec | undefined | null): number {
  if (!rec) return 0.0;
  const frac = rec.corridor_frac ?? 0.0;
  const strength = Math.max(0.0, Math.min(1.0, ((rec.avg_passes ?? 0.0) - 1.0) / 4.0));
  return Math.min(EFF_CAP, EFF_W * frac * strength);
}

export type KmMap<T> = Record<number, T>;

/** Per-km composite 'can I hold an effort here' score fusing all layers. */
export function computeEffort(l1: L1, qual: KmMap<string>, haz: { km: number; t: string }[],
                              stops: { km: number }[], nkm: number, corridor: KmMap<CorridorRec> = {}) {
  const cont: KmMap<number> = {};
  for (const g of l1.per_km_geometry || []) cont[g.km] = g.continuity;
  const grad: KmMap<number> = {};
  for (const g of l1.per_km_gradient || []) grad[g.km] = g.avg_gradient_pct;
  const hz = new Array<number>(nkm + 1).fill(0.0);
  for (const h of haz) hz[hazKmBucket(h.km, nkm)] += HAZ_SEVERITY[h.t] ?? 1.5;
  for (const s of stops) hz[hazKmBucket(s.km, nkm)] += STOP_SEVERITY;
  const scores: number[] = [];
  for (let k = 1; k <= nkm; k++) {
    const c = cont[k] ?? 0;
    const qm = QUAL_MULT[qual[k] ?? "unknown"] ?? 1.0;
    const pen = Math.min(70.0, hz[k] * 18.0);
    const bonus = effBonus(corridor[k]);
    scores.push(Math.max(0.0, pyRound(c * qm - pen + bonus, 1)));
  }
  return { scores, cont, grad };
}

export const scoreTier = (s: number) => (s >= 68 ? "g" : s >= 42 ? "m" : "p");

export interface PBlock { start_km: number; end_km: number; len_km: number; score: number; cont: number; character: string; hist_frac?: number }

/** Ranked stretches for auto-placing an interval body, best first. */
export function placementBlocks(l1: L1, scores: number[], grad: KmMap<number>, nkm: number, thresh = 58): PBlock[] {
  const character = (g: number) => (g >= 1.5 ? "climbing" : g <= -1.5 ? "descending" : Math.abs(g) < 0.8 ? "flat" : "rolling");
  const blocks: PBlock[] = [];
  let run: number | null = null;
  for (let k = 1; k <= nkm; k++) {
    const good = scores[k - 1] >= thresh;
    if (good && run === null) run = k;
    if ((!good || k === nkm) && run !== null) {
      const end = good ? k : k - 1;
      if (end - run + 1 >= 2) {
        const seg = scores.slice(run - 1, end);
        const cavg = sum(seg) / seg.length;
        const gs: number[] = [];
        for (let kk = run; kk <= end; kk++) gs.push(grad[kk] ?? 0.0);
        blocks.push({ start_km: run, end_km: end, len_km: end - run + 1, score: pyRound(cavg),
                      cont: pyRound(cavg), character: character(sum(gs) / gs.length) });
      }
      run = null;
    }
  }
  const lf = l1.longest_flat_stretch;
  if (lf && (lf.length_km ?? 0) >= 3) {
    const a = lf.start_km;
    const b = lf.end_km;
    let seg = scores.slice(a - 1, b);
    if (!seg.length) seg = [40];
    const avg = sum(seg) / seg.length;
    blocks.push({ start_km: a, end_km: b, len_km: lf.length_km, score: pyRound(avg), cont: pyRound(avg), character: "flat (long)" });
  }
  sortBy(blocks, (x) => [-x.score, -x.len_km]);
  return blocks;
}
