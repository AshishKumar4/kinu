/**
 * This layer is green only if it really ran in workerd: a pool that cannot start lets vitest run the files under Node.
 * Measured 2026-09-16: without the `cloudflareTest` plugin, `instruction-digest.test.ts` reported 4 passed under Node;
 * `navigator.userAgent` is `'Cloudflare-Workers'` in this pool and `'Node.js/22'` there. A red here is the pool, not this check.
 */
if (navigator.userAgent !== 'Cloudflare-Workers') {
  throw new Error(
    `The workerd layer ran outside workerd: navigator.userAgent is ${JSON.stringify(navigator.userAgent)}, `
    + 'so @cloudflare/vitest-pool-workers did not start and every platform assertion below measures '
    + 'a runtime this project does not deploy.',
  );
}
