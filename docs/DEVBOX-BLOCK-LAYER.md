# Block layer: design gate

2026-09-13, base df1694e9c. Status: designed, unimplemented; full-hook requirement refused. I cannot
adopt any evaluated candidate under all current constraints. The read-only design removes storage
attachment's whole-file copy, but arbitrary restored services can still trigger that copy before
readiness. Even an ideal filesystem cannot bound a service that scans F bytes before listening: demanded
work Q may equal F. No large disk, product deployment, or Lean proof was run.

## Read-only design, conditional on accepting that limitation

Let B be stored bytes, N stored files, F the largest changed file, M changed-file records, H other
changed namespace records, L layers, and k one file's overrides. H includes directories, deletions and
hardlink names; hiding it inside M would change M's definition.

With R=/var/tmp/devbox, the exact newest-first stack is:

`lowerdir=R/block-lower:R/lower-delta/<generation>/.devbox-delta/tree:R/lower-base`

The fresh plain upper is R/upper; work is R/work; merged is /workspace. For legacy-only deltas, retain
`delta:base`; never combine legacy and chunked formats. block-lower presents complete chunked inodes and
ancestor directories. tree serves whole files, symlinks and hardlinks lazily, including multi-GB whole
records. Deleted paths use pre-mounted upper whiteouts; treplace uses the replacement inode above the old
directory. No recursive merged-tree deletion, whole-file planting, or chunk enumeration at attach.

Phases: generation/store checks and lazy squashfuse mounts O(L); parse namespace records, construct
directories/whiteouts and start the read-only server O(M+H); mount/prove the overlay and generation O(L).
Metadata path lengths are platform-bounded. Payload reads/copies are zero. This is O(M+H+L), or O(M+L)
only if H≤cM. It is not a wall-clock guarantee. Resuming services and proving listeners follows
attachment inside the hook.

## One necessary format change

V1 embeds over[]. Using the real planner with synthetic hashes, M=1 and one deduplicated chunk, logical
F=64KiB/1MiB/16MiB/1GiB produced manifest bytes 525/6406/101860/6616994. No payload files were allocated.
Inline parsing therefore retains a linear-F case.

V2 preserves the envelope's files/dirs/deleted/treplace/links, whole records, and chunked
p/s/mode/uid/gid. It replaces only over:

`{kind:"chunked",p,s,mode,uid,gid,over:{index:"<sha256>",root:"<sha256>",count:k}}`

index names a file beside chunks within the same delta squashfs, not another remote object. It contains
bounded authenticated search pages ordered by block offset. Fetch/search O(log(k+1)) pages per block,
never fetch the entire index on open. Entries retain o/src/d; src=hole means zero bytes, not lower
fallthrough. Missing override means the same base range, zero-extended beyond base EOF; s clips the last
block. Whole-file thresholds stay 64KiB and >50% zero blocks. V1 is refused by version; reset deployment,
no dual reader. Publication must merge retained delta metadata with the upper; today's mounted-delta
collapse cannot remain.

## Why the other candidates fail

[A: fuse-overlayfs 1.7.1 source](https://github.com/containers/fuse-overlayfs/blob/v1.7.1/main.c#L2951):
ovl_do_open→get_node_up→copyup copies the inode before O_RDWR/O_WRONLY succeeds, even without a write.
Its work is O(size of that file), bounded by F, plus ancestor metadata. Sparse upper holes never consult
lower ranges. devbox.ts #restorePhases restarts arbitrary saved workloads before settlement; deferring
their writable opens would block database-backed listeners or falsely declare them restored.

[B: writable routing] Binding a sparse plain file over the composed inode exposes zeros at unwritten
offsets. Binding a writable FUSE inode restores the callback-capture problem. Native f3a0fcf7f's
LAZY-RESTORE-2026-09-03.md, "Local dirty-mmap capability prototype", records immutable byte 0 instead of
mapped byte 81; mmap-contract-cost/results/arm-journal-no-mmap-cap.run1.json records SQLITE_IOERR_SHMMAP.
[Cached FUSE](https://docs.kernel.org/filesystems/fuse/fuse-io.html) supports mmap and writeback,
including close/last-reference unmap, but a mapping may outlive its closed descriptor and receive later
unsynced stores. A checkpoint bitmap cannot count callbacks that have not arrived;
[MS_SYNC](https://man7.org/linux/man-pages/man2/msync.2.html) needs an explicit completed barrier.
[SQLite's -shm grows](https://sqlite.org/walformat.html#the_wal_index_file_format), and -wal contains
committed data; a size threshold cannot exclude them safely.

[C: reflink] Local image 31bf61768ed3: root/upper overlayfs, Docker backing extfs, squashfuse lower
fuseblk. A tiny actual clone failed EXDEV, exit 1. [FICLONE requires the same mounted
filesystem](https://man7.org/linux/man-pages/man2/FICLONE.2const.html); even a reflink-capable host
cannot clone squashfuse's decoded ranges.

The read-only lower avoids native write interception entirely: writable overlay opens use the plain
upper; it imposes no mmap refusal. It does not repair checkpointing of unsynced upper mappings.

## Tools, refusals, proof scope

Image inventory found squashfuse 0.1.103 and fuse-overlayfs 1.7.1.
[fuse-archive](https://github.com/google/fuse-archive), [DwarFS](https://github.com/mhx/dwarfs),
[rangefs](https://github.com/DCsunset/rangefs), and [concatfs](https://github.com/schlaile/concatfs) do
not implement this indexed two-source format. A custom Rust/fuser server is estimated at 700–1200 lines,
unmeasured. Production currently uses the pinned upstream image in cf-backend/wrangler.jsonc;
packages/devbox has probe Dockerfiles, no production custom image build.

Reject hostile paths, duplicate/out-of-range offsets, invalid pages/digests, mount/generation mismatch
and unsupported metadata. Demand corruption returns EIO, never base fallback. Missing mounts never
publish readiness.

Proposed lean/Kinu/Storage/BlockLayer.lean statements, not proofs:

- attach_metadata_bound: work ≤ a+b(M+H)+cL; attach_payload_bytes=0.
- block_lookup_bound: ≤ a+b⌈log₂(k+1)⌉ page resolutions/block.
- composed_read_correct: bytes equal size-clipped base with overrides.
- hole_is_zero; absent_override_reads_base: distinct zero/base semantics.
- ready_implies_all_composed_mounted: matching generation and complete mounts.
- copyup_is_file_local: bytes ≤ file size ≤ F; no claim past lifecycle readiness.
- No full-hook or callback-only O(written-blocks) theorem.

Publication remains SnapshotChain.lean's chunked_file_publishes_blocks_and_record and conditional
c3_wire_bound. Lean checks the model, not kernel execution or 30-second latency.
