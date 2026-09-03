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
 * page-in and eviction work: `bounded-layers`/6.13, `merkle-pack`/6.13 and
 * `merkle-pack`/6.14 cleared and were deleted; `bounded-layers`/6.18 cleared
 * and was deleted; `bounded-layers`/6.14 improved (266 remote ops to 5) but
 * stays red against the O(1)=3 bound, for reasons stated in its own row.
 */
export const KNOWN_RED: readonly KnownRed[] = [
  {
    arm: 'snapshot-chain',
    cell: '6.12',
    since: '2026-09-02',
    reason: "bytesStaged 823296 > 2k + 4c for k=4 KiB; nodesRewritten 206 > p(d+2) = 3; seal.bytesStaged: n gives 823296, 10n gives 8196096; seal.bytesChunked: n gives 823296, 10n gives 8196096; seal.nodesRewritten: n gives 206, 10n gives 2034; publish.bytesPut: n gives 1133987, 10n gives 11288974",
  },
  {
    arm: 'overlay-cas',
    cell: '6.12',
    since: '2026-09-02',
    reason: "bytesStaged 823296 > 2k + 4c for k=4 KiB; nodesRewritten 206 > p(d+2) = 3; objectsPut 5 > ceil(k/P)+2 = 3; seal.bytesStaged: n gives 823296, 10n gives 8196096; seal.bytesChunked: n gives 823296, 10n gives 8196096; seal.nodesRewritten: n gives 206, 10n gives 2034; publish.bytesPut: n gives 64302, 10n gives 565706",
  },
  {
    arm: 'bounded-layers',
    cell: '6.12',
    since: '2026-09-02',
    reason: "bytesStaged 823296 > 2k + 4c for k=4 KiB; nodesRewritten 206 > p(d+2) = 3; objectsPut 5 > ceil(k/P)+2 = 3; seal.bytesStaged: n gives 823296, 10n gives 8196096; seal.bytesChunked: n gives 823296, 10n gives 8196096; seal.nodesRewritten: n gives 206, 10n gives 2034; publish.bytesPut: n gives 77016, 10n gives 707021; restore.totalRemoteOps: n gives 410, 10n gives 4010",
  },
  {
    arm: 'snapshot-chain',
    cell: '6.14',
    since: '2026-09-02',
    reason: "wake made 4 remote ops; O(1) is 3; the 64 KiB write chunked 68157440 bytes; the 64 KiB write put 89478808 bytes",
  },
  {
    arm: 'bounded-layers',
    cell: '6.14',
    since: '2026-09-03',
    reason: "wake made 5 remote ops; O(1) is 3 (the lane-4 lazy restore brought this from 266 to 5: the v1 control plane's attach-time verifyObject on rootObject and closureObject, plus openBoundedLayers' own root-plus-one-base-layer read, floor at 4; the 64 KiB write chunked and put bytes both now pass. closureObject verification is GC bookkeeping integrity, not the read path lazy restore covers, so removing it is out of this lane's scope)",
  },
  {
    arm: 'snapshot-chain',
    cell: '6.15',
    since: '2026-09-02',
    reason: "bytesPut 89478658 > 4 × 64 dirty pages × 16384 = 4194304",
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
    arm: 'bounded-layers',
    cell: '6.15',
    since: '2026-09-02',
    reason: "bytesPut 26798013 > 4 × 64 dirty pages × 16384 = 4194304",
  },
  {
    arm: 'snapshot-chain',
    cell: '6.18',
    since: '2026-09-02',
    reason: "the checkpoint under quota failed: staging /var/tmp/devbox/upper needs up to 23635 bytes and /var/tmp/devbox/stage has 976 free. Refusing to archive rather than filling the container disk and taking the box down mid-checkpoint.; nothing evicted clean bytes to make room; the wake served {\"notes.txt\":\"generation one\",\"src.txt\":\"export const one = 1;\"}",
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
];
