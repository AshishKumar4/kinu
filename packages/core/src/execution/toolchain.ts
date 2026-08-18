/**
 * The toolchain question, asked once for every machine we can ask.
 *
 * Two environments answer "what can this host run": the machine the CLI runs on
 * (cli-backend `host-toolchain.ts`, via `Bun.which` against a live PATH) and the
 * user's tunnelled machine (the `pc-agent` daemon, via a PATH walk it performs
 * on itself). The MECHANISM has to differ — only a host can look at its own
 * PATH, and one of those hosts is a dependency-free Node script — but the
 * QUESTION must not. A second table of "which binaries prove `python`" is the
 * drift this repo keeps deleting, so the table lives here and both lookups
 * consume it.
 *
 * Declared sets are rendered into the agent's own execution block
 * (`prompting/volatile-context.ts` — `— runs: …`), which is where the model
 * decides to send work. A capability declared but absent routes work to a
 * machine that cannot do it; one present but undeclared means the work never
 * goes there at all. Both failures are why this is probed rather than assumed.
 */

import { type ExecutorCapability } from './types';

/**
 * A capability and the PATH entries that would make it true. Any one suffices —
 * each named binary runs that language or tool by itself.
 */
export const TOOLCHAIN_PROBE: readonly (readonly [ExecutorCapability, readonly string[]])[] = [
  ['javascript', ['node', 'bun', 'deno']],
  // `tsc` is not in this list on purpose: it type-checks, it does not run. These
  // three execute a `.ts` file directly.
  ['typescript', ['bun', 'deno', 'tsx']],
  ['python', ['python3', 'python']],
  // Reads "Installs npm packages", and all four install from the npm registry —
  // the same set core's approval gate treats as the package managers.
  ['npm', ['npm', 'bun', 'pnpm', 'yarn']],
  ['git', ['git']],
] as const;

/**
 * What a probe cannot settle either way, and why. Declaring these is the point:
 * a capability quietly omitted from a row reads to the model exactly like one
 * measured absent, and `gpu` is the entry that costs the most to get wrong — a
 * user may have attached their machine FOR its GPU, and an undeclared GPU is
 * work that never goes there.
 */
export const TOOLCHAIN_UNPROBEABLE: readonly (readonly [ExecutorCapability, string])[] = [
  // A `docker` client on PATH evidences a client, not a reachable daemon, and
  // the capability reads "Docker" — it promises containers run.
  ['docker', 'a docker client on PATH is not a reachable daemon'],
  ['gpu', 'nothing on PATH establishes usable hardware'],
] as const;

/** Every capability a PATH lookup CAN settle — the probe's declared scope.
 *  Anything outside it was never measured, which is not the same as absent. */
export const TOOLCHAIN_PROBED_CAPABILITIES: readonly ExecutorCapability[] =
  TOOLCHAIN_PROBE.map(([capability]) => capability);

/** Every binary name worth asking a host about, deduped. The wire form of the
 *  question: a host answers which of THESE it has, and nothing else — so the
 *  probe can never become a way to enumerate someone's machine. */
export const TOOLCHAIN_PROBE_BINARIES: readonly string[] =
  [...new Set(TOOLCHAIN_PROBE.flatMap(([, binaries]) => binaries))];

/**
 * The capabilities a set of resolved binary names establishes. The one mapping
 * from "what is installed" to "what this row may claim"; every prober feeds it
 * the names its own host resolved.
 */
export function toolchainCapabilities(present: Iterable<string>): ExecutorCapability[] {
  const found = present instanceof Set ? present : new Set(present);
  return TOOLCHAIN_PROBE
    .filter(([, binaries]) => binaries.some((binary) => found.has(binary)))
    .map(([capability]) => capability);
}
