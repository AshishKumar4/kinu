import { describe, expect, test } from 'bun:test';
import { lstatSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '@kinu.run/test-utils';
import { tolerate } from '@kinu.run/core/obs';
import {
  createConfigLock, createProcessIdentityBoundary, darwinStartIdentity, decodeLockOwner, encodeLockOwner,
  procStartTicks, withConfigLock, type LockOwner,
} from '../src/config-lock';

/**
 * Lock ownership rules in-process; cross-process proofs live in packages/cli/tests/config-lock.test.ts and
 * codex-refresh-processes.test.ts. Breakability is process identity (pid + /proc start time), never duration.
 */
describe('the config lock is held by a process, not by a path', () => {
  function scratchConfig() {
    const configPath = join(scratchDir('config-lock'), 'config.json');

    return { configPath, lockPath: `${configPath}.lock` };
  }

  /** A held lock is a symlink, so `existsSync` (which follows it) answers false. */
  function lockHeld(lockPath: string): boolean {
    return tolerate(() => lstatSync(lockPath), 'enoent') !== undefined;
  }

  /** The versioned owner record is the symlink target; Linux records name procfs field 22. */
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

  /** A pid whose exit Bun has already reaped, so `/proc/<pid>` is gone. */
  async function reapedPid(): Promise<number> {
    const child = Bun.spawn({ cmd: ['/bin/true'] });
    await child.exited;

    return child.pid;
  }

  /**
   * This process's identity, and a signal once a contender has asked twice whether the holder lives: only a
   * taken lock's owner is asked about, so the second question means the first answer was acted on and the
   * contender polled again. Acquisition yields before its first attempt, so a test waits on this, not on
   * the call returning.
   */
  function watchedLock() {
    const waited = Promise.withResolvers<void>();

    const host = createProcessIdentityBoundary('linux', (pid) => (pid === process.pid
      ? { state: 'read', identity: selfStartTicks() }
      : { state: 'absent' }));

    let asked = 0;

    const lock = createConfigLock({
      self: async (pid) => await host.self(pid),
      liveness: async (owner) => {
        asked += 1;

        if (asked === 2) waited.resolve();

        return await host.liveness(owner);
      },
    });

    return { lock, waited: waited.promise };
  }

  /** An unreadable owner is never asked about, so no question marks the attempt. The first attempt reads
   *  procfs and the lock synchronously, so it is over one event-loop turn after the contender starts. */
  async function firstAttemptMade(): Promise<void> {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }

  test('a caller outside the holder waits until its async callback settles, and is not refused', async () => {
    const { configPath, lockPath } = scratchConfig();
    const { lock, waited } = watchedLock();
    const order: string[] = [];
    const entry = Promise.withResolvers<void>();
    const hold = Promise.withResolvers<void>();

    const first = lock.with(configPath, async () => {
      order.push('first enters');
      entry.resolve();
      await hold.promise;
      order.push('first leaves');
    });

    await entry.promise;

    // Same pid, a different call: the holder's async context does not reach it, so this waits.
    const second = lock.with(configPath, async () => {
      order.push('second enters');
      await Promise.resolve();
    });

    // A second that got in, or was refused, settles the race first.
    await Promise.race([waited, second]);
    expect(order).toEqual(['first enters']);

    hold.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['first enters', 'first leaves', 'second enters']);
    expect(lockHeld(lockPath)).toBe(false);
  });

  test('a holder whose lock was replaced does not delete the replacement', async () => {
    const { configPath, lockPath } = scratchConfig();

    await withConfigLock(configPath, async () => {
      await Promise.resolve();
      // Someone else owns the path; releasing by path would hand a third caller a doubly held lock.
      unlinkSync(lockPath);
      forgeLock(lockPath, process.pid, selfStartTicks());
    });

    expect(decodeLockOwner(readlinkSync(lockPath))?.token).toBe('00000000-0000-4000-8000-000000000001');
  });

  test('a lock whose process no longer exists is broken at once', async () => {
    const { configPath, lockPath } = scratchConfig();
    forgeLock(lockPath, await reapedPid(), '12345');

    let ownerInside = '';
    await withConfigLock(configPath, () => {
      ownerInside = readlinkSync(lockPath);
    });

    expect(decodeLockOwner(ownerInside)).toMatchObject({
      platform: 'linux',
      pid: process.pid,
      identity: selfStartTicks(),
    });
    expect(lockHeld(lockPath)).toBe(false);
  });

  test('a lock whose pid was reused by another process is broken', async () => {
    const { configPath, lockPath } = scratchConfig();
    // Our pid, but a different recorded start time: the owner is gone and its pid reused.
    forgeLock(lockPath, process.pid, '1');

    await withConfigLock(configPath, () => undefined);
    expect(lockHeld(lockPath)).toBe(false);
  });

  test('a lock held by a live process is never broken, however long it holds', async () => {
    const { configPath, lockPath } = scratchConfig();
    const { lock, waited } = watchedLock();
    forgeLock(lockPath, process.pid, selfStartTicks());

    let ran = false;

    const blocked = lock.with(configPath, async () => {
      await Promise.resolve();
      ran = true;
    });

    await Promise.race([waited, blocked]);
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

  test('a nested take of a lock this call already holds refuses', async () => {
    const { configPath, lockPath } = scratchConfig();
    // The holder's `finally` runs when this call returns, so waiting here would never end.
    await expect(withConfigLock(configPath, async () => await withConfigLock(configPath, () => 'inner')))
      .rejects.toThrow('this call already holds it');
    expect(lockHeld(lockPath)).toBe(false);
  });

  test('a lock this program did not write is waited out, never stolen', async () => {
    const { configPath, lockPath } = scratchConfig();
    // A regular file carries no owner record, so acquisition waits instead of breaking it.
    writeFileSync(lockPath, 'not a record\n');

    let ran = false;

    const blocked = withConfigLock(configPath, async () => {
      await Promise.resolve();
      ran = true;
    });

    await firstAttemptMade();
    expect(ran).toBe(false);
    expect(readFileSync(lockPath, 'utf8')).toBe('not a record\n');

    unlinkSync(lockPath);
    await blocked;
    expect(ran).toBe(true);
  });

  test('a record missing its process identity is unreadable, not abandoned', async () => {
    const { configPath, lockPath } = scratchConfig();
    // Fail closed: an unreadable owner makes the caller wait.
    symlinkSync('token-only', lockPath);

    let ran = false;

    const blocked = withConfigLock(configPath, async () => {
      await Promise.resolve();
      ran = true;
    });

    await firstAttemptMade();
    expect(ran).toBe(false);
    expect(readlinkSync(lockPath)).toBe('token-only');

    unlinkSync(lockPath);
    await blocked;
    expect(ran).toBe(true);
  });

  test('the start time is read past the executable name, parentheses and all', () => {
    const stat = readFileSync(`/proc/${String(process.pid)}/stat`, 'utf8');
    expect(procStartTicks(stat)).toBe(stat.split(' ')[21]);
    expect(procStartTicks(stat)).toMatch(/^\d+$/u);
    // Parse past the last `)`: field 2 is the executable name, which may contain spaces.
    const nasty = `4242 (my prog (v2)) S ${Array.from({ length: 18 }, (_, i) => String(i)).join(' ')} 999 rest`;
    expect(procStartTicks(nasty)).toBe('999');
    expect(procStartTicks('4242 (prog) S 1 2 3')).toBeNull();
    expect(procStartTicks('no parenthesis here')).toBeNull();
  });

  test('Darwin identity distinguishes live, missing, reused and unreadable processes', async () => {
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

    // Darwin identity must work without Linux procfs.
    const { configPath, lockPath } = scratchConfig();
    expect(await createConfigLock(boundary).with(configPath, () => {
      writeFileSync(configPath, 'darwin config write\n');

      return readFileSync(configPath, 'utf8');
    })).toBe('darwin config write\n');
    expect(lockHeld(lockPath)).toBe(false);
    expect(await boundary.self(42)).toEqual({ platform: 'darwin', pid: 42, identity: initial });
    expect(await boundary.liveness(owner)).toBe('live');
    expect(await boundary.liveness({ ...owner, pid: 43 })).toBe('gone');
    expect(await boundary.liveness({ ...owner, pid: 44 })).toBe('gone');
    expect(await boundary.liveness({ ...owner, pid: 45 })).toBe('unknown');
  });

  test('versioned platform records round-trip without cross-platform confusion', async () => {
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
    expect(await createProcessIdentityBoundary('darwin', () => ({ state: 'read', identity })).liveness(linuxRecord)).toBe('unknown');
    // Unknown or noncanonical records never become another platform's owner.
    expect(decodeLockOwner('00000000-0000-4000-8000-000000000003 42 start')).toBeNull();
    expect(decodeLockOwner('v2 darwin 00000000-0000-4000-8000-000000000003 42 start')).toBeNull();
    expect(decodeLockOwner('v1 freebsd 00000000-0000-4000-8000-000000000003 42 start')).toBeNull();
    expect(decodeLockOwner('v1 darwin 00000000-0000-4000-8000-000000000003 42 start extra')).toBeNull();
  });
});
