/**
 * intervals.icu REST client (icu.py). Basic auth with the literal username
 * "API_KEY" and the athlete's key. Reads retry once; failures surface as a
 * clean IcuError so the UI can degrade ("proceeding with reduced context").
 */
import { buildRideRecord, type RideRec } from "../lib/gpx.js";
import { pyRound } from "../lib/py.js";
import { cfg, icuConfigured, localDate } from "./config.js";

export class IcuError extends Error {}

const auth = () => `Basic ${Buffer.from(`API_KEY:${cfg.ICU_API_KEY}`).toString("base64")}`;

function errName(e: unknown): string {
  if (e instanceof Error) return e.name === "TimeoutError" || e.name === "AbortError" ? "ReadTimeout" : e.name === "Error" ? "HTTPError" : e.name;
  return "Error";
}

async function http(url: string, init: RequestInit = {}, timeoutMs = 20000): Promise<unknown> {
  const r = await fetch(url, { ...init, headers: { Authorization: auth(), ...(init.headers || {}) }, signal: AbortSignal.timeout(timeoutMs) });
  if (r.status === 401) throw new IcuError("intervals.icu rejected the API key (401)");
  if (!r.ok) throw new Error(`Client error '${r.status} ${r.statusText}' for url '${url}'`);
  const txt = await r.text();
  try {
    return JSON.parse(txt);
  } catch {
    throw Object.assign(new Error("Expecting value: line 1 column 1 (char 0)"), { name: "JSONDecodeError" });
  }
}

async function get(path: string, params?: Record<string, string>): Promise<any> {
  if (!icuConfigured()) {
    throw new IcuError("intervals.icu not configured — set ICU_API_KEY and ICU_ATHLETE_ID in the site's environment variables");
  }
  const qs = params ? `?${new URLSearchParams(params)}` : "";
  const url = `${cfg.ICU_BASE}/api/v1${path}${qs}`;
  let last: unknown = null;
  for (let i = 0; i < 2; i++) {
    try {
      return await http(url);
    } catch (e) {
      if (e instanceof IcuError) throw e;
      last = e;
    }
  }
  throw new IcuError(`intervals.icu request failed: ${errName(last)}: ${last instanceof Error ? last.message : String(last)}`);
}

async function post(path: string, body: unknown): Promise<any> {
  if (!icuConfigured()) throw new IcuError("intervals.icu not configured");
  try {
    return await http(`${cfg.ICU_BASE}/api/v1${path}`, {
      method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    if (e instanceof IcuError) throw e;
    throw new IcuError(`intervals.icu create failed: ${errName(e)}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const aid = () => cfg.ICU_ATHLETE_ID;

export async function recentActivities(days = 14): Promise<Record<string, unknown>[]> {
  const data = await get(`/athlete/${aid()}/activities`, { oldest: localDate(-days), newest: localDate() });
  return Array.isArray(data) ? data : data.activities || [];
}

/** Latest CTL/ATL/TSB from the wellness feed. TSB = CTL - ATL. */
export async function fitness() {
  const data = await get(`/athlete/${aid()}/wellness`, { oldest: localDate(-7), newest: localDate() });
  let rows: Record<string, any>[] = Array.isArray(data) ? data : data.wellness || [];
  rows = rows.filter((w) => w.ctl !== null && w.ctl !== undefined);
  if (!rows.length) return { ctl: null, atl: null, tsb: null };
  const key = (w: Record<string, any>) => String(w.id || w.date || "");
  rows.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const latest = rows[rows.length - 1];
  const ctl = latest.ctl;
  const atl = latest.atl;
  const tsb = ctl !== null && ctl !== undefined && atl !== null && atl !== undefined ? pyRound(ctl - atl, 1) : null;
  return { ctl: ctl ? pyRound(ctl, 1) : null, atl: atl ? pyRound(atl, 1) : null, tsb, date: latest.id || latest.date || null };
}

/** Ride FTP / FTHR from the athlete record (or the sport-settings endpoint). */
export async function sportSettings() {
  let ss: any;
  try {
    const ath = await get(`/athlete/${aid()}`);
    ss = ath.sportSettings || ath.sport_settings || [];
  } catch (e) {
    if (!(e instanceof IcuError)) throw e;
    ss = await get(`/athlete/${aid()}/sport-settings`);
  }
  let ride: any = null;
  for (const s of Array.isArray(ss) ? ss : []) {
    const types = s.types || [s.type];
    if (types && types.some((t: string) => t && (t === "Ride" || t === "VirtualRide"))) {
      ride = s;
      break;
    }
  }
  ride = ride || (Array.isArray(ss) && ss.length ? ss[0] : ss && ss.length ? ss[0] : {});
  return { ftp: ride.ftp || ride.ftp_watts || null, fthr: ride.lthr || ride.fthr_bpm || ride.fthr || null };
}

const shiftDate = (ymd: string, days: number) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

/** Calendar events within ± spanDays of a YYYY-MM-DD date. */
export async function events(around: string, spanDays = 3): Promise<Record<string, any>[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(around)) throw new Error(`Invalid isoformat string: '${around}'`);
  const data = await get(`/athlete/${aid()}/events`, { oldest: shiftDate(around, -spanDays), newest: shiftDate(around, spanDays) });
  return Array.isArray(data) ? data : data.events || [];
}

export async function getEvent(id: unknown): Promise<Record<string, any>> {
  return get(`/athlete/${aid()}/events/${id}`);
}

export async function createWorkout(startDate: string, name: string, description: string,
                                    distanceMeters: number | null, durationSeconds: number | null) {
  const body: Record<string, unknown> = {
    category: "WORKOUT", start_date_local: `${startDate}T00:00:00`, type: "Ride", name, description,
  };
  if (distanceMeters) body.distance = pyRound(distanceMeters);
  if (durationSeconds) body.moving_time = Math.trunc(durationSeconds);
  return post(`/athlete/${aid()}/events`, body);
}

/**
 * download_gpx: intervals.icu has no GPX export and the latlng STREAM drops
 * longitude, so geometry comes from /map's latlngs and time/HR/speed/altitude/
 * watts from /streams — fused into the compact ride record.
 */
export async function downloadRide(activityId: string, startLocal?: string | null): Promise<RideRec> {
  const base = cfg.ICU_BASE;
  const mp = (await http(`${base}/api/v1/activity/${activityId}/map`, {}, 60000)) as { latlngs?: unknown[] };
  const latlngs = mp.latlngs || [];
  if (latlngs.length < 2) throw new IcuError(`${activityId}: no GPS geometry`);
  const st = (await http(`${base}/api/v1/activity/${activityId}/streams?${new URLSearchParams({ types: "time,heartrate,velocity_smooth,altitude,watts" })}`,
    {}, 60000)) as { type: string; data?: unknown[] }[];
  return buildRideRecord(activityId, latlngs, st, startLocal);
}
