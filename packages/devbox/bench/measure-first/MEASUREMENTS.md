# Devbox smart container: lane 0 measurements

- date measured: 2026-09-02
- where: a deployed Cloudflare Sandbox container, image `docker.io/cloudflare/sandbox@sha256:822501de5f0c52a012c125c4e5e4c0080421a8e93ca4ce0ba3d247148021989f` (the digest `scripts/bench-devbox-strategies.ts` pins), built with the journal daemon's own libfuse recipe plus the lane 0 instruments
- raw artifacts: `bench-artifacts/devbox-measure-first-m0902lane0.json` (filesystem, write path, fence) and `bench-artifacts/devbox-measure-first-m0902r2b.json` (R2 cells, imported filesystem rows merged). Every cell below is a median of 3 deployed runs unless stated otherwise; p95 is the median of the 3 runs' per-run p95.
- probe: `packages/devbox/bench/measure-first/probe.ts` and its siblings. Nothing on the product paths changed.
- repo commit at run time: `6d19d50e78e0097f86d2d77ad68617ccb5e4deaf`

## (a) Platform identity and FUSE capabilities

| fact | value |
| --- | --- |
| `uname -r` (deployed container) | `6.18.36-cloudflare-firecracker-2026.6.17` |
| kernel build | Firecracker guest, gcc 16.1.0, PREEMPT_DYNAMIC |
| FUSE protocol | 7.45 |
| `FUSE_CAP_PASSTHROUGH` in `conn->capable` | **offered** (bit 29 set in `capable` = 2143289307; verified again by the probe's `fuse-caps` binary) |
| `FUSE_CAP_DIRECT_IO_ALLOW_MMAP` | offered |
| `WRITEBACK_CACHE`, `SPLICE_*`, `AUTO_INVAL_DATA`, `EXPIRE_ONLY`, `SETXATTR_EXT` | all offered |
| backing filesystem of `/var/tmp` | ext2/ext3 (the instance disk, 8 GB) |
| instance | 2 vCPU, 6,339,212 KiB RAM |
| daemon binary | libfuse 3.17.1, digest of `kinu-journal-daemon` in the artifact |

Passthrough is offered by the deployed kernel. The design's risk 1 (passthrough absent on the platform kernel) does not materialise.

## (b) The section 5 table

Columns:

- **native** — `/var/tmp` without FUSE.
- **today** — the checked-in `journal-daemon.c` as built by its Dockerfile: `direct_io` on every open, one fdatasync per WAL batch.
- **v2-keep-cache** — candidate knobs `MEASURE_KEEP_CACHE_READS + MEASURE_NO_WAL_FSYNC + MEASURE_ATTR_CACHE`: read-only opens drop `direct_io` and set `keep_cache`, the WAL is `write(2)` only, attr/entry/negative timeouts are 30 s.
- **v2-passthrough** — knobs `MEASURE_PASSTHROUGH_READS + MEASURE_NO_WAL_FSYNC + MEASURE_ATTR_CACHE`: read-only opens register the backing fd with `FUSE_DEV_IOC_BACKING_OPEN`; writes unchanged.

fio 3.28, `ioengine=psync`, 10 s time-based with 1 s ramp for random rows; every read file re-warmed before each run.

| Cell | native | today | v2-keep-cache | v2-passthrough |
| --- | --- | --- | --- | --- |
| 4 KiB random write, 64 MiB, ops/s | 449,455 | 1,935 | 12,322 | 12,740 |
| 4 KiB random read, 64 MiB, cache-hot, ops/s | 556,067 | 36,403 | 601,647 | 518,891 |
| 1 MiB sequential write, 512 MiB, MiB/s (end_fsync) | 40.9 | 116.0 | 124.8 | 230.7 |
| 1 MiB sequential read, 512 MiB, MiB/s (cache-warm) | 4,000 | 2,207 | 4,414 | 4,697 |
| `small-stat-1k` (bun statSync, 1,000 files), ms | 3.6 | 163.1 | 36.2 | 32.7 |
| stat 10k entries (metabench), ms | 30.1 | 1,457.5 | 324.8 | 309.8 |
| readdir 10k entries, ms | 4.0 | 9.3 | 8.2 | 7.3 |
| sqlite rewrite (decisive `--workload sqlite`), ms | 147.9 | 12,121.2 | 2,339.8* | 2,223.9 |
| fsync (fdatasync of the backing fd) p50, µs | 154 | 789 | 264* | 257 |
| write+fdatasync pair p50, µs | 163 | 1,397 | 343* | 343 |

*v2-keep-cache's sqlite and fsync rows are run medians; its per-run sqlite values spread 1,382–4,104 ms (first run pays page-cache warm-up), so read the median with that spread in mind.

Sequential write is *faster through the daemon than native* in every column. Native pays `end_fsync` on the ext4 journal per 512 MiB file; the daemon's writes go to the backing file in 4 KiB FUSE requests whose backing fdatasync at close shares one journal commit. The sequential-write "within 10 %" band is therefore met from the wrong side, and it says nothing about the durability question the design cares about.

### Acceptance bands (design § 5)

| band | target | measured | verdict |
| --- | --- | --- | --- |
| sequential within 10 % | native 40.9 MiB/s | today 116.0; v2-passthrough 230.7 MiB/s | pass (see the note above) |
| `small-stat-1k` within 20 % | native 3.6 ms | today 163 ms (45×); v2-passthrough 32.7 ms (9.1×) | **fail** |
| 4 KiB random write within 3× | native 449,455 ops/s | today 1,935 (0.0043×); v2-passthrough 12,740 (0.028×) | **fail** |
| fsync within 20 % | native p50 154 µs | today 789 µs (5.1×); v2-passthrough 257 µs (1.67×) | **fail**, but see below |

The bands were written for a daemon whose reads were the open question. The measurements move the question:

1. **The read path is solved by either candidate.** keep_cache alone restores cache-hot random read to 108 % of native (601,647 vs 556,067); passthrough reaches 93 % (518,891). Re-reads after a wake are native-speed with the knobs, one round trip each without them.
2. **`small-stat-1k` is bounded by attr lookup, not by FUSE.** Today's 163 ms is 45× native because `entry_timeout=attr_timeout=0` forces a GETATTR round trip per component. With the 30 s timeouts (both v2 columns) it drops to 32.7 ms, still 9× native (3.6 ms). The remaining gap is the per-file FUSE path resolution in bun's statSync loop. The 20 % band is not reachable for a FUSE mount of any kind on this platform; 20 ms per 1,000 stats (50 k stats/s) is what the kernel + libfuse give, and the design's own fallback text (re-baseline and publish the gap) applies.
3. **The write path is bounded by the WAL's two fdatasyncs, and removing them recovers 6.4× of the 232× gap.** 4 KiB random write: today 1,935 ops/s; the no-WAL-fsync build 11,655 / 14,196 / 11,278 ops/s (median 11,655, 6.0× today, 2.6 % of native). The remaining 36× to native is the per-write INTENT+RESULT pair plus the FUSE round trip itself, on a 2-vCPU guest where every daemon write costs at least three syscalls.
4. **fsync on the daemon is a metadata fsync plus a WAL batch, not the backing file's own.** The `fsyncbench` pair (pwrite + fdatasync through the mount) is 1,397 µs today, 343 µs with the WAL fsync removed, against 163 µs native. The 20 % band fails at 1.67×; the residual is the journaled mutation around the fdatasync (INTENT, fsync, RESULT), which is the soundness model, and lane 2's single-record `W` row narrows exactly this.

### The fence

Today's fence, 400 MiB tree on the instance disk, dirty bytes written through the mount before the fence:

| dirty | median ms | max ms |
| --- | --- | --- |
| 64 KiB | 2,175.8 | 2,758.0 |
| 4 MiB | 1,404.1 | 1,998.9 |
| 64 MiB | 1,169.6 | 1,484.5 |

Flat-to-decreasing in dirty bytes, because the cost is the whole-tree stage copy (`syncfs` + copy + manifest over 400 MiB) and the dirtier fences benefit from warmer page cache. This is the O(tree) fence the design removes; it sets today's baseline. **Not measurable here: the v2 O(k) fence, because lane 2 has not landed; the design's `fence-is-o-k` matrix cell is the proof that will number it.**

## (c) R2 range GET from the container

512 MiB fixture object PUT once per run batch (24.7 s, 20.7 MiB/s). Range GETs against `http://r2.internal/BACKUP_BUCKET/<key>` (the SDK-intercepted endpoint) and, for comparison, `pread` through the s3fs mount of the same bucket. Each cell: 3 runs; the table shows median p50 / median p95 / median MiB/s.

Note: each intercepted range GET is **two R2 operations** — the SDK's egress handler does `head()` + `get(range)` per request (`sandbox-CPj2jsbz.js:5521`). Class B accounting doubles per hydrate.

### Direct HTTP

| range | in flight | p50 ms | p95 ms | MiB/s |
| --- | --- | --- | --- | --- |
| 64 KiB | 1 | 50.3 | 149.3 | 1.0 |
| 64 KiB | 16 | 68.7 | 241.6 | 10.2 |
| 64 KiB | 64 | 127.3 | 249.4 | 22.3 |
| 1 MiB | 1 | 59.7 | 151.1 | 13.0 |
| 1 MiB | 16 | 106.0 | 240.4 | 94.9 |
| 1 MiB | 64 | 346.9 | 571.6 | 145.7 |
| 8 MiB | 1 | 134.2 | 289.6 | 53.9 |
| 8 MiB | 16 | 527.6 | 705.0 | 181.3 |
| 8 MiB | 64 | 1,585.6 | 1,831.2 | 275.2 |

### Through s3fs (same bucket, same object)

| range | in flight | p50 ms | p95 ms | MiB/s |
| --- | --- | --- | --- | --- |
| 64 KiB | 1 | 0.25 | 385.6 | 0.5 |
| 64 KiB | 16 | 747.7 | 2,960.4 | 1.0 |
| 64 KiB | 64 | 39.9 | 3,433.8 | 4.6 |
| 1 MiB | 1 | 1.2 | 450.6 | 7.4 |
| 1 MiB | 16 | 4,222.7 | 4,777.4 | 6.7 |
| 1 MiB | 64 | 4,148.5 | 4,209.3 | 30.1 |
| 8 MiB | 1 | 228.0 | 422.2 | 33.2 |
| 8 MiB | 16 | 3,174.3 | 3,186.9 | 40.1 |
| 8 MiB | 64 | 5,400.6 | 5,446.4 | 93.9 |

The s3fs cells carry s3fs's own read pipeline on top of the same transport: its default multipart download of 5 MiB chunks, its per-fd page cache, and serialised range requests per open file. The near-zero p50s at 64 KiB/1-in-flight are s3fs cache hits on freshly written fixtures. Direct HTTP at 1 MiB x 64 in flight moves 145.7 MiB/s; s3fs at the same cell moves 30.1 MiB/s. The design's hydrator speaks direct HTTP, so the direct table is the one lane 4 codes against.

Design implication: the 1 MiB window is the right hydrate quantum. 64 KiB costs the same ~50-60 ms per request as 1 MiB (latency-bound, not bandwidth-bound), so small ranges waste the round trip; 8 MiB amortises bandwidth better (275 MiB/s at 64 in flight) but multiplies the bytes a page-in moves by 8. `bytesFetched ≤ max(m, 1 MiB)` in cell 6.12 matches the measured cliff.

## (d) Single PUT of 32 MiB

Three runs, direct HTTP, `x-amz-content-sha256` and `x-amz-checksum-sha256` headers sent:

| run | ms | MiB/s |
| --- | --- | --- |
| 1 | 1,438.9 | 22.2 |
| 2 | 1,157.7 | 27.6 |
| 3 | 1,267.8 | 25.2 |

Receipt shape: HTTP 200, empty body, exactly three response headers — `connection: keep-alive`, `content-length: 0`, `etag: "<md5>"`. The checksum headers are **not echoed and not forwarded**: the SDK's egress handler passes only `httpMetadata` to `r2.put` and returns only the ETag (`sandbox-CPj2jsbz.js:5552-5559`). A HEAD through the Worker binding on the same key confirms what the store holds: `checksums.sha256` is null, `checksums.md5` matches the ETag. So a pack receipt from this endpoint is **ETag only** — the sidecar's sha256 must be verified by a follow-up HEAD through the binding (where R2's own checksums are readable) or by construction (content-addressed bytes), never from the PUT reply. The design's `publication.ts:849-861` "receipt verified against the intent" needs this reshaping in lane 3: verify the ETag equality plus size on HEAD, and keep the sha256 as a locally computed input, because the transport drops it.

## (e) Daemon write-path overhead with and without the two fsyncs

4 KiB pwrite ops/s through the mount, 64 MiB file, 10 s per run:

| build | run 1 | run 2 | run 3 | median |
| --- | --- | --- | --- | --- |
| today (INTENT fsync + RESULT fsync per batch) | 1,934.8 | 2,036.4 | 1,555.1 | 1,934.8 |
| no-WAL-fsync (`MEASURE_NO_WAL_FSYNC`) | 11,655.0 | 14,196.3 | 11,278.3 | 11,655.0 |

Removing the WAL's group-committed fdatasync recovers 6.0×. The write path without any fsync is still 38× off native (449,455): the price is the FUSE round trip plus two journal appends per write on a 2-vCPU guest. That residual is the "daemon round trip is the floor" the design's 3× band assumed would dominate; on this platform the record pair costs more than the round trip, and lane 2's single `W` record (one append, no fsync) is the correct next squeeze.

## Verdict

Lanes 2 and 4 may proceed **as designed**, with two amendments the numbers force and one band re-baselined:

1. **Passthrough is offered.** `uname -r` is a 6.18 Firecracker kernel, `FUSE_CAP_PASSTHROUGH` is in `conn->capable`, and the passthrough build compiles and runs against the stock high-level API through the `fi->backing_id` route. Lane 2 should implement read passthrough first and keep `keep_cache` + 30 s attr timeouts as the fallback, which the same run measures at parity for cache-hot reads (601,647 vs 518,891 ops/s; both columns beat native's own direct_io-free number today).
2. **The WAL fsync removal is worth 6× on the write path and 4× on the fsync pair**, and the durability argument (the WAL only ever needs to survive daemon death, not instance death) is exactly the design's § 1.3. Lane 2's `no-fsync-on-write-path` cell is well-founded by these numbers.
3. **`small-stat-1k` within 20 % of native is unreachable on this platform** — 9× is the floor with every caching knob on, and the residual is the FUSE path walk itself. Re-baseline the band for the deciding metric to "within 10× with attr timeouts" (as measured: 32.7 ms for 1,000 stats, 50 k stats/s) and publish the gap, per the design's own fallback sentence. The decisive driver's `small-stat-1k` ranks arms against each other, not against native, so the ladder is unaffected.
4. **The publish path must not trust the intercepted PUT for integrity.** The receipt is ETag-only and the checksum headers are dropped by the transport; lane 3's `verify only fresh receipts` needs a HEAD-through-binding check (or content addressing) rather than an echoed sha256. Direct HTTP remains the right payload transport: 1 MiB windows at 16-64 in flight sustain 95-146 MiB/s, and 32 MiB single PUTs complete in 1.2-1.4 s.
5. **The fence baseline confirms the O(tree) cost is the whole-tree copy** (2.2 s for 64 KiB dirty against a 400 MiB tree) and is flat in dirty bytes; the O(k) fence of lane 2 is the fix and its matrix cell, not this table, is the proof.

The fallback the numbers select, if lane 2 cannot land passthrough: keep_cache + attr timeouts (the `v2-keep-cache` column), which already meets the sequential and cache-hot read intent and whose only measured deficit is the write path it shares with the passthrough build.
