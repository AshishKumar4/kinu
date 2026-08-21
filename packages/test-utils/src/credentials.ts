// Credential fixtures — auth-resolver shims for tests.
//
// The new provider seam exposes `getAuth(key)` returning ready-to-attach
// HTTP headers rather than raw Credential values. UserDO is the production
// implementation; this file gives tests the equivalent shape without
// spinning up a DO.
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
