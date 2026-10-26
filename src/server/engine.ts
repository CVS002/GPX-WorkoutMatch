/**
 * Thin wrappers over the analysis engine (server/engine.py): load the caches
 * from Blobs, call the layer, hand back plain objects.
 */
import seedBank from "../../engine/data/cache/workout_bank.json" with { type: "json" };
import { cumdist } from "../lib/geo.js";
import type { RoutePt } from "../lib/gpx.js";
import { pyFloat, pyFmtG, pyRound } from "../lib/py.js";
import type { L1 } from "../engine/analyze.js";
import { buildCandidates, computeEffort, placementBlocks, type Candidate, type CorridorRec, type KmMap, type PBlock } from "../engine/mapwidget.js";
import { enrich, type HazardCache, type L3 } from "../engine/osm.js";
import { score, scoreEffort, type EffortDb, type L2, type L5, type RoadDb } from "../engine/score.js";
import { pick, selectCategory } from "../engine/suggest.js";
import type { BankWorkout } from "../engine/windows.js";
import { cfg } from "./config.js";
import { cachedJSON } from "./store.js";

const pyErr = (e: unknown) => `${e instanceof Error ? (e.name === "Error" ? "Exception" : e.name) : "Exception"}: ${e instanceof Error ? e.message : String(e)}`;

export async function bank(): Promise<BankWorkout[]> {
  const b = await cachedJSON<{ workouts?: BankWorkout[] }>("workout_bank.json");
  return (b ?? (seedBank as { workouts?: BankWorkout[] })).workouts ?? [];
}

/** Layer 2 — None without a road cache; {error} if scoring throws. */
export async function scoreRoads(pts: RoutePt[]): Promise<L2 | { error: string } | null> {
  const db = await cachedJSON<RoadDb>("road_db.json");
  if (!db) return null;
  try {
    return score(pts, db);
  } catch (e) {
    return { error: pyErr(e) };
  }
}

/** Layer 5 — None without an effort cache. */
export async function scoreEffortLayer(pts: RoutePt[]): Promise<L5 | { error: string } | null> {
  const db = await cachedJSON<EffortDb>("effort_db.json");
  if (!db) return null;
  try {
    return scoreEffort(pts, db);
  } catch (e) {
    return { error: pyErr(e) };
  }
}

/**
 * Layer 3 — OSM hazards, cache first; degrades to {available: false}. A live
 * Overpass fallback is bounded (2 mirrors x 18 s) to fit the request limit.
 */
export async function enrichOsm(pts: RoutePt[]): Promise<L3> {
  try {
    const cache = await cachedJSON<HazardCache>("osm_hazards.json");
    return await enrich(pts, cache, { useCache: true, liveTimeoutS: 18 });
  } catch (e) {
    return { distance_km: 0, available: false, hazards: [], note: pyErr(e) } as L3;
  }
}

export async function rankObjectives(tsb: number, phase: string, last: string | null, terrain: string, routeKm: number) {
  const [top, cand, reason] = selectCategory(tsb, phase, last, terrain);
  const minutes = (routeKm / cfg.REF_SPEED_KMH) * 60;
  const b = await bank();
  const candidates = cand.map((cat) => {
    const w = pick(b, cat, minutes, 0);
    return {
      objective: cat,
      seed: w ? { name: w.name ?? null, plan: w.plan ?? "", structure: w.structure ?? null, duration_min: w.duration_min ?? null } : null,
    };
  });
  return { top, reason, candidates };
}

export async function bankCandidates(routeKm: number): Promise<Record<string, Candidate[]>> {
  return buildCandidates(await bank(), routeKm);
}

const CAT_ORDER = ["vo2max", "threshold", "sweetspot", "tempo", "anaerobic", "sprint", "endurance"];

function midPct(pct: unknown): number | string {
  const s = String(pct);
  if (s.includes("-")) {
    const i = s.indexOf("-");
    const lo = pyFloat(s.slice(0, i));
    const hi = pyFloat(s.slice(i + 1));
    if (lo === null || hi === null) return s;           // float() raised → keep the text
    return pyRound((lo + hi) / 2);
  }
  return s;
}

/** Flat, ordered, search-ready workout list for the picker. */
export async function listWorkouts(routeKm: number) {
  const cands = await bankCandidates(routeKm);
  const out: Record<string, unknown>[] = [];
  for (const cat of CAT_ORDER) {
    (cands[cat] || []).forEach((c, i) => {
      const name = c.name || cat;
      const plan = c.plan ?? "";
      const tokens: string[] = [cat, name, plan];
      let structure: string;
      let body: number;
      if (c.steady) {
        structure = "Steady Z2 endurance";
        body = pyRound(c.body_min ?? (routeKm / cfg.REF_SPEED_KMH) * 60);
        tokens.push("steady", "z2", "endurance");
      } else {
        const reps = c.reps;
        const wm = c.work_min as number;
        const wmS = wm && Math.abs(wm - pyRound(wm)) < 0.05 ? `${Math.trunc(wm)}` : pyFmtG(wm);
        structure = `${reps}× ${wmS}min @ ${midPct(c.work_pct)}% FTP`;
        body = pyRound(c.body_min ?? 0);
        tokens.push(structure, `${reps}x${wmS}`, `${reps}x${wmS}min`, `${wmS}min`);
      }
      out.push({
        id: `${cat}:${i}`, category: cat, index: i, name, plan, structure,
        reps: c.reps ?? null, work_min: c.work_min ?? null, body_min: body,
        search: tokens.join(" ").toLowerCase(),
      });
    });
  }
  return out;
}

export async function getWorkout(routeKm: number, category: string, index: number): Promise<Candidate | null> {
  const cands = (await bankCandidates(routeKm))[category] || [];
  return index >= 0 && index < cands.length ? cands[index] : null;
}

export interface Stop { km: number; pos: number[]; stop_rate?: number; passes?: number }
export interface Haz { km: number; t: string; pos: number[]; c: string | null; turn: string | null }
export interface Comp {
  scores: number[]; blocks: PBlock[]; cont: KmMap<number>; grad: KmMap<number>; qual: KmMap<string>;
  stops: Stop[]; haz: Haz[]; corridor: KmMap<CorridorRec>; nkm: number;
}

/** Fuse all layers into the per-km effort score and ranked placement blocks. */
export function compositeScores(pts: RoutePt[], l1: L1, l2: L2 | { error: string } | null, l3: L3 | null,
                                l5: L5 | { error: string } | null, clearedKm: number[] = []): Comp {
  const cum = cumdist(pts);
  const nkm = Math.max(1, Math.ceil(cum[cum.length - 1] / 1000));
  const ptAtKm = (k: number) => {
    const m = k * 1000;
    for (let i = 0; i < cum.length; i++) if (cum[i] >= m) return [pyRound(pts[i][0], 5), pyRound(pts[i][1], 5)];
    return [pyRound(pts[pts.length - 1][0], 5), pyRound(pts[pts.length - 1][1], 5)];
  };
  const qual: KmMap<string> = {};
  let stops: Stop[] = [];
  if (l2 && "per_km_road_quality" in l2) {
    for (const q of l2.per_km_road_quality) qual[q.km] = q.quality;
    stops = l2.stop_hotspots.map((h) => ({ km: pyRound(h.km, 2), pos: ptAtKm(h.km), stop_rate: h.stop_rate, passes: h.passes }));
  }
  let haz: Haz[] = [];
  if (l3 && l3.available) {
    haz = l3.hazards.map((h) => ({ km: pyRound(h.km, 2), t: h.type, pos: ptAtKm(h.km), c: h.confidence ?? null, turn: h.turn ?? null }));
  }
  const corridor: KmMap<CorridorRec> = {};
  if (l5 && "per_km_effort" in l5) for (const r of l5.per_km_effort) corridor[r.km] = r;
  if (clearedKm.length) {
    const keep = (k: number) => clearedKm.every((c) => Math.abs(k - c) > 0.2);
    haz = haz.filter((h) => keep(h.km));
    stops = stops.filter((s) => keep(s.km));
  }
  const { scores, cont, grad } = computeEffort(l1, qual, haz, stops, nkm, corridor);
  const blocks = placementBlocks(l1, scores, grad, nkm);
  return { scores, blocks, cont, grad, qual, stops, haz, corridor, nkm };
}

// ------------------------------------------------------------ recent load ---
function zone(ifPct: number | null): string {
  if (ifPct === null) return "?";
  if (ifPct < 60) return "recovery";
  if (ifPct < 76) return "endurance";
  if (ifPct < 88) return "tempo/SS";
  if (ifPct < 95) return "threshold-";
  return "hard";
}

type Act = Record<string, unknown>;
const field = (a: Act, ...names: string[]) => {
  for (const n of names) if (a[n] !== null && a[n] !== undefined) return a[n];
  return null;
};
const ordinal = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map((x) => parseInt(x, 10));
  return Date.UTC(y, m - 1, d) / 86400000;
};

/** Compact 14-day load/recency summary for the context panel and ranking. */
export function summarizeLoad(activities: Act[], days = 14) {
  const dateOf = (a: Act) => String(a.start_date_local || a.start_date || "");
  const acts = activities.filter((a) => dateOf(a));
  acts.sort((a, b) => (dateOf(a) < dateOf(b) ? 1 : dateOf(a) > dateOf(b) ? -1 : 0));
  if (!acts.length) {
    return { rows: [], load7: 0, load14: 0, last_quality_days: null, last_stimulus: null, headroom: true };
  }
  const newest = ordinal(dateOf(acts[0]).slice(0, 10));
  const cutoff = newest - days;
  const rows: Record<string, unknown>[] = [];
  let load7 = 0.0;
  let load14 = 0.0;
  const hard: number[] = [];
  for (const a of acts) {
    const dd = dateOf(a).slice(0, 10);
    const o = ordinal(dd);
    if (o < cutoff) break;
    const age = newest - o;
    const load = (field(a, "icu_training_load", "training_load", "power_load") as number) || 0;
    const ifp = field(a, "icu_intensity", "intensity_factor") as number | null;
    const moving = (field(a, "moving_time", "moving_time_seconds") as number) || 0;
    const z = zone(ifp);
    rows.push({
      age, date: dd, type: Object.hasOwn(a, "type") ? a.type : "?", min: pyRound(moving / 60), load: pyRound(load),
      if: ifp !== null ? pyRound(ifp) : null, stimulus: z, name: Object.hasOwn(a, "name") ? a.name : "",
    });
    load14 += load;
    if (age < 7) load7 += load;
    if ((z === "threshold-" || z === "hard") && ["Ride", "VirtualRide", "Run"].includes(a.type as string)) hard.push(age);
  }
  const lastQ = hard.length ? Math.min(...hard) : null;
  let lastStim: string | null = null;
  if (rows.length) {
    const top = rows[0].stimulus as string;
    lastStim = ({ "tempo/SS": "sweetspot", "threshold-": "threshold", hard: "vo2max" } as Record<string, string>)[top] ?? null;
  }
  return {
    rows, load7: pyRound(load7), load14: pyRound(load14), last_quality_days: lastQ,
    quality_days: hard.length, last_stimulus: lastStim, headroom: !hard.length,
  };
}
