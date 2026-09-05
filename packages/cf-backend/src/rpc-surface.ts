/**
 * The Durable Object RPC boundary — what a stub-holder can actually reach.
 *
 * Cloudflare resolves `stub.foo(...)` by looking `foo` up on the receiver's
 * PROTOTYPE CHAIN — `rpc.prototype_chain` in the platform catalog. Three
 * consequences, each verified against real workerd (1.20260601.1, via
 * miniflare, one DO calling another):
 *
 *   1. TypeScript `private` is erased at compile time, so a `private` method is
 *      an ordinary prototype method and IS callable over RPC. Every
 *      `requireTier` check in `user/workspace-capability.ts` sits at the top of
 *      a public method; a stub-holder that calls `sqlx` or `readCredential`
 *      instead never reaches one.
 *   2. SUPERCLASS methods are reachable too — the walk does not stop at the
 *      most-derived class. `Agent.sql` from the agents SDK is a tagged-template
 *      query runner over `ctx.storage.sql`, so a single inherited method hands
 *      any stub-holder arbitrary SQL against the receiver's storage. `Agent` +
 *      `Server` alone contribute 267 reachable names; `Think` adds 245 more.
 *   3. OWN INSTANCE properties are NOT reachable. workerd rejects them with
 *      `The RPC receiver does not implement the method "x".`, exactly as it
 *      rejects a name that does not exist — including when the own property
 *      shadows a prototype method of the same name.
 *
 * (3) is the primitive this module is built on. `sealRpcSurface` copies every
 * reachable member that is NOT on a class's declared surface down onto the
 * instance as a non-enumerable own property. In-process behaviour is
 * unchanged — `this.sqlx(...)` finds the same function object, `super.x()`
 * still reaches the prototype, base-class code that calls `this.sql\`…\`` still
 * works, and `@callable` metadata (a WeakMap keyed on function identity)
 * still matches. From outside, the name has ceased to exist.
 *
 * Why not the alternatives:
 *   • `#`-private members are genuinely unreachable, but they cannot express a
 *     `protected` member a subclass needs (`ActorAgent` → `OrchestratorAgent` /
 *     `SubordinateAgent`), and they cannot touch the inherited SDK surface at
 *     all — which is where `sql` lives. They fix the smaller half of the hole.
 *   • A narrow RpcTarget facade only helps if callers hold the facade instead
 *     of the stub. Inside one Worker every Durable Object can call
 *     `env.UserDO.get(...)` itself, so the raw stub can never be taken away.
 *   • An allowlist at the dispatch boundary is what `cli/rpc-gate.ts` does for
 *     the WebSocket transport, because the agents SDK routes those frames
 *     through `onMessage` and there is a place to stand. Native Workers RPC has
 *     no such hook: resolution happens inside the runtime, before any Kinu
 *     code runs. The allowlist survives — it is the `surface` argument here —
 *     but enforcement has to be reachability, not interception.
 *
 * Fail-closed by construction: the surface is an allowlist, so a member added
 * to a sealed class tomorrow is unreachable until someone puts its name here,
 * and a name that is not reachable at all is denied by the runtime anyway. The
 * corollary is that adopting an SDK feature whose protocol runs over a stub
 * means adding its names — the agents SDK's agent-tool adapter
 * (`startAgentToolRun` and friends), which Kinu does not use, is the one
 * such feature deliberately left off every surface.
 */

import { AGENT_RPC_ACCESS } from './cli/rpc-gate';
import type { ActorAgent } from './actor-agent';
import type { OrchestratorAgent } from './orchestrator';
import type { SubordinateAgent } from './subordinate-agent';
import type { UserDO } from './user/user-do';

/**
 * The names the Workers runtime and the two SDKs dispatch on a stub, which
 * therefore have to stay reachable on every sealed class.
 *
 *   • `fetch` — the agents/partyserver transport. Every browser and CLI
 *     WebSocket, and every HTTP call to `/agents/*`, arrives this way.
 *   • `setName` — `getServerByName` calls it on the stub before returning it,
 *     so denying it breaks every `getAgentByName`.
 *   • `_initAndFetch` — partyserver's combined entry point. It is exactly
 *     `setName` followed by `fetch`, both already reachable, so listing it
 *     costs nothing it did not already have.
 *   • `alarm` / `webSocket*` — handlers the runtime itself invokes on the
 *     instance. Denying them would risk the DO's own lifecycle for no gain:
 *     their arguments (a live WebSocket) cannot cross an RPC boundary.
 */
const PLATFORM_RPC_SURFACE: readonly string[] = [
  'fetch',
  'setName',
  '_initAndFetch',
  'alarm',
  'webSocketMessage',
  'webSocketClose',
  'webSocketError',
] as const;

/**
 * The agents-SDK facet protocol: the `_cf_`-prefixed methods the SDK invokes on
 * a stub rather than on `this`. Facets (`SubordinateAgent` in every mode) live
 * on their parent DO, and every hop between a facet and its root crosses a
 * real RPC boundary (`_rootAlarmOwner()` resolves the root through
 * `getServerByName`), so sealing these would break sub-agents,
 * facet schedules, and sub-agent WebSocket bridging. Only the agent family
 * needs them; `UserDO` neither is a facet nor spawns one.
 *
 * Derived by reading `agents/dist/index.js` for `_cf_` calls whose receiver is
 * not `this`, so it is the SDK's actual cross-stub surface and not a prefix
 * rule. Three universal bridges are deliberately absent —
 * `_cf_invokeSubAgent`, `_cf_invokeSubAgentPath` and `_cf_invokeStubMethod`
 * take a method NAME and call it on the receiver, which would re-open
 * everything this module closes. They are only used by `getSubAgentByName` and
 * by `parentAgent()` from a facet nested two deep; Kinu uses neither.
 */
const AGENTS_FACET_RPC_SURFACE: readonly string[] = [
  '_cf_acquireFacetKeepAlive',
  '_cf_broadcastToSubAgent',
  '_cf_cancelScheduleForFacet',
  '_cf_checkRunFibersForFacet',
  '_cf_cleanupFacetPrefix',
  '_cf_closeSubAgentConnection',
  '_cf_destroyDescendantFacet',
  '_cf_dispatchScheduledCallback',
  '_cf_getScheduleForFacet',
  '_cf_handleSubAgentWebSocketClose',
  '_cf_handleSubAgentWebSocketConnect',
  '_cf_handleSubAgentWebSocketMessage',
  '_cf_initAsFacet',
  '_cf_listSchedulesForFacet',
  '_cf_registerFacetRun',
  '_cf_releaseFacetKeepAlive',
  '_cf_scheduleEveryForFacet',
  '_cf_scheduleForFacet',
  '_cf_sendToSubAgentConnection',
  '_cf_setSubAgentConnectionState',
  '_cf_subAgentConnectionMetas',
  '_cf_unregisterFacetRun',
] as const;

/**
 * The names Cloudflare will resolve on a stub for `target` — every member on
 * the prototype chain below `Object.prototype`, minus anything an own instance
 * property shadows. This is the rule workerd implements, and `sealRpcSurface`
 * works from it. The suite states the same rule on its own side
 * (unit-rpc-surface.test.ts). The mechanism tests pin the two against each
 * other. A change here that the model does not share goes red there.
 */
function rpcReachableNames<Target extends object>(target: Target): string[] {
  const own = new Set(Object.getOwnPropertyNames(target));
  const reachable = new Set<string>();
  for (let proto: object | null = Object.getPrototypeOf(target);
       proto !== null && proto !== Object.prototype;
       proto = Object.getPrototypeOf(proto)) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name !== 'constructor' && !own.has(name)) reachable.add(name);
    }
  }
  return [...reachable].sort();
}

/**
 * Reduce `instance`'s RPC-reachable surface to `surface`, in place. Call it as
 * the last statement of a Durable Object's constructor, once the whole
 * prototype chain — including the wrappers the agents SDK installs during
 * `super()` — is in its final shape.
 *
 * Every other reachable member is copied onto the instance descriptor-for-
 * descriptor (accessors stay accessors, function identity is preserved), which
 * leaves in-process calls untouched and makes the name unresolvable from a
 * stub. Names in `surface` that the class does not have are ignored: a surface
 * is a ceiling, and the runtime already denies what does not exist.
 */
export function sealRpcSurface<Instance extends object>(instance: Instance, surface: readonly string[]): void {
  const allowed = new Set(surface);
  for (const name of rpcReachableNames(instance)) {
    if (allowed.has(name)) continue;
    const descriptor = inheritedDescriptor(instance, name);
    if (descriptor) Object.defineProperty(instance, name, { ...descriptor, enumerable: false });
  }
}

/** The descriptor the prototype chain resolves `name` to. */
function inheritedDescriptor<Instance extends object>(instance: Instance, name: string): PropertyDescriptor | undefined {
  for (let proto: object | null = Object.getPrototypeOf(instance);
       proto !== null && proto !== Object.prototype;
       proto = Object.getPrototypeOf(proto)) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    if (descriptor) return descriptor;
  }
  return undefined;
}

// ── The surfaces ────────────────────────────────────────────────────────────
// One table per Durable Object class, kept together so "what can be reached in
// this Worker" is answerable by reading one file — the same reason
// `cli/rpc-gate.ts` keeps the CLI's transport policy in one table. The class
// types are imported for types only, exactly as `cli/rpc-gate.ts` imports
// `OrchestratorAgent`, so nothing here pulls a Durable Object into the graph.
//
// `satisfies readonly (keyof X)[]` on each list is the compile-time half of the
// guard: a name that is not a member, or that is `private`/`protected`, is not
// in `keyof X` and fails the build here rather than at runtime.

/**
 * Everything a holder of a `UserDO` stub may call — the RPC counterpart of the
 * `requireTier` gate. Each entry is a method that takes a `UserCaller` and gates
 * itself (plus the identity bootstrap and the platform handlers), so the two
 * lists are the same list: a name here is a name the gate has already vetted.
 *
 * Nothing else on this class or anywhere in its inheritance chain is reachable
 * from a stub — not `sqlx`, not `readCredential`, and not the SDK's inherited
 * `sql`, which would otherwise hand any Durable Object in this Worker arbitrary
 * queries against the credential store.
 *
 * `UserDO` gets no facet surface: it is neither a facet nor spawns one.
 */
const USER_DO_METHODS = [
  'createReleaseChange',
  'decideReleaseApproval',
  'deleteCredential',
  'deviceRpc',
  'deviceRuntimeStatus',
  'disconnectCodex',
  'ensureProfile',
  'ensureWorkspaceCapability',
  'getAuthHeaders',
  'getCodexStatus',
  'getConfig',
  'getCredentialBaseURL',
  'getDeviceFileView',
  'getWorkspaceTitle',
  'getExperienceEntry',
  'getReleaseBoard',
  'getReleaseDetail',
  'getProfile',
  'getProfileCatalog',
  'getWorkspaceProfileCatalog',
  'hasPeerGrant',
  'hasWorkspace',
  'issueCliAgentConnectTicket',
  'issueDeviceConnectTicket',
  'listAIGateways',
  'listAccessTokens',
  'listActiveWorkspaces',
  'listCliTokens',
  'listCloudflareAccounts',
  'listConfig',
  'listConnectedProviders',
  'listCredentials',
  'listDeviceConsents',
  'listDevices',
  'listEgressSecrets',
  'listWorkspaces',
  'mintAccessToken',
  'mintCliToken',
  'openDeviceTerminal',
  'pollCodexDeviceFlow',
  'publishExperience',
  'publishWorkspaceReservation',
  'putEgressSecret',
  'putProfileCatalog',
  'recordReleaseCheck',
  'recordReleaseDeployment',
  'registerBrowserSession',
  'registerDevice',
  'registerWorkspace',
  'releaseWorkspaceReservation',
  'removeWorkspace',
  'renameDevice',
  'renewWorkspaceReservation',
  'reserveWorkspace',
  'requestReleaseApproval',
  'resolveEgressInjection',
  'revokeAccessToken',
  'revokeBrowserSession',
  'revokeCliTokenHash',
  'revokeDevice',
  'acknowledgeDeviceRequest',
  'acknowledgeUnstoppedDevice',
  'cancelDeviceRequestsForBackgroundJob',
  'cancelDeviceRequestsForTurn',
  'revokeDeviceConsent',
  'revokeEgressSecret',
  'searchExperience',
  'selectAIGateway',
  'selectCloudflareAccount',
  'setConfig',
  'setCredential',
  'setDeviceTier',
  'setWorkspaceDisplayName',
  'startCodexDeviceFlow',
  'touchWorkspace',
  'transitionReleaseChange',
  'updateReleaseChange',
  'upsertReleaseSource',
  'transferDeviceRequestToBackgroundJob',
  'userMcp_add',
  'userMcp_callTool',
  'userMcp_handleOAuthCallback',
  'userMcp_list',
  'userMcp_remove',
  'userMcp_toolDescriptors',
  'userMcp_update',
  'userMcp_warmConnections',
  'verifyAccessToken',
  'verifyBrowserSession',
  'verifyCliAgentConnectTicket',
  'verifyCliToken',
  'verifyDeviceConnectTicket',
  'verifyDeviceToken',
  'verifyCliSocketBearer',
  'verifySocketSession',
  'revokeAllCliTokens',
  'getCredentialsRevision',
] as const satisfies readonly (keyof UserDO)[];

/** A method name on the UserDO surface above, for typing a stub of it. */
export type UserDoRpcMethod = (typeof USER_DO_METHODS)[number];

export const USER_DO_RPC_SURFACE: readonly string[] = [...PLATFORM_RPC_SURFACE, ...USER_DO_METHODS];

/**
 * The members every actor exposes to a stub-holder — the workspace-capability
 * handshake, the credential-change fan-out, the workspace filesystem a forked
 * facet (a subordinate, or a head) reaches on its parent, and the mission
 * ledger that facet charges. Concrete actors add their own on top.
 *
 * `missionGuard`/`missionDebit` are here rather than on the public transport
 * for the same reason `rawCopyFromFork` is: they are how a facet reaches the
 * actor that declared a budget, and nothing else should be able to move a
 * spend ledger. They are inert without labels either way — both return
 * immediately on an empty label set, so reaching them cannot create a cap.
 *
 * The four `headJournal*` names are the same shape and the same reason: a
 * recursive split writes the WHOLE subtree's journal to the run's root, so an
 * intermediate facet reaches them on its parent stub. They were declared on
 * `ActorAgent` and left off this list, and the seal is fail-closed — so every
 * one of those calls rejected with "does not implement the method", which is
 * the same silence a depth-2 head had before the routing was fixed at all.
 *
 * `getSubordinateBootstrapIdentity` and `receiveSubordinateEvent` are here for
 * exactly that reason and moved here from ORCHESTRATOR_METHODS when `hire`
 * became recursive: a subordinate tree makes an intermediate SUBORDINATE the
 * parent that seeds a child and admits its reports, so both names are reached on
 * a parent stub that is not the orchestrator's. Leaving them on the
 * orchestrator-only list would have failed closed at depth 2 — a nested hire
 * whose seeding call rejects, and reports that reach nobody.
 *
 * Everything else this class declares — including every `protected` member a
 * subclass relies on — stays an ordinary method and stays unreachable, because
 * the seal shadows rather than removes.
 */
const ACTOR_AGENT_RPC_SURFACE = [
  'deleteWorkspaceFile',
  // The owner's UserDO closes this workspace's CLI websockets the moment it
  'closeRevokedCliSockets',
  'closeRevokedSessionSockets',
  // The owner's UserDO asks a workspace root to re-push its capability token
  // down the subtree when a reconciliation intent says an earlier push missed
  // a replica — the idempotent retry that heals the stranding.
  'repushWorkspaceCapability',
  'getSubordinateBootstrapIdentity',
  'headJournalCacheMerge',
  'headJournalInsertSpawn',
  'headJournalRecordReport',
  'headJournalRecordSplit',
  // The container's own Durable Object asks the workspace root whether work it
  // could disturb is still live, and a root asks the same of each subordinate
  // in its subtree — a subordinate rides its PARENT's container, so both
  // directions of the tree are reached on a stub.
  'hasSandboxBackgroundWork',
  'installWorkspaceCapability',
  'getWorkspaceInstructionApprovals',
  'listWorkspaceFiles',
  'missionDebit',
  'missionGuard',
  'nodeArbitrate',
  'onCredentialsChanged',
  'readWorkspaceFile',
  'receiveSubordinateEvent',
  // A child titling itself reaches its parent's roster the same way its
  // reports do — parent-side, both directions of a nested tree.
  'recordSubordinateTitle',
  'reportFacetModelCall',
  'reportFacetModelOperation',
  'statWorkspaceFile',
  'writeWorkspaceFile',
] as const satisfies readonly (keyof ActorAgent)[];

/**
 * What a holder of an `OrchestratorAgent` stub may call, beyond the shared
 * actor and infrastructure surfaces.
 *
 * `AGENT_RPC_ACCESS` supplies the larger half: the CLI's HTTP transport
 * dispatches those names straight onto this stub, so they are reachable by
 * construction and that table is their single source of truth. Its `never`
 * entry (`destroyAgent`) stays here too — it is denied to remote CLI clients by
 * `cli/routes.ts`, but the owner's UserDO calls it Durable-Object-to-Durable-
 * Object when a workspace is deleted.
 *
 * The names below are the rest: the worker routes (email, webhooks, runs, MCP),
 * the UserDO handshake, and the calls siblings make — a subordinate or a head
 * reaching its parent workspace, one workspace delivering a peer message or a
 * fork copy to another.
 */
const ORCHESTRATOR_METHODS = [
  'abortExecutorFileDownload',
  'abortExecutorFileWrite',
  'acceptContainerEvent',
  'acceptEmailDelivery',
  'acceptSandboxLifecycleFailure',
  'acceptWebhookDelivery',
  'authorizeEmailSender',
  'awaitDeviceConsent',
  'beginGenesisTurn',
  'claimOwner',
  'createDurableWebhook',
  'facetTurnProfile',
  'getEmailIngress',
  'getRunEvents',
  'getRunEventsWire',
  'getShadowStatus',
  'getToolList',
  'getWorkspaceCapabilityHash',
  'listPeersFromMcp',
  'listRecentEventsWire',
  'listTriggersWire',
  'listRuns',
  'openDeviceTerminal',
  'prepareTerminal',
  'publishHeadStream',
  'rawCopyFromFork',
  'readExecutorFileChunk',
  'receivePeerMessage',
  'recordHeadStep',
  'runScaffoldOnceWire',
  'runTaskFromMcp',
  'saveNoteFromMcp',
  'sendPeerFromMcp',
  'setAutoDisplayName',
  'setEmailAllowlist',
  'setEmailNotifications',
  'setInitialDisplayName',
  'startExecutorFileDownload',
  'transitionReleaseChange',
  'writeExecutorFileChunk',
  // The workspace's byte plane, for the facets that share it. Here rather than
  // on the public transport for the same reason `rawCopyFromFork` is: these are
  // how a facet reaches the object that owns the filesystem, and
  // `NimbusExecOptions.cred` names a uid — a browser socket that could reach
  // `workspaceBoxOp` could run a command as uid 0. `routeWorkspacePreview` is
  // reached only by the preview edge, which has already verified the hostname's
  // signature, and re-checks the capability handle inside the object.
  'routeWorkspacePreview',
  'workspaceBoxOp',
  // A facet's home, on the same byte plane and for the same reason: the
  // answer carries the credential the session runs the facet's commands as,
  // and the registry it is provisioned in exists only on this object.
  'provisionFacetHome',
  'releaseFacetHome',
  // A gadget server's binding calls, back from its isolate through the
  // loopback entrypoints (gadgets/bindings.ts). Stub transport only: a
  // browser socket that could name a binding could reach the owner's MCP
  // connections as a gadget, and the gate inside decides per manifest.
  'gadgetBindingCall',
  // The one method the supervisor entrypoint calls on the object that owns a
  // workspace: a facet's filesystem calls arrive here through the composed
  // `OrchestratorAgent` namespace. Listed (not sealed away) but never
  // `@callable`, exactly like `workspaceBoxOp` — reachable by a Durable
  // Object stub in this Worker, unreachable from the browser or CLI.
  'supervisorOp',
  // A subagent asks its workspace what it is called: its prompt names the
  // workspace it works in, and it holds only the slug.
  'workspaceTitle',
] as const satisfies readonly (keyof OrchestratorAgent)[];

export const ORCHESTRATOR_RPC_SURFACE: readonly string[] = [
  ...PLATFORM_RPC_SURFACE,
  ...AGENTS_FACET_RPC_SURFACE,
  ...ACTOR_AGENT_RPC_SURFACE,
  ...Object.keys(AGENT_RPC_ACCESS),
  ...ORCHESTRATOR_METHODS,
];

/**
 * What the parent orchestrator may call on a subordinate facet. A subordinate
 * carries its parent's capability token, so its reachable surface is kept to
 * the calls the parent actually makes; its chat surface arrives over the SDK's
 * sub-agent WebSocket bridge and is dispatched on `this`, not on a stub.
 *
 * The parent half of a nested tree — seeding a child, admitting its reports — is
 * on ACTOR_AGENT_RPC_SURFACE, because a subordinate is now on both sides of that
 * relationship.
 */
const SUBORDINATE_METHODS = [
  'decidePlanReview',
  'enqueueSubordinateTask',
  'getActivePlanReview',
  'getSubordinateSnapshot',
  'getSubordinateStatus',
  'setSubordinateIdentity',
  'savePlanReviewAnnotations',
  'setSubordinateNaming',
] as const satisfies readonly (keyof SubordinateAgent)[];

export const SUBORDINATE_RPC_SURFACE: readonly string[] = [
  ...PLATFORM_RPC_SURFACE,
  ...AGENTS_FACET_RPC_SURFACE,
  ...ACTOR_AGENT_RPC_SURFACE,
  ...SUBORDINATE_METHODS,
];

/**
 * What a spawner may call on an exploration facet: seed it, then run it. Its
 * reach back into the workspace goes the other way — a head holds an
 * orchestrator stub and mounts its file plane over ACTOR_AGENT_RPC_SURFACE — so
 * nothing else here needs to be reachable.
 *
 * One class hosts both families now, so these names are members of
 * SubordinateAgent beside the subordinate family's. The constructor seals the
 * boot surface below; the mode's own seed narrows the instance to exactly one
 * family's surface, which is what keeps a head from reaching subordinate
 * seeds (and the reverse) across a stub.
 */
const EXPLORATION_METHODS = [
  'abortHead',
  'explore',
  'generateReflection',
  'initHead',
  'initNode',
  'runAsHead',
  'runAsNode',
  'setOwner',
  'setSharedParent',
] as const satisfies readonly (keyof SubordinateAgent)[];

export const EXPLORATION_RPC_SURFACE: readonly string[] = [
  ...PLATFORM_RPC_SURFACE,
  ...AGENTS_FACET_RPC_SURFACE,
  ...EXPLORATION_METHODS,
];

/**
 * What a fresh facet seals to in its constructor, before any seed tells it
 * which family it is. The union of both families: the seal only ever narrows
 * (a seed shadows more names, never fewer), so the boot surface must admit
 * every seed. Each seed narrows to its own family's surface above.
 */
export const SUBORDINATE_AGENT_BOOT_SURFACE: readonly string[] = [
  ...PLATFORM_RPC_SURFACE,
  ...AGENTS_FACET_RPC_SURFACE,
  ...ACTOR_AGENT_RPC_SURFACE,
  ...SUBORDINATE_METHODS,
  ...EXPLORATION_METHODS,
];
