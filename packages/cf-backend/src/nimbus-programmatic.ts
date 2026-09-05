/**
 * The one reach into `@nimbus-sh/worker`'s session internals.
 *
 * Nimbus's programmatic surface — background processes, listening ports, the R2
 * runtime catalogue, capability-routed preview requests, `git` — is written
 * against a plain host object (`ProgrammaticHost`) rather than against the
 * session Durable Object that usually supplies one. That is exactly what lets
 * Kinu compose it over the workspace it already owns: the functions here run in
 * the actor's own isolate, against the actor's own `ctx.storage.sql`.
 *
 * WHY THE PATHS LOOK LIKE THIS. `@nimbus-sh/worker@0.4.0` publishes an
 * `exports` map that stops at `.`, `./router`, `./auth`, `./session-id`,
 * `./preview-host` and `./workspace`, so `@nimbus-sh/worker/session/programmatic`
 * does not resolve — a package-name import is a build error, not a subtlety.
 * The dist modules and their `.d.ts` files are real and shipped; reaching them
 * through the installed tree is the only way to hold them today.
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
import type * as programmaticModule from '../../../node_modules/@nimbus-sh/worker/dist/session/programmatic.js';
import type * as routesModule from '../../../node_modules/@nimbus-sh/worker/dist/session/routes.js';
import type * as gitModule from '../../../node_modules/@nimbus-sh/worker/dist/git/commands.js';

export type {
  ProgrammaticExecOptions,
  ProgrammaticHost,
} from '../../../node_modules/@nimbus-sh/worker/dist/session/programmatic.js';

type Programmatic = typeof programmaticModule;
type Routes = typeof routesModule;
type Git = typeof gitModule;

export interface NimbusProgrammatic {
  readonly ensureProgrammaticReady: Programmatic['ensureProgrammaticReady'];
  readonly rpcEnsureRuntimes: Programmatic['rpcEnsureRuntimes'];
  readonly rpcExec: Programmatic['rpcExec'];
  readonly rpcExposePort: Programmatic['rpcExposePort'];
  readonly rpcInstallRuntime: Programmatic['rpcInstallRuntime'];
  readonly rpcKillProcess: Programmatic['rpcKillProcess'];
  readonly rpcListPorts: Programmatic['rpcListPorts'];
  readonly rpcListProcesses: Programmatic['rpcListProcesses'];
  readonly rpcListRuntimes: Programmatic['rpcListRuntimes'];
  readonly rpcProcessLogs: Programmatic['rpcProcessLogs'];
  readonly rpcRouteCapabilityPort: Programmatic['rpcRouteCapabilityPort'];
  readonly rpcRunCode: Programmatic['rpcRunCode'];
  readonly rpcStartProcess: Programmatic['rpcStartProcess'];
  readonly rpcUnexposePort: Programmatic['rpcUnexposePort'];
  /** The interactive session's fetch route for a capability-bearing port. Used
   *  for WebSocket previews only: `rpcRouteCapabilityPort` answers an upgrade
   *  with 409 because a 101 cannot cross a Durable Object RPC boundary, and
   *  this one keeps fetch semantics. */
  readonly routeCapabilityPort: Routes['routeCapabilityPort'];
  /** `git` over a Nimbus filesystem — isomorphic-git against SqliteVFS, with no
   *  child process and nothing reaching a host's git. Registered by the
   *  workspace host here, because Kinu composes the workspace itself. */
  readonly registerGitCommands: Git['registerGitCommands'];
}

let loading: Promise<NimbusProgrammatic> | null = null;

export function nimbusProgrammatic(): Promise<NimbusProgrammatic> {
  loading ??= (async () => {
    const [programmatic, routes, git] = await Promise.all([
      import('../../../node_modules/@nimbus-sh/worker/dist/session/programmatic.js'),
      import('../../../node_modules/@nimbus-sh/worker/dist/session/routes.js'),
      import('../../../node_modules/@nimbus-sh/worker/dist/git/commands.js'),
    ]);
    return {
      ensureProgrammaticReady: programmatic.ensureProgrammaticReady,
      rpcEnsureRuntimes: programmatic.rpcEnsureRuntimes,
      rpcExec: programmatic.rpcExec,
      rpcExposePort: programmatic.rpcExposePort,
      rpcInstallRuntime: programmatic.rpcInstallRuntime,
      rpcKillProcess: programmatic.rpcKillProcess,
      rpcListPorts: programmatic.rpcListPorts,
      rpcListProcesses: programmatic.rpcListProcesses,
      rpcListRuntimes: programmatic.rpcListRuntimes,
      rpcProcessLogs: programmatic.rpcProcessLogs,
      rpcRouteCapabilityPort: programmatic.rpcRouteCapabilityPort,
      rpcRunCode: programmatic.rpcRunCode,
      rpcStartProcess: programmatic.rpcStartProcess,
      rpcUnexposePort: programmatic.rpcUnexposePort,
      routeCapabilityPort: routes.routeCapabilityPort,
      registerGitCommands: git.registerGitCommands,
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
