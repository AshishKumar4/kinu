# Devbox decisions

The decision log for `packages/devbox`. Read it before changing the package.
One entry per decision: what was decided, the evidence that settled it, the
date, the commit. A decision without a measurement is a hypothesis and says
so. A change that reverses an entry names the entry and re-runs its
measurement under both shapes before it lands.

Report files named below live under `packages/devbox/bench/measure-first/`.
The probes that took them left the tree once D27 closed the strategy search;
`git log --diff-filter=D -- packages/devbox/bench/measure-first` finds their
last version.
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

P2. A timer set inside `blockConcurrencyWhile` fires on schedule while no
timer set outside the block falls due first (P5). Measured 2026-09-13 on a
plain Durable Object: a 50 ms `setTimeout` awaited inside the block completed
at exactly 50 ms. Evidence: `kinu-logs/startup-probe/`
(`p1-get-timer-inside.body`, `observations.md`). Remeasured deployed
2026-09-23 (run `s20260923020822`): 50 ms alone and 50 ms with reads queued
at the gate. The earlier claim in `lifecycle.ts` that timers starve in the
block was a hypothesis written as fact; it is withdrawn.

P3. One control exec inside `onStart` completes when the block opens against
an accepting control server, and never completes when it does not. Measured
2026-09-13 on fresh containers, three of each: `startAndWaitForPorts({ports:
3000})` then exec answered in 118 to 125 ms, 3/3; `start()` then exec held
the block to the cap and reset the object at 41 s, 3/3. Port 3000 is
`@cloudflare/sandbox`'s own RPC control listener (`Sandbox.defaultPort`); the
port wait runs outside the block with real timers. Probe source:
`packages/devbox/bench/onstart-probe.ts`, `probe-worker.ts`,
`wrangler.probe.jsonc`.

P4. A WebSocket delivers its messages under the input gate current when it
was accepted. A reply over a connection accepted before a
`blockConcurrencyWhile` block cannot arrive inside the block; a reply over a
connection accepted inside it can. Source, read 2026-09-23: workerd
`src/workerd/api/web-socket.c++` (`internalAccept(js,
IoContext::current().getCriticalSection())`; `readLoop` runs each message
through `context.run(..., mapAddRef(cs))`). Measured deployed 2026-09-23 (run
`s20260923013446`): a hook exec over the connection opened before the block
got no reply, 4 of 4, and the object reset at the cap; over a connection
opened inside the block it answered in 152 to 176 ms, 4 of 4.

P5. Timers fire in due order, and each runs under the input gate current when
it was set. A timer set outside a block that falls due while the block holds
the gate waits for the block to end, and every later timer, those set inside
the block included, waits behind it. `clearTimeout` of the waiting timer
drops its pending run and the queue moves on. Source, read 2026-09-23: workerd
`src/workerd/io/io-context.c++`, `TimeoutManagerImpl::setTimeoutImpl` (captures
`context.getCriticalSection()` when the timer is set; an entry of
`timeoutTimes` is fulfilled "when the time has been reached AND all previous
timeouts have completed") and `TimeoutState::cancel`; `scheduler.wait` and
`AbortSignal.timeout` use the same queue (`src/workerd/api/basics.c++`,
`setTimeoutInternal`). Measured 2026-09-23, local workerd: a 250 ms interval
set inside the block stopped at the first tick after the SDK's 1 s connection
poll, set before the block, fell due; the block then reset at 30 s, 3 of 3.
With that poll cleared at block entry, the hook's timers fired and the hook
returned, 3 of 3. A third such timer is the containers package's port ping:
`addTimeoutSignal` arms a 5 s timer per ping and clears it only on abort, so
the pings that prove a port just before a start block fall due inside it.
With the hold past 5 s, the hook's timers stalled locally, 4 of 4 (run
`s20260923031614`), and fired once each ping cleared its timer on settling,
4 of 4 (`s20260923031930`).

## Decisions

D1. Admission is port-proven. The container-start path proves the control
listener answers before calling the budgeted restore hook. D8 supersedes the
input-block portion of this decision; the listener proof remains required.
Decided 2026-09-09 (`6e96741cc`, "admit only through startAndWaitForPorts"),
reversed 2026-09-09 (`bde0047cb`, on the mistaken premise that port 3000 was
an app port), re-decided 2026-09-13 on P3. Status: on main since the
`feat/devbox-gated-restore` merge `69cae24ac` (2026-09-13). The five resets
measured 2026-09-10 (DECISIVE-2026-09-05.md, "Six fresh starts") were
measured under the reversed shape and do not bear on the port-proven one.

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

D5. Snapshot-chain is refused full strategy admission on 2026-09-13.
Settlement run `20260913154111`, clean `fed2b9d779`, ran from
15:41:12.703 to 16:02:22.337 UTC and completed the checkpoint ladder, but
failed G3, G6 and G9. It ranks no strategy. Snapshot-chain remains the
shipped implementation; no alternative is shown better under R3.

The source manifest numbers its ten gates G0 to G9, not G1 to G10. These are the
run's recorded verdicts, without combining observations from other runs:

| Gate | Verdict | Deciding evidence |
| --- | --- | --- |
| G0 Provenance | Pass | Clean `fed2b9d779`; Worker `25825c2d-1a73-47da-9b15-68e1912c906e`; pinned image digest `3b11f7bf756af01664663f05fd1f3c1721dababc6a4fcf2bfa047d341d9b6a9e` |
| G1 Mount truth | Pass | Workspace mount, writable upper, named archives and durable bytes verified |
| G2 Filesystem semantics | Pass | Both re-registered witnesses observed; no unexpected semantic failure |
| G3 Publication safety | Refused | The read-only probe's top-level `exit` terminated the persistent SDK shell, so write refusal and the aggregate cut verdict were unobserved |
| G4 Security | Pass | F7 stale writer, F10 hostile metadata, F11 capability escape/replay and F12 credential exposure completed |
| G5 Restore complexity | Pass | Counted store window and bounded-k archive-depth check passed; this is not a CPU or peak-memory profile |
| G6 Complete cells | Refused | Cold attach 25,039 ms exceeded 25,000 ms; C3 made three object attempts; C3 cold restore exhausted the 55-second observer and file correctness was unmeasured |
| G7 Reconciled accounting | Pass | Operation and byte accounting reconciled |
| G8 Complete cleanup | Pass | All seven teardown entries completed; Worker, container application, bucket and generated config absent; object/multipart residue absent |
| G9 Statistical validity | Refused | Only 15 of 40 requested segment observations existed, 13 priced; later workload preparations were refused during replacement startup |

Both npm profiles completed their first repetition. Git repetition 1
completed segments 0 to 2; after the idle-policy quiesce, segments 3 and 4 were
refused. SQLite repetition 1 and all four second-repetition preparations
were attempted before replacement startup settled and returned "ask again".
This was the request-admission gap fixed by D13 (`c0181b5eb`), not a stale
startup row discarded by D12. The original refusal remains recorded.

The immutable-publication witness retained the first 81,932,288-byte delta
with its original etag, published a new UUID key, and advanced the record
from revision 20 to 21. The composed-restore witness read the exact marker
on a new boot, found it absent from the fresh upper, observed both lower
mounts and zero payload bytes, index pages and read requests, then committed
the next checkpoint without collapsing the base. Archive checks use each
delta's own ID. The legacy-only `delta-layer-collapse` profile remains:
`snapshot-chain.ts` still collapses a mounted non-chunked delta, and the
full-upper conformance row proves that live property.

The G3 command now runs in a subshell (`9ae255d17`). Its local POSIX-shell
control was red for session termination and green for preserving both a
failed write's status 1 and a writable control's status 0. Neither this fix
nor D13 has a completed post-fix cloud matrix: three consecutive deployed
attempts were refused at initial container admission. Each retained
the platform message "There is no container instance that can be provided
to this Durable Object, try again later". State observations included brief
`running:true` readings, but no restore settled and the final reading was
stopped. The unchanged 55-second observation ceiling ended measurement.

| Run | Source | UTC interval on 2026-09-13 | Outcome |
| --- | --- | --- | --- |
| `20260913161007` | `c0181b5eb` | 16:10:09.351 to 16:11:45.088 | Eight admission incidents; no restore or workload |
| `20260913161823` | `9ae255d17` | 16:18:25.294 to 16:19:40.525 | Eight admission incidents; no restore or workload |
| `20260913162021` | `9ae255d17` | 16:20:22.861 to 16:21:40.113 | Nine admission incidents; no restore or workload |

All three pass G0 and G8 and refuse the other eight gates for missing
measurements. Their seven-entry teardown manifests are complete, cleanup
errors are empty, and bucket/multipart absence is verified. Deployment
attempts stopped at the authorized three-consecutive-refusal limit.
The earlier `20260913154033` provisioning attempt failed with Cloudflare
R2 API code 10001 before Worker deployment and also completed teardown.

The bounded storage figures remain separate evidence: C3 attached in
5,218 ms in `b20260913143908`; the dense 2 GiB changed file attached in
3,735 ms in `b20260913145258`. Both read zero payload bytes, index pages and
file-read requests at attach and passed their byte checks. The dense figure
used retained diagnostic instrumentation, not a clean tree. Neither figure
admits a strategy. The settlement run's C3 still observed a zero-byte
directory PUT, a zero-byte file-placeholder PUT, and the 69,632-byte payload
PUT. The one-attempt requirement remains red; no attempt was hidden.

Raw run artifacts are `bench-artifacts/devbox-strategies-<run>.json`,
per-arm observations are `bench-artifacts/<run>/snapshot-chain.json`, and
receipts are `bench-artifacts/teardown/<run>.json`. Selected lifecycle logs
and driver output are under `bench-artifacts/devbox-admission/<run>/`.
Observer processes were stopped. No runtime budget, gate bound, workload or
lock was increased. No fallback was added.

Dispositions of the alternatives at this settlement:

| Candidate | Evidence | Disposition |
| --- | --- | --- |
| r2fs / s3fs workspace | Attached in 3,362 ms and preserved the marker on 2026-09-04; stopped after three ticks; sparse, hardlink and single-writer limits recorded | Not shown better; not disproven for custom FUSE designs |
| overlay-cas | 64 MiB quiesce 67,723 to 37,855 ms with 16-wide concurrency; large pending recovery over 300,000 ms; held-byte metering unreliable | Measured configuration missed the recovery bound; not a verdict on every CAS layout |
| bounded-layers | 40/40 deciding ticks in one configuration; lazy wake constant at 5 requests from 1k to 100k files but fetched bytes 495,655 to 49,609,348 | Unsettled; constant request count is not constant work |
| merkle-pack v1 | Full index read on open; 4 MiB cap refused large trees; 4/40 ticks versus chain 40/40 | Structural disadvantage for this full-index design; paged designs not judged |
| native root/extent + merkle v4 | Matched C1 lookup 1,038 to 5,183 GETs versus chain 5; dirty MAP_SHARED writes escaped FUSE; refusing them broke SQLite WAL | Not shown better on the preserved configuration |
| snapshot-chain, chunked | Local C3 and many-file proofs pass; `20260913154111` refused admission on G3, G6, G9; three post-fix attempts failed container admission | Shipped implementation; full strategy admission refused |

No comparison run to date was admitted end to end; see "Comparisons not
admitted" in `kinu-logs/devbox-history-report.json`. The two earliest, whose
reports are deleted:

- `kinu-devbox-bench-20260903140046` on `1ffe8ea4f` plus driver fix
  `2f3b3f81`, 2026-09-03T14:00:48Z to 15:28:41Z, seed 20260824, 2 reps. Refused
  at admission: G0 green, G1 to G9 red. Only snapshot-chain passed lifecycle
  (9/9). r2fs was refused at cold attach ("Failed to change directory to
  /var/tmp/devbox"). bounded-layers and merkle-pack failed on `journal manifest
  version 2 is a delta`, thrown from `captureFromJournalFence`. overlay-cas's
  first npm checkpoint missed the 1,500,000 ms deadline, and the run ended with
  `GET cursor.json: HTTP 530`. Snapshot-chain's figures: small-stat-1k p50
  0.028 ms and 0.027 ms; quiesce 2199 ms / 86,016 B (64 KiB), 1339 ms /
  4,366,336 B (4 MiB), 9170 ms / 71,389,184 B (64 MiB); ticks 80/196/200 ms,
  all skipped as unchanged; ops 3082 (A 2836 / B 245); npm Σ tick 34,165 /
  124,420 ms. Overlay-cas checkpoints ran at 0.05 to 1.98 MB/s, about 132
  store calls at about 513 ms each.
- `kinu-devbox-bench-20260904142724` on `9a0fe0c7f`, clean tree, 42m47s wall.
  Refused: G1 to G9 with 4, 9, 5, 1, 16, 11, 5, 3 and 6 reasons. `dfe94eb68`
  landed after it started and was not measured. Snapshot-chain reproduced the
  earlier figures within a few percent (npm 32,626 / 120,924; git 55,052 /
  113,035; sqlite 122,544 / 119,592 ms). bounded-layers' first checkpoint moved
  130574 bytes and held 129347 B, in a bucket of 155 objects. merkle-pack's
  first quiesce moved 138,155 B; lifecycle 2/3, cold attach 20,319 ms.
  overlay-cas with 16-wide concurrency: 64 KiB quiesce 5,350 to 3,383 ms
  (1.58×), 4 MiB 7,393 to 4,931 ms (1.50×), 64 KiB tick 845 to 90 ms (9.39×).
  Its meter reported held=1791B while a bucket LIST found 24,516 objects,
  270.38 MB (blobs 193.66, tree 75.77, journal 6.08, scan cache 4.24 MB). Its
  attach refusal read "Devbox.attach exceeded its 300000ms budget".
  `INCIDENT_LEDGER_MAX_ROWS = 100` truncated the incidents to totals, so they
  could not be grouped.

The removal of the alternatives' source on 2026-09-09 (`337eaf6f9`) followed
an owner choice to measure C3 and chain publication first, not an owner
finding that the alternatives were defeated. They are recoverable from the
`archive/*` tags named in `docs/BRANCH-ARCHIVE.md`.

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

D8. SDK input blocks contain storage work only (`4bca22e3c`, 2026-09-13). Reversed by D26.
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
`5a7624fb-b8e2-41dd-b8bc-577847457b76` later restored successfully.

`resolveReadiness` now joins or creates the existing port-proven coordinator
for an already-running unstarted generation. It never joins a hook owned by
a retired generation. Requests arriving before the container reports running
keep the existing path; runtime and observation budgets are unchanged.
The lifecycle double is red before the fix for an exec issued immediately
after `running:true`, before the hook, and for a running boot without a
coordinator. Both are green after it; the before-running control remains
green. Each exec returns the new boot marker only after restore settles.
Raw control evidence is under `bench-artifacts/devbox-admission/20260913154111/`.

D14. A due schedule row is never re-armed by a caller that is not
dispatching it (2026-09-14, `fix/devbox-o1`). The "cold restore unstarted"
red of `b20260914045438` is not a regression between `4ded56c3b` and
`5d2707ba3`: the same 55-second `running:true, restoration:unstarted`
reading, with one incident undelivered and no heartbeat tick, appears on
`40f16afc6` (both cells of `b20260913131044`) and on `4ded56c3b` (the dense
baseline of `b20260913143908`). Its cause was measured on
`b20260914070552` (`ba2258e91` plus the startup traces of `791a80a83`,
ten destroy/create cycles, `--lifecycle`, interrupted by the driver's own
process ceiling after seven): cycles 2, 3, 5 and 6 each recorded exactly one
admission refusal, `Container request aborted.: The container is not
listening in the TCP address 10.0.0.1:3000` after the 6,000 ms port wait,
then nothing for the rest of the 55 s window. The retry row was armed one
second out and the platform never delivered it. The raw tail shows why:
`Alarm - Canceled` at 07:06:16, 07:07:08, 07:08:09, 07:09:09 and 07:10:09
UTC and no `devbox.alarm.enter` between 07:06:22 and 07:08:14. The driver
reads `/state` every 300 ms; `devboxState` kicks the startup row through
`#arm`, whose guard counted only future rows, so once the row was due every
reading inserted another row and the SDK's `schedule()` reset the object's
one platform alarm a second out each time. The alarm was moved away faster
than the platform could deliver it. Cycle 4 recovered only because its
refusal left the container stopped, which the driver answers with a second
drive; the same cycle then ran 150 accumulated startup rows in one alarm
pass. `needsArming` now takes the dispatching flag: a callback looks past
its own due row, every other caller counts every row. The lifecycle double
is red before the fix (four polls after the row came due armed it four
times) and green after; the self-re-arming direction stays red. Evidence:
`bench-artifacts/block-attach/b20260914070552/` (`observations.json`,
`tail.log`, `lifecycle.jsonl`) and its completed seven-entry teardown
`bench-artifacts/teardown/b20260914070552.json`, zero objects and zero
multipart uploads, bucket absent.

Measured live on 2026-09-14 on clean `3618e3e0b`, run `b20260914073654`,
`--lifecycle`, all ten destroy/create cycles: no cycle refused at the
55-second ceiling with `restoration:unstarted`; every cold cycle attached,
with `incidents.total` between 3 and 8 and `incidents.undelivered` at 0,
and `devbox.alarm.enter` rows between the retries the platform was starving.
The same source's `--c3-only` cell, run `b20260914074243`, restored the C3
changed file in 12,350 ms (`restoration.ms`, after 2 redrives), paid the
still-unfixed s3fs shape's three `put` attempts
(`published.transport.puts: 3`, `putUploadBytes: 69632`), and passed file
correctness. Both runs' teardown manifests report zero residue objects and
zero residue multipart uploads. Evidence: `observations.json` and
`verdict.json` under `bench-artifacts/block-attach/b20260914073654/` and
`bench-artifacts/block-attach/b20260914074243/`, and
`bench-artifacts/teardown/b20260914073654.json`,
`bench-artifacts/teardown/b20260914074243.json`.

D15. One object attempt per checkpoint, by publishing the staged archive
with an HTTP PUT to the mount's own egress host (2026-09-14, `fix/devbox-o1`,
`e2cd0eb51`). H1's design, landed and measured live. `storeObjectUrl(key)` in
`#chainPorts` answers `http://r2.internal/<binding>/<key relative to the
mount prefix>` and refuses a key outside the prefix; `publishCommand`
writes the publisher script into `/var/tmp/devbox` and runs it under bun,
returning `<exit> <bytes> <etag>`; `publishArchive` reads that reply. The
publisher sends the whole `Bun.file` for a single PUT and `slice.stream()`
with an explicit `Content-Length` for multipart parts, because the pinned
image's Bun 1.3.12 sends nothing for a `Bun.file` slice as a fetch body
(measured locally, `/tmp/o1-publisher/`). Its own HEAD afterwards replaces
the `conv=fsync` check `dd` owed s3fs; the mount is still held because its
registration routes `r2.internal` and its reads serve the layers.

Measured live on clean `4a7dd1be6`, run `b20260914082622`, `--c3-only`:
`published.transport.puts: 1`, `putUploadBytes: 69632`, `correctness:
passed`, cold restore 13,839 ms, versus three attempts and 12,350 ms on
the s3fs control `b20260914074243`, and the three attempts of the earlier
control `b20260914045438`. The one-object-attempt gate under
`C3_BYTES_BOUND` is green. Errors: none; teardown `finalResidueObjects: 0`,
`finalResidueMultipartUploads: 0`. Evidence:
`bench-artifacts/block-attach/b20260914082622/` (`observations.json`,
`verdict.json`, `tail.log`) and
`bench-artifacts/teardown/b20260914082622.json`. The cold-restore difference
between two redrived cells is noise, not a fix claim; the change removes two
of three attempts. s3fs's marker/placeholder/flush three-put shape is retired
for writes and stays for reads.

D16. The post-fix settlement run is refused at cold attach
(2026-09-14). Run `20260914220919` on clean `e060e360f` reproduced D5's
shape on the current tree (one `snapshot-chain` arm, `--decisive`,
`--fault-cuts`, seed 20260824, loop budget 8,000 ms, two repetitions)
with D14's alarm fix and D15's one-attempt publish in place. The fixture
Worker deployed at version `1d6af079-a325-4a23-a1c5-b60e56e1a0c8`; the
cold attach then held `restoration:unstarted` through nine readiness
drives and was refused at its 54,540 ms ceiling (8 incidents, 0
undelivered, `startupMs` 4,010). No cell ran; `admission.admitted` is
false. The run's recorded verdicts, without combining observations from
other runs:

| Gate | Verdict | Deciding evidence |
| --- | --- | --- |
| G3 Publication safety | Refused | No completed fault-cut evidence: the interruption at the publication cut never ran to completion; observers did not confirm all-old-or-all-new state across the cut; barrier-ack loss across the cut was never counted; post-publication references were never swept for absent objects; rollback and phantom-root behaviour was never checked |
| G6 Complete cells | Refused | Cell T0/C0/K0 (blank) did not complete; arm `snapshot-chain` recorded no required live C3 observation; cold attach reported kind "none" and was never timed; second attach did not observe the unchanged generation; wake did not attach durable bytes; 0 of 6 ladder checkpoints |
| G9 Statistical validity | Refused | Deciding cell T0/C0/K0 censored: fewer than two repetitions; all 40 decisive segments incomplete with no unique priced observation; `small-stat-1k` measured 0 of 2 requested times |

All seven teardown entries completed with zero objects and zero
multipart uploads remaining; Worker, container application, bucket and
generated configuration are absent. Raw driver output:
`kinu-logs/devbox-settle/run-20260914220918.log`; artifact
`bench-artifacts/devbox-strategies-20260914220919.json`; per-arm
observations `bench-artifacts/20260914220919/snapshot-chain.json`;
receipt `bench-artifacts/teardown/20260914220919.json`. The D14
redrive evidence (`b20260914073654`, ten cycles, zero refusals) and the
D15 one-attempt cell (`b20260914082622`) measured the fixes on their own
cells; this settlement shows the same `running:true,
restoration:unstarted` reading still ends a full run. Whether the
54,540 ms refusal is the D14 alarm shape recurring under settlement
timing or a new admission failure is unmeasured. O1 stays open.


D17. A fixture is not handed to a driver until its container application
has a provisioned instance (2026-09-14, `6bcd11b35`). This answers D16's
open question: the 54,540 ms refusal was neither the D14 alarm shape nor a
new admission failure. It was the platform's rollout of a freshly deployed
container application, measured inside the cold attach's own 55 s observer
ceiling.

The mechanism. `wrangler deploy` returns while the application's one
instance is still `scheduling` or `starting`, and every `container.start()`
until it is provisioned answers "There is no container instance that can be
provided to this Durable Object, try again later". `deployFixture`
(`scripts/bench-devbox-strategies.ts`) waited only for the Worker to accept
the run's token, so both drivers kicked `/create` 11 to 24 s after the
run started and the remaining rollout landed inside `pollForAttach`'s
55 s window. The box cut that wait into the bench fixture's 6,000 ms admission
windows (`portWaitMs` in `packages/devbox/bench/worker.ts`, applied at
`#admitControlListener` in `packages/devbox/src/devbox.ts` as
`AbortSignal.timeout(portWaitMs)`), each ending in one `Aborted waiting
for container to start as we received a cancellation signal` incident and
an immediate re-drive; the incident count is the rollout time divided by
six seconds. The settlement driver and the lifecycle
driver take the same path (`startupOperation` on `/create`, the same
generated config, image and instance type): the lifecycle run
`b20260914073654` needed seven windows and attached at 50,151 ms, 4.4 s
under the ceiling; the four settlement runs since 2026-09-13 16:10 needed
eight or nine and were refused. D5's 25,039 ms cold attach was three such
windows plus the attach, so G6's cold-attach figure has held the rollout
since the first settlement. D13 and D14 are unchanged and were not
involved: D13's join returns each drive at the window's end with the box's
own "ask again", not a client abort, and after every aborted window the
next flight opened within 300 ms with the retry alarm delivered
(`lifecycle.jsonl` of `b20260914073654`; today's eight incidents all
`delivered: true`, `undelivered: 0`).

Measured 2026-09-14 by `scripts/bench-devbox-rollout-probe.ts`, run
`r20260914233505`, two fresh applications on the bench image, each deleted
and proved absent afterwards. Passive cell, nothing touching the Durable
Object: `starting:1` from the first reading until `healthy:1` 37,760 ms
after the deploy returned; one default `startAndWaitForPorts` then admitted
in 2,490 ms. Churn cell, the fixture's 6 s windows re-driven back to back
from the deploy: six refusals, the seventh admitted 39,636 ms after the
deploy, and the instance read `active:1` from then on. The two clocks agree,
so the windows neither hurry nor delay the rollout; the churn cell's
recorded "no healthy instance" error is the probe reading `healthy` where
a held instance reads `active`, corrected in the same commit's helper.
Evidence: `bench-artifacts/rollout-probe/r20260914233505/observations.json`.
The account's two leftover bench applications from 2026-09-10 and
2026-09-11 predate D5's 25 s attach and are not the cause.

The change. `awaitApplicationRollout` in
`scripts/fixtures/r2-bench/deploy-substrate.ts` polls `wrangler containers
info --json` every 2 s until `healthy + active + assigned >= 1`, refusing
the deployment by name and last reading at the deploy step's existing
180 s deadline; `deployFixture` runs it after the token is accepted and
records each arm's rollout in the run identity (`identity.rollouts`). No
gate, ceiling, budget or workload changed. `scripts/deploy-substrate.test.ts`
is red when the wait would return on `scheduling` or `starting`, green on
`healthy` and on `active`, and red past the deadline.

Settlement run `20260914234711`, clean `6bcd11b35`, D5's exact flags (one
`snapshot-chain` arm, `--decisive`, `--fault-cuts`, seed 20260824, loop
budget 8,000 ms, two repetitions), Worker version
`a78f7be4-654b-4302-842d-2d154929d799`, 23:47:12 to 00:50:42 UTC. The
application was provisioned 18,525 ms after the deploy (readings
`scheduling:1` until `healthy:1`); the cold attach then attached on its
first drive in 3,618 ms and the whole ladder ran. It is the first
settlement since D5 to complete every cell; `admission.admitted` is still
false. The run's recorded verdicts:

| Gate | Verdict | Deciding evidence |
| --- | --- | --- |
| G0 Provenance | Pass | Clean `6bcd11b35`; Worker `a78f7be4-654b-4302-842d-2d154929d799`; pinned image digest `3b11f7bf…` |
| G1 Mount truth | Pass | Workspace mount, writable upper, named archives and durable bytes verified |
| G2 Filesystem semantics | Refused | The expected red witness `chunked-absorption` did not fail: chunked manifest unobserved, marker merged=false, upper absent; an expected failure that vanished is instrument drift |
| G3 Publication safety | Refused | The cut cell threw before judging: the baseline witness was not observed, bytes differ; no cut completion, observer, barrier-ack, sweep or rollback evidence |
| G4 Security | Pass | F7 stale writer, F10 hostile metadata, F11 capability escape/replay and F12 credential exposure all refused |
| G5 Restore complexity | Pass | Counted store window and bounded-k archive-depth check passed |
| G6 Complete cells | Pass | Cold attach 3,618 ms; warm 63 ms; wake 12,107 ms attached; C3 one object attempt (`puts: 1`, 69,632 bytes), cold restore 12,911 ms, correctness passed, zero payload bytes and index pages at attach |
| G7 Reconciled accounting | Pass | Operation and byte accounting reconciled |
| G8 Complete cleanup | Pass | All seven teardown entries done; Worker, container application, bucket and generated config absent; zero objects and zero multipart uploads |
| G9 Statistical validity | Refused | 36 of 40 requested segment observations exist, 24 priced; 12 incomplete |

G9's twelve incomplete segments have three shapes, none of them the initial
admission this entry closes. Eight (`npm/2/1`, `npm/2/3`, `git/1/2`,
`git/1/4`, `git/2/2`, `sqlite/1/2`, `sqlite/1/4`, `sqlite/2/2`) ran their
command against a quiesced box (`running:false, restoration:unstarted`
before) and recorded the box's own `this devbox is not ready … A startup is
armed, so ask again` after 6,090 to 6,102 ms as an unobserved execution:
a warm restart attached 11,223 to 16,472 ms after its kick on this run,
each through one or two 6,000 ms windows, so the segment's own window ends
first, and the workload segment path does not ask again where
`pollForAttach` does. Two
(`sqlite/1/1`, `git/2/4`) were interrupted by the idle-policy stop while
executing (`OperationInterruptedError`, attached before, unstarted after).
One (`npm/2/4`) lost the persistent shell (`SessionTerminatedError`) and one
(`npm-excluded/2/0`) lost its socket, after which that repetition's four
remaining segments had no unique priced observation. Teardown:
`bench-artifacts/teardown/20260914234711.json`, seven entries done, zero
residue objects and zero multipart uploads; the account lists no Worker,
application or bucket of this run. Artifacts:
`bench-artifacts/devbox-strategies-20260914234711.json`,
`bench-artifacts/20260914234711/snapshot-chain.json`; driver output
`kinu-logs/devbox-settle/run-20260914234711.log`.

O1 stays open on G2, G3 and G9, each with the red reason above; the
initial-admission refusal of D5's three post-fix attempts and D16 is
closed.


D18. Snapshot-chain is admitted as the full strategy (2026-09-15). Run
`20260915065241`, clean `84a026c2f`, D5's exact flags (one `snapshot-chain`
arm, `--decisive`, `--fault-cuts`, seed 20260824, loop budget 8,000 ms, two
repetitions), Worker version `f793cbb1-c6e1-4dd0-9dbd-52f70bf6737a`, ran
from 06:52:42 to 08:19:07 UTC and passed all ten gates;
`admission.admitted` is true. It is the first admitted settlement. Four
decisions, each measured before it, carried the three gates D17 left red:

| Gate | Verdict | Deciding evidence |
| --- | --- | --- |
| G0 Provenance | Pass | Clean `84a026c2f`; Worker `f793cbb1-c6e1-4dd0-9dbd-52f70bf6737a`; pinned image digest `3b11f7bf…`; application provisioned 37,794 ms after deploy |
| G1 Mount truth | Pass | Workspace mount, writable upper, named archives and durable bytes verified |
| G2 Filesystem semantics | Pass | `mutable-delta` and `chunked-absorption` both observed |
| G3 Publication safety | Pass | Cut verdict `all-old`: the record is identical to its pre-cut self and the cut marker never landed; absent references 0; barrier-ack loss 0; rollback or phantom root false; the served delta layer refused writes |
| G4 Security | Pass | F7 stale writer, F10 hostile metadata, F11 capability escape/replay and F12 credential exposure all refused |
| G5 Restore complexity | Pass | Counted store window and bounded-k archive-depth check passed |
| G6 Complete cells | Pass | Cold attach 1,979 ms; warm 112 ms; stop 822 ms; wake 8,455 ms attached; C3 one object attempt (`puts: 1`, 69,632 bytes), cold restore 8,973 ms, correctness passed, zero payload bytes and index pages at attach |
| G7 Reconciled accounting | Pass | Operation and byte accounting reconciled |
| G8 Complete cleanup | Pass | All seven teardown entries done; Worker, container application, bucket and generated config absent; zero objects and zero multipart uploads |
| G9 Statistical validity | Pass | 40 of 40 requested segment observations exist and are priced, five per workload per repetition |

The four decisions, in landing order, each with its measurement:

(a) Every operation route asks again while the box is starting
(`fc9d4f010`). Run `20260914234711` recorded eight decisive segments as
`unobserved execution` on the box's own `A startup is armed, so ask again`,
read after the fixture's 6,000 ms admission window against a box that had
just been quiesced, while `pollForAttach` beside them re-drove the same
refusal. `askWhileStarting` in `scripts/bench-devbox-strategies.ts` is the
one rule: `execInBox`, `writeFileInBox` and the readiness drive ask again
every 250 ms while the reply is the re-askable refusal, until the startup
observation ceiling, and return the box's own last words after it; a
terminal refusal is the answer on the first ask, and a refused write throws
instead of passing as written. `scripts/bench-devbox-ask-again.test.ts` is
red on a tree where either route returns its first refusal. No budget,
ceiling or window changed.

(b) A stop never lands under a caller (`bb0195201`). Run `20260914234711`
lost `sqlite/1/1` and `git/2/4` to `OperationInterruptedError` three
seconds into each command, and quiesced under `git/1/1`'s successor. Two
causes, both in the box. First, `quiesceStep` trusted a `quietSince` older
than the last interaction: a beat cannot run while a scheduled checkpoint
holds the object's one alarm, so a 72 s tick starved every beat inside it,
and the first beat afterwards read a 73 s idle lease beside a 97 s old
stretch and stopped. A stretch that began before the last interaction now
ends with it (`packages/devbox/src/lifecycle.ts`); the timing matrix in
`tests/decisions.test.ts` is red before and green after. Second, the
decision behind a stop was made before a final checkpoint that runs for
minutes, and a request admitted meanwhile ran on the container the stop
then killed. `quiesce` now re-checks for an executing command, a claimed
resource lane or a caller stamped since the decision after the checkpoint
and refuses the stop, keeping the commit; `ensureReady` stamps the lease
for every admitted operation, so file traffic counts as use.
`tests/stop-under-caller.test.ts` is red before the fix (the stop landed
under an admitted exec) and green after, with its no-caller control
stopping; `tests/terminal-activity.test.ts` pins the write stamp.

(c) A witness cell's setup replies are read (`665ed6a09`). Run
`20260914234711`'s `chunked-absorption` cell wrote its marker through an
exec that was answered "ask again", never read the reply, and judged a
marker nobody wrote: G2's "expected red witness vanished". With (a) the
exec is answered; `ranInBox` ends the cell with the box's own reason if a
setup command did not run to exit 0.

(d) A delta batch's `set -e` stays inside its own subshell (`84a026c2f`).
The SDK runs every command of a box in one persistent `bash --norc`
session (`@cloudflare/sandbox` 0.12.8 container server `initialize()`), and
`runOpsBatched`'s top-level `set -e` outlived its batch: from the wake's
delta-namespace batch on, the first failing command from any caller ended
the session with that command's status. G3's read-only probe, a `touch`
meant to fail with EROFS, answered `SessionTerminatedError: Session
'sandbox-default' shell exited (exit code: 1)` in run `20260915012040`,
and D5's G3 recorded the same death on 2026-09-13 as "the read-only probe's
top-level `exit` terminated the persistent SDK shell". The probe's
subshell fix (`9ae255d17`) treated the symptom; the `set -e` was the
cause. Measured 2026-09-15 on the pinned image's own container server run
locally: a `set -e` batch then a failing top-level command ends the
session; the same batch inside `( … )` and the session survives. The batch
is now `header, (, set -e, ops, )`; `tests/support/session-shell.ts`
refuses a command whose top-level `set -e` would outlive it as the third
member of its session-death class, so the conformance and chain suites are
red on the old batch text, and `tests/decisions.test.ts` measures both
directions against a real bash fed the way the SDK feeds a session.

The intermediate run `20260915012040` on clean `bb0195201` (with (a), (b)
and (c), before (d)) passed nine gates and refused only G3, with 40 of 40
segments priced and both witnesses observed; its artifacts are committed
beside this run's. D13 and D14 are unchanged. No gate, ceiling, budget,
workload, witness or lock changed in any of the four. Teardown of
`20260915065241`: `bench-artifacts/teardown/20260915065241.json`, seven
entries done, zero residue objects and zero multipart uploads; the account
lists no Worker, application or bucket of this run. Artifacts:
`bench-artifacts/devbox-strategies-20260915065241.json`,
`bench-artifacts/20260915065241/snapshot-chain.json`; driver output
`kinu-logs/devbox-settle/run-20260915065240.log`.


D19. A start budget and its races are measured on one clock the box is
handed, not on the wall clock (2026-09-15). `openStartBudget` measured
`remainingMs` with `Date.now()` and `raceAllowance` armed a real
`setTimeout`, so a test budget was a race against the machine.
`tests/lifecycle-generation.test.ts`'s `TightBox` holds a 20 ms budget so
one step can be exhausted without sleeping; under the deploy wave on main
`bea156897` the whole restore outran that budget before the parked
exposure was reached, and "an exposure that outruns its allowance is
reported, not exposed and not replaced" received `[deadline → repair]
restoration did not settle inside the 20ms hook budget` in place of `port
3000`, while passing 3 of 3 alone.

The change: `StartClock` (`now`, `after`) in `packages/devbox/src/
lifecycle.ts`; `openStartBudget(budgetMs, clock)` carries it and every race
under the budget arms its timer on it; `runRestoreStep` takes the clock;
`Devbox.startClock` answers `REAL_START_CLOCK` in the product and the
hook, the repair and their races read it. The 20 ms policy value is
unchanged; the request-join hold (`requestJoinMs`) is a caller's wait, not
a start budget, and stays on real timers. `manualStartClock()` in
`tests/support/devbox-harness.ts` fires armed timers only when a test moves
it: `tick()` fires the earliest timer alone, `advance(ms)` every timer due
on the way. `TightBox` measures its budget on one; the exposure and
slow-server tests `tick()` so the parked step's own allowance elapses and
the hook's does not, and the boot-stamp test `advance(20)` so the hook's
does. A budget property is now the arithmetic of the budget: which timer
is earliest, never how fast the runner reached the parked step. Also found:
bun's `expect(promise).rejects` blocks the test until
the promise settles, so under a test-driven clock the assertion must
follow the advance.

Measured 2026-09-15 on this branch. The failing test and the new control
"the exposure verdict does not depend on how slowly the container answers"
(every command 25 real ms, longer than the whole budget) pass 3 of 3 alone,
and 3 of 3 with `bun test --parallel=4 packages/cf-backend` and a 24-way CPU
burner running beside them, one-minute load average 13.80 on 24 cores. The
control is red 3 of 3 on main `bea156897`, where the same scenario answers
`[abandoned → replace] Devbox.onStart exceeded its 20ms budget`; main's
original test did not go red under load 13.80 in 3 runs, so the deploy
wave's exact load was not reproduced here and the fix rests on the control,
not on a re-run of the wave. The whole `lifecycle-generation` file passes
3 of 3 (56 tests); the devbox package passes 484 bun tests and 7 workerd
tests; `gate:do-init` is unchanged. No timeout, budget or window was
raised and no test retries.


D20. The hosted workspace runs Nimbus's published hosted runtime, not a
hand-built host (2026-09-21, commits `5a3f3530f` and `5b7438e59` on
`feat/nimbus-hosted-runtime-0921`). `createHostedWorkspace` composes
`composeHostedRuntime` (`@nimbus-sh/worker` 0.8.0, core 0.10.0, fabric 0.6.0,
sdk 0.7.0) over the bundle's own `NimbusWorkspace`, with Kinu's one
`PortRegistry` per isolate and the runtime's `schedule`/`cancel` mapped onto a
timer plus `waitUntil` per reason, because the object's alarm slot is the
Agents SDK scheduler's. The slate re-drive hook is load-bearing (the manager
refuses a durable spawn carrying `globalOutbound` without an embedder
`resolveWorkerLaunch`), so it rides an upstream patch
(`patches/@nimbus-sh%2Fworker@0.8.0.patch`, upstream branch
`feat/hosted-runtime-hooks`, `3f83361e`). Measured 2026-09-21 in the worktree:
`bun test packages/core/` 5807 pass 0 fail; the cf-backend host suites over the
composed runtime (`unit-workspace-locality` 12/0, `unit-workspace-cwd` 4/0,
`unit-private-tmp` 14/0, `unit-global-view` 16/0, `unit-exec-credential` 8/0,
`unit-facet-tmp-confinement` 6/0, `unit-node-home-wiring` 28/0,
`unit-workspace-host-facets` 3/1, its hosted `npm install` case red because
upstream's installer resolves through a `LOADER.get` facet the suite's fake
loader refuses); the commit tier (lint plus every typecheck project) is green. The
workerd tiers and the bundle size are unmeasured for this change.

D21. A current workspace filesystem opens over a read-only handle
(2026-09-21). Upstream `@nimbus-sh/core` 0.10.0 writes the schema-migration
marker (`INSERT OR IGNORE INTO vfs_schema_migrations`) on every `SqliteVFS`
construction; every other schema step is already conditional, so a reader
holding a `readonly` database failed with `SQLITE_READONLY` although nothing
needed writing. The fix gates the marker on the marker's absence, upstream on
`feat/hosted-runtime-hooks` (`3f83361e`, `tests/unit/sqlite-vfs-readonly-open.mjs`:
red at its line 27 without the change, `sqlite-vfs-readonly-open: ok` with it)
and here in `patches/@nimbus-sh%2Fcore@0.10.0.patch`. Measured 2026-09-21 in
this tree with `bun test packages/cli-backend/tests/vfs-blob.test.ts` ("a
current filesystem opens read-only and reads what a writer left"): red with
the guard removed from `src/vfs/sqlite-vfs.ts`, green with it. The same run
showed the earlier `dist`-only hunk never reached bun at all, since the
package's `bun` export condition resolves to `src/*.ts`; the patch now carries
both.

D22. The Nimbus upgrade retires the hook patch and grows the read-only one
(2026-09-21, commits `81e5964ff`, `7eaef3034` and this one on
`lane/nimbus-0921b`). Core moves to 0.11.0, worker to 0.9.0, sdk to 0.8.0 and
fabric to 0.7.0; `@nimbus-sh/platform` follows to 0.5.0 under them and stays
undeclared. Every version stays an exact pin, not a caret, because
`patchedDependencies` is keyed by `name@version`: a range that aged to 0.11.1
would match no key and would drop the patch with no manifest line changing.
So every declaration moves by hand, the root `devDependencies` included: left
at 0.10.0 it hoisted core 0.10.0 to the top of `node_modules` and nested
0.11.0 under each workspace, so the copy that ran was the stale unpatched one.

Retired, because upstream carries them: D20's `resolveWorkerLaunch` embedder
hook is in worker 0.9.0 at `dist/hosted/runtime.d.ts:29`
(`resolveWorkerLaunch?: FacetManagerHostHooks['resolveWorkerLaunch']`) and
`dist/hosted/runtime.js:74`, with the plumbing at `dist/hosted/services.d.ts:20`
and `dist/hosted/services.js:86`. It sits on `HostedRuntimeOptions` directly,
not under a `hooks` member, so `createHostedWorkspace` passes it flat now.
`dist/workspace-host.d.ts:1-2` re-exports `FacetManagerHostHooks` and
`WorkerRecipe`. Two hunks are not upstream and stay: `facets()` is absent from
`composeHostedRuntime`'s return (the 0.9.0 surface is `workspace terminal files
runtimes ready exec runCode startProcess listProcesses killProcess
writeProcessInput endProcessInput resizeProcess signalProcess processLogs
listPorts listApps ensureDurableApp unexposePort removeDurableApp exposeApp
removeApp rotateLink installRuntime ensureRuntimes listRuntimes spawnWorker
routeCapabilityPort supervisorOp onScheduled attachTerminal terminalFrame
terminalClose close`), and `LongRunningWorkerSpawnOptions` is still not
re-exported from `workspace-host.d.ts`. The whole `NPM_REGISTRY` group is
absent too: `dist/hosted/commands.js:824` calls
`install(cwd, { packages, pid: ctx.pid })` and `dist/npm/r2-cache.js:102` keeps
`NPM_REGISTRY_ORIGIN` a module-private constant.

Grown: core 0.11.0 reintroduces D21's defect in four new places, all
unconditional writes on the construction path: the filesystem identity row
(`src/vfs/sqlite-vfs.ts:772`), the device row (`:780`), the `vfs_ino_allocator`
seed (`:924`) and `backfillInoColumn`'s two `UPDATE`s (`:1033-1034`). The
stable-inode allocator is new in this version. Each is now gated on its row's
absence, the same shape D21 used. Measured 2026-09-21 in this worktree with
`bun test packages/cli-backend/tests/vfs-blob.test.ts` ("a current filesystem
opens read-only and reads what a writer left"): 5 pass 0 fail with all five
guards, and 4 pass 1 fail with any one of them reverted alone: identity,
device, allocator seed, backfill and the D21 marker, each measured separately.

Upstream contract changes our code took: the flat `resolveWorkerLaunch` above,
and one credential-bound filesystem authority: `composeFacetManager`'s
`FacetManagerDeps` and core's wasm runner factories now take
`NimbusFilesystemAuthority` where they took a raw `SqliteVFS`
(`@nimbus-sh/core/dist/runtime/bash-runner.d.ts:74-77`), read off
`NimbusWorkspace.filesystem`. The handoff's unlink-ENOENT restoration needed no
adaptation: our `unlink` delegates to `files.delete` and reads no code.

Measurements, all 2026-09-21 in `/home/mrwhite0racle/Kinu-wt-nimbus-0921b`:
`bun test packages/cli-backend/tests/vfs-blob.test.ts` 5 pass 0 fail;
`bunx vitest run tests/workerd/{slate-durability,do-eviction-recovery,slate-egress,slate-process}.test.ts`
from `packages/cf-backend` 4 files 20 tests passed 0 failed;
`bun run gate:patch-parity` ok, 7 patched dependencies and 30 files governed,
core 4/4 and worker 13/13 matching; `bunx tsc --noEmit` clean on the `core`,
`cf-backend` and `cli-backend` projects; `git diff --stat bun.lock` 16
insertions 16 deletions, every version row `@nimbus-sh`.

For the next upgrade: `bun patch --commit` followed by
`bun install` left three module instances of `@nimbus-sh/platform` (top level,
under `fabric`, under `sdk/@nimbus-sh/core`). `composeFabric` holds its
composition in module state and is first-write-wins, so the host's
`hostNamespace: 'OrchestratorAgent'` went into one instance while the runtime
read another and refused with `HostedRuntime: env.NIMBUS_SESSION must be the
Durable Object namespace configured by composeFabric`, and 6 of 20 workerd tests
went red on a tree whose manifests and lock were already correct. A
`rm -rf node_modules && bun install` collapsed it to one copy of each and all
20 passed. The duplication is an artefact of incremental installs over a patch
cycle, not of the new ranges: the primary checkout's tree holds one copy.
Re-cut a patch, then install clean before believing any suite.

D23. A sealed message is projected once; a delta mints no revision
(2026-09-21, commits 558ce4165 and this one). Measured cause of the Durable
Object CPU resets on the eval workspaces. The observability API with a
`$workers.durableObjectId` filter shows the eval objects' alarm and RPC
invocations at `exceededCpu` (cpuTimeMs 30,000, wall 36 to 100 s; one
object burned 649 s of CPU in 26 minutes), every frame the same: activation,
`subordinate.assignment_repended` (the interrupted delegated turn re-run
from its start), a model call, the budget. Output tokens are small (2,370
over 8 calls for `durable-continuity`), so the burn is not the stream. It
is the read: every step materializes every message in its context from its
`message_updates` rows, and a streamed answer is one row per delta, so the
cost of a step grows with every answer ever streamed in the workspace and
a delegated turn of ten steps re-pays it ten times. Measured under the
workerd pool (`tests/workerd/long/transcript-cost.test.ts`): a 500-delta
turn cost 396 ms on an empty transcript and 2,474 ms after twenty
2,000-delta answers, and the twenty priors themselves took 44.8 s.
Three changes, each measured: (1) a delta extends its message under the
fence and mints no context revision; the cutoff moves once at the step's
seal (2,002 revisions per 2,000-delta answer became 3; bun:sqlite 5.2 s to
2.1 s over 60 turns). (2) `append` asks the two partial indexes with literal
operations instead of walking every update of the part (8,000 deltas 3.97 s
to 2.12 s; a bound parameter defeats a partial index, so the operation is in
the statement text). (3) `message_projections`: a sealed message's
materialized form is written once on the first read after its seal and read
as one row thereafter; the update rows stay the truth and a missing
projection is rebuilt from them. The same turn after twenty long answers
measured 375 ms (1.03x the empty transcript; the priors 22.4 s). The gate
above holds the ratio under 3x and is red on the old reader at 6.3x.
(4) After (1)-(3) shipped as 5682c7907 the eval object `del-gw1zqv` still
reset ten times in ten minutes, each frame 30 s of CPU across activation,
the re-run of the interrupted delegated turn, and its two model calls, with
output tokens in the low thousands per call. What remained was one storage
statement per streamed token: a reasoning model streams tens of thousands.
Deltas now reach the rows in windows of 64 deltas or 4 KB, written ahead of
the part's next non-delta update or by the step's final text (bun:sqlite,
30,000 deltas: 7.2 s and 40,051 rows to 0.85 s and 682 rows; the workerd
gate 256 ms and 297 ms). A cut turn keeps all but its last window.
Pins: `packages/cli-backend/tests/local-session.test.ts` "a streamed answer
mints a revision per step" and `packages/core/tests/unit-session-context-store.test.ts`
"a sealed message is projected once", both red on the old code.

D23-N. Every instance of the host namespace answers `supervisorOp` with the
hosted runtime (2026-09-21, this commit; the Nimbus upgrade to core 0.12.0,
worker 0.10.0, fabric 0.7.1, sdk 0.8.1, platform 0.5.1 under them). The host
forwarded the envelope to `bundle.session().supervisorOp`, which is core's
bare-workspace handler: it serves the filesystem ops natively and refuses
every host op, the ones `SUPERVISOR_OP_ROUTES` names
(`@nimbus-sh/core/dist/workspace/supervisor-op.js:103-141`, `fanoutExecute`
at `:133`). Core 0.12.0 says so in the refusal itself
(`:281-286`): "'<op>' is a host op, and this handler is a bare workspace's.
Forward supervisorOp(envelope) to composeHostedRuntime(...).supervisorOp on
every instance of the host namespace, the siblings Nimbus opens by name
included (fanout peers, process hosts)."

A resolver layer of five
packages or more is sharded across sibling objects of the composed namespace
(`@nimbus-sh/fabric/dist/fanout.js:30` `IN_DO_THRESHOLD = 5`, the names at
`:153-157` and `:234`, the dispatch at `:250`), and each shard arrives as
`supervisorOp({ op: 'fanoutExecute' })` on an object of our class opened under
`nbf:npm-resolve-fanout:<doId>:<shard>`. `createHostedWorkspace` composes over
whatever storage the object holds, so a sibling is a runtime with its own
empty filesystem, with no genesis, owner or transcript. Kinu's `ensureSchema`
runs from `onStart`, and the Agents SDK starts that lifecycle from `fetch`,
`alarm` and its own internal RPCs only (`agents/dist/src-5W6JNKVb.js:459-460`
and `durable-object-lifecycle-D6nNQJJd.js:824-836`), never from a plain RPC
method such as this one.

Measured 2026-09-21 in `/home/mrwhite0racle/Kinu-wt-nimbus-0922` with
`bunx vitest run tests/workerd/nimbus-git-npm.test.ts` from
`packages/cf-backend`: 3 pass 1 fail with the workspace answering, the failure
`resolver-fanout failed at layer 0: peer shard
nbf:npm-resolve-fanout:9d8e18eb2375:3 (1 task) ... 'fanoutExecute' is a host
op, and this handler is a bare workspace's (layer width 6, peer-do)`; 4 pass 0
fail with the runtime answering. The suite installs six packages off the
fixture registry for exactly that width, and clones over the fixture's git
smart-HTTP origin.

The `git clone` half of the same 2026-09-21 failure was upstream, not here.
Worker 0.9.0 minted a facet's supervisor binding with props
`{ doId, pid, mutationOwner }` (`dist/git/network-facet.js:410`) and its
entrypoint resolved the host namespace from `hostNamespace()`, its own
isolate's composition (`dist/session/supervisor-rpc.js:88`), which is empty in
the isolate workerd serves an entrypoint from. That produced `SupervisorRPC:
env.NIMBUS_SESSION is not a Durable Object namespace` on a clone in a
correctly composed workspace. 0.10.0 mints `route: hostRoute() ?? undefined`
into the props and resolves through `hostNamespaceBinding(this.env,
'SupervisorRPC', props.route)` (`:95`). Every op a clone facet performs is a
filesystem op, so the clone cases in the suite above are green under both
handlers; they stay as the end-to-end proof that a facet reaches this object.

This runtime never clones a local path, at any version: every
`git clone` is delegated to the network facet
(`@nimbus-sh/worker/dist/git/commands.js:385`) and the bundled isomorphic-git
registers `http` and `https` transports only (`GitRemoteManager.getRemoteHelperFor`
in `dist/git-bundle.generated.js`), so `git clone seed/app-a` is a URL parse
failure rather than a copy. The suite asserts that refusal by its own words,
so a host failure can never hide behind it.

D24. A streamed answer accumulates in SQLite in one row per open part and
is committed once (2026-09-21, commits bef2de9bf through bd383b907 on
`lane/session-store`). The owner's decision, removing D23's defect at its
root: `message_updates` (an append-only ledger folded to a cutoff on every
read), `message_parts` and D23's `message_projections` cache are gone, with
every `*_sequence` column and FK, `PreparedMessageUpdate`, the two partial
indexes and `SessionHistory.extendOutput`. A message row holds its envelope
and, once sealed, its parts array (`content_json`, or `content_path` plus
digest through the payload spill rule). A streamed answer accumulates in
`stream_parts`, one row per open part, extended by D23's window of 64
deltas or 4 KB as one `UPDATE ... SET text = text || ?`; the seal at step
end writes the content row and deletes the stream rows. `MessageReference`
is `{ messageId }`; every sequence fence is an open-or-sealed check under
the turn-epoch fence. A turn that ends before its step seals what streamed;
a message a reset activation left open seals at the next admission; a fork
refuses an open message. Tool results keep `toolCallId` and `toolName` in
their value; `replyTo` is data in the parts array. The schema genesis is
re-locked (a reset deployment; there are no users).
Measured 2026-09-21 in `/home/mrwhite0racle/Kinu-wt-session-store` with a
throwaway bench (not committed) driving `SessionStream` over bun:sqlite,
one streamed text answer, three runs each, median; the base 0104882bb read
through a `git archive` copy under the same modules. Stream time is the
whole answer from `text-start` to the step's seal; rows are what the answer
leaves. 2,000 deltas: base 12 ms, 39 `message_updates` rows plus 2
`message_parts` and 1 projection per answer; now 9 ms, 1 `stream_parts` row
while open and 0 after, the answer in its message row. 30,000 deltas: base
90 ms and 476 update rows; now 68 ms and 1 row while open. The read of a
context after twenty 2,000-delta answers: base 6.8 ms (projection rows),
now 5.6 ms (content rows). bun:sqlite in memory is the floor of both
shapes; the Durable Object statement cost D23 measured is what the row
counts stand for. The workerd transcript-cost gate
(`packages/cf-backend/tests/workerd/long/transcript-cost.test.ts`) on this
tree: a 500-delta turn 219 ms on an empty transcript and 299 ms after twenty
2,000-delta answers (1.37x, bound 3x). Removed: 3 tables (`message_parts`,
`message_updates`, `message_projections`; `stream_parts` added), 7
`*_sequence` columns with their FKs, 4 fork staging columns, 908 source
lines against 544 added across 22 files (`git diff --numstat 0104882bb
bd383b907 -- 'packages/*/src/**'`).
Review fixes (commit d8a16a673): a streamed answer joins the working
context only when it seals, so a context revision names immutable content;
every container seals before its step advances, so a step cancelled while
reasoning keeps its buffered tail; a part whose text outgrows one row
continues in the next `stream_parts` segment (262,144 UTF-16 units, under
the payload inline bound and the platform row limit) and its descriptor
follows the spill rule; an abandoned message is one whose request's claim
is settled or superseded in epoch, sealed after an admission commits and
never by one the store refuses. The delta window counts UTF-8 bytes.
Pins: `packages/core/tests/unit-session-stream.test.ts` (five), the fork
refusal in `packages/core/tests/unit-fork.test.ts`, and the row bound in
`packages/core/tests/unit-session-context-store.test.ts`.
Pins: `packages/cli-backend/tests/local-session.test.ts` "a streamed answer
holds one stream row per part while open and none once sealed" and
`packages/core/tests/unit-session-context-store.test.ts` "an open message
reads its accumulated text and a sealed one its content" and "a message left
open by a dead stream seals from what it accumulated at the next admission".

D25. A wake proves a recycle only after the stop confirms (`6b217f201`,
2026-09-04). The 2026-09-04 rerun (`kinu-devbox-bench-20260904142724`) saw
candidate arms wake empty with "candidate control has no published head".
Probe `kinu-devbox-bench-20260904220340` (bounded-layers, tip `66aa6f501`)
ran a real recycle: stop 8578 ms, wake 579 store calls in 45917 ms, boot
`fd48f635` then `64b07fe4`, and the publish-time and wake-time control rows
were identical. No write was lost. The cause stays an inference: stops that
never completed were measured as recycles. `requireConfirmedStop` in
`scripts/bench-devbox-strategies.ts` refuses a wake after an unconfirmed stop.

D26. Restore runs inside the SDK start block again (2026-09-23,
`5d3197bfe` and `61aa55ef7`, `@cloudflare/sandbox` 0.12.9). This reverses D8's placement
(hook after the block) and restores R1: no event reaches the object until
the restore settles. Two platform facts made the in-block hook deadlock, and
the patched SDK isolates the hook from both.

P4 was D8's deadlock. In the first start block of D8's trace
`b20260913105359` the hook's execs answered (700, 143, 59, 99, 56, 55 ms),
because their capnweb connection opened inside that block. The second
block, 12 ms after a request exec, sent the boot-id RPC over that earlier
connection, and the reply could not arrive inside the new block. The SDK
closes an idle connection after 1 s, so the window is narrow.

P5 was found while measuring the P4 fix: a timer the hook set never fired.
The SDK's control client polls every 1 s while a connection is open, the
alarm loop waits between schedule rows, the containers package arms a 5 s
timer per port ping and never clears it after a successful ping, and
Devbox's admission window ran for `portWaitMs`. Each is set before the
block, and once due it holds every timer the hook sets, the D19 restore
budget's included.

The change. The containers patch runs `setHealthy`, then `callOnStart()`,
inside both start blocks; `callOnStart()` ends the alarm loop's wait (as a
container exit does; the loop re-arms) and calls `onStart()`; each port ping
clears its timer when the ping settles. The sandbox patch overrides
`callOnStart()`: it suspends the outer control client's poll and idle
timers and runs the hook on a fresh client (`createClientForTransport`),
whose connection opens inside the block and never starts a container;
afterwards it restores the outer client and resumes its timers, and
in-flight calls on the outer client keep their connection. Devbox disarms
its admission window when the hook starts, a checkpoint that meets a pending
startup waits for it to settle instead of racing a timer (`requestJoinMs` is
gone), and `resolveReadiness` no longer joins the hook, because no request
runs while the block holds the gate. `scripts/do-init-gate.ts` requires both
start blocks to run the hook through `callOnStart`, the installed
`callOnStart` to suspend the outer timers and swap the client before the
hook, the base `callOnStart` to clear the alarm wait before `onStart()`, and
every `addTimeoutSignal` result to be cleared in a `finally`; every other
input block still reaches no container RPC.

Residual. A timer another event sets before the block, outside the SDK's and
Devbox's own, still holds the hook's timers once it falls due (the stray
column below). The hook's ordinary path awaits no timer; the budget's races
need one only when a step overruns, and then the platform resets the object
at 30 s and the next activation recovers the interrupted restore (the
`restoring` row, `ContainerStartInterrupted`).

Measured on the tree that ships, deployed 2026-09-23 with
`scripts/bench-devbox-onstart-shapes.ts --pending connection,alarm,stray
--runs 3 --hold-ms 6000`: `@cloudflare/sandbox` 0.12.9 and
`@cloudflare/containers` 0.3.7 from npm, the product image
`kinu-devbox-block-layer@sha256:8561558654fd05c04ff1c229ab24c1e248852fc8fb7953cd4300134f2ef13957`
(built on `cloudflare/sandbox@sha256:4a56a37a…`), window 5,000 ms, a request
every 250 ms. Each arm is the same probe (`probeReentry`: start, leave one
timer pending, start again at once, hook execs once, then holds 6 s, past
the 5 s ping timers) built from those packages plus one patch set: outside
is `b2c60d09f`'s pair and inside is upstream's containers package with
`b2c60d09f`'s sandbox patch, both ported onto the 0.12.9 chunk; rotated is
this tree's pair. Pending timer: connection (an exec just before, so the 1 s
poll is armed), alarm (two schedule rows, the loop waiting for the second),
stray (a 1 s `setTimeout` nothing clears). Outside and inside ran as
`s20260923032104` (03:21 to 03:33 UTC); that driver died in the rotated arm
after its connection cell, so the rotated arm ran again, whole, as
`s20260923033729` (03:37 to 03:42 UTC).

| Arm, run | connection | alarm | stray |
| --- | --- | --- | --- |
| outside (D8), `s20260923032104` | exec 88, 114, 131 ms; 22, 21, 22 requests ran during the hook; exited | exec 269, 361, 375 ms; 21, 22, 22 requests; exited | exec 292, 339, 292 ms; 22, 23, 22 requests; exited |
| inside (upstream block), `s20260923032104` | no reply, 3 of 3; reset at the cap | exec 377, 347, 369 ms; hold never ended, 3 of 3; reset | exec 325, 350, 311 ms; hold never ended, 3 of 3; reset |
| rotated (D26), `s20260923033729` | exec 209, 180, 172 ms; no request during the hook; exited at +6.2 s, 3 of 3 | exec 271, 362, 578 ms; no request; exited at +6.3 to +6.6 s, 3 of 3 | exec 338, 312, 268 ms; hold never ended, 3 of 3; reset |

The partial rotated arm of `s20260923032104` agrees: connection 3 of 3, exec
53 to 61 ms, gate held, exited at +6.1 s. Every arm deleted its Worker and
container application and listed the application absent; the one the dead
driver left (`kinu-devbox-shapes-s20260923032104-rotated`) was deleted by
hand at 03:37:23 UTC. At 2026-09-23T03:42:36Z the account listed 67 Worker
scripts and 6 container applications, none named `kinu-devbox-shapes-*`
(Workers API `GET /workers/scripts`, `wrangler containers list --json`).

History, superseded by the table above. Deployed `s20260923013446`
(0.12.8, connection only, before the timer suspension): outside answered in
80 to 103 ms with 6 to 7 requests during the hook; inside got no reply, 4 of
4; rotated answered in 152 to 176 ms and its 2 s hold never ended, 4 of 4,
the first sighting of P5. Deployed `s20260923030235` (0.12.8, suspension in,
ping timers leaking): rotated exited 1 of 2 on connection and 0 of 2 on
alarm, which found the ping timers. Local `s20260923025542` (0.12.8,
suspension in, 2 s hold, 2 runs per cell) matched the table above except
that the 2 s hold ended before the ping timers fell due. `s20260923011640` is
void: `git apply` inside the repository skipped every patch.

Tests: `tests/restore-after-start.test.ts` T1 and T5 are red on D8's harness
(the hook outside the block) and green on the block-holding harness;
`scripts/do-init-block-bodies.test.ts` is red on D8's shape, on upstream's
block, on a `callOnStart` that keeps the old client or leaves its timers
running, on a start block that leaves the alarm wait armed, and on a port
ping that leaves its timer pending. On the tree that ships (a clean install
of 0.12.9 with both patches, 2026-09-23): `scripts/do-init-block-bodies.test.ts`
10 pass, 0 fail; the devbox package 483 pass, 0 fail; its workerd suite 7
pass; `bun scripts/do-init-gate.ts` ok; `bun scripts/patch-parity.ts` ok.

D27. Snapshot-chain stays and the storage strategy search stops (owner
decision, 2026-09-23, checklist row DBX-10; asked first in m1191). The
evidence is D18: settlement `20260915065241` admitted snapshot-chain on all
ten gates, and no other design measured under the contract below was shown
better (D5's table). A new design reopens the search only with a comparison
run under that contract; none is scheduled (O3).

D28. The Durable Object batches the container calls it keeps (DBX-7,
`b60c5d873`, 2026-09-23; asked in m712: "combine multiple exec api calls to single ones
wherever possible, as the DO <> container I/O can be flaky"). Measured
first with `scripts/bench-devbox-exec-census.ts` over the deployed `kinu`
Worker, 6 h to 2026-09-23T03:44Z: 509 `sandbox.exec` events in 303 Durable
Object invocations across 16 boxes. Per invocation: a heartbeat alarm, 1
exec (235 of them) plus a `containerFetch` ping; an idle checkpoint tick, 2
or 3 (the mount table, the upper's fingerprint walk, a boot-id read; 44); a
committing checkpoint, 9 or 10; a restore, 8. Process-lane commands
(`startProcess`) raise no event and are outside the count. The heartbeat's
ping and boot-id read are now one exec, since the read crosses the same
control plane; the idle tick's mount-table read and fingerprint walk are one
exec (`tickProbeCommand`). The committing checkpoint's calls stay as they
are: DBX-5 moves backup and sync into the container (m712: that machinery
"should live inside the docker image/container itself, and NOT be issued via
the DO"), which takes them off the Durable Object entirely.

D29. Checkpoint payloads do not cross the Durable Object; DBX-5 moves the
orchestration, not the bytes (2026-09-23). The chain's publish (D15) and its
layer reads go to `r2.internal`, which the SDK serves in its `ContainerProxy`
WorkerEntrypoint: `@cloudflare/sandbox` 0.12.9, `dist/sandbox-D0rNqxlr.js`
lines 7199-7222 (`ContainerProxy$1.fetch` sends `r2EgressMount` to
`r2EgressHandler`), with the SDK's note that the handler registry is "NOT
shared between the Durable Object's execution context and the ContainerProxy
WorkerEntrypoint context"; `putRequestBody` and `handleUploadPart` stream
each object and part through a `FixedLengthStream` into the R2 binding, with
no buffering. Cloudflare
documents outbound handlers as running on the container's machine. Presigned
URLs straight to `<account>.r2.cloudflarestorage.com` were weighed and
dropped: `KinuSandbox` sets `interceptHttps` with a catch-all handler, and
the documented precedence sends even an allowed host through that handler,
so the hop would stay and signing keys would return to the Worker. Status:
read from source. The Durable Object byte meter that shows zero payload
bytes on a deployed run lands with DBX-5's in-image checkpoint.

D30. The container syncs itself; the Durable Object keeps the record
(DBX-5, 2026-09-23; asked in m702, m712, m859). Writes land on the
overlay's local upper, the local cache, and the image's `sync.js` publishes
them in the background: every `checkpointIntervalMs` (5 min, as before) it runs the
chain checkpoint on the container's own shell, fingerprint-gated, so an idle
box costs one local walk per period and no request. The code that runs is
`snapshotChainStorage(...).checkpoint`, the same code the box ran, bundled
from `packages/devbox/src/sync-main.ts` into the block-lower image. What a
container cannot reach, it asks its box for, over the path Cloudflare
documents for this ("Connect to Workers and Bindings", containers docs, read
2026-09-23): a POST to `http://devbox.internal/v1/sync`, which the class's
outbound handler (`devboxSyncHandlers`, registered per concrete class because
the registry is keyed by class name) sends to the box resolved from
`ctx.containerId`. The box answers `devboxSync` with its own ports:
`readState`, the fenced `writeState`, `checkChanges`, the store mount, and
`objectFacts`/`deleteObjects` on the binding. Any process in the container
can reach that host, so the box holds every request to its own record:
a container generation other than the one it restored is refused, a key
outside the box's store prefix is refused, and a record that names a new
layer must name one the store holds at the declared size (the box checks
with its own `head`). A request can therefore damage only this box's own
history, which a process in the container could already do by deleting its
files. The box starts the program after each restore; when the heartbeat's
single container call finds it gone (D28's call now also carries that probe),
the box files an incident, since nothing commits while it is down, and starts
it again. Its alarm no longer ticks checkpoints. A stop's final checkpoint
is one exec, `sync.js flush`, answered by the running program after its tick
in flight, or in that process when none runs. When the stop goes ahead, the
box ends the program before it detaches: the program finishes the checkpoint
in flight, then exits, so no tick races the detach; a refused stop leaves it
running. The flush runs in its own SDK session (`devbox-sync`): the container
server runs one command at a time per session (`executeInSession` holds a
per-session lock, read from the 0.12.9 container server), and a store mount
the sync asks for runs in the default session, which the flush would
otherwise hold until it finished. The container remembers the record it last
read or wrote, so a tick with nothing to commit asks its box nothing; the
retained-change query now runs only when a commit is due. A box that may
extract (local
`wrangler dev`, whose containers get no outbound interception, measured
2026-09-23: a request to an intercepted host connected and never reached its
handler) keeps driving its own checkpoints, as before. The block lower's log
and the sync's log go to the container's stdout, which Workers Logs carries
(DBX-7). Both redirect through bash process substitution; the session shell
is `bash --norc` (read from the 0.12.9 container server), so the tests' parse
gate now models bash where it modelled POSIX `sh`. The image and the box move
together: `block-lower/upstream.json` pins the bundle's sha256
(`dceb17ed…`, image `kinu-devbox-block-layer@sha256:8a2c971c…`), and
`tests/block-image.test.ts` bundles the tree again and fails on any other
bytes, so a change to the sync's code fails until the image is rebuilt and
re-pinned. Status: built and unit-tested; the deployed measurement of the loss
window and of the box's bytes per checkpoint is pending.

## Measurement contract for a strategy comparison

Vary stored bytes B, file count N, changed bytes D and demanded bytes Q
separately, on identical committed trees. Capture pre-admission metadata
bytes, CPU work, request count, peak memory and elapsed hook time. A request
count is not a cost. A local workerd clock is not a cloud latency. A run is
admitted only when every G gate passes; a refused run ranks nothing.

## Open

O1. Closed by D18 on 2026-09-15: settlement `20260915065241` on clean
`84a026c2f` passed all ten gates and `admission.admitted` is true. What
follows is the history that led there, kept as written.

Full live acceptance was refused by D5's dated settlement. Witness
registration is complete in `fed2b9d779` and both witnesses passed on
deployed Containers and R2. The two measured blockers are now closed: D14's
alarm-starvation fix ran ten `--lifecycle` cycles with zero refusals
(`b20260914073654`) and D15's egress publish is one object attempt live
(`b20260914082622`, `puts: 1`, correctness passed). The post-fix
settlement ran on 2026-09-14 (D16, run `20260914220919`, clean
`e060e360f`): the cold attach was refused at its 54,540 ms ceiling with
`restoration:unstarted`, no cell ran, and G3, G6 and G9 all scored
Refused for missing measurements. D17 measured that refusal as the fresh
container application's rollout inside the observer ceiling and moved the
wait into the deploy step; settlement `20260914234711` on clean
`6bcd11b35` then attached cold in 3,618 ms, completed every cell and
passed G6 with one C3 object attempt, but refused G2 (the
`chunked-absorption` witness stopped failing), G3 (the cut cell's baseline
witness bytes differed before judging) and G9 (24 of 40 segments priced:
eight post-quiesce segments answered "ask again" at the 6 s window, two
were interrupted by the idle stop, two lost their shell or socket). D18's
four decisions closed those three gates and run `20260915065241` passed
all ten. Earlier controls follow.

The bounded cloud attempt on 2026-09-13 (`b20260913094839`, source
`ad8a2346b`, image digest
`d09be1f3e613173006430cff1b58e5e5d1269dc383fe0404a33f9e3ff8a2d0a0`) was
refused before either changed-file restore. The 64 MiB C3 baseline
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
committed as chunked in 23,610 ms. The edit still uploaded 67,559,424
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
`b20260914045438` on `5d2707ba3` repeated both: three attempts, and a cold
restore that read `running:true, restoration:unstarted` for 55 s. D14 names
the startup cause and its fix, now measured live (`b20260914073654`); D15
names the publication design, landed in `e2cd0eb51` and measured live at
one attempt (`b20260914082622`). O1 therefore remains open as a full
strategy-admission claim.

O2. Storage implementation closed by D7. Deployed latency evidence remains
part of O1; arbitrary service startup remains outside the storage bound.

O3. A corrected candidate under the measurement contract above, if one is
proposed; none is scheduled.
