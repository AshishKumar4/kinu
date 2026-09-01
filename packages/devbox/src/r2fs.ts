/**
 * Strategy two: the object store IS the filesystem.
 *
 * The work directory is an s3fs-FUSE mount of the box's own prefix in the
 * bucket, with a native-disk cache underneath it. There is no archive, no
 * layer, and no restore: an attach is a mount, and a mount is fast whatever the
 * directory holds.
 *
 * CONSISTENCY, stated plainly, because the difference from the snapshot chain
 * is not a detail:
 *
 *   A write becomes durable when the writer CLOSES the file. Not when `write`
 *   returns. s3fs buffers a file locally and uploads it on release, so a file
 *   still open when the container stops loses whatever had not been closed. The
 *   snapshot chain does not have this property: it archives the overlay's upper
 *   directory, which holds the bytes whether or not a handle is open.
 *
 *   There is no flush-to-store primitive. `sync` pushes the kernel's dirty
 *   pages into s3fs, and s3fs uploads on close. So a checkpoint commits
 *   everything that is closed and cannot commit anything that is not. This is
 *   why `checkpoint` reports the bytes the prefix HOLDS rather than the bytes
 *   it just moved: what it moved is not a number this layer knows.
 *
 *   Reads come from the disk cache while the cached copy's entity tag still
 *   matches, and from the store otherwise. Metadata is cached for
 *   `stat_cache_expire` seconds, so a change another writer makes to the same
 *   prefix can stay invisible for that long.
 *
 *   `rename` is a copy followed by a delete. It is not atomic and it costs the
 *   object's bytes. Code that renames a large tree pays for it here in a way it
 *   does not pay on a local disk.
 *
 *   ONE WRITER. Two containers mounted on one prefix will lose each other's
 *   writes, and nothing in this file arbitrates between them. A devbox owns its
 *   prefix.
 *
 * What this buys: no attach transfer at all, no archive to build, and a work
 * directory that survives a container recycle without a restore step. What it
 * costs: every read that misses the cache is a request to the store, and POSIX
 * semantics that are close to but not the same as a disk.
 */

import { findMount } from './lifecycle';
import {
  DEVBOX_RUNTIME_DIR,
  DEVBOX_WORKDIR,
  type AttachOutcome,
  type CheckpointKind,
  type CheckpointOutcome,
  type DevboxStorage,
} from './storage';

/** Where the native-disk cache lives. On the container's own disk, which is
 *  ephemeral — that is correct here, because the cache is only ever a copy of
 *  what the store already holds. */
export const R2FS_CACHE_DIR = `${DEVBOX_RUNTIME_DIR}/r2fs-cache`;

/**
 * s3fs options for a work directory, on top of the SDK's own R2 defaults.
 *
 * The SDK already passes `stat_cache_expire=60`, `enable_noobj_cache` and
 * `multipart_size=5`, plus the endpoint and credential wiring, which this must
 * not touch — `passwd_file` and `url` are refused outright, and correctly so.
 * Everything below is chosen for the one workload this package has: a source
 * tree that a process walks, reads repeatedly, and writes in bursts.
 *
 * `use_cache` is the reason this strategy is worth measuring at all. Without
 * it, every read is a store request. With it, a second read of the same file is
 * a local disk read.
 */
export const R2FS_S3FS_OPTIONS: readonly string[] = [
  // The native-disk cache. Everything else here is secondary to this line.
  `use_cache=${R2FS_CACHE_DIR}`,
  // Drop the cache on unmount. The container's disk does not survive a recycle
  // anyway, so this is about not leaving a stale copy behind for a remount
  // inside one container's life.
  'del_cache',
  // Metadata lifetime, raised from the SDK's 60. A build or a test run stats
  // the same paths thousands of times; at 60 s the walk pays for the store
  // again every minute. Raising it widens the window in which another writer's
  // change is invisible, which is acceptable because a devbox owns its prefix.
  'stat_cache_expire=300',
  // How many entries that cache may hold. The default 100000 is under one
  // dependency tree's file count, and an evicted entry is a store request.
  'max_stat_cache_size=200000',
  // Cache negative lookups too. A module resolver's misses outnumber its hits,
  // and each uncached miss is a store request that returns nothing.
  'enable_noobj_cache',
  // Bigger parts and more of them in flight. The SDK's 5 MiB is a floor for
  // compatibility; a workspace write is usually one large object or many small
  // ones, and both do better with fewer, larger, more parallel parts.
  'multipart_size=16',
  'parallel_count=20',
  // Bound the cache. It shares the container's single disk with the work
  // directory itself, and s3fs bounds it at nothing by default: the cache grows
  // until the disk is full and then an UNRELATED write fails with ENOSPC, so the
  // failure surfaces nowhere near its cause. Reserve a gigabyte.
  'ensure_diskfree=1024',
];

// DELIBERATELY ABSENT, both directions, measured on the shipped image.
//
// `compat_dir` is NOT an option s3fs 1.90 accepts — the version in
// `cloudflare/sandbox:0.12.8`. Passing it fails the mount outright with
// `fuse: unknown option 'compat_dir'`, so every attach on this strategy failed
// and the arm produced nothing. It was there to make a directory that exists
// only because a key has a slash in it visible, and that behaviour is the
// DEFAULT in 1.90, so the option was asking for something already true.
//
// Its negative, `notsup_compat_dir`, is the one that exists, and it stays out
// too: it turns that compatibility OFF, which would make a prefix written
// through the store binding read as empty. A mount that hides existing data is
// the worst failure this strategy could have.
//
// Nor does anything here pass `use_path_request_style`, `url`, `ahbe_conf` or
// `ro`: the SDK spreads its own values for those AFTER the caller's, so they are
// at best a no-op, and `passwd_file` and `url` are refused up front.
//
// ── the request bounds, and why they stay at the compiled defaults ───────────
//
// The four bounds on a stalled request are s3fs's own and this list overrides
// none of them. Read from `doc/man/s3fs.1` at tag v1.90, the version in
// `cloudflare/sandbox:0.12.8`:
//
//   `connect_timeout=300` seconds, `readwrite_timeout=120` seconds,
//   `retries=5`, `multireq_max=20`.
//
// The SDK sets none of them either — `R2_DEFAULT_S3FS_OPTIONS` in the shipped
// bundle is `stat_cache_expire=60`, `enable_noobj_cache`, `multipart_size=5` and
// nothing more — so those are the values a mount actually runs with. They are
// BOUNDS, not an absence, and they are facts about the pinned image rather than
// configuration to restate here: passing a number equal to the default adds a
// second place for it to drift.
//
// Nor is a SMALLER number ours to pick. Neither s3fs nor Cloudflare documents
// one for this workload and nothing here has been measured on the shipped image,
// and an elapsed-time cap is the wrong fence anyway: what stops a stalled mount
// from mattering is the attach owner in `devbox.ts` — its attach budget
// destroys and replaces a container it cannot fence, so an internal 300s connect
// can never overlap a retry. A generation, not a clock.
//
// `max_thread_count` is NOT an option 1.90 has — absent from that man page
// entirely — so passing it would fail the mount the way `compat_dir` did.
//
// EVERY LINE ABOVE IS PINNED TO ONE VERSION. `r2fs.test.ts` asserts the pinned
// `@cloudflare/sandbox` version alongside these claims, so a bump turns it red:
// re-read the man page for the s3fs the new image ships, then update the
// defaults recorded here and the version the test pins. Neither the numbers nor
// the version may move alone.

// ── ports ───────────────────────────────────────────────────────────────────

/** Everything the strategy needs from the world. The adapter closes over the
 *  binding name, the prefix and the mount path, so nothing here has to know how
 *  a box is addressed. */
export interface R2fsPorts {
  containerRunning(): boolean;
  /** `/proc/mounts` as the container sees it. */
  readMounts(): Promise<string>;
  /** Run one shell command container-side. */
  exec(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Does this container path exist? */
  pathExists(path: string): Promise<boolean>;
  /** Mount this box's prefix read-write at the work directory, with these s3fs
   *  options merged over the SDK's R2 defaults. */
  mount(s3fsOptions: readonly string[]): Promise<void>;
  unmount(): Promise<void>;
  /** Objects and bytes this box's prefix holds right now. Read through the
   *  store binding, not through the mount: the question is what is durable, and
   *  the mount's answer would come from a cache. */
  inventory(): Promise<{ objects: number; bytes: number }>;
  /** Delete every object under this box's prefix. Returns how many went. */
  clearPrefix(): Promise<number>;
  /**
   * Move every entry sitting in the BARE mountpoint aside, and answer how many
   * moved.
   *
   * MEASURED DEFECT THIS REPAIRS. s3fs refuses a non-empty mountpoint outright
   * — `s3fs: MOUNTPOINT directory /workspace is not empty` — and that refusal
   * is TERMINAL for a box: every later attach re-reads the same directory and
   * is refused again, so one write that landed while nothing was mounted costs
   * the box the rest of its life. Two consecutive deployed runs died there
   * (20260831031426 and 20260831143544, `r2fs` arm, at its third attach).
   *
   * An entry can only be in the bare mountpoint if it was written while nothing
   * was mounted, so it is not durable and never was — this strategy's durable
   * bytes are the store's. It is MOVED rather than deleted, so nothing is
   * destroyed, and the count travels back so the strategy says what it swept
   * instead of sweeping silently.
   */
  quarantineMountpoint(): Promise<number>;
  log(message: string): void;
}

/**
 * True when `dir` is an s3fs mount.
 *
 * Matched on `s3fs`, not on `fuse`. The snapshot chain attaches with
 * fuse-overlayfs, whose fstype is `fuse.fuse-overlayfs`, so a bare `fuse` test
 * would report a chain-attached work directory as an r2fs mount and let each
 * strategy claim the other's box. The fstype here is `fuse.s3fs`.
 */
export function isS3fsMounted(procMounts: string, dir: string): boolean {
  const line = findMount(procMounts, dir);
  return line !== undefined && line.fstype.includes('s3fs');
}

// ── the strategy ────────────────────────────────────────────────────────────

export function r2fsStorage(ports: R2fsPorts): DevboxStorage {
  /** What is wrong with the mount `procMounts` describes, or nothing when it is
   *  the mount this strategy claims to provide. Takes the reading rather than
   *  taking it again: `/proc/mounts` costs a container round trip. */
  const mountDefect = async (procMounts: string): Promise<string | undefined> => {
    // A successful mount call is not a landed mount, and a landed mount with no
    // cache directory is a mount that will answer every read from the store
    // while claiming to be cached. Both facts are read back from the container.
    if (!isS3fsMounted(procMounts, DEVBOX_WORKDIR)) {
      return `${DEVBOX_WORKDIR} is not an s3fs mount`;
    }
    if (!(await ports.pathExists(R2FS_CACHE_DIR))) {
      return `${DEVBOX_WORKDIR} is mounted without its cache directory ${R2FS_CACHE_DIR}, so `
        + 'every read would reach the store';
    }
    return undefined;
  };

  const attach = async (): Promise<AttachOutcome> => {
    const mountsBefore = await ports.readMounts();
    if (isS3fsMounted(mountsBefore, DEVBOX_WORKDIR)) {
      // CHECKED, not adopted. A mount already here gets the same read-back a
      // fresh one does: the previous attach could have refused this very mount a
      // moment ago, and returning `already-attached` over it would launder a
      // rejected mount into a healthy answer on the next call.
      const defect = await mountDefect(mountsBefore);
      if (defect !== undefined) {
        await ports.unmount();
        throw new Error(
          `${DEVBOX_WORKDIR} was already mounted, but ${defect}. Unmounted; the next attach `
          + 'starts from a clean container rather than serving a mount this strategy would '
          + 'have refused.',
        );
      }
      const held = await ports.inventory();
      ports.log(`${DEVBOX_WORKDIR} already mounted — mount skipped`);
      return {
        kind: 'already-attached',
        detail: `r2fs ${held.objects} objects ${held.bytes}B`,
      };
    }
    await ports.exec(`mkdir -p '${R2FS_CACHE_DIR}' '${DEVBOX_WORKDIR}'`);
    // AN EMPTY MOUNTPOINT IS PART OF THE MOUNT'S PRECONDITION, so it is
    // established here rather than hoped for. `detach` already leaves the
    // mountpoint empty, and this covers the case no detach ran: a write that
    // reached the bare directory while nothing was mounted. Without it s3fs
    // refuses, the refusal is terminal, and the box never attaches again.
    const swept = await ports.quarantineMountpoint();
    if (swept > 0) {
      ports.log(
        `${swept} entr${swept === 1 ? 'y' : 'ies'} were sitting in ${DEVBOX_WORKDIR} with `
        + 'nothing mounted there, so they were never durable; moved aside so the mount can '
        + 'land, and this box serves the store',
      );
    }
    await ports.mount(R2FS_S3FS_OPTIONS);

    const defect = await mountDefect(await ports.readMounts());
    if (defect !== undefined) {
      // UNMOUNT BEFORE REFUSING. Throwing over a live mount left the container
      // holding exactly the mount this refused, and the next attach saw it in
      // /proc/mounts and reported `already-attached` — one broken mount, refused
      // once and then accepted for the rest of the container's life. A refusal
      // has to leave nothing behind for a later call to adopt.
      await ports.unmount();
      throw new Error(
        `mount of ${DEVBOX_WORKDIR} reported success, but ${defect}. Unmounted; refusing to `
        + 'start rather than serve a mount that is not the one this strategy describes.',
      );
    }
    const held = await ports.inventory();
    ports.log(
      `${DEVBOX_WORKDIR} mounted (r2fs, ${held.objects} objects, ${held.bytes} bytes, `
      + `cache ${R2FS_CACHE_DIR})`,
    );
    return { kind: 'attached', detail: `r2fs ${held.objects} objects ${held.bytes}B` };
  };

  const checkpoint = async (kind: CheckpointKind): Promise<CheckpointOutcome> => {
    if (!ports.containerRunning()) {
      return { kind: 'skipped', reason: 'container is not running', bytes: undefined, movedBytes: 0 };
    }
    // Attachment first, for the same reason the snapshot chain asks first: a
    // checkpoint reported against a work directory that is not mounted is a
    // broken box wearing a healthy answer.
    if (!isS3fsMounted(await ports.readMounts(), DEVBOX_WORKDIR)) {
      const reason = `${DEVBOX_WORKDIR} is not an s3fs mount, so nothing written there `
        + 'reaches the store. Refusing to report a checkpoint for a work directory that is '
        + 'not attached.';
      ports.log(`${DEVBOX_WORKDIR} checkpoint failed: ${reason}`);
      return { kind: 'failed', reason, bytes: undefined, movedBytes: undefined };
    }

    // Push the kernel's dirty pages into s3fs. s3fs uploads a file when its
    // last handle closes, so this makes every closed file durable and can do
    // nothing at all for one that is still open. See the header.
    //
    // `&&`, and stderr kept. Chained with `;` the exit code reported was the
    // bare fallback `sync`'s, which succeeds on anything, so the failure branch
    // below could not fire for the failure it was written to catch; and
    // `2>/dev/null` threw away the only words that would say why.
    const synced = await ports.exec(`sync -f '${DEVBOX_WORKDIR}' && sync; echo $?`);
    if (synced.stdout.trim().split('\n').pop() !== '0') {
      const reason = `sync of ${DEVBOX_WORKDIR} failed: ${synced.stderr.trim() || synced.stdout.trim()}`;
      ports.log(`${DEVBOX_WORKDIR} checkpoint failed: ${reason}`);
      return { kind: 'failed', reason, bytes: undefined, movedBytes: undefined };
    }

    const held = await ports.inventory();
    if (held.objects === 0) {
      // Not a failure: a box whose caller has written nothing yet is a real and
      // ordinary state. Saying `skipped` keeps `committed` meaning "there are
      // durable bytes and here is how many".
      return {
        kind: 'skipped',
        movedBytes: 0,
        reason: `${DEVBOX_WORKDIR} holds no objects yet`,
        bytes: undefined,
      };
    }
    ports.log(
      `${DEVBOX_WORKDIR} ${kind} checkpoint synced (r2fs, ${held.objects} objects, `
      + `${held.bytes} bytes durable)`,
    );
    // `movedBytes: undefined` is the truthful answer, not a gap: s3fs uploads
    // a file when its last handle closes, so no bytes are attributable to this
    // sync. See CheckpointOutcome.
    return { kind: 'committed', reason: undefined, bytes: held.bytes, movedBytes: undefined };
  };

  /**
   * Release the mount and leave the mountpoint in the state an attach requires.
   *
   * THE UNMOUNT IS HALF THE JOB. Once s3fs is gone, `${DEVBOX_WORKDIR}` is an
   * ordinary directory again, and anything the container wrote there while the
   * mount was down becomes visible — which is exactly the state that makes the
   * NEXT `s3fs` refuse with `MOUNTPOINT directory is not empty`. A stop that
   * leaves that behind hands the next attach a box it cannot mount, so the
   * sweep belongs here, where the checkpoint that made the store durable has
   * already run.
   */
  const detach = async (): Promise<void> => {
    if (!ports.containerRunning()) return;
    if (isS3fsMounted(await ports.readMounts(), DEVBOX_WORKDIR)) {
      // ONE SYNC BEFORE THE UNMOUNT, because s3fs only uploads a file when its
      // last handle CLOSES — and the stop has just closed every holder's last
      // handle for good. The bytes an open writer flushed are sitting in the
      // kernel's page cache with the process that wrote them gone; this is the
      // one moment they can be pushed into s3fs before the mount it belongs to
      // is released. Without it the container dies holding them in cache, and
      // the durability question the stop was asked to answer is answered by
      // accident. Checked like the checkpoint's own sync, for the same reason:
      // a refused flush is a refusal to lose bytes, not a warning.
      const synced = await ports.exec(`sync -f '${DEVBOX_WORKDIR}'`);
      if (synced.exitCode !== 0) {
        throw new Error(
          `sync of ${DEVBOX_WORKDIR} failed before its release: `
          + `${synced.stderr.trim() || synced.stdout.trim() || `exit ${synced.exitCode}`}`,
        );
      }
      await ports.unmount();
    }
    const swept = await ports.quarantineMountpoint();
    ports.log(
      `${DEVBOX_WORKDIR} released (r2fs, mountpoint left empty`
      + `${swept > 0 ? `, ${swept} undurable entr${swept === 1 ? 'y' : 'ies'} moved aside` : ''})`,
    );
  };

  const discard = async (): Promise<void> => {
    // Unmount first. Deleting objects under a live mount leaves s3fs holding
    // cached metadata for keys that no longer exist, and its next write would
    // recreate some of them from that cache.
    //
    // Only ask the container when there IS one: reading /proc/mounts on a
    // stopped box wakes it, or fails, purely to check a mount that cannot
    // exist. A container that is down holds no mount by definition.
    await detach();
    const deleted = await ports.clearPrefix();
    ports.log(`${DEVBOX_WORKDIR} discarded (r2fs, ${deleted} objects deleted)`);
  };

  return { attach, checkpoint, detach, discard };
}
