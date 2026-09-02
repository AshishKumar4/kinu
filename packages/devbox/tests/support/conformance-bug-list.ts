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

/** Recorded from the matrix on origin/main 6d19d50e7 with this battery, 2026-09-02. */
export const KNOWN_RED: readonly KnownRed[] = [
  {
    arm: 'snapshot-chain',
    cell: '6.9',
    since: '2026-09-02',
    reason: "attach:after-store-mount: 4 mounts across both isolates, an uninterrupted wake makes 3; attach:after-layer-mount: 5 mounts across both isolates, an uninterrupted wake makes 3",
  },
  {
    arm: 'snapshot-chain',
    cell: '6.10',
    since: '2026-09-02',
    reason: "the late finalize reported committed; the wake served {\"extra.txt\":\"added by the second commit\",\"notes.txt\":\"generation two\",\"src.txt\":\"export const one = 1;\"}, the new boot published {\"notes.txt\":\"generation one\",\"src.txt\":\"export const one = 1;\",\"third.txt\":\"written by the third generation\"} (before the wake: {\"extra.txt\":\"added by the second commit\",\"notes.txt\":\"generation two\",\"src.txt\":\"expor…",
  },
  {
    arm: 'r2fs',
    cell: '6.10',
    since: '2026-09-02',
    reason: "the late finalize reported committed",
  },
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
    arm: 'merkle-pack',
    cell: '6.12',
    since: '2026-09-02',
    reason: "bytesStaged 823296 > 2k + 4c for k=4 KiB; nodesRewritten 207 > p(d+2) = 3; objectsPut 5 > ceil(k/P)+2 = 3; seal.bytesStaged: n gives 823296, 10n gives 8196096; seal.bytesChunked: n gives 823296, 10n gives 8196096; seal.nodesRewritten: n gives 207, 10n gives 2035; publish.bytesPut: n gives 123700, 10n gives 1143382; restore.totalRemoteOps: n gives 503, 10n gives 4839",
  },
  {
    arm: 'bounded-layers',
    cell: '6.13',
    since: '2026-09-02',
    reason: "RestoreWork.totalRemoteOps is 200006 for 1e5 files and 2006 for 1e3 (the commit, the wake and the exact tree pass since the control snapshot moved off argv; what remains is one object per file on restore plus a HEAD per closure object at attach, the lane-4 lazy-restore property)",
  },
  {
    arm: 'merkle-pack',
    cell: '6.13',
    since: '2026-09-02',
    reason: "the 100000-file commit did not commit: failed — index is 47217175 bytes, above maxPackBytes 4194304",
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
    since: '2026-09-02',
    reason: "wake made 266 remote ops; O(1) is 3; the 64 KiB write chunked 68157440 bytes",
  },
  {
    arm: 'merkle-pack',
    cell: '6.14',
    since: '2026-09-02',
    reason: "wake made 11292 remote ops; O(1) is 3; the 64 KiB write chunked 68157440 bytes; the 64 KiB write put 3728247 bytes",
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
    arm: 'merkle-pack',
    cell: '6.15',
    since: '2026-09-02',
    reason: "bytesPut 4539046 > 4 × 64 dirty pages × 16384 = 4194304",
  },
  {
    arm: 'r2fs',
    cell: '6.17',
    since: '2026-09-02',
    reason: "2 boots reported committed (A,B); the loser recorded no failure; both dirty sets were merged: {\"a.txt\":\"written by boot A\",\"b.txt\":\"written by boot B\",\"notes.txt\":\"generation one\",\"src.txt\":\"export const one = 1;\"}",
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
  {
    arm: 'bounded-layers',
    cell: '6.18',
    since: '2026-09-02',
    reason: "nothing evicted clean bytes to make room",
  },
  {
    arm: 'merkle-pack',
    cell: '6.18',
    since: '2026-09-02',
    reason: "nothing evicted clean bytes to make room",
  },
];
