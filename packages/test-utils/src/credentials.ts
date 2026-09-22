// Auth-resolver fixtures: the `getAuth(key)` header-bundle shape UserDO provides, without a DO.
import type { AuthResolution, AuthResolver } from '@kinu.run/core';

export interface TestAuth {
  getAuth: AuthResolver;
  hasCredential: (key: string) => Promise<boolean>;
  set: (key: string, value: AuthResolution) => void;
  remove: (key: string) => void;
}

/** Build a test auth resolver pre-loaded with the given header bundles. */
export function createTestAuth(entries: Record<string, AuthResolution> = {}): TestAuth {
  const store = new Map<string, AuthResolution>(Object.entries(entries));

  return {
    async getAuth(key) { return store.get(key) ?? null; },
    async hasCredential(key) { return store.has(key); },
    set(key, value) { store.set(key, value); },
    remove(key) { store.delete(key); },
  };
}
