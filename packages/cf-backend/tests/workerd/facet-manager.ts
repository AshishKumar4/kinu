/**
 * The facet manager a slate probe composes over its own Durable Object, as `createHostedWorkspace` does.
 * A probe arms no timer, so the launch pump rides `waitUntil` directly.
 */
import type { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { SqliteFilesystemAuthority } from '@nimbus-sh/core/runtime/filesystem-authority.js';
import type { PortRegistry } from '@nimbus-sh/core/runtime/port-registry.js';
import type { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import { composeFacetManager, type ComposedFacetManager } from '@nimbus-sh/worker/workspace-host';

export interface ProbeFacetManagerDeps {
  readonly ctx: DurableObjectState;
  readonly env: unknown;
  readonly processes: SessionProcessSupervisor;
  readonly portRegistry: PortRegistry;
  readonly vfs: SqliteVFS;
}

export function probeFacetManager(deps: ProbeFacetManagerDeps): ComposedFacetManager {
  const composed: ComposedFacetManager = composeFacetManager({
    ...deps,
    // One authority per object: a second is a second set of descriptor scopes over the same rows.
    filesystem: new SqliteFilesystemAuthority(deps.vfs),
    hooks: {
      onExternalExit: () => undefined,
      onSpawn: () => undefined,
      notify: () => undefined,
      requestLaunchTurn: () => { deps.ctx.waitUntil(composed.pumpLaunches()); },
      // Journal answered as the hosted workspace does (null, row released): a probe re-drives nothing across a reset.
      resolveWorkerLaunch: () => Promise.resolve(null),
    },
  });

  return composed;
}

/** The reservation a durable spawn is pre-flighted against. */
export function probeDurableApps(composed: ComposedFacetManager) {
  return {
    ensure: async (input: { readonly owner: string; readonly preferredPort?: number }) => {
      const reserved = await composed.apps.ensureDurableApp({ owner: input.owner, preferredPort: input.preferredPort, visibility: 'scoped' });

      if (reserved.capability === null) throw new Error(`the manager reserved port ${String(reserved.port)} without a capability`);

      return { port: reserved.port, capability: reserved.capability };
    },
    remove: async (owner: string) => {
      const removed = await composed.apps.removeDurableApp(owner);

      return { removed: removed.removed, port: removed.port };
    },
  };
}
