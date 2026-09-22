/** Package-local because devbox cannot depend on test-utils; the `kinu-` prefix lets
 *  `scripts/preflight.ts` reclaim these dirs. Each suite releases in its own `afterAll`. */
export const DEVBOX_SCRATCH_PREFIX = 'kinu-devbox-scratch-';
