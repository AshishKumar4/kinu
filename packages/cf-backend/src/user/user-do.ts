/**
 * Per-user Durable Object keyed by the stable Kinu userId; holds all secrets, agents get headers.
 * Every privileged method takes a `UserCaller` first and gates on `requireTier` before anything else.
 * Each domain is its own module; this class is their one object and their RPC surface.
 */
import { Agent, type AgentContext } from 'agents';

import { USER_DO_RPC_SURFACE, USER_DO_STARTED_RPC, sealRpcSurface } from '../rpc-surface';
import { ActivationGate, reportSocketCallFailures, startBeforeRpc } from '../activation-gate';

import {
  ownerCaller, type AccessTokenMint, type AccessTokenRecord, DEVICE_CONNECT_PATH, DEVICE_TERMINAL_PATH, NO_DEVICE_CONNECTED, ORCHESTRATOR_AGENT_SLUG, type Credential, type ExperienceEntry, type ExperienceKind, type ProfileCatalogEnvelope, type PublishableCandidate, type DeviceCodeStart, type JsonValue, type EgressRequestFacts, type EgressSecretBinding, type NameOrigin, initUserTables, requireTier, type UserCaller, type WorkspaceCapability, type ResolvedCaller, deviceIdFromSocket, terminalFromSocket, type AuthRequest, type AuthResolution, type EgressInjectionResult, type EgressSecretSummary, type PutEgressSecretInput, type UnrevokedGrant, initAccessTokenTable, type GitHubRefreshAnswer, type GitHubRefreshAsk, type MossaicVfs, recoveryBackoffMs, type WorkspaceOverview, DEVICE_KEEPALIVE_PING, DEVICE_KEEPALIVE_PONG, DEVICE_TOKEN_ROTATION_ACK, type DeviceCheckpointHint, type DeviceExecOutput, type DeviceStatus, type DeviceTier, type DriveListing, type DriveUploadOutcome, type MarkedSkill, type RelayedProvider, } from '@kinu.run/core';

import { DurableObjectOAuthClientProvider, type AgentMcpOAuthProvider } from 'agents/mcp/do-oauth-client-provider';

// Re-exported for tests: the provider binds `agents/mcp/*` at load, so tests must import it
// via user-do (after the stub lands), not mcp.ts directly.
export { RegisteredAppOAuthClientProvider } from './mcp-registered-app';

import { diagnostics, KinuError, settle, tolerate, toKinuError } from '@kinu.run/core/obs';
import * as v from 'valibot';
import { Hono } from 'hono';
import { rawPath, rethrow } from '../api/context';
import { tenantDrive } from '../drive/tenant';

import { installAnalyticsDiagnostics, openAnalyticsWindow } from '@kinu.run/core/analytics';
import { type McpPresetAvailability, type McpServerSummary } from './mcp';
import { acceptRosterSocket, isRosterSocket, unreportedWorkspaces, ROSTER_SOCKET_PATH, type RosterPage, type RosterQuery } from './roster';

import { UserDrive, type DriveAnswer, type DriveChunkWrite } from './drive';
import { DeviceHelloSchema, UserDevices, type DeviceCancellationOutcome } from './devices';
import { UserTerminals } from './terminals';
import { UserChatGptSignIn, type ChatGptMachineSignIn, type ChatGptPlanStatus } from './chatgpt-sign-in';
import { UserMcpServers, USER_MCP_CLIENT_NAME, type McpToolCall } from './mcp-servers';
import { UserAccountMemory } from './account-memory';
import type { AccountMemoryView, AccountNoteHit, AccountProposal, AccountProposer, Fact, SqlValue } from '@kinu.run/core';
import {
  UserSessions, CLI_AGENT_WEBSOCKET_CAPABILITY, type BrowserSessionIdentity, type CliAgentConnectTicketVerification, type CliTokenVerification, type LiveBrowserSession,
} from './sessions';

import { UserCredentials, type CheckpointedCredential, type CredentialEndpoint, type CodexStatus, type ConnectedProvider, type CredentialSummary } from './credentials';
import { UserWorkspaces, type WorkspaceEntry, type WorkspaceRegistration, type WorkspaceRegistrationSource } from './workspaces';
import { UserProfileStore, type ProfileCatalogWriteResult, type UserProfile } from './profile';
import { ShareCardJobs, type ReceivedShare } from './share-cards';
import type { SqlRow, UserObjectHost } from './user-host';

import {
  type Admission, type AttemptBucket, type ChallengePurpose, type Grant, type NewBuiltinAccount, type NewInvite, type PasskeyAccount, type PasswordAccount, type PasswordHash, type PendingChallenge, type ListedAccount, type Reset, type SigningAccount,
} from '@kinu.run/core/identity';

const ROSTER_NUDGE_LANES = 4;

const DeviceRotationAckSchema = v.object({ type: v.literal(DEVICE_TOKEN_ROTATION_ACK) });

function isTextWebSocketMessage(
  message: string | ArrayBuffer | ArrayBufferView,
): message is string {
  return v.is(v.string(), message);
}

export class UserDO extends Agent<Env> {
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    sealRpcSurface(this, USER_DO_RPC_SURFACE);
    const gate = new ActivationGate();
    this.lifecycle.use(gate);
    this.lifecycle.use(this.shareCards);
    startBeforeRpc(this, USER_DO_STARTED_RPC, () => gate.ready());
    // A DO is its own isolate, so the Worker's diagnostics sink must be installed here too.
    installAnalyticsDiagnostics(this.env);
    // Every event, a native RPC included, reaches whole tables: native RPCs run no `onStart`.
    this.initTables();
  }

  /** Every gated RPC waits for this (`startBeforeRpc`); the MCP dials it starts are not awaited. */
  override onStart(): void {
    this.mcpServers.start();
  }

  private readonly host: UserObjectHost = {
    ctx: this.ctx, env: this.env,
    sqlx: (query, ...bindings) => this.sqlx(query, ...bindings),
    requireTier: (caller, capability) => this.requireTier(caller, capability),
    sessionStands: (tokenHash) => this.sessions.sessionStands(tokenHash),
  };

  private readonly credentials = new UserCredentials({ ...this.host, setConfig: (caller, key, value) => this.profile.setConfig(caller, key, value) });

  private readonly sessions = new UserSessions({ ...this.host, sql: (query, ...values) => this.sql(query, ...values), accountName: () => this.name, getProfile: (caller) => this.profile.getProfile(caller), workspaceRegistered: (name) => this.workspaces.workspaceRegistered(name) });

  private readonly mcpServers = new UserMcpServers({ ...this.host, mcp: this.mcp, vault: this.credentials });

  private readonly accountMemory = new UserAccountMemory({
    ...this.host,
    sql: <T,>(query: TemplateStringsArray, ...values: SqlValue[]): T[] => this.ctx.storage.sql.exec<Extract<T, Record<string, SqlStorageValue>>>(query.join('?'), ...values).toArray(),
  });

  private readonly shareCards = new ShareCardJobs({
    sql: this.ctx.storage.sql,
    owner: () => ({ userId: this.name, email: this.sqlx<{ email: string }>(`SELECT email FROM user_profile WHERE id = 1`)[0]?.email ?? '' }),
    recipient: (userId) => this.env.UserDO.get(this.env.UserDO.idFromName(userId)),
    caller: () => ownerCaller(this.env),
  });

  private readonly workspaces = new UserWorkspaces({
    ...this.host, mcpServers: this.mcpServers, shareCards: this.shareCards, nudgeUnreported: () => { this.nudgeUnreported(); },
  });

  private readonly profile = new UserProfileStore({ ...this.host, workspaces: this.workspaces });

  private readonly devices = new UserDevices({ ...this.host, chatgptSignIns: () => this.chatgpt.chatgptSignIns() });

  private readonly chatgpt = new UserChatGptSignIn({ ...this.host, devices: this.devices, vault: this.credentials });

  private readonly terminals = new UserTerminals({ ...this.host, devices: this.devices });

  private readonly userDrive = new UserDrive({ ...this.host, driveFor: (tenant) => this.driveFor(tenant) });

  ensureProfile(caller: UserCaller, email: string, displayName?: string): Promise<UserProfile> {
    return this.profile.ensureProfile(caller, email, displayName);
  }

  getProfile(caller: UserCaller): Promise<UserProfile | null> {
    return this.profile.getProfile(caller);
  }

  completeOnboarding(caller: UserCaller): ReturnType<UserProfileStore['completeOnboarding']> {
    return this.profile.completeOnboarding(caller);
  }

  setDisplayName(caller: UserCaller, displayName: string): Promise<UserProfile> {
    return this.profile.setDisplayName(caller, displayName);
  }

  publishExperience(caller: UserCaller, candidate: PublishableCandidate): Promise<ExperienceEntry> {
    return this.profile.publishExperience(caller, candidate);
  }

  searchExperience(caller: UserCaller, options: { query?: string; kind?: ExperienceKind; limit?: number } = {}): Promise<ExperienceEntry[]> {
    return this.profile.searchExperience(caller, options);
  }

  getExperienceEntry(caller: UserCaller, id: string): Promise<ExperienceEntry | null> {
    return this.profile.getExperienceEntry(caller, id);
  }

  getConfig(caller: UserCaller, key: string): Promise<string | null> {
    return this.profile.getConfig(caller, key);
  }

  setConfig(caller: UserCaller, key: string, value: string): Promise<void> {
    return this.profile.setConfig(caller, key, value);
  }

  listConfig(caller: UserCaller): Promise<Record<string, string>> {
    return this.profile.listConfig(caller);
  }

  getProfileCatalog(caller: UserCaller): Promise<ProfileCatalogEnvelope> {
    return this.profile.getProfileCatalog(caller);
  }

  getWorkspaceProfileCatalog(caller: UserCaller): Promise<ProfileCatalogEnvelope> {
    return this.profile.getWorkspaceProfileCatalog(caller);
  }

  putProfileCatalog(caller: UserCaller, catalog: JsonValue, expectedVersion: number): Promise<ProfileCatalogWriteResult> {
    return this.profile.putProfileCatalog(caller, catalog, expectedVersion);
  }

  shareCards_put(caller: UserCaller, row: ReceivedShare): Promise<void> {
    return this.profile.shareCards_put(caller, row);
  }

  shareCards_remove(caller: UserCaller, ownerUserId: string, workspace: string, shareId: string): Promise<void> {
    return this.profile.shareCards_remove(caller, ownerUserId, workspace, shareId);
  }

  libraryTiles(caller: UserCaller): ReturnType<UserProfileStore['libraryTiles']> {
    return this.profile.libraryTiles(caller);
  }

  sharesReceived_list(caller: UserCaller): Promise<ReceivedShare[]> {
    return this.profile.sharesReceived_list(caller);
  }

  sharesReceived_forget(caller: UserCaller, ownerUserId: string): Promise<void> {
    return this.profile.sharesReceived_forget(caller, ownerUserId);
  }

  /** For the account-delete sweep: cancels every card not yet delivered and names every account sent one. */
  async shareCards_withdraw(caller: UserCaller): Promise<string[]> {
    await this.requireTier(caller, 'shares');

    return await this.shareCards.withdraw();
  }

  ensureWorkspaceCapability(workspaceName: string, presentedHash: string | null): Promise<void> {
    return this.workspaces.ensureWorkspaceCapability(workspaceName, presentedHash);
  }

  listWorkspaces(caller: UserCaller, query?: RosterQuery): Promise<RosterPage> {
    return this.workspaces.listWorkspaces(caller, query);
  }

  putWorkspaceOverview(caller: UserCaller, name: string, overview: WorkspaceOverview): Promise<void> {
    return this.workspaces.putWorkspaceOverview(caller, name, overview);
  }

  listActiveWorkspaces(caller: UserCaller): Promise<Array<Pick<WorkspaceEntry, 'name' | 'displayName' | 'createdAt'>>> {
    return this.workspaces.listActiveWorkspaces(caller);
  }

  registerWorkspace(caller: UserCaller, name: string, displayName?: string, from?: WorkspaceRegistrationSource): Promise<WorkspaceRegistration> {
    return this.workspaces.registerWorkspace(caller, name, displayName, from);
  }

  reserveWorkspace(caller: UserCaller, name: string, displayName?: string): ReturnType<UserWorkspaces['reserveWorkspace']> {
    return this.workspaces.reserveWorkspace(caller, name, displayName);
  }

  renewWorkspaceReservation(caller: UserCaller, name: string, createdAt: number): Promise<boolean> {
    return this.workspaces.renewWorkspaceReservation(caller, name, createdAt);
  }

  publishWorkspaceReservation(caller: UserCaller, name: string, createdAt: number, capabilityHash: string | null): Promise<void> {
    return this.workspaces.publishWorkspaceReservation(caller, name, createdAt, capabilityHash);
  }

  releaseWorkspaceReservation(caller: UserCaller, name: string, createdAt: number): Promise<boolean> {
    return this.workspaces.releaseWorkspaceReservation(caller, name, createdAt);
  }

  touchWorkspace(caller: UserCaller, name: string): Promise<boolean> {
    return this.workspaces.touchWorkspace(caller, name);
  }

  removeWorkspace(caller: UserCaller, name: string, ownerUserId: string): Promise<void> {
    return this.workspaces.removeWorkspace(caller, name, ownerUserId);
  }

  setWorkspaceDisplayName(caller: UserCaller, name: string, displayName: string, origin: NameOrigin): ReturnType<UserWorkspaces['setWorkspaceDisplayName']> {
    return this.workspaces.setWorkspaceDisplayName(caller, name, displayName, origin);
  }

  setWorkspaceLogo(caller: UserCaller, name: string, svg: string): ReturnType<UserWorkspaces['setWorkspaceLogo']> {
    return this.workspaces.setWorkspaceLogo(caller, name, svg);
  }

  getWorkspaceTitle(caller: UserCaller, name: string): ReturnType<UserWorkspaces['getWorkspaceTitle']> {
    return this.workspaces.getWorkspaceTitle(caller, name);
  }

  hasWorkspace(caller: UserCaller, name: string): Promise<boolean> {
    return this.workspaces.hasWorkspace(caller, name);
  }

  hasPeerGrant(caller: UserCaller, senderAgentName: string, senderUserId: string): Promise<boolean> {
    return this.workspaces.hasPeerGrant(caller, senderAgentName, senderUserId);
  }

  listCredentials(caller: UserCaller): Promise<CredentialSummary[]> {
    return this.credentials.listCredentials(caller);
  }

  setCredential(caller: UserCaller, key: string, credentialJson: Credential | JsonValue): Promise<void> {
    return this.credentials.setCredential(caller, key, credentialJson);
  }

  deleteCredential(caller: UserCaller, key: string): Promise<void> {
    return this.credentials.deleteCredential(caller, key);
  }

  checkpointCredentials(caller: UserCaller, account: string): Promise<CheckpointedCredential[]> {
    return this.credentials.checkpointCredentials(caller, account);
  }

  restoreCredentials(caller: UserCaller, account: string, checkpoint: readonly CheckpointedCredential[]): Promise<string[]> {
    return this.credentials.restoreCredentials(caller, account, checkpoint);
  }

  listUnrevokedGrants(caller: UserCaller): Promise<UnrevokedGrant[]> {
    return this.credentials.listUnrevokedGrants(caller);
  }

  dismissUnrevokedGrant(caller: UserCaller, key: string): Promise<void> {
    return this.credentials.dismissUnrevokedGrant(caller, key);
  }

  getCredentialsRevision(caller: UserCaller): Promise<number> {
    return this.credentials.getCredentialsRevision(caller);
  }

  listEgressSecrets(caller: UserCaller): Promise<EgressSecretSummary[]> {
    return this.credentials.listEgressSecrets(caller);
  }

  putEgressSecret(caller: UserCaller, input: PutEgressSecretInput): Promise<EgressSecretBinding> {
    return this.credentials.putEgressSecret(caller, input);
  }

  revokeEgressSecret(caller: UserCaller, id: string): ReturnType<UserCredentials['revokeEgressSecret']> {
    return this.credentials.revokeEgressSecret(caller, id);
  }

  resolveEgressInjection(caller: UserCaller, facts: EgressRequestFacts, active: readonly EgressSecretBinding[]): Promise<EgressInjectionResult> {
    return this.credentials.resolveEgressInjection(caller, facts, active);
  }

  getCredentialEndpoint(caller: UserCaller, key: string): Promise<CredentialEndpoint | null> {
    return this.credentials.getCredentialEndpoint(caller, key);
  }

  getAuthHeaders(caller: UserCaller, key: string, opts?: AuthRequest): Promise<Record<string, string> | null> {
    return this.credentials.getAuthHeaders(caller, key, opts);
  }

  getAuth(caller: UserCaller, key: string, opts?: AuthRequest): Promise<AuthResolution | null> {
    return this.credentials.getAuth(caller, key, opts);
  }

  listAIGateways(caller: UserCaller): ReturnType<UserCredentials['listAIGateways']> {
    return this.credentials.listAIGateways(caller);
  }

  selectAIGateway(caller: UserCaller, gatewayId: string | null): Promise<void> {
    return this.credentials.selectAIGateway(caller, gatewayId);
  }

  listCloudflareAccounts(caller: UserCaller): ReturnType<UserCredentials['listCloudflareAccounts']> {
    return this.credentials.listCloudflareAccounts(caller);
  }

  selectCloudflareAccount(caller: UserCaller, accountId: string): Promise<void> {
    return this.credentials.selectCloudflareAccount(caller, accountId);
  }

  startCodexDeviceFlow(caller: UserCaller, account?: string): Promise<DeviceCodeStart> {
    return this.credentials.startCodexDeviceFlow(caller, account);
  }

  pollCodexDeviceFlow(caller: UserCaller): ReturnType<UserCredentials['pollCodexDeviceFlow']> {
    return this.credentials.pollCodexDeviceFlow(caller);
  }

  startClaudeSignIn(caller: UserCaller): ReturnType<UserCredentials['startClaudeSignIn']> {
    return this.credentials.startClaudeSignIn(caller);
  }

  finishClaudeSignIn(caller: UserCaller, returned: string): ReturnType<UserCredentials['finishClaudeSignIn']> {
    return this.credentials.finishClaudeSignIn(caller, returned);
  }

  disconnectCodex(caller: UserCaller): Promise<void> {
    return this.credentials.disconnectCodex(caller);
  }

  getCodexStatus(caller: UserCaller): Promise<CodexStatus> {
    return this.credentials.getCodexStatus(caller);
  }

  listConnectedProviders(caller: UserCaller): Promise<ConnectedProvider[]> {
    return this.credentials.listConnectedProviders(caller);
  }

  registerBrowserSession(caller: UserCaller, tokenHash: string, expiresAt: number, identity: BrowserSessionIdentity & { credentialGeneration?: number }): Promise<void> {
    return this.sessions.registerBrowserSession(caller, tokenHash, expiresAt, identity);
  }

  verifyBrowserSession(caller: UserCaller, tokenHash: string): Promise<LiveBrowserSession | null> {
    return this.sessions.verifyBrowserSession(caller, tokenHash);
  }

  builtinHasOwner(caller: UserCaller): Promise<boolean> {
    return this.sessions.builtinHasOwner(caller);
  }

  builtinIsOwner(caller: UserCaller, userId: string): Promise<boolean> {
    return this.sessions.builtinIsOwner(caller, userId);
  }

  builtinAdmissible(caller: UserCaller, request: Pick<NewBuiltinAccount, 'email' | 'grant'>): Promise<Admission> {
    return this.sessions.builtinAdmissible(caller, request);
  }

  builtinReserveAttempt(caller: UserCaller, buckets: readonly AttemptBucket[]): Promise<number> {
    return this.sessions.builtinReserveAttempt(caller, buckets);
  }

  builtinReplacePassword(caller: UserCaller, userId: string, password: PasswordHash): Promise<void> {
    return this.sessions.builtinReplacePassword(caller, userId, password);
  }

  builtinResetAccount(caller: UserCaller, grant: Grant): Promise<SigningAccount | null> {
    return this.sessions.builtinResetAccount(caller, grant);
  }

  builtinApplyReset(caller: UserCaller, reset: Reset): Promise<SigningAccount | null> {
    return this.sessions.builtinApplyReset(caller, reset);
  }

  builtinListAccounts(caller: UserCaller): Promise<ListedAccount[]> {
    return this.sessions.builtinListAccounts(caller);
  }

  builtinClearAttempts(caller: UserCaller, keys: readonly string[]): Promise<void> {
    return this.sessions.builtinClearAttempts(caller, keys);
  }

  builtinInvitedEmail(caller: UserCaller, inviteHash: string): Promise<string | null> {
    return this.sessions.builtinInvitedEmail(caller, inviteHash);
  }

  builtinRegister(caller: UserCaller, account: NewBuiltinAccount): Promise<Admission> {
    return this.sessions.builtinRegister(caller, account);
  }

  builtinPasswordAccount(caller: UserCaller, email: string): Promise<PasswordAccount | null> {
    return this.sessions.builtinPasswordAccount(caller, email);
  }

  builtinPasskeyAccount(caller: UserCaller, credentialId: string): Promise<PasskeyAccount | null> {
    return this.sessions.builtinPasskeyAccount(caller, credentialId);
  }

  builtinRecordPasskeyUse(caller: UserCaller, credentialId: string, counter: number): Promise<void> {
    return this.sessions.builtinRecordPasskeyUse(caller, credentialId, counter);
  }

  builtinIssueChallenge(caller: UserCaller, challenge: string, pending: PendingChallenge, expiresAt: number): Promise<void> {
    return this.sessions.builtinIssueChallenge(caller, challenge, pending, expiresAt);
  }

  builtinSpendChallenge(caller: UserCaller, challenge: string, purposes: readonly ChallengePurpose[]): Promise<PendingChallenge | null> {
    return this.sessions.builtinSpendChallenge(caller, challenge, purposes);
  }

  builtinCreateInvite(caller: UserCaller, invite: NewInvite): Promise<boolean> {
    return this.sessions.builtinCreateInvite(caller, invite);
  }

  revokeBrowserSession(caller: UserCaller, tokenHash: string): Promise<void> {
    return this.sessions.revokeBrowserSession(caller, tokenHash);
  }

  verifySocketSession(caller: UserCaller, tokenHash: string): ReturnType<UserSessions['verifySocketSession']> {
    return this.sessions.verifySocketSession(caller, tokenHash);
  }

  mintCliToken(caller: UserCaller, userId: string, authorizationHash: string, label?: string): ReturnType<UserSessions['mintCliToken']> {
    return this.sessions.mintCliToken(caller, userId, authorizationHash, label);
  }

  verifyCliToken(caller: UserCaller, token: string): Promise<CliTokenVerification> {
    return this.sessions.verifyCliToken(caller, token);
  }

  listCliTokens(caller: UserCaller): ReturnType<UserSessions['listCliTokens']> {
    return this.sessions.listCliTokens(caller);
  }

  revokeCliTokenHash(caller: UserCaller, tokenHash: string): ReturnType<UserSessions['revokeCliTokenHash']> {
    return this.sessions.revokeCliTokenHash(caller, tokenHash);
  }

  raiseCredentialFloor(caller: UserCaller, generation: number): Promise<void> {
    return this.sessions.raiseCredentialFloor(caller, generation);
  }

  revokeAllCliTokens(caller: UserCaller): ReturnType<UserSessions['revokeAllCliTokens']> {
    return this.sessions.revokeAllCliTokens(caller);
  }

  verifyCliSocketBearer(caller: UserCaller, tokenHash: string): ReturnType<UserSessions['verifyCliSocketBearer']> {
    return this.sessions.verifyCliSocketBearer(caller, tokenHash);
  }

  mintAccessToken(caller: UserCaller, userId: string, name: string, scopes: readonly string[]): Promise<AccessTokenMint> {
    return this.sessions.mintAccessToken(caller, userId, name, scopes);
  }

  verifyAccessToken(caller: UserCaller, token: string): Promise<CliTokenVerification> {
    return this.sessions.verifyAccessToken(caller, token);
  }

  listAccessTokens(caller: UserCaller): Promise<AccessTokenRecord[]> {
    return this.sessions.listAccessTokens(caller);
  }

  revokeAccessToken(caller: UserCaller, ref: string): ReturnType<UserSessions['revokeAccessToken']> {
    return this.sessions.revokeAccessToken(caller, ref);
  }

  issueCliAgentConnectTicket(caller: UserCaller, input: {
    userId: string;
    agentClass: typeof ORCHESTRATOR_AGENT_SLUG;
    agentName: string;
    cliTokenHash: string;
    capabilities?: Array<typeof CLI_AGENT_WEBSOCKET_CAPABILITY>;
  }): ReturnType<UserSessions['issueCliAgentConnectTicket']> {
    return this.sessions.issueCliAgentConnectTicket(caller, input);
  }

  verifyCliAgentConnectTicket(caller: UserCaller, ticket: string, expected: {
      userId: string;
      agentClass: typeof ORCHESTRATOR_AGENT_SLUG;
      agentName: string;
      capability: typeof CLI_AGENT_WEBSOCKET_CAPABILITY;
    }): Promise<CliAgentConnectTicketVerification> {
    return this.sessions.verifyCliAgentConnectTicket(caller, ticket, expected);
  }

  userMcp_warmConnections(caller: UserCaller): ReturnType<UserMcpServers['userMcp_warmConnections']> {
    return this.mcpServers.userMcp_warmConnections(caller);
  }

  userMcp_list(caller: UserCaller): Promise<McpServerSummary[]> {
    return this.mcpServers.userMcp_list(caller);
  }

  accountMemory_facts(caller: UserCaller): Promise<Fact[]> {
    return this.accountMemory.accountMemory_facts(caller);
  }

  accountMemory_searchNotes(caller: UserCaller, query: string, limit: number): Promise<AccountNoteHit[]> {
    return this.accountMemory.accountMemory_searchNotes(caller, query, limit);
  }

  accountMemory_propose(caller: UserCaller, proposal: AccountProposal, proposer: AccountProposer, delivery?: string): Promise<string> {
    return this.accountMemory.accountMemory_propose(caller, proposal, proposer, delivery);
  }

  accountMemory_view(caller: UserCaller): Promise<AccountMemoryView> {
    return this.accountMemory.accountMemory_view(caller);
  }

  accountMemory_decide(caller: UserCaller, id: string, decision: 'accept' | 'decline'): Promise<boolean> {
    return this.accountMemory.accountMemory_decide(caller, id, decision);
  }

  accountMemory_put(caller: UserCaller, key: string, value: JsonValue, workspace?: string): Promise<string> {
    return this.accountMemory.accountMemory_put(caller, key, value, workspace);
  }

  accountMemory_forget(caller: UserCaller, key: string): Promise<boolean> {
    return this.accountMemory.accountMemory_forget(caller, key);
  }

  accountMemory_forgetNote(caller: UserCaller, id: string): Promise<boolean> {
    return this.accountMemory.accountMemory_forgetNote(caller, id);
  }

  userMcp_presets(caller: UserCaller): Promise<McpPresetAvailability[]> {
    return this.mcpServers.userMcp_presets(caller);
  }

  userMcp_add(caller: UserCaller, input: JsonValue, publicOrigin: string): ReturnType<UserMcpServers['userMcp_add']> {
    return this.mcpServers.userMcp_add(caller, input, publicOrigin);
  }

  userMcp_remove(caller: UserCaller, id: string): Promise<void> {
    return this.mcpServers.userMcp_remove(caller, id);
  }

  userMcp_update(caller: UserCaller, id: string, patch: JsonValue): Promise<void> {
    return this.mcpServers.userMcp_update(caller, id, patch);
  }

  userMcp_toolDescriptors(caller: UserCaller): Promise<string> {
    return this.mcpServers.userMcp_toolDescriptors(caller);
  }

  userMcp_callTool(caller: UserCaller, call: McpToolCall): Promise<string> {
    return this.mcpServers.userMcp_callTool(caller, call);
  }

  userMcp_cancelCall(caller: UserCaller, callId: string): Promise<void> {
    return this.mcpServers.userMcp_cancelCall(caller, callId);
  }

  userMcp_handleOAuthCallback(caller: UserCaller, url: string): ReturnType<UserMcpServers['userMcp_handleOAuthCallback']> {
    return this.mcpServers.userMcp_handleOAuthCallback(caller, url);
  }

  chatgptPlan(caller: UserCaller): Promise<ChatGptPlanStatus> {
    return this.chatgpt.chatgptPlan(caller);
  }

  startChatGptSignIn(caller: UserCaller): Promise<ChatGptMachineSignIn> {
    return this.chatgpt.startChatGptSignIn(caller);
  }

  cancelChatGptSignIn(caller: UserCaller): Promise<void> {
    return this.chatgpt.cancelChatGptSignIn(caller);
  }

  startChatGptPasteSignIn(caller: UserCaller, account?: string): ReturnType<UserChatGptSignIn['startChatGptPasteSignIn']> {
    return this.chatgpt.startChatGptPasteSignIn(caller, account);
  }

  finishChatGptPasteSignIn(caller: UserCaller, returned: string): ReturnType<UserChatGptSignIn['finishChatGptPasteSignIn']> {
    return this.chatgpt.finishChatGptPasteSignIn(caller, returned);
  }

  signOutChatGpt(caller: UserCaller): ReturnType<UserChatGptSignIn['signOutChatGpt']> {
    return this.chatgpt.signOutChatGpt(caller);
  }

  openDeviceTerminal(caller: UserCaller, agentName: string, window: { cols: number; rows: number }, deviceId?: string): ReturnType<UserTerminals['openDeviceTerminal']> {
    return this.terminals.openDeviceTerminal(caller, agentName, window, deviceId);
  }

  registerDevice(caller: UserCaller, label?: string, replaces?: string): ReturnType<UserDevices['registerDevice']> {
    return this.devices.registerDevice(caller, label, replaces);
  }

  renameDevice(caller: UserCaller, deviceId: string, name: string): ReturnType<UserDevices['renameDevice']> {
    return this.devices.renameDevice(caller, deviceId, name);
  }

  verifyDeviceToken(caller: UserCaller, token: string): ReturnType<UserDevices['verifyDeviceToken']> {
    return this.devices.verifyDeviceToken(caller, token);
  }

  issueDeviceConnectTicket(caller: UserCaller, token: string): ReturnType<UserDevices['issueDeviceConnectTicket']> {
    return this.devices.issueDeviceConnectTicket(caller, token);
  }

  recordDeviceUpdateRefusal(caller: UserCaller, token: string, refusal: { version: string; runtime: string; reason: string }): Promise<boolean> {
    return this.devices.recordDeviceUpdateRefusal(caller, token, refusal);
  }

  verifyDeviceConnectTicket(caller: UserCaller, ticket: string): ReturnType<UserDevices['verifyDeviceConnectTicket']> {
    return this.devices.verifyDeviceConnectTicket(caller, ticket);
  }

  deviceRpc(caller: UserCaller, method: string, params: JsonValue[], opts?: {
      deviceId?: string; agentName?: string; checkpoint?: DeviceCheckpointHint;
      timeoutMs?: number; requestId?: string; backgroundJobId?: string;
      onOutput?: (output: DeviceExecOutput) => void | Promise<void>;
    }): Promise<string | undefined> {
    return this.devices.deviceRpc(caller, method, params, opts);
  }

  relayDevice(caller: UserCaller, provider: RelayedProvider): ReturnType<UserDevices['relayDevice']> {
    return this.devices.relayDevice(caller, provider);
  }

  relayModelCall(caller: UserCaller, deviceId: string, callId: string, request: Request): Promise<Response> {
    return this.devices.relayModelCall(caller, deviceId, callId, request);
  }

  cancelModelRelay(caller: UserCaller, callId: string): Promise<void> {
    return this.devices.cancelModelRelay(caller, callId);
  }

  acknowledgeDeviceRequest(caller: UserCaller, requestId: string): Promise<void> {
    return this.devices.acknowledgeDeviceRequest(caller, requestId);
  }

  cancelDeviceRequestsForTurn(caller: UserCaller, turnId: string): Promise<DeviceCancellationOutcome[]> {
    return this.devices.cancelDeviceRequestsForTurn(caller, turnId);
  }

  transferDeviceRequestToBackgroundJob(caller: UserCaller, requestId: string, jobId: string): ReturnType<UserDevices['transferDeviceRequestToBackgroundJob']> {
    return this.devices.transferDeviceRequestToBackgroundJob(caller, requestId, jobId);
  }

  cancelDeviceRequestsForBackgroundJob(caller: UserCaller, jobId: string): Promise<DeviceCancellationOutcome[]> {
    return this.devices.cancelDeviceRequestsForBackgroundJob(caller, jobId);
  }

  setDeviceTier(caller: UserCaller, deviceId: string, tier: DeviceTier): ReturnType<UserDevices['setDeviceTier']> {
    return this.devices.setDeviceTier(caller, deviceId, tier);
  }

  listDeviceConsents(caller: UserCaller): ReturnType<UserDevices['listDeviceConsents']> {
    return this.devices.listDeviceConsents(caller);
  }

  revokeDeviceConsent(caller: UserCaller, agentName: string, deviceId: string): ReturnType<UserDevices['revokeDeviceConsent']> {
    return this.devices.revokeDeviceConsent(caller, agentName, deviceId);
  }

  getDeviceFileView(caller: UserCaller, agentName: string, device?: string): ReturnType<UserDevices['getDeviceFileView']> {
    return this.devices.getDeviceFileView(caller, agentName, device);
  }

  listDevices(caller: UserCaller): ReturnType<UserDevices['listDevices']> {
    return this.devices.listDevices(caller);
  }

  watchDeviceStatus(caller: UserCaller, watching: boolean): Promise<void> {
    return this.devices.watchDeviceStatus(caller, watching);
  }

  deviceName(caller: UserCaller, deviceId: string): Promise<string | null> {
    return this.devices.deviceName(caller, deviceId);
  }

  deviceRuntimeStatus(caller: UserCaller): Promise<DeviceStatus> {
    return this.devices.deviceRuntimeStatus(caller);
  }

  revokeDevice(caller: UserCaller, deviceId: string): ReturnType<UserDevices['revokeDevice']> {
    return this.devices.revokeDevice(caller, deviceId);
  }

  acknowledgeUnstoppedDevice(caller: UserCaller, deviceId: string): ReturnType<UserDevices['acknowledgeUnstoppedDevice']> {
    return this.devices.acknowledgeUnstoppedDevice(caller, deviceId);
  }

  drive_list(caller: UserCaller, path: string): Promise<DriveAnswer<DriveListing>> {
    return this.userDrive.drive_list(caller, path);
  }

  drive_mkdir(caller: UserCaller, path: string): Promise<DriveAnswer<void>> {
    return this.userDrive.drive_mkdir(caller, path);
  }

  drive_rename(caller: UserCaller, from: string, to: string): Promise<DriveAnswer<void>> {
    return this.userDrive.drive_rename(caller, from, to);
  }

  drive_delete(caller: UserCaller, path: string): Promise<DriveAnswer<void>> {
    return this.userDrive.drive_delete(caller, path);
  }

  drive_markAsSkill(caller: UserCaller, path: string): Promise<DriveAnswer<MarkedSkill>> {
    return this.userDrive.drive_markAsSkill(caller, path);
  }

  drive_addSkill(caller: UserCaller, skillFile: string): Promise<DriveAnswer<MarkedSkill>> {
    return this.userDrive.drive_addSkill(caller, skillFile);
  }

  drive_writeChunk(caller: UserCaller, write: DriveChunkWrite): Promise<DriveAnswer<DriveUploadOutcome>> {
    return this.userDrive.drive_writeChunk(caller, write);
  }

  drive_abortUpload(caller: UserCaller, transferId: string): Promise<void> {
    return this.userDrive.drive_abortUpload(caller, transferId);
  }

  drive_startDownload(caller: UserCaller, path: string, transferId: string): ReturnType<UserDrive['drive_startDownload']> {
    return this.userDrive.drive_startDownload(caller, path, transferId);
  }

  drive_readChunk(caller: UserCaller, transferId: string, offset: number, length: number): ReturnType<UserDrive['drive_readChunk']> {
    return this.userDrive.drive_readChunk(caller, transferId, offset, length);
  }

  drive_abortDownload(caller: UserCaller, transferId: string): Promise<void> {
    return this.userDrive.drive_abortDownload(caller, transferId);
  }

  /** Keyed by {@link USER_MCP_CLIENT_NAME}, not this object's name: every stored grant uses that key. */
  override createMcpOAuthProvider(callbackUrl: string): AgentMcpOAuthProvider {
    return new DurableObjectOAuthClientProvider(this.ctx.storage, USER_MCP_CLIENT_NAME, callbackUrl);
  }

  /** Once per activation, from the constructor. Claims live in isolate memory, so any claim in storage
   * at activation start was abandoned; the activation boundary is the expiry. */
  private initTables(): void {
    initUserTables(this.ctx.storage.sql);
    initAccessTokenTable(this.ctx.storage.sql);
    this.devices._inflight.releaseAbandonedClaims();
  }

  private sqlx<T extends SqlRow = SqlRow>(query: string, ...bindings: SqlStorageValue[]): T[] {

    return this.ctx.storage.sql.exec<T>(query, ...bindings).toArray();
  }

  /**
   * The attenuation gate: first statement of every privileged method below.
   * Also reopens the analytics window, since the 250-point budget is per invocation.
   */
  private requireTier(caller: UserCaller, capability: WorkspaceCapability): Promise<ResolvedCaller> {
    openAnalyticsWindow(this.env);

    return requireTier(this.ctx.storage.sql, this.env, { caller }, capability);
  }

  // The 'account' capability is floored at owner_only, so no workspace token reaches these methods.

  /** So two reads never ask one twice. */
  private readonly nudging = new Set<string>();

  /** Never awaited, so a read never waits; a lane never rejects. */
  private nudges: Promise<unknown> = Promise.resolve();

  /** Each ask marks its retry first, so a failed or cut-short one is asked again. */
  private nudgeUnreported(): void {
    const queue = unreportedWorkspaces(this.ctx.storage.sql, Date.now()).filter((name) => !this.nudging.has(name));

    if (queue.length === 0) return;

    for (const name of queue) this.nudging.add(name);

    const lane = async (): Promise<void> => {
      for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
        try {
          // Deleted since the queue was read: never woken.
          if (!this.workspaces.workspaceRegistered(name)) continue;
          const [marker] = this.sqlx<{ attempts: number }>(`SELECT attempts FROM workspace_overview_nudges WHERE name = ?`, name);
          const attempts = (marker?.attempts ?? 0) + 1;

          this.sqlx(`INSERT INTO workspace_overview_nudges (name, attempts, next_at) VALUES (?, ?, ?)
            ON CONFLICT (name) DO UPDATE SET attempts = excluded.attempts, next_at = excluded.next_at`,
          name, attempts, Date.now() + recoveryBackoffMs(attempts));
          await this.env.OrchestratorAgent.get(this.env.OrchestratorAgent.idFromName(name)).requestOverviewPush();
        } catch (cause) {
          diagnostics.failure('roster.overview_nudge_failed', toKinuError({
            doing: 'asking a workspace with no tile for its first one', cause, otherwise: 'unavailable',
          }), { workspace: name });
        } finally {
          this.nudging.delete(name);
        }
      }
    };

    this.nudges = Promise.all([this.nudges, ...Array.from({ length: Math.min(ROSTER_NUDGE_LANES, queue.length) }, lane)]);
  }

  // Session authority lives here: KV writes and deletes take up to a minute to reach every colo,
  // so KV can confirm neither revocation nor existence.

  /** Revoke exactly this session; the row's absence is the revocation. The write is durable
   * before the fan-out, so a failed push cannot keep a socket authorized (see retireCliAuthority). */

  /** A WebSocket cannot cross RPC; the Worker forwards these upgrades. */
  private readonly _sockets = new Hono({ getPath: rawPath })
    .all(DEVICE_CONNECT_PATH, async (c) => this.devices.acceptDeviceSocket(c.req.raw, new URL(c.req.url)))
    .all(DEVICE_TERMINAL_PATH, async (c) => this.terminals.acceptTerminalSocket(c.req.raw, new URL(c.req.url)))
    // Frames a socket missed while it was down are not replayed, so a new one starts from what waits on the owner now.
    .all(ROSTER_SOCKET_PATH, async (c) => acceptRosterSocket(this.ctx, c.req.raw, (socket) => { this.accountMemory.pendingMoved([socket]); }))
    .notFound(async (c) => super.fetch(c.req.raw))
    .onError(rethrow);

  override async fetch(request: Request): Promise<Response> {
    return await this._sockets.fetch(request);
  }

  /* These hibernation handlers are declared here, so `Lifecycle.installHandlers` skips them and there
   * is no `super`; foreign sockets are delegated to the lifecycle directly, as `Agent.fetch` does. */
  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer | ArrayBufferView): Promise<void> {
    if (isRosterSocket(ws)) return;
    // Pane bytes are raw keystrokes; decoding them as text would corrupt them.
    const terminal = terminalFromSocket(ws);

    if (terminal) {
      this.terminals._terminals.fromPane(terminal.session, terminal.device, message);

      return;
    }

    const deviceId = deviceIdFromSocket(ws);

    if (!deviceId) return this.lifecycle.webSocketMessage(ws, message);
    let data: string;

    if (isTextWebSocketMessage(message)) {
      data = message;
    } else if (message instanceof ArrayBuffer) {
      data = new TextDecoder().decode(message);
    } else {
      const bytes = new Uint8Array(message.byteLength);
      bytes.set(new Uint8Array(message.buffer, message.byteOffset, message.byteLength));
      data = new TextDecoder().decode(bytes);
    }

    // Keepalive answered here, not by platform auto-response, which would eat a pasted "ping" to a shell.
    if (data === DEVICE_KEEPALIVE_PING) {
      ws.send(DEVICE_KEEPALIVE_PONG);

      return;
    }

    // Anything not a HELLO (including non-JSON) is treated as an RPC response.
    const hello = v.safeParse(DeviceHelloSchema, tolerate(() => JSON.parse(data), 'malformed-input'));

    if (hello.success) {
      if (!this.devices._devices.hello(deviceId, hello.output.protocolVersion, hello.output.features)) {
        this.sqlx(`INSERT OR IGNORE INTO user_device_protocol_refusals (device_id) VALUES (?)`, deviceId);

        return;
      }

      this.devices.recordDeviceHello(deviceId, hello.output);
      await this.devices.devicesMoved();
      const frame = await this.devices.deviceUpdateFrame(deviceId, hello.output);

      if (frame !== null) {
        diagnostics.event('device.update_pushed', { device: deviceId, from: hello.output.version ?? '', to: frame.version });
        ws.send(JSON.stringify(frame));

        return;
      }

      return settle(this.chatgpt.continueChatGptSignIn(deviceId));
    }

    const acknowledged = v.safeParse(DeviceRotationAckSchema, tolerate(() => JSON.parse(data), 'malformed-input'));

    if (acknowledged.success) {
      const now = Date.now();

      const [grace] = this.sqlx<{ prev_token_hash: string | null }>(
        `SELECT prev_token_hash FROM user_devices WHERE id = ?`, deviceId,
      );

      this.devices.retireDeviceTokens(deviceId, [grace?.prev_token_hash ?? null], now);
      this.sqlx(`UPDATE user_devices SET prev_token_hash = NULL, last_seen_at = ? WHERE id = ?`, now, deviceId);

      return;
    }

    // Terminal frames have no request id; the RPC correlator would silently drop them.
    if (this.terminals.handleTerminalFrame(data)) return;
    this.devices._devices.handleMessage(deviceId, data);
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    if (isRosterSocket(ws)) return;
    // A pane's socket closing hangs up the shell rather than leaving it running with no window.
    const terminal = terminalFromSocket(ws);

    if (terminal) {
      return settle(this.terminals.closeDeviceTerminal(terminal.session, terminal.device));
    }

    const deviceId = deviceIdFromSocket(ws);

    if (!deviceId) return this.lifecycle.webSocketClose(ws, code, reason, wasClean);
    this.devices._devices.handleClose(deviceId, ws);

    // The daemon hangs up its shells when the socket drops, so tell the panes.
    for (const session of this.terminals._terminals.panesForDevice(deviceId)) {
      this.terminals._terminals.endPane(session, NO_DEVICE_CONNECTED);
    }

    await this.devices.devicesMoved();
  }

  override async webSocketError(...call: Parameters<NonNullable<Agent<Env>['webSocketError']>>): Promise<void> {
    const [ws] = call;

    // Device sockets clean up in webSocketClose, which the runtime fires next.
    if (!deviceIdFromSocket(ws) && !isRosterSocket(ws)) return this.lifecycle.webSocketError(...call);
  }

  // All reads/writes of `user_credentials.value` go through this pair; the only places plaintext
  // secrets exist in this class (sealed by credential-envelope.ts).

  // Egress secret vault: see user/egress-vault.ts for why the row shape is its own table.

  // Codex device flow: calls wait on OpenAI while other calls run. The generation names the
  // attempt a poll belongs to and `settled_at` whether it is still live, fencing stale polls.

  // The Mossaic tenant id is the owner's user id, derived from the profile row's email as the
  // edge does, so no caller names a tenant. Every owner workspace mounts it at `/shared`.

  /** Seam: the hosted deployment builds the SDK client from bindings; the bun:sqlite harness fakes it. */
  protected driveFor(tenant: string): MossaicVfs | null {
    return tenantDrive(this.env, tenant);
  }

  async heldRows(caller: UserCaller): Promise<Record<string, number>> {
    await this.requireTier(caller, 'account');

    const tables = this.sqlx<{ name: string; sql: string | null }>(
      `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
         AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name`,
    );

    const indexes = tables.filter((table) => /^\s*create\s+virtual\s+table/iu.test(table.sql ?? '')).map((table) => table.name);
    const held: Record<string, number> = {};

    for (const { name } of tables) {
      if (indexes.some((index) => name === index || name.startsWith(`${index}_`))) continue;

      const rows = this.sqlx<{ n: number }>(`SELECT COUNT(*) AS n FROM "${name.replaceAll('"', '""')}"`)[0]?.n ?? 0;

      if (rows > 0) held[name] = rows;
    }

    return held;
  }

  /**
   * Delete everything under this account, then the object itself; the step order is the contract.
   * Each step leaves no rows, so a failed sweep resumes on retry; errors propagate to the owner.
   */
  async deleteAccount(caller: UserCaller, ownerUserId: string): Promise<{ ok: true; workspaces: number }> {
    await this.requireTier(caller, 'account');

    if (!/^[a-f0-9]{32}$/.test(ownerUserId)) throw new KinuError('bad_input', 'invalid owner user id');

    const workspaces = this.sqlx<{ name: string }>(`SELECT name FROM user_workspaces`);

    for (const { name } of workspaces) {
      await this.workspaces.tearDownWorkspace(name, ownerUserId);
    }

    const devices = this.sqlx<{ id: string }>(`SELECT id FROM user_devices WHERE revoked_at IS NULL`);

    for (const { id } of devices) {
      await this.devices.revokeDevice(caller, id);
    }

    const servers = this.sqlx<{ id: string }>(`SELECT id FROM user_mcp_servers`);

    for (const { id } of servers) {
      await this.mcpServers.userMcp_remove(caller, id);
    }

    await this.destroy();
    // The isolate abort is a tick away, and a request can land in that tick: it meets the tables made
    // again, empty, and answers as the new account.
    this.initTables();

    return { ok: true, workspaces: workspaces.length };
  }

  userMcp_githubRefresh(caller: UserCaller, ask: GitHubRefreshAsk): Promise<GitHubRefreshAnswer> {
    return this.mcpServers.userMcp_githubRefresh(caller, ask);
  }
}

reportSocketCallFailures(UserDO, Agent);
