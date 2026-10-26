/**
 * Layer 2 (apply) — score a route against the road-knowledge cache — and
 * Layer 5 (apply) — against the effort-corridor cache (score_route.py).
 */
import { bearingDeg, dirBin, haversineM, NDIR } from "../lib/geo.js";
import { GpxError, type RoutePt } from "../lib/gpx.js";
import { pyMod, pyRound, sortBy } from "../lib/py.js";

/** [passes, samples, stop_samples, sum_speed, min_speed, dpass[8], dstop[8]] (v1 cells lack the last two). */
export type RoadCell = (number | number[])[];
/** [effort_passes, effort_samples, dpass[8]] (v1 cells lack dpass). */
export type EffortCell = (number | number[])[];

export interface GridMeta { cell_lat: number; cell_lon: number; activities?: string[]; [k: string]: unknown }
export interface RoadDb { meta: GridMeta; cells: Record<string, RoadCell> }
export interface EffortDb { meta: GridMeta; cells: Record<string, EffortCell> }

const MIN_PASSES = 2;
const STOP_RATE = 0.12;
const DIR_MIN_PASSES = 2;
const DIR_STOP_RATE = 0.3;
const EFF_MIN_PASSES = 2;

function dirWindow(dpass: number[], dstop: number[], rb: number): [number, number] {
  let dp = 0;
  let ds = 0;
  for (const d of [-1, 0, 1]) {
    const b = pyMod(rb + d, NDIR);
    dp += dpass[b];
    ds += dstop[b];
  }
  return [dp, ds];
}

function cumOf(pts: RoutePt[]): number[] {
  const cum = [0.0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversineM(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
  return cum;
}

function headings(pts: RoutePt[]): number[] {
  const brg = new Array<number>(pts.length).fill(0.0);
  for (let i = 1; i < pts.length; i++) brg[i] = bearingDeg(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
  brg[0] = pts.length > 1 ? brg[1] : 0.0;
  return brg;
}

/** Most-ridden cell in the 3x3 neighbourhood (tolerates small GPS offsets). */
function bestCell<C extends (number | number[])[]>(cells: Record<string, C>, cl: number, co: number, lat: number, lon: number): C | null {
  const ci = pyRound(lat / cl);
  const cj = pyRound(lon / co);
  let best: C | null = null;
  for (const di of [-1, 0, 1]) {
    for (const dj of [-1, 0, 1]) {
      const c = cells[`${ci + di},${cj + dj}`];
      if (c && (best === null || (c[0] as number) > (best[0] as number))) best = c;
    }
  }
  return best;
}

export interface L2 {
  route_km: number;
  rides_in_cache: number;
  route_coverage_pct: number;
  per_km_road_quality: { km: number; coverage: number; avg_passes: number; quality: string }[];
  stop_hotspots: { km: number; passes: number; stop_rate: number }[];
}

export function score(pts: RoutePt[], cache: RoadDb): L2 {
  const { meta, cells } = cache;
  const cl = meta.cell_lat;
  const co = meta.cell_lon;
  const nRides = (meta.activities || []).length;
  if (pts.length < 2) throw new GpxError("Route GPX has fewer than 2 points");
  const cum = cumOf(pts);
  const totalM = cum[cum.length - 1];
  const nKm = Math.max(1, Math.ceil(totalM / 1000));
  const brg = headings(pts);

  const buckets = Array.from({ length: nKm }, () => ({ known: 0, total: 0, stops: 0, sum_pass: 0 }));
  const hotspots: { km: number; passes: number; stop_rate: number }[] = [];
  for (let i = 0; i < pts.length; i++) {
    const k = Math.min(Math.trunc(cum[i] / 1000), nKm - 1);
    const b = buckets[k];
    b.total += 1;
    const c = bestCell(cells, cl, co, pts[i][0], pts[i][1]);
    if (c && (c[0] as number) >= MIN_PASSES) {
      const passes = c[0] as number;
      const samples = c[1] as number;
      const stopSamples = c[2] as number;
      b.known += 1;
      b.sum_pass += passes;
      // Directional decision first (v2 cells), else the sample rate.
      let stopped: boolean | null = null;
      let rate = 0;
      if (c.length >= 7) {
        const [dp, ds] = dirWindow(c[5] as number[], c[6] as number[], dirBin(brg[i]));
        if (dp >= DIR_MIN_PASSES) {
          rate = ds / dp;
          stopped = rate >= DIR_STOP_RATE;
        }
      }
      if (stopped === null) {
        rate = samples ? stopSamples / samples : 0.0;
        stopped = rate >= STOP_RATE;
      }
      if (stopped) {
        b.stops += 1;
        hotspots.push({ km: pyRound(cum[i] / 1000, 2), passes, stop_rate: pyRound(rate, 2) });
      }
    }
  }

  sortBy(hotspots, (h) => h.km);
  const merged: typeof hotspots = [];
  for (const h of hotspots) {
    if (merged.length && h.km - merged[merged.length - 1].km < 0.15) continue;
    merged.push(h);
  }

  const perKm = buckets.map((b, k) => {
    const cov = b.total ? b.known / b.total : 0.0;
    const quality = cov < 0.3 ? "unknown" : b.stops > 0 ? "known-stop" : "known-clear";
    return {
      km: k + 1,
      coverage: pyRound(cov, 2),
      avg_passes: b.known ? pyRound(b.sum_pass / b.known, 1) : 0,
      quality,
    };
  });
  const covered = perKm.filter((r) => r.coverage >= 0.3).length;
  return {
    route_km: pyRound(totalM / 1000, 2),
    rides_in_cache: nRides,
    route_coverage_pct: pyRound((100 * covered) / nKm),
    per_km_road_quality: perKm,
    stop_hotspots: merged,
  };
}

export interface L5 {
  per_km_effort: { km: number; corridor_frac: number; avg_passes: number }[];
  corridor_km: number;
}

export function scoreEffort(pts: RoutePt[], cache: EffortDb): L5 {
  const { meta, cells } = cache;
  const cl = meta.cell_lat;
  const co = meta.cell_lon;
  if (pts.length < 2) return { per_km_effort: [], corridor_km: 0 };
  const cum = cumOf(pts);
  const nKm = Math.max(1, Math.ceil(cum[cum.length - 1] / 1000));
  const brg = headings(pts);

  const buckets = Array.from({ length: nKm }, () => ({ total: 0, hit: 0, sum_pass: 0 }));
  for (let i = 0; i < pts.length; i++) {
    const k = Math.min(Math.trunc(cum[i] / 1000), nKm - 1);
    const b = buckets[k];
    b.total += 1;
    const c = bestCell(cells, cl, co, pts[i][0], pts[i][1]);
    if (!c) continue;
    let passes: number;
    if (c.length >= 3) {
      const rb = dirBin(brg[i]);
      const dp = c[2] as number[];
      passes = dp[pyMod(rb - 1, NDIR)] + dp[pyMod(rb, NDIR)] + dp[pyMod(rb + 1, NDIR)];
    } else {
      passes = c[0] as number;
    }
    if (passes >= EFF_MIN_PASSES) {
      b.hit += 1;
      b.sum_pass += passes;
    }
  }
  const perKm = buckets.map((b, k) => ({
    km: k + 1,
    corridor_frac: pyRound(b.total ? b.hit / b.total : 0.0, 2),
    avg_passes: pyRound(b.hit ? b.sum_pass / b.hit : 0.0, 1),
  }));
  return { per_km_effort: perKm, corridor_km: perKm.filter((r) => r.corridor_frac >= 0.5).length };
}
