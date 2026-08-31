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
 * The reach is HERE and nowhere else. When upstream exports these subpaths,
 * this file's import specifiers change and no other module notices.
 * cf-backend's unit tests already reach the same dist files the same way, and a
 * workerd fixture (tests/fixtures/nimbus-capability-websocket-worker.ts) proves
 * a real bundle resolves them.
 */

export {
  ensureProgrammaticReady,
  rpcEnsureRuntimes,
  rpcExec,
  rpcExposePort,
  rpcInstallRuntime,
  rpcKillProcess,
  rpcListPorts,
  rpcListProcesses,
  rpcListRuntimes,
  rpcProcessLogs,
  rpcRouteCapabilityPort,
  rpcRunCode,
  rpcStartProcess,
  rpcUnexposePort,
} from '../../../node_modules/@nimbus-sh/worker/dist/session/programmatic.js';
export type {
  ProgrammaticExecOptions,
  ProgrammaticHost,
} from '../../../node_modules/@nimbus-sh/worker/dist/session/programmatic.js';

/** The interactive session's fetch route for a capability-bearing port. Used
 *  for WebSocket previews only: `rpcRouteCapabilityPort` answers an upgrade
 *  with 409 because a 101 cannot cross a Durable Object RPC boundary, and this
 *  one keeps fetch semantics. */
export { routeCapabilityPort } from '../../../node_modules/@nimbus-sh/worker/dist/session/routes.js';

/** `git` over a Nimbus filesystem — isomorphic-git against SqliteVFS, with no
 *  child process and nothing reaching a host's git. Registered by the session
 *  worker's own `initSession` in Nimbus; registered by the workspace host here,
 *  because Kinu composes the workspace itself. */
export { registerGitCommands } from '../../../node_modules/@nimbus-sh/worker/dist/git/commands.js';
