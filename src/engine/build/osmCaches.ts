/**
 * Layer 3 (build): regional OSM hazard cache (build_osm_cache.py) and street
 * basemap cache (build_street_cache.py) around the athlete's home area.
 */
import { haversineM } from "../../lib/geo.js";
import { pyFixed, pyRound } from "../../lib/py.js";
import { classify, runOverpass, type HazardCache, type OverpassElement } from "../osm.js";
import type { RoadDb } from "../score.js";
import type { StreetCache } from "../mapwidget.js";
import { wayKind } from "../mapwidget.js";

type Log = (line: string) => void | Promise<void>;

/** Densest ride cluster in the road DB → [home_lat, home_lon, bbox, n_cells]. */
export function homeBBox(db: RoadDb, radiusKm: number): [number, number, [number, number, number, number], number] {
  const cl = db.meta.cell_lat;
  const co = db.meta.cell_lon;
  const cells: [number, number, number][] = [];
  for (const [key, v] of Object.entries(db.cells)) {
    const [i, j] = key.split(",");
    cells.push([parseInt(i, 10) * cl, parseInt(j, 10) * co, v[0] as number]);
  }
  if (!cells.length) throw new Error("road DB has no cells; build_road_db.py first");
  const BIN = 0.05;
  const hist = new Map<string, [number, number, number]>();
  for (const [la, lo, p] of cells) {
    const a = pyRound(la / BIN);
    const b = pyRound(lo / BIN);
    const k = `${a},${b}`;
    const h = hist.get(k);
    if (h) h[2] += p;
    else hist.set(k, [a, b, p]);
  }
  let best: [number, number, number] | null = null;
  for (const h of hist.values()) if (best === null || h[2] > best[2]) best = h;
  const homeLat = (best as [number, number, number])[0] * BIN;
  const homeLon = (best as [number, number, number])[1] * BIN;
  const cosH = Math.cos(homeLat * (Math.PI / 180));
  const kept = cells.filter(([la, lo]) => Math.hypot((la - homeLat) * 111.0, (lo - homeLon) * 111.0 * cosH) <= radiusKm);
  if (!kept.length) throw new Error("min() arg is an empty sequence");
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  for (const [la, lo] of kept) {
    if (la < s) s = la;
    if (la > n) n = la;
    if (lo < w) w = lo;
    if (lo > e) e = lo;
  }
  return [homeLat, homeLon, [s - cl, w - co, n + cl, e + co], kept.length];
}

const fmt5 = (b: number[]) => b.map((x) => pyFixed(x, 5)).join(",");

function localDate(tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export async function buildOsmCache(db: RoadDb, radiusKm: number, tz: string, log: Log): Promise<HazardCache> {
  const [homeLat, homeLon, bbox, nCells] = homeBBox(db, radiusKm);
  const [s, w, n, e] = bbox;
  const hkm = (n - s) * 111.0;
  const wkm = (e - w) * 111.0 * Math.cos(((s + n) / 2) * (Math.PI / 180));
  await log(`home ~ ${pyFixed(homeLat, 3)},${pyFixed(homeLon, 3)}  bbox ${pyFixed(wkm, 0)}x${pyFixed(hkm, 0)} km  `
    + `lat[${pyFixed(s, 4)},${pyFixed(n, 4)}] lon[${pyFixed(w, 4)},${pyFixed(e, 4)}]`);
  const b = fmt5(bbox);
  const q = `[out:json][timeout:180];
(
  node[highway=traffic_signals](${b});
  node[railway=level_crossing](${b});
  node[highway=mini_roundabout](${b});
  node[highway=give_way](${b});
  node[highway=stop](${b});
  way[junction=roundabout](${b});
);
out center;
`;
  const raw = await runOverpass(q, 185, 2);
  const hazards: { type: string; lat: number; lon: number }[] = [];
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
    hazards.push({ type: classify(el), lat: pyRound(lat, 6), lon: pyRound(lon, 6) });
  }
  const counts: Record<string, number> = {};
  for (const h of hazards) counts[h.type] = (counts[h.type] || 0) + 1;
  const out: HazardCache = {
    meta: {
      version: 1, home: [pyRound(homeLat, 5), pyRound(homeLon, 5)], radius_km: radiusKm,
      bbox: bbox.map((x) => pyRound(x, 5)), generated: localDate(tz),
      source: "OpenStreetMap via Overpass API", home_cells: nCells, counts,
    },
    hazards,
  };
  const summ = Object.keys(counts).sort().map((k) => `${counts[k]} ${k}`).join(", ");
  await log(`OSM cache: ${hazards.length} hazards (${summ}) -> osm_hazards.json`);
  return out;
}

function decimate(geom: { lat: number; lon: number }[], stepM: number): number[][] {
  const poly = [[pyRound(geom[0].lat, 5), pyRound(geom[0].lon, 5)]];
  let acc = 0.0;
  for (let i = 1; i < geom.length; i++) {
    acc += haversineM(geom[i - 1].lat, geom[i - 1].lon, geom[i].lat, geom[i].lon);
    if (acc >= stepM) {
      poly.push([pyRound(geom[i].lat, 5), pyRound(geom[i].lon, 5)]);
      acc = 0.0;
    }
  }
  const last = [pyRound(geom[geom.length - 1].lat, 5), pyRound(geom[geom.length - 1].lon, 5)];
  const pl = poly[poly.length - 1];
  if (pl[0] !== last[0] || pl[1] !== last[1]) poly.push(last);
  return poly;
}

/**
 * The Python fetched the whole box in one Overpass query; a dense 120 km box
 * returns hundreds of MB, more than a function can hold. Here the box is
 * queried in ~25 km tiles, ways crossing tile edges are de-duplicated by id and
 * the result is put back in id order — the same ways, in the same order, as the
 * single query (Overpass returns full way geometry and sorts by id).
 */
export async function buildStreetCache(bbox: number[], classes: string[], tz: string, log: Log,
                                       stepM = 40.0, tileKm = 25): Promise<StreetCache> {
  const [s, w, n, e] = bbox;
  const wkm = (e - w) * 111.0 * Math.cos(((s + n) / 2) * (Math.PI / 180));
  const hkm = (n - s) * 111.0;
  await log(`box ${pyFixed(wkm, 0)}x${pyFixed(hkm, 0)} km  classes=[${classes.map((c) => `'${c}'`).join(", ")}]`);
  const cls = classes.join("|");
  const nx = Math.max(1, Math.ceil(wkm / tileKm));
  const ny = Math.max(1, Math.ceil(hkm / tileKm));
  const byId = new Map<number, { c: string; k: string; g: number[][] }>();
  let anon = -1;
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const ts = s + ((n - s) * iy) / ny;
      const tn = iy === ny - 1 ? n : s + ((n - s) * (iy + 1)) / ny;
      const tw = w + ((e - w) * ix) / nx;
      const te = ix === nx - 1 ? e : w + ((e - w) * (ix + 1)) / nx;
      const q = `[out:json][timeout:180];way[highway~"^(${cls})(_link)?$"](${fmt5([ts, tw, tn, te])});out geom;`;
      const raw = await runOverpass(q, 185, 2);
      for (const el of (raw.elements || []) as OverpassElement[]) {
        const g = el.geometry;
        if (!g || g.length < 2) continue;
        const id = el.id ?? anon--;
        if (byId.has(id)) continue;
        const tags = el.tags || {};
        byId.set(id, { c: tags.highway || "road", k: wayKind(tags), g: decimate(g, stepM) });
      }
      await log(`  tile ${iy * nx + ix + 1}/${nx * ny}: ${byId.size} ways so far`);
    }
  }
  const ways = [...byId.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  let npts = 0;
  let ncycle = 0;
  for (const wy of ways) {
    npts += wy.g.length;
    if (wy.k === "cycle") ncycle++;
  }
  const payload: StreetCache = {
    meta: { version: 2, bbox: bbox.map((x) => pyRound(x, 5)), generated: localDate(tz), classes, step_m: stepM,
            count_ways: ways.length, count_pts: npts, source: "OpenStreetMap via Overpass API" },
    ways,
  };
  const mb = JSON.stringify(payload).length / 1e6;
  await log(`street cache: ${ways.length} ways (${ncycle} cycle), ${npts} pts, ${pyFixed(mb, 2)} MB -> osm_streets.json`);
  return payload;
}
