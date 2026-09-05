/**
 * A hosted facet's home, on the Nimbus session its workspace owns.
 *
 * Same contract as the in-isolate backend — `NodeWorkspaceProvisioner`, the one
 * seam core knows — and a different applier for the LAYOUT, because the session
 * is reached over an RPC rather than a local view: there is no uid-0
 * `SqliteVFS` to `chown` with, so the layout `vfs/agent-home.ts` describes is
 * applied by the session's own coreutils, run as uid 0 over the box the actor
 * already holds.
 *
 * The layout itself is NOT restated here. `agentHomeLayout` is the table; this
 * module renders it into one command, so a home's owner and mode cannot drift
 * between the two backends.
 *
 * The `/tmp` rewrite is NOT applied over that RPC. `confinePrincipal` is a
 * `SqliteVFS` method with no RPC — and it needs none, because this provisioner
 * runs ON the object that owns the workspace: the owner passes its own
 * `SqliteVFS` as `confiner`, and the rewrite lands in the same registry every
 * plane of that session resolves through. A provisioner that cannot reach the
 * owner's filesystem passes none, and its facets get `TMPDIR` alone — a
 * command hardcoding `/tmp/x` there lands in the shared `/tmp`.
 */

import {
  agentCred, agentHome, agentHomeLayout, agentIdentity, agentTmpRoot, confineAgentTmp, nodeAgentName,
} from '@kinu.run/core';
import type { NimbusSandboxHandle, NodeWorkspaceProvisioner, TmpConfiner } from '@kinu.run/core';
import { CRED_KERNEL, type SqlDatabase, type VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { shellQuote } from './cli/install-command';

/**
 * What a hosted node's facet rebuilds its runtime from: where its own files
 * belong, where its scratch is, and who it acts as on BOTH planes.
 *
 * Three fields and no node id, because that is everything the facet does with
 * it — a facet that carried its own id back from the parent would be quoting a
 * value it already had.
 */
export interface HostedNodeHome {
  readonly home: string;
  readonly tmp: string;
  readonly cred: VfsCred;
}

async function rootExec(box: NimbusSandboxHandle, command: string, doing: string): Promise<void> {
  const result = await box.exec(command, { cwd: '/', cred: CRED_KERNEL });
  if (!result.success) {
    throw new Error(`Nimbus could not ${doing}: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`);
  }
}

/**
 * Provision one facet agent's home on the session: its layout through the
 * session's own coreutils as uid 0, its `/tmp` rewrite in the owner's
 * principal registry when the caller can reach it.
 *
 * The `confiner` is the owning object's own `SqliteVFS` — the same instance
 * every plane of its session resolves through — so this call belongs wherever
 * the workspace object itself lives, beside the uid allocation in the same
 * database. A caller that only holds the box passes none and gets the
 * `TMPDIR`-only layout; nothing is copied and nothing is mounted to make up
 * for it.
 */
export async function provisionNimbusAgentHome(
  sql: SqlDatabase,
  box: NimbusSandboxHandle,
  agentName: string,
  confiner?: TmpConfiner,
): Promise<HostedNodeHome & { readonly isolation: 'private-home' }> {
  // Allocates and validates before a single character reaches the session
  // shell: a name that could escape `/home` is refused here, and the uid row
  // is the durable half a reset must not change.
  const identity = agentIdentity(sql, agentName);
  // ONE command for the whole layout, and `&&` between its directories: a
  // half-applied home — created but not owned — is a home the facet cannot
  // write, and two round trips is how that becomes reachable.
  const applied = agentHomeLayout(agentName, identity).map((dir) => {
    const path = shellQuote(dir.path);
    return `mkdir -p -- ${path} && chown ${dir.uid}:${dir.gid} ${path} && chmod ${dir.mode.toString(8)} ${path}`;
  });
  await rootExec(box, applied.join(' && '), `provision node home ${agentHome(agentName)}`);
  // The rewrite, registered where the session resolves it rather than sent
  // over the box: the RPC carries no such call, and the owner holds the
  // registry directly.
  const tmp = confiner ? confineAgentTmp(confiner, agentName, identity) : agentTmpRoot(agentName);
  return {
    home: agentHome(agentName),
    tmp,
    cred: agentCred(identity),
    isolation: 'private-home',
  };
}

export function createNimbusNodeHomeProvisioner(
  sql: SqlDatabase,
  box: NimbusSandboxHandle,
  confiner?: TmpConfiner,
): NodeWorkspaceProvisioner {
  return async (node) => provisionNimbusAgentHome(sql, box, nodeAgentName(node.nodeId), confiner);
}

/**
 * Reclaim a hosted facet's bytes, and only its bytes.
 *
 * Its uid row is NOT dropped: the allocation is durable so a facet that comes
 * back after a reset finds the identity it already had, and nothing else in the
 * session is keyed by it. The confinement IS dropped when the caller hands
 * the registry over: the mapping is isolate memory, and a dead facet's uid
 * never recurs, so an unreleased entry is a leak rather than a hazard — but a
 * leak with a one-line cure at the site that already removes the bytes.
 */
export async function releaseNimbusAgentHome(
  box: NimbusSandboxHandle,
  agentName: string,
  release?: { readonly sql: SqlDatabase; readonly confiner: TmpConfiner },
): Promise<void> {
  const home = agentHome(agentName);
  await rootExec(
    box,
    `rm -rf -- ${shellQuote(home)} ${shellQuote(agentTmpRoot(agentName))}`,
    `remove node home ${home}`,
  );
  if (release) release.confiner.releasePrincipal(agentIdentity(release.sql, agentName).uid);
}

export async function cleanupNimbusNodeHome(
  box: NimbusSandboxHandle,
  nodeId: string,
  release?: { readonly sql: SqlDatabase; readonly confiner: TmpConfiner },
): Promise<void> {
  await releaseNimbusAgentHome(box, nodeAgentName(nodeId), release);
}

/**
 * The session, addressed as one node: commands run as its uid, from its home,
 * with `HOME` and `TMPDIR` pointing at its own directories.
 *
 * The FILE half is not here — it is `nimbusSessionFiles(box, cred)` in core,
 * built from the same credential by `createCFRuntime`. Both halves are required:
 * a node whose commands were confined and whose file tools were the session user
 * could not write its own home at all.
 */
export function withHostedNodeExecution(box: NimbusSandboxHandle, node: HostedNodeHome): NimbusSandboxHandle {
  const optionsFor = (options?: Parameters<NimbusSandboxHandle['exec']>[1]) => ({
    ...options,
    cwd: options?.cwd ?? node.home,
    env: { ...options?.env, HOME: node.home, TMPDIR: node.tmp },
    cred: node.cred,
  });
  const execution: NimbusSandboxHandle = {
    ...box,
    exec: (command, options) => box.exec(command, optionsFor(options)),
  };
  if (box.startProcess) {
    const startProcess = box.startProcess;
    execution.startProcess = (command, options) => startProcess(command, optionsFor(options));
  }
  if (box.runCode) {
    const runCode = box.runCode;
    execution.runCode = (code, options) => runCode(code, optionsFor(options));
  }
  return execution;
}
