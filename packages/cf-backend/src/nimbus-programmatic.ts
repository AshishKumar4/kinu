/**
 * The one reach into `@nimbus-sh/worker`'s session internals.
 *
 * Nimbus's programmatic surface — background processes, listening ports, the R2
 * runtime catalogue, capability-routed preview requests, durable applications,
 * `git` — is written against a plain host object (`ProgrammaticHost`) rather
 * than against the session Durable Object that usually supplies one. That is
 * exactly what lets Kinu compose it over the workspace it already owns: the
 * functions here run in the actor's own isolate, against the actor's own
 * `ctx.storage.sql`.
 *
 * WHERE THE SUBPATHS COME FROM. `@nimbus-sh/worker@0.7.0` publishes
 * `./workspace-host`, `./port-capability`, `./durable-slots` and `./git`
 * beside the router, auth, session-id and preview-host entries. The
 * programmatic RPC surface (`rpcExec`, `rpcStartProcess`, the runtime,
 * process and port verbs, `ProgrammaticHost`), the loader facet host and
 * the R2 runtime catalog are library-host needs the package does not yet
 * export, so `patches/@nimbus-sh%2Fworker@0.7.0.patch` adds `./programmatic`,
 * `./facet-host` and `./runtime-catalog` to its export map until upstream
 * ships them. A reach through the installed tree is refused by lint
 * (`no-restricted-imports`): a dependency is used through its export map or
 * the map is patched, never around. The `./workspace` entry names
 * `dist/workspace/nimbus-workspace.js`, a file the 0.7.0 tarball does not
 * carry; the workspace is `@nimbus-sh/core/workspace`.
 *
 * WHY THE VALUES LOAD LAZILY. These modules' static graphs carry isomorphic-git,
 * tarball handling and the substrate's wasm-adjacent machinery. Every consumer
 * already awaits the workspace host before calling any of them, so the import
 * belongs to that first await: module eval stays clean for the Worker's cold
 * start and for the workerd test pool's SSR loader, which cannot shim the CJS
 * and wasm assets the deep graph reaches.
 *
 * The reach is HERE and nowhere else. When upstream exports these subpaths,
 * this file's import specifiers change and no other module notices.
 */

import type { FabricComposition } from '@nimbus-sh/fabric/composition.js';
import type { FacetManagerHostHooks } from '@nimbus-sh/worker/workspace-host';
import { diagnostics } from '@kinu.run/core/obs';
import type * as programmaticModule from '@nimbus-sh/worker/programmatic';
import type * as gitModule from '@nimbus-sh/worker/git';

// The per-port reservation record is Nimbus-owned storage: the owner that holds
// a port, the capability its URL is built on, and its visibility. These reads
// and the owner-gated re-adoption stay usable on a cold route without
// importing the runtime graph.
export {
  listPortReservations,
  readPortExposure,
  readPortReservationByOwner,
  releasePortReservation,
} from '@nimbus-sh/worker/port-capability';

export type {
  ProgrammaticExecOptions,
  ProgrammaticHost,
} from '@nimbus-sh/worker/programmatic';

type Programmatic = typeof programmaticModule;

type Git = typeof gitModule;

export interface NimbusProgrammatic {
  readonly ensureProgrammaticReady: Programmatic['ensureProgrammaticReady'];
  readonly rpcEnsureDurableApp: Programmatic['rpcEnsureDurableApp'];
  readonly rpcEnsureRuntimes: Programmatic['rpcEnsureRuntimes'];
  readonly rpcExec: Programmatic['rpcExec'];
  readonly rpcExposePort: Programmatic['rpcExposePort'];
  readonly rpcInstallRuntime: Programmatic['rpcInstallRuntime'];
  readonly rpcKillProcess: Programmatic['rpcKillProcess'];
  readonly rpcListPorts: Programmatic['rpcListPorts'];
  readonly rpcListProcesses: Programmatic['rpcListProcesses'];
  readonly rpcListRuntimes: Programmatic['rpcListRuntimes'];
  readonly rpcProcessLogs: Programmatic['rpcProcessLogs'];
  readonly rpcRemoveDurableApp: Programmatic['rpcRemoveDurableApp'];
  readonly rpcRouteCapabilityPort: Programmatic['rpcRouteCapabilityPort'];
  readonly rpcRunCode: Programmatic['rpcRunCode'];
  readonly rpcStartProcess: Programmatic['rpcStartProcess'];
  readonly rpcUnexposePort: Programmatic['rpcUnexposePort'];
  /** `git` over a Nimbus filesystem — isomorphic-git against SqliteVFS, with no
   *  child process and nothing reaching a host's git. The session registers
   *  the command itself; the workspace host does the same here, because Kinu
   *  composes the workspace itself. */
  readonly runGitCommand: Git['runGitCommand'];
}

let loading: Promise<NimbusProgrammatic> | null = null;

export function nimbusProgrammatic(): Promise<NimbusProgrammatic> {
  loading ??= (async () => {
    const [programmatic, git] = await Promise.all([
      import('@nimbus-sh/worker/programmatic'),
      import('@nimbus-sh/worker/git'),
    ]);

    return {
      ensureProgrammaticReady: programmatic.ensureProgrammaticReady,
      rpcEnsureDurableApp: programmatic.rpcEnsureDurableApp,
      rpcEnsureRuntimes: programmatic.rpcEnsureRuntimes,
      rpcExec: programmatic.rpcExec,
      rpcExposePort: programmatic.rpcExposePort,
      rpcInstallRuntime: programmatic.rpcInstallRuntime,
      rpcKillProcess: programmatic.rpcKillProcess,
      rpcListPorts: programmatic.rpcListPorts,
      rpcListProcesses: programmatic.rpcListProcesses,
      rpcListRuntimes: programmatic.rpcListRuntimes,
      rpcProcessLogs: programmatic.rpcProcessLogs,
      rpcRemoveDurableApp: programmatic.rpcRemoveDurableApp,
      rpcRouteCapabilityPort: programmatic.rpcRouteCapabilityPort,
      rpcRunCode: programmatic.rpcRunCode,
      rpcStartProcess: programmatic.rpcStartProcess,
      rpcUnexposePort: programmatic.rpcUnexposePort,
      runGitCommand: git.runGitCommand,
    };
  })();

  return loading;
}

/**
 * The fabric every workspace this Worker hosts is composed with.
 *
 * A facet runs in its own isolate and reaches the object that owns the
 * filesystem through the supervisor entrypoint — and the entrypoint can only
 * mint that binding from `ctx.exports` against a composed name, and can only
 * reach the host through a composed namespace and method. Each half names
 * something Kinu already has: `SupervisorRPC` is re-exported from
 * `server.ts`, `OrchestratorAgent` is this deployment's own Durable Object
 * namespace binding, and `supervisorOp` is the one method the orchestrator
 * mounts for its facets. `NIMBUS_SESSION` is deliberately NOT named: the
 * class is gone (wrangler.jsonc migrations `v3`) and no binding carries that
 * name, so composing it would point every facet at a namespace that does not
 * exist. `hostDispatchMethod` repeats the default on purpose — a reader must
 * not have to know the default to see which method a facet lands on.
 */
export const HOST_FABRIC_COMPOSITION: FabricComposition = {
  supervisorEntrypoint: 'SupervisorRPC',
  hostNamespace: 'OrchestratorAgent',
  hostDispatchMethod: 'supervisorOp',
};

/**
 * What the facet manager tells its host, as this host hears it: an exit it
 * did not run, a spawn, a line meant for the user. A session shows these on
 * its terminal; a hosted workspace has none, so each lands as a diagnostics
 * event under a stable name. The one hook missing here, `requestLaunchTurn`,
 * is the host's own turn-granting primitive and is composed beside these.
 */
export function facetDiagnosticsHooks(): Pick<FacetManagerHostHooks, 'onExternalExit' | 'onSpawn' | 'notify'> {
  return {
    onExternalExit: (pid, code, reason) => {
      diagnostics.event('workspace.facet.external_exit', { pid, code, reason });
    },
    onSpawn: (pid, command) => {
      diagnostics.event('workspace.facet.spawn', { pid, command });
    },
    notify: (line) => {
      diagnostics.event('workspace.facet.notify', { line });
    },
  };
}
