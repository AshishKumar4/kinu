// The r2fs gate.
//
// This strategy makes the object store the filesystem, so its failure mode is
// the opposite of the snapshot chain's: there is no restore step that can be
// skipped, and instead the risk is a mount that lands in a shape other than the
// one the strategy describes. A mount with no disk cache serves every read from
// the store while the code believes it is cached, and a mount that did not land
// at all leaves writes on a disk that will be recycled. Both are asserted from
// what the container reports, never from what a call returned.
import { describe, expect, test } from 'bun:test';

import {
  isS3fsMounted,
  R2FS_CACHE_DIR,
  R2FS_S3FS_OPTIONS,
  r2fsStorage,
  type R2fsPorts,
} from '../src/r2fs';
import {
  CHECKPOINT_OUTCOME_KINDS,
  DEVBOX_WORKDIR,
  type CheckpointKind,
  type CheckpointOutcome,
} from '../src/storage';

const MOUNTED = [
  'proc /proc proc rw,relatime 0 0',
  `s3fs ${DEVBOX_WORKDIR} fuse.s3fs rw,nosuid,nodev,relatime,user_id=0 0 0`,
].join('\n');
const NOT_MOUNTED = 'proc /proc proc rw,relatime 0 0\n/dev/vdc / ext4 rw 0 0';

const seenCheckpoint = new Set<string>();

interface Harness {
  readonly ports: R2fsPorts;
  /** Every port call, in order. The ordering assertions read this. */
  readonly calls: string[];
  /** Whether the work directory is mounted right now. The ports flip it, so a
   *  postcondition observes a world the code changed. */
  readonly mounted: () => boolean;
}

function harness(overrides: {
  running?: boolean;
  mountedAtStart?: boolean;
  mountLands?: boolean;
  cacheExists?: boolean;
  objects?: number;
  bytes?: number;
  syncExit?: number;
} = {}): Harness {
  const calls: string[] = [];
  let mounted = overrides.mountedAtStart ?? false;
  const ports: R2fsPorts = {
    containerRunning: () => overrides.running ?? true,
    readMounts: () => Promise.resolve(mounted ? MOUNTED : NOT_MOUNTED),
    exec: (command) => {
      calls.push(`exec:${command.split(' ')[0]}`);
      if (command.startsWith('sync')) {
        const code = overrides.syncExit ?? 0;
        return Promise.resolve({
          stdout: String(code), stderr: code === 0 ? '' : 'device busy', exitCode: 0,
        });
      }
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    },
    pathExists: (path) => {
      calls.push(`pathExists:${path}`);
      return Promise.resolve(path === R2FS_CACHE_DIR ? overrides.cacheExists ?? true : true);
    },
    mount: (s3fsOptions) => {
      calls.push(`mount:${s3fsOptions.join(',')}`);
      mounted = overrides.mountLands ?? true;
      return Promise.resolve();
    },
    unmount: () => {
      calls.push('unmount');
      mounted = false;
      return Promise.resolve();
    },
    inventory: () => Promise.resolve({
      objects: overrides.objects ?? 12,
      bytes: overrides.bytes ?? 34_567,
    }),
    clearPrefix: () => {
      calls.push('clearPrefix');
      return Promise.resolve(overrides.objects ?? 12);
    },
    log: (message) => calls.push(`log:${message}`),
  };
  return { ports, calls, mounted: () => mounted };
}

async function checkpointOf(record: Harness, kind: CheckpointKind): Promise<CheckpointOutcome> {
  const outcome = await r2fsStorage(record.ports).checkpoint(kind);
  seenCheckpoint.add(outcome.kind);
  return outcome;
}

// ── the option set ──────────────────────────────────────────────────────────

describe('s3fs options — the disk cache is the reason this strategy exists', () => {
  test('a native-disk cache is configured, and dropped on unmount', () => {
    expect(R2FS_S3FS_OPTIONS).toContain(`use_cache=${R2FS_CACHE_DIR}`);
    expect(R2FS_S3FS_OPTIONS).toContain('del_cache');
  });

  test('metadata caching is raised above the SDK default and negative lookups are cached', () => {
    // The SDK passes stat_cache_expire=60. A build stats the same paths
    // thousands of times, so at 60 s the walk pays for the store every minute.
    const expire = R2FS_S3FS_OPTIONS.find(option => option.startsWith('stat_cache_expire='));
    expect(Number(expire?.split('=')[1])).toBeGreaterThan(60);
    expect(R2FS_S3FS_OPTIONS).toContain('enable_noobj_cache');
    const size = R2FS_S3FS_OPTIONS.find(option => option.startsWith('max_stat_cache_size='));
    expect(Number(size?.split('=')[1])).toBeGreaterThan(100_000);
  });

  test('DEPLOYED DEFECT: neither directory-compatibility option is passed', () => {
    // `compat_dir` is not an option s3fs 1.90 accepts, which is the version in
    // the shipped image. Passing it failed the mount outright with `fuse:
    // unknown option 'compat_dir'`, so every r2fs attach failed and the arm
    // produced nothing. The behaviour it asked for is the default there.
    expect(R2FS_S3FS_OPTIONS).not.toContain('compat_dir');
    // And the negative stays out as well: it would turn that default OFF, so a
    // prefix written through the store binding would read as empty.
    expect(R2FS_S3FS_OPTIONS).not.toContain('notsup_compat_dir');
  });

  test('the cache is bounded, so it cannot fill the shared disk', () => {
    // The cache and the work directory share one container disk, and s3fs bounds
    // the cache at nothing by default. Unbounded, it fills the disk and an
    // UNRELATED write fails with ENOSPC, so the failure surfaces nowhere near
    // its cause.
    const reserve = R2FS_S3FS_OPTIONS.find(option => option.startsWith('ensure_diskfree='));
    expect(Number(reserve?.split('=')[1])).toBeGreaterThan(0);
  });

  test('nothing the SDK supplies after the caller is passed here', () => {
    // The SDK spreads its own endpoint and request-style values AFTER these, so
    // passing them is at best a no-op and at worst a refusal.
    for (const supplied of ['use_path_request_style', 'url', 'ahbe_conf', 'ro']) {
      expect(R2FS_S3FS_OPTIONS.map(o => o.split('=')[0])).not.toContain(supplied);
    }
  });

  test('nothing the SDK protects is overridden', () => {
    // `passwd_file` and `url` are refused outright by the SDK for a binding
    // mount, and correctly: they are the credential wiring.
    for (const option of R2FS_S3FS_OPTIONS) {
      expect(option.split('=')[0]).not.toBe('passwd_file');
      expect(option.split('=')[0]).not.toBe('url');
    }
  });
});

// ── attach ──────────────────────────────────────────────────────────────────

describe('attach — the mount must be observed, in the shape claimed', () => {
  test('a fresh box mounts, and reports what the prefix holds', async () => {
    const record = harness({ objects: 7, bytes: 900 });
    const outcome = await r2fsStorage(record.ports).attach();
    expect(outcome.kind).toBe('attached');
    expect(outcome.detail).toBe('r2fs 7 objects 900B');
    expect(record.calls.some(call => call.startsWith('mount:use_cache='))).toBe(true);
  });

  test('an already-mounted box does not remount', async () => {
    const record = harness({ mountedAtStart: true });
    const outcome = await r2fsStorage(record.ports).attach();
    expect(outcome.kind).toBe('already-attached');
    expect(record.calls.filter(call => call.startsWith('mount:'))).toEqual([]);
  });

  test('a mount call that returns without landing FAILS the start', async () => {
    const record = harness({ mountLands: false });
    await expect(r2fsStorage(record.ports).attach())
      .rejects.toThrow(/reported success, but .* is not an s3fs mount/);
  });

  test('a mount that lands without its cache directory FAILS the start', async () => {
    // Otherwise the box runs at store latency for every read while the strategy
    // claims a disk cache, which is a silent performance cliff rather than a
    // failure anyone would notice.
    const record = harness({ cacheExists: false });
    await expect(r2fsStorage(record.ports).attach())
      .rejects.toThrow(/landed without its cache directory/);
  });
});

// ── checkpoint ──────────────────────────────────────────────────────────────

describe('checkpoint — honest about what s3fs already persisted', () => {
  test('an unmounted work directory can answer neither skipped nor committed', async () => {
    const record = harness({ mountedAtStart: false });
    const outcome = await checkpointOf(record, 'quiesce');
    expect(outcome.kind).toBe('failed');
    expect(outcome.reason).toContain('is not an s3fs mount');
    // And no sync was attempted: syncing a directory that is not the mount
    // would report success for work that is going nowhere.
    expect(record.calls.filter(call => call.startsWith('exec:sync'))).toEqual([]);
  });

  test('a sync commits, and reports the bytes the prefix HOLDS', async () => {
    // Not the bytes it moved: s3fs uploads on close, so what a checkpoint moved
    // is not a number this layer knows. What is durable, it does know.
    const record = harness({ mountedAtStart: true, objects: 4, bytes: 2_048 });
    const outcome = await checkpointOf(record, 'quiesce');
    expect(outcome.kind).toBe('committed');
    expect(outcome.bytes).toBe(2_048);
    expect(record.calls.some(call => call.startsWith('exec:sync'))).toBe(true);
  });

  test('a periodic tick and a quiesce do the same work here', async () => {
    // There is no interval to gate: a sync is cheap and idempotent, and s3fs
    // has already written everything that was closed.
    const tick = await checkpointOf(harness({ mountedAtStart: true }), 'tick');
    const quiesce = await checkpointOf(harness({ mountedAtStart: true }), 'quiesce');
    expect(tick.kind).toBe('committed');
    expect(quiesce.kind).toBe('committed');
    expect(tick.bytes).toBe(quiesce.bytes);
  });

  test('an empty prefix is skipped, so committed always means durable bytes exist',
    async () => {
      const record = harness({ mountedAtStart: true, objects: 0, bytes: 0 });
      const outcome = await checkpointOf(record, 'tick');
      expect(outcome.kind).toBe('skipped');
      expect(outcome.reason).toContain('no objects yet');
      expect(outcome.bytes).toBeUndefined();
    });

  test('a failed sync is a failure, not a quiet success', async () => {
    const record = harness({ mountedAtStart: true, syncExit: 1 });
    const outcome = await checkpointOf(record, 'quiesce');
    expect(outcome.kind).toBe('failed');
    expect(outcome.reason).toContain('sync of');
  });

  test('a stopped container is asked nothing', async () => {
    const record = harness({ running: false, mountedAtStart: true });
    expect((await checkpointOf(record, 'tick')).kind).toBe('skipped');
    expect(record.calls).toEqual([]);
  });
});

// ── discard ─────────────────────────────────────────────────────────────────

describe('discard — unmount before deleting', () => {
  test('a live mount is released first, then the prefix is emptied', async () => {
    // Deleting under a live mount leaves s3fs holding metadata for keys that no
    // longer exist, and its next write can recreate some of them from that
    // cache.
    const record = harness({ mountedAtStart: true });
    await r2fsStorage(record.ports).discard();
    expect(record.calls.indexOf('unmount')).toBeLessThan(record.calls.indexOf('clearPrefix'));
  });

  test('with nothing mounted, the prefix is emptied without an unmount', async () => {
    const record = harness({ mountedAtStart: false });
    await r2fsStorage(record.ports).discard();
    expect(record.calls).not.toContain('unmount');
    expect(record.calls).toContain('clearPrefix');
  });
});

// ── mount detection ─────────────────────────────────────────────────────────

describe('mount detection', () => {
  test('a FUSE line at the work directory is a mount; anything else is not', () => {
    expect(isS3fsMounted(MOUNTED, DEVBOX_WORKDIR)).toBe(true);
    expect(isS3fsMounted(NOT_MOUNTED, DEVBOX_WORKDIR)).toBe(false);
    expect(isS3fsMounted(MOUNTED, '/elsewhere')).toBe(false);
  });
});

// ── the denominator ─────────────────────────────────────────────────────────

describe('denominator', () => {
  test('every checkpoint outcome kind was produced above', () => {
    expect([...seenCheckpoint].sort()).toEqual([...CHECKPOINT_OUTCOME_KINDS].sort());
  });

  test('this strategy cannot report an empty attach, and that is stated rather than assumed',
    async () => {
      // `empty` belongs to the snapshot chain: it means no archive was ever
      // recorded. Here a mount always lands or the attach throws, so the answer
      // is `attached` or `already-attached` and the object count travels in the
      // detail instead. Asserted so a future change that starts returning
      // `empty` has to come back and say why.
      const fresh = await r2fsStorage(harness({ objects: 0, bytes: 0 }).ports).attach();
      expect(fresh.kind).toBe('attached');
      expect(fresh.detail).toBe('r2fs 0 objects 0B');
    });
});
