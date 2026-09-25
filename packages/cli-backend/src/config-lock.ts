import { classify, tolerate } from '@kinu.run/core/obs';
import { lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Acquisitions the current async call already holds (path → token). A nested take
 * of a held path deadlocks; a different call in the same process will release.
 */
const heldByCall = new AsyncLocalStorage<ReadonlyMap<string, string>>();

const LOCK_POLL_MS = 50;

const LOCK_RECORD_VERSION = 'v1';

type SupportedPlatform = 'linux' | 'darwin';

type Liveness = 'live' | 'gone' | 'unknown';

type ProcessIdentityProbe =
  | { readonly state: 'read'; readonly identity: string }
  | { readonly state: 'absent' }
  | { readonly state: 'unreadable' };

/**
 * Pids are reused, so the platform tag plus `identity` names one process
 * generation: Linux `/proc/<pid>/stat` field 22; Darwin SHA-256 of
 * `/bin/ps -p <pid> -o lstart=` under `LC_ALL=C`. The token identifies one acquisition.
 */
export interface LockOwner {
  readonly version: typeof LOCK_RECORD_VERSION;
  readonly platform: SupportedPlatform;
  readonly token: string;
  readonly pid: number;
  readonly identity: string;
}

interface Held {
  readonly lockPath: string;
  readonly token: string;
}

interface ProcessIdentity {
  readonly platform: SupportedPlatform;
  readonly pid: number;
  readonly identity: string;
}

/** Linux reads procfs; Darwin runs absolute `/bin/ps` with `LC_ALL=C` (no shell,
 *  no locale drift). Unsupported systems refuse rather than write an unprovable record. */
interface ProcessIdentityBoundary {
  self(pid: number): Promise<ProcessIdentity>;
  liveness(owner: LockOwner): Promise<Liveness>;
}

interface ConfigLock {
  with<T>(configPath: string, fn: () => T | Promise<T>): Promise<T>;
}

/** Asynchronous throughout: a synchronous wait could only spawn `ps` synchronously on Darwin, and Bun can
 *  wedge a synchronous spawn for good when a collection lands inside it (oven-sh/bun#34069). */
export function createConfigLock(boundary = hostProcessIdentity()): ConfigLock {
  return {
    async with<T>(configPath: string, fn: () => T | Promise<T>): Promise<T> {
      const lockPath = lockPathFor(configPath);
      const held = await acquire(lockPath, boundary);

      try {
        return await holding(lockPath, held.token, fn);
      } finally {
        release(held);
      }
    },
  };
}

/** Serialize every read-modify-write against one config file across processes; release follows settlement. */
export async function withConfigLock<T>(configPath: string, fn: () => T | Promise<T>): Promise<T> {
  return await createConfigLock().with(configPath, fn);
}

function lockPathFor(configPath: string): string {
  mkdirSync(dirname(configPath), { recursive: true });

  return `${configPath}.lock`;
}

function holding<T>(lockPath: string, token: string, fn: () => T): T {
  const held = new Map(heldByCall.getStore() ?? []);
  held.set(lockPath, token);

  return heldByCall.run(held, fn);
}

async function acquire(lockPath: string, boundary: ProcessIdentityBoundary): Promise<Held> {
  const self = await boundary.self(process.pid);

  for (;;) {
    const held = await tryAcquire(lockPath, self, boundary);

    if (held !== null) return held;
    assertNotSelfHeld(lockPath);
    const poll = Promise.withResolvers<void>();
    setTimeout(poll.resolve, LOCK_POLL_MS);
    await poll.promise;
  }
}

/** Owner info lands in the same syscall as the name, so a crash cannot leave an unidentifiable lock. */
async function tryAcquire(lockPath: string, self: ProcessIdentity, boundary: ProcessIdentityBoundary): Promise<Held | null> {
  const token = randomUUID();

  const created = tolerate(() => {
    symlinkSync(encodeLockOwner({ version: LOCK_RECORD_VERSION, token, ...self }), lockPath);

    return true;
  }, 'eexist');

  if (created === undefined) {
    await breakAbandonedLock(lockPath, boundary);

    return null;
  }

  return { lockPath, token };
}

/** No duration removes a lock; only a process the kernel proves gone. */
async function breakAbandonedLock(lockPath: string, boundary: ProcessIdentityBoundary): Promise<void> {
  const owner = readOwner(lockPath);

  if (owner === null || await boundary.liveness(owner) !== 'gone') return;
  release({ lockPath, token: owner.token });
}

function release(held: Held): void {
  if (readOwner(held.lockPath)?.token !== held.token) return;
  tolerate(() => unlinkSync(held.lockPath), 'enoent');
}

/** Strict versioned record; unversioned or cross-platform records fail closed. */
export function encodeLockOwner(owner: LockOwner): string {
  return `${owner.version} ${owner.platform} ${owner.token} ${String(owner.pid)} ${owner.identity}`;
}

export function decodeLockOwner(record: string): LockOwner | null {
  const [version, platform, token, pid, identity, ...extra] = record.split(' ');

  if (
    version !== LOCK_RECORD_VERSION
    || (platform !== 'linux' && platform !== 'darwin')
    || token === undefined
    || !/^[0-9a-f-]{36}$/u.test(token)
    || pid === undefined
    || !/^\d+$/u.test(pid)
    || identity === undefined
    || !/^[A-Za-z0-9_-]+$/u.test(identity)
    || extra.length !== 0
  ) return null;
  const processId = Number(pid);

  if (!Number.isSafeInteger(processId) || processId <= 0) return null;

  return { version, platform, token, pid: processId, identity };
}

function readOwner(lockPath: string): LockOwner | null {
  const entry = tolerate(() => lstatSync(lockPath), 'enoent');

  if (entry === undefined || !entry.isSymbolicLink()) return null;
  const target = tolerate(() => readlinkSync(lockPath), 'enoent');

  return target === undefined ? null : decodeLockOwner(target);
}

/** Field 22 is process start ticks since boot. */
export function procStartTicks(stat: string): string | null {
  const close = stat.lastIndexOf(')');

  if (close === -1) return null;
  const startTicks = stat.slice(close + 2).split(' ')[19];

  return startTicks === undefined || !/^\d+$/u.test(startTicks) ? null : startTicks;
}

export function darwinStartIdentity(lstart: string): string | null {
  const canonical = lstart.trim();

  return canonical === '' ? null : createHash('sha256').update(canonical, 'utf8').digest('base64url');
}

export function createProcessIdentityBoundary(
  platform: SupportedPlatform,
  read: (pid: number) => ProcessIdentityProbe | Promise<ProcessIdentityProbe>,
): ProcessIdentityBoundary {
  return {
    async self(pid): Promise<ProcessIdentity> {
      const probe = await read(pid);

      if (probe.state !== 'read') {
        throw new Error(`Refusing to take the config lock: cannot read this ${platform} process's `
          + `identity for pid ${String(pid)}, so a lock it takes could never be proven abandoned.`);
      }

      return { platform, pid, identity: probe.identity };
    },
    async liveness(owner): Promise<Liveness> {
      if (owner.platform !== platform) return 'unknown';
      const probe = await read(owner.pid);

      if (probe.state !== 'read') return probe.state === 'absent' ? 'gone' : 'unknown';

      return probe.identity === owner.identity ? 'live' : 'gone';
    },
  };
}

function hostProcessIdentity(): ProcessIdentityBoundary {
  if (process.platform === 'linux') return createProcessIdentityBoundary('linux', readLinuxIdentity);

  if (process.platform === 'darwin') return createProcessIdentityBoundary('darwin', readDarwinIdentity);
  throw new Error(`Refusing to take the config lock: ${process.platform} cannot prove a process `
    + 'generation after a crash. Kinu supports this lock on Linux and macOS.');
}

function readLinuxIdentity(pid: number): ProcessIdentityProbe {
  try {
    const startTicks = procStartTicks(readFileSync(`/proc/${String(pid)}/stat`, 'utf8'));

    return startTicks === null ? { state: 'unreadable' } : { state: 'read', identity: startTicks };
  } catch (error) {
    return classify({ cause: error }) === 'enoent' ? { state: 'absent' } : { state: 'unreadable' };
  }
}

/** `ps` runs to its exit rather than synchronously: 1 names a pid no process holds, and a `ps` that could not
 *  run at all refuses rather than guess whether a lock is abandoned. */
async function readDarwinIdentity(pid: number): Promise<ProcessIdentityProbe> {
  try {
    const ps = Bun.spawn({
      cmd: ['/bin/ps', '-p', String(pid), '-o', 'lstart='],
      env: { LC_ALL: 'C', LANG: 'C' },
      stdout: 'pipe',
      stderr: 'ignore',
    });

    const [stdout, exitCode] = await Promise.all([new Response(ps.stdout).text(), ps.exited]);

    if (exitCode === 1) return { state: 'absent' };

    if (exitCode !== 0) return { state: 'unreadable' };
    const identity = darwinStartIdentity(stdout);

    return identity === null ? { state: 'unreadable' } : { state: 'read', identity };
  } catch (error) {
    throw new Error(`Cannot read Darwin process identity for pid ${String(pid)}; refusing to `
      + 'guess whether its lock is abandoned.', { cause: error });
  }
}

/**
 * Waits end when the holder does, never on a clock: a timeout would drop a config
 * write. The one refused wait is a take of a path this call already holds.
 */
function assertNotSelfHeld(lockPath: string): void {
  const token = heldByCall.getStore()?.get(lockPath);

  if (token === undefined || readOwner(lockPath)?.token !== token) return;
  throw new Error(`Deadlocked on the config lock: ${lockPath}: this call already holds it, and the `
    + 'hold is released only when it returns. Take the lock once around the whole '
    + 'read-modify-write instead of nesting it.');
}
