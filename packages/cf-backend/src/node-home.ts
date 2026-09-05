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

import { headAgentName, nodeAgentName, subordinateAgentName } from '@kinu.run/core';
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
 * The facet kinds an owner provisions homes for. A branch is not one: an MCTS
 * rollout is toolless and acquires no plane at all.
 */
export type HostedFacetKind = 'node' | 'head' | 'subordinate';

/** The one home namespace, by kind: `node-<id>`, `head-<id>`, `sub-<slug>`.
 *  Derived on the owner from the kind and the id it is handed, so a facet
 *  names what it IS and never the directory it wants. */
export function hostedFacetAgentName(kind: HostedFacetKind, id: string): string {
  switch (kind) {
    case 'node': return nodeAgentName(id);
    case 'head': return headAgentName(id);
    case 'subordinate': return subordinateAgentName(id);
  }
}

/**
 * Where an actor's facets get their homes: the owner's registry, reached
 * directly by the owner and over one hop by every facet. Provision is
 * idempotent — a facet that comes back finds the home it already had — and
 * release reclaims the bytes and the `/tmp` rewrite while the uid row stays.
 */
export interface HostedFacetHomes {
  provision(kind: HostedFacetKind, id: string): Promise<HostedNodeHome>;
  release(kind: HostedFacetKind, id: string): Promise<void>;
}

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
