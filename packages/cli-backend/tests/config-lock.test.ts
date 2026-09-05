import { describe, expect, test } from 'bun:test';
import { lstatSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '@kinu.run/test-utils';
import { tolerate } from '@kinu.run/core/obs';
import {
  createConfigLock, createProcessIdentityBoundary, darwinStartIdentity, decodeLockOwner, encodeLockOwner,
  procStartTicks, withConfigLock, withConfigLockAsync, type LockOwner,
} from '../src/config-lock';

/**
 * The lock's OWNERSHIP rules, driven in-process. The cross-process proofs live in
 * packages/cli/tests/config-lock.test.ts and
 * packages/cli-backend/tests/codex-refresh-processes.test.ts. What is exact in
 * one process is whose lock a release removes, and which locks may be broken at
 * all.
 *
 * Breakability is process identity, never duration: pid plus the process start
 * time the kernel reports in `/proc/<pid>/stat`. So every scenario below forges a
 * record with a KNOWN identity — this process (alive), a reaped child (gone), or
 * this pid with the wrong start time (reused) — instead of moving a clock.
 *
 * No test waits on the clock. Two properties of the implementation stand in for
 * it: an acquisition's FIRST attempt is synchronous, so a refusal is observable
 * the instant the call returns, and a contender's acquisition resolves as a
 * promise, so waiting for one is awaiting a signal rather than guessing.
 */
describe('the config lock is held by a process, not by a path', () => {
  function scratchConfig() {
    const configPath = join(scratchDir('config-lock'), 'config.json');
    return { configPath, lockPath: `${configPath}.lock` };
  }

  /** A held lock is a symlink to its owner record, not a file, so `existsSync` —
   *  which follows the link — answers false for a lock that is very much there. */
  function lockHeld(lockPath: string): boolean {
    return tolerate(() => lstatSync(lockPath), 'enoent') !== undefined;
  }

  /** A versioned owner record is the symlink target, which is how a real
   *  acquisition writes one. Linux records name field 22 of procfs. */
  function forgeLock(lockPath: string, pid: number, startTicks: string): void {
    symlinkSync(encodeLockOwner({
      version: 'v1',
      platform: 'linux',
      token: '00000000-0000-4000-8000-000000000001',
      pid,
      identity: startTicks,
    }), lockPath);
  }

  function selfStartTicks(): string {
    const ticks = procStartTicks(readFileSync(`/proc/${String(process.pid)}/stat`, 'utf8'));
    if (ticks === null) throw new Error('this process has no readable start time');
    return ticks;
  }

  /** A pid that Linux has finished with. `spawnSync` has already reaped it, so
   *  `/proc/<pid>` is gone and the kernel's answer is unambiguous. */
  function reapedPid(): number {
    return Bun.spawnSync({ cmd: ['/bin/true'] }).pid;
  }

  test('an async callback smuggled through a void signature is refused', () => {
    const { configPath, lockPath } = scratchConfig();
    // No cast anywhere: TypeScript assigns `() => Promise<void>` to
    // `() => void`, which is exactly how the Codex refresh reached the
    // synchronous helper and had its lock released at the first await.
    const declaredVoid: () => void = async () => { await Promise.resolve(); };

    expect(() => withConfigLock(configPath, declaredVoid)).toThrow(
      'withConfigLock ran a callback that returned pending work, which the lock does not cover. Use withConfigLockAsync.',
    );
    // And the refusal is not a wedge: the lock is gone and the next caller runs.
    expect(lockHeld(lockPath)).toBe(false);
    expect(withConfigLock(configPath, () => 'after')).toBe('after');
  });

  test('the await-aware helper holds the lock until the callback settles', async () => {
    const { configPath, lockPath } = scratchConfig();
    const order: string[] = [];
    const entry = Promise.withResolvers<void>();
    const hold = Promise.withResolvers<void>();

    const first = withConfigLockAsync(configPath, async () => {
      order.push('first enters');
      entry.resolve();
      await hold.promise;
      order.push('first leaves');
    });
    await entry.promise;

    // The contender's first attempt runs synchronously inside this call, so the
    // assertion below observes a real refusal and not a race that happened to
    // resolve this way.
    const second = withConfigLockAsync(configPath, async () => {
      order.push('second enters');
      await Promise.resolve();
    });
    expect(order).toEqual(['first enters']);

    hold.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['first enters', 'first leaves', 'second enters']);
    expect(lockHeld(lockPath)).toBe(false);
  });

  test('a holder whose lock was replaced does not delete the replacement', async () => {
    const { configPath, lockPath } = scratchConfig();

    await withConfigLockAsync(configPath, async () => {
      await Promise.resolve();
      // Somebody else owns the path now. Releasing by path would hand a third
      // caller a lock two processes believe they hold.
      unlinkSync(lockPath);
      forgeLock(lockPath, process.pid, selfStartTicks());
    });

    expect(decodeLockOwner(readlinkSync(lockPath))?.token).toBe('00000000-0000-4000-8000-000000000001');
  });

  test('a lock whose process no longer exists is broken at once', () => {
    const { configPath, lockPath } = scratchConfig();
    forgeLock(lockPath, reapedPid(), '12345');

    let ownerInside = '';
    withConfigLock(configPath, () => {
      ownerInside = readlinkSync(lockPath);
    });

    // Taken over on the FIRST attempt — a crashed holder costs the next caller
    // nothing, where waiting out a staleness window cost it that window.
    expect(decodeLockOwner(ownerInside)).toMatchObject({
      platform: 'linux',
      pid: process.pid,
      identity: selfStartTicks(),
    });
    expect(lockHeld(lockPath)).toBe(false);
  });

  test('a lock whose pid was reused by another process is broken', () => {
    const { configPath, lockPath } = scratchConfig();
    // This pid is alive — it is ours — but the recorded process started at a
    // different time, so the record names a process that is gone and whose
    // number has since been handed to us. Age would have said "fresh".
    forgeLock(lockPath, process.pid, '1');

    withConfigLock(configPath, () => undefined);
    expect(lockHeld(lockPath)).toBe(false);
  });

  test('a lock held by a live process is never broken, however long it holds', async () => {
    const { configPath, lockPath } = scratchConfig();
    // The identity of a process that is definitely running: this one. There is
    // no age to advance, which is the point — duration is not a reason.
    forgeLock(lockPath, process.pid, selfStartTicks());

    let ran = false;
    const blocked = withConfigLockAsync(configPath, async () => {
      await Promise.resolve();
      ran = true;
    });
    // The first attempt has already happened, synchronously, and refused.
    expect(decodeLockOwner(readlinkSync(lockPath))).toMatchObject({
      platform: 'linux',
      pid: process.pid,
      identity: selfStartTicks(),
    });
    expect(ran).toBe(false);

    unlinkSync(lockPath);
    await blocked;
    expect(ran).toBe(true);
  });

  test('a lock this program did not write is waited out, never stolen', async () => {
    const { configPath, lockPath } = scratchConfig();
    // A regular file at the lock path carries no owner record, so no process can
    // be proven to hold it or to have abandoned it. Breaking it is how two
    // processes both proceed; acquisition waits, and the timeout names the path.
    writeFileSync(lockPath, 'not a record\n');

    let ran = false;
    const blocked = withConfigLockAsync(configPath, async () => {
      await Promise.resolve();
      ran = true;
    });
    expect(ran).toBe(false);
    expect(lockHeld(lockPath)).toBe(true);

    unlinkSync(lockPath);
    await blocked;
    expect(ran).toBe(true);
  });

  test('a record missing its process identity is unreadable, not abandoned', async () => {
    const { configPath, lockPath } = scratchConfig();
    // Half a record proves nothing either way. Fail closed: an unreadable owner
    // is the one case where the caller waits rather than deciding for itself.
    symlinkSync('token-only', lockPath);

    let ran = false;
    const blocked = withConfigLockAsync(configPath, async () => {
      await Promise.resolve();
      ran = true;
    });
    expect(ran).toBe(false);
    expect(readlinkSync(lockPath)).toBe('token-only');

    unlinkSync(lockPath);
    await blocked;
    expect(ran).toBe(true);
  });

  test('the start time is read past the executable name, parentheses and all', () => {
    // Field 22 of a real /proc line, against the kernel's own answer.
    const stat = readFileSync(`/proc/${String(process.pid)}/stat`, 'utf8');
    expect(procStartTicks(stat)).toBe(stat.split(' ')[21]);
    expect(procStartTicks(stat)).toMatch(/^\d+$/u);
    // The whole reason for reading past the LAST `)`: field 2 is the executable
    // name, and a program may be called anything at all. A space-split parser
    // hands this process's identity another field's value, and an identity that
    // reads the wrong number never matches its own process.
    const nasty = `4242 (my prog (v2)) S ${Array.from({ length: 18 }, (_, i) => String(i)).join(' ')} 999 rest`;
    expect(procStartTicks(nasty)).toBe('999');
    // And nothing that is not a start time is accepted as one.
    expect(procStartTicks('4242 (prog) S 1 2 3')).toBeNull();
    expect(procStartTicks('no parenthesis here')).toBeNull();
  });

  test('Darwin identity distinguishes live, missing, reused and unreadable processes', () => {
    const initial = darwinStartIdentity('Mon Aug 27 12:34:56 2026');
    const reused = darwinStartIdentity('Tue Aug 28 12:34:56 2026');
    if (initial === null || reused === null) throw new Error('fixture lost Darwin lstart identities');

    const owner: LockOwner = {
      version: 'v1',
      platform: 'darwin',
      token: '00000000-0000-4000-8000-000000000002',
      pid: 42,
      identity: initial,
    };
    const boundary = createProcessIdentityBoundary('darwin', (pid) => {
      if (pid === process.pid || pid === 42) return { state: 'read', identity: initial };
      if (pid === 43) return { state: 'absent' };
      if (pid === 44) return { state: 'read', identity: reused };
      return { state: 'unreadable' };
    });

    // Darwin identity can take, write under and release a config lock rather
    // than refusing because Linux procfs is absent.
    const { configPath, lockPath } = scratchConfig();
    expect(createConfigLock(boundary).withSync(configPath, () => {
      writeFileSync(configPath, 'darwin config write\n');
      return readFileSync(configPath, 'utf8');
    })).toBe('darwin config write\n');
    expect(lockHeld(lockPath)).toBe(false);
    expect(boundary.self(42)).toEqual({ platform: 'darwin', pid: 42, identity: initial });
    expect(boundary.liveness(owner)).toBe('live');
    expect(boundary.liveness({ ...owner, pid: 43 })).toBe('gone');
    expect(boundary.liveness({ ...owner, pid: 44 })).toBe('gone');
    expect(boundary.liveness({ ...owner, pid: 45 })).toBe('unknown');
  });

  test('versioned platform records round-trip without cross-platform confusion', () => {
    const identity = darwinStartIdentity('Mon Aug 27 12:34:56 2026');
    if (identity === null) throw new Error('fixture lost Darwin lstart identity');
    const owner: LockOwner = {
      version: 'v1',
      platform: 'darwin',
      token: '00000000-0000-4000-8000-000000000003',
      pid: 42,
      identity,
    };
    expect(decodeLockOwner(encodeLockOwner(owner))).toEqual(owner);
    const linuxRecord = decodeLockOwner('v1 linux 00000000-0000-4000-8000-000000000003 42 darwin-start');
    expect(linuxRecord).toEqual({
      ...owner,
      platform: 'linux',
      identity: 'darwin-start',
    });
    if (linuxRecord === null) throw new Error('fixture lost Linux versioned record');
    expect(createProcessIdentityBoundary('darwin', () => ({ state: 'read', identity })).liveness(linuxRecord)).toBe('unknown');
    // Old records and records with an unexpected version, platform, extra field
    // or noncanonical token never become another platform's owner by accident.
    expect(decodeLockOwner('00000000-0000-4000-8000-000000000003 42 start')).toBeNull();
    expect(decodeLockOwner('v2 darwin 00000000-0000-4000-8000-000000000003 42 start')).toBeNull();
    expect(decodeLockOwner('v1 freebsd 00000000-0000-4000-8000-000000000003 42 start')).toBeNull();
    expect(decodeLockOwner('v1 darwin 00000000-0000-4000-8000-000000000003 42 start extra')).toBeNull();
  });
});
