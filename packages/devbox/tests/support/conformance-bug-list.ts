/**
 * The conformance bug list: every (arm, cell) pair that is RED on the current
 * tree, with the reason the matrix printed when it was recorded.
 *
 * This is a lock, not an allowlist. `strategy-conformance.test.ts` runs every
 * cell against every arm; a cell that FAILS without a row here fails the
 * suite (a regression), and a row here whose cell PASSES fails the suite too
 * (the fix landed; record the win by deleting the row). The set of reds can
 * therefore only change on purpose, in a diff someone reads. Rows carry the
 * date they were recorded so a red that outlives the lanes meant to fix it is
 * visible as such.
 */

import type { DevboxStrategyName } from '../../src/storage';

export interface KnownRed {
  readonly arm: DevboxStrategyName;
  readonly cell: string;
  readonly since: string;
  readonly reason: string;
}

/**
 * EMPTY, AND THAT IS THE RECORD. Every row this lock has ever carried named an
 * arm that is no longer shipped, or a red the shipped arm has since cleared:
 * `snapshot-chain`/6.12 on 2026-09-05, and 6.22 on 2026-09-10 when the
 * chunked delta took the C3 overwrite from 89,478,664 bytes to under the
 * 196,608 bound in the same one object. A new row here is a deliberate act,
 * and the suite fails in both directions until it is.
 */
export const KNOWN_RED: readonly KnownRed[] = [];
