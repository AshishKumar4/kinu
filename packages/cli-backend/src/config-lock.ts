import { tolerate } from '@kinu.run/core/obs';
import { closeSync, mkdirSync, openSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as v from 'valibot';

const LOCK_TIMEOUT_MS = 30_000;
const LOCK_STALE_MS = 30_000;
const LOCK_POLL_MS = 50;

/** The only property of an openSync failure acquireLock ever branches on. */
const fsErrorCodeSchema = v.object({ code: v.string() });

/** Serialize every read-modify-write against one config file across processes. */
export function withConfigLock<T>(configPath: string, fn: () => T): T {
  mkdirSync(dirname(configPath), { recursive: true });
  const lockPath = `${configPath}.lock`;
  const fd = acquireLock(lockPath);
  try {
    return fn();
  } finally {
    closeSync(fd);
    tolerate(() => unlinkSync(lockPath), 'enoent');
  }
}

function acquireLock(lockPath: string): number {
  const started = Date.now();
  while (true) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      writeFileSync(fd, `${process.pid}\n${Date.now()}\n`);
      return fd;
    } catch (error) {
      if (!(v.is(fsErrorCodeSchema, error) && error.code === 'EEXIST')) throw error;
      tolerate(() => {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) unlinkSync(lockPath);
      }, 'enoent');
      if (Date.now() - started > LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for the config lock: ${lockPath}`, { cause: error });
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_POLL_MS);
    }
  }
}
