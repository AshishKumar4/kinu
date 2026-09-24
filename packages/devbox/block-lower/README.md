# Read-only block lower

This process composes chunked files from a lazy base squashfs and one v2 delta
squashfs. It never reads an index or a file payload while mounting. Only the
manifest's namespace records and source mount identities are read at startup.
Whole records are served by the separate `.devbox-delta/tree` overlay lower.

Build: `cargo build --release --locked`. Test: `cargo test --locked`.
The image build uses the pinned Rust Alpine image to produce a static musl
binary that runs on the pinned upstream Sandbox image without a libc upgrade.

The image also carries the container's backup sync (D30), bundled from
`packages/devbox/src/sync-main.ts` before the Docker build and pinned in
`upstream.json` like the binaries. `tests/block-image.test.ts` bundles it again,
so a change to the sync's code fails until the image is rebuilt and re-pinned:

```sh
bun packages/devbox/block-lower/bundle-sync.ts
docker build -t kinu-devbox-block-layer:<date> packages/devbox/block-lower
```

## Format and reads

`over.index` names `.devbox-delta/<sha256>`, a file in the same delta image.
`over.root` authenticates its root page; `over.count` is the number of overrides.
Each 128-byte page occupies the rank of its block offset in ascending order:

| Bytes | Field |
| --- | --- |
| 0 to 7 | Block byte offset, unsigned little-endian |
| 8 | 1 = chunk, 2 = hole |
| 9 to 15 | Zero |
| 16 to 47 | Chunk SHA-256, or zero for a hole |
| 48 to 79 | Left child SHA-256, or zero for an empty subtree |
| 80 to 111 | Right child SHA-256, or zero for an empty subtree |
| 112 to 127 | Zero |

A subtree of ranks `[lo,hi)` has its root at `floor((lo+hi)/2)`. Its children
occupy `[lo,mid)` and `[mid+1,hi)`. Each lookup halves that interval and reads
at most `ceil(log2(k+1))` pages. Count zero uses SHA-256 of the empty string for
both digests and an empty index file. The whole-file digest names the artifact;
the root hash authenticates demand reads without scanning that artifact.

The producer validates every offset. The reader validates the authenticated
search path: source tags, padding, child shape, aligned strictly increasing
offset bounds, page digests, chunk lengths and chunk digests. It detects
off-path corruption when that path is demanded, not by scanning at attach.
Corruption returns EIO, including errors in an index for an otherwise absent
override. An authenticated missing override reads the base range, zero-extended
past its EOF. A hole is all zero. The declared file size clips every response.
All source paths resolve beneath anchored directory descriptors with no symlink
following. Namespace conflicts, hostile names and unsupported metadata fail
before the mount; an absent source chunk never becomes base fallback.

Namespace tables are byte-radix trees: each branching table has at most 256
entries, and path lengths are platform-bounded. Startup does not sort an
unbounded set of names or depend on hash-table collision behaviour. It visits
only the manifest's M+H records and constructs their ancestor directories.

## Concurrency and overlay semantics

`fuser::mount2` runs one request loop. A request finishes before the next request
changes the metrics or resolves data; there is no callback bitmap or write
interception. The kernel may cache immutable read pages. Reads never enumerate
chunks and hold at most one 16 KiB chunk plus the requested output buffer.
The stats file outside the mounted tree counts actual source payload bytes and
index pages; its initial payload count is zero.

This filesystem is a read-only lower beneath fuse-overlayfs with a plain upper.
Opening a restored file for writing makes fuse-overlayfs copy up that complete
file before returning the writable descriptor. That copy is file-local and is
off the storage attach path. It can happen during subsequent service startup:
neither service startup nor total hook latency has a size-independent bound.

No mmap mode is refused. Read-only mappings use the kernel's cached FUSE IO;
writable mappings belong to the copied-up plain inode. The kernel's
[FUSE IO modes](https://docs.kernel.org/filesystems/fuse/fuse-io.html) describe
cached IO, mmap, and writeback. A mapped inode can survive descriptor close;
[MS_SYNC](https://man7.org/linux/man-pages/man2/msync.2.html) is a completed
barrier, not a promise made by a later callback. This lower does not solve
checkpointing unsynced upper mappings. The relevant overlay path is
[fuse-overlayfs 1.7.1 `ovl_do_open` → `get_node_up` → `copyup`](https://github.com/containers/fuse-overlayfs/blob/v1.7.1/main.c#L2951).

Cloudflare documents derived images in its
[Sandbox Dockerfile reference](https://developers.cloudflare.com/sandbox/configuration/dockerfile/)
and [Containers image management](https://developers.cloudflare.com/containers/guides/image-management/)
(both read 2026-09-13, last updated 2026-08-28). Keep the upstream entrypoint
and SDK/image version matched. The derived image also adds `devbox-squashfuse`,
the low-level driver built from digest-pinned upstream squashfuse 0.1.103.
On 2026-09-13 the real-tools test found that the image's high-level driver
reported inode 7 and inode 5 for two names of one hardlink (both nlink 2).
`use_ino` made its directories disappear. The low-level driver preserves the
hardlink identity and passes the same assertion without copying whole files.
Mounts set both `fsname=<archive>` and `subtype=squashfuse`: the default source
name `squashfuse` is not an archive identity.
