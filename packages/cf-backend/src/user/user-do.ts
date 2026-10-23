/**
 * Per-user Durable Object keyed by the stable Kinu userId; holds all secrets, agents get headers.
 * Every privileged method takes a `UserCaller` first and gates on `requireTier` before anything else.
 * Each domain is its own module; this class is their one object and their RPC surface.
 */
import { Agent, type AgentContext } from 'agents';

import { USER_DO_RPC_SURFACE, USER_DO_STARTED_RPC } from '../rpc-surface';
import { sealRpcSurface } from '@nimbus-sh/fabric/sealed.js';
import { ActivationGate, reportSocketCallFailures, startBeforeRpc } from '../activation-gate';

import {
  isEvalAccountEmail, objectNamed,
  ownerCaller, type AccessTokenMint, type AccessTokenRecord, DEVICE_CONNECT_PATH, DEVICE_TERMINAL_PATH, type Credential, type ExperienceEntry, type ExperienceKind, type ProfileCatalogEnvelope, type PublishableCandidate, type JsonValue, type EgressRequestFacts, type NameOrigin, initUserTables, requireTier, type UserCaller, type WorkspaceCapability, type ResolvedCaller, deviceIdFromSocket, terminalFromSocket, type AuthRequest, type AuthResolution, type EgressInjectionResult, type SecretSummary, type SecretInput, type SecretDestination, type GrantedSecrets, type DisconnectOutcome, initAccessTokenTable, type GitHubRefreshAnswer, type GitHubRefreshAsk, type MossaicVfs, recoveryBackoffMs, type WorkspaceOverview, type DeviceCheckpointHint, type DeviceExecOutput, type DeviceStatus, type DeviceTier, type DriveListing, type DriveUploadOutcome, type MarkedSkill, type RelayedProvider, type RosterPage, type CredentialSummary, type WorkspaceEntry, type UserProfile, DEVICE_FRAMES, DEVICE_SCREEN_PATH, screenFromSocket, readScreenData, statementText,   bookmarkNow, restartedForRestore, restoreArmed, type ArmedRestore, type RestoreTarget,
} from '@kinu.run/core';

import { DurableObjectOAuthClientProvider, type AgentMcpOAuthProvider } from 'agents/mcp/do-oauth-client-provider';

// Re-exported for tests: the provider binds `agents/mcp/*` at load, so tests must import it
// via user-do (after the stub lands), not mcp.ts directly.
export { RegisteredAppOAuthClientProvider } from './mcp-registered-app';

import { diagnostics, KinuError, refusalOf, settle, tolerate, toKinuError } from '@kinu.run/core/obs';
import * as v from 'valibot';
import {
  censusOf, durableStamps, ERROR_STATUS, mcpPresetById, readStamp, repairSchema, SCHEMA_TABLES, requireOps, StoragePredatesReleaseError, writeStamp,
  type OpsCaller, type Repair, type TablesAnswer,
} from '@kinu.run/core';
import { Hono } from 'hono';
import { rawPath, rethrow } from '../api/context';
import { destroyDriveTenant, tenantDrive } from '../drive/tenant';
import { forgetSharesGiven, forgetSharesReceived } from './shares-given';
import { internalCaller } from '@kinu.run/core/control-plane';
import { BUILTIN_ACCOUNTS_OBJECT, builtinSignInOn } from '@kinu.run/core/identity';
import { controlPlaneStub, hasControlPlane } from '../control-plane/stub';

import { installAnalyticsDiagnostics, openAnalyticsWindow } from '@kinu.run/core/analytics';
import type { McpPresetAvailability, McpServerSummary, ProviderListing } from '@kinu.run/core';
import {
  acceptRosterSocket, isRosterSocket, rosterForeground, rosterGone, rosterSockets, sendForeground, unreportedWorkspaces, ROSTER_SOCKET_PATH, type RosterQuery,
} from './roster';

import { UserDrive, type DriveAnswer, type DriveChunkWrite } from './drive';
import { UserDevices, type DeviceCancellationOutcome } from './devices';
import { ACCOUNT_EPOCH_FIELDS, DeviceHelloHeadSchema, DeviceHelloSchema, DeviceUpdateHelloSchema } from '@kinu.run/core';
import { UserTerminals } from './terminals';
import { UserScreens } from './screens';
import { UserChatGptSignIn, type ChatGptMachineSignIn, type ChatGptPlanStatus } from './chatgpt-sign-in';
import { UserMcpServers, USER_MCP_CLIENT_NAME, type McpToolCall, type McpToolSurface } from './mcp-servers';
import { UserAccountMemory } from './account-memory';
import type { AccountMemoryView, AccountNoteHit, AccountProposal, AccountProposer, Fact, InvocationSurface, SqlValue } from '@kinu.run/core';
import {
  UserSessions, type BrowserSessionIdentity, type CliAgentConnectTicketVerification, type CliTokenVerification, type LiveBrowserSession,
} from './sessions';

import { UserCredentials, type CheckpointedCredential, type CredentialEndpoint, type CodexStatus } from './credentials';
import { UserSecrets } from './secrets';
import { mcpOAuthStorage } from './mcp-oauth-storage';
import { UserWorkspaces, type WorkspaceRegistration, type WorkspaceRegistrationSource } from './workspaces';
import { UserProfileStore, type ProfileCatalogWriteResult } from './profile';
import { accountSlateAi, addSlateAiSpend, slateAiSpendOf } from './slate-ai-account';
import {
  EffectApprovals, SlateConsentSchema, SlateConsentStore, partAiCall, partCallVerdict, resolvePartCall,
  type PartAiAnswer, type PartConnectionAnswer, type SlateAiRoute, type SlateConsent,
} from '@kinu.run/core/slates';
import { McpToolSurfaceSchema } from '@kinu.run/core';
import { parseJsonValue } from '../../../core/src/utils/json';
import { Effect } from 'effect';
import type { AccountSpend, SlateSurfaceValue } from '@kinu.run/core';
import { ShareCardJobs, type HeldShare, type ReceivedShare } from './share-cards';
import { EvalLeaseJobs } from './eval-leases';
import { WorkspaceDeletionJobs } from './workspace-deletions';
import { accountIdFor } from '../auth/store';
import type { SqlRow, UserObjectHost } from './user-host';

import {
  initBuiltinAccounts, type Admission, type AttemptBucket, type ChallengePurpose, type Grant, type NewBuiltinAccount, type NewInvite, type PasskeyAccount, type PasswordAccount, type PendingChallenge, type ListedAccount, type Reset, type SigningAccount,
} from '@kinu.run/core/identity';

const ROSTER_NUDGE_LANES = 4;

const DeviceRotationAckSchema = v.object({ type: v.literal(DEVICE_FRAMES.rotated) });

function isTextWebSocketMessage(
  message: string | ArrayBuffer | ArrayBufferView,
): message is string {
  return v.is(v.string(), message);
}

/** The account's model settings as a workspace reads them: its profile catalog's version, its credentials' revision. */
export interface AccountSettingsRevision {
  readonly catalog: number;
  readonly credentials: number;
}

/** When the account was deleted: the one thing its object keeps after, until a sign-in makes it an account again. */
const ACCOUNT_DELETED_KEY = 'account:deleted-at';

export class UserDO extends Agent<Env> {
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    sealRpcSurface(this, USER_DO_RPC_SURFACE);
    // Asked once, never caught: storage a release left behind is brought to this build here, before any event reads it
    // (core state/schema-repair.ts), and one that cannot be answers every call with why.
    const stamps = durableStamps(this.ctx.storage.kv);
    const stamp = readStamp(stamps, this.ctx.storage.sql, 'account');
    const { storage } = this.ctx;

    // The builtin sign-in directory makes its tables when first asked; it repairs them as every account does its own.
    const directory = storage.sql.exec(`SELECT 1 FROM sqlite_master WHERE name = 'builtin_accounts'`).toArray().length > 0;

    this.schemaRepair = repairSchema(storage.sql, {
      schema: 'account', tables: SCHEMA_TABLES.account, stamps, transactionSync: (write) => storage.transactionSync(write),
      init: () => {
        this.initTables();

        if (directory) initBuiltinAccounts((query, ...values) => this.sql(query, ...values));
      },
    }, `account ${ctx.id.toString()}`);

    if (this.schemaRepair?.refused != null) this.storageRefusal = new StoragePredatesReleaseError('account', this.schemaRepair.refused);
    const gate = new ActivationGate(() => this.storageRefusal);
    this.lifecycle.use(gate);
    this.lifecycle.use(this.shareCards);
    this.lifecycle.use(this.evalLeases);
    this.lifecycle.use(this.workspaceDeletions);
    startBeforeRpc(this, USER_DO_STARTED_RPC, () => gate.ready());
    // A DO is its own isolate, so the Worker's diagnostics sink must be installed here too.
    installAnalyticsDiagnostics(this.env);

    // Every event, a native RPC included, reaches whole tables: native RPCs run no `onStart`.
    if (this.storageRefusal === undefined) this.initTables();

    if (stamp === 'unmade') writeStamp(stamps, 'account');
  }

  /** Why this account's storage may not be read: its repair could not bring it to this build. */
  private readonly storageRefusal: StoragePredatesReleaseError | undefined;

  /** What this activation's repair did, for the deploy's walk; null where the storage was at this build. */
  private readonly schemaRepair: Repair | null;

  /** Every gated RPC waits for this (`startBeforeRpc`); the MCP dials it starts are not awaited. */
  override onStart(): void {
    if (this.storageRefusal !== undefined) return;
    this.mcpServers.start();
    this.workspaceDeletions.adoptMarked();
  }

  private readonly host: UserObjectHost = {
    ctx: this.ctx, env: this.env,
    sqlx: (query, ...bindings) => this.sqlx(query, ...bindings),
    requireTier: (caller, capability) => this.requireTier(caller, capability),
    sessionStands: (tokenHash) => this.sessions.sessionStands(tokenHash),
  };

  private readonly credentials = new UserCredentials(this.host);

  private readonly secrets: UserSecrets = new UserSecrets(this.host, {
    configured: () => this.mcpServers.githubConnected(),
    token: async () => this.mcpServers.githubGitToken(),
  });

  private readonly sessions = new UserSessions({ ...this.host, sql: (query, ...values) => this.sql(query, ...values), accountName: () => this.name, getProfile: (caller) => this.profile.getProfile(caller), workspaceRegistered: (name) => this.workspaces.workspaceRegistered(name) });

  private readonly mcpServers: UserMcpServers = new UserMcpServers({
    ...this.host, mcp: this.mcp, vault: this.credentials, connectionsMoved: async () => this.secrets.connectionsMoved(),
  });

  private readonly slateConsentStore = new SlateConsentStore(this.ctx.storage.sql);

  /** One approval admits one exact effect; these disappear with the transient runs on eviction. */
  private readonly effectApprovals = new EffectApprovals();

  private readonly accountMemory = new UserAccountMemory({
    ...this.host,
    sql: <T,>(query: TemplateStringsArray, ...values: SqlValue[]): T[] => this.ctx.storage.sql.exec<Extract<T, Record<string, SqlStorageValue>>>(statementText(query), ...values).toArray(),
  });

  private readonly shareCards = new ShareCardJobs({
    sql: this.ctx.storage.sql,
    owner: () => ({ userId: this.name, email: this.sqlx<{ email: string }>(`SELECT email FROM user_profile WHERE id = 1`)[0]?.email ?? '' }),
    recipient: (userId) => objectNamed(this.env.UserDO, userId),
    accountOf: (email) => accountIdFor(this.env, email),
    caller: () => ownerCaller(this.env),
    forget: (person, workspaces) => this.forgetPersonIn(person, workspaces),
  });

  private readonly evalLeases = new EvalLeaseJobs({
    evalAccount: () => isEvalAccountEmail(this.env.DEV_USER_EMAIL ?? '', this.sqlx<{ email: string }>(`SELECT email FROM user_profile WHERE id = 1`)[0]?.email ?? ''),
    markOf: (workspace) => this.workspaces.markOf(workspace),
    tearDown: (workspace) => this.workspaces.tearDownWorkspace(workspace, this.name),
  });

  private readonly workspaceDeletions = new WorkspaceDeletionJobs({
    marked: () => this.workspaces.markedForDeletion(),
    tearDown: (workspace) => this.workspaces.tearDownWorkspace(workspace, this.name),
  });

  private readonly workspaces = new UserWorkspaces({
    ...this.host, mcpServers: this.mcpServers, shareCards: this.shareCards, evalLeases: this.evalLeases, deletions: this.workspaceDeletions,
    nudgeUnreported: () => { this.nudgeUnreported(); },
    ownerId: () => this.name,
  });

  private readonly profile = new UserProfileStore({ ...this.host, workspaces: this.workspaces });

  private readonly devices = new UserDevices({
    ...this.host, chatgptSignIns: () => this.chatgpt.chatgptSignIns(), accountName: () => this.name,
    workspaceRegistered: (name) => this.workspaces.workspaceRegistered(name),
  });

  private readonly chatgpt = new UserChatGptSignIn({ ...this.host, devices: this.devices, vault: this.credentials });

  private readonly terminals = new UserTerminals({ ...this.host, devices: this.devices });

  private readonly screens = new UserScreens({ ...this.host, devices: this.devices });

  private readonly userDrive = new UserDrive({ ...this.host, accountId: () => this.name, driveFor: (tenant) => this.driveFor(tenant) });

  /** A sign-in: an account deleted before is a new one now, and keeps cards again. */
  async ensureProfile(caller: UserCaller, email: string, displayName?: string): Promise<UserProfile> {
    const profile = await this.profile.ensureProfile(caller, email, displayName);

    this.ctx.storage.kv.delete(ACCOUNT_DELETED_KEY);

    return profile;
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

  claimConfig(caller: UserCaller, key: string, proposed: string): Promise<string> {
    return this.profile.claimConfig(caller, key, proposed);
  }

  getProfileCatalog(caller: UserCaller): Promise<ProfileCatalogEnvelope> {
    return this.profile.getProfileCatalog(caller);
  }

  /**
   * A slate's `workspace.ai` call for this account's own personal part: run with this account's
   * own catalog, credentials and spend (`slate-ai-account.ts`), never the slate owner's.
   */
  async slateAi(caller: UserCaller, request: { readonly workspace: string; readonly route: SlateAiRoute }): Promise<SlateSurfaceValue> {
    await this.requireTier(caller, 'credentials.model');

    return accountSlateAi({
      env: this.env, accountId: this.name, catalog: (asker) => this.profile.getProfileCatalog(asker), credentialsRevision: (asker) => this.credentials.getCredentialsRevision(asker),
      spent: (spend) => { addSlateAiSpend(this.ctx.storage.sql, spend); },
    }, caller, request);
  }

  /** This account's model calls in other people's slates, per provider account: read with its workspaces' in its usage. */
  async slateAiSpend(caller: UserCaller): Promise<AccountSpend[]> {
    await this.requireTier(caller, 'account');

    return slateAiSpendOf(this.ctx.storage.sql);
  }

  async slateConsents(caller: UserCaller, request: { readonly workspace: string; readonly slate: string }): Promise<SlateConsent[]> {
    await this.requireTier(caller, 'account');

    return this.slateConsentStore.forSlate(request.workspace, request.slate);
  }

  async consentSlate(caller: UserCaller, consent: SlateConsent): Promise<SlateConsent> {
    await this.requireTier(caller, 'account');

    return settle(Effect.gen({ self: this }, function* () {
      const parsed = v.safeParse(SlateConsentSchema, consent);

      if (!parsed.success) return yield* new KinuError('bad_input', 'A slate consent must name its workspace, slate, connection, root, tools, effects and revision.');
      this.slateConsentStore.put(parsed.output);

      return parsed.output;
    }));
  }

  async withdrawSlateConsent(caller: UserCaller, request: { readonly workspace: string; readonly slate: string; readonly server: string; readonly root: Readonly<Record<string, string>> }): Promise<boolean> {
    await this.requireTier(caller, 'account');

    return this.slateConsentStore.withdraw(request.workspace, request.slate, request.server, request.root);
  }

  /** `mcp.tools` is the same floor as userMcp_callTool: the account's connection, with this slate's consent checked too. */
  async slatePartTool(caller: UserCaller, request: {
    readonly workspace: string; readonly slate: string; readonly revision: string; readonly server: string; readonly tool: string; readonly args: JsonValue[];
  }): Promise<PartConnectionAnswer<JsonValue>> {
    await this.requireTier(caller, 'mcp.tools');

    return settle(Effect.gen({ self: this }, function* () {
      const { workspace, slate, revision, server, tool } = request;
      const surface = v.parse(McpToolSurfaceSchema, yield* Effect.promise(() => this.userMcp_toolDescriptors(caller)));
      const resolved = resolvePartCall(surface.descriptors, request);

      if (resolved.kind === 'missing') return { kind: 'missing' as const, message: `Your connections do not offer ${server}.${tool}.` };

      if (resolved.kind === 'malformed') return yield* new KinuError('bad_input', `${server}.${tool} takes one JSON object argument.`);
      const { descriptor, payload, call: { root } } = resolved;
      const verdict = partCallVerdict(this.slateConsentStore.find(workspace, slate, server, root), resolved.call, revision, false);
      // What its asks call the connection and the tool: the catalog's own name for a preset server, else the person's.
      const titles = { serverTitle: mcpPresetById(descriptor.presetId ?? '')?.title ?? descriptor.serverName, toolTitle: descriptor.title ?? descriptor.name };

      if (verdict.kind === 'needs-consent') return { ...verdict, ask: { ...verdict.ask, ...titles } };

      if (verdict.kind === 'needs-approval') {
        const call = { workspace, slate, revision, server, tool, root, payload };

        if (!this.effectApprovals.take(call)) return { kind: 'needs-approval' as const, ask: { ...this.effectApprovals.ask(call), ...titles } };
      }

      const text = yield* Effect.promise(() => this.userMcp_callTool(caller, { serverId: descriptor.serverId, name: tool, args: payload, id: crypto.randomUUID() }));

      return { kind: 'ran' as const, value: parseJsonValue(text) };
    }));
  }

  /**
   * Whether each call a personal part's paused run already made is still within this account's consent at the revision
   * (nothing is run): what a resumed run may be answered from. A connection no longer offered is no longer consented.
   */
  async slatePartConsented(caller: UserCaller, calls: readonly {
    readonly workspace: string; readonly slate: string; readonly revision: string; readonly server: string; readonly tool: string; readonly args: JsonValue[];
  }[]): Promise<boolean[]> {
    await this.requireTier(caller, 'mcp.tools');

    const mcp = calls.some((call) => call.server !== 'ai')
      ? v.parse(McpToolSurfaceSchema, await this.userMcp_toolDescriptors(caller)).descriptors : [];

    return calls.map((call) => {
      const { workspace, slate, revision, server, tool } = call;

      if (server === 'ai') return (tool === 'run' || tool === 'stream') && partCallVerdict(this.slateConsentStore.find(workspace, slate, 'ai', {}), partAiCall(tool), revision, true).kind === 'run';
      const resolved = resolvePartCall(mcp, call);

      return resolved.kind === 'resolved' && partCallVerdict(this.slateConsentStore.find(workspace, slate, server, resolved.call.root), resolved.call, revision, true).kind === 'run';
    });
  }

  /** Same `credentials.model` floor as slateAi; consent adds the viewer's revision-bound permission, not a new credential path. */
  async slatePartAi(caller: UserCaller, request: { readonly workspace: string; readonly slate: string; readonly revision: string; readonly route: SlateAiRoute }): Promise<PartAiAnswer> {
    await this.requireTier(caller, 'credentials.model');
    const verdict = partCallVerdict(this.slateConsentStore.find(request.workspace, request.slate, 'ai', {}), partAiCall(request.route.stream === true ? 'stream' : 'run'), request.revision, false);

    if (verdict.kind === 'needs-consent') return verdict;

    return { kind: 'ran', value: await this.slateAi(caller, request) };
  }

  async decideSlateEffect(caller: UserCaller, request: { readonly id: string; readonly decision: 'approve' | 'decline' }): Promise<boolean> {
    await this.requireTier(caller, 'account');

    return this.effectApprovals.decide(request.id, request.decision === 'approve');
  }

  getWorkspaceProfileCatalog(caller: UserCaller): Promise<ProfileCatalogEnvelope> {
    return this.profile.getWorkspaceProfileCatalog(caller);
  }

  putProfileCatalog(caller: UserCaller, catalog: JsonValue, expectedVersion: number): Promise<ProfileCatalogWriteResult> {
    return this.profile.putProfileCatalog(caller, catalog, expectedVersion);
  }

  /** A deleted account keeps no card: it answers `deleted`, and its sender forgets it (`ShareCardJobs.onJob`). */
  async shareCards_put(caller: UserCaller, row: ReceivedShare): Promise<'kept' | 'deleted'> {
    await this.requireTier(caller, 'shares');

    if (this.ctx.storage.kv.get(ACCOUNT_DELETED_KEY) !== undefined) return 'deleted';
    await this.profile.shareCards_put(caller, row);

    return 'kept';
  }

  shareCards_remove(caller: UserCaller, ownerUserId: string, workspace: string, shareId: string): Promise<void> {
    return this.profile.shareCards_remove(caller, ownerUserId, workspace, shareId);
  }

  libraryTiles(caller: UserCaller): ReturnType<UserProfileStore['libraryTiles']> {
    return this.profile.libraryTiles(caller);
  }

  sharesReceived_list(caller: UserCaller): Promise<HeldShare[]> {
    return this.profile.sharesReceived_list(caller);
  }

  sharesSeenAt(caller: UserCaller): Promise<number | null> {
    return this.profile.sharesSeenAt(caller);
  }

  sharesSeen(caller: UserCaller, at: number): Promise<void> {
    return this.profile.sharesSeen(caller, at);
  }

  /**
   * An account this one shared with is deleted; its delete names the workspaces of this account that shared with it.
   * Each forgets it (`OrchestratorAgent.forgetPerson`), then no card goes to it again and nothing here names it.
   */
  async shareRecipient_forget(caller: UserCaller, person: { readonly userId: string; readonly email: string }, workspaces: readonly string[]): Promise<void> {
    await this.requireTier(caller, 'shares');
    await this.forgetPersonIn(person, workspaces);
    await this.shareCards.forgetRecipient(person.userId);
  }

  /** `person` forgotten in those of `workspaces` that are this account's, and in its overviews of them. */
  private async forgetPersonIn(person: { readonly userId: string; readonly email: string }, workspaces: readonly string[]): Promise<void> {
    const mine = new Set(this.sqlx<{ name: string }>(`SELECT name FROM user_workspaces`).map((row) => row.name));

    for (const workspace of new Set(workspaces)) {
      if (mine.has(workspace)) await objectNamed(this.env.OrchestratorAgent, workspace).forgetPerson(this.name, person);
    }

    this.workspaces.forgetShareUser(person.email);
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

  listActiveWorkspaces(caller: UserCaller, filter?: { readonly awaitsSettings?: boolean }): Promise<WorkspaceEntry[]> {
    return this.workspaces.listActiveWorkspaces(caller, filter);
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

  listCredentials(caller: UserCaller): Promise<CredentialSummary[]> {
    return this.credentials.listCredentials(caller);
  }

  setCredential(caller: UserCaller, key: string, credentialJson: Credential | JsonValue): Promise<void> {
    return this.credentials.setCredential(caller, key, credentialJson);
  }

  deleteCredential(caller: UserCaller, key: string, revoke: boolean): Promise<DisconnectOutcome> {
    return this.credentials.deleteCredential(caller, key, revoke);
  }

  checkpointCredentials(caller: UserCaller, account: string): Promise<CheckpointedCredential[]> {
    return this.credentials.checkpointCredentials(caller, account);
  }

  restoreCredentials(caller: UserCaller, account: string, checkpoint: readonly CheckpointedCredential[]): Promise<string[]> {
    return this.credentials.restoreCredentials(caller, account, checkpoint);
  }

  getCredentialsRevision(caller: UserCaller): Promise<number> {
    return this.credentials.getCredentialsRevision(caller);
  }

  storedProviderListing(caller: UserCaller, accounts: string): Promise<ProviderListing | null> {
    return this.credentials.storedProviderListing(caller, accounts);
  }

  keepProviderListing(caller: UserCaller, revision: number, accounts: string, listing: ProviderListing): Promise<void> {
    return this.credentials.keepProviderListing(caller, revision, accounts, listing);
  }

  /**
   * What a workspace's model settings were read under, in one call: its profile catalog's version and its credentials'
   * revision. A workspace asks it as a turn opens, since a change does not wake one at rest, and reads again only what moved.
   */
  async getSettingsRevision(caller: UserCaller): Promise<AccountSettingsRevision> {
    const [catalog, credentials] = await Promise.all([this.profile.getWorkspaceProfileCatalogVersion(caller), this.credentials.getCredentialsRevision(caller)]);

    return { catalog, credentials };
  }

  listSecrets(caller: UserCaller): Promise<SecretSummary[]> {
    return this.secrets.listSecrets(caller);
  }

  putSecrets(caller: UserCaller, entries: readonly SecretInput[], grantTo: readonly string[]): Promise<void> {
    return this.secrets.putSecrets(caller, entries, grantTo);
  }

  setSecretDestination(caller: UserCaller, name: string, destination: SecretDestination): Promise<void> {
    return this.secrets.setSecretDestination(caller, name, destination);
  }

  deleteSecret(caller: UserCaller, name: string): Promise<void> {
    return this.secrets.deleteSecret(caller, name);
  }

  grantSecret(caller: UserCaller, input: Parameters<UserSecrets['grantSecret']>[1]): Promise<void> {
    return this.secrets.grantSecret(caller, input);
  }

  revokeSecretGrant(caller: UserCaller, input: Parameters<UserSecrets['revokeSecretGrant']>[1]): Promise<void> {
    return this.secrets.revokeSecretGrant(caller, input);
  }

  grantedSecrets(caller: UserCaller): Promise<GrantedSecrets> {
    return this.secrets.grantedSecrets(caller);
  }

  revealedSecrets(caller: UserCaller): Promise<Record<string, string>> {
    return this.secrets.revealedSecrets(caller);
  }

  revealedSecretsFor(caller: UserCaller, workspace: string): Promise<Record<string, string>> {
    return this.secrets.revealedSecretsFor(caller, workspace);
  }

  resolveEgressInjection(caller: UserCaller, facts: EgressRequestFacts, workspace: string): Promise<EgressInjectionResult> {
    return this.secrets.resolveEgressInjection(caller, facts, workspace);
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

  startClaudeSignIn(caller: UserCaller): ReturnType<UserCredentials['startClaudeSignIn']> {
    return this.credentials.startClaudeSignIn(caller);
  }

  finishClaudeSignIn(caller: UserCaller, returned: string): ReturnType<UserCredentials['finishClaudeSignIn']> {
    return this.credentials.finishClaudeSignIn(caller, returned);
  }

  disconnectCodex(caller: UserCaller, revoke: boolean): Promise<DisconnectOutcome> {
    return this.credentials.disconnectCodex(caller, revoke);
  }

  getCodexStatus(caller: UserCaller): Promise<CodexStatus> {
    return this.credentials.getCodexStatus(caller);
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

  builtinResetAccount(caller: UserCaller, grant: Grant): Promise<SigningAccount | null> {
    return this.sessions.builtinResetAccount(caller, grant);
  }

  builtinApplyReset(caller: UserCaller, reset: Reset): Promise<SigningAccount | null> {
    return this.sessions.builtinApplyReset(caller, reset);
  }

  builtinListAccounts(caller: UserCaller): Promise<ListedAccount[]> {
    return this.sessions.builtinListAccounts(caller);
  }

  builtinRemoveAccount(caller: UserCaller, person: { readonly userId: string; readonly email: string }): Promise<void> {
    return this.sessions.builtinRemoveAccount(caller, person);
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
    agentName: string;
    cliTokenHash: string;
  }): ReturnType<UserSessions['issueCliAgentConnectTicket']> {
    return this.sessions.issueCliAgentConnectTicket(caller, input);
  }

  verifyCliAgentConnectTicket(caller: UserCaller, ticket: string, expected: { userId: string; agentName: string }): Promise<CliAgentConnectTicketVerification> {
    return this.sessions.verifyCliAgentConnectTicket(caller, ticket, expected);
  }

  userMcp_warmConnections(caller: UserCaller): ReturnType<UserMcpServers['userMcp_warmConnections']> {
    return this.mcpServers.userMcp_warmConnections(caller);
  }

  userMcp_connectedPresets(caller: UserCaller): Promise<string[]> {
    return this.mcpServers.userMcp_connectedPresets(caller);
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

  userMcp_toolDescriptors(caller: UserCaller): Promise<McpToolSurface> {
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

  userMcp_beginConnect(caller: UserCaller, id: string, run: string): ReturnType<UserMcpServers['userMcp_beginConnect']> {
    return this.mcpServers.userMcp_beginConnect(caller, id, run);
  }

  userMcp_reconnect(caller: UserCaller, id: string): ReturnType<UserMcpServers['userMcp_reconnect']> {
    return this.mcpServers.userMcp_reconnect(caller, id);
  }

  /**
   * Eval-only: ends this account's activation as the platform's hibernation does, so the next request is a fresh wake
   * that dials every MCP server again. Sealed in `rpc-surface.ts`, eval-service identity only (`eval/abort-route.ts`).
   */
  async evalAbortActivation(): Promise<void> {
    this.ctx.abort('eval-service: the account activation was aborted on request');
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

  signOutChatGpt(caller: UserCaller, revoke: boolean): ReturnType<UserChatGptSignIn['signOutChatGpt']> {
    return this.chatgpt.signOutChatGpt(caller, revoke);
  }

  openDeviceTerminal(caller: UserCaller, agentName: string, window: { cols: number; rows: number }, target: { device?: string; session?: string }): ReturnType<UserTerminals['openDeviceTerminal']> {
    return this.terminals.openDeviceTerminal(caller, agentName, window, target);
  }

  listDeviceSessions(caller: UserCaller, agentName: string, deviceId: string): ReturnType<UserTerminals['listDeviceSessions']> {
    return this.terminals.listDeviceSessions(caller, agentName, deviceId);
  }

  openDeviceSession(caller: UserCaller, agentName: string, deviceId: string, name?: string): ReturnType<UserTerminals['openDeviceSession']> {
    return this.terminals.openDeviceSession(caller, agentName, deviceId, name);
  }

  renameDeviceSession(caller: UserCaller, agentName: string, deviceId: string, request: { id: string; name: string }): ReturnType<UserTerminals['renameDeviceSession']> {
    return this.terminals.renameDeviceSession(caller, agentName, deviceId, request);
  }

  closeDeviceSession(caller: UserCaller, agentName: string, deviceId: string, id: string): ReturnType<UserTerminals['closeDeviceSession']> {
    return this.terminals.closeDeviceSession(caller, agentName, deviceId, id);
  }

  openDeviceScreen(caller: UserCaller, agentName: string, deviceId?: string): ReturnType<UserScreens['openDeviceScreen']> {
    return this.screens.openDeviceScreen(caller, agentName, deviceId);
  }

  issueDeviceJoin(caller: UserCaller, workspace: string | null): ReturnType<UserDevices['issueDeviceJoin']> {
    return this.devices.issueDeviceJoin(caller, workspace);
  }

  joinDevice(caller: UserCaller, ticket: string, label?: string, replaces?: string): ReturnType<UserDevices['joinDevice']> {
    return this.devices.joinDevice(caller, ticket, label, replaces);
  }

  registerDevice(caller: UserCaller, label?: string, replaces?: string, join?: string): ReturnType<UserDevices['registerDevice']> {
    return this.devices.registerDevice(caller, label, replaces, join);
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
      deviceId?: string; agentName?: string; actorId?: string; checkpoint?: DeviceCheckpointHint;
      timeoutMs?: number; requestId?: string; backgroundJobId?: string; surface?: InvocationSurface;
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

  cancelDeviceRequestsForAgent(caller: UserCaller, actorId: string): Promise<DeviceCancellationOutcome[]> {
    return this.devices.cancelDeviceRequestsForAgent(caller, actorId);
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

  grantDeviceConsent(caller: UserCaller, agentName: string, deviceId: string): ReturnType<UserDevices['grantDeviceConsent']> {
    return this.devices.grantDeviceConsent(caller, agentName, deviceId);
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

  /** Keyed by {@link USER_MCP_CLIENT_NAME}, not this object's name: every stored grant uses that key, sealed. */
  override createMcpOAuthProvider(callbackUrl: string): AgentMcpOAuthProvider {
    return new DurableObjectOAuthClientProvider(mcpOAuthStorage(this.ctx, this.env), USER_MCP_CLIENT_NAME, callbackUrl);
  }

  /**
   * The operator's restore (`/ops/restore`, ARCHITECTURE-DECISIONS W7): this account's storage, armed to go back to
   * `target` at its next start; `opsRestart` ends it at once. Only `/ops/*` holds the capability.
   */
  async opsRestore(caller: OpsCaller, target: RestoreTarget): Promise<ArmedRestore> {
    return await restoreArmed(this.ctx, this.env, caller, target);
  }

  /** Ends this activation, so an armed restore lands. */
  async opsRestart(caller: OpsCaller): Promise<void> {
    await restartedForRestore(this.ctx, this.env, caller);
  }

  /** Where this object's history stands now. */
  async opsBookmark(caller: OpsCaller): Promise<string> {
    return await bookmarkNow(this.ctx, this.env, caller);
  }

  /** The deploy's walk (`scripts/reset.ts tables`): this account's tables and their rows, what its repair did, and the
   *  objects it leads the walk to, its workspaces and (the builtin directory's) accounts. Only `/ops/tables` holds the
   *  capability. */
  async opsTables(caller: OpsCaller): Promise<TablesAnswer> {
    await requireOps(this.env, caller);
    const census = censusOf(this.ctx.storage.sql);
    const open = this.storageRefusal === undefined;
    const workspaces = open ? this.sqlx<{ name: string }>(`SELECT name FROM user_workspaces WHERE create_pending = 0`) : [];
    // The builtin sign-in directory is an account object too, and the one that knows every builtin account.
    const directory = open && census.some(({ table }) => table === 'builtin_accounts');
    const accounts = directory ? this.sqlx<{ user_id: string }>(`SELECT user_id FROM builtin_accounts`) : [];

    return {
      name: null, census, repair: this.schemaRepair, refused: this.storageRefusal?.reason ?? null,
      workspaces: workspaces.map(({ name }) => name), accounts: accounts.map(({ user_id }) => user_id), agents: [],
    };
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
          const [marker] = this.sqlx<{ nudge_attempts: number }>(`SELECT nudge_attempts FROM user_workspaces WHERE name = ?`, name);
          const attempts = (marker?.nudge_attempts ?? 0) + 1;

          this.sqlx(`UPDATE user_workspaces SET nudge_attempts = ?, nudge_next_at = ? WHERE name = ?`, attempts, Date.now() + recoveryBackoffMs(attempts), name);
          await objectNamed(this.env.OrchestratorAgent, name).requestOverviewPush();
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

  /** A WebSocket cannot cross RPC; the Worker forwards these upgrades. */
  private readonly _sockets = new Hono({ getPath: rawPath })
    .all(DEVICE_CONNECT_PATH, async (c) => this.devices.acceptDeviceSocket(c.req.raw, new URL(c.req.url)))
    .all(DEVICE_TERMINAL_PATH, async (c) => this.terminals.acceptTerminalSocket(c.req.raw, new URL(c.req.url)))
    .all(DEVICE_SCREEN_PATH, async (c) => this.screens.acceptScreenSocket(c.req.raw, new URL(c.req.url)))
    // Frames a socket missed while it was down are not replayed, so a new one starts from what waits on the owner now.
    .all(ROSTER_SOCKET_PATH, async (c) => acceptRosterSocket(this.ctx, c.req.raw, (socket) => {
      this.accountMemory.pendingMoved([socket]);
      sendForeground([socket], rosterSockets(this.ctx), this.sessions.sessionStands);
    }))
    .notFound(async (c) => super.fetch(c.req.raw))
    .onError(rethrow);

  /** Storage a release's tables step has not reached answers every socket and request with why, as every RPC does. */
  override async fetch(request: Request): Promise<Response> {
    if (this.storageRefusal !== undefined) return Response.json(refusalOf(this.storageRefusal), { status: ERROR_STATUS[this.storageRefusal.code] });

    return await this._sockets.fetch(request);
  }

  /* These hibernation handlers are declared here, so `Lifecycle.installHandlers` skips them and there
   * is no `super`; foreign sockets are delegated to the lifecycle directly, as `Agent.fetch` does. */
  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer | ArrayBufferView): Promise<void> {
    if (isRosterSocket(ws)) return rosterForeground(ws, message, rosterSockets(this.ctx), this.sessions.sessionStands);
    // Pane bytes are raw keystrokes; decoding them as text would corrupt them.
    const terminal = terminalFromSocket(ws);

    if (terminal) {
      this.terminals._terminals.fromPane(terminal, message);

      return;
    }

    // A viewer's bytes are RFB, relayed unread.
    const viewer = screenFromSocket(ws);

    if (viewer) {
      this.screens._screens.fromViewer(viewer, message);

      return;
    }

    const deviceId = deviceIdFromSocket(ws);

    if (!deviceId) return this.lifecycle.webSocketMessage(ws, message);
    // A screen's bytes are the one binary frame a daemon sends; every other frame is JSON text.
    const screen = isTextWebSocketMessage(message) ? null : readScreenData(message);

    if (screen) {
      this.screens._screens.toViewer(deviceId, screen.stream, screen.bytes);

      return;
    }

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
    if (data === DEVICE_FRAMES.ping) {
      ws.send(DEVICE_FRAMES.pong);

      return;
    }

    // Anything not a HELLO (including non-JSON) is treated as an RPC response.
    const announced = tolerate(() => JSON.parse(data), 'malformed-input');
    const head = v.safeParse(DeviceHelloHeadSchema, announced);

    if (head.success) {
      const admitted = this.devices._devices.hello(deviceId, head.output.protocolVersion, head.output.features);
      const hello = v.safeParse(DeviceHelloSchema, announced);

      if (admitted !== 'serve' || !hello.success) {
        this.sqlx(`UPDATE user_devices SET protocol_refused = 1 WHERE id = ?`, deviceId);
        // The protocol before this one is pushed the build that brings it here, and nothing else.
        const previous = v.safeParse(DeviceUpdateHelloSchema, announced);
        // Decided and sent in the turn the HELLO arrived, on its socket: nothing is awaited before the send.
        const update = admitted === 'update' && previous.success ? this.devices.deviceUpdateFrame(deviceId, previous.output) : null;

        if (update === null || !previous.success) {
          this.devices._devices.refuse(deviceId);

          return;
        }

        diagnostics.event('device.update_pushed', { device: deviceId, from: previous.output.version ?? '', to: update.version });
        ws.send(JSON.stringify(update));

        return;
      }

      this.devices.recordDeviceHello(deviceId, hello.output);
      this.terminals.deviceConnected(deviceId);
      this.screens.deviceConnected(deviceId);
      // Sent before the first wait, in the turn the HELLO arrived on its socket.
      const frame = this.devices.deviceUpdateFrame(deviceId, hello.output);

      if (frame !== null) {
        diagnostics.event('device.update_pushed', { device: deviceId, from: hello.output.version ?? '', to: frame.version });
        ws.send(JSON.stringify(frame));
        await this.devices.devicesMoved();

        return;
      }

      await this.devices.devicesMoved();

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

    // A terminal's, a screen's and the screen state's frames have no request id; the RPC correlator would silently drop
    // them.
    if (this.unrequestedFrame(deviceId, data)) return;
    this.devices._devices.handleMessage(deviceId, data);
  }

  private unrequestedFrame(deviceId: string, data: string): boolean {
    return this.terminals.handleTerminalFrame(deviceId, data) || this.screens.handleScreenFrame(deviceId, data)
      || this.devices.handleDesktopFrame(deviceId, data);
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    if (isRosterSocket(ws)) return rosterGone(ws, rosterSockets(this.ctx), this.sessions.sessionStands);
    // A pane's socket closing hangs up the shell rather than leaving it running with no window.
    const terminal = terminalFromSocket(ws);

    if (terminal) {
      return settle(this.terminals.closeDeviceTerminal(terminal, ws));
    }

    const viewer = screenFromSocket(ws);

    if (viewer) return this.screens._screens.closeStream(viewer.device, viewer.stream);

    const deviceId = deviceIdFromSocket(ws);

    if (!deviceId) return this.lifecycle.webSocketClose(ws, code, reason, wasClean);
    this.devices._devices.handleClose(deviceId, ws);

    // The daemon detaches its shells when the socket drops, so the panes close; each opens again on the next socket.
    this.terminals.deviceClosed(deviceId);
    this.screens.deviceClosed(deviceId);

    await this.devices.devicesMoved();
  }

  override async webSocketError(...call: Parameters<NonNullable<Agent<Env>['webSocketError']>>): Promise<void> {
    const [ws] = call;

    // Device sockets clean up in webSocketClose, which the runtime fires next.
    if (!deviceIdFromSocket(ws) && !isRosterSocket(ws)) return this.lifecycle.webSocketError(...call);
  }

  // The Mossaic tenant id is this account's own id, the name it is addressed by, so no caller names a tenant. Every
  // owner workspace mounts the same one at `/shared`: its recorded owner is that name too.

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

      // One row of independent fences: each is held once it is set, and only that one.
      if (name === 'account_epochs') {
        for (const field of ACCOUNT_EPOCH_FIELDS) {
          const set = this.sqlx<{ n: number }>(`SELECT COUNT(${field}) AS n FROM account_epochs`)[0]?.n ?? 0;

          if (set > 0) held[`account_epochs.${field}`] = set;
        }

        continue;
      }

      const rows = this.sqlx<{ n: number }>(`SELECT COUNT(*) AS n FROM "${name.replaceAll('"', '""')}"`)[0]?.n ?? 0;

      if (rows > 0) held[name] = rows;
    }

    return held;
  }

  /**
   * Delete everything under this account, then the object itself; the step order is the contract.
   * Each step leaves no rows, so a failed sweep resumes on retry; errors propagate to the owner.
   */
  /**
   * Everything the account is, deleted, each store through its own delete path (the privacy policy's promise): the
   * shares it gave and took, its workspaces, devices and MCP servers, its credentials (revoked at their providers), its
   * mail and mail names, its Drive, its place in the fleet's index and Gallery, its built-in sign-in, then this object.
   * A step that fails stops it before this object goes, so a retry still has every index here; each step is idempotent.
   */
  async deleteAccount(caller: UserCaller, ownerUserId: string): Promise<{ ok: true; workspaces: number }> {
    await this.requireTier(caller, 'account');

    if (!/^[a-f0-9]{32}$/.test(ownerUserId)) throw new KinuError('bad_input', 'invalid owner user id');
    const person = { userId: ownerUserId, email: (this.sqlx<{ email: string }>(`SELECT email FROM user_profile WHERE id = 1`)[0]?.email ?? '').trim().toLowerCase() };

    // Every account it sent a card forgets it; its own card jobs are withdrawn first, so none lands after. Every account
    // that sent it one forgets it too, where it shared.
    await forgetSharesGiven(this.env, ownerUserId, caller, await this.shareCards_withdraw(caller));
    const cards = this.sqlx<{ owner_user_id: string; workspace: string }>(`SELECT owner_user_id, workspace FROM user_share_cards`);

    await forgetSharesReceived(this.env, person, caller, cards.map((card) => ({ ownerUserId: card.owner_user_id, workspace: card.workspace })));

    // By name: the first teardown refused stops the sweep, so which went first must not be the query planner's choice.
    const workspaces = this.sqlx<{ name: string }>(`SELECT name FROM user_workspaces ORDER BY name`);

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

    // Each grant revoked at its provider where it can be; a provider that refuses is logged, and the grant goes here.
    for (const { key } of this.sqlx<{ key: string }>(`SELECT key FROM user_credentials`)) await this.credentials.disconnectCredential(key, true);

    await objectNamed(this.env.MAILBOX, ownerUserId).deleteBox(ownerUserId);
    await destroyDriveTenant(this.env, ownerUserId);

    const { ControlPlaneDO } = this.env;

    if (ControlPlaneDO !== undefined && hasControlPlane({ ControlPlaneDO })) {
      await controlPlaneStub({ ControlPlaneDO }).forgetUser(await internalCaller(this.env), person);
    }

    if (builtinSignInOn(this.env)) await objectNamed(this.env.UserDO, BUILTIN_ACCOUNTS_OBJECT).builtinRemoveAccount(await ownerCaller(this.env), person);

    await this.destroy();
    // The isolate abort is a tick away, and a request can land in that tick: it meets the tables made
    // again, empty, and answers as the new account. They are this build's, so they carry its stamp. The
    // one thing kept is when it was deleted, which refuses a card still on its way until a sign-in.
    this.initTables();
    writeStamp(durableStamps(this.ctx.storage.kv), 'account');
    this.ctx.storage.kv.put(ACCOUNT_DELETED_KEY, Date.now());

    return { ok: true, workspaces: workspaces.length };
  }

  userMcp_githubRefresh(caller: UserCaller, ask: GitHubRefreshAsk): Promise<GitHubRefreshAnswer> {
    return this.mcpServers.userMcp_githubRefresh(caller, ask);
  }
}

reportSocketCallFailures(UserDO, Agent);
