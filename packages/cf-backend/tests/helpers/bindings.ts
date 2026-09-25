/**
 * Platform bindings a route's env declares but the path under test never reaches, as refusals:
 * the first reach names the binding and fails, so "this path reads no binding" stays checked.
 */
import type { KvStore } from '@kinu.run/agent-utils';
import type { Connection } from 'agents';
import type { UserProfile } from '../../src/user/user-do';
import type { CliAgentTarget, CliRoutesAuthority, CliRoutesEnv } from '../../src/cli/routes';
import type { UserRoutesAuthority } from '../../src/user/routes';
import type { McpAuthority } from '../../src/mcp-server';
import type { AssetFetcher } from '@kinu.run/core';
import type { ObjectNamespace } from '@kinu.run/core';

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

/** The whole deployment `Env` the Worker entry takes; bindings not in `reached` refuse on first touch. */
export function workerEnv(reached: Partial<Env> = {}): Env {
  return {
    LOADER: {
      get: (name) => { throw new Error(`LOADER.get(${String(name)}): not reachable in this test`); },
      load: () => { throw new Error('LOADER.load: not reachable in this test'); },
    },
    OrchestratorAgent: unreachableObjects('OrchestratorAgent'),
    UserDO: unreachableObjects('UserDO'),
    MonitorDO: unreachableObjects('MonitorDO'),
    ControlPlaneDO: unreachableObjects('ControlPlaneDO'),
    Sandbox: unreachableObjects('Sandbox'),
    CodexEgress: unreachableObjects('CodexEgress'),
    DeployRunDO: unreachableObjects('DeployRunDO'),
    AUTH_KV: unreachableKvNamespace('AUTH_KV'),
    ASSETS: unreachableFetcher('ASSETS'),
    AI_GATEWAY_URL: 'https://gateway.invalid/unreachable',
    PREVIEW_HOST_SUFFIX: '',
    ...reached,
  };
}

/** A Durable Object namespace whose every entry point refuses, naming the binding. */
export function unreachableObjects<T extends Rpc.DurableObjectBranded>(binding: string): DurableObjectNamespace<T> {
  const refuse = (verb: string, arg: string): never => {
    throw new Error(`${binding}.${verb}(${arg}): not reachable in this test`);
  };

  return {
    idFromName: (name) => refuse('idFromName', name),
    idFromString: (id) => refuse('idFromString', id),
    newUniqueId: () => refuse('newUniqueId', ''),
    jurisdiction: (where) => refuse('jurisdiction', where),
    get: (id) => refuse('get', id.toString()),
    getByName: (name) => refuse('getByName', name),
  };
}

/** The platform KV namespace, refusing (`unreachableKv` is the narrow `KvStore` port). */
function unreachableKvNamespace(binding: string): KVNamespace {
  const refuse = (verb: string, key: string): never => {
    throw new Error(`${binding}.${verb}(${key}): not reachable in this test`);
  };

  return {
    get: (key: string | string[]) => refuse('get', String(key)),
    getWithMetadata: (key: string | string[]) => refuse('getWithMetadata', String(key)),
    put: (key: string) => refuse('put', key),
    delete: (key: string) => refuse('delete', key),
    list: () => refuse('list', ''),
  };
}

function unreachableFetcher(binding: string): Fetcher {
  return {
    fetch: () => { throw new Error(`${binding}.fetch: not reachable in this test`); },
    connect: () => { throw new Error(`${binding}.connect: not reachable in this test`); },
  };
}

/** `ExecutionContext` whose `waitUntil` promises are collected in `retained`. */
export function workerContext(): ExecutionContext & { readonly retained: Promise<unknown>[] } {
  const retained: Promise<unknown>[] = [];

  return {
    retained,
    waitUntil(promise: Promise<unknown>) { retained.push(promise); },
    passThroughOnException() {},
    props: {},
    tracing: {
      enterSpan: (_name, callback, ...args) => callback(new UntracedSpan(), ...args),
      startActiveSpan: (_name, callback, ...args) => callback(new UntracedSpan(), ...args),
      Span: UntracedSpan,
    },
  };
}

class UntracedSpan {
  get isTraced(): boolean { return false; }
  setAttribute(): void {}
  end(): void {}
}

/** A `Connection` whose unbuilt members refuse by name; `readyState` is OPEN unless a case asks otherwise. */
export function socketConnection(built: Partial<Connection> = {}): Connection {
  const refuse = (member: string) => unreached('Connection', member);

  return {
    id: 'test-connection',
    uri: 'wss://test.invalid/',
    state: null,
    tags: [],
    setState: refuse('setState'),
    accept: refuse('accept'),
    send: refuse('send'),
    close: refuse('close'),
    serializeAttachment: refuse('serializeAttachment'),
    deserializeAttachment: refuse('deserializeAttachment'),
    addEventListener: refuse('addEventListener'),
    removeEventListener: refuse('removeEventListener'),
    dispatchEvent: refuse('dispatchEvent'),
    readyState: WebSocket.OPEN,
    url: 'wss://test.invalid/',
    protocol: '',
    extensions: '',
    binaryType: 'arraybuffer',
    bufferedAmount: 0,
    onclose: null,
    onerror: null,
    onmessage: null,
    onopen: null,
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
    ...built,
  };
}

/** `ensureProfile`'s answer from a bootstrap that stores nothing: no onboarding stamp, no workspaces. */
export function bootstrappedProfile(email: string, displayName: string | null = null): UserProfile {
  return { email, displayName, createdAt: 1, lastSeenAt: 1, onboardedAt: null, workspaceCount: 0 };
}

/** An all-refusing CLI env for public static routes, which return before reading a binding. */
export function staticRouteCliEnv(): CliRoutesEnv<string> {
  return {
    AUTH_KV: unreachableKv('AUTH_KV'),
    ASSETS: unreachableAssets(),
    UserDO: unreachableNamespace('UserDO'),
    OrchestratorAgent: unreachableNamespace('OrchestratorAgent'),
  };
}

function unreached(object: string, member: string) {
  return (): never => { throw new Error(`${object}.${member}: not reachable in this test`); };
}

/** The CLI plane's account object, with unbuilt calls refusing. */
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

/** The MCP account object; bearer and cookie auth share it because one server serves CLI and browser. */
export function mcpAccount<Built extends Partial<McpAuthority>>(built: Built): McpAuthority & Built {
  const refuse = (member: string) => unreached('UserDO', member);

  return {
    ensureProfile: refuse('ensureProfile'),
    mintCliToken: refuse('mintCliToken'),
    verifyCliToken: refuse('verifyCliToken'),
    verifyAccessToken: refuse('verifyAccessToken'),
    registerBrowserSession: refuse('registerBrowserSession'),
    verifyBrowserSession: refuse('verifyBrowserSession'),
    revokeBrowserSession: refuse('revokeBrowserSession'),
    hasWorkspace: refuse('hasWorkspace'),
    ensureWorkspaceCapability: refuse('ensureWorkspaceCapability'),
    ...built,
  };
}

/** The workspace object a Worker route addresses, typed at the CLI plane's (widest) reach; unbuilt calls refuse. */
export function workspaceObject<Built extends Partial<CliAgentTarget>>(built: Built): CliAgentTarget & Built {
  const refuse = (member: string) => unreached('OrchestratorAgent', member);

  return {
    claimOwner: refuse('claimOwner'),
    setInitialDisplayName: refuse('setInitialDisplayName'),
    setSoul: refuse('setSoul'),
    resetWorkspaceBaseline: refuse('resetWorkspaceBaseline'),
    setModel: refuse('setModel'),
    setReasoningEffort: refuse('setReasoningEffort'),
    setRole: refuse('setRole'),
    beginGenesisTurn: refuse('beginGenesisTurn'),
    reportFacetModelCall: refuse('reportFacetModelCall'),
    onCredentialsChanged: refuse('onCredentialsChanged'),
    accountSpend: refuse('accountSpend'),
    createDurableWebhook: refuse('createDurableWebhook'),
    ...built,
  };
}

/** The `/api/user/*` account object: one stub serves every route family, so unbuilt calls refuse. */
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
