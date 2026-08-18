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
 * Locked cli-only in scripts/capability-parity.lock.json rather than moved to a
 * shared package. It imports nothing core could not, so the parity gate reads it
 * as movable — but `Bun.which` is a platform global, absent on workerd, and the
 * gate says outright that a global reached with no import is its blind spot.
 * Nor is there anything for cf to under-wire: a Worker isolate has no host and
 * no PATH, and the cf `laptop` is the device tunnel, which cannot be probed from
 * that side at all until `DeviceStatus` can carry an answer back — the gap
 * recorded in docs/EXECUTION-LAYER-SPEC.md.
 */

import type { ExecutorCapability } from '@proteus/core';

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

/**
 * A capability and the PATH entries that would make it true. Any one suffices —
 * each named binary runs that language or tool by itself.
 *
 * `docker` is deliberately absent: a `docker` client on PATH evidences a client,
 * not a reachable daemon, and the capability reads "Docker". `gpu` likewise —
 * nothing on PATH establishes usable hardware.
 */
const PROBED: readonly (readonly [ExecutorCapability, readonly string[]])[] = [
  ['javascript', ['node', 'bun', 'deno']],
  // `tsc` is not in this list on purpose: it type-checks, it does not run. These
  // three execute a `.ts` file directly.
  ['typescript', ['bun', 'deno', 'tsx']],
  ['python', ['python3', 'python']],
  // Reads "Installs npm packages", and all four install from the npm registry —
  // the same set core's approval gate treats as the package managers.
  ['npm', ['npm', 'bun', 'pnpm', 'yarn']],
  ['git', ['git']],
];

/** Every capability the host running this CLI can be shown to have.
 *
 *  `PATH` is passed rather than left ambient: bare `Bun.which` resolves against
 *  the environment the process STARTED with, and the agent can install a
 *  toolchain onto this very machine mid-session (`laptop.exec`), so the live
 *  value is the honest one to ask against. */
export function hostToolchainCapabilities(): readonly ExecutorCapability[] {
  const PATH = process.env.PATH ?? '';
  return [
    ...STRUCTURAL,
    ...PROBED
      .filter(([, binaries]) => binaries.some((binary) => Bun.which(binary, { PATH }) !== null))
      .map(([capability]) => capability),
  ];
}
