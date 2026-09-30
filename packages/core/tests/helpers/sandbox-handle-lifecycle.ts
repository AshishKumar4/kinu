import type { SandboxHandle } from '../../src/index';

/** Lifecycle surface every fake handle must carry; suites that never touch processes spread this in. */
export const sandboxHandleLifecycle: Pick<
  SandboxHandle,
  | 'ensureReady' | 'startSupervisedProcess' | 'stopSupervisedProcess'
  | 'listSupervisedProcesses' | 'portToken' | 'notePortRemoved'
> = {
  ensureReady: async () => {},
  startSupervisedProcess: async () => ({ processId: 'proc-1' }),
  stopSupervisedProcess: async () => ({ stopped: true }),
  listSupervisedProcesses: async () => [],
  portToken: async () => ({ urlToken: 'tok-1' }),
  notePortRemoved: async () => {},
};

/** A file read as the native `Devbox.readFile` answers it: the bytes only when asked for base64,
 *  otherwise `Response.text()`, which replaces every invalid UTF-8 sequence. */
export function nativeFileRead(bytes: Uint8Array, opts?: { encoding?: 'utf-8' | 'base64' }): { content: string; encoding: string } {
  return opts?.encoding === 'base64'
    ? { content: Buffer.from(bytes).toString('base64'), encoding: 'base64' }
    : { content: new TextDecoder().decode(bytes), encoding: 'utf-8' };
}
