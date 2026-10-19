/**
 * The toolchain a Nimbus workspace can reach: the runtime packages the host supplies (never imported here: they read
 * `node:fs`), which NimbusWorkspace installs on the first use of one of their bins and rehydrates when the workspace
 * reopens. npm and npx are the hosted runtime's own commands.
 */

import * as v from 'valibot';
import { KinuError, refusalOf, renderCauseChain, toKinuError, type Refusal } from '../obs/index';
import type { JsonValue } from '../utils/json';

/**
 * What the workspace shell does instead of a command models reach for that it lacks, where it has one: measured on
 * staging, 2026-10-19 (`rg` refused 10 of Luna's calls in the rc20 trials; `grep -rn` and `diff` answer there).
 */
const IN_THIS_SHELL: ReadonlyMap<string, string> = new Map([
  ['rg', 'Here `grep -rn <pattern> <dir>` searches. '],
  ['cmp', 'Here `diff` compares files. '],
]);

/**
 * Turn a shell's exit-127 "command not found" into a refusal naming the real exits: what this shell does instead,
 * `help`, which lists its commands, the computer, `nimbus install`. `cataloged` is per call: installed runtimes
 * re-register bins mid-session.
 */
export async function workspaceCommandNotFound<O extends { stdout: string; stderr: string; exitCode: number; refusal?: Refusal }>(
  outcome: O,
  cataloged: (bin: string) => boolean | { readonly unreadable: KinuError } | Promise<boolean | { readonly unreadable: KinuError }>,
): Promise<O> {
  if (outcome.refusal !== undefined || outcome.exitCode !== 127) return outcome;

  const missing = /^\s*([^\s:]+): command not found$/m.exec(outcome.stderr)?.[1];

  if (missing === undefined) return outcome;

  const bin = missing.includes('/') ? missing.slice(missing.lastIndexOf('/') + 1) : missing;
  const catalog = await cataloged(bin);
  const installable = catalog === true;
  const unreadable = catalog !== true && catalog !== false ? catalog.unreadable : undefined;
  const instead = IN_THIS_SHELL.get(bin);

  return {
    ...outcome,
    refusal: refusalOf(new KinuError(
      'unavailable',
      `${bin}: no such command in this workspace's shell, whose commands \`help\` lists. `
        + (instead ?? '')
        + (installable
          ? `Run it on your computer (runtime 'computer'), or install it with \`nimbus install ${bin}\`.`
          : `Run it on your computer (runtime 'computer'), which ships a full toolchain, `
            + `or install it with \`nimbus install ${bin}\` if a Nimbus runtime provides it.`)
        // "No bins known" and "could not ask" are different answers.
        + (unreadable === undefined ? '' : ` The runtime catalog could not be read: ${renderCauseChain(unreadable)}`),
      { execution: { exitCode: outcome.exitCode } },
    )),
  };
}


/** `runtimes.list()` answer: `{installed, available}` on the SDK handle, or a bare `installed` array. */
const NimbusRuntimeCatalogSchema = v.union([
  v.object({
    installed: v.array(v.object({ name: v.string(), bins: v.array(v.string()) })),
    available: v.array(v.object({ name: v.string() })),
  }),
  v.array(v.object({ name: v.string(), bins: v.array(v.string()) })),
]);

/** Bins a hosted session box can put on PATH: installed bins plus available runtime names. */
export async function sessionRuntimeBins(list: () => Promise<JsonValue | undefined>): Promise<ReadonlySet<string> | { readonly unreadable: KinuError }> {
  try {
    const parsed = v.safeParse(NimbusRuntimeCatalogSchema, await list());

    if (!parsed.success) return new Set();

    const rows = Array.isArray(parsed.output) ? parsed.output : parsed.output.installed;
    const names = new Set<string>();

    for (const runtime of rows) for (const bin of runtime.bins) names.add(bin);

    if (!Array.isArray(parsed.output)) {
      for (const available of parsed.output.available) names.add(available.name);
    }

    return names;
  } catch (cause) {
    // Distinct from a catalog that parsed and named no bins.
    return { unreadable: toKinuError({ doing: 'reading the session box runtime catalog', cause, otherwise: 'io' }) };
  }
}
