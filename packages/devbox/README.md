# @kinu.run/devbox

Devbox presents an ephemeral Cloudflare container as a machine that stays.

A container is spot capacity. The platform recycles it between calls and the
disk comes back blank. Devbox keeps files, revives background processes, and
keeps a preview URL hostname.

Devbox extends `Sandbox` from `@cloudflare/sandbox`:

```ts
import { Devbox } from '@kinu.run/devbox';

export class MyBox extends Devbox<Env> {
  protected override get store() {
    return { binding: 'BUCKET', bucket: this.env.BUCKET };
  }
}
```

A subclass with no overrides is a working box with no durability. It reports
that on every call.

## Lifecycle

`Devbox` owns this order:

1. `onStart` takes the activity lease and arms two schedule rows. It does no
   slow work because it runs inside `blockConcurrencyWhile`.
2. A schedule attaches the filesystem, restarts processes, and re-exposes ports
   outside that gate under a real budget.
3. Operations wait on readiness. A failed attach refuses with its reason and
   re-arms its retry instead of resetting the object.
4. A heartbeat holds the lease. Three gates must agree before a stop.
5. A graceful stop checkpoints, disables keep-alive, then sends `SIGTERM`.
6. A lifecycle failure is stored before delivery retries until the host accepts
   it.

`DevboxStorage` hides durable bytes behind the three methods its two strategies
need:

```ts
interface DevboxStorage {
  attach(): Promise<AttachOutcome>;
  checkpoint(kind: 'tick' | 'quiesce'): Promise<CheckpointOutcome>;
  discard(): Promise<void>;
}
```

`attach()` takes no deadline. The container-start hook owns the budget and
`withContainerStartDeadline` wraps the whole attach. Neither strategy would use
a deadline argument.

`lifecycle.ts` holds pure decisions. It touches no container, bucket, or clock,
so tests can pin the reasoning without the platform.

## Storage strategies

### `snapshot-chain`

The chain is one immutable base plus one cumulative delta, both squashfs archives
in R2, attached as lazy FUSE layers. The first checkpoint archives the work
directory. Each later checkpoint archives the overlay upper directory, including
whiteouts, into one delta replaced by atomic `PUT`. The chain never exceeds two
layers.

Attach mounts the store subtree read-only, then base, delta, and a fresh writable
upper through `squashfuse` and `fuse-overlayfs`. It moves no bytes until a read,
so it fits the container-start budget at any work-directory size.

The atomic `PUT` lets a reader see the old delta or the new one. Devbox writes
the state record before cleanup. A crash between them leaves a complete unnamed
delta that the next attach adopts. Squashfs checks its superblock, so the mount
validates the object.

Keys are `backups/<uuid>/data.sqsh` and `backups/<uuid>/delta.sqsh`. Key
builders require a UUID, so no key can use `..` or another box's guess.

Extraction is only for local development. A store mount needs outbound
interception that plain local `wrangler dev` lacks, and extraction reads every
byte on every attach. The host declares permission through `allowExtraction`,
default false. A refused mount fails its checkpoint with its own reason, and an
extract-mode record is refused at attach.

I set that default after a deployed failure. A failed mount fell back to
extraction, the box archived a base, and every later write was lost: a plain
directory has no overlay upper, so it has no changed set to archive. Two phases
later the error was `delta content lost across restore`.

A chain is written only after a mount proves its mode. Its stored attach
postcondition is strict: a chain-mode record must end as an overlay or attach
throws.

### `r2fs`

`r2fs` mounts the box's R2 prefix with s3fs over a disk cache. It has no archive
or restore. Attach is a mount, so it is fast whatever the prefix holds.

- A write becomes durable when the writer closes it. s3fs buffers locally and
  uploads on release. An open file loses unclosed data when the container stops.
  The chain can archive its upper directory with an open handle.
- `sync` pushes dirty pages into s3fs, but s3fs uploads only on close. A
  checkpoint commits closed files, never open files, and reports bytes held in
  the prefix rather than bytes moved.
- Reads use cache while the entity tag matches, then R2. Metadata caches for
  `stat_cache_expire` seconds.
- `rename` copies then deletes. It is not atomic and costs object bytes.
- One prefix has one writer. Two containers on it lose each other's writes.

`use_cache` avoids an R2 request for every read. The options set
`stat_cache_expire=300`, `max_stat_cache_size=200000`, `enable_noobj_cache`,
`multipart_size=16`, `parallel_count=20`, `ensure_diskfree=1024`, and
`del_cache`. The cache and work directory share one disk. s3fs sets no cache
limit, so an unbounded cache fills the disk and an unrelated write fails with
ENOSPC.

The shipped s3fs 1.90 rejects `compat_dir` with
`fuse: unknown option 'compat_dir'`; its requested behaviour is already the
default. `notsup_compat_dir` disables that default, making an R2-binding-written
prefix read empty. The SDK adds `use_path_request_style`, `url`, `ahbe_conf`,
and `ro` after caller options, so Devbox does not pass them.

### `overlay-cas`

`overlay-cas` mounts its materialized `tree/` read-only as a lower layer and a
fresh native fuse-overlayfs upper over it. Attach replays only journal entries
newer than the folded cursor, so recovery costs the pending change.

A tick scans the upper, stages chunk blobs, then appends one journal object per
batch of 64 entries, blob before journal. Class-A cost is new blobs plus
`ceil(p / 64)`, not one `PUT` per changed path. This suits npm-shaped ticks that
touch thousands of paths but few bytes.

`overlay-cas.test.ts` red-tests one `PUT` per batch. The deployed cost remains
unmeasured: no deployed run has observed batching.

## Platform constraints

`onStart` runs inside `blockConcurrencyWhile`. I measured a deployed Worker
where its first operation after a stop answered 500:
`A call to blockConcurrencyWhile() in a Durable Object waited for too long.
The call was canceled and the Durable Object was reset.` A timer inside that
block cannot fire until the block releases, so `withContainerStartDeadline`
could not help. Attach runs in the `devboxStartup` schedule row instead.

Every operation awaits `ensureReady()`. A failed attach records an incident,
refuses with its reason, and re-arms a heartbeat-cadence schedule. Per-operation
retry would record an incident for every operation on one broken box.

`fuse-overlayfs` does not expose `lowerdir`, `upperdir`, or `workdir` in
`/proc/mounts`; kernel overlay does. An earlier chain parsed `upperdir`, passed
local kernel-overlay tests, then failed deployed with `produced an overlay whose
upper directory (unnamed) does not exist`. Devbox asks the mount line only if it
is mounted and overlay-family. The strategy verifies its chosen upper directory
by direct probe and reads the delta there. Chain matches `overlay`; r2fs matches
`s3fs`, because `fuse.fuse-overlayfs` and `fuse.s3fs` are distinct mechanisms.
A generic `fuse` test would let either strategy claim the other's box.

The activity lease prevents only our own inactivity sleep. I held a probe box
through an 11-minute true idle. The final tick was
`running, ping ok, armedNext, decision hold`; one heartbeat row remained
pending and no inactivity sleep occurred. The marker in the container still
vanished because the platform replaced the instance.

The heartbeat renews the SDK clock, and quiesce is the only deliberate stop.
Continuity survives replacement: each restored instance writes a boot id under
`/tmp` and mirrors it durably. A different id, or no id, increments
`state.replacedCount` and restores immediately. `state.bootId` identifies the
instance the durable state expects. Replacement is a platform fact, not a
package failure.

Three of four schedule rows re-arm themselves. A broken chain does not restart
itself. Devbox now arms all three initial rows because `devboxHeartbeat` cannot
supply its own first link. Its idempotence guard counts only strictly-future
rows: the SDK retains a fired row until its callback returns, so counting the
active row used to suppress its successor.

Devbox never enables `setKeepAlive(true)`. The SDK alarm loop's activity branch
returns without an alarm. With keepAlive on, `onActivityExpired` logs, then an
idle box expires, stops neither itself nor its alarm, and leaves unreachable
rows. Devbox renews the SDK clock and overrides `onActivityExpired` to make a
final checkpoint before stop. `state.lastTick` records each heartbeat because
these failures look the same from outside.

Attach verifies a mount line and an existing writable layer before a checkpoint
can report a change. A live container once reported a successful attach with no
overlay mount; forced checkpoint returned `unchanged`, and restart found an empty
work directory.

`checkChanges` also needs a baseline. The SDK returns `unchanged` without
`since`, but a never-checkpointed box has no baseline. I reproduced a fresh box
that wrote files, stopped, and saved nothing while every call succeeded. Without
a baseline, content counts as change.

## Tests

`bun test packages/devbox` runs six suites. `bunx tsc --noEmit -p
packages/devbox` exits 0. Each suite passes standalone and their standalone
counts equal the directory total.

The count is 170, at 2026-08-25T07:28Z. It is not tied to a commit: this
uncommitted worktree produced 163 and 170 for the same hash one minute apart
while this file was written. The count changes as siblings land.

- `decisions.test.ts` pins quiesce timing, restart order, port tokens, listener
  probes, incident backoff, start budget, mount parsing, UUID refusals, and the
  interval gate.
- `snapshot-chain.test.ts` covers crash order, delta adoption, attach
  postconditions, and unattached checkpoint refusal. Its denominator tests make
  an unexercised outcome kind fail.
- `overlay-cas.test.ts` covers journal folding, replay cursor, chunk staging,
  and blob-before-journal order. `r2fs.test.ts` covers the mount strategy.
- `independence.test.ts` rejects product-core imports and workspace dependencies;
  its third test proves the check can fail.
- `workspace-resolution.test.ts` rejects `@kinu.run/*` resolving outside this
  checkout. A wrong `node_modules` can otherwise test another tree's source.

Suites import modules rather than the package index. The index loads `Sandbox`
and `cloudflare:workers`, neither available outside a Worker.

## Benchmark fixture

`bench/` raises a real container and runs both strategies against one workload.
It is not part of a product deploy. Local `wrangler dev` lacks outbound
interception, so it is only smoke. `wrangler dev --remote` refuses Durable
Objects. A real deployment is the only route to a number.

Run `POST /verify` before any workload. It checks the four facts above; a
never-attached box only measures its blank disk.

Routes are `/create`, `/verify`, `/exec`, `/write`, `/checkpoint`, `/stop`,
`/wake`, `/state`, `/ops`, `/ops/reset`, `/teardown`. Each requires
`Authorization: Bearer $BENCH_TOKEN`. An absent token refuses everything, so an
old fixture is inert.

s3fs traffic bypasses the Durable Object binding, so `ContainerProxy` is the
only place that sees every operation. `uploadPart` and `complete` are methods on
the handle from `createMultipartUpload`; wrapping only the bucket reported two
class-A operations for a phase that wrote 111 MiB.

A purge cannot promise an empty bucket. Pending multipart uploads count towards
emptiness, but the Workers binding cannot list them. Use a dedicated bucket with
a lifecycle rule that aborts incomplete multipart uploads.

## Independence and evidence

Devbox declares three dependencies, `@cloudflare/sandbox`,
`@cloudflare/containers`, and `valibot`, and no workspace dependency.
`independence.test.ts` rejects product-core imports and `workspace:` ranges. It
reads the forbidden scope from a sibling manifest, so a rename cannot leave a
dead guard.

`patches/@cloudflare%2Fsandbox@0.12.8.patch` makes the SDK merge
`outboundHandlers` rather than assign them. A bucket mount cannot then unbind a
host handler.

Every rule above has a unit test. Two deployed production-workerd runs of
`bun scripts/sandbox-durability-probe.ts --run` passed all six phases on
2026-08-24.

| Run | P1 | P2 | P3 | P4 | P5 | P6 |
| --- | --- | --- | --- | --- | --- | --- |
| `31158290` | 64 MiB base | wake 79 ms; deep slice 82 ms | 4,096 B committed | HTTP 200 before and after restart | heartbeat chain alive for 11 minutes; platform replaced and healed the container | workspace intact |
| `e54c7de8` | passed; no separate byte figure recorded | wake 443 ms; deep slice 72 ms | passed | passed | passed | passed |

These are two observations, not a latency distribution or evidence for later
source changes. The probe writes each later JSON record under ignored
`bench-artifacts/`, including partial evidence and the phase error.

The source keeps the earlier failure records behind these policies: `onStart` in
`src/devbox.ts`, `#stampBootId`, the `allowExtraction` reasoning in
`src/snapshot-chain.ts`, and the `ContainerProxy` note in `bench/worker.ts`.
