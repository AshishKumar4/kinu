/** How a command member's reading of a call becomes the call the approval gate reviews, keys and runs. */

import { sha256Hex, stableStringify } from '../safety/argument-digest';
import type { CommandCall, ExecutionContext, PreparedCall } from '../safety/approval-gate';
import type { ShellExecOptions } from '../types/primitives';

/**
 * A shell call as a command member reads it: its directory and named shell, where the member honours it a digest of
 * its stdin, whether it runs as a background job, and its cancel. The one reading of {@link ShellExecOptions} for
 * every machine shell.
 */
export function shellCall(command: string, options: ShellExecOptions, honours: { readonly stdin: boolean }): CommandCall {
  return {
    text: command,
    ...(options.cwd !== undefined && { cwd: options.cwd }),
    ...(options.name !== undefined && { shell: options.name }),
    ...(options.signal !== undefined && { signal: options.signal }),
    context: {
      ...(honours.stdin && options.stdin !== undefined && { stdinSha256: sha256Hex(options.stdin) }),
      ...(options.job !== undefined && { background: true }),
    },
  };
}

/** An environment as part of a call's identity: its names, and a digest of names and values in one order. */
export function envContext(env: Readonly<Record<string, string>> | undefined): Pick<ExecutionContext, 'env'> {
  if (env === undefined) return {};

  // One spelling however the call ordered its keys; names are unique, so no two compare equal.
  return { env: { names: Object.keys(env).sort((a, b) => (a < b ? -1 : 1)), sha256: sha256Hex(stableStringify({ ...env })) } };
}

/** A member that takes nothing but the words: its one reading of a call is the command, run as given. */
export function wordsOnly<R>(run: (command: string) => Promise<R>): (args: readonly unknown[]) => PreparedCall<R> {
  return (args) => {
    const command = typeof args[0] === 'string' ? args[0] : '';

    return { call: { text: command, context: {} }, run: () => run(command) };
  };
}
