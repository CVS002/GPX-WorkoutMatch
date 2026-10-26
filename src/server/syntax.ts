/**
 * Segments → intervals.icu workout syntax, plus the guardrail validator every
 * design and every map adjustment must pass before it can reach the calendar
 * (syntax.py).
 *
 * A segment is {name, a, b, pct, kind, buf}: a/b route km (or minutes for a
 * no-route workout), pct a %FTP range string, kind warmup|work|rest|tt|cooldown,
 * buf = structural buffer written BUFFER_KM longer (lap-button padding).
 */
import { pyFmtG, pyRepr, pyRound, pyStr, pyStrJson, pySum } from "../lib/py.js";
import { CAT_WIN } from "../engine/windows.js";
import { cfg } from "./config.js";

export interface Seg { name: string; a: number; b: number; pct: string; kind: string; buf?: boolean; [k: string]: unknown }
export interface Issue { level: "error" | "warn" | "info"; msg: string; seg?: number }

/**
 * How a raw seg number prints in a message. Python printed the stored value
 * with str(): designs built server-side hold floats ("12.0"), segments that
 * came back from the browser were parsed from JSON (integral → "12").
 */
export interface NumStr {
  raw: (x: number) => string;
  /** str(round(x, nd)) — round() keeps x's type, so a JSON int stays an int. */
  rounded: (x: number, nd: number) => string;
}
export const SERVER_NUM: NumStr = { raw: pyRepr, rounded: (x, nd) => pyRepr(pyRound(x, nd)) };
export const CLIENT_NUM: NumStr = {
  raw: pyStrJson,
  rounded: (x, nd) => (Number.isInteger(x) ? String(x) : pyRepr(pyRound(x, nd))),
};

function fmtKm(km0: number): string {
  const km = pyRound(km0, 1);
  if (Math.abs(km - pyRound(km)) < 0.05) return `${Math.trunc(pyRound(km))}km`;
  return `${pyFmtG(km)}km`;
}

export const pctStr = (pct: unknown): string => pyStr(pct).trim().replace(/%+$/, "");

export function writtenDistanceKm(seg: Seg): number {
  let d = seg.b - seg.a;
  if (seg.buf) d += cfg.BUFFER_KM;
  return d;
}

function fmtMin(m: number): string {
  if (Math.abs(m - pyRound(m)) < 0.02) return `${Math.trunc(pyRound(m))}m`;
  return `${Math.trunc(pyRound(m * 60))}s`;
}

/** One line per segment: `- <name> <amount> <pct>% power=3s`. */
export function toSyntax(segs: Seg[], unit: "km" | "min" = "km"): string {
  return segs
    .map((s) => {
      const amount = unit === "min" ? fmtMin(s.b - s.a) : fmtKm(writtenDistanceKm(s));
      return `- ${pyStr(s.name)} ${amount} ${pctStr(s.pct)}% power=3s`;
    })
    .join("\n");
}

/**
 * round(sum(written), 1). For segments posted by the browser, whole-number
 * a/b arrived as JSON ints, so an unpadded step's length was a Python int —
 * which changes how sum() adds it (see pySum).
 */
export function totalWrittenKm(segs: Seg[], fromClient = false): number {
  const isInt = fromClient ? (i: number) => Number.isInteger(segs[i].a) && Number.isInteger(segs[i].b) && !segs[i].buf : undefined;
  return pyRound(pySum(segs.map(writtenDistanceKm), isInt), 1);
}

const FLOAT_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$|^[+-]?(inf|infinity|nan)$/i;

export function pctLoHi(pct: unknown): [number, number] {
  const s = pctStr(pct);
  const f = (x: string) => {
    const t = x.trim();
    if (!FLOAT_RE.test(t)) throw new Error("ValueError");
    return /nan/i.test(t) ? NaN : /inf/i.test(t) ? (t.startsWith("-") ? -Infinity : Infinity) : Number(t);
  };
  try {
    if (s.includes("-")) {
      const i = s.indexOf("-");
      return [f(s.slice(0, i)), f(s.slice(i + 1))];
    }
    return [f(s), f(s)];
  } catch {
    return [0.0, 0.0];
  }
}

export function pctValid(pct: unknown): boolean {
  const s = pct !== null && pct !== undefined && pct !== "" ? pctStr(pct) : "";
  if (!s) return false;
  const parts = s.includes("-") ? [s.slice(0, s.indexOf("-")), s.slice(s.indexOf("-") + 1)] : [s];
  return parts.every((p) => FLOAT_RE.test(p.trim()));
}

/** Deterministic guardrails → [{level, msg, seg?}]; 'error' blocks the push. */
export function validate(segs: Seg[], routeKm: number, category: string, stops: { km: number }[],
                         haz: { km: number; t?: string }[], num: NumStr = SERVER_NUM): Issue[] {
  const issues: Issue[] = [];
  if (!segs.length) return [{ level: "error", msg: "no segments" }];

  // 1. Contiguity: bands must tile 0..route_km without gaps/overlap.
  if (Math.abs(segs[0].a) > 0.15) issues.push({ level: "warn", msg: `first band starts at km ${num.raw(segs[0].a)}, not 0` });
  for (let i = 0; i + 1 < segs.length; i++) {
    const p = segs[i];
    const n = segs[i + 1];
    if (Math.abs(n.a - p.b) > 0.15) {
      issues.push({ level: "warn", msg: `gap/overlap between '${pyStr(p.name)}' and '${pyStr(n.name)}' (km ${num.raw(p.b)} -> ${num.raw(n.a)})` });
    }
  }
  const last = segs[segs.length - 1];
  if (Math.abs(last.b - routeKm) > 1.0) {
    issues.push({ level: "warn", msg: `last band ends at km ${num.raw(last.b)}, route is ${pyRepr(routeKm)} km` });
  }

  // 2. Buffer padding: written distance must be route + BUFFER_KM per buffer.
  const nbuf = segs.filter((s) => s.buf).length;
  const expect = routeKm + cfg.BUFFER_KM * nbuf;
  const got = totalWrittenKm(segs, num === CLIENT_NUM);
  if (Math.abs(got - expect) > Math.max(2.0, 0.05 * expect)) {
    const intTotal = num === CLIENT_NUM && segs.every((s) => Number.isInteger(s.a) && Number.isInteger(s.b) && !s.buf);
    issues.push({ level: "warn", msg: `written distance ${intTotal ? String(got) : pyRepr(got)} km vs expected ~${pyRepr(pyRound(expect, 1))} km `
      + `(${nbuf} padded buffer(s)) — padding may be wrong` });
  }
  for (const s of segs) {
    if (s.buf && !["warmup", "rest", "cooldown"].includes(s.kind)) {
      issues.push({ level: "warn", msg: `'${pyStr(s.name)}' is padded but is a ${pyStr(s.kind)} step `
        + "(only warm-up/bridge/cooldown should be padded)" });
    }
  }

  // 3. Work-step intensities within the category's physiological window.
  const win = CAT_WIN[category];
  if (win) {
    segs.forEach((s, i) => {
      if ((s.kind === "work" || s.kind === "tt") && pctValid(s.pct)) {
        const [lo, hi] = pctLoHi(s.pct);
        const mid = (lo + hi) / 2;
        if (!(win.pct[0] - 1 <= mid && mid <= win.pct[1] + 1)) {
          issues.push({ level: "warn", seg: i, msg: `'${pyStr(s.name)}' @ ${pyStr(s.pct)}% is outside the `
            + `${category} window ${win.pct[0]}-${win.pct[1]}%` });
        }
      }
    });
  }

  // 4. No work-step START on a known stop / hazard, and none mid-effort.
  const danger = [...stops.map((s) => s.km), ...haz.filter((h) => h.t !== "right_before_left").map((h) => h.km)];
  segs.forEach((s, i) => {
    if (s.kind === "work" || s.kind === "tt") {
      const near = danger.filter((d) => Math.abs(d - s.a) <= 0.3);
      if (near.length) {
        issues.push({ level: "error", seg: i, msg: `'${pyStr(s.name)}' starts at km ${num.rounded(s.a, 1)} on/near a `
          + `stop or junction (km ${pyRepr(pyRound(near[0], 2))}) — move it` });
      }
      const inside = danger.filter((d) => s.a + 0.3 < d && d < s.b - 0.05);
      if (inside.length) {
        issues.push({ level: "warn", seg: i, msg: `'${pyStr(s.name)}' crosses a stop or junction mid-effort `
          + `(km ${pyRepr(pyRound(inside[0], 2))}) — consider moving or splitting it` });
      }
    }
  });

  // 5. Every step parses to name + range + power=3s.
  segs.forEach((s, i) => {
    if (!pyStr(s.name ?? "").trim()) issues.push({ level: "warn", seg: i, msg: "a segment has no name" });
    if (!pctValid(s.pct)) issues.push({ level: "error", seg: i, msg: `'${pyStr(s.name)}' has no readable intensity` });
  });
  return issues;
}

/** Guardrails for a no-route (time-based) workout. */
export function validateBlank(segs: Seg[], category: string): Issue[] {
  const issues: Issue[] = [];
  if (!segs.length) return [{ level: "error", msg: "no segments — add at least one" }];
  const win = CAT_WIN[category];
  segs.forEach((s, i) => {
    if (!pctValid(s.pct)) issues.push({ level: "error", seg: i, msg: `'${pyStr(s.name)}' has no readable intensity` });
    if (s.b - s.a <= 0) issues.push({ level: "error", seg: i, msg: `'${pyStr(s.name)}' has zero/negative duration` });
    if (win && (s.kind === "work" || s.kind === "tt") && pctValid(s.pct)) {
      const [lo, hi] = pctLoHi(s.pct);
      const mid = (lo + hi) / 2;
      if (!(win.pct[0] - 1 <= mid && mid <= win.pct[1] + 1)) {
        issues.push({ level: "warn", seg: i, msg: `'${pyStr(s.name)}' @ ${pyStr(s.pct)}% is outside the `
          + `${category} window ${win.pct[0]}-${win.pct[1]}%` });
      }
    }
  });
  return issues;
}
