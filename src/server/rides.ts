/**
 * Match past rides against a route + extract speed/power overlays (rides.py).
 *
 * Each history ride is indexed once into ~110 m cells (ride_index.json, keyed
 * by blob ETag the way the Python keyed by file mtime), so "which rides were on
 * this route?" is a set-overlap question.
 */
import { cumdist, haversineM } from "../lib/geo.js";
import { decodeRide, fmtTime, type RideRec, type RoutePt } from "../lib/gpx.js";
import { pyFloorDiv, pyRound, pySum, sortBy } from "../lib/py.js";
import { getJSON, kv, putCacheJSON } from "./store.js";

const CELL = 1000;
const INDEX_KEY = "ride_index.json";

export class NotFound extends Error {}

const cell = (lat: number, lon: number) => `${pyRound(lat * CELL)}:${pyRound(lon * CELL)}`;

/** (lat, lon, speed_ms|null, power_w|null, time|null) — rides.parse_ride. */
type RP = [number, number, number | null, number | null, number | null];

function ridePoints(r: RideRec, keepEvery = 1): RP[] {
  const pts: RP[] = [];
  for (let i = 0; i < r.la.length; i += keepEvery) pts.push([r.la[i], r.lo[i], r.sp[i] ?? null, r.pw[i] ?? null, r.t[i] ?? null]);
  return pts;
}

/** Fallback for rides without <speed>: v = distance/time between samples. */
function deriveSpeeds(pts: RP[]): RP[] {
  const out: RP[] = [];
  let prev: [number, number, number | null] | null = null;
  for (const [la, lo, , pwr, tm] of pts) {
    const ts = tm;
    let spd: number | null = null;
    if (prev && ts && prev[2] && ts > prev[2]) spd = haversineM(prev[0], prev[1], la, lo) / (ts - prev[2]);
    out.push([la, lo, spd, pwr, tm]);
    prev = [la, lo, ts];
  }
  return out;
}

export async function loadRide(aid: string): Promise<RideRec | null> {
  const b = await kv("history").getBytes(aid);
  return b ? decodeRide(b) : null;
}

/** Map with bounded concurrency, results in input order. */
export async function mapLimit<T, R>(xs: T[], limit: number, f: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(xs.length);
  let next = 0;
  const worker = async () => {
    while (next < xs.length) {
      const i = next++;
      out[i] = await f(xs[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, xs.length) }, worker));
  return out;
}

export interface IndexEntry {
  mtime: string; cells: string[]; activity_id: string | null; date: string;
  distance_km: number; avg_kmh: number | null; max_kmh: number | null; has_power: boolean;
}

function indexEntry(rec: RideRec, etag: string): IndexEntry {
  const pts = ridePoints(rec, 6);
  const spds = pts.map((p) => p[2]).filter((v): v is number => v !== null);
  let dist = 0.0;
  if (pts.length > 1) {
    const c = cumdist(pts);
    dist = c[c.length - 1] / 1000;
  }
  const sp = pySum(spds);
  let mx = -Infinity;
  for (const v of spds) if (v > mx) mx = v;
  return {
    mtime: etag,
    cells: [...new Set(pts.map((p) => cell(p[0], p[1])))].sort(),
    activity_id: rec.aid,
    date: pts.length && pts[0][4] !== null ? fmtTime(pts[0][4]).slice(0, 10) : "",
    distance_km: pyRound(dist, 1),
    avg_kmh: spds.length ? pyRound((sp / spds.length) * 3.6, 1) : null,
    max_kmh: spds.length ? pyRound(mx * 3.6, 1) : null,
    has_power: pts.some((p) => p[3] !== null),
  };
}

/**
 * Bring the ride index up to date with the history store. shouldStop lets a
 * background job stop between rides and continue later (progress is saved).
 */
export async function refreshIndex(shouldStop?: () => boolean): Promise<{ idx: Record<string, IndexEntry>; complete: boolean; total: number }> {
  const idx: Record<string, IndexEntry> = (await getJSON<Record<string, IndexEntry>>("cache", INDEX_KEY)) ?? {};
  const blobs = (await kv("history").list()).map((b) => ({ name: `${b.key}.gpx`, key: b.key, etag: b.etag }));
  blobs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const seen = new Set(blobs.map((b) => b.name));
  const todo = blobs.filter((b) => !(b.name in idx && idx[b.name].mtime === b.etag));
  let changed = false;
  let complete = true;
  for (const k of Object.keys(idx)) {
    if (!seen.has(k)) {
      delete idx[k];
      changed = true;
    }
  }
  for (let c0 = 0; c0 < todo.length; c0 += 32) {
    if (shouldStop?.()) {
      complete = false;
      break;
    }
    const chunk = todo.slice(c0, c0 + 32);
    const entries = await mapLimit(chunk, 8, async (b) => {
      const rec = await loadRide(b.key);
      return rec ? indexEntry(rec, b.etag) : null;
    });
    chunk.forEach((b, i) => {
      const e = entries[i];
      if (e) {
        idx[b.name] = e;
        changed = true;
      }
    });
  }
  if (changed) await putCacheJSON(INDEX_KEY, idx);
  return { idx, complete, total: Object.keys(idx).length };
}

/** The ride index, (re)indexing new/changed rides first. */
export async function rideIndex(): Promise<Record<string, IndexEntry>> {
  return (await refreshIndex()).idx;
}

const parseCell = (c: string) => c.split(":").map((x) => parseInt(x, 10));
function neigh(cells: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const c of cells) {
    const [a, b] = parseCell(c);
    for (const da of [-1, 0, 1]) for (const db of [-1, 0, 1]) out.add(`${a + da}:${b + db}`);
  }
  return out;
}

/** Rides that were 'mostly on this route', best match first. */
export async function matches(rpts: RoutePt[], top = 12, minCoverage = 0.5) {
  const rcells = new Set<string>();
  for (let i = 0; i < rpts.length; i += 3) rcells.add(cell(rpts[i][0], rpts[i][1]));
  if (!rcells.size) return [];
  const rtol = neigh(rcells);
  const out: Record<string, unknown>[] = [];
  for (const [name, m] of Object.entries(await rideIndex())) {
    const cells = m.cells || [];
    if (!cells.length) continue;
    const on = cells.filter((c) => rtol.has(c)).length / cells.length;
    const ridetol = neigh(cells);
    let hit = 0;
    for (const c of rcells) if (ridetol.has(c)) hit++;
    const cov = hit / rcells.size;
    if (cov < minCoverage) continue;
    out.push({
      file: name, coverage_pct: pyRound(cov * 100), on_route_pct: pyRound(on * 100),
      score: pyRound(cov * (0.5 + 0.5 * on), 3),
      activity_id: m.activity_id ?? null, date: m.date ?? null, distance_km: m.distance_km ?? null,
      avg_kmh: m.avg_kmh ?? null, max_kmh: m.max_kmh ?? null,
    });
  }
  sortBy(out, (x) => -(x.score as number));
  return out.slice(0, top);
}

/** Speed track of one history ride, downsampled for the overlay. */
export async function track(name: string, maxPts = 1600) {
  const base = name.split(/[\\/]/).pop() || "";           // basename only — no traversal
  if (!base.endsWith(".gpx")) throw new NotFound(name);
  const rec = await loadRide(base.slice(0, -4));
  if (!rec) throw new NotFound(name);
  let pts = ridePoints(rec, 1);
  if (pts.length && pts.every((x) => x[2] === null)) pts = deriveSpeeds(pts);
  const step = Math.max(1, Math.trunc(pts.length / maxPts));
  const tr: (number | null)[][] = [];
  for (let i = 0; i < pts.length; i += step) {
    const [la, lo, spd] = pts[i];
    tr.push([pyRound(la, 5), pyRound(lo, 5), spd !== null ? pyRound(spd * 3.6, 1) : null]);
  }
  return { track: tr, activity_id: rec.aid, points: tr.length };
}

// ------------------------------------------------- 500 m window overviews ---
type Metric = "speed" | "power";
const VALUE: Record<Metric, [(p: RP) => number | null, number, string]> = {
  speed: [(p) => p[2], 3.6, "km/h"],
  power: [(p) => p[3], 1.0, "W"],
};
const COMPANION: Record<Metric, Metric> = { speed: "power", power: "speed" };

type Best = [number, number | null, string] | null;

export interface Overview {
  bins: { km: number; val: number | null; comp: number | null; date: string | null }[];
  segments: Record<string, unknown>[];
  bin_km: number; win_km: number; route_km: number; threshold: number; n_rides: number;
  unit: string; metric: Metric; comp_unit: string;
}

/**
 * Across every past ride overlapping the route, the best *average* value (speed
 * or power) sustained over any 500 m sliding window, per 100 m sub-bin, plus the
 * companion metric over the same winning window. Both metrics are computed in
 * one pass over the history (each ride is read once).
 */
export async function overviews(rpts: RoutePt[], thresholds: Partial<Record<Metric, number>>,
                                winM = 500, subM = 100, nearM = 120.0): Promise<Partial<Record<Metric, Overview>>> {
  const metrics = Object.keys(thresholds) as Metric[];
  const binKm = subM / 1000;
  const winKm = winM / 1000;
  const result: Partial<Record<Metric, Overview>> = {};
  if (rpts.length < 2) {
    for (const mt of metrics) {
      result[mt] = { bins: [], segments: [], bin_km: binKm, win_km: winKm, threshold: thresholds[mt] as number,
                     n_rides: 0, route_km: 0, unit: VALUE[mt][2], metric: mt, comp_unit: VALUE[COMPANION[mt]][2] };
    }
    return result;
  }
  const cum = cumdist(rpts);
  const totalM = cum[cum.length - 1];
  const nsub = Math.trunc(pyFloorDiv(totalM, subM)) + 1;
  const WIN = Math.max(1, pyRound(winM / subM));
  const COV = Math.max(1, Math.trunc(WIN * 0.7));

  const rindex = new Map<string, number[]>();
  rpts.forEach((p, i) => {
    const k = cell(p[0], p[1]);
    const l = rindex.get(k);
    if (l) l.push(i);
    else rindex.set(k, [i]);
  });
  const rtolCells = neigh(rindex.keys());

  const best: Record<string, Best[]> = {};
  const nRides: Record<string, number> = {};
  for (const mt of metrics) {
    best[mt] = new Array<Best>(nsub).fill(null);
    nRides[mt] = 0;
  }

  const idx = await rideIndex();
  const cand = Object.entries(idx).filter(([, m]) => (m.cells || []).filter((c) => rtolCells.has(c)).length >= 3);
  const wants = (m: IndexEntry) => metrics.filter((mt) => !(mt === "power" && m.has_power === false));
  const todo = cand.filter(([, m]) => wants(m).length);

  // Read rides with bounded concurrency but fold them in index order, so ties
  // between rides resolve exactly as the sequential Python loop did.
  const CHUNK = 24;
  for (let c0 = 0; c0 < todo.length; c0 += CHUNK) {
    const chunk = todo.slice(c0, c0 + CHUNK);
    const recs = await mapLimit(chunk, 12, ([name]) => loadRide(name.slice(0, -4)));
    chunk.forEach(([, m], ci) => {
      const rec = recs[ci];
      if (!rec) return;
      let pts = ridePoints(rec, 1);
      if (pts.length && pts.every((x) => x[2] === null)) pts = deriveSpeeds(pts);
      const date = m.date || "";
      // nearest route sub-bin per sample (shared by both metrics)
      const kOf = new Int32Array(pts.length).fill(-1);
      for (let pi = 0; pi < pts.length; pi++) {
        const p = pts[pi];
        if (p[2] === null && p[3] === null) continue;
        const la = p[0];
        const lo = p[1];
        const ca = pyRound(la * CELL);
        const cb = pyRound(lo * CELL);
        let bd: number | null = null;
        let bi = -1;
        for (const da of [-1, 0, 1]) {
          for (const db of [-1, 0, 1]) {
            for (const i of rindex.get(`${ca + da}:${cb + db}`) || []) {
              const d = haversineM(la, lo, rpts[i][0], rpts[i][1]);
              if (bd === null || d < bd) {
                bd = d;
                bi = i;
              }
            }
          }
        }
        if (bi < 0 || (bd as number) > nearM) continue;
        kOf[pi] = Math.min(nsub - 1, Math.trunc(pyFloorDiv(cum[bi], subM)));
      }
      for (const mt of wants(m)) {
        const [valueOf, scale] = VALUE[mt];
        const [compOf, cscale] = VALUE[COMPANION[mt]];
        const vsum = new Float64Array(nsub);
        const vcnt = new Int32Array(nsub);
        const csum = new Float64Array(nsub);
        const ccnt = new Int32Array(nsub);
        for (let pi = 0; pi < pts.length; pi++) {
          const v = valueOf(pts[pi]);
          if (v === null) continue;
          const k = kOf[pi];
          if (k < 0) continue;
          vsum[k] += v;
          vcnt[k] += 1;
          const cv = compOf(pts[pi]);
          if (cv !== null) {
            csum[k] += cv;
            ccnt[k] += 1;
          }
        }
        if (!vcnt.some((x) => x !== 0)) continue;
        nRides[mt] += 1;
        const bm = best[mt];
        const w0 = Math.min(WIN, nsub);
        let runS = pySum(vsum.subarray(0, w0));
        let runCs = pySum(csum.subarray(0, w0));
        let runC = 0, runCc = 0, runCov = 0;
        for (let k = 0; k < w0; k++) {
          runC += vcnt[k];
          runCc += ccnt[k];
          if (vcnt[k]) runCov += 1;
        }
        for (let s = 0; s <= nsub - WIN; s++) {
          if (s > 0) {
            const o = s - 1;
            const n = s + WIN - 1;
            runS += vsum[n] - vsum[o];
            runC += vcnt[n] - vcnt[o];
            runCs += csum[n] - csum[o];
            runCc += ccnt[n] - ccnt[o];
            runCov += (vcnt[n] ? 1 : 0) - (vcnt[o] ? 1 : 0);
          }
          if (runC && runCov >= COV) {
            const wavg = (runS / runC) * scale;
            for (let k = s; k < s + WIN; k++) {
              const bk = bm[k];
              if (bk === null || wavg > bk[0]) {
                const comp = runCc ? pyRound((runCs / runCc) * cscale, 1) : null;
                bm[k] = [wavg, comp, date];
              }
            }
          }
        }
      }
    });
  }

  for (const mt of metrics) {
    const bm = best[mt];
    const threshold = thresholds[mt] as number;
    result[mt] = {
      bins: bm.map((b, k) => ({
        km: pyRound(k * binKm, 3), val: b ? pyRound(b[0], 1) : null, comp: b ? b[1] : null, date: b ? b[2] : null,
      })),
      bin_km: pyRound(binKm, 3), win_km: pyRound(winKm, 3), route_km: pyRound(totalM / 1000, 2),
      threshold, n_rides: nRides[mt], segments: fastSegments(bm, binKm, threshold),
      unit: VALUE[mt][2], metric: mt, comp_unit: VALUE[COMPANION[mt]][2],
    };
  }
  return result;
}

const SEG_GAP = 2;

/** Contiguous stretches clearing the threshold, bridging gaps ≤ SEG_GAP sub-bins. */
function fastSegments(best: Best[], binKm: number, threshold: number) {
  const n = best.length;
  const over = best.map((b) => Boolean(b) && (b as [number, number | null, string])[0] >= threshold);
  const segments: Record<string, unknown>[] = [];
  let i = 0;
  while (i < n) {
    if (!over[i]) {
      i++;
      continue;
    }
    let j = i;
    for (;;) {
      let nxt = -1;
      for (let g = 1; g <= SEG_GAP + 1; g++) {
        if (j + g < n && over[j + g]) {
          nxt = j + g;
          break;
        }
      }
      if (nxt < 0) break;
      j = nxt;
    }
    let seg = -1;
    for (let k = i; k <= j; k++) {
      if (over[k] && (seg < 0 || (best[k] as NonNullable<Best>)[0] > (best[seg] as NonNullable<Best>)[0])) seg = k;
    }
    const b = best[seg] as [number, number | null, string];
    segments.push({
      km_start: pyRound(i * binKm, 2), km_end: pyRound((j + 1) * binKm, 2), length_km: pyRound((j + 1 - i) * binKm, 2),
      peak: pyRound(b[0], 1), comp: b[1], date: b[2],
    });
    i = j + 1;
  }
  return segments;
}
