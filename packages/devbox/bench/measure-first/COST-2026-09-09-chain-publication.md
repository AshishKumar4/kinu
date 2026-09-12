# Snapshot-chain publication cost, 2026-09-09

**Not a decision.** `DEFAULT_DEVBOX_STRATEGY` stays `snapshot-chain` and
nothing here promotes a challenger or changes a constant. This report exists
because `DECISIVE-2026-09-05.md` records the win without its price: it says
what snapshot-chain beat and how, and says nothing about what a publication
costs as a box keeps working. A reader deciding whether to revisit the
strategy needs the cost beside the win.

Measured against the shipped module at `7f27576ca`, `snapshot-chain.ts` blob
`179a0123f`, with the matched-chain harness on the same host and the same
proxy counting boundary as the other chain cohorts. `putUploadBytes` is PUT
request-body bytes: what went UP.

## What one publication costs

A checkpoint uploads one squashfs archive of the WHOLE cumulative delta, and
rewrites it onto the same `delta.sqsh` key each time. So the cost of a
publication is set by the cumulative changed set since the base — not by the
history length, not by the tree size, and not by the size of the edit that
triggered it.

Two controls separate those, on the same 4/8/16/32/64 quiesce ladder over a
2-file tree and a 1000-file tree, 10 rows each, 20 rows and 496 publications
in total, all correct.

**Constant changed set** (`C0-history`: the same 32 KiB `churn.bin` rewritten
per generation). Publication 1 uploads the base — 36,864 B on the 2-file tree,
40,960 B on the 1000-file tree — and every later publication uploads a flat
36,864 B in 2 PUTs, at generation 64 exactly as at generation 2. Cumulative
store bytes stop at 73,728 (2-file) and 77,824 (1000-file) after the second
publication and never move again. One base object id survives all 64
generations; 0 deletes, 0 orphans, no fallback. A 500x larger base tree moved
the per-publication upload not one byte.

**Growing changed set** (`C0-growth`: a NEW 32 KiB file per generation, so
generation N's cumulative delta holds N-1 generations of change).
Per-publication upload tracks the cumulative changed set exactly, and
therefore grows linearly with history:

| publications | upload at last publication | total uploaded across history | final store bytes | rebases |
| --- | --- | --- | --- | --- |
| 4 | 135,168 | 278,528 | 241,664 | 2 |
| 8 | 233,472 | 1,048,576 | 573,440 | 3 |
| 16 | 528,384 | 4,194,304 | 634,880 | 6 |
| 32 | 1,019,904 | 16,744,448 | 2,146,304 | 11 |
| 64 | 2,101,248 | 67,043,328 | 2,207,744 | 22 |

2-file tree; the 1000-file tree differs by under 0.5% on every column.

Total bytes moved across a history of N publications is **quadratic**:
`totalUpload / N²` is constant at 16,352-17,920 across the entire ladder and
both trees. Sixty-four publications moved 67,043,328 B to hold a 2,207,744 B
store, a write amplification of about 30x over the history.

Cumulative STORE bytes stay bounded at the live tree size (2,207,744 B against
a live tree of 64 x 32,768 = 2,097,152 B). **The cost is bandwidth and object
writes, not storage.**

## What bounds it

`REBASE_DELTA_RATIO = 1` fires whenever the delta exceeds the base, at a
quiesce only. Measured: 22 rebases over 64 publications, every third
publication, identically in both trees. That is what holds per-publication
upload to roughly one base instead of letting the delta grow without limit,
and what keeps stored bytes at tree size. The ratio is correct as it stands;
this report is the production measurement its comment asked for.

## The single-edit figure

`C3` ran the native overwrite matrix — 27 cases, sizes 3,145,728 / 12,582,912
/ 50,331,648 x positions beginning/middle/end x extraRuns 0/64/256, two 64 KiB
overwrites each at a fixed offset — through the chain at the same boundary.
27/27 correct on exact bytes, both neighbours and a probed hole; 54/54 rounds.

An overwrite published on its own re-archives the whole changed inode:
790,528 B at extraRuns 0, 1,052,672 B at 64, 1,839,104-1,847,296 B at 256, in
2 PUTs, with round 2 costing exactly what round 1 cost. That is 12.1x-28.2x
the 65,536-byte edit and 8.2x-15.8x the native publisher's 91,472-147,329
bytes put for the same edit, beside native's 72,045-135,571 staged and
16,463-63,107 metadata bytes. The amount is fixed by the file's real data
volume: byte-identical at 3 MiB, 12 MiB and 48 MiB logical size, and
byte-identical across the three overwrite positions.

**Per-edit is not the product unit.** A tick checkpoint is gated by
`ports.checkpointIntervalMs()`, so every edit inside one interval collapses
into one publication over the cumulative changed set; a turn making ten edits
to one file inside one interval pays one archive, not ten. The per-turn figure
is therefore `publications-per-turn x archive(cumulative changed set)`, and
publications per turn and edits per turn are UNMEASURED. `TurnFileLedger`
emits the right signal — one `file_edit` run event per turn carrying
`attempts` and `applied` — but no recorded `run_events` corpus exists to read
it from, so no per-turn number is stated here rather than estimated.

## Provenance

- Revision `7f27576ca6dff3acb6d5515234fed2cf01b9adaa`, `snapshot-chain.ts`
  blob `179a0123f0093d8acb290fde48c1b56ff0907803`.
- Cohorts `C3-7e4a7d9a-9ce15c72`, `C0-history-7e4a7d9a-9ce15c72`,
  `C0-growth-7e4a7d9a-9ce15c72`; rows and raws in
  `matched-controls-table-20260909-blank-cells.json` beside them.
- Native comparison rows extracted read-only from the frozen native cohort
  `C3-9d58834b-fa94f34c`. "Staged" is `seal.bytesStaged`; "metadata" is
  `buildWork[0].recordBytesWritten`. `work.restore.metadataBytes` is a
  different and far smaller quantity (1,844-2,054 B) and is not that column.
- Both transport hops are local, so wall-clock here supports no cloud claim.
- The C3 and C0-history matrices were executed three times — once at
  `904c22cc4` and twice at `7f27576ca` under two harness digests — and agree
  byte-for-byte on every figure above.
