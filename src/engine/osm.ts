/**
 * Layer 3 — OpenStreetMap hazards near a route (osm_enrich.py): traffic
 * signals, level crossings, roundabouts, give-way and stop signs, each snapped
 * to the route km it sits on. Regional cache first; live Overpass otherwise.
 */
import { cumdist, haversineM, type LatLon } from "../lib/geo.js";
import { GpxError, type RoutePt } from "../lib/gpx.js";
import { pyFixed, pyRound, sortBy } from "../lib/py.js";

const DEFAULT_OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];

/** Overpass mirrors, tried in order (OVERPASS_URLS env: comma-separated override). */
export function overpassUrls(): string[] {
  const env = process.env.OVERPASS_URLS;
  return env ? env.split(",").map((u) => u.trim()).filter(Boolean) : DEFAULT_OVERPASS;
}
const UA = "gpx-workout-designer-v2/2.0";

export interface OverpassElement {
  type?: string;
  id?: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
}

/** POST a query to each mirror in turn; throws the last error if all fail. */
export async function runOverpass(query: string, timeoutS: number, retrySleepS = 0): Promise<{ elements?: OverpassElement[] }> {
  let last: unknown = null;
  for (const url of overpassUrls()) {
    try {
      const r = await fetch(url, {
        method: "POST",
        body: query,
        headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
        signal: AbortSignal.timeout(timeoutS * 1000),
      });
      if (!r.ok) throw new Error(`HTTP Error ${r.status}: ${r.statusText}`);
      return (await r.json()) as { elements?: OverpassElement[] };
    } catch (e) {
      last = e;
      if (retrySleepS) await new Promise((res) => setTimeout(res, retrySleepS * 1000));
    }
  }
  throw last ?? new Error("Overpass unreachable");
}

export function errName(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === "TimeoutError" || e.name === "AbortError") return "TimeoutError";
    // fetch() reports DNS/connection failures as TypeError; urllib called them URLError
    return e.name === "Error" || e.name === "TypeError" ? "URLError" : e.name;
  }
  return "Error";
}

function downsample(pts: RoutePt[], cum: number[], stepM = 100.0): RoutePt[] {
  const keep = [0];
  let last = 0;
  for (let i = 1; i < pts.length; i++) {
    if (cum[i] - cum[last] >= stepM) {
      keep.push(i);
      last = i;
    }
  }
  if (keep[keep.length - 1] !== pts.length - 1) keep.push(pts.length - 1);
  return keep.map((i) => pts[i]);
}

function buildQuery(routePts: RoutePt[], radiusM = 30): string {
  const coords = routePts.map(([la, lo]) => `${pyFixed(la, 5)},${pyFixed(lo, 5)}`).join(",");
  const around = `around:${radiusM},${coords}`;
  return `[out:json][timeout:90];
(
  node(${around})[highway=traffic_signals];
  node(${around})[railway=level_crossing];
  node(${around})[highway=mini_roundabout];
  node(${around})[highway=give_way];
  node(${around})[highway=stop];
  way(${around})[junction=roundabout];
);
out center;
`;
}

function nearestKm(lat: number, lon: number, pts: RoutePt[], cum: number[]): [number, number] {
  let bestD = Infinity;
  let bestM = 0.0;
  for (let i = 0; i < pts.length; i++) {
    const d = haversineM(lat, lon, pts[i][0], pts[i][1]);
    if (d < bestD) {
      bestD = d;
      bestM = cum[i];
    }
  }
  return [pyRound(bestM / 1000, 2), pyRound(bestD)];
}

export function classify(el: OverpassElement): string {
  const tags = el.tags || {};
  if (tags.highway === "traffic_signals") return "traffic_signal";
  if (tags.railway === "level_crossing") return "level_crossing";
  if (tags.junction === "roundabout" || tags.highway === "mini_roundabout") return "roundabout";
  if (tags.highway === "give_way") return "give_way";
  if (tags.highway === "stop") return "stop_sign";
  return "other";
}

export type BBox = [number, number, number, number];   // s, w, n, e

export function routeBBox(pts: readonly LatLon[]): BBox {
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  for (const p of pts) {
    if (p[0] < s) s = p[0];
    if (p[0] > n) n = p[0];
    if (p[1] < w) w = p[1];
    if (p[1] > e) e = p[1];
  }
  return [s, w, n, e];
}

function bboxContains(outer: number[], inner: BBox): boolean {
  return inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];
}

export interface HazardCache {
  meta: { bbox: number[]; generated?: string; [k: string]: unknown };
  hazards: { type: string; lat: number; lon: number }[];
}

export interface Hazard { type: string; km: number; offset_m: number; turn?: string | null; confidence?: string | null; note?: string | null }

export interface L3 {
  distance_km: number;
  hazards: Hazard[];
  available: boolean;
  source?: string;
  cache_generated?: string | null;
  note?: string;
  per_km_hazards?: { km: number; count: number }[];
  summary?: Record<string, number>;
  priority_note?: string;
}

function snapCachedHazards(cache: HazardCache, pts: RoutePt[], cum: number[], radiusM = 30): Hazard[] {
  const [s, w, n, e] = routeBBox(pts);
  const m = radiusM / 111000.0 + 0.001;
  const out: Hazard[] = [];
  for (const h of cache.hazards || []) {
    const la = h.lat;
    const lo = h.lon;
    if (!(s - m <= la && la <= n + m && w - m <= lo && lo <= e + m)) continue;
    const [km, dist] = nearestKm(la, lo, pts, cum);
    if (dist <= radiusM) out.push({ type: h.type, km, offset_m: dist });
  }
  return out;
}

function dedupeAndSummarize(result: L3, hazards: Hazard[], totalKm: number): L3 {
  sortBy(hazards, (h) => [h.km, h.type]);
  const deduped: Hazard[] = [];
  for (const h of hazards) {
    const prev = deduped[deduped.length - 1];
    if (prev && h.type === prev.type && Math.abs(h.km - prev.km) < 0.04) continue;
    deduped.push(h);
  }
  result.hazards = deduped;
  const nKm = Math.max(1, Math.ceil(totalKm));
  const perKm = new Array<number>(nKm).fill(0);
  for (const h of deduped) perKm[Math.min(Math.trunc(h.km), nKm - 1)] += 1;
  result.per_km_hazards = perKm.map((c, i) => ({ km: i + 1, count: c }));
  const counts: Record<string, number> = {};
  for (const h of deduped) counts[h.type] = (counts[h.type] || 0) + 1;
  result.summary = counts;
  return result;
}

/**
 * osm_enrich.enrich with priority=False (the app never runs the live turn-
 * priority analysis). liveTimeoutS bounds each Overpass mirror so a request
 * stays inside the function time limit.
 */
export async function enrich(pts: RoutePt[], cache: HazardCache | null, opts: { useCache?: boolean; liveTimeoutS?: number } = {}): Promise<L3> {
  const useCache = opts.useCache ?? true;
  if (pts.length < 2) throw new GpxError("GPX contains fewer than 2 track/route points");
  const cum = cumdist(pts);
  const totalKm = cum[cum.length - 1] / 1000;
  const result: L3 = { distance_km: pyRound(totalKm, 2), hazards: [], available: false };
  let hazards: Hazard[] = [];
  let gotBase = false;

  if (useCache && cache && bboxContains(cache.meta.bbox, routeBBox(pts))) {
    result.available = true;
    result.source = "regional_cache";
    result.cache_generated = (cache.meta.generated as string | undefined) ?? null;
    hazards = snapCachedHazards(cache, pts, cum);
    gotBase = true;
  }

  if (!gotBase) {
    const route = downsample(pts, cum, 100.0);
    let raw: { elements?: OverpassElement[] };
    try {
      raw = await runOverpass(buildQuery(route), opts.liveTimeoutS ?? 95);
    } catch (e) {
      result.note = `OSM enrichment unavailable (${errName(e)}); proceeding without junction data.`;
      return result;
    }
    result.available = true;
    result.source = "live_overpass";
    for (const el of raw.elements || []) {
      let lat: number;
      let lon: number;
      if (el.lat !== undefined && el.lon !== undefined) {
        lat = el.lat;
        lon = el.lon;
      } else if (el.center) {
        lat = el.center.lat;
        lon = el.center.lon;
      } else continue;
      const [km, dist] = nearestKm(lat, lon, pts, cum);
      hazards.push({ type: classify(el), km, offset_m: dist });
    }
  }
  return dedupeAndSummarize(result, hazards, totalKm);
}
