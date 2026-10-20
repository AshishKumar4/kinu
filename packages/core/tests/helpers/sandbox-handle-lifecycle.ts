import type { SandboxHandle } from '../../src/index';

/** Unused native stat and lifecycle routes: file fixtures override statFile with their filesystem's metadata. */
export const sandboxHandleLifecycle: Pick<
  SandboxHandle,
  | 'ensureReady' | 'startSupervisedProcess' | 'stopSupervisedProcess' | 'supervisedProcessLogs'
  | 'listSupervisedProcesses' | 'portToken' | 'probePort' | 'resize' | 'portListeners' | 'stampedProcesses' | 'answerRest' | 'statFile'
  | 'writeFileIfDigest' | 'desktop' | 'releaseDesktop'
> = {
  ensureReady: async () => {},
  statFile: async () => { throw new Error('this fixture does not read native metadata'); },
  writeFileIfDigest: async () => { throw new Error('this fixture does not replace files under a digest'); },
  startSupervisedProcess: async () => ({ processId: 'proc-1' }),
  stopSupervisedProcess: async () => ({ stopped: true }),
  supervisedProcessLogs: async () => 'ready on 4100\n',
  listSupervisedProcesses: async () => [],
  portToken: async () => ({ urlToken: 'tok-1' }),
  probePort: async () => { throw new Error('this fixture does not probe a native listener'); },
  resize: async (size) => ({ kind: 'recorded', size }),
  portListeners: async () => null,
  stampedProcesses: async () => null,
  answerRest: async () => ({ kind: 'refused', reason: 'no rest ask is pending' }),
  desktop: async () => { throw new Error('this fixture has no desktop'); },
  releaseDesktop: async () => { throw new Error('this fixture has no desktop'); },
};

/** A file read as the native `Devbox.readFile` answers it: the bytes only when asked for base64,
 *  otherwise `Response.text()`, which replaces every invalid UTF-8 sequence. */
export function nativeFileRead(bytes: Uint8Array, opts?: { encoding?: 'utf-8' | 'base64' }): { content: string; encoding: string } {
  return opts?.encoding === 'base64'
    ? { content: Buffer.from(bytes).toString('base64'), encoding: 'base64' }
    : { content: new TextDecoder().decode(bytes), encoding: 'utf-8' };
}
