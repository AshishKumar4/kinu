# @kinu.run/devbox

Devbox presents an ephemeral Cloudflare container as a machine that stays.

A container is spot capacity. The platform can recycle it between two calls, and
the disk comes back blank. Devbox makes that container look asleep rather than
gone. Files stay. Background processes come back. A preview URL keeps its
hostname.

Devbox extends `Sandbox` from `@cloudflare/sandbox`. You use it the way you use
`Sandbox`: extend the class, override the protected hooks.

```ts
import { Devbox } from '@kinu.run/devbox';

export class MyBox extends Devbox<Env> {
  protected override get store() {
    return { binding: 'BUCKET', bucket: this.env.BUCKET };
  }
}
```

A subclass that overrides nothing is a working box with no durability. It
reports that on every call instead of pretending.

## What each part hides

**`Devbox`** hides the container lifecycle. Six things happen in an order that
matters, and the class owns the order:

1. `onStart` does nothing slow. It takes the activity lease and arms two
   schedule rows. The hook runs inside `blockConcurrencyWhile`, so anything slow
   there shares one platform cancel window with the container cold start.
2. A scheduled callback attaches the filesystem, restarts processes, and
   re-exposes ports, all outside that gate and all under a real budget.
3. Every operation waits on a readiness gate, so a caller never sees a
   half-attached or half-restored box. A failed attach refuses operations with
   its reason and re-arms the retry, instead of resetting the object.
4. A heartbeat holds the activity lease. Three gates must agree before the box
   stops.
5. A graceful stop commits a final checkpoint, disables keep-alive, then sends
   `SIGTERM`.
6. A lifecycle failure is written down before anyone is told, and delivery
   retries until the host accepts it.

**`DevboxStorage`** hides how bytes become durable. It has three methods,
because three is what the two real strategies need.

```ts
interface DevboxStorage {
  attach(): Promise<AttachOutcome>;
  checkpoint(kind: 'tick' | 'quiesce'): Promise<CheckpointOutcome>;
  discard(): Promise<void>;
}
```

`attach()` takes no deadline. The container-start hook has the budget, and
`withContainerStartDeadline` applies it around the whole attach. Neither strategy would
read a deadline argument, so neither gets one.

**`lifecycle.ts`** holds every decision as a pure function. Nothing in it
touches a container, a bucket, or a clock. A container lifecycle is hard to
drive from a test, so the reasoning is separated from the platform and the
reasoning is what the tests pin.

## Three strategies

### `snapshot-chain`

One immutable base plus one cumulative delta, both squashfs archives in R2,
attached as lazy FUSE layers.

The first checkpoint archives the whole work directory as the base. Later
checkpoints archive the overlay upper directory, which holds exactly the changed
set including whiteouts, into one delta object. Each checkpoint replaces that
object with an atomic `PUT`. The chain is always at most two layers deep, however
many checkpoints have happened.

An attach moves no bytes. The store subtree mounts read-only, `squashfuse` mounts
the base and the delta out of it, and `fuse-overlayfs` lays a fresh writable
upper on top. Bytes arrive when something reads them. An attach therefore fits
inside the container-start budget for a work directory of any size.

Two ordering rules carry the crash safety:

- The delta is replaced by an atomic `PUT`. A reader sees the old object or the
  new one.
- The state record is written before any cleanup. A crash between the `PUT` and
  the record leaves a complete delta that the record does not name yet, and the
  next attach adopts it. The `PUT` was all or nothing, and squashfs verifies its
  own superblock, so the mount is the validator.

Object keys are `backups/<uuid>/data.sqsh` and `backups/<uuid>/delta.sqsh`. A
chain id must be a UUID. Every key builder validates it, so no key can be
assembled from `..` or from another box's guess.

Extraction is the local development path and nothing else. A store mount needs
container outbound interception, which a plain local `wrangler dev` does not
have. Extraction archives and extracts whole trees, so it costs a full pass over
every byte on every attach.

The host DECLARES whether extraction is allowed, through `allowExtraction`, and
the default is false. Nothing discovers it. Where it is not allowed, a mount that
fails is a failed checkpoint carrying the mount's own reason, and an extract-mode
record is refused at attach.

That rule comes from a deployed measurement. A failed mount was converted into
extraction, the box archived a base, and every write after it was lost: a plain
directory has no overlay upper, so there was no changed set to archive. The loss
surfaced two phases later as `delta content lost across restore`. A fallback
nobody asked for is how a silent mode split gets into production.

The strategy still proves its mode by performing a mount rather than asking the
platform whether it could, so a box only writes a chain after it has mounted one.
And the persisted mode is the attach postcondition: a chain-mode record must end
as an overlay or the attach throws.

### `r2fs`

The work directory is an s3fs mount of the box prefix in R2, with a disk cache
underneath.

There is no archive and no restore. An attach is a mount, and a mount is fast
whatever the prefix holds.

The consistency rules differ from the chain, and the difference is not a detail:

- A write becomes durable when the writer closes the file. s3fs buffers the file
  locally and uploads it on release. A file still open when the container stops
  loses whatever was not closed. The chain does not have this property, because
  it archives the upper directory whether or not a handle is open.
- There is no flush-to-store call. `sync` pushes the kernel dirty pages into
  s3fs, and s3fs uploads on close. A checkpoint commits everything closed and
  cannot commit anything open. `checkpoint` therefore reports the bytes the
  prefix holds, not the bytes it moved.
- Reads come from the disk cache while the cached entity tag matches, and from
  R2 otherwise. Metadata is cached for `stat_cache_expire` seconds.
- `rename` is a copy then a delete. It is not atomic and it costs the object
  bytes.
- One writer only. Two containers on one prefix lose each other's writes.

`use_cache` is why this strategy is worth measuring. Without it, every read is
an R2 request. The option set also raises `stat_cache_expire` to 300 and
`max_stat_cache_size` to 200000, keeps `enable_noobj_cache`, raises
`multipart_size` to 16 with `parallel_count` 20, and bounds the cache with
`ensure_diskfree=1024` and `del_cache`.

The bound matters. The cache and the work directory share one container disk and
s3fs bounds the cache at nothing, so an unbounded cache fills the disk and an
unrelated write fails with ENOSPC, far from the cause.

Two options are deliberately absent, both measured on the shipped image.
`compat_dir` is not an option s3fs 1.90 accepts: passing it failed every mount
with `fuse: unknown option 'compat_dir'`, and the behaviour it asked for is the
default there anyway. Its negative, `notsup_compat_dir`, stays out because it
turns that default off, which would make a prefix written through the R2 binding
read as empty. Nothing here passes `use_path_request_style`, `url`, `ahbe_conf`
or `ro` either: the SDK supplies those after the caller's options.

### `overlay-cas`

A content-addressed overlay. The prefix's materialized `tree/` mounts read-only as
the lower, a fresh native fuse-overlayfs upper goes on top, and an attach replays
only the journal entries newer than the folded cursor, so recovery costs the
pending change rather than the whole tree.

A tick scans the upper, stages new chunk blobs, and appends one journal object per
batch of 64 entries, blob before journal. Class-A cost is then the new chunk blobs
plus `ceil(p / 64)` rather than one `PUT` per changed path. That is why the strategy
exists: an npm-shaped tick touches thousands of paths and almost none of their
bytes.

`overlay-cas.test.ts` pins that behaviour, including a red-first test that the
batching is one `PUT` per batch and not one per entry. What is not measured is the
cost on a deployed box: no deployed run has observed the batching yet.

## The attach does not belong in `onStart`

`onStart` is awaited inside `blockConcurrencyWhile`. Putting the attach there
makes a container cold start and the attach share one platform cancel window,
and when it expires the runtime resets the object.

Measured on a deployed Worker: the first operation after a stop answered 500
with `A call to blockConcurrencyWhile() in a Durable Object waited for too long.
The call was canceled and the Durable Object was reset.` A bound inside that
window does not help, because a timer set inside the block is not delivered
until the block releases. So `withContainerStartDeadline` could never fire there, and the
platform's reset happened instead.

The attach therefore runs in the `devboxStartup` schedule row. Nothing observes
a half-attached box, because every operation awaits `ensureReady()` and that is
what `ensureReady()` waits for. A failed attach records an incident, refuses
operations with the reason, and re-arms a retry at the heartbeat cadence. The
retry is a schedule rather than the next operation: retrying per operation would
record an incident per operation for one broken box.

## Ask each mechanism the question it can answer

`fuse-overlayfs` does not publish `lowerdir`, `upperdir` or `workdir` in
`/proc/mounts`. Kernel overlay does. An earlier version of the chain parsed
`upperdir` out of the mount line, which passed every local proof (those used
kernel overlay) and then failed on a deployed container with `produced an
overlay whose upper directory (unnamed) does not exist`.

So the mount line answers only what it can: is something mounted here, and is it
overlay-family. The upper directory is the path the strategy CHOSE and passed to
the mount command, and it is verified with a direct existence probe. The delta
archive reads from that same chosen path. Nothing re-derives it.

The strategies also have to be told apart by mechanism, not by family.
fuse-overlayfs reports `fuse.fuse-overlayfs` and s3fs reports `fuse.s3fs`, so a
test for `fuse` would let each strategy claim the other's box. The chain matches
`overlay` and r2fs matches `s3fs`.

## What the hold actually guarantees

Measured on a deployed container, not inferred. The activity lease keeps a box
from sleeping because of ITS OWN inactivity, and nothing more. The platform can
reclaim a container instance at any moment, and no keepalive vetoes that.

A probe held a box through an 11-minute true idle. The heartbeat chain ticked the
whole way: the last tick reported `running, ping ok, armedNext, decision hold`,
one heartbeat row pending, no inactivity sleep. The ephemeral marker inside the
container still vanished, because the instance underneath had been replaced.

So the guarantee is two things, stated separately because they have different
mechanisms:

- The box never sleeps from our own inactivity. The heartbeat renews the clock
  the SDK reads, and the quiesce decision is the only thing that stops a box on
  purpose.
- Continuity survives replacement. Each restored instance is stamped with a boot
  id under `/tmp`, mirrored in durable storage. The id dies with the instance,
  which is the whole point: a heartbeat that reads a different id, or none, knows
  the instance was replaced, counts it, and re-drives the restoration
  immediately rather than waiting for the next operation. Idle is exactly when
  nobody is watching.

`state.replacedCount` is therefore a measured fact about the platform rather than
a failure of this package, and `state.bootId` says which instance the durable
state believes it is talking to.

## A self-re-arming schedule is a chain, and chains break quietly

Three of this class's four schedule rows re-arm themselves, so each is a chain
that runs forever once started and never starts on its own. Two separate
breakages of that chain reached a deployed container.

The first: nothing armed the heartbeat initially. `devboxHeartbeat` re-arms
itself at every exit, so `onStart` is the only place a first link can be, and
without it the lease never ticked and quiesce was unreachable. `onStart` now arms
all three.

The second: the guard that made arming idempotent counted the row being
dispatched. The container SDK deletes a fired row AFTER its callback returns, so
while a callback runs its own row is still in the table. The callback asked "is a
row already pending for me", saw itself, decided it had nothing to do, and was
deleted a moment later. The guard now counts only rows scheduled strictly in the
future, so the firing row never suppresses its own successor.

The third, which is not a chain break but ends the same way: `setKeepAlive(true)`.
The container alarm loop is one self-perpetuating chain, and its activity branch
is the one place that returns without setting the next alarm. With keepAlive on,
`onActivityExpired` only logs, so an idle box expires its clock, is not stopped,
sets no alarm, and goes quiet with its rows unreachable. keepAlive is never
enabled here. The heartbeat renews the activity clock the SDK actually reads, and
`onActivityExpired` is overridden to take a final checkpoint before letting the
container stop.

All three are pinned, and a durable tick row (`state.lastTick`) records what each
heartbeat saw, because from outside these three failures look identical.

## Both strategies must prove their own attach

A live container once reported every step of an attach as fine while
`/proc/mounts` held no overlay line for the work directory. A forced checkpoint
then answered `unchanged`, and after a restart the work directory was empty.
Nothing threw.

So an attach reads its result back from the kernel. It needs a mount line and a
writable layer that exists. A checkpoint asks whether the directory is attached
before it asks whether anything changed, so a box that is not attached reports a
failure rather than `skipped`. A commit reports a byte count, so a caller can
check that number against the store.

## The change gate needs a baseline

`checkChanges` answers whether a path changed since the version you hold. A box
that has never checkpointed holds no version, and the SDK answers a call with no
`since` as `unchanged`. It is establishing a baseline, not reporting on one.

Consulting the gate there is how a fresh box writes files, stops, and saves
nothing while every call reports success. Devbox reproduced that against a real
container. With no baseline, content counts as a change, and the only remaining
question is whether the directory holds anything at all.

## Tests

`bun test packages/devbox` runs six suites. Three things about them hold whatever
the count is: every suite passes, every suite also passes standalone, and the six
standalone counts sum to exactly the directory total. `bunx tsc --noEmit -p
packages/devbox` exits 0.

The count itself is 170, at 2026-08-25T07:28Z. It is deliberately not pinned to a
commit. This package sits in an uncommitted worktree, so two people can measure
the same hash a minute apart and get 163 and 170, which happened while this file
was being written. A hash identifies committed state and nobody here is measuring
committed state, so the clock is the only honest anchor and the number moves as
siblings land.

- `decisions.test.ts` pins every pure rule at its boundary: the quiesce timing
  matrix, restart ordering, port tokens, listener probes, incident backoff, the
  start budget, mount parsing, UUID refusals, and the interval gate.
- `snapshot-chain.test.ts` drives the chain through fake ports. It asserts the
  crash ordering, delta adoption, the two attach postconditions, and the
  unattached-checkpoint refusal. Its last two tests assert a denominator, so
  adding an outcome kind without exercising it turns the suite red.
- `overlay-cas.test.ts` pins the content-addressed overlay: the journal fold, the
  replay cursor, chunk staging, and the blob-before-journal ordering.
- `r2fs.test.ts` does the same for the mount strategy.
- `independence.test.ts` reads the files on disk and fails if `src` or `bench`
  imports the product core, or if the manifest declares any workspace dependency.
  Its third test proves the check can fail, against a specifier that must be
  caught.
- `workspace-resolution.test.ts` fails if `@kinu.run/*` resolves outside this
  checkout. Every package here carries it, because the failure is silent: a
  checkout whose `node_modules` points at another one runs green while testing
  the other tree's source.

The suites import the modules directly rather than the package index, because
the index pulls in the `Sandbox` runtime and `cloudflare:workers`, which does not
exist outside a Worker. That the decisions run without the platform is the point
of separating them.

## The benchmark fixture

`bench/` holds a Worker that raises a real container and runs both strategies
against one workload. It is not part of any product deploy.

`wrangler dev` gives a local container, a local store, and no outbound
interception. That is enough for a smoke test and it is not a measurement.
`wrangler dev --remote` refuses Durable Objects, so a real deployment is the only
route to a number.

`POST /verify` runs the lifecycle and checks the four facts above. Run it before
any workload. An arm that measures a box which never attached is measuring the
container's own blank disk.

Routes: `/create`, `/verify`, `/exec`, `/write`, `/checkpoint`, `/stop`,
`/wake`, `/state`, `/ops`, `/ops/reset`, `/teardown`. Every route needs
`Authorization: Bearer $BENCH_TOKEN`. An absent token refuses everything, so a
fixture that outlives its run is inert.

Two facts about the op counter, both measured the hard way. s3fs traffic does not
go through the Durable Object binding, so the `ContainerProxy` env is the only
place that sees every call. And `uploadPart` and `complete` are calls on the
handle that `createMultipartUpload` returned, so a wrapper that stops at the
bucket reported two class-A operations for a phase that wrote 111 MiB.

A purge cannot promise an empty bucket. Pending multipart uploads count towards
emptiness and the Workers binding cannot list them. Use a dedicated bucket with
a lifecycle rule that aborts incomplete multipart uploads.

## Independence

Devbox declares no dependency on any workspace package. Its three declared
dependencies are `@cloudflare/sandbox`, `@cloudflare/containers` and `valibot`.
`independence.test.ts` enforces that by reading the source and the manifest: it
refuses any import of the product core's scope and any `workspace:` range, and it
reads the forbidden scope out of the sibling manifest rather than writing it down,
so a rename cannot leave the guard checking a name nothing uses.

The vendored patch `patches/@cloudflare%2Fsandbox@0.12.8.patch` applies here too.
It makes the SDK merge `outboundHandlers` instead of assigning them, so
configuring a bucket mount cannot unbind a handler the host installed.

## What is proven and measured

Every rule above is pinned by a unit test. Two deployed production-workerd runs
of `bun scripts/sandbox-durability-probe.ts --run` passed all six phases on
2026-08-24.

| Run | P1 | P2 | P3 | P4 | P5 | P6 |
| --- | --- | --- | --- | --- | --- | --- |
| `31158290` | 64 MiB base | wake 79 ms; deep slice 82 ms | 4,096 B committed | HTTP 200 before and after restart | heartbeat chain alive for 11 minutes; platform replaced and healed the container | workspace intact |
| `e54c7de8` | passed; no separate byte figure recorded | wake 443 ms; deep slice 72 ms | passed | passed | passed | passed |

These are two observations from the deployed builds that ran them. They do not
measure a latency distribution or later source changes. The product probe now
writes the complete JSON record for every future attempt under the ignored
`bench-artifacts/` directory, including partial evidence and the error when a
phase fails.

The source still records older failure observations that explain the policies.
They are not performance numbers. `onStart` in `src/devbox.ts` records an
11-minute idle with keep-alive on where the box slept. `#stampBootId` records a
platform replacement underneath a healthy heartbeat chain. The
`allowExtraction` reasoning in `src/snapshot-chain.ts` records a mount failure
converted into extraction that lost every write after the base. The
`ContainerProxy` note in `bench/worker.ts` records a wrapper that reported two
class-A operations for a phase that wrote 111 MiB.
