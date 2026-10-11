/**
 * The hosts this Worker's ASSETS binding is fetched under, in one place. ASSETS routes by pathname alone; each host is
 * `.invalid` (RFC 2606), internal to the binding. Under `vite dev` the dev server answers ASSETS, and its host guard
 * refuses every host it was not told of with a 403, so vite.config.ts admits exactly these. A cf capability: no other
 * backend has an ASSETS binding.
 */
export const ASSETS_HOSTS = {
  /** The agent bundle every agent's isolate, main's included, loads (agent-facets.ts). */
  agentBundle: 'assets.invalid',
  /** Nimbus's staged napi assets, fetched under a host it does not export (@nimbus-sh/worker runtime/staged-source.js). */
  nimbus: 'nimbus-internal.invalid',
} as const;
