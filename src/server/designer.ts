/**
 * Deterministic session designer (designer.py): pick a bank session for the
 * objective, reshape it to the route's clean blocks (gated by where YOUR rides
 * show you can hold the effort), assemble warm-up / bridges / cooldown with
 * lap-button padding, then render syntax + load estimate + evidence.
 */
import type { RoutePt } from "../lib/gpx.js";
import { cumdist } from "../lib/geo.js";
import { pyFixed, pyFmtG, pyRepr, pyRound, pySum, pyTitle, sortBy } from "../lib/py.js";
import { analyze, type L1 } from "../engine/analyze.js";
import type { Candidate, PBlock } from "../engine/mapwidget.js";
import type { L3 } from "../engine/osm.js";
import { CAT_WIN, REST_MIN, REST_PCT } from "../engine/windows.js";
import { cfg } from "./config.js";
import * as engine from "./engine.js";
import { overviews } from "./rides.js";
import { pctLoHi, totalWrittenKm, toSyntax, validate, validateBlank, type Issue, type Seg } from "./syntax.js";

const WARMUP_PCT = "55-75";
const BRIDGE_PCT = "62-68";
const ENDUR_PCT = "63-70";
const COOLDOWN_PCT = "55-60";
const SURGE_PCT = "82-88";

const TARGET_WORK_MIN: Record<string, number> = { vo2max: 15, threshold: 36, sweetspot: 45, tempo: 45, anaerobic: 8, sprint: 4, endurance: 0 };

const km = (minutes: number) => minutes * cfg.KM_PER_MIN;

type Block = PBlock | { start_km: number; end_km: number; len_km: number; score: number; fallback?: true };

function danger(comp: engine.Comp): number[] {
  return [...comp.stops.map((s) => s.km), ...comp.haz.filter((h) => h.t !== "right_before_left").map((h) => h.km)];
}

const realBlocks = (blocks: Block[], rkm: number) => blocks.filter((b) => b.len_km < 0.9 * rkm);

export type Session = Partial<Candidate> & { name?: string; category?: string; steady?: boolean };

function fallbackSession(cat: string): Session {
  const win = CAT_WIN[cat];
  if (!win) return { name: "Steady Z2", category: "endurance", steady: true, work_pct: ENDUR_PCT };
  const workMin = pyRound((win.work[0] + win.work[1]) / 2, 1);
  const reps = pyRound((win.reps[0] + win.reps[1]) / 2);
  const pct = pyRound((win.pct[0] + win.pct[1]) / 2);
  const restMin = REST_MIN[cat](workMin);
  return {
    name: `${cat} ${reps}x${pyFmtG(workMin)}min`, category: cat, reps, work_min: workMin,
    work_pct: `${pct - 2}-${pct + 2}`, rest_min: restMin, rest_pct: REST_PCT[cat],
    body_min: reps * workMin + (reps - 1) * restMin,
  };
}

async function chooseSession(cat: string, rkm: number, blocks: Block[]): Promise<Session> {
  const cands = (await engine.bankCandidates(rkm))[cat] || [];
  if (cat === "endurance") return cands.length ? cands[0] : fallbackSession(cat);
  if (!cands.length) return fallbackSession(cat);
  const real = realBlocks(blocks, rkm);
  const longest = real.length ? Math.max(...real.map((b) => b.len_km)) : rkm;
  const target = TARGET_WORK_MIN[cat] ?? 20;
  const fits = (c: Candidate) => km(c.work_min as number) <= longest + 0.5;
  const doseErr = (c: Candidate) => Math.abs((c.reps as number) * (c.work_min as number) - target);
  let pool = cands.filter(fits);
  if (!pool.length) pool = cands;
  sortBy(pool, (c) => [doseErr(c), -(c.reps as number)]);
  return pool[0];
}

/** Max whole efforts that fit in a block (work + inter-effort rests). */
function cap(block: Block, workKm: number, restKm: number): number {
  const avail = block.end_km - block.start_km;
  let r = 0;
  while ((r + 1) * workKm + r * restKm <= avail + 1e-6) r += 1;
  return r;
}

const overlap = (a: Block, b: Block) => !(a.end_km <= b.start_km || b.end_km <= a.start_km);

/** Groups [(block, reps)] — non-overlapping, in route order, at most 2. */
function planPlacement(blocks: Block[], rkm: number, reps: number, workKm: number, restKm: number): [Block, number][] {
  const real = realBlocks(blocks, rkm).filter((b) => b.end_km - b.start_km >= workKm * 0.9);
  const ranked = sortBy(real.slice(), (b) => [-b.score, -b.len_km]);
  for (const b of ranked) if (cap(b, workKm, restKm) >= reps) return [[b, reps]];
  const chosen: [Block, number][] = [];
  let placed = 0;
  for (const b of ranked) {
    if (chosen.length >= 2) break;
    if (chosen.some(([c]) => overlap(b, c))) continue;
    const r = Math.min(cap(b, workKm, restKm), reps - placed);
    if (r >= 1) {
      chosen.push([b, r]);
      placed += r;
    }
  }
  if (!chosen.length) {
    const base: Block = ranked.length ? ranked[0] : blocks.length ? blocks[0]
      : { start_km: 1, end_km: rkm, len_km: rkm, score: 40, fallback: true };
    return [[base, reps]];
  }
  if (placed < reps) chosen[chosen.length - 1][1] += reps - placed;
  sortBy(chosen, (x) => x[0].start_km);
  return chosen;
}

/** Nudge an effort's start forward off a danger km (bounded search). */
function avoidStart(a0: number, dng: number[]): number {
  let a = a0;
  let shifted = 0.0;
  while (dng.some((d) => Math.abs(a - d) <= 0.32) && shifted < 1.25) {
    a += 0.25;
    shifted += 0.25;
  }
  return pyRound(a, 2);
}

// ---- learned capability: where your own rides say you can hold the effort ----
export interface Capability { bin_km: number; spd: (number | null)[]; pwr: (number | null)[]; n_spd: number; n_pwr: number }

export async function capability(pts: RoutePt[]): Promise<Capability> {
  const ov = await overviews(pts, { speed: 33.0, power: 200.0 });
  const sp = ov.speed!;
  const pw = ov.power!;
  return { bin_km: sp.bin_km ?? 0.1, spd: sp.bins.map((b) => b.val), pwr: pw.bins.map((b) => b.val), n_spd: sp.n_rides, n_pwr: pw.n_rides };
}

function spdBar(c: Capability, pctl = 45): number | null {
  const svals = c.spd.filter((v): v is number => v !== null).sort((a, b) => a - b);
  if (!svals.length) return null;
  return svals[Math.min(svals.length - 1, Math.trunc((svals.length * pctl) / 100))];
}

function binSupported(c: Capability, k: number, targetW: number, spdThr: number | null): boolean {
  if (c.pwr[k] !== null) return (c.pwr[k] as number) >= targetW;
  return c.spd[k] !== null && spdThr !== null && (c.spd[k] as number) >= spdThr;
}

function blockSupport(block: Block, c: Capability, targetW: number, spdThr: number | null): [number, number] {
  const bk = c.bin_km;
  const n = c.spd.length;
  const k0 = Math.trunc(block.start_km / bk);
  const k1 = Math.trunc(block.end_km / bk);
  let tot = 0;
  let sup = 0;
  const margins: number[] = [];
  for (let k = Math.max(0, k0); k < Math.min(n, k1); k++) {
    tot += 1;
    if (binSupported(c, k, targetW, spdThr)) {
      sup += 1;
      if (c.pwr[k] !== null && targetW > 0) margins.push((c.pwr[k] as number) / targetW);
      else if (c.spd[k] !== null && spdThr) margins.push((c.spd[k] as number) / spdThr);
    }
  }
  const frac = tot ? sup / tot : 0.0;
  return [frac, margins.length ? pySum(margins) / margins.length : 0.0];
}

function applySupport(blocks: Block[], c: Capability | null, targetW: number, spdThr: number | null): [Block[], boolean] {
  if (!c || (!c.n_spd && !c.n_pwr)) return [blocks, false];
  const out = blocks.map((b) => {
    const [frac] = blockSupport(b, c, targetW, spdThr);
    return { ...b, hist_frac: pyRound(frac, 2), score: pyRound(frac * 100 + Math.min(9.0, (b.score ?? 0) / 12), 1) };
  });
  return [out, true];
}

function supportedFrac(segs: Seg[], c: Capability, targetW: number, thr: number | null): number {
  const bk = c.bin_km;
  const n = c.spd.length;
  let tot = 0.0;
  let sup = 0.0;
  for (const s of segs) {
    if (s.kind !== "work") continue;
    for (let k = Math.max(0, Math.trunc(s.a / bk)); k < Math.min(n, Math.trunc(s.b / bk) + 1); k++) {
      tot += 1;
      if (binSupported(c, k, targetW, thr)) sup += 1;
    }
  }
  return tot ? sup / tot : 0.0;
}

export interface RouteCtx { l1: L1; comp: engine.Comp; profile: number[][] | null }

/** Run all analysis layers for a route once (cached per session by the caller). */
export async function routeContext(pts: RoutePt[], l3: L3 | null, clearedKm: number[]): Promise<RouteCtx> {
  const l1 = analyze(pts);
  const [l2, l5] = await Promise.all([engine.scoreRoads(pts), engine.scoreEffortLayer(pts)]);
  const comp = engine.compositeScores(pts, l1, l2, l3, l5, clearedKm);
  return { l1, comp, profile: elevProfile(pts, l1) };
}

/** Downsampled [km, ele_m] pairs for the timeline backdrop; null without elevation. */
function elevProfile(pts: RoutePt[], l1: L1, n = 240): number[][] | null {
  if (!l1.has_elevation) return null;
  const cum = cumdist(pts);
  const total = cum[cum.length - 1];
  if (total <= 0) return null;
  const prof: number[][] = [];
  let j = 0;
  for (let k = 0; k <= n; k++) {
    const target = (total * k) / n;
    while (j < cum.length - 1 && cum[j] < target) j++;
    if (pts[j][2] !== null) prof.push([pyRound(cum[j] / 1000, 2), pyRound(pts[j][2] as number, 1)]);
  }
  return prof;
}

const SHORT: Record<string, string> = { vo2max: "VO2", threshold: "Thr", sweetspot: "SS", tempo: "Tempo", anaerobic: "Ana", sprint: "Sprint", endurance: "Surge" };
const shortName = (o: string) => SHORT[o] ?? "Effort";

function title(objective: string, sess: Session, reps: number, prefix = true): string {
  const label = ({ vo2max: "VO2max", threshold: "Threshold", sweetspot: "Sweet Spot", tempo: "Tempo", anaerobic: "Anaerobic",
                   sprint: "Sprint", endurance: "Endurance" } as Record<string, string>)[objective] ?? pyTitle(objective);
  let core: string;
  if (reps && sess.work_min) {
    const wm0 = sess.work_min;
    const wm = Math.abs(wm0 - pyRound(wm0)) < 0.05 ? `${Math.trunc(wm0)}min` : `${pyFmtG(wm0)}min`;
    core = `${label} ${reps}x${wm}`;
  } else {
    core = label;
  }
  return prefix ? `Prodrive 65 - ${core} v1` : core;
}

export function estimateLoad(segs: Seg[], _ftp: number, unit: "km" | "min" = "km") {
  let totH = 0.0;
  let acc = 0.0;
  for (const s of segs) {
    const span = s.b - s.a;
    const h = unit === "min" ? span / 60.0 : span / cfg.REF_SPEED_KMH;
    const [lo, hi] = pctLoHi(s.pct);
    const intensity = Math.min(1.25, (lo + hi) / 2 / 100.0);
    acc += intensity * intensity * h;
    totH += h;
  }
  // A negative mean square (segments with negative spans) made Python's
  // `** 0.5` complex and round() then raised — keep that failure identical.
  if (totH && acc / totH < 0) throw new TypeError("type complex doesn't define __round__ method");
  const ifEst = totH ? Math.sqrt(acc / totH) : 0.0;
  return { tss: pyRound(acc * 100), if: pyRound(ifEst, 2), minutes: pyRound(totH * 60) };
}

function evidence(segs: Seg[], comp: engine.Comp) {
  const { cont, qual, corridor } = comp;
  const out: { name: string; km: string; note: string }[] = [];
  for (const s of segs) {
    if (s.kind !== "work" && s.kind !== "tt") continue;
    const kms: number[] = [];
    for (let k = Math.trunc(s.a) + 1; k < Math.trunc(s.b) + 2; k++) kms.push(k);
    const cvals = kms.map((k) => cont[k]).filter((v) => v !== undefined && v !== null);
    const avgCont = cvals.length ? pyRound(pySum(cvals) / cvals.length) : null;
    const quals = kms.map((k) => qual[k] ?? "unknown");
    const clear = quals.filter((q) => q === "known-clear").length;
    const stop = quals.filter((q) => q === "known-stop").length;
    let corr = 0;
    const cv = kms.map((k) => corridor[k]?.avg_passes ?? 0);
    if (cv.length) corr = Math.max(...cv);
    const note: string[] = [];
    if (avgCont !== null) note.push(`continuity ${avgCont}`);
    if (clear) note.push(`ridden clean (${clear} km)`);
    if (stop) note.push(`${stop} known-stop km!`);
    if (corr >= 2) note.push(`corridor ${pyRound(corr)}x`);
    out.push({ name: s.name, km: `${pyRepr(pyRound(s.a, 1))}-${pyRepr(pyRound(s.b, 1))}`, note: note.join(", ") || "no history — geometry only" });
  }
  return out;
}

export type Design = Record<string, unknown> & {
  objective: string; title: string; segs: Seg[]; syntax: string; issues: Issue[];
  load_estimate: number; if_estimate: number; duration_min: number;
};

/**
 * Design a route workout. getCap lazily computes (or reads the session's
 * cached) learned capability — it scans the ride history, so it's only
 * fetched when an interval session actually needs placing.
 */
export async function design(ctx: RouteCtx, objective0: string, ftp: number, getCap: () => Promise<Capability>,
                             opts: { title?: string | null; session?: Session | null } = {}): Promise<Design> {
  let objective = objective0;
  if (opts.session) objective = opts.session.category ?? objective;
  const { l1, comp } = ctx;
  const rkm = l1.distance_km;
  const blocks: Block[] = comp.blocks;
  const dng = danger(comp);

  const sess: Session = opts.session || (await chooseSession(objective, rkm, blocks));
  let segs: Seg[] = [];
  let repNo = 0;
  const isSteady = Boolean(sess.steady) || !("reps" in sess) || sess.reps === undefined;
  let gated = false;
  let capb: Capability | null = null;
  let targetW = 0;
  let spdThr: number | null = null;
  let placed = 0;
  let reps = 0;
  let overflow = 0;
  let groups: [Block, number][] = [];

  if (objective === "endurance" && isSteady) {
    const wu = pyRound(Math.min(5.0, rkm * 0.08), 1);
    const cd = pyRound(Math.min(8.0, Math.max(4.0, rkm * 0.12)), 1);
    segs = [
      { name: "Warm-up", a: 0.0, b: wu, pct: WARMUP_PCT, kind: "warmup" },
      { name: "Endurance Z2", a: wu, b: pyRound(rkm - cd, 1), pct: ENDUR_PCT, kind: "rest" },
      { name: "Cooldown", a: pyRound(rkm - cd, 1), b: pyRound(rkm, 1), pct: COOLDOWN_PCT, kind: "cooldown" },
    ];
  } else {
    if (sess.reps === undefined) throw new Error("'reps'");
    reps = Math.trunc(sess.reps);
    const workKm = km(sess.work_min as number);
    const restKm = km(sess.rest_min ?? (sess.work_min as number));
    const workPct = objective !== "endurance" ? (sess.work_pct as string) : SURGE_PCT;
    const restPct = sess.rest_pct ?? BRIDGE_PCT;

    // Gate placement by learned capability (power where measured, else speed).
    const [lo, hi] = pctLoHi(workPct);
    targetW = ftp ? pyRound(((lo + hi) / 2 / 100.0) * ftp) : 0;
    capb = await getCap();
    spdThr = spdBar(capb);
    const [gateBlocks, g] = applySupport(blocks, capb, targetW, spdThr);
    gated = g;

    groups = planPlacement(gateBlocks, rkm, reps, workKm, restKm);
    placed = groups.reduce((t, [, r]) => t + r, 0);
    overflow = Math.max(0, groups[groups.length - 1][1] - cap(groups[groups.length - 1][0], workKm, restKm));

    const starts = groups.map(([b, r]) => [avoidStart(b.start_km, dng), b, r] as const);
    segs.push({ name: "Warm-up", a: 0.0, b: pyRound(starts[0][0], 1), pct: WARMUP_PCT, kind: "warmup", buf: true });
    let prevEnd = 0;
    starts.forEach(([start, , n], gi) => {
      if (gi > 0) {
        segs.push({ name: `Endurance bridge ${gi}`, a: pyRound(prevEnd, 1), b: pyRound(start, 1), pct: BRIDGE_PCT, kind: "rest", buf: true });
      }
      let a = start;
      for (let i = 0; i < n; i++) {
        a = avoidStart(a, dng);
        repNo += 1;
        const wb = a + workKm;
        segs.push({ name: `${shortName(objective)} ${repNo} @${workPct}%`, a: pyRound(a, 2), b: pyRound(wb, 2), pct: workPct, kind: "work" });
        a = wb;
        if (i < n - 1) {
          const rb = a + restKm;
          segs.push({ name: "Float", a: pyRound(a, 2), b: pyRound(rb, 2), pct: restPct, kind: "rest" });
          a = rb;
        }
      }
      prevEnd = a;
    });
    const tail = rkm - prevEnd;
    if (tail > 10) {
      const cd = Math.min(8.0, Math.max(5.0, tail * 0.25));
      segs.push({ name: "Endurance home", a: pyRound(prevEnd, 1), b: pyRound(rkm - cd, 1), pct: ENDUR_PCT, kind: "cooldown" });
      segs.push({ name: "Cooldown", a: pyRound(rkm - cd, 1), b: pyRound(rkm, 1), pct: COOLDOWN_PCT, kind: "cooldown" });
    } else if (tail > 0.3) {
      segs.push({ name: "Cooldown", a: pyRound(prevEnd, 1), b: pyRound(rkm, 1), pct: COOLDOWN_PCT, kind: "cooldown" });
    }
  }

  segs[0].a = 0.0;
  segs[segs.length - 1].b = pyRound(rkm, 1);

  const txt = toSyntax(segs);
  const issues = validate(segs, rkm, objective, comp.stops, comp.haz);
  if (overflow) {
    const lb = groups[groups.length - 1][0];
    const endKm = "fallback" in lb && lb.fallback ? pyRepr(lb.end_km) : String(lb.end_km);
    issues.push({ level: "warn", msg: `${overflow} effort(s) don't fit inside the clean block `
      + `km ${lb.start_km}-${endKm} and extend beyond it — check the map before pushing` });
  }
  if (!isSteady && gated && capb) {
    const frac = supportedFrac(segs, capb, targetW, spdThr);
    // Python formatted spd_thr with :.0f even when no 500 m window qualified
    // (spd_thr None) and failed; the port fails the same way.
    if (spdThr === null) throw new TypeError("unsupported format string passed to NoneType.__format__");
    const thr = spdThr;
    const bar = capb.n_pwr ? `≥${targetW} W where measured, else ≥${pyFixed(thr, 0)} km/h` : `≥${pyFixed(thr, 0)} km/h`;
    issues.push({
      level: frac < 0.5 ? "warn" : "info",
      msg: `Placement learned from ${capb.n_spd} of your rides`
        + (capb.n_pwr ? ` (${capb.n_pwr} with power)` : "")
        + ` — efforts sit on the stretches you most often hold ${bar}. `
        + `${pyRound(frac * 100)}% of the work distance is history-supported`
        + (frac >= 0.5 ? "." : "; consider a shorter/easier session for this route."),
    });
  } else if (!isSteady && !gated) {
    issues.push({ level: "info", msg: "No ride history covers this route yet — placement used road "
      + "quality. Add rides via “Refresh ride history” to learn placement." });
  }
  const load = estimateLoad(segs, ftp);
  const ev = evidence(segs, comp);
  const ttl = opts.title || title(objective, sess, !isSteady ? reps : 0);

  return {
    objective, session_name: sess.name ?? null, session_plan: sess.plan ?? "",
    reps_placed: !isSteady ? placed : 0, reps_requested: !isSteady ? reps : 0,
    title: ttl, segs, syntax: txt, written_km: totalWrittenKm(segs), route_km: rkm, ftp,
    load_estimate: load.tss, if_estimate: load.if, duration_min: load.minutes, evidence: ev, issues,
    blocks: blocks.slice(0, 6), stops: comp.stops, haz: comp.haz, profile: ctx.profile,
  };
}

// ------------------------------------------------ no-route (time-based) ------
const WARMUP_MIN = 15.0;
const COOLDOWN_MIN = 10.0;

export function designBlank(objective0: string, ftp: number, session: Session | null = null, ttl: string | null = null): Design {
  let objective = objective0;
  if (session) objective = session.category ?? objective;
  const sess = session || fallbackSession(objective);
  const segs: Seg[] = [{ name: "Warm-up", a: 0.0, b: WARMUP_MIN, pct: WARMUP_PCT, kind: "warmup" }];
  let a = WARMUP_MIN;
  let reps = 0;
  const isSteady = Boolean(sess.steady) || sess.reps === undefined;
  if (objective === "endurance" && isSteady) {
    segs.push({ name: "Endurance Z2", a, b: pyRound(a + 45, 1), pct: ENDUR_PCT, kind: "rest" });
    a += 45;
  } else {
    if (sess.reps === undefined) throw new Error("'reps'");
    reps = Math.trunc(sess.reps);
    const wm = sess.work_min as number;
    const rm = sess.rest_min ?? wm;
    const wp = objective !== "endurance" ? (sess.work_pct as string) : SURGE_PCT;
    const rp = sess.rest_pct ?? BRIDGE_PCT;
    for (let i = 0; i < reps; i++) {
      let b = a + wm;
      segs.push({ name: `${shortName(objective)} ${i + 1} @${wp}%`, a: pyRound(a, 2), b: pyRound(b, 2), pct: wp, kind: "work" });
      a = b;
      if (i < reps - 1) {
        b = a + rm;
        segs.push({ name: "Float", a: pyRound(a, 2), b: pyRound(b, 2), pct: rp, kind: "rest" });
        a = b;
      }
    }
  }
  segs.push({ name: "Cool-down", a: pyRound(a, 1), b: pyRound(a + COOLDOWN_MIN, 1), pct: COOLDOWN_PCT, kind: "cooldown" });
  const total = segs[segs.length - 1].b;
  const load = estimateLoad(segs, ftp, "min");
  return {
    mode: "blank", objective, session_name: sess.name ?? null, session_plan: sess.plan ?? "",
    reps_placed: reps, reps_requested: reps, title: ttl || title(objective, sess, reps, false), segs,
    syntax: toSyntax(segs, "min"), written_km: null, route_km: null, total_min: total, ftp,
    load_estimate: load.tss, if_estimate: load.if, duration_min: load.minutes, evidence: [],
    issues: validateBlank(segs, objective), blocks: [], stops: [], haz: [], profile: null,
  };
}
