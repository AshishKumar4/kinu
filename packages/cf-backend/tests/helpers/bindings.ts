/**
 * Stand-ins for the platform bindings a route's env declares but the route
 * under test never reaches.
 *
 * A route family's env names every binding the family can read, including the
 * ones a particular path returns before touching. Building those as refusals
 * rather than as quiet stand-ins is what keeps "this path reads no binding" a
 * checked claim: the first reach names the binding and fails the test, instead
 * of resolving a fake nobody asserted on.
 */
import type { KvStore } from '@kinu.run/agent-utils';
import type { UserProfile } from '../../src/user/user-do';
import type { CliAgentTarget, CliRoutesAuthority, CliRoutesEnv } from '../../src/cli/routes';
import type { UserRoutesAuthority } from '../../src/user/routes';
import type { AssetFetcher } from '@kinu.run/core';
import type { ObjectNamespace } from '../../src/bindings';

export function unreachableNamespace<Stub>(binding: string): ObjectNamespace<string, Stub> {
  return {
    idFromName: (name) => { throw new Error(`${binding}.idFromName(${name}): not reachable in this test`); },
    get: (id) => { throw new Error(`${binding}.get(${id}): not reachable in this test`); },
  };
}

export function unreachableKv(binding: string): KvStore {
  const refuse = (verb: string) => (key: string): never => {
    throw new Error(`${binding}.${verb}(${key}): not reachable in this test`);
  };

  return { get: refuse('get'), put: refuse('put'), delete: refuse('delete') };
}

export function unreachableAssets(): AssetFetcher {
  return {
    fetch: (input) => { throw new Error(`ASSETS.fetch(${input.url}): not reachable in this test`); },
  };
}

/** The row `ensureProfile` answers with, as a bootstrap that stores nothing
 *  returns it: the account exists, has no onboarding stamp and owns nothing. */
export function bootstrappedProfile(email: string, displayName: string | null = null): UserProfile {
  return { email, displayName, createdAt: 1, lastSeenAt: 1, onboardedAt: null, workspaceCount: 0 };
}

/** The CLI plane's env with nothing in it but refusals: what a public static
 *  route — the install page, the installer, the launcher — is answered from,
 *  since each returns before reading a binding. */
export function staticRouteCliEnv(): CliRoutesEnv<string> {
  return {
    AUTH_KV: unreachableKv('AUTH_KV'),
    ASSETS: unreachableAssets(),
    UserDO: unreachableNamespace('UserDO'),
    OrchestratorAgent: unreachableNamespace('OrchestratorAgent'),
  };
}

/** Name one member of an object binding that this case does not reach. The
 *  refusal is the point: a route that was supposed to answer without it says
 *  so, instead of a stand-in quietly answering for it. */
function unreached(object: string, member: string) {
  return (): never => { throw new Error(`${object}.${member}: not reachable in this test`); };
}

/**
 * The account object as the CLI plane declares it, with every call this case
 * did not build refusing.
 *
 * The plane's env names one object for every CLI surface — sign-in, tokens,
 * devices, credentials, workspaces — while one case drives a handful. Filling
 * the rest with refusals is what keeps "this route touched only these" a
 * checked claim.
 */
export function cliAccount<Built extends Partial<CliRoutesAuthority>>(built: Built): CliRoutesAuthority & Built {
  const refuse = (member: string) => unreached('UserDO', member);

  return {
    ensureProfile: refuse('ensureProfile'),
    mintCliToken: refuse('mintCliToken'),
    verifyCliToken: refuse('verifyCliToken'),
    verifyAccessToken: refuse('verifyAccessToken'),
    registerBrowserSession: refuse('registerBrowserSession'),
    verifyBrowserSession: refuse('verifyBrowserSession'),
    revokeBrowserSession: refuse('revokeBrowserSession'),
    getAuthHeaders: refuse('getAuthHeaders'),
    getCredentialBaseURL: refuse('getCredentialBaseURL'),
    listCredentials: refuse('listCredentials'),
    setCredential: refuse('setCredential'),
    deleteCredential: refuse('deleteCredential'),
    getProfileCatalog: refuse('getProfileCatalog'),
    putProfileCatalog: refuse('putProfileCatalog'),
    registerWorkspace: refuse('registerWorkspace'),
    removeWorkspace: refuse('removeWorkspace'),
    releaseWorkspaceReservation: refuse('releaseWorkspaceReservation'),
    ensureWorkspaceCapability: refuse('ensureWorkspaceCapability'),
    hasWorkspace: refuse('hasWorkspace'),
    listActiveWorkspaces: refuse('listActiveWorkspaces'),
    revokeCliTokenHash: refuse('revokeCliTokenHash'),
    listCliTokens: refuse('listCliTokens'),
    revokeAllCliTokens: refuse('revokeAllCliTokens'),
    listAccessTokens: refuse('listAccessTokens'),
    mintAccessToken: refuse('mintAccessToken'),
    revokeAccessToken: refuse('revokeAccessToken'),
    issueCliAgentConnectTicket: refuse('issueCliAgentConnectTicket'),
    registerDevice: refuse('registerDevice'),
    listDevices: refuse('listDevices'),
    ...built,
  };
}

/** The workspace object a Worker route addresses, with the birth sequence and
 *  the credential notice refusing unless the case built them. The dispatch
 *  surface is the request's own choice of name, so a case supplies exactly the
 *  methods it drives. Typed at the CLI plane's reach, which is the widest of
 *  the two planes that address one. */
export function workspaceObject<Built extends Partial<CliAgentTarget>>(built: Built): CliAgentTarget & Built {
  const refuse = (member: string) => unreached('OrchestratorAgent', member);

  return {
    claimOwner: refuse('claimOwner'),
    setInitialDisplayName: refuse('setInitialDisplayName'),
    setAutoDisplayName: refuse('setAutoDisplayName'),
    setSoul: refuse('setSoul'),
    resetWorkspaceBaseline: refuse('resetWorkspaceBaseline'),
    setModel: refuse('setModel'),
    setReasoningEffort: refuse('setReasoningEffort'),
    setRole: refuse('setRole'),
    beginGenesisTurn: refuse('beginGenesisTurn'),
    reportFacetModelCall: refuse('reportFacetModelCall'),
    onCredentialsChanged: refuse('onCredentialsChanged'),
    createDurableWebhook: refuse('createDurableWebhook'),
    ...built,
  };
}

/**
 * The account object as `/api/user/*` declares it, with every call this case
 * did not build refusing.
 *
 * One dispatcher holds one stub for every route family the plane answers, so a
 * case that drives the credential routes still has to say what the device,
 * config, codex and MCP families would do. Refusals say it.
 */
export function userAccount<Built extends Partial<UserRoutesAuthority>>(
  built: Built,
): UserRoutesAuthority & Built {
  const refuse = (member: string) => unreached('UserDO', member);

  return {
    ensureProfile: refuse('ensureProfile'),
    getProfile: refuse('getProfile'),
    getProfileCatalog: refuse('getProfileCatalog'),
    putProfileCatalog: refuse('putProfileCatalog'),
    userMcp_warmConnections: refuse('userMcp_warmConnections'),
    userMcp_list: refuse('userMcp_list'),
    userMcp_presets: refuse('userMcp_presets'),
    userMcp_add: refuse('userMcp_add'),
    userMcp_remove: refuse('userMcp_remove'),
    userMcp_update: refuse('userMcp_update'),
    userMcp_handleOAuthCallback: refuse('userMcp_handleOAuthCallback'),
    listWorkspaces: refuse('listWorkspaces'),
    listActiveWorkspaces: refuse('listActiveWorkspaces'),
    touchWorkspace: refuse('touchWorkspace'),
    registerWorkspace: refuse('registerWorkspace'),
    removeWorkspace: refuse('removeWorkspace'),
    releaseWorkspaceReservation: refuse('releaseWorkspaceReservation'),
    ensureWorkspaceCapability: refuse('ensureWorkspaceCapability'),
    listDevices: refuse('listDevices'),
    acknowledgeUnstoppedDevice: refuse('acknowledgeUnstoppedDevice'),
    revokeDevice: refuse('revokeDevice'),
    renameDevice: refuse('renameDevice'),
    listDeviceConsents: refuse('listDeviceConsents'),
    setDeviceTier: refuse('setDeviceTier'),
    revokeDeviceConsent: refuse('revokeDeviceConsent'),
    listCredentials: refuse('listCredentials'),
    setCredential: refuse('setCredential'),
    deleteCredential: refuse('deleteCredential'),
    getAuthHeaders: refuse('getAuthHeaders'),
    getCredentialBaseURL: refuse('getCredentialBaseURL'),
    getCodexStatus: refuse('getCodexStatus'),
    disconnectCodex: refuse('disconnectCodex'),
    startCodexDeviceFlow: refuse('startCodexDeviceFlow'),
    pollCodexDeviceFlow: refuse('pollCodexDeviceFlow'),
    listConfig: refuse('listConfig'),
    getConfig: refuse('getConfig'),
    setConfig: refuse('setConfig'),
    listConnectedProviders: refuse('listConnectedProviders'),
    listCloudflareAccounts: refuse('listCloudflareAccounts'),
    selectCloudflareAccount: refuse('selectCloudflareAccount'),
    listAIGateways: refuse('listAIGateways'),
    selectAIGateway: refuse('selectAIGateway'),
    ...built,
  };
}
