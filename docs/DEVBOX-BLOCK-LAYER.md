# Block layer: design gate

Base df1694e9c on 2026-09-13. Status is designed, unimplemented. I refuse the full-hook requirement. I cannot
adopt any evaluated candidate under all current constraints. The read-only design removes the whole-file copy at storage
attachment. An arbitrary restored service can still trigger that copy before
readiness. Even an ideal filesystem cannot bound a service that scans F bytes before it listens. Demanded
work Q may equal F. No large disk, product deployment, or Lean proof covers this.

## Read-only design, conditional on accepting that limitation

Each symbol names one thing. B is stored bytes. N is stored files. F is the largest changed file. M is changed-file records. H is other
changed namespace records. L is layers. k is one file's overrides. H includes directories, deletions and
hardlink names. Hiding it inside M would change what M means.

With R=/var/tmp/devbox, the exact newest-first stack is:

`lowerdir=R/block-lower:R/lower-delta/<generation>/.devbox-delta/tree:R/lower-base`

The fresh plain upper is R/upper. Work is R/work. Merged is /workspace. For legacy-only deltas, I retain
`delta:base`. I never combine legacy and chunked formats. block-lower presents complete chunked inodes and
ancestor directories. tree serves whole files, symlinks and hardlinks lazily, including multi-GB whole
records. Deleted paths use pre-mounted upper whiteouts. treplace uses the replacement inode above the old
directory. At attach I do no recursive merged-tree deletion, whole-file planting, or chunk enumeration.

Phases carry their own bounds. Generation and store checks plus lazy squashfuse mounts cost O(L). Parsing namespace records, constructing
directories and whiteouts, and starting the read-only server cost O(M+H). Mounting and proving the overlay and generation cost O(L).
Metadata path lengths are platform-bounded. Payload reads and copies are zero. This is O(M+H+L), or O(M+L)
only if H≤cM. It is not a wall-clock guarantee. Resuming services and proving listeners follow
attachment inside the hook.

Opaque directories are directory records with `opaque:true`. An opaque root
uses `p:""`. The native publication probe observes `trusted.overlay.opaque`,
the user-namespace variants and fuse-overlayfs's `.wh..wh..opq` marker.
Unreadable opacity refuses publication. The package places the marker in
`delta/tree`, and the block server verifies it before mounting. A mask on
the higher block directory would also hide this checkpoint's whole files.
The tree-level mask hides only the older base. Cumulative publication drops
retained descendants of a replaced opaque directory and preserves its mask
on later ordinary edits. I enumerate no lower directory.

H still counts directory records, including an opaque root. It does not count the
entries those records hide. On 2026-09-13 the Docker conformance row renamed
a directory over a removed lower directory, checkpointed, restored, and
listed exactly the new names. Mixed whole and chunked records stayed
readable with zero payload bytes and index pages at attach. A missing opaque
marker refused readiness. `BlockLayer.lean` models these precedence rules
and proves that opacity adds no second directory record.

## One necessary format change

V1 embeds over[]. I ran the real planner with synthetic hashes, M=1 and one deduplicated chunk. Logical
F=64KiB/1MiB/16MiB/1GiB produced manifest bytes 525/6406/101860/6616994. I allocated no payload files.
Inline parsing therefore retains a linear-F case.

V2 preserves the envelope's files/dirs/deleted/treplace/links, whole records, and chunked
p/s/mode/uid/gid. It replaces only over:

`{kind:"chunked",p,s,mode,uid,gid,over:{index:"<sha256>",root:"<sha256>",count:k}}`

index names a file beside chunks within the same delta squashfs, not another remote object. It contains
bounded authenticated search pages ordered by block offset. I fetch and search O(log(k+1)) pages per block.
I never fetch the entire index on open. Entries retain o/src/d. src=hole means zero bytes, not lower
fallthrough. A missing override means the same base range, zero-extended beyond base EOF. s clips the last
block. Whole-file thresholds stay 64KiB and >50% zero blocks. A mostly-zero file is
a whole record inside the chunked delta's tree, not a legacy whole-upper
publication. The bounded block-lower cell therefore uses a dense changed
file. On 2026-09-13, `b20260913105359` attributed the sparse cell's legacy
fallback to `block-hash-failed` (0 of 131072 hashes), not the zero-block rule.
The shell expanded every split path into one `sha256sum` argument list.
`packages/devbox/tests/delta-hash-argv.test.ts` reproduced `Argument list too long`. Hashing now
uses `find -exec ... +` batches. Every format fallback is a named value on
the published chain and its log event. V1 is refused by version. I ship a reset deployment with
no dual reader. Publication must merge retained delta metadata with the upper. The current mounted-delta
collapse cannot remain.

## Why the other candidates fail

[A: fuse-overlayfs 1.7.1 source](https://github.com/containers/fuse-overlayfs/blob/v1.7.1/main.c#L2951):
ovl_do_open→get_node_up→copyup copies the inode before O_RDWR/O_WRONLY succeeds, even without a write.
Its work is O(size of that file), bounded by F, plus ancestor metadata. Sparse upper holes never consult
lower ranges. devbox.ts #restorePhases restarts arbitrary saved workloads before settlement. Deferring
their writable opens would block database-backed listeners or falsely declare them restored.

[B: writable routing] Binding a sparse plain file over the composed inode exposes zeros at unwritten
offsets. Binding a writable FUSE inode restores the callback-capture problem. Native f3a0fcf7f's
LAZY-RESTORE-2026-09-03.md, "Local dirty-mmap capability prototype", records immutable byte 0 instead of
mapped byte 81. mmap-contract-cost/results/arm-journal-no-mmap-cap.run1.json records SQLITE_IOERR_SHMMAP.
[Cached FUSE](https://docs.kernel.org/filesystems/fuse/fuse-io.html) supports mmap and writeback,
including close and last-reference unmap. A mapping may outlive its closed descriptor and receive later
unsynced stores. A checkpoint bitmap cannot count callbacks that have not arrived.
[MS_SYNC](https://man7.org/linux/man-pages/man2/msync.2.html) needs an explicit completed barrier.
[SQLite's -shm grows](https://sqlite.org/walformat.html#the_wal_index_file_format), and -wal contains
committed data. A size threshold cannot safely exclude them.

[C: reflink] Local image 31bf61768ed3: root/upper overlayfs, Docker backing extfs, squashfuse lower
fuseblk. A tiny actual clone failed EXDEV, exit 1. [FICLONE requires the same mounted
filesystem](https://man7.org/linux/man-pages/man2/FICLONE.2const.html). Even a reflink-capable host
cannot clone squashfuse's decoded ranges.

The read-only lower avoids native write interception entirely. Writable overlay opens use the plain
upper. It imposes no mmap refusal. It does not repair checkpointing of unsynced upper mappings.

## Tools, refusals, proof scope

Image inventory found squashfuse 0.1.103 and fuse-overlayfs 1.7.1.
[fuse-archive](https://github.com/google/fuse-archive), [DwarFS](https://github.com/mhx/dwarfs),
[rangefs](https://github.com/DCsunset/rangefs), and [concatfs](https://github.com/schlaile/concatfs) do
not implement this indexed two-source format. A custom Rust/fuser server is estimated at 700 to 1200 lines,
unmeasured. Production currently uses the pinned upstream image in `packages/cf-backend/wrangler.jsonc`.
packages/devbox has probe Dockerfiles and no production custom image build.

I reject hostile paths, duplicate and out-of-range offsets, invalid pages and digests, mount and generation mismatch,
and unsupported metadata. Demand corruption returns EIO, never base fallback. Missing mounts never
publish readiness.

Proposed statements for a `Kinu.Storage.BlockLayer` module, not proofs. The
module lands with the implementation:

- attach_metadata_bound: work ≤ a+b(M+H)+cL; attach_payload_bytes=0.
- block_lookup_bound: ≤ a+b⌈log₂(k+1)⌉ page resolutions/block.
- composed_read_correct: bytes equal size-clipped base with overrides.
- hole_is_zero; absent_override_reads_base: distinct zero/base semantics.
- ready_implies_all_composed_mounted: matching generation and complete mounts.
- copyup_is_file_local: bytes ≤ file size ≤ F; no claim past lifecycle readiness.
- No full-hook or callback-only O(written-blocks) theorem.

Publication remains SnapshotChain.lean's chunked_file_publishes_blocks_and_record and conditional
c3_wire_bound. Lean checks the model, not kernel execution or 30-second latency.
