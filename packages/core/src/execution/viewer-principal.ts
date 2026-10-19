/**
 * A share's viewer on the workspace's own box: who it runs as there, so the owner's files and processes are never its
 * own, and how its processes are known wherever they go, so the egress never spends an owner's secret for one.
 */

import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { AgentIdentity } from '../vfs/agent-home';
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
 * The agent's box (`owner`) with each viewer's call run on `viewer` as the viewer (`place`): its credential, `HOME` and
 * `TMPDIR`, and a process named as a viewer's. `viewer` keys its named shells in a domain of their own, so a viewer never
 * resumes the owner's directory or exported variables, whatever a shell is named. An owner's call passes as it is.
 * Innermost of the wrappers, so a facet's own home never stands in for the viewer's.
 */
export function withViewerPrincipal(
  boxes: { readonly owner: NimbusSandboxHandle; readonly viewer: NimbusSandboxHandle },
  place: () => Promise<ViewerPlace>,
): NimbusSandboxHandle {
  const { owner } = boxes;

  const viewer = withCommandOptions(boxes.viewer, async (options) => {
    const { home, tmp, cred } = await place();

    return { ...options, env: { ...options?.env, HOME: home, TMPDIR: tmp }, cred, execId: principalExecId(options?.execId ?? crypto.randomUUID()) };
  });

  const as = (): NimbusSandboxHandle => (secretsCaller() === 'viewer' ? viewer : owner);
  const routed: NimbusSandboxHandle = { ...owner, exec: async (command, options) => await as().exec(command, options) };

  if (owner.execStream !== undefined && viewer.execStream !== undefined) {
    const streams = { owner: owner.execStream.bind(owner), viewer: viewer.execStream.bind(viewer) };
    routed.execStream = async (command, options) => await (secretsCaller() === 'viewer' ? streams.viewer : streams.owner)(command, options);
  }

  if (owner.startProcess !== undefined && viewer.startProcess !== undefined) {
    const starts = { owner: owner.startProcess.bind(owner), viewer: viewer.startProcess.bind(viewer) };
    routed.startProcess = async (command, options) => await (secretsCaller() === 'viewer' ? starts.viewer : starts.owner)(command, options);
  }

  if (owner.shellCwd !== undefined && viewer.shellCwd !== undefined) {
    const cwds = { owner: owner.shellCwd.bind(owner), viewer: viewer.shellCwd.bind(viewer) };
    routed.shellCwd = async (name) => await (secretsCaller() === 'viewer' ? cwds.viewer : cwds.owner)(name);
  }

  if (owner.shellState !== undefined && viewer.shellState !== undefined) {
    const states = { owner: owner.shellState.bind(owner), viewer: viewer.shellState.bind(viewer) };
    routed.shellState = async (name) => await (secretsCaller() === 'viewer' ? states.viewer : states.owner)(name);
  }

  return routed;
}
