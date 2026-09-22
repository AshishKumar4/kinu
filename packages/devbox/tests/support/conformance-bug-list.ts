/** Known-red (arm, cell) pairs: a lock, not an allowlist. An unlisted failing cell fails the
 *  suite, and so does a listed cell that passes, so the reds change only in a reviewed diff. */

import type { DevboxStrategyName } from '../../src/storage';

export interface KnownRed {
  readonly arm: DevboxStrategyName;
  readonly cell: string;
  readonly since: string;
  readonly reason: string;
}

/** Adding a row is deliberate: the suite fails in both directions until the list matches. */
export const KNOWN_RED: readonly KnownRed[] = [];
