/**
 * Owner-only files. `writeFileSync`'s `mode` applies only on create, so the mode
 * is verified after writing, never merely requested.
 */

import { chmodSync, statSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

const SECRET_FILE_MODE = 0o600;

const SECRET_DIR_MODE = 0o700;

const SHARED_BITS = 0o077;

/** Narrow `path` to owner-only and verify; callers holding a secret must let the throw propagate. */
export function enforceOwnerOnly(path: string, mode: number = SECRET_FILE_MODE): void {
  try {
    chmodSync(path, mode);
  } catch (caught) {
    throw new Error(
      `could not restrict ${path} to owner-only permissions`,
      { cause: caught },
    );
  }

  const observed = statSync(path).mode & 0o777;

  if ((observed & SHARED_BITS) !== 0) {
    throw new Error(
      `${path} is readable beyond its owner (mode ${observed.toString(8)}) ; refusing to leave a secret there`,
    );
  }
}

/** Atomic owner-only write; the tmp file is narrowed before rename. */
export function writeSecretFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;

  try {
    writeFileSync(tmp, content, { mode: SECRET_FILE_MODE });
    enforceOwnerOnly(tmp);
    renameSync(tmp, path);
  } catch (caught) {
    try {
      unlinkSync(tmp);
    } catch (cleanup) {
      throw new Error(`failed to write ${path} and could not remove ${tmp}`, { cause: cleanup });
    }

    throw caught;
  }

  enforceOwnerOnly(path);
}

export function ensureSecretDir(path: string): void {
  mkdirSync(path, { recursive: true });
  enforceOwnerOnly(path, SECRET_DIR_MODE);
}
