/**
 * The toolchain an embedded Nimbus workspace can reach, and the moment it
 * arrives.
 *
 * A bare `NimbusWorkspace` is the JavaScript half of Nimbus: the durable
 * filesystem, the shell, ~95 coreutils and `node`. `bash`, `python3`, `pip`
 * and `npm` are all "command not found" — not disabled, ABSENT, because the
 * workspace has been handed nothing that could run a wasm module and nothing
 * that speaks to a package registry. This module hands it both.
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
import { localFacetHost } from '@nimbus-sh/core/runtime/local-facet-host.js';
import { makeBashRunnerFactory } from '@nimbus-sh/core/runtime/bash-runner.js';
import { makeCPythonRunnerFactory } from '@nimbus-sh/core/runtime/cpython-runner.js';
import {
  rehydrateInstalledRuntimesView,
  runtimeEntrypoints,
  type RunnerFactory,
} from '@nimbus-sh/core/runtime/installed-runtimes.js';
import { seedRuntimePackage, type RuntimePackage } from '@nimbus-sh/core/runtime/runtime-package.js';
import {
  createNpmCommand,
  createNpxCommand,
  type ShellExecuteFn,
} from '@nimbus-sh/core/substrate/lifo/commands/system/npm.js';
import type { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import type { CredentialedVfs } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type { CommandRegistry } from '@nimbus-sh/core/substrate/lifo/commands/registry.js';
import type { Command } from '@nimbus-sh/core/substrate/lifo/commands/types.js';
import type { ExecutorCapability } from '../execution/types';
import { WORKSPACE_ROOT } from './workspace-path';

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
export function provisionWorkspaceRuntimes(deps: {
  workspace: NimbusWorkspace;
  runtimes: readonly RuntimePackage[];
}): void {
  const { workspace, runtimes } = deps;
  const registry = workspace.registry;
  const home = workspace.env.HOME ?? WORKSPACE_ROOT;
  const kernelFs = workspace.vfs.as(CRED_KERNEL);
  // The runner each manifest entrypoint can name, over THIS workspace. Held per
  // workspace rather than in the substrate's process-global runner table because
  // every factory closes over one filesystem and one facet host: a second
  // workspace in the same process would otherwise retarget the first one's bash.
  //
  // A Map because the lookups are dynamic even though the keys are not — the key
  // is a `runner` field out of a manifest, so an unknown one must come back
  // undefined rather than needing an assertion to ask.
  const runnerDeps = { facets: localFacetHost(), vfs: workspace.vfs };
  const runners = new Map<string, RunnerFactory>([
    ['bash-runner', makeBashRunnerFactory(runnerDeps)],
    ['cpython-runner', makeCPythonRunnerFactory(runnerDeps)],
  ]);
  const runnerFor = (key: string): RunnerFactory | undefined => runners.get(key);

  const installed = rehydrateInstalledRuntimesView(kernelFs, registry, home, runnerFor);
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
  registry.register('npm', createNpmCommand(registry, shellExecute, workspace.kernel));
  registry.register('npx', createNpxCommand(registry, shellExecute));

  for (const runtimePackage of runtimes) {
    const install = provisionOnce({ kernelFs, home, registry, runnerFor, runtimePackage });
    for (const entrypoint of runtimeEntrypoints(runtimePackage.manifest)) {
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
        await seedRuntimePackage(deps.kernelFs, deps.home, deps.runtimePackage);
        return rehydrateInstalledRuntimesView(deps.kernelFs, deps.registry, deps.home, deps.runnerFor).bins;
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
        + `${error instanceof Error ? error.message : String(error)}\n`);
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
