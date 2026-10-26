/**
 * Objective selection (TSB gate + phase bias + novelty + terrain) and bank
 * session picking (suggest_workout.py).
 */
import { pyFixedSigned, pyListRepr, sortBy } from "../lib/py.js";
import { validSession, type BankWorkout } from "./windows.js";

const CATS = ["sprint", "anaerobic", "vo2max", "threshold", "sweetspot", "tempo", "endurance"];

const PHASE_FAV: Record<string, string[]> = {
  base: ["endurance", "tempo", "sweetspot"],
  build: ["threshold", "sweetspot", "vo2max"],
  peak: ["vo2max", "anaerobic", "sprint", "threshold"],
  taper: ["vo2max", "sprint", "endurance"],
  recovery: ["endurance"],
};
const TERRAIN_FIT: Record<string, string[]> = {
  flat: ["threshold", "tempo", "sweetspot", "endurance", "vo2max", "anaerobic", "sprint"],
  rolling: ["sweetspot", "threshold", "vo2max", "tempo", "endurance"],
  climbs: ["threshold", "vo2max", "sweetspot"],
  punchy: ["anaerobic", "vo2max", "sprint"],
  urban: ["endurance"],
};

function tsbPool(tsb: number): string[] {
  if (tsb < -20) return ["endurance"];
  if (tsb < -10) return ["endurance", "tempo", "sweetspot"];
  if (tsb <= 5) return CATS.slice();
  return ["vo2max", "threshold", "anaerobic", "sprint"];
}

export function selectCategory(tsb: number, phaseIn: string | null, last: string | null, terrain: string | null): [string, string[], string] {
  const phase = (phaseIn || "build").toLowerCase();
  let pool = tsbPool(tsb);
  if (phase === "recovery") pool = ["endurance"];
  const fav = Object.hasOwn(PHASE_FAV, phase) ? PHASE_FAV[phase] : ["threshold", "sweetspot", "endurance"];
  let cand = fav.filter((c) => pool.includes(c));
  if (!cand.length) cand = tsb <= 5 ? pool.slice() : fav.slice();
  if (last && cand.length > 1) {
    const f = cand.filter((c) => c !== last);
    if (f.length) cand = f;
  }
  if (terrain && Object.hasOwn(TERRAIN_FIT, terrain) && cand.length > 1) {
    const order = TERRAIN_FIT[terrain];
    cand = sortBy(cand.slice(), (c) => (order.includes(c) ? order.indexOf(c) : 99));
  }
  const reason = `TSB ${pyFixedSigned(tsb, 0)} -> pool ${pyListRepr(pool.slice(0, 3))}${pool.length > 3 ? "..." : ""}; `
    + `phase ${phase} favours ${fav[0]}`
    + (terrain ? `; terrain ${terrain}` : "")
    + (last ? `; avoided last=${last}` : "");
  return [cand[0], cand, reason];
}

export function pick(bank: BankWorkout[], category: string, minutes: number | null, nth = 0): BankWorkout | null {
  const pool = bank.filter((w) => w.category === category && validSession(w));
  const m = minutes || 90;
  sortBy(pool, (w) => Math.abs((w.duration_min || 0) - m));
  if (!pool.length) return null;
  return pool[nth % pool.length];
}
