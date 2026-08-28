import * as v from 'valibot';
import { classify, tolerate } from '@kinu.run/core/obs';
import { lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

const LOCK_TIMEOUT_MS = 30_000;
const LOCK_POLL_MS = 50;
const LOCK_RECORD_VERSION = 'v1';

export type SupportedPlatform = 'linux' | 'darwin';
type Liveness = 'live' | 'gone' | 'unknown';

export type ProcessIdentityProbe =
  | { readonly state: 'read'; readonly identity: string }
  | { readonly state: 'absent' }
  | { readonly state: 'unreadable' };

/**
 * Which process holds a lock.
 *
 * Pid alone cannot say: pids are reused. The platform tag plus `identity` names
 * one process generation: Linux uses `/proc/<pid>/stat` field 22; Darwin uses
 * the SHA-256 of `/bin/ps -p <pid> -o lstart=` under `LC_ALL=C`. A later caller
 * removes this record only when the kernel reports no pid, or reports the pid
 * with a different generation. The uuid token identifies one lock acquisition
 * and is what release compares.
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

/**
 * Injectable kernel boundary. Linux reads procfs; Darwin executes the absolute
 * `/bin/ps` path with `LC_ALL=C`, so no shell expands a pid and no locale changes
 * the lstart representation that becomes identity. Unsupported systems refuse
 * rather than write a record they could never prove abandoned.
 */
export interface ProcessIdentityBoundary {
  self(pid: number): ProcessIdentity;
  liveness(owner: LockOwner): Liveness;
}

/**
 * The extra arguments a call supplies: none for a synchronous callback, and one
 * nobody can produce for an async one — so `withConfigLock(path, async () => …)`
 * does not compile.
 */
type RefuseAsync<T> = T extends PromiseLike<unknown> ? [useWithConfigLockAsync: never] : [];

/** An async callback returns a native Promise. A structural `then` detector would
 *  itself be thenable, which is a footgun in this await-aware boundary. */
const pendingWorkSchema = v.instance(Promise);

/** A lock implementation parameterised by the one platform trust boundary. */
export interface ConfigLock {
  withSync<T>(configPath: string, fn: () => T, ...refuseAsync: RefuseAsync<T>): T;
  withAsync<T>(configPath: string, fn: () => T | Promise<T>): Promise<T>;
}

/** Creates the local lock around a specific process-identity source. Production
 *  supplies the host source; Darwin tests supply controlled C-locale ps output. */
export function createConfigLock(boundary = hostProcessIdentity()): ConfigLock {
  return {
    withSync<T>(configPath: string, fn: () => T, ..._refuseAsync: RefuseAsync<T>): T {
      const held = acquireSync(lockPathFor(configPath), boundary);
      try {
        const result = fn();
        // The type above cannot be the only refusal: `() => Promise<void>` is
        // assignable to `() => void`, so a callback DECLARED synchronous still
        // reaches here with pending work behind it.
        if (v.is(pendingWorkSchema, result)) {
          throw new TypeError('withConfigLock ran a callback that returned pending work, which the '
            + 'lock does not cover. Use withConfigLockAsync.');
        }
        return result;
      } finally {
        release(held);
      }
    },
    async withAsync<T>(configPath: string, fn: () => T | Promise<T>): Promise<T> {
      const held = await acquireAsync(lockPathFor(configPath), boundary);
      try {
        return await fn();
      } finally {
        release(held);
      }
    },
  };
}

/** Serialize every read-modify-write against one config file across processes. */
export function withConfigLock<T>(configPath: string, fn: () => T, ...refuseAsync: RefuseAsync<T>): T {
  return createConfigLock().withSync(configPath, fn, ...refuseAsync);
}

/** `withConfigLock` for a callback that awaits; release follows settlement. */
export async function withConfigLockAsync<T>(configPath: string, fn: () => T | Promise<T>): Promise<T> {
  return await createConfigLock().withAsync(configPath, fn);
}

function lockPathFor(configPath: string): string {
  mkdirSync(dirname(configPath), { recursive: true });
  return `${configPath}.lock`;
}

function acquireSync(lockPath: string, boundary: ProcessIdentityBoundary): Held {
  const self = boundary.self(process.pid);
  const startedMs = Date.now();
  for (;;) {
    const held = tryAcquire(lockPath, self, boundary);
    if (held !== null) return held;
    assertWaiting(lockPath, startedMs, boundary);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_POLL_MS);
  }
}

async function acquireAsync(lockPath: string, boundary: ProcessIdentityBoundary): Promise<Held> {
  const self = boundary.self(process.pid);
  const startedMs = Date.now();
  for (;;) {
    const held = tryAcquire(lockPath, self, boundary);
    if (held !== null) return held;
    assertWaiting(lockPath, startedMs, boundary);
    const poll = Promise.withResolvers<void>();
    setTimeout(poll.resolve, LOCK_POLL_MS);
    await poll.promise;
  }
}

/** The record is a symlink target: owner information reaches the filesystem in
 *  the same syscall as the name, so a crash cannot leave an empty lock nothing
 *  can identify. */
function tryAcquire(lockPath: string, self: ProcessIdentity, boundary: ProcessIdentityBoundary): Held | null {
  const token = randomUUID();
  const created = tolerate(() => {
    symlinkSync(encodeLockOwner({ version: LOCK_RECORD_VERSION, token, ...self }), lockPath);
    return true;
  }, 'eexist');
  if (created === undefined) {
    breakAbandonedLock(lockPath, boundary);
    return null;
  }
  return { lockPath, token };
}

/** No duration removes a lock. A breaker acts only on a process Linux or Darwin
 *  proves gone; that process cannot race its own `finally`. */
function breakAbandonedLock(lockPath: string, boundary: ProcessIdentityBoundary): void {
  const owner = readOwner(lockPath);
  if (owner === null || boundary.liveness(owner) !== 'gone') return;
  release({ lockPath, token: owner.token });
}

/** Owner-checked, always. A release cannot remove a lock somebody else owns. */
function release(held: Held): void {
  if (readOwner(held.lockPath)?.token !== held.token) return;
  tolerate(() => unlinkSync(held.lockPath), 'enoent');
}

/** Strict versioned record. A Linux record cannot be parsed as Darwin's owner or
 *  vice versa; old unversioned records fail closed rather than being guessed at. */
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

/** Linux procfs identity: field 22 is process start ticks since boot. */
export function procStartTicks(stat: string): string | null {
  const close = stat.lastIndexOf(')');
  if (close === -1) return null;
  const startTicks = stat.slice(close + 2).split(' ')[19];
  return startTicks === undefined || !/^\d+$/u.test(startTicks) ? null : startTicks;
}

/**
 * Makes the Darwin identity stable across localized systems. ps output itself
 * contains spaces, so the stored identity is its SHA-256 base64url digest; the
 * original exact, trimmed C-locale output is what both sides compare.
 */
export function darwinStartIdentity(lstart: string): string | null {
  const canonical = lstart.trim();
  return canonical === '' ? null : createHash('sha256').update(canonical, 'utf8').digest('base64url');
}

/**
 * The platform boundary is public so focused tests inject Darwin ps answers on
 * Linux.
 */
export function createProcessIdentityBoundary(
  platform: SupportedPlatform,
  read: (pid: number) => ProcessIdentityProbe,
): ProcessIdentityBoundary {
  return {
    self(pid): ProcessIdentity {
      const probe = read(pid);
      if (probe.state !== 'read') {
        throw new Error(`Refusing to take the config lock: cannot read this ${platform} process's `
          + `identity for pid ${String(pid)}, so a lock it takes could never be proven abandoned.`);
      }
      return { platform, pid, identity: probe.identity };
    },
    liveness(owner): Liveness {
      if (owner.platform !== platform) return 'unknown';
      const probe = read(owner.pid);
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

function readDarwinIdentity(pid: number): ProcessIdentityProbe {
  try {
    const result = Bun.spawnSync({
      cmd: ['/bin/ps', '-p', String(pid), '-o', 'lstart='],
      env: { LC_ALL: 'C', LANG: 'C' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (result.exitCode === 1) return { state: 'absent' };
    if (result.exitCode !== 0) return { state: 'unreadable' };
    const identity = darwinStartIdentity(result.stdout.toString());
    return identity === null ? { state: 'unreadable' } : { state: 'read', identity };
  } catch (error) {
    throw new Error(`Cannot read Darwin process identity for pid ${String(pid)}; refusing to `
      + 'guess whether its lock is abandoned.', { cause: error });
  }
}

function assertWaiting(lockPath: string, startedMs: number, boundary: ProcessIdentityBoundary): void {
  if (Date.now() - startedMs <= LOCK_TIMEOUT_MS) return;
  throw new Error(`Timed out waiting for the config lock: ${lockPath} — ${ownerDescription(lockPath, boundary)}`);
}

function ownerDescription(lockPath: string, boundary: ProcessIdentityBoundary): string {
  const owner = readOwner(lockPath);
  if (owner === null) {
    return 'it carries no versioned owner record this program wrote, so no process can be proven '
      + 'to hold or to have abandoned it. Remove that path if no kinu is running';
  }
  switch (boundary.liveness(owner)) {
    case 'live':
      return `${owner.platform} pid ${String(owner.pid)} is running and still holds it. Wait for that process, or stop it`;
    case 'unknown':
      return `${owner.platform} pid ${String(owner.pid)} could not be read, so it cannot be proven abandoned. `
        + 'Remove that path if that process is not running';
    case 'gone':
      return `${owner.platform} pid ${String(owner.pid)} is gone and the lock outlived it. Remove that path`;
  }
}
