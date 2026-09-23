// The attenuation boundary against the real UserDO methods: a registered workspace reaches everything
// but `owner_only` authorities. A non-CapabilityDeniedError failure means the gate let the call through.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createTestUserDO, provisionTestWorkspace, testOwner, type TestUserDO } from './helpers/user-do';
import { CAPABLE_HELLO, daemon } from './helpers/device-harness';
import { USER_DO_RPC_SURFACE, type UserDoRpcMethod } from '../src/rpc-surface';
import type { UserDO } from '../src/user/user-do';
import { sha256Hex } from '@kinu.run/core';
import { BUILTIN_PROFILE_CATALOG, decodeJsonValue } from '@kinu.run/core';
import {
  CapabilityDeniedError,
  type UserCaller,
  type WorkspaceCapability,
} from '@kinu.run/core';
import { present } from '@kinu.run/test-utils';

const WORKSPACE = 'workspace-a';

const OTHER_WORKSPACE = 'workspace-b';

const USER_ID = '0123456789abcdef0123456789abcdef';

const TOKEN_HASH = 'a'.repeat(64);

// A provider/OAuth call that survives the gate must fail loudly rather than dial out.
const realFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = Object.assign(
    async (): Promise<Response> => { throw new Error('network disabled in tests'); },
    { preconnect: realFetch.preconnect },
  );
});

afterAll(() => { globalThis.fetch = realFetch; });

type UserDOInstance = TestUserDO['userDO'];

type AsyncUserDOResult = {
  [Method in keyof UserDOInstance]: UserDOInstance[Method] extends
    (...args: never[]) => Promise<infer Result> ? Result : never;
}[keyof UserDOInstance];

interface GatedCall {
  capability: WorkspaceCapability;
  name: string;
  run(userDO: UserDOInstance, caller: UserCaller): Promise<AsyncUserDOResult>;
}

/** The attenuation matrix as calls, one row per privileged method, grouped by capability. */
const GATED_CALLS: GatedCall[] = [
  // Model providers: the agent must still function; these headers attach in trusted DO code, never LLM context.
  { capability: 'credentials.model', name: 'getAuthHeaders(codex.oauth)', run: (u, c) => u.getAuthHeaders(c, 'codex.oauth') },
  { capability: 'credentials.model', name: 'getAuthHeaders(openai.bearer)', run: (u, c) => u.getAuthHeaders(c, 'openai.bearer') },
  { capability: 'credentials.model', name: 'getCredentialBaseURL(openai-compat.box)', run: (u, c) => u.getCredentialBaseURL(c, 'openai-compat.box') },
  { capability: 'credentials.model', name: 'listCredentials', run: (u, c) => u.listCredentials(c) },
  { capability: 'credentials.model', name: 'listConnectedProviders', run: (u, c) => u.listConnectedProviders(c) },

  { capability: 'credentials.other', name: 'getAuthHeaders(github)', run: (u, c) => u.getAuthHeaders(c, 'github') },
  { capability: 'credentials.other', name: 'getCredentialBaseURL(github)', run: (u, c) => u.getCredentialBaseURL(c, 'github') },
  { capability: 'credentials.other', name: 'setCredential', run: (u, c) => u.setCredential(c, 'github', { kind: 'bearer', token: 'ghp_x' }) },
  { capability: 'credentials.other', name: 'deleteCredential', run: (u, c) => u.deleteCredential(c, 'github') },

  // Binding a secret to a host is like storing a credential; unwrapping a placeholder is more privileged still.
  { capability: 'egress_secrets.manage', name: 'listEgressSecrets', run: (u, c) => u.listEgressSecrets(c) },
  {
    capability: 'egress_secrets.manage',
    name: 'putEgressSecret',
    run: (u, c) => u.putEgressSecret(c, {
      id: 'stripe', label: 'Stripe', host: 'api.stripe.com', secret: 'sk_live_probe_value',
    }),
  },
  { capability: 'egress_secrets.manage', name: 'revokeEgressSecret', run: (u, c) => u.revokeEgressSecret(c, 'stripe') },
  {
    capability: 'egress_secrets.inject',
    name: 'resolveEgressInjection',
    run: (u, c) => u.resolveEgressInjection(
      c, { host: 'api.stripe.com', url: 'https://api.stripe.com/v1/charges', headers: [] }, [],
    ),
  },

  { capability: 'ai_gateway.admin', name: 'listAIGateways', run: (u, c) => u.listAIGateways(c) },
  { capability: 'ai_gateway.admin', name: 'selectAIGateway', run: (u, c) => u.selectAIGateway(c, null) },
  { capability: 'ai_gateway.admin', name: 'listCloudflareAccounts', run: (u, c) => u.listCloudflareAccounts(c) },
  { capability: 'ai_gateway.admin', name: 'selectCloudflareAccount', run: (u, c) => u.selectCloudflareAccount(c, 'aaa111aaa111aaa111aaa111aaa111aa') },

  { capability: 'workspaces.read', name: 'getWorkspaceTitle', run: (u, c) => u.getWorkspaceTitle(c, WORKSPACE) },
  { capability: 'mcp.tools', name: 'userMcp_toolDescriptors', run: (u, c) => u.userMcp_toolDescriptors(c) },
  { capability: 'mcp.tools', name: 'userMcp_callTool', run: (u, c) => u.userMcp_callTool(c, 'srv', 'tool', {}) },

  { capability: 'mcp.manage', name: 'userMcp_list', run: (u, c) => u.userMcp_list(c) },
  { capability: 'mcp.manage', name: 'userMcp_presets', run: (u, c) => u.userMcp_presets(c) },
  { capability: 'mcp.manage', name: 'userMcp_add', run: (u, c) => u.userMcp_add(c, { name: 'x', serverUrl: 'https://x' }, 'https://app') },
  { capability: 'mcp.manage', name: 'userMcp_remove', run: (u, c) => u.userMcp_remove(c, 'srv') },
  { capability: 'mcp.manage', name: 'userMcp_update', run: (u, c) => u.userMcp_update(c, 'srv', { name: 'y' }) },
  { capability: 'mcp.manage', name: 'userMcp_warmConnections', run: (u, c) => u.userMcp_warmConnections(c) },
  { capability: 'mcp.manage', name: 'userMcp_handleOAuthCallback', run: (u, c) => u.userMcp_handleOAuthCallback(c, 'https://app/api/user/mcp/callback') },

  { capability: 'device.rpc', name: 'deviceRpc', run: (u, c) => u.deviceRpc(c, 'exec', ['ls'], { agentName: WORKSPACE }) },
  { capability: 'device.rpc', name: 'acknowledgeDeviceRequest', run: (u, c) => u.acknowledgeDeviceRequest(c, 'rpc-1') },
  { capability: 'device.rpc', name: 'cancelDeviceRequestsForTurn', run: (u, c) => u.cancelDeviceRequestsForTurn(c, 'turn-1') },
  { capability: 'device.rpc', name: 'cancelDeviceRequestsForBackgroundJob', run: (u, c) => u.cancelDeviceRequestsForBackgroundJob(c, 'job-1') },
  { capability: 'device.rpc', name: 'deviceRuntimeStatus', run: (u, c) => u.deviceRuntimeStatus(c) },
  { capability: 'device.rpc', name: 'openDeviceTerminal', run: (u, c) => u.openDeviceTerminal(c, WORKSPACE, { cols: 80, rows: 24 }) },

  // `device.consent.read_self` narrows the file view's own path scope, so refusing it would widen the scope.
  { capability: 'device.consent.read_self', name: 'getDeviceFileView', run: (u, c) => u.getDeviceFileView(c, WORKSPACE) },

  { capability: 'device.rpc', name: 'transferDeviceRequestToBackgroundJob', run: (u, c) => u.transferDeviceRequestToBackgroundJob(c, 'rpc-1', 'job-1') },

  { capability: 'workspaces.read', name: 'listWorkspaces', run: (u, c) => u.listWorkspaces(c) },
  { capability: 'workspaces.read', name: 'listActiveWorkspaces', run: (u, c) => u.listActiveWorkspaces(c) },
  { capability: 'workspaces.read', name: 'hasWorkspace', run: (u, c) => u.hasWorkspace(c, OTHER_WORKSPACE) },

  { capability: 'workspaces.write', name: 'registerWorkspace', run: (u, c) => u.registerWorkspace(c, 'spawned') },
  { capability: 'workspaces.write', name: 'reserveWorkspace', run: (u, c) => u.reserveWorkspace(c, 'reserved') },
  { capability: 'workspaces.write', name: 'releaseWorkspaceReservation', run: (u, c) => u.releaseWorkspaceReservation(c, 'reserved', 1) },
  { capability: 'workspaces.write', name: 'renewWorkspaceReservation', run: (u, c) => u.renewWorkspaceReservation(c, 'reserved', 1) },
  { capability: 'workspaces.write', name: 'publishWorkspaceReservation', run: (u, c) => u.publishWorkspaceReservation(c, 'reserved', 1, null) },
  { capability: 'workspaces.write', name: 'touchWorkspace', run: (u, c) => u.touchWorkspace(c, WORKSPACE) },
  { capability: 'workspaces.write', name: 'removeWorkspace', run: (u, c) => u.removeWorkspace(c, OTHER_WORKSPACE, USER_ID) },

  { capability: 'workspaces.rename_self', name: 'setWorkspaceDisplayName', run: (u, c) => u.setWorkspaceDisplayName(c, WORKSPACE, 'Renamed', 'user') },

  { capability: 'peers.grants', name: 'hasPeerGrant', run: (u, c) => u.hasPeerGrant(c, 'scout', 'b'.repeat(32)) },

  { capability: 'experience.read', name: 'searchExperience', run: (u, c) => u.searchExperience(c, { query: 'deploy' }) },
  { capability: 'experience.read', name: 'getExperienceEntry', run: (u, c) => u.getExperienceEntry(c, 'exp-nope') },
  {
    capability: 'experience.write',
    name: 'publishExperience',
    run: (u, c) => u.publishExperience(c, {
      kind: 'fact', key: 'deploy.target', title: 'deploy.target',
      payload: { kind: 'fact', key: 'deploy.target', value: 'x.workers.dev', confidence: 1 },
      evidence: 'held at confidence 1.00',
    }),
  },

  {
    capability: 'release',
    name: 'upsertReleaseSource',
    run: (u, c) => u.upsertReleaseSource(c, {
      kind: 'github', label: 'o/r', repoUrl: 'https://github.com/o/r',
    }),
  },
  { capability: 'release', name: 'createReleaseChange', run: (u, c) => u.createReleaseChange(c, WORKSPACE, { bindingId: 'b1', userPrompt: 'x' }) },
  { capability: 'release', name: 'updateReleaseChange', run: (u, c) => u.updateReleaseChange(c, 'pc_1', { plan: 'x' }) },
  { capability: 'release', name: 'transitionReleaseChange', run: (u, c) => u.transitionReleaseChange(c, 'pc_1', 'planning') },
  { capability: 'release', name: 'recordReleaseCheck', run: (u, c) => u.recordReleaseCheck(c, 'pc_1', { name: 'test', status: 'passed' }) },
  { capability: 'release', name: 'requestReleaseApproval', run: (u, c) => u.requestReleaseApproval(c, 'pc_1', 'deploy_production') },
  {
    capability: 'release',
    name: 'decideReleaseApproval',
    run: (u, c) => u.decideReleaseApproval(c, { approvalId: 'ap_1', decision: 'approved', approvedBy: USER_ID }),
  },
  { capability: 'release', name: 'recordReleaseDeployment', run: (u, c) => u.recordReleaseDeployment(c, 'pc_1', { environment: 'production' }) },
  { capability: 'release', name: 'getReleaseBoard', run: (u, c) => u.getReleaseBoard(c, WORKSPACE) },
  { capability: 'release', name: 'getReleaseDetail', run: (u, c) => u.getReleaseDetail(c, 'pc_1') },

  { capability: 'profile', name: 'getProfile', run: (u, c) => u.getProfile(c) },
  { capability: 'profile', name: 'ensureProfile', run: (u, c) => u.ensureProfile(c, 'owner@example.com') },

  { capability: 'config', name: 'getConfig', run: (u, c) => u.getConfig(c, 'default_model') },
  { capability: 'config', name: 'setConfig', run: (u, c) => u.setConfig(c, 'default_model', 'x') },
  { capability: 'config', name: 'listConfig', run: (u, c) => u.listConfig(c) },
  { capability: 'profile.resolve', name: 'getWorkspaceProfileCatalog', run: (u, c) => u.getWorkspaceProfileCatalog(c) },

  { capability: 'auth_tokens', name: 'mintCliToken', run: (u, c) => u.mintCliToken(c, USER_ID, TOKEN_HASH) },
  { capability: 'auth_tokens', name: 'verifyCliToken', run: (u, c) => u.verifyCliToken(c, `ptc_${USER_ID}_${'x'.repeat(44)}`) },
  { capability: 'auth_tokens', name: 'listCliTokens', run: (u, c) => u.listCliTokens(c) },
  { capability: 'auth_tokens', name: 'revokeCliTokenHash', run: (u, c) => u.revokeCliTokenHash(c, TOKEN_HASH) },
  { capability: 'auth_tokens', name: 'mintAccessToken', run: (u, c) => u.mintAccessToken(c, USER_ID, 'ci', ['workspace.read']) },
  { capability: 'auth_tokens', name: 'verifyAccessToken', run: (u, c) => u.verifyAccessToken(c, `pta_${USER_ID}_${'x'.repeat(44)}`) },
  { capability: 'auth_tokens', name: 'listAccessTokens', run: (u, c) => u.listAccessTokens(c) },
  { capability: 'auth_tokens', name: 'revokeAccessToken', run: (u, c) => u.revokeAccessToken(c, 'ci') },
  {
    capability: 'auth_tokens',
    name: 'issueCliAgentConnectTicket',
    run: (u, c) => u.issueCliAgentConnectTicket(c, {
      userId: USER_ID, agentClass: 'orchestrator-agent', agentName: WORKSPACE, cliTokenHash: TOKEN_HASH,
    }),
  },
  {
    capability: 'auth_tokens',
    name: 'verifyCliAgentConnectTicket',
    run: (u, c) => u.verifyCliAgentConnectTicket(c, `pat_${USER_ID}_${'x'.repeat(32)}`, {
      userId: USER_ID, agentClass: 'orchestrator-agent', agentName: WORKSPACE, capability: 'agent.websocket',
    }),
  },
  {
    capability: 'auth_tokens',
    name: 'registerBrowserSession',
    run: (u, c) => u.registerBrowserSession(c, TOKEN_HASH, Date.now() + 60_000, {
      email: 'person@example.com', displayName: null, provider: 'cloudflare', sub: 'cf-1', authTime: Date.now(),
    }),
  },
  { capability: 'auth_tokens', name: 'verifyBrowserSession', run: (u, c) => u.verifyBrowserSession(c, TOKEN_HASH) },
  { capability: 'auth_tokens', name: 'revokeBrowserSession', run: (u, c) => u.revokeBrowserSession(c, TOKEN_HASH) },
  // Refusing a workspace's own revocation check would make revocation unenforceable on its CLI sockets.
  {
    capability: 'auth_tokens.socket',
    name: 'verifyCliSocketBearer',
    run: (u, c) => u.verifyCliSocketBearer(c, TOKEN_HASH),
  },
  // Session-side twin of the row above: a workspace must still be able to enforce a logout.
  {
    capability: 'auth_tokens.socket',
    name: 'verifySocketSession',
    run: (u, c) => u.verifySocketSession(c, TOKEN_HASH),
  },
  { capability: 'auth_tokens', name: 'revokeAllCliTokens', run: (u, c) => u.revokeAllCliTokens(c) },
  {
    capability: 'credentials.model',
    name: 'getCredentialsRevision',
    run: (u, c) => u.getCredentialsRevision(c),
  },

  { capability: 'codex_auth', name: 'startCodexDeviceFlow', run: (u, c) => u.startCodexDeviceFlow(c) },
  { capability: 'codex_auth', name: 'pollCodexDeviceFlow', run: (u, c) => u.pollCodexDeviceFlow(c) },
  { capability: 'codex_auth', name: 'disconnectCodex', run: (u, c) => u.disconnectCodex(c) },
  { capability: 'codex_auth', name: 'getCodexStatus', run: (u, c) => u.getCodexStatus(c) },
];

interface OwnerOnlyCall {
  name: string;
  /** Present when the whole capability is floored at `owner_only`, so this row carries its coverage. */
  capability?: WorkspaceCapability;
  run(userDO: UserDOInstance, caller: UserCaller): Promise<AsyncUserDOResult>;
}

/**
 * Owner-only: the profile catalog is refused by its method inside `config`; the device registry and
 * device consent are `owner_only` capabilities refused before any method runs.
 */
const OWNER_ONLY_CALLS: OwnerOnlyCall[] = [
  { capability: 'account', name: 'completeOnboarding', run: (u, c) => u.completeOnboarding(c) },
  { capability: 'account', name: 'setDisplayName', run: (u, c) => u.setDisplayName(c, 'Owner') },
  { name: 'getProfileCatalog', run: (userDO, caller) => userDO.getProfileCatalog(caller) },
  // A workspace that could turn its own Sandbox off would be granting itself the whole machine (F5/F6).
  {
    name: 'setDeviceTier',
    run: (userDO: UserDOInstance, caller: UserCaller) => userDO.setDeviceTier(caller, 'dev-1', 'raw'),
  },
  {
    name: 'putProfileCatalog',
    run: (userDO, caller) => userDO.putProfileCatalog(
      caller,
      decodeJsonValue({ value: BUILTIN_PROFILE_CATALOG }),
      0,
    ),
  },

  { capability: 'device.consent', name: 'listDeviceConsents', run: (u, c) => u.listDeviceConsents(c) },
  { capability: 'device.consent', name: 'revokeDeviceConsent', run: (u, c) => u.revokeDeviceConsent(c, WORKSPACE, 'dev-1') },

  { capability: 'device.manage', name: 'listDevices', run: (u, c) => u.listDevices(c) },
  { capability: 'device.manage', name: 'registerDevice', run: (u, c) => u.registerDevice(c, 'device') },
  { capability: 'device.manage', name: 'revokeDevice', run: (u, c) => u.revokeDevice(c, 'dev-1') },
  { capability: 'device.manage', name: 'acknowledgeUnstoppedDevice', run: (u, c) => u.acknowledgeUnstoppedDevice(c, 'dev-1') },
  { capability: 'device.manage', name: 'renameDevice', run: (u, c) => u.renameDevice(c, 'dev-1', 'studio tower') },
  { capability: 'device.manage', name: 'verifyDeviceToken', run: (u, c) => u.verifyDeviceToken(c, 'pdt_x') },
  { capability: 'device.manage', name: 'verifyDeviceConnectTicket', run: (u, c) => u.verifyDeviceConnectTicket(c, 'pct_x') },
  { capability: 'device.manage', name: 'issueDeviceConnectTicket', run: (u, c) => u.issueDeviceConnectTicket(c, 'pdt_x') },

  {
    capability: 'shares',
    name: 'sharesReceived_add',
    run: (u, c) => u.sharesReceived_add(c, {
      ownerUserId: USER_ID, ownerEmail: 'owner@x', workspace: WORKSPACE,
      shareId: 'share-1', title: 'a blueprint',
    }),
  },
  { capability: 'shares', name: 'sharesReceived_list', run: (u, c) => u.sharesReceived_list(c) },
  { capability: 'shares', name: 'sharesReceived_forget', run: (u, c) => u.sharesReceived_forget(c, USER_ID) },

  { capability: 'drive', name: 'drive_list', run: (u, c) => u.drive_list(c, '/') },
  { capability: 'drive', name: 'drive_mkdir', run: (u, c) => u.drive_mkdir(c, '/x') },
  { capability: 'drive', name: 'drive_rename', run: (u, c) => u.drive_rename(c, '/x', '/y') },
  { capability: 'drive', name: 'drive_delete', run: (u, c) => u.drive_delete(c, '/x') },
  { capability: 'drive', name: 'drive_markAsSkill', run: (u, c) => u.drive_markAsSkill(c, '/x') },
  { capability: 'drive', name: 'drive_addSkill', run: (u, c) => u.drive_addSkill(c, '') },
  {
    capability: 'drive',
    name: 'drive_writeChunk',
    run: (u, c) => u.drive_writeChunk(c, {
      target: { kind: 'file', path: '/x' }, transferId: 't', offset: 0, chunk: new Uint8Array(0), final: true,
    }),
  },
  { capability: 'drive', name: 'drive_abortUpload', run: (u, c) => u.drive_abortUpload(c, 't') },
  { capability: 'drive', name: 'drive_startDownload', run: (u, c) => u.drive_startDownload(c, '/x', 't') },
  { capability: 'drive', name: 'drive_readChunk', run: (u, c) => u.drive_readChunk(c, 't', 0, 1) },
  { capability: 'drive', name: 'drive_abortDownload', run: (u, c) => u.drive_abortDownload(c, 't') },

  // Last: an owner reaching it drops the object's storage and aborts its context.
  { capability: 'account', name: 'deleteAccount', run: (u, c) => u.deleteAccount(c, USER_ID) },
];

/** Refused by the boundary, as opposed to failing for its own reasons (no device, stubbed MCP). */
async function refused(call: Pick<GatedCall, 'run'>, userDO: UserDOInstance, caller: UserCaller): Promise<boolean> {
  try {
    await call.run(userDO, caller);

    return false;
  } catch (error) {
    return error instanceof CapabilityDeniedError;
  }
}

async function setupWorkspaces(
  options: { connectedDeviceId?: string } = {},
): Promise<TestUserDO & { token: string; otherToken: string }> {
  // A responder, so a call that passes the boundary completes instead of hanging.
  const harness = createTestUserDO({ ...options, deviceResponder: daemon });
  const token = await provisionTestWorkspace(harness, WORKSPACE, 'Workspace A');
  const otherToken = await provisionTestWorkspace(harness, OTHER_WORKSPACE, 'Workspace B');

  // The real hub cannot accept a socket whose device row does not exist.
  if (options.connectedDeviceId) {
    harness.sql.exec(
      `INSERT INTO user_devices (id, token_hash, label) VALUES (?, ?, ?)`,
      options.connectedDeviceId, 'fixture-token-hash', 'fixture device',
    );
    // Reports like a daemon: a machine that has proved nothing runs no commands.
    await harness.sendDeviceHello(CAPABLE_HELLO);
  }

  return Object.assign(harness, { token, otherToken });
}

describe('a registered workspace reaches the whole surface', () => {
  test('no gated call is refused', async () => {
    const harness = await setupWorkspaces();
    const caller: UserCaller = { workspaceToken: harness.token };

    const cut: string[] = [];
    const kept: string[] = [];

    for (const call of GATED_CALLS) {
      (await refused(call, harness.userDO, caller) ? cut : kept).push(`${call.capability}:${call.name}`);
    }

    expect(cut).toEqual([]);
    expect(kept).toContain('device.rpc:deviceRpc');
    expect(kept).toContain('mcp.tools:userMcp_callTool');
    expect(kept).toContain('credentials.other:getAuthHeaders(github)');
    expect(kept).toContain('workspaces.read:listWorkspaces');
    expect(kept).toContain('workspaces.write:registerWorkspace');
    expect(kept).toContain('release:getReleaseBoard');
    expect(kept).toContain('experience.read:searchExperience');
    expect(kept).toContain('experience.write:publishExperience');
    expect(kept).toContain('profile:getProfile');
    expect(kept).toContain('auth_tokens:mintCliToken');
    expect(kept).toContain('credentials.model:getAuthHeaders(codex.oauth)');
    harness.close();
  });

  test('an owner session is never refused', async () => {
    const harness = await setupWorkspaces();
    const cut: string[] = [];

    for (const call of GATED_CALLS) {
      if (await refused(call, harness.userDO, await testOwner())) cut.push(`${call.capability}:${call.name}`);
    }

    expect(cut).toEqual([]);
    harness.close();
  });

  test('the credential store shows every key to a workspace caller', async () => {
    const harness = await setupWorkspaces();
    await harness.userDO.setCredential(await testOwner(), 'openai.bearer', { kind: 'bearer', token: 'sk-model' });
    await harness.userDO.setCredential(await testOwner(), 'github', { kind: 'bearer', token: 'ghp_secret' });
    const caller: UserCaller = { workspaceToken: harness.token };

    expect((await harness.userDO.listCredentials(caller)).map((c) => c.key)).toEqual(['github', 'openai.bearer']);
    expect(await harness.userDO.getAuthHeaders(caller, 'openai.bearer')).toEqual({ Authorization: 'Bearer sk-model' });
    expect(await harness.userDO.getAuthHeaders(caller, 'github')).toEqual({ Authorization: 'Bearer ghp_secret' });
    harness.close();
  });

  test('rename scopes to the calling workspace', async () => {
    const harness = await setupWorkspaces();
    const caller: UserCaller = { workspaceToken: harness.token };

    await harness.userDO.setWorkspaceDisplayName(caller, WORKSPACE, 'Renamed by itself', 'user');
    await expect(harness.userDO.setWorkspaceDisplayName(caller, OTHER_WORKSPACE, 'Hijacked', 'user'))
      .rejects.toThrow('may only rename itself');

    const names = (await harness.userDO.listWorkspaces(await testOwner())).entries;
    expect(names.find((w) => w.name === WORKSPACE)?.displayName).toBe('Renamed by itself');
    expect(names.find((w) => w.name === OTHER_WORKSPACE)?.displayName).toBe('Workspace B');
    harness.close();
  });

  test('sibling workspaces are admitted independently', async () => {
    const harness = await setupWorkspaces();

    const first: UserCaller = { workspaceToken: harness.token };
    const sibling: UserCaller = { workspaceToken: harness.otherToken };
    expect((await harness.userDO.listWorkspaces(first)).entries).toHaveLength(2);
    expect((await harness.userDO.listWorkspaces(sibling)).entries).toHaveLength(2);
    await expect(harness.userDO.setWorkspaceDisplayName(first, OTHER_WORKSPACE, 'Hijacked', 'user'))
      .rejects.toThrow('may only rename itself');
    harness.close();
  });

  test('the pre-existing surfaces still answer: registry, credentials, consent', async () => {
    const harness = await setupWorkspaces();
    const caller: UserCaller = { workspaceToken: harness.token };
    await harness.userDO.setCredential(await testOwner(), 'openai.bearer', { kind: 'bearer', token: 'sk-1' });

    expect((await harness.userDO.listWorkspaces(caller)).entries.map((w) => w.name).sort())
      .toEqual([WORKSPACE, OTHER_WORKSPACE]);
    expect(await harness.userDO.hasWorkspace(caller, WORKSPACE)).toBe(true);
    expect(await harness.userDO.getAuthHeaders(caller, 'openai.bearer')).toEqual({ Authorization: 'Bearer sk-1' });
    expect(await harness.userDO.getDeviceFileView(caller, WORKSPACE)).toEqual({ unconfined: false });
    harness.close();
  });
});

describe('the boundary fails closed', () => {
  /** Callers a privileged method must refuse: no identity, or a token this deployment never minted
   *  (including a workspace-shaped token in the owner's slot). */
  const badCallers: Array<{ name: string; caller: UserCaller }> = [
    { name: 'an empty owner token', caller: { ownerToken: '' } },
    { name: 'an empty workspace token', caller: { workspaceToken: '' } },
    { name: 'a workspace-shaped token in the owner slot', caller: { ownerToken: 'pwc_whatever' } },
    { name: 'an unknown workspace token', caller: { workspaceToken: 'pwc_never_minted' } },
  ];

  for (const { name, caller } of badCallers) {
    test(`${name} is refused by every privileged method`, async () => {
      const harness = await setupWorkspaces();
      const allowed: string[] = [];

      for (const call of GATED_CALLS) {
        if (!(await refused(call, harness.userDO, caller))) allowed.push(`${call.capability}:${call.name}`);
      }

      expect(allowed).toEqual([]);
      harness.close();
    });
  }

  test('a workspace that never claimed an owner reaches nothing', async () => {
    const harness = createTestUserDO();
    // The state of a DO the Worker has not yet claimed: no token to present.
    const allowed: string[] = [];

    for (const call of GATED_CALLS) {
      if (!(await refused(call, harness.userDO, { workspaceToken: 'pwc_forged' }))) {
        allowed.push(`${call.capability}:${call.name}`);
      }
    }

    expect(allowed).toEqual([]);
    harness.close();
  });

  test('deleting a workspace kills its token', async () => {
    const harness = await setupWorkspaces();
    const caller: UserCaller = { workspaceToken: harness.otherToken };
    expect((await harness.userDO.listWorkspaces(caller)).entries).toHaveLength(2);

    await harness.userDO.removeWorkspace(await testOwner(), OTHER_WORKSPACE, USER_ID);
    expect(harness.destroyedWorkspaces).toEqual([OTHER_WORKSPACE]);
    await expect(harness.userDO.listWorkspaces(caller)).rejects.toThrow('Unrecognized workspace capability token');
    harness.close();
  });
});

describe('capability provisioning', () => {
  test('provisioning issues a working identity', async () => {
    const harness = createTestUserDO();
    const token = await provisionTestWorkspace(harness, WORKSPACE, 'Workspace A');

    expect(token).toMatch(/^pwc_[A-Za-z0-9_-]{40,}$/);
    expect((await harness.userDO.listWorkspaces({ workspaceToken: token })).entries).toHaveLength(1);
    harness.close();
  });

  test('a workspace that already agrees with the registry is not re-minted', async () => {
    const harness = await setupWorkspaces();
    const hash = await sha256Hex(harness.token);

    await harness.userDO.ensureWorkspaceCapability(WORKSPACE, hash);

    expect(harness.installed.get(WORKSPACE)).toBe(harness.token);
    expect((await harness.userDO.listWorkspaces({ workspaceToken: harness.token })).entries).toHaveLength(2);
    harness.close();
  });

  test('concurrent first touches settle on ONE identity, never a split one', async () => {
    // Two invocations both reconciling without a serialization point can leave the stored hash from a
    // different mint than the installed token: a workspace that never authenticates nor re-provisions.
    const harness = createTestUserDO();
    await harness.userDO.registerWorkspace(await testOwner(), WORKSPACE, 'Workspace A');

    await Promise.all([
      harness.userDO.ensureWorkspaceCapability(WORKSPACE, null),
      harness.userDO.ensureWorkspaceCapability(WORKSPACE, null),
      harness.userDO.ensureWorkspaceCapability(WORKSPACE, null),
    ]);

    const installedToken = present(harness.installed.get(WORKSPACE), 'the installed workspace capability token');
    expect((await harness.userDO.listWorkspaces({ workspaceToken: installedToken })).entries).toHaveLength(1);
    harness.close();
  });

  test('a workspace holding a token the registry does not know is repaired', async () => {
    const harness = await setupWorkspaces();
    // The state a failed teardown leaves: the workspace kept its copy, the UserDO dropped the row.
    harness.db.prepare('DELETE FROM workspace_capability_tokens WHERE workspace_name = ?').run(WORKSPACE);

    await harness.userDO.ensureWorkspaceCapability(WORKSPACE, await sha256Hex(harness.token));

    const repaired = present(harness.installed.get(WORKSPACE), 'the repaired workspace capability token');
    expect(repaired).not.toBe(harness.token);
    expect((await harness.userDO.listWorkspaces({ workspaceToken: repaired })).entries).toHaveLength(2);
    harness.close();
  });

  test('provisioning refuses a name that is not one of this user\'s workspaces', async () => {
    const harness = await setupWorkspaces();
    await expect(harness.userDO.ensureWorkspaceCapability('not-mine', null))
      .rejects.toThrow('not in your registry');
    expect(harness.installed.has('not-mine')).toBe(false);
    harness.close();
  });

  test('a re-mint supersedes the old secret and keeps admission', async () => {
    const harness = await setupWorkspaces();
    await harness.userDO.setCredential(await testOwner(), 'openai.bearer', { kind: 'bearer', token: 'sk-model' });
    await harness.userDO.ensureWorkspaceCapability(WORKSPACE, null);
    const reminted = present(harness.installed.get(WORKSPACE), 'the re-minted workspace capability token');

    await expect(harness.userDO.listWorkspaces({ workspaceToken: harness.token }))
      .rejects.toThrow('Unrecognized workspace capability token');
    expect((await harness.userDO.listWorkspaces({ workspaceToken: reminted })).entries).toHaveLength(2);
    expect(await harness.userDO.getAuthHeaders({ workspaceToken: reminted }, 'openai.bearer'))
      .toEqual({ Authorization: 'Bearer sk-model' });
    harness.close();
  });

  test('the raw token is never persisted in the UserDO', async () => {
    const harness = await setupWorkspaces();
    const rows = harness.db.prepare('SELECT * FROM workspace_capability_tokens').all();
    expect(JSON.stringify(rows)).not.toContain(harness.token);
    expect(JSON.stringify(rows)).not.toContain(harness.otherToken);
    harness.close();
  });
});

describe('workspace name reservation', () => {
  /** Raw SQL rows: a reservation is invisible to owner-visible reads until published (KINU-027). */
  const rosterRows = (harness: TestUserDO): string[] => harness.db
    .prepare<{ name: string }, []>(`SELECT name FROM user_workspaces ORDER BY name`)
    .all().map((row) => row.name);

  test('a fork conflict leaves an archived roster row byte-for-byte unchanged', async () => {
    const harness = createTestUserDO();
    const owner = await testOwner();
    await harness.userDO.registerWorkspace(owner, 'archived-name', 'Archived title');
    harness.db.prepare(
      'UPDATE user_workspaces SET archived_at = ?, last_visited = ? WHERE name = ?',
    ).run(777, 123, 'archived-name');

    const before = harness.db.prepare(
      'SELECT * FROM user_workspaces WHERE name = ?',
    ).get('archived-name');

    const result = await harness.userDO.reserveWorkspace(owner, 'archived-name', 'Fork title');

    const after = harness.db.prepare(
      'SELECT * FROM user_workspaces WHERE name = ?',
    ).get('archived-name');

    expect(result.reserved).toBe(false);
    expect(after).toEqual(before);
    harness.close();
  });

  test('releases only the exact row created by the reservation', async () => {
    const harness = createTestUserDO();
    const owner = await testOwner();
    const reserved = await harness.userDO.reserveWorkspace(owner, 'fork-reservation', 'Fork title');

    expect(await harness.userDO.releaseWorkspaceReservation(owner, 'fork-reservation', reserved.entry.createdAt + 1)).toBe(false);
    expect(rosterRows(harness)).toEqual(['fork-reservation']);
    expect(await harness.userDO.releaseWorkspaceReservation(owner, 'fork-reservation', reserved.entry.createdAt)).toBe(true);
    expect(rosterRows(harness)).toEqual([]);
    harness.close();
  });
});

describe('facets attenuate with their workspace', () => {
  // Facets present the parent workspace's token, so identity follows the workspace. These need a live
  // device: otherwise device methods short-circuit before the identity substitution.
  test('device consent answers for the PROVEN workspace, not the name the caller passed', async () => {
    const harness = await setupWorkspaces({ connectedDeviceId: 'dev-1' });
    const facetCaller: UserCaller = { workspaceToken: harness.token };
    harness.consentDecision = 'always';
    await harness.userDO.deviceRpc(facetCaller, 'readFile', ['/tmp/a'], { agentName: WORKSPACE });
    expect(await harness.userDO.setDeviceTier(await testOwner(), 'dev-1', 'raw')).toEqual({ ok: true });

    // A facet naming anything still gets workspace-a's answer: its identity is the token, not the argument.
    expect(await harness.userDO.getDeviceFileView(facetCaller, 'some-facet-name'))
      .toEqual({ unconfined: true });
    expect(await harness.userDO.getDeviceFileView(facetCaller, OTHER_WORKSPACE))
      .toEqual({ unconfined: true });

    const sibling: UserCaller = { workspaceToken: harness.otherToken };
    expect(await harness.userDO.getDeviceFileView(sibling, WORKSPACE))
      .toEqual({ unconfined: false });
    harness.close();
  });

  test('a workspace cannot ride a sibling\'s remembered device grant', async () => {
    const harness = await setupWorkspaces({ connectedDeviceId: 'dev-1' });
    harness.consentDecision = 'always';
    await harness.userDO.deviceRpc({ workspaceToken: harness.token }, 'readFile', ['/tmp/a'], { agentName: WORKSPACE });
    harness.consentDecision = 'deny';
    const sibling: UserCaller = { workspaceToken: harness.otherToken };

    // Consent resolves against the proven caller, so a borrowed claim is asked, not waved through.
    await expect(harness.userDO.deviceRpc(sibling, 'exec', ['ls'], { agentName: WORKSPACE }))
      .rejects.toThrow('device use was not approved');
    expect(harness.consentPrompts.filter((p) => p.workspace === OTHER_WORKSPACE)).toEqual([{
      workspace: OTHER_WORKSPACE,
      method: 'exec',
      command: 'ls',
      workspaceName: OTHER_WORKSPACE,
    }]);

    const consents = await harness.userDO.listDeviceConsents(await testOwner());
    expect(consents.map((c) => c.agentName)).toEqual([WORKSPACE]);
    harness.close();
  });

  test('a facet resolves as its parent workspace, live', async () => {
    const harness = await setupWorkspaces();
    const facetCaller: UserCaller = { workspaceToken: harness.token };
    expect((await harness.userDO.listWorkspaces(facetCaller)).entries).toHaveLength(2);

    // No re-issue: the registry answers current state on every call.
    await harness.userDO.setWorkspaceDisplayName(facetCaller, WORKSPACE, 'Renamed by its facet', 'user');
    await expect(harness.userDO.setWorkspaceDisplayName(facetCaller, OTHER_WORKSPACE, 'Hijacked', 'user'))
      .rejects.toThrow('may only rename itself');
    const names = (await harness.userDO.listWorkspaces(await testOwner())).entries;
    expect(names.find((w) => w.name === WORKSPACE)?.displayName).toBe('Renamed by its facet');
    harness.close();
  });

  test('a facet cannot name a different workspace to escape its parent', async () => {
    const harness = await setupWorkspaces();
    const facetCaller: UserCaller = { workspaceToken: harness.token };

    await expect(harness.userDO.setWorkspaceDisplayName(facetCaller, OTHER_WORKSPACE, 'Hijacked', 'user'))
      .rejects.toThrow('may only rename itself');
    harness.close();
  });
});

// Completeness, held by the compiler: a new RPC method must take the caller first or be exempted here.

/** Dispatched by the runtime or the SDK, never by a stub-holder with a caller. */
const RUNTIME_DISPATCHED = new Set([
  'fetch', '__unsafe_ensureInitialized', 'alarm', 'webSocketMessage', 'webSocketClose', 'webSocketError',
]);

/** Cannot take a caller: it bootstraps caller identity. Safe by shape, not by gate. */
const IDENTITY_BOOTSTRAP = 'ensureWorkspaceCapability';

/** The first parameter of a method, or `never` when it takes none. */
type FirstParameter<F> = F extends (...args: infer A) => void ? (A extends [infer First, ...unknown[]] ? First : never) : never;

/** `true` when `F` takes exactly a `UserCaller` first. */
type TakesCallerFirst<F> = [FirstParameter<F>] extends [UserCaller]
  ? ([UserCaller] extends [FirstParameter<F>] ? true : false)
  : false;

type UngatedRpcMethod = {
  [K in Exclude<UserDoRpcMethod, typeof IDENTITY_BOOTSTRAP>]: TakesCallerFirst<UserDO[K]> extends true ? never : K
}[Exclude<UserDoRpcMethod, typeof IDENTITY_BOOTSTRAP>];

/** `true` when `Names` is empty; otherwise the names, so the compiler error lists them. */
type NoneOf<Names> = [Names] extends [never] ? true : Names;

const everyRpcMethodTakesTheCallerFirst: NoneOf<UngatedRpcMethod> = true;

describe('no privileged UserDO method escapes the gate', () => {
  test('every RPC method takes the caller first, or is the identity bootstrap', () => {
    expect(everyRpcMethodTakesTheCallerFirst).toBe(true);
  });

  test('owner-only profile writes reject every workspace token and accept an owner session', async () => {
    const harness = await setupWorkspaces();
    const workspace: UserCaller = { workspaceToken: harness.token };

    for (const call of OWNER_ONLY_CALLS) {
      expect(await refused(call, harness.userDO, workspace)).toBe(true);
      expect(await refused(call, harness.userDO, await testOwner())).toBe(false);
    }

    harness.close();
  });

  test('every gated method is exercised by the lists above', () => {
    const gated = USER_DO_RPC_SURFACE.filter((name) => !RUNTIME_DISPATCHED.has(name) && name !== IDENTITY_BOOTSTRAP);

    const exercised = new Set([
      ...GATED_CALLS.map((call) => call.name.replace(/\(.*$/u, '')),
      ...OWNER_ONLY_CALLS.map((call) => call.name),
    ]);

    expect(gated.length).toBeGreaterThan(20);
    expect(gated.filter((name) => !exercised.has(name)).sort()).toEqual([]);
  });
});
