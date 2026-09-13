# Devbox decisions

The decision log for `packages/devbox`. Read it before changing the package.
One entry per decision: what was decided, the evidence that settled it, the
date, the commit. A decision without a measurement is a hypothesis and says
so. A change that reverses an entry names the entry and re-runs its
measurement under both shapes before it lands.

Report files named below live under `packages/devbox/bench/measure-first/`.
Owner messages live under `docs/research/user-messages/`.

## Requirements (the owner's, verbatim where quoted)

R1. Restore runs inside the container's `onStart`, once per fresh container
start, inside `blockConcurrencyWhile`, so nothing touches the container until
it is ready. Stated 2026-08-17 (m292), restated 2026-08-24 (m628), 2026-08-26
(m704), 2026-09-01 (m859), and 2026-09-09: "I want restores and resumption to
happen within blockConcurrencyWhile, once per container start to ensure
idempotency and that nothing else touches the container until it's fully
ready." SDK patches are allowed to make this hold.

R2. Restore work is O(1) or O(log N) in stored bytes and file count, within
the ~30 s block cap. Stated 2026-08-26 (m705), restated 2026-09-13.

R3. The best supported strategy ships. Replace snapshot-chain only if an
alternative is demonstrably better on R1, R2, publication cost and
correctness. Stated 2026-09-13: "a better replacement IF such exists".

R4. Direct container-to-R2 payloads; frequent asynchronous persistence with a
narrow loss window; minimal moving parts. Stated 2026-08-26 (m702, m712).

## Platform contract (measured, not inferred)

P1. Container disk is ephemeral. Sleep, stop, restart, or destroy loses every
local byte; the next start has the image's disk, whatever the sandbox id.
Official: developers.cloudflare.com/containers/concepts/architecture,
"Persistent disk", updated 2026-08-28. A Durable Object reset beside a
container that keeps running does not lose that disk.

P2. A timer set inside `blockConcurrencyWhile` fires on schedule. Measured
2026-09-13 on a plain Durable Object: a 50 ms `setTimeout` awaited inside the
block completed at exactly 50 ms. Evidence: `kinu-logs/startup-probe/`
(`p1-get-timer-inside.body`, `observations.md`). The earlier claim in
`lifecycle.ts` that timers starve in the block was a hypothesis written as
fact; it is withdrawn.

P3. One control exec inside `onStart` completes when the block opens against
an accepting control server, and never completes when it does not. Measured
2026-09-13 on fresh containers, three of each: `startAndWaitForPorts({ports:
3000})` then exec answered in 118 to 125 ms, 3/3; `start()` then exec held
the block to the cap and reset the object at 41 s, 3/3. Port 3000 is
`@cloudflare/sandbox`'s own RPC control listener (`Sandbox.defaultPort`); the
port wait runs outside the block with real timers. Probe source:
`packages/devbox/bench/onstart-probe.ts`, `probe-worker.ts`,
`wrangler.probe.jsonc`.

## Decisions

D1. Admission is port-proven. The container-start path proves the control
listener answers before the block opens, then restores inside the block.
Decided 2026-09-09 (`6e96741cc`, "admit only through startAndWaitForPorts"),
reversed 2026-09-09 (`bde0047cb`, on the mistaken premise that port 3000 was
an app port), re-decided 2026-09-13 on P3. Status: rebuilding on
`feat/devbox-gated-restore`. The five resets measured 2026-09-10
(DECISIVE-2026-09-05.md, "Six fresh starts") were measured under the reversed
shape and do not bear on the port-proven one.

D2. Attach cost is O(M + L + D), not O(1). Attach mounts the store subtree
and the base and legacy-delta lowers lazily, reads the chunked manifest
(M records, one per changed file), and materialises every chunked file into
the upper before readiness: for a changed big file that is its whole base
plus its overrides, so D counts the full base bytes of each changed chunked
file. Readiness is published only after that. Decided 2026-09-13 after three
lazy designs were refuted: first-touch hydration (readiness would expose base
bytes to supervised processes and previews), hydration on the first
post-readiness command (same exposure), and serving overrides as a sparse
delta lower (measured with fuse-overlayfs 1.7.1: a sparse newer inode shadows
the whole base inode, holes read as zero; `tests/support/sparse-lower-probe.sh`).
R2's O(1) attach needs a block-serving layer inside the container and is
open (O2). Publication stays chunked (D4).

D3. `onStart` reaches the container only through the budgeted restore path
after a port-proven start. `scripts/do-init-gate.ts` pins this. Its previous
invariant (the hook reaches no container) enforced the withdrawn P2
hypothesis and is replaced, with red fixtures in both directions.

D4. Chunked delta publication stays. A checkpoint publishes changed 16 KiB
blocks plus whole small files in one delta object, so a 64 KiB overwrite in a
64 MiB file publishes under 196,608 bytes (`C3_BYTES_BOUND`). Decided
2026-09-09 (`baf033132`, `006289643`) from COST-2026-09-09-chain-publication.md,
which measured whole-delta publication re-uploading unchanged dirty data
quadratically. D2 changes where the delta is consumed, not how it is written.

D5. Snapshot-chain is the current strategy under R3. Each alternative's
disposition, from the reconstruction of 2026-09-13:

| Candidate | Evidence | Disposition |
| --- | --- | --- |
| r2fs / s3fs workspace | Attached in 3,362 ms and preserved the marker on 2026-09-04; stopped after three ticks; sparse, hardlink and single-writer limits recorded | Not shown better; not disproven for custom FUSE designs |
| overlay-cas | 64 MiB quiesce 67,723 to 37,855 ms with 16-wide concurrency; large pending recovery over 300,000 ms; held-byte metering unreliable | Measured configuration missed the recovery bound; not a verdict on every CAS layout |
| bounded-layers | 40/40 deciding ticks in one configuration; lazy wake constant at 5 requests from 1k to 100k files but fetched bytes 495,655 to 49,609,348 | Unsettled; constant request count is not constant work |
| merkle-pack v1 | Full index read on open; 4 MiB cap refused large trees; 4/40 ticks versus chain 40/40 | Structural disadvantage for this full-index design; paged designs not judged |
| native root/extent + merkle v4 | Matched C1 lookup 1,038 to 5,183 GETs versus chain 5; dirty MAP_SHARED writes escaped FUSE; refusing them broke SQLite WAL | Not shown better on the preserved configuration |
| snapshot-chain, chunked | Local C3 and many-file proofs pass; the 2026-09-12 live run refused admission on G2, G3, G6 | Current strategy; live acceptance open |

No comparison run to date was admitted end to end; see "Comparisons not
admitted" in `kinu-logs/devbox-history-report.json`. The removal of the
alternatives' source on 2026-09-09 (`337eaf6f9`) followed an owner choice to
measure C3 and chain publication first, not an owner finding that the
alternatives were defeated. They are recoverable from the `archive/*` tags
named in `docs/BRANCH-ARCHIVE.md`.

D6. The test double models the platform. `FakeSandbox.stop()` and
`destroy()` discard container-local state and keep Durable Object rows and
remote objects; `resetIsolate()` keeps the disk. Decided 2026-09-13 from P1
(`0a913d39c`). Before this the double kept the disk across a stop, so tests
that passed under it proved reactivation, not restart.

D7. Block-layer design gate. Status: designed, unimplemented. The conditional
read-only composition design and proposed Lean statements are in
[DEVBOX-BLOCK-LAYER.md](DEVBOX-BLOCK-LAYER.md). Evaluated 2026-09-13 on
`feat/devbox-block-layer`, based on `df1694e9c`; this entry and the design
are committed together. No candidate meets the strengthened full-hook
bound for arbitrary restored workloads, so none is adopted.

A read-only range-serving lower removes eager base-file copying from storage
attach, but fuse-overlayfs copies the complete inode on a writable open.
Saved services can perform that open, or read the entire file, before
readiness. A plain sparse-file bind exposes zeros; a writable FUSE bind
needs a kernel-visible checkpoint barrier before its callback bitmap is
complete. The prior native dirty-mmap failure remains relevant. A tiny
local clone from actual squashfuse to the image upper failed EXDEV, as the
FICLONE same-filesystem contract requires.

V1 inline override arrays also invalidate O(M + L) when M counts files:
the real planner produced 525 to 6,616,994 manifest bytes for one changed
file and one deduplicated chunk, over synthetic logical sizes 64 KiB to
1 GiB. A proposed V2 replaces `over` with a range-paged index reference
inside the existing delta object and refuses V1 by version; no format
change has shipped. Other changed namespace records must be counted too.
D2, D4 and O2 remain in force. Measurements and exact commands:
`kinu-logs/block-layer/evidence.json`. No product deployment or Lean proof
was run, and no full-hook latency or callback-only publication bound is
claimed.

## Measurement contract for a strategy comparison

Vary stored bytes B, file count N, changed bytes D and demanded bytes Q
separately, on identical committed trees. Capture pre-admission metadata
bytes, CPU work, request count, peak memory and elapsed hook time. A request
count is not a cost. A local workerd clock is not a cloud latency. A run is
admitted only when every G gate passes; a refused run ranks nothing.

## Open

O1. Live acceptance of the chunked chain on deployed Containers and R2 after
the evidence corrections of 2026-09-12 (`6e6b9e43c`, `ccb5a2aab`).
O2. A block-serving layer inside the container that composes a file from
base ranges and delta chunks per read, so attach no longer copies changed
big files (R2). Not scheduled; the owner decides whether the D2 cost is
acceptable.
O3. A corrected candidate under the measurement contract above, if one is
proposed; none is scheduled.
