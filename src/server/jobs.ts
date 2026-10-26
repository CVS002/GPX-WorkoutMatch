/**
 * Maintenance jobs (jobs.py): the one-click cache rebuilds.
 *
 * The Python ran each builder as a subprocess thread with an in-memory log.
 * Here a job is a record in the "jobs" store; the API creates it and hands it to
 * the maint-background function (15 min limit), which streams log lines into
 * the record the UI polls. Long jobs save their progress and re-invoke
 * themselves before the limit, so a first two-year history download completes
 * across several invocations.
 */
import seedWorkoutRides from "../../engine/data/cache/workout_rides.json" with { type: "json" };
import { encodeRide } from "../lib/gpx.js";
import { buildEffortDb } from "../engine/build/effortDb.js";
import { buildOsmCache, buildStreetCache, homeBBox } from "../engine/build/osmCaches.js";
import { buildRoadDb, type BuildIO } from "../engine/build/roadDb.js";
import { buildWorkoutBank } from "../engine/build/workoutBank.js";
import type { HazardCache } from "../engine/osm.js";
import type { EffortDb, RoadDb } from "../engine/score.js";
import { pyRepr } from "../lib/py.js";
import { cfg, localDate, localNow } from "./config.js";
import * as icu from "./icu.js";
import { loadRide, mapLimit, refreshIndex } from "./rides.js";
import { cachedJSON, getJSON, kv, putCacheJSON, setJSON } from "./store.js";

/** Dense basemap: arterial + residential + cycling infrastructure. */
const STREET_CLASSES = "primary,secondary,tertiary,unclassified,residential,living_street,cycleway,track,path";

export const COMMANDS: Record<string, [string, string]> = {
  road_db: ["Rebuild road-knowledge DB", "build_road_db.py data/history"],
  effort_db: ["Rebuild effort-corridor DB", "build_effort_db.py data/history"],
  osm_hazards: ["Rebuild OSM hazard cache (60 km)", "build_osm_cache.py --radius-km 60"],
  streets: ["Rebuild dense street basemap", `build_street_cache.py --classes ${STREET_CLASSES}`],
  bank: ["Refresh workout bank", "build_workout_bank.py"],
};
const HISTORY_LABEL = (days: number) => `Refresh ride history (${days} d) + rebuild road/effort DB`;

const KEEP_JOBS = 10;
/** Background functions are cut at 15 min; chain onwards after 12. */
const BUDGET_MS = 12 * 60 * 1000;
const HARD_LIMIT_MS = 15.5 * 60 * 1000;

export interface JobState { phase: string; rides?: [string, string | null][]; i?: number; got?: number; skipped?: number }

export interface Job {
  id: string; label: string; status: "running" | "done" | "error"; log: string[];
  started: string; finished: string | null; error: string | null;
  kind: string; nonce: string; deadline: number; state?: JobState;
}

const publicJob = ({ id, label, status, log, started, finished, error }: Job) => ({ id, label, status, log, started, finished, error });

/** Newest first; running jobs past their hard deadline are reported as failed. */
export async function status() {
  const keys = (await kv("jobs").list()).map((b) => b.key).sort().reverse();
  const jobs: Job[] = [];
  for (const k of keys.slice(0, KEEP_JOBS)) {
    const j = await getJSON<Job>("jobs", k);
    if (!j) continue;
    if (j.status === "running" && Date.now() > j.deadline) {
      j.status = "error";
      j.error = "stopped: the background function hit its 15-minute limit — run it again to continue";
      j.finished = localNow();
      await setJSON("jobs", k, j);
    }
    jobs.push(j);
  }
  return jobs.map(publicJob);
}

async function newJob(kind: string, label: string): Promise<Job> {
  const id = `job${Date.now().toString(36).padStart(9, "0")}`;
  const job: Job = {
    id, label, status: "running", log: [], started: localNow(), finished: null, error: null,
    kind, nonce: crypto.randomUUID(), deadline: Date.now() + HARD_LIMIT_MS,
  };
  await setJSON("jobs", id, job);
  const old = (await kv("jobs").list()).map((b) => b.key).sort().reverse().slice(KEEP_JOBS);
  await Promise.all(old.map((k) => kv("jobs").delete(k)));
  return job;
}

/** Headers that let an internal call pass the site's own access control. */
export type FwdHeaders = Record<string, string>;

export type Invoke = (body: { jid: string; nonce: string; fwd: FwdHeaders }) => Promise<void>;

export async function start(kind: string, invoke: Invoke, fwd: FwdHeaders): Promise<string> {
  if (!(kind in COMMANDS)) throw new RangeError(`unknown job kind: ${kind}`);
  const job = await newJob(kind, COMMANDS[kind][0]);
  await invoke({ jid: job.id, nonce: job.nonce, fwd });
  return job.id;
}

export async function startHistoryRefresh(invoke: Invoke, fwd: FwdHeaders, days = 760): Promise<string> {
  const job = await newJob("history", HISTORY_LABEL(days));
  await invoke({ jid: job.id, nonce: job.nonce, fwd });
  return job.id;
}

// ------------------------------------------------------------ the runner ---

class Runner {
  private dirty = false;
  private lastFlush = 0;
  constructor(public job: Job, private t0: number) {}

  async log(line: string) {
    for (const l of String(line).split("\n")) this.job.log.push(l.replace(/\s+$/, ""));
    this.dirty = true;
    if (Date.now() - this.lastFlush > 1500) await this.flush();
  }

  async flush() {
    if (!this.dirty) return;
    this.dirty = false;
    this.lastFlush = Date.now();
    await setJSON("jobs", this.job.id, this.job);
  }

  overBudget = () => Date.now() - this.t0 > BUDGET_MS;

  async finish(error: string | null = null) {
    this.job.status = error ? "error" : "done";
    this.job.error = error;
    this.job.finished = localNow();
    delete this.job.state;
    this.dirty = true;
    await this.flush();
  }
}

const errText = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

async function historyKeys(): Promise<string[]> {
  return (await kv("history").list()).map((b) => b.key);
}

function workoutIds(): Set<string> {
  return new Set(Object.keys((seedWorkoutRides as { rides?: Record<string, unknown> }).rides || {}));
}

function io(r: Runner, keys: string[]): BuildIO {
  return { keys, load: loadRide, log: (l) => r.log(l), shouldYield: r.overBudget };
}

/** One builder step as the Python _run_cmd did it: returns 0 on success. */
async function runRoadDb(r: Runner): Promise<number | "yield"> {
  const existing = await getJSON<RoadDb>("cache", "road_db.json");
  const { cache, complete } = await buildRoadDb(existing, workoutIds(), io(r, await historyKeys()));
  await putCacheJSON("road_db.json", cache);
  return complete ? 0 : "yield";
}

async function runEffortDb(r: Runner): Promise<number | "yield"> {
  const existing = await getJSON<EffortDb>("cache", "effort_db.json");
  const grid = (await cachedJSON<RoadDb>("road_db.json"))?.meta ?? null;
  const { cache, complete } = await buildEffortDb(existing, grid, io(r, await historyKeys()));
  await putCacheJSON("effort_db.json", cache);
  return complete ? 0 : "yield";
}

async function runSingle(r: Runner, kind: string): Promise<number | "yield"> {
  const tz = cfg.APP_TZ;
  switch (kind) {
    case "road_db":
      return runRoadDb(r);
    case "effort_db":
      return runEffortDb(r);
    case "osm_hazards": {
      const db = await cachedJSON<RoadDb>("road_db.json");
      if (!db) throw new Error("No such file or directory: 'road_db.json' — run “Refresh ride history” first");
      await putCacheJSON("osm_hazards.json", await buildOsmCache(db, 60.0, tz, (l) => r.log(l)));
      return 0;
    }
    case "streets": {
      let bbox: number[] | null = null;
      const haz = await cachedJSON<HazardCache>("osm_hazards.json");
      if (haz) {
        bbox = haz.meta.bbox;
        await r.log("using hazard-cache bbox from osm_hazards.json");
      } else {
        const db = await cachedJSON<RoadDb>("road_db.json");
        if (!db) throw new Error("No such file or directory: 'road_db.json' — run “Refresh ride history” first");
        bbox = homeBBox(db, 40.0)[2];
      }
      await putCacheJSON("osm_streets.json", await buildStreetCache(bbox, STREET_CLASSES.split(","), tz, (l) => r.log(l)));
      return 0;
    }
    case "bank":
      await putCacheJSON("workout_bank.json", await buildWorkoutBank((l) => r.log(l), tz));
      return 0;
  }
  throw new RangeError(`unknown job kind: ${kind}`);
}

/** start_history_refresh: download recent rides, then rebuild road + effort DBs. */
async function runHistory(r: Runner, days = 760, maxRides = 1200): Promise<"yield" | void> {
  const st: JobState = r.job.state ?? { phase: "list" };
  r.job.state = st;
  if (st.phase === "list") {
    try {
      await r.log(`listing activities (last ${days} d)...`);
      const acts = await icu.recentActivities(days);
      const rides = acts.filter((a) => a.type === "Ride" && (a.distance || a.distance_meters)).slice(0, maxRides);
      await r.log(`${rides.length} GPS rides to consider`);
      st.rides = rides.map((a) => [String(a.id), (a.start_date_local || a.start_date || null) as string | null]);
      Object.assign(st, { phase: "download", i: 0, got: 0, skipped: 0 });
    } catch (e) {
      await r.finish(`history download failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
  }
  if (st.phase === "download") {
    const have = new Set(await historyKeys());
    const rides = st.rides || [];
    while ((st.i as number) < rides.length) {
      if (r.overBudget()) return "yield";
      const batch = rides.slice(st.i, (st.i as number) + 8);
      await mapLimit(batch, 4, async ([aid, start]) => {
        if (have.has(aid)) {
          st.skipped = (st.skipped as number) + 1;
          return;
        }
        try {
          const rec = await icu.downloadRide(aid, start);
          await kv("history").setBytes(aid, encodeRide(rec));
          st.got = (st.got as number) + 1;
          if ((st.got as number) % 10 === 0) await r.log(`  downloaded ${st.got}...`);
        } catch (e) {
          await r.log(`  skip ${aid}: ${e instanceof Error ? (e.name === "Error" ? "HTTPStatusError" : e.name) : "Error"}`);
        }
      });
      st.i = (st.i as number) + batch.length;
    }
    await r.log(`downloaded ${st.got}, already had ${st.skipped}`);
    st.rides = undefined;
    st.phase = "road_db";
    await r.log(`$ ${COMMANDS.road_db[1]}`);
  }
  if (st.phase === "road_db") {
    if ((await runRoadDb(r)) === "yield") return "yield";
    st.phase = "effort_db";
    await r.log(`$ ${COMMANDS.effort_db[1]}`);
  }
  if (st.phase === "effort_db") {
    if ((await runEffortDb(r)) === "yield") return "yield";
    st.phase = "index";
    await r.log("indexing rides for the past-ride overlays...");
  }
  if (st.phase === "index") {
    const { complete, total } = await refreshIndex(() => r.overBudget());
    if (!complete) return "yield";
    await r.log(`ride index: ${total} rides`);
  }
  await r.finish(null);
}

/**
 * Background entry point. Verifies the nonce, runs (or resumes) the job, and
 * re-invokes itself with the saved state when the time budget runs out. Never
 * throws: a thrown error would make Netlify retry the whole job.
 */
export async function run(body: { jid: string; nonce: string; fwd: FwdHeaders }, invoke: Invoke): Promise<void> {
  const job = await getJSON<Job>("jobs", body.jid);
  if (!job || job.nonce !== body.nonce || job.status !== "running") return;
  job.deadline = Date.now() + HARD_LIMIT_MS;
  const r = new Runner(job, Date.now());
  await r.flush();
  try {
    let res: number | "yield" | void;
    if (job.kind === "history") {
      res = await runHistory(r);
    } else {
      if (!job.state) {
        job.state = { phase: "run" };
        await r.log(`$ ${COMMANDS[job.kind][1]}`);
      }
      res = await runSingle(r, job.kind);
      if (res !== "yield") await r.finish(res === 0 ? null : `exit code ${res}`);
    }
    if (res === "yield") {
      await r.log("  (continuing in a fresh background invocation...)");
      await r.flush();
      await invoke(body);
    }
  } catch (e) {
    await r.log(`error: ${errText(e)}`);
    await r.finish(job.kind === "history" ? "a rebuild step failed" : "exit code 1");
  }
}

// ------------------------------------------------------------ dossier (L4) ---
/** Append athlete-confirmed road corrections ("I ride through this"). */
export async function appendKnownRoads(entries: { km: number; note?: string }[]): Promise<void> {
  if (!entries.length) return;
  const key = "known-roads-corrections.md";
  const prev = (await kv("cache").getText(key))?.data ?? "";
  const lines = [`\n### App corrections ${localDate()}\n`];
  for (const e of entries) lines.push(`- km ${pyRepr(e.km)}: ${e.note ?? "I ride through this / not a real stop"}`);
  await kv("cache").setText(key, prev + lines.join("\n") + "\n");
}
