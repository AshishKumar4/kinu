// A model call's dependencies over a fixed credential store and a stubbed fetch, as provider contract suites need them.
import type { AuthResolution, ModelCallDeps } from '@kinu.run/core';

/** `creds` by credential key, `fetchFn` for the network; `affinity` the session and workspace cache keys. */
export function modelCallDeps(creds: Record<string, AuthResolution>, fetchFn: typeof fetch, affinity = 'kinu-test'): ModelCallDeps {
  const store = new Map(Object.entries(creds));

  return {
    env: {},
    sessionAffinity: affinity,
    workspaceAffinity: affinity,
    fetch: fetchFn,
    async getAuth(key) { return store.get(key) ?? null; },
    async hasCredential(key) { return store.has(key); },
    async listCredentialKeys() { return [...store.keys()]; },
  };
}
