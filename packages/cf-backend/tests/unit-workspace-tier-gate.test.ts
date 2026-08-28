// The attenuation boundary, exercised against the REAL UserDO methods.
//
// Wave B1 ships with every workspace `full`, so nothing here changes observable
// behaviour today; what it pins down is that when a workspace IS tainted, each
// capability the design's matrix cuts is actually cut at the UserDO — and that
// the agent can still think, because model-inference credentials survive.
//
// Every entry below names a real method. A denial is a CapabilityDeniedError;
// anything else (a missing device, an unknown change id, a stubbed MCP client)
// means the gate let the call through, which is what "allowed" asserts.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestUserDO, provisionTestWorkspace, testOwner, type TestUserDO } from './helpers/user-do';
import { declaredClassMembers, isInternalMember } from './helpers/declared-members';
import { sha256Hex } from '../src/lib/crypto';
import { BUILTIN_PROFILE_CATALOG, decodeJsonValue } from '@kinu.run/core';
import {
  CapabilityDeniedError,
  WORKSPACE_CAPABILITY_TIERS,
  setWorkspaceTier,
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
  // Model providers — kept at both tiers: the agent must still function, and
  // these headers attach inside trusted DO code, never in LLM context.
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

  { capability: 'device.consent', name: 'getDeviceFsConsent', run: (u, c) => u.getDeviceFsConsent(c, WORKSPACE) },
  { capability: 'device.consent', name: 'setDeviceConsentScope', run: (u, c) => u.setDeviceConsentScope(c, WORKSPACE, 'dev-1', 'all_local_actions') },
  { capability: 'device.consent', name: 'listDeviceConsents', run: (u, c) => u.listDeviceConsents(c) },
  { capability: 'device.consent', name: 'revokeDeviceConsent', run: (u, c) => u.revokeDeviceConsent(c, WORKSPACE, 'dev-1') },

  { capability: 'device.manage', name: 'listDevices', run: (u, c) => u.listDevices(c) },
  { capability: 'device.manage', name: 'registerDevice', run: (u, c) => u.registerDevice(c, 'laptop') },
  { capability: 'device.manage', name: 'revokeDevice', run: (u, c) => u.revokeDevice(c, 'dev-1') },
  { capability: 'device.manage', name: 'acknowledgeUnstoppedDevice', run: (u, c) => u.acknowledgeUnstoppedDevice(c, 'dev-1') },
  { capability: 'device.rpc', name: 'transferDeviceRequestToBackgroundJob', run: (u, c) => u.transferDeviceRequestToBackgroundJob(c, 'rpc-1', 'job-1') },
  { capability: 'device.manage', name: 'renameDevice', run: (u, c) => u.renameDevice(c, 'dev-1', 'studio tower') },
  { capability: 'device.manage', name: 'verifyDeviceToken', run: (u, c) => u.verifyDeviceToken(c, 'pdt_x') },
  { capability: 'device.manage', name: 'issueDeviceConnectTicket', run: (u, c) => u.issueDeviceConnectTicket(c, 'pdt_x') },
  { capability: 'device.manage', name: 'verifyDeviceConnectTicket', run: (u, c) => u.verifyDeviceConnectTicket(c, 'pct_x') },

  { capability: 'workspaces.read', name: 'listWorkspaces', run: (u, c) => u.listWorkspaces(c) },
  { capability: 'workspaces.read', name: 'listActiveWorkspaces', run: (u, c) => u.listActiveWorkspaces(c) },
  { capability: 'workspaces.read', name: 'hasWorkspace', run: (u, c) => u.hasWorkspace(c, OTHER_WORKSPACE) },

  { capability: 'workspaces.write', name: 'registerWorkspace', run: (u, c) => u.registerWorkspace(c, 'spawned') },
  { capability: 'workspaces.write', name: 'reserveWorkspace', run: (u, c) => u.reserveWorkspace(c, 'reserved') },
  { capability: 'workspaces.write', name: 'releaseWorkspaceReservation', run: (u, c) => u.releaseWorkspaceReservation(c, 'reserved', 1) },
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

  { capability: 'auth_tokens', name: 'mintCliToken', run: (u, c) => u.mintCliToken(c, USER_ID) },
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
    run: (u, c) => u.registerBrowserSession(c, TOKEN_HASH, Date.now() + 60_000),
  },
  { capability: 'auth_tokens', name: 'verifyBrowserSession', run: (u, c) => u.verifyBrowserSession(c, TOKEN_HASH) },
  { capability: 'auth_tokens', name: 'revokeBrowserSession', run: (u, c) => u.revokeBrowserSession(c, TOKEN_HASH) },

  { capability: 'codex_auth', name: 'startCodexDeviceFlow', run: (u, c) => u.startCodexDeviceFlow(c) },
  { capability: 'codex_auth', name: 'pollCodexDeviceFlow', run: (u, c) => u.pollCodexDeviceFlow(c) },
  { capability: 'codex_auth', name: 'disconnectCodex', run: (u, c) => u.disconnectCodex(c) },
  { capability: 'codex_auth', name: 'getCodexStatus', run: (u, c) => u.getCodexStatus(c) },
];

const OWNER_ONLY_CALLS = [
  { name: 'getProfileCatalog', run: (userDO: UserDOInstance, caller: UserCaller) => userDO.getProfileCatalog(caller) },
  {
    name: 'putProfileCatalog',
    run: (userDO: UserDOInstance, caller: UserCaller) => userDO.putProfileCatalog(
      caller,
      decodeJsonValue({ value: BUILTIN_PROFILE_CATALOG }),
      0,
    ),
  },
] as const;

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
): Promise<TestUserDO & { fullToken: string; otherToken: string }> {
  const harness = createTestUserDO(options);
  const fullToken = await provisionTestWorkspace(harness, WORKSPACE, 'Workspace A');
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
  }
  return Object.assign(harness, { fullToken, otherToken });
}

describe('a tainted workspace loses exactly the capabilities the matrix cuts', () => {
  test('every cut capability is refused, and model inference still works', async () => {
    const harness = await setupWorkspaces();
    setWorkspaceTier(harness.sql, WORKSPACE, 'shared');
    const caller: UserCaller = { workspaceToken: harness.fullToken };

    const cut: string[] = [];
    const kept: string[] = [];
    for (const call of GATED_CALLS) {
      (await refused(call, harness.userDO, caller) ? cut : kept).push(`${call.capability}:${call.name}`);
    }

    const expectedKept = GATED_CALLS
      .filter((c) => WORKSPACE_CAPABILITY_TIERS[c.capability] === 'shared')
      .map((c) => `${c.capability}:${c.name}`);
    expect(kept.sort()).toEqual(expectedKept.sort());
    expect(cut).toHaveLength(GATED_CALLS.length - expectedKept.length);
    // Named explicitly so the confinement is legible, not just counted.
    expect(cut).toContain('device.rpc:deviceRpc');
    expect(cut).toContain('mcp.tools:userMcp_callTool');
    expect(cut).toContain('credentials.other:getAuthHeaders(github)');
    expect(cut).toContain('workspaces.read:listWorkspaces');
    expect(cut).toContain('workspaces.write:registerWorkspace');
    expect(cut).toContain('release:getReleaseBoard');
    expect(cut).toContain('experience.read:searchExperience');
    expect(cut).toContain('experience.write:publishExperience');
    expect(cut).toContain('profile:getProfile');
    expect(cut).toContain('auth_tokens:mintCliToken');
    expect(kept).toContain('credentials.model:getAuthHeaders(codex.oauth)');
    harness.close();
  });

  test('the credential store hides non-model keys from a tainted workspace', async () => {
    const harness = await setupWorkspaces();
    await harness.userDO.setCredential(await testOwner(), 'openai.bearer', { kind: 'bearer', token: 'sk-model' });
    await harness.userDO.setCredential(await testOwner(), 'github', { kind: 'bearer', token: 'ghp_secret' });
    const caller: UserCaller = { workspaceToken: harness.fullToken };

    expect((await harness.userDO.listCredentials(caller)).map((c) => c.key)).toEqual(['github', 'openai.bearer']);

    setWorkspaceTier(harness.sql, WORKSPACE, 'shared');
    expect((await harness.userDO.listCredentials(caller)).map((c) => c.key)).toEqual(['openai.bearer']);
    expect(await harness.userDO.getAuthHeaders(caller, 'openai.bearer')).toEqual({ Authorization: 'Bearer sk-model' });
    await expect(harness.userDO.getAuthHeaders(caller, 'github')).rejects.toThrow(CapabilityDeniedError);
    harness.close();
  });

  test('rename survives tainting but only for the calling workspace', async () => {
    const harness = await setupWorkspaces();
    setWorkspaceTier(harness.sql, WORKSPACE, 'shared');
    const caller: UserCaller = { workspaceToken: harness.fullToken };

    await harness.userDO.setWorkspaceDisplayName(caller, WORKSPACE, 'Renamed by itself', 'user');
    await expect(harness.userDO.setWorkspaceDisplayName(caller, OTHER_WORKSPACE, 'Hijacked', 'user'))
      .rejects.toThrow('may only rename itself');

    const names = (await harness.userDO.listWorkspaces(await testOwner())).entries;
    expect(names.find((w) => w.name === WORKSPACE)?.displayName).toBe('Renamed by itself');
    expect(names.find((w) => w.name === OTHER_WORKSPACE)?.displayName).toBe('Workspace B');
    harness.close();
  });

  test('tainting one workspace leaves its sibling at full reach', async () => {
    const harness = await setupWorkspaces();
    setWorkspaceTier(harness.sql, WORKSPACE, 'shared');

    const tainted: UserCaller = { workspaceToken: harness.fullToken };
    const sibling: UserCaller = { workspaceToken: harness.otherToken };
    await expect(harness.userDO.listWorkspaces(tainted)).rejects.toThrow(CapabilityDeniedError);
    expect((await harness.userDO.listWorkspaces(sibling)).entries).toHaveLength(2);
    harness.close();
  });
});

describe('a full workspace behaves exactly as before', () => {
  test('no capability is refused', async () => {
    const harness = await setupWorkspaces();
    const caller: UserCaller = { workspaceToken: harness.fullToken };

    const cut: string[] = [];
    for (const call of GATED_CALLS) {
      if (await refused(call, harness.userDO, caller)) cut.push(`${call.capability}:${call.name}`);
    }
    expect(cut).toEqual([]);
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

  test('the pre-existing surfaces still answer: registry, credentials, consent', async () => {
    const harness = await setupWorkspaces();
    const caller: UserCaller = { workspaceToken: harness.fullToken };
    await harness.userDO.setCredential(await testOwner(), 'openai.bearer', { kind: 'bearer', token: 'sk-1' });

    expect((await harness.userDO.listWorkspaces(caller)).entries.map((w) => w.name).sort())
      .toEqual([WORKSPACE, OTHER_WORKSPACE]);
    expect(await harness.userDO.hasWorkspace(caller, WORKSPACE)).toBe(true);
    expect(await harness.userDO.getAuthHeaders(caller, 'openai.bearer')).toEqual({ Authorization: 'Bearer sk-1' });
    expect(await harness.userDO.getDeviceFsConsent(caller, WORKSPACE)).toEqual({ fullFilesystem: false });
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

  test('a valid token whose registry row is gone is refused, not defaulted to full', async () => {
    const harness = await setupWorkspaces();
    harness.db.prepare('DELETE FROM workspace_tiers WHERE workspace_name = ?').run(WORKSPACE);
    const caller: UserCaller = { workspaceToken: harness.fullToken };

    const allowed: string[] = [];
    for (const call of GATED_CALLS) {
      if (!(await refused(call, harness.userDO, caller))) allowed.push(`${call.capability}:${call.name}`);
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
  test('provisioning issues a working identity registered as full', async () => {
    const harness = createTestUserDO();
    const token = await provisionTestWorkspace(harness, WORKSPACE, 'Workspace A');

    expect(token).toMatch(/^pwc_[A-Za-z0-9_-]{40,}$/);
    expect((await harness.userDO.listWorkspaces({ workspaceToken: token })).entries).toHaveLength(1);
    harness.close();
  });

  test('a workspace that already agrees with the registry is not re-minted', async () => {
    const harness = await setupWorkspaces();
    const hash = await sha256Hex(harness.fullToken);

    await harness.userDO.ensureWorkspaceCapability(WORKSPACE, hash);

    expect(harness.installed.get(WORKSPACE)).toBe(harness.fullToken);
    expect((await harness.userDO.listWorkspaces({ workspaceToken: harness.fullToken })).entries).toHaveLength(2);
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

    await harness.userDO.ensureWorkspaceCapability(WORKSPACE, await sha256Hex(harness.fullToken));

    const repaired = harness.installed.get(WORKSPACE)!;
    expect(repaired).not.toBe(harness.fullToken);
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

  test('a re-mint supersedes the old secret without restoring capability', async () => {
    const harness = await setupWorkspaces();
    setWorkspaceTier(harness.sql, WORKSPACE, 'shared');
    await harness.userDO.ensureWorkspaceCapability(WORKSPACE, null);
    const reminted = harness.installed.get(WORKSPACE)!;

    await expect(harness.userDO.listWorkspaces({ workspaceToken: harness.fullToken }))
      .rejects.toThrow('Unrecognized workspace capability token');
    await expect(harness.userDO.listWorkspaces({ workspaceToken: reminted }))
      .rejects.toThrow(CapabilityDeniedError);
    expect(await harness.userDO.getAuthHeaders({ workspaceToken: reminted }, 'openai.bearer')).toBeNull();
    harness.close();
  });

  test('the raw token is never persisted in the UserDO', async () => {
    const harness = await setupWorkspaces();
    const rows = harness.db.prepare('SELECT * FROM workspace_capability_tokens').all();
    expect(JSON.stringify(rows)).not.toContain(harness.fullToken);
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
  // holds it, so tainting the workspace taints every facet of it at once.
  // These need a LIVE device: without one the device methods short-circuit on
  // "no device connected" before ever reaching the identity substitution, and
  // the assertions below would hold whether or not it existed.
  test('device consent answers for the PROVEN workspace, not the name the caller passed', async () => {
    const harness = await setupWorkspaces({ connectedDeviceId: 'dev-1' });
    const facetCaller: UserCaller = { workspaceToken: harness.fullToken };
    // The owner grants the full-filesystem tier to workspace-a only.
    await harness.userDO.setDeviceConsentScope(await testOwner(), WORKSPACE, 'dev-1', 'full_filesystem');

    // A facet of workspace-a naming anything at all still gets workspace-a's
    // answer — its identity is the token, not the argument.
    expect(await harness.userDO.getDeviceFsConsent(facetCaller, 'some-facet-name'))
      .toEqual({ fullFilesystem: true });
    expect(await harness.userDO.getDeviceFsConsent(facetCaller, OTHER_WORKSPACE))
      .toEqual({ fullFilesystem: true });

    // …and workspace-b cannot read workspace-a's grant by naming it.
    const sibling: UserCaller = { workspaceToken: harness.otherToken };
    expect(await harness.userDO.getDeviceFsConsent(sibling, WORKSPACE))
      .toEqual({ fullFilesystem: false });
    harness.close();
  });

  test('a workspace cannot ride a sibling\'s remembered device grant', async () => {
    const harness = await setupWorkspaces({ connectedDeviceId: 'dev-1' });
    // workspace-a has already said "always" for this device.
    await harness.userDO.setDeviceConsentScope(await testOwner(), WORKSPACE, 'dev-1', 'all_local_actions');
    const sibling: UserCaller = { workspaceToken: harness.otherToken };

    // workspace-b calls while CLAIMING to be workspace-a. Consent is resolved
    // against the proven caller, so it is asked rather than waved through — and
    // this harness's workspace refuses.
    await expect(harness.userDO.deviceRpc(sibling, 'exec', ['ls'], { agentName: WORKSPACE }))
      .rejects.toThrow('device use was not approved');
    expect(harness.consentPrompts).toEqual([{
      workspace: OTHER_WORKSPACE,
      method: 'exec',
      command: 'ls',
      scope: 'full_filesystem',
      workspaceName: OTHER_WORKSPACE,
    }]);

    // The remembered grant still belongs to workspace-a alone; being asked did
    // not create one for the caller that tried to borrow it.
    const consents = await harness.userDO.listDeviceConsents(await testOwner());
    expect(consents.map((c) => c.agentName)).toEqual([WORKSPACE]);
    harness.close();
  });

  test('tainting the workspace cuts the facet in the same instant, with no facet bookkeeping', async () => {
    const harness = await setupWorkspaces();
    const facetCaller: UserCaller = { workspaceToken: harness.fullToken };
    expect((await harness.userDO.listWorkspaces(facetCaller)).entries).toHaveLength(2);

    setWorkspaceTier(harness.sql, WORKSPACE, 'shared');

    // Same token, same facet, no re-issue anywhere: tier is read live.
    await expect(harness.userDO.listWorkspaces(facetCaller)).rejects.toThrow(CapabilityDeniedError);
    await expect(harness.userDO.deviceRpc(facetCaller, 'exec', ['ls'])).rejects.toThrow(CapabilityDeniedError);
    await expect(harness.userDO.userMcp_callTool(facetCaller, 'srv', 'tool', {})).rejects.toThrow(CapabilityDeniedError);
    // …while the facet can still run a model, which is what keeps it working.
    expect(await harness.userDO.getAuthHeaders(facetCaller, 'openai.bearer')).toBeNull();
    harness.close();
  });

  test('a facet cannot name a different workspace to escape its parent\'s tier', async () => {
    const harness = await setupWorkspaces();
    setWorkspaceTier(harness.sql, WORKSPACE, 'shared');
    const facetCaller: UserCaller = { workspaceToken: harness.fullToken };

    // Every remaining name argument is either scoped to the proven workspace
    await expect(harness.userDO.setWorkspaceDisplayName(facetCaller, OTHER_WORKSPACE, 'Hijacked', 'user'))
      .rejects.toThrow('may only rename itself');
    await expect(harness.userDO.getDeviceFsConsent(facetCaller, OTHER_WORKSPACE))
      .rejects.toThrow(CapabilityDeniedError);
    await expect(harness.userDO.getReleaseBoard(facetCaller, OTHER_WORKSPACE))
      .rejects.toThrow(CapabilityDeniedError);
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
    const workspace: UserCaller = { workspaceToken: harness.fullToken };
    for (const call of OWNER_ONLY_CALLS) {
      expect(await refused(call, harness.userDO, workspace)).toBe(true);
      expect(await refused(call, harness.userDO, await testOwner())).toBe(false);
    }
    harness.close();
  });

  test('every gated method is exercised by the matrix above', () => {
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

  test('every capability in the matrix has at least one call behind it', () => {
    const covered = new Set(GATED_CALLS.map((c) => c.capability));
    const declared = Object.keys(WORKSPACE_CAPABILITY_TIERS).filter(
      (name): name is WorkspaceCapability => Object.hasOwn(WORKSPACE_CAPABILITY_TIERS, name),
    );
    expect(declared.filter((c) => !covered.has(c))).toEqual([]);
  });
});
