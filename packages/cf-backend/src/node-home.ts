/**
 * A hosted facet's home, on the Nimbus session its workspace owns.
 *
 * The layout is core's and so is the applier: `facetHomeProvisioner` over the
 * three members `WorkspaceBundle.privileged()` hands out, exactly as the local
 * backend runs it. That works because provisioning runs ON the object that
 * owns the workspace — the orchestrator holds the uid-0 view, the principal
 * registry and the uid table in one database — and nowhere else: a facet's
 * workspace is one Durable Object away, and `confinePrincipal` has no RPC, so
 * a facet asks the owner for its home (`provisionFacetHome`) and the owner
 * applies it in its own isolate. Nothing is copied and nothing is mounted.
 *
 * What is here is the hosted half a facet REBUILDS from that home: the kinds
 * an owner provisions for, the port every actor reaches the owner through, and
 * the execution wrapper that makes a session act as one facet.
 */

import type { NimbusSandboxHandle } from '@kinu.run/core';
import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';

/**
 * What a hosted facet rebuilds its runtime from: where its own files belong,
 * where its scratch is, and who it acts as on BOTH planes.
 *
 * Three fields and no id, because that is everything the facet does with it —
 * a facet that carried its own id back from the parent would be quoting a
 * value it already had.
 */
export interface HostedNodeHome {
  readonly home: string;
  readonly tmp: string;
  readonly cred: VfsCred;
}

/**
 * The actor-home kind vocabulary, the name namespace it maps onto, and the
 * provisioner all live in `actor-hosting.ts`, as `HostedActorHomeKind`,
 * `hostedActorAgentName` and `provisionHostedActorHome`. The host provisions
 * each actor's home locally from the workspace's home host and directory, so
 * the kind vocabulary and the provisioner each have one owner rather than a
 * second copy of each here that nothing would call.
 */

/**
 * The session, addressed as one facet: commands run as its uid, from its home,
 * with `HOME` and `TMPDIR` pointing at its own directories.
 *
 * The FILE half is not here — it is `nimbusSessionFiles(box, cred)` in core,
 * built from the same credential by `createCFRuntime`. Both halves are required:
 * a facet whose commands were confined and whose file tools were the session
 * user could not write its own home at all.
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
