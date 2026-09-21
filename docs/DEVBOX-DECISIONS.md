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

D5. Snapshot-chain is refused full strategy admission on 2026-09-13.
Settlement run `20260913154111`, clean `fed2b9d779`, ran from
15:41:12.703 to 16:02:22.337 UTC and completed the checkpoint ladder, but
failed G3, G6 and G9. It ranks no strategy. Snapshot-chain remains the
shipped implementation; no alternative is shown better under R3.

The source manifest numbers its ten gates G0–G9, not G1–G10. These are the
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
completed segments 0–2; after the idle-policy quiesce, segments 3–4 were
refused. SQLite repetition 1 and all four second-repetition preparations
were attempted before replacement startup settled and returned “ask again”.
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
attempts were refused at initial container admission. Every one retained
the platform message “There is no container instance that can be provided
to this Durable Object, try again later”. State observations included brief
`running:true` readings, but no restore settled and the final reading was
stopped. The unchanged 55-second observation ceiling ended measurement.

| Run | Source | UTC interval on 2026-09-13 | Outcome |
| --- | --- | --- | --- |
| `20260913161007` | `c0181b5eb` | 16:10:09.351–16:11:45.088 | Eight admission incidents; no restore or workload |
| `20260913161823` | `9ae255d17` | 16:18:25.294–16:19:40.525 | Eight admission incidents; no restore or workload |
| `20260913162021` | `9ae255d17` | 16:20:22.861–16:21:40.113 | Nine admission incidents; no restore or workload |

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

The alternatives' dispositions at this settlement are:

| Candidate | Evidence | Disposition |
| --- | --- | --- |
| r2fs / s3fs workspace | Attached in 3,362 ms and preserved the marker on 2026-09-04; stopped after three ticks; sparse, hardlink and single-writer limits recorded | Not shown better; not disproven for custom FUSE designs |
| overlay-cas | 64 MiB quiesce 67,723 to 37,855 ms with 16-wide concurrency; large pending recovery over 300,000 ms; held-byte metering unreliable | Measured configuration missed the recovery bound; not a verdict on every CAS layout |
| bounded-layers | 40/40 deciding ticks in one configuration; lazy wake constant at 5 requests from 1k to 100k files but fetched bytes 495,655 to 49,609,348 | Unsettled; constant request count is not constant work |
| merkle-pack v1 | Full index read on open; 4 MiB cap refused large trees; 4/40 ticks versus chain 40/40 | Structural disadvantage for this full-index design; paged designs not judged |
| native root/extent + merkle v4 | Matched C1 lookup 1,038 to 5,183 GETs versus chain 5; dirty MAP_SHARED writes escaped FUSE; refusing them broke SQLite WAL | Not shown better on the preserved configuration |
| snapshot-chain, chunked | Local C3 and many-file proofs pass; `20260913154111` refused admission on G3, G6, G9; three post-fix attempts failed container admission | Shipped implementation; full strategy admission refused |

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
passed`, cold restore 13,839 ms — versus three attempts and 12,350 ms on
the s3fs control `b20260914074243`, and the three attempts of the earlier
control `b20260914045438`. The one-object-attempt gate under
`C3_BYTES_BOUND` is green. Errors: none; teardown `finalResidueObjects: 0`,
`finalResidueMultipartUploads: 0`. Evidence:
`bench-artifacts/block-attach/b20260914082622/` (`observations.json`,
`verdict.json`, `tail.log`) and
`bench-artifacts/teardown/b20260914082622.json`. The cold-restore delta is
noise-scale between two redrived cells, not a fix claim; what the change
removes is two of three attempts. s3fs's marker/placeholder/flush three-put
shape is retired for writes and stays for reads.

D16. The post-fix settlement run is refused at cold attach
(2026-09-14). Run `20260914220919` on clean `e060e360f` reproduced D5's
shape on the current tree — one `snapshot-chain` arm, `--decisive`,
`--fault-cuts`, seed 20260824, loop budget 8,000 ms, two repetitions —
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
six seconds and nothing else. The settlement driver and the lifecycle
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
ended with it (`packages/devbox/src/lifecycle.ts`); the timing matrix in
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
top-level `exit` terminated the persistent SDK shell" — the probe's
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
is earliest, never how fast the runner reached the parked step. One
finding on the way: bun's `expect(promise).rejects` blocks the test until
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
`unit-workspace-host-facets` 3/1 — the hosted `npm install` case is red because
upstream's installer resolves through a `LOADER.get` facet the suite's fake
loader refuses); the commit tier (lint plus every typecheck project) green. The
workerd tiers and the bundle size are unmeasured for this change.

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
