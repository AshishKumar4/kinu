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

D2. Storage attach processes O(M + H + L) metadata and reads zero file-payload
bytes: M changed files, H other changed namespace records (including ancestor
directories, deletions and hardlink names), L layer records. There is no
stored-byte, stored-file-count or largest-changed-file term. This reverses
the eager-materialization decision of 2026-09-13. V2 moves overrides out of
the manifest into authenticated search pages. The read-only block lower
composes ranges on demand; the lazy tree lower serves whole records.
Deletions are pre-mounted `.wh.` whiteouts, the representation fuse-overlayfs
1.7.1 uses when the backing overlay refuses mknod(0,0).

Measured 2026-09-13 by `tests/block-lower.test.ts`: attach's block server read
zero payload bytes and zero index pages; the overlay served exact
base/chunk/hole/EOF bytes, deletions, replacements, hardlinks and symlinks.
The eager control copied each changed chunked file's complete base; the new
stack copies none. The sparse-inode counterexample still fails:
`tests/support/sparse-lower-probe.sh`. This is a storage-work bound, not a
30-second wall-clock guarantee. Service startup can demand an entire file
or trigger its copy-up before lifecycle readiness. Publication stays D4.

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

D7. Block-layer design gate. Status: storage half implemented on 2026-09-13.
The conditional design is in [DEVBOX-BLOCK-LAYER.md](DEVBOX-BLOCK-LAYER.md).
Manifest v2 is `f69af22cf`; the Rust/fuser lower is `7598a68a6`; the derived
image is `ac6ae8f39`, digest-pinned for both product and bench. The exact
stack is `block-lower:lower-delta/<generation>/.devbox-delta/tree:lower-base`.
No implementation can bound arbitrary service-demanded work before readiness;
the adopted read-only lower bounds storage attachment only.

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
1 GiB. V2 replaces `over` with a 128-byte-page authenticated index reference
inside the delta object and refuses V1 by version. The same changed-file
record stays bounded while the index grows. C3 publishes 90,298 bytes in one
object in the conformance harness. The conditional wire theorem's premises
are unchanged: a record at most 4 KiB and encoding/framing overhead at most
64 KiB; the four aligned index pages consume 512 bytes of that overhead.

The image's high-level squashfuse assigned different inodes to two names
of a hardlink; its same-version low-level driver preserves that identity.
Both the source tarball and derived image are pinned in
`packages/devbox/block-lower/upstream.json`. A mounted-archive overwrite
probe returned new byte 66 in place of old byte 65. Each delta now gets a
new UUID key and a CAS-published pointer. Retained metadata is merged with
the upper; a sweep keeps an old delta while a live mount or fallback needs
it. Publication remains cumulative in the changed set, not pending-only.

The eager counterexamples `c3_attach_copies_the_whole_64mib_base` and
`attach_materialization_has_no_constant_bound` are retired with the eager
implementation. They do not describe v2 storage attach. No product deployment,
full-hook latency guarantee or callback-only publication bound is claimed.

## Measurement contract for a strategy comparison

Vary stored bytes B, file count N, changed bytes D and demanded bytes Q
separately, on identical committed trees. Capture pre-admission metadata
bytes, CPU work, request count, peak memory and elapsed hook time. A request
count is not a cost. A local workerd clock is not a cloud latency. A run is
admitted only when every G gate passes; a refused run ranks nothing.

## Open

O1. Live acceptance of the chunked chain on deployed Containers and R2 after
the evidence corrections of 2026-09-12 (`6e6b9e43c`, `ccb5a2aab`).
The matrix witnesses `chunked-absorption`, `mutable-delta`, and
`chainArchiveExpectations` keyed by `base.id` describe the retired eager
attach and mutable publication. They must be re-registered against immutable
delta IDs and the composed lower before a full admitted run. The bounded C3
and 2 GiB cells are storage evidence, not G1–G10 strategy admission.

The bounded cloud attempt on 2026-09-13 (`b20260913094839`, source
`ad8a2346b`, image digest `d09be1f3e613173006430cff1b58e5e5d1269dc383fe0404a33f9e3ff8a2d0a0`)
was refused before either changed-file restore. The 64 MiB C3 baseline
publication took 656,741 ms and failed at s3fs fsync/close with EIO; the
2 GiB sparse baseline took 217,663 ms and failed at the same boundary.
Both requested attach figures and payload counters are unmeasured, not zero.
Raw observations and the completed teardown manifest are committed under
`bench-artifacts/block-attach/b20260913094839/` and
`bench-artifacts/teardown/b20260913094839.json`. Worker, container application,
bucket and generated configuration were removed; the final residue scan
found zero objects and zero multipart uploads. No workload was changed to
make this refusal green. R2 publication must be diagnosed before O1 can close.
O2. Storage implementation closed by D7. Deployed latency evidence remains
part of O1; arbitrary service startup remains outside the storage bound.
O3. A corrected candidate under the measurement contract above, if one is
proposed; none is scheduled.
