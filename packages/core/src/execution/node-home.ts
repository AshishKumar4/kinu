/**
 * A hosted facet's home on its workspace's Nimbus session. Provisioning runs on the object that owns the
 * workspace (`confinePrincipal` has no RPC), so a facet asks the owner via `provisionFacetHome`.
 */

import { type NimbusSandboxHandle } from './nimbus';
import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';

/** What a hosted facet rebuilds its runtime from: home, scratch, and identity on both planes. */
export interface HostedNodeHome {
  readonly home: string;
  readonly tmp: string;
  readonly cred: VfsCred;
}

/** Actor-home kinds and provisioning live in `actor-hosting.ts`. */

/**
 * The session as one facet: its uid, home, `HOME` and `TMPDIR`. The file half is
 * `nimbusSessionFiles(box, cred)`; both are required or the facet cannot write its own home.
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
