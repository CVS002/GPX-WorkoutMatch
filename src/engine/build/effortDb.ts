/**
 * Layer 5 (build): where the athlete SUSTAINS hard efforts (build_effort_db.py).
 *
 * A sample is "in effort" when HR > 165 bpm AND speed ≥ 31 km/h, inside a
 * continuous, steady (speed CV ≤ 0.22) run of ≥ 90 s. Cells count how many rides
 * held an effort through them, per heading. Grid comes from road_db so cells
 * line up. Rides without HR contribute nothing (but are marked done).
 */
import { bearingDeg, dirBin, haversineM, NDIR } from "../../lib/geo.js";
import type { RideRec } from "../../lib/gpx.js";
import { pyRound, pySum } from "../../lib/py.js";
import type { EffortCell, EffortDb, GridMeta } from "../score.js";
import { CELL_LAT, CELL_LON, type BuildIO } from "./roadDb.js";

const HR_ABS_MIN = 165;
const SPD_FLOOR = 8.6;
const EFFORT_MIN_S = 90.0;
const STEADY_CV = 0.22;
const CACHE_VERSION = 2;

type Pt = [lat: number, lon: number, hr: number | null, spd: number, t: number | null];

function ridePoints(r: RideRec): Pt[] {
  const pts: [number, number, number | null, number | null, number | null][] = [];
  let anyHr = false;
  for (let i = 0; i < r.la.length; i++) {
    const hr = r.hr[i] ?? null;
    if (hr !== null) anyHr = true;
    pts.push([r.la[i], r.lo[i], hr, r.sp[i] ?? null, r.t[i] ?? null]);
  }
  if (!anyHr) return [];
  for (let i = 0; i < pts.length; i++) {
    if (pts[i][3] === null) {
      pts[i][3] = i > 0 ? haversineM(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) : 0.0;
    }
  }
  return pts as Pt[];
}

function cv(vals: number[]): number {
  if (vals.length < 2) return 0.0;
  const m = pySum(vals) / vals.length;
  if (m <= 0) return 1.0;
  return Math.sqrt(pySum(vals.map((v) => (v - m) * (v - m))) / vals.length) / m;
}

function effortFlags(pts: Pt[]): boolean[] {
  const n = pts.length;
  const cand = pts.map((p) => p[2] !== null && p[2] > HR_ABS_MIN && (p[3] || 0) >= SPD_FLOOR);
  const flags = new Array<boolean>(n).fill(false);
  let i = 0;
  while (i < n) {
    if (!cand[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < n && cand[j + 1]) j++;
    const t0 = pts[i][4];
    const t1 = pts[j][4];
    const span = t0 !== null && t1 !== null ? t1 - t0 : j - i;
    const speeds: number[] = [];
    for (let k = i; k <= j; k++) speeds.push(pts[k][3] || 0.0);
    if (span >= EFFORT_MIN_S && cv(speeds) <= STEADY_CV) for (let k = i; k <= j; k++) flags[k] = true;
    i = j + 1;
  }
  return flags;
}

export async function buildEffortDb(existing: EffortDb | null, grid: GridMeta | null, io: BuildIO): Promise<{ cache: EffortDb; complete: boolean }> {
  let cl = grid?.cell_lat ?? CELL_LAT;
  let co = grid?.cell_lon ?? CELL_LON;
  let cache: EffortDb;
  if (existing) {
    cache = existing;
    cache.meta = cache.meta || ({} as GridMeta);
    cache.meta.activities = cache.meta.activities || [];
    cache.meta.version = CACHE_VERSION;
    if (cache.meta.ndir === undefined) cache.meta.ndir = NDIR;
    cl = cache.meta.cell_lat ?? cl;
    co = cache.meta.cell_lon ?? co;
  } else {
    cache = {
      meta: { version: CACHE_VERSION, cell_lat: cl, cell_lon: co, hr_abs_min: HR_ABS_MIN, effort_min_s: EFFORT_MIN_S,
              spd_floor: SPD_FLOOR, steady_cv: STEADY_CV, ndir: NDIR, activities: [] },
      cells: {},
    };
  }
  const activities = cache.meta.activities as string[];
  const done = new Set(activities);
  const cells = cache.cells;
  const files = io.keys.map((k) => `${k}.gpx`).sort();
  let added = 0;
  let noHr = 0;
  let complete = true;
  for (const f of files) {
    const aid = f.slice(0, -4);
    if (done.has(aid)) continue;
    if (io.shouldYield?.()) {
      complete = false;
      break;
    }
    const rec = await io.load(aid);
    if (!rec) continue;
    const pts = ridePoints(rec);
    if (!pts.length) {                     // no HR → nothing for this layer
      noHr++;
      activities.push(aid);
      done.add(aid);
      continue;
    }
    const flags = effortFlags(pts);
    const percell = new Map<string, Map<number, number>>();
    for (let i = 0; i < pts.length; i++) {
      if (!flags[i]) continue;
      const p = pts[i];
      const key = `${pyRound(p[0] / cl)},${pyRound(p[1] / co)}`;
      let c: EffortCell | undefined = cells[key];
      if (c === undefined) c = cells[key] = [0, 0, new Array(NDIR).fill(0)];
      else if (c.length < 3) c = cells[key] = [...c, new Array(NDIR).fill(0)];
      c[1] = (c[1] as number) + 1;
      let e = percell.get(key);
      if (!e) percell.set(key, (e = new Map()));
      if (i > 0) {
        const b = dirBin(bearingDeg(pts[i - 1][0], pts[i - 1][1], p[0], p[1]));
        e.set(b, (e.get(b) || 0) + 1);
      }
    }
    for (const [key, bins] of percell) {
      const c = cells[key];
      c[0] = (c[0] as number) + 1;
      if (bins.size) {
        let dom = -1;
        let best = -1;
        for (const [bin, cnt] of bins) if (cnt > best) { best = cnt; dom = bin; }
        (c[2] as number[])[dom] += 1;
      }
    }
    activities.push(aid);
    done.add(aid);
    added++;
    if (percell.size) await io.log(`  + ${aid}: ${pts.length} pts, ${percell.size} effort cells`);
  }
  await io.log(`Effort cache: ${Object.keys(cells).length} cells from ${done.size} rides (+${added} mined, ${noHr} had no HR) -> effort_db.json`);
  return { cache, complete };
}
