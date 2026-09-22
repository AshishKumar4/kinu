/**
 * Host capabilities, probed via PATH. Deliberately not memoised: the answer
 * changes under a long session (`npm i -g`). The question itself lives in core
 * (`execution/toolchain.ts`), shared with the device daemon.
 */

import { which } from 'bun';
import {
  TOOLCHAIN_PROBE_BINARIES, TOOLCHAIN_UNPROBEABLE, toolchainCapabilities,
  type ExecutorCapability,
} from '@kinu.run/core';

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
export const HOST_UNMEASURED_CAPABILITIES: readonly ExecutorCapability[] =
  TOOLCHAIN_UNPROBEABLE.map(([capability]) => capability);
