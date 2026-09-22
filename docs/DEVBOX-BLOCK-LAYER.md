# Block layer: design gate

Written against base df1694e9c on 2026-09-13. The storage half is implemented
(decision D7 in [DEVBOX-DECISIONS.md](DEVBOX-DECISIONS.md): manifest v2
`f69af22cf`, the Rust/fuser lower `7598a68a6`, the derived image `ac6ae8f39`).

I refuse the full-hook requirement: no candidate I evaluated meets it under the
current constraints. The read-only design removes the whole-file copy from
storage attach. A restored service can still trigger that copy before
readiness, and no filesystem, however good, can bound a service that scans F
bytes before it listens; the work Q it demands may equal F. No large disk,
product deployment or Lean proof covers this case.

## Read-only design, if that limit is accepted

Symbols: B is stored bytes, N stored files, F the largest changed file, M
changed-file records, H other changed namespace records, L layers, k one
file's overrides. H covers directories, deletions and hardlink names; folding
it into M would change what M means.

With R=/var/tmp/devbox, the stack, newest first, is:

`lowerdir=R/block-lower:R/lower-delta/<generation>/.devbox-delta/tree:R/lower-base`

The fresh plain upper is R/upper, work is R/work, and merged is /workspace.
Legacy-only deltas keep `delta:base`; legacy and chunked formats are never
combined. block-lower presents complete chunked inodes and their ancestor
directories. tree serves whole files, symlinks and hardlinks lazily, including
multi-GB whole records. Deleted paths use pre-mounted upper whiteouts.
treplace puts the replacement inode above the old directory. Attach does no
recursive delete in the merged tree, plants no whole files and enumerates no
chunks.

Cost by phase: generation and store checks plus lazy squashfuse mounts are
O(L); parsing namespace records, building directories and whiteouts, and
starting the read-only server are O(M+H); mounting and proving the overlay and
generation are O(L). The platform bounds metadata path lengths. Payload reads
and copies are zero. The total is O(M+H+L), or O(M+L) only if H≤cM. That is
not a wall-clock guarantee. Resuming services and proving listeners come after
attach, under the same restore budget.

Opaque directories are directory records with `opaque:true`; an opaque root
uses `p:""`. The native publication probe reads `trusted.overlay.opaque`, its
user-namespace variants, and fuse-overlayfs's `.wh..wh..opq` marker. If opacity
cannot be read, publication is refused. The package places the marker in
`delta/tree`, and the block server checks it before mounting. A mask on the
higher block directory would also hide this checkpoint's whole files, so the
mask sits at tree level and hides only the older base. Cumulative publication
drops retained descendants of a replaced opaque directory and keeps its mask
on later ordinary edits. No lower directory is enumerated.

H still counts directory records, an opaque root included, but not the entries
they hide. On 2026-09-13 the Docker conformance row renamed a directory over a
removed lower directory, checkpointed, restored, and listed exactly the new
names. Mixed whole and chunked records stayed readable with zero payload bytes
and index pages at attach. A missing opaque marker refused readiness.
`BlockLayer.lean` models these precedence rules and proves that opacity adds no
second directory record.

## One necessary format change

V1 embeds over[]. I ran the real planner with synthetic hashes, M=1 and one
deduplicated chunk. Logical F=64KiB/1MiB/16MiB/1GiB produced manifest bytes
525/6406/101860/6616994, with no payload files allocated. Parsing inline
therefore keeps a case linear in F.

V2 keeps the envelope's files/dirs/deleted/treplace/links, whole records, and
chunked p/s/mode/uid/gid. It replaces only over:

`{kind:"chunked",p,s,mode,uid,gid,over:{index:"<sha256>",root:"<sha256>",count:k}}`

index names a file beside the chunks in the same delta squashfs, not another
remote object. It holds bounded, authenticated search pages ordered by block
offset. Each block fetches and searches O(log(k+1)) pages; opening a file never
fetches the whole index. Entries keep o/src/d. src=hole means zero bytes, not a
fall-through to the lower. A missing override means the same base range,
zero-extended past base EOF. s clips the last block.

Whole-file thresholds stay 64KiB and >50% zero blocks. A mostly-zero file is a
whole record inside the chunked delta's tree, not a legacy whole-upper
publication, so the bounded block-lower cell uses a dense changed file. On
2026-09-13, `b20260913105359` traced the sparse cell's legacy fallback to
`block-hash-failed` (0 of 131072 hashes), not to the zero-block rule: the shell
expanded every split path into one `sha256sum` argument list.
`packages/devbox/tests/delta-hash-argv.test.ts` reproduced `Argument list too
long`, and hashing now runs in `find -exec ... +` batches.

Every format fallback is a named value on the published chain and in its log
event. V1 is refused by version. The deployment is a reset with no dual reader.
Publication must merge retained delta metadata with the upper, so the current
collapse of the mounted delta cannot stay.

## Why the other candidates fail

[A: fuse-overlayfs 1.7.1 source](https://github.com/containers/fuse-overlayfs/blob/v1.7.1/main.c#L2951):
ovl_do_open→get_node_up→copyup copies the inode before an O_RDWR/O_WRONLY open
succeeds, even with no write. The work is O(size of that file), bounded by F,
plus ancestor metadata. Sparse upper holes never consult lower ranges.
devbox.ts #restorePhases restarts arbitrary saved workloads before settlement.
Deferring their writable opens would block database-backed listeners or
falsely report them restored.

[B: writable routing] Binding a sparse plain file over the composed inode
exposes zeros at unwritten offsets. Binding a writable FUSE inode brings back
the callback-capture problem. Native f3a0fcf7f's LAZY-RESTORE-2026-09-03.md,
"Local dirty-mmap capability prototype", records immutable byte 0 instead of
mapped byte 81. mmap-contract-cost/results/arm-journal-no-mmap-cap.run1.json
records SQLITE_IOERR_SHMMAP.
[Cached FUSE](https://docs.kernel.org/filesystems/fuse/fuse-io.html) supports
mmap and writeback, including close and last-reference unmap. A mapping can
outlive its closed descriptor and take later unsynced stores, and a checkpoint
bitmap cannot count callbacks that have not arrived.
[MS_SYNC](https://man7.org/linux/man-pages/man2/msync.2.html) needs an explicit
completed barrier.
[SQLite's -shm grows](https://sqlite.org/walformat.html#the_wal_index_file_format),
and -wal holds committed data, so no size threshold can safely exclude them.

[C: reflink] Local image 31bf61768ed3: root/upper overlayfs, Docker backing
extfs, squashfuse lower fuseblk. A tiny real clone failed with EXDEV, exit 1.
[FICLONE requires the same mounted filesystem](https://man7.org/linux/man-pages/man2/FICLONE.2const.html),
and even a reflink-capable host cannot clone squashfuse's decoded ranges.

The read-only lower avoids native write interception entirely. Writable
overlay opens use the plain upper. It refuses no mmap mode. It does not fix
checkpointing of unsynced upper mappings.

## Tools, refusals, proof scope

The image inventory found squashfuse 0.1.103 and fuse-overlayfs 1.7.1.
[fuse-archive](https://github.com/google/fuse-archive),
[DwarFS](https://github.com/mhx/dwarfs),
[rangefs](https://github.com/DCsunset/rangefs) and
[concatfs](https://github.com/schlaile/concatfs) do not implement this indexed
two-source format, so the lower is a custom Rust/fuser server:
`packages/devbox/block-lower/`, built by its `Dockerfile` on top of the pinned
upstream Sandbox image. `packages/cf-backend/wrangler.jsonc` pins the derived
image by digest.

The lower rejects hostile paths, duplicate and out-of-range offsets, invalid
pages and digests, mount and generation mismatches, and unsupported metadata.
Demand corruption returns EIO and never falls back to the base. A missing
mount never publishes readiness.

`lean/Kinu/Storage/BlockLayer.lean` proves these statements about the model:

- attach_metadata_bound: work ≤ a+b(M+H)+cL; attach_payload_bytes=0.
- block_lookup_bound: ≤ ⌈log₂(k+1)⌉ page reads per block.
- composed_read_correct: bytes equal size-clipped base with overrides.
- hole_is_zero; absent_override_reads_base: distinct zero/base semantics.
- ready_implies_all_composed_mounted: matching generation and complete mounts.
- copyup_is_file_local: bytes ≤ file size ≤ F; no claim past lifecycle readiness.
- No full-hook or callback-only O(written-blocks) theorem.

Publication stays covered by SnapshotChain.lean's
chunked_file_publishes_blocks_and_record and the conditional c3_wire_bound.
Lean checks the model, not kernel execution or 30-second latency.
