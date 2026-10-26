/** Spherical geometry shared by every layer (mirrors the engine scripts). */

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export type LatLon = readonly [number, number, ...unknown[]];

export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000.0;
  const p1 = lat1 * D2R;
  const p2 = lat2 * D2R;
  const dp = (lat2 - lat1) * D2R;
  const dl = (lon2 - lon1) * D2R;
  const s1 = Math.sin(dp / 2);
  const s2 = Math.sin(dl / 2);
  const a = s1 * s1 + Math.cos(p1) * Math.cos(p2) * (s2 * s2);
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Initial compass bearing from point 1 to point 2, degrees [0, 360). */
export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * D2R;
  const p2 = lat2 * D2R;
  const dl = (lon2 - lon1) * D2R;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * R2D + 360.0) % 360.0;
}

/** Absolute heading change between two bearings, degrees [0, 180]. */
export function turnAngle(b1: number, b2: number): number {
  const d = Math.abs(b2 - b1) % 360;
  return d <= 180 ? d : 360 - d;
}

export const NDIR = 8;

/** Heading → 0..NDIR-1 (bin 0 centred on North). */
export function dirBin(bearing: number): number {
  return Math.trunc(((bearing + 360.0 / NDIR / 2) % 360.0) / (360.0 / NDIR)) % NDIR;
}

/** Cumulative along-track distance (m) per point. */
export function cumdist(pts: readonly LatLon[]): number[] {
  const cum = [0.0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + haversineM(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
  }
  return cum;
}
