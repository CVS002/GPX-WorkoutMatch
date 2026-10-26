/**
 * Per-category interval windows + bank-entry validation (workout_windows.py).
 * The bank's category label and its one-line structure often disagree, so
 * every consumer re-validates an entry against its category's window.
 */
import { pyRound } from "../lib/py.js";

const STRUCT = /^\s*(\d+)\s*x\s*(\d+)\s*(s|sec|min)\s*@\s*(\d+)\s*%/i;

export interface CatWin { pct: [number, number]; work: [number, number]; reps: [number, number] }

export const CAT_WIN: Record<string, CatWin> = {
  vo2max: { pct: [108, 125], work: [2.0, 5.0], reps: [3, 10] },
  threshold: { pct: [95, 106], work: [6.0, 20.0], reps: [2, 5] },
  sweetspot: { pct: [84, 95], work: [8.0, 20.0], reps: [2, 4] },
  tempo: { pct: [76, 90], work: [10.0, 30.0], reps: [1, 3] },
  anaerobic: { pct: [118, 160], work: [0.3, 1.6], reps: [6, 15] },
  sprint: { pct: [140, 260], work: [0.12, 0.55], reps: [5, 12] },
};

/** Recovery minutes as a function of work minutes. */
export const REST_MIN: Record<string, (w: number) => number> = {
  vo2max: (w) => pyRound(w, 1),
  threshold: (w) => pyRound(Math.max(2.0, w * 0.4), 1),
  sweetspot: () => 4.0,
  tempo: () => 5.0,
  anaerobic: (w) => pyRound(Math.max(1.0, w * 2), 1),
  sprint: (w) => pyRound(Math.max(2.0, w * 6), 1),
};

export const REST_PCT: Record<string, string> = {
  vo2max: "55-62", threshold: "58-64", sweetspot: "60-66",
  tempo: "60-66", anaerobic: "50-58", sprint: "50-58",
};

/** "Nx Ds @ P%" → [reps, work_min, pct] or null. */
export function parseStruct(s: string | null | undefined): [number, number, number] | null {
  const m = STRUCT.exec(s || "");
  if (!m) return null;
  const reps = parseInt(m[1], 10);
  const n = parseInt(m[2], 10);
  const unit = m[3].toLowerCase();
  const pct = parseInt(m[4], 10);
  const workMin = unit === "s" || unit === "sec" ? n / 60.0 : n;
  return [reps, workMin, pct];
}

export interface BankWorkout { name?: string; category?: string; duration_min?: number; structure?: string; plan?: string; source?: string }

export function validSession(w: BankWorkout): boolean {
  const cat = w.category;
  const p = parseStruct(w.structure ?? "");
  if (cat === "endurance") return p === null || p[2] <= 88;
  const win = cat ? CAT_WIN[cat] : undefined;
  if (!win || !p) return false;
  const [reps, workMin, pct] = p;
  return win.pct[0] <= pct && pct <= win.pct[1]
    && win.work[0] <= workMin && workMin <= win.work[1]
    && win.reps[0] <= reps && reps <= win.reps[1];
}
