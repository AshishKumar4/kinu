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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';

import {
  isS3fsMounted,
  R2FS_CACHE_DIR,
  R2FS_S3FS_OPTIONS,
  r2fsStorage,
  type R2fsPorts,
} from '../src/r2fs';
import {
  classifyRecovery,
  ContainerStartOverrun,
  recoveryStep,
  openStartBudget,
  withContainerStartDeadline,
} from '../src/lifecycle';
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
  /** What the BARE mountpoint holds right now. Empty is the state a mount
   *  requires, so this is the postcondition a stop owes the next attach. */
  readonly mountpoint: () => readonly string[];
  /** What was moved aside, so a test can prove nothing was destroyed. */
  readonly quarantined: () => readonly string[];
}

function harness(overrides: {
  running?: boolean;
  mountedAtStart?: boolean;
  mountLands?: boolean;
  cacheExists?: boolean;
  objects?: number;
  bytes?: number;
  syncExit?: number;
  /** Entries sitting in the BARE mountpoint, as a container left them when it
   *  was written to with nothing mounted. `mount` refuses while any remain,
   *  which is what s3fs does. */
  mountpointEntries?: readonly string[];
  /** The mount call never answers, which is what a stalled store request looks
   *  like from here: s3fs is inside its own connect and retry budgets and this
   *  side has nothing to observe. */
  mountHangs?: boolean;
} = {}): Harness {
  const calls: string[] = [];
  let mounted = overrides.mountedAtStart ?? false;
  let mountpoint = [...overrides.mountpointEntries ?? []];
  const quarantined: string[] = [];
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
      if (overrides.mountHangs === true) return Promise.withResolvers<void>().promise;
      // THE REFUSAL THIS STRATEGY HAS TO SURVIVE, in s3fs's own words. The
      // deployed `r2fs` arm died of it twice, and every later attach was refused
      // for the same reason, so a stand-in that always mounts could not see the
      // defect at all.
      if (mountpoint.length > 0) {
        return Promise.reject(new Error(
          `S3FS mount failed: s3fs: MOUNTPOINT directory ${DEVBOX_WORKDIR} is not empty. `
          + "if you are sure this is safe, can use the 'nonempty' mount option.",
        ));
      }
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
    quarantineMountpoint: () => {
      calls.push('quarantineMountpoint');
      quarantined.push(...mountpoint);
      const moved = mountpoint.length;
      mountpoint = [];
      return Promise.resolve(moved);
    },
    log: (message) => calls.push(`log:${message}`),
  };
  return {
    ports,
    calls,
    mounted: () => mounted,
    mountpoint: () => [...mountpoint],
    quarantined: () => [...quarantined],
  };
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

// ── the request bounds ──────────────────────────────────────────────────────
//
// KINU-038 read this list as omitting connection, read-write, multirequest and
// retry bounds. It does not set them, which is not the same thing: s3fs compiles
// its own, the SDK adds none, and those defaults are facts about ONE pinned
// image. Recording a fact twice is how a fact drifts, so the module records them
// in prose and these tests make the prose fail when the image moves.

const PINNED_SANDBOX = '0.12.8';

/** The exact version the recorded s3fs defaults were read against. A range would
 *  defeat the whole pin. */
function pinnedSandboxVersion(): string {
  const manifest = v.parse(
    v.object({ dependencies: v.object({ '@cloudflare/sandbox': v.string() }) }),
    JSON.parse(readFileSync(join(import.meta.dir, '../package.json'), 'utf8')),
  );
  return manifest.dependencies['@cloudflare/sandbox'];
}

describe('the request bounds are facts about a pinned image, not options', () => {
  test('the pinned sandbox version is the one the recorded defaults were read from', () => {
    // A bump lands here FIRST. The s3fs in the new image may not be 1.90, and
    // every default recorded in r2fs.ts — connect_timeout=300,
    // readwrite_timeout=120, retries=5, multireq_max=20 — has to be re-read from
    // that version's man page before this string moves.
    expect(pinnedSandboxVersion()).toBe(PINNED_SANDBOX);
  });

  test('the recorded defaults and the pinned version cannot move apart', () => {
    const module = readFileSync(join(import.meta.dir, '../src/r2fs.ts'), 'utf8');
    expect(module).toContain(`cloudflare/sandbox:${PINNED_SANDBOX}`);
    expect(module).toContain('v1.90');
    for (const recorded of [
      'connect_timeout=300', 'readwrite_timeout=120', 'retries=5', 'multireq_max=20',
    ]) {
      expect(module).toContain(recorded);
    }
  });

  test('no request bound is restated as an option', () => {
    const names = R2FS_S3FS_OPTIONS.map(option => option.split('=')[0]);
    for (const bound of ['connect_timeout', 'readwrite_timeout', 'retries', 'multireq_max']) {
      expect(names).not.toContain(bound);
    }
  });

  test('max_thread_count is never passed: s3fs 1.90 has no such option', () => {
    // Same class of defect as `compat_dir`: an option the shipped s3fs does not
    // know fails the mount outright, so every attach on this strategy would die.
    expect(R2FS_S3FS_OPTIONS.map(option => option.split('=')[0]))
      .not.toContain('max_thread_count');
  });

  test('a stalled mount is cancelled by the attach owner, never waited out by s3fs', async () => {
    // The trigger, from the strategy side. s3fs would spend 300s connecting and
    // then retry five times; nothing here observes any of that. What ends it is
    // the attach budget abandoning the work, whose recovery class is `abandoned`
    // and whose step is REPLACE — destroying the container identity is the
    // cancellation, because work left inside an unfenceable container cannot be
    // stopped any other way.
    //
    // The class-level proof that `replace` destroys once, persists the stage
    // first and proves the container gone lives in lifecycle-generation.test.ts
    // ("the SECOND failure of that identity destroys it, and proves it gone");
    // decisions.test.ts owns the budget and taxonomy cases. This test owns only
    // the link they cannot reach: a real strategy attach that never returns.
    const record = harness({ mountHangs: true });
    const late: string[] = [];
    const run = withContainerStartDeadline(
      'Devbox.attach',
      openStartBudget(0),
      () => r2fsStorage(record.ports).attach(),
      (failure) => { late.push(String(failure.cause)); },
    );

    let overrun: { readonly cause: unknown } | undefined;
    try {
      await run;
    } catch (error) {
      // A caught binding is not a parameter, so the thrown value reaches the
      // classifier without a boundary that admits anything.
      overrun = { cause: error };
    }
    expect(overrun?.cause).toBeInstanceOf(ContainerStartOverrun);
    expect(classifyRecovery(overrun ?? { cause: undefined })).toBe('abandoned');
    expect(recoveryStep({
      owned: true, failure: 'abandoned', stage: undefined,
    })).toEqual({ action: 'replace', stage: 'replace' });
    // The mount was reached and never answered, and the attach did not proceed
    // past it: no read-back, no inventory, no `attached` outcome.
    expect(record.calls.some(call => call.startsWith('mount:'))).toBe(true);
    expect(record.calls).not.toContain('unmount');
    expect(late).toEqual([]);
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
      .rejects.toThrow(/mounted without its cache directory/);
  });

  // KINU-038. A refusal used to be thrown OVER a live mount. The mount stayed,
  // /proc/mounts showed it, and the very next attach reported
  // `already-attached` on the mount the previous one had just rejected — one
  // broken mount, refused once and then accepted for the rest of the
  // container's life.
  test('a refused mount is unmounted, so nothing is left for a later attach to adopt', async () => {
    const record = harness({ cacheExists: false });

    await expect(r2fsStorage(record.ports).attach()).rejects.toThrow(/Unmounted/);

    expect(record.calls).toContain('unmount');
    expect(record.mounted()).toBe(false);
  });

  test('a mount already there is CHECKED, not adopted', async () => {
    // The state the old refusal left behind: mounted, and missing its cache.
    const record = harness({ mountedAtStart: true, cacheExists: false });

    await expect(r2fsStorage(record.ports).attach())
      .rejects.toThrow(/was already mounted, but .* mounted without its cache directory/);

    expect(record.calls).toContain('unmount');
    expect(record.mounted()).toBe(false);
  });

  test('a healthy mount already there is still adopted without a remount', async () => {
    const record = harness({ mountedAtStart: true });

    expect((await r2fsStorage(record.ports).attach()).kind).toBe('already-attached');
    expect(record.calls).not.toContain('unmount');
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

// ── the mountpoint, across a stop and back ──────────────────────────────────
//
// MEASURED, TWICE. The deployed `r2fs` arm of runs 20260831031426 and
// 20260831143544 died at its third attach with
//
//   S3FS mount failed: s3fs: MOUNTPOINT directory /workspace is not empty
//
// and that refusal is TERMINAL: the directory is still not empty on the next
// attach, so the box never attaches again. What put entries there is a container
// replaced under an attached box — the readiness gate accepted this object's
// in-memory `attached` restoration as proof that the new container held the
// mount, so writes went to the bare directory. The commit path now re-attaches
// when the generation changed (see devbox.ts), and these are the two halves the
// strategy itself owes: a stop that leaves the mountpoint mountable, and an
// attach that is not defeated by one that was not.

describe('the mountpoint a stop leaves behind', () => {
  test('detach leaves an empty mountpoint, which is what the next mount requires', async () => {
    const record = harness({ mountedAtStart: true, mountpointEntries: ['stranded.txt'] });

    await r2fsStorage(record.ports).detach?.();

    expect(record.calls).toContain('unmount');
    expect(record.mountpoint()).toEqual([]);
    // MOVED, NOT DELETED. Those bytes were never durable — nothing was mounted
    // when they were written — but they are still the caller's, so the sweep
    // keeps them where an operator can find them.
    expect(record.quarantined()).toEqual(['stranded.txt']);
  });

  test('a stop then attach cycle mounts, where an unswept mountpoint refused forever', async () => {
    const record = harness({ mountedAtStart: true, mountpointEntries: ['stranded.txt'] });
    const storage = r2fsStorage(record.ports);

    await storage.detach?.();
    const outcome = await storage.attach();

    expect(outcome.kind).toBe('attached');
    expect(record.mounted()).toBe(true);
  });

  test('an attach sweeps a mountpoint no stop ever swept, instead of being refused', async () => {
    // The container was replaced, the writes landed on a bare directory, and no
    // detach ran on that container at all: the sweep has to be part of the
    // mount's own precondition, not only of the stop.
    const record = harness({ mountpointEntries: ['.devbox-bench', 'ladder'] });

    const outcome = await r2fsStorage(record.ports).attach();

    expect(outcome.kind).toBe('attached');
    expect(record.calls.indexOf('quarantineMountpoint'))
      .toBeLessThan(record.calls.findIndex(call => call.startsWith('mount:')));
    expect(record.quarantined()).toEqual(['.devbox-bench', 'ladder']);
  });

  test('a detach on a stopped container asks the container nothing', async () => {
    const record = harness({ running: false, mountedAtStart: true });
    await r2fsStorage(record.ports).detach?.();
    expect(record.calls).toEqual([]);
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
