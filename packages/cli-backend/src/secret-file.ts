/**
 * Owner-only files on disk — credentials, the config that holds them, the
 * daemon pid, a diagnostics bundle.
 *
 * Every one of these used to be written as
 *
 *     writeFileSync(path, data, { mode: 0o600 });
 *     try { chmodSync(path, 0o600); } catch {}
 *
 * which is wrong twice. `writeFileSync`'s `mode` applies only when the file is
 * CREATED, so rewriting a file that an older version left group-readable keeps
 * the old bits; and the `chmod` that was supposed to narrow them was the one
 * call whose failure was discarded. The net effect is a refresh token in a
 * world-readable file with nothing anywhere saying so.
 *
 * So the mode is not requested, it is VERIFIED. A filesystem that cannot
 * express POSIX modes reports that truthfully here instead of being silently
 * assumed, because "this platform ignores chmod" and "we failed to secure the
 * owner's token" are not the same fact and must not share a code path.
 */

import { chmodSync, statSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

/** Owner read/write only. */
const SECRET_FILE_MODE = 0o600;
/** Owner traverse only. */
const SECRET_DIR_MODE = 0o700;

/** Group and world bits — none of these may be set on a secret file. */
const SHARED_BITS = 0o077;

/**
 * Narrow `path` to owner-only and prove it landed.
 *
 * Throws when the bits are still shared afterwards. Callers holding a secret
 * MUST let that propagate: an unreadable-by-others file is the whole point, and
 * continuing past a failed narrowing publishes the secret.
 */
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
      `${path} is readable beyond its owner (mode ${observed.toString(8)}) — refusing to leave a secret there`,
    );
  }
}

/**
 * Write `content` to `path` atomically, owner-only, verified.
 *
 * tmp + rename so a concurrent reader never sees a half-written credential,
 * and the tmp file is narrowed before the rename so the window in which the
 * bytes exist under a wider mode is empty.
 */
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

/** Create `path` as an owner-only directory, verified. */
export function ensureSecretDir(path: string): void {
  mkdirSync(path, { recursive: true });
  enforceOwnerOnly(path, SECRET_DIR_MODE);
}
