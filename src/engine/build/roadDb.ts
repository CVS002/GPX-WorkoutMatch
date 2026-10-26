/**
 * Layer 2 (build): ride history → road-knowledge cache (build_road_db.py).
 *
 * Bins every GPS sample into a ~50 m grid: passes per cell, typical speed, how
 * often you were nearly stopped — per 8-way heading — with "segment done" stops
 * after a hard effort ignored on planned-workout rides. Incremental: rides
 * already in the cache are skipped.
 */
import { bearingDeg, dirBin, haversineM, NDIR } from "../../lib/geo.js";
import type { RideRec } from "../../lib/gpx.js";
import { pyRound } from "../../lib/py.js";
import type { RoadCell, RoadDb } from "../score.js";

export const CELL_LAT = 0.00045;
export const CELL_LON = 0.00072;
const STOP_MS = 1.5;
const SLOWDOWN_CEIL_MS = 4.5;
const SLOWDOWN_FRAC = 0.55;
const SLOWDOWN_WIN_M = 120.0;
const EFFORT_FAST_MS = 8.6;
const EFFORT_MIN_S = 90.0;
const ENDSTOP_WIN_M = 180.0;
const CACHE_VERSION = 2;

export function cellLonFor(latDeg: number): number {
  return pyRound(CELL_LAT / Math.max(0.2, Math.cos(latDeg * (Math.PI / 180))), 8);
}

type Pt = [number, number, number];

function stopishFlags(pts: Pt[]): boolean[] {
  const n = pts.length;
  const flags = new Array<boolean>(n).fill(false);
  const win: [number, number][] = [];
  let head = 0;
  let cum = 0.0;
  for (let i = 0; i < n; i++) {
    if (i > 0) cum += haversineM(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    const spd = pts[i][2] || 0.0;
    win.push([cum, spd]);
    while (head < win.length && cum - win[head][0] > SLOWDOWN_WIN_M) head++;
    let recentMax = spd;
    if (head < win.length) {
      recentMax = -Infinity;
      for (let k = head; k < win.length; k++) if (win[k][1] > recentMax) recentMax = win[k][1];
    }
    flags[i] = spd < STOP_MS || (spd < SLOWDOWN_CEIL_MS && recentMax > 0 && spd < SLOWDOWN_FRAC * recentMax);
  }
  return flags;
}

function effortEndMask(pts: Pt[], times: (number | null)[]): boolean[] {
  const n = pts.length;
  const cum = new Array<number>(n).fill(0.0);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + haversineM(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
  const fast = pts.map((p) => (p[2] || 0.0) >= EFFORT_FAST_MS);
  const endPos: number[] = [];
  let i = 0;
  while (i < n) {
    if (!fast[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < n && fast[j + 1]) j++;
    const ti = times[i];
    const tj = times[j];
    const span = ti !== null && tj !== null ? tj - ti : j - i;
    if (span >= EFFORT_MIN_S) endPos.push(cum[j]);
    i = j + 1;
  }
  const mask = new Array<boolean>(n).fill(false);
  for (let k = 0; k < n; k++) {
    for (const e of endPos) {
      const d = cum[k] - e;
      if (d >= 0 && d <= ENDSTOP_WIN_M) {
        mask[k] = true;
        break;
      }
    }
  }
  return mask;
}

/** parse_ride: [lat, lon, speed] with missing speed filled by the step distance. */
function ridePoints(r: RideRec): { pts: Pt[]; times: (number | null)[] } {
  const pts: Pt[] = [];
  const times: (number | null)[] = [];
  for (let i = 0; i < r.la.length; i++) {
    pts.push([r.la[i], r.lo[i], r.sp[i] as number]);
    times.push(r.t[i] ?? null);
  }
  for (let i = 0; i < pts.length; i++) {
    if (pts[i][2] === null || pts[i][2] === undefined) {
      pts[i][2] = i > 0 ? haversineM(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) : 0.0;
    }
  }
  return { pts, times };
}

const newCell = (): RoadCell => [0, 0, 0, 0.0, 1e9, new Array(NDIR).fill(0), new Array(NDIR).fill(0)];
const upgrade = (c: RoadCell): RoadCell => (c.length < 7 ? [...c, new Array(NDIR).fill(0), new Array(NDIR).fill(0)] : c);

export interface BuildIO {
  /** History keys (activity ids), any order — processed sorted like glob. */
  keys: string[];
  load: (key: string) => Promise<RideRec | null>;
  log: (line: string) => void | Promise<void>;
  /** Stop between rides when this returns true (time budget); progress is kept. */
  shouldYield?: () => boolean;
}

/** Returns the updated cache and whether every ride was processed. */
export async function buildRoadDb(existing: RoadDb | null, workoutIds: Set<string>, io: BuildIO): Promise<{ cache: RoadDb; complete: boolean }> {
  let cache: RoadDb;
  if (existing) {
    cache = existing;
    cache.meta = cache.meta || ({} as RoadDb["meta"]);
    cache.meta.activities = cache.meta.activities || [];
    cache.meta.version = CACHE_VERSION;
    if (cache.meta.ndir === undefined) cache.meta.ndir = NDIR;
  } else {
    cache = { meta: { version: CACHE_VERSION, cell_lat: CELL_LAT, cell_lon: CELL_LON, stop_ms: STOP_MS, ndir: NDIR, activities: [] }, cells: {} };
  }
  if (workoutIds.size) await io.log(`  workout-aware for ${workoutIds.size} planned-workout rides`);
  const activities = cache.meta.activities as string[];
  const done = new Set(activities);
  const cells = cache.cells;
  const cl = cache.meta.cell_lat ?? CELL_LAT;
  let co = cache.meta.cell_lon ?? CELL_LON;
  const files = io.keys.map((k) => `${k}.gpx`).sort();
  let added = 0;
  let complete = true;
  let fresh = !Object.keys(cells).length && !activities.length;
  for (const f of files) {
    const aid = f.slice(0, -4);
    if (done.has(aid)) continue;
    if (io.shouldYield?.()) {
      complete = false;
      break;
    }
    const rec = await io.load(aid);
    if (!rec) continue;
    const { pts, times } = ridePoints(rec);
    if (pts.length < 2) continue;
    if (fresh) {                 // a NEW cache takes its lon cell size from the first ride
      co = cellLonFor(pts[0][0]);
      cache.meta.cell_lon = co;
      fresh = false;
    }
    let flags = stopishFlags(pts);
    const isWk = workoutIds.has(aid);
    if (isWk) {
      const endmask = effortEndMask(pts, times);
      flags = flags.map((fl, i) => fl && !endmask[i]);
    }
    const percell = new Map<string, { bins: Map<number, number>; stop: boolean }>();
    for (let i = 0; i < pts.length; i++) {
      const [lat, lon, spd] = pts[i];
      const key = `${pyRound(lat / cl)},${pyRound(lon / co)}`;
      let c = cells[key];
      if (c === undefined) c = cells[key] = newCell();
      else c = cells[key] = upgrade(c);
      c[1] = (c[1] as number) + 1;
      if (flags[i]) c[2] = (c[2] as number) + 1;
      c[3] = (c[3] as number) + spd;
      if (spd < (c[4] as number)) c[4] = spd;
      const b = i > 0 ? dirBin(bearingDeg(pts[i - 1][0], pts[i - 1][1], lat, lon)) : null;
      let e = percell.get(key);
      if (!e) percell.set(key, (e = { bins: new Map(), stop: false }));
      if (b !== null) e.bins.set(b, (e.bins.get(b) || 0) + 1);
      if (flags[i]) e.stop = true;
    }
    for (const [key, e] of percell) {
      const c = cells[key];
      c[0] = (c[0] as number) + 1;
      if (e.bins.size) {
        let dom = -1;
        let best = -1;
        for (const [bin, cnt] of e.bins) if (cnt > best) { best = cnt; dom = bin; }
        (c[5] as number[])[dom] += 1;
        if (e.stop) (c[6] as number[])[dom] += 1;
      }
    }
    done.add(aid);
    activities.push(aid);
    added++;
    await io.log(`  + ${aid}: ${pts.length} points, ${percell.size} cells${isWk ? "  [workout]" : ""}`);
  }
  await io.log(`Cache v${CACHE_VERSION}: ${Object.keys(cells).length} cells from ${done.size} rides (+${added} this run) -> road_db.json`);
  return { cache, complete };
}
