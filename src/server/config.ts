/**
 * Runtime configuration from the site's environment variables (Netlify →
 * Site configuration → Environment variables). Only ICU_API_KEY and
 * APP_PASSWORD are secret.
 */

function env(key: string, dflt = ""): string {
  const n = (globalThis as { Netlify?: { env?: { get(k: string): string | undefined } } }).Netlify;
  const v = n?.env?.get(key) ?? process.env[key];
  return v === undefined || v === "" ? dflt : v;
}

export const cfg = {
  get ICU_BASE() { return env("ICU_BASE", "https://intervals.icu").replace(/\/+$/, ""); },
  get ICU_API_KEY() { return env("ICU_API_KEY"); },
  get ICU_ATHLETE_ID() { return env("ICU_ATHLETE_ID", "0"); },
  /** HTTP Basic password every API call needs (any username); empty = open. */
  get APP_PASSWORD() { return env("APP_PASSWORD"); },
  /** Time zone for "today" (activity windows, job stamps). The Python used the PC's clock. */
  get APP_TZ() { return env("APP_TZ", "Europe/Amsterdam"); },
  get REF_SPEED_KMH() { return parseFloat(env("REF_SPEED_KMH", "30")); },
  get KM_PER_MIN() { return this.REF_SPEED_KMH / 60.0; },
  get BUFFER_KM() { return parseFloat(env("BUFFER_KM", "5")); },
};

export function icuConfigured(): boolean {
  return Boolean(cfg.ICU_API_KEY) && !["", "0"].includes(cfg.ICU_ATHLETE_ID);
}

/** Local calendar date (YYYY-MM-DD) in APP_TZ, offset by `days`. */
export function localDate(days = 0): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: cfg.APP_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  if (!days) return today;
  const [y, m, d] = today.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Local wall-clock timestamp "YYYY-MM-DDTHH:MM:SS" in APP_TZ (datetime.now().isoformat). */
export function localNow(): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: cfg.APP_TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}
