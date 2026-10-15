import { Effect } from 'effect';
import { tolerate, settle } from '@kinu.run/core/obs';
import { lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { hostGenerationReader, type GenerationProbe, type SupportedPlatform } from './process-generation';

/**
 * Acquisitions the current async call already holds (path → token). A nested take
 * of a held path deadlocks; a different call in the same process will release.
 */
const heldByCall = new AsyncLocalStorage<ReadonlyMap<string, string>>();

const LOCK_POLL_MS = 50;

const LOCK_RECORD_VERSION = 'v1';

type Liveness = 'live' | 'gone' | 'unknown';

/**
 * Pids are reused, so the platform tag plus `identity` names one process generation (`process-generation.ts`). The
 * token identifies one acquisition.
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

/** Unsupported systems refuse rather than write an unprovable record. */
interface ProcessIdentityBoundary {
  self(pid: number): Promise<ProcessIdentity>;
  liveness(owner: LockOwner): Promise<Liveness>;
}

interface ConfigLock {
  with<T>(configPath: string, fn: () => T | Promise<T>): Promise<T>;
}

/** Asynchronous: a wait polls on a timer, so the process keeps running while another holds the lock. */
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

/**
 * One try at the lock at `path`, for a caller that skips work another live process is doing rather than wait for it:
 * its release, or null while a live process holds it. A lock whose holder the kernel proves gone is taken over.
 */
export async function tryLock(path: string, boundary = hostProcessIdentity()): Promise<(() => void) | null> {
  mkdirSync(dirname(path), { recursive: true });
  const self = await boundary.self(process.pid);

  // The second try follows a broken abandoned lock.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const held = await tryAcquire(path, self, boundary);

    if (held !== null) return () => { release(held); };
  }

  return null;
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

export function createProcessIdentityBoundary(
  platform: SupportedPlatform,
  read: (pid: number) => GenerationProbe | Promise<GenerationProbe>,
): ProcessIdentityBoundary {
  return {
    self(pid): Promise<ProcessIdentity> {
      return settle(Effect.gen(function* () {
        const probe = yield* Effect.promise(async () => read(pid));

        if (probe.state !== 'read') {
          return yield* Effect.die(new Error(`Refusing to take the config lock: cannot read this ${platform} process's `
            + `identity for pid ${String(pid)}, so a lock it takes could never be proven abandoned.`));
        }

        return { platform, pid, identity: probe.identity };
      }));
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
  const host = hostGenerationReader();

  if (host === null) {
    throw new Error(`Refusing to take the config lock: ${process.platform} cannot prove a process `
      + 'generation after a crash. Kinu supports this lock on Linux and macOS.');
  }

  return createProcessIdentityBoundary(host.platform, (pid) => host.read(pid));
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
