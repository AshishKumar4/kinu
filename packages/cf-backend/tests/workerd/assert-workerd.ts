/**
 * The pool assertion: this layer is green only if it really ran in workerd.
 *
 * `vitest.config.ts` states what belongs here — a test whose assertion is about
 * the PLATFORM — so the runtime under the test IS the subject. Nothing in the
 * layer checked that it was the runtime that ran. `@cloudflare/vitest-pool-workers`
 * is a POOL, and a pool that cannot start is a configuration error vitest can
 * survive: the files are then executed by whatever pool answers, under Node, and
 * only a suite that imports `cloudflare:test` or `cloudflare:workers` notices.
 * Two files here import neither — `instruction-digest.test.ts` and
 * `abort-final-chunk.test.ts` — and the first of them is the whole argument: its
 * subject is workerd honouring `node:crypto`'s SYNCHRONOUS `createHash` under
 * `nodejs_compat`, a claim Node satisfies trivially. MEASURED 2026-09-16: with
 * the `cloudflareTest` plugin removed from a scratch copy of this config, that
 * file ran on vitest's default pool and reported 4 passed — a green that had
 * measured nothing about the runtime we deploy.
 *
 * `navigator.userAgent` is the cheapest unambiguous probe: workerd hardcodes the
 * value and Node reports its own version there. MEASURED 2026-09-16 on this
 * tree, both directions, by `vitest run --root packages/cf-backend
 * tests/workerd/<one file>`: inside this pool `navigator.userAgent` is
 * `'Cloudflare-Workers'`; on the scratch config above it is `'Node.js/22'`,
 * which is the red this file exists to produce.
 *
 * A red here is the pool, never this check: the repair is the config or the
 * runtime, and deleting the assertion restores the silent green it names.
 */
if (navigator.userAgent !== 'Cloudflare-Workers') {
  throw new Error(
    `The workerd layer ran outside workerd: navigator.userAgent is ${JSON.stringify(navigator.userAgent)}, `
    + 'so @cloudflare/vitest-pool-workers did not start and every platform assertion below measures '
    + 'a runtime this project does not deploy.',
  );
}
