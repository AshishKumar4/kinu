# @kinu.run/devbox

Devbox presents an ephemeral Cloudflare container as a machine that stays.

A container is spot capacity. The platform recycles it between calls and the
disk comes back blank. Devbox keeps files, revives background processes, and
keeps a preview URL hostname.

Every decision in this package, with the measurement that settled it, is in
[docs/DEVBOX-DECISIONS.md](../../docs/DEVBOX-DECISIONS.md). Read it before you
change the package. The block-layer design is in
[docs/DEVBOX-BLOCK-LAYER.md](../../docs/DEVBOX-BLOCK-LAYER.md).

Devbox extends the platform's `DurableObject` and owns `ctx.container`.
It uses `Files` and `S3Mounts` from `@cloudflare/sandbox` 1.0.0-rc.1, not the
old Sandbox or Containers classes.

`example/worker.ts` is the complete standalone host: its class supplies an
R2 binding and its Durable Object binding name. The Worker exports
`DevboxSyncGateway`, `DevboxOutbound` and `DevboxStoreGateway`. The store
gateway answers the container's S3 requests from the R2 binding, so no key
pair exists in the Worker or the guest (D41).

A subclass with no store is a working box with no durability. It reports
that when it attaches.

## Lifecycle

`Devbox` owns this order:

1. Start calls the native container API and proves admission with
   `container.exec(['/bin/true'])`. A refusal records an incident and arms
   the `devboxStartup` row. A caller asking meanwhile receives the
   platform's refusal.
2. Devbox installs outbound routing, then enters its own
   `blockConcurrencyWhile` restore block. It adopts an already-restored
   instance or restores files, supervised processes and port exposures under
   one budget. A native sleeper, not a Worker timer, enforces that budget.
3. Operations wait for attachment. A failed attach refuses with its reason
   and walks one bounded recovery ladder instead of resetting the object.
4. A heartbeat renews the native inactivity deadline. Three gates must agree
   before a stop. A box no caller has used counts idle time from its start.
5. A graceful stop fences new calls and drains admitted commands and resource
   streams without a work deadline. A detached, unsupervised command still
   running refuses the stop. D35 permits stop after an unreadable process
   list exhausts its quiet-confirm window; the result names that risk. Devbox
   stops residents but retains their launch records, releases work-directory
   holders, takes the final
   checkpoint, detaches, and destroys the container. A failed commit resumes
   residents and reopens admission (D39).
6. A lifecycle failure is stored before delivery retries until the host
   accepts it.
7. `destroy` closes the box, cancels and joins starts in flight, and deletes
   startup, heartbeat and checkpoint rows before destroying the native
   container. A request that arrived before the destroy cannot reopen it.
   A later caller or host can ask for a new start (D36).

`DevboxStorage` hides durable bytes behind the three methods every strategy
needs:

```ts
interface DevboxStorage {
  attach(): Promise<AttachOutcome>;
  checkpoint(kind: 'tick' | 'quiesce'): Promise<CheckpointOutcome>;
  discard(): Promise<void>;
}
```

`attach()` takes no deadline. The one restore attempt owns the budget and
races it, so no strategy would use a deadline argument.

`lifecycle.ts` holds pure decisions. It touches no container, bucket, or clock,
so tests can pin the reasoning without the platform.

## Storage

The chain is one immutable base plus one cumulative delta, both squashfs archives
in R2, attached as lazy FUSE layers. The first checkpoint archives the work
directory. Each later checkpoint archives the overlay upper directory, including
whiteouts, into one delta replaced by atomic `PUT`. The chain never exceeds two
layers.

Attach mounts the store subtree read-only, then base, delta, and a fresh writable
upper through `squashfuse` and `fuse-overlayfs`. A changed file stored as
blocks in the delta is served by the read-only block lower in `block-lower/`.
Attach moves no bytes until a read, so it fits the container-start budget at
any work-directory size.

The atomic `PUT` lets a reader see the old delta or the new one. Devbox writes
the state record before cleanup. A crash between them leaves a complete unnamed
delta that the next attach adopts. Squashfs checks its superblock, so the mount
validates the object.

Writes land on the overlay's local upper. The container syncs it in the
background (D30): the image's `sync.js` runs the chain checkpoint every
`checkpointIntervalMs` (5 min) on the container's own shell, gated on the
upper's fingerprint, so an idle box costs one local walk per period. It asks
its Durable Object only for the record, store metadata and mount control,
over `http://devbox.internal`. `DevboxSyncGateway` binds that request to its
own box. Payloads go through `DevboxStoreGateway` and never cross the owner
object (D29). On DO recreation, Devbox rebuilds routing from the SDK's
mount-registration marker, not a second copy in its own storage (D40).

Keys are `boxes/<box>/backups/<uuid>/data.sqsh` and `…/delta.sqsh`: one chain
root per box, every generation beneath it. Key builders require a UUID, so no
key can use `..` or guess another box's key. One mount over the box root serves
every generation the box will ever publish, including one a rebase mints while
the previous generation's layers are still mounted.

A record names two generations: the one it serves, and one fallback. A rebase
writes a new generation and keeps the outgoing one. The attach that mounts the
new generation proves it, and only then does the old one become garbage. So a
restore always has a second generation to fall back to, and garbage collection
cannot remove the last proven copy before its replacement is proven.

Attach reads the two generations newest first. It compares the size the record
declares against the size the store holds, compares the layer's identity the
same way, then mounts. If the newest generation is missing, or its archive is
not the one the record describes, attach records the refusal on the state row,
promotes the fallback in one write, and serves it. The event line says which
generation recovered. If both fail, the start fails with both reasons and
deletes neither.

Each layer carries two identities. The first is the SHA-256 of the bytes that
landed. Devbox takes it while the upload streams, so it costs one CPU pass and
no buffer; later it could only be recovered by reading the whole object back.
The second is the version R2 mints for that upload and reports from every later
`head`. A byte count cannot tell one archive from another of the same length.
These can, so a same-length replacement is refused rather than mounted.

A single-request upload also hands the digest to R2, so R2 verifies the bytes it
received and reports that checksum afterwards. The Workers multipart API takes
no checksum, so a large archive has no store-side digest. The version covers
that case.

The digest decides when both sides have one: equal content is sound whatever
the versions say. The version decides only when no digest can. The order
matters because a version belongs to an upload, not to content. This chain can
re-put identical bytes, so refusing on a new version alone would reject a
healthy archive. An absent identity means UNKNOWN, never sound. A record written
before these fields existed still attaches, and learns them as its layers are
rewritten.

The archive keeps `.git`. Git metadata is the only copy of a commit that was
never pushed, and for a linked worktree the top-level `.git` file is what makes
the tree a repository. The exclude list drops only trees a lockfile or a build
can rebuild.

A pattern in that list matches at any depth, in both storage modes. Devbox
writes the patterns to an exclude file, in anchored and non-anchored form, and
runs `mksquashfs -wildcards -ef`. The patterns travel as data, never as shell
arguments. The staging-space estimate prunes the same paths, so it cannot report
less than the archive needs.

Extraction is only for local development. A store mount needs outbound
interception that plain local `wrangler dev` lacks, and extraction reads every
byte on every attach. The host allows it through `allowExtraction`, default
false. A refused mount fails its checkpoint with its own reason, and an
extract-mode record is refused at attach.

I set that default after a deployed failure. A failed mount fell back to
extraction, the box archived a base, and every later write was lost: a plain
directory has no overlay upper, so it has no changed set to archive. Two phases
later the error was `delta content lost across restore`.

A chain is written only after a mount proves its mode. Its stored attach
postcondition is strict: a chain-mode record must end as an overlay or attach
throws.

The upper layer must honour writable `MAP_SHARED` mappings, which SQLite's WAL
mode needs for its shared-memory index. `tests/workspace-mount-contract.test.ts`
holds that contract against the shipped image, and against a FUSE fixture that
refuses it, to prove the test can go red.

## Platform constraints

Restore runs once per fresh container, after native admission, inside
Devbox's `blockConcurrencyWhile` block. D38 reran D26's three controls on
the patched 0.12.9 SDK and the native API before removing the SDK patches.
Native command completion does not need a control WebSocket. Worker timers
still depend on the gate where they were created: an earlier timer can hold
a later in-block timer until the platform resets the object. The restore
budget therefore uses a native `/bin/sleep` process; cancellation kills that
process. The three deployed deadline controls ended in 5.03, 5.18 and 5.03 s.

`Files` preserves POSIX failures through the SDK's structured error.
Commands use native exec; an untimed command's cancellation is registered
before readiness, so cancelling during startup cannot launch it afterwards.
PTY input, resize and signals use the native process API. Preview requests
reach `getTcpPort(port).fetch` over HTTP inside the container.

Every operation awaits `ensureReady()`, which resolves once the work directory is
attached. A failed attach records an incident, refuses with its reason, and
recovers by one bounded ladder: ask the same container identity again at the
heartbeat cadence, then destroy and replace that identity, then refuse.
Retrying per operation would record an incident for every operation on one
broken box. The class is read from the SDK's own error codes, never from its
message text: storage exhaustion and permanent configuration refuse at once,
because asking again spends the same resource or reads the same input. Work the
attach budget abandoned is still running inside the container, where no token
here can fence it, so replacing the identity is its only cancellation.

The ladder is one durable row, `devbox:attach-recovery`, holding an owner token
and a stage. Each attempt claims the row, preserving the stage it finds; every
later write is conditional on the token still being there, and the compare and
the write sit inside one critical section. An attempt that raced a newer
attempt's success therefore changes zero rows. An unreadable row refuses the
attempt before it attaches anything, and resets itself to the terminal stage
so the refusal stays finite.

A terminal refusal keeps its stage. Clearing it would let the next eviction
restart a destructive ladder, and a box could then destroy one identity after
another. `attachNow()` is the explicit repair: it re-attempts the attach,
destroys nothing, and refuses again if the attach fails again. Any attach that
lands deletes the row.

One budget covers the whole restore: the attach, the workload restart, each
listener proof, each exposure, and the boot stamp. Wrapping `attach()` alone,
with a listener-proof window per port, lets three silent ports add about
ninety seconds while every caller waits in the readiness gate and nothing
bounds the total. Each step draws an allowance of what is left divided by the
steps still declared (every probe, exposure and the boot stamp included), so no
one step can spend what the rest still need, and nothing is reserved.

What running out of budget means depends on what is abandoned. The attach is
mid-mount, so work abandoned there is work a retry would collide with and no
token here can reach: it throws, and the recovery is to replace the container
identity. No step after the attach touches a mount, so running out there is
reported instead. The box stays attached, its specs stay, no failed port is
exposed, `unready` names what did not come back, and an agent or an explicit
`attachNow()` retries. A slow `npm run dev` costs the box its readiness and
nothing else; replacing a healthy container over it would do more harm than
the slow server. The retry is safe to repeat: the walk asks the container
before starting anything, so a process it already holds is left alone rather
than started twice.

A restored service that failed does not refuse operations, because the agent
whose server failed is the one that can repair it. It fails readiness instead.
`ready` means the attach landed and every supervised process, listener and port
came back; `unready` says which did not.

Every startup attempt owns a lifecycle generation and re-checks it after each
await, before any state write, exposure, cleanup, or release of the single-flight
entry. A container start, a replacement the heartbeat spotted, a graceful stop
and a replaced identity all turn the generation over, so an attempt the platform
abandoned publishes no readiness, files no failure, releases no successor's entry
and destroys no identity.

`fuse-overlayfs` does not expose `lowerdir`, `upperdir`, or `workdir` in
`/proc/mounts`; kernel overlay does. An earlier chain parsed `upperdir`, passed
local kernel-overlay tests, then failed deployed with `produced an overlay whose
upper directory (unnamed) does not exist`. Devbox asks the mount line only if it
is mounted and overlay-family. The strategy verifies its chosen upper directory
by direct probe and reads the delta there. A mount is the workspace's only if
its filesystem is overlay-family: `fuse.fuse-overlayfs` and `fuse.s3fs` are
distinct mechanisms, and a generic `fuse` test would read a store mount as the
workspace.

The activity lease prevents only our own inactivity sleep. I held a probe box
through an 11-minute true idle. The final tick was
`running, ping ok, armedNext, decision hold`; one heartbeat row remained
pending and no inactivity sleep occurred. The marker in the container still
vanished because the platform replaced the instance.

The heartbeat renews the native inactivity deadline, and quiesce is the
deliberate idle stop. Continuity survives replacement: each restored instance
writes a boot id under `/tmp` and mirrors it durably. A changed or missing id
increments `state.replacedCount` and restores immediately.

Devbox owns its schedule records and the platform alarm. Startup, heartbeat
and checkpoint rows re-arm while work remains; incident delivery runs until
the host accepts it. A heartbeat that finds the container stopped writes one
last tick and arms nothing (D34). The arming guard counts strictly-future
rows, not the callback currently being consumed. With no row left,
`alarm()` deletes the platform alarm.

Attach verifies a mount line and an existing writable layer before a checkpoint
can report a change. A live container once reported a successful attach with no
overlay mount; forced checkpoint returned `unchanged`, and restart found an empty
work directory.

## Tests

`bun run --cwd packages/devbox test` runs the package's Bun and workerd
suites. `bun run --cwd packages/devbox check` checks both TypeScript targets.
The package test command loads the repository's one Workers platform preload.

- `decisions.test.ts` covers restart order, port tokens, listener probes,
  incident backoff, start budgets, recovery and mount parsing.
- `supervised-lifecycle.test.ts` and `lifecycle-generation.test.ts` drive the
  real class over `support/devbox-harness.ts` and its native platform model.
  They cover generation ownership, process restoration and bounded recovery.
- `quiesce-order.test.ts` covers admission draining, resident restart and the
  delta after a first-quiesce base. `untimed-exec.test.ts` uses real local
  processes to check output, process-tree termination and early cancellation.
- `mount-route.test.ts` checks that absent or incompatible SDK registration
  markers refuse rather than replacing the container or widening its route.
- `snapshot-chain.test.ts` covers crash order, delta adoption, attach
  postconditions, unattached checkpoint refusal, archive scope, generation
  retention, and fallback recovery. Its denominator tests make an unexercised
  outcome kind fail.
- `strategy-conformance.test.ts` drives the shipped adapter through its own
  production ports over a durable store and a container disk a replacement
  blanks, dying at each commit sub-step. `workspace-mount-contract.test.ts`
  holds the mmap and WAL contract described under Storage against the real
  image.
- `scripts/bench-devbox-independence.test.ts` rejects product-core imports and
  workspace dependencies; its third test proves the check can fail.
- `workspace-resolution.test.ts` rejects `@kinu.run/*` resolving outside this
  checkout. A wrong `node_modules` can otherwise test another tree's source.

The package entry loads `cloudflare:workers`; a non-Worker test must use the
platform preload rather than replace the whole SDK.

## Benchmark fixture

`bench/` raises a real container and runs every strategy arm against one
workload (`BENCH_SELECTED_ARMS` narrows it; a generated fixture names its arms).
It is not part of a product deploy. Local `wrangler dev` lacks outbound
interception, so it is only smoke. `wrangler dev --remote` refuses Durable
Objects. A real deployment is the only route to a number.

The driver verifies each arm with short `/exec`, `/checkpoint`, `/stop`,
`/wake`, `/state`, and exact-object metadata requests. A never-attached box
measures its blank disk and is not ranked.

Routes are `/create`, `/exec`, `/write`, `/checkpoint`, `/stop`, `/wake`,
`/state`, `/ops`, `/ops/reset`, `/teardown`. Each requires
`Authorization: Bearer $BENCH_TOKEN`. An absent token refuses everything, so an
old fixture is inert.

S3 traffic bypasses the owner object. `CountingStoreGateway` serves it from the
counting binding and meters each request, including each multipart part.
Counting only the bucket binding misses this traffic; the 160 MiB native
proof made one multipart create, 33 part uploads and one completion.

A purge cannot promise an empty bucket. Pending multipart uploads count towards
emptiness, but the Workers binding cannot list them. Use a dedicated bucket with
a lifecycle rule that aborts incomplete multipart uploads.

## Independence and evidence

Devbox declares three dependencies, `@cloudflare/sandbox`, `effect` and
`valibot`, and no workspace dependency. `scripts/bench-devbox-independence.test.ts`
rejects product-core imports and `workspace:` ranges. There are no Sandbox or
Containers patches.

Every failure the package raises is one type, `DevboxError`, an Effect
`Data.TaggedError` with a `code` (D42). Inside the package failures travel in
the Effect channel; `settle` in `src/errors.ts` is the one runner.
`devboxFailure` reads a failure back after Worker RPC has dropped its class.
Kinu turns it into its own `KinuError` in one adapter,
`packages/cf-backend/src/sandbox-exec-lane.ts`.

`example/worker.ts` uses Devbox with no Kinu code. Kinu's `KinuSandbox`
(`packages/cf-backend/src/kinu-sandbox.ts`) adds product egress, previews and
incident delivery. Generic Devbox classes allow public networking;
`KinuSandbox` starts with raw internet disabled and routes HTTP and HTTPS
through the vault. Native routing uses exact-host gateway capabilities
before that fallback; `scripts/egress-interception.ts` checks both policies.
`bun scripts/bench-devbox-standalone.ts` deploys the example on its own Worker,
bucket and container application, drives one box through start, write,
delete, stop, wake and discard, and deletes everything it made.

Historical production-workerd observations from 2026-08-24, before the native cutover:
| Run | P1 | P2 | P3 | P4 | P5 | P6 |
| --- | --- | --- | --- | --- | --- | --- |
| `31158290` | 64 MiB base | wake 79 ms; deep slice 82 ms | 4,096 B committed | HTTP 200 before and after restart | heartbeat chain alive for 11 minutes; platform replaced and healed the container | workspace intact |
| `e54c7de8` | passed; no separate byte figure recorded | wake 443 ms; deep slice 72 ms | passed | passed | passed | passed |

These are two observations, not a latency distribution, and not evidence for
later source changes. The probe that took them, `scripts/sandbox-durability-probe.ts`,
left the tree with the native cutover (D41).

D38-D40 record the native API controls, stop/wake proof, byte-exact 160 MiB
read after owner eviction, and the SDK marker format used for route recovery.
