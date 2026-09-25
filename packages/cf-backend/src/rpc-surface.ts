/**
 * The Durable Object RPC boundary. Cloudflare resolves `stub.foo(...)` on the receiver's prototype chain
 * (`rpc.prototype_chain`): TS `private` methods and superclass methods (e.g. `Agent.sql`, arbitrary SQL)
 * are reachable; own instance properties are not, even when they shadow a prototype method.
 * Measured 2026-09-10 under workerd on `agents@0.22.0`: `Agent` contributes 289 reachable names, `Think` 372 more.
 * `sealRpcSurface` therefore shadows every unlisted reachable member with an own property. The surface is
 * an allowlist, so a new member is unreachable until listed; native RPC has no dispatch hook to intercept.
 */

import { AGENT_RPC_ACCESS } from '@kinu.run/core';
import type { ActorAgent } from './actor-agent';
import type { OrchestratorAgent } from './orchestrator';
import type { UserDO } from './user/user-do';

/**
 * Names the runtime and SDKs dispatch on a stub. `__unsafe_ensureInitialized` is what `getAgentByName`
 * calls on the stub; denying it breaks every `getAgentByName`.
 */
const PLATFORM_RPC_SURFACE: readonly string[] = [
  'fetch',
  '__unsafe_ensureInitialized',
  'alarm',
  'webSocketMessage',
  'webSocketClose',
  'webSocketError',
] as const;

/**
 * The agents-SDK `_cf_` facet protocol, invoked on the root object's stub. `unit-rpc-surface.test.ts`
 * derives this list from `agents/dist`. `_cf_invokeSubAgent*`/`_cf_invokeAgentPath` stay sealed: they call
 * a method by NAME and would re-open everything this module closes.
 */
const AGENTS_FACET_RPC_SURFACE: readonly string[] = [
  '_cf_acquireFacetKeepAlive',
  '_cf_broadcastToSubAgent',
  '_cf_checkRunFibersForFacet',
  '_cf_cleanupFacetPrefix',
  '_cf_closeSubAgentConnection',
  '_cf_destroyDescendantFacet',
  '_cf_handleSubAgentWebSocketClose',
  '_cf_handleSubAgentWebSocketConnect',
  '_cf_handleSubAgentWebSocketMessage',
  '_cf_initAsFacet',
  '_cf_registerFacetRun',
  '_cf_releaseFacetKeepAlive',
  '_cf_routeLifecycle',
  '_cf_sendToSubAgentConnection',
  '_cf_setSubAgentConnectionState',
  '_cf_subAgentConnectionMetas',
  '_cf_unregisterFacetRun',
] as const;

interface RpcSurfaceSubject {
  readonly constructor: Function;
}

/** Every prototype-chain member below `Object.prototype` not shadowed by an own property; the rule
 * workerd implements, pinned by unit-rpc-surface.test.ts. */
function rpcReachableNames(target: RpcSurfaceSubject): string[] {
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
 * Reduce `instance`'s RPC-reachable surface to `surface`, in place. Call as the last statement of the
 * constructor, after `super()` installed the SDK wrappers. Function identity is preserved.
 */
export function sealRpcSurface(instance: RpcSurfaceSubject, surface: readonly string[]): void {
  const allowed = new Set(surface);

  for (const name of rpcReachableNames(instance)) {
    if (allowed.has(name)) continue;
    const descriptor = inheritedDescriptor(instance, name);

    if (descriptor) Object.defineProperty(instance, name, { ...descriptor, enumerable: false });
  }
}

function inheritedDescriptor(instance: RpcSurfaceSubject, name: string): PropertyDescriptor | undefined {
  for (let proto: object | null = Object.getPrototypeOf(instance);
       proto !== null && proto !== Object.prototype;
       proto = Object.getPrototypeOf(proto)) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);

    if (descriptor) return descriptor;
  }

  return undefined;
}

// `satisfies readonly (keyof X)[]` fails the build on a name that is not a public member.

/** The RPC counterpart of the `requireTier` gate: every entry gates itself on a `UserCaller`. */
const USER_DO_METHODS = [
  'createReleaseChange',
  'completeOnboarding',
  'decideReleaseApproval',
  'deleteAccount',
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
  'putWorkspaceOverview',
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
  'setDisplayName',
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
  'userMcp_presets',
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
  'sharesReceived_add',
  'sharesReceived_forget',
  'sharesReceived_list',
  'drive_list',
  'drive_mkdir',
  'drive_rename',
  'drive_delete',
  'drive_markAsSkill',
  'drive_addSkill',
  'drive_writeChunk',
  'drive_abortUpload',
  'drive_startDownload',
  'drive_readChunk',
  'drive_abortDownload',
] as const satisfies readonly (keyof UserDO)[];

export type UserDoRpcMethod = (typeof USER_DO_METHODS)[number];

export const USER_DO_RPC_SURFACE: readonly string[] = [...PLATFORM_RPC_SURFACE, ...USER_DO_METHODS];

/** Members every actor exposes; entries a facet reaches on its parent stub must be listed or nested
 * trees fail closed at depth 2. `protected` members stay unreachable. */
const ACTOR_AGENT_RPC_SURFACE = [
  'deleteWorkspaceFile',
  'slateBindingDispatch',
  'closeRevokedCliSockets',
  'closeRevokedSessionSockets',
  'repushWorkspaceCapability',
  'getSubordinateBootstrapIdentity',
  'inspectSubordinateStorage',
  'headJournalCacheMerge',
  'headJournalInsertSpawn',
  'headJournalRecordReport',
  'headJournalRecordSplit',
  // Reached both directions of the tree: a subordinate rides its parent's container.
  'hasSandboxBackgroundWork',
  'installWorkspaceCapability',
  'getWorkspaceInstructionApprovals',
  'listWorkspaceFiles',
  'missionDebit',
  'missionGuard',
  'onCredentialsChanged',
  'readWorkspaceFile',
  'receiveSubordinateEvent',
  'recordSubordinateTitle',
  'reportFacetModelCall',
  'reportFacetModelOperation',
  'statWorkspaceFile',
  'writeWorkspaceFile',
] as const satisfies readonly (keyof ActorAgent)[];

/** Beyond `AGENT_RPC_ACCESS` (reachable by construction); `destroyAgent` is called DO-to-DO by UserDO. */
const ORCHESTRATOR_METHODS = [
  'abortExecutorFileDownload',
  'abortExecutorFileWrite',
  'acceptContainerEvent',
  // Never `@callable`.
  'admitBlueprint',
  'blueprintBundle',
  'readBlueprint',
  'shareBlueprintWith',
  'acceptEmailDelivery',
  'acceptSandboxLifecycleFailure',
  'acceptWebhookDelivery',
  'accountSpend',
  'announceDeviceAvailable',
  'announceDeviceUnavailable',
  'authorizeEmailSender',
  'awaitDeviceConsent',
  'beginGenesisTurn',
  'claimOwner',
  'createDurableWebhook',
  'getActorSnapshot',
  'getEmailIngress',
  'getRunEvents',
  'getShadowStatus',
  'getToolList',
  'getWorkspaceCapabilityHash',
  'listPeersFromMcp',
  'listRuns',
  'openDeviceTerminal',
  'prepareTerminal',
  'rawCopyFromFork',
  'readExecutorFileChunk',
  'receivePeerMessage',
  'recordHeadStep',
  'runScaffoldOnce',
  'runTaskFromMcp',
  'saveNoteFromMcp',
  'sendPeerFromMcp',
  'setEmailAllowlist',
  'setEmailNotifications',
  'setInitialDisplayName',
  'startExecutorFileDownload',
  'transitionReleaseChange',
  'writeExecutorFileChunk',
  // No file operation gets a uid-bearing forwarding RPC: `NimbusExecOptions.cred` names a uid.
  'routeWorkspacePreview',
  // Answers a refusal, never a storage key: no physical key appears in a client-visible URL.
  'resolveHostedActorRoute',
  'applyActorDirectory',
  // A browser cannot mint a caller.
  'slateAs',
  'slateBindingCallAs',
  // Reachable by a DO stub in this Worker, never a browser; none is `@callable`.
  'routeSlateShare',
  'readLiveShare',
  'shareLiveWith',
  'liveShareBundle',
  'liveShareUrl',
  'viewerEntryUrl',
  // Never `@callable`: reachable only by a Durable Object stub in this Worker.
  'requestOverviewPush',
  'supervisorOp',
  'workspaceTitle',
  // Eval-only. Never `@callable`; the route admits only the eval-service identity.
  'evalAbortActivation',
] as const satisfies readonly (keyof OrchestratorAgent)[];

export const ORCHESTRATOR_RPC_SURFACE: readonly string[] = [
  ...PLATFORM_RPC_SURFACE,
  ...AGENTS_FACET_RPC_SURFACE,
  ...ACTOR_AGENT_RPC_SURFACE,
  ...Object.keys(AGENT_RPC_ACCESS),
  ...ORCHESTRATOR_METHODS,
];
