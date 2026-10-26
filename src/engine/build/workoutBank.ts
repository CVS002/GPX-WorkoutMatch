/**
 * Refresh the workout bank from open .zwo repos on GitHub (build_workout_bank.py).
 * Classifies each workout into 7 buckets by where its work-time is spent and
 * stores a compact structure line. Like the Python, this REPLACES the bank with
 * the GitHub-sourced entries only.
 */
import { pyFixed, pyFloat, pyRound } from "../../lib/py.js";

type Log = (line: string) => void | Promise<void>;
const UA = { "User-Agent": "gpx-workout-designer-v2/2.0" };
const CATS = ["sprint", "anaerobic", "vo2max", "threshold", "sweetspot", "tempo", "endurance"];
const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));

async function get(url: string, isJson = true, tries = 3): Promise<any> {
  for (let k = 0; k < tries; k++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return isJson ? await r.json() : await r.text();
    } catch {
      if (k === tries - 1) return null;
      await sleep(2);
    }
  }
  return null;
}

const num = (x: string | undefined, d = 0.0) => {
  const v = pyFloat(x);
  return v === null ? d : v;
};

interface El { tag: string; attrib: Record<string, string>; children: El[]; text: string }

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (t: string) => t.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e: string) =>
  e[0] === "#" ? String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e] ?? m);

/** Minimal XML element tree (enough for .zwo); null on obviously broken input. */
function parseXml(text: string): El | null {
  const s = text.replace(/<\?[\s\S]*?\?>/g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/<!DOCTYPE[^>]*>/gi, "");
  const re = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^\s=>/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  const root: El = { tag: "#doc", attrib: {}, children: [], text: "" };
  const stack: El[] = [root];
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m[5] !== undefined) {
      const top = stack[stack.length - 1];
      if (!top.children.length) top.text += decode(m[5]);
      continue;
    }
    const [, close, tag, attrs, self] = m;
    if (close) {
      if (stack.length < 2 || stack[stack.length - 1].tag !== tag) return null;
      stack.pop();
      continue;
    }
    const attrib: Record<string, string> = {};
    for (const a of attrs.matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrib[a[1]] = decode(a[2] ?? a[3]);
    const el: El = { tag, attrib, children: [], text: "" };
    stack[stack.length - 1].children.push(el);
    if (!self) stack.push(el);
  }
  if (stack.length !== 1 || root.children.length !== 1) return null;
  return root.children[0];
}

type Bout = [number, number];

export function parseZwo(text: string): [string, Bout[], number] | null {
  const root = parseXml(text);
  if (!root) return null;
  const wk = root.children.find((c) => c.tag === "workout");
  const nameEl = root.children.find((c) => c.tag === "name");
  const name = nameEl ? nameEl.text.trim() : "";
  if (!wk) return null;
  const bouts: Bout[] = [];
  let total = 0.0;
  for (const el of wk.children) {
    const a = el.attrib;
    if (el.tag === "IntervalsT") {
      const rep = Math.trunc(num(a.Repeat, 1));
      const onD = num(a.OnDuration);
      const offD = num(a.OffDuration);
      const onP = num(a.OnPower);
      const offP = num(a.OffPower);
      for (let i = 0; i < rep; i++) {
        bouts.push([onD, onP], [offD, offP]);
        total += onD + offD;
      }
    } else if (["SteadyState", "Warmup", "Cooldown", "Ramp", "FreeRide", "MaxEffort"].includes(el.tag)) {
      const d = num(a.Duration);
      let p = "Power" in a ? num(a.Power) : (num(a.PowerLow) + num(a.PowerHigh)) / 2 || num(a.PowerLow);
      if (el.tag === "MaxEffort") p = 1.6;
      bouts.push([d, p]);
      total += d;
    }
  }
  if (total < 300) return null;
  return [name, bouts, total];
}

export function classifyBouts(bouts: Bout[]): string {
  const band: Record<string, number> = Object.fromEntries(CATS.map((c) => [c, 0.0]));
  for (const [d, p] of bouts) {
    if (p >= 1.5) band.sprint += d;
    else if (p >= 1.2) band.anaerobic += d;
    else if (p >= 1.06) band.vo2max += d;
    else if (p >= 0.95) band.threshold += d;
    else if (p >= 0.88) band.sweetspot += d;
    else if (p >= 0.76) band.tempo += d;
  }
  for (const c of CATS.slice(0, -1)) if (band[c] >= 90) return c;
  return "endurance";
}

export function summarize(bouts: Bout[]): string {
  const work = bouts.filter(([d, p]) => p >= 0.76 && d >= 20);
  if (!work.length) return "steady aerobic";
  const counts = new Map<string, [number, number, number]>();
  for (const [d, p] of work) {
    const dur = pyRound(d);
    const pw = pyRound(p, 2);
    const k = `${dur}|${pw}`;
    const c = counts.get(k);
    if (c) c[2]++;
    else counts.set(k, [dur, pw, 1]);
  }
  let best: [number, number, number] | null = null;
  for (const c of counts.values()) if (best === null || c[2] > best[2]) best = c;
  const [dur, pw, n] = best as [number, number, number];
  const mins = dur / 60;
  const dtxt = mins >= 1.5 ? `${pyFixed(mins, 0)}min` : `${pyFixed(dur, 0)}s`;
  const pct = Math.trunc(pw * 100);
  return n > 1 ? `${n}x ${dtxt} @ ${pct}% FTP` : `${dtxt} @ ${pct}% FTP`;
}

export async function buildWorkoutBank(log: Log, tz: string) {
  const queries = ["zwift+workouts", "zwo+workouts", "zwift+workout+library", "cycling+zwo", "trainerroad+zwo", "zwift+training+plan"];
  const seenRepo = new Set<string>();
  const repos: [string, string, number][] = [];
  for (const q of queries) {
    const j = (await get(`https://api.github.com/search/repositories?q=${q}&sort=stars&per_page=20`)) || {};
    for (const it of j.items || []) {
      if (seenRepo.has(it.full_name)) continue;
      seenRepo.add(it.full_name);
      repos.push([it.full_name, it.default_branch, it.stargazers_count]);
    }
    await sleep(1);
  }
  await log(`candidate repos: [${repos.slice(0, 8).map((r) => `('${r[0]}', ${r[2]})`).join(", ")}]`);
  const bank: { name: string; category: string; duration_min: number; structure: string; source: string }[] = [];
  const seen = new Set<string>();
  const used: [string, number][] = [];
  for (const [full, branch] of repos) {
    if (bank.length >= 900) break;
    const t = await get(`https://api.github.com/repos/${full}/git/trees/${branch}?recursive=1`);
    const paths: string[] = t && t.tree ? t.tree.map((x: { path: string }) => x.path).filter((p: string) => p.toLowerCase().endsWith(".zwo")) : [];
    if (paths.length < 3) continue;
    used.push([full, paths.length]);
    for (const p of paths.slice(0, 250)) {
      if (bank.length >= 900) break;
      const raw = await get(`https://raw.githubusercontent.com/${full}/${branch}/${p}`, false);
      if (!raw) continue;
      const parsed = parseZwo(raw);
      if (!parsed) continue;
      const [name, bouts, total] = parsed;
      const cat = classifyBouts(bouts);
      const sig = `${name.toLowerCase()}|${pyRound(total)}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      bank.push({
        name: name || p.split("/").pop()!.slice(0, -4), category: cat,
        duration_min: pyRound(total / 60, 1), structure: summarize(bouts), source: full,
      });
    }
    await log(`  ${full}: ${paths.length} zwo, bank now ${bank.length}`);
  }
  const generated = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const payload = {
    meta: { source_repos: used, generated, count: bank.length, license_note: "structures parsed from open .zwo files; training facts only" },
    workouts: bank,
  };
  await log(`\nTOTAL ${bank.length} workouts -> workout_bank.json`);
  for (const c of CATS) await log(`  ${c.padEnd(10)} ${bank.filter((w) => w.category === c).length}`);
  return payload;
}
