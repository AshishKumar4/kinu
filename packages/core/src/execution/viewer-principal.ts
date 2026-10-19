/**
 * A share's viewer on the workspace's own box: who it runs as there, so the owner's files and processes are never its
 * own, and how its processes are known wherever they go, so the egress never spends an owner's secret for one.
 */

import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { VIEWER_HOME_NAME, type AgentIdentity } from '../vfs/agent-home';
import type { NimbusSandboxHandle } from './nimbus';
import { withCommandOptions } from './node-home';
import { principalExecId, secretsCaller } from './secrets-caller';

/** Where a viewer's commands run: its own home and `/tmp`, as its own uid. */
export interface ViewerPlace {
  readonly home: string;
  readonly tmp: string;
  readonly cred: VfsCred;
}

/**
 * The viewer's credential: its own uid and group and no other, so it writes only its own home and `/tmp` and reads of the
 * workspace what everyone may; files it makes are its alone.
 */
export function viewerCred(identity: AgentIdentity): VfsCred {
  return { uid: identity.uid, gid: identity.gid, groups: [identity.gid], umask: 0o077 };
}

/**
 * `box` with each viewer's call run as the viewer (`place`): its credential, `HOME` and `TMPDIR`, a process named as a
 * viewer's, and named shells of its own, so it never resumes the owner's directory or exported variables. An owner's
 * call passes as it is. Innermost of the wrappers, so a facet's own home never stands in for the viewer's.
 */
export function withViewerPrincipal(box: NimbusSandboxHandle, place: () => Promise<ViewerPlace>): NimbusSandboxHandle {
  const shell = (name: string): string => (secretsCaller() === 'viewer' ? `${VIEWER_HOME_NAME}.${name}` : name);

  const viewed = withCommandOptions(box, async (options) => {
    if (secretsCaller() !== 'viewer') return options;
    const { home, tmp, cred } = await place();

    return {
      ...options,
      ...(options?.shellId !== undefined && { shellId: shell(options.shellId) }),
      env: { ...options?.env, HOME: home, TMPDIR: tmp },
      cred,
      execId: principalExecId(options?.execId ?? crypto.randomUUID()),
    };
  });

  const shellCwd = box.shellCwd?.bind(box);
  const shellState = box.shellState?.bind(box);

  // A named shell's directory and variables are read under the name its calls run in.
  return {
    ...viewed,
    ...(shellCwd !== undefined && { shellCwd: async (name: string) => shellCwd(shell(name)) }),
    ...(shellState !== undefined && { shellState: async (name: string) => shellState(shell(name)) }),
  };
}
