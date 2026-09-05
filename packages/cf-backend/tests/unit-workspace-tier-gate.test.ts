// The attenuation boundary, exercised against the REAL UserDO methods.
//
// A registered workspace reaches every capability except the account
// authorities the matrix marks `owner_only`. What this pins down is that each
// method actually passes through the gate — and that the agent can still
// think, because model-inference credentials resolve.
//
// Every entry below names a real method. A denial is a CapabilityDeniedError;
// anything else (a missing device, an unknown change id, a stubbed MCP client)
// means the gate let the call through, which is what "allowed" asserts.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestUserDO, provisionTestWorkspace, testOwner, type TestUserDO } from './helpers/user-do';
import { CAPABLE_HELLO, daemon } from './helpers/device-harness';
import { declaredClassMembers, isInternalMember } from './helpers/declared-members';
import { sha256Hex } from '../src/lib/crypto';
import { BUILTIN_PROFILE_CATALOG, decodeJsonValue } from '@kinu.run/core';
import {
  CapabilityDeniedError,
  type UserCaller,
  type WorkspaceCapability,
} from '../src/user/workspace-capability';

const WORKSPACE = 'workspace-a';
const OTHER_WORKSPACE = 'workspace-b';
const USER_ID = '0123456789abcdef0123456789abcdef';
const TOKEN_HASH = 'a'.repeat(64);

// No test here should reach the network; a provider/OAuth call that survives
// the gate must fail loudly rather than dial out.
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

/**
 * The attenuation matrix as calls. One row per privileged method — grouped by
 * the capability it names — so "is the matrix complete" is answerable by
 * reading this list against the design's table.
 */
const GATED_CALLS: GatedCall[] = [
  // Model providers — the agent must still function, and these headers attach
  // inside trusted DO code, never in LLM context.
  { capability: 'credentials.model', name: 'getAuthHeaders(codex.oauth)', run: (u, c) => u.getAuthHeaders(c, 'codex.oauth') },
  { capability: 'credentials.model', name: 'getAuthHeaders(openai.bearer)', run: (u, c) => u.getAuthHeaders(c, 'openai.bearer') },
  { capability: 'credentials.model', name: 'getCredentialBaseURL(openai-compat.box)', run: (u, c) => u.getCredentialBaseURL(c, 'openai-compat.box') },
  { capability: 'credentials.model', name: 'listCredentials', run: (u, c) => u.listCredentials(c) },
  { capability: 'credentials.model', name: 'listConnectedProviders', run: (u, c) => u.listConnectedProviders(c) },

  // Everything else in the credential store.
  { capability: 'credentials.other', name: 'getAuthHeaders(github)', run: (u, c) => u.getAuthHeaders(c, 'github') },
  { capability: 'credentials.other', name: 'getCredentialBaseURL(github)', run: (u, c) => u.getCredentialBaseURL(c, 'github') },
  { capability: 'credentials.other', name: 'setCredential', run: (u, c) => u.setCredential(c, 'github', { kind: 'bearer', token: 'ghp_x' }) },
  { capability: 'credentials.other', name: 'deleteCredential', run: (u, c) => u.deleteCredential(c, 'github') },

  // The egress secret vault. Binding one of the owner's secrets to a host is
  // the same class of act as storing a credential, and turning a placeholder
  // back into the real secret is strictly more privileged than holding it.
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

  // `device.consent.read_self` answers for the calling workspace: the file view
  // narrows its own path scope with the answer, so refusing it would widen the
  // scope rather than close it. Every other device method is an account
  // authority and lives in OWNER_ONLY_CALLS below.
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
  { capability: 'release', name: 'decideReleaseApproval', run: (u, c) => u.decideReleaseApproval(c, 'ap_1', 'approved', USER_ID) },
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
  // The frame-time revocation check a workspace runs on its own CLI sockets.
  // A workspace that could not ask would either keep serving a revoked CLI or
  // lose its CLI entirely, so refusing here would make revocation
  // unenforceable exactly where the workspace is least trusted.
  {
    capability: 'auth_tokens.socket',
    name: 'verifyCliSocketBearer',
    run: (u, c) => u.verifyCliSocketBearer(c, TOKEN_HASH),
  },
  // The session-side twin of the row above: same reasoning — a workspace must
  // still be able to enforce a logout.
  {
    capability: 'auth_tokens.socket',
    name: 'verifySocketSession',
    run: (u, c) => u.verifySocketSession(c, TOKEN_HASH),
  },
  // The orphaned-bearer recovery surface: naming what is still live and ending
  // it is account administration, exactly as every other auth_tokens write is.
  { capability: 'auth_tokens', name: 'revokeAllCliTokens', run: (u, c) => u.revokeAllCliTokens(c) },
  // The credential revision compare a cached provider listing is held against —
  // a number about state the workspace already depends on, like the socket row.
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
  /** Present when the whole CAPABILITY is floored at `owner_only`, so this row
   *  also carries that capability's coverage. Absent for an owner-only method
   *  inside a capability workspaces do legitimately use. */
  capability?: WorkspaceCapability;
  run(userDO: UserDOInstance, caller: UserCaller): Promise<AsyncUserDOResult>;
}

/**
 * Methods no workspace token reaches at all, and an owner session does.
 *
 * Two kinds sit here and the difference is where the rule is written. The
 * profile catalog is an owner-only METHOD inside `config`, a capability
 * workspaces do use, so the check is in the method. The device registry and
 * device consent are owner-only CAPABILITIES: the matrix floors both at
 * `owner_only` and refuses them before any method runs.
 */
const OWNER_ONLY_CALLS: OwnerOnlyCall[] = [
  { name: 'getProfileCatalog', run: (userDO, caller) => userDO.getProfileCatalog(caller) },
  // The device Sandbox switch. A workspace holds no device authority at all
  // after F5/F6; this one additionally names the reason it can never move to a
  // workspace: a workspace that could turn its own sandbox off would be
  // granting itself the whole machine.
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

  // Writing a grant is granting the owner's machine away, and reading the
  // roster hands over every other workspace's grants too.
  { capability: 'device.consent', name: 'listDeviceConsents', run: (u, c) => u.listDeviceConsents(c) },
  { capability: 'device.consent', name: 'revokeDeviceConsent', run: (u, c) => u.revokeDeviceConsent(c, WORKSPACE, 'dev-1') },

  // The registry and the daemon's own credential exchange.
  { capability: 'device.manage', name: 'listDevices', run: (u, c) => u.listDevices(c) },
  { capability: 'device.manage', name: 'registerDevice', run: (u, c) => u.registerDevice(c, 'laptop') },
  { capability: 'device.manage', name: 'revokeDevice', run: (u, c) => u.revokeDevice(c, 'dev-1') },
  { capability: 'device.manage', name: 'acknowledgeUnstoppedDevice', run: (u, c) => u.acknowledgeUnstoppedDevice(c, 'dev-1') },
  { capability: 'device.manage', name: 'renameDevice', run: (u, c) => u.renameDevice(c, 'dev-1', 'studio tower') },
  { capability: 'device.manage', name: 'verifyDeviceToken', run: (u, c) => u.verifyDeviceToken(c, 'pdt_x') },
  { capability: 'device.manage', name: 'issueDeviceConnectTicket', run: (u, c) => u.issueDeviceConnectTicket(c, 'pdt_x') },
  { capability: 'device.manage', name: 'verifyDeviceConnectTicket', run: (u, c) => u.verifyDeviceConnectTicket(c, 'pct_x') },
];

/** Did the boundary refuse this call, as opposed to the call failing for its
 *  own reasons (no device connected, unknown change id, stubbed MCP client)? */
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
  // A responder, so a call that PASSES the boundary completes instead of
  // hanging on a socket nobody listens to — the fixture cannot seed a binding
  // through the card the owner actually answers otherwise.
  const harness = createTestUserDO({ ...options, deviceResponder: daemon });
  const token = await provisionTestWorkspace(harness, WORKSPACE, 'Workspace A');
  const otherToken = await provisionTestWorkspace(harness, OTHER_WORKSPACE, 'Workspace B');
  // A connected socket must belong to a registered device row. The real hub
  // cannot accept a slot whose row does not exist; the old fixture only
  // attached the socket, so deviceRpc quite correctly read "no device
  // connected" before it ever reached the sibling-consent assertion.
  if (options.connectedDeviceId) {
    harness.sql.exec(
      `INSERT INTO user_devices (id, token_hash, label) VALUES (?, ?, ?)`,
      options.connectedDeviceId, 'fixture-token-hash', 'fixture device',
    );
    // And it reports like a daemon: a machine that has proved nothing runs no
    // commands, which would refuse these calls for a reason this suite is not
    // about.
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
    // Named explicitly so the reach is legible, not just counted.
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
  type MalformedCaller = string | { workspaceToken: string } | undefined;
  const badCallers: Array<{ name: string; caller: MalformedCaller }> = [
    { name: 'no token at all', caller: undefined },
    { name: 'an empty token', caller: { workspaceToken: '' } },
    { name: 'a token-shaped string in the wrong place', caller: 'pwc_whatever' },
    { name: 'an unknown token', caller: { workspaceToken: 'pwc_never_minted' } },
  ];

  for (const { name, caller } of badCallers) {
    test(`${name} is refused by every privileged method`, async () => {
      const harness = await setupWorkspaces();
      const allowed: string[] = [];
      for (const call of GATED_CALLS) {
        // SAFETY: `badCallers` is the locally constructed fixture union above;
        // this deliberate type violation crosses only the runtime trust gate
        // under test, which must reject every value before using its fields.
        const untrustedCaller = caller as UserCaller;
        if (!(await refused(call, harness.userDO, untrustedCaller))) allowed.push(`${call.capability}:${call.name}`);
      }
      expect(allowed).toEqual([]);
      harness.close();
    });
  }

  test('a workspace that never claimed an owner reaches nothing', async () => {
    const harness = createTestUserDO();
    // No registerWorkspace, no mint — exactly the state of a DO the Worker has
    // not yet claimed. There is no token it could present.
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
    // Two Worker invocations both see "no token" and both reconcile. Without a
    // serialization point each mints and each installs, and the surviving
    // stored hash can belong to a different mint than the surviving installed
    // token — a workspace that can never authenticate and never re-provisions,
    // because it does hold a token.
    const harness = createTestUserDO();
    await harness.userDO.registerWorkspace(await testOwner(), WORKSPACE, 'Workspace A');

    await Promise.all([
      harness.userDO.ensureWorkspaceCapability(WORKSPACE, null),
      harness.userDO.ensureWorkspaceCapability(WORKSPACE, null),
      harness.userDO.ensureWorkspaceCapability(WORKSPACE, null),
    ]);

    const installedToken = harness.installed.get(WORKSPACE)!;
    expect((await harness.userDO.listWorkspaces({ workspaceToken: installedToken })).entries).toHaveLength(1);
    harness.close();
  });

  test('a workspace holding a token the registry does not know is repaired', async () => {
    const harness = await setupWorkspaces();
    // Exactly the state a failed teardown leaves behind: the workspace kept its
    // copy while the UserDO dropped the row.
    harness.db.prepare('DELETE FROM workspace_capability_tokens WHERE workspace_name = ?').run(WORKSPACE);

    await harness.userDO.ensureWorkspaceCapability(WORKSPACE, await sha256Hex(harness.token));

    const repaired = harness.installed.get(WORKSPACE)!;
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
    const reminted = harness.installed.get(WORKSPACE)!;

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
  /** The roster rows as SQL sees them. A reservation is invisible to every
   *  owner-visible read until it is published (KINU-027), so the listing cannot
   *  answer whether a release left the row alone — only the row can. */
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
  // A subordinate or head presents the PARENT workspace's token (pushed at
  // spawn, refreshed on reissue — see unit-subordinates / unit-facet-spawn).
  // What that BUYS is here: the token resolves as the parent no matter who
  // holds it, so scoping follows the workspace and no facet carries identity
  // of its own. These need a LIVE device: without one the device methods
  // short-circuit on "no device connected" before ever reaching the identity
  // substitution, and the assertions below would hold whether or not it
  // existed.
  test('device consent answers for the PROVEN workspace, not the name the caller passed', async () => {
    const harness = await setupWorkspaces({ connectedDeviceId: 'dev-1' });
    const facetCaller: UserCaller = { workspaceToken: harness.token };
    // workspace-a is bound to the machine, and the owner has turned that
    // device's Sandbox switch off — the two facts that lift the file view.
    harness.consentDecision = 'always';
    await harness.userDO.deviceRpc(facetCaller, 'readFile', ['/tmp/a'], { agentName: WORKSPACE });
    expect(await harness.userDO.setDeviceTier(await testOwner(), 'dev-1', 'raw')).toEqual({ ok: true });

    // A facet of workspace-a naming anything at all still gets workspace-a's
    // answer — its identity is the token, not the argument.
    expect(await harness.userDO.getDeviceFileView(facetCaller, 'some-facet-name'))
      .toEqual({ unconfined: true });
    expect(await harness.userDO.getDeviceFileView(facetCaller, OTHER_WORKSPACE))
      .toEqual({ unconfined: true });

    // …and workspace-b cannot read workspace-a's grant by naming it.
    const sibling: UserCaller = { workspaceToken: harness.otherToken };
    expect(await harness.userDO.getDeviceFileView(sibling, WORKSPACE))
      .toEqual({ unconfined: false });
    harness.close();
  });

  test('a workspace cannot ride a sibling\'s remembered device grant', async () => {
    const harness = await setupWorkspaces({ connectedDeviceId: 'dev-1' });
    // workspace-a has already said "always" for this device.
    harness.consentDecision = 'always';
    await harness.userDO.deviceRpc({ workspaceToken: harness.token }, 'readFile', ['/tmp/a'], { agentName: WORKSPACE });
    harness.consentDecision = 'deny';
    const sibling: UserCaller = { workspaceToken: harness.otherToken };

    // workspace-b calls while CLAIMING to be workspace-a. Consent is resolved
    // against the proven caller, so it is asked rather than waved through — and
    // this harness's workspace refuses.
    await expect(harness.userDO.deviceRpc(sibling, 'exec', ['ls'], { agentName: WORKSPACE }))
      .rejects.toThrow('device use was not approved');
    expect(harness.consentPrompts.filter((p) => p.workspace === OTHER_WORKSPACE)).toEqual([{
      workspace: OTHER_WORKSPACE,
      method: 'exec',
      command: 'ls',
      workspaceName: OTHER_WORKSPACE,
    }]);

    // The remembered grant still belongs to workspace-a alone; being asked did
    // not create one for the caller that tried to borrow it.
    const consents = await harness.userDO.listDeviceConsents(await testOwner());
    expect(consents.map((c) => c.agentName)).toEqual([WORKSPACE]);
    harness.close();
  });

  test('a facet resolves as its parent workspace, live', async () => {
    const harness = await setupWorkspaces();
    const facetCaller: UserCaller = { workspaceToken: harness.token };
    expect((await harness.userDO.listWorkspaces(facetCaller)).entries).toHaveLength(2);

    // Same token, same facet, no re-issue anywhere: the registry answers
    // current state on every call.
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

    // Name arguments stay scoped to the proven workspace: the file view answers
    // from the proven grant (pinned with a live device above), and a rename
    // names its own workspace or fails.
    await expect(harness.userDO.setWorkspaceDisplayName(facetCaller, OTHER_WORKSPACE, 'Hijacked', 'user'))
      .rejects.toThrow('may only rename itself');
    harness.close();
  });
});

// ── Completeness ────────────────────────────────────────────────────────────
// The lists above are only as good as their coverage of the class. This reads
// the source so a privileged method added later must either take the caller or
// be deliberately exempted — it cannot quietly ship ungated.

const USER_DO_SOURCE = readFileSync(join(import.meta.dir, '..', 'src', 'user', 'user-do.ts'), 'utf8');

/** Not RPC: the Durable Object runtime calls these, never a stub-holder. */
const NON_RPC_METHODS = new Set(['fetch', 'webSocketMessage', 'webSocketClose', 'webSocketError']);

/** The one method that cannot take a caller, because it IS the bootstrap of
 *  caller identity. Safe by shape rather than by gate — see its own tests
 *  below and the contract asserted here. */
const IDENTITY_BOOTSTRAP = 'ensureWorkspaceCapability';

const declaredMembers = () => declaredClassMembers(USER_DO_SOURCE);

describe('no privileged UserDO method escapes the gate', () => {
  test('every externally-callable member takes the caller first, or is an explicit exception', () => {
    const ungated = declaredMembers()
      .filter((m) => !isInternalMember(m))
      .filter((m) => !NON_RPC_METHODS.has(m.name) && m.name !== IDENTITY_BOOTSTRAP)
      .filter((m) => !m.params.startsWith('caller: UserCaller'))
      .map((m) => m.name);
    expect(ungated).toEqual([]);
  });

  test('the check sees the method shapes someone might actually add', () => {
    // Guards the guard: a regex that only matched `async foo(` would let a
    // getter, a plain method, or a `public async` one through ungated.
    const declared = declaredMembers();
    const named = (name: string) => declared.some((m) => m.name === name);
    expect(named('getAuthHeaders')).toBe(true);              // async, no modifier
    expect(named('fetch')).toBe(true);                       // override async
    expect(named('requireTier')).toBe(true);                 // private, non-async
    expect(named('credentialSummaries')).toBe(true);         // private, non-async
    expect(declared.filter(isInternalMember).length).toBeGreaterThan(5);
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
    const declared = new Set(
      declaredMembers()
        .filter((m) => !isInternalMember(m) && m.params.startsWith('caller: UserCaller'))
        .map((m) => m.name),
    );
    const exercised = new Set([
      ...GATED_CALLS.map((call) => call.name.replace(/\(.*$/u, '')),
      ...OWNER_ONLY_CALLS.map((call) => call.name),
    ]);
    expect([...declared].filter((name) => !exercised.has(name)).sort()).toEqual([]);
  });

});
