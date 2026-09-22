/** Client-only node builtin stubs (dev serves the core barrel as source); calling one is a bug and throws. */
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

/** For @nimbus-sh/fabric's module-scope AsyncLocalStorage: construction must succeed, use throws. */
export class AsyncLocalStorage {
  run(): never {
    throw new Error("node:async_hooks is not available in browser code");
  }
  getStore(): undefined {
    return undefined;
  }
}

/** For core's prompting/volatile-context.ts module-scope import; never called client-side. */
export function isDeepStrictEqual(): never {
  throw new Error("node:util is not available in browser code");
}
