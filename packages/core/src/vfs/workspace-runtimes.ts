/**
 * The toolchain an embedded Nimbus workspace can reach: lifo's npm/npx, and the runtime packages the host supplies
 * (never imported here: they read `node:fs`), which NimbusWorkspace installs on the first use of one of their bins
 * and rehydrates when the workspace reopens.
 */

import { textSink } from '@nimbus-sh/core/_shared/bytes.js';
import type { ShellExecuteFn } from '@nimbus-sh/core/substrate/lifo/commands/system/npm.js';
import type { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import * as v from 'valibot';
import { KinuError, refusalOf, renderCauseChain, toKinuError, type Refusal } from '../obs/index';
import type { JsonValue } from '../utils/json';

/**
 * Turn a shell's exit-127 "command not found" into a refusal naming the real exits (sandbox, `nimbus install`).
 * `cataloged` is per call: installed runtimes re-register bins mid-session.
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

  return {
    ...outcome,
    refusal: refusalOf(new KinuError(
      'unavailable',
      `${bin}: no such command in this workspace's shell. `
        + (installable
          ? `Run it in the sandbox executor (runtime 'sandbox'), or install it with \`nimbus install ${bin}\`.`
          : `Run it in the sandbox executor (runtime 'sandbox'), which ships a full toolchain, `
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

/** Registers npm and npx on the workspace's shell; nothing is fetched until a subcommand runs. */
export async function registerNpm(workspace: NimbusWorkspace): Promise<void> {
  // At first registration, not module eval: lifo's npm would otherwise join every consumer's static import graph.
  const npm = await import('@nimbus-sh/core/substrate/lifo/commands/system/npm.js');
  const registry = workspace.registry;

  // Per-stream decoder so a multibyte character split across chunks lands whole.
  const shellExecute: ShellExecuteFn = async (command, ctx) => (await workspace.shell.execute(command, {
    cwd: ctx.cwd,
    env: ctx.env,
    onStdout: textSink((text) => ctx.stdout.write(text)),
    onStderr: textSink((text) => ctx.stderr.write(text)),
  })).exitCode;

  registry.register('npm', npm.createNpmCommand(registry, shellExecute, workspace.kernel));
  registry.register('npx', npm.createNpxCommand(registry, shellExecute));
}

