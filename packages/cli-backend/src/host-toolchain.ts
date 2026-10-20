/**
 * Host capabilities, probed via PATH. Deliberately not memoised: the answer
 * changes under a long session (`npm i -g`). The question itself lives in core
 * (`execution/toolchain.ts`), shared with the device daemon.
 */

import { which } from 'bun';
import {
  createInlineExecutor, TOOLCHAIN_PROBE_BINARIES, TOOLCHAIN_UNPROBEABLE, toolchainCapabilities,
  type ActorHandle, type ExecutorCapability, type ExecutorProvider, type InlineExecutorDeps, type SqlExecutor,
} from '@kinu.run/core';
import { hostResourceLimits } from './cgroup-limits';

/** True by construction of this executor's wiring, not by probe. */
const STRUCTURAL: readonly ExecutorCapability[] = [
  'native_binary', 'shell', 'fs_shared', 'net_outbound', 'process_spawn',
] as const;

/** `PATH` is passed explicitly: bare `Bun.which` resolves against the startup
 *  environment, and the agent can install toolchains mid-session. */
export function hostToolchainCapabilities(): readonly ExecutorCapability[] {
  const PATH = process.env.PATH ?? '';
  const found = TOOLCHAIN_PROBE_BINARIES.filter((binary) => which(binary, { PATH }) !== null);

  return [...STRUCTURAL, ...toolchainCapabilities(found)];
}

/** Declared rather than dropped: an omission reads to the agent like a measured absence. */
const HOST_UNMEASURED_CAPABILITIES: readonly ExecutorCapability[] =
  TOOLCHAIN_UNPROBEABLE.map(([capability]) => capability);

/** What an actor's workspace executor is built over: its own file plane, and the shared machine. */
type HostWorkspace = Omit<InlineExecutorDeps, 'filesOwner' | 'toolchain' | 'unmeasured' | 'resourceLimits' | 'sql' | 'actor'>
  & { readonly sql: SqlExecutor; readonly actor: ActorHandle };

/** An actor's `workspace` executor on this machine: its files are the actor's own plane, and what the machine is (its
 *  shell's owner, toolchain and limits) is the host's. */
export function hostWorkspaceExecutor(workspace: HostWorkspace): ExecutorProvider {
  const limits = hostResourceLimits();

  return createInlineExecutor({
    ...workspace,
    crafting: () => workspace.actor.config.getCrafting(),
    filesOwner: 'user',
    toolchain: hostToolchainCapabilities(),
    unmeasured: HOST_UNMEASURED_CAPABILITIES,
    ...(limits !== null && { resourceLimits: limits }),
  });
}
