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
It uses `Files` and `S3Mount` from `@cloudflare/sandbox` 1.0.0, not the
old Sandbox or Containers classes. The host's container runs on the
`durable_object` scheduling policy: each start names the image (`devbox` in the
container's `images` map) and the instance size the box records (D50).

A box starts at its own choice of size (`resize`), else the default its host
stored (`useDefaultSize`), else the class's `defaultSize`. `resize` restarts
a running container at a new size and `resize(null)` drops the choice;
`useDefaultSize` only records, so a running container keeps its size until it
next starts.

`example/worker.ts` is the complete standalone host: its class supplies an
R2 binding and its Durable Object binding name. The Worker exports
`DevboxOutbound` and `DevboxStoreGateway`. The store
gateway answers the container's S3 requests from the R2 binding, so no key
pair exists in the Worker or the guest (D41).

A subclass with no store is a working box with no durability. It reports
that when it attaches.

## Lifecycle

`Devbox` owns this order:

1. Start calls the native container API and proves admission with
   `container.exec(['/bin/true'])`. A refusal records an incident and arms
   the `devboxStartup` row. A caller asking meanwhile receives the
   platform's refusal. A refusal the recovery ladder classes terminal is
   recorded with the start's image, size and internet setting; until one of
   them changes or a caller asks with `start()` or `attachNow()`, requests
   get that refusal (code `refused`) and nothing starts or is filed again,
   and `boxSize()` reports it. The refusal names no action: the host tells
   its own readers what they can do (D52).
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
   retains residents' launch records, takes the final checkpoint and the rest
   snapshot beside the running processes, and stops the container. A failed
   commit leaves the box running and reopens admission (D39).
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

The workspace is the container's own disk (D55). Two copies keep it:

- At each rest, after the final commit, Devbox takes a platform snapshot of the
  container (`snapshotContainer`). The next start wakes from it with the disk as
  it was, excluded folders and all. A snapshot is used only on the image that
  took it, only when the chain has not moved past it, and only within 29 of its
  30 days. A snapshot start that fails, or is not admitted within
  `snapshotWakeCutoverMs` (10 s), is destroyed and replaced by an image start.
- The disk chain (`src/disk-chain.ts`) is the R2 backup. The first save
  streams the work directory as one squashfs base (D57, D58). Each later save
  finds what changed since the last save by comparing file inventories and
  publishes those files, with whiteouts for deletions, as one more layer. A
  rest compacts the chain into a new base once the deltas outgrow a quarter of
  the base or reach eight layers.

An image start with a chain record recovers lazily inside the start gate: the
layers mount through `squashfuse` under one `fuse-overlayfs` with a writable
upper, and a background copy writes them to disk. The next start merges the
upper into the copy and the workspace is plain disk again. The recovery records
an incident saying when the workspace was restored to and which excluded
folders (`node_modules`, caches, build output) must be rebuilt.

Keys are `boxes/<box>/backups/disk/<uuid>/base.sqsh` and
`…/delta-<n>-<uuid>.sqsh`: one root per box, read through one store mount. The
record is written only after the object's size is read back from the store and
the layer reads back as a squashfs, so a record never names a torn layer. A
superseded generation is deleted after the new record lands.

The archive keeps `.git`. Git metadata is the only copy of a commit that was
never pushed. The exclude list drops only trees a lockfile or a build can
rebuild; a class overrides `archiveExcludes` to keep one.

The upper layer of a recovery must honour writable `MAP_SHARED` mappings, which
SQLite's WAL mode needs for its shared-memory index.
The real-container deploy tier checks mmap and WAL on the golden's actual
lazy recovery mount (`bench/disk-contracts.ts`, D72).

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

## Tests

`bun run --cwd packages/devbox test` runs the package's Bun and workerd
suites. `bun run --cwd packages/devbox check` checks both TypeScript targets.
The package test command loads the repository's one Workers platform preload.

- `decisions.test.ts` covers restart order, port tokens, listener probes,
  incident backoff, start budgets, recovery and mount parsing.
- `supervised-lifecycle.test.ts` and `lifecycle-generation.test.ts` drive the
  real class over `support/devbox-harness.ts` and its native platform model.
  They cover generation ownership, process restoration and bounded recovery.
- `quiesce-order.test.ts` covers admission draining, resident restart and a
  wake from the rest snapshot. `untimed-exec.test.ts` uses real local
  processes to check output, process-tree termination and early cancellation.
- `mount-route.test.ts` checks that an owner evicted over its running container
  rebinds the SDK's registration marker, or needs none when nothing is mounted,
  and that an incompatible marker, or a mount with none, refuses once rather
  than replacing the container or widening its route (D47).
- `scripts/devbox-container-tier.ts` runs the native process, kill, exec,
  trust, tools and desktop contracts on an eval-owned throwaway Worker and
  golden container; it deletes the Worker, application, bucket and snapshots.
- `hybrid.test.ts` covers the rest snapshot and every wake that cannot use
  it: a stalled or lost snapshot, a moved chain, another image, a refused
  snapshot. The deploy tier runs the real disk chain against R2, with exact
  lazy and plain recovery, compaction, block deltas and disk-pressure controls.
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

`example/worker.ts` uses Devbox with no Kinu code. Kinu's `KinuDevbox`
(`packages/cf-backend/src/kinu-devbox.ts`) adds product egress, previews and
incident delivery. Generic Devbox classes allow public networking;
`KinuDevbox` starts with raw internet disabled and routes HTTP and HTTPS
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
