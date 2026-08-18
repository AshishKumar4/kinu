/**
 * What the machine the CLI is running on can actually run — asked of that
 * machine, not assumed of it.
 *
 * The set an executor declares is rendered into the agent's own execution block
 * (core `prompting/volatile-context.ts` — `— runs: …`), so it is where the model
 * decides to send work: a capability declared but absent routes work to a
 * machine that cannot do it, and one present but undeclared means the work never
 * goes there at all. The `laptop` row here is the user's own host, and the only
 * way the agent reaches it is `laptop.exec` — a PATH lookup. So PATH is exactly
 * the right evidence, and `Bun.which` asks the very machine in question instead
 * of inferring a toolchain from the fact that developers usually have one.
 *
 * Counterpart of core's `workspaceToolchainCapabilities`, which answers the same
 * question from the runtime packages a workspace was given. Deliberately not
 * memoised: the answer can change under a long session (`npm i -g`), and a stale
 * cached row is the failure this module exists to prevent.
 *
 * The QUESTION lives in core (`execution/toolchain.ts`) and is shared with the
 * user's tunnelled machine, which answers it about itself over the device
 * tunnel. Only the lookup differs — `Bun.which` here, a PATH walk in the
 * dependency-free daemon there — because only a host can look at its own PATH.
 * A second table of which binaries prove `python` is the drift this repo keeps
 * deleting.
 *
 * Locked cli-only in scripts/capability-parity.lock.json rather than moved to a
 * shared package. It imports nothing core could not, so the parity gate reads it
 * as movable — but `Bun.which` is a platform global, absent on workerd, and the
 * gate says outright that a global reached with no import is its blind spot.
 */

import {
  TOOLCHAIN_PROBE_BINARIES, TOOLCHAIN_UNPROBEABLE, toolchainCapabilities,
  type ExecutorCapability,
} from '@proteus/core';

/** True by construction rather than by probe — properties of this executor's own
 *  wiring, which no PATH lookup could confirm or deny:
 *  `shell` — `createHostShell` spawns through the host's real shell;
 *  `fs_shared` — the tools read and write the user's own files in place;
 *  `net_outbound` — this process reached a model API to get here;
 *  `process_spawn` — `exec` starts children via `node:child_process`;
 *  `native_binary` — this process IS one, on that machine. */
const STRUCTURAL: readonly ExecutorCapability[] = [
  'native_binary', 'shell', 'fs_shared', 'net_outbound', 'process_spawn',
] as const;

/** Every capability the host running this CLI can be shown to have.
 *
 *  `PATH` is passed rather than left ambient: bare `Bun.which` resolves against
 *  the environment the process STARTED with, and the agent can install a
 *  toolchain onto this very machine mid-session (`laptop.exec`), so the live
 *  value is the honest one to ask against. */
export function hostToolchainCapabilities(): readonly ExecutorCapability[] {
  const PATH = process.env.PATH ?? '';
  const found = TOOLCHAIN_PROBE_BINARIES.filter((binary) => Bun.which(binary, { PATH }) !== null);
  return [...STRUCTURAL, ...toolchainCapabilities(found)];
}

/** What this host cannot answer for either way — `docker` and `gpu`, for the
 *  reasons core records against them. Declared rather than dropped: an omission
 *  reads to the agent's execution block exactly like a measured absence, and
 *  "no GPU here" is a claim nothing on PATH entitles this row to make. */
export const HOST_UNMEASURED_CAPABILITIES: readonly ExecutorCapability[] =
  TOOLCHAIN_UNPROBEABLE.map(([capability]) => capability);
