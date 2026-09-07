# Lazy page-in and clean eviction — measured, 2026-09-03

Lane 4 of the smart-container design: hydrate on first touch, evict clean
bytes, wake pays for what changed. This file states what a wake cost before
this lane and what it costs after, on the exact tree shapes the conformance
machine (`tests/strategy-conformance.test.ts`) uses, so the numbers are
reproducible by running that suite rather than trusted on their own.

## The measured facts this lane built on

- The O(k) fence shipped: 196,608 bytes staged, 7 ms, at a 4 MiB tree AND a
  419 MiB tree (`MEASUREMENTS.md`, dated 2026-09-02).
- R2 range GET measured 95-146 MiB/s with sufficient parallelism; a 1 MiB
  hydrate window wants 16-64 requests in flight (same source). This is why
  `HYDRATE_PAGE_BYTES` (`src/durability/contracts.ts`) is 1 MiB: 64 KiB and
  1 MiB cost the same ~50-60 ms per request (latency-bound), while 8 MiB
  multiplies the bytes one miss moves by eight.
- Cells 6.13 and 6.14 are the bar: restore ops must stop scaling with total
  files; wake's remote operations must meet the bound.

## Before, 2026-09-02

Recorded in `tests/support/conformance-bug-list.ts` on the tree at
`origin/main 6d19d50e7`, from the same cells measured below:

| Arm | Cell | `RestoreWork.totalRemoteOps` | Bound |
|---|---|---|---|
| bounded-layers | 6.13 (1e3 files) | 2,006 | same as 1e5 |
| bounded-layers | 6.13 (1e5 files) | 200,006 | same as 1e3 |
| merkle-pack | 6.13 (1e3 files) | 4 | same as 1e5 |
| merkle-pack | 6.13 (1e5 files) | 5 | same as 1e3 |
| bounded-layers | 6.14 (1 GiB sparse + 64 MiB dense) | 266 | ≤ 3 |
| merkle-pack | 6.14 (1 GiB sparse + 64 MiB dense) | 6 | ≤ 3 |

bounded-layers' 200,006 was one object read per file on restore plus one HEAD
per closure object at attach — every file in the tree, both ways. merkle-pack
V2's 5 was one whole-pack read per ledger pack at attach, tracking pack count
rather than file count but still walking the store instead of the manifest.

## After, 2026-09-03

Measured by driving `tests/support/strategy-machine.ts`'s `CONFORMANCE_ARMS`
through the identical fixtures cells 6.13 and 6.14 build
(`generatedTree({ seed: 5, files, bytesPerFile: 16 })` for 6.13,
`gigabyteTree()` for 6.14), reading `arm.work().restore` right after
`wake()`:

| Arm | Cell | `RestoreWork.totalRemoteOps` | Bound | Result |
|---|---|---|---|---|
| bounded-layers | 6.13 (1e3 files) | 5 | same as 1e5 | pass |
| bounded-layers | 6.13 (1e5 files) | 5 | same as 1e3 | pass |
| merkle-pack | 6.13 (1e3 files) | 3 | same as 1e5 | pass |
| merkle-pack | 6.13 (1e5 files) | 3 | same as 1e3 | pass |
| bounded-layers | 6.14 (1 GiB sparse + 64 MiB dense) | 5 | ≤ 3 | still red |
| merkle-pack | 6.14 (1 GiB sparse + 64 MiB dense) | 3 | ≤ 3 | pass |

**200,006 → 5, constant across a 100x file-count change.** bounded-layers'
wake now costs exactly what `open()` reads — the root document and one base
layer — regardless of whether the tree holds 1,000 files or 100,000. The
100x-larger tree shows up only in bytes moved (the layer document lists every
file's metadata, so it is itself O(files) in size — a pre-existing property
of the format, not a remote-operation count, and outside this lane's scope,
which is stated in terms of `totalRemoteOps` exactly as cell 6.13 checks it),
never in operation count: `metadataBytes` + `payloadBytes` for the 1e5-file
wake is 49,609,348 bytes against 495,655 for 1e3 — a ~100x byte ratio riding
on a 1x operation-count ratio.

**5 → 3, merkle-pack's wake now clears the O(1) bound cell 6.14 states.**
Both cells' eviction round-trip (`evictCleanBytes` then a full-tree re-read)
passes for merkle-pack at both fixtures.

**bounded-layers' 266 → 5, a 53x reduction, but still 2 ops over the O(1)=3
bound cell 6.14 states.** The 5 ops are: one GET of the envelope object
(`runControl`, read to learn the current head before anything is verified),
the v1 control plane's attach-time `verifyObject` on `rootObject` and
`closureObject` (2 HEAD checks, unrelated to this lane — they predate lazy
restore and exist to catch a broken box before opening it), and
`openBoundedLayers`' own root-plus-one-base-layer range read (2 GETs, what
the "manifest and the ledger" phrase in the design means for this format).
Dropping the `closureObject` check would clear the bound — it verifies GC
bookkeeping integrity, not anything the read path consults, since `open()`
never reads the closure object at all — but that check is a pre-existing
safety property outside "lazy page-in and clean eviction," so it stays, and
`bounded-layers`/6.14 stays on the bug list with this reason.

## What changed to get there

1. **`src/candidates/residency.ts` (new).** One `Residency` class: a
   registered file is a placeholder — length and hole geometry known, no
   bytes local — until something reads it. A read pages in the coalesced
   run of missing 1 MiB windows it crosses; a hole under a window costs
   nothing. Reports `HydrateWork` (page-in) and `GcWork` (the eviction
   sweep), the two counted rows the v2 durability contract already declared
   for this lane.
2. **`src/candidates/lazy-restore.ts` (new).** `LazyRestore` wraps a
   `Residency` over any codec's read surface (`stat`/`readdir`/`extents`/
   `readRange` — the shape both merkle-pack/v2 and bounded-layers already
   serve), handing out one directory's children at a time as placeholders.
3. **`src/candidates/bounded-layers.ts`.** `headFilesystemOf()` adapts an
   opened `BoundedLayers` root to that surface at zero extra remote cost —
   `open()` already resolved every entry's metadata in memory. Added
   `extents()` (geometry from the chunk list, no chunk read) and a
   `HydrateWork` row on `readRange` amplification.
4. **`src/candidates/control.ts`.** The v1 attach path stopped walking the
   closure (`verifyEnvelopeClosure`, one HEAD per member) and instead
   verifies only `rootObject` and `closureObject`
   (`verifyEnvelopeHead`) — the closure walk was the other half of
   bounded-layers' 200,006, and every payload read is already
   digest-verified by `readCandidateRange`, so a lost chunk now refuses at
   the page-in that needs it.
5. **`bench/sidecar/core.ts`.** `SidecarCore.restoreLazily()` (additive;
   `materialize()` stays for a caller that wants the whole tree now),
   `evictClean()`, `hydration()`. Merkle-pack/v2's attach already read only
   the root record; this is what serves the rest of the tree lazily instead
   of materializing it.
6. **`tests/support/strategy-machine.ts`, `tests/support/lazy-container.ts`
   (new).** `Workspace` became async by contract so a lazy wake can leave a
   genuinely partial tree — a synchronous facade cannot represent "some
   paths are not resident yet" — and both candidate arms attach lazily
   through a shared `LazyContainer` that faults a write's target and
   ancestors in before mutating, so a fence never mistakes a placeholder's
   zero bytes for a file's new content. Root-level listing was moved out of
   the attach window entirely after cell 6.13 caught it scaling with
   top-level directory fanout (28 ops at 1e5 files against 4 at 1e3): the
   first `paths`, `snapshot` or `read` on the workspace lists on demand now,
   billed to `HydrateWork`, never to the wake's own `RestoreWork`.

## Reproduce

```
bun test packages/devbox/tests/strategy-conformance.test.ts
```

Cells 6.13 and 6.14 assert the same bound the table above states, so their
own pass/fail is the reproduction; the exact figures above come from
opening each arm through `CONFORMANCE_ARMS`, planting and committing the
cells' own `generatedTree`/`gigabyteTree` fixtures, waking, and reading
`arm.work().restore` — the same sequence cells 6.13 and 6.14 run, with the
row printed instead of compared.

## GC inventory removed from attach, 2026-09-06

The v2 sidecar still read its complete pack ledger during attach. The
record reader did not need that inventory, but the sidecar fetched it
before returning readiness. A local store fault made the distinction
observable. With the ledger read unavailable, the old attach failed.
The revised attach opens the head and reads the exact file bytes.

Measured with seed 17, 16 KiB per file, 32 KiB packs and generated nested
trees. These are object-store reads during attach, excluding the separate
control/envelope snapshot. The old implementation is commit 294a47c2d.

| files | ledger B | old reads / B | revised reads / B |
| ---: | ---: | ---: | ---: |
| 16 | 2,213 | 2 / 2,530 | 1 / 317 |
| 128 | 16,137 | 2 / 16,454 | 1 / 317 |

The ledger cache is keyed by its object key. Seals, materialization and
compaction load it when they need it. The focused v2 and sidecar suites
passed 26 tests. The unavailable-inventory regression fails before this
change and passes after it.

This removes one linear attach term. Flat directories still carry an
unpaged entry array, file headers still carry extent-page arrays, and
seals still rewrite the full ledger. Those costs remain unbounded by this
measurement. A separate 2 MiB-file probe with 32 KiB packs refused a
43,195 B metadata record. No cap was changed to make that probe pass.

## Retirement safety measured locally, 2026-09-06

A 131,072 B repeated-content rewrite caused the old liveness estimate to
retire a 3,178 B pack. That pack still held an untouched file. Both seals
reported publication success, but reading the untouched file failed after
automatic deletion. The estimate counted logical repetitions as physical
dead bytes. Shared extents can also remain reachable through another file.

The inventory now names `estimatedLiveBytes` and uses wire version 2.
Replacement counts select compaction candidates; they do not authorize
retirement. A complete relocation moves data, extent pages, file records,
symlinks and directory records before the new root retires their packs.
The local replay deleted zero packs before compaction and one afterwards.
The untouched file still read `keep me`. Empty files, empty directories
and symlinks also remained readable after compaction and deletion.

A separate held-read test let a newer publication complete during an old
compaction scan. The old implementation then lost `fresh.txt`. Compaction
now binds its publication to the head it scanned and records a stale-parent
refusal if that head changed. The concurrent file survives.

The v2, sidecar, durability-contract and cut suites passed 55 tests. These
are algorithm and local store-port proofs. They do not establish a real
daemon mount, a reset-safe retirement queue, reader lifetime protection or
an amortized maintenance bound. The deployed v1 report is unchanged.

## Directory page trees measured locally, 2026-09-06

A directory record held every entry inline. One entry update rewrote the
whole record, and one lookup read it whole. Entries now live in a page
tree with a fanout of 64 (`DIR_ENTRIES_PER_PAGE`). Each node holds at
most 64 entries or 64 child-page refs. A lookup reads one node per level.
An update rewrites one node per level and reuses sibling pages by
reference. A full listing reads every page.

Measured on the local store port with one 7-byte file update in a
directory of `width` siblings, PUT bytes for the whole seal and record
reads for one path lookup after a fresh attach:

| width | update PUT bytes | lookup reads | full-listing reads |
|---|---|---|---|
| 50 | 11,289 | 2 | 0 |
| 500 | 15,790 | 3 | 7 |
| 5,000 | 27,718 | 4 | 79 |
| 50,000 | 30,115 | 4 | 793 |

A 1,000x width increase costs one to two more tree levels. A fanout of 256
was measured first and rejected: a full leaf was about 50 KiB, so a 2,000
wide directory paid 53,649 B per update. Each entry carries two 64-hex
digests and a name, about 200 B, which sets the leaf size. The listing
cost is linear in width and is charged as such.

The test `a wide directory pays for one path, not its width` pins the
bound at 500 against 50,000 siblings. The v2, wire, sidecar and contract
suites passed 70 tests. Update bytes above 500 siblings are dominated by
the two 13 KiB leaf pages that hold the changed entry and the
intermediate page above it; a compact entry encoding would cut that
further and is not measured.

## Retirement survives a boot, 2026-09-06

The retirement queue was a private array in the sidecar process. A boot
that did not retire a pack never deleted it, so a restart after compaction
leaked every retired pack. A local replay reproduced this: four packs
retired by boot 1, zero deletes from boot 2 after the grace window.

The ledger now carries a `retired` row per pack awaiting deletion, with
the generation that retired it and the staging time in milliseconds. GC
reads the ledger, deletes the rows past grace, and remembers the keys in
the process. The next seal drops the rows this process deleted. A boot
that crashes between delete and seal repeats an idempotent delete. Rows
are sorted by key and disjoint from the retained packs; the schema refuses
both violations. The same replay now deletes all four packs from boot 2,
and boot 3 sees an empty queue after its first seal.

GC on a fresh boot reads the ledger once, O(#packs). Attach still reads
no inventory. The grace clock starts at staging, at most one upload
earlier than publication; the default window is 600,000 ms. 74 focused
tests pass.

## A lazy reader outlives the head it adopted, 2026-09-06

`restoreLazily` bound the `LazyRestore` to the view open at that moment,
and every attach built a new restore. A container kept the instance it
adopted. After four churn publishes, one compaction and one GC sweep past
grace, that instance read an untouched placeholder from a deleted pack:
`missing candidate object`. Grace protects a read in flight; it cannot
protect a reader that keeps resolving through a retired head.

The restore now reads through a `HeadFilesystem` that resolves the
sidecar's current view on every call, and attach no longer replaces the
instance. The same replay reads `still here` after the sweep. Residency
survives a publish, so a placeholder that was hydrated stays hydrated. A
placeholder for a path the container renamed before hydrating stays in
the residency map under its old name; it is inert and is not measured.
The v2, sidecar and conformance suites passed 174 tests.

## The v2 sidecar over the real daemon, 2026-09-06

`tests/sidecar-real-daemon-run.ts` drives the shipped `SidecarCore` through
`SidecarDaemonClient` against the real journal daemon inside the privileged
image, with in-memory payload, envelope and control stores. The host suite
`tests/sidecar-real-daemon.test.ts` runs it and pins its 22 checks by name.
The tree is 308 entries: a 300-file directory, nesting, a symlink, a
hardlink and a 3 MiB file. It found five defects at the daemon boundary.

1. A file unlinked while a descriptor was open was published under
   libfuse's `.fuse_hiddenNNNN` name. `hard_remove` was measured and
   rejected: the kernel sends GETATTR without a handle, so `fstat` on the
   nameless inode answered ESTALE, and `nullpath_ok` would hand every
   handle callback a NULL path and lose the name a W record binds to. The
   daemon keeps hiding and journals the hide as the caller's `unlink`; the
   hidden name is never journaled, described or published.
2. `readWalProgress` parsed `W <ino> <path> <offset> <length>` split on
   spaces; the record is seven tab-separated fields with aux
   `ino offset length`. The seal cadence's byte trigger counted 0 for every
   write. It now counts 3,148,667 for 3,148,667 written.
3. A write through one name of a hardlink whose other name the generation
   never touched left the twin stale, with and without an unlink of the
   written name. W records now carry the link count; a fence whose dirty
   inode has more than one link walks the tree once and describes every
   present name. Every other fence stays O(k).
4. The daemon refused every base hand-back after the first compaction
   (ERANGE): a compaction re-roots the same cut at a higher generation and
   the base rule required the fence's exact generation. A base now names
   the latest fence's cut at that generation or later and moves forward; the
   daemon adopts the head's generation so its next fence continues it.
   Recovery applies the same rule to BASE records.
5. A lazy page-in resolved bytes through the current head by path. A path
   rewritten to the same length between registration and page-in would
   have mixed two generations in one file. The v2 view now serves a
   location-free `contentId` (size, holes, chunk digests) and the restore
   refuses a page-in whose identity moved. A compaction keeps the identity;
   a same-length rewrite changes it and the page-in is refused by name.

Measured on the real mount: first seal 4 PUTs and 762,564 B; second seal 2
PUTs and 113,255 B; fresh attach 1 range read; compaction retired 3 packs
and GC deleted 3 after grace; a SIGKILL with an unsealed write recovered
and the next seal published generation 9 on an unbroken chain. An open
descriptor kept its inode across rename, unlink, replacement and a publish.
The daemon matrix (14 scenarios), the v2 and conformance suites pass.

## Hide lifecycle and descriptor death, 2026-09-06

The first hide repair matched a `.fuse_hidden` prefix. That would have
dropped a caller's own file of that name from every head and never
journaled its unlink. The daemon now recognises a hide by three facts,
libfuse's exact name `.fuse_hidden` plus 16 lowercase hex digits, the same
parent directory, and a handle open through this daemon on the source
inode, and records each hide it performed with a HIDE record. The release
time unlink of a recorded name is the end of the hide and is journaled as
UNHIDE; the unlink of any other name is ordinary. Recovery replays HIDE and
UNHIDE, removes a hidden name whose holder died with the daemon, and WAL
compaction carries outstanding hides forward.

Measured on the real mount: a caller's file named `.fuse_hidden0000abcd0000ef01`
was published with its bytes and its unlink was published; a hidden name
outstanding at SIGKILL was gone from the backing tree after restart.

The one collision left is a caller that renames an open file to a
same-directory name of exactly libfuse's shape. The high-level API hands
the daemon the same rename callback for both, so that rename is journaled
as an unlink. It is not measured.

Descriptor death is the kernel's: a read on a descriptor of the dead mount
answered EIO, its close answered ok, and a fresh open after restart served
the bytes the dead daemon had written through. A page-in refused for a
moved placeholder recovers by taking the placeholder again from the current
head; the modeled test proves both the refusal and the recovery.

The hardlink walk stays visible. On the 308-entry tree the seal that
walked measured 10 ms against 8 ms for a plain seal. It is O(tree) and is
paid only by a generation that wrote through a multi-link inode. A links
table carried by the head would remove the walk; it is not built.

## The direct R2 transport over workerd, 2026-09-06

The same runner takes `KINU_STORE_ENDPOINT` and then publishes through
`DirectR2Store`, the HTTP transport the container uses against the
intercepted R2 endpoint in production. The host test serves that wire from
a workerd worker over a persisted R2 bucket (one PUT per pack answered with
an ETag, range GETs answered 206, DELETE) and runs the container on the
host network. All 28 checks pass over both transports. Store writes and
bytes are equal seal for seal: first seal 4 PUTs and 762,564 B, second
seal 2 PUTs and 113,255 B, 5 GC deletes, 1 attach read. The head
authority stays in memory in this test; the Durable Object side is the
workerd suite's.


