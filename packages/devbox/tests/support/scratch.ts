/**
 * The prefix devbox's own suites mint scratch directories under.
 *
 * Package-local on purpose: devbox is standalone — `tests/independence.test.ts`
 * refuses a workspace dependency and `gate:undeclared-imports` refuses an
 * undeclared one, so `scratchDir` from test-utils is out of reach and each
 * suite mints under this prefix and releases in its own `afterAll`, where the
 * hook actually fires. Only the NAME is shared: `SCRATCH_PREFIXES` opens with
 * `kinu-`, so `scripts/preflight.ts` counts and reclaims these without
 * test-utils naming them.
 */
export const DEVBOX_SCRATCH_PREFIX = 'kinu-devbox-scratch-';
