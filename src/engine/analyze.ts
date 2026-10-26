/**
 * Layer 1 — terrain + road geometry from a route's points (analyze_gpx.py).
 *
 * Per-km continuity ("can I hold steady power here"), effort-ready blocks,
 * gradient profile, climbs and the longest flat stretch.
 */
import { bearingDeg, haversineM, turnAngle } from "../lib/geo.js";
import { GpxError, type RoutePt } from "../lib/gpx.js";
import { pyRound, sortByDesc, sum } from "../lib/py.js";

export interface KmGeo { km: number; sinuosity: number; turns_45: number; turns_90: number; continuity: number }
export interface EffortBlock {
  start_km: number; end_km: number; length_km: number; avg_continuity: number; total_turns_90: number;
  avg_gradient_pct?: number; character?: string;
}
export interface Climb {
  start_km: number; end_km: number; length_m: number; gain_m: number;
  avg_gradient_pct: number; max_gradient_pct: number; avg_continuity?: number | null;
}
export interface L1 {
  points: number;
  distance_km: number;
  has_elevation: boolean;
  per_km_geometry: KmGeo[];
  effort_blocks: EffortBlock[];
  note?: string;
  elevation_gain_m?: number;
  elevation_loss_m?: number;
  min_ele_m?: number;
  max_ele_m?: number;
  per_km_gradient?: { km: number; avg_gradient_pct: number }[];
  climbs?: Climb[];
  longest_flat_stretch?: { start_km: number; end_km: number; length_km: number };
}

/** Uniform 40 m arc-length resampling, so turn detection is density-independent. */
function resample(pts: RoutePt[], cum: number[], stepM = 40.0): [number, number, number][] {
  const total = cum[cum.length - 1];
  const out: [number, number, number][] = [];
  let d = 0.0;
  let j = 0;
  while (d <= total) {
    while (j < cum.length - 2 && cum[j + 1] < d) j++;
    const seg = cum[j + 1] - cum[j] || 1.0;
    const f = Math.min(Math.max((d - cum[j]) / seg, 0.0), 1.0);
    const la = pts[j][0] + (pts[j + 1][0] - pts[j][0]) * f;
    const lo = pts[j][1] + (pts[j + 1][1] - pts[j][1]) * f;
    out.push([la, lo, d]);
    d += stepM;
  }
  if (!out.length || out[out.length - 1][2] < total - 1) {
    out.push([pts[pts.length - 1][0], pts[pts.length - 1][1], total]);
  }
  return out;
}

function computeGeometry(pts: RoutePt[], cum: number[], totalM: number) {
  const rs = resample(pts, cum, 40.0);
  const bearings: number[] = [];
  for (let a = 0; a < rs.length - 1; a++) bearings.push(bearingDeg(rs[a][0], rs[a][1], rs[a + 1][0], rs[a + 1][1]));
  const turns = [0.0];
  for (let k = 1; k < bearings.length; k++) turns.push(turnAngle(bearings[k - 1], bearings[k]));
  turns.push(0.0);

  const nKm = Math.max(1, Math.ceil(totalM / 1000));
  const kmGeo: KmGeo[] = [];
  for (let k = 0; k < nKm; k++) {
    const startM = k * 1000;
    const endM = Math.min((k + 1) * 1000, totalM);
    let t45 = 0;
    let t90 = 0;
    let first: [number, number, number] | null = null;
    let last: [number, number, number] | null = null;
    for (let a = 0; a < rs.length; a++) {
      const pos = rs[a][2];
      if ((startM <= pos && pos < endM) || (k === nKm - 1 && pos <= endM)) {
        if (first === null) first = rs[a];
        last = rs[a];
        if (turns[a] >= 90) t90 += 1;
        else if (turns[a] >= 45) t45 += 1;
      }
    }
    let sinu: number;
    if (first === null || last === null || first === last) {
      sinu = 1.0;
    } else {
      const ridden = last[2] - first[2];
      const straight = haversineM(first[0], first[1], last[0], last[1]);
      sinu = straight > 1 ? ridden / straight : 1.0;
    }
    const turnPen = t90 * 22 + t45 * 7;
    const sinuPen = Math.max(0.0, sinu - 1.02) * 250;
    const continuity = Math.max(0, pyRound(100 - turnPen - sinuPen));
    kmGeo.push({ km: k + 1, sinuosity: pyRound(sinu, 3), turns_45: t45, turns_90: t90, continuity });
  }

  // Effort-ready blocks: runs of >= 2 km with continuity >= 65.
  const blocks: EffortBlock[] = [];
  let runStart: number | null = null;
  for (let k = 0; k < kmGeo.length; k++) {
    const good = kmGeo[k].continuity >= 65;
    if (good && runStart === null) runStart = k;
    if ((!good || k === kmGeo.length - 1) && runStart !== null) {
      const runEnd = good ? k : k - 1;
      const length = runEnd - runStart + 1;
      if (length >= 2) {
        const seg = kmGeo.slice(runStart, runEnd + 1);
        blocks.push({
          start_km: runStart + 1,
          end_km: runEnd + 1,
          length_km: length,
          avg_continuity: pyRound(sum(seg.map((s) => s.continuity)) / length),
          total_turns_90: sum(seg.map((s) => s.turns_90)),
        });
      }
      runStart = null;
    }
  }
  sortByDesc(blocks, (b) => [b.avg_continuity, b.length_km]);
  return { per_km_geometry: kmGeo, effort_blocks: blocks };
}

function smooth(values: number[], window = 5): number[] {
  if (!values.length) return values;
  const half = Math.trunc(window / 2);
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(values.length, i + half + 1);
    out.push(sum(values.slice(lo, hi)) / (hi - lo));
  }
  return out;
}

function character(g: number): string {
  if (g >= 1.5) return "climbing";
  if (g <= -1.5) return "descending";
  if (Math.abs(g) < 0.8) return "flat";
  return "rolling";
}

export function analyze(pts: RoutePt[]): L1 {
  if (pts.length < 2) throw new GpxError("GPX contains fewer than 2 track/route points");
  const hasEle = pts.every((p) => p[2] !== null);
  const cum = [0.0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversineM(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
  const totalM = cum[cum.length - 1];

  const geo = computeGeometry(pts, cum, totalM);
  const result: L1 = {
    points: pts.length,
    distance_km: pyRound(totalM / 1000, 2),
    has_elevation: hasEle,
    ...geo,
  };
  if (!hasEle) {
    result.note = "No elevation data; treat route as flat unless the user says otherwise.";
    return result;
  }

  const eles = smooth(pts.map((p) => p[2] as number), 7);
  let gain = 0.0;
  let loss = 0.0;
  for (let i = 1; i < eles.length; i++) {
    const d = eles[i] - eles[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  result.elevation_gain_m = pyRound(gain);
  result.elevation_loss_m = pyRound(loss);
  let mn = Infinity;
  let mxe = -Infinity;
  for (const e of eles) {                 // no spread: routes can have 100k+ points
    if (e < mn) mn = e;
    if (e > mxe) mxe = e;
  }
  result.min_ele_m = pyRound(mn);
  result.max_ele_m = pyRound(mxe);

  const kmProfile: { km: number; avg_gradient_pct: number }[] = [];
  const nKm = Math.max(1, Math.ceil(totalM / 1000));
  let idx = 0;
  for (let k = 0; k < nKm; k++) {
    const endM = Math.min((k + 1) * 1000, totalM);
    const i0 = idx;
    while (idx < cum.length - 1 && cum[idx + 1] < endM) idx++;
    const i1 = Math.min(idx + 1, pts.length - 1);
    const dist = Math.max(cum[i1] - cum[i0], 1.0);
    const grad = ((eles[i1] - eles[i0]) / dist) * 100;
    kmProfile.push({ km: k + 1, avg_gradient_pct: pyRound(grad, 1) });
  }
  result.per_km_gradient = kmProfile;

  // Climbs: >= 2% over >= 300 m, allowing brief (< 200 m) dips.
  const climbs: Climb[] = [];
  let i = 0;
  while (i < pts.length - 1) {
    const segD = Math.max(cum[i + 1] - cum[i], 0.01);
    const g = ((eles[i + 1] - eles[i]) / segD) * 100;
    if (g >= 2.0) {
      const start = i;
      let j = i;
      let slack = 0.0;
      while (j < pts.length - 1) {
        const d = Math.max(cum[j + 1] - cum[j], 0.01);
        const gj = ((eles[j + 1] - eles[j]) / d) * 100;
        if (gj >= 2.0) {
          slack = 0.0;
          j += 1;
        } else {
          slack += d;
          if (slack > 200) break;
          j += 1;
        }
      }
      const length = cum[j] - cum[start];
      const rise = eles[j] - eles[start];
      if (length >= 300 && rise >= 8) {
        let mx = -Infinity;
        for (let a = start; a < j; a++) {
          const dd = Math.max(cum[a + 1] - cum[a], 0.01);
          const ga = ((eles[a + 1] - eles[a]) / dd) * 100;
          if (ga > mx) mx = ga;
        }
        climbs.push({
          start_km: pyRound(cum[start] / 1000, 2),
          end_km: pyRound(cum[j] / 1000, 2),
          length_m: pyRound(length),
          gain_m: pyRound(rise),
          avg_gradient_pct: pyRound((rise / length) * 100, 1),
          max_gradient_pct: pyRound(mx, 1),
        });
      }
      i = j + 1;
    } else {
      i += 1;
    }
  }
  result.climbs = climbs;

  // Longest reasonably flat stretch (|avg gradient| < 1.5% per km) — TT candidate.
  let bestStart = 0;
  let bestLen = 0;
  let curStart = 0;
  let curLen = 0;
  kmProfile.forEach((row, k) => {
    if (Math.abs(row.avg_gradient_pct) < 1.5) {
      if (curLen === 0) curStart = k;
      curLen += 1;
      if (curLen > bestLen) {
        bestStart = curStart;
        bestLen = curLen;
      }
    } else {
      curLen = 0;
    }
  });
  if (bestLen) {
    result.longest_flat_stretch = { start_km: bestStart + 1, end_km: bestStart + bestLen, length_km: bestLen };
  }

  const gradForRange = (s: number, e: number) => {
    const rows = kmProfile.filter((r) => s <= r.km && r.km <= e).map((r) => r.avg_gradient_pct);
    return rows.length ? pyRound(sum(rows) / rows.length, 1) : 0.0;
  };
  for (const b of result.effort_blocks) {
    b.avg_gradient_pct = gradForRange(b.start_km, b.end_km);
    b.character = character(b.avg_gradient_pct);
  }
  for (const c of climbs) {
    const seg = result.per_km_geometry.filter((g) => c.start_km <= g.km && g.km <= c.end_km + 1).map((g) => g.continuity);
    c.avg_continuity = seg.length ? pyRound(sum(seg) / seg.length) : null;
  }
  return result;
}
