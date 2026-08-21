/**
 * Browser stubs for node builtins reached through @kinu.run/core imports in the
 * design gallery (gallery.vite.config.ts only). The gallery renders components
 * with mock data and never executes these paths; calling them is a bug.
 */
export function createHash(): never {
  throw new Error("node:crypto is not available in the design gallery");
}
export function createHmac(): never {
  throw new Error("node:crypto is not available in the design gallery");
}
export function randomBytes(): never {
  throw new Error("node:crypto is not available in the design gallery");
}
export function timingSafeEqual(): never {
  throw new Error("node:crypto is not available in the design gallery");
}
export default { createHash, createHmac, randomBytes, timingSafeEqual };

/**
 * node:async_hooks, for @nimbus-sh/fabric's timers.ts, which constructs an
 * AsyncLocalStorage at module scope. Construction must succeed for the bundle
 * to load; the gallery never runs an outbox drain, so USING it is a bug.
 */
export class AsyncLocalStorage {
  run(): never {
    throw new Error("node:async_hooks is not available in the design gallery");
  }
  getStore(): undefined {
    return undefined;
  }
}
