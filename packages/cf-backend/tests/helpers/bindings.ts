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
import type { Connection } from 'agents';
import type { UserProfile } from '../../src/user/user-do';
import type { CliAgentTarget, CliRoutesAuthority, CliRoutesEnv } from '../../src/cli/routes';
import type { UserRoutesAuthority } from '../../src/user/routes';
import type { McpAuthority } from '../../src/mcp-server';
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

/**
 * The deployment's whole `Env`, with every binding refusing and naming itself.
 *
 * What the Worker ENTRY takes. `route()` is the host-aware table over every
 * surface this Worker answers, so its env is the whole deployment's and nothing
 * narrower is honest there. A case hands `reached` the bindings its request
 * genuinely reads; a binding it leaves out refuses on first touch, so "this
 * request answered before reaching a binding" is a checked claim instead of an
 * empty array somebody remembered to assert.
 */
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
    DeployRunDO: unreachableObjects('DeployRunDO'),
    AUTH_KV: unreachableKvNamespace('AUTH_KV'),
    ASSETS: unreachableFetcher('ASSETS'),
    AI_GATEWAY_URL: 'https://gateway.invalid/unreachable',
    PREVIEW_HOST_SUFFIX: '',
    ...reached,
  };
}

/** A Durable Object namespace nothing may resolve through: every entry point
 *  into it refuses and says which binding was reached. */
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

/** The platform KV binding, refusing. `unreachableKv` above is the narrow
 *  `KvStore` port our own code reads a store through; this is the whole
 *  namespace an `Env` member is declared as. */
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
    fetch: (input) => { throw new Error(`${binding}.fetch(${String(input)}): not reachable in this test`); },
    connect: (address) => { throw new Error(`${binding}.connect(${String(address)}): not reachable in this test`); },
  };
}

/**
 * The entry's `ExecutionContext`, with the retention hooks recording.
 *
 * `waitUntil` is how every retained write leaves a request — the control-plane
 * observation, the index feed — so a case that asserts one happened reads the
 * promises back out of `retained`.
 */
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

/** The span a test's request runs under: nothing collects it, and it says so. */
class UntracedSpan {
  get isTraced(): boolean { return false; }
  setAttribute(): void {}
  end(): void {}
}

/**
 * The socket an actor is handed, with every member this case did not build
 * refusing by name.
 *
 * `Connection` is the workers `WebSocket` plus the party's five — 27 members —
 * and a path under test reads two or three of them. Refusing the rest is what
 * keeps "this handler only sent on the wire" a checked claim; `readyState` is
 * OPEN because a closed socket is a state a case asks for deliberately.
 */
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

/**
 * The account object as the MCP surface declares it: the bearer path's token
 * checks, the cookie path's session checks, and the ownership gate's roster
 * reads, with everything a case did not build refusing.
 *
 * One server answers external MCP clients (a CLI bearer) and the browser
 * (a session cookie), so both authentications are on the same object even
 * though one request takes one of them.
 */
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
