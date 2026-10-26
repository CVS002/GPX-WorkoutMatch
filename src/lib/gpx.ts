/**
 * GPX input (uploaded routes) and the compact ride record that replaces the
 * engine's history/*.gpx files in Blobs.
 *
 * The Python engine re-parsed full GPX text everywhere. Here a route is parsed
 * once on upload, and each history ride is stored as a gzipped column record
 * whose values are exactly what Python would read back from the GPX it wrote
 * (lat/lon to 6 dp, ele 1 dp, speed 3 dp, whole-second UTC times) — so every
 * consumer sees the same numbers without an XML parse per request.
 */
import { gunzipSync, gzipSync } from "node:zlib";
import { pyFixed, pyFloat, pyRound } from "./py.js";

export type RoutePt = [lat: number, lon: number, ele: number | null];

export class GpxError extends Error {}

const COMMENT = /<!--[\s\S]*?-->/g;
const PT_OPEN = /<((?:[A-Za-z_][\w.-]*:)?)(trkpt|rtept)\b([^>]*?)(\/?)>/g;
const ELE = /<(?:[A-Za-z_][\w.-]*:)?ele\b[^>]*?(\/?)>(?:([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?ele\s*>)?/g;

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs);
  return m ? (m[1] ?? m[2]) : null;
}

/** (lat, lon, ele) from every trkpt/rtept in document order (analyze_gpx.parse_points). */
export function parseGpxPoints(xml: string): RoutePt[] {
  const s = xml.replace(COMMENT, "");
  if (!/<(?:[A-Za-z_][\w.-]*:)?gpx\b/.test(s)) throw new GpxError("not a GPX document (no <gpx> element)");
  const pts: RoutePt[] = [];
  PT_OPEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PT_OPEN.exec(s))) {
    const [, prefix, name, attrs, selfClose] = m;
    let body = "";
    if (!selfClose) {
      const close = s.indexOf(`</${prefix}${name}`, PT_OPEN.lastIndex);
      body = close < 0 ? "" : s.slice(PT_OPEN.lastIndex, close);
      if (close >= 0) PT_OPEN.lastIndex = close;
    }
    const lat = pyFloat(attr(attrs, "lat"));
    const lon = pyFloat(attr(attrs, "lon"));
    if (lat === null || lon === null) continue;
    let ele: number | null = null;
    ELE.lastIndex = 0;
    let e: RegExpExecArray | null;
    while ((e = ELE.exec(body))) {
      const text = e[1] ? undefined : e[2];
      if (text) {                       // first <ele> child that has text
        ele = pyFloat(text);
        break;
      }
    }
    pts.push([lat, lon, ele]);
  }
  return pts;
}

// ---------------------------------------------------------------- rides ----

/** One history ride, column-wise. Row i is the i-th <trkpt> download_gpx wrote. */
export interface RideRec {
  v: 2;
  aid: string;
  t: (number | null)[];    // epoch seconds (the GPX's naive timestamps read as UTC)
  la: number[];
  lo: number[];
  el: (number | null)[];
  sp: (number | null)[];   // m/s
  hr: (number | null)[];
  pw: (number | null)[];
}

export function encodeRide(r: RideRec): Uint8Array {
  return gzipSync(Buffer.from(JSON.stringify(r)));
}

export function decodeRide(buf: ArrayBuffer | Uint8Array): RideRec {
  return JSON.parse(gunzipSync(Buffer.from(buf as ArrayBuffer)).toString("utf8")) as RideRec;
}

/** "YYYY-MM-DDTHH:MM:SSZ" — the GPX <time> text for a record timestamp. */
export function fmtTime(epoch: number): string {
  return new Date(epoch * 1000).toISOString().slice(0, 19) + "Z";
}

function parseNaive(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number);
  const t = Date.UTC(y, mo - 1, d, h, mi, se);
  const chk = new Date(t);
  if (chk.getUTCMonth() !== mo - 1 || chk.getUTCDate() !== d || h > 23 || mi > 59 || se > 61) return null;
  return t / 1000;
}

const num = (v: unknown): number => {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  throw new TypeError(`unsupported format string passed to ${v === null ? "NoneType" : typeof v}.__format__`);
};

/**
 * icu.download_gpx: fuse /activity/{id}/map latlngs with /streams into the same
 * rows the GPX writer produced (GPS dropouts skipped, values at GPX precision).
 */
export function buildRideRecord(
  aid: string,
  latlngs: unknown[],
  streams: { type: string; data?: unknown[] | null }[],
  startLocal?: string | null,
): RideRec {
  if (latlngs.length < 2) throw new GpxError(`${aid}: no GPS geometry`);
  const S: Record<string, unknown[]> = {};
  for (const s of streams) S[s.type] = s.data || [];
  const tstream = S.time as unknown[] | undefined;
  const hr = S.heartrate || [];
  const vel = S.velocity_smooth || [];
  const alt = S.altitude || [];
  const pwr = S.watts || [];
  const n = Math.min(latlngs.length, tstream && tstream.length ? tstream.length : latlngs.length);

  let base = Date.UTC(2020, 0, 1) / 1000;
  if (startLocal) {
    const s = startLocal.replace(/Z/g, "").split("+")[0].split(".")[0].slice(0, 19);
    const b = parseNaive(s);
    if (b !== null) base = b;
  }
  const rec: RideRec = { v: 2, aid, t: [], la: [], lo: [], el: [], sp: [], hr: [], pw: [] };
  for (let i = 0; i < n; i++) {
    const ll = latlngs[i];
    if (!ll || !Array.isArray(ll) || ll.length < 2) continue;      // GPS dropout
    const tv = tstream && tstream.length && i < tstream.length ? tstream[i] : null;
    const secs = tv !== null && tv !== undefined ? num(tv) : i;
    const whole = Number.isInteger(secs) ? secs : Math.floor(pyRound(secs * 1e6) / 1e6);
    rec.la.push(Number(pyFixed(num(ll[0]), 6)));
    rec.lo.push(Number(pyFixed(num(ll[1]), 6)));
    rec.t.push(base + whole);
    rec.el.push(i < alt.length && alt[i] !== null && alt[i] !== undefined ? Number(pyFixed(num(alt[i]), 1)) : null);
    rec.sp.push(i < vel.length && vel[i] !== null && vel[i] !== undefined ? Number(pyFixed(num(vel[i]), 3)) : null);
    rec.hr.push(i < hr.length && hr[i] !== null && hr[i] !== undefined ? Math.trunc(num(hr[i])) : null);
    rec.pw.push(i < pwr.length && pwr[i] !== null && pwr[i] !== undefined ? Math.trunc(num(pwr[i])) : null);
  }
  return rec;
}

/**
 * Read a history GPX in the engine's own format (download_gpx output) into a
 * record — used to import existing local history and by the parity tests.
 */
export function parseHistoryGpx(xml: string, fallbackAid: string): RideRec {
  const s = xml.replace(COMMENT, "");
  const link = /<(?:[\w.-]+:)?link\b[^>]*\bhref\s*=\s*"([^"]*)"/.exec(s);
  let aid = fallbackAid;
  if (link) {
    const m = /\/activities\/(\w+)/.exec(link[1]);
    if (m) aid = m[1];
  }
  const rec: RideRec = { v: 2, aid, t: [], la: [], lo: [], el: [], sp: [], hr: [], pw: [] };
  const tag = (body: string, name: string): string | null => {
    const m = new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*>([^<]*)<`).exec(body);
    return m && m[1] ? m[1] : null;
  };
  PT_OPEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PT_OPEN.exec(s))) {
    const [, prefix, name, attrs, selfClose] = m;
    if (name !== "trkpt") continue;
    let body = "";
    if (!selfClose) {
      const close = s.indexOf(`</${prefix}${name}`, PT_OPEN.lastIndex);
      body = close < 0 ? "" : s.slice(PT_OPEN.lastIndex, close);
      if (close >= 0) PT_OPEN.lastIndex = close;
    }
    const lat = pyFloat(attr(attrs, "lat"));
    const lon = pyFloat(attr(attrs, "lon"));
    if (lat === null || lon === null) continue;
    const tm = tag(body, "time");
    const t = tm ? parseNaive(tm.trim().replace(/Z$/, "")) : null;
    rec.la.push(lat);
    rec.lo.push(lon);
    rec.t.push(t);
    rec.el.push(pyFloat(tag(body, "ele")));
    rec.sp.push(pyFloat(tag(body, "speed")));
    rec.hr.push(pyFloat(tag(body, "hr")));
    rec.pw.push(pyFloat(tag(body, "power")));
  }
  return rec;
}
