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
listener answers before calling the budgeted restore hook. D8 supersedes the
input-block portion of this decision; the listener proof remains required.
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
after a port-proven start, outside SDK input blocks (D8).
`scripts/do-init-gate.ts` pins this. Its previous
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

D8. SDK input blocks contain storage work only (`4bca22e3c`, 2026-09-13).
This supersedes D1/D3's
in-block restore placement and the input-block part of R1, as authorized by
the lifecycle-defect assignment on 2026-09-13. Restore still runs once per
fresh container in the awaited `onStart` hook, after port-proven admission.
Public operations join that hook's singleflight; status cannot report ready
while it remains pending. Neither the restore budget nor the platform cap
was increased.

Control `b20260913105359` retained block/await entry and exit logs. The
SDK's `container.js:641` block entered at 1789296874570; `setHealthy` at :643
finished in 0 ms. Its `onStart` await at :644 and Devbox's boot-id
`super.exec` at :3495 never exited. The next constructor appeared 30,650 ms
later. All Devbox storage blocks exited. A second such SDK block held the
same boot-id RPC during the sparse cell. Port proof permits the first RPC;
it does not make subsequent RPC replies deliverable through a held DO input
gate. The control lost its C3 witness file before baseline publication.

The outside-block control `b20260913110816` completed its first two
post-empty-attach execs in 117 and 67 ms. Its third repeated same-box start
was refused with `stale-owner → retry`; this run is not full lifecycle
acceptance. Raw source instrumentation and observations are under
`bench-artifacts/block-attach/`. `scripts/do-init-block-bodies.test.ts` fails
against the old installed SDK and passes the storage-only blocks. It follows
named methods, virtual hooks and direct callback arguments; computed names
and imported/indirect callbacks remain outside its static claim.

D9. Opaque directories are directory records (`40f16afc6`, 2026-09-13).
The native probe observes overlay xattrs or `.wh..wh..opq`; an unreadable
opacity decision refuses publication. The package writes the mask in
`delta/tree`, below the chunked inodes and beside this checkpoint's whole
records. A mask on the higher block directory would hide those whole records
too. The Rust lower validates the declared marker before mounting.
Cumulative publication removes retained descendants on opaque replacement
and retains the mask on later edits. An opaque root is `p:"", opaque:true`.
H still counts one directory record; it never counts that record's hidden
lower children. The namespace precedence and unchanged count are checked in
`BlockLayer.lean`.

The Docker control renamed a directory over a removed lower directory,
checkpointed, restored and listed exactly the replacement names. Mixed whole
and chunked children stayed readable with zero payload bytes and index pages
at attachment. Missing marker metadata refused readiness. The same planner
was red before the fix. The image and source are pinned in
`block-lower/upstream.json`; evidence is under
`bench-artifacts/block-attach/opaque-20260913/`.

D10. Storage commands run from the runtime directory (`291359865`,
2026-09-13). In `b20260913132854`, first-base reseat ran with cwd
`/workspace` and unmount failed EBUSY after 2,235 ms. The catch continued;
the next checkpoint found no base files and compared 4,096 upper blocks
against zero base blocks. The corrected control `b20260913141100` reseated
from `/var/tmp/devbox` in 1,575 ms, found the base, matched 4,092 blocks and
published 69,632 bytes. Failed reseats now refuse the checkpoint, even when
the base archive is already durable. A Docker row proves the cwd holder,
reseat, small next delta and exact cold restore.

D11. The block mount type is the measured `fuse` (`4ded56c3b`, 2026-09-13).
Cloud trace `b20260913141100` showed that type with every source/generation
comparison true; the old `fuse.devbox-block` assertion alone refused the
valid composition and drove recovery. The pinned image reports `fuse` in
Docker too. Exact base, delta, store and boot-token checks remain. The
conformance corpus is red for a missing mount, wrong type or wrong token,
and green for the measured mount.

D12. A stale startup row cannot reopen a settled running generation
(`9f877511e`, 2026-09-13). The SDK can buffer rows that a successful hook
has deleted. The dense trace below showed one such adoption waiting
14,814 ms behind an active writer on the shared exec session. Scheduled
startup now returns when that running generation already has admission;
unsettled generations still use the same coordinator. The active-caller
regression is red before the guard and green after it.

D13. A request in the running-before-hook window joins the generation's
startup coordinator (2026-09-13). Run `20260913154111`, control `fed2b9d779`,
quiesced after Git repetition 1 segment 2. The next requests saw
`running:true` before `onStart` had registered its restore promise and
received `pending` instead of joining startup. The remaining workload
preparations were attempted before the replacement restore settled. D12's
guard was not responsible: quiesce revoked admission, and the new boot
`5a7624fb-b8e2-41dd-b8bc-577847457b76` subsequently restored successfully.

`resolveReadiness` now joins or creates the existing port-proven coordinator
for an already-running unstarted generation. It never joins a hook owned by
a retired generation. Requests arriving before the container reports running
keep the existing path; runtime and observation budgets are unchanged.
The lifecycle double is red before the fix for an exec issued immediately
after `running:true`, before the hook, and for a running boot without a
coordinator. Both are green after it; the before-running control remains
green. Each exec returns the new boot marker only after restore settles.
Raw control evidence is under `bench-artifacts/devbox-admission/20260913154111/`.

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
make this refusal green. The stream-composition publication defect was later
fixed in `08d58075b`; its controls are in
`bench-artifacts/block-attach/20260913-publication/`.

The bounded rerun `b20260913114625` on clean `116c7e632` attempted C3 and a
2 GiB dense changed file after D8 and the named-fallback/hash-batching fix
`197daa94f`. Their base checkpoints committed in 13,259 ms (67,112,960 bytes)
and 181,611 ms (2,147,487,744 bytes). Both edited checkpoints then refused
`opaque-directory publication requires an explicit namespace record`, after
1,882 and 61,558 ms. Neither changed-file attach ran. Both attach times,
payload-byte counters and index-page counters are unmeasured, not zero.
The dense writer's size and three range hashes were recorded before its
edited checkpoint. This refusal did not publish a legacy delta.

`a551b73f3` fixed the empty delta-key delete that interrupted intermediate
cleanup. Each cell now has its own container identity; startup observation
ends at 55 seconds without changing a runtime budget. Worker, container
application, both boxes, bucket and generated configuration were removed;
the final residue scan counted zero objects and zero multipart uploads.
Raw observations, verdict and receipts are under
`bench-artifacts/block-attach/b20260913114625/` and
`bench-artifacts/teardown/b20260913114625.json`. O1 remains open on opaque
directory support and the unmeasured changed-file restores at that revision.

D9 removed the opaque publication refusal. In `b20260913131044` on clean
`40f16afc6`, C3's base committed in 15,268 ms and its edited checkpoint
committed as chunked in 23,610 ms. The edit nevertheless uploaded 67,559,424
bytes, with two zero-byte PUTs and one multipart completion (13 parts).
These were successful directory/placeholder operations, not retries, and
the one-object/196,608-byte gate remains red. The reason for the full-file
delta is unmeasured; the first-base reseat and lower-base hash inputs need a
trace.

C3's cold restore and the independent dense cell's empty baseline then
exhausted the 55-second startup observation ceiling while reporting
`running:true, restoration:unstarted`. Both changed-file attach times and
payload/index counters remain unmeasured. Worker, container application,
both boxes, bucket and generated configuration were removed; all ten
teardown entries completed and the final object/multipart counts were zero.
The observations, precise refusals and receipt are under
`bench-artifacts/block-attach/b20260913131044/` and
`bench-artifacts/teardown/b20260913131044.json`. O1 stays open on startup
admission and publication cost, not on opaque-record support at that revision.

The storage figures are now observed. Clean `4ded56c3b`, run
`b20260913143908`, restored the C3 changed file in 5,218 ms (5,555 − 337),
with payloadBytes=0, indexPages=0 and readRequests=0 before the full file
verification passed. Its delta was 69,632 bytes. The independent dense run
`b20260913145258` restored the 2 GiB changed file in 3,735 ms (4,032 − 297),
also with all three attach counters zero; file size and the three saved
range hashes matched. Its delta was also 69,632 bytes.

The dense run used the same product base plus Worker/SDK await
instrumentation. Its dirty digest and exact patches are retained; its timing
is not a clean-tree figure. Neither run measures the later D12 guard. The
combined verdict is
`bench-artifacts/block-attach/b20260913145258/verdict.json`. Both runs removed
their Worker, container application, boxes, bucket and generated config;
their final residue counts were zero objects and zero multipart uploads.

C3 still made three object attempts: two zero-byte directory/placeholder
PUTs and the payload write. The payload-size gate passes; the one-attempt
gate remains red. No attempt was hidden or reclassified to admit the run.
O1 therefore remains open as a full strategy-admission claim.
O2. Storage implementation closed by D7. Deployed latency evidence remains
part of O1; arbitrary service startup remains outside the storage bound.
O3. A corrected candidate under the measurement contract above, if one is
proposed; none is scheduled.
