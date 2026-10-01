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

P6. The container server hands a command's output back by lines, not bytes.
It runs the command with stdout and stderr redirected to files, re-reads each
file with bash `while IFS= read -r line` into one log, and `exec` answers with
the log's lines joined by `\n`. So every NUL byte is dropped, the final newline
is dropped, and an empty line inside the output is kept. A program the
container runs on its own shell, as the image's `sync.js` does, gets bash's
bytes unchanged. Source, read 2026-09-25: the 0.12.9 container server in the
production image (`buildFIFOScript`, `parseLogFile`). Measured 2026-09-25
against that image's own server, run locally (`kinu-devbox-block-layer@sha256:c2c03bdf…`,
`/api/execute`): `printf 'a\0b'` answered `ab`, `printf 'a\nb\n'` answered
`a\nb`, and `printf 'a\n\nb'` answered `a\n\nb`. Production showed it the same
day (Workers Logs, `containers` dataset): the heartbeat's read of a boot id, a
NUL and a running sync's `alive` came back as one 41-character line
(`stdoutLen 41`) on both running boxes (D33).

P7. A container application can refuse a start as over `max_instances`, with
fewer instances running than that, for about a minute and a half after a
sibling instance is destroyed. The refusal reads `Maximum number of running
container instances exceeded. Try again later, or try configuring a higher
value for max_instances`. Measured in Workers Logs on staging's sandbox
(`max_instances` 3), 2026-09-27 and 2026-09-28. In the 30 minutes before each
refusal, one other box's container ran: `fb30af5d…`, granted 15:55:46Z and
destroyed 15:56:33.965Z on 09-27, and `7de7d8f4…`, granted 00:27:24Z and
destroyed 00:28:11.620Z on 09-28. The next box's admission was refused on
every attempt until 73.6 s (09-27) and 73.5 s (09-28) after that destroy.
Its next attempt was granted, and that admission settled 93.8 s and 96.8 s
after the destroy, cold start and restore included. One destroyed sibling
against three slots does not explain the refusal. The Containers docs read
2026-09-28 (FAQ, Limits, Scaling and Routing, Rollouts) say neither what else
counts toward `max_instances` nor how long a destroyed instance holds its
place. Staging now takes production's 10 (D36).

## Decisions

D1. Admission is port-proven. The container-start path proves the control
listener answers before calling the budgeted restore hook. D8 supersedes the
input-block portion of this decision; the listener proof remains required.
Decided 2026-09-09 (`8f9693f6e`, "admit only through startAndWaitForPorts"),
reversed 2026-09-09 (`6707ce6fd`, on the mistaken premise that port 3000 was
an app port), re-decided 2026-09-13 on P3. Status: on main since the
`feat/devbox-gated-restore` merge `408df63f4` (2026-09-13). The five resets
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
2026-09-09 (`edecd1e38`, `7962b3624`) from COST-2026-09-09-chain-publication.md,
which measured whole-delta publication re-uploading unchanged dirty data
quadratically. D2 changes where the delta is consumed, not how it is written. The hand-run
live-record checker `scripts/bench-c3-overwrite-cell.ts` left the tree
2026-09-27; restore from `4ed6396663`.

D5. Snapshot-chain is refused full strategy admission on 2026-09-13.
Settlement run `20260913154111`, clean `a292c7488c`, ran from
15:41:12.703 to 16:02:22.337 UTC and completed the checkpoint ladder, but
failed G3, G6 and G9. It ranks no strategy. Snapshot-chain remains the
shipped implementation; no alternative is shown better under R3.

The source manifest numbers its ten gates G0 to G9, not G1 to G10. These are the
run's recorded verdicts, without combining observations from other runs:

| Gate | Verdict | Deciding evidence |
| --- | --- | --- |
| G0 Provenance | Pass | Clean `a292c7488c`; Worker `25825c2d-1a73-47da-9b15-68e1912c906e`; pinned image digest `3b11f7bf756af01664663f05fd1f3c1721dababc6a4fcf2bfa047d341d9b6a9e` |
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
This was the request-admission gap fixed by D13 (`796b5bab2`), not a stale
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

The G3 command now runs in a subshell (`bd287a516`). Its local POSIX-shell
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
| `20260913161007` | `796b5bab2` | 16:10:09.351 to 16:11:45.088 | Eight admission incidents; no restore or workload |
| `20260913161823` | `bd287a516` | 16:18:25.294 to 16:19:40.525 | Eight admission incidents; no restore or workload |
| `20260913162021` | `bd287a516` | 16:20:22.861 to 16:21:40.113 | Nine admission incidents; no restore or workload |

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

- `kinu-devbox-bench-20260903140046` on `35fee582a` plus driver fix
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

The removal of the alternatives' source on 2026-09-09 (`46c320bc1`) followed
an owner choice to measure C3 and chain publication first, not an owner
finding that the alternatives were defeated. They are recoverable from the
`archive/*` tags named in `docs/BRANCH-ARCHIVE.md`.

D6. The test double models the platform. `FakeSandbox.stop()` and
`destroy()` discard container-local state and keep Durable Object rows and
remote objects; `resetIsolate()` keeps the disk. Decided 2026-09-13 from P1
(`620709a75`). Before this the double kept the disk across a stop, so tests
that passed under it proved reactivation, not restart.

D7. Block-layer design gate. Status: storage half implemented on 2026-09-13.
The conditional design is in [DEVBOX-BLOCK-LAYER.md](DEVBOX-BLOCK-LAYER.md).
Manifest v2 is `e185bb046`; the Rust/fuser lower is `0bdf297c5`; the derived
image is `6a97e34ce`, digest-pinned for both product and bench. The exact
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

D8. SDK input blocks contain storage work only (`25b4cf285`, 2026-09-13). Reversed by D26.
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

D9. Opaque directories are directory records (`e46c7760c`, 2026-09-13).
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

D10. Storage commands run from the runtime directory (`a3f34dc22`,
2026-09-13). In `b20260913132854`, first-base reseat ran with cwd
`/workspace` and unmount failed EBUSY after 2,235 ms. The catch continued;
the next checkpoint found no base files and compared 4,096 upper blocks
against zero base blocks. The corrected control `b20260913141100` reseated
from `/var/tmp/devbox` in 1,575 ms, found the base, matched 4,092 blocks and
published 69,632 bytes. Failed reseats now refuse the checkpoint, even when
the base archive is already durable. A Docker row proves the cwd holder,
reseat, small next delta and exact cold restore.

D11. The block mount type is the measured `fuse` (`e2e84f464`, 2026-09-13).
Cloud trace `b20260913141100` showed that type with every source/generation
comparison true; the old `fuse.devbox-block` assertion alone refused the
valid composition and drove recovery. The pinned image reports `fuse` in
Docker too. Exact base, delta, store and boot-token checks remain. The
conformance corpus is red for a missing mount, wrong type or wrong token,
and green for the measured mount.

D12. A stale startup row cannot reopen a settled running generation
(`2c6f6db18`, 2026-09-13). The SDK can buffer rows that a successful hook
has deleted. The dense trace below showed one such adoption waiting
14,814 ms behind an active writer on the shared exec session. Scheduled
startup now returns when that running generation already has admission;
unsettled generations still use the same coordinator. The active-caller
regression is red before the guard and green after it.

D13. A request in the running-before-hook window joins the generation's
startup coordinator (2026-09-13). Run `20260913154111`, control `a292c7488c`,
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
red of `b20260914045438` is not a regression between `e2e84f464` and
`c45d48cc5`: the same 55-second `running:true, restoration:unstarted`
reading, with one incident undelivered and no heartbeat tick, appears on
`e46c7760c` (both cells of `b20260913131044`) and on `e2e84f464` (the dense
baseline of `b20260913143908`). Its cause was measured on
`b20260914070552` (`7347577db` plus the startup traces of `a6494198a`,
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

Measured live on 2026-09-14 on clean `e34e124c2`, run `b20260914073654`,
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
`0b31e69e3`). H1's design, landed and measured live. `storeObjectUrl(key)` in
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

Measured live on clean `d691264bb`, run `b20260914082622`, `--c3-only`:
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
(2026-09-14). Run `20260914220919` on clean `0415e0f93` reproduced D5's
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
has a provisioned instance (2026-09-14, `c28e0d9a4`). This answers D16's
open question: the 54,540 ms refusal was neither the D14 alarm shape nor a
new admission failure. It was the platform's rollout of a freshly deployed
container application, measured inside the cold attach's own 55 s observer
ceiling.

The mechanism. `wrangler deploy` returns while the application's one
instance is still `scheduling` or `starting`, and every `container.start()`
until it is provisioned answers "There is no container instance that can be
provided to this Durable Object, try again later". `deployFixture`
(`scripts/bench-devbox-fixture.ts`) waited only for the Worker to accept
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

Settlement run `20260914234711`, clean `c28e0d9a4`, D5's exact flags (one
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
| G0 Provenance | Pass | Clean `c28e0d9a4`; Worker `a78f7be4-654b-4302-842d-2d154929d799`; pinned image digest `3b11f7bf…` |
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
`20260915065241`, clean `421c75d69`, D5's exact flags (one `snapshot-chain`
arm, `--decisive`, `--fault-cuts`, seed 20260824, loop budget 8,000 ms, two
repetitions), Worker version `f793cbb1-c6e1-4dd0-9dbd-52f70bf6737a`, ran
from 06:52:42 to 08:19:07 UTC and passed all ten gates;
`admission.admitted` is true. It is the first admitted settlement. Four
decisions, each measured before it, carried the three gates D17 left red:

| Gate | Verdict | Deciding evidence |
| --- | --- | --- |
| G0 Provenance | Pass | Clean `421c75d69`; Worker `f793cbb1-c6e1-4dd0-9dbd-52f70bf6737a`; pinned image digest `3b11f7bf…`; application provisioned 37,794 ms after deploy |
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
(`ddb47d348`). Run `20260914234711` recorded eight decisive segments as
`unobserved execution` on the box's own `A startup is armed, so ask again`,
read after the fixture's 6,000 ms admission window against a box that had
just been quiesced, while `pollForAttach` beside them re-drove the same
refusal. `askWhileStarting` in `scripts/bench-devbox-fixture.ts` is the
one rule: `execInBox`, `writeFileInBox` and the readiness drive ask again
every 250 ms while the reply is the re-askable refusal, until the startup
observation ceiling, and return the box's own last words after it; a
terminal refusal is the answer on the first ask, and a refused write throws
instead of passing as written. `scripts/bench-devbox-ask-again.test.ts` is
red on a tree where either route returns its first refusal. No budget,
ceiling or window changed.

(b) A stop never lands under a caller (`6966047d1`). Run `20260914234711`
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

(c) A witness cell's setup replies are read (`88bfd3b45`). Run
`20260914234711`'s `chunked-absorption` cell wrote its marker through an
exec that was answered "ask again", never read the reply, and judged a
marker nobody wrote: G2's "expected red witness vanished". With (a) the
exec is answered; `ranInBox` ends the cell with the box's own reason if a
setup command did not run to exit 0.

(d) A delta batch's `set -e` stays inside its own subshell (`421c75d69`).
The SDK runs every command of a box in one persistent `bash --norc`
session (`@cloudflare/sandbox` 0.12.8 container server `initialize()`), and
`runOpsBatched`'s top-level `set -e` outlived its batch: from the wake's
delta-namespace batch on, the first failing command from any caller ended
the session with that command's status. G3's read-only probe, a `touch`
meant to fail with EROFS, answered `SessionTerminatedError: Session
'sandbox-default' shell exited (exit code: 1)` in run `20260915012040`,
and D5's G3 recorded the same death on 2026-09-13 as "the read-only probe's
top-level `exit` terminated the persistent SDK shell". The probe's
subshell fix (`bd287a516`) treated the symptom; the `set -e` was the
cause. Measured 2026-09-15 on the pinned image's own container server run
locally: a `set -e` batch then a failing top-level command ends the
session; the same batch inside `( … )` and the session survives. The batch
is now `header, (, set -e, ops, )`; `tests/support/session-shell.ts`
refuses a command whose top-level `set -e` would outlive it as the third
member of its session-death class, so the conformance and chain suites are
red on the old batch text, and `tests/decisions.test.ts` measures both
directions against a real bash fed the way the SDK feeds a session.

The intermediate run `20260915012040` on clean `6966047d1` (with (a), (b)
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
`423af6ffc` the whole restore outran that budget before the parked
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
control is red 3 of 3 on main `423af6ffc`, where the same scenario answers
`[abandoned → replace] Devbox.onStart exceeded its 20ms budget`; main's
original test did not go red under load 13.80 in 3 runs, so the deploy
wave's exact load was not reproduced here and the fix rests on the control,
not on a re-run of the wave. The whole `lifecycle-generation` file passes
3 of 3 (56 tests); the devbox package passes 484 bun tests and 7 workerd
tests; `gate:do-init` is unchanged. No timeout, budget or window was
raised and no test retries.


D20. The hosted workspace runs Nimbus's published hosted runtime, not a
hand-built host (2026-09-21, commits `c0d3c46a1` and `a18e018be` on
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
(4) After (1)-(3) shipped as 7c6d070c1 the eval object `del-gw1zqv` still
reset ten times in ten minutes, each frame 30 s of CPU across activation,
the re-run of the interrupted delegated turn, and its two model calls, with
output tokens in the low thousands per call. What remained was one storage
statement per streamed token: a reasoning model streams tens of thousands.
Deltas now reach the rows in windows of 64 deltas or 4 KB, written ahead of
the part's next non-delta update or by the step's final text (bun:sqlite,
30,000 deltas: 7.2 s and 40,051 rows to 0.85 s and 682 rows; the workerd
gate 256 ms and 297 ms). A cut turn keeps all but its last window.
Pins: `packages/cli-backend/tests/local-session-turns.test.ts` "a streamed answer
mints a revision per step" and `packages/core/tests/unit-session-context-store.test.ts`
"a sealed message is projected once", both red on the old code.
(5) 2026-09-28 (lane/turn-sql): text windows are cut where a tab's replay store
cuts its chunks (`flush-cadence.ts`: the first content event, then every ten, and
each settled tool result), and the `step_partial` run events that re-wrote the
whole cumulative step at that cadence are gone: a turn cut mid-step resumes from
its open output in `stream_parts`. Reasoning keeps the 64-delta or 4 KB window.
Pins: `packages/cli-backend/tests/turn-continuation.test.ts` "A STEP CUT
MID-STREAM" and `packages/core/tests/unit-partial-flush-cadence.test.ts`.
(6) 2026-09-28 (lane/agents-024): no tab replay store is left to agree with. A tab
that reconnects mid-turn is replayed the chunks the chat transport relayed for the
turn in progress, held in its memory and dropped at turn end; after an eviction it
reads the partial from the transcript frame. The answer's one durable copy is
`stream_parts`. The cadence stays: first content, every ten, each settled result.
Pins: `packages/cf-backend/tests/unit-chat-transport.test.ts` "a tab that reconnects
mid-turn".
(7) 2026-09-30 (lane/staging-fix-resume): (6)'s "after an eviction it reads the
partial from the transcript frame" was never measured and does not hold: an open
turn's transcript frame carries its user row alone, since the answer row is written
at the commit (74cc1eea6), measured through the actor harness on 5f49adf4e. The
re-drive streamed under a request id the next activation minted and nothing named,
so the client that sent the turn never heard the rest (F2: staging a4e564ce1, a
12-step turn reset after step 2 failed at its run's end). No replay store returns:
RESUMING names the turn (`turnId`, its opening message's id), a client follows its
turn by that id, and a tab that reconnects before the re-drive opens is told
STREAM_PENDING (the SDK's #1784 frame) and RESUMING once it opens. A tab still sees
the dead activation's steps only from the commit. Pins:
`packages/cf-backend/tests/unit-chat-reopened-turn.test.ts`.

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
empty filesystem, with no genesis, owner or transcript. Kinu makes a
workspace's tables in the constructor, which skips an object whose name starts
with `nbf:` (no workspace name can hold a `:`), and the Agents SDK starts the
`onStart` lifecycle from `fetch`, `alarm` and its own internal RPCs only
(`agents/dist/src-5W6JNKVb.js:459-460` and
`durable-object-lifecycle-D6nNQJJd.js:824-836`), never from a plain RPC method
such as this one.

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
is committed once (2026-09-21, commits 28fa2a5e0 through 02dffa2fe on
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
one streamed text answer, three runs each, median; the base c57832111 read
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
2,000-delta answers (1.37x, bound 3x). 2026-09-26: that wall ratio read 6.8x
in a loaded deploy yet 0.26-1.28x in eight runs at the same tree, so it became
the complexity subject `session store, a long turn after twenty long answers`,
which counts rows and fails on this entry's per-delta rows re-read (n^0.48). Removed: 3 tables (`message_parts`,
`message_updates`, `message_projections`; `stream_parts` added), 7
`*_sequence` columns with their FKs, 4 fork staging columns, 908 source
lines against 544 added across 22 files (`git diff --numstat c57832111
02dffa2fe -- 'packages/*/src/**'`).
Review fixes (commit 3f13ab88a): a streamed answer joins the working
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
Pins: `packages/cli-backend/tests/local-session-turns.test.ts` "a streamed answer
holds one stream row per part while open and none once sealed" and
`packages/core/tests/unit-session-context-store.test.ts` "an open message
reads its accumulated text and a sealed one its content" and "a message left
open by a dead stream seals from what it accumulated at the next admission".

2026-09-28 (`lane/t150-stream`): a live stream seals from the native descriptors
and full text it holds, including replacement provider metadata. Buffered windows
still flush before sealing; D23(5) and the epoch fence are unchanged. The seal
receives the known envelope, and source binding uses the reconciled native parts
instead of materializing the new row. Opening and sealing check their existing
refusals in the write, not in a preceding read. The workerd complexity subject
"orchestrator, a long turn after twenty long answers" measured 534 statements at
`fa8bd6c4ae` and 523 after this change, with 286 rows written in both. Removed:
five message-row reads (two open-parts reads, two seals, one source binding), two
stream-parts reads, and four open-container/part pre-reads. All 51 stream appends
remain; the working-context origin check and abandoned-stream recovery reads
remain. The unchanged workerd chat-session parity fixture passes.
A lone surrogate from a malformed provider stream now seals as streamed, not as bun's replacement characters; valid pairs remain byte-identical.

D25. A wake proves a recycle only after the stop confirms (`b6a6ace00`,
2026-09-04). The 2026-09-04 rerun (`kinu-devbox-bench-20260904142724`) saw
candidate arms wake empty with "candidate control has no published head".
Probe `kinu-devbox-bench-20260904220340` (bounded-layers, tip `7ff3ef80b`)
ran a real recycle: stop 8578 ms, wake 579 store calls in 45917 ms, boot
`fd48f635` then `64b07fe4`, and the publish-time and wake-time control rows
were identical. No write was lost. The cause stays an inference: stops that
never completed were measured as recycles. `requireConfirmedStop` in
`scripts/bench-devbox-strategies.ts` refused a wake after an unconfirmed stop;
it left the tree with D27's comparison instruments.

D26. Restore runs inside the SDK start block again (2026-09-23,
`2a2716881` and `423c294c9`, `@cloudflare/sandbox` 0.12.9). This reverses D8's placement
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
is `6c3b99cfb`'s pair and inside is upstream's containers package with
`6c3b99cfb`'s sandbox patch, both ported onto the 0.12.9 chunk; rotated is
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
run under that contract; none is scheduled (O3). The comparison instruments
were removed on 2026-09-25 by the commit that carries this sentence:
`scripts/bench-devbox-strategies.ts` (driver, arms, frozen controls, decisive
workloads, G0-G9 admission, ranking report), `scripts/fixtures/storage-matrix/`
`admission.ts`, `protocol.ts`, `manifest.ts` and `confirmatory-plan.json`,
`scripts/fixtures/r2-bench/` `decision.ts`, `decisive.ts`, `layouts.ts`,
`probe.ts`, `report.ts` and `security/cells.ts`, and the fixture Worker's G4
security cells and G3 publication cut (`packages/devbox/bench/security-cells.ts`,
`publication-cut.ts`, `publication-bucket.ts`). Reopening the search starts by
restoring them from that commit's parent. The fixture the live drivers share
stays as `scripts/bench-devbox-fixture.ts`.

D28. The Durable Object batches the container calls it keeps (DBX-7,
`527e15417`, 2026-09-23; asked in m712: "combine multiple exec api calls to single ones
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

The SDK-specific census was removed by `37a8d6c10` on 2026-09-30, after
native Container.exec replaced sandbox.exec logging. Restore
`scripts/bench-devbox-exec-census.ts` from `98f64cde610869efc60ff072ff89e866bb5fd116`.

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
together: `block-lower/upstream.json` pins the bundle's sha256 and the image
digest, and `tests/block-image.test.ts` bundles the tree again and fails on
any other bytes, so a change to the sync's code fails until the image is
rebuilt and re-pinned. The flush's own session left the default session's
shell on the work directory: the container server returns a shell to where it
rests after each command given a `cwd`, and keeps only a bare `cd`. So a first base's
reseat inside the container failed EBUSY, D10's defect again (strategies run
`20260923160413`: "reseating it failed: ... failed to unmount /workspace:
Device or resource busy"). The box now parks that shell in the runtime
directory with a bare `cd` for a quiesce's flush, and returns it after.

Deployed, run `w260923160453` (2026-09-23, `e1e2a6b41`, one box, P = 300 s,
5 writes at random offsets into the period): write-to-commit windows 153.9,
194.0, 137.6, 262.8 and 53.5 s; p50 153.9 s, max 262.8 s, each inside
P plus the commit. The box's own wire (commands, replies and sync requests)
was 27,018 bytes for a small write's commit and 29,918 bytes for the commit
that added 67,108,864 bytes to the store: payload bytes stay off the Durable
Object (D29). That run predates D31, so its commits after the first were
deltas; D31 makes them fresh bases until the box's next wake.

D31. A delta is committed only over the base the overlay serves (2026-09-23,
DBX-9). The standalone acceptance run `s20260923160514` deleted a file after
the container's sync had committed the box's first base from a tick. The
stop committed a delta, and the file was back after the wake. The upper is
a delta relative to the lowers the overlay serves, not to the record's base.
A fresh box's overlay serves no base, so its upper still held the file and
deleting it left no whiteout. The old code reseated only a first base
committed by a quiesce, and D30 made the first commit a tick. The same holds
after a collapse: a file created after the old base, captured by the new
one and then deleted leaves no whiteout, and a chunked delta's blocks are
computed against the old base, not the new one.

So while the base the overlay serves (the `fsname` of its `lower-base` mount)
is not the record's, a changed checkpoint archives the merged view as a fresh
base. A base is exact by construction. Recording deletions against the base
instead, with whiteouts for base paths missing from the view, was rejected.
In the common case (a fresh box before its first wake) the upper holds the
whole tree and no base is mounted to diff blocks against, so a delta there
already carries every byte a base does. It would save bytes only after a
collapse while the box keeps running, and it would still need the base's path
list at every tick, plus pruned whiteouts under replaced directories.

Cost: until the box's next wake seats its base, each changed period uploads
the whole tree. For a fresh box that equals what its deltas moved. After a
collapse while running (a legacy layered delta at a tick, or a quiesce rebase
whose stop was refused), it replaces the changes since the old base. The
store holds at most the fallback and the current generation; each commit
sweeps the rest. Tests: the conformance suite deletes a file after a tick
commits the first base, commits by quiesce or by tick, wakes, and expects
the file gone. It was red on `e1e2a6b41` (the file came back) and is green
here. Deployed re-proof: owed on this image.

D32. The dd-style storage arm DBX-8 asks for is not built (2026-09-23): D27
stopped the storage search (owner, DBX-10), and a new design reopens it only
under the measurement contract below. The platform would allow one. In the
deployed container of run `w260923160453` (16:05Z, image `8a2c971c…`) the
process held every capability (`CapEff 000001ffffffffff`), `/dev/loop-control`
and `/dev/loop0` existed, `losetup` and `mkfs.ext4` were present (`fuse2fs`
absent), ext4 was a registered filesystem, and a 64 MiB ext4 image
loop-mounted and unmounted. The same run proved DBX-8's other half. Three
benches started within 61 s on their own Worker, bucket and container
application: strategies `20260923160413`, sync-window `w260923160453` and
standalone `s20260923160514`. Each later start's sweep left the live runs
alone ("run 20260923160413 is still running"). The sync-window and standalone
runs tore down their own resources and passed their cleanup checks. One sweep
misreported: at 16:02Z a start's sweep drained the bucket of the interrupted
run `w260923143440`, logged it deleted and marked the entry done. The bucket,
created 14:34:43Z, was still listed at 21:37Z. It was deleted by hand at
21:39Z and the listing then showed it gone. Why the delete reported success
is not established; the sweep should observe a bucket absent before marking
it done. The account still lists `kinu-devbox-bench-*` resources from
2026-08-31 to 2026-09-11 (9 Workers, 2 container applications, 11 buckets),
created before manifests recorded owners and by none of these runs.

D33. A read through `exec` separates its fields by lines (2026-09-25). The
heartbeat's one container call (D28) read the boot id, a NUL, then the sync's
liveness probe (D30), and split on the NUL. The container server drops NUL
bytes (P6), so on a box whose sync ran, the boot id arrived with `alive`
appended; the box took its container for a replaced one, invalidated its
generation and ran its start hook again. From the first deploy that carried
D30 (2026-09-24 17:13Z) to 2026-09-25 13:12Z, production ran 2,097 start hooks
on 11 boxes. Boxes `deabd3bb…` and `bcac5302…` each ran it 622 times in 10.4
hours, once a minute (median gap 60.0 s). The heartbeat returned before its
quiesce decision, so those containers never stopped: `deabd3bb…` took no
request after 04:15Z and still ran at 13:10Z. The loop did not fence out the
sync's commits, which the box checks against the boot id, not the generation
(`devboxSync`). No test could see it: the harness answered the read with the
NUL intact. It now hands every session command's output back as the server
does (`tests/support/session-shell.ts`, `sessionShellOutput`). The heartbeat
reads one line per field (`# devbox-beat-v1`). The checkpoint gate's probe
misread its mark the same way on a box that drives its own ticks; it now puts
the upper's fingerprint on its first line and the mount table after it
(`# devbox-tick-probe-v2`). Measured 2026-09-25 on the rebuilt image
(`kinu-devbox-block-layer@sha256:d04e2bee…`, sync bundle `1311ddcc…`), through
its own server with its own sync running: the heartbeat's read answered the
boot id and `alive` on two lines, the gate's probe a 64-character mark and then
the mount table, and an unreadable upper an empty first line. Tests: a box
with a running sync starts once and, idle, stops after the policy's idle
window and quiet confirmation, then holds no alarm (`tests/sync.test.ts`). It
was red before the fix (60 start hooks in 120 alarm passes, still running)
and is green after. The gate's probe, run by bash, reads the same mark on the
sync's own shell and through the server (`tests/snapshot-chain.test.ts`); it
was red through the server before the fix. Deployed re-proof owed: start
hooks per wake and idle stops in Workers Logs after the next deploy.

D34. A stopped box arms no heartbeat (2026-09-25). A heartbeat that found the
container stopped wrote a tick and armed the next beat. So every box whose
container stopped other than by a heartbeat's own quiesce (a direct
`quiesce`, a stop under it, an activity expiry) woke its object once a minute
for as long as the object lived, to record that the container was still
stopped. Measured 2026-09-25 in Workers Logs, the hour to 13:10Z: 174 stopped
boxes ran 10,141 heartbeat alarms, while 2 boxes ran containers. Each wake
also shows as a `canceled` alarm delivery a second before the one that runs
the beat, which fits the containers base's constructor moving the alarm a
second out (`scheduleNextAlarm`, containers 0.3.7), as in D14. A stopped container now
ends the chain with one last tick (`running: false`, `armedNext: false`), and
the next start arms it again: every start runs the start hook, which arms the
heartbeat (`#armContainerSchedules`). With no row owed, the SDK deletes the
object's alarm (`container.js:1594-1603`). Tests: a box stopped each of those
three ways, owing three overdue beats, runs what the stop left once, starts
nothing, and holds no row and no alarm (`tests/schedule-chain.test.ts`). It
was red before (a heartbeat row and an alarm remained after 20 passes) and is
green after. Deployed re-proof, 2026-09-26: the 03:38Z deploy carried it.
Production `KinuSandbox` alarm invocations per hour, canceled / ok, were flat
at 11,300-12,500 / 9,500-10,700 from 09-24 06Z to 09-26 02Z over about 185
objects. After the deploy: 03Z 7,900 / 7,149 (the deploy hour), 04Z 0 / 75,
05Z 6 / 136. Query: Workers Observability telemetry, `view: calculations`,
`granularity: 3600000`, filters `$workers.entrypoint = KinuSandbox`,
`$metadata.type = cf-worker-event`, `$workers.eventType = alarm`, grouped by
`$workers.scriptName` and `$workers.outcome`; `scripts/prod-logs.ts` holds
the client.

D35. Container rest follows container use, and rest never kills work
(2026-09-26). The heartbeat asked the owning workspace whether it had
background work every beat. The root answered yes for anything it owed itself:
pending sends, unsettled claims, untimed arms, fibers to re-drive.
warm-forge-4d6acc02's root owed work it could not finish, so its box
(bcac5302…) kept its container running for 30+ hours, measured in Workers Logs
2026-09-25 00Z to 2026-09-26 06Z: 120 alarms an hour, then 60 after D34. Each
beat also woke the root with an RPC.

A box now holds for three reasons, checked in this order:
- Its own lanes are busy.
- A process it started is still running in the container and no supervised
  spec names it. This covers a command an earlier activation left running: a
  detached `npm test` whose caller was evicted is work, and resting would
  kill it. A supervised server does not hold, because the next start restores
  it. A process list that cannot be read holds for one `quietConfirmMs` window
  of beats, counted durably (`devbox:unreadable-process-beats`, reset by a good
  read). An unreadable supervised-spec store counts the same. After that the
  tick records the reason in `note` and the idle gate decides, so a failing
  `/processes` cannot keep a box up forever (Review2, 2026-09-26). The streak's
  start, the give-way and a stop that could not list processes are incidents
  of stage `quiesce`, delivered to the agent like any other stage.
- The root's `sandboxInUse` answers yes: a live turn of any actor, or a job
  this activation's `BackgroundJobRunner` drives, re-drives included. The
  runner, not the row: recovery writes the next attempt's wait before the
  drive starts, so the row reads deferred for the whole drive (Review2,
  2026-09-26).

Owed work is the root's own wake's business. A box that rests is restored by
its next caller. The beat reuses the root's answer for one `quietConfirmMs`
window, so a busy root is asked once per 10 minutes, not 60 times.

Tests:
- `cf-backend/tests/unit-eviction-durability.test.ts`: an admitted send and an
  orphaned job row no longer hold. Red before, green after.
- `devbox/tests/terminal-activity.test.ts`: five beats in one window ask once
  (red at 5). An earlier activation's live command holds, and the box rests
  once the command exits (red: it quiesced). A supervised server does not hold.
  A process list that always throws holds 9 beats, then quiesces with the
  reason in `note` (red: it held for 40 beats).
- `core/tests/unit-background-job-runner.test.ts`: a re-driven job is in
  flight for its whole drive while its row reads deferred.

Deployed re-proof owed, to run after the first promote that carries D35
(production served 2f660875cc on 2026-09-27, which predates it). Pass: every
`KinuSandbox` whose container ran and then stopped being used logs
`sandbox.destroy` within `idleMs + quietConfirmMs` (40 minutes) of its last
`jsrpc` invocation, and no box shows `devbox.alarm.enter` with
`running: true` more than 40 minutes after its last `jsrpc`. The query is
Workers Observability telemetry with `$metadata.service = kinu`,
`$workers.entrypoint = KinuSandbox`, grouped by `$workers.durableObjectId`,
comparing the last `cf-worker-event` of `eventType` `jsrpc` against the first
`sandbox.destroy` after it. Include `bcac5302…` (warm-forge's box, which ran
for 30+ hours on 2026-09-25 and 26) if it still exists.

Staging could not settle this. It ran D35 (build 6a27b7ef54, version
ea064f37) from 2026-09-26 11:54Z to 2026-09-27 03:47Z. Over that window 58
boxes existed, two of them started a container (203d4deb…, 2293879e…), and
both were destroyed by their eval workspace's teardown 4 and 50 seconds after
use. No container was ever left idle, so the idle path never ran. The window
did confirm D34: each stopped box took one heartbeat that armed nothing
(`devbox.schedule.exit` with no `nextSeconds`). There were 81 `KinuSandbox`
alarm invocations in all, and none of the 58 boxes looped.

D36. A destroyed box starts nothing of its own, a refused box says so, and a
box no caller used rests (2026-09-28). Staging's first-run case
`sandbox-mount-write` failed on 2026-09-27 and 2026-09-28 with `this devbox
is not ready: no restoration has run for this container yet`. No call reached
the box before its restoration settled. The platform refused the box a
container on every admission (P7), and each of the case's three tool calls
waited inside those refusals, for 10, 19 and 20 s. Three defects sat in that
chain.

- The caller was told no restoration had run, and the platform's refusal went
  only to the incident ledger. A pending or failed answer now names it (`the
  platform refused this box a container: …`) until an admission is granted.
  The refusal is kept per generation, so a later generation never shows it.
- The case's teardown (`discardState`, then `destroy`) did not stop the box's
  own start. Each refusal had armed a startup row. On 09-28 that row won a
  container at 00:29:48Z, 22 s after the teardown, and the container was
  restored and watched. It still ran hours later, holding one of staging's
  three slots; the 09-27 one ran 3 h 15 min. `destroy` now closes the box.
  Before its first await it sets a closed flag and counts one more teardown.
  It then cancels every start under way and waits for each to settle, deletes
  the startup, heartbeat and checkpoint rows, and only then runs the SDK's
  destroy, which stops whatever such a start launched. Incident delivery
  carries on. While the box is closed, Devbox's `startAndWaitForPorts` refuses
  to start a container and tracks every start it lets through, the start hook
  restores nothing, and the three rows are not armed. A request is judged by
  the teardown count it arrived under: one that arrived before a destroy is
  refused when it reaches readiness, however long it waited for its lane, and
  reopens nothing. `resolveReadiness`, `attachNow`, `kickStartup` and `start`
  reopen the box for a request that arrived after the destroy. In the
  installed SDK (containers 0.3.7, sandbox 0.12.9, source read 2026-09-28),
  `containerFetch` and `startContainerForRPC` start through
  `startAndWaitForPorts`, and a start checks its cancellation only after it
  has launched a stopped container, so one cancelled by a destroy can still
  launch a container before it rejects; that is why the destroy waits before
  its own kill. The tests below model this path in the harness and do not run
  the SDK. The flag and the count live in
  memory. `#replaceContainer` keeps the SDK's destroy: a replaced identity is
  restarted, not closed. The bench drives that destroy a box ask again
  through `/create` or `/wake`.
- A box no caller used never rested: its idle clock fell back to each beat's
  `now`. It now falls back to when its container last started
  (`devbox:started-at`, written as the start hook settles).

Staging's sandbox takes production's `max_instances` of 10 (was 3).

Tests, red before and green after:
- `tests/restoration-visibility.test.ts`: a caller of a refused box learns the
  refusal, then is restored once granted. Red on cbfd32def6: `no restoration
  has run`.
- `tests/lifecycle-generation.test.ts`, each asserting that nothing is running
  and no startup, heartbeat or checkpoint row is left once the teardown and
  the parked work have settled:
  - the box's own start, parked inside the start when the teardown lands,
    also restores nothing (red on cbfd32def6: running, heartbeat armed, one
    restore stamp);
  - a beat parked at the SDK's state read, before the refusal (red on
    f1d4b5bc40: the beat's command restarted the container and the beat
    re-armed itself);
  - a plain `start` and a beat's command, each parked inside the start past
    the refusal (red on 491f9b0f67: running);
  - a file write queued on its path behind another before the teardown is
    refused with `destroyed after this request arrived` (red on 491f9b0f67:
    it reopened the box, started a container and wrote);
  - a startup row delivered after the teardown starts nothing (red on
    cbfd32def6: one start, running, two rows).
  A caller and a host's kick still reopen the box, green before and after.
  The harness's session exec reads its state and starts a stopped container
  through `startAndWaitForPorts`, as the SDK source does.
- `tests/terminal-activity.test.ts`: a box its own startup started rests after
  the idle window. Red on cbfd32def6: still running with its alarm armed after
  120 passes.

Deployed re-proof owed: `sandbox-mount-write` passes on a staging cold start,
and no staging box logs `devbox.alarm.enter` with `running: true` after its
workspace's `sandbox.destroy`.

D37. An untimed command runs on the runtime's own exec, not the SDK's
process lane (2026-09-28). Staging's first-run `background-settle` on
690e3a6040 ran `sleep 45 && echo KINU_SETTLED_AFTER_DETACH`; it exited 0
and the product answered `(no output)`.

The SDK's background mode (`sandbox-container/src/session.ts`, the
`buildFIFOScript` background branch) makes two FIFOs, starts a labeler on
each and then the command, and a monitor deletes the FIFOs once the labelers
are gone. The monitor waits with `wait "$r1" "$r2"`, but the labelers are its
parent's children, so `wait` returns at once (rc 127). The FIFOs can be
deleted before the command opens them. The command then creates a plain file
at the FIFO's path and writes into it, and nothing reads it; the process
record keeps `stdout: ""` for good. Caught in the act on a probe box: a lost
run's `<id>.stdout.pipe` was a regular 18-byte file, the length of its
`MARK_…\n`. The stream's polling read also moves past a half-written last
line, a second, smaller loss.

Probe (`~/kinu-logs/deploy-lane/sandbox-exec-probe/`: both Workers and every
result file; 200 `sleep 1 && echo MARK` at 16 at once per round, six rounds
on one box):

- startProcess, SDK as shipped: 143 of 1,175 final lines lost, 7 to 44 a
  round, rising as the box aged.
- startProcess with the monitor's wait and the read patched in the image:
  13 of 1,195, still rising with age.
- `ctx.container.exec` on the unpatched image: 0 of 1,200, and two
  100,000-line outputs byte-exact.

`Devbox.execUntimed` runs the command under `bash -c` through
`ctx.container.exec` and returns its output whole; `killUntimed` ends its
tree as the SDK's kill did (SIGTERM leaves first, five seconds, then
SIGKILL). The cf-backend untimed lane (`sandbox-exec-lane.ts`) uses them.
The image patch is not carried. Timed `exec`, supervised processes and the
restoration's `#rawExec` still use the SDK.

The first-run case `sandbox-exec-output` runs 600 commands, 32 at once,
through `sandbox.exec` with no deadline. Red on staging 690e3a6040 (595 of
600); the upstream report is `kinu-logs/deploy-lane/sandbox-sdk-issue.md`.

D38. Devbox owns the native container; the SDK supplies files and S3 mounts
(2026-09-29). This replaces D26's patched Sandbox/Containers start owner,
not its rule that restoration excludes callers. The control was the shipped
patched Sandbox 0.12.9 and Containers 0.3.7 on commit `45d4f9e40d`. The
candidate used native `ctx.container`, Sandbox 1.0.0-rc.1, Workers types
5.20260928.1, compatibility date 2026-09-28 and Wrangler 4.143.0.

The deployed D26 control was rerun on 2026-09-28: three runs per pending
condition, a six-second hold inside the start block, and concurrent touch
requests. A command opened the old control connection before reentry. Native
exec has no such connection; its matching condition leaves an outside timer
pending. The three shapes gave:

| Shape | Prior connection / native outside timer | Alarm | Stray outside timer |
| --- | --- | --- | --- |
| Patched 0.12.9, Worker-timer hold | 3/3 completed | 3/3 completed | 3/3 reset at the platform block limit |
| Native exec, native-process hold | 3/3 completed | 3/3 completed | 3/3 completed |
| Native exec, Worker-timer hold | 3/3 reset | 3/3 completed | 3/3 reset |

Native-process holds took 7.006-7.911 s end to end, including admission.
There were no touch deliveries strictly between the recorded hook entry and
exit. Timestamps equal to exit count as released, not as a gate breach.
Worker time froze behind pending timers in the native arm, so its apparent
one-second hook duration is not elapsed time. A separate five-second native
deadline cut a 60-second guest command at 5.03, 5.18 and 5.03 s, measured by
`/proc/uptime`, with an outside timer, an alarm and a stray timer pending.
Each command exited 137. Removing the SDK does not fix Worker timer ordering.
Devbox uses a native sleeper for its restore budget and kills it on cancel.

The Files comparison ran 16 operations concurrently. All 256 4 KiB and all
32 1 MiB create/read/stat/rename/delete cycles were byte-exact in both arms.
Files p50/max was 273/369 ms at 4 KiB and 557/639 ms at 1 MiB; direct native
exec was 219/412 ms and 322/483 ms. Files is not the faster arm. It replaces
our shell/protocol work with the SDK's file API and POSIX error contract.
Commands, PTYs, port forwarding, alarms and inactivity use the native API.
The old control WebSocket, ContainerProxy, SDK transport selector, SDK mocks
and both Cloudflare patches leave the tree.

PID-namespace controls covered the sandbox and Codex images, enabled and
disabled. Enabled exposed the application as PID 1; disabled exposed the VM's
`/sbin/init` and kernel processes. The cutover keeps the namespace enabled.
The native snapshot method existed but refused with "Snapshots are not
available because this container does not support the requested snapshot
operation." The directory-snapshot attempt lost container connectivity.
Neither is a durability fallback. The existing lazy squashfs/block-delta
chain stays. The Ubuntu 24 image includes the SDK shim and s3fs 1.93; its
pinned provenance is `packages/devbox/block-lower/upstream.json`.

Native outbound registration order let an earlier catch-all shadow a later
exact host, and replacing the catch-all still shadowed it. An exact-first
routing table returned the specific response and then its revoked response.
`DevboxOutbound` is that permanent host router: first-party gateway
capabilities first, then host policy. Kinu starts with raw internet disabled
and sends HTTP and HTTPS through its vault; generic Devbox/bench classes
retain public networking. Commands, residents and PTYs receive the documented
Cloudflare CA environment rather than disabling certificate verification.
The deployed PTY proof read cwd /workspace, resized to 37x111, interrupted a
command with exit 130, retained tmux state on reconnect, reset it on request,
and reached Codex through the forwarder (the uncredentialed request returned
its upstream 401). HTTP and WebSocket previews worked through native ports.

S3Mounts' own gateway in 1.0.0-rc.1 has no R2-binding route: active routes
resolve S3 credentials and sign upstream requests; the other mode denies. The
upstream `docs/s3-mounts-design.md:70-72` explicitly declines an
S3-to-R2-binding server. DirectoryBackups accepts a binding but restores whole
tar+zstd archives, not lazy mounts. This entry concluded that each deployment
needs its own bucket-scoped R2 token. D41 reverses that: the key belongs to
the SDK's gateway, not to the mount, and Devbox's own gateway serves the mount
from the binding with no key.

The SDK's payload-transport comparison (`scripts/bench-payload-transports.ts`
and its fixture) and the product durability probe
(`scripts/sandbox-durability-probe.ts` and `scripts/fixtures/kinu-durability/`)
left the tree with this change. Both Workers were built on the SDK `Sandbox`
class it removes, and the durability probe pinned the stock
`cloudflare/sandbox:0.12.8` image, which has lacked the block lower since
2026-09-13, so it could not pass its P1 since then; its P5 (the container
never sleeps) is what D35 reversed. The standalone acceptance and the bench
fixture's lifecycle cover the rest. Restore both from the parent of the commit
that carries this paragraph.

Evidence: `/mnt/scratch/kinu/wt/devbox-native/bench-artifacts/native-migration/`
holds `gate-all.json`, `native-deadline-*.json`, `files-*.json`, the PID
controls and interception observations. The corresponding directory under
`devbox-native-current` holds `terminal-input-smoke.log`,
`quiesce-live.json` and the live marker proof. Final marker deployment:
`kinu-devbox-native-m2609281930`, version
`fcfaadf9-757d-416f-b151-02577a5bfd31`. These are probe deployments, not a
staging product acceptance.

D39. Quiesce releases holders before its final commit (2026-09-29).
D10's first-quiesce reseat is retained, as is D31's requirement that a delta
names the base actually mounted. The defect was order: the first quiesce
published a base, then attempted to reseat /workspace while a supervised
server still held it as cwd. The live stop refused EBUSY after publishing the
base. Removing the reseat would make later warm commits republish the full
base rather than a delta, so that alternative was rejected.

Quiesce now fences new admissions, joins startup, and drains admitted calls,
resource streams and checkpoints without a work deadline. A readable live
unmanaged command refuses the stop. The existing D35 grace still applies to
an unreadable process list: before the quiet-confirm window is spent the
stop refuses; afterwards it records `devbox.quiesce.processes.unreadable`
and a durable incident, and includes the failure in its result. Under D35 an
unobservable detached command can be stopped. Admitted calls still drain.

After that check, quiesce drains and stops the ambient sync, stops resident
processes without deleting their launch records, and releases fd and cwd
holders. The final one-shot flush commits before detach and native destroy.
If it fails, resident processes and ambient sync resume before admissions
reopen. Init runs from /, outside the removable workdir; it and the scan's
ancestor chain are never signalled.

Red proofs: the parked-call regression admitted a later caller; the resident
regression returned a failed commit; the real-image holder scan stopped init
(exit 137); the native unreadable-list regression kept the container running.
A planted inverted unmanaged-command guard made its stop return skipped and
killed the command. Green covers both D35 branches, the named result,
admission draining, byte-exact restore and the resident's restart.

Deployed proof on 2026-09-29: a resident /workspace server no longer prevented
the first stop. The base was 167,776,256 bytes: one multipart create, 33 parts
and one completion. Wake restored the 160 MiB file's SHA-256 and its HTTP
server. A 64 KiB overwrite then published a 4,096-byte chunked delta while
retaining the base id. The later cold wake took 17,034 ms, restored the changed
SHA-256, and served HTTP again. The final stop and discard succeeded.
The final sync-before-holder ordering and D35 exception are covered locally;
the owner-token cutover must rerun this live sequence on the final image.

Tests: `quiesce-order.test.ts`, `terminal-activity.test.ts`, the real-image
`block-image.test.ts`, and the real Linux holder test in
`decisions.test.ts`. Red/green logs are under the native-migration artifact
directories named in D38. This does not change the storage algorithm.

D40. Rebuild reused-mount routing from the SDK's own registration
(2026-09-29). In the deployed rc.1 image, reusing an S3Mounts mount after
owner eviction did not repopulate our replacement routing table. An uncached
lazy read then failed with Input/output error. Direct download and extraction
of the immutable R2 archive still gave the original SHA-256: the object was
intact; its lazy route was missing.

The shim already stores the authoritative registration at
`/run/sandbox/s3-mounts/markers/<sha256(mountPath)>.json`.
`@cloudflare/sandbox` 1.0.0-rc.1's
`crates/sandbox-tools/src/s3_mount/marker_store.rs:100-112` names that path.
Devbox reads this file through Files, checks protocol 1, mount path, source,
access and its exact key prefix, constructs S3Gateway with the current Worker
secrets, and installs the complete mount/static/vault routing table. It
persists no registration mirror. A missing or unknown marker refuses by name
as a permanent configuration error; it never silently replaces the container.
(D47: a missing marker refuses only where something is mounted, and the
refusal is settled once rather than retried.)

Red: the 160 MiB lazy read after explicit owner eviction exited 1. Green:
from a clean mount, eviction followed by route reconstruction returned the
original SHA-256, `f9bafecadaf380ceb4ad3492e168f6227602f94e79aec05dad404e198329aaed`.
A mount whose earlier failed reads had already poisoned its cache was not
used as a green control. Marker tests also refuse another box's prefix,
unknown protocol and an absent marker.

This is deliberate coupling to an SDK-internal file. The unfiled upstream
request, `kinu-logs/devbox/ISSUE-s3mount-registrations.md`, asks for public
registrations or supported rebinding. Delete the direct marker read when
that API ships. The live evidence is `warm-eviction-red.log` and
`warm-read-byte-green.log` under `devbox-native-current`'s artifact directory.

D41. A store mount needs no key pair: the Worker answers its S3 requests
from the R2 binding (2026-09-30). This reverses D38's finding that each
deployment needs a bucket-scoped R2 token. The key was the price of the SDK's
`S3Gateway`, not of the mount. sandbox-shim (1.0.0-rc.1, source at
`dc8a7103`) starts s3fs with a fixed placeholder password,
`sandbox-access-key:sandbox-secret-key`
(`crates/sandbox-tools/src/s3_mount/linux_mount.rs:53`), against
`url=http://s3-<routeId>.sandbox.internal` (`:85`). `S3Mounts.mount` routes
that host to whatever Fetcher its gateway binding returns
(`dist/index.mjs:2406-2417`), through the container's
`interceptOutboundHttp` (workers-types 5.20260928.1, `index.d.ts:3996`).
Only `S3Gateway` resolves a key and signs for R2's S3 endpoint
(`index.mjs:1764-1786`). 0.12.9 had the same shape with a binding behind it
(`r2EgressHandler`), which is why it needed no key.

`DevboxStoreGateway` (`src/store-gateway.ts`) is that gateway for the
binding. S3Mounts receives it instead of `S3Gateway`. The store's source
names the R2 binding as its bucket, with an endpoint and key pair nothing
reads. It serves what s3fs and the publisher send: HEAD, GET with one byte
range, PUT with a declared length, DELETE, ListObjects v1 and v2, and
multipart create, part, complete and abort. It answers 403 for another
bucket, a key or listing outside the route's prefix, another route's host, a
revoked route and a write on a read-only route, and 501 for server-side copy,
aws-chunked bodies and any other query. The bucket, prefix and access come
from the object (S3Mounts' props), never from the guest. The upstream design
note declines this server for the SDK (`docs/s3-mounts-design.md:70-72`); it
lives here because the binding is the application's. It differs from S3 in
three places nothing here uses: no server-side copy (a binding has none, and
the chain never copies), no aws-chunked bodies (s3fs sends none), and no
inspection headers for `S3Mounts.inspect()` (Devbox never calls it).

Measured. Locally on 2026-09-30, s3fs 1.93 from the pinned image, started
with the shim's options, against `serveStore` over Miniflare's R2: the
publisher's 167,776,256-byte base (1 create, 33 parts, 1 complete), the
listing, and a squashfuse read of the 160 MiB file, byte-exact
(`bench-artifacts/native-migration/credential-free/local-s3fs.log`).
Deployed on 2026-09-30 UTC with no secret on the Worker, image
`kinu-devbox-native@sha256:e79fe2d9…`: the standalone acceptance
`s20260930031837` passed start, write, delete, stop, wake, verify and discard,
and cleaned up; the bench fixture runs `sbs09300316n` and `sbs09300321n`
published a 234,885,120-byte base (1 create, 45 parts, 1 complete), read it
back lazily byte-exact on every wake, committed a 64 KiB overwrite as a
69,632-byte chunked delta, and after an owner eviction read an uncached
64 MiB file byte-exact through the rebuilt route (D40). The same runs on the
old shape (`d35c1060fe`, patched 0.12.9) are `s20260930031843`,
`sbs09300316o` and `sbs09300321o`; D43 sets the figures side by side. Red
for the refusals: `tests/store-gateway.test.ts`.

Removed with the key: the `DEVBOX_S3_*` vars and secrets, their
infra-manifest rows, the fixtures' secrets files and the owner's token steps.
The pinned image, `sha256:3378de60…`, is the measured one rebuilt with the
same binaries and a sync bundle that no longer carries the payload-transport
contracts, whose only consumer left with D38's instruments.

D42. Devbox has one failure type of its own, `DevboxError` (2026-09-29).
DBX-9 keeps the package free of product-core imports, and the error model
wants one failure type in the Effect channel, while `KinuError` lives in
core. So devbox owns one type, as Nimbus owns `VfsError`: `DevboxError`, an
Effect `Data.TaggedError` with a `code` (`src/errors.ts`; `effect`
4.0.0-rc.117, pinned exactly). The six Error subclasses
(`ContainerStartOverrun`, `ContainerStartInterrupted`, `ChainRecordAdvanced`,
`ContainerChangedDuringAttach`, `LayerUnreadable`,
`DeltaNamespaceProbeFailed`) are codes.
Failures travel through `attempt` and `attemptSync`; `settle` and
`settleSync` in `src/errors.ts` are the one runner, on a microtask scheduler.
`devboxFailure({ cause })` reads a failure back after Worker RPC has dropped
its class; its tag, code and message survive
(`cf-backend/tests/workerd/error-compatibility.test.ts`). The Files errno
error is the platform's contract, and one function (`fileFault`) puts it in
the failure's cause. `gate:error-model` reads each package's failure type
from one table (`FAILURE_SURFACES`: core `KinuError`, devbox `DevboxError`)
under the same rules, with no exclusion and no raised lock. Kinu turns a
DevboxError into a `KinuError` in one function, `fromDevbox` in
`cf-backend/src/sandbox-exec-lane.ts`.

Measured on the error-model lock: devbox falls from 169 sites to 158
(error-class 6 to 0, throw 102 to 100, catch 51 to 49, promise-rejection 3
to 2). The remaining throws throw `DevboxError` from async functions not yet
moved into the channel; the lock only falls. Red:
`scripts/error-model.test.ts` "a stray throw in the standalone devbox library
is red and cannot grow its lock". `fromDevbox` first classified every failure
it could not read as `unavailable`, a verdict `withSandboxRetry` never
re-enters, so a transport failure on the way to the box stopped being
retried as it was before the cutover. An unread failure is now `io` and keeps
its text. `cf-backend/tests/unit-sandbox-rpc-errors.test.ts` was red (one
call, a refusal) and is green (two calls, the read returned).

D43. Native devbox measured beside the path it replaces (2026-09-30 UTC).
Both shapes ran the same instruments on the same day, each on throwaway
Workers and buckets that were deleted after: the native tree (credential-free
store, image `sha256:e79fe2d9…`) and the old shape, `d35c1060fe` with patched
0.12.9. The side-by-side probe is the bench fixture driven through create,
160 MiB and 64 MiB of random data plus 200 small files, a base checkpoint,
stop, wake, cold and warm reads, a 64 KiB overwrite and delta checkpoint, an
owner eviction with an uncached read, stop, wake and five more stop and wake
cycles (`sbs09300316n`, `sbs09300321n`, `sbs09300316o`, `sbs09300321o`). Every
read on both shapes was byte-exact.

| Measure | Native | Old |
| --- | --- | --- |
| Standalone acceptance | pass, 7 of 7 steps (`s20260930031837`) | pass, 7 of 7 (`s20260930031843`) |
| Base checkpoint, 234,885,120 B | 38.8, 41.1 s; 97 class A, 16 class B | 39.8, 38.5 s; 95 A, 20 B |
| Delta checkpoint | 69,632 B, 1 PUT; 6.5, 8.4 s | 69,632 B, 1 PUT; 11.9, 12.8 s |
| Stop, median of 9 | 2,215 ms (294 to 5,915) | 3,265 ms (1,091 to 4,909) |
| Wake as the caller sees it, median of 9 | 9,636 ms (7,834 to 14,928) | 10,084 ms (9,577 to 11,599) |
| Restore inside the gate, median of 9 | 4,687 ms (3,726 to 8,734) | 3,902 ms (3,306 to 6,018) |
| Cold lazy read, 160 MiB, median of 9 | 33.5 MiB/s (26.0 to 39.4) | 29.3 MiB/s (21.7 to 32.8) |
| Warm read, median of 7 | 925 MiB/s | 216 MiB/s |
| Uncached read after owner eviction | 86.8, 80.9 MiB/s | 54.6, 28.2 MiB/s |

One figure is worse: the store mount inside the restore gate, a median
1,869 ms against 863 ms. An instrumented native run (`sbs09300339n`) put the
extra time between the mount's route install and s3fs's first request
reaching the gateway: 1.3 to 1.6 s in 6 of 7 mounts and 0.2 s in one. The
route install is two RPCs of 5 to 10 ms, the shim's stdin handshake arrives
in under 10 ms, and DNS and a second s3fs start on the same container take 5
to 21 ms (`sbs09300347n`, `sbs09300350n`, `sbs09300356n`). No Worker runs in
the gap; D44 finds it in the platform's first DNS answer, which only a
container with the internet enabled waits for. Every run in this table had
the internet enabled, the bench default; Kinu's containers do not, and D44
compares the two shapes that way. The old shape's mount call also waited
0.8 s for its first request. The caller's wake is not slower because the
native container starts sooner.

D26's check. Its probe is the SDK start block, which the native owner does
not have. The same probe shape on `ctx.container` (2026-09-28,
`devbox-native/bench-artifacts/native-migration/gate-all.json`): in every
run no request ran while the hook held the gate. A hook that holds
on a container process, as `src/native-clock.ts` makes the restore deadline
do, ended 9 of 9 with a connection, alarm or stray timer pending; D26's
rotated arm ended 6 of 9 and reset on all three stray runs. A hook that holds
on a Worker timer still resets behind a stray timer (0 of 3), as D26 found.

The durability canary was not run on either shape. Its steps call `shell`
with the `workspace` runtime (`scripts/canary-script.ts:50`) and nothing in
`cf-backend` starts the devbox unasked, so its three numbers cannot tell the
shapes apart. It also needs a whole product deployment. Its baseline is the
staging run of 2026-09-26 (`kinu-logs/onstart/DESIGN.md`).
D44. D43's slower store mount is the platform's first DNS answer, which
only a container with the internet enabled waits for (2026-09-30). The
bench runs its box with the internet enabled; `KinuSandbox` does not.

With the internet enabled, the gap between the route's registration and
s3fs's first request is name resolution. s3fs's own log on three wakes
(`sbs09300459n`): its first request reaches `url_to_host` 4 ms after s3fs
starts, and curl reports the route host resolved 1,013, 1,033 and 1,051 ms
later; the connection then takes 2 ms. strace of the same lookup at the
instant the shim starts s3fs (`sbs09300506n`): one `sendmmsg` of the A and
AAAA queries, no retransmission, answers after 1,019 and 1,048 ms (11 ms on
one boot of three). Every later lookup takes 4 to 8 ms, fresh names
included. None of it is ours: before that query the container has sent
nothing (`/proc/net/snmp6` all zero), afterwards one neighbour solicitation
went out and one advertisement came back (`sbs09300510n`), and a 100 ms
neighbour retransmit timer changes nothing, 1,031 to 1,058 ms
(`sbs09300515na`). Installing a host route or reinstalling the catch-all
router in a running container leaves the next lookup at 9 to 24 ms
(`sbs09300539nr`); DNS over TCP is not answered (`sbs09300534nc`).

An overlap was tried and not kept. An image that sends one lookup when it
boots moved the wait 0.23 to 0.28 s earlier (`sbs09300515nb`), since the
first query cannot leave before the container boots. Paired runs, 12 wakes
on each image at once, internet enabled: store mount phase median 2,035
against 1,823 ms (`sbs09300543nwbefore`, `sbs09300542nwafter`). Internet
disabled, 8 wakes each: 1,910 against 1,963 ms (`sbs09300552nibefore`,
`sbs09300552niafter`). It buys nothing where Kinu runs. Answering route
hosts from `/etc/hosts` with the platform's interception address
(`fd00::119:1`, `11.9.0.1`) would remove the wait, but no Cloudflare
document names that address; that is not done.

With the internet disabled there is no such wait: the first lookup at the
instant the shim starts s3fs takes 12 to 26 ms (`sbs09300559nidns`), and
s3fs resolves the route host in 3 to 11 ms (`sbs09300603nidbg`). Both shapes
that way at the same time, 8 wakes each (`interceptHttps` too on the old
one, as its `KinuSandbox` set): the store is mounted at a median 2,014 ms
after the restore opens on native against 1,844 ms on the old shape; the
restore takes 6,254 against 5,796 ms; the wake as the caller sees it
10,824 against 10,649 ms (`sbs09300614nknew`, `sbs09300614okold`). A second
native run: 1,922, 6,108 and 9,682 ms (`sbs09300625nkbefore`). By phase
stamp medians, native starts its container sooner (119 against 302 ms) and
takes longer from the boot id to the store mount (1,548 against 1,277 ms)
and from the mount to the base attach (2,217 against 1,846 ms).

Both longer segments come from the SDK's mount. S3Mounts mounts
`bucket:/prefix`, and the shim returns only after s3fs has checked that
prefix: a HEAD, a HEAD of its `_$folder$` twin and a LIST, three store round
trips, 0.27 s (`sbs09300603nidbg`). 0.12.9 mounted the bucket root
(`s3fs BACKUP_BUCKET /backups`) and scoped the prefix in its Worker. And the
SDK always sets `compat_dir` (`RESERVED_S3FS_OPTIONS`, `index.mjs:1872`),
so s3fs looks each directory up with up to four requests during the attach
(`sbs09300609nitl`); 0.12.9's mount did not set it. Rooting the prefix in
`DevboxStoreGateway` lets the mount take the bucket root and drop the three
checks; D46 does it.
The mount also registered its route by reinstalling both catch-alls one
after the other, 168 to 171 ms; installing them together took 174 to
235 ms (`sbs09300634nafix`), so the platform serializes them. D45 removes
the one cost that was Devbox's own.

D45. A container its box started is not unmounted before its first store
mount (2026-09-30). The chain unmounts the store before every mount because
the shim treats a marker with the same configuration as a live mount, so a
marker left by a mount whose s3fs died must go first. A container that
`#startNative` has just started has a new `/run` and no marker, and the
unmount was a shim exec of 108 to 113 ms on every wake (`sbs09300609nitl`).
`ContainerRoutes.started()` records the start; any mount attempt clears the
record, so a remount in the same container still unmounts first. Live, every
wake of a started container skipped it (`sbs09300634nafix`, 5 wakes). Red and
green: `tests/store-mount-bounds.test.ts`, "a container this box started
holds no marker" (`bench-artifacts/native-migration/mount-fix-red.log`,
`-green.log`). Not kept, because measured to buy nothing: installing the two
catch-alls together, above, and setting s3fs's miss cache and a 60 s stat
cache as 0.12.9 did, since s3fs 1.93 enables the miss cache by default and
keeps stat entries 900 s. Medians across runs cannot show a 0.1 s change:
single runs of one image differ by up to 0.8 s in the store mount phase
(1,388 and 2,190 ms, `sbs09300519nafter`, `sbs09300525nafterb`), so the
change is shown by the call it removes.

D46. Each store route is rooted at its box's prefix, and s3fs mounts the
bucket root (2026-09-30). S3Mounts mounted `bucket:/prefix`, and the shim
returned only after s3fs had checked that prefix with three store round trips
(D44). 0.12.9's Worker rooted its mount instead, and so does
`DevboxStoreGateway` now. `ContainerRoutes.#gateway` builds every store
route, S3Mounts' included, with the box's prefix as its root, and the mount
names no key prefix. The gateway prefixes each key the guest names and strips
the root from what it lists. The boundary is where it was: the root comes
from the object, never from the guest, as the prefix did.

A root must end in `/`, since `boxes/box-1` would reach `boxes/box-10/…`
through `0/…`. A key must be a plain path: no leading `/` and no empty, `.` or
`..` segment once percent-decoded. URL parsing resolves literal and
percent-encoded dot segments before the gateway sees the path, so they arrive
as another bucket and are refused. A `/` the guest encodes survives parsing
and the gateway refuses it. A listing's prefix and marker follow the same
rules, and whatever continuation token the guest hands back, only keys under
the root leave. The one non-plain key answered is `/`, the mount root's own
directory object, which s3fs asks for when it mounts: 404, since no key with
an empty segment is ever written. Red then green: `tests/store-gateway.test.ts`
(`bench-artifacts/native-migration/rooted-gateway-red.log`, `-green.log`):
dot segments, encoded slashes and dots, absolute keys, the sibling `box-10`
beside `box-1`, and list, delete and continuation across the boundary.
`tests/mount-route.test.ts` refuses a marker from a prefix mount: its s3fs
sends full keys, which a rooted route would prefix twice, so such a container
is not routed after an eviction. The publisher's URLs, and the image's
`sync.js` that builds them in the container, name keys under the root. The
image is `sha256:649439b5…`, with unchanged binaries.

Measured as D45's pair was, both at once with the internet disabled, 10
wakes each (`sbs09300654npbefore` on `915cfd2d87`, `sbs09300654nrafter`): the
store mount phase median fell from 1,754 ms (1,689 to 2,382) to 1,474 ms
(1,369 to 1,599, one wake at 3,671). The store is mounted 1,587 ms after the
restore opens, against 1,876. Each wake makes 19 to 20 store requests against
21 to 22. The mount's four (the prefix listing, HEADs of the prefix and its
`_$folder$` twin, and a delimited listing) became two: the root listing and
the root's directory object, which that run answered with a 400 and no R2
call (now a 404). The rooted run's store answered slower, HEAD median 136
against 109 ms (each run has its own bucket), which covers its later
segments. Its attach took 2,574 against 2,316 ms over about 14 serial
requests, and its restore 6,526 against 6,374 ms. The wake as the caller sees
it took 10,206 against 10,717 ms.

D47. A warm owner rebinds whatever its container holds, and a start that
fails the same way every time is refused once (2026-09-30, review 3f6).
D46 mounted the store with no key prefix, but D40's marker schema still
required one, and its check then refused any marker that named one. So every
owner evicted over a running container failed to rebind after its first store
mount: `S3Mounts marker registration not understood for /backups`. A box
evicted before its store was ever mounted failed too, on `S3Mounts marker
missing`: its container held no marker because nothing had been mounted. Both
are healthy boxes.

The shim omits an absent prefix (`crates/sandbox-tools/src/s3_mount/model.rs:45`,
`skip_serializing_if`), so the marker's `keyPrefix` is optional and a
marker that names one, from a mount made before D46, is still refused. With
no marker, the SDK's own `S3Mounts.inspect()` says what is at the store path
(`observation.rs:17-47`): `absent`, nothing mounted, leaves nothing to route,
and the chain's next mount registers its own route; anything else, such as
an s3fs mount with no registration (`unmanaged`), is refused by name.

That admission failure was retried each second forever: `#admitExecution`
armed a startup after any failure, so a `mount-marker` refusal, which the
recovery ladder classes `permanent`, filed an incident on every start. The
admission now classifies first, as the ladder does. A terminal class
(`permanent` or `exhausted`, now one predicate, `isTerminalRecovery`) settles
the box unattached with no retry, files one incident, drops the startup row
and ends the pending adoption, so later requests are answered from the
settled refusal; `attachNow()` asks again. Because `mount-marker` is now
terminal, only the container's answers about the marker carry it: a failure
to read the marker file or to inspect the path through the transport stays
`io` and is retried.

Red then green: `tests/mount-route.test.ts`
(`bench-artifacts/review-3f6/marker-rebind-red.log`, `-green.log`). An owner
evicted after a checkpoint (whose mount wrote the marker) and one evicted
before any mount both answer `restored`, with no incident, no destroy and no
second start. The exact marker the shim writes rebinds a route rooted at the
box's prefix. An unknown protocol files `[permanent -> refuse]` once, arms no
startup, and a later request and the platform's alarm file nothing more.

D48. A stop ends a process that ignores TERM, and one claim decides whether a
launch ran (2026-09-30, review 3f6). Two defects in the process scripts
(`src/processes.ts`), which the harness only imitated.

The stop sent TERM to the process group and then waited for the pid with no
end, so a resident that traps TERM held `quiesce()` and `stopSupervised()`
before their holder scan, and admission stayed fenced. 0.12.9's container
(`cloudflare/sandbox:0.12.9`, `/container-server/dist/index.js`,
`Session.killCommand`, the path its `killProcess` took for a default-session
start) sent SIGTERM to the command's whole tree, walking
`/proc/<pid>/task/<pid>/children`, and polled every 50 ms for up to 5 s for
every pid in it to end. It then sent SIGKILL to the tree and to any pid still
standing, polled up to 5 s more, logged a warning if any remained, and
reported success either way (exit 143 or 137). Its sessionless path
(`terminateProcessTree`) signalled the group the same way with a 5 s grace
and a 1 s wait after KILL. The stop now sends TERM to the group, sends KILL to
the group if any member outlives the same 5 s (`TERM_GRACE_MS`, which the
workspace holder scan also uses), and returns when the group has exited. That
end is the process's own, not a deadline: after KILL nothing the group does
delays it, so 0.12.9's second cap, which reported success over survivors, is
not kept. The probe is `kill -s 0 -- -PGID`: dash rejects `kill -0 -- -PGID`
as a usage error (exit 2), which a loop would read as the group being gone.

`start` wrote the record before the exec. An exec that never ran its wrapper
(a missing `cwd` the runtime refuses, or any refusal) left the record with
neither pid nor exit, which reads `starting` forever, so a retry adopted it
and reported a start it never made, and a stop waited forever for its pid.
An exec whose answer is lost after the spawn looks the same from the box,
and its process must be adopted, not started twice (the harness's
`created: true` fault). So one symlink now decides each launch: the wrapper
makes `launch -> launched` before it runs anything, and a caller that finds
no pid and no exit makes `launch -> unlaunched`, after which the wrapper
exits without running. The start claims that way when its exec fails, and so
do a retry and a stop that find a launch nobody answered. A launch that never
ran reads `failed` with no exit code, and a retry launches it again. The
wrapper also enters the `cwd` itself, as 0.12.9's session shell did, so a
missing one is the launch's own recorded failure: exit 1 and `Failed to
change directory to '<cwd>'` in its stderr.

Red then green, in the real image's shell with the SDK's file calls against
its `sandbox-shim` (`tests/processes-image.test.ts`, over `docker exec`;
`bench-artifacts/review-3f6/processes-image-red.log`, `-green.log`). On
integration's scripts the stop of a TERM-trapping resident never returned
(killed by the outer timeout), a missing `cwd` was refused at the exec, and a
refused exec left `starting`. Now the first ends on KILL after the grace
(exit 137), a process that obeys TERM gets no KILL (exit 143), both failed
launches record their failure, each retry launches exactly one process, and
an answer lost after the spawn runs once however the retry finds it.

D49. Three boundary defects from the same review (2026-09-30, review 3f6).

- A reopen waited on a quiesce without taking its arrival, so a destroy that
  landed while it waited (D36) did not fence it: once the quiesce settled,
  `start()` and `attachNow()` launched a container for the torn-down box and
  `kickStartup()` armed one. All three now take their arrival before that
  wait and refuse with `this devbox was destroyed after this request arrived`
  (`tests/lifecycle-generation.test.ts`, red: the request ran and the
  container started or the startup was armed; green: refused, nothing
  started, nothing armed).
- The adapter maps `DevboxError` to `KinuError` (D42), so an aborted exec
  reached core's sandbox executor as `KinuError[cancelled]`, which it did not
  take for a cancellation: the exec tool returned an ordinary `cancelled`
  result instead of rejecting. The executor now propagates anything that
  classifies as `cancelled` (`classifyErrorCode`), the bare `AbortError`
  included (`packages/cf-backend/tests/unit-exec-no-deadline.test.ts`, core's
  executor over the real adapter).
- Core's sandbox file view read with no encoding, which this box answers as
  `Response.text()`, so a binary file came back with its invalid UTF-8
  replaced: a download or a copy of `89 50 00 ff fe` was corrupted. The view
  now asks for base64, the only exact read, and decodes each answer as its
  `encoding` names it. The core test doubles answered base64 whatever
  was asked, which hid this; they now answer as the box does
  (`nativeFileRead`), and the VFS conformance binary round-trip is red on the
  old view. The adapter (`unit-sandbox-rpc-errors.test.ts`) and the box's own
  read (`tests/file-bytes.test.ts`) are each held to the exact bytes. The
  `readFile` tool still returns text for the model: 0.12.9 returned base64 for
  a file it detected as binary, and the native box returns it decoded.

D50. Boxes run on the `durable_object` scheduling policy, each at a size it
records, on Sandbox SDK 1.0 (2026-09-30). The container application no longer
names an image or an instance type: `containers[].images.devbox` names the
image, and every start passes `ctx.container.start({ image, instance, ... })`
at the one start boundary (`#startContainer`), whichever path woke the box: a
request, an alarm, a file call on the `/sandbox` mount, `start()`. The sizes
are one table, `src/sizes.ts`: Small 1 vCPU, 4 GiB; Medium 2 vCPU, 8 GiB;
Large 4 vCPU, 12 GiB; each a 20 GB disk. A box stores the key (`devbox:size`,
absent means the default its host stored with `useDefaultSize(size)`, else
the class's `defaultSize`, Medium) and the size its running container got
(`devbox:running-size`); `boxSize()` and `devboxState()` report both, and
`resize(null)` drops the choice. `resize(size)` is one call: a box that is not
running only records the size, so its first start comes up at it; one
running at another size commits in D39's order and starts again at the new
size, supervised processes and exposed ports come back from their specs, and
a running command ends (`tests/box-size.test.ts`). A resize is the owner's
explicit ask, so it goes ahead over a live unmanaged command, which D35 still
makes a rest refuse. `@cloudflare/sandbox` moves from 1.0.0-rc.1 to 1.0.0:
`S3Mounts` is `S3Mount`, and the shim's mount marker and inspection are
unchanged (`sandbox-tools/src/s3_mount/{marker_store,model,observation}.rs`
at the `@cloudflare/sandbox@1.0.0` tag are byte-identical to rc.1). The
image moves to 1.0.0's shim (`sha256:5db34cc1…`, `block-lower/upstream.json`).

In Kinu the owner's default is the `sandbox_size` config key, set in User
settings under Sandbox, and a workspace chooses its own size on its
Environment card, which applies at once, as `sandbox.resize(size)` does from
codemode. Before a box's first operation in each turn, the runtime hands it
the owner's default through `useDefaultSize`. The codemode declaration of
`resize` and the prompt's sandbox line come from the size table and replace
the stale "2 vCPU, about 6 GB"; a sandbox executor given no table has no
`resize`. The boundary tests: `packages/core/tests/unit-sandbox-resize.test.ts`
and `packages/cf-backend/tests/unit-sandbox-size-settings.test.ts`.

What the policy removes. There is no application-wide rollout, so the
fixtures no longer wait for one (`awaitApplicationRollout`, D5's 38 s), and a
deploy changes the image a box starts next: a running box keeps its image
until it next starts. There is no `max_instances`; running instances count
against the account's limits.

The account's limits, measured with throwaway Workers (2026-09-30): 8 vCPU,
24 GiB and 16 vCPU, 48 GiB are refused, as an instance type at deploy
(`SURPASSED_BASE_LIMITS`, "No more than 4", "No more than 12GiB") and as a
runtime instance at start (`monitor()` rejects about 750 ms in, `Container
exceeds account limits (vcpu: no more than 4; memory_mib: no more than
12288)`). `GET /accounts/{id}/containers/me` says the same: 4 vCPU, 12 GiB and
20 GB per instance. Under this policy memory is hot-plugged: a Large box
reported 6.7 GiB at its first exec and 12.2 GiB a minute later, and an 11 GiB
allocation succeeded.

Platform note: wrangler cannot delete a durable_object application. Its id
is 32 hex digits, which `wrangler containers delete` refuses before any
request ("Expected a container ID but got 12578b1d…", wrangler 4.143.0 and
4.145.0), and the dashed form it accepts answers `APPLICATION_NOT_FOUND`.
`DELETE /accounts/{id}/containers/applications/{id}` deletes it
(`scripts/cloudflare-rest.ts`, used by the fixtures' teardown and the reset).

The wake before and after, the D43 fixture with the internet disabled as
Kinu runs, 9 stop and wake cycles each (`bench-artifacts/side-by-side/`
`policy-a-summary.txt`; runs `sbs09302041npb` on the old shape at
integration `d59a30999`, `sbs09302041npm` and `sbs09302041nps`):

| | default policy, 2 vCPU, 6 GiB, 8 GB | Medium | Small |
| --- | --- | --- | --- |
| Wake as the caller sees it, median | 12,259 ms (11,525 to 12,414) | 4,873 ms (4,597 to 5,125) | 5,695 ms (5,263 to 6,237) |
| Restore inside the gate, median | 6,493 ms | 4,135 ms | 4,333 ms |
| Container start phase, median | 116 ms | 34 ms | 34 ms |
| Store mount phase, median | 1,540 ms | 676 ms | 760 ms |
| Cold read, 160 MiB, median | 32.2 MiB/s | 34.8 MiB/s | 36.6 MiB/s |
| Warm read, median | 829 MiB/s | 982 MiB/s | 1,006 MiB/s |
| Delta checkpoint, 64 KiB overwrite | 7.3 s, 69,632 B | 7.5 s, 69,632 B | 10.9 s, 69,632 B |
| First start of a fresh application | 2,146 ms, after the rollout | 6,159 ms | 6,616 ms |
| Uncached 64 MiB read after the owner's eviction | 91 MiB/s | 73 MiB/s | 61 MiB/s |

Every read was byte-exact, and the evicted owner rebound its running
container (D47) on all three shapes.

One figure is worse: the base checkpoint of 224 MiB. Five fresh boxes per
shape (`bench-artifacts/side-by-side/base-commit-summary.txt`; runs
`sbs09302059ncb`, `ncm`, `ncs` and `ncss`), each committed as soon as its
files were written:

| | default policy | Medium | Small |
| --- | --- | --- | --- |
| Base commit, median of 5 | 39,983 ms (37,849 to 40,747) | 53,232 ms (48,146 to 62,120) | 74,644 ms (62,781 to 77,410) |
| The same pack alone, median of 5 | 8,180 ms | 17,016 ms | 43,391 ms |
| The rest: upload and bookkeeping | 31,803 ms | 37,223 ms | 29,677 ms |

It is not memory hot-plug: every box already reported its whole size when
it committed (8,595,728 kB on Medium, 4,401,424 kB on Small), and five Small
boxes held until their memory had arrived committed in a median 70,010 ms.
It is a real regression, mostly in the pack. Direct probes of the same pack
(`bench-artifacts/snapshot-probe/`: `pack09302111o.json` on a Medium
container, `pack09302111d.json` on the default policy's) found a btrfs root
with transparent zstd:3 compression where the default policy has ext4, 8
processors online of which 2 are allowed, and a single thread about 20%
slower at `zstd -15` (6.4 to 7.2 s for 160 MiB against 5.1 to 6.2 s). The
pack is no faster with `-processors $(nproc)` (`pack09302106.json`) nor
written into a directory with compression off (`chattr +m`, 12.3 to 15.8 s
against 12.5 to 14.3 s, `pack09302116o.json`), so the rest of the doubling was
not explained then. The checkpoint is off the wake path.

Where the time goes, measured the same evening (22:51 to 23:33 UTC).
`bench-artifacts/side-by-side/phases.ts` samples the container every 200 ms
without forking: the VM's CPU jiffies, the whole disks' sectors and busy
time, the network bytes, Dirty and Writeback, and which of the flush's
programs runs. Each interval is charged to the phase its opening sample
names: the pack (`mksquashfs`), the upload (`devbox-publish.mjs`) and the
rest of the flush (the sync's round trips to the box). Base commits of the
same 224 MiB, as written (runs `sbs09302251opb`, `sbs09302257opb2`,
`sbs09302308opub` and `sbs09302316othb` on the default policy;
`sbs09302257npm2`, `sbs09302314npum2`, `sbs09302316nthm` and
`sbs09302327nps1` on Medium):

| | default policy, 7 boxes | Medium, 13 boxes |
| --- | --- | --- |
| Base commit, median | 59.4 s (33.0 to 63.8) | 66.1 s (50.2 to 93.2) |
| Pack | 7.8 s, 14.1 CPU-s | 15.2 s, 29.7 CPU-s |
| Upload, one 5 MiB part at a time | 44.7 s (19.9 to 51.8) | 43.5 s (35.0 to 71.7) |
| Rest of the flush | 4.9 s | 3.9 s |

The pack is where the policies differ, and it is the platform's CPU. It is
CPU-bound on both (its two threads keep the two usable CPUs busy, and no
disk wait runs under it) and does identical work, yet costs 2.1 times the
CPU-seconds on Medium. The same pack with one thread and with two
(`-processors 1` and `2`, runs `sbs09302316othb` and `sbs09302316nthm`): one
thread 12.3 to 13.8 s on the default policy and 18.5 to 29.8 s on Medium,
two threads 5.8 to 6.9 s and 10.4 to 14.9 s. The vCPUs are separate cores
(`core_id` 0 and 1, no siblings) and both policies gain from the second
thread, so a Medium vCPU does about half a default one's work, and it varies
within one box (one thread took 20.2 s, then 29.8 s). The kernel reports
steal under the pack on Medium, 0.7 to 7.6 s (median 1.9 s) against under
0.1 s on the default policy, too little to account for the doubling alone.
The shapes: the default policy's `instance_type`
of 2 vCPU, 6,144 MiB and 8,000 MB, 2 CPUs online, an ext4 root, image
`649439b5…`; Medium on `durable_object`, 2 vCPU, 8,192 MiB and 20,000 MB, 8
CPUs online of which the process may use 2, a btrfs root with zstd:3, image
`5db34cc1…`; both "AMD EPYC". This is recorded for the owner to raise with
the Containers team. Medium's disk is slower too: a `sync` of 226 MiB of
dirty data took 2.5 to 5.9 s there and 0.2 to 1.1 s on the default policy,
and that writeback shows as iowait under the pack and the upload.

The upload was ours. The publisher sent one 5 MiB part at a time, and its
rate moved with the hour on both policies (10 MiB/s at 22:51, 3 to 6 MiB/s by
23:16). The same 224 MiB, synced to disk, through the store gateway with one
to eight parts in flight, median of 3 boxes each:

| Parts in flight | 1 | 2 | 4 | 8 |
| --- | --- | --- | --- | --- |
| default policy | 37.9 s | 26.9 s | 21.5 s | 22.2 s |
| Medium | 39.1 s | 23.6 s | 20.9 s | 20.9 s |

The publisher now keeps four parts in flight (`PUBLISH_PARTS_IN_FLIGHT`;
`tests/publish-script.test.ts`, red on e0dc4195a,
`bench-artifacts/parallel-publish/`). On Medium in the same hour, 3 boxes
each: the base commit took 62.5 s (61.4 to 76.9) with one part in flight
(`sbs09302327nps1`) and 30.6 s (30.6 to 37.8) with four (`sbs09302323npf`,
image `7e0f8359…`); its upload fell from 43.5 s to 17.3 s.

D51. The platform's container snapshots are faster than the chain on every
measure and cannot replace it: a snapshot never follows a new image, and it
expires 30 days after its last restore (2026-09-30). `snapshotContainer()`
and `start({ containerSnapshot })` exist only under D50's policy. Measured on
the D43 fixture with the internet disabled, on a Medium container driven
directly on `ctx.container` by throwaway Workers
(`bench-artifacts/snapshot-probe/`, `drive.ts` to `drive3.ts`; runs
`snap09302043`, `snap09302048b2`, `snap09302053b3`), beside the chain on the
same policy and size (D50's Medium column):

| | chain, Medium | native snapshot, Medium |
| --- | --- | --- |
| Save, 224 MiB base | 55.9 s, 234,885,120 B published | 9.5 s, `size` 235,050,844 |
| Save after a 64 KiB overwrite | 7.5 s, 69,632 B moved | 4.1 s, `size` 65,917 |
| Save with nothing changed | skipped | 4.5 s, `size` 141 |
| Wake as the caller sees it | 4,873 ms, median of 9 | 1,747 ms, median of 5 (937 to 2,565; the first 448) |
| Cold read, 160 MiB | 34.8 MiB/s | 181 MiB/s, median of 5 (83 to 333) |
| Warm read | 982 MiB/s | 1,119 MiB/s |
| Uncached 64 MiB read after the owner's eviction | 875 ms | 670 ms |
| Every read byte-exact | yes | yes |

`size` counts what a save adds over its parent (141 B for an unchanged save),
and a 64 KiB overwrite inside a 160 MiB file adds 65,917 B, so the platform
stores blocks, not files. It does not say what it transfers; a save costs
about 4 s plus about 25 ms per MiB added.

On failure it was sound. A missing or malformed id: `start()` returns and
`monitor()` rejects about 220 ms later with `Snapshot "<id>" was not found.`
A save taken while a writer appended 4 KiB records, each carrying its own
hash: the restore held 43,329 records, every one intact, none torn or zeroed,
a crash-consistent point at the save's start, while the writer went on to
82,880 during the 9.3 s save. `destroy()` 1 s into a save waits for it, and
that snapshot restores whole. An owner evicted 1 s into a save never gets
the id, yet the save completes on the platform: an orphan nobody can list or
delete. A Medium snapshot restores at Large in 0.4 s and at Small in 1.9 s.
With the image's tag deleted from the registry, the restore still works.

Why the chain stays. After the Worker moved to another image, a restore
still ran the snapshot's own image (its shim's hash and `inspect().image`
say so), while a fresh start ran the new image with an empty `/workspace`;
the docs agree ("tied to the Container image version it was created from
and is not portable to a different image"). Every image change would need
each box's files copied out of the old image and into the new one, which is
the chain's job. A snapshot's time-to-live is 30 days from creation or its
last restore and cannot be set, so a box idle for 30 days would lose its
files. There is no delete and no list: an orphan and every superseded save
live out their 30 days. Each save also appears in the account's container
registry, as a `rootfs-set-<hash>` and a `rootfs-snapshot-<hash>` tag under
the image's repository (26 tags for 13 saves), which is the storage the
documented 50 GB per-account image limit governs; the probes' 28 tags were
deleted by hand. A native-only store would have removed about 5,190 lines
(`snapshot-chain.ts`, `chunked-delta.ts`, `delta-index.ts`,
`store-gateway.ts`, `sync.ts`, `sync-main.ts`, `native-archives.ts`, the
block-lower crate) and squashfuse and s3fs from the image. The chain stays
the record of truth.

The hybrid's premise, a snapshot as the wake path in front of the chain,
does not hold on a chain-mounted box (queue item 4, measured the same night
on Medium, run `sbs09302343nhy` with `bench-artifacts/side-by-side/hybrid.ts`:
the bench box's next start restored the snapshot instead of the image, and
Devbox's attach ran over it). A snapshot taken with the chain mounted (s3fs
at `/backups`, squashfuse lowers, fuse-overlayfs at `/workspace`) succeeded
in 5.1 s, left the mounts working, and recorded `size` 176,268,790 B: the
rootfs, whose upper held 168 MiB because fuse-overlayfs copies a whole file
up on a 64 KiB overwrite. The lowers are not in it: they are FUSE views of
objects in R2, and no mount survives a restore. On each wake from the
snapshot the attach mounted the base and the delta from R2 again and emptied
the restored upper (its seed stamp did not match the stored delta; not
traced further), so the wake did the chain's work over a larger rootfs.
Three wakes each way on one box, medians with ranges:

| | chain wake | wake from the snapshot |
| --- | --- | --- |
| Restore inside the gate | 3,366 ms (3,149 to 3,701) | 2,779 ms (2,702 to 3,055) |
| Wake as the driver sees it | 4,030 ms (3,951 to 6,108) | 3,610 ms (3,182 to 4,124) |
| Cold read, 160 MiB | 44.1 MiB/s (39.5 to 52.4) | 49.8 MiB/s (33.6 to 73.3) |

Every read was byte-exact. The snapshot's 0.5 to 2.6 s wakes and 181 MiB/s
cold reads above came from a box whose files were on its own disk. A
chain-mounted box gets them only if its workspace lives on the container's
disk rather than behind FUSE, with the chain packing from that disk: a
different design, which goes to the owner. Nothing of the hybrid is built.

D52. A start that fails the same way every time is refused once, from a
record of what it was made with (2026-09-30). D47 settles a terminal
admission failure and files one incident, but that settled phase held only
while a container ran. A start the platform refuses leaves none running,
such as one for a host that names no image (D50), so every later request,
every startup row a `kickStartup()` or a `devboxState()` poll armed, and
every request after an eviction started the box again and filed another
incident: one start and three asks made four starts and four incidents
(`bench-artifacts/start-refusal/red.log`, on 719c2d1ac).

A terminal refusal of a start this box made is now stored with that start's
inputs (`devbox:start-refused`): the image, the size and the internet
setting, which is everything `ctx.container.start()` receives. While the
container is stopped and those inputs are unchanged, the one start boundary
answers the recorded refusal and starts nothing, `#armStartup` arms nothing,
and nothing is filed; an evicted object's successor reads the same row. A
changed input asks again, as does a caller's explicit ask (`start()`,
`attachNow()`), and an admitted start deletes the row. A terminal refusal
over a container the box found running (D47's marker) is not stored: a later
start gets a fresh container, which can come up clean. `boxSize()` reports
a recorded start refusal (`startRefused`).

A refusal names only actions its reader can take. D47's text told every
reader to call `attachNow()`, which Kinu never exposes, so devbox's terminal
refusal now states the failure and names no action, under its own code
(`refused`), and the host adds its readers' actions. Kinu's adapter maps it to
`unavailable`, which `withSandboxRetry` never re-enters, and tells the agent
to choose another size with `sandbox.resize(...)` or ask the owner. The
owner's try-again is "Start again" on the sandbox's Environment card, shown
only while a start refusal is recorded; it calls `startSandbox`, which runs
the box's one start path and so clears the record. Agents get no retry: a
start with the same inputs fails the same way, and a resize is theirs.

A capacity answer is not terminal. The platform's "There is no container
instance that can be provided to this Durable Object, try again later"
(three times for Medium on the old path, `c-before.log`) is a plain error
with no code, which the ladder classes `unclassified`, so it retries: the
caller gets `pending` with the platform's words, a startup row is armed,
nothing is recorded, and a successor starts the box once the platform has
room (`tests/box-size.test.ts`).

Red then green: `tests/box-size.test.ts`
(`bench-artifacts/start-refusal/red.log`, `green.log`). After one refused
start, two requests, a successor's `kickStartup()` and its request answer the
refusal with one start, one incident and no startup row. An image the host
names later, another size, another internet setting, `attachNow()` and
`start()` each start the box again. The agent's and the owner's words:
`packages/cf-backend/tests/unit-sandbox-size-settings.test.ts`.

D53. Five storage designs on one fixture, and the one to build (2026-10-01).
The owner asked for today's chain beside four designs that keep the
workspace on the container's own disk. Each ran on the D43 fixture (160 MiB
and 64 MiB of random data and 200 small files: a 234,885,120-byte base),
Medium on the `durable_object` policy with the internet disabled, on
integration `8316a55e3` and image `c072f8f5…`, with `434b11d6…` as the
changed image. All five ran at once, each on its own throwaway Worker,
container and bucket, from 03:27 to 03:45Z; every one was deleted after (the
`teardown` field of each record), and the 220 registry tags the snapshots
left (two per save, D51) were deleted by hand.

- A, today's chain mounted lazily: the product on the bench fixture
  (`bench-artifacts/side-by-side/probe.ts` with `designA.ts`; runs
  `sbs10010327nda`, `sbs10010327npa` for five fresh-box base saves,
  `sbs10010336ndai` for the image change, `sbs10010333ndae` and
  `sbs10010353ndafix` for the eviction).
- B to E: a throwaway Worker over `ctx.container`
  (`bench-artifacts/storage-designs/worker.ts`, `drive.ts`, run
  `sd10010327`). B and C wake from the latest `snapshotContainer()`. C and D
  back up with SDK 1.0's `DirectoryBackup`. B and E back up with the chain
  packed from disk (`chain.mjs`: the chain's own mksquashfs base, a delta of
  the 16 KiB blocks that changed, through `DevboxStoreGateway`, four 5 MiB
  parts at once). E′ is E with zstd level 1 and sixteen 16 MiB parts
  (`sd10010327ev`).

A wake is the time from the start to a workspace the box can serve: A's
restore probe (the caller's figure beside it), the first exec after a
snapshot start (B, C), or a fresh start plus the restore (D, E). Medians with
ranges, n=5 unless noted. Every read was byte-exact: 78 checks for B to E
and E′, 13 for A.

| 224 MiB workspace | A chain, lazy | B disk, snapshot, chain | C disk, snapshot, DirectoryBackup | D DirectoryBackup alone | E chain alone |
| --- | --- | --- | --- | --- | --- |
| Wake | 4,343 ms (3,193 to 5,135); caller 5,202 | 2,798 ms (926 to 3,531) | 820 ms (258 to 5,377) | 4,146 ms (1,533 to 5,191) | 3,736 ms (3,280 to 7,482) |
| Wake after an image change | 1,956 ms (1,555 to 2,251, n=6); caller 2,646 | 4,560 ms (2,761 to 5,218) | 2,205 ms (1,718 to 3,939) | 1,401 ms (1,090 to 7,952) | 5,231 ms (4,187 to 6,383) |
| Wake with the snapshot missing | no snapshot | 4,742 ms (3,128 to 8,565) | 3,407 ms (2,247 to 4,845) | no snapshot | no snapshot |
| Cold read, 160 MiB, after a wake | 42.7 MiB/s (35.1 to 55.0) | 114 MiB/s (84 to 216) | 124 MiB/s (107 to 909) | 1,096 MiB/s | 1,111 MiB/s |
| Cold read after a fallback | 69 MiB/s (46 to 84, n=6) | 1,260 MiB/s (n=10) | 1,050 MiB/s (n=10) | 1,060 MiB/s | 1,260 MiB/s |
| Warm read | 1,096 MiB/s | 1,240 MiB/s | 1,356 MiB/s | 1,212 MiB/s | 1,127 MiB/s |
| Small-edit save, n=9 | 4,502 ms; 69,632 to 598,016 B | 5,005 ms: chain 688 ms, 66,883 B; snapshot 4,272 ms, 317,181 B | 7,848 ms: backup 2,708 ms, 234,957,346 B; snapshot 4,254 ms, 66,043 B | 2,430 ms, 234,891,281 B | 657 ms, 66,883 B |
| Base save, 224 MiB | 27,449 ms (25,852 to 31,579): pack 8.1 s, upload 15.3 s | 21,517 ms: chain 13,060 (pack 7.2 s), snapshot 7,691 | 11,766 ms: backup 2,653, snapshot 7,432 | 2,125 ms (2,016 to 5,082) | 11,945 ms (pack 6.2 s); E′ 4,288 ms |
| Stored after 10 saves (a base, 9 edits; one sequence) | 235,483,136 B | 235,967,325 B, and 238,163,075 B of snapshots | 234,891,450 B (2,348,912,551 B kept), and 235,651,046 B of snapshots | 234,891,345 B (2,348,912,276 B kept) | 235,967,325 B |

The snapshot missing: the platform refused the start in 144 to 334 ms
(`Snapshot "<id>" was not found.`), and the R2 copy restored. D's wake is
mostly the container's start (240 to 3,404 ms); its restore took 1,131 to
2,063 ms. A's edit saves grow because its chunked delta carries every edit
since the base. "Kept" is every DirectoryBackup left in place; the first
figure deletes each one the next save supersedes, which
`DirectoryBackup.delete` does. Snapshot bytes are the platform's: no delete,
no list, 30 days from the last restore (D51).

A again with D54, alone, on image `ea5d88ee…` (`sbs10010434ndafull2`, and
`sbs10010433npafix` for five fresh-box base saves): wake 2,046 ms (1,840 to
2,756; caller 2,578), 1,991 ms after a change to `c072f8f5…`, cold read
48.7 MiB/s, small-edit save 5,682 ms (5,380 to 6,315, n=9), base save
22,473 ms (21,324 to 27,477). The read-back D54 adds costs about 1.2 s a
save. A's wake ran 2.0 s alone and 4.3 s beside four other designs, so a
wake moves by 2 s with the hour and the load.

A save interrupted by an eviction 1 s in, five rounds each:

| Design | What the store held after | The next save |
| --- | --- | --- |
| A before D54 | rounds 1 to 4 of `sbs10010327nda` kept the previous state; round 5 named a delta that does not mount, and the box refused every start | in `sbs10010333ndae` it reported the workspace unchanged, and 4 of 5 crashes restored the state before the round |
| A with D54 | 5 of 5 restored the round's new state (`sbs10010353ndafix`, `sbs10010434ndafull2`): the re-driven save waited 17 to 62 s for the evicted object's flush, then found nothing left to save | nothing left to save, 10 of 10 |
| B, E (chain) | the chain's save is a container process: 5 of 5 finished after the object died, and 5 of 5 restored the new state | nothing left to save (E); a new snapshot (B) |
| C, D (DirectoryBackup) | the backup ended with its object and nothing was recorded; 5 of 5 restored the backup before it; each round left one incomplete multipart upload, which R2 aborts after 7 days | worked: D 3.0 to 5.1 s, C 8.0 to 12.0 s |
| B, C (snapshot) | the snapshot's id was lost with the object, 10 of 10; the container ran on, and the previous snapshot woke the box 10 of 10 | |

The 2 GiB workspace (eight 256 MiB random files and 2,000 small files), one
box per design. These are single observations, not settled figures: each
save ran once (n=1), each restore twice, once onto the changed image and once
onto the same one (n=2), A's lazy wake twice, and only the snapshot wakes five
times. D55 repeats them at n≥5.

| 2 GiB | A | B | C | D | E | E′ |
| --- | --- | --- | --- | --- | --- | --- |
| Base save | 197 s | 166 s: chain 143 s (pack 81, upload 56), snapshot 23 s | 58.6 s: backup 11.7 s, snapshot 46.8 s | 13.7 s | 136 s: pack 80, upload 51 | 24.6 s: pack 7.0, upload 11.8 |
| Restore into a fresh container, image changed, then the same image | lazy: wake 2.7 s, the first 256 MiB at 47 to 68 MiB/s, all 2 GiB read in 28 to 53 s | 85.0 s, 83.2 s (download 54, 40; unsquashfs 28, 35) | 18.4 s, 12.0 s | 18.6 s, 11.8 s | 100.1 s, 102.6 s (download 68, 52; unsquashfs 25, 36) | 101.4 s, 52.0 s |
| Snapshot wake, n=5 | | 1,842 ms (1,784 to 1,929) | 278 ms (211 ms to 351 s) | | | |

C's first wake from its 2 GiB snapshot ran its first exec 351,380 ms after
the start; the next four took 211 to 1,951 ms. Of 17 wakes from 2 GiB
snapshots across this run and the two before it (`sd10010138`,
`sd10010155bs`), two took 14.0 s and 351 s. The chain prototype downloads the
whole archive, hashes it and then unpacks it, where DirectoryBackup streams,
so B's and E's restores are not the fastest a chain from disk could reach.

The code each design adds or deletes, estimated from line counts at
`8316a55e3` (nothing was built):

| | A | B | C | D | E |
| --- | --- | --- | --- | --- | --- |
| Deleted | none | about 3,300: the lazy attach in `snapshot-chain.ts` (about 750), `chunked-delta.ts` (744), `delta-index.ts` (113), the chunked stage (about 135), the store-mount routing (about 190), and the block-lower crate (1,362 lines of Rust); squashfuse, fuse-overlayfs and s3fs leave the image | about 5,400: the whole chain (`snapshot-chain.ts` 2,079, `chunked-delta.ts` 744, `delta-index.ts` 113, `store-gateway.ts` 299, `sync.ts` 435, `sync-main.ts` 137, `native-archives.ts` 70), the mount routing and the crate | about 5,400, as C | about 3,300, as B |
| Added | none | about 650: a disk delta and block index, a full restore, the snapshot's record, wake and fallback, and a registry-tag cleanup outside the box | about 450: save, record, delete and restore with DirectoryBackup; the snapshot's record, wake and fallback | about 200 | about 400 |
| Tests | | most of about 9,500 lines of chain tests rewritten | about 10,000 lines deleted, about 800 added | as C | as B |

Recommendation, for the owner: D, DirectoryBackup alone. It is the SDK's own
code and deletes about 5,400 lines and three FUSE programs. On this fixture
its wake is in today's range (4.1 s; A 2.0 to 4.3 s), and then it reads at
disk speed (1,096 against 43 to 49 MiB/s). Its saves take 2.1 to 2.4 s
against 5.7 to 22 s. A new image costs it nothing, and an interrupted save
fails cleanly. Its price is that every save uploads, and every wake
downloads, the whole workspace: 13.7 s (n=1) and 12 to 19 s (n=2) at 2 GiB,
where the chain wakes lazily in 2.7 s and then reads at 47 to 68 MiB/s (n=2). C puts
snapshots in front of D for faster wakes (0.8 s at 224 MiB, 0.2 to 2 s at
2 GiB). With them come saves three times as long (7.8 s against 2.4 s), an
image-bound copy that cannot be listed or deleted and leaves two registry
tags per save against the account's 50 GB image limit, an id lost on
eviction, and one wake of 351 s. B and E keep the chain's code and restore a
2 GiB workspace in 83 to 103 s against D's 12 to 19 s (n=2 each). Nothing is built
until the owner chooses; A stays, with D54.

The owner's answer (2026-10-01): no compromise on performance for big
workspaces, and the whole filesystem kept where possible, not only
`/workspace`, so installed packages and setup survive. That rules D out (it
downloads the whole workspace on every wake) and asks for more than any of
the five; D55 takes it up.

D54. One commit at a time in a container, and a record names only a layer
that reads back (2026-10-01). D53's eviction rounds on today's chain (run
`sbs10010327nda`, integration `8316a55e3`, image `c072f8f5…`) evicted the
object 1 s into a quiesce checkpoint. Its `sync.js flush` ran on in the
container, which outlives the object (D30), and the successor's re-driven
checkpoint started a second flush in the same `/var/tmp/devbox/stage`. In
rounds 1 to 4 the second flush failed on the first's files: mksquashfs found
the other's half-written `layer.sqsh` ("Can't find a SQUASHFS superblock ...
will not overwrite"), or `rm` met a directory the other was filling. In round
5 both published, 216 ms apart (03:32:24.050Z and .266Z). Delta `54b3aa1c`
fails `unsquashfs -l` ("Bad xattr_ids count in super block") though
`unsquashfs -s` passes it. Delta `b7788c09` reads, but holds part of its tree
under `.devbox-delta_1/`: mksquashfs appended to the other flush's file. The
record named `54b3aa1c`, so every later start refused ("squashfuse mount
failed ... The record names no earlier generation to fall back to"), and the
workspace was lost (`bench-artifacts/flush-lock/corrupt-delta.log`). A second
run that let both flushes end (240 s) and then saved again (`sbs10010333ndae`)
lost data with no error: in rounds 2 to 5 that save found the workspace
unchanged, and the crash after it restored the state before the round.

Two causes. Nothing kept two flushes in one container apart. And publication
checked only the landed size, which a torn or interleaved archive keeps.

The fix:
- `sync.js` holds an exclusive `flock` for each checkpoint, so a second flush
  waits. The lock is `/var/tmp/devbox/stage.lock`, beside the stage and not on
  it: each commit deletes the stage, and a lock on a deleted directory
  excludes nobody. `flock` holds it while its stdin is open, so a program
  killed mid-commit releases it. A program that finds another held the lock
  since it last did reads the record again; otherwise it keeps the record it
  remembers, so an idle tick still asks the box nothing.
- mksquashfs runs with `-noappend`.
- Every publication reads the stored object back through the store mount
  with `unsquashfs -l`, which reads every table a mount reads, before the
  record names it.

Why nothing caught it: no test ran two flushes at once.
`tests/concurrent-flush-image.test.ts` runs the image's own `sync.js flush`
twice at once against a box and a store served inside the container
(`tests/support/flush-box.ts`, the shipped `serveSync`). On `8316a55e3` both
cases were red: two flushes overlapped and published two bases (one run) or
the loser failed on the winner's stage with no stamp (others), and a layer
that landed with torn tables was named by the record. After the fix both
pass, 3 runs of 3 (`bench-artifacts/flush-lock/image-red.log`,
`image-green.log`). The strategy machine answers the read-back from its own
squashfs model, which refuses a truncated archive as a mount does.

Live on the new image, the same shape as `sbs10010327nda` (bench fixture,
5 rounds, run `sbs10010353ndafix`): each re-driven checkpoint waited 18 to
62 s for the evicted object's flush to end, read the record that flush wrote,
and found the workspace unchanged. The next save found it unchanged too, and
the crash after each round restored that round's new state, 5 of 5
(`bench-artifacts/flush-lock/live-green.log`).

Image `ea5d88ee…`, sync.js `cf631788…`.

D55. Plan, a hypothesis until built: the whole filesystem in the platform's
snapshot, with a full copy in R2 behind it (2026-10-01). The owner's answer
to D53: no compromise on performance for big workspaces, and the whole
filesystem kept where possible, so installed packages and setup survive.
Measured for this entry on Medium, `durable_object` policy, image
`ea5d88ee…`, internet disabled except for package installs, every Worker,
container, bucket and registry tag deleted after
(`bench-artifacts/storage-designs/d55.ts`; runs `d5510010444`,
`d5510010451sc`, `d5510010504dc`; the chain's `sbs10010452ndab2` and
`sbs10010452ndab10`). The 2 and 10 GiB runs had all twenty boxes running at
once, which loaded the store and is the likely cause of the chain's two
publish timeouts.

What a box changes. The root is a btrfs subvolume on a 20 GB device
(`/dev/vdc[/rootfs] btrfs compress=zstd:3`; 278 MB used at start). A typical
setup (`apt-get install build-essential python3-pip python3-venv`, `npm i -g
typescript`, `pip install requests`, one dotfile) changed 5,519 files
outside `/workspace` by ctime; tar and zstd pack them to 110.5 MB in 1.4 s.
Restored and applied onto a fresh container of the same image, they took
0.8 to 1.6 s plus 2.8 to 3.1 s, and gcc compiled and ran, tsc and `requests`
loaded, the dotfile was there (n=5). Selected by mtime, the same delta was
1,201 files and 16.4 MB and gcc was missing, since dpkg keeps each file's
package mtime. `snapshotContainer()` holds all of it already: it saves the
whole subvolume, and its `size` is the blocks changed since the parent. The
chain cannot serve the root lazily: the root is the platform's mount, not an
overlay the chain owns.

| Medium, n=5 unless noted | 2 GiB | 10 GiB |
| --- | --- | --- |
| Snapshot save, whole filesystem | 18.0 s (17.1 to 19.6) | 91.8 s (68.3 to 96.8) |
| Snapshot save after a 64 KiB edit | 4.1 s at 224 MiB (D51) | 3.3 s, 66,295 B (n=1) |
| Snapshot wake, first after the save | 1,330 ms (322 to 16,141) | 403 ms (276 to 589) |
| Snapshot wake, second | 641 ms (252 to 1,650) | 303 ms (234 to 1,038) |
| First 256 MiB read after a snapshot wake, n=10 | 371 MiB/s (180 to 1,076) | 552 MiB/s (60 to 818) |
| Whole workspace read after a snapshot wake, n=10 | 6.5 s (3.6 to 15.9) | 25.4 s (15.8 to 56.0) |
| DirectoryBackup save | 30.1 s (17.1 to 32.4) | 140 s (100 to 146) |
| DirectoryBackup restore into a fresh container | 12.3 s (11.2 to 14.1) | 79.7 s (72.1 to 122.8, n=4) |
| Whole read right after that restore | 1.9 to 2.3 s | 102 to 155 s, n=4 |
| Today's chain: save | 222 s (200 to 230, n=3); 2 of 5 timed out publishing after 414 s | failed 5 of 5: no space to stage the squashfs |
| Today's chain: lazy wake, n=6 | 2.6 s (2.5 to 3.2); caller 4.1 s | nothing saved to wake |
| Today's chain: first 256 MiB, n=6 | 52 MiB/s (30 to 89) | |
| Today's chain: whole read, n=6 | 39.2 s (23.4 to 60.8) | |

The fifth 10 GiB restore lost its Worker RPC connection at 79 s. The chain
stages the whole base on the container's disk before upload, so a workspace
whose squashfs does not fit in the free disk cannot be saved; random data
does not compress, so 10 GiB on a 20 GB disk fails. That is a defect of
today's product, and it is the same for any design that packs a base on the
disk (D53's B and E). Snapshot wakes at 2 GiB or more over D53 and this
entry: 3 of 40 took over 10 s (14.0, 16.1 and 351 s).

Candidates:

1. Snapshot first, DirectoryBackup behind it. The workspace and the root
   live on the container's disk. A checkpoint is a `snapshotContainer()`. A
   quiesce also writes a DirectoryBackup of `/workspace`, `/root` and
   `/home`, and the root's ctime delta as one tarball. A wake starts the
   latest snapshot; a missing or expired one (refused in 144 to 334 ms,
   D53) restores the backup onto the box's pinned image. Deletes the chain,
   the block-lower crate, the store gateway and the mount routing (about
   5,400 lines; squashfuse, fuse-overlayfs and s3fs leave the image) and
   adds about 700.
2. Snapshot first, a lazy chain behind it for `/workspace`. As 1, but the
   R2 copy is mounted lazily on fallback (2.6 s at 2 GiB instead of 12.3 s).
   It keeps about 3,000 lines and adds about 900, its saves take 200 s or
   more at 2 GiB, and it cannot save 10 GiB.
3. Today's chain plus the root's delta. Adds about 200 lines and no platform
   beta, but every first read runs at about 50 MiB/s and 10 GiB cannot be
   saved.

Images. A start may name any registry digest, not only those in the config:
one no config named started with its own `sync.js` (n=1). A snapshot also
carries its image (D51). So a box keeps the image it was created on, stored
in its record, until its owner upgrades it. An upgrade backs up `/workspace`,
`/root` and `/home`, starts the new image, restores them, and leaves package
installs to the owner's setup, because the root's delta may not match the
new image's libraries. It costs one backup and one restore (12 s at 2 GiB,
80 s at 10 GiB) plus the setup's own time (17 s for the apt step above), and
the registry must keep every digest a box pins.

The record (Durable Object storage): `{ image, snapshot: { id, at },
backup: { record, at } }`. A snapshot's id is stored only after
`snapshotContainer()` returns. An eviction mid-save loses it (D51); the
record keeps the previous id, and the next checkpoint of the running
container saves again. A wake uses the snapshot unless the backup is newer.
A snapshot lasts 30 days from its last restore, so a box idle that long falls
back to the backup its last quiesce wrote. Nothing deletes a snapshot. Each
leaves two registry tags; deleting both left the snapshot restorable 5 s
later (n=1).

Recommendation: candidate 1. On the normal path it is the fastest measured
at both sizes: a 10 GiB box wakes in 0.2 to 1.0 s and reads its first file
at a median 552 MiB/s; at 2 GiB the chain reads it at 52 MiB/s. It keeps packages and home with
no code of ours. It is the only candidate that saves 10 GiB, and it deletes
the most code. Its cost is the fallback, a full download: 12 s at 2 GiB and
80 s at 10 GiB, for a box whose snapshot is gone. Its risks are the
platform's: snapshots are a beta, a few wakes take 14 s to 6 min, and every
save adds registry tags.

Still open: the cause of the slow snapshot wakes; whether the registry tags
count against the account's 50 GB image limit, and whether deleting them
shortens a snapshot's life beyond minutes (a cleanup would need an account
API token in the Worker, which D41 removed); a workspace near the 20 GB disk
and snapshot limit; a root delta after a package removal (deletions are not
in the tarball); the slow whole read after a 10 GiB restore (93 MiB/s against
404 after a snapshot wake, cause not traced); and these figures with fewer
boxes at once.

## Measurement contract for a strategy comparison

Vary stored bytes B, file count N, changed bytes D and demanded bytes Q
separately, on identical committed trees. Capture pre-admission metadata
bytes, CPU work, request count, peak memory and elapsed hook time. A request
count is not a cost. A local workerd clock is not a cloud latency. A run is
admitted only when every G gate passes; a refused run ranks nothing. The
admission code that enforced this left the tree with D27's instruments.

## Open

O1. Closed by D18 on 2026-09-15: settlement `20260915065241` on clean
`421c75d69` passed all ten gates and `admission.admitted` is true. What
follows is the history that led there, kept as written.

Full live acceptance was refused by D5's dated settlement. Witness
registration is complete in `a292c7488c` and both witnesses passed on
deployed Containers and R2. The two measured blockers are now closed: D14's
alarm-starvation fix ran ten `--lifecycle` cycles with zero refusals
(`b20260914073654`) and D15's egress publish is one object attempt live
(`b20260914082622`, `puts: 1`, correctness passed). The post-fix
settlement ran on 2026-09-14 (D16, run `20260914220919`, clean
`0415e0f93`): the cold attach was refused at its 54,540 ms ceiling with
`restoration:unstarted`, no cell ran, and G3, G6 and G9 all scored
Refused for missing measurements. D17 measured that refusal as the fresh
container application's rollout inside the observer ceiling and moved the
wait into the deploy step; settlement `20260914234711` on clean
`c28e0d9a4` then attached cold in 3,618 ms, completed every cell and
passed G6 with one C3 object attempt, but refused G2 (the
`chunked-absorption` witness stopped failing), G3 (the cut cell's baseline
witness bytes differed before judging) and G9 (24 of 40 segments priced:
eight post-quiesce segments answered "ask again" at the 6 s window, two
were interrupted by the idle stop, two lost their shell or socket). D18's
four decisions closed those three gates and run `20260915065241` passed
all ten. Earlier controls follow.

The bounded cloud attempt on 2026-09-13 (`b20260913094839`, source
`7469fadfd`, image digest
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
fixed in `b3666d43b`; its controls are in
`bench-artifacts/block-attach/20260913-publication/`.

The bounded rerun `b20260913114625` on clean `f6a0ee931` attempted C3 and a
2 GiB dense changed file after D8 and the named-fallback/hash-batching fix
`16d1357ec`. Their base checkpoints committed in 13,259 ms (67,112,960 bytes)
and 181,611 ms (2,147,487,744 bytes). Both edited checkpoints then refused
`opaque-directory publication requires an explicit namespace record`, after
1,882 and 61,558 ms. Neither changed-file attach ran. Both attach times,
payload-byte counters and index-page counters are unmeasured, not zero.
The dense writer's size and three range hashes were recorded before its
edited checkpoint. This refusal did not publish a legacy delta.

`b5089313d` fixed the empty delta-key delete that interrupted intermediate
cleanup. Each cell now has its own container identity; startup observation
ends at 55 seconds without changing a runtime budget. Worker, container
application, both boxes, bucket and generated configuration were removed;
the final residue scan counted zero objects and zero multipart uploads.
Raw observations, verdict and receipts are under
`bench-artifacts/block-attach/b20260913114625/` and
`bench-artifacts/teardown/b20260913114625.json`. O1 remains open on opaque
directory support and the unmeasured changed-file restores at that revision.

D9 removed the opaque publication refusal. In `b20260913131044` on clean
`e46c7760c`, C3's base committed in 15,268 ms and its edited checkpoint
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

The storage figures are now observed. Clean `e2e84f464`, run
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
`b20260914045438` on `c45d48cc5` repeated both: three attempts, and a cold
restore that read `running:true, restoration:unstarted` for 55 s. D14 names
the startup cause and its fix, now measured live (`b20260914073654`); D15
names the publication design, landed in `0b31e69e3` and measured live at
one attempt (`b20260914082622`). O1 therefore remains open as a full
strategy-admission claim.

O2. Storage implementation closed by D7. Deployed latency evidence remains
part of O1; arbitrary service startup remains outside the storage bound.

O3. A corrected candidate under the measurement contract above, if one is
proposed; none is scheduled.
