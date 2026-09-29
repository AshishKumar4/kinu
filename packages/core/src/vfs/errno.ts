/** File-plane error presentation over Nimbus's POSIX error type. */
import { isVfsError, toVfsError, VfsError, VFS_ERRNO, VFS_STRERROR, type VfsErrorCode } from '@nimbus-sh/core/vfs/vfs-error.js';

function knownCode(code: string): code is VfsErrorCode {
  return Object.hasOwn(VFS_ERRNO, code);
}

/** Node's error text from a remote plane, retaining the requested path. Unknown codes stay unclassified. */
export function vfsErrorFromText(message: string, path: string): VfsError | null {
  const [, code, text] = /^(E[A-Z]+): (.*)$/su.exec(message) ?? [];

  return code !== undefined && text !== undefined && knownCode(code) ? new VfsError(code, text, path) : null;
}

/** Adds model-facing guidance without repeating Nimbus's code or path. */
export function withVfsErrorHint(error: VfsError, hint: string): VfsError {
  const suffix = error.path === undefined ? 0 : `, '${error.path}'`.length;
  const message = error.message.slice(error.code.length + 2, suffix === 0 ? undefined : -suffix);

  return new VfsError(error.code, `${message}: ${hint}`, error.path, { cause: error });
}

/** Names the file-plane path instead of Nimbus's internal storage key. */
export async function atVfsPath<T>(absolute: string, syscall: string, call: () => T | Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const failure = toVfsError(error, absolute);

    if (!isVfsError(failure)) throw error;

    throw new VfsError(failure.code, `${VFS_STRERROR[failure.code]}, ${syscall}`, absolute, { cause: error });
  }
}
