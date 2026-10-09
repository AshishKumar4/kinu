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

P8. The first containers to start from a snapshot all at once wait for the
platform to fetch it; a second wave from the same snapshot does not.
Measured 2026-10-03 (run `vb10030503dm`, `bench-artifacts/h2h/tail.ts`,
`runs/tail.log`), Medium, one 10 GB snapshot per design, 20 boxes started
together, two waves 15 s apart, wake timed to the end of the gate:

| snapshot | first wave, ms | second wave, ms |
|---|---|---|
| the workspace on the root | 12,432 to 60,761, median 46,000 | 351 to 8,890, median 1,400 |
| the workspace in a thin pool on the root | 9,118 to 54,877, median 36,000 | 330 to 1,956, median 610 |

All 80 wakes succeeded. Single wakes from a snapshot measured 0.3 to 2 s
in D64, so the first wave's 9 to 61 s is the fetch, and it lands on every
design that wakes from a snapshot: nothing in a box can shorten it.

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
(8) 2026-10-01 (lane/staging-fix-resume): that last gap is closed, on one path for
every join. Measured through the actor harness on 35c5a634d with the shipped
`useAgentChat`: a tab that redialled into the re-drive drew step 3 alone, and a
tab reloading inside a normal turn was replayed the relay's chunks, never the ledger.
A join's replay now restates from the ledger each finished step it records
(`step_finish` messages, drawn by the transcript's own projection), marked
`restated`, then the relay's chunks of the steps after them. At this revision the
ledger writer consumed the full stream beside the relay's UI stream. A step was
restated only once its row existed and the relay had sent its last chunk. The
relay kept chunks with their step; no chunk store returned. A client skipped a
restated step it held whole and a same-stream step as far as it had read. Following
another activation silently cut its private accumulator at the re-run step; that
did not retract text already emitted to a terminal or ACP client.

(9) 2026-10-01: core announces a text or reasoning step that a restart retracts
before the re-run's first delta. The wire carries transient `data-kinu-step-cut`
with the one-based `stepIndex`; a restart between completed steps emits none.
Web and TUI remove that step's partial output. CLI JSON emits `step_cut`. ACP
keeps its append-only partial, emits one restart notice, then streams the re-run;
plain CLI output uses the notice too, on stderr when stdout is a pipe. Live token
streaming is unchanged. The same replay path serves normal reloads and re-drives,
and an already-open client keeps completed steps rather than resetting them.
The CLI archive and server publish together; the chat wire has no negotiated
version check or compatibility path.
Measured by `unit-chat-reopened-turn`, `cloud-agent-client`, `chat-app` and ACP
suites, and a source CLI smoke with a real dropped socket: JSON emitted one cut
between `tw` and `two`, with final text `one, two`; a pipe kept the model's text on
stdout and the single notice on stderr.

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

2026-10-03 (`lane/providers-one-owner`): one output-slot rule for both producers, `step * 3 + slot` under the
request, and a native step a program cut off seals before the program's own output opens. Before, a native container
took bare slot 0 to 2 and a program's first step the same `step * 3 + slot` under the same request, so a program
continuing after an unfinished native delegation failed its turn on "message identity is already recorded". Pin:
`packages/core/tests/unit-session-stream.test.ts` "a program following an unfinished native delegation retains both
outputs and settles every part".
A lone surrogate from a malformed provider stream now seals as streamed, not as bun's replacement characters; valid pairs remain byte-identical.

2026-10-01: the owner-approved single writer commits a native step's seals,
`tool_call_end` rows and `step_finish` usage and cost in the seal's transaction.
The event consumer writes none of those rows for a native step; a cut
step's collected results belong to its closing seal. Subscribers are notified
after commit, and a rejected ledger write rolls back the seals as well. A re-drive
restores the finished-step count and reported usage without debiting them again.
The SDK's call-local response arrays are joined across fallback and output-limit
calls before the seal and row share them, so a continuation cannot leave an empty
step in the recorded prefix.
The public-completion actor regression on the merged baseline `7d96877b9` lost
step 2's tool and step rows, returned usage `1/1` rather than `3/3`, and kept two
priced rows rather than three. With the single writer, the ledger and timeline
hold all three steps in order and each cost once. A local output-limit turn
previously recorded its second step without text; it now records both halves.
The Workers restart suite checks conversation and per-run step-order invariants;
its old whole-database golden pinned the resumed index reset and was removed,
not re-recorded.

2026-10-02: the native callback hands over one `StepRecord`, including its tool
results and request, before the next model call. Internal `ChatEvent.source`
marks the producer, not a consumer mode switch; scaffold-authored events remain
the consumer's to record even after `defaultInference`. A local promoted
scaffold that delegates, then runs its own tool step, retains both steps and
the tool in order, with the native usage only once. Run-event indices come from
the committed rows, so two recorders sharing a database cannot reuse a cached
index after another writer or a rollback.

The Workers restart check also exposed two model histories: request preparation
classified a failed tool into `error-json`, but its seal kept the SDK's raw
`error-text`. A re-drive had no SDK step metadata to reconstruct the envelope,
lost `reason: missing` and changed the cached prefix. Error feedback now joins
the `StepRecord` before the seal; live requests and re-drives use those recorded
messages. The request-time reclassification is gone. The failed/success/image
regression compares the live and re-driven tool-message bytes, not just the
last answer or the error's words.

Provenance is stamped where each event is produced, without an extra
async-generator hop. The undelayed steering regression receives its nudge on
the fourth request. Logical tool hooks still run from event consumption, so
that timing is not guaranteed for a delayed consumer.

2026-10-03: a native record is finalized on provider failure and an early
consumer return or exception. A completed tool can precede `finish-step`;
tying its record to the consumer lost it on those exits. The consumer-throw
regression failed before this change and passes after it. A real HTTP model
stream and early-return caller retained the completed call once; the local
session also retained a real memory save after its provider disconnected.
Closing a consumer aborts that model call before awaiting its live tee;
provider failures retain their classification, including overflow recovery.

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

Superseded in part by D59 (2026-10-01): a process still running no longer
holds a box on its own, a supervised server no longer rests it silently, and
an unreadable process list never lets the box rest without an answer.

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

D55. The hybrid: platform snapshots are the primary save and wake, and the
chain is the R2 backup, on `cloudflare/debian-trixie` with a golden snapshot
(the owner's design, approved 2026-09-30 in m1889, m1890 and m1902, and
restated 2026-10-02). This is not a contest between snapshots and the chain.
An earlier version of this entry framed it as one, with a bar for replacing
the chain; that framing was wrong and is withdrawn (git history keeps it).

The design:
- Base image. `cloudflare/debian-trixie`, by name: it cannot be pinned by
  digest (run `p5510020813`: `inspect()` reports `cloudflare/debian-trixie`
  with no digest, and the account's registry credentials get 401 on the
  managed image's manifest). D65 records what a roll does to a snapshot. Cloudflare
  distributes and prepares it on eligible hosts before requests arrive
  (blog.cloudflare.com/faster-agent-sandboxes). Our own Ubuntu image
  (`block-lower/Dockerfile`) is downloaded by every new host, and every
  image change makes Cloudflare prepare it again for 12 to 20 minutes
  (D57).
- Golden snapshot. One container starts from the base image and installs
  Kinu's tools by exec: squashfuse, fuse-overlayfs, s3fs, devbox-block-lower,
  sync.js, the sandbox shim, bun, tmux, git and the egress CA trust. It is
  then saved with `snapshotContainer()`, and every new box starts from that
  snapshot. A tool change rebuilds the golden snapshot instead of an image,
  and it is rebuilt before its 30-day life ends. This also removes the
  obstacle that set trixie aside: our binaries could not take it as a
  Docker `FROM` base, but an exec can install them.
- The workspace lives on the container's disk, not behind FUSE. A snapshot
  then captures it whole, and a wake from one serves it at disk speed: on a
  chain-mounted box the snapshot holds only the overlay's upper, and the
  attach redoes the chain's work on every wake (D51's hybrid probe).
- Per-box snapshots are the primary save and wake, for saves in a session
  and for wakes.
- The chain is the backup. It is packed from the disk and written to R2, so
  an image change, an expired snapshot or a lost snapshot id still recovers
  exactly, inside the start gate (R1, R2).

What decides it, measured before building (n>=5 per figure, Medium, the
durable_object policy):
1. Whether `cloudflare/debian-trixie` carries what Devbox's native
   `ctx.container` path needs, and what the golden snapshot must add. Native
   exec runs on it with no shim (first exec 72 ms median, n=4, against
   363 ms on our Ubuntu image, `bench-artifacts/image-start/`); the
   sandbox shim, which `Files` and `S3Mount` use, is not in it.
2. A fresh box's wake from the golden snapshot, 20 boxes at once: the first
   wave after the snapshot is made, and later waves.
3. A per-box snapshot's wake, 20 at once at 10 GiB, with its slow tail. The
   earlier 20-at-once runs had wakes of 14 s, 16 s and 351 s.
4. The long-session row: a dev server running from `/workspace`, a ~500 MB
   install, then 10 small edits, each saved with a snapshot. Reported per
   save: bytes, time, and the pause the box sees; then exactness after a
   wake.
5. How the chain backup is written from the disk without a cumulative delta,
   and how fresh it is when a snapshot is lost.

Already measured, on our Ubuntu image (2026-10-02, run `h5510020546ses2`):
the long-session row for both save paths. With an npm install of next,
react, typescript, eslint, vite and @swc/core in place:
- a snapshot saved each 3 KiB edit in 2.8 s median (2.3 to 3.1, n=10) as
  about 10 KB. The container paused 0.75 s median (0.51 to 0.99) during
  each save, measured as the longest gap of a 50 ms ticker;
- the chain's tick, with its excludes turned off so that it kept every
  path as a snapshot does, republished the whole upper on each edit: 145 MB
  in 10.7 s median (10.2 to 11.1, n=10), with no pause (ticker gap 61 ms).
  D61 explains why: a tick never reseats, because a reseat unmounts
  `/workspace`. With the product's excludes (`CHAIN_EXCLUDES`:
  `node_modules`, `.cache`, `.next`, `dist`, `target`, `.venv`, `*.log` and
  others) an install never enters the chain. Through the real 5-minute sync
  loop on a live box, the install saved as 28,672 bytes and the 10 edits as
  28 to 57 KB each, in 1.1 to 2.2 s (`bench-artifacts/reseat-holders/
  session-live.log`). The cumulative republish remains for what the excludes
  keep, such as a clone's `.git`, its sources and data.
Both woke exact: the chain in 4.2 s, the snapshot in 1.2 s. On a workspace
on the disk there is no upper, so the chain backup needs its own record of
what changed (item 5).

The chain's root delta, for when the whole filesystem must come back from R2
(run `r5510020601b`, n=5 each, through the real Devbox). A setup of
build-essential, python3-pip, typescript and requests changed 5,519 files
(331 MB). Packed as one squashfs, it was 127 MB: 3.8 s to pack and 9.8 s to
upload. Applied after a wake on a fresh container:
- eagerly (unsquashfs onto `/`) in 3.6 s median (3.3 to 5.9), with the first
  use (gcc, tsc, requests) in 0.76 s;
- lazily (squashfuse from the store, one fuse-overlayfs per top-level
  directory) in 1.4 s median (1.2 to 2.1), with the first use in 1.54 s.
Every application worked, and the box had no gcc before it.

Measured on 2026-10-02, on throwaway Workers on Medium, the durable_object
policy (`bench-artifacts/storage-designs/g55.ts`; runs `g5510020614a`,
`g5510020615b`, `g5510020705c` and `g5510020758e`):

1. What trixie carries. Debian 13 with node 24.20.0, apt, `/dev/fuse` and
   the capabilities FUSE needs. Native exec runs on it with no shim, so
   Devbox's `ctx.container` path works as it stands: a first start reached
   its first exec in 115 and 178 ms. It lacks bun, git, tmux, tini, s3fs,
   fuse-overlayfs, the squashfs tools, zstd, curl, python3, the sandbox
   shim and a CA bundle, and `Files` fails without the shim. The golden
   snapshot adds them all:
   - apt installs the Debian packages. Our binaries come in as one 30 MB
     tarball, piped from R2 into an exec's stdin in under 1 s. They are
     block-lower and the shim (both static), squashfuse (glibc and libfuse2,
     which runs on trixie), bun and sync.js.
   - Each build was checked in its own container: squashfuse and
     fuse-overlayfs mount and read, `Files` goes through the shim, and bun
     and node run.
   - A build took 22.1 s median (20.7 to 31.2, n=7), of which apt took
     16.7 s. Its snapshot took 6.3 s and holds 148 MB.
2. Fresh boxes from the golden snapshot, 20 at once. The first wave, made
   six minutes after the snapshot, so most hosts could not have had it,
   reached its first exec in 0.27 s median (0.20 to 0.53, n=20). A wave on
   20 new objects took 0.27 s (0.20 to 0.41, n=20). Every box had its tools,
   and `Files` worked in all 50 of the boxes that started. When the same 20
   objects were destroyed and started again at once, 10 of the 20 starts
   were refused with "Container acquisition rate limits exceeded"; the
   other 10 came up in 1.46 s (0.57 to 2.99). Host placement cannot be
   observed from inside a box, so "a host that has it" is not separable
   from these figures.
3. A per-box snapshot at 10 GiB, 20 boxes at once. Each save took 126 s
   median (96 to 176, n=20) and recorded 10.74 GB. Wakes from those
   snapshots took 1.31 s median (0.20 to 53.0, n=59), with p90 3.1 s.
   - 4 of the 59 wakes took 30.7, 31.8, 52.6 and 53.0 s. One more start
     failed with "Network connection lost".
   - The first 256 MiB read in 0.33 s, and the whole 10 GiB in 16.5 s
     (11.7 to 21.2). All 19 full reads were exact.
4. The long session on the golden snapshot. A node server ran from
   `/workspace/app` throughout, and it answered 200 before and after a
   snapshot. The npm install was 420 MB in 12,132 files. Then came 10 edits
   of 3 KiB each, every one saved with a snapshot; n=40 over four sessions.
   - The install's save took 6.5 to 9.2 s and recorded 366 to 390 MB.
   - Each edit's save took 3.0 s median (2.5 to 3.6) and recorded 10 KB
     (7 to 14 KB).
   - Every save paused the container: the ticker's longest gap was 725 ms
     median (452 to 1,014), and exec answers through the object waited up
     to 700 ms. A dev server cannot answer during that pause.
   - Every wake from the last save was exact, in 0.84 to 1.88 s.
   (The sessions' own liveness check read the exec's shell instead of the
   server and reports it gone; the separate check above is the evidence.)
5. The chain backup packed from the disk (`chain.mjs`). It walks the tree's
   metadata and hashes the 16 KiB blocks of changed files, so each save holds
   only what changed since the last save. The base also carries a block
   index. Measured with a ticker running:

   | Workspace | Base save | Save after a small edit | Save after 100 MiB | Full restore |
   | --- | --- | --- | --- | --- |
   | Clone of vscode with Next.js `node_modules`, 761 MB, 38,832 files | 27.0 s, 261 MB (18.5 s of it the block index) | 1.75 s (1.72 to 1.87), 11 KB | 3.5 s (2.8 to 4.3), 105 MB | 18.6 s (15.6 to 23.5), 3 of 3 exact |
   | 6 GiB of random data | 86.0 s, 6.46 GB | 0.94 s (0.89 to 1.60), 66 KB | 2.9 s (2.4 to 4.6), 105 MB | 114.5 s (93.5 to 154.4), 3 of 3 exact |

   n=5 for each save and n=3 for each restore. No save paused the box:
   the ticker's longest gap was 53 to 59 ms. At 10 GiB the prototype failed,
   because it stages the whole base on the disk; the product's streamed
   base (D57, D58) saves 10 GiB in 219 s on one box.

The second quiesce with a holder the release cannot keep down: through the
product's own loop (run `sbs10020600nsess3`), a respawner whose cwd is `/`
restarted a server in `/workspace` whenever it died. Two stops in a row both
succeeded, in 962 and 488 ms. A rest unmounts nothing: the commit runs, then
the container stops, and that ends every process. Only a first base's
reseat needs `/workspace` unheld (D61).

What the measurements decide:
- Build on `cloudflare/debian-trixie` with the golden snapshot. The image
  needs no shim for native exec, the tools install in about 22 s, and boxes
  start from the snapshot in 0.27 s, 20 at once.
- Per-box snapshots are the primary wake: 1.3 s median at 10 GiB, and the
  whole tree on the disk.
  - The tail must be bounded. 4 of 59 wakes took 30 to 53 s, so a wake
    that has not reached its first exec in 10 s should be cut over to the
    chain's lazy wake (about 4 s at 10 GiB, D57). The worst case is then
    about 15 s.
  - A refused start ("rate limits exceeded") is retried with backoff.
- In-session snapshot saves cost a pause the user can feel, 0.45 to 1.0 s
  per save. Take them when the box is quiet (no exec running, no input),
  and at the rest.
- The chain backup is written from the disk as deltas since its last
  write, with no pause, at every save. That bounds what a lost or expired
  snapshot costs to one save period: a recovery serves the newer of the
  snapshot and the chain, and its notice says to what time it restored.
  The chain excludes `node_modules` and caches, so a recovery from the
  chain alone names the excluded folders that need rebuilding.
- Recovery from the chain stays lazy inside the gate. A full restore took
  18.6 s at 761 MB but 93 to 154 s at 6 GiB, past the 30 s gate (R2). So
  the fallback mounts the base and the deltas from R2 as today's attach
  does, then copies the tree down to the disk in the background.
- The deltas are compacted into a new base at the rest once they outgrow a
  share of it. With the workspace on the disk, that is a repack of the
  disk: no overlay to reseat and no holders to stop.

The registry, measured 2026-10-02 (run `p5510020813`, `l5510020823`,
`l5510020825dep`, `bench-artifacts/storage-designs/`):
- Each snapshot adds two tags, `rootfs-set-*` and `rootfs-snapshot-*`, to a
  `cloudchamber-snapshots/<hash>` repository (or to the image's own repository
  for a snapshot of our image). Both name one manifest with one layer, the
  snapshot's own increment: 67 MB for a 64 MiB base, 4.7 KB after a 3 KB
  edit, 10.5 MB after a 10 MiB write. The manifest's annotations carry
  `snapshot_id` and `parent_snapshot_id`, so snapshots form a lineage from
  the first save.
- Snapshot tags do not count toward the 50 GB image limit. With 574.5 GB of
  snapshot layers (143 snapshots, every one a bench leftover) beside 17.6 GB
  of images, a 1 MiB image push succeeded (`limit-push-1002.log`). The 143
  were then deleted (`registry-snapshots-1002.json` is the record); none
  belonged to a production or staging instance, and no product code
  snapshots. Bench runs delete their own snapshot tags since.
- A child restores exactly after its ancestors' tags are deleted: C1 and C2
  after their base's tags, and C2 after both ancestors', at once, after 30
  minutes and after 90 minutes (n=2 each, all exact). Whether the platform
  keeps an ancestor's data until the child's 30 days end is unknown; a
  sweep therefore deletes only snapshots outside every live lineage until
  that is measured.
- Depth costs little: wakes on fresh objects at lineage depth 1, 10 and 30
  took 0.20, 0.20 and 0.28 s median (n=10 each, all exact; one depth-30 wake
  took 1.7 s). Re-rooting is not needed for wake time.
- Growth between sweeps is the boxes' own saves: each box adds its first
  save (the whole workspace, about 0.4 GB for a fresh npm app) and then each
  save's increment. An eval pass makes 20 to 40 boxes, several passes a day,
  so a daily sweep sees on the order of 10 to 80 GB, none of it against the
  image limit.

Built so far (2026-10-02, `980ee7404`): a hybrid box (`Devbox.hybrid`, off
by default). A rest commits the disk chain (`disk-chain.ts`), then takes a
snapshot; the next wake starts from it unless the chain moved past it or it
is 29 days old. A snapshot start that fails or is not admitted within 10 s
is destroyed and the box starts from the image: the start hook mounts the
chain's layers lazily (O(layers), inside the gate) and records an incident
naming the time it restored to and the excluded folders to rebuild. A
finished copy to the disk becomes the plain workspace at the next start, its
overlay upper merged in. A box the older chain holds keeps its overlay until
the disk chain's first base. Limits as built: a delta holds whole files, so
an in-place write re-sends the file; ticks run from the object (no in-box
sync loop); no snapshot is taken during a session; the golden snapshot and
`cloudflare/debian-trixie` are not yet used. Tests: the real chain in the
image (`disk-chain-image.test.ts`: a base and deltas recover exactly lazily
and then as plain disk, compaction, a baseline mismatch) and the box with a
model chain (`hybrid.test.ts`, red on the box before it, then green).

D56. The box decides its own rest from its own use; the workspace neither
asks nor tells it (2026-10-01, corrected the same day). This replaces D35's
third hold reason, the root's `sandboxInUse`, and keeps the other two. While a
box ran, every beat with no work of its own asked the workspace whether it was
busy. The answer was kept for one quiet-confirm window, but only in the box
object's memory, so a box object that restarted asked again. On staging
(`f62dfcb9`, eval-site-preview-5, 01:00 to 02:47Z) each ask rebuilt the idle
workspace once a minute, and its runtime read the owner's device status as it
did.

Two causes. The rule asked across objects on every beat. And nothing counted
the box's calls to its host beat by beat, so a cache that lived in one
object's memory passed every test that kept one object. On the old shape, a
running box used a minute before each beat, with a fresh box object per beat,
asked its idle workspace 5 times in 5 beats (`bench-artifacts/host-push/red.log`).

The first fix (`fe1a920dc`, `f521bd212`) turned the ask into a push: the
workspace called `Devbox.noteHostWork()` whenever a turn's claim moved and
when a background job settled, so a turn kept its box alive. The owner
corrected it: a turn that does not touch the sandbox must not keep the box
alive, and the sandbox stays lazily provisioned. So the push is gone too:
`noteHostWork`, the workspace's turn-claim and job-settle notices,
`sandboxUsed` and the runtime's `sandboxReached`. With them went
`hasBackgroundWork`, its in-memory answer, the workspace's `sandboxInUse` RPC
and W2's startless exception. The box rests on its own use only: commands,
files, the terminal, ports, previews, and its own lanes. A process still
running in it does not decide alone: the box asks its agent first (D59).

What changes: a box rests `idleMs + quietConfirmMs` (40 min) after its own
last use, whatever its workspace is doing. A turn that runs longer than that
between sandbox calls loses nothing: its next call wakes the box.

Tests. `cf-backend/tests/unit-eviction-durability.test.ts` ("a workspace's
turns are not its box's use") runs ten turns in a workspace that never reached
its sandbox and ten after it did, and counts every call on any box: 0 and 0.
On `f521bd212` the second case made 22
(`bench-artifacts/host-push/reversal-red.log`, `reversal-green.log`).
`devbox/tests/terminal-activity.test.ts` ("only the box's own use holds it")
holds a box last used a minute ago through its idle window and rests it once
the quiet is confirmed. Deployed re-proof owed: no call from a workspace to
its box in Workers Logs while turns run, and boxes resting 40 minutes after
their own last use.

D57. The chain streams every layer to the store as mksquashfs builds it, so
a base larger than the free disk saves (2026-10-01). The defect: a layer was
built whole on the disk, and when the disk could not hold it, in tmpfs. The
platform's tmpfs is 64 MiB (D55), so on a Medium box (a 20 GB disk) any
workspace whose squashfs did not fit in the free disk could not be saved at
all. On image `ea5d88ee…`, a box with 10 GiB of random data failed 5 of 5
saves with `No space left on device`, 13 to 15 s in, and kept nothing
(`bench-artifacts/stream-base/live-red.log`). It had failed the same way on
`c072f8f5…` in D55's runs.

The change (`stream-archive.ts`, called by `snapshot-chain.ts`):
- `sync.js` runs mksquashfs into a sparse file and uploads each 5 MiB part
  once the archive has grown past it. After the store answers, it re-reads
  the part, checks it did not change, and punches it out of the disk.
- mksquashfs writes its output in order and returns once, for the 96-byte
  superblock at offset 0. strace on 4.7.5 showed no other backward write,
  with or without duplicate files. So the first part is held and uploads
  last.
- When more than the window (64 MiB) waits on the disk, mksquashfs is
  stopped until uploads free it. It runs under `nice`, so the uploader keeps
  its turn to stop it. Freeing a part waits for its pages to be written, so
  the bound is soft: on an ext4 test host the archive briefly held 203 MB
  against a 40 MiB window.
- A disk that cannot hold twice the window streams through tmpfs, with a
  16 MiB window.
- Parts in flight and part size are unchanged (four, 5 MiB, D50).

Before the record names the layer:
- The store's own digest of every part must equal the digest of the bytes
  sent. R2 answers each part with its MD5, and a completed object with the
  MD5 of those followed by `-<parts>`; this was checked live in run
  `m5510011512et`.
- After mksquashfs exits, no punched range may hold data again, which would
  mean a write after the upload.
- The store's HEAD must report the size sent and the composite digest.
- D54's `unsquashfs -l` read-back through the store mount must succeed.
Any failure aborts the multipart upload and records nothing.

The small path is faster, not slower, because packing and uploading now
overlap. A 224 MiB base saved in 29.2 to 30.6 s on `ea5d88ee…` (median
30.0 s). On the new image it took 22.5 to 26.4 s and 23.6 to 25.7 s in two
runs (medians 25.4 and 24.6 s). Each run was n=5 on fresh Medium boxes in
the same hour (`bench-artifacts/stream-base/small-*.log`).

A large base is now bound by mksquashfs. At its default zstd level on random
data it ran on about two cores: one box streamed 2 GiB from plain disk in
about 110 s. Five 10 GiB boxes at once, packing through fuse-overlayfs,
streamed about 4 MiB/s each. D53's E′ variant (zstd level 1, sixteen 16 MiB
parts) saved 2 GiB in 24.6 s; that tuning is the next change, with its own
measurement.

Tests:
- `stream-script.test.ts` runs the shipped script with the real mksquashfs
  against an R2-like store:
  - a 288 MiB archive lands exactly as a direct mksquashfs makes it, with
    several parts in flight and never more than half of it on the disk;
  - a small archive is one PUT;
  - a part the store holds as other bytes is refused, and the upload aborted;
  - an archiver that writes into a part already uploaded is refused;
  - mksquashfs failing exits 4.
- Strategy cell 6.25 (`strategy-conformance.test.ts`, a base larger than the
  free disk commits and wakes exact) is red against the old code, which
  failed the save and woke empty
  (`bench-artifacts/stream-base/model-red.log`), and passes now
  (`model-green.log`). The model's tmpfs now holds 64 MiB, as the platform's
  does; it was unbounded.
- The concurrent-flush image test's store answers with R2's digests.
- devbox suite: 523 pass.

Image `a41e4a11…`, sync.js `fc469296…`. The small-path runs used `6bea205d…`,
whose script is the same, before the publisher moved into its own module.

Live on `a41e4a11…`, the same 10 GiB fixture saved and woke exactly, 3 of 3:
- One box alone (`sbs10011701nsg3`): the quiesce committed 10,737,442,816
  bytes in 893 s. The wake took 4.4 s at the driver, with 1.9 s attaching the
  base. The first 256 MiB read in 4.7 s, and the whole workspace in 209 s.
- Five boxes at once (`sbs10011738nsg5b`): box 1 committed in 893 s and woke
  twice, in 5.2 and 10.0 s, reading everything in 238 and 195 s.
For most of each save, mksquashfs sat stopped by the window: the upload was
the bound, about 13 MiB/s per box with four 5 MiB parts in flight.

The other four boxes reported "skipped: nothing has been written since the
attach", and their records still named their 10 GiB bases. The trace (ps,
the stage and the box's state every 30 s) shows why:
- The bench drives the quiesce from an alarm. The platform cut the alarm
  handler at 900 s and delivered it again.
- The second delivery started a second flush at exactly 900 s on each of
  those boxes. It waited on D54's lock until the first had committed and
  reseated the upper, then truthfully found the upper empty.
So a quiesce flush longer than 15 minutes is delivered twice. D54's lock
makes that safe, but the answer was wrong: it said "skipped" for a workspace
the first flush had just made durable.

The fix: the lock file holds one small record, the last holder's token and
outcome, overwritten by every flush. A flush that had to wait for the lock,
and then finds nothing to save, reports the commit it waited behind: kind
`committed`, the record's durable bytes, `movedBytes` 0, and a reason naming
the flush ahead of it. `afterWaiting` in `sync.ts`; the test in `sync.test.ts`
was red before it (`bench-artifacts/stream-base/waited-red.log`). The
real-image test checks that the lock stays one file under 2 KiB. Image
`648726e8…`, sync.js `22c7f1af…`.

Platform time on a new image: the first deploy of `a41e4a11…` polled
`containers/image-preparations` 296 times in 12 minutes (16:48:55 to
17:00:43Z) before it was stopped. The retry polled 179 times in 7 minutes
(17:01:49 to 17:08:49Z), then deployed. That is about 20 minutes, which any
deploy of a new image may pay.

D58. A chain layer packs at zstd level 1 and uploads sixteen 16 MiB parts at
once (2026-10-01). D57 left a large base bound by its upload: about 13 MiB/s a
box, with four 5 MiB parts in flight. That put a 10 GiB save near or past the
platform's 900 s alarm cut, and a flush past it is delivered twice. D53's E′
shape (zstd level 1, sixteen 16 MiB parts) saved a 224 MiB base in 4.3 s,
against 11.9 s for E.

The change (`stream-archive.ts`):
- mksquashfs packs at `-Xcompression-level 1`. Its zstd default is level 15
  (mksquashfs 4.6.1 in the image).
- A layer staged on disk streams as 16 MiB parts, 16 in flight, with a
  512 MiB window. So the disk path now needs up to 1 GiB free, twice the
  window; with less, the layer streams through tmpfs.
- A layer staged on the platform's 64 MiB tmpfs keeps 5 MiB parts, R2's
  least, two in flight, in a 16 MiB window.

Before and after ran on the same fixtures, all but one sample in the same
hours: Medium boxes, random data, internet off, the durable_object policy. The
images were
`648726e8…` (sync.js `22c7f1af…`) and `daefe832…` (sync.js `2171d5f4…`),
pinned through `BENCH_IMAGE_DIGEST`. Each figure is the median (range, n) of
the save's time at the driver. "Five at once" means five boxes saving
together. The two lanes ran side by side, so up to ten boxes saved at once.

| Base save | Before | After | Per box, before → after |
|---|---|---|---|
| 224 MiB, one box | 24.7 s (23.3 to 29.2, n=5) | 16.4 s (15.0 to 18.4, n=5) | 9 → 14 MiB/s |
| 2 GiB, one box | 193.8 s (173.7 to 208.7, n=5) | 52.9 s (42.9 to 53.0, n=5) | 11 → 39 MiB/s |
| 2 GiB, five at once | 158.9 s (153.5 to 198.7, n=5) | 133.5 s (53.0 to 143.5, n=5) | 13 → 15 MiB/s |
| 10 GiB, one box | 974.3 s (751.6 to 989.7, n=5) | 219.1 s (173.8 to 234.1, n=5) | 11 → 47 MiB/s |
| 10 GiB, five at once | 1,010.4 s (964.3 to 1,315.9, n=5) | 380.0 s (269.4 to 420.1, n=5) | 10 → 27 MiB/s |

Every save committed, and every record held the whole base. Random data does
not compress, so level 1 stored 4 KiB more at each size: 2,147,504,128
against 2,147,508,224 bytes at 2 GiB, and 10,737,442,816 against
10,737,446,912 at 10 GiB. Every before-lane 10 GiB save run alongside other
boxes took longer than 900 s and was delivered twice. Each second delivery
reported the commit it waited behind (D57's fix), so the records stayed
correct. The one before-lane sample run with no other box saving took 752 s,
which is the low end of its row.

The level costs bytes on data that compresses. On this host, packing the
repository's `node_modules` (1,948,715,012 bytes in 121,250 files) with
`-processors 2`, as a Medium box has two CPUs, n=3 each with identical sizes:
the default level packed 465,465,344 bytes in 81 to 84 s; level 1 packed
566,403,072 bytes in 2.1 to 2.4 s. That is 22% more stored, at about 40 times
the pack speed. At the default level such a base packs at about 23 MiB/s,
which is below the 39 to 47 MiB/s one box now uploads. This host's CPUs are
not the container's, so the ratio is the finding, not the times
(`bench-artifacts/save-speed/zstd-levels-node-modules.log`).

Five boxes at once still share the upload. After the change, 2 GiB at five
at once ran at 15 MiB/s a box against 39 alone, and 10 GiB at 27 against 47.
What bounds the shared rate is not established here; the boxes, the account
and R2 are each candidates.

fuse-overlayfs is not what bounds a save. A first base packs `/workspace`
through the overlay (a delta packs the upper on disk), so each save was
preceded by a read of the same tree both ways: a `tar` after a cache drop the
container may refuse (`designA.ts`, `SBS_A_READ_PROBE`). At 2 GiB, which fits
in the box's 8 GiB of memory, the overlay read 1,809 MiB/s against 1,879 from
the disk (one box, before). At 10 GiB the overlay read 155 MiB/s (137 to 172)
against 270 (250 to 279) from the disk, one box after the change, and 129
(113 to 222) against 208 (188 to 351) at five boxes. Both are well above what
the save reached, 47 and 27 MiB/s a box.

The 224 MiB rows come from the phases probe. As in D57's small runs, its base
save reports "committed, but reseating it failed: ... /workspace: Device or
resource busy" on both images. The commit lands before the reseat, and the
time is the commit's. D61 traces the cause: the probe's own sampler, whose
cwd is `/workspace`.

Tests: `stream-script.test.ts` runs the shipped script with its own small
profile (5 MiB parts, four in flight, 40 MiB window), so a test archive spans
many windows. The chain's tests use `DISK_STREAM`, and the strategy model
holds the platform's 64 MiB tmpfs as its own fact. Image `daefe832…`, sync.js
`2171d5f4…`, re-pinned in `upstream.json` and the three wranglers. devbox
suite: 524 pass.
The bench's `BENCH_IMAGE_DIGEST` (`1cca04102`) runs another pushed digest of
the same repository. Runs: `bench-artifacts/save-speed/` (`lane.sh`, `one.sh`,
`table.py`; the 224 MiB rows in `small-*.log`); every Worker, app and bucket
was deleted. The before lane's 10 GiB one-box row took three runs:
- The first failed at its first request, which got a 404 page from the new
  Worker's address.
- The rerun (`one.sh`) saved four boxes; its first save overlapped the after
  lane's last. A host restart cut it during the fifth box, and its Worker,
  app and bucket were deleted by hand.
- The fifth sample ran alone on 2026-10-02 at about 03:55Z. The first try
  failed the same way, its Worker and app were deleted by hand, and the
  retry saved.

D59. A box idle long enough to rest, with anything still running in it,
asks its agent and holds until the agent answers (2026-10-01). Before this:
- A process the box started that was not supervised held the box for as long
  as it ran, with nobody told. A long build or a background shell job could
  keep a box up indefinitely.
- A supervised server did not hold it. The box rested after 40 idle minutes
  and stopped the server without telling anyone.
- A process list that could not be read held the box for one quiet-confirm
  window of beats. After that the box rested anyway, with an empty list
  (D35's give-way), so it could stop a command nobody could see.

The owner's rule (m1937): when the sandbox has gone unused long enough and any
long-running process is up, dev servers included, wake the agent and let it
confirm whether resting is safe. A box with nothing running rests as before.

The rule now:
- A process no longer counts as the box's work in `quiesceStep`. Only the
  box's own lanes and callers do.
- When the step reaches `quiesce`, the box reads its process registry. If
  nothing live is in it, the box rests silently, as before.
- If any process is live, supervised or not, or the list cannot be read, the
  box records a rest ask, holds, and ticks `decision: 'ask'`. The ask goes
  out on the existing incident path as stage `rest`: the incident ledger, then
  `KinuDevbox.onIncident`, the root's `acceptSandboxLifecycleIncident`, and
  one inbox signal.
- The ask lists each process: its command, pid, age, the ports it listens on
  (from `portListeners`, matched by process group), and what resting does to
  it. An unsupervised process ends and does not come back; a supervised
  server stops and restarts cold on its next use, without its in-memory
  state. The ask also says that 'keep' means another ask in about 40 minutes.
  An unreadable list says so, and that resting could end a command nobody can
  see.
- The agent answers with `sandbox.rest('now' | 'keep')`. This is a binding on
  the sandbox namespace that eval programs reach, not a native tool, so
  `BUILTIN_TOOLS` stays at eight. It is declared only in that namespace's
  types. It calls `SandboxHandle.answerRest`, then the adapter's DO-only call
  (which never starts a resting container), then `Devbox.answerRest`.
- 'now' saves the workspace and stops the container. That is an ending, so
  untimed commands end and an unread list does not hold it.
- 'keep' stamps use, so the box asks again only after its next idle window
  and quiet confirmation.
- Either answer with no ask pending is refused, so it cannot stop a box in
  use. An ask nobody answers is recorded again once per idle window, and the
  box keeps holding.
- `devbox:rest-ask` holds when the box last asked. An answer deletes it, and
  so does a rest.

Removed:
- `setKeepAlive`, `isKeptAlive` and `devbox:keep-alive`, which had no caller
  in cf-backend or core. 'keep' is the one way to keep a box running, and it
  is a stamp of use.
- `devbox:unreadable-process-beats` and the give-way. A stop that the agent
  did not answer for is now always held while the list is unreadable.
- `acceptSandboxLifecycleFailure` is renamed `acceptSandboxLifecycleIncident`,
  and its types with it, because it now carries an ask. The persisted signal
  kind, `sandbox_lifecycle_failure`, is unchanged, so rows already written
  still read.

D35's measurement, re-run under both rules: the process list throws on every
read, and the box is idle.
- D35's rule held for 9 beats, then rested the box at beat 10, with no ask.
  The new test, run against those sources, found the box rested and nothing
  asked (`bench-artifacts/rest-ask/devbox-red.log`).
- The new rule held 10 beats while the quiet was confirmed, asked once at
  beat 11, and held the next 29 beats as `ask`. In 40 beats it stopped the box
  0 times.

Tests (`devbox/tests/terminal-activity.test.ts`, "a box with work still
running asks before it rests"; red before the change, 6 of 7):
- a command still running is listed in one ask over three beats, and the box
  holds;
- a supervised server alone asks, and its line says it restarts cold;
- a box with nothing running rests without asking;
- an unreadable list asks and never rests;
- 'keep' holds, then asks again one idle window later, and 'now' stops the
  box;
- an answer with no ask pending is refused;
- an unreadable supervised-spec store asks rather than throwing.
In cf-backend, a `rest` incident lands as one signal that names the process
and both answers and does not read as a failure. In core, `sandbox.rest`
reaches the box once per answer and renders each outcome. Both were red on the
old sources (`cf-core-red.log`).

D60. The Cloudflare SDK audit's four items, each red first (2026-10-01).
The audit (agent BewilderedSalamander) confirmed we ship the latest stable
releases: sandbox 1.0.0, agents 0.24, wrangler 4.145. It found four places
where the SDK docs do better than the box did.

(a) A process pid counts only in the boot that started it (`4ecacaa7f`). The
process registry lives in the container, so a snapshot or the chain restores
it into a new boot, where its pids name whatever process the new boot gave
that number. Status read such a pid as running, and a stop signalled it. The
wrapper now writes `/proc/sys/kernel/random/boot_id` beside the pid, as the
docs' RUN and STATUS scripts do. Status and stop believe a pid only from this
boot. A record in the old form counts only if its pid file was written since
boot. In the real image (`devbox/tests/processes-image.test.ts`), the old
scripts recorded no boot, and a stop of a restored record naming PID 1 went
on to `kill -s TERM -- -1` and failed (`bench-artifacts/sdk-audit/boot-red.log`). With the change,
the restored and foreign records read lost, PID 1 is never signalled, and an
old-form record from this boot still reads running (`boot-green.log`).

(b) An open preview socket is the box's use (`bb928c7fa`). A preview
WebSocket went straight from the port to the visitor, so the box saw only the
upgrade and rested 40 minutes later under a socket still in use. The box now
holds both ends, as the SDK's `bridge()` does. It relays both ways, counts each
open socket as work at the heartbeat, and stamps its use when either end
closes. Red on the old box: a box with an open preview socket rested at the
end of its quiet window (`preview-socket-red.log`). Green: it holds while the
socket is open, relays a message each way, closes the app's end with the
visitor's code, and rests one idle window after the close
(`terminal-activity.test.ts`, "an open preview socket is the box's use").
Preview tokens now compare in constant time. A unit test cannot observe the
timing, so `preview-route.test.ts` pins only the answers, and it passed on the
old compare too: a same-length wrong token, a prefix and another port's token
get 404. The port comes from the hostname. The Worker builds
`/_devbox/preview/<label port>/<token>` ahead of the visitor's path, and
nothing reads `X-Sandbox-Port`. A visitor's header or a path naming another
port reaches the label's port, with that path left as a path; the Worker test
and the box test pin both.

(c) The container trusts the intercept CA in its own bundle (`1622c3a9e`). The
box named the CA only in env vars (`SSL_CERT_FILE`, `CURL_CA_BUNDLE`,
`GIT_SSL_CAINFO` and `NODE_EXTRA_CA_CERTS`, all naming the CA alone). A tool
that reads none of them, such as apt, Java or a process with a cleared env,
refused every intercepted site. The box now runs the docs' TRUST step once its
HTTPS intercept is registered. The step keeps a copy of the image's bundle,
waits up to 10 s for the CA, and writes the bundle as that copy plus this
container's CA. A snapshot's next container so keeps no earlier container's
CA. Commands carry the docs' env, `NODE_EXTRA_CA_CERTS` and
`REQUESTS_CA_BUNDLE`. In the real image with a stand-in CA
(`trust-image.test.ts`), the old shape failed a curl that read no env, and
held no trust step for the next container (`trust-red.log`). Public roots did
not break under the old env, because curl, git and Python also read the hashed
`/etc/ssl/certs`; the test pins them anyway. Green: curl, git, Python and Node
reach the intercepted site, curl, git and Python reach a public root, a curl
with no env reaches both, and the next container trusts its own CA only, with
one CA beyond the image's bundle (`trust-green.log`). A configure whose CA
never appears fails, and the start awaits the configure, so the start fails as
the docs' `startContainer()` does (read from the code, not tested). The cost
is one exec in the start path; its live time is unmeasured until a deploy.
The order item needed no change. Every hostname route, S3Mount's included,
is an entry in `DevboxOutbound`'s exact-first table rather than a platform
intercept registered beside the catch-all, so no route can be shadowed (D38).

(d) The platform lifecycle, evaluated; nothing adopted. The box already sets
`setInactivityTimeout` to `idleMs + quietConfirmMs + 60 s` on every use and
every beat, and it awaits `monitor()` when it stops the container. Letting the
platform's timeout or a `monitor()` watch replace the beat would remove no
code without breaking a rule:
- The platform stops a container without the quiesce checkpoint, and without
  D59's ask. Container CPU is not activity to it, so it would stop a box that
  D59 holds for a running build at 41 minutes.
- A constructor re-arm covers at most the 60 s until the next beat re-arms it,
  at one extra call per object construction.
- `monitor()` keeps the object resident while it waits and ends on a restart.
  The beat still has to run for the quiet window and the ask, so the watch
  would add a path and remove none.
So the timeout stays a backstop that only fires when the beat itself stops.

D61. A quiesce releases a process that maps the work directory; the
reseat refusal D57 and D58 saw is the bench's own (2026-10-02). After a
quiesce commits a first base, it reseats `/workspace`: it unmounts the
overlay, mounts the base as the lower and starts an empty upper. While
anything holds `/workspace`, the unmount is refused, the outcome is "committed,
but reseating it failed", and the quiesce fails. In production the holders
that matter are a dev server and a terminal shell, so this entry measures what
the reseat does with each.

The bench's refusal. The phases probe records, just before each commit, every
process holding `/workspace` by its cwd, an open fd or a mapping
(`side-by-side/phases.ts`). Live (run `sbs10020448nrspws`, image `daefe832…`,
n=2), the holders were the probe's sampler (`bash /tmp/phase-sampler.sh`), the
sampler's `sleep`, and the probe's own scan, all with their cwd in
`/workspace`. Both commits failed the reseat. The bench drives that commit
through `POST /checkpoint`, which calls `checkpointNow('quiesce')`. That is a
commit without the quiesce's holder release. In the product only the bench
calls `checkpointNow`; the heartbeat calls `quiesce()`, which releases holders
first. With the sampler started from `/` instead (`sbs10020521nrsproot3`,
n=2), both commits reseated and committed 234,885,120 bytes. The only process
listed was the probe's own scan, which exits before the commit.

What the product does, measured in the image with a real fuse-overlayfs at
`/workspace`. The image's own sync.js ran against a box and store served
inside the container (`bench-artifacts/reseat-holders/run.ts`, as
`concurrent-flush-image.test.ts` does). The workspace held 64 MiB of random
data and 40 small files; then came a first base and two 4 KiB edits.

| Holders, and the path | Reseat | Record exact | Upper after | The two edits moved |
|---|---|---|---|---|
| dev server and terminal shell, cwd in `/workspace`; quiesce (release, then commit) | ok, both holders stopped | yes | 0 B | 8,192 and 12,288 B (deltas) |
| the same; commit only, as the bench does | refused (EBUSY) | yes | 67,109,215 B | 67,117,056 and 67,121,152 B (full rebases) |
| the same plus a program run from `/workspace`, its cwd elsewhere; quiesce, before the fix | refused (EBUSY) | yes | 67,144,551 B | 67,129,344 and 67,133,440 B (full rebases) |
| the same, after the fix | ok, all three stopped | yes | 0 B | 8,192 and 12,288 B (deltas) |

The dev server is `python3 -m http.server` started in `/workspace`. The
terminal shell is a tmux pane, as `terminal.ts` opens it: a tmux server
started from `/`, with its pane's shell in `/workspace`. "Exact" means every
file `/workspace` shows is in the recorded layers, and no layer holds a file
it does not.

So a refused reseat loses nothing: the base is durable before it, and every
record stayed exact. Its cost is that the box keeps the old overlay, with the
whole tree in the upper, which grows with every write and never shrinks. Each
later commit then republishes the whole tree as a rebase, about 64 MiB for a
4 KiB edit here. And the quiesce fails, so the box does not stop. What the
next quiesce does with the holder still alive was not measured.

The defect. The release found holders by cwd and by open fd only. A process
whose binary or library comes from `/workspace` holds the mount through its
mapping, with no fd open there and its cwd elsewhere: for example a dev server
built into the workspace and started from `/`, or a native addon a server
loads. The release said "none", the holder outlived it, and the reseat was
refused. The scan now also reads `/proc/<pid>/maps` (`f5d992608`,
`releaseWorkdirHoldersCommand`). `workdir-holders-image.test.ts` starts four
holders in the image: a dev server and a terminal shell (cwd), a program run
from `/workspace`, and a process with a library preloaded from it. It was red
on `20804a4f0`: the last two survived the release and the unmount was refused
(`bench-artifacts/reseat-holders/holders-red.log`). It is green now
(`holders-green.log`). devbox suite: 539 pass.

One image for both lanes. lane/devbox-rest-ask changed no file the image
carries: its code runs in the Durable Object, and the sync bundle is unchanged
at `2171d5f4…`. Built from the merged tree, the image is byte-identical to
`daefe832…` (local image id `d8372d0b…` for both builds), so `daefe832…` stays
the pin. Live on `f5d992608` (run `sbs10020453nmlive`, one Medium box, 2 GiB
of random data): the base saved in 37.8 s and committed 2,147,508,224 bytes.
The box woke twice, in 4.2 s and 3.1 s at the driver, both exact. The first
256 MiB read in 11.1 s and 3.2 s, and the whole workspace in 41 s and 25 s.

D62. The hybrid is the only path; the older chain is deleted, and a reset,
not a converter, takes boxes across (2026-10-02). Every box now keeps its
workspace on the container's disk, takes a platform snapshot at each rest
and backs it up with the disk chain (D55). The `hybrid` flag, the
`snapshot-chain` strategy and its overlay-on-store chain, the container's own
sync program (`sync.js`, `DevboxSyncGateway`, D30), the work-directory holder
release (D61), extraction mode and the chunked delta stager are gone: 4,041
source lines and 10,782 test lines deleted, 102 and 185 added. The image no
longer carries `sync.js` (`01b8221c…`, built from this tree; the three
binaries are unchanged).

No converter. AGENTS.md ships a storage-format change as a reset
deployment, and the promotion that ships this one resets production
(`scripts/reset.ts`), as staging was reset. Measured before deciding
(2026-10-02, read-only listing): `kinu-backups` held 7 boxes, two with
bytes (76.5 MB and 9.6 MB, both base-only), and `kinu-backups-staging` none.
The reset already empties the new layout: it deletes every object under
`boxes/` in the store bucket, and the disk chain writes only under
`boxes/<box>/backups/disk/`; both buckets hold nothing outside `boxes/`. The
snapshot and chain records live in the Durable Objects the reset deletes.
What a reset does not reach is the snapshots themselves: each sits in the
image's registry repository as two `rootfs-*` tags (D55), shared by
production and staging, and its annotations name no box, app or
environment, so a reset cannot tell its own from the other environment's.
Once their objects are gone nothing references them; they lapse in 30 days
and do not count toward the image limit (D55). This is a known effect of a
reset, accepted on 2026-10-02 rather than splitting the repository per
environment: the registry sweep, held for the owner's token decision, is where
they get cleaned.

One fix the deletion surfaced. A snapshot's disk can keep the S3Mount
marker of the mount it was taken under, and the first mount after a wake
then failed ("invalid S3 mount route selection") because the box skipped
the unmount for a container it had just started. A snapshot start now runs
that unmount (`quiesce-order.test.ts`, red before the change).

D63. A large file changed in place travels as the blocks that changed, and
the block lower composes it through every layer (2026-10-02, option (a) of
the D55 follow-up). D55's disk chain sent each changed file whole. A dev
session's databases and logs are written in place, so one 4 KiB page write
re-sent the whole file at every save. Measured before building (local, the
image, `bench-artifacts/inplace/measure.log`): a session with a 616 MB SQLite
database, a 165 MB JSONL log, a git repo and a 1 GiB file written in place
re-sent 1.85 GB per save.

What a save does now. A regular file of 1 MiB or more, changed since the last
save and with its block digests cached, is read once in 16 KiB blocks. Each
block whose SHA-256 differs from the cached one becomes a chunk (an all-zero
block becomes a hole), indexed in the block lower's authenticated page format.
Its record (path, size, mode, owner, mtime, index) goes in
`.devbox-delta/manifest.json` (`v: 3`), and the layer's `tree/` holds the
other changed files whole and the whiteouts. The cache is the digests of each
large file as the record holds it. A save stages the next cache beside the
current one, and it becomes current only once the record names the layer,
under one lock that also drops a cache built for a rev the inventory has
moved past. A base caches every large file whose size and mtime held across
the pack and the read, and a recovery caches its copy to disk. A file with no
cache travels whole once and is cached from then on.

What a recovery does. Every layer is a lazy squashfs mount; the deltas'
`tree/` directories are overlay lowers, and `devbox-block-lower` sits above
them all. It serves a file whose newest version is a block record. It reads
each block from the newest layer that holds it, down to the file's last whole
copy, each record's index looked up by that version's own size. A file a newer
layer replaced or removed is not served, so the overlay reads that layer. A
record with no earlier version beneath it is EIO, never zeros. The crate lost
the older chain's single-delta CLI, its opacity probe and the v2 manifest.

Measured (local, image built from this tree, 2 CPUs, real FUSE and the shipped
publisher, the store served in the container; `bench-artifacts/block-deltas/`,
`session.jsonl`, the same session as above):

| Step | Result |
|---|---|
| base of the 1.85 GB workspace | 25.2 s, 1.42 GB stored, 3 large files cached |
| each of 10 saves | 9.34 to 9.41 MB moved (was 1.85 GB), 1.8 to 3.6 s |
| what a save records | about 1,000 blocks of the database, 100 of the 1 GiB file, 7 or 8 of the log |
| recovery of 11 layers | attached in 2.4 s, lazily |
| every file read through the layers | 49 s, exact (sha256 of every file) |
| first save after the recovery | 9.48 MB: the copy's cache held |

The image tests are red on the committed chain and green now
(`image-red.log`, `image-green.log`): the earlier test's 4 KiB write into an
8 MiB file moves under 256 KiB, and a new test stacks block records over
four saves (growth, a punch, a truncation below an earlier growth, a
re-edited block), then recovers exactly lazily, as a plain disk, and from
the store again. A bug that test found is fixed: a record's index was looked
up by the served file's size, so a version shorter than the one below read
as EIO. The crate's unit tests cover the resolution through layers, a
shadowing newer layer, a missing earlier version and a corrupt chunk.

The image is `e7444653…`, built from this tree; its other binaries are
unchanged. Lines: the crate +684 / -526, `disk-chain.ts` +195 / -32. The record's
format is `disk-chain/2`; no box holds `/1` (the hybrid was opt-in until
D62), and a format change ships as a reset.

D64. The hybrid's live runs pass, after three fixes they found (2026-10-02).
Run `sbs10021640nhyf` (`bench-artifacts/hybrid-live/`): the bench fixture of
this tree, image `e7444653…`, Medium, `durable_object` policy, three fresh
boxes, each through a base and a block delta (16,384 bytes moved), a rest, a
wake from its snapshot, a second rest, the snapshot lost (the bench points
the record at an id the platform does not hold), a wake, a rest and a wake of
the recovered box. Every Worker, application and bucket is deleted, and so
is every snapshot tag the runs made.

| Step, n=3 | Driver | The box's restore | Result |
|---|---|---|---|
| rest (commit, then snapshot) | 4.4 to 7.1 s | | committed |
| wake from the snapshot | 0.64, 0.65, 0.89 s | 34 to 38 ms | exact, excluded folders included |
| wake with the snapshot lost | 4.3, 4.5, 5.3 s | 3.5 to 4.1 s | image start, lazy recovery of 3 layers; exact without the excluded folders; the notice names the time and the folders |
| wake of the recovered box | 0.66, 0.72, 1.13 s | 157 to 210 ms | "recovery made plain", exact |

What the runs found, each red first:
- A snapshot start the platform refuses ("Snapshot … was not found")
  fails its first exec at once, and the cutover started the image. The
  10 s cutover timer was an `AbortSignal.timeout` handed to that exec; it
  fired 10 s later and took the image's container down mid-recovery. The
  timer is now cleared once the exec settles (`hybrid.test.ts`, on fake
  timers, red on the old form).
- The recovery started the block lower as `cd / && setsid nohup … >log &`.
  The background shell held the exec's stdout, and the platform's exec
  answers when stdout closes, so the mount step held the start gate past its
  25 s budget. The whole job is redirected now. `disk-chain-image.test.ts`
  answers an exec when its stdout closes, as the platform does; on the old
  form its recoveries held until a 60 s bound added for that run failed them
  (`bench-artifacts/block-deltas/image-pipe-red.log`).
- A discard deleted every listed key in one call: R2 refuses a delete of no
  keys (10027), and lists 1,000 at a time. A box with no objects failed its
  teardown, and one with more than 1,000 kept the rest. The discard now
  pages and skips an empty delete; the test bucket models both limits.

Each snapshot's manifest names its box: `deployment_id` is the Durable
Object id under the `durable_object` policy. That maps a tag to a box and so
to an environment's bucket, which the sweep can use.

D65. Snapshots are deleted by lineage: a snapshot nothing can wake again is
deleted with its whole lineage, and a live lineage is kept whole
(2026-10-02). A rest after a wake from snapshot S takes a child of S, so S
stays: the record holds the new snapshot's ancestors (`lineage`, root
first) and the time its root was taken. A lineage is dead when its box is
discarded, when a wake could not use it and started from the image (the
cutover, a moved chain, another image, an aged root), or when the bench
loses it; the box then lists every snapshot of that lineage in
`devbox:dead-snapshots` and deletes them after the rest's stop, after a
cutover and after a discard. A deletion never holds a save or a wake: a
refusal is logged in the platform's words and asked again at the next
sweep. The 29-day rule counts from the lineage's root, not its newest
snapshot, until probe (b) below says a child keeps its parent alive.

The registry client (`src/snapshot-registry.ts`) mints push credentials
with a Containers-scoped API token (`DEVBOX_REGISTRY_TOKEN`, Account >
Containers > Edit, declared in `infra-manifest.ts`), finds the repository
holding `rootfs-snapshot-<sha256(id)>` in the catalog, reads its set id and
deletes `rootfs-snapshot-*` and `rootfs-set-<sha256(set id)>`. A box with no
token keeps its dead snapshots until it has one; they lapse in 30 days.
Live (run `sbs10021734nhsw`, image `e7444653…`, Medium, two boxes through
D64's steps, all exact): the re-rooted box deleted its two-snapshot lineage
during the run, the teardown's discards deleted the rest, and the
repository held no tag of the run afterwards.

What a snapshot is in the registry (read 2026-10-02 from that run's tags):
both tags name one OCI manifest with one layer, a btrfs send stream. A
root's layer is the whole rootfs increment over the image (75.8 MB) and its
`subject` is the image's manifest. A child's layer is an incremental stream
(64,470 B) whose `subject` is its parent's manifest, with
`parent_snapshot_id` in its annotations. So restoring a child needs its
parent's layer, and probe (a) asks whether the registry keeps it once the
parent's tags are gone. `deployment_id` is the Durable Object's id under
the `durable_object` policy, so every tag maps to its box.

A roll of `cloudflare/debian-trixie` should leave existing snapshots
restorable on the base they were taken from. A snapshot carries its own
base: after a Worker moved from image A to image B, a restore of a snapshot
taken on A ran A's shim (`a2973893…`) and `inspect()` named A, while a fresh
start on B ran B's shim with an empty workspace (D51, run
`snap09302048b2`); with A's tag deleted from the registry the restore still
worked (`snap09302053b3`); and a root snapshot's manifest names its image's
manifest as its `subject`. The box's image check compares the configured
image string, which a roll does not change, so a box keeps waking its own
snapshot across a roll. Not measured: a roll of a managed image itself,
which only Cloudflare can do.

The long probes, started 2026-10-02 (`bench-artifacts/snapshot-life/`): a
throwaway Worker with an hourly Cron Trigger takes every reading and writes
it to its R2 bucket, then deletes its snapshots' tags, its container
application and itself after the last one; the bucket keeps the readings.
Each question runs on our image and on trixie. (a) P -> C with P's tags
deleted on day 0: C restored at 1 h and then daily to 14 days, and P's tags,
manifest and layer read by digest each time. (b) P -> C untouched: C
restored every 3 days and P never; from day 28 to 36, daily, whether C
restores and whether P's tags, manifest and layer still exist. Run
`life10021741`, Worker and bucket `kinu-life10021741`; the readings are
`readings/<lineage>/<hours>h.json`. Until the owner mints the
Containers-scoped token, the Worker holds the deploy token as its secret;
that is temporary, and the secret is swapped when the scoped token exists.

Day 0 of (a), both bases: C's manifest names P's manifest as its `subject`
and P as `parent_snapshot_id`, and does not name P's layer; C's one layer
is an incremental btrfs stream (5,644 B on our image, 6,216 B on trixie)
over P's 67 MB layer. P's two tags deleted (204, 204): both then answer
404, while P's manifest by digest and P's layer blob still answer 200, and
C restored exact at once (324 ms, 449 ms to its first exec). Under OCI's
rules a `subject` points from the referrer to its subject and does not keep
the subject, so only the time series can say whether the registry's
collection spares an untagged parent.

D66. A box starts from a golden snapshot of `cloudflare/debian-trixie`
with the pinned tools, and its tools reach it as one tarball (2026-10-03,
the owner's design of D55, built). The image keeps only what a container
needs from us; everything a box runs is in the tools tarball, which the
Dockerfile's `tools` stage builds (`scripts/devbox-tools.ts build`) and
upstream.json pins by sha256: an offline apt repository of the closure of
the 15 Debian packages a box needs, taken from snapshot.debian.org on
2026-10-02, and our four binaries (bun, block lower, squashfuse, the shim).
Two builds with no cache made the same tarball (`75164f17…`, 100.8 MB). The
deploy refuses a store bucket that lacks it, by name; the developer who
re-pins runs `devbox-tools.ts publish <bucket>` for each environment.
Since 2026-10-05 a store holds the tarball in parts of at most 256 MiB
(`devbox-tools/<sha256>.tgz.0`, `.1`, …), which the box joins in order and
checks against the pinned sha256 before it extracts anything: the desktop
(D70) made the tarball 320 MiB, and `wrangler r2 object put` takes 300.

The golden object, one object of the box's class (`devbox-golden`), starts
the base, pipes the tarball in from the store, installs it with apt over the
local repository (no network), checks the tools and FUSE, and snapshots.
It rebuilds when the pinned tools move, and at 25 days, when it also
restores the previous golden so both stay alive. A platform roll of the
base is not a rebuild: a snapshot keeps the base it was taken on, and the
next refresh takes the new one. The Worker's 15-minute cron asks the golden
object (the owner's choice, 2026-10-03: no deploy step, route or secret);
with nothing to do it answers without starting a container, and the first
box of a new deployment that finds no golden asks for the build. A box
starts from its own snapshot, else the golden. A golden of other tools still
serves; the box then installs the pinned tarball inside its start gate. A
golden the platform refuses is reported lost and the next is used. With no
golden at all, the box does not start a container and does not install in
its gate: its readiness is pending with the reason, the golden object
records it, and when a build verifies, the golden object tells each waiting
box once to start; a failed build's words become each waiting box's reason.
The box arms no clock for it. `tini` is the container's init, from the
tarball.

Measured on Medium, the `durable_object` policy, internet off
(`bench-artifacts/storage-designs/`, runs `g5510022003debs`,
`g5510022009rfr`; n=5 each, all checked: FUSE, the block lower, bun 1.4.2,
`Files`):

| | in the gate | with the pipe from R2 |
|---|---|---|
| fresh install of everything | 12.2 to 26.0 s (median 13.2) | 14.9 to 31.2 s |
| refresh, nothing changed | 1.42 to 1.64 s, 0 packages | the box compares the stamp first and does nothing |
| refresh, one .deb and bun changed | 1.46 to 1.64 s (apt 236 to 306 ms) | 3.5 to 5.0 s |

The fresh install does not fit the 25 s gate every time, so it never runs in
one: only the golden object installs from scratch, outside every box's
gate. Plain `dpkg -i` cannot do it: the managed base is 13.6 against 13.7
packages, and pre-dependencies need ordering, which apt over a local
repository gives.

Live (run `sbs10030035ngld`, the bench fixture of this tree, two Medium
boxes): the golden built in 20.4 s; each box started from it (`debian 13.6`,
tools `75164f17`, bun 1.4.2, tini as pid 1), then D64's steps: a wake from
its snapshot in 0.40 and 0.61 s, a lost snapshot recovered lazily in 4.7
and 4.8 s with the notice, the recovered box woken in 0.56 and 0.62 s; all
exact. Every Worker, application, bucket and snapshot tag of the run was
deleted, the golden's with the product's registry client.

D67. What a box in `repair` is missing reaches the agent through the
incident inbox and nothing else, and a recovery is told as a recovery
(2026-10-03). The admission no longer carries `incomplete`: the adapter
accepted `repair` and dropped it, `exec()` discarded `ensureReady()`'s
answer, and nothing in core or the host read it, so the comment that a
caller "learns from the call itself" was false. `devboxState().unready`
still names what is missing.

Proved through the agent's own path
(`cf-backend/tests/unit-sandbox-repair-notice.test.ts`): its commands go
through the sandbox executor and `adaptCloudflareSandbox` to a Devbox on the
container harness, and the box's incidents go through KinuDevbox's
restatement (now one function, `lifecycleIncident`) to a real workspace's
`acceptSandboxLifecycleIncident`, whose inbox turns are counted. A service
that does not restart, on a snapshot wake and on a lost-snapshot recovery:
the agent's first command, the one that woke the box, ran with the
restoration already settled in `repair`; its files were exact; exactly one
inbox notice named the service ("(process p1)") with the container's cause.

The test found one defect, fixed red first
(`bench-artifacts/repair/recovery-notice-red.log`): the recovery notice was
filed as an `attach` incident, so the agent was told "The workspace container
failed at the attach stage ... sandbox tools are refused until an attach
succeeds" about a recovery that had succeeded. It is its own stage now,
`recovered`, told as what it is: the time the workspace came back to, the
folders to rebuild (`bun install`, not `npm install`), and that every tool
works.

A failed final boot stamp changes nothing a user or agent can see
(`tests/stamp-repair.test.ts`). The early stamp writes this container's id
to the file and the row before the attach; the final step only re-reads it,
so its failure leaves the identity whole. The box settles in `repair` with
"the boot id stamp failed", and that is all: no incident (there is nothing
to act on), operations admitted, saves commit (no replacement is seen), the
heartbeat starts nothing. Nothing retries it but `attachNow()`, which no host
calls, so `ready` stays false until the next restoration; no host reads
`ready`. A pid from an earlier boot is fenced by the kernel's boot id each
process record carries, not by this stamp: on the real image, a record from
another boot naming a live pid reads lost and a stop never signals it
(`tests/processes-image.test.ts`).

Live (run `sbs10030449nrps`, image `e7444653…` on the trixie golden, two
Medium boxes, a service on port 8123 that cannot come back after its
`.serve` file is removed before the rest):

| | box 1 | box 2 |
|---|---|---|
| wake from the snapshot | 6.6 s, `repair`: "port 8123 never answered", 1 notice, exact | 6.8 s, the same |
| lost snapshot, the first command is the wake | 8.8 s, lazy over 3 layers, exact, `repair`, 2 notices in all | 9.2 s, the same |
| the recovered box woken | 6.8 s, "recovery made plain", exact | 6.9 s, the same |
| the kernel's boot id | changed at every wake | changed at every wake |
| the restarted service, read and stopped | `failed`, nothing signalled | `failed`, nothing signalled |

The wakes take 6 s more than D64's because the box waits out the port's
probe window before it settles in `repair`. The kernel's boot id changing at
every wake is what makes every process record a snapshot restores read as
another boot.

One fact the run measured, for the record: `/tmp` is on the rootfs, so a
snapshot carries `/tmp/devbox-boot-id`. After a snapshot wake the file holds
the previous container's id, and the box treats the woken container as the
one it stamped. Nothing is wrong today: a rest deletes the settled row before
the snapshot, so a wake restores in full. But the stamp now names a
snapshot's lineage, not a container: a replacement started from the same
snapshot without the box's start would not be seen. Not observed; the
kernel's boot id would see it.

D68. The hybrid stays; a thin-pool virtual disk, vblk alone and btrfs change
detection are rejected (2026-10-03).
Five arms on one workload (`bench-artifacts/h2h/`: `h2h.sh`, `h2hx`, the
drivers and `table.md`), Medium, n=5 a figure unless the table says
otherwise: A production's chain (2f660875cc), B platform snapshots alone, C
the hybrid (this lane), D vblk alone (E's lost-snapshot path), E platform
snapshots with vblk-T (ext4 on a dm-thin volume in a pool on the root, R2 by
block). Rows at 0.25, 2, 10 and 18 GB and D63's long session.

| at 2 GB | A | B | C | E |
|---|---|---|---|---|
| warm wake, ms | none | 594 | 386 | 495 |
| snapshot lost, ms | 7,199 | none | 7,346 | 1,449 |
| 3 KB save, ms (pause) | 142,338 (72) | 2,747 (775) | 980 (53) | 944 (74) |
| 3 KB save moves | 1.5 GB | 20 KB | 10 KB | 8.5 MB |
| 100 MiB save, ms | 173,272 | 4,707 | 6,585 | 1,934 |
| session: R2 after 10 saves | 2.8 GB | none | 1.5 GB | 8.2 GB |

Every arm restored exactly where it ran. E is rejected on reliability, not
speed. It cannot hold 18 GB: with the pool sized to all the disk but 512 MiB
and ext4 reserving nothing (18.2 GB free to ext4), the 18 GB tree still met
ENOSPC, 3 of 3. The thin metadata is 16.5 MB and the pool file costs nothing
beyond its size; the loss is ext4 in place of the root's btrfs, which
compresses (zstd) and keeps small files inline. And a rewrite that a save's
snapshot pins past the pool's free space fails ext4 with I/O errors, and the
workspace goes read-only (2 GB under write pressure: 3 of 5 writable). B has
no backup, a 600 to 1,100 ms pause, and fills the disk when rewrites follow
snapshots. A takes minutes a save and fails saves on E2BIG (fixed on
integration by 84525f638 and d4fa3062e).

C's own failures, to fix next: at 10 to 18 GB a save meets ENOSPC staging or
reading a delta back; and the fault soak (104 cycles,
`h2h/runs/sbs10031343nsoak1-soak.jsonl`) found a box left terminal by a kill
during its copy, the store mount failing after a kill, and one silent loss.
The 10 GB base's failure, 4 of 4, was mksquashfs reading a duplicate back
from an archive already punched (a7fb584b3).

A btrfs-native backup (`btrfs send -p`) saves in 4 to 15 ms of pause and
sends exact extents, but a send stream restores only by replay (`btrfs
receive` at about 9 s a GB): no lazy restore. A platform snapshot keeps
neither a nested subvolume nor a snapshot of the root (2 of 2), so btrfs can
serve C only as change detection within one container's life (10 GB: 10 to
22 ms snapshot and 4 to 53 ms `send --no-data`, against C's 518 to 604 ms
walk). Backup stores, from a box through its gateway, 16 KiB GETs: R2 150 ms
p50, the box's Durable Object 9.5 ms, KV 7 ms on a warm cache only; the
object's 10 GB and 2 MB-row limits make it the place for indexes and hot
blocks, R2 for the bulk. KV is not used: its writes took 167 to 382 ms and
its cold reads were not measured.

Decided: C. E and D are rejected for the reliability above. btrfs change
detection is not built: it saves about 0.6 s a save at 10 GB, but loses its
base snapshot at every wake (so the first save after one walks anyway) and its
held snapshot pins rewritten blocks, which deepens C's ENOSPC at 10 to 18 GB.

After D68 (2026-10-04). The fault soak is clean: 104 cycles plus a 32-cycle
kill-mid-save rerun, 0 silent losses, 0 dead boxes (be2407fc8, 47b0a7a4b).
A delta streams its tar to mksquashfs with no staged copy, chunks sharded by
digest (eeab19c94): at 18 GB, 12 GB rewrites save in 375 to 401 s with at
least 1.96 GB free (n=5; ENOSPC before). A lost wake mounts its layers at
once (a417a4e2f): median/worst ms, all exact, n=5: 0.25 GB 3,242/3,940,
2 GB 3,428/4,437, 10 GB 4,342/4,687; 18 GB 4,338/4,933 (n=2). s3fs keeps
every layer byte it reads on the disk, so a lost wake copies to disk only
when copy and layers fit (9cb262140); at 18 GB the workspace stays lazy
instead of failing reads with EIO. Rejected for the remaining 2.5 to 3.5 s
gate: s3fs read-ahead cut to 10 MiB (0.7 s faster, sequential reads 43-67
down to 17-27 MiB/s); priming each layer's superblock and tables (no gain);
the DO+R2 store. The gate's time is several 100 to 500 ms s3fs round trips
per layer, not bytes, and a DO behind the gateway does not remove them.

D69. An untimed command's kill and a supervised process's stop end it by
one operation, and answer only once nothing it started is alive
(2026-10-03). `END_TREE` (`src/processes.ts`) sends TERM to the command's
tree and to each process group a member of it leads, at once rather than
leaves first, sends KILL to whatever outlives `TERM_GRACE_MS`, and returns
once none of them is alive; a zombie counts as gone. The untimed kill (D37)
answered as soon as the processes it listed first were gone, and did not
wait after its KILL. The stop (D48) watched the group alone. An untimed
command now starts under `setsid -w`, so it leads its own group as a
supervised one does, whatever group the runtime gave the exec. In the real
image (`tests/kill-image.test.ts`, under docker), a shell answers TERM by
starting a process that ignores TERM, and exits. On bfb0f35a9 the untimed
kill answered with that process still running; now both callers answer once
it is gone, and a command that ignores TERM ends on KILL under both.

D70. The desktop is KasmVNC with its own web client, started by the first
open and reached through `/_devbox/desktop` (2026-10-04). The probe ran on
throwaway Medium boxes from integration 85285006f's image, each server driven
by a real client in headless Chrome through the box's Durable Object, n=3
boxes a server:

| | KasmVNC 1.5, its client | TigerVNC, websockify, noVNC 1.6 |
|---|---|---|
| server listens, ms | 187 (169-196) | 703 (702-774) |
| idle server PSS | 27 MB | 18 MB Xvnc and 34 MB websockify |
| socket opens, ms (n=9) | 123 (119-1,189) | 156 (137-251) |
| first frame after open, ms (n=9) | 218 (163-237) | 115 (108-188) |
| click to screen, ms (n=60) | 66 (64-83) | 49 (32-83) |
| full-screen scroll, MB/s (n=9) | 2.7 (2.6-3.1) | 9.3 (7.7-10.2) |
| packages installed | 330 MB | 324 MB |

Chromium with one tab is 402 MB PSS under both, and an idle screen sends 0
bytes. The stack is 236 more packages in the tools tarball (336 MB, was 101
MB): its offline install on trixie took 82 s locally, against 33 s before. KasmVNC's PointerEvent is 11 bytes (a 16-bit button mask, then x, y
and two scroll deltas; kasmweb `core/rfb.js`), where RFB's is 6: with
upstream noVNC 1.6 or 1.7 the server ends the session at the first click
("unknown message type 144"), live 3 of 3 and locally. Kasm's client is not
on npm and is not a library (its `display.js` imports its app UI), so the
client is its prebuilt web app, vendored from the image's pinned `.deb`: the
15 files it loads, 864 KB (`packages/cf-backend/public/kasmvnc/upstream.json`,
`scripts/kasmvnc-client.ts`, `unit-kasmvnc-vendor.test.ts`). The app frames
it from its own origin; its document policy allows framing by the app alone
and sockets to the app's origin alone, so no client setting can point the
socket elsewhere.

The server listens on every interface, because the box reaches the container
at the container's own address, and asks for the `binary` subprotocol and an
`Origin`, which the Worker's allowlist strips and the box sets. Without
`-publicIP`, KasmVNC queries STUN servers and exits when none answers: with
no network it never listened (`tools-image.test.ts`). An open desktop is a
bridged socket like a preview's, so it holds the box awake; port 6080 is
refused as a preview. `desktop-image.test.ts` drives the vendored client in
Chrome, through the Worker's route and the box's, to Chromium in the real
image, and sees a click turn the screen; it fails without the box's
`Origin`. `tools-image.test.ts` runs the start script with no network, so it
fails without `-publicIP`, and opens the menu's browser as root.

D71. The desktop stays on KasmVNC; Media over QUIC through Cloudflare's relay
is rejected (2026-10-05). Probe only (`/mnt/local/kinu/tmp/moq-probe-save`):
throwaway Medium boxes on integration 0b367f089's image, n=3 boxes, each
publishing its X display (ffmpeg x11grab, libx264 ultrafast zerolatency,
1280x800 at 30 fps, fMP4 into moq-rs's `moq-pub`, draft-14 branch) to the
public draft-14 relay, played by moq-js main (WebTransport and WebCodecs).
Every client ran with TLS verification off: the relay's certificate expired
2026-10-04 20:33:59 UTC. All boxes, Workers and buckets were deleted.

| | MoQ | KasmVNC (D70) |
|---|---|---|
| reaches the relay from a box | yes, QUIC/UDP | |
| a viewer on another box or this host sees it | 0 of 12 | |
| encode, % of one core: a strip changes / full-screen motion | 22 / 30 | |
| bitrate, Mb/s | 0.11 a strip changes, 11.3-11.9 motion | 0 idle, 21-24 scrolling |
| click to screen, ms (p50) | 124, in the box | 66, from this host |
| glass to glass, ms (p50) | 109, in the box | |

The relay delivers only within one relay server. A box read its own
publication back 6 of 6; a second box in the same colo (DFW, the same egress
IP) read 0 of 3; this host (DFW) read nothing in either direction, 0 of 9,
while host to host worked 6 of 6, and the same ffmpeg stream from a local
container played on this host. So the latency was measured with the player in
the box: both clocks are the box's, and the figures exclude the viewer's
network and the input path (`xdotool` in the box), where KasmVNC's 66 ms is
the whole path through the Worker and the Durable Object. The box p50s were
92, 109 and 137 ms glass to glass (p90 up to 360, n=1,366 frames) and 123, 124
and 161 ms click to frame (97 to 213, n=60), on a box also running the encoder
and the decoder. moq-pub takes 0.5 to 2.3% of a core; the motion's software
rendering in Chromium takes 108 to 116%, so a two-core box is full. The
motion and KasmVNC's scrolling are different content, so the bitrates
compare only roughly.

Authorization is from the documentation, unmeasured (no token with the MoQ
permission): a token is relay-wide, publishes or subscribes or both, expires
within a year, and travels in the URL path, so it reaches access logs; there
is no namespace scope. A workspace of its own means a relay of its own. Chrome's
WebTransport over this host's WARP tunnel (MTU 1280) failed with a packet
write error until its QUIC packets were capped at 1200 bytes.

D72. The native application prepares no Devbox image; the golden's base is
`cloudflare/debian-trixie` (2026-10-06, the commit carrying this entry;
m1890, m1959, m2023). This removes D50's named custom image declaration,
not D66's golden or its tools build. Wrangler 4.145 refuses the official
name in `containers.images.devbox.image`: that field accepts only a
digest-pinned managed-registry image. Its `durable_object` application
permits no `images` map, and the golden starts the official name directly.

Measured on eval-owned throwaway Workers, Medium, internet off:

| Run | Application declaration | What the box actually booted |
|---|---|---|
| `dc2026100604100676936` | `kinu-devbox-native@sha256:b40f5a17…` | Cloudflare's `cf/production/node-24-trixie@sha256:6cef8f20…` |
| `dc20261006042135d5c0c` | no `images` map; `Container.images` answered `{}` | the same Cloudflare trixie digest |

The first run built its golden in 66.4 s. The no-image control built it in
58.0 s and started its first box in 1.17 s. Both ran the tools, native exec,
process-launch, tree-kill and trust contracts successfully. The no-image
run also drove KasmVNC's framed client through the product's desktop route:
a click changed Chromium's red page to blue, and the document refused a
foreign socket. Every Worker, application, bucket and snapshot tag of both
runs was deleted and checked absent. The first driver was interrupted while
waiting on a desktop route missing its execution context; its explicit
cleanup recovery checked the same absence. Reports are under
`/mnt/local/kinu/tmp/kinu-devbox-contracts-KbgG5B/` and `-TTRRDA/`.

The Ubuntu runtime stage, Node image copy, runtime image build helpers and
runtime image digest are deleted. The Dockerfile's `tools` target stays:
`scripts/devbox-tools.ts build` and `publish` still build it, while a golden
pipes the pinned tarball's R2 parts into its base. The 335,860,844-byte
tarball remains `d1639d06…`; the runtime-stage deletion changes no tools
stage input. The live tools contract installed that exact archive, refused
an incomplete part before extraction and reinstalled with `changed=0`.
Docker builds the distribution artifact only; no commit test builds or
starts a Docker image.

The official-base declaration also exposed an image/account coupling:
snapshot cleanup derived its account from the deleted custom image URL.
Kinu now supplies its deployment's `CLOUDFLARE_ACCOUNT_ID`. The regression
was red with an undefined account and green with the managed base. The
native fixture's snapshot deletions independently verified the same
account-scoped registry path. Fresh Vite build plus `wrangler deploy
--dry-run` passed with no Devbox image preparation: 11,860.90 KiB Total
Upload on `0657ad9af` plus this change (2026-10-06); the earlier
`ad2215476` build with the same native declaration was 11,841.24 KiB.

The deployed regression tier is `bun run gate:devbox-e2e`, now the native
container driver. Run `dc20261006045352da6d8` passed all 17 steps in 370 s
including its verified teardown: golden, declared-image inspection, tools,
exec, process launch/boot fencing, tree kill, trust, desktop click, product
snapshot/lost-snapshot/plain recovery, and eight disk-chain controls.
Those controls cover block growth/truncation and writable mmap/WAL,
compaction/deletion, a missing baseline, streaming under disk pressure,
parallel lower mounts, low-disk lazy resume, lost inventory publication,
and the next tick after a quiesce. The report is
`/mnt/local/kinu/tmp/kinu-devbox-contracts-f3aM6j/report.json` and carries
the source revision and dirty digest. Every snapshot tag, Worker,
application and bucket was absent afterwards.

Deleted: the eight local-Docker suites and their build/container/store/mmap
fixtures, plus the obsolete 2026-09-01 five-strategy driver and its
calibration-only oracle. The native contracts use the golden's actual
kernel, shim, Files clients and R2 route. A local publisher test also
claimed disk use never exceeded three windows; the loaded run exceeded
that while preserving every byte. D57 already records a soft window
overshoot of 203 MB at 40 MiB (more than three). That unmeasured scheduler
pin and its sampling helper are deleted; concurrent publication and exact
stored bytes stay checked, and the live disk-pressure row proves the
useful bounded-disk contract on an actual container.

A failed teardown health read is recorded, not a prerequisite for deletion.
The research run `dc20261006052451b68f5` hit DNS `ETIMEOUT` there; explicit
cleanup recovery removed its resources. The driver now completes the
Worker, application and bucket deletions even when health or an earlier
cleanup operation fails. The throwing-health regression was red with zero
deletions and green with all three; health retains the DNS cause in its
report. This changes no container lifetime or retry policy.

D73. Native bindings do not replace the Durable Object, and SDK 1.0 does
not supply a container-start hook (2026-10-06, m1966, m1967; the commit
carrying this entry). One object still owns one container, its SQLite,
generation, admission fence and alarms. `ctx.container.start()` starts the
guest; `exec`, PTYs, ports, `monitor` and snapshots are native methods.
There is no SDK `Sandbox` or `Container.onStart` superclass in this design.
Devbox's start boundary admits the container, configures its routes, then
awaits its restore hook inside `ctx.blockConcurrencyWhile`. Every external
operation goes through readiness; restoration and its resource admissions
remain one owner. `repair` admits tools but names missing residents through
the incident inbox (D67).

The measured gate contract is D38/D43: no request delivered inside the
native restore block in nine pending-timer controls; native-process holds
completed 9/9, while Worker-timer holds still reset behind outside timers.
The native restore budget uses a guest process, not a Worker timer. Moving
lineage selection/deletion into `Snapshots` and scopes/queues into
`operation-lanes` changes no gate or teardown fence. The hybrid,
lifecycle-generation, quiesce-order, resource-lane and registry suites
exercise these same owners.

SDK 1.0's installed README and exports were read on 2026-10-06. It supplies
`Files`, `S3Mount`/`S3Gateway`, and `DirectoryBackup`; command, PTY and
snapshot execution belong to the native binding. Devbox uses its file and
mount clients. What remains here is the product's golden builder, primary
snapshot lineage with an R2 block-delta fallback, generation-safe recovery,
supervised resident restart, rest consent, preview/desktop socket activity,
and the binding-backed S3 route (D41). Those are not SDK services. D38
already removed the old control WebSocket, ContainerProxy and both SDK
patches. D62 removed 4,041 source and 10,782 test lines of the older chain;
this change removes the separate local-image test path. There is no new
container transport or Sandbox wrapper.

D74. No DirectoryBackup leg remains to remove (2026-10-06, m1932;
the commit carrying this entry). The letter C names different designs in
two entries: D53's C was snapshots plus DirectoryBackup; D68's C is native
snapshots plus the disk chain. D68's D is vblk alone, not D53's
DirectoryBackup-alone D. The open-asks note conflated those letter labels.
Repository search of `packages/devbox` found zero `DirectoryBackup`
imports or calls; the live no-image box reported `disk-chain/2`, wrote block
deltas and recovered through that chain, not a directory archive.

The retained measurement is D53, repeated on the accepted fixture there:
224 MiB DirectoryBackup-alone save 2.125 s, small-edit save 2.430 s moving
234,891,281 bytes, and whole restore 1.131-2.063 s (n=5). At 2 GiB it took
11.8-18.6 s to download and restore the whole tree (n=2); five owner
evictions retained the prior backup and left an incomplete upload. The
owner's D55/D66 hybrid choice needs a size-independent lazy fallback and
block-sized edits. DirectoryBackup's eager whole-directory restore is not
that fallback. It stays an SDK export, not a Devbox dependency. No logged
decision is reversed and no new backup mechanism is built.

D75. Keep D66's native-snapshot primary and the current R2 fallback for this
release; s3backer, ZeroFS and JuiceFS are viable filesystems, not drop-in
replacements for that lifecycle (2026-10-06, m1967; the commit carrying
this entry). No filesystem dependency or daemon is added to the product.
ZeroFS is the next candidate worth a full fallback comparison, not a
proved improvement or an admitted replacement. D73 consolidates what
Devbox still owns beyond SDK 1.0's Files, mount and backup clients.

All three ran on eval-owned throwaway Workers, real Medium containers
forked from the pinned trixie golden, and their own R2 buckets. There was
no local Docker filesystem and no production/staging workspace. The
payload was 64 MiB of random bytes plus SQLite WAL. The three reads below
each reopened the filesystem after removing its client cache. Every data
SHA matched its original; each SQLite database reopened with row `7`.
These are small compatibility and persistence measurements, not a ranking
at the sizes the product serves. Cache geometries were not equalized, and
the object store's own cache and placement were not controlled.

| Backend, configuration | First write, ms | Explicit durability barrier, ms | Client-cache-cold attach, ms (n=3) | 64 MiB read, ms (n=3) |
|---|---:|---:|---|---|
| s3backer `1.5.4-2+b2`, 512 MiB sparse device, ext4 loop mount, 128 KiB blocks, 128 MiB cache | 155 | 53,969 | 2,749 / 2,869 / 2,536 | 26,124 / 19,870 / 13,788 |
| ZeroFS `2.3.5`, S3 metadata/data, 9P FUSE client, 1 GB disk and 0.2 GB memory cache | 2,689 | 128 | 6,099 / 6,108 / 5,026 | 2,394 / 2,076 / 1,232 |
| JuiceFS `1.4.1`, S3 data, local SQLite metadata, 1,024 MiB cache | 799 | 11 | 551 / 553 / 879 | 1,144 / 632 / 494 |

Do not treat the first s3backer write's return as durable: its subsequent
barrier carried the outstanding work. Initial ext4 formatting took
26,172 ms; the initial s3backer start was 715 ms and the loop mount 476 ms.
ZeroFS's initial server/client start was 6,054 ms. JuiceFS format took
1,475 ms and its first mount 561 ms. No row above substitutes a buffered
write's return for a persistence claim.

The runs and source evidence are in these reports. Each records its
revision and dirty digest; the code was committed as `9ec0ed074`.

- s3backer: `dc2026100606455875abb`,
  `/mnt/local/kinu/tmp/kinu-devbox-contracts-lyqbK3/report.json`.
- ZeroFS: `dc202610060625548b2e3`,
  `/mnt/local/kinu/tmp/kinu-devbox-contracts-Y3rbQK/report.json`.
- JuiceFS: `dc2026100605595892b07`,
  `/mnt/local/kinu/tmp/kinu-devbox-contracts-XNfyci/report.json`.

Every Worker, application, bucket and recorded snapshot tag was deleted
and checked absent. ZeroFS's release archive was checked against
`367b2e79…`; JuiceFS's against `01ee09a2…`. Earlier combined probes taught
two instrumentation lessons, not filesystem failures: externally
unmounting the ZeroFS FUSE client does not end its process, and a single
long HTTP wait can expire independently of guest work. The final ZeroFS
control unmounted, killed both its owned client and server, cleared their
cache, and verified data and WAL on all three starts. The final driver
ran a detached guest job and polled its recorded exit; it added no
filesystem timeout or retry policy.

Against the chosen design:

- s3backer genuinely supplies a block device, with ext4 providing POSIX,
  locking and WAL. It stores filesystem metadata in those blocks too,
  so it needs no separate database. The real kernel supported its FUSE
  and loop mounts. It adds a writable virtual device, geometry/growfs,
  cache flush and writer ownership to the box's lifecycle; its normal
  block writes do not themselves publish the box's immutable fallback
  pointer. D68 already rejected changing the primary to a virtual disk
  merely to make block tracking cheap. This small trial does not reverse
  that decision or prove a root snapshot plus s3backer eviction contract.
- ZeroFS puts metadata in an object-backed LSM and file contents in
  compressed/encrypted immutable segments. Its upstream v2.3.5 architecture
  and configuration were read: it has writer fencing, checkpoints and
  read replicas; explicit fsync seals data then flushes metadata. It is
  not dismissed as a directory archive or as lacking persistence. It
  could replace substantial custom fallback machinery. But these trials
  used direct R2 S3 credentials, not D41's binding-backed route. ZeroFS
  requires conditional puts for fencing; the current route's PUT handler
  does not apply `onlyIf`. The binding adapter, snapshot-mounted-state
  restart, complete isolation/fencing, 18 GB disk-pressure path and
  D63's long session are unproved. Admit that full comparison before
  replacing the fallback; do not ship a second filesystem beside it.
- JuiceFS is fast here and supports the required file operations. It
  separates data blocks from namespace/extent metadata. After the test
  removed its SQLite metadata database, the intact R2 data could not
  mount: `unformatted volume, please run "juicefs format" first` (n=1).
  That is the configuration tested, not a claim that JuiceFS has no
  metadata backup facility: background jobs were disabled, and metadata
  dump/restore was not tested. A root snapshot can carry the SQLite
  database, but the independent R2 fallback would still need its own
  durable metadata path. Its supported Redis/SQL/TiKV engines are not a
  supplied Cloudflare binding. Adding that owner or service is not a
  reduction of the selected snapshot/R2 design without a complete proof.

The admitted product comparator remains D68's five-run Medium workload at
0.25, 2, 10 and 18 GB, plus D63's long session. D72 reran the current
hybrid's snapshot/lost-snapshot/plain recovery, block/WAL, compaction,
missing baseline, streaming/disk-pressure, parallel mount and lost
inventory controls on real containers. None of these small filesystem
trials establishes an O(1)/O(log n) readiness bound for arbitrary metadata,
full-root package persistence, snapshot eviction, stale-writer isolation,
or a long-lived branch. Keep the design already proved; keep the ZeroFS
follow-up bounded by those same admission rows.

D76. Comparable filesystem I/O does not change D68's choice of the hybrid
(2026-10-06, m1986; the commit carrying this entry). The missing I/O rows
are now measured for D68's production chain, native snapshot root,
current hybrid, vblk and vblk-T's warm thin-pool plane, and for D75's three
libraries. This does not reopen the restore/save/reliability admission.

Real Medium trixie containers on `48316e8da`, forked from the pinned D66
golden. Every arm ran the same `io.py`: 128 MiB of incompressible bytes,
1 MiB sequential operations, 128 seeded random 4 KiB operations, 32
changed-block fsync samples, and 512 4 KiB files for each metadata pass.
Three iterations per metric. SHA-256 checked the complete file after the
writes and every random read checked its exact bytes; all eight arms were
exact. R2 was each fixture's throwaway bucket, never a user workspace.
Each container generated its own random payload; sizes, entropy class,
operation counts and random offsets were identical, not the payload hash.

These are mounted-view figures, not a cold object-store benchmark. Each
read asked Linux to discard that file's clean pages with
`POSIX_FADV_DONTNEED`; backend caches remained warm, as did lower-device
pages that the view's hint does not necessarily discard. The subsequent
hash checks also warm caches. A FUSE view, ext4 loop device, compressed
btrfs root and a local thin pool do not discard the same caches. The
high cached read figures below are not R2 transfer rates.

### Data I/O: medians of three

Sequential columns are MiB/s; random columns are operations/s. `+fsync`
includes the final fsync after the timed writes. `fsync p50` is the median
of each iteration's 32 syscall latencies after a changed 4 KiB write,
then the median of those three medians. It is a syscall-return measure,
not proof of a host-failure or R2 checkpoint durability guarantee.

| Mounted view | Seq read | Seq write return | Seq write +fsync | Random read 4 KiB | Random write return | Random write +fsync | fsync p50, ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| A: production chain `2f660875cc`, base-only overlay | 2,797.1 | 560.9 | 311.2 | 44,486 | 38,155 | 12,933 | 0.874 |
| B: native snapshot-woken btrfs root | 662.6 | 923.2 | 198.2 | 10,205 | 173,085 | 26,042 | 0.821 |
| C: hybrid after lazy recovery was made plain | 807.0 | 615.3 | 196.4 | 5,571 | 139,441 | 17,436 | 1.234 |
| D: recovered vblk-T binary, FUSE file + ext4, local cache | 4,078.9 | 1,455.9 | 199.3 | 16,667 | 308,605 | 10,933 | 1.959 |
| E: vblk-T warm layout, ext4 on local dm-thin pool | 2,736.4 | 2,028.8 | 64.8 | 19,943 | 216,736 | 4,620 | 3.551 |
| s3backer `1.5.4-2+b2`, ext4 loop | 1,800.9 | 2,900.4 | 27.6 | 7,755 | 268,383 | 6,497 | 0.102 |
| ZeroFS `2.3.5`, object-backed LSM + 9P FUSE | 72.1 | 164.2 | 19.7 | 2,367 | 261,177 | 152 | 859.211 |
| JuiceFS `1.4.1`, S3 data + local SQLite metadata | 63.5 | 414.6 | 91.4 | 7,859 | 10,434 | 65 | 273.584 |

### Small-file metadata: median operations/s

Creation includes writing and closing each 4 KiB file, not an explicit
per-file fsync. Stat, rename and unlink are separate passes over the same
512 files. A library's close/flush and namespace protocol are therefore
part of its observed creation cost; this is not a pure in-memory lookup.

| Mounted view | Create +close | Stat | Rename | Unlink |
|---|---:|---:|---:|---:|
| A: production chain | 4,477 | 34,902 | 5,321 | 6,766 |
| B: native snapshot root | 26,162 | 124,329 | 21,517 | 25,748 |
| C: hybrid made plain | 10,562 | 57,301 | 10,862 | 12,051 |
| D: vblk local cache | 20,541 | 105,783 | 26,759 | 43,965 |
| E: dm-thin warm layout | 13,315 | 86,484 | 20,794 | 32,322 |
| s3backer | 21,088 | 138,394 | 32,755 | 48,985 |
| ZeroFS | 681 | 4,537 | 918 | 1,378 |
| JuiceFS | 3.44 | 5,037 | 1,125 | 905 |

The library creation row is consequential for a development workload:
JuiceFS's three 512-file passes took 147-150 s in this configuration,
while the root's passes took about 18-24 ms. That does not condemn every
JuiceFS configuration: it names this version, cache and metadata engine,
and the close behavior of the tested mount. D75's quick sequential write
was not evidence about compiling or installing a small-file tree.

### What each arm was, and was not

- A restores `snapshotChainStorage` and its dependencies from
  `2f660875cc`. Only the adapter ports and valibot import resolution
  changed. It published a 128 MiB base to the real R2 route, then mounted
  that base through s3fs/squashfuse/fuse-overlayfs. This is a base-only
  chain, not a many-delta session, and no old container image was booted.
- B wrote its file, took a native root snapshot, destroyed the container
  and woke from that recorded snapshot before I/O. Snapshot
  `236ddf06-5ef7-4c9d-8db6-2c73935c4ebc` was deleted with the run.
- C ran the current disk-chain code, published the same-sized base,
  erased its workspace, attached the R2 lower, completed the copy, and
  admitted the plain recovered disk. It reported `recovery made plain`.
  A still-lazy, low-disk C is a different I/O plane and is not this row.
- D uses the preserved D68 `vblkt` Go binary, SHA-256 `c66fbbd1…`, copied
  read-only from the old scratch disk. Its CLI mounted a 1 GiB logical
  device with 1 MiB blocks and 1 GiB local cache, then ext4 without a
  reservation. Its initial state was generation 0. The measured writes
  and fsync target that local device/cache; no R2 generation publication
  is claimed by this I/O row. D68's cold restore/save figures remain the
  evidence for that separate path.
- E reconstructs the *warm physical layout*, not the entire old vblk-T
  checkpoint driver: a 2 GiB local pool, 16 MiB metadata, 512 KiB thin
  blocks, one thin volume and ext4 with zero reserved blocks, all on the
  native btrfs root. It measures no thin-snapshot save or R2 restore.
  Its small geometry deliberately avoids D68's disk-capacity admission;
  it cannot rebut the 18 GB ENOSPC or pinned-rewrite failures there.
- s3backer used a 1 GiB ext4-backed volume, 128 KiB blocks and a 1 GiB
  block cache. ZeroFS used a 1 GB disk cache and 0.2 GB memory cache.
  JuiceFS used a 1,024 MiB data cache and its local SQLite metadata. All
  used their own real R2 store; cache geometries are declared, not equal
  claims of “cold.” The release archives were the hashes checked in D75.

### Runs, evidence and cleanup

| Run | Measured arm | Report directory under `/mnt/local/kinu/tmp/kinu-devbox-contracts-` |
|---|---|---|
| `dc20261006123833202e1` | A | `QsqgTx` |
| `dc20261006123833235e7` | B | `jAMhN9` |
| `dc2026100612434425a92` | C | `hoMfyX` |
| `dc202610061249247c74d` | D | `ACD9Ce` |
| `dc20261006130605ec0fa` | E warm layout | `xzqKuo` |
| `dc202610061217276f2a2` | all three D75 libraries, in one container | `W2Qgzt` |

Every report has the revision, dirty digest, raw rows and cleanup result.
Each metric has three rows, each arm has an exact-byte result, and every
successful run checked its Worker, application, bucket and recorded
snapshot tags absent. Failed setup controls are recorded separately:
the native golden occasionally returned an internal error/rebuild before
I/O; two early chain controls called the wrong checkpoint method or
started before their recorded attach; one thin-pool control lacked its
container device nodes. No failed setup's numbers enter the table.

The full source and sanitized raw reports are archived off-tree at
`/mnt/local/kinu/tmp/devbox-io.TOor79/io-2026-10-06.tar.zst`, SHA-256
`973a6972175ad66394d6b1378ca6860a8ac6578e29e460d48ba464f475d2d6b1`;
`io.py` is SHA-256 `7a4bfb58…`. No measurement instrument enters the product or its
test tiers. The source methods and data shape are preserved in that
archive so these rows do not depend on the older missing h2h files.

Do not choose a backup from this table. A/B/C warm-root behavior, cache
hits and buffered writes cannot settle cold restore or checkpoint
reliability. D68 already places those above I/O, and D75 explains the
library integration and metadata obligations. The table closes m1986's
missing comparable I/O evidence; D68's decision is unchanged.

## Measurement contract for a strategy comparison

Vary stored bytes B, file count N, changed bytes D and demanded bytes Q
separately, on identical committed trees. Capture pre-admission metadata
bytes, CPU work, request count, peak memory and elapsed hook time. A request
count is not a cost. A local workerd clock is not a cloud latency. A run is
admitted only when every G gate passes; a refused run ranks nothing. The
admission code that enforced this left the tree with D27's instruments.

D77. The disk chain's deltas are a binary counter (2026-10-07, m1966b). A
recovery mounted every layer the chain held, and a rest compacted only at
eight deltas or a quarter of the base, so a box that ticked between rests
recovered through up to nine squashfuse mounts, block-lower manifests and
overlay lowers. Now each save takes in the newest layers no larger than
what it has gathered, the way a binary counter carries, and publishes one
layer cut from the boundary below them: n saves since the base are held in
at most floor(log2 n) + 1 deltas, so L <= floor(log2 n) + 2 layers.

- A merged layer is cumulative from its boundary. Its changes are the union
  of the lists its layers answer for, each path written as it is now or
  whited out if gone. Every delta carries that list
  (`.devbox-delta/paths`) and leaves it on the disk; after a recovery the
  list is read from the object. A delta from before D77 has none, so the
  save that would take it in is a base.
- The block digests of each boundary below a kept layer stay on the disk,
  so an edited block in a large file still travels as a block when a merge
  re-cuts it. A boundary without them sends its changed large files whole.
- Nothing merges into a layer a mounted recovery reads: saves on it count
  above those layers, and take them in once the copy is the workspace.
- `COMPACT_LAYERS` is gone; the quarter-of-the-base compaction at a rest
  stays. No change to `devbox-block-lower`: a merged layer is an ordinary
  layer over the ones below it.
- A delta no longer whites out a path under one that stopped being a
  directory; the archive held such a parent as both a file and a directory.

Measured off-tree (`research/d77-lsm-bench/`: the driver, results and
table), Medium, run `dc20261007175712f13ab`, before (the chain as
`integration/0965` holds it at `ff0b0a2f1`) and after (this design), n=5
recoveries per row. Each row filled a workspace (12,000 small files, a
1 GiB file, 256 MiB random fills to the size), saved a base, then 3 or
63 saves of a line, a new 4 KiB file and a 4 KiB write into the large
file; each recovery is a crashed container's cold one, timed from attach.
Medians (min–max), ms:

| size | saves | arm | layers | attach | first 4 KiB | tree walk | 64 MiB read | find loops |
|---|---:|---|---:|---:|---:|---:|---:|---:|
| 0.25 GB | 3 | before | 4 | 1,564 (843–1,842) | 612 | 1,054 | 940 | 0 |
| 0.25 GB | 3 | after | 3 | 1,223 (862–1,341) | 785 | 1,250 | 754 | 0 |
| 0.25 GB | 63 | before | 64 | 5,110 (4,980–6,524) | 893 | 1,819 | 7,350 | 7 |
| 0.25 GB | 63 | after | 7 | 1,413 (1,372–1,941) | 528 | 1,116 | 1,025 | 0 |
| 2 GB | 3 | before | 4 | 1,202 (1,085–1,456) | 472 | 1,137 | 1,891 | 0 |
| 2 GB | 3 | after | 3 | 1,414 (870–1,778) | 631 | 1,083 | 1,671 | 0 |
| 2 GB | 63 | before | 64 | 5,774 (5,301–7,977) | 1,107 | 1,845 | 15,738 | 7 |
| 2 GB | 63 | after | 7 | 1,586 (1,180–1,820) | 707 | 1,172 | 2,689 | 0 |
| 10 GB | 3 | before | 4 | 1,621 (1,391–1,669) | 689 | 1,069 | 2,131 | 0 |
| 10 GB | 3 | after | 3 | 1,510 (1,335–1,942) | 606 | 1,055 | 1,914 | 0 |
| 10 GB | 63 | before | 64 | 6,388 (4,458–9,547) | 779 | 1,996 | 15,931 | 7 |
| 10 GB | 63 | after | 7 | 1,920 (1,665–2,962) | 634 | 1,090 | 2,578 | 0 |

- At three saves the two are the same within noise. At 63, attach is 3.3
  to 3.6 times faster, a 64 MiB read of the large file 6 to 7 times, and
  the 64-lower overlay made `find` report seven file-system loops on every
  recovery (the same inode handed out twice); seven lowers made none.
- What it costs: a save's median rose 7 to 21% (681 to 828 ms at 0.25 GB,
  1,434 to 1,627 ms at 10 GB), and 63 saves moved 4.18 MB where they moved
  1.56 MB, since a merge re-sends what its layers held.
- 18 GB has no row: its base save ran out of disk on the Medium box's
  20 GB (`mksquashfs`: no space left), before either arm differed.

D78. The tools tarball is built on armada, and this machine builds no
Devbox artifact with Docker (2026-10-07, m1966b). D66's golden installs
the pinned tools tarball onto `cloudflare/debian-trixie`; D72 kept the
Dockerfile's `tools` stage to build it, the last Devbox step that needed a
local Docker engine. Now `bun scripts/devbox-tools.ts build` runs one
armada map over an environment of `cloudflare/debian-trixie`:
`tools-setup.sh` (root, once per environment) pins every Debian package to
snapshot.debian.org's `20261002T000000Z`, with priority 1001 so the base's
or the runner's newer packages are taken back to that day, installs Rust
1.93.1 from four sha256-pinned components, and fetches squashfuse 0.1.103,
bun 1.4.2, KasmVNC 1.5.0 and the Sandbox 1.0.0 shim's one layer by sha256;
`tools-build.sh` (the user) compiles the block lower for musl and
squashfuse's low-level driver, and packs as the stage did. The block
lower's sources ride in the recipe's install text, so the environment's
key covers them.

- Measured: an armada task's output is kept up to 64 MiB and refused at
  128 MiB, so the tarball comes back as 32 MiB parts from one map.
- Reproducible: two environments of different keys built the same tarball,
  `a3146b2f…`, 335,856,114 bytes (jobs `20261007173606-445ff1b2` and
  `20261007175028-8ba62822`; armada's typed API returned it again,
  `20261007180715-2240e16c`).
- Against the Docker-built `d1639d06…`: the same 377 entries; `Packages`
  and every deb byte-identical, bun and the shim byte-identical;
  `devbox-block-lower` (static-pie, same size) and `devbox-squashfuse`
  (now linked on trixie, the golden's own system, not Ubuntu 24.04) differ.
- The Dockerfile is gone. `upstream.json` pins the two scripts and the
  sources (release-config A8), and the KasmVNC pin test reads the setup
  script. armada's SDK is a GitHub dev dependency, the first in Kinu;
  install parity knows such a package by the `.bun-tag` bun writes.
- On real Medium containers with it pinned (`devbox-container-tier.ts
  --headless --tools`, run `dc20261007183233b9cfb`): the golden installs
  it, and every contract passes but the desktop client's, which drives a
  browser on the host: tools (each binary, squashfuse under an overlay,
  KasmVNC answering RFB, a truncated tarball refused, a reinstall changing
  nothing), exec, processes, kill, trust, the product chain's lost-snapshot
  recovery, and the ten disk contracts.
- Not done here: the Codex egress container still has its image, built
  with `wrangler containers build -p` on the local engine.

Amended the same day: the build is armada's `devbox-tools` task
(`armada/devbox-tools.ts`, project `kinu` in `armada.config.ts`), which
hands the whole tarball back as one output, since armada now streams an
output of any size up to 4.995 GiB into R2; the 32 MiB parts are gone. Its
recipe is the same text, and only the machine starting the build reads the
tree for it. Job `20261007220730-765aa172` returned `a3146b2f…`,
335,856,114 bytes, and a new environment (`ccdf65f8…`, job
`20261007220922-089ccf45`) built the same bytes again.

D79. A call that meets a box waiting for its base snapshot is held, not
refused (2026-10-08). After the reset deploy of `f69a2671a` to staging, the
golden was being rebuilt, and all 600 execs of the first-run case
`sandbox-exec-output` were refused `unavailable` with "the base snapshot is
being rebuilt (about 30 s); the box starts when it is ready": the agent got
a refusal to retry for a wait D66 already knows the end of. The box starts by
itself once the build verifies, so the refusal was the wrong contract.

The golden object records the step its build is at (`building` in its
state: starting the base image, reading the base, fetching, installing and
checking the tools, snapshotting the base), and its pending answer to a box
carries `building: { step }` while a build is under way, `step` null before
it begins; after a failed build it carries the build's words and no
`building`. The box keeps that answer and returns it as its readiness. The
box still arms no clock. The caller holds: the cf-backend sandbox lane
(`readinessPastBase` in `sandbox-exec-lane.ts`) asks again every second while
the readiness carries `building`, and its bound is the build's progress,
never a total. Each new step re-arms 180 s, which is past the builder's own
120 s give-up on its longest step and every fresh install measured in D66
(31.2 s at most). A build that names no new step for 180 s is refused in the
box's words with the step it stalled at; a failed build and every other
pending answer are refused at once, as before; the call's own stop ends the
hold. A notice the golden object fails to deliver is covered too: each ask
asks the golden again, which answers `ready` once one is built.
`cf-backend/tests/unit-sandbox-base-wait.test.ts` is red on the refusal and
green held; `devbox/tests/golden.test.ts` and `golden-start.test.ts` pin the
step the golden answers and the box passes on.

D80. Opening the desktop shows a desktop: a background, a panel with a
terminal and a browser to launch, and the windows open (2026-10-08). On
production (`beaf28a46`), the owner opened Env → Desktop on a fresh box and
saw a cursor on black. Nothing had failed: D70's start script brought up
Xkasmvnc and a bare openbox, the tools held no panel and no terminal, and
openbox's only way in is its right-click root menu, whose terminal entry had
nothing to run. The tier's desktop check could not see it: it launched its own
kiosk page first and clicked that.

The tools now carry tint2, xterm, `x11-xserver-utils` and
`fonts-dejavu-core` (D66: the golden installs the tarball's list, so nothing
is installed at open). The start script sets the root background and starts
tint2 after openbox, writing the panel's configuration and its two launchers
as it writes Chromium's flags; it waits for the panel's window, so the first
frame shows it. tint2 resolves a background id as it reads it, so the
backgrounds come first: named before they are defined, the panel took the
transparent background 0 and drew black (probe on armada, trixie with the
tools' packages, job `20261008203914-30819315`). The launchers sit at fixed
centres (24 and 60 px, 18 px above the foot) because the padding fixes them.

The tier's desktop step is now what a person does: a box no other contract
touched, its desktop opened through the product's client and routes with
nothing launched; within 30 s of the client's first frame the screen shows
the background a quarter in from its corner and the panel at its foot, and a
click on each launcher opens an xterm and a Chromium window in the box. Not
the screen's middle: X starts its pointer there, and the client draws it,
lightening the pixel by a quarter on either session. The foreign-socket
refusal stays. Red on the desktop production runs (run
`dc202610082057400e72f`: `{"desktop":[0,0,0],"panel":[0,0,0]}` 30 s after the
first frame, the black screen); green on this one (`dc2026100820574061df2`:
the desktop step in 5.9 s, every other contract green, cleanup verified). The tarball is `5046244c…`, 349,830,567
bytes (armada job `20261008204556-b92029c0`), 14 MB above D78's.

D81. A directory listing is one guest-side metadata read, and stat reads one entry (2026-10-09).
`Devbox.#listFiles` ran `readDirectory` once and then `lstat` once per entry, each a new
sandbox-shim process, while core's `sandboxFiles.stat` re-listed the parent to find one child.
A 72-entry directory cost 73 listings and about as many child stats; Nimbus's walk then paid
that per directory it stated, so `find /sandbox/usr/share -maxdepth 1` ran about 5,200 guest
calls in about 40 s, once per statted directory plus its parent listing.

Now one guest process (`python3`, present by the golden's own tools check) walks the directory
and returns every entry's name, type, size, mode, mtime, uid, gid, atime and ctime in one JSON
answer, and `Devbox.statFile` answers one path through the SDK's `stat`/`lstat` without touching
its siblings. Symlink types stay the link's own (lstat); POSIX errors keep their code, operation
and path in the `devbox.file` cause core classifies; every call keeps its `pathScopes` claim.

Measured on real golden containers at the tier's `file-metadata` step
(`scripts/devbox-container-tier.ts`), before and after on the same `find`:
before (test-only `df51186a7`, armada job `20261009170530-f289c0c0`):
width-1 listing 2 calls in 72 ms, width-72 listing 73 calls in 618 ms,
`find /sandbox/usr/share -maxdepth 1` 5,195-5,196 calls in 39.6-40.3 s, 3 of 3;
after (`377bb7a3`, armada job `20261009172321-bef9a18c`):
width-1 and width-72 listings 1 call each in 108 and 28 ms,
the same find 73 calls in 117-151 ms, 3 of 3, every contract green with cleanup verified.

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
