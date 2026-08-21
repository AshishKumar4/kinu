/**
 * Browser stubs for the node builtins the client graph reaches through
 * `@kinu.run/core` imports. The barrel is served as source in dev, so every
 * module it re-exports loads in the browser even though nothing client-side
 * calls into these; the production build tree-shakes them away. Aliased in
 * for the CLIENT environment only (vite.config.ts, gallery.vite.config.ts) —
 * the worker keeps real node builtins. Calling one of these from client code
 * is a bug and throws rather than pretending.
 */
export function createHash(): never {
  throw new Error("node:crypto is not available in browser code");
}
export function createHmac(): never {
  throw new Error("node:crypto is not available in browser code");
}
export function randomBytes(): never {
  throw new Error("node:crypto is not available in browser code");
}
export function timingSafeEqual(): never {
  throw new Error("node:crypto is not available in browser code");
}
export default { createHash, createHmac, randomBytes, timingSafeEqual };

/**
 * node:async_hooks, for @nimbus-sh/fabric's timers.ts, which constructs an
 * AsyncLocalStorage at module scope. Construction must succeed for the bundle
 * to load; no browser path runs an outbox drain, so USING it is a bug.
 */
export class AsyncLocalStorage {
  run(): never {
    throw new Error("node:async_hooks is not available in browser code");
  }
  getStore(): undefined {
    return undefined;
  }
}
