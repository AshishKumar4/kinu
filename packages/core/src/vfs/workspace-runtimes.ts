/**
 * The toolchain an embedded Nimbus workspace can reach. npm/npx are always registered; wasm interpreters
 * (bash, cpython) only where a `facets` host can run them. Runtime packages are supplied by the host, never
 * imported here (they read `node:fs`). Each runtime installs on first use of one of its bins via a stub;
 * reopening rehydrates installed runtimes, which an evicted Durable Object needs to see them again.
 */

import { BASH_RUNNER, CRED_KERNEL } from '@nimbus-sh/core/runtime/os-contracts.js';
import { textSink } from '@nimbus-sh/core/_shared/bytes.js';
import type { FacetHost } from '@nimbus-sh/core/runtime/facet-host.js';
import type { RunnerFactory } from '@nimbus-sh/core/runtime/installed-runtimes.js';
import type { RuntimePackage } from '@nimbus-sh/core/runtime/runtime-package.js';
import type { ShellExecuteFn } from '@nimbus-sh/core/substrate/lifo/commands/system/npm.js';
import type { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import type { CredentialedVfs } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type { CommandRegistry } from '@nimbus-sh/core/substrate/lifo/commands/registry.js';
import type { Command } from '@nimbus-sh/core/substrate/lifo/commands/types.js';
import * as v from 'valibot';
import type { ExecutorCapability } from '../execution/types';
import { WORKSPACE_ROOT } from './workspace-path';
import { KinuError, refusalOf, renderCauseChain, renderThrownChain, toKinuError, type Refusal } from '../obs/index';
import type { JsonValue } from '../utils/json';

/**
 * Turn a shell's exit-127 "command not found" into a refusal naming the real exits (sandbox, `nimbus install`).
 * `cataloged` is per call: installed runtimes re-register bins mid-session.
 */
export async function workspaceCommandNotFound(
  outcome: { stdout: string; stderr: string; exitCode: number; refusal?: Refusal },
  cataloged: (bin: string) => boolean | { readonly unreadable: KinuError } | Promise<boolean | { readonly unreadable: KinuError }>,
): Promise<typeof outcome> {
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

/**
 * Capabilities a workspace holding `runtimes` may declare; reads the same list that decides registration,
 * so the declaration cannot drift. `npm` is always registered.
 */
export function workspaceToolchainCapabilities(
  runtimes: readonly RuntimePackage[],
): readonly ExecutorCapability[] {
  const capabilities: ExecutorCapability[] = ['npm'];

  // `cpython` is the manifest name; `python` is the catalog name users type.
  if (runtimes.some((pkg) => pkg.manifest.name === 'cpython' || pkg.manifest.name === 'python')) {
    capabilities.push('python');
  }

  return capabilities;
}

/**
 * Loaded on first provisioning, not at module eval: the runner modules reach wasm assets, which would
 * otherwise enter every consumer's static import graph.
 */
interface RuntimeToolkit {
  readonly makeBashRunnerFactory: typeof import('@nimbus-sh/core/runtime/bash-runner.js')['makeBashRunnerFactory'];
  readonly makeCPythonRunnerFactory: typeof import('@nimbus-sh/core/runtime/cpython-runner.js')['makeCPythonRunnerFactory'];
  readonly rehydrateInstalledRuntimesView: typeof import('@nimbus-sh/core/runtime/installed-runtimes.js')['rehydrateInstalledRuntimesView'];
  readonly runtimeEntrypoints: typeof import('@nimbus-sh/core/runtime/installed-runtimes.js')['runtimeEntrypoints'];
  readonly seedRuntimePackage: typeof import('@nimbus-sh/core/runtime/runtime-package.js')['seedRuntimePackage'];
  readonly createNpmCommand: typeof import('@nimbus-sh/core/substrate/lifo/commands/system/npm.js')['createNpmCommand'];
  readonly createNpxCommand: typeof import('@nimbus-sh/core/substrate/lifo/commands/system/npm.js')['createNpxCommand'];
}

let toolkitOnce: Promise<RuntimeToolkit> | null = null;

const runtimeToolkit = (): Promise<RuntimeToolkit> => {
  toolkitOnce ??= (async () => {
    try {
      const [bash, cpython, installed, pkg, npm] = await Promise.all([
        import('@nimbus-sh/core/runtime/bash-runner.js'),
        import('@nimbus-sh/core/runtime/cpython-runner.js'),
        import('@nimbus-sh/core/runtime/installed-runtimes.js'),
        import('@nimbus-sh/core/runtime/runtime-package.js'),
        import('@nimbus-sh/core/substrate/lifo/commands/system/npm.js'),
      ]);

      return {
        makeBashRunnerFactory: bash.makeBashRunnerFactory,
        makeCPythonRunnerFactory: cpython.makeCPythonRunnerFactory,
        rehydrateInstalledRuntimesView: installed.rehydrateInstalledRuntimesView,
        runtimeEntrypoints: installed.runtimeEntrypoints,
        seedRuntimePackage: pkg.seedRuntimePackage,
        createNpmCommand: npm.createNpmCommand,
        createNpxCommand: npm.createNpxCommand,
      };
    } catch (error) {
      toolkitOnce = null;
      throw error;
    }
  })();

  return toolkitOnce;
};

export async function provisionWorkspaceRuntimes(deps: {
  workspace: NimbusWorkspace;
  runtimes: readonly RuntimePackage[];
  /**
   * Where a wasm interpreter runs; absent on workerd, which forbids the dynamic evaluation `localFacetHost` uses.
   * Absent means those runtimes register no bins, so the command stays "not found" rather than throwing.
   */
  facets?: FacetHost;
}): Promise<void> {
  const kit = await runtimeToolkit();
  const { workspace, runtimes } = deps;
  const registry = workspace.registry;
  const home = workspace.env.HOME ?? WORKSPACE_ROOT;
  const kernelFs = workspace.vfs.as(CRED_KERNEL);
  // Per workspace, not the substrate's process-global runner table: each factory closes over one filesystem.
  // Empty without a facet host, so wasm-runner manifests register no bins.
  const runnerDeps = deps.facets ? { facets: deps.facets, filesystem: workspace.filesystem } : null;

  const runners: Record<string, RunnerFactory> = runnerDeps
    ? {
      [BASH_RUNNER]: kit.makeBashRunnerFactory(runnerDeps),
      'cpython-runner': kit.makeCPythonRunnerFactory(runnerDeps),
    }
    : {};

  const runnerFor = (key: string): RunnerFactory | undefined => runners[key];

  const installed = await kit.rehydrateInstalledRuntimesView(kernelFs, registry, home, runnerFor);
  const alreadyRegistered = new Set(installed.bins);

  // Per-stream decoder so a multibyte character split across chunks lands whole.
  const shellExecute: ShellExecuteFn = async (command, ctx) => (await workspace.shell.execute(command, {
    cwd: ctx.cwd,
    env: ctx.env,
    onStdout: textSink((text) => ctx.stdout.write(text)),
    onStderr: textSink((text) => ctx.stderr.write(text)),
  })).exitCode;

  // Nothing is fetched until a subcommand runs.
  registry.register('npm', kit.createNpmCommand(registry, shellExecute, workspace.kernel));
  registry.register('npx', kit.createNpxCommand(registry, shellExecute));

  for (const runtimePackage of runtimes) {
    const install = provisionOnce({ kit, kernelFs, home, registry, runnerFor, runtimePackage });

    for (const entrypoint of kit.runtimeEntrypoints(runtimePackage.manifest)) {
      // Installed already, or a name the workspace answers for other reasons.
      if (alreadyRegistered.has(entrypoint.binName) || registry.has(entrypoint.binName)) continue;
      registry.register(entrypoint.binName, provisioningStub({
        binName: entrypoint.binName,
        registry,
        install,
        runtimeName: runtimePackage.manifest.name,
      }));
    }
  }
}

/**
 * Install `runtimePackage` at most once and re-register its entrypoints. Returns bins that became runnable;
 * a manifest whose runner cannot be built registers none.
 */
function provisionOnce(deps: {
  kit: RuntimeToolkit;
  kernelFs: CredentialedVfs;
  home: string;
  registry: CommandRegistry;
  runnerFor: (key: string) => RunnerFactory | undefined;
  runtimePackage: RuntimePackage;
}): () => Promise<readonly string[]> {
  let running: Promise<readonly string[]> | null = null;

  return () => {
    running ??= (async () => {
      try {
        await deps.kit.seedRuntimePackage(deps.kernelFs, deps.home, deps.runtimePackage);

        return (await deps.kit.rehydrateInstalledRuntimesView(deps.kernelFs, deps.registry, deps.home, deps.runnerFor)).bins;
      } catch (error) {
        // Clear the memo so a failed install is retried on the next invocation.
        running = null;
        throw new Error(`${deps.runtimePackage.manifest.name} runtime install failed`, { cause: error });
      }
    })();

    return running;
  };
}

/**
 * Install, then run. Re-resolves through the registry; a resolve that still returns this stub means no
 * runner was registered, which is reported instead of looping.
 */
function provisioningStub(deps: {
  binName: string;
  registry: CommandRegistry;
  install: () => Promise<readonly string[]>;
  runtimeName: string;
}): Command {
  const stub: Command = async (ctx) => {
    try {
      await deps.install();
    } catch (error) {
      await ctx.stderr.write(`${deps.binName}: installing the ${deps.runtimeName} runtime failed: `
        + `${renderThrownChain({ cause: error })}\n`);

      return 127;
    }

    const command = await deps.registry.resolve(deps.binName);

    if (!command || command === stub) {
      await ctx.stderr.write(`${deps.binName}: the ${deps.runtimeName} runtime installed but provides no `
        + `runnable ${deps.binName} in this workspace\n`);

      return 127;
    }

    return command(ctx);
  };

  return stub;
}
