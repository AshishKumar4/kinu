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


