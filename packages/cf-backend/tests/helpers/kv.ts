import type { KvStore } from '@kinu.run/agent-utils';
import * as v from 'valibot';

/** How long a Workers KV location keeps what it read: `cacheTtl`'s default 60 s (Cloudflare KV docs, "How KV works",
 *  read 2026-10-23: elsewhere "changes may take up to 60 seconds or more to be visible as their cached versions of the
 *  data time-out", and reads that found no key are cached too). */
const KV_CACHE_SECONDS = 60;

const CachedSchema = v.object({ value: v.nullable(v.string()) });

interface Entry {
  value: string;
  expiresAt: number;
}

export interface FakeKv extends KvStore {
  keys(): string[];
  ttlOf(key: string): number | null;
}

/** Keys expire on their TTL against the wall clock, so `setSystemTime` moves store and records together. */
export function makeKv(): FakeKv {
  const entries = new Map<string, Entry>();
  const ttls = new Map<string, number>();

  const live = (key: string): Entry | null => {
    const entry = entries.get(key);

    if (!entry) return null;

    if (entry.expiresAt <= Date.now()) {
      entries.delete(key);

      return null;
    }

    return entry;
  };

  return {
    async get(key: string) {
      return live(key)?.value ?? null;
    },
    async put(key: string, value: string, options: { expirationTtl: number }) {
      ttls.set(key, options.expirationTtl);
      entries.set(key, { value, expiresAt: Date.now() + options.expirationTtl * 1000 });
    },
    async delete(key: string) {
      entries.delete(key);
    },
    keys() {
      return [...entries.keys()].filter((key) => live(key) !== null);
    },
    ttlOf(key: string) {
      return ttls.get(key) ?? null;
    },
  };
}

/**
 * Workers KV as each location reads it: a location keeps what a read found, an absent key included, for KV's 60 s
 * cache, so a write made at another location stays unseen there until that copy expires; a location reads its own
 * writes at once. A copy expires as `makeKv`'s keys do, so `setSystemTime` ages it.
 */
export function locatedKv(): (location: string) => KvStore {
  const origin = makeKv();
  const caches = new Map<string, FakeKv>();

  return (location) => {
    const cache = caches.get(location) ?? makeKv();
    const keep = (key: string, value: string | null) => cache.put(key, JSON.stringify({ value }), { expirationTtl: KV_CACHE_SECONDS });

    caches.set(location, cache);

    return {
      async get(key: string) {
        const cached = await cache.get(key);

        if (cached !== null) return v.parse(CachedSchema, JSON.parse(cached)).value;
        const value = await origin.get(key);

        await keep(key, value);

        return value;
      },
      async put(key: string, value: string, options: { expirationTtl: number }) {
        await origin.put(key, value, options);
        await keep(key, value);
      },
      async delete(key: string) {
        await origin.delete(key);
        await keep(key, null);
      },
    };
  };
}
