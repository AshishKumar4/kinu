import type { KvStore } from '../../src/lib/kv';

interface Entry {
  value: string;
  expiresAt: number;
}

export interface FakeKv extends KvStore {
  /** Every key still readable now, for assertions about what a flow left behind. */
  keys(): string[];
  /** Seconds of TTL the last write for `key` asked KV for. */
  ttlOf(key: string): number | null;
}

/** In-memory KV honouring the one behaviour these tests depend on: a key stops
 *  being readable once its TTL is up. Reads the wall clock, so a suite moves
 *  time with `setSystemTime` and the store and the records it holds expire
 *  together. */
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
