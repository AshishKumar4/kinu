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
 * The agents-SDK `_cf_` facet protocol, invoked on the root object's stub; the workerd facet journeys call it across
 * real stubs. `_cf_invokeSubAgent*`/`_cf_invokeAgentPath` stay sealed: they call a method by NAME and would re-open
 * everything this module closes (`workerd/orchestrator-seal.test.ts` calls each).
 */
const AGENTS_FACET_RPC_SURFACE: readonly string[] = [
  '_cf_acquireFacetKeepAlive',
  '_cf_broadcastToSubAgent',
  '_cf_checkRunFibersForFacet',
  '_cf_cleanupFacetPrefix',
  '_cf_closeSubAgentConnection',
  '_cf_closeSubAgentConnectionsForPrefix',
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

// `satisfies readonly (keyof X)[]` fails the build on a name that is not a public member.

/** The RPC counterpart of the `requireTier` gate: every entry gates itself on a `UserCaller`. */
const USER_DO_METHODS = [
  'slateAi',
  'slatePartConsented',
  'slateAiSpend',
  'slateConsents',
  'consentSlate',
  'withdrawSlateConsent',
  'slatePartTool',
  'slatePartAi',
  'decideSlateEffect',
  'accountMemory_decide',
  'accountMemory_facts',
  'accountMemory_forget',
  'accountMemory_forgetNote',
  'accountMemory_propose',
  'accountMemory_put',
  'accountMemory_searchNotes',
  'accountMemory_view',
  'builtinAdmissible',
  'builtinApplyReset',
  'builtinClearAttempts',
  'builtinRemoveAccount',
  'builtinCreateInvite',
  'builtinHasOwner',
  'builtinInvitedEmail',
  'builtinIsOwner',
  'builtinIssueChallenge',
  'builtinListAccounts',
  'builtinPasskeyAccount',
  'builtinPasswordAccount',
  'builtinRecordPasskeyUse',
  'builtinRegister',

  'builtinReserveAttempt',
  'builtinResetAccount',
  'builtinSpendChallenge',
  'cancelChatGptSignIn',
  'cancelModelRelay',
  'chatgptPlan',
  'checkpointCredentials',
  'closeDeviceSession',
  'completeOnboarding',
  'deleteAccount',
  'deleteCredential',
  'deviceName',
  'deviceRpc',
  'deviceRuntimeStatus',
  'disconnectCodex',
  'raiseCredentialFloor',
  'ensureProfile',
  'ensureWorkspaceCapability',
  'finishChatGptPasteSignIn',
  'finishClaudeSignIn',
  'getAuth',
  'getAuthHeaders',
  'getCodexStatus',
  'getConfig',
  'claimConfig',
  'getCredentialEndpoint',
  'getDeviceFileView',
  'getWorkspaceTitle',
  'getExperienceEntry',
  'getProfile',
  'getProfileCatalog',
  'getWorkspaceProfileCatalog',
  'hasWorkspace',
  'heldRows',
  'issueCliAgentConnectTicket',
  'issueDeviceConnectTicket',
  'issueDeviceJoin',
  'joinDevice',
  'opsTables',
  'listAIGateways',
  'listAccessTokens',
  'listActiveWorkspaces',
  'listCliTokens',
  'listCloudflareAccounts',
  'listCredentials',
  'listDeviceConsents',
  'listDeviceSessions',
  'listDevices',
  'listSecrets',
  'listWorkspaces',
  'mintAccessToken',
  'mintCliToken',
  'openDeviceScreen',
  'openDeviceSession',
  'openDeviceTerminal',
  'publishExperience',
  'publishWorkspaceReservation',
  'putSecrets',
  'putProfileCatalog',
  'putWorkspaceOverview',
  'registerBrowserSession',
  'registerDevice',
  'recordDeviceUpdateRefusal',
  'registerWorkspace',
  'relayDevice',
  'relayModelCall',
  'releaseWorkspaceReservation',
  'removeWorkspace',
  'renameDevice',
  'renameDeviceSession',
  'renewWorkspaceReservation',
  'reserveWorkspace',
  'resolveEgressInjection',
  'restoreCredentials',
  'revokeAccessToken',
  'revokeBrowserSession',
  'revokeCliTokenHash',
  'revokeDevice',
  'acknowledgeDeviceRequest',
  'acknowledgeUnstoppedDevice',
  'cancelDeviceRequestsForAgent',
  'cancelDeviceRequestsForBackgroundJob',
  'grantDeviceConsent',
  'revokeDeviceConsent',
  'revokeSecretGrant',
  'setSecretDestination',
  'deleteSecret',
  'grantSecret',
  'grantedSecrets',
  'revealedSecrets',
  'revealedSecretsFor',
  'searchExperience',
  'selectAIGateway',
  'selectCloudflareAccount',
  'setConfig',
  'setCredential',
  'setDeviceTier',
  'setDisplayName',
  'setWorkspaceDisplayName',
  'setWorkspaceLogo',
  'signOutChatGpt',
  'startChatGptPasteSignIn',
  'startChatGptSignIn',
  'startClaudeSignIn',
  'touchWorkspace',
  'transferDeviceRequestToBackgroundJob',
  'userMcp_add',
  'userMcp_callTool',
  'userMcp_cancelCall',
  'userMcp_githubRefresh',
  'userMcp_handleOAuthCallback',
  'userMcp_beginConnect',
  'userMcp_connectedPresets',
  'userMcp_list',
  'userMcp_presets',
  'userMcp_remove',
  'userMcp_toolDescriptors',
  'userMcp_warmConnections',
  'verifyAccessToken',
  'verifyBrowserSession',
  'verifyCliAgentConnectTicket',
  'verifyCliToken',
  'verifyDeviceConnectTicket',
  'verifyDeviceToken',
  'verifyCliSocketBearer',
  'verifySocketSession',
  'watchDeviceStatus',
  'revokeAllCliTokens',
  'getCredentialsRevision',
  'storedProviderListing',
  'keepProviderListing',
  'getSettingsRevision',
  'shareCards_put',
  'shareCards_remove',
  'shareCards_withdraw',
  'shareRecipient_forget',
  'sharesReceived_forget',
  'sharesReceived_list',
  'sharesSeenAt',
  'sharesSeen',
  'libraryTiles',
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
  'limits',
  'limits_nearNote',
  'limits_admitStoredBytes',
  'limits_storageSampled',
  'limits_admitComputerStart',
  'limits_computerTick',
  'limits_computerStopped',
  'limits_admitTurn',
  'limits_platformTokensSpent',
  'limits_setClass',
  'limits_suspend',
  'limits_unsuspend',
] as const satisfies readonly (keyof UserDO)[];

export type UserDoRpcMethod = (typeof USER_DO_METHODS)[number];

export const USER_DO_RPC_SURFACE: readonly string[] = [...PLATFORM_RPC_SURFACE, ...USER_DO_METHODS];

/** Never gated: a deletion must work when start throws, and the deploy's tables walk reads tables alone. */
const USER_DO_STARTLESS: ReadonlySet<string> = new Set(['deleteAccount', 'opsTables']);

export const USER_DO_STARTED_RPC: readonly string[] = USER_DO_METHODS.filter((name) => !USER_DO_STARTLESS.has(name));

/** Members every actor exposes; entries a facet reaches on its parent stub must be listed or nested
 * trees fail closed at depth 2. `protected` members stay unreachable. */
const ACTOR_AGENT_RPC_SURFACE = [
  'deleteWorkspaceFile',
  'slateCallDispatch',
  'closeRevokedCliSockets',
  'closeRevokedSessionSockets',
  'inspectSubagentStorage',
  'headJournalCacheMerge',
  'headJournalInsertSpawn',
  'headJournalRecordReport',
  'headJournalRecordSplit',
  'installWorkspaceCapability',
  'listWorkspaceFiles',
  'missionDebit',
  'missionGuard',
  'onModelSettingsChanged',
  'readWorkspaceFile',
  'statWorkspaceFile',
  'writeWorkspaceFile',
] as const satisfies readonly (keyof ActorAgent)[];

/** Beyond `AGENT_RPC_ACCESS` (reachable by construction); `destroyAgent` is called DO-to-DO by UserDO. */
const ORCHESTRATOR_METHODS = [
  'abortExecutorFileDownload',
  'opsTables',
  'abortExecutorFileWrite',
  'acceptContainerEvent',
  // A Node program's namespace call, from its principal's egress (`node-program.ts`).
  'nodeProgramCall',
  'secretsMoved',
  'recordGitHubEgress',
  // Never `@callable`.
  'admitBlueprint',
  // The account's install, DO-to-DO (`workspace-create.ts`): a blueprint's layout, agent and owner schedules.
  'seedBlueprint',
  // The account, DO-to-DO, when the owner's connections change (`user/mcp-servers.ts`).
  'connectionsChanged',
  // The account, DO-to-DO, when an account it shared with is deleted (`user/share-cards.ts`).
  'forgetPerson',
  // The account, DO-to-DO, confirming a workspace's deletion (`user/workspaces.ts`, core's `confirmedDeletion`).
  'storedWorkspace',
  'blueprintBundle',
  'readBlueprint',
  'shareBlueprintWith',
  'acceptSandboxLifecycleIncident',
  'sandboxStopped',
  'sandboxRestore',
  'computerStartAdmitted',
  'computerRunningTick',
  'acceptWebhookDelivery',
  'accountSpend',
  'announceDeviceAvailable',
  'announceDeviceUnavailable',
  'askDeviceConsent',
  'beginGenesisTurn',
  'claimOwner',
  'createDurableWebhook',
  'devicesMoved',
  'getActorSnapshot',
  'getEmailIngress',
  'getRunEvents',
  'getRunEventText',
  'getEvolutionStatus',
  'getToolList',
  'getWorkspaceCapabilityHash',
  'listPeersFromMcp',
  'listRuns',
  'openDeviceScreen',
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
  'setEmailNotifications',
  'setInitialDisplayName',
  'startExecutorFileDownload',
  'writeExecutorFileChunk',
  // No file operation gets a uid-bearing forwarding RPC: `NimbusExecOptions.cred` names a uid.
  'routeWorkspacePreview',
  // The app's preview entry asks it of the signed-in visitor: a read, which never claims the workspace.
  'previewAccess',
  // Answers a refusal, never a storage key: no physical key appears in a client-visible URL.
  'resolveHostedActorRoute',
  'applyActorDirectory',
  // A browser cannot mint a caller.
  'slateAs',
  'slateBuildAs',
  'slateCallAs',
  // A personal part's run, its process's calls, and what its viewer showed: DO-to-DO only, from the app's routes and PartBinding.
  // A slate shared to edit: its files read, and changed, for the editor another workspace names (its owner).
  'slateFilesFor',
  'editSlateAs',
  'runSlatePart',
  'slatePartCall',
  'showSlatePart',
  'releaseSlatePart',
  // An isolate running an actor's turn, or a slate, calls the actor's operations here.
  'callOperation',
  'listOperations',
  'cancelOperation',
  // Reachable by a DO stub in this Worker, never a browser; none is `@callable`.
  'routeSlateShare',
  'openLiveShare',
  'shareLiveWith',
  'liveShareBundle',
  // The owner's share sheet's mode, Gallery listing and standing approvals, and a listed share's needs for the Gallery's
  // public page.
  'setLiveShareMode',
  'setLiveShareListing',
  'slatePreapprovals',
  'withdrawSlatePreapproval',
  'galleryNeeds',
  'liveShareUrl',
  // Worker-only: the mail router hands a filed arrival to the workspace it woke (mail/handler.ts), and the owner's
  // route a thread they sent it (mail/routes.ts).
  'mailArrived',
  'mailHanded',
  // Worker-only: the assistant's install and the owner's claim of an address (user/blueprint-install.ts, mail/routes.ts).
  'readOwnerMail',
  // Worker-only: the mail router's word that new mail waits for the assistant's triage (mail/handler.ts).
  'triageOwnerMail',
  'viewerEntryUrl',
  // Never `@callable`: reachable only by a Durable Object stub in this Worker.
  'requestOverviewPush',
  'ownsBrowserSession',
  'supervisorOp',
  'agentWorkspace',
  // Its agents' isolate tail (`AgentIsolateTail`) reports a death of memory here.
  'isolateOutOfMemory',
  'workspaceTitle',
  'activations',
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

/** Never gated: a deletion must work when start throws, and must not start a workspace to delete it; the deploy's
 *  tables walk reads tables alone, and must not start every workspace to reach them. */
const ORCHESTRATOR_STARTLESS: ReadonlySet<string> = new Set(['destroyAgent', 'storedWorkspace', 'quietForDeletion', 'evalAbortActivation', 'opsTables']);

export const ORCHESTRATOR_STARTED_RPC: readonly string[] = [
  ...ACTOR_AGENT_RPC_SURFACE,
  ...Object.keys(AGENT_RPC_ACCESS),
  ...ORCHESTRATOR_METHODS,
].filter((name) => !ORCHESTRATOR_STARTLESS.has(name));
