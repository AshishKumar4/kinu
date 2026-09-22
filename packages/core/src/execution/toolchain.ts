/** Shared capability-to-binaries table for every toolchain probe (cli `host-toolchain.ts`, `pc-agent`). */

import { type ExecutorCapability } from './types';

/** A capability and the PATH entries that make it true; any one suffices. */
export const TOOLCHAIN_PROBE: readonly (readonly [ExecutorCapability, readonly string[]])[] = [
  ['javascript', ['node', 'bun', 'deno']],
  // No `tsc`: it type-checks, it does not run.
  ['typescript', ['bun', 'deno', 'tsx']],
  ['python', ['python3', 'python']],
  // Same set core's approval gate treats as package managers.
  ['npm', ['npm', 'bun', 'pnpm', 'yarn']],
  ['git', ['git']],
] as const;

/** Capabilities a probe cannot settle; declared so omission is not read as measured absence. */
export const TOOLCHAIN_UNPROBEABLE: readonly (readonly [ExecutorCapability, string])[] = [
  // A `docker` client on PATH does not prove a reachable daemon.
  ['docker', 'a docker client on PATH is not a reachable daemon'],
  ['gpu', 'nothing on PATH establishes usable hardware'],
] as const;

/** Capabilities a PATH lookup can settle; anything outside was never measured. */
export const TOOLCHAIN_PROBED_CAPABILITIES: readonly ExecutorCapability[] =
  TOOLCHAIN_PROBE.map(([capability]) => capability);

/** Every binary name worth asking about, deduped; hosts answer only for these, so the probe cannot enumerate a machine. */
export const TOOLCHAIN_PROBE_BINARIES: readonly string[] =
  [...new Set(TOOLCHAIN_PROBE.flatMap(([, binaries]) => binaries))];

export function toolchainCapabilities(present: Iterable<string>): ExecutorCapability[] {
  const found = present instanceof Set ? present : new Set(present);

  return TOOLCHAIN_PROBE
    .filter(([, binaries]) => binaries.some((binary) => found.has(binary)))
    .map(([capability]) => capability);
}
