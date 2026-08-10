/**
 * VFS error taxonomy — the closed set of error codes the workspace file plane
 * speaks. Every throw from the CompositeVFS and its mount adapters carries one
 * of these codes; the conformance suite asserts the right code per operation.
 *
 * A closed union (never a bare `Error`) is the agent-core house rule: callers
 * switch on `err.code` exhaustively instead of regex-matching messages.
 * SqliteFS (agent-utils, a lower layer that cannot import core) raises the same
 * code strings by value, so the taxonomy is shared across the whole plane.
 */

/** The closed set of POSIX-style codes the file plane raises. */
export type VfsErrorCode =
  | 'EPERM'      // operation not permitted
  | 'ENOENT'     // no such file or directory
  | 'EIO'        // I/O error (unclassified environment failure)
  | 'ENXIO'      // mount not available (reserved / offline)
  | 'EACCES'     // permission denied (e.g. outside the consented device subtree)
  | 'EEXIST'     // already exists
  | 'ENOTDIR'    // not a directory
  | 'EISDIR'     // is a directory
  | 'ENOTEMPTY'  // directory not empty
  | 'EROFS';     // read-only mount / synthetic mount table

/** Canonical negative errno numbers (Linux ABI), keyed by code. */
export const ERRNO: Readonly<Record<VfsErrorCode, number>> = {
  EPERM: -1, ENOENT: -2, EIO: -5, ENXIO: -6, EACCES: -13, EEXIST: -17,
  ENOTDIR: -20, EISDIR: -21, ENOTEMPTY: -39, EROFS: -30,
};

export interface VfsError extends Error {
  code: VfsErrorCode;
  errno: number;
  path: string;
}

/** Errno-style error shared by the composite and its mount adapters. */
export function makeVfsError(code: VfsErrorCode, message: string, path: string): VfsError {
  const err = new Error(`${code}: ${message}`) as VfsError;
  err.code = code;
  err.errno = ERRNO[code];
  err.path = path;
  return err;
}

/** The same error with guidance appended to its message. Code, errno and path
 *  are preserved, so callers switching on `code` are unaffected — only what a
 *  human or a model reads changes. */
export function withVfsErrorHint(err: VfsError, hint: string): VfsError {
  const next = new Error(`${err.message} — ${hint}`) as VfsError;
  next.code = err.code;
  next.errno = err.errno;
  next.path = err.path;
  return next;
}

/** True when `err` carries a code from the closed taxonomy. */
export function isVfsError(err: unknown): err is VfsError {
  return err instanceof Error && typeof (err as VfsError).code === 'string'
    && (err as VfsError).code in ERRNO;
}
