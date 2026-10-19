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

type CommandOptions = Parameters<NimbusSandboxHandle['exec']>[1];

/**
 * `box` with every command it runs, a process it keeps running past the call (`startProcess`) included, given the
 * options `optionsFor` makes of the caller's. Nothing that runs a command is carried over as it is: a member not bound
 * here is absent, never run as someone else.
 */
export function withCommandOptions(
  box: NimbusSandboxHandle,
  optionsFor: (options: CommandOptions) => CommandOptions | Promise<CommandOptions>,
): NimbusSandboxHandle {
  const execution: NimbusSandboxHandle = {
    ready: () => box.ready(),
    ...(box.runtimes !== undefined && { runtimes: box.runtimes }),
    ...(box.processes !== undefined && { processes: box.processes }),
    ...(box.ports !== undefined && { ports: box.ports }),
    ...(box.mountTable !== undefined && { mountTable: box.mountTable.bind(box) }),
    ...(box.namespace !== undefined && { namespace: box.namespace.bind(box) }),
    ...(box.shellCwd !== undefined && { shellCwd: box.shellCwd.bind(box) }),
    exec: async (command, options) => box.exec(command, await optionsFor(options)),
  };

  if (box.execStream) {
    const execStream = box.execStream;
    execution.execStream = async (command, options) => execStream(command, await optionsFor(options));
  }

  if (box.startProcess) {
    const startProcess = box.startProcess;
    execution.startProcess = async (command, options) => startProcess(command, await optionsFor(options));
  }

  return execution;
}

/**
 * The session as one facet: its uid, home, `HOME` and `TMPDIR`. The file half is
 * `nimbusSessionFiles(box, cred)`; both are required or the facet cannot write its own home.
 */
export function withHostedNodeExecution(box: NimbusSandboxHandle, node: HostedNodeHome): NimbusSandboxHandle {
  // An unnamed call starts at home unless told; a named one where its shell is, unless told.
  return withCommandOptions(box, (options) => ({
    ...options,
    ...(options?.shellId === undefined && { cwd: options?.cwd ?? node.home }),
    env: { ...options?.env, HOME: node.home, TMPDIR: node.tmp },
    cred: node.cred,
  }));
}
