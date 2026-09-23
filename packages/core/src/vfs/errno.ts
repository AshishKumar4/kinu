/** Closed VFS error taxonomy: every workspace file-plane throw carries one code, so callers switch on `err.code`. */

import * as v from 'valibot';

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
  | 'EROFS'      // read-only mount / synthetic mount table
  | 'ENOTSUP';   // operation not supported

/** Canonical negative errno numbers (Linux ABI), keyed by code. */
export const ERRNO = {
  EPERM: -1, ENOENT: -2, EIO: -5, ENXIO: -6, EACCES: -13, EEXIST: -17,
  ENOTDIR: -20, EISDIR: -21, ENOTEMPTY: -39, EROFS: -30, ENOTSUP: -95,
} satisfies Readonly<Record<VfsErrorCode, number>>;

const VfsErrorCodeSchema = v.picklist([
  'EPERM', 'ENOENT', 'EIO', 'ENXIO', 'EACCES', 'EEXIST', 'ENOTDIR',
  'EISDIR', 'ENOTEMPTY', 'EROFS', 'ENOTSUP',
]);

export class VfsError extends Error {
  readonly errno: number;

  constructor(
    readonly code: VfsErrorCode,
    message: string,
    readonly path: string | undefined,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = 'VfsError';
    this.errno = ERRNO[code];
  }
}

export function makeVfsError(code: VfsErrorCode, message: string, path: string): VfsError {
  return new VfsError(code, message, path);
}

/** The same error with guidance appended to its message; code, errno and path are preserved. */
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

/** Addressing correction appended to path errors; lives in agent-utils because its emulated shell cannot import core. */
export { vfsAddressingHint } from '@kinu.run/agent-utils/vfs';

export function isVfsError<T>(error: T): error is T & VfsErrorLike {
  return error instanceof Error
    && 'code' in error
    && v.is(VfsErrorCodeSchema, error.code);
}

/** Node's wording per code. */
const ERRNO_TEXT = {
  EPERM: 'operation not permitted', ENOENT: 'no such file or directory', EIO: 'i/o error',
  ENXIO: 'no such device or address', EACCES: 'permission denied', EEXIST: 'file already exists',
  ENOTDIR: 'not a directory', EISDIR: 'illegal operation on a directory', ENOTEMPTY: 'directory not empty',
  EROFS: 'read-only file system', ENOTSUP: 'operation not supported',
} satisfies Readonly<Record<VfsErrorCode, string>>;

/** Rethrows a vendor failure naming `absolute`: Nimbus names its storage key. */
export async function atVfsPath<T>(absolute: string, syscall: string, call: () => T | Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!isVfsError(error)) throw error;

    throw new VfsError(error.code, `${ERRNO_TEXT[error.code]}, ${syscall} '${absolute}'`, absolute, { cause: error });
  }
}
