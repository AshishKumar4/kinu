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
