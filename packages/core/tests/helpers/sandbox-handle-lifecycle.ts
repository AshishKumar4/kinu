import type { SandboxHandle } from '../../src/index';

/** The lifecycle surface every fake handle must carry now that supervision is
 *  part of the contract. Suites that never touch processes spread this in. */
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
