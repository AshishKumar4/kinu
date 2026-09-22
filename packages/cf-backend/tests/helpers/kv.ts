import type { KvStore } from '@kinu.run/agent-utils';

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
