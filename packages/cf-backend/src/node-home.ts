/**
 * A hosted swarm node's home, on a REMOTE Nimbus session.
 *
 * Same contract as the in-isolate backend — `NodeWorkspaceProvisioner`, the one
 * seam core knows — and a different applier, because this filesystem is not in
 * this isolate: there is no uid-0 `SqliteVFS` view to `chown` with, so the
 * layout `vfs/agent-home.ts` describes is applied by the session's own
 * coreutils, run as uid 0 over the RPC the actor already holds.
 *
 * The layout itself is NOT restated here. `agentHomeLayout` is the table; this
 * module renders it into one command, so a home's owner and mode cannot drift
 * between the two backends.
 *
 * What the session cannot do is `confinePrincipal` — it is a `SqliteVFS` method
 * with no RPC — so a hosted node's `/tmp/<node>` is a real private directory
 * that `TMPDIR` points at, and a command hardcoding `/tmp/x` lands in the shared
 * `/tmp` instead of being rewritten. That is the whole of the difference, and it
 * is stated rather than papered over.
 */

import {
  agentCred, agentHome, agentHomeLayout, agentIdentity, agentTmpRoot, nodeAgentName,
} from '@kinu.run/core';
import type { NimbusSandboxHandle, NodeWorkspaceProvisioner } from '@kinu.run/core';
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

export function createNimbusNodeHomeProvisioner(
  sql: SqlDatabase,
  box: NimbusSandboxHandle,
): NodeWorkspaceProvisioner {
  return async (node) => {
    const name = nodeAgentName(node.nodeId);
    // Allocates and validates before a single character reaches the session
    // shell: a name that could escape `/home` is refused here, and the uid row
    // is the durable half a reset must not change.
    const identity = agentIdentity(sql, name);
    // ONE command for the whole layout, and `&&` between its directories: a
    // half-applied home — created but not owned — is a home the node cannot
    // write, and two round trips is how that becomes reachable.
    const applied = agentHomeLayout(name, identity).map((dir) => {
      const path = shellQuote(dir.path);
      return `mkdir -p -- ${path} && chown ${dir.uid}:${dir.gid} ${path} && chmod ${dir.mode.toString(8)} ${path}`;
    });
    await rootExec(box, applied.join(' && '), `provision node home ${agentHome(name)}`);
    return {
      home: agentHome(name),
      tmp: agentTmpRoot(name),
      cred: agentCred(identity),
      isolation: 'private-home',
    };
  };
}

/**
 * Reclaim a hosted node's bytes, and only its bytes.
 *
 * Its uid row is NOT dropped: the allocation is durable so a node that comes
 * back after a reset finds the identity it already had, and nothing else in the
 * session is keyed by it.
 */
export async function cleanupNimbusNodeHome(
  box: NimbusSandboxHandle,
  nodeId: string,
): Promise<void> {
  const name = nodeAgentName(nodeId);
  const home = agentHome(name);
  await rootExec(
    box,
    `rm -rf -- ${shellQuote(home)} ${shellQuote(agentTmpRoot(name))}`,
    `remove node home ${home}`,
  );
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
