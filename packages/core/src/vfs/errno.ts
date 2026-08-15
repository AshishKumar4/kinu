/**
 * VFS error taxonomy — the closed set of error codes the workspace file plane
 * speaks. Every throw from the workspace filesystem and from an executor's
 * file view carries one; the conformance suite asserts the right code per
 * operation.
 *
 * A closed union (never a bare `Error`) is the agent-core house rule: callers
 * switch on `err.code` exhaustively instead of regex-matching messages.

 */

import * as v from 'valibot';

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
export const ERRNO = {
  EPERM: -1, ENOENT: -2, EIO: -5, ENXIO: -6, EACCES: -13, EEXIST: -17,
  ENOTDIR: -20, EISDIR: -21, ENOTEMPTY: -39, EROFS: -30,
} satisfies Readonly<Record<VfsErrorCode, number>>;

const VfsErrorCodeSchema = v.picklist([
  'EPERM', 'ENOENT', 'EIO', 'ENXIO', 'EACCES', 'EEXIST', 'ENOTDIR',
  'EISDIR', 'ENOTEMPTY', 'EROFS',
]);

export class VfsError extends Error {
  readonly errno: number;

  constructor(
    readonly code: VfsErrorCode,
    message: string,
    readonly path: string | undefined,
  ) {
    super(`${code}: ${message}`);
    this.name = 'VfsError';
    this.errno = ERRNO[code];
  }
}

/** Errno-style error shared by the composite and its mount adapters. */
export function makeVfsError(code: VfsErrorCode, message: string, path: string): VfsError {
  return new VfsError(code, message, path);
}

/** The same error with guidance appended to its message. Code, errno and path
 *  are preserved, so callers switching on `code` are unaffected — only what a
 *  human or a model reads changes. */
export function withVfsErrorHint(err: VfsErrorLike, hint: string): VfsError {
  const prefix = `${err.code}: `;
  const message = err.message.startsWith(prefix) ? err.message.slice(prefix.length) : err.message;
  return new VfsError(err.code, `${message} — ${hint}`, err.path);
}

interface VfsErrorLike extends Error {
  readonly code: VfsErrorCode;
  readonly errno?: number;
  readonly path?: string;
}

/** The addressing correction every file surface appends to a path error. It
 *  lives in agent-utils because the emulated shell down there needs the same
 *  sentence and cannot import core. */
export { vfsAddressingHint } from '@proteus/agent-utils/vfs';

/** True when `err` carries a code from the closed taxonomy. */
export function isVfsError<T>(error: T): error is T & VfsErrorLike {
  return error instanceof Error
    && 'code' in error
    && v.is(VfsErrorCodeSchema, error.code);
}
