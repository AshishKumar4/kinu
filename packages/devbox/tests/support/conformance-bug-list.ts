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
 * Recorded from the matrix on origin/main 6d19d50e7 with this battery,
 * 2026-09-02. Rows dated 2026-09-03 were re-measured by the lane-4 lazy
 * page-in and eviction work. On 2026-09-05 `snapshot-chain`/6.12 cleared and
 * `snapshot-chain`/6.14 and 6.15 moved to the arm's own structural refusal:
 * the format archives the whole changed inode, and the measurement is in the
 * arm's declaration. Later on 2026-09-05 the bounded-layers arm began to
 * fence through `captureFromJournalDelta` as the deployed runner does, and
 * its 6.12, 6.14, 6.15 and 6.21 rows cleared; the modeled daemon began to
 * key its dirty set and boundary map by inode as the C daemon does, and the
 * `merkle-pack`/6.14 row appeared. The restored-inode boundary handback
 * cleared that row on 2026-09-06; the remaining rows still fail.
 */
export const KNOWN_RED: readonly KnownRed[] = [
  {
    arm: 'overlay-cas',
    cell: '6.12',
    since: '2026-09-02',
    reason: "bytesStaged 823296 > 2k + 4c for k=4 KiB; nodesRewritten 206 > p(d+2) = 3; objectsPut 5 > ceil(k/P)+2 = 3; seal.bytesStaged: n gives 823296, 10n gives 8196096; seal.bytesChunked: n gives 823296, 10n gives 8196096; seal.nodesRewritten: n gives 206, 10n gives 2034; publish.bytesPut: n gives 64302, 10n gives 565706",
  },
  {
    arm: 'r2fs',
    cell: '6.15',
    since: '2026-09-02',
    reason: "bytesPut 67108864 > 4 × 64 dirty pages × 16384 = 4194304",
  },
  {
    arm: 'overlay-cas',
    cell: '6.15',
    since: '2026-09-02',
    reason: "bytesPut 93874582 > 4 × 64 dirty pages × 16384 = 4194304",
  },
  {
    arm: 'r2fs',
    cell: '6.18',
    since: '2026-09-02',
    reason: "nothing evicted clean bytes to make room",
  },
  {
    arm: 'overlay-cas',
    cell: '6.18',
    since: '2026-09-02',
    reason: "nothing evicted clean bytes to make room",
  },
  {
    arm: 'overlay-cas',
    cell: '6.21',
    since: '2026-09-05',
    reason: "64 KiB backup bytesPut 2934023 at 10,000 files against 411000 at 1,000: the commit rewrites the tree manifest, so a fixed change puts bytes that grow with the tree",
  },
  {
    arm: 'merkle-pack',
    cell: '6.21',
    since: '2026-09-05',
    reason: "64 KiB backup bytesPut 5139 at 10,000 files against 4505 at 1,000 (12.3% over the 10% bar, byte-identical across reruns): the v2 pack ledger is O(#packs) by design (contracts.ts PackLedgerSchema) and 40 MiB is two 32 MiB packs where 4 MiB is one; restore ops hold at 3 and 3",
  },
];
