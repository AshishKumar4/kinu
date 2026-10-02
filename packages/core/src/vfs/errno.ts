/** File-plane error presentation over Nimbus's POSIX error type. */
import { Effect } from 'effect';
import { settle } from '../obs/effect';
import { isVfsError, isVfsErrorCode, syscallError, toVfsError, VfsError } from '@nimbus-sh/core/vfs/vfs-error.js';

/**
 * Node's error text from another plane or isolate (`EPERM: <words>, rename '<path>'`), on the requested path with
 * its own words and syscall. Unknown codes stay unclassified.
 */
export function vfsErrorFromText(input: { message: string; path: string | undefined; cause?: unknown }): VfsError | null {
  const { message, path, cause } = input;

  const [, code, words, syscall, dest] = /^(E[A-Z]+): (.*?)(?:, ([a-z]+))? '[^']*'(?: -> '([^']*)')?$/su.exec(message)
    ?? /^(E[A-Z]+): (.*)$/su.exec(message) ?? [];

  if (code === undefined || words === undefined || !isVfsErrorCode(code)) return null;

  return syscall === undefined
    ? new VfsError(code, words, path, { dest, cause })
    : syscallError(code, syscall, path, { detail: words, dest, cause });
}

/** Adds model-facing guidance after Nimbus's message; code, errno, syscall, path and dest are kept. */
export function withVfsErrorHint(error: VfsError, hint: string): VfsError {
  const guided = new VfsError(error.code, `${error.message.slice(error.code.length + 2)}: ${hint}`, undefined, { syscall: error.syscall, cause: error });

  return Object.assign(guided, { path: error.path, ...(error.dest !== undefined && { dest: error.dest }) });
}

/** Names the file-plane path, not the engine's storage key, with the call that met the failure. */
export function atVfsPath<T>(absolute: string, syscall: string, call: () => T | Promise<T>): Promise<T> {
  return settle(Effect.tryPromise({ try: async () => call(), catch: (error) => toVfsError(error, syscall, absolute) }).pipe(
    Effect.catch((failure) => (isVfsError(failure) ? Effect.fail(failure) : Effect.die(failure))),
  ));
}
