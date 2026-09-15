/**
 * Nimbus's programmatic host over a workspace opened in plain bun — the
 * shape `createHostedWorkspace` composes in the Durable Object, held here
 * once so every suite that drives the session RPCs over a `NimbusWorkspace`
 * reads the same host.
 *
 * Two contexts, as production keeps them: the facet manager is composed over
 * a Durable-Object-shaped ctx (`id`, `storage`, `waitUntil`, `getWebSockets`),
 * while the host exposes the session's `ProgrammaticContext` shim over the
 * same durable map. Neither is cast into the other. The manager's hooks are
 * production's own diagnostics-backed functions; only the launch turn differs,
 * because a test file may not arm a timer — the pump runs on `waitUntil`
 * directly, and no suite here requests a launch.
 */

import type { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import { PortRegistry } from '@nimbus-sh/core/runtime/port-registry.js';
import { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import { composeFacetManager, type ComposedFacetManager } from '@nimbus-sh/worker/workspace-host';
import type { ProgrammaticHost } from '../../../../node_modules/@nimbus-sh/worker/dist/session/programmatic.js';
import { facetDiagnosticsHooks } from '../../src/nimbus-programmatic';

export type DurableState = Map<string, unknown>;

type DurableStorage = ProgrammaticHost['ctx']['storage'] & { sync(): Promise<void> };

/** The Durable Object storage verbs both contexts answer from one map. */
export function durableStorage(durable: DurableState): DurableStorage {
  const list = async <T,>(options: { prefix: string }): Promise<Map<string, T>> => {
    const entries = new Map<string, unknown>();

    for (const [key, value] of durable) {
      if (key.startsWith(options.prefix)) entries.set(key, value);
    }

    // SAFETY: the storage list contract types each row by the caller's T,
    // which the untyped stand-in rows cannot name; `never` keeps the Map
    // assignable to every T.
    return entries as Map<string, never>;
  };

  return {
    get: async (key) => durable.get(key),
    put: async (key, value) => { durable.set(key, value); },
    delete: async (key) => { durable.delete(key); },
    list,
    deleteAll: async () => { durable.clear(); },
    deleteAlarm: async () => undefined,
    transaction: async (body) => body({
      get: async (key) => durable.get(key),
      put: async (key, value) => { durable.set(key, value); },
      delete: async (key) => { durable.delete(key); },
      list,
    }),
    sync: async () => undefined,
  };
}

export interface TestProgrammaticHost {
  readonly host: ProgrammaticHost;
  readonly facetManager: ComposedFacetManager;
  readonly processes: SessionProcessSupervisor;
  readonly portRegistry: PortRegistry;
  readonly durable: DurableState;
}

export interface ProgrammaticHostSeams {
  /** The durable map both contexts read; shared across hosts to play a reconstructed isolate. */
  readonly durable?: DurableState;
  /** The supervisor the workspace was created over, when the suite holds one. */
  readonly processes?: SessionProcessSupervisor;
}

export function programmaticHostOver(workspace: NimbusWorkspace, seams: ProgrammaticHostSeams = {}): TestProgrammaticHost {
  const durable = seams.durable ?? new Map<string, unknown>();

  const managerCtx = {
    id: { toString: () => 'programmatic-host-test' },
    storage: durableStorage(durable),
    waitUntil: (promise: Promise<unknown>) => void promise,
    getWebSockets: () => [],
  };

  // Unchecked and named: `DurableObjectState` is a workerd type with no
  // constructible form; the factory reads `id`, `storage`, `waitUntil` and
  // `getWebSockets` — all present above — while `facets` is only touched by a
  // spawn no suite over this host performs.
  const doCtx: DurableObjectState = Object.create(managerCtx);

  const processes = seams.processes ?? new SessionProcessSupervisor();
  const portRegistry = new PortRegistry();

  const facetManager = composeFacetManager({
    ctx: doCtx,
    env: { LOADER: { load: () => ({}), get: () => ({}) } },
    processes,
    portRegistry,
    vfs: workspace.vfs,
    hooks: {
      ...facetDiagnosticsHooks(),
      requestLaunchTurn: () => { doCtx.waitUntil(facetManager.pumpLaunches()); },
    },
  });

  const host: ProgrammaticHost = {
    _w1SessionDestroyed: false,
    env: {},
    ctx: { storage: durableStorage(durable) },
    shell: workspace.shell,
    shellProcessPid: null,
    sqliteFs: workspace.vfs,
    processes,
    portRegistry,
    facetManager: facetManager.manager,
    facetManagerComposed: facetManager,
    viteDevServer: null,
    cirrusReal: null,
    _cpRegistry: workspace.registry,
    _viteShimPid: null,
    _viteShimPort: null,
    ensureSqliteFs: () => undefined,
    ensureFacetManager: () => facetManager,
    initSession: async () => { throw new Error('workspace is already composed'); },
  };

  return { host, facetManager, processes, portRegistry, durable };
}
