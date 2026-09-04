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

import { Devbox, harness as devboxHarness } from './support/devbox-harness';
import { sessionShellRefusal } from './support/session-shell';
import { describeThrown, type DevboxPolicy } from '../src/lifecycle';
import {
  CHECKPOINT_OUTCOME_KINDS,
  DEVBOX_RUNTIME_DIR,
  DEVBOX_WORKDIR,
  type CheckpointKind,
  type CheckpointOutcome,
  type DevboxStrategyName,
  type DevboxStore,
} from '../src/storage';
import {
  isS3fsMounted,
  R2FS_CACHE_DIR,
  R2FS_S3FS_OPTIONS,
  r2fsStorage,
  type R2fsPorts,
} from '../src/r2fs';
import {
  DEFAULT_DEVBOX_POLICY,
  classifyRecovery,
  ContainerStartOverrun,
  recoveryStep,
  openStartBudget,
  withContainerStartDeadline,
} from '../src/lifecycle';

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
  /** The directories this container holds. An absent runtime directory is the
   *  fresh-container state the deployed r2fs arm died on. */
  readonly directories: () => ReadonlySet<string>;
  /** Create a directory in this container, as a command that runs from a cwd
   *  the container holds would. */
  readonly makeDirectory: (path: string) => void;
}

/**
 * ONE r2fs box on the platform stand-in, with a store the ports can read.
 *
 * The stop order is a property of the Devbox class's own `quiesce`, not of the
 * strategy's detach alone, so the red test has to drive the real class with
 * the r2fs adapter underneath it — the same stand-in `lifecycle-generation`
 * drives, with the one addition the stop order needs: the container fake
 * holds a work-directory holder whose unmount answers EBUSY, exactly as a
 * live s3fs mount does.
 */
class R2fsQuiesceBox extends Devbox<Record<string, never>> {
  protected override get strategy(): DevboxStrategyName {
    return 'r2fs';
  }

  protected override get store(): DevboxStore {
    // SAFETY: constructed against the R2Bucket contract — the fake provides
    // exactly the members the r2fs ports reach (`prefixInventory` on a listing
    // and `deletePrefix` on the same), verified by this suite driving the
    // whole attach/checkpoint/stop cycle through the real class below.
    const bucket: R2Bucket = Object.create({ list: () => ({ objects: [], truncated: false }) });
    return { binding: 'BACKUP_BUCKET', bucket };
  }

  protected override get ambientCheckpoints(): boolean {
    return false;
  }

  protected override get policy(): DevboxPolicy {
    return { ...DEFAULT_DEVBOX_POLICY, portWaitMs: 4, portProbeIntervalMs: 1 };
  }
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
  /** A reference the strategy may NOT revoke: an ancestor of the scan's own
   *  shell, or one of the container server's own children sitting on the mount.
   *  Parking the session cannot clear it, so an ordinary unmount stays refused
   *  and only a lazy detach can release the mount. */
  unrevocableHolder?: boolean;
  /** Even `MNT_DETACH` cannot release the mount. The only state in which a
   *  release failure reaches a caller, so it is the only one that can prove what
   *  that caller is told. */
  lazyUnmountRefuses?: boolean;
  /** A fresh container: the runtime directory does not exist until something
   *  creates it. The deployed r2fs arm died here — its port wiring runs every
   *  command FROM the runtime dir, and the session's chdir killed it before
   *  the mkdir that would have created the dir could run. */
  runtimeDirExists?: boolean;
} = {}): Harness {
  const calls: string[] = [];
  let mounted = overrides.mountedAtStart ?? false;
  let mountpoint = [...overrides.mountpointEntries ?? []];
  const quarantined: string[] = [];
  // The container's directory set. A fresh per-arm container holds the
  // image's own paths and nothing under /var/tmp/devbox — the runtime dir is
  // ours to create, and nothing creates it before the r2fs attach runs.
  const directories = new Set<string>(
    overrides.runtimeDirExists === false ? ['/workspace'] : ['/workspace', DEVBOX_RUNTIME_DIR],
  );
  // WHERE THE SHARED SESSION SHELL IS STANDING. The SDK creates its default
  // session with `cwd: "/workspace"` — the mount point — so that is the state
  // this starts in, and every port that runs a command moves it the way an
  // exec's cwd option does.
  let sessionCwd = DEVBOX_WORKDIR;
  const ports: R2fsPorts = {
    containerRunning: () => overrides.running ?? true,
    readMounts: () => Promise.resolve(mounted ? MOUNTED : NOT_MOUNTED),
    // THE PARSE FIRST, as the container's session shell does it: a composed
    // command it cannot run kills the session rather than answering. See
    // `support/session-shell.ts`.
    exec: (command) => {
      const refused = sessionShellRefusal(command);
      if (refused !== undefined) {
        calls.push(`sessionKilled:${command.split(' ')[0]}`);
        return Promise.reject(refused);
      }
      // THE SDK SESSION CHDIRS BEFORE IT RUNS ANY COMMAND. A cwd the container
      // does not hold kills the session with the deployed words — the exact
      // refusal the r2fs arm recorded twice on 2026-09-03 — so the fake models
      // it: every exec declares its cwd, and a missing one never runs.
      if (overrides.runtimeDirExists === false && !directories.has(DEVBOX_RUNTIME_DIR)
        && commandRunFromRuntimeDir(command)) {
        calls.push(`execFailed:${command.split(' ')[0]}`);
        return Promise.resolve({
          stdout: '',
          stderr: `Failed to change directory to '${DEVBOX_RUNTIME_DIR}'`,
          exitCode: 1,
        });
      }
      calls.push(`exec:${command.split(' ')[0]}`);
      if (command.startsWith('sync')) {
        const code = overrides.syncExit ?? 0;
        return Promise.resolve({
          stdout: String(code), stderr: code === 0 ? '' : 'device busy', exitCode: 0,
        });
      }
      // mkdir -p creates what it names, once its cwd exists.
      for (const made of command.matchAll(/'(\/[^']+)'/g)) {
        directories.add(made[1]!);
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
    // THE REFUSAL A REAL fusermount GIVES, and the reference it gives it for.
    // This stand-in used to unmount unconditionally, which is precisely why
    // every deployed r2fs stop could refuse while this suite stayed green: the
    // one thing that actually holds the mount was not modelled at all. A shell
    // standing on a mount is a reference to it — measured on a real mount, and
    // measured again in deployed probe `hp0901170218`, where the identical
    // `fusermount -u` refused with the session inside and returned 0 with it
    // parked outside.
    unmount: () => {
      calls.push('unmount');
      if (sessionCwd === DEVBOX_WORKDIR || sessionCwd.startsWith(`${DEVBOX_WORKDIR}/`)) {
        return Promise.reject(new Error(
          `fusermount -u failed (exit 1): fusermount: failed to unmount ${DEVBOX_WORKDIR}: `
          + 'Device or resource busy',
        ));
      }
      if (overrides.unrevocableHolder === true) {
        // A reference this strategy may not revoke — an ancestor of the scan's
        // own shell, or one of the container server's children. Parking the
        // session cannot clear it, so an ordinary unmount stays refused.
        return Promise.reject(new Error(
          `fusermount -u failed (exit 1): fusermount: failed to unmount ${DEVBOX_WORKDIR}: `
          + 'Device or resource busy',
        ));
      }
      mounted = false;
      return Promise.resolve();
    },
    // `cd` MOVES THE SHARED SESSION, and it stays moved: that persistence is
    // the whole mechanism, because the SDK's own unmount passes no cwd and
    // inherits wherever this left the shell.
    parkSession: () => {
      calls.push('parkSession');
      sessionCwd = DEVBOX_RUNTIME_DIR;
      return Promise.resolve(DEVBOX_RUNTIME_DIR);
    },
    // MNT_DETACH removes the mount from the namespace even with live
    // references, which is measured on a real mount against a live cwd holder.
    // `lazyUnmountRefuses` is the one state where even that cannot release it —
    // the only path on which a release failure reaches a caller at all.
    lazyUnmount: () => {
      calls.push('lazyUnmount');
      if (overrides.lazyUnmountRefuses === true) return Promise.resolve(false);
      mounted = false;
      return Promise.resolve(true);
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
    directories: () => directories,
    makeDirectory: (path) => directories.add(path),
  };
}

/**
 * Whether the r2fs port wiring runs this command from the runtime directory —
 * the wiring every `readMounts`/`exec`/`quarantineMountpoint` port declares in
 * `devbox.ts` (`#rawExec(command, DEVBOX_RUNTIME_DIR)`), which is what the
 * deployed chdir refusal named.
 */
function commandRunFromRuntimeDir(command: string): boolean {
  // The harness cannot see the cwd the ports declared; the commands the r2fs
  // ports compose from the runtime dir are these four shapes. Modelled by
  // shape rather than by a new port argument so the port signature — the
  // product's own seam — stays exactly as the strategy consumes it.
  return command.startsWith('d=') || command.startsWith('cat /proc/mounts')
    || command.startsWith('mkdir') || command.startsWith('find')
    || command.startsWith('sync') || command.startsWith('test -');
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

  test('a refusal names the DEFECT and carries the release failure as its cause', async () => {
    // A release failure MUST NOT REPLACE the sentence naming the defect, which
    // is the only thing telling a caller why this mount was rejected. Measured
    // against the init gate's restore deadline: past it a release command is not
    // issued at all, and a bare throw from the release produced a report with no
    // mention of what was wrong with the mount.
    //
    // Nothing is lost by wrapping instead: `classifyRecovery` walks the cause
    // chain and returns on the first classified value, so a gate refusal buried
    // under this sentence still classifies and still retries; `describeThrown`
    // renders the chain, so ONE reason carries both facts.
    const record = harness({
      mountedAtStart: true,
      cacheExists: false,
      unrevocableHolder: true,
      lazyUnmountRefuses: true,
    });

    let thrown: Error | undefined;
    try {
      await r2fsStorage(record.ports).attach();
    } catch (error) {
      thrown = error instanceof Error ? error : new Error(String(error));
    }

    expect(thrown).toBeInstanceOf(Error);
    if (thrown === undefined) return;
    // The DEFECT, in the outermost sentence a caller reads first.
    expect(thrown.message).toContain('mounted without its cache directory');
    // And the honest consequence, because the mount is still up.
    expect(thrown.message).toContain('could NOT be released');
    // The refusal itself, reachable rather than discarded.
    expect(describeThrown({ cause: thrown })).toContain('Device or resource busy');
    // Both release attempts really were made before the caller was told.
    expect(record.calls).toContain('parkSession');
    expect(record.calls).toContain('lazyUnmount');
    expect(record.mounted()).toBe(true);
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

// ── the stop order, against the real Devbox class ──────────────────────────
//
// MEASURED DEFECT THIS REPAIRS. `quiesce` used to run `storage.detach()` —
// s3fs's unmount — BEFORE `stop('SIGTERM')`, and fusermount refuses an
// unmount with an open fd (EBUSY). One open writer therefore made the box
// UNSTOPPABLE: the refusal landed before `stop()` was ever reached, every
// later stop died the same way, and no teardown could clean the box up.
//
// The order has to be: checkpoint (the final commit), release the work
// directory's holders, detach, stop. The platform stand-in in
// `support/devbox-harness.ts` models the holder exactly as the real one
// behaves — an unmount refuses while the holder lives, and the release
// command's signal work is what clears it — so the assertions below read the
// sequence rather than a mock's tally of calls.
describe('the stop order: holders are released before the mount is detached', () => {
  test('an open writer does not make the box unstoppable', async () => {
    const { box, container } = devboxHarness(R2fsQuiesceBox);
    container.workdirHolder = { pid: 4242, comm: 'bun' };
    await box.devboxStartup();
    expect(container.s3fsMounts.has(DEVBOX_WORKDIR)).toBe(true);

    const outcome = await box.quiesce();

    // The stop completed: the holder was signalled inside the release command
    // (which the stand-in clears, as the real TERM does), the unmount landed
    // behind it, and the container was stopped. The checkpoint itself reports
    // `skipped` because the store holds no objects — the honest answer for an
    // empty prefix, and not what this test is about.
    expect(['committed', 'skipped']).toContain(outcome.kind);
    // ONE chronological channel for both the release command and the unmount,
    // because the order this test pins lives ACROSS the exec and mount APIs.
    //
    // BOTH ROWS ARE REQUIRED TO EXIST BEFORE THEY ARE COMPARED. `findIndex`
    // answers -1 for a row that is not there and -1 is less than every index,
    // so an ordering written only as a comparison stays green when the command
    // it names changes shape — which this assertion really did the moment the
    // release command's first word changed.
    const released = container.sequence.indexOf('exec:release-workdir-holders');
    const detached = container.sequence.indexOf('unmount:/workspace');
    expect({ released: released >= 0, detached: detached >= 0 })
      .toEqual({ released: true, detached: true });
    expect(detached).toBeGreaterThan(released);
    expect(container.s3fsMounts.has(DEVBOX_WORKDIR)).toBe(false);
    expect(container.running.running).toBe(false);
    expect(container.stops).toBe(1);
  });

  test('the session is moved OUT of the work directory before the mount is released', async () => {
    // THE DEFECT EVERY DEPLOYED r2fs STOP DIED OF, at class level. The SDK
    // issues `fusermount -u` through a session it created with
    // `cwd: "/workspace"`, and a shell standing on a mount holds that mount, so
    // the unmount was refused by the very session asking for it — with the
    // holder scan's names taking the blame. Measured as a controlled experiment
    // in deployed probe `hp0901170218`: the identical `fusermount -u` answered
    // `Device or resource busy` with the session inside the mount and `0` with
    // it parked outside, adjacent in time, with no holder alive in either arm.
    const { box, container } = devboxHarness(R2fsQuiesceBox);
    await box.devboxStartup();
    // The attach ran commands in the work directory, so the session is standing
    // exactly where the SDK leaves it before a stop.
    container.sessionCwd = DEVBOX_WORKDIR;

    const outcome = await box.quiesce();

    expect(['committed', 'skipped']).toContain(outcome.kind);
    // Released outright — no lazy fallback needed, because the only reference
    // was the session's own cwd and parking it is a real repair rather than a
    // workaround.
    expect(container.sequence).not.toContain('exec:lazy-unmount');
    expect({
      stillMounted: container.s3fsMounts.has(DEVBOX_WORKDIR),
      stopped: container.stops,
      parkedOutside: container.sessionCwd.startsWith(DEVBOX_WORKDIR),
    }).toEqual({ stillMounted: false, stopped: 1, parkedOutside: false });
  });

  test('a holder that IS this session is named, and the mount is still released', async () => {
    // The container's exec channel can hold the work directory too, and the
    // scan runs inside it: signalling an ancestor of its own shell would kill
    // the session the stop is speaking through, so the command reports that
    // holder instead. Proven against real `/proc` in `decisions.test.ts`.
    //
    // WHAT CHANGED HERE: naming it used to be the END of the story, and the box
    // was left unstoppable — mount up, container running, billing, with no
    // sequence of calls that could ever release it, because the one holder the
    // scan must never signal is also the one that never goes away. A reference
    // this strategy may not revoke is exactly what `MNT_DETACH` is for, so the
    // stop now completes and the holder is named in the log instead of in a
    // refusal.
    const { box, container } = devboxHarness(R2fsQuiesceBox);
    container.workdirHolder = { pid: 31, comm: 'sandbox-session', session: true };
    await box.devboxStartup();

    const outcome = await box.quiesce();

    expect(['committed', 'skipped']).toContain(outcome.kind);
    expect(container.sequence).toContain('exec:lazy-unmount');
    expect({
      stillMounted: container.s3fsMounts.has(DEVBOX_WORKDIR),
      stopped: container.stops,
      // The session survived the scan: the fake answers every later command,
      // which is exactly what a killed session would not do.
      answersAfterwards: (await container.exec('true')).exitCode,
    }).toEqual({ stillMounted: false, stopped: 1, answersAfterwards: 0 });
  });

  test('a cwd-only holder — invisible to an fd scan — is named and does not wedge the stop',
    async () => {
      // SIX OF THESE WERE LIVE IN THE DEPLOYED CONTAINER and none of them was
      // ever reported: `node` children of the container server sitting at
      // `cwd=/workspace` with zero `/proc/<pid>/fd` matches, while the scan
      // matched fds alone. A cwd inside a mount is a mount reference — the same
      // EBUSY an open fd earns — so these were both the least visible and the
      // least accounted-for references on the mount.
      const { box, container } = devboxHarness(R2fsQuiesceBox);
      container.workdirHolder = { pid: 93, comm: 'node', cwdOnly: true };
      await box.devboxStartup();

      const outcome = await box.quiesce();

      expect(['committed', 'skipped']).toContain(outcome.kind);
      // NAMED, on the channel the scan uses for what it declined to signal.
      expect(container.sequence).toContain('exec:lazy-unmount');
      expect({
        stillMounted: container.s3fsMounts.has(DEVBOX_WORKDIR),
        stopped: container.stops,
      }).toEqual({ stillMounted: false, stopped: 1 });
    });

  test('a holder that survives the signals is NAMED, and the mount is taken lazily', async () => {
    const { box, container } = devboxHarness(R2fsQuiesceBox);
    container.workdirHolder = { pid: 777, comm: 'stubborn-writer', survives: true };
    await box.devboxStartup();

    const outcome = await box.quiesce();

    // THE FLUSH RAN FIRST, which is what makes taking the mount lazily a
    // release rather than a data loss: `detach` checks its `sync -f` before it
    // reaches any unmount at all.
    expect(['committed', 'skipped']).toContain(outcome.kind);
    const synced = container.sequence.indexOf('exec:sync');
    const lazy = container.sequence.indexOf('exec:lazy-unmount');
    expect({ synced: synced >= 0, lazy: lazy >= 0 }).toEqual({ synced: true, lazy: true });
    expect(lazy).toBeGreaterThan(synced);
    expect({
      stillMounted: container.s3fsMounts.has(DEVBOX_WORKDIR),
      stopped: container.stops,
    }).toEqual({ stillMounted: false, stopped: 1 });
  });
});

// ── the runtime directory a cold attach stands in ───────────────────────────
//
// THE DEPLOYED DEFECT, in the arm's own recorded words: `create failed: cold
// attach refused: /workspace could not be emptied for a mount: Failed to
// change directory to '/var/tmp/devbox'` — run 20260903140046, and the same
// refusal in the aborted launch before it, so it reproduced across both
// launches of the day. The r2fs port wiring names the runtime directory as the
// cwd of every command it issues; the session shell chdirs before it runs
// anything; and a fresh per-arm container holds no `/var/tmp/devbox` at all
// (every arm gets its own worker and its own container, so no sibling
// strategy's mountStore has ever created it there). The session died on the
// chdir — and the `mkdir -p` that would have created the directory travels
// through that very exec, so the box could never dig itself out.
//
// Driven through the REAL class against the container stand-in, because the
// defect lives in the port wiring rather than in the strategy: a fake standing
// in for the ports cannot see the cwd they declare.

describe('a cold attach on a fresh container establishes its runtime directory', () => {
  test('the attach mounts where the deployed arm died on the chdir', async () => {
    const { box, container } = devboxHarness(R2fsQuiesceBox);
    // The fresh container: the image's own paths, and nothing of ours.
    expect(container.directories.has(DEVBOX_RUNTIME_DIR)).toBe(false);

    await box.devboxStartup();

    // No command was refused its cwd, the runtime directory exists, and the
    // work directory carries the mount this strategy claims.
    expect(container.sequence.filter((row) => row.startsWith('chdirRefused:'))).toEqual([]);
    expect(container.directories.has(DEVBOX_RUNTIME_DIR)).toBe(true);
    expect(container.s3fsMounts.has(DEVBOX_WORKDIR)).toBe(true);
  });
});
