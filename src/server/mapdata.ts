/**
 * The JSON the in-app SVG map draws from (mapdata.py): route line, per-km
 * composite tiers, hazards, stops, placement blocks and the street basemap.
 */
import { cumdist } from "../lib/geo.js";
import type { RoutePt } from "../lib/gpx.js";
import { pyRound } from "../lib/py.js";
import { getStreets, scoreTier, type StreetCache } from "../engine/mapwidget.js";
import type { RouteCtx } from "./designer.js";
import { cachedJSON } from "./store.js";

const QCODE: Record<string, string> = { "known-clear": "clear", "known-stop": "stop", unknown: "new" };

function perkm(comp: RouteCtx["comp"]) {
  const { scores, cont, qual, corridor } = comp;
  const out: Record<string, unknown>[] = [];
  for (let k = 1; k <= comp.nkm; k++) {
    const s = scores[k - 1];
    out.push({
      km: k, tier: scoreTier(s), score: pyRound(s), cont: pyRound(cont[k] ?? 0),
      ql: QCODE[qual[k] ?? "unknown"] ?? "new", corr: pyRound(corridor[k]?.avg_passes ?? 0, 1),
    });
  }
  return out;
}

function routeLine(pts: RoutePt[], maxPts = 900) {
  const cum = cumdist(pts);
  const step = Math.max(1, Math.trunc(pts.length / maxPts));
  const line: number[][] = [];
  for (let i = 0; i < pts.length; i += step) line.push([pyRound(pts[i][0], 5), pyRound(pts[i][1], 5), pyRound(cum[i] / 1000, 3)]);
  const n = pts.length - 1;
  const last = [pyRound(pts[n][0], 5), pyRound(pts[n][1], 5), pyRound(cum[n] / 1000, 3)];
  if (line[line.length - 1][2] !== last[2]) line.push(last);
  let minLa = Infinity, maxLa = -Infinity, minLo = Infinity, maxLo = -Infinity;
  for (const p of line) {
    if (p[0] < minLa) minLa = p[0];
    if (p[0] > maxLa) maxLa = p[0];
    if (p[1] < minLo) minLo = p[1];
    if (p[1] > maxLo) maxLo = p[1];
  }
  return { line, bounds: { minLa, maxLa, minLo, maxLo } };
}

/** Near-route street basemap; [] when neither the cache nor Overpass delivers. */
async function streets(pts: RoutePt[]) {
  try {
    const cache = await cachedJSON<StreetCache>("osm_streets.json");
    return await getStreets(pts, 320, 26000, cache, 30);
  } catch {
    return [];
  }
}

export async function build(pts: RoutePt[], ctx: RouteCtx) {
  const comp = ctx.comp;
  const { line, bounds } = routeLine(pts);
  return {
    route: line, bounds, route_km: ctx.l1.distance_km, perkm: perkm(comp),
    haz: comp.haz, stops: comp.stops, blocks: comp.blocks.slice(0, 6), streets: await streets(pts),
  };
}
