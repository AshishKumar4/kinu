/**
 * The toolchain an embedded Nimbus workspace can reach, and the moment it
 * arrives.
 *
 * A bare `NimbusWorkspace` is the JavaScript half of Nimbus: the durable
 * filesystem, the shell, ~95 coreutils and `node`. `bash`, `python3`, `pip`
 * and `npm` are all "command not found" — not disabled, ABSENT, because the
 * workspace has been handed nothing that could run a wasm module and nothing
 * that speaks to a package registry.
 *
 * `npm` and `npx` are handed over unconditionally: they are JavaScript reaching
 * a registry over `fetch`. The wasm interpreters are handed over only where
 * something can actually run one — see `provisionWorkspaceRuntimes`' `facets`.
 * A deployed Worker has no such thing (workerd forbids the dynamic evaluation
 * `localFacetHost` performs, and the dynamic-worker substrate that replaces it
 * belongs to the Nimbus session Durable Object), so a hosted workspace has the
 * filesystem, the shell, the coreutils, `node`, `npm`, `npx` and `git` — and
 * says exactly that.
 *
 * WHERE THE BYTES COME FROM
 *
 * On Cloudflare, `nimbus install <name>` reads a runtime out of an R2 bucket
 * through a digest chain. Off Cloudflare there is no bucket and none is needed:
 * `@nimbus-sh/runtime-bash` and `@nimbus-sh/runtime-cpython` are npm packages
 * holding the same manifest and the same content-addressed blobs, and
 * `seedRuntimePackage` writes the same tree at the same path. Which publisher
 * ran is not observable afterwards. The packages are NOT imported here — they
 * read `node:fs` and weigh 40 MB, so the host that has a filesystem supplies
 * them and the Worker never sees them.
 *
 * WHEN IT ARRIVES
 *
 * On first use of the command, never at open. Measured by
 * `scripts/nimbus-runtime-probe.ts`: workspace open is 12ms with no runtimes
 * supplied and 14ms with both, the first `python3` costs 82ms because it is the
 * install, and every `python3` after it costs 0ms. The re-seed check itself is
 * 0.2ms, so the expense was never the check — it is the 35.7 MB of durable rows
 * CPython writes, and a workspace that never runs Python must not carry them. So
 * each bin name a supplied-but-uninstalled runtime declares gets a stub that
 * installs on the first invocation and hands the same call to the real command;
 * from then on the runtime is on disk and the stub is gone.
 *
 * A workspace reopened over a populated filesystem skips all of that: the
 * runtimes are already installed and only need re-registering, which is what
 * `rehydrateInstalledRuntimesView` does here. That path is not an optimisation
 * — a Durable Object that was evicted comes back with the filesystem and an
 * empty command registry, so without it an installed runtime is invisible.
 */

import { CRED_KERNEL } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { FacetHost } from '@nimbus-sh/core/runtime/facet-host.js';
import type { RunnerFactory } from '@nimbus-sh/core/runtime/installed-runtimes.js';
import type { RuntimePackage } from '@nimbus-sh/core/runtime/runtime-package.js';
import type { ShellExecuteFn } from '@nimbus-sh/core/substrate/lifo/commands/system/npm.js';
import type { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import type { CredentialedVfs } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type { CommandRegistry } from '@nimbus-sh/core/substrate/lifo/commands/registry.js';
import type { Command } from '@nimbus-sh/core/substrate/lifo/commands/types.js';
import type { ExecutorCapability } from '../execution/types';
import { WORKSPACE_ROOT } from './workspace-path';
import { renderThrownChain } from '../obs/index';

/**
 * The capability names a workspace holding `runtimes` may honestly declare.
 *
 * Beside {@link provisionWorkspaceRuntimes} because it reads the same argument:
 * the list that decides which commands get registered is the list that decides
 * what the model is told, so the declaration cannot drift from the registry. A
 * host that supplies nothing declares nothing extra — the coreutils, `node` and
 * the shell are the bare workspace's own and are declared by the executor.
 *
 * `npm` needs no runtime package: Nimbus's own npm client is registered
 * unconditionally, because it is JavaScript reaching a registry over `fetch`.
 * `bash` maps to no capability of its own; the vocabulary already says `shell`,
 * and it was never a lie — the workspace has always had one.
 */
export function workspaceToolchainCapabilities(
  runtimes: readonly RuntimePackage[],
): readonly ExecutorCapability[] {
  const capabilities: ExecutorCapability[] = ['npm'];
  // `python` is the catalog name users type; `cpython` is the wasm32-wasi
  // interpreter that supersedes it and the name its manifest carries.
  if (runtimes.some((pkg) => pkg.manifest.name === 'cpython' || pkg.manifest.name === 'python')) {
    capabilities.push('python');
  }
  return capabilities;
}

/**
 * Give `workspace` the runtimes in `runtimes` on demand, and npm/npx now.
 *
 * Called once per workspace, after `NimbusWorkspace.create` and before the
 * first command runs. Idempotent registrations only — no bytes are written
 * unless a provisioned command is actually invoked.
 */
/**
 * The runner and package machinery, loaded on first provisioning rather than at
 * module eval: the bash and cpython runner modules statically reach wasm
 * assets, and the npm command sits in the same substrate graph. Evaluating them
 * with the module would put a WebAssembly import into every consumer's static
 * graph — the Worker's cold start and the workerd test pool alike — for
 * machinery only a BOOTING workspace uses.
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
  })();
  return toolkitOnce;
};

export async function provisionWorkspaceRuntimes(deps: {
  workspace: NimbusWorkspace;
  runtimes: readonly RuntimePackage[];
  /**
   * Where a wasm interpreter would run, or absent because nothing here can run
   * one.
   *
   * Absent is workerd. `localFacetHost` builds a facet's scope with
   * `new AsyncFunction(preamble)` — dynamic evaluation, which the Workers
   * runtime forbids outright — so a deployed Worker that registered
   * bash/cpython runners anyway would answer `python3` with an eval error
   * instead of "command not found", and would first have written 35.7 MB of
   * interpreter rows to get there. A registry entry that cannot run is worse
   * than an absent one: `provisioningStub` says so itself.
   */
  facets?: FacetHost;
}): Promise<void> {
  const kit = await runtimeToolkit();
  const { workspace, runtimes } = deps;
  const registry = workspace.registry;
  const home = workspace.env.HOME ?? WORKSPACE_ROOT;
  const kernelFs = workspace.vfs.as(CRED_KERNEL);
  // The runner each manifest entrypoint can name, over THIS workspace. Held per
  // workspace rather than in the substrate's process-global runner table because
  // every factory closes over one filesystem and one facet host: a second
  // workspace in the same process would otherwise retarget the first one's bash.
  //
  // Empty when no facet host was supplied, which is not a degraded table but the
  // honest one: a manifest naming `cpython-runner` on a host that cannot run wasm
  // resolves to nothing, `rehydrateInstalledRuntimesView` registers no bin for
  // it, and `python3` stays "command not found" instead of becoming a command
  // that throws.
  const runnerDeps = deps.facets ? { facets: deps.facets, vfs: workspace.vfs } : null;
  const runners: Record<string, RunnerFactory> = runnerDeps
    ? {
      'bash-runner': kit.makeBashRunnerFactory(runnerDeps),
      'cpython-runner': kit.makeCPythonRunnerFactory(runnerDeps),
    }
    : {};
  const runnerFor = (key: string): RunnerFactory | undefined => runners[key];

  const installed = kit.rehydrateInstalledRuntimesView(kernelFs, registry, home, runnerFor);
  const alreadyRegistered = new Set(installed.bins);

  const shellExecute: ShellExecuteFn = async (command, ctx) => (await workspace.shell.execute(command, {
    cwd: ctx.cwd,
    env: ctx.env,
    onStdout: (data) => ctx.stdout.write(data),
    onStderr: (data) => ctx.stderr.write(data),
  })).exitCode;
  // Nimbus's own npm: it resolves against registry.npmjs.org, extracts tarballs
  // into this filesystem and registers each package's bins as commands. Free to
  // register — nothing is fetched until a subcommand runs.
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
 * Install `runtimePackage` at most once, however many of its commands are
 * invoked concurrently, and re-register its entrypoints when it lands.
 *
 * Returns the bin names that became invokable, which is the difference between
 * "installed" and "runnable": a manifest whose runner this workspace cannot
 * build writes its files and registers nothing.
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
        return deps.kit.rehydrateInstalledRuntimesView(deps.kernelFs, deps.registry, deps.home, deps.runnerFor).bins;
      } catch (error) {
        // A failed install must not become a permanently poisoned command: clear
        // the memo so the next invocation tries again, and re-raise with the
        // cause for the caller already waiting on this one.
        running = null;
        throw new Error(`${deps.runtimePackage.manifest.name} runtime install failed`, { cause: error });
      }
    })();
    return running;
  };
}

/**
 * The command a not-yet-installed runtime answers with: install, then run.
 *
 * Re-resolving through the registry rather than calling a captured handler is
 * what keeps this honest — the install re-registers the real command under this
 * same name, so a resolve that still returns this stub means the runtime landed
 * on disk with nothing able to run it, and that is reported instead of looping.
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
      ctx.stderr.write(`${deps.binName}: installing the ${deps.runtimeName} runtime failed: `
        + `${renderThrownChain({ cause: error })}\n`);
      return 127;
    }
    const command = await deps.registry.resolve(deps.binName);
    if (!command || command === stub) {
      ctx.stderr.write(`${deps.binName}: the ${deps.runtimeName} runtime installed but provides no `
        + `runnable ${deps.binName} in this workspace\n`);
      return 127;
    }
    return command(ctx);
  };
  return stub;
}
