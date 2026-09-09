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
 * arm that is no longer shipped. The shipped strategy's own reds were either
 * fixed or turned into the arm's structural refusals, where the measurement
 * lives beside the reason: `snapshot-chain`/6.12 cleared on 2026-09-05, and
 * 6.14 and 6.15 became the arm's own declaration — the format archives the
 * whole changed inode. A new row here is a deliberate act, and the suite fails
 * in both directions until it is.
 */
export const KNOWN_RED: readonly KnownRed[] = [];
