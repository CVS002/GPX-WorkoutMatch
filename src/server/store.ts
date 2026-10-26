/**
 * Persistent state in Netlify Blobs (replaces engine/data/ and appdata/).
 *
 *   cache    road_db.json, effort_db.json, osm_hazards.json, osm_streets.json,
 *            workout_bank.json (when refreshed), ride_index.json,
 *            known-roads-corrections.md
 *   history  one gzipped ride record per activity id (was history/*.gpx)
 *   routes   per uploaded route: <rid>/session, /pts, /haz, /ctx, /map, /cap
 *   jobs     maintenance job records (status + log)
 *
 * Stores are site-wide and strongly consistent, so a write in one function
 * instance is visible to the next request on any other. Large caches are
 * memoised per warm instance and revalidated by ETag.
 */
import { getStore } from "@netlify/blobs";

export interface KV {
  getText(key: string): Promise<{ data: string; etag?: string } | null>;
  /** Conditional read: returns "unchanged" when etag still matches. */
  getTextIfChanged(key: string, etag: string): Promise<{ data: string; etag?: string } | null | "unchanged">;
  getBytes(key: string): Promise<Uint8Array | null>;
  setText(key: string, data: string): Promise<void>;
  setBytes(key: string, data: Uint8Array): Promise<void>;
  list(prefix?: string): Promise<{ key: string; etag: string }[]>;
  delete(key: string): Promise<void>;
}

export type StoreName = "cache" | "history" | "routes" | "jobs";

function blobsKV(name: StoreName): KV {
  const st = getStore({ name, consistency: "strong" });
  return {
    async getText(key) {
      const r = await st.getWithMetadata(key, { type: "text" });
      return r ? { data: r.data, etag: r.etag } : null;
    },
    async getTextIfChanged(key, etag) {
      const r = await st.getWithMetadata(key, { type: "text", etag });
      if (r === null) return null;
      if (r.data === null) return "unchanged";        // etag still matched server-side
      return { data: r.data, etag: r.etag };
    },
    async getBytes(key) {
      const r = await st.get(key, { type: "arrayBuffer" });
      return r ? new Uint8Array(r) : null;
    },
    async setText(key, data) {
      await st.set(key, data);
    },
    async setBytes(key, data) {
      await st.set(key, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
    },
    async list(prefix) {
      const r = await st.list(prefix ? { prefix } : {});
      return r.blobs.map((b) => ({ key: b.key, etag: b.etag }));
    },
    async delete(key) {
      await st.delete(key);
    },
  };
}

/** In-memory KV for tests and local runs without Netlify. */
export function memoryKV(): KV {
  const m = new Map<string, { data: Uint8Array; etag: string }>();
  let seq = 0;
  const put = (k: string, d: Uint8Array) => m.set(k, { data: d, etag: `"e${++seq}"` });
  return {
    async getText(key) {
      const v = m.get(key);
      return v ? { data: Buffer.from(v.data).toString("utf8"), etag: v.etag } : null;
    },
    async getTextIfChanged(key, etag) {
      const v = m.get(key);
      if (!v) return null;
      if (v.etag === etag) return "unchanged";
      return { data: Buffer.from(v.data).toString("utf8"), etag: v.etag };
    },
    async getBytes(key) {
      return m.get(key)?.data ?? null;
    },
    async setText(key, data) {
      put(key, new Uint8Array(Buffer.from(data, "utf8")));
    },
    async setBytes(key, data) {
      put(key, data);
    },
    async list(prefix) {
      return [...m.entries()].filter(([k]) => !prefix || k.startsWith(prefix)).map(([key, v]) => ({ key, etag: v.etag }));
    },
    async delete(key) {
      m.delete(key);
    },
  };
}

let factory: (name: StoreName) => KV = blobsKV;
const instances = new Map<StoreName, KV>();

/** Swap the backend (tests). */
export function useStores(f: (name: StoreName) => KV): void {
  factory = f;
  instances.clear();
  memo.clear();
}

export function kv(name: StoreName): KV {
  let s = instances.get(name);
  if (!s) instances.set(name, (s = factory(name)));
  return s;
}

export async function getJSON<T>(name: StoreName, key: string): Promise<T | null> {
  const r = await kv(name).getText(key);
  return r ? (JSON.parse(r.data) as T) : null;
}

export async function setJSON(name: StoreName, key: string, value: unknown): Promise<void> {
  await kv(name).setText(key, JSON.stringify(value));
}

const memo = new Map<string, { etag?: string; value: unknown }>();

/** A cache-store JSON blob, memoised across requests on a warm instance. */
export async function cachedJSON<T>(key: string): Promise<T | null> {
  const m = memo.get(key);
  if (m?.etag) {
    const r = await kv("cache").getTextIfChanged(key, m.etag);
    if (r === "unchanged") return m.value as T;
    if (r === null) {
      memo.delete(key);
      return null;
    }
    const v = JSON.parse(r.data) as T;
    memo.set(key, { etag: r.etag, value: v });
    return v;
  }
  const r = await kv("cache").getText(key);
  if (!r) return null;
  const v = JSON.parse(r.data) as T;
  memo.set(key, { etag: r.etag, value: v });
  return v;
}

/** Write a cache blob and drop this instance's memo of it. */
export async function putCacheJSON(key: string, value: unknown): Promise<void> {
  await setJSON("cache", key, value);
  memo.delete(key);
}
