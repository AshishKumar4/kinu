/**
 * UserDO — per-user Durable Object. Keyed by the stable Kinu userId.
 * OAuth identities are resolved to that userId by auth/store.ts before requests reach this DO.
 *
 * Owns:
 *   - identity (email, displayName, last_seen)
 *   - agent registry (replaces the browser-side localStorage list)
 *   - credentials (single source of truth — Codex OAuth, BYO API keys)
 *   - user-level config (defaults: model, strategy, inference loop, approval mode)
 *   - in-flight Codex device-code state
 *
 * All secrets live here. Orchestrator agents never store credential material;
 * they call `getAuthHeaders(key)` and get ready-to-attach HTTP headers.
 * Token refresh (Codex OAuth) happens atomically inside this DO.
 *
 * Every privileged method takes a `UserCaller` as its FIRST argument and gates
 * on `requireTier` before doing anything else. That is the whole attenuation
 * boundary: it lives where the secrets are, so no workspace-DO code path,
 * crafted tool, or forgotten tool gate can route around it. Worker routes act
 * for the owner whose identity the edge verified and present the owner
 * capability; agents present their workspace capability token and get whatever
 * their tier allows. Methods the DO calls on itself present it too, because
 * their public entry point was already gated.
 */
import { Agent, type AgentContext } from "agents";
import { USER_DO_RPC_SURFACE, sealRpcSurface } from "../rpc-surface";
import { parseCliTokenUserId } from "../cli/auth-store";
import {
  getActiveAccessTokenScopes,
  listAccessTokens as listAccessTokenRows,
  mintAccessToken as mintAccessTokenRow,
  revokeAccessToken as revokeAccessTokenRow,
  verifyAccessToken as verifyAccessTokenRow,
  type AccessTokenMint,
  type AccessTokenRecord,
  type AccessTokenScope,
} from "../cli/access-token-store";
import { MCPClientManager } from "agents/mcp/client";
import {
  DurableObjectOAuthClientProvider,
  type AgentMcpOAuthProvider,
} from "agents/mcp/do-oauth-client-provider";
import {
  DEVICE_CONNECT_PATH,
  NO_DEVICE_CONNECTED,
  ORCHESTRATOR_AGENT_SLUG,
  nanoid,
  createExperienceLibrary,
  createReleaseStore,
  releaseSqlFromExec,
  BUILTIN_PROFILE_CATALOG,
  profileCatalogDigest,
  validateProfileCatalog,
  type Credential,
  type ExperienceEntry,
  type ExperienceKind,
  type ProfileCatalog,
  type ProfileCatalogEnvelope,
  type PublishableCandidate,
  type ReleaseBoard,
  type ReleaseApproval,
  type ReleaseCheck,
  type ReleaseDetail,
  type ReleaseChange,
  type ReleaseStatus,
  type ReleaseDeployment,
  type ReleaseSource,
  type ReleaseSourceInput,
  CODEX_CRED_KEY,
  CodexOAuthTokenError,
  createCodexOAuthClient,
  decodeCodexAccountId,
  tokensToCredential,
  type DeviceCodeStart,
  type DeviceCheckpointHint,
  type DeviceConsentRequest,
  type JsonObject,
  type JsonValue,
  type OAuthCredential,
  type EgressRequestFacts,
  type EgressSecretBinding,
  JsonObjectSchema,
  decodeJsonValue,
} from '@kinu.run/core';
import {
  diagnostics,
  KinuError,
  renderThrownChain,
  tolerate,
  toKinuError,
} from '@kinu.run/core/obs';
import * as v from 'valibot';
import { initUserTables, PROFILE_CATALOG_CONFIG_KEY } from './schema';
import {
  CapabilityDeniedError,
  armCapabilityReconcile,
  clearCapabilityReconcile,
  commitWorkspaceCapability,
  freshWorkspaceCapability,
  ownerCaller,
  pendingCapabilityReconcile,
  requireTier,
  revokeWorkspaceCapability,
  workspaceCapabilityHash,
  type UserCaller,
  type WorkspaceCapability,
  type ResolvedCaller,
} from './workspace-capability';
import { DeviceSocketHub, deviceIdFromSocket } from './device-hub';
import {
  DeviceRequestLedger,
  type ClaimedDeviceRequest, type DeviceCancelOutcome,
} from './device-inflight';
import { credentialToHeaders, accessTokenExpiring, isModelInferenceCredentialKey } from './credential-headers';
import { validateCredential, validateCredentialKey, validateWorkspaceName } from './validate';
import { createCredentialCipher, type CredentialCipher } from './credential-envelope';
import {
  listEgressSecrets, putEgressSecret, resolveEgressInjection,
  revokeEgressSecret, rewrapEgressSecrets,
  type EgressInjectionResult, type EgressSecretSummary, type EgressVaultDeps,
  type PutEgressSecretInput,
} from './egress-vault';
import { randomToken, sha256Hex } from '../lib/crypto';
import { resolveWorkspaceTitle } from '../lib/agent-naming';
import { installAnalyticsDiagnostics } from '../analytics/install';
import { recordReleaseTransition } from '../analytics/record';
import { openAnalyticsWindow } from '../analytics/writer';
import {
  DEVICE_CONSENT_SCOPE, DEVICE_CONSENT_SCOPE_FULL_FS,
  DEVICE_CONSENT_DENIED, DEVICE_CONSENT_UNANSWERED, DEVICE_PROVISION_METHOD,
  DEVICE_TOKEN_ROTATION, DEVICE_TOKEN_ROTATION_ACK,
  DEVICE_CANCEL_METHOD, DEVICE_CANCEL_PROTOCOL, DEVICE_EXEC_ACK_METHOD, parseDeviceCancelAnswer, nextDeviceRequestId,
  consentScopeCovers, deviceConsentScopeForMethod, mergeConsentScope, parseConsentScope, summarizeDeviceAction,
  type DeviceConsentScope, type DeviceConsentDecision, type DeviceStatus,
  type DeviceFleetEntry,
} from '@kinu.run/core';
import {
  validateMcpServerInput, validateMcpServerName, parseAllowedTools, mapConnectionStatus,
  parseMcpHeaders, mcpCredentialTransport, describeMcpTool, isMcpTransportUnauthorized,
  type McpServerSummary, type McpTransport,
  type SerializableToolDescriptor,
} from './mcp';
import {
  CLOUDFLARE_AI_GATEWAY_CRED_KEY,
  CLOUDFLARE_OAUTH_CRED_KEY,
  CloudflareOAuthTokenError,
  accountIdFromCloudflareCredential,
  cloudflareAIGatewayId,
  cloudflareAccountsFromCredential,
  cloudflareWorkersAIBaseURL,
  fetchCloudflareAIGateways,
  isCloudflareAIGatewayId,
  isCloudflareCredentialExpiring,
  isCloudflareCredentialUsable,
  refreshCloudflareCredential,
  withCloudflareAccount,
  type CloudflareAccount,
  type CloudflareAIGatewaySummary,
} from '../lib/cloudflare-oauth';

const CLI_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180 days
/** How long a device link lives from its last ROTATION. Rotation happens on
 *  every accepted connect, so a machine in use renews itself and never has to
 *  be re-linked; a copy of `device.json` that stops rotating dies on this wall
 *  clock rather than living as long as someone keeps using it. */
const DEVICE_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180 days
const DEVICE_CONNECT_TICKET_TTL_MS = 60 * 1000;
/** How long a fork transfer holds its reserved name without saying it is still
 *  running. Renewed as each frame lands, so the bound is on the GAP between
 *  frames rather than on the transfer: minutes of slack for a slow ranged read
 *  over a large workspace, and still an end for a sender whose Durable Object
 *  died mid-stream. */
const FORK_RESERVATION_LEASE_MS = 5 * 60 * 1000;
/** A device name is a display label, not a hostname — bounded so a UI row
 *  cannot be blown out by one paste. */
const DEVICE_NAME_MAX_LENGTH = 80;
/** Owner-facing checkpoint reads do not execute or write on the device. Every
 * other workspace call, including restore, crosses the consent chokepoint. */
const CONSENT_FREE_DEVICE_METHODS = {
  checkpointStatus: true,
  checkpointList: true,
  checkpointPlan: true,
} as const satisfies Record<string, true>;
const CLI_AGENT_CONNECT_TICKET_TTL_MS = 60 * 1000;
const CLI_AGENT_WEBSOCKET_CAPABILITY = 'agent.websocket' as const;

/** Wire bound for the roster listing. A page past this size answers with the
 *  newest rows plus the whole-roster total — never a silent truncation.
 *  Numerically equal to core status.ts's MAX_HISTORY_LIMIT by coincidence
 *  only: that one caps transcript pages, this one caps registry rows. */
const WORKSPACE_LIST_LIMIT = 200;

/** Stable per-user OAuth callback path. The full URL is built from the
 *  request origin at add-time so it works in any environment without
 *  configuration. NOT the SDK's per-agent default (`/agents/.../callback`)
 *  — every server uses this single per-user endpoint so callback routing
 *  is uniform regardless of which agent triggered the addition. */
const MCP_OAUTH_CALLBACK_PATH = '/api/user/mcp/callback';
/** The OAuth client name this user's MCP plane registers under. It keys the
 *  SDK's own storage (`/{clientName}/{serverId}/...`), so every construction
 *  and every restore has to spell it the same way. */
const USER_MCP_CLIENT_NAME = 'kinu-user-mcp';

/** The sentence a taken MCP server name produces, written once. Both guards
 *  refuse with it: the atomic claim in `claimMcpServerName`, and the UNIQUE
 *  index where it exists. Two spellings of one refusal is how a UI comes to
 *  show a different message than the API.
 *
 *  The MESSAGE rather than a built error, so neither caller needs an optional
 *  cause: the claim has nothing to chain and the translation below has the
 *  violation it caught. */
function mcpNameTakenMessage(name: string): string {
  return `An MCP server named '${name}' already exists.`;
}

/**
 * Rethrow a failed name claim, renaming the `lower(name)` UNIQUE violation to
 * that same sentence.
 *
 * ALWAYS THROWS, which is what `never` says and what lets this carry no
 * `unknown` out. Anything that is not the violation is a real storage failure —
 * including the claim's own refusal, which already carries the sentence — and is
 * rethrown untouched: a blanket rename here would report a full disk as a
 * duplicate name. Rethrowing rather than RETURNING the caught value is the whole
 * of it; a function that hands `unknown` back to be thrown by its caller has
 * only moved the boundary.
 */
function rethrowMcpNameCollision(input: { cause: unknown; name: string }): never {
  if (/UNIQUE constraint failed/i.test(renderThrownChain({ cause: input.cause }))) {
    throw new Error(mcpNameTakenMessage(input.name), { cause: input.cause });
  }
  throw input.cause;
}

/** One configured MCP server that produced no tools for this turn. */
export interface McpServerUnavailable {
  server: string;
  reason: string;
}

/** What the per-user MCP plane offers a turn: the tools it CAN dispatch, and
 *  the configured servers it could not reach. */
export interface McpToolSurface {
  descriptors: SerializableToolDescriptor[];
  unavailable: McpServerUnavailable[];
}

/** The `user_mcp_servers` columns hydration needs: what to register, and
 *  whether the row holds a sealed credential. `headers` stays SEALED here —
 *  it is opened per request inside the transport closure, never carried. */
interface McpHydrationRow extends SqlRow {
  id: string;
  name: string;
  server_url: string;
  transport: McpTransport;
  headers: string | null;
}

interface SqlRow extends Record<string, SqlStorageValue> {}

type DeviceCancellationOutcome = {
  requestId: string;
  outcome: DeviceCancelOutcome | 'failed';
  detail?: string;
};
/** The request id a cancellation frame names, parsed off the outgoing params. */
const CancelledRequestIdSchema = v.pipe(v.string(), v.minLength(1));

const DeviceHelloSchema = v.object({
  type: v.literal('HELLO'),
  os: v.optional(v.string()),
  hostname: v.optional(v.string()),
  /** The directory `kinu connect` ran in — the base tier's whole reach — and
   *  the machine's home. Absolute or ignored: a relative path names nothing
   *  the hub can scope a call to. */
  root: v.optional(v.string()),
  home: v.optional(v.string()),
});
const AbsolutePathSchema = v.pipe(v.string(), v.regex(/^\/.+/));
/** An absolute path, or null for anything else — an older daemon sends
 *  nothing, and a relative path is not a scope. */
function absolutePathOrNull(value: string | undefined): string | null {
  const parsed = v.safeParse(AbsolutePathSchema, value);
  if (!parsed.success) return null;
  return parsed.output.length > 1 ? parsed.output.replace(/\/+$/, '') : parsed.output;
}
const DeviceRotationAckSchema = v.object({ type: v.literal(DEVICE_TOKEN_ROTATION_ACK) });
const LooseObjectSchema = v.looseObject({});
const NullableStringArraySchema = v.nullable(v.array(v.string()));
const NullableStringRecordSchema = v.nullable(v.record(v.string(), v.string()));


function isTextWebSocketMessage(
  message: string | ArrayBuffer | ArrayBufferView,
): message is string {
  return v.is(v.string(), message);
}

export interface UserProfile {
  email: string;
  displayName: string | null;
  createdAt: number;
  lastSeenAt: number;
}

export interface WorkspaceEntry {
  name: string;
  displayName: string;
  createdAt: number;
  lastVisited: number;
  archivedAt: number | null;
}

/** One bounded page of the workspace roster. `total` is the whole active
 *  roster; `nextCursor` walks to the following page and is null past the end,
 *  so the roster's tail is reachable instead of silently dropped. */
export interface WorkspaceList {
  entries: WorkspaceEntry[];
  total: number;
  nextCursor: string | null;
}

/** What {@link UserDO.registerWorkspace} found under a name: the row it just
 *  inserted, the live workspace already there, or a name an uncommitted fork
 *  transfer is holding. `reserved` carries no entry on purpose — a half-written
 *  fork target is not a workspace any caller may act on, and leaving the field
 *  out is what makes acting on it unrepresentable rather than merely wrong. */
export type WorkspaceRegistration =
  | { readonly status: 'created' | 'active'; readonly entry: WorkspaceEntry }
  | { readonly status: 'reserved' };

/** Thrown when a publish is asked to commit something that is not an open
 *  reservation — a wrong timestamp, a name nothing reserved, or a name already
 *  published. Its own class because a fork transfer treats it as its own
 *  rollback trigger and not as a transport fault. Crosses the DO RPC boundary
 *  as its message, the same way `CapabilityDeniedError` does. */
export class WorkspaceReservationNotPendingError extends Error {
  constructor(name: string, why: string) {
    super(`Workspace "${name}" cannot be published: ${why}.`);
    this.name = 'WorkspaceReservationNotPendingError';
  }
}

/** Thrown when a CLI device-code approval is redeemed twice. Its own class
 *  because the poll route answers it as the already-delivered outcome the flow
 *  already has words for, and because the alternative — a bare SQL uniqueness
 *  violation — is not something a caller can read. Crosses the DO RPC boundary
 *  as its message, the same way `CapabilityDeniedError` does. */
class CliAuthorizationSpentError extends Error {
  constructor(options: ErrorOptions) {
    super('That CLI authorization has already been redeemed.', options);
    this.name = 'CliAuthorizationSpentError';
  }
}

/** Outcome of a compare-and-swap catalog write. A typed domain result rather
 *  than an exception because it crosses the DO RPC boundary, where error
 *  classes do not survive and callers must branch on status codes anyway. */
export type ProfileCatalogWriteResult =
  | { readonly ok: true; readonly envelope: ProfileCatalogEnvelope }
  | { readonly ok: false; readonly kind: 'conflict'; readonly currentVersion: number; readonly currentDigest: string }
  | { readonly ok: false; readonly kind: 'malformed'; readonly reason: string };

/** The one persisted account catalog row. It is parsed before profile code
 * trusts its SQL values, so a damaged row cannot become a plausible default. */
interface StoredProfileCatalogRow {
  value: string;
  version: number;
}

/** The catalog and its monotonic CAS version under one account's authority. */
interface ProfileCatalogState {
  version: number;
  catalog: ProfileCatalog;
}

const StoredProfileCatalogRowSchema: v.GenericSchema<StoredProfileCatalogRow> = v.strictObject({
  value: v.string(),
  version: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

/** A page request over the roster. `limit` clamps to [1, WORKSPACE_LIST_LIMIT]. */
export interface WorkspaceListPageQuery {
  cursor?: string | null;
  limit?: number;
}

export interface CredentialSummary {
  key: string;
  kind: 'bearer' | 'oauth' | 'openai-compat';
  createdAt: number;
  updatedAt: number;
}

export interface CodexStatus {
  connected: boolean;
  accountId: string | null;
  expiresAt: number | null;
  startedFlow: { userCode: string; portalURL: string; pollIntervalSec: number } | null;
}

export interface ConnectedProvider {
  id: string;
  label: string;
  /** Credential keys this provider can use. */
  credentialKeys: string[];
}

export interface CliTokenVerification {
  ok: boolean;
  user?: { id: string; email: string; displayName: string | null };
  tokenHash?: string;
  expiresAt?: number;
  /** Present only for scoped `pta_…` access tokens; session tokens are unscoped. */
  scopes?: AccessTokenScope[];
  error?: string;
}

export interface CliAgentConnectTicketVerification {
  ok: boolean;
  user?: { id: string; email: string; displayName: string | null };
  tokenHash?: string;
  expiresAt?: number;
  capabilities?: string[];
  /** Present only when the ticket was minted by a scoped `pta_…` access
   *  token — the websocket boundary pins the connection to these scopes.
   *  Interactive session tickets are unscoped. */
  scopes?: AccessTokenScope[];
  /** The account's authorization generation this connection is admitted under.
   *  It rides the connection's own tags, so a later revocation can name every
   *  socket that predates it — including one restored from hibernation, which
   *  is where the bearer's identity used to be lost entirely. */
  authGeneration?: number;
  error?: string;
}

/** What a browser session cookie stands for, as it stood at the sign-in that
 *  minted it. Written once with the row and never updated: a rename lands on
 *  the next sign-in, because this is what the cookie has always meant. */
export interface BrowserSessionIdentity {
  email: string;
  displayName: string | null;
  provider: string;
  /** Provider subject — `sub`, or the provider's own stable user id. */
  sub: string;
  /** Interactive-auth time in epoch ms, which step-up checks read. */
  authTime: number;
}

/** One browser session as its authority sees it. Being answered at all IS the
 *  liveness answer: a revoked or lapsed session has no row and reads as null.
 *
 *  `identity` is null only for a row registered before the row carried one,
 *  where the KV projection is still the only copy of it. */
export interface LiveBrowserSession {
  identity: BrowserSessionIdentity | null;
}

export function parseCliAgentConnectTicketUserId(ticket: string): string | null {
  const match = /^pat_([a-f0-9]{32})_[A-Za-z0-9_-]{24,}$/.exec(ticket);
  return match?.[1] ?? null;
}

function cleanCliTokenLabel(label?: string): string {
  const trimmed = (label ?? '').trim().replace(/\s+/g, ' ');
  return trimmed ? trimmed.slice(0, 80) : 'Kinu CLI';
}

function parseCapabilityList(value: string): string[] {
  const parsed = v.safeParse(v.array(v.string()), tolerate(() => JSON.parse(value), 'malformed-input'));
  return parsed.success ? parsed.output : [];
}

/** The roster cursor is the ordering key of a page's last row — `(last_visited,
 *  name)` under the listing's `last_visited DESC, name ASC` order — URL-encoded
 *  JSON so it survives query strings without a second encoding scheme. */
function encodeRosterCursor(entry: Pick<WorkspaceEntry, 'name' | 'lastVisited'>): string {
  return encodeURIComponent(JSON.stringify({ v: entry.lastVisited, n: entry.name }));
}

const RosterCursorSchema = v.strictObject({ v: v.number(), n: v.string() });

function decodeRosterCursor(cursor?: string | null): { v: number; n: string } | null {
  if (cursor == null || cursor === '') return null;
  let raw: unknown;
  try {
    raw = JSON.parse(decodeURIComponent(cursor));
  } catch (e) {
    throw new Error('Invalid workspace roster cursor; start from page one.', { cause: e });
  }
  const parsed = v.safeParse(RosterCursorSchema, raw);
  if (!parsed.success) throw new Error('Invalid workspace roster cursor; start from page one.');
  return parsed.output;
}

function clampRosterLimit(limit?: number): number {
  if (limit === undefined) return WORKSPACE_LIST_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Workspace roster limit must be a positive integer.');
  return Math.min(limit, WORKSPACE_LIST_LIMIT);
}

/**
 * Silence the SDK's own MCP manager on this object, before it can dial.
 *
 * The Agent base builds a manager of its own and its init chain calls
 * `restoreConnectionsFromStorage` unconditionally on every activation, with no
 * subclass opt-out (`agents/dist/index.js:1026-1030`). That manager reads the
 * SAME `cf_agents_mcp_servers` rows this object's user plane derives from
 * {@link UserDO.hydrateUserMcp}, but with none of its credential closures — so
 * every activation opened an anonymous connection to every MCP endpoint the
 * user configured, whether or not anyone touched MCP: third-party 401 noise,
 * duplicate sessions churning `server_options`, and an OAuth 401 able to write
 * a fresh `auth_url` onto the shared row, which the user plane then reads as
 * authenticating-and-never-connect.
 *
 * Marking the manager restored is the whole fix: the SDK's restore is then a
 * no-op, and this user's connections are made where their credentials are —
 * `hydrateUserMcp`, on the manager that has them. Set in the constructor, which
 * runs before any entry point reaches the init chain.
 */
function retireInheritedMcpManager(manager: MCPClientManager): void {
  // The CALL is retired, not the private flag behind it: what this object needs
  // is that the SDK's restore does nothing on a manager it never uses, and that
  // is a public method with a stated contract rather than an internal field
  // whose rename would silently bring the dialing back.
  manager.restoreConnectionsFromStorage = async (): Promise<void> => {
    diagnostics.event('mcp.inherited_restore_skipped', { manager: USER_MCP_CLIENT_NAME });
  };
}

export class UserDO extends Agent<Env> {
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    sealRpcSurface(this, USER_DO_RPC_SURFACE);
    // A Durable Object is its own isolate, so the Worker's diagnostics sink is
    // not installed here — see the same call in `ActorAgent`'s constructor. The
    // capability denials this DO's gate produces are the fleet's authorization
    // signal, and without this they reach Workers Logs and no dataset.
    installAnalyticsDiagnostics(this.env);
    retireInheritedMcpManager(this.mcp);
  }

  private _initialized = false;

  /** Per-user MCP manager. NOTE: distinct from the inherited `Agent.mcp`
   *  — that field is the SDK's agent-scoped manager (we don't use it).
   *  This one is per-user and stores its config in `user_mcp_servers`. */
  private _userMcp: MCPClientManager | null = null;

  /** The one full reconciliation in flight. UserDO calls interleave at every
   *  external await; joining this makes remove/register/restore/establish one
   *  credential-safe sequence. Cleared after either settlement so the cause
   *  reaches every joiner and a later caller can retry. */
  private _hydratingUserMcp: Promise<void> | null = null;


  /**
   * Once per activation. Cancellation claims are activation-scoped by
   * construction: the sweep that holds one lives in this isolate's memory, so
   * every claim already in storage when an activation begins was abandoned by
   * the activation that died. Releasing them here needs no lease clock and no
   * elapsed guess — the activation boundary IS the expiry.
   */
  private ensureInit(): void {
    if (this._initialized) return;
    initUserTables(this.ctx.storage.sql);
    this._inflight.releaseAbandonedClaims();
    this._initialized = true;
  }

  private sqlx<T extends SqlRow = SqlRow>(query: string, ...bindings: SqlStorageValue[]): T[] {
    this.ensureInit();
    return this.ctx.storage.sql.exec<T>(query, ...bindings).toArray();
  }

  /**
   * The attenuation gate. First statement of every privileged method below —
   * the check lives here, next to the secrets, rather than in any caller.
   *
   * Also where this object's analytics write window reopens, for the same reason
   * it is the gate: it runs exactly once per RPC, and the platform's 250-point
   * budget is per INVOCATION. Opening it in the constructor alone gave a hot
   * UserDO one budget for a whole activation, after which its capability denials
   * and release transitions stopped reaching the dataset with nothing to say so.
   */
  private requireTier(caller: UserCaller, capability: WorkspaceCapability): Promise<ResolvedCaller> {
    this.ensureInit();
    openAnalyticsWindow(this.env);
    return requireTier(this.ctx.storage.sql, this.env, caller, capability);
  }

  /** Provisioning in flight, per workspace. A Durable Object serializes nothing
   *  across an outbound RPC await, so two concurrent first-touches would
   *  otherwise each mint and each install, leaving the surviving stored hash
   *  and the surviving installed token from DIFFERENT mints — a workspace that
   *  can never authenticate again and never re-provisions, because it does hold
   *  a token. Coalescing on this map is what makes the handshake atomic. */
  private readonly _provisioning = new Map<string, Promise<void>>();

  /**
   * Reconcile a workspace's identity: the workspace reports the hash of the
   * token it holds, and any disagreement with the registry is repaired by
   * minting a fresh one and installing it.
   *
   * `presentedHash` makes this self-healing in both directions — a workspace
   * that holds nothing, and a workspace holding a token this UserDO no longer
   * recognizes (its storage was reset, or a delete tore down one side only).
   *
   * Deliberately ungated, and the ONLY method that is: this is the bootstrap of
   * workspace identity, so it cannot require identity. It is safe because it
   * hands the secret to nobody — the token is delivered straight into the
   * Durable Object of the named workspace, which must already be in this user's
   * registry. The worst a caller can do is force a rotation, after which both
   * sides still agree and the tier is untouched.
   *
   * Being the only ungated method is also why it opens the analytics window
   * itself: every other entry reaches `requireTier`, which does it.
   */
  async ensureWorkspaceCapability(workspaceName: string, presentedHash: string | null): Promise<void> {
    this.ensureInit();
    openAnalyticsWindow(this.env);
    validateWorkspaceName(workspaceName);
    if (!this.workspaceRegistered(workspaceName)) {
      throw new Error(`Workspace ${workspaceName} is not in your registry.`);
    }
    return this.reconcileWorkspaceCapability(workspaceName, presentedHash);
  }

  /**
   * The reconcile itself, from a presented hash to both sides agreeing.
   *
   * Split out of {@link ensureWorkspaceCapability} for
   * {@link publishWorkspaceReservation}, which does its own admission check: a
   * reservation is deliberately absent from the registry read that gates every
   * other caller, so it cannot go through the same front door. One body, so the
   * coalescing map and the re-mint rule cannot drift between the two.
   *
   * THE ADMISSION IS RE-CHECKED AT THE WRITE, not only at the entrance. Minting
   * hashes, hashing is an await, and a delete that lands during it revokes an
   * identity this call was already carrying — so the check below and the write
   * next to it are one synchronous turn, and a reconcile that was already in
   * flight when a teardown began cannot bring the dead workspace's identity
   * back.
   */
  private async reconcileWorkspaceCapability(workspaceName: string, presentedHash: string | null): Promise<void> {
    if (presentedHash && presentedHash === workspaceCapabilityHash(this.ctx.storage.sql, workspaceName)) {
      // The root holds the token the registry committed — the state that reads
      // as "done". It is done only when no rotation is waiting on a replica:
      // a subtree push that missed a descendant left it presenting the
      // previous token, and nothing else ever retries that. The root is the
      // only holder of the plaintext, so the retry asks it to re-push.
      const pending = pendingCapabilityReconcile(this.ctx.storage.sql, workspaceName);
      if (pending === null || pending !== presentedHash) return;
      const workspace = this.env.OrchestratorAgent.get(this.env.OrchestratorAgent.idFromName(workspaceName));
      const result = await workspace.repushWorkspaceCapability();
      if (result.missed === 0) {
        clearCapabilityReconcile(this.ctx.storage.sql, workspaceName);
        return;
      }
      armCapabilityReconcile(this.ctx.storage.sql, workspaceName, presentedHash);
      return;
    }

    const inFlight = this._provisioning.get(workspaceName);
    if (inFlight) return inFlight;
    const task = (async () => {
      const { token, tokenHash } = await freshWorkspaceCapability();
      if (!this.workspaceMintable(workspaceName)) {
        throw new Error(`Workspace ${workspaceName} is being deleted; it cannot be issued an identity.`);
      }
      commitWorkspaceCapability(this.ctx.storage.sql, workspaceName, tokenHash);
      clearCapabilityReconcile(this.ctx.storage.sql, workspaceName);
      const workspace = this.env.OrchestratorAgent.get(this.env.OrchestratorAgent.idFromName(workspaceName));
      const result = await workspace.installWorkspaceCapability(token);
      if (result.missed > 0) {
        armCapabilityReconcile(this.ctx.storage.sql, workspaceName, tokenHash);
      }
    })();
    this._provisioning.set(workspaceName, task);
    try { await task; } finally { this._provisioning.delete(workspaceName); }
  }

  /** Whether this registry still holds a name an identity may be issued for.
   *
   *  Looser than {@link workspaceRegistered} in exactly one direction, and it
   *  has to be: a fork reservation (`create_pending = 1`) is invisible to every
   *  owner-facing read and is still a name {@link publishWorkspaceReservation}
   *  mints for. What it refuses is the case that matters — a row whose teardown
   *  has started, and a name this registry no longer holds at all. */
  private workspaceMintable(name: string): boolean {
    return this.sqlx(
      `SELECT 1 AS x FROM user_workspaces WHERE name = ? AND delete_pending = 0`, name,
    ).length > 0;
  }

  private releases() {
    this.ensureInit();
    return createReleaseStore(releaseSqlFromExec(this.ctx.storage.sql), { validateAgentName: validateWorkspaceName });
  }

  // ── Profile ────────────────────────────────────────────────────────

  async ensureProfile(caller: UserCaller, email: string, displayName?: string): Promise<UserProfile> {
    await this.requireTier(caller, 'profile');
    const now = Date.now();
    const existing = this.sqlx<{ email: string; display_name: string | null; created_at: number; last_seen_at: number }>(
      `SELECT email, display_name, created_at, last_seen_at FROM user_profile WHERE id = 1`,
    )[0];
    if (existing) {
      this.sqlx(
        `UPDATE user_profile SET last_seen_at = ?, display_name = COALESCE(?, display_name) WHERE id = 1`,
        now, displayName ?? null,
      );
      return {
        email: existing.email,
        displayName: displayName ?? existing.display_name,
        createdAt: existing.created_at,
        lastSeenAt: now,
      };
    }
    this.sqlx(
      `INSERT INTO user_profile (id, email, display_name, created_at, last_seen_at) VALUES (1, ?, ?, ?, ?)`,
      email, displayName ?? null, now, now,
    );
    return { email, displayName: displayName ?? null, createdAt: now, lastSeenAt: now };
  }

  async getProfile(caller: UserCaller): Promise<UserProfile | null> {
    await this.requireTier(caller, 'profile');
    const row = this.sqlx<{ email: string; display_name: string | null; created_at: number; last_seen_at: number }>(
      `SELECT email, display_name, created_at, last_seen_at FROM user_profile WHERE id = 1`,
    )[0];
    if (!row) return null;
    return {
      email: row.email,
      displayName: row.display_name,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
    };
  }

  // ── Workspace registry ─────────────────────────────────────────────

  async listWorkspaces(caller: UserCaller, page?: WorkspaceListPageQuery): Promise<WorkspaceList> {
    await this.requireTier(caller, 'workspaces.read');
    // The ordinary read IS the retry: a teardown a previous attempt could not
    // finish gets another go here, before the listing that must not show it —
    // and so does a fork reservation whose sender stopped renewing it, which is
    // otherwise a name this listing hides and nothing can free.
    await this.resumePendingDeletions();
    await this.reclaimStaleForkReservations();
    const limit = clampRosterLimit(page?.limit);
    const cursor = decodeRosterCursor(page?.cursor);
    const rows = this.sqlx<{ name: string; display_name: string; created_at: number; last_visited: number; archived_at: number | null }>(
      cursor
        ? `SELECT name, display_name, created_at, last_visited, archived_at
           FROM user_workspaces
           WHERE archived_at IS NULL AND delete_pending = 0 AND create_pending = 0
             AND (last_visited < ? OR (last_visited = ? AND name > ?))
           ORDER BY last_visited DESC, name ASC LIMIT ${limit + 1}`
        : `SELECT name, display_name, created_at, last_visited, archived_at
           FROM user_workspaces WHERE archived_at IS NULL AND delete_pending = 0 AND create_pending = 0
           ORDER BY last_visited DESC, name ASC LIMIT ${limit + 1}`,
      ...(cursor ? [cursor.v, cursor.v, cursor.n] : []),
    );
    const hasMore = rows.length > limit;
    const entries = rows.slice(0, limit).map((r) => ({
      name: r.name,
      displayName: r.display_name,
      createdAt: r.created_at,
      lastVisited: r.last_visited,
      archivedAt: r.archived_at,
    }));
    const { n } = this.sqlx<{ n: number }>(
      `SELECT COUNT(*) AS n FROM user_workspaces
       WHERE archived_at IS NULL AND delete_pending = 0 AND create_pending = 0`,
    )[0];
    const last = entries.at(-1);
    return { entries, total: n, nextCursor: hasMore && last ? encodeRosterCursor(last) : null };
  }

  /** Complete enumeration of the active roster for server-side fans (credential
   *  invalidation, peer lists, the CLI's config reconcile) where a capped page
   *  would silently drop targets. Identity fields only — the wide wire contract
   *  is listWorkspaces. */
  async listActiveWorkspaces(caller: UserCaller): Promise<Array<Pick<WorkspaceEntry, 'name' | 'displayName' | 'createdAt'>>> {
    await this.requireTier(caller, 'workspaces.read');
    return this.sqlx<{ name: string; display_name: string; created_at: number }>(
      `SELECT name, display_name, created_at FROM user_workspaces
       WHERE archived_at IS NULL AND delete_pending = 0 AND create_pending = 0
       ORDER BY last_visited DESC`,
    ).map((r) => ({ name: r.name, displayName: r.display_name, createdAt: r.created_at }));
  }

  /**
   * Claim a roster name for a new workspace, and say what was found.
   *
   * THE STATUS IS A CLOSED WORD, not a boolean, because the three answers need
   * three different acts from the caller and `existed` conflated two of them.
   * `created` is an EXCLUSIVE claim: the read and the insert below are one
   * synchronous turn, so of two creates racing on one name exactly one is told
   * `created` and is the only one that may initialize the workspace or roll the
   * row back. `active` is the name's live workspace, returned as it stands —
   * the create that gets it must not re-seed a soul, reset a baseline or open a
   * second genesis turn on a workspace that is already somebody's. `reserved`
   * carries no entry at all: a name an uncommitted fork transfer is holding is
   * not a workspace this caller has, and the row IS that reservation, so it is
   * neither taken nor written.
   *
   * `create_pending = 0` is written rather than left to the column default:
   * this is the path whose workspace exists by the time the row does, so it is
   * published the moment it lands.
   */
  async registerWorkspace(
    caller: UserCaller, name: string, displayName?: string, purpose?: string,
  ): Promise<WorkspaceRegistration> {
    await this.requireTier(caller, 'workspaces.write');
    validateWorkspaceName(name);
    await this.requireNotDeleting(name);
    const now = Date.now();
    const existing = this.sqlx<{
      display_name: string;
      created_at: number;
      archived_at: number | null;
      create_pending: number;
    }>(
      `SELECT display_name, created_at, archived_at, create_pending
       FROM user_workspaces WHERE name = ?`,
      name,
    )[0];
    if (existing && existing.create_pending !== 0) return { status: 'reserved' };
    if (existing) {
      // The owner asked for this name, so the workspace behind it has been
      // visited; nothing else about it is this call's to rewrite. Returning the
      // row's OWN timestamp is what makes the answer stable across retries —
      // and what lets a rollback match the row it actually inserted, which a
      // freshly generated `createdAt` silently prevented.
      this.sqlx(
        `UPDATE user_workspaces SET last_visited = ?, archived_at = NULL WHERE name = ?`,
        now, name,
      );
      return {
        status: 'active',
        entry: {
          name,
          displayName: existing.display_name,
          createdAt: existing.created_at,
          lastVisited: now,
          archivedAt: null,
        },
      };
    }
    const explicit = displayName?.trim() ?? '';
    const title = resolveWorkspaceTitle({ explicit, purpose, slug: name });
    // No ON CONFLICT clause: the read above and this write are one turn, so a
    // conflict here is unreachable — and if the two were ever separated by an
    // await, a silent upsert is exactly the wrong answer.
    this.sqlx(
      `INSERT INTO user_workspaces (name, display_name, name_origin, created_at, last_visited, create_pending)
       VALUES (?, ?, ?, ?, ?, 0)`,
      name, title, explicit !== '' ? 'user' : 'auto', now, now,
    );
    return {
      status: 'created',
      entry: { name, displayName: title, createdAt: now, lastVisited: now, archivedAt: null },
    };
  }

  /**
   * Hold a name for a fork transfer that has not happened yet.
   *
   * The row is inserted UNPUBLISHED (`create_pending = 1`) and is invisible to
   * every owner-visible read until {@link publishWorkspaceReservation} commits
   * it (KINU-027): a target being streamed into is not a workspace the owner
   * has, and a roster that offered it would be offering a half-written one. The
   * row exists anyway, because the name is what the reservation is FOR — the
   * existence probe below is deliberately blind to the flag, so a pending
   * reservation still refuses a second reservation of the same name.
   *
   * IT ALSO CARRIES A LEASE, because "the transfer has not happened yet" used
   * to have no end. The sender streams frames from another Durable Object; when
   * that object died between frames nothing ran its cleanup, and the row stayed
   * `create_pending` forever — invisible to every roster read, so the owner
   * could not delete it, and refusing every retry of the same name, so they
   * could not have it back either. A reservation whose lease has lapsed is
   * therefore ADOPTED here: its half-written target is torn down and the name
   * is reserved afresh for the caller asking for it now.
   */
  async reserveWorkspace(caller: UserCaller, name: string, displayName?: string): Promise<{ entry: WorkspaceEntry; reserved: boolean }> {
    await this.requireTier(caller, 'workspaces.write');
    validateWorkspaceName(name);
    await this.requireNotDeleting(name);
    const existing = this.sqlx<{
      name: string;
      display_name: string;
      created_at: number;
      last_visited: number;
      archived_at: number | null;
      create_pending: number;
      fork_lease_expires_at: number | null;
    }>(
      `SELECT name, display_name, created_at, last_visited, archived_at,
              create_pending, fork_lease_expires_at
       FROM user_workspaces WHERE name = ?`,
      name,
    )[0];
    const abandoned = existing !== undefined
      && existing.create_pending === 1
      && (existing.fork_lease_expires_at ?? 0) <= Date.now();
    if (abandoned) await this.reclaimForkReservation(name);
    if (existing && !abandoned) {
      return {
        entry: {
          name: existing.name,
          displayName: existing.display_name,
          createdAt: existing.created_at,
          lastVisited: existing.last_visited,
          archivedAt: existing.archived_at,
        },
        reserved: false,
      };
    }

    const now = Date.now();
    const explicit = displayName?.trim() ?? '';
    const title = resolveWorkspaceTitle({ explicit, slug: name });
    this.sqlx(
      `INSERT INTO user_workspaces
         (name, display_name, name_origin, created_at, last_visited, create_pending, fork_lease_expires_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
      name, title, explicit !== '' ? 'user' : 'auto', now, now, now + FORK_RESERVATION_LEASE_MS,
    );
    return {
      entry: { name, displayName: title, createdAt: now, lastVisited: now, archivedAt: null },
      reserved: true,
    };
  }

  /**
   * The transfer is still running — hold the name a while longer.
   *
   * Called by the sender as each frame lands, so the lease tracks the transfer
   * rather than a guess about how long one takes. Answers false when this is no
   * longer the caller's reservation to hold (published, released, or adopted by
   * someone else), which is how a sender that outlived its own claim learns to
   * stop.
   */
  async renewWorkspaceReservation(caller: UserCaller, name: string, createdAt: number): Promise<boolean> {
    await this.requireTier(caller, 'workspaces.write');
    validateWorkspaceName(name);
    if (!Number.isFinite(createdAt)) return false;
    return this.sqlx(
      `UPDATE user_workspaces SET fork_lease_expires_at = ?
       WHERE name = ? AND created_at = ? AND create_pending = 1 AND delete_pending = 0
       RETURNING name`,
      Date.now() + FORK_RESERVATION_LEASE_MS, name, createdAt,
    ).length > 0;
  }

  /**
   * Give up a reservation whose transfer stopped renewing it: destroy whatever
   * the half-finished transfer left in the target Durable Object, then drop the
   * row. `tearDownWorkspace` is the same teardown a delete runs and is
   * idempotent, so a target that was never written converges too.
   */
  private async reclaimForkReservation(name: string): Promise<void> {
    const ownerUserId = this.ctx.id.name ?? '';
    if (!/^[a-f0-9]{32}$/.test(ownerUserId)) {
      // Without the owner id this object cannot prove the destroy is
      // authorized, and guessing is what that check refuses. The row keeps its
      // lapsed lease and the next attempt tries again.
      diagnostics.failure('workspace.fork_reservation_unowned', toKinuError({
        doing: 'reclaiming a fork reservation whose transfer stopped',
        cause: new Error('this user object has no user id to authorize the destroy with'),
        otherwise: 'denied',
      }), { workspace: name });
      throw new Error(`Workspace "${name}" holds an abandoned fork reservation that cannot be reclaimed.`);
    }
    await this.tearDownWorkspace(name, ownerUserId);
  }

  /**
   * Reclaim every reservation whose transfer stopped renewing it.
   *
   * Driven by the owner's own reads, exactly like {@link resumePendingDeletions}
   * and for the same reason: this object has no timer of its own, and the
   * answer to "who retries this" is the next person to look at their workspace
   * list. Without it a wedged name is invisible AND unreachable — the roster
   * filters `create_pending`, so the owner cannot even see what to delete.
   */
  private async reclaimStaleForkReservations(): Promise<void> {
    const stale = this.sqlx<{ name: string }>(
      `SELECT name FROM user_workspaces
       WHERE create_pending = 1 AND delete_pending = 0
         AND COALESCE(fork_lease_expires_at, 0) <= ?`,
      Date.now(),
    );
    for (const row of stale) {
      try {
        await this.reclaimForkReservation(row.name);
      } catch (err) {
        diagnostics.failure('workspace.fork_reservation_reclaim_failed', toKinuError({
          doing: 'reclaiming a fork reservation whose transfer stopped renewing it',
          cause: err,
          otherwise: 'io',
        }), { workspace: row.name });
      }
    }
  }

  /**
   * Commit a reservation: the transfer landed, so the name it has been holding
   * becomes a workspace the owner has.
   *
   * The ONE place `create_pending` is cleared, which is what makes "absent"
   * mean the same thing on every surface — there is no second way for a
   * half-written fork target to become visible.
   */
  async publishWorkspaceReservation(
    caller: UserCaller,
    name: string,
    createdAt: number,
    capabilityHash: string | null,
  ): Promise<void> {
    await this.requireTier(caller, 'workspaces.write');
    validateWorkspaceName(name);
    // Exactly the row `reserveWorkspace` inserted, still open. The timestamp is
    // the identity: on the name alone, a transfer's late reply could publish a
    // LATER reservation of the same name. `delete_pending` is excluded for the
    // reason it is excluded from `releaseWorkspaceReservation` — a row whose
    // teardown has started is not one anything may commit.
    const reserved = v.safeParse(v.object({ create_pending: v.picklist([0, 1]) }), this.sqlx(
      `SELECT create_pending FROM user_workspaces
       WHERE name = ? AND created_at = ? AND delete_pending = 0`,
      name, createdAt,
    )[0]);
    if (!reserved.success) {
      throw new WorkspaceReservationNotPendingError(name, 'no reservation of that name is open under that timestamp');
    }
    if (reserved.output.create_pending === 0) {
      throw new WorkspaceReservationNotPendingError(name, 'it is already published');
    }
    // Installing the capability is a cross-DO await, so it cannot sit inside the
    // transaction: `transactionSync` commits when its SYNCHRONOUS body returns,
    // and an async body would commit at its first await and take the atomicity
    // with it. So the install happens first and the flip commits after it. That
    // order is also the safe one — a failed install leaves the row unpublished,
    // which is still invisible and still releasable, whereas publishing first
    // would hand the owner a workspace holding no identity.
    await this.reconcileWorkspaceCapability(name, capabilityHash);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `UPDATE user_workspaces SET create_pending = 0, fork_lease_expires_at = NULL
         WHERE name = ? AND created_at = ? AND create_pending = 1`,
        name, createdAt,
      );
    });
  }

  /** Drop only the exact roster row a failed fork reservation inserted. This
   * never contacts the target DO: the caller uses it only when that target
   * proved it already belongs to another user and was left untouched. */
  async releaseWorkspaceReservation(caller: UserCaller, name: string, createdAt: number): Promise<boolean> {
    await this.requireTier(caller, 'workspaces.write');
    validateWorkspaceName(name);
    if (!Number.isFinite(createdAt)) return false;
    // A marked row is not this reservation's to drop: it belongs to a teardown
    // that has not finished, and dropping it would lose the only record that
    // anything is still owed.
    const row = this.sqlx<{ created_at: number }>(
      `SELECT created_at FROM user_workspaces WHERE name = ? AND delete_pending = 0`,
      name,
    )[0];
    if (!row || row.created_at !== createdAt) return false;
    this.sqlx(`DELETE FROM user_workspaces WHERE name = ? AND created_at = ?`, name, createdAt);
    revokeWorkspaceCapability(this.ctx.storage.sql, name);
    return true;
  }

  async touchWorkspace(caller: UserCaller, name: string): Promise<void> {
    await this.requireTier(caller, 'workspaces.write');
    validateWorkspaceName(name);
    // A workspace being torn down, or one a fork has not committed yet, is not
    // one the owner can visit, so a touch finds nothing to touch — the same
    // answer every ordinary read gives.
    this.sqlx(
      `UPDATE user_workspaces SET last_visited = ?
       WHERE name = ? AND delete_pending = 0 AND create_pending = 0`,
      Date.now(), name,
    );
  }

  /**
   * Delete one workspace: its Durable Object and every external plane it owns,
   * then its registry row.
   *
   * The row is MARKED before any of that and removed only after all of it, so a
   * teardown that fails mid-way leaves a record of the intent rather than a
   * half-deleted workspace nobody is responsible for. A marked row is invisible
   * to every ordinary read — it is not a workspace the owner has any more — but
   * it is still there, which is what gives the cleanup an owner: the next read
   * of this registry drives it again (`resumePendingDeletions`), and
   * `destroyAgent` is idempotent, so a re-run over already-destroyed planes
   * converges instead of failing.
   */
  async removeWorkspace(caller: UserCaller, name: string, ownerUserId: string): Promise<void> {
    await this.requireTier(caller, 'workspaces.write');
    validateWorkspaceName(name);
    if (!/^[a-f0-9]{32}$/.test(ownerUserId)) throw new Error('invalid owner user id');
    await this.tearDownWorkspace(name, ownerUserId);
  }

  /**
   * The teardown itself, from a live workspace to no row.
   *
   * THE FENCE COMES FIRST, IN ONE SYNCHRONOUS TURN. Marking the row and
   * revoking the workspace's capability are the same act — an authority the
   * owner has withdrawn must not survive into the teardown — and the destroy
   * below is an await, during which this object accepts other calls. Revoking
   * afterwards left the dying workspace holding a token its own registry still
   * honoured, so for the whole length of the destroy it could still read the
   * owner's credentials, list their other workspaces and spend their devices.
   * The mark is what every other read already excludes; the revoke is what the
   * capability gate reads. Neither is any use without the other, so they are
   * written together, before anything can interleave.
   *
   * Tear the agent's Durable Object down (storage, alarm, sandbox) BEFORE
   * dropping it from the registry — otherwise the DO's SQLite (conversation,
   * model, scaffold, triggers) survives and a same-name recreate inherits stale
   * state, and its alarm keeps firing. A real teardown failure is fail-closed:
   * the marked row stays, so a same-name recreation cannot reconnect to
   * resources that were not actually destroyed, and the failure reaches the
   * caller. The revoke is not undone by that failure either: a workspace whose
   * delete the owner has asked for does not get its authority back because its
   * container refused to stop.
   */
  private async tearDownWorkspace(name: string, ownerUserId: string): Promise<void> {
    this.sqlx(`UPDATE user_workspaces SET delete_pending = 1 WHERE name = ?`, name);
    revokeWorkspaceCapability(this.ctx.storage.sql, name);
    // The device grants go with the capability, in the same synchronous turn
    // and for the same reason. A grant is read BY NAME on every later device
    // call, so a row that outlived its workspace is a standing
    // full_filesystem waiting for the next workspace created with that name -
    // which a shared template makes ordinary rather than unlikely.
    this.sqlx(`DELETE FROM device_consent WHERE agent_name = ?`, name);
    try {
      const stub = this.env.OrchestratorAgent.get(this.env.OrchestratorAgent.idFromName(name));
      await stub.destroyAgent(ownerUserId);
    } catch (err) {
      // agents-SDK destroy aborts its own isolate after the durable wipe. That
      // exact sentinel is successful completion; every other error is real.
      if (!(err instanceof Error) || err.message !== 'destroyed') throw err;
    }
    this.sqlx(`DELETE FROM user_workspaces WHERE name = ?`, name);
    // Re-run for the row this teardown resumed from an earlier attempt, whose
    // identity a pre-fence delete could have left registered.
    revokeWorkspaceCapability(this.ctx.storage.sql, name);
  }

  /**
   * Finish any teardown a previous attempt left marked.
   *
   * Driven by the owner's own reads rather than by a wake of its own: this
   * object has no timer, and the answer to "who retries this" is the next
   * person to look at their workspace list. A cleanup that fails again keeps its
   * marker and states why — the row is the retry, so nothing is lost by not
   * throwing here, and a listing that failed because an unrelated workspace
   * could not finish dying would be the worse answer.
   */
  private async resumePendingDeletions(): Promise<void> {
    const pending = this.sqlx<{ name: string }>(
      `SELECT name FROM user_workspaces WHERE delete_pending = 1`,
    );
    if (pending.length === 0) return;
    const ownerUserId = this.ctx.id.name ?? '';
    if (!/^[a-f0-9]{32}$/.test(ownerUserId)) {
      // Without the owner id this object cannot prove to the workspace that the
      // destroy is authorized, and guessing is exactly what the check refuses.
      diagnostics.failure('workspace.cleanup_unowned', toKinuError({
        doing: 'resuming a pending workspace teardown',
        cause: new Error('this user object has no user id to authorize the destroy with'),
        otherwise: 'denied',
      }), { pending: pending.length });
      return;
    }
    for (const row of pending) {
      try {
        await this.tearDownWorkspace(row.name, ownerUserId);
      } catch (err) {
        diagnostics.failure('workspace.cleanup_retry_failed', toKinuError({
          doing: 'finishing a workspace teardown a previous attempt left unfinished',
          cause: err,
          otherwise: 'io',
        }), { workspace: row.name });
      }
    }
  }

  /**
   * Refuse a name whose teardown has not finished.
   *
   * Creating is the one path that cannot read a marked row as absent. The row
   * still owns a Durable Object and its planes, so a same-name recreate over it
   * would hand the owner a workspace wired to resources the pending teardown is
   * about to destroy. The retry runs first because the ordinary way to arrive
   * here is an owner recreating a name they just deleted, whose teardown hit
   * something transient: that owner gets their name back, not a dead end.
   */
  private async requireNotDeleting(name: string): Promise<void> {
    const marked = `SELECT 1 AS x FROM user_workspaces WHERE name = ? AND delete_pending = 1`;
    if (this.sqlx(marked, name).length === 0) return;
    await this.resumePendingDeletions();
    if (this.sqlx(marked, name).length === 0) return;
    throw new Error(`Workspace "${name}" is still being deleted; its teardown has not finished.`);
  }

  /**
   * ROOT title authority. Commits the shown name AND whose it is; an 'auto'
   * write is REFUSED when the owner has named this workspace, so a generated
   * title can never displace a chosen one — the refusal lives here where the
   * state is, not in a per-actor mirror that resets with its process.
   * Returns whether the write applied.
   *
   * The workspace actor mirrors this value only after the cross-DO write
   * succeeds.
   */
  async setWorkspaceDisplayName(
    caller: UserCaller, name: string, displayName: string, origin: 'user' | 'auto',
  ): Promise<{ applied: boolean }> {
    const resolved = await this.requireTier(caller, 'workspaces.rename_self');
    validateWorkspaceName(name);
    // Workspace-scoped by construction: an agent renames itself, never a
    // sibling. This is what makes rename safe to keep at the `shared` tier.
    if (resolved.kind === 'workspace' && resolved.workspace !== name) {
      throw new Error(`Workspace "${resolved.workspace}" may only rename itself.`);
    }
    // Both pending flags excluded as everywhere else: a workspace being torn
    // down, or one a fork has not committed yet, has no title to commit, so the
    // write reports the not-found answer.
    const current = this.sqlx<{ name_origin: 'user' | 'auto' | null }>(
      `SELECT name_origin FROM user_workspaces
       WHERE name = ? AND delete_pending = 0 AND create_pending = 0`, name,
    )[0];
    if (!current) return { applied: false };
    if (origin === 'auto' && current.name_origin !== 'auto') return { applied: false };
    this.sqlx(
      `UPDATE user_workspaces SET display_name = ?, name_origin = ? WHERE name = ?`,
      displayName, origin, name,
    );
    return { applied: true };
  }

  /** The root's current naming state for one workspace, or null when it holds
   *  no such row. This is what an actor hydrates its activation cache from. */
  async getWorkspaceTitle(caller: UserCaller, name: string): Promise<{ displayName: string; nameOrigin: 'user' | 'auto' } | null> {
    await this.requireTier(caller, 'workspaces.read');
    validateWorkspaceName(name);
    const row = this.sqlx<{ display_name: string; name_origin: 'user' | 'auto' | null }>(
      `SELECT display_name, name_origin FROM user_workspaces
       WHERE name = ? AND delete_pending = 0 AND create_pending = 0`, name,
    )[0];
    if (!row) return null;
    return { displayName: row.display_name, nameOrigin: row.name_origin ?? 'user' };
  }

  async hasWorkspace(caller: UserCaller, name: string): Promise<boolean> {
    await this.requireTier(caller, 'workspaces.read');
    return this.workspaceRegistered(name);
  }

  /** Registry membership, ungated — the internal read behind `hasWorkspace`
   *  and the ticket flows, whose own entry points are already gated. */
  private workspaceRegistered(name: string): boolean {
    validateWorkspaceName(name);
    // Both pending flags excluded for the same reason `archived_at` is: a
    // workspace whose teardown has started, and one whose fork transfer has not
    // committed, are not ones this owner can open — and this gate is what every
    // open goes through, including `ensureWorkspaceCapability`'s admission.
    const row = this.sqlx(
      `SELECT 1 AS x FROM user_workspaces
       WHERE name = ? AND archived_at IS NULL AND delete_pending = 0
         AND create_pending = 0`,
      name,
    )[0];
    return !!row;
  }

  // ── Peer-messaging grants (cross-owner, default deny) ──────────────

  /** Read by the receiving agent's `receivePeerMessage` — whether a foreign
   *  sender may deliver into this user's agents. Same-owner peers never need
   *  a grant (ownership is checked before this). */
  async hasPeerGrant(caller: UserCaller, senderAgentName: string, senderUserId: string): Promise<boolean> {
    await this.requireTier(caller, 'peers.grants');
    const row = this.sqlx(
      `SELECT 1 AS x FROM user_peer_grants WHERE sender_user_id = ? AND sender_agent_name = ?`,
      senderUserId, senderAgentName,
    )[0];
    return !!row;
  }

  // ── Browser sessions ───────────────────────────────────────────────
  //
  // The authority behind a session cookie: whether it is still live, and what
  // it stands for. KV holds a projection of the identity for the fast path and
  // is trusted for nothing, because a KV write and a KV delete both take up to
  // a minute to reach every colo — so KV can neither say a session was revoked
  // (a stolen cookie replayed at a lagging colo used to outlive logout by that
  // window) nor say one exists yet (the first request after a sign-in redirect
  // used to read as signed out at a colo the write had not reached, and bounce
  // the browser into a sign-in that would lose the same race). This table
  // answers both, from every colo, in one round trip.

  /** Publish a browser session as active, with the identity it was minted for.
   *  Called before the sign-in response hands the browser its cookie, so no
   *  cookie is ever outstanding without authority behind it. A hash already
   *  present is a real fault and throws: the caller compensates rather than
   *  adopting a row it did not create. */
  async registerBrowserSession(
    caller: UserCaller,
    tokenHash: string,
    expiresAt: number,
    identity: BrowserSessionIdentity,
  ): Promise<void> {
    await this.requireTier(caller, 'auth_tokens');
    this.sqlx(
      `INSERT INTO user_browser_sessions
         (token_hash, expires_at, email, display_name, provider, provider_sub, auth_time)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      tokenHash, expiresAt,
      identity.email, identity.displayName, identity.provider, identity.sub, identity.authTime,
    );
  }

  /** This cookie's session, or null when it is not a live one. Expired rows are
   *  dropped in the same transaction as the read, so a lapsed session reads as
   *  ABSENT and expiry needs no sweeper, no alarm and no second lifecycle
   *  column. The identity comes back with the liveness answer rather than
   *  behind a second round trip, so a caller whose KV projection has not
   *  arrived yet still has something true to answer with. */
  async verifyBrowserSession(caller: UserCaller, tokenHash: string): Promise<LiveBrowserSession | null> {
    await this.requireTier(caller, 'auth_tokens');
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`DELETE FROM user_browser_sessions WHERE expires_at <= ?`, Date.now());
      const row = this.ctx.storage.sql.exec<{
        email: string | null;
        display_name: string | null;
        provider: string | null;
        provider_sub: string | null;
        auth_time: number | null;
      }>(
        `SELECT email, display_name, provider, provider_sub, auth_time
           FROM user_browser_sessions WHERE token_hash = ? LIMIT 1`, tokenHash,
      ).toArray()[0];
      if (!row) return null;
      // All five were written by one INSERT, so they are present together or
      // absent together; a row from before they existed carries no identity at
      // all rather than a half of one.
      if (row.email === null || row.provider === null || row.provider_sub === null || row.auth_time === null) {
        return { identity: null };
      }
      return {
        identity: {
          email: row.email,
          displayName: row.display_name,
          provider: row.provider,
          sub: row.provider_sub,
          authTime: row.auth_time,
        },
      };
    });
  }

  /** Revoke exactly this session. The row's absence IS the revocation, so the
   *  next request carrying that cookie is refused at whatever colo it reaches,
   *  and the user's other sessions keep their own rows.
   *
   *  The write comes first and the fan-out second, exactly as
   *  {@link retireCliAuthority} does it: the revocation is durable here before
   *  any cross-DO await, so a fan-out that fails cannot leave a websocket
   *  believing it is still authorized — the frame-time check reads this store
   *  and refuses the next frame either way. The push is what makes the revocation
   *  reach a socket that is only LISTENING, which a per-frame check by itself can
   *  never reach because a client that says nothing sends no frames. */
  async revokeBrowserSession(caller: UserCaller, tokenHash: string): Promise<void> {
    await this.requireTier(caller, 'auth_tokens');
    this.sqlx(`DELETE FROM user_browser_sessions WHERE token_hash = ?`, tokenHash);
    await this.pushSessionSocketRevocation(tokenHash);
  }

  /** Tell this account's workspaces to close every websocket that named this
   *  session at its upgrade. Best-effort by construction, and named on each
   *  failure, for the same reason the CLI socket push is. */
  private async pushSessionSocketRevocation(tokenHash: string): Promise<void> {
    const workspaces = this.sqlx<{ name: string }>(
      `SELECT name FROM user_workspaces
       WHERE archived_at IS NULL AND delete_pending = 0 AND create_pending = 0`,
    ).map((row) => row.name);
    const settled = await Promise.allSettled(workspaces.map((name) => this.env.OrchestratorAgent
      .get(this.env.OrchestratorAgent.idFromName(name))
      .closeRevokedSessionSockets(tokenHash)));
    for (const [index, outcome] of settled.entries()) {
      if (outcome.status === 'fulfilled') continue;
      diagnostics.failure('auth.session_socket_revocation_push_failed', toKinuError({
        doing: 'closing a workspace websocket whose browser session was revoked',
        cause: outcome.reason,
        otherwise: 'unavailable',
      }), { workspace: workspaces[index] });
    }
  }

  /** Whether a browser session that authenticated a live websocket may still
   *  act — the session-side twin of {@link verifyCliSocketBearer}. Read at
   *  FRAME TIME by the workspace the socket is attached to, against the row
   *  this object owns, so there is no cached verdict to be stale. A workspace
   *  that cannot be reached is refused by the caller, not answered here. */
  async verifySocketSession(caller: UserCaller, tokenHash: string): Promise<{ live: boolean }> {
    await this.requireTier(caller, 'auth_tokens.socket');
    if (!/^[a-f0-9]{64}$/.test(tokenHash)) return { live: false };
    const row = this.sqlx<{ token_hash: string }>(
      `SELECT token_hash FROM user_browser_sessions WHERE token_hash = ? AND expires_at > ? LIMIT 1`,
      tokenHash, Date.now(),
    )[0];
    return { live: row !== undefined };
  }

  // ── CLI auth tokens ────────────────────────────────────────────────

  /**
   * Mint a CLI bearer token against one browser approval. The raw token is
   * returned once to the CLI; only its hash is stored. The userId is embedded
   * solely so edge routes can route directly to the correct UserDO before
   * verification.
   *
   * `authorizationHash` IS THE APPROVAL, and it is what makes this mint
   * single-use. The device-code flow's record lives in KV, which has no
   * compare-and-swap and answers reads from each colo's cache, so the flow
   * cannot enforce "mint once" itself: two polls of one approved request both
   * read `approved` and both were handed a 180-day token. This object is the
   * one that mints, so the claim belongs in the same INSERT as the token —
   * atomic, strongly consistent, and unique by index rather than by luck. A
   * second attempt against the same approval finds the row and is refused.
   */
  async mintCliToken(
    caller: UserCaller, userId: string, authorizationHash: string, label?: string,
  ): Promise<{ token: string; tokenHash: string; expiresAt: number }> {
    await this.requireTier(caller, 'auth_tokens');
    if (!/^[a-f0-9]{32}$/.test(userId)) throw new Error('invalid user id');
    if (!/^[a-f0-9]{64}$/.test(authorizationHash)) throw new Error('invalid authorization hash');
    const token = `ptc_${userId}_${nanoid(44)}`;
    const tokenHash = await sha256Hex(token);
    const now = Date.now();
    const expiresAt = now + CLI_TOKEN_TTL_MS;
    try {
      this.sqlx(
        `INSERT INTO user_cli_tokens (token_hash, label, created_at, expires_at, authorization_hash)
         VALUES (?, ?, ?, ?, ?)`,
        tokenHash, cleanCliTokenLabel(label), now, expiresAt, authorizationHash,
      );
    } catch (cause) {
      // The unique index owns the message, exactly as `claimMcpServerName`'s
      // does: the refusal is a fact about the approval, not a SQL constraint
      // the caller can act on.
      throw new CliAuthorizationSpentError({ cause });
    }
    return { token, tokenHash, expiresAt };
  }

  /** Verify a CLI bearer token. Called by Worker HTTP routes after routing to
   *  this UserDO via the user id embedded in the token. */
  async verifyCliToken(caller: UserCaller, token: string): Promise<CliTokenVerification> {
    await this.requireTier(caller, 'auth_tokens');
    const userId = parseCliTokenUserId(token);
    if (!userId) return { ok: false, error: 'malformed token' };
    const tokenHash = await sha256Hex(token);
    const row = this.sqlx<{ expires_at: number; revoked_at: number | null }>(
      `SELECT expires_at, revoked_at FROM user_cli_tokens WHERE token_hash = ? LIMIT 1`,
      tokenHash,
    )[0];
    if (!row || row.revoked_at !== null) return { ok: false, error: 'invalid token' };
    const now = Date.now();
    if (row.expires_at <= now) return { ok: false, error: 'expired token' };
    this.sqlx(`UPDATE user_cli_tokens SET last_used_at = ? WHERE token_hash = ?`, now, tokenHash);
    const profile = await this.getProfile(await ownerCaller(this.env));
    if (!profile) return { ok: false, error: 'profile missing' };
    return {
      ok: true,
      user: { id: userId, email: profile.email, displayName: profile.displayName },
      tokenHash,
      expiresAt: row.expires_at,
    };
  }

  async listCliTokens(caller: UserCaller): Promise<Array<{ tokenHash: string; label: string; createdAt: number; expiresAt: number; lastUsedAt: number | null }>> {
    await this.requireTier(caller, 'auth_tokens');
    return this.sqlx<{ token_hash: string; label: string; created_at: number; expires_at: number; last_used_at: number | null }>(
      `SELECT token_hash, label, created_at, expires_at, last_used_at
       FROM user_cli_tokens WHERE revoked_at IS NULL ORDER BY created_at DESC`,
    ).map((r) => ({
      tokenHash: r.token_hash,
      label: r.label,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      lastUsedAt: r.last_used_at,
    }));
  }

  async revokeCliTokenHash(caller: UserCaller, tokenHash: string): Promise<{ ok: boolean }> {
    await this.requireTier(caller, 'auth_tokens');
    this.sqlx(`UPDATE user_cli_tokens SET revoked_at = ? WHERE token_hash = ?`, Date.now(), tokenHash);
    await this.retireCliAuthority();
    return { ok: true };
  }

  /** Revoke every active CLI session token. The recovery path for a logout whose
   *  remote revocation never landed (or a token copied off a lost machine):
   *  the caller has no way to name the orphan, so the answer is all of them. The
   *  owner re-authenticates afterwards — that is the cheap half of an account
   *  whose every remaining bearer needed to die anyway. One generation rise
   *  covers every socket at once, exactly as a single revocation does. */
  async revokeAllCliTokens(caller: UserCaller): Promise<{ revoked: number }> {
    await this.requireTier(caller, 'auth_tokens');
    const revoked = this.sqlx<{ n: number }>(
      `SELECT COUNT(*) AS n FROM user_cli_tokens WHERE revoked_at IS NULL`,
    )[0]?.n ?? 0;
    this.sqlx(`UPDATE user_cli_tokens SET revoked_at = ? WHERE revoked_at IS NULL`, Date.now());
    await this.retireCliAuthority();
    return { revoked };
  }

  // ── The authorization generation ────────────────────────────────────

  /**
   * This account's authorization generation: one number that rises with every
   * CLI or access-token revocation.
   *
   * A websocket authenticated by a bearer records the generation it was
   * admitted under, which is what lets a revocation name every socket that
   * predates it without enumerating token hashes — including sockets that are
   * merely LISTENING, which a per-frame check by itself can never reach because
   * a client that says nothing sends no frames while it keeps receiving the
   * workspace's stream.
   */
  private authGeneration(): number {
    const row = this.sqlx<{ generation: number }>(
      `SELECT generation FROM user_auth_generation WHERE id = 1`,
    )[0];
    return row?.generation ?? 0;
  }

  /**
   * Record that authority was withdrawn, then tell this account's workspaces.
   *
   * THE WRITE COMES FIRST AND THE FAN-OUT SECOND, and the order is the point:
   * the revocation is durable in this object before any cross-DO await, so a
   * fan-out that fails cannot leave a socket believing it is still authorized —
   * the frame-time check reads this store and refuses the next frame either
   * way. The push is what makes revocation immediate rather than
   * next-frame-immediate; it is not what makes it true.
   */
  private async retireCliAuthority(): Promise<void> {
    this.sqlx(
      `INSERT INTO user_auth_generation (id, generation, updated_at) VALUES (1, 1, ?)
       ON CONFLICT(id) DO UPDATE SET generation = generation + 1, updated_at = excluded.updated_at`,
      Date.now(),
    );
    const generation = this.authGeneration();
    const workspaces = this.sqlx<{ name: string }>(
      `SELECT name FROM user_workspaces
       WHERE archived_at IS NULL AND delete_pending = 0 AND create_pending = 0`,
    ).map((row) => row.name);
    const settled = await Promise.allSettled(workspaces.map((name) => this.env.OrchestratorAgent
      .get(this.env.OrchestratorAgent.idFromName(name))
      .closeRevokedCliSockets(generation)));
    for (const [index, outcome] of settled.entries()) {
      if (outcome.status === 'fulfilled') continue;
      diagnostics.failure('auth.socket_revocation_push_failed', toKinuError({
        doing: 'closing a workspace websocket whose CLI bearer was revoked',
        cause: outcome.reason,
        otherwise: 'unavailable',
      }), { workspace: workspaces[index], generation });
    }
  }

  /**
   * Whether a bearer that authenticated a live websocket may still act, and
   * the generation it must be holding.
   *
   * Read at FRAME TIME by the workspace the socket is attached to. A connect
   * ticket is checked once, at the upgrade; without this the socket outlived
   * every revocation, and hibernation made it worse — the connection came back
   * from its tags with its scopes intact and nothing that named the bearer at
   * all. This is the gate that cannot be bypassed: it reads the same rows the
   * revocation writes, in the object that owns them.
   */
  async verifyCliSocketBearer(caller: UserCaller, tokenHash: string): Promise<{
    live: boolean; generation: number; error?: string;
  }> {
    await this.requireTier(caller, 'auth_tokens.socket');
    const generation = this.authGeneration();
    if (!/^[a-f0-9]{64}$/.test(tokenHash)) return { live: false, generation, error: 'invalid token hash' };
    const scopes = this.cliBearerScopes(tokenHash, Date.now());
    if (!scopes) return { live: false, generation, error: 'the CLI token behind this connection is no longer valid' };
    return { live: true, generation };
  }

  // ── CI access tokens (long-lived, scoped `pta_…` bearers) ──────────

  /** Mint a scoped access token. The step-up policy (interactive session
   *  token, freshly minted) is enforced by the CLI routes; this DO owns the
   *  hash-only storage plus name/scope validation. */
  async mintAccessToken(caller: UserCaller, userId: string, name: string, scopes: readonly string[]): Promise<AccessTokenMint> {
    await this.requireTier(caller, 'auth_tokens');
    return mintAccessTokenRow(this.ctx.storage.sql, userId, name, scopes);
  }

  /** Verify a `pta_…` access token presented as a bearer. Same contract as
   *  verifyCliToken, with the granted scopes attached. */
  async verifyAccessToken(caller: UserCaller, token: string): Promise<CliTokenVerification> {
    await this.requireTier(caller, 'auth_tokens');
    const verified = await verifyAccessTokenRow(this.ctx.storage.sql, token);
    if (!verified.ok) return { ok: false, error: verified.error };
    const profile = await this.getProfile(await ownerCaller(this.env));
    if (!profile) return { ok: false, error: 'profile missing' };
    return {
      ok: true,
      user: { id: verified.userId, email: profile.email, displayName: profile.displayName },
      tokenHash: verified.tokenHash,
      scopes: verified.scopes,
    };
  }

  async listAccessTokens(caller: UserCaller): Promise<AccessTokenRecord[]> {
    await this.requireTier(caller, 'auth_tokens');
    return listAccessTokenRows(this.ctx.storage.sql);
  }

  async revokeAccessToken(caller: UserCaller, ref: string): Promise<{ ok: true; revoked: boolean }> {
    await this.requireTier(caller, 'auth_tokens');
    const result = revokeAccessTokenRow(this.ctx.storage.sql, ref);
    // Unconditionally, not only when a row changed: `revoked: false` also
    // covers an already-revoked token, and a generation that rises on a no-op
    // costs one comparison while one that skips a real revocation costs the
    // socket it should have closed.
    await this.retireCliAuthority();
    return result;
  }

  async issueCliAgentConnectTicket(caller: UserCaller, input: {
    userId: string;
    agentClass: typeof ORCHESTRATOR_AGENT_SLUG;
    agentName: string;
    cliTokenHash: string;
    capabilities?: Array<typeof CLI_AGENT_WEBSOCKET_CAPABILITY>;
  }): Promise<{ ok: boolean; ticket?: string; expiresAt?: number; error?: string }> {
    await this.requireTier(caller, 'auth_tokens');
    if (!/^[a-f0-9]{32}$/.test(input.userId)) return { ok: false, error: 'invalid user id' };
    if (input.agentClass !== ORCHESTRATOR_AGENT_SLUG) return { ok: false, error: 'invalid agent class' };
    if (!/^[a-f0-9]{64}$/.test(input.cliTokenHash)) return { ok: false, error: 'invalid token hash' };
    validateWorkspaceName(input.agentName);
    if (!this.workspaceRegistered(input.agentName)) return { ok: false, error: 'agent not found' };

    const now = Date.now();
    this.sqlx(`DELETE FROM cli_agent_connect_tickets WHERE expires_at <= ? OR used_at IS NOT NULL`, now);
    if (!this.cliBearerScopes(input.cliTokenHash, now)) return { ok: false, error: 'invalid CLI token' };

    const capabilities = input.capabilities?.length ? input.capabilities : [CLI_AGENT_WEBSOCKET_CAPABILITY];
    if (!capabilities.includes(CLI_AGENT_WEBSOCKET_CAPABILITY)) return { ok: false, error: 'missing websocket capability' };
    const ticket = `pat_${input.userId}_${randomToken(32)}`;
    const expiresAt = now + CLI_AGENT_CONNECT_TICKET_TTL_MS;
    this.sqlx(
      `INSERT INTO cli_agent_connect_tickets
         (ticket_hash, user_id, agent_class, agent_name, cli_token_hash, capabilities, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      await sha256Hex(ticket),
      input.userId,
      input.agentClass,
      input.agentName,
      input.cliTokenHash,
      JSON.stringify(capabilities),
      now,
      expiresAt,
    );
    return { ok: true, ticket, expiresAt };
  }

  async verifyCliAgentConnectTicket(
    caller: UserCaller,
    ticket: string,
    expected: {
      userId: string;
      agentClass: typeof ORCHESTRATOR_AGENT_SLUG;
      agentName: string;
      capability: typeof CLI_AGENT_WEBSOCKET_CAPABILITY;
    },
  ): Promise<CliAgentConnectTicketVerification> {
    await this.requireTier(caller, 'auth_tokens');
    const hintedUserId = parseCliAgentConnectTicketUserId(ticket);
    if (!hintedUserId) return { ok: false, error: 'malformed ticket' };
    if (hintedUserId !== expected.userId) return { ok: false, error: 'wrong user' };
    validateWorkspaceName(expected.agentName);

    const now = Date.now();
    this.sqlx(`DELETE FROM cli_agent_connect_tickets WHERE expires_at <= ? OR used_at IS NOT NULL`, now);
    const ticketHash = await sha256Hex(ticket);
    const row = this.sqlx<{
      user_id: string;
      agent_class: string;
      agent_name: string;
      cli_token_hash: string;
      capabilities: string;
      expires_at: number;
      used_at: number | null;
    }>(
      `SELECT user_id, agent_class, agent_name, cli_token_hash, capabilities, expires_at, used_at
         FROM cli_agent_connect_tickets
        WHERE ticket_hash = ? LIMIT 1`,
      ticketHash,
    )[0];
    if (!row || row.used_at !== null || row.expires_at <= now) return { ok: false, error: 'invalid ticket' };
    if (row.user_id !== expected.userId) return { ok: false, error: 'wrong user' };
    if (row.agent_class !== expected.agentClass) return { ok: false, error: 'wrong agent class' };
    if (row.agent_name !== expected.agentName) return { ok: false, error: 'wrong agent' };
    const capabilities = parseCapabilityList(row.capabilities);
    if (!capabilities.includes(expected.capability)) return { ok: false, error: 'missing capability' };

    this.sqlx(`UPDATE cli_agent_connect_tickets SET used_at = ? WHERE ticket_hash = ?`, now, ticketHash);
    if (!this.workspaceRegistered(expected.agentName)) return { ok: false, error: 'agent not found' };
    const bearerScopes = this.cliBearerScopes(row.cli_token_hash, now);
    if (!bearerScopes) return { ok: false, error: 'invalid CLI token' };
    const profile = await this.getProfile(await ownerCaller(this.env));
    if (!profile) return { ok: false, error: 'profile missing' };
    const verification: CliAgentConnectTicketVerification = {
      ok: true,
      user: { id: expected.userId, email: profile.email, displayName: profile.displayName },
      tokenHash: row.cli_token_hash,
      expiresAt: row.expires_at,
      capabilities,
      authGeneration: this.authGeneration(),
    };
    if (bearerScopes !== 'all') verification.scopes = bearerScopes;
    return verification;
  }

  /** A connect ticket stays bound to the bearer that minted it: an
   *  interactive session token (expiring, unscoped → 'all') or a live access
   *  token (revocable, pinned to its granted scopes). Null when the bearer is
   *  no longer valid. Scopes are resolved at verify time so a revoked access
   *  token can never ride a pre-minted ticket. */
  private cliBearerScopes(tokenHash: string, now: number): 'all' | AccessTokenScope[] | null {
    const session = this.sqlx<{ expires_at: number }>(
      `SELECT expires_at FROM user_cli_tokens WHERE token_hash = ? AND revoked_at IS NULL LIMIT 1`,
      tokenHash,
    )[0];
    if (session) return session.expires_at > now ? 'all' : null;
    return getActiveAccessTokenScopes(this.ctx.storage.sql, tokenHash);
  }

  // ── Connected devices (user-level laptop/PC tunnel hub) ──────────────
  //
  // The reverse-WS tunnel from a user's machine terminates HERE, not on a
  // specific agent — so one `kinu connect` lets every one of the user's
  // agents reach the device. The worker forwards the daemon's upgrade Request
  // to this DO (a WebSocket itself cannot cross the RPC boundary) and the
  // socket is accepted inside fetch() as a hibernatable WebSocket owned by
  // the DeviceSocketHub (tagging, replace-on-reconnect, DeviceTunnel rebuild
  // on wake). Agents reach a device by forwarding to `deviceRpc()` over a
  // DO-to-DO call.
  private readonly _devices = new DeviceSocketHub(this.ctx);

  /** The durable record of commands running on the user's machines, and the
   *  precedence protocol over it (see ./device-inflight.ts). This object owns
   *  the sockets and the consent boundary; the ledger owns the table. */
  private readonly _inflight = new DeviceRequestLedger(this.ctx.storage.sql);

  /** Intercept device-daemon WebSocket upgrades; everything else (agents-SDK
   *  routing, sub-agents) flows to the SDK untouched. */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === DEVICE_CONNECT_PATH) return this.acceptDeviceSocket(request, url);
    return super.fetch(request);
  }

  /** Verify + consume the daemon's connect ticket, accept its WebSocket, and
   *  ROTATE the device's long-lived token over that socket.
   *
   *  Ticket verification lives HERE (not in the worker) so the upgrade is safe
   *  no matter how the request reached this DO. Rotation lives here for the
   *  same reason it exists: this is the one moment the real machine has proved
   *  possession of the current secret, so it is the only moment a copy of
   *  `device.json` can be made stale. The new secret rides the socket that was
   *  just authenticated — it never appears in a URL or a log line.
   *
   *  A second socket taking the slot is never silent: the owner reads it on
   *  the device row. The newcomer wins the slot — a real machine redialling
   *  must not be locked out by a socket the hub has not yet noticed closing —
   *  and what stops the alternation a displacement used to start is the
   *  one-shot grace in {@link rotateDeviceToken}, not a refusal here.
   */
  private async acceptDeviceSocket(request: Request, url: URL): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }
    const ticket = url.searchParams.get('ticket');
    const verified = ticket ? await this.verifyDeviceConnectTicket(await ownerCaller(this.env), ticket) : { ok: false as const };
    if (!verified.ok || !verified.deviceId) return new Response('unauthorized', { status: 401 });

    if (this._devices.isConnected(verified.deviceId)) {
      this.sqlx(`UPDATE user_devices SET replaced_at = ? WHERE id = ?`, Date.now(), verified.deviceId);
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this._devices.accept(verified.deviceId, server);
    const now = Date.now();
    this.sqlx(
      `UPDATE user_devices SET connected_at = ?, last_seen_at = ?, last_ip = ?, last_agent = ? WHERE id = ?`,
      now, now,
      request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for'),
      (request.headers.get('user-agent') ?? '').slice(0, 200) || null,
      verified.deviceId,
    );
    server.send(JSON.stringify({
      type: DEVICE_TOKEN_ROTATION,
      token: await this.rotateDeviceToken(verified.deviceId, verified.tokenWasCurrent === true),
    }));
    const init: ResponseInit & { webSocket: WebSocket } = { status: 101, webSocket: client };
    return new Response(null, init);
  }

  /**
   * Mint this device's next long-lived token.
   *
   * `keepGrace` is the whole of the grace policy. The superseded hash is held
   * only when the machine reached this accept with the CURRENT secret, so the
   * one failure the grace exists for — a rotation lost with its socket — is
   * survivable, and the machine ends it by acknowledging
   * ({@link DEVICE_TOKEN_ROTATION_ACK}).
   *
   * A machine that reached this accept ON the grace gets none. It shares that
   * secret with anyone else holding a copy of `device.json`, so the superseded
   * hash it would leave behind is the OTHER claimant's live token: that is
   * precisely what let two claimants alternate forever, each one's reconnect
   * re-arming the other's. Withholding it ends the exchange at the first
   * hand-over, at the cost of one honest failure — two rotation frames lost in
   * a row now needs `kinu connect` again, and says so.
   *
   * The absolute window restarts here either way, so a machine that keeps
   * connecting never lapses and a copy that stops rotating expires on a wall
   * clock.
   */
  private async rotateDeviceToken(deviceId: string, keepGrace: boolean): Promise<string> {
    const token = `pdt_${randomToken(32)}`;
    // One statement: SQLite evaluates the right-hand sides against the row as
    // it stands, so `token_hash` here is the secret being superseded.
    this.sqlx(
      `UPDATE user_devices
          SET prev_token_hash = CASE WHEN ? THEN token_hash ELSE NULL END,
              token_hash = ?,
              expires_at = ?
        WHERE id = ?`,
      keepGrace ? 1 : 0, await sha256Hex(token), Date.now() + DEVICE_TOKEN_TTL_MS, deviceId,
    );
    return token;
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer | ArrayBufferView): Promise<void> {
    const deviceId = deviceIdFromSocket(ws);
    if (!deviceId) return super.webSocketMessage(ws, message);
    this.ensureInit();
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
    // The daemon's HELLO carries metadata; everything else (including a frame
    // that is not JSON at all) is an RPC response.
    const hello = v.safeParse(DeviceHelloSchema, tolerate(() => JSON.parse(data), 'malformed-input'));
    if (hello.success) {
      // COALESCE, not overwrite: a daemon too old to send these must not
      // erase what a newer one already recorded for this machine.
      this.sqlx(
        `UPDATE user_devices
            SET os = ?, hostname = ?, last_seen_at = ?,
                consented_root = COALESCE(?, consented_root),
                device_home = COALESCE(?, device_home)
          WHERE id = ?`,
        hello.output.os ?? null, hello.output.hostname ?? null, Date.now(),
        absolutePathOrNull(hello.output.root), absolutePathOrNull(hello.output.home),
        deviceId);
      return;
    }
    const acknowledged = v.safeParse(DeviceRotationAckSchema, tolerate(() => JSON.parse(data), 'malformed-input'));
    if (acknowledged.success) {
      // The machine says the new secret is on its disk, so the superseded one
      // has no remaining purpose. Every second it stays valid is a second a
      // copy of the old `device.json` could spend it.
      this.sqlx(`UPDATE user_devices SET prev_token_hash = NULL, last_seen_at = ? WHERE id = ?`,
        Date.now(), deviceId);
      return;
    }
    this._devices.handleMessage(deviceId, data);
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    const deviceId = deviceIdFromSocket(ws);
    if (!deviceId) return super.webSocketClose(ws, code, reason, wasClean);
    this.ensureInit();
    this._devices.handleClose(deviceId, ws);
    // A replacing socket may already be live — only then keep connected_at.
    if (!this._devices.isConnected(deviceId)) {
      this.sqlx(`UPDATE user_devices SET connected_at = NULL WHERE id = ?`, deviceId);
    }
  }

  override async webSocketError<ErrorValue>(ws: WebSocket, error: ErrorValue): Promise<void> {
    // Device sockets clean up in webSocketClose, which the runtime fires next.
    if (!deviceIdFromSocket(ws)) return super.webSocketError(ws, error);
  }

  /** Mint a device + connect token. The authenticated CLI receives the raw
   *  token once and writes it to the local daemon config; only its hash is
   *  stored here. The label is the user-chosen name the CLI prompts for
   *  (default `user@hostname`); 'Your PC' covers a caller that sent nothing. */
  async registerDevice(caller: UserCaller, label?: string): Promise<{ deviceId: string; token: string }> {
    await this.requireTier(caller, 'device.manage');
    const deviceId = `dev-${nanoid(10)}`;
    const token = `pdt_${randomToken(32)}`;
    const tokenHash = await sha256Hex(token);
    const now = Date.now();
    const trimmedLabel = label?.trim().slice(0, DEVICE_NAME_MAX_LENGTH);
    this.sqlx(
      `INSERT INTO user_devices (id, token_hash, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
      deviceId, tokenHash, trimmedLabel || 'Your PC', now, now + DEVICE_TOKEN_TTL_MS,
    );
    return { deviceId, token };
  }

  /** Rename a registered device. Every surface renders this name; the id and
   *  credentials are untouched. */
  async renameDevice(caller: UserCaller, deviceId: string, name: string): Promise<{ ok: boolean }> {
    await this.requireTier(caller, 'device.manage');
    const trimmed = name.trim().slice(0, DEVICE_NAME_MAX_LENGTH);
    const row = trimmed ? this.sqlx<{ id: string }>(
      `SELECT id FROM user_devices WHERE id = ? AND revoked_at IS NULL LIMIT 1`, deviceId,
    )[0] : undefined;
    if (!row) return { ok: false };
    this.sqlx(`UPDATE user_devices SET label = ? WHERE id = ?`, trimmed, deviceId);
    return { ok: true };
  }

  /**
   * Verify a presented device token.
   *
   * The window is ABSOLUTE, measured from the last rotation — verification does
   * not extend it. That is the point: an idle-sliding window kept a copied
   * `device.json` alive forever as long as the thief kept connecting, while a
   * real machine renews by ROTATING on every accept.
   *
   * The superseded secret is accepted once more, so a rotation message lost
   * with its socket does not brick the machine. THAT GRACE IS ONE-SHOT, from
   * both ends: any successful verification clears it, and the accept that rode
   * it may not mint another (see {@link acceptDeviceSocket}). Clearing only on
   * the CURRENT hash, and re-granting a grace on every accept, is what made a
   * copied `device.json` perpetual — each accept handed the OTHER holder a
   * fresh grace to reconnect on, so two claimants alternated indefinitely and
   * both always held a live token. One shot means the exchange terminates: the
   * loser's token is neither current nor grace, and its next connect is
   * refused and recorded on the device row.
   *
   * `current` says which of the two matched. It travels on the ticket rather
   * than being re-derived at the accept, because by then the hash the machine
   * proved is gone.
   *
   * Rows written before the window existed carry a null `expires_at` and are
   * stamped on their next rotation rather than being locked out.
   */
  async verifyDeviceToken(caller: UserCaller, token: string): Promise<{ ok: boolean; deviceId?: string; current?: boolean }> {
    await this.requireTier(caller, 'device.manage');
    if (!/^pdt_[A-Za-z0-9_-]{32,}$/.test(token)) return { ok: false };
    const tokenHash = await sha256Hex(token);
    const row = this.sqlx<{ id: string; expires_at: number | null; current: number }>(
      `SELECT id, expires_at, (token_hash = ?) AS current
         FROM user_devices
        WHERE (token_hash = ? OR prev_token_hash = ?) AND revoked_at IS NULL
        LIMIT 1`,
      tokenHash, tokenHash, tokenHash,
    )[0];
    if (!row) return { ok: false };
    if (row.expires_at !== null && row.expires_at <= Date.now()) return { ok: false };
    this.sqlx(`UPDATE user_devices SET prev_token_hash = NULL WHERE id = ?`, row.id);
    return { ok: true, deviceId: row.id, current: row.current === 1 };
  }

  /** Exchange the daemon's local long-lived token for a one-minute WebSocket
   *  ticket. The ticket is scoped to this UserDO and can be consumed once. */
  async issueDeviceConnectTicket(caller: UserCaller, token: string): Promise<{ ok: boolean; ticket?: string; expiresAt?: number }> {
    await this.requireTier(caller, 'device.manage');
    const verified = await this.verifyDeviceToken(await ownerCaller(this.env), token);
    if (!verified.ok || !verified.deviceId) return { ok: false };
    const now = Date.now();
    this.sqlx(`DELETE FROM device_connect_tickets WHERE expires_at <= ? OR used_at IS NOT NULL`, now);
    const ticket = `pct_${randomToken(32)}`;
    const expiresAt = now + DEVICE_CONNECT_TICKET_TTL_MS;
    this.sqlx(
      `INSERT INTO device_connect_tickets
         (ticket_hash, device_id, created_at, expires_at, token_was_current)
       VALUES (?, ?, ?, ?, ?)`,
      await sha256Hex(ticket),
      verified.deviceId,
      now,
      expiresAt,
      verified.current === true ? 1 : 0,
    );
    return { ok: true, ticket, expiresAt };
  }

  /** Consume a short-lived WebSocket connect ticket. */
  async verifyDeviceConnectTicket(caller: UserCaller, ticket: string): Promise<{ ok: boolean; deviceId?: string; tokenWasCurrent?: boolean }> {
    await this.requireTier(caller, 'device.manage');
    if (!/^pct_[A-Za-z0-9_-]{32,}$/.test(ticket)) return { ok: false };
    const now = Date.now();
    this.sqlx(`DELETE FROM device_connect_tickets WHERE expires_at <= ? OR used_at IS NOT NULL`, now);
    const ticketHash = await sha256Hex(ticket);
    const row = this.sqlx<{
      device_id: string; expires_at: number; used_at: number | null; token_was_current: number | null;
    }>(
      `SELECT device_id, expires_at, used_at, token_was_current
         FROM device_connect_tickets
        WHERE ticket_hash = ? LIMIT 1`,
      ticketHash,
    )[0];
    if (!row || row.used_at !== null || row.expires_at <= now) return { ok: false };
    this.sqlx(`UPDATE device_connect_tickets SET used_at = ? WHERE ticket_hash = ?`, now, ticketHash);
    const active = this.sqlx<{ id: string }>(
      `SELECT id FROM user_devices WHERE id = ? AND revoked_at IS NULL LIMIT 1`, row.device_id,
    )[0];
    if (!active) return { ok: false };
    // A null column is a ticket written before it existed: read as "not proved
    // current", which withholds the grace rather than granting one on a guess.
    return { ok: true, deviceId: row.device_id, tokenWasCurrent: row.token_was_current === 1 };
  }

  private deviceLabel(deviceId: string): string {
    return this.sqlx<{ label: string }>(`SELECT label FROM user_devices WHERE id = ?`, deviceId)[0]?.label ?? 'your device';
  }

  private isActiveDevice(deviceId: string): boolean {
    return this.sqlx<{ id: string }>(
      `SELECT id FROM user_devices WHERE id = ? AND revoked_at IS NULL LIMIT 1`, deviceId,
    )[0] !== undefined;
  }

  /** Forward a JSON-RPC call to a connected device — the single consent
   *  chokepoint. Every agent call passes its name, so we can enforce the
   *  per-(agent, device) policy: allow → run; deny → block; ask → call back to
   *  the agent to raise a consent card and await the user's decision. */
  async deviceRpc(
    caller: UserCaller,
    method: string,
    params: JsonValue[],
    opts?: {
      deviceId?: string; agentName?: string; checkpoint?: DeviceCheckpointHint;
      timeoutMs?: number; requestId?: string; backgroundJobId?: string;
    },
  ): Promise<string | undefined> {
    const resolved = await this.requireTier(caller, 'device.rpc');
    // STOPPING work is never gated. Consent decides what may run on the
    // machine, and a cancellation only ends a command the owner already let
    // through — gating it would leave a live process waiting on a card nobody
    // is there to answer, which is the failure the cancellation exists for.
    const stopping = method === DEVICE_CANCEL_METHOD;
    const ownerRead = opts?.agentName === undefined && Object.hasOwn(CONSENT_FREE_DEVICE_METHODS, method);
    const consentAgent = stopping ? undefined : (resolved.kind === 'workspace'
      ? (ownerRead ? undefined : resolved.workspace)
      : opts?.agentName);
    const deviceId = this._devices.connectedDeviceId(opts?.deviceId);
    if (!deviceId) {
      // A workspace operation that needs a machine raises one provisioning
      // request. Owner-facing checkpoint reads stay consent-free and simply
      // report that no machine is connected.
      if (consentAgent !== undefined) {
        await this.raiseProvisioningRequest(consentAgent);
      }
      throw new Error(NO_DEVICE_CONNECTED);
    }
    if (!stopping && !this.isActiveDevice(deviceId)) throw new Error(NO_DEVICE_CONNECTED);
    if (consentAgent !== undefined) {
      // Consent is keyed on the PROVEN workspace, never the claimed name — an
      // agent cannot ride a sibling workspace's remembered grant. The three
      // closed checkpoint reads above are the only consent-free methods.
      const consent = await this.checkDeviceConsent(
        consentAgent, deviceId, method, params,
        resolved.kind === 'workspace' ? resolved.workspace : undefined,
      );
      if (!consent.allowed) throw new Error(consent.reason);
    }
    if (!stopping && !this.isActiveDevice(deviceId)) throw new Error(NO_DEVICE_CONNECTED);
    const tunnel = this._devices.tunnel(deviceId);
    if (!tunnel) throw new Error(NO_DEVICE_CONNECTED);
    const rpcOptions: NonNullable<Parameters<typeof tunnel.rpc>[2]> = {};
    if (opts?.checkpoint) {
      rpcOptions.extra = {
        checkpoint: {
          agent: opts.checkpoint.agent,
          turnId: opts.checkpoint.turnId,
          sessionId: opts.checkpoint.sessionId,
          dir: opts.checkpoint.dir,
        },
      };
    }
    if (opts?.timeoutMs !== undefined) rpcOptions.timeoutMs = opts.timeoutMs;
    if (opts?.requestId !== undefined) rpcOptions.requestId = opts.requestId;

    // Persist BEFORE the frame leaves UserDO. The request identity is the same
    // one the daemon registers its owned process group under and the same one
    // `execCancel` names; an insert after send would recreate the eviction gap
    // as a small race. Only a PROVEN workspace command carries a durable turn
    // identity, so owner-side/out-of-turn operations do not pretend to have
    // turn authority they do not possess.
    const requestId = opts?.requestId;
    const durableExec = method === 'exec' && requestId !== undefined && resolved.kind === 'workspace';
    if (durableExec) {
      // A probe must never ACK the command's own id: a retry may carry a
      // retained terminal result, and ACKing it before replay would delete it.
      // This fresh canonical id names no command and only distinguishes a
      // daemon that implements durable result acknowledgement before work.
      await tunnel.rpc(DEVICE_EXEC_ACK_METHOD, [nextDeviceRequestId(), DEVICE_CANCEL_PROTOCOL]);
      // The probe is an await, so a revocation sweep can land inside it. Recheck
      // admission before the row and the frame: a command admitted after that
      // sweep claimed this device's requests would run with nothing left to
      // cancel it and nothing counting it as unstopped.
      if (!this.isActiveDevice(deviceId)) throw new Error(NO_DEVICE_CONNECTED);
      // A command issued INSIDE an already-detached scope is the background
      // job's from the start, which is why the owner is passed to the insert
      // rather than handed over afterwards.
      //
      // An owner that does not NAME a job is refused rather than stored: a blank
      // owner would leave a row that neither a turn sweep nor a job sweep can
      // ever select, which is precisely the orphan this table exists to prevent.
      const backgroundJobId = opts?.backgroundJobId ?? null;
      if (backgroundJobId === '') {
        throw new KinuError('bad_input', 'A background job id must name a job.');
      }
      this.ensureInit();
      this._inflight.insert({
        requestId,
        deviceId,
        workspace: resolved.workspace,
        turnId: opts?.checkpoint?.turnId ?? null,
        backgroundJobId,
      });
    }
    const result = await tunnel.rpc(method, params, rpcOptions);
    // A tool aborting its own exec sends this frame straight through, so the
    // answer must land in the same place a durable sweep would put it. First
    // answer wins: it is the one that actually ended the process group, and a
    // later sweep then reports it instead of killing a dead command again.
    if (stopping) this.recordToolPathCancellation(params, result);
    return result === undefined ? undefined : JSON.stringify(result);
  }

  /** Store the answer from a cancellation this UserDO merely forwarded, so the
   *  durable authority holds ONE outcome per request whichever path stopped it.
   *
   *  An answer that does not NAME the request asked about is not this request's
   *  answer, so it is neither stored nor returned: the caller is told the stop
   *  was not confirmed, and the row stays live work for the next sweep. */
  private recordToolPathCancellation(params: JsonValue[], result: JsonValue | undefined): void {
    const requestId = v.safeParse(CancelledRequestIdSchema, params[0]);
    if (!requestId.success) return;
    const answer = parseDeviceCancelAnswer(requestId.output, result);
    this.ensureInit();
    this._inflight.settleUnclaimed(requestId.output, answer.cancelled);
  }

  /**
   * Cloud-side acceptance of one exec result. The supervisor's normal result
   * remains local and replayable until this RPC has the proven workspace row,
   * then acknowledges the daemon before removing the durable row.
   *
   * A claimed row belongs to an in-flight cancellation, which owns the terminal
   * outcome and sends its own acknowledgement. Completion racing cancellation
   * therefore settles once, under whichever authority claimed the row first.
   */
  async acknowledgeDeviceRequest(caller: UserCaller, requestId: string): Promise<void> {
    const resolved = await this.requireTier(caller, 'device.rpc');
    if (resolved.kind !== 'workspace' || requestId === '') return;
    const held = this._inflight.acknowledgeable(requestId, resolved.workspace);
    if (!held) return;
    const tunnel = this._devices.tunnel(held.deviceId);
    if (!tunnel) throw new Error(NO_DEVICE_CONNECTED);
    await tunnel.rpc(DEVICE_EXEC_ACK_METHOD, [requestId, DEVICE_CANCEL_PROTOCOL]);
    this._inflight.deleteAcknowledged({
      requestId, workspace: resolved.workspace, deviceId: held.deviceId,
    });
  }

  /**
   * Stop every live device command of one durable turn after a fresh actor
   * activation. The actor's in-memory AbortControllers died with that
   * activation; these UserDO rows are the durable complement, inserted before
   * their frames left the socket.
   *
   * Rows with no turn id are deliberately excluded. An operation issued outside
   * a turn has no turn authority, so Stop must not widen into a workspace sweep.
   */
  async cancelDeviceRequestsForTurn(
    caller: UserCaller,
    turnId: string,
  ): Promise<DeviceCancellationOutcome[]> {
    // Claim ownership atomically BEFORE any device await. A snapshot-then-await
    // sweep could still cancel a request a parallel detach moved to a background
    // job in the meantime; the claim makes precedence one synchronous storage
    // decision instead of a race.
    return this.cancelClaimedDeviceRequests(caller, turnId,
      (workspace) => this._inflight.claimTurnRequests(workspace, turnId));
  }

  /** One guard for both cancellation scopes: the device tier, the workspace
   *  kind, and the refusal of an empty id are one policy, not two copies. */
  private async cancelClaimedDeviceRequests(
    caller: UserCaller,
    scopeId: string,
    claim: (workspace: string) => ClaimedDeviceRequest[],
  ): Promise<DeviceCancellationOutcome[]> {
    const resolved = await this.requireTier(caller, 'device.rpc');
    if (resolved.kind !== 'workspace' || scopeId === '') return [];
    return this.cancelDeviceRequests(claim(resolved.workspace));
  }

  /**
   * Move ONE live device request to the durable background job that now owns
   * it. Ownership is per request because a single turn can hold several
   * parallel device calls, and only the detaching call changes hands.
   */
  async transferDeviceRequestToBackgroundJob(
    caller: UserCaller,
    requestId: string,
    jobId: string,
  ): Promise<{ transferred: boolean }> {
    const resolved = await this.requireTier(caller, 'device.rpc');
    if (resolved.kind !== 'workspace' || requestId === '' || jobId === '') return { transferred: false };
    return this._inflight.transferToBackgroundJob({
      requestId, workspace: resolved.workspace, jobId,
    });
  }

  /** Stop all live device work owned by one durable background job. */
  async cancelDeviceRequestsForBackgroundJob(
    caller: UserCaller,
    jobId: string,
  ): Promise<DeviceCancellationOutcome[]> {
    return this.cancelClaimedDeviceRequests(caller, jobId,
      (workspace) => this._inflight.claimBackgroundJobRequests(workspace, jobId));
  }

  /**
   * Ask the device to stop each claimed request, and report what stopping it
   * achieved. The ledger owns which row this sweep may still speak for; this
   * loop owns the frames and what the caller is told.
   */
  private async cancelDeviceRequests(rows: ClaimedDeviceRequest[]): Promise<DeviceCancellationOutcome[]> {
    const outcomes: DeviceCancellationOutcome[] = [];
    for (const row of rows) {
      // One read, taken BEFORE any frame, answers both questions that can have
      // changed while an earlier row was awaiting: does this sweep still own the
      // row, and has an answer landed since it was claimed? A tool aborting its
      // own exec stores one through `deviceRpc`, so re-reading here is what stops
      // this sweep killing a command that is already dead and contradicting the
      // answer the abort reported.
      const held = this._inflight.held(row.requestId, row.claim);
      if (held === null) continue;
      if (held.settled !== null) {
        outcomes.push({ requestId: row.requestId, outcome: held.settled });
        await this.cleanUpSettledDeviceRequest(row);
        continue;
      }
      const tunnel = this._devices.tunnel(row.deviceId);
      if (!tunnel) {
        this._inflight.releaseClaim(row.requestId, row.claim);
        outcomes.push({ requestId: row.requestId, outcome: 'failed', detail: NO_DEVICE_CONNECTED });
        continue;
      }
      try {
        const answer = parseDeviceCancelAnswer(row.requestId, await tunnel.rpc(
          DEVICE_CANCEL_METHOD, [row.requestId, DEVICE_CANCEL_PROTOCOL],
        )).cancelled;
        // Durable BEFORE the acknowledgement, because the acknowledgement is the
        // step that can fail. The guarded write is also this call's post-await
        // ownership check: no row updated means the terminal authority took the
        // claim mid-flight, and it - not this sweep - reports the request. What
        // comes back is the answer that STANDS, which is this sweep's only when
        // no answer landed while it was waiting.
        const settled = this._inflight.settleHeld(row.requestId, row.claim, answer);
        if (settled === null) continue;
        outcomes.push({ requestId: row.requestId, outcome: settled });
        await this.cleanUpSettledDeviceRequest(row);
      } catch (err) {
        // The kill itself failed, so this request is still live work. The
        // release doubles as the ownership check: releasing nothing means the
        // terminal authority took or dropped the row mid-flight, and it - not
        // this sweep - answers for the request.
        if (!this._inflight.releaseClaim(row.requestId, row.claim)) continue;
        outcomes.push({
          requestId: row.requestId,
          outcome: 'failed',
          detail: renderThrownChain({ cause: err }),
        });
      }
    }
    return outcomes;
  }

  /**
   * Release the daemon's retained supervisor for a settled request, then drop
   * the row. Cleanup failure is not cancellation failure: the stored answer
   * stays truthful, the claim goes back so the next sweep in this activation can
   * retry, and the row stays untransferable because it is settled.
   */
  private async cleanUpSettledDeviceRequest(row: ClaimedDeviceRequest): Promise<void> {
    const tunnel = this._devices.tunnel(row.deviceId);
    try {
      if (!tunnel) throw new Error(NO_DEVICE_CONNECTED);
      await tunnel.rpc(DEVICE_EXEC_ACK_METHOD, [row.requestId, DEVICE_CANCEL_PROTOCOL]);
      this._inflight.deleteHeld(row.requestId, row.claim);
    } catch (err) {
      this._inflight.releaseClaim(row.requestId, row.claim);
      diagnostics.failure('device.cancellation_ack_cleanup_failed', toKinuError({
        doing: 'releasing the cancelled device command supervisor',
        cause: err,
        otherwise: 'unavailable',
      }), { device: row.deviceId, request: row.requestId });
    }
  }


  // ── Device consent (ask-once-then-remember) ──────────────────────────

  private getDeviceConsentPolicy(agentName: string, deviceId: string): { policy: 'allow' | 'deny'; scope: DeviceConsentScope } | null {
    const row = this.sqlx<{ policy: string; scope: string }>(
      `SELECT policy, scope FROM device_consent WHERE agent_name = ? AND device_id = ?`, agentName, deviceId,
    )[0];
    if (row?.policy !== 'allow' && row?.policy !== 'deny') return null;
    return { policy: row.policy, scope: parseConsentScope(row.scope) };
  }

  private setDeviceConsentPolicy(
    agentName: string,
    deviceId: string,
    policy: 'allow' | 'deny',
    lastAction?: { method: string; command: string },
    scope: DeviceConsentScope = DEVICE_CONSENT_SCOPE,
  ): void {
    // Remembering a base action grant must not downgrade full_filesystem.
    const existing = this.sqlx<{ scope: string }>(
      `SELECT scope FROM device_consent WHERE agent_name = ? AND device_id = ?`, agentName, deviceId,
    )[0];
    const effectiveScope = policy === 'allow' ? mergeConsentScope(existing?.scope, scope) : scope;
    this.sqlx(
      `INSERT INTO device_consent
         (agent_name, device_id, policy, scope, last_method, last_summary, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_name, device_id) DO UPDATE SET
         policy = excluded.policy,
         scope = excluded.scope,
         last_method = excluded.last_method,
         last_summary = excluded.last_summary,
         updated_at = excluded.updated_at`,
      agentName, deviceId, policy, effectiveScope,
      lastAction?.method ?? null, lastAction?.command ?? null, Date.now(),
    );
  }

  /** Resolve consent for one agent→device call. Remembered policies short-
   *  circuit (either tier covers device actions — full_filesystem implies the
   *  base grant); otherwise the agent renders a card and the user decides. */
  /**
   * Consent for one device call. Fails CLOSED, but says which kind of closed:
   * a refusal the owner made, or a prompt nobody answered. The caller turns
   * `reason` into the error the model reads, and the two must not be the same
   * sentence — an unattended agent that reads an expired prompt as a refusal
   * concludes the capability was taken away and stops asking for it.
   */
  private async checkDeviceConsent(
    agentName: string, deviceId: string, method: string, params: JsonValue[],
    /** Present when the caller is the named workspace itself — the card then
     *  asks for THE WORKSPACE's grant, which is what "always" records. */
    workspaceName?: string,
  ): Promise<{ allowed: true } | { allowed: false; reason: string }> {
    const requiredScope = deviceConsentScopeForMethod(method);
    const policy = this.getDeviceConsentPolicy(agentName, deviceId);
    if (policy?.policy === 'allow' && consentScopeCovers(policy.scope, requiredScope)) return { allowed: true };
    if (policy?.policy === 'deny') return { allowed: false, reason: DEVICE_CONSENT_DENIED };
    const action = summarizeDeviceAction(method, params);
    let decision: DeviceConsentDecision;
    try {
      const stub = this.env.OrchestratorAgent.get(this.env.OrchestratorAgent.idFromName(agentName));
      const base: DeviceConsentRequest = {
        deviceId,
        deviceLabel: this.deviceLabel(deviceId),
        method: action.method,
        command: action.command,
        scope: requiredScope,
      };
      const request: DeviceConsentRequest = workspaceName
        ? { ...base, workspaceName }
        : base;
      decision = await stub.awaitDeviceConsent(request);
    } catch (error) {
      // The agent could not be reached to raise the card at all — nobody was
      // asked, so this is the unanswered case, not a refusal.
      diagnostics.event('device.consent_unreachable', { error: renderThrownChain({ cause: error }) });
      return { allowed: false, reason: DEVICE_CONSENT_UNANSWERED };
    }
    // Only "always" is remembered; "once", "deny" and "timeout" are per-call.
    if (decision === 'deny') return { allowed: false, reason: DEVICE_CONSENT_DENIED };
    if (decision === 'timeout') return { allowed: false, reason: DEVICE_CONSENT_UNANSWERED };
    // A CARD NEVER RECORDS THE FULL TIER. The card an exec raises names one
    // command, and "always" on it granted an unattended `bash -c` as the owner
    // on every later turn, from every ingress the workspace consumes — a peer
    // agent's task, a webhook body, an inbound email. The owner who pressed it
    // was answering about `printf %s "$HOME"`. The full tier is granted only
    // where it is stated as a standing decision about a machine, in Account
    // settings (`setDeviceConsentScope`), so "always" here remembers the base
    // tier and an exec keeps asking until that toggle exists.
    if (decision === 'always') {
      const remembered = requiredScope === DEVICE_CONSENT_SCOPE_FULL_FS
        ? DEVICE_CONSENT_SCOPE
        : requiredScope;
      this.setDeviceConsentPolicy(agentName, deviceId, 'allow', action, remembered);
    }
    return { allowed: true };
  }

  /**
   * The agent reached for its owner's computer and none was connected. Raise
   * ONE provisioning card on the same rail per-action consent rides — approve
   * surfaces the connect flow, deny ends the asking — and fail the call
   * either way: nothing executes until a daemon is actually linked.
   * A retry loop cannot stack cards: the registry joins an identical prompt
   * already waiting instead of minting a second id (DeviceConsentRegistry.
   * request). This used to check listPendingConsents here first, which is a
   * check-then-act across two RPCs and races itself.
   */
  private async raiseProvisioningRequest(workspaceOrAgent: string): Promise<void> {
    try {
      const stub = this.env.OrchestratorAgent.get(this.env.OrchestratorAgent.idFromName(workspaceOrAgent));
      await stub.awaitDeviceConsent({
        deviceId: '',
        deviceLabel: 'this computer',
        method: DEVICE_PROVISION_METHOD,
        command: `Connect this computer so "${workspaceOrAgent}" can run commands on it — you will be walked through \`kinu connect\`.`,
        scope: DEVICE_CONSENT_SCOPE,
        workspaceName: workspaceOrAgent,
      });
    } catch (error) {
      // No one to show the card to is the unanswered case, never a refusal.
      diagnostics.event('device.provision_request_unreachable', { error: renderThrownChain({ cause: error }) });
    }
  }

  /** The remembered consent policies (Account settings → Devices — see/revoke which agents may
   *  use a device). */
  async listDeviceConsents(caller: UserCaller): Promise<Array<{
    agentName: string;
    deviceId: string;
    policy: string;
    scope: DeviceConsentScope;
    lastMethod: string | null;
    lastSummary: string | null;
  }>> {
    await this.requireTier(caller, 'device.consent');
    return this.sqlx<{
      agent_name: string; device_id: string; policy: string; scope: string;
      last_method: string | null; last_summary: string | null;
    }>(
      `SELECT agent_name, device_id, policy, scope, last_method, last_summary
       FROM device_consent ORDER BY updated_at DESC`,
    ).map((r) => ({
      agentName: r.agent_name,
      deviceId: r.device_id,
      policy: r.policy,
      scope: parseConsentScope(r.scope),
      lastMethod: r.last_method,
      lastSummary: r.last_summary,
    }));
  }

  /**
   * Grant or reduce a workspace's consent tier on a device (Account settings →
   * Devices, and the CLI's owner-authenticated route). Granting
   * full_filesystem also records the base 'allow' policy.
   *
   * BOTH NAMES ARE CHECKED AGAINST THE REGISTRY, here rather than in the
   * route. A grant is read by name on every later device call, so a row naming
   * a workspace that does not exist is a grant waiting for one to be created
   * with that name — which is exactly how a deleted workspace's
   * full_filesystem used to be inherited by its replacement. Checking in the
   * route instead would be a check-then-act across two RPCs, and this object
   * serializes nothing across an await.
   */
  async setDeviceConsentScope(caller: UserCaller, agentName: string, deviceId: string, scope: DeviceConsentScope): Promise<{ ok: boolean }> {
    await this.requireTier(caller, 'device.consent');
    if (scope !== DEVICE_CONSENT_SCOPE && scope !== DEVICE_CONSENT_SCOPE_FULL_FS) {
      return { ok: false };
    }
    // `workspaceMintable`, not `workspaceRegistered`: an archived workspace is
    // reopenable and its grants are the owner's to set, while a name whose
    // teardown has started is one this registry no longer holds. The device
    // must be an unrevoked row for the same reason — a grant on a dead device
    // id is a row the owner's roster shows and nothing can ever use.
    if (!this.workspaceMintable(agentName) || !this.isActiveDevice(deviceId)) {
      return { ok: false };
    }
    // An explicit tier choice overrides the no-downgrade merge.
    this.sqlx(
      `INSERT INTO device_consent (agent_name, device_id, policy, scope, updated_at)
       VALUES (?, ?, 'allow', ?, ?)
       ON CONFLICT(agent_name, device_id) DO UPDATE SET
         policy = 'allow', scope = excluded.scope, updated_at = excluded.updated_at`,
      agentName, deviceId, scope, Date.now(),
    );
    return { ok: true };
  }

  /** Revoke a workspace's grant on a device (Account settings → Devices).
   *  The row is deleted rather than flipped to 'deny', so the next call asks
   *  again instead of reading as a standing refusal — and it takes effect on
   *  that next call, because the chokepoint reads this table every time.
   *
   *  It is not a stop, and must not be read as one: consent decides what may
   *  START, so a command already running keeps running and still returns its
   *  result. `revokeDevice` is the authority that ENDS live commands. */
  async revokeDeviceConsent(caller: UserCaller, agentName: string, deviceId: string): Promise<{ ok: boolean }> {
    await this.requireTier(caller, 'device.consent');
    if (!agentName || !deviceId) return { ok: false };
    this.sqlx(`DELETE FROM device_consent WHERE agent_name = ? AND device_id = ?`, agentName, deviceId);
    return { ok: true };
  }

  /** The device file view's path-scope check: does this workspace hold the
   *  full-filesystem tier on the currently connected device? */
  async getDeviceFsConsent(caller: UserCaller, agentName: string): Promise<{ fullFilesystem: boolean }> {
    const resolved = await this.requireTier(caller, 'device.consent.read_self');
    const deviceId = this._devices.connectedDeviceId();
    if (!deviceId) return { fullFilesystem: false };
    const policy = this.getDeviceConsentPolicy(
      resolved.kind === 'workspace' ? resolved.workspace : agentName, deviceId,
    );
    return {
      fullFilesystem: policy?.policy === 'allow' && policy.scope === DEVICE_CONSENT_SCOPE_FULL_FS,
    };
  }

  /**
   * The user's devices for Account settings.
   *
   * Ordinary revoked rows stay hidden. A revoked row with `unstopped_at` remains
   * visible only until its owner acknowledges the incident: hiding it on reload
   * would make the durable warning/ack action vanish before anyone could read
   * it. The explicit `revokedAt` tells the UI not to offer connect/rename
   * controls for this incident row.
   */
  async listDevices(caller: UserCaller): Promise<Array<{
    id: string; label: string; os: string | null; hostname: string | null;
    connected: boolean; createdAt: number; lastSeenAt: number | null; expiresAt: number | null;
    lastIp: string | null; lastAgent: string | null; replacedAt: number | null;
    revokedAt: number | null; unstoppedAt: number | null;
  }>> {
    await this.requireTier(caller, 'device.manage');
    return this.sqlx<{
      id: string; label: string; os: string | null; hostname: string | null;
      created_at: number; last_seen_at: number | null; expires_at: number | null;
      last_ip: string | null; last_agent: string | null; replaced_at: number | null;
      revoked_at: number | null; unstopped_at: number | null;
    }>(`SELECT id, label, os, hostname, created_at, last_seen_at, expires_at,
               last_ip, last_agent, replaced_at, revoked_at, unstopped_at
          FROM user_devices
         WHERE revoked_at IS NULL OR unstopped_at IS NOT NULL
         ORDER BY created_at DESC`)
      .map((r) => ({
        id: r.id, label: r.label, os: r.os, hostname: r.hostname,
        connected: r.revoked_at === null && this._devices.isConnected(r.id),
        createdAt: r.created_at, lastSeenAt: r.last_seen_at, expiresAt: r.expires_at,
        lastIp: r.last_ip, lastAgent: r.last_agent, replacedAt: r.replaced_at,
        revokedAt: r.revoked_at, unstoppedAt: r.unstopped_at,
      }));
  }

  /**
   * The device plane as an agent runtime needs it: whether a machine is there,
   * and what that machine can run. One call, because a laptop row that says
   * "connected" and nothing about its toolchain is honest and useless — the
   * declared set is what the model reads to decide where to send work.
   *
   * The toolchain half is asked of the machine on the first status read after it
   * connects, and again once an answer ages out of evidence. Deliberately not
   * asked from the WebSocket message handler where HELLO arrives: the reply is
   * itself a frame on that socket, so awaiting it there would wait on the
   * handler that has to deliver it. Here the caller is another Durable Object,
   * exactly as it is for `deviceRpc`, and the round-trip is bounded.
   *
   * Separate from `listDevices`, which serves Account settings: that is the
   * device REGISTRY (labels, timestamps, revocation) and must not pay for a
   * device round-trip to render a settings page.
   */
  async deviceRuntimeStatus(caller: UserCaller): Promise<DeviceStatus> {
    const resolved = await this.requireTier(caller, 'device.rpc');
    const workspace = resolved.kind === 'workspace' ? resolved.workspace : null;
    const deviceId = this._devices.connectedDeviceId();
    // Names and liveness are visible BEFORE any grant: an agent that cannot
    // see the machine cannot ask for it by name, and seeing it grants nothing —
    // every call still goes through the consent chokepoint above.
    const devices = this.deviceFleet();
    if (deviceId) {
      const granted = workspace
        ? this.getDeviceConsentPolicy(workspace, deviceId)?.policy === 'allow'
        : undefined;
      const scope = this.sqlx<{ consented_root: string | null; device_home: string | null }>(
        `SELECT consented_root, device_home FROM user_devices WHERE id = ?`, deviceId,
      )[0];
      const status: DeviceStatus = {
        connected: true,
        registered: true,
        toolchain: await this._devices.probeToolchain(deviceId, Date.now()),
        devices,
        consentedRoot: scope?.consented_root ?? null,
        deviceHome: scope?.device_home ?? null,
      };
      if (granted !== undefined) status.workspaceGranted = granted;
      return status;
    }
    return { connected: false, registered: devices.length > 0, toolchain: null, devices };
  }

  /** Every registered device with its user-chosen name, platform and live
   *  state — the pre-grant view both the agent's executor row and the UI read. */
  private deviceFleet(): DeviceFleetEntry[] {
    return this.sqlx<{ id: string; label: string; os: string | null; hostname: string | null }>(
      `SELECT id, label, os, hostname FROM user_devices
        WHERE revoked_at IS NULL ORDER BY created_at DESC`,
    ).map((r) => ({
      id: r.id,
      name: r.label,
      os: r.os,
      hostname: r.hostname,
      connected: this._devices.isConnected(r.id),
    }));
  }

  /**
   * Revoke a device only after attempting to terminate each unsettled command.
   *
   * A close remains the backstop for a daemon that cannot answer, but it is not
   * proof a process stopped. Every unconfirmed request is recorded on the
   * owner-visible device row before its active row is removed: revocation makes
   * the daemon unable to reconnect, so retaining an active row would leave
   * nothing that could ever act on it.
   */
  async revokeDevice(
    caller: UserCaller,
    deviceId: string,
  ): Promise<{ ok: boolean; unstoppedCommands: number }> {
    await this.requireTier(caller, 'device.manage');
    // Revoking one device twice at once is one terminal act, not two. Without
    // coalescing, two sweeps share the device row: whichever finishes last
    // decides what the owner sees, so a confirmed sweep could erase the
    // unconfirmed commands the other one just reported. Same reason as
    // `_provisioning` above - a Durable Object serializes nothing across an
    // outbound await.
    const inFlight = this._revoking.get(deviceId);
    if (inFlight) return inFlight;
    const task = this.sweepAndRevokeDevice(deviceId);
    this._revoking.set(deviceId, task);
    try { return await task; } finally { this._revoking.delete(deviceId); }
  }

  private readonly _revoking = new Map<string, Promise<{ ok: boolean; unstoppedCommands: number }>>();

  private async sweepAndRevokeDevice(
    deviceId: string,
  ): Promise<{ ok: boolean; unstoppedCommands: number }> {
    const now = Date.now();
    // Close admission before the first cancellation await. A device RPC that
    // resumes after its consent await rechecks this durable state before send.
    this.sqlx(
      `UPDATE user_devices SET revoked_at = ?, connected_at = NULL
        WHERE id = ? AND revoked_at IS NULL`,
      now, deviceId,
    );
    // Revocation is the terminal device authority, so it TAKES the claim from
    // any in-flight sweep rather than reading a list that a concurrent detach or
    // sweep can change under its awaits. A displaced sweep keeps reporting the
    // outcome it observed; its guarded cleanup simply finds the row already gone.
    const rows = this._inflight.claimEveryRequestOf(deviceId);
    // Pessimistic, and written BEFORE the first await below: an activation that
    // dies mid-sweep leaves a revoked device the owner can SEE carries commands
    // nobody confirmed, rather than a silent revoked row with live processes and
    // a daemon that can never reconnect to be asked again. `now` is this sweep's
    // provisional value, and only this sweep's own value is cleared on success.
    if (rows.length > 0) {
      this.sqlx(`UPDATE user_devices SET unstopped_at = ? WHERE id = ?`, now, deviceId);
    }
    let unstoppedCommands = 0;
    const tunnel = this._devices.tunnel(deviceId);
    for (const row of rows) {
      // A stored answer already says nothing runs under this request, so it is
      // not an unstopped command however the socket behaves now. Its cleanup is
      // owed, and revocation drops every row below in either case.
      const settled = row.settled;
      if (!tunnel) {
        if (settled === null) unstoppedCommands += 1;
        continue;
      }
      try {
        if (settled === null) {
          const answer = parseDeviceCancelAnswer(row.requestId, await tunnel.rpc(
            DEVICE_CANCEL_METHOD, [row.requestId, DEVICE_CANCEL_PROTOCOL],
          )).cancelled;
          // Durable before the acknowledgement, so an activation that dies here
          // leaves an answer rather than a row that reads as live work.
          this._inflight.settleRevoked(row.requestId, answer);
        }
        try {
          await tunnel.rpc(DEVICE_EXEC_ACK_METHOD, [row.requestId, DEVICE_CANCEL_PROTOCOL]);
        } catch (err) {
          // Kill confirmation is already truthful. This is only local replay
          // cleanup; record it apart so a failed ACK never reads as a process
          // that may still run.
          diagnostics.failure('device.revocation_ack_cleanup_failed', toKinuError({
            doing: 'releasing the cancelled device command supervisor on revocation',
            cause: err,
            otherwise: 'unavailable',
          }), { device: deviceId, request: row.requestId });
        }
      } catch (err) {
        unstoppedCommands += 1;
        diagnostics.failure('device.revocation_cancel_unconfirmed', toKinuError({
          doing: 'confirming device command termination before revocation',
          cause: err,
          otherwise: 'unavailable',
        }), { device: deviceId, request: row.requestId });
      }
    }
    // One sweep per device runs at a time, so this decision is the whole truth
    // about the commands THIS sweep swept. A later revoke of an already-revoked
    // device sweeps nothing, wrote no provisional marker, and therefore may not
    // retract the incident an earlier sweep recorded: its unconfirmed processes
    // can never be asked about again, and only the owner may clear that.
    if (unstoppedCommands > 0) {
      this.sqlx(`UPDATE user_devices SET unstopped_at = ? WHERE id = ?`, now, deviceId);
    } else if (rows.length > 0) {
      this.sqlx(`UPDATE user_devices SET unstopped_at = NULL WHERE id = ?`, deviceId);
    }

    this._inflight.deleteEveryRequestOf(deviceId);
    // A revoked device can never be reached again, so its grants are dead
    // rows the owner's roster still shows as live permissions. Deleted here
    // rather than left: the roster is what the owner audits, and a list of
    // grants on machines that no longer exist is what makes it unreadable.
    this.sqlx(`DELETE FROM device_consent WHERE device_id = ?`, deviceId);
    this._devices.close(deviceId, 'device revoked');
    return { ok: true, unstoppedCommands };
  }

  /**
   * The owner has read the revocation incident. Only that explicit decision, or
   * deleting the device row, may clear it - reconnect cannot revive a revoked
   * device and must never make an unconfirmed stop look confirmed.
   *
   * Refused while the device still has unsettled request rows: the sweep that
   * wrote the warning has not finished deciding, so there is nothing to read
   * yet. Clearing there would let an activation failure retire a warning about a
   * process nobody has confirmed and nobody can ask about again.
   */
  async acknowledgeUnstoppedDevice(caller: UserCaller, deviceId: string): Promise<{ ok: boolean }> {
    await this.requireTier(caller, 'device.manage');
    if (this._inflight.hasRequestsFor(deviceId)) return { ok: false };
    const cleared = this.sqlx<{ id: string }>(
      `UPDATE user_devices SET unstopped_at = NULL
        WHERE id = ? AND revoked_at IS NOT NULL AND unstopped_at IS NOT NULL
        RETURNING id`,
      deviceId,
    );
    return { ok: cleared.length === 1 };
  }

  // ── Releases ─────────────────────────────────────────────────

  async upsertReleaseSource(caller: UserCaller, input: ReleaseSourceInput & { id?: string }): Promise<ReleaseSource> {
    await this.requireTier(caller, 'release');
    return this.releases().upsertSourceBinding(input);
  }

  async createReleaseChange(caller: UserCaller, agentName: string, input: { bindingId: string; userPrompt: string; plan?: string | null }): Promise<ReleaseChange> {
    await this.requireTier(caller, 'release');
    return this.releases().createChange(agentName, input);
  }

  async updateReleaseChange(
    caller: UserCaller,
    changeId: string,
    patch: { plan?: string | null; summary?: string | null; patch?: string | null; previewUrl?: string | null },
  ): Promise<ReleaseChange> {
    await this.requireTier(caller, 'release');
    return this.releases().updateChange(changeId, patch);
  }

  async transitionReleaseChange(caller: UserCaller, changeId: string, to: ReleaseStatus): Promise<ReleaseChange> {
    await this.requireTier(caller, 'release');
    const change = this.releases().transitionChange(changeId, to);
    // A release moving is a control-plane operation, so it lands on the audit
    // dataset beside the rows a reader compares it with rather than on the agent
    // one. The status is the release store's own closed vocabulary; the change id
    // is digested because it identifies one user's work.
    recordReleaseTransition(this.env, {
      actor: this.name,
      operation: 'transition',
      reason: to,
      target: changeId,
      outcome: 'ok',
      code: '',
    });
    return change;
  }

  async recordReleaseCheck(
    caller: UserCaller,
    changeId: string,
    input: { name: string; status: ReleaseCheck['status']; stdout?: string | null; stderr?: string | null; durationMs?: number | null },
  ): Promise<ReleaseCheck> {
    await this.requireTier(caller, 'release');
    return this.releases().recordCheck(changeId, input);
  }

  async requestReleaseApproval(caller: UserCaller, changeId: string, approvalType: ReleaseApproval['approvalType']): Promise<ReleaseApproval> {
    await this.requireTier(caller, 'release');
    return this.releases().requestApproval(changeId, approvalType);
  }

  async decideReleaseApproval(
    caller: UserCaller,
    approvalId: string,
    decision: 'approved' | 'rejected',
    approvedBy: string,
    note?: string | null,
  ): Promise<ReleaseApproval> {
    await this.requireTier(caller, 'release');
    return this.releases().decideApproval(approvalId, decision, approvedBy, note);
  }

  async recordReleaseDeployment(
    caller: UserCaller,
    changeId: string,
    input: { environment: ReleaseDeployment['environment']; workerVersionId?: string | null; deploymentId?: string | null; rollbackTarget?: string | null },
  ): Promise<ReleaseDeployment> {
    await this.requireTier(caller, 'release');
    const deployment = this.releases().recordDeployment(changeId, input);
    recordReleaseTransition(this.env, {
      actor: this.name,
      operation: 'deployment',
      reason: input.environment,
      target: changeId,
      outcome: 'ok',
      code: '',
    });
    return deployment;
  }

  async getReleaseBoard(caller: UserCaller, agentName?: string, limit = 20): Promise<ReleaseBoard> {
    await this.requireTier(caller, 'release');
    return this.releases().board(agentName, limit);
  }

  /** Full ledger view of one change — the execution engine's read surface. */
  async getReleaseDetail(caller: UserCaller, changeId: string): Promise<ReleaseDetail> {
    await this.requireTier(caller, 'release');
    return this.releases().detail(changeId);
  }

  // ── Experience library (cross-workspace transfer) ───────────────────

  private experienceLibrary() {
    this.ensureInit();
    return createExperienceLibrary(this.ctx.storage.sql);
  }

  /**
   * Publish one artifact this workspace has proven. The source workspace is
   * taken from the PROVEN caller, never from the argument — a workspace can
   * only ever publish under its own name, and an owner session (which is not
   * any workspace) cannot publish at all.
   */
  async publishExperience(caller: UserCaller, candidate: PublishableCandidate): Promise<ExperienceEntry> {
    const resolved = await this.requireTier(caller, 'experience.write');
    if (resolved.kind !== 'workspace') {
      throw new Error('Only a workspace can publish experience; it publishes under its own name.');
    }
    return this.experienceLibrary().publish(candidate, resolved.workspace);
  }

  /** Search the owner's library. The calling workspace's own entries are
   *  excluded — re-importing what you already have is noise, not transfer. */
  async searchExperience(
    caller: UserCaller,
    options: { query?: string; kind?: ExperienceKind; limit?: number } = {},
  ): Promise<ExperienceEntry[]> {
    const resolved = await this.requireTier(caller, 'experience.read');
    const searchOptions: typeof options & { excludeWorkspace?: string } = { ...options };
    if (resolved.kind === 'workspace') searchOptions.excludeWorkspace = resolved.workspace;
    return this.experienceLibrary().search(searchOptions);
  }

  async getExperienceEntry(caller: UserCaller, id: string): Promise<ExperienceEntry | null> {
    await this.requireTier(caller, 'experience.read');
    return this.experienceLibrary().get(id);
  }

  // ── Credentials ────────────────────────────────────────────────────

  async listCredentials(caller: UserCaller): Promise<CredentialSummary[]> {
    return this.credentialSummaries(await this.requireTier(caller, 'credentials.model'));
  }

  /** Non-model credentials are cut from a shared workspace's view along with
   *  access to them: the agent must not even learn that the owner holds a
   *  GitHub PAT. Model providers stay listed so the model picker still works. */
  private credentialSummaries(resolved: ResolvedCaller): CredentialSummary[] {
    const attenuated = resolved.kind === 'workspace' && resolved.tier === 'shared';
    return this.sqlx<{ key: string; kind: CredentialSummary['kind']; created_at: number; updated_at: number }>(
      `SELECT key, kind, created_at, updated_at FROM user_credentials ORDER BY key`,
    ).filter((r) => !attenuated || isModelInferenceCredentialKey(r.key))
      .map((r) => ({
        key: r.key,
        kind: r.kind,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
  }

  /** Model-inference credentials survive tainting — the agent must still be
   *  able to think, and provider headers attach inside trusted DO code without
   *  ever entering LLM context. Everything else in the store is owner-level. */
  private requireCredentialAccess(caller: UserCaller, key: string): Promise<ResolvedCaller> {
    return this.requireTier(caller, isModelInferenceCredentialKey(key) ? 'credentials.model' : 'credentials.other');
  }

  async setCredential<CredentialInput>(caller: UserCaller, key: string, credentialJson: CredentialInput): Promise<void> {
    await this.requireTier(caller, 'credentials.other');
    validateCredentialKey(key);
    if (key === CLOUDFLARE_AI_GATEWAY_CRED_KEY) {
      throw new Error(`${CLOUDFLARE_AI_GATEWAY_CRED_KEY} is derived from your Cloudflare login and cannot be stored directly.`);
    }
    const cred = validateCredential(credentialJson);
    if (key === CODEX_CRED_KEY && cred.kind === 'oauth' && !cred.refreshToken) {
      throw new Error('codex.oauth requires an OAuth refresh token.');
    }
    await this.writeCredential(key, cred);
    // Cloudflare login just landed → discover the account's AI Gateways now
    // (single-gateway auto-select lives in listAIGateways), so my-gateway
    // works without a settings visit. listAIGateways never throws.
    if (key === CLOUDFLARE_OAUTH_CRED_KEY) await this.listAIGateways(await ownerCaller(this.env));
  }

  async deleteCredential(caller: UserCaller, key: string): Promise<void> {
    await this.requireTier(caller, 'credentials.other');
    validateCredentialKey(key);
    this.dropCredential(key);
  }

  // ── Credentials at rest ─────────────────────────────────────────────
  // Every read and write of `user_credentials.value` goes through this pair.
  // The value is sealed by credential-envelope.ts, so the two functions below
  // are the only places plaintext secret material exists in this class.

  private _credentialsRewrapped: Promise<void> | null = null;

  private cipher(): Promise<CredentialCipher> {
    return createCredentialCipher(this.env);
  }

  /** What a sealed value is bound to. The Durable Object's own id is in there
   *  so a ciphertext lifted into a different user's store does not open, and
   *  the credential key so it cannot be moved between rows within one. */
  private credentialAad(key: string): string {
    return `${this.ctx.id.toString()}:${key}`;
  }

  /** Internal read of the raw credential. */
  private async readCredential(key: string): Promise<Credential | null> {
    await this.rewrapCredentials();
    const row = this.sqlx<{ value: string }>(`SELECT value FROM user_credentials WHERE key = ?`, key)[0];
    if (!row) return null;
    let plaintext: string;
    try { plaintext = await (await this.cipher()).open(this.credentialAad(key), row.value); }
    catch (err) {
      diagnostics.failure('credential.unreadable', toKinuError({
        doing: 'opening a stored credential',
        cause: err,
        otherwise: 'bad_input',
      }), { credentialKey: key });
      return null;
    }
    // Parsed outside the catch above on purpose: a JSON error message quotes
    // the input it choked on, and that input is the decrypted secret.
    try { return validateCredential(JSON.parse(plaintext)); }
    catch {
      diagnostics.failure(
        'credential.malformed',
        new KinuError('bad_input', 'a stored credential did not decode as JSON'),
        { credentialKey: key },
      );
      return null;
    }
  }

  /** Seal a credential for storage. Asynchronous and writes NOTHING, so that
   *  {@link commitCredential} can be paired with a fence read in one turn. */
  private async sealCredential(key: string, cred: Credential): Promise<string> {
    await this.rewrapCredentials();
    return (await this.cipher()).seal(this.credentialAad(key), JSON.stringify(cred));
  }

  /**
   * Commit a sealed credential and move its revision on. Preserves
   * `created_at` on update, exactly as the original upsert did.
   *
   * SYNCHRONOUS, so `expectRevision` is a real compare-and-swap: nothing can
   * interleave between the revision read and the write. `false` means the store
   * moved under this caller while it was sealing or waiting on a provider, so
   * the value it is holding is the stale one and was not written.
   */
  private commitCredential(input: {
    key: string; kind: Credential['kind']; sealed: string; expectRevision?: number;
  }): boolean {
    if (input.expectRevision !== undefined && this.credentialRevision(input.key) !== input.expectRevision) {
      return false;
    }
    const now = Date.now();
    this.sqlx(
      `INSERT INTO user_credentials (key, kind, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, value = excluded.value, updated_at = excluded.updated_at`,
      input.key, input.kind, input.sealed, now, now,
    );
    this.bumpCredentialRevision(input.key);
    this.bumpCredentialsRevision();
    return true;
  }

  /** Internal write of a credential, sealed under the current key. */
  private async writeCredential(key: string, cred: Credential): Promise<void> {
    this.commitCredential({ key, kind: cred.kind, sealed: await this.sealCredential(key, cred) });
  }

  /** Drop a credential and move its revision on, so a refresh already in the
   *  air cannot land a rotated token over the absence the owner just created. */
  private dropCredential(key: string): void {
    this.sqlx(`DELETE FROM user_credentials WHERE key = ?`, key);
    this.bumpCredentialRevision(key);
    this.bumpCredentialsRevision();
  }

  /** The revision of one credential key — every write of it AND every deletion.
   *  0 for a key this store has never held, so a first write needs no seeding. */
  private credentialRevision(key: string): number {
    const row = v.safeParse(v.object({ revision: v.number() }), this.sqlx(
      `SELECT revision FROM user_credential_revisions WHERE key = ?`, key,
    )[0]);
    return row.success ? row.output.revision : 0;
  }

  private bumpCredentialRevision(key: string): void {
    this.sqlx(
      `INSERT INTO user_credential_revisions (key, revision, updated_at) VALUES (?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at`,
      key, Date.now(),
    );
  }

  /** This account's credential revision: one number, rising with every
   *  mutation of the credential store. Read by a workspace before it uses its
   *  cached provider/model state, so a mutation the fan-out notification failed
   *  to deliver is still noticed — by comparison, at use, with no clock.
   *
   *  `shared` on the same reasoning as `auth_tokens.socket`: the answer is a
   *  number about state the workspace already depends on, it names no secret
   *  and mints nothing, and a shared workspace that could not compare would
   *  keep a stale catalog of exactly the model providers it needs. */
  async getCredentialsRevision(caller: UserCaller): Promise<number> {
    await this.requireTier(caller, 'credentials.model');
    return this.credentialsRevision();
  }

  private credentialsRevision(): number {
    const row = v.safeParse(v.object({ revision: v.number() }), this.sqlx(
      `SELECT revision FROM user_credentials_revision WHERE id = 1`,
    )[0]);
    return row.success ? row.output.revision : 0;
  }

  private bumpCredentialsRevision(): void {
    this.sqlx(
      `INSERT INTO user_credentials_revision (id, revision, updated_at) VALUES (1, 1, ?)
       ON CONFLICT(id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at`,
      Date.now(),
    );
  }

  /**
   * Write a credential this call rotated, unless the owner moved it while the
   * provider was answering.
   *
   * Returns what the caller may act on: its own rotated credential, or
   * `'revoked'` when the store no longer holds a usable one. THAT is the fence
   * these three lines exist for — a rotation reply arriving after a disconnect
   * used to reconnect the account by writing itself back, and one arriving
   * after the owner pasted a replacement used to overwrite it with a token
   * derived from the credential they had just retired.
   */
  private async commitRefreshedCredential(
    key: string, next: OAuthCredential, expectRevision: number,
  ): Promise<OAuthCredential | 'revoked'> {
    const sealed = await this.sealCredential(key, next);
    if (this.commitCredential({ key, kind: next.kind, sealed, expectRevision })) return next;
    diagnostics.event('credential.refresh_superseded', { outcome: 'denied', credentialKey: key });
    // The store is the authority, so the answer comes from it and never from
    // the token this call was carrying.
    const current = await this.readCredential(key);
    return current?.kind === 'oauth' ? current : 'revoked';
  }

  /** Retire a credential its provider rejected outright — unless the owner has
   *  already replaced it, in which case the rejection belongs to a credential
   *  that no longer exists and must not take its successor down. */
  private retireRejectedCredential(key: string, expectRevision: number): void {
    if (this.credentialRevision(key) !== expectRevision) return;
    this.dropCredential(key);
  }

  /**
   * Seal every stored credential under the CURRENT key. Runs once per DO
   * instance, on the first credential access.
   *
   * One mechanism covers two migrations, because they are the same operation:
   * a row written before encryption existed, and a row still sealed under a
   * retired key after a rotation. The marker in `user_schema_meta` is the key
   * id the whole store is known to be sealed under, so the pass is skipped
   * entirely once it matches.
   *
   * A row that cannot be opened is left alone and the pass continues. Failing
   * the pass would take every provider down over one damaged row; leaving it
   * means that ONE credential reports its own failure when it is used, which
   * is the isolation the rest of the provider layer already has.
   */
  private rewrapCredentials(): Promise<void> {
    this._credentialsRewrapped ??= (async () => {
      const cipher = await this.cipher();
      const marker = this.sqlx<{ value: string }>(
        `SELECT value FROM user_schema_meta WHERE key = ?`, UserDO.CREDENTIAL_ENVELOPE_MARKER,
      )[0];
      if (marker?.value === cipher.keyId) return;
      let clean = true;
      for (const row of this.sqlx<{ key: string; value: string }>(`SELECT key, value FROM user_credentials`)) {
        const aad = this.credentialAad(row.key);
        try {
          this.sqlx(
            `UPDATE user_credentials SET value = ? WHERE key = ?`,
            await cipher.seal(aad, await cipher.open(aad, row.value)), row.key,
          );
        } catch (err) {
          clean = false;
          diagnostics.failure('credential.reseal_failed', toKinuError({
            doing: 'resealing a stored credential under the current key',
            cause: err,
            otherwise: 'bad_input',
          }), { credentialKey: row.key });
        }
      }
      for (const row of this.sqlx<{ id: string; headers: string }>(
        `SELECT id, headers FROM user_mcp_servers WHERE headers IS NOT NULL`,
      )) {
        const aad = this.mcpHeadersAad(row.id);
        try {
          this.sqlx(
            `UPDATE user_mcp_servers SET headers = ? WHERE id = ?`,
            await cipher.seal(aad, await cipher.open(aad, row.headers)), row.id,
          );
        } catch (err) {
          clean = false;
          diagnostics.failure('mcp.stored_headers_reseal_failed', toKinuError({
            doing: "resealing an MCP server's stored headers under the current key",
            cause: err,
            otherwise: 'bad_input',
          }), { serverId: row.id });
        }
      }
      // Egress secrets are sealed with the same cipher, so they rotate in the
      // same pass. Omitting them would let the marker claim the whole store is
      // current while these rows still needed a key the next rotation drops.
      if (!await rewrapEgressSecrets(this.egressVaultDeps(cipher))) clean = false;
      // The marker claims the WHOLE store is sealed under this key, and the
      // documented rotation drops the retired key on the strength of that
      // claim. A pass that left a row behind must not make it.
      if (!clean) return;
      this.sqlx(
        `INSERT INTO user_schema_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        UserDO.CREDENTIAL_ENVELOPE_MARKER, cipher.keyId,
      );
    })();
    return this._credentialsRewrapped;
  }

  private static readonly CREDENTIAL_ENVELOPE_MARKER = 'credential_envelope_key_id';

  /** MCP `headers` hold bearer tokens for self-hosted servers — the same class
   *  of secret as `user_credentials`, so they are sealed the same way. AAD is
   *  the server id, so a header blob cannot be replayed against a different
   *  server. Null passes through: most servers have no custom headers. */
  private mcpHeadersAad(serverId: string): string {
    return `${this.ctx.id.toString()}:mcp:${serverId}`;
  }

  private async sealMcpHeaders(serverId: string, headers: string | null): Promise<string | null> {
    await this.rewrapCredentials();
    return headers === null ? null : (await this.cipher()).seal(this.mcpHeadersAad(serverId), headers);
  }

  private async openMcpHeaders(serverId: string, stored: string | null): Promise<string | null> {
    await this.rewrapCredentials();
    if (stored === null) return null;
    try { return await (await this.cipher()).open(this.mcpHeadersAad(serverId), stored); }
    catch (err) {
      diagnostics.failure('mcp.stored_headers_unreadable', toKinuError({
        doing: "opening an MCP server's stored headers",
        cause: err,
        otherwise: 'bad_input',
      }), { serverId });
      return null;
    }
  }

  // ── Egress secret vault ─────────────────────────────────────────────
  // The owner's per-host secrets, spent by an agent's container without ever
  // entering it. Same DO, same cipher, same key as `user_credentials`; see
  // user/egress-vault.ts for why the row shape is its own table.

  /** Shared wiring for every vault call: the DO's own storage, the deployment
   *  cipher, and an AAD naming this row in this DO so a ciphertext cannot be
   *  replayed into another binding or another user's store. */
  private egressVaultDeps(cipher: CredentialCipher): EgressVaultDeps {
    return {
      sql: this.ctx.storage.sql,
      cipher,
      aad: (id) => `${this.ctx.id.toString()}:egress:${id}`,
    };
  }

  /** Every binding, with no secret material — this is the read-back surface,
   *  and there is deliberately no other. A stored secret is never returned to
   *  the owner, the UI or an agent. */
  async listEgressSecrets(caller: UserCaller): Promise<EgressSecretSummary[]> {
    await this.requireTier(caller, 'egress_secrets.manage');
    return listEgressSecrets(this.ctx.storage.sql);
  }

  /**
   * Add or rotate a secret, returning the binding the container will use.
   *
   * The returned `placeholder` is the ONLY thing that may be written into the
   * container. Rotating an existing id keeps its placeholder, so a rotation
   * needs no change inside the container.
   */
  async putEgressSecret(caller: UserCaller, input: PutEgressSecretInput): Promise<EgressSecretBinding> {
    await this.requireTier(caller, 'egress_secrets.manage');
    await this.rewrapCredentials();
    return putEgressSecret(this.egressVaultDeps(await this.cipher()), input);
  }

  /** Revoke a secret. The next intercepted request carrying its placeholder is
   *  refused rather than forwarded with a dummy. */
  async revokeEgressSecret(caller: UserCaller, id: string): Promise<{ revoked: boolean }> {
    await this.requireTier(caller, 'egress_secrets.manage');
    return { revoked: revokeEgressSecret(this.ctx.storage.sql, id) };
  }

  /**
   * Resolve one intercepted request: which placeholders in it may become real
   * secrets, for this destination.
   *
   * `active` is the caller's grant-filtered view of the vault, so CONSENT was
   * decided by the approval gate before the request was made; this decides
   * DESTINATION, on every request, and opens only what it authorises. Gated at
   * `egress_secrets.inject` — a workspace-scoped caller must hold it, and the
   * outbound handler presents the owner capability.
   */
  async resolveEgressInjection(
    caller: UserCaller,
    facts: EgressRequestFacts,
    active: readonly EgressSecretBinding[],
  ): Promise<EgressInjectionResult> {
    await this.requireTier(caller, 'egress_secrets.inject');
    await this.rewrapCredentials();
    return resolveEgressInjection(this.egressVaultDeps(await this.cipher()), facts, active);
  }

  /** Expose the baseURL for openai-compat credentials. The orchestrator's
   *  provider deps need this to point the SDK at the right endpoint —
   *  baseURL isn't a secret on its own and won't show up in
   *  listCredentials(). */
  async getCredentialBaseURL(caller: UserCaller, key: string): Promise<string | null> {
    await this.requireCredentialAccess(caller, key);
    validateCredentialKey(key);
    // The my-gateway view rides the same account-scoped /ai/v1 endpoint as
    // Workers AI — only the cf-aig-gateway-id header differs.
    const storedKey = key === CLOUDFLARE_AI_GATEWAY_CRED_KEY ? CLOUDFLARE_OAUTH_CRED_KEY : key;
    const cred = await this.readCredential(storedKey);
    if (cred?.kind === 'openai-compat') return cred.baseURL;
    if (storedKey === CLOUDFLARE_OAUTH_CRED_KEY && cred?.kind === 'oauth') {
      if (!isCloudflareCredentialUsable(cred)) return null;
      const accountId = accountIdFromCloudflareCredential(cred);
      return accountId ? cloudflareWorkersAIBaseURL(accountId) : null;
    }
    return null;
  }

  /** Returns headers ready to inject into a fetch. Handles Codex OAuth
   *  refresh atomically (DO event loop serializes concurrent calls). */
  async getAuthHeaders(caller: UserCaller, key: string, opts?: { forceRefresh?: boolean }): Promise<Record<string, string> | null> {
    await this.requireCredentialAccess(caller, key);
    validateCredentialKey(key);
    // `cloudflare.ai-gateway` is a DERIVED view of the Cloudflare login: same
    // bearer + refresh path, but cf-aig-gateway-id names the user's own
    // selected gateway (null until one is selected — that gates my-gateway).
    const storedKey = key === CLOUDFLARE_AI_GATEWAY_CRED_KEY ? CLOUDFLARE_OAUTH_CRED_KEY : key;
    const stored = await this.readCredential(storedKey);
    if (!stored) return null;
    // Explicitly-typed non-null so the conditional refresh-reassignment below
    // doesn't re-widen back to `Credential | null`.
    let cred: Credential = stored;

    // Codex OAuth — auto-refresh if expiring or forced.
    if (storedKey === CODEX_CRED_KEY && cred.kind === 'oauth') {
      const refreshToken = cred.refreshToken;
      if (!refreshToken) return null;
      const needRefresh = opts?.forceRefresh || accessTokenExpiring(cred.accessToken);
      if (needRefresh) {
        const refreshed = await this.refreshCodexInternal({ ...cred, refreshToken });
        if (refreshed === 'revoked') return null;
        if (refreshed) cred = refreshed;
        // If refresh failed we keep using the old (possibly-expired) creds —
        // the caller may still succeed, and if not it gets 401 and a clear
        // signal that re-auth is needed.
      }
    }
    if (storedKey === CLOUDFLARE_OAUTH_CRED_KEY && cred.kind === 'oauth') {
      const needRefresh = opts?.forceRefresh || isCloudflareCredentialExpiring(cred);
      if (needRefresh) {
        if (!cred.refreshToken) return null;
        const refreshed = await this.refreshCloudflareInternal(cred);
        if (refreshed === 'revoked') return null;
        if (refreshed) cred = refreshed;
      }
    }

    // A credential whose stored shape does not match its key is a defect, not
    // an absent credential: it must not reach the caller as "not connected".
    const headers = credentialToHeaders(storedKey, cred);
    if (key === CLOUDFLARE_AI_GATEWAY_CRED_KEY) {
      const gatewayId = this.selectedAIGatewayId();
      if (!gatewayId) return null;
      headers['cf-aig-gateway-id'] = gatewayId;
    } else if (key === CLOUDFLARE_OAUTH_CRED_KEY) {
      // Workers AI traffic routes through the user's selected gateway when
      // they picked one (their caching/logging/limits apply), otherwise the
      // platform's configured default.
      headers['cf-aig-gateway-id'] = this.selectedAIGatewayId() ?? cloudflareAIGatewayId(this.env);
    }
    return headers;
  }

  // ── Cloudflare AI Gateway (the user's own gateway) ───────────────────

  private static readonly AI_GATEWAY_CONFIG_KEY = 'cloudflare_ai_gateway';

  private selectedAIGatewayId(): string | null {
    const row = this.sqlx<{ value: string }>(
      `SELECT value FROM user_config WHERE key = ?`, UserDO.AI_GATEWAY_CONFIG_KEY,
    )[0];
    return row && isCloudflareAIGatewayId(row.value) ? row.value : null;
  }

  /** Fresh (refreshed-if-expiring) access token + account id for management
   *  API calls. Null when no usable Cloudflare credential is stored. */
  private async cloudflareAPICredential(): Promise<{ accessToken: string; accountId: string } | null> {
    const stored = await this.readCredential(CLOUDFLARE_OAUTH_CRED_KEY);
    if (stored?.kind !== 'oauth' || !isCloudflareCredentialUsable(stored)) return null;
    let cred = stored;
    if (isCloudflareCredentialExpiring(cred)) {
      const refreshed = await this.refreshCloudflareInternal(cred);
      if (refreshed === 'revoked' || !refreshed) return null;
      cred = refreshed;
    }
    const accountId = accountIdFromCloudflareCredential(cred);
    return accountId ? { accessToken: cred.accessToken, accountId } : null;
  }

  /** The user's AI Gateways + current selection. Zero-friction rule: exactly
   *  one gateway and nothing selected → select it (persisted). Never throws —
   *  discovery failures surface in `error` so login can call this inline. */
  async listAIGateways(caller: UserCaller): Promise<{
    connected: boolean;
    selectedId: string | null;
    gateways: CloudflareAIGatewaySummary[];
    error: string | null;
  }> {
    await this.requireTier(caller, 'ai_gateway.admin');
    let selectedId = this.selectedAIGatewayId();
    const api = await this.cloudflareAPICredential();
    if (!api) return { connected: false, selectedId, gateways: [], error: null };
    try {
      const gateways = await fetchCloudflareAIGateways(api.accountId, api.accessToken);
      if (!selectedId && gateways.length === 1) {
        await this.selectAIGateway(await ownerCaller(this.env), gateways[0].id);
        selectedId = gateways[0].id;
      }
      return { connected: true, selectedId, gateways, error: null };
    } catch (err) {
      return { connected: true, selectedId, gateways: [], error: renderThrownChain({ cause: err }) };
    }
  }

  async selectAIGateway(caller: UserCaller, gatewayId: string | null): Promise<void> {
    await this.requireTier(caller, 'ai_gateway.admin');
    if (gatewayId === null) {
      this.sqlx(`DELETE FROM user_config WHERE key = ?`, UserDO.AI_GATEWAY_CONFIG_KEY);
      return;
    }
    if (!isCloudflareAIGatewayId(gatewayId)) throw new Error('Invalid AI Gateway id.');
    await this.setConfig(await ownerCaller(this.env), UserDO.AI_GATEWAY_CONFIG_KEY, gatewayId);
  }

  // ── Cloudflare account (which account serves this user's Workers AI) ──

  /** The accounts this Cloudflare login can see, plus the one currently
   *  serving Workers AI. Reads the stored credential only — no API call, so
   *  this cannot fail for a reason the user did not cause. */
  async listCloudflareAccounts(caller: UserCaller): Promise<{
    connected: boolean;
    selectedId: string | null;
    accounts: CloudflareAccount[];
  }> {
    await this.requireTier(caller, 'ai_gateway.admin');
    const cred = await this.readCredential(CLOUDFLARE_OAUTH_CRED_KEY);
    if (cred?.kind !== 'oauth') return { connected: false, selectedId: null, accounts: [] };
    return {
      connected: true,
      selectedId: accountIdFromCloudflareCredential(cred),
      accounts: cloudflareAccountsFromCredential(cred),
    };
  }

  /** Point Workers AI at another of this login's accounts — how a user whose
   *  entitlement lives outside their first account reaches it. The AI Gateway
   *  selection belongs to the old account, so it is dropped and rediscovered. */
  async selectCloudflareAccount(caller: UserCaller, accountId: string): Promise<void> {
    await this.requireTier(caller, 'ai_gateway.admin');
    const cred = await this.readCredential(CLOUDFLARE_OAUTH_CRED_KEY);
    if (cred?.kind !== 'oauth') throw new Error('Cloudflare is not connected.');
    await this.writeCredential(CLOUDFLARE_OAUTH_CRED_KEY, withCloudflareAccount(cred, accountId));
    const owner = await ownerCaller(this.env);
    await this.selectAIGateway(owner, null);
    await this.listAIGateways(owner);
  }

  /** Returns the rotated credential, `'revoked'` when Cloudflare rejected
   *  the refresh token outright (`invalid_grant`) or the owner retired the
   *  credential while this refresh was in the air, or null on transient
   *  failure (the current credential stays in place). On `invalid_grant`
   *  the dead refresh token is stripped from storage so the credential
   *  stops counting as usable and the connect CTA resurfaces, instead of
   *  advertising a provider whose every call would 401.
   *
   *  The revision is read BEFORE the network call and every write below is
   *  fenced on it, because this method's only awaits are the ones during which
   *  the owner can disconnect or reconnect. */
  private async refreshCloudflareInternal(current: OAuthCredential): Promise<OAuthCredential | 'revoked' | null> {
    const revision = this.credentialRevision(CLOUDFLARE_OAUTH_CRED_KEY);
    try {
      const next = await refreshCloudflareCredential(this.env, current);
      return await this.commitRefreshedCredential(CLOUDFLARE_OAUTH_CRED_KEY, next, revision);
    } catch (err) {
      if (err instanceof CloudflareOAuthTokenError && err.oauthError === 'invalid_grant') {
        diagnostics.failure('credential.cloudflare_refresh_revoked', toKinuError({
          doing: 'refreshing the Cloudflare credential',
          cause: err,
          otherwise: 'denied',
        }));
        const { refreshToken: _dead, ...rest } = current;
        // Stripping the dead token is itself a write of the credential this
        // call read, so it carries the same fence: a login the owner completed
        // during the round trip must not be demoted by its predecessor's
        // rejection.
        await this.commitRefreshedCredential(CLOUDFLARE_OAUTH_CRED_KEY, rest, revision);
        return 'revoked';
      }
      diagnostics.failure('credential.cloudflare_refresh_failed', toKinuError({
        doing: 'refreshing the Cloudflare credential',
        cause: err,
        otherwise: 'unavailable',
      }));
      return null;
    }
  }

  /** Returns the rotated credential, `'revoked'` when OpenAI rejected the
   *  refresh token outright (`invalid_grant`) or the owner disconnected while
   *  this refresh was in the air, or null on transient failure (the current
   *  credential stays in place). On `invalid_grant` the whole row is deleted —
   *  nothing but model calls reads it, unlike the Cloudflare credential whose
   *  token still serves the management APIs — so the credential stops counting
   *  as connected and the connect CTA resurfaces, instead of advertising a
   *  provider whose every call would 401. */
  private async refreshCodexInternal(current: OAuthCredential & { refreshToken: string }): Promise<OAuthCredential | 'revoked' | null> {
    const revision = this.credentialRevision(CODEX_CRED_KEY);
    const client = createCodexOAuthClient();
    try {
      const fresh = await client.refresh(current.refreshToken);
      const next: OAuthCredential = {
        kind: 'oauth',
        accessToken: fresh.accessToken,
        refreshToken: fresh.refreshToken,
        expiresAt: fresh.expiresAt,
        metadata: current.metadata,
      };
      return await this.commitRefreshedCredential(CODEX_CRED_KEY, next, revision);
    } catch (err) {
      if (err instanceof CodexOAuthTokenError && err.oauthError === 'invalid_grant') {
        diagnostics.failure('credential.codex_refresh_revoked', toKinuError({
          doing: 'refreshing the Codex credential',
          cause: err,
          otherwise: 'denied',
        }));
        // Fenced like every other write here: a sign-in the owner completed
        // during the round trip is not deleted by the rejection of the
        // credential it replaced.
        this.retireRejectedCredential(CODEX_CRED_KEY, revision);
        return 'revoked';
      }
      diagnostics.failure('credential.codex_refresh_failed', toKinuError({
        doing: 'refreshing the Codex credential',
        cause: err,
        otherwise: 'unavailable',
      }));
      return null;
    }
  }

  // ── Codex device flow ──────────────────────────────────────────────
  //
  // ONE ROW, A RISING GENERATION, AND A SETTLEMENT. Every call here waits on
  // OpenAI, and this object accepts other calls while it waits: a second
  // `start` supersedes the first, a `disconnect` closes whatever is open, and
  // both used to be invisible to a poll that was already in flight — which then
  // wrote its tokens over the attempt the owner was actually approving, or
  // reconnected an account that had just been disconnected. The generation
  // names the attempt a poll belongs to and `settled_at` says whether it is
  // still the owner's live intent, so a superseded reply has something to fail
  // against instead of a row that merely happens to be there.

  async startCodexDeviceFlow(caller: UserCaller): Promise<DeviceCodeStart> {
    await this.requireTier(caller, 'codex_auth');
    const client = createCodexOAuthClient();
    const result = await client.startDeviceFlow();
    // The generation rises in the write itself rather than from a value read
    // before it, so two starts that raced cannot land on the same number.
    this.sqlx(
      `INSERT INTO codex_device_flow
         (id, device_auth_id, user_code, poll_interval, portal_url, started_at, generation, settled_at)
       VALUES (1, ?, ?, ?, ?, ?, 1, NULL)
       ON CONFLICT(id) DO UPDATE SET
         device_auth_id = excluded.device_auth_id,
         user_code      = excluded.user_code,
         poll_interval  = excluded.poll_interval,
         portal_url     = excluded.portal_url,
         started_at     = excluded.started_at,
         generation     = generation + 1,
         settled_at     = NULL`,
      result.deviceAuthId, result.userCode, result.pollIntervalSec, result.portalURL, Date.now(),
    );
    return result;
  }

  async pollCodexDeviceFlow(caller: UserCaller): Promise<{ connected: boolean; accountId?: string; error?: string }> {
    await this.requireTier(caller, 'codex_auth');
    const row = this.sqlx<{ device_auth_id: string; user_code: string; generation: number }>(
      `SELECT device_auth_id, user_code, generation FROM codex_device_flow
       WHERE id = 1 AND settled_at IS NULL`,
    )[0];
    if (!row) return { connected: false, error: 'No device flow in progress — call startCodexDeviceFlow first.' };
    // Both fences are read here, BEFORE the provider wait that is the whole
    // reason they exist.
    const generation = row.generation;
    const revision = this.credentialRevision(CODEX_CRED_KEY);

    const client = createCodexOAuthClient();
    try {
      const tokens = await client.pollDeviceFlow(row.device_auth_id, row.user_code);
      if (!tokens) return { connected: false }; // still pending
      const accountId = decodeCodexAccountId(tokens.accessToken);
      const cred = tokensToCredential(tokens, accountId ? { accountId } : undefined);
      const sealed = await this.sealCredential(CODEX_CRED_KEY, cred);
      if (!this.commitCodexDeviceFlow({ generation, revision, kind: cred.kind, sealed })) {
        diagnostics.event('credential.codex_device_flow_superseded', { outcome: 'denied' });
        return {
          connected: false,
          error: 'That Codex sign-in was superseded before it completed — start the connection again.',
        };
      }
      return { connected: true, accountId: accountId ?? undefined };
    } catch (err) {
      return { connected: false, error: renderThrownChain({ cause: err }) };
    }
  }

  /**
   * Commit an approved device-code sign-in: the credential and the flow's
   * settlement, together.
   *
   * SYNCHRONOUS, and both fences are checked before either write, so a poll
   * either lands whole against the attempt it belongs to or lands not at all.
   * Splitting the two would leave the case each fence exists to refuse: a flow
   * settled without its credential, or a credential written into an account
   * that had already disconnected.
   */
  private commitCodexDeviceFlow(input: {
    generation: number; revision: number; kind: Credential['kind']; sealed: string;
  }): boolean {
    const open = this.sqlx(
      `SELECT 1 AS x FROM codex_device_flow
       WHERE id = 1 AND generation = ? AND settled_at IS NULL`,
      input.generation,
    ).length > 0;
    if (!open) return false;
    if (!this.commitCredential({
      key: CODEX_CRED_KEY, kind: input.kind, sealed: input.sealed, expectRevision: input.revision,
    })) return false;
    this.sqlx(`UPDATE codex_device_flow SET settled_at = ? WHERE id = 1`, Date.now());
    return true;
  }

  async disconnectCodex(caller: UserCaller): Promise<void> {
    await this.requireTier(caller, 'codex_auth');
    this.dropCredential(CODEX_CRED_KEY);
    // Settled, not deleted: the generation has to keep rising, and a poll that
    // is already waiting on OpenAI has to find this attempt closed rather than
    // find no row and read that as nothing to fence against.
    this.sqlx(`UPDATE codex_device_flow SET settled_at = ? WHERE id = 1 AND settled_at IS NULL`, Date.now());
  }

  async getCodexStatus(caller: UserCaller): Promise<CodexStatus> {
    await this.requireTier(caller, 'codex_auth');
    const cred = await this.readCredential(CODEX_CRED_KEY);
    // Only an OPEN attempt is a flow the owner is in the middle of. A settled
    // row is the record that keeps the generation rising, not a prompt to go
    // back to a portal page that has already been used.
    const flow = this.sqlx<{ user_code: string; portal_url: string; poll_interval: number }>(
      `SELECT user_code, portal_url, poll_interval FROM codex_device_flow
       WHERE id = 1 AND settled_at IS NULL`,
    )[0];
    if (cred?.kind === 'oauth') {
      return {
        connected: true,
        accountId: decodeCodexAccountId(cred.accessToken),
        expiresAt: cred.expiresAt ?? null,
        startedFlow: flow
          ? { userCode: flow.user_code, portalURL: flow.portal_url, pollIntervalSec: flow.poll_interval }
          : null,
      };
    }
    return {
      connected: false,
      accountId: null,
      expiresAt: null,
      startedFlow: flow
        ? { userCode: flow.user_code, portalURL: flow.portal_url, pollIntervalSec: flow.poll_interval }
        : null,
    };
  }

  // ── User-level config (defaults) ───────────────────────────────────

  async getConfig(caller: UserCaller, key: string): Promise<string | null> {
    await this.requireTier(caller, 'config');
    if (key === PROFILE_CATALOG_CONFIG_KEY) {
      throw new Error('profile_catalog has a dedicated typed CAS route.');
    }
    const row = this.sqlx<{ value: string }>(`SELECT value FROM user_config WHERE key = ?`, key)[0];
    return row?.value ?? null;
  }

  async setConfig(caller: UserCaller, key: string, value: string): Promise<void> {
    await this.requireTier(caller, 'config');
    if (key === PROFILE_CATALOG_CONFIG_KEY) {
      throw new Error('profile_catalog has a dedicated typed CAS route.');
    }
    this.sqlx(
      `INSERT INTO user_config (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key, value, Date.now(),
    );
  }

  async listConfig(caller: UserCaller): Promise<Record<string, string>> {
    await this.requireTier(caller, 'config');
    const rows = this.sqlx<{ key: string; value: string }>(
      `SELECT key, value FROM user_config WHERE key <> ?`, PROFILE_CATALOG_CONFIG_KEY,
    );
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  }

  // ── Profile catalog (the account authority over roles + tiers) ─────

  /**
   * The owner's profile-catalog read. Owner-session only: the account's
   * role/tier configuration IS authority, so unlike tier-gated capabilities
   * even a `full`-tier workspace is refused here — until the agent runtime
   * integration adds its narrow read surface, workspace capability has no
   * reach into the catalog plane.
   */
  private async requireOwnerSession(caller: UserCaller): Promise<void> {
    const resolved = await this.requireTier(caller, 'config');
    if (resolved.kind !== 'owner_session') {
      throw new CapabilityDeniedError(
        'The profile catalog is owner-only. Workspaces cannot read or write the account\'s roles and tiers.',
      );
    }
  }

  /** Parse the catalog value at its storage boundary. Corruption is an account
   *  configuration error, not permission to substitute different authority. */
  private parseStoredProfileCatalog(value: string): ProfileCatalog {
    let json: JsonValue;
    try {
      json = decodeJsonValue({ value: JSON.parse(value) });
    } catch (error) {
      throw new Error(
        'The stored account profile catalog cannot be decoded as JSON.',
        { cause: error },
      );
    }
    try {
      return validateProfileCatalog(json);
    } catch (error) {
      throw new Error(
        'The stored account profile catalog violates the profile catalog contract.',
        { cause: error },
      );
    }
  }

  /** The envelope for a version + catalog pair under this account's authority. */
  private profileCatalogEnvelope(version: number, catalog: ProfileCatalog): ProfileCatalogEnvelope {
    return {
      authority: { kind: 'account', accountId: this.ctx.id.name ?? this.ctx.id.toString() },
      version,
      digest: profileCatalogDigest(catalog),
      catalog,
    };
  }

  /** Current CAS state. A missing row starts at 0. Stored state is parsed
   *  before use, so malformed configuration fails rather than changing roles. */
  private readProfileCatalogState(): ProfileCatalogState {
    const rawRow = this.sqlx(
      `SELECT value, version FROM user_config WHERE key = ?`, PROFILE_CATALOG_CONFIG_KEY,
    )[0];
    if (!rawRow) return { version: 0, catalog: BUILTIN_PROFILE_CATALOG };

    let row: StoredProfileCatalogRow;
    try {
      row = v.parse(StoredProfileCatalogRowSchema, rawRow);
    } catch (error) {
      throw new Error('The stored account profile catalog state is malformed.', { cause: error });
    }
    return { version: row.version, catalog: this.parseStoredProfileCatalog(row.value) };
  }

  async getProfileCatalog(caller: UserCaller): Promise<ProfileCatalogEnvelope> {
    await this.requireOwnerSession(caller);
    const current = this.readProfileCatalogState();
    return this.profileCatalogEnvelope(current.version, current.catalog);
  }

  /** Profile authority exposed to the workspace that resolves the next turn.
   * Shared workspaces may read it, but only an owner session may mutate it. */
  async getWorkspaceProfileCatalog(caller: UserCaller): Promise<ProfileCatalogEnvelope> {
    await this.requireTier(caller, 'profile.resolve');
    const current = this.readProfileCatalogState();
    return this.profileCatalogEnvelope(current.version, current.catalog);
  }

  /**
   * Compare-and-swap write of the account catalog: the caller names the
   * version it read, and a mismatch refuses with the current state rather
   * than overwriting a concurrent change. Validation runs before any write;
   * the read-check-write itself contains no await, so within this DO nothing
   * can interleave and every accepted write increments the version by one.
   */
  async putProfileCatalog(caller: UserCaller, catalog: JsonValue, expectedVersion: number): Promise<ProfileCatalogWriteResult> {
    await this.requireOwnerSession(caller);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      return { ok: false, kind: 'malformed', reason: 'expectedVersion must be a non-negative integer.' };
    }
    let parsed: ProfileCatalog;
    try {
      parsed = validateProfileCatalog(catalog);
    } catch (cause) {
      // The whole chain, not the outermost frame. This reason is the only thing
      // an owner is shown about a catalog the account refused, and the frame
      // that names the offending path can be one `cause` below the wrapper —
      // which is exactly the loss `renderThrownChain` exists to stop.
      return { ok: false, kind: 'malformed', reason: renderThrownChain({ cause }) };
    }
    // No await from here to the write: DO input gates make the CAS atomic.
    const current = this.readProfileCatalogState();
    if (current.version !== expectedVersion) {
      return {
        ok: false,
        kind: 'conflict',
        currentVersion: current.version,
        currentDigest: profileCatalogDigest(current.catalog),
      };
    }
    const nextVersion = current.version + 1;
    this.sqlx(
      `INSERT INTO user_config (key, value, updated_at, version) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, version = excluded.version`,
      PROFILE_CATALOG_CONFIG_KEY, JSON.stringify(parsed), Date.now(), nextVersion,
    );
    return { ok: true, envelope: this.profileCatalogEnvelope(nextVersion, parsed) };
  }

  // ── MCP servers ────────────────────────────────────────────────────

  /** Lazy MCPClientManager construction. The callback URL is built per-add
   *  (it depends on the request origin) so we don't bake it in here. */
  private userMcp(): MCPClientManager {
    if (this._userMcp) return this._userMcp;
    this.ensureInit();
    this._userMcp = new MCPClientManager(USER_MCP_CLIENT_NAME, '0.1.0', {
      storage: this.ctx.storage,
      // Override so EVERY server (regardless of when added) uses the same
      // per-user callback URL pattern. The SDK calls this for new connect()s
      // and for restoreConnectionsFromStorage(). The stored callback_url is
      // the source of truth for which path the IdP is told to redirect to,
      // so we pass it through verbatim.
      createAuthProvider: (callbackUrl: string): AgentMcpOAuthProvider =>
        new DurableObjectOAuthClientProvider(
          this.ctx.storage,
          USER_MCP_CLIENT_NAME,
          callbackUrl,
        ),
    });
    return this._userMcp;
  }

  /**
   * THE ONE HYDRATION AUTHORITY for this user's MCP plane.
   *
   * `user_mcp_servers` is the truth. The SDK's `cf_agents_mcp_servers` rows and
   * its live `mcpConnections` are derived from it, and every read path comes
   * through here so there is one place that says what "hydrated" means. Three
   * steps, and the ORDER is the substance:
   *
   *  1. An SDK row with no config row is removed. `userMcp_add` rolls back both
   *     sides, but a rollback that itself throws and a `removeServer` that failed
   *     during a delete both leave an SDK row behind — and that row keeps
   *     reconnecting, keeps spending the user's credential and keeps appearing in
   *     `listServers()` with nothing able to delete it. Two writable truths.
   *  2. Every row holding a sealed credential is registered by US, carrying the
   *     credential as a `fetch` closure rather than as data (see
   *     `mcpCredentialTransport`). `registerServer` builds the connection
   *     WITHOUT connecting and leaves it in CONNECTING, and
   *     `restoreConnectionsFromStorage` skips a connection already in that
   *     state (`agents/dist/client-zqKcsyFa.js:1541-1549`), so the SDK never
   *     gets to connect a credentialed server from its own persisted options.
   *     That is what closes the cold-start window: no unauthenticated first
   *     request, and no reason for a credential to be persisted at all. The
   *     same call rewrites `server_options`, which is how a row written by the
   *     old plaintext path is scrubbed.
   *  3. The SDK restores everything else — OAuth continuations, retry policy,
   *     resumed sessions — and then the connections registered in step 2 are
   *     established.
   *
   * Idempotent. A connection that already carries the closure is left alone, so
   * a warm activation pays one `listServers()` scan.
   */
  private async hydrateUserMcp(): Promise<void> {
    if (this._hydratingUserMcp) return this._hydratingUserMcp;
    const hydration = this.hydrateUserMcpOnce();
    this._hydratingUserMcp = hydration;
    try {
      await hydration;
    } finally {
      if (this._hydratingUserMcp === hydration) this._hydratingUserMcp = null;
    }
  }

  /** One complete derived-plane reconciliation. Called only through
   *  {@link hydrateUserMcp}, which coalesces concurrent callers. */
  private async hydrateUserMcpOnce(): Promise<void> {
    const mgr = this.userMcp();
    const rows = this.sqlx<McpHydrationRow>(
      `SELECT id, name, server_url, transport, headers FROM user_mcp_servers`,
    );
    const configured = new Set(rows.map((row) => row.id));
    for (const stored of mgr.listServers()) {
      if (configured.has(stored.id)) continue;
      try { await mgr.removeServer(stored.id); }
      catch (err) {
        diagnostics.failure('mcp.orphan_server_removal_failed', toKinuError({
          doing: 'removing an SDK MCP server row that no config row owns',
          cause: err,
          otherwise: 'unavailable',
        }), { serverId: stored.id });
        throw err;
      }
    }

    const registered: string[] = [];
    for (const row of rows) {
      if (row.headers === null) continue;
      const live = mgr.mcpConnections[row.id]?.options.transport;
      if (live && 'fetch' in live && live.fetch) continue;
      await this.registerCredentialedMcpServer(row);
      registered.push(row.id);
    }

    await mgr.restoreConnectionsFromStorage(USER_MCP_CLIENT_NAME);
    for (const id of registered) await mgr.establishConnection(id);
  }

  /** Register one credentialed server with the credential as a closure.
   *
   *  A live connection is torn down FIRST. `createConnection` returns an
   *  existing connection object untouched (`client-zqKcsyFa.js:1719-1720`), so
   *  registering over one would rewrite the storage row and leave the wire
   *  running on the old transport — the credential seam would silently not be
   *  installed. Only the credential-acquiring transition reaches that branch; a
   *  cold activation has no connection to close.
   *
   *  Any pending OAuth continuation on the SDK's row (callback URL, client id,
   *  the authorize URL a user has not visited yet) is read before the teardown
   *  and carried across, because this registration REPLACES that row. */
  private async registerCredentialedMcpServer(row: McpHydrationRow): Promise<void> {
    const mgr = this.userMcp();
    const stored = mgr.listServers().find((server) => server.id === row.id);
    const callbackUrl = stored?.callback_url ?? '';
    if (mgr.mcpConnections[row.id]) {
      try { await mgr.removeServer(row.id); }
      catch (err) {
        diagnostics.failure('mcp.credential_seam_teardown_failed', toKinuError({
          doing: 'closing an MCP connection before installing its credential seam',
          cause: err,
          otherwise: 'unavailable',
        }), { serverId: row.id });
        throw err;
      }
    }
    const transport: NonNullable<Parameters<MCPClientManager['registerServer']>[1]['transport']> = {
      ...mcpCredentialTransport(row.server_url, () => this.openMcpHeaderMap(row.id)),
      type: row.transport,
    };
    if (callbackUrl) {
      const authProvider = new DurableObjectOAuthClientProvider(
        this.ctx.storage, USER_MCP_CLIENT_NAME, callbackUrl,
      );
      authProvider.serverId = row.id;
      if (stored?.client_id) authProvider.clientId = stored.client_id;
      transport.authProvider = authProvider;
    }
    const options: Parameters<MCPClientManager['registerServer']>[1] = {
      url: row.server_url, name: row.name, callbackUrl, transport,
    };
    if (stored?.client_id) options.clientId = stored.client_id;
    if (stored?.auth_url) options.authUrl = stored.auth_url;
    await mgr.registerServer(row.id, options);
  }

  /** This server's current custom headers, opened for ONE request.
   *
   *  Read from SQL on every call rather than captured: a rotated header is then
   *  spent by the next request with no reconnect, and no decrypted copy is held
   *  by the closure, the connection or the SDK. The closure captures the server
   *  id and its origin — nothing else. */
  private async openMcpHeaderMap(serverId: string): Promise<Record<string, string> | null> {
    const row = this.sqlx<{ headers: string | null }>(
      `SELECT headers FROM user_mcp_servers WHERE id = ?`, serverId,
    )[0];
    if (!row) return null;
    return parseMcpHeaders(await this.openMcpHeaders(serverId, row.headers));
  }

  /** Idempotent boot warmup. Called by the routes layer on first hit per
   *  process so MCP connections can re-establish in parallel with the user's
   *  first orchestrator turn, not on its critical path. Fire-and-forget.
   *
   *  Runs even with no configured server, and that is deliberate: the SDK's own
   *  rows are what reconciliation removes, and "the user deleted their last
   *  server while its removal failed" is exactly the case where a row is left
   *  reconnecting to a third party with their credential. A count-first
   *  short-circuit would make the one state that needs collecting the one state
   *  nothing ever looks at. */
  async userMcp_warmConnections(caller: UserCaller): Promise<{ servers: number }> {
    await this.requireTier(caller, 'mcp.manage');
    const rows = this.sqlx<{ n: number }>(`SELECT COUNT(*) AS n FROM user_mcp_servers`)[0];
    const servers = rows?.n ?? 0;
    try { await this.hydrateUserMcp(); }
    catch (err) {
      diagnostics.failure('mcp.connection_warmup_failed', toKinuError({
        doing: 'restoring the user MCP connections on warmup',
        cause: err,
        otherwise: 'unavailable',
      }), { servers });
    }
    return { servers };
  }

  async userMcp_list(caller: UserCaller): Promise<McpServerSummary[]> {
    await this.requireTier(caller, 'mcp.manage');
    const rows = this.sqlx<{
      id: string; name: string; server_url: string; transport: McpTransport;
      allowed_tools: string | null; created_at: number; updated_at: number;
    }>(
      `SELECT id, name, server_url, transport, allowed_tools, created_at, updated_at
       FROM user_mcp_servers ORDER BY name`,
    );
    // Hydrate so the live view of connection state is real, and unconditionally
    // — an orphaned SDK row outlives the last config row, and this is the
    // management surface where that is settled. Idempotent. A failure here is a
    // storage failure, not a per-server connection failure — those surface as
    // the row's `status` — so it must not report every server disconnected.
    await this.hydrateUserMcp();
    const connections = this._userMcp?.mcpConnections ?? {};
    return rows.map((r): McpServerSummary => {
      const conn = connections[r.id];
      const status = mapConnectionStatus(conn?.connectionState);
      const allowed = parseAllowedTools(r.allowed_tools);
      const toolsCount = conn?.tools
        ? (allowed
            ? conn.tools.filter((t: { name: string }) => allowed.includes(t.name)).length
            : conn.tools.length)
        : 0;
      // authUrl is set on the auth provider while AUTHENTICATING. The SDK
      // also persists it on the storage row; expose only if currently
      // pending so the UI knows whether to render the "Open authorize" link.
      const authUrl = status === 'authenticating'
        ? (conn?.options?.transport?.authProvider?.authUrl ?? null)
        : null;
      return {
        id: r.id,
        name: r.name,
        serverUrl: r.server_url,
        transport: r.transport,
        status,
        error: conn?.connectionError ?? null,
        toolsCount,
        authUrl,
        allowedTools: allowed,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    });
  }

  /** Add a new MCP server. `publicOrigin` is the user-facing origin the
   *  Worker should redirect OAuth callbacks to (e.g. `https://kinu.example`).
   *  The routes layer derives it from the inbound request's `Origin` /
   *  `Host` header — UserDO doesn't see the request. */
  async userMcp_add<McpInput>(
    caller: UserCaller,
    input: McpInput,
    publicOrigin: string,
  ): Promise<{ id: string; authUrl: string | null }> {
    await this.requireTier(caller, 'mcp.manage');
    const cfg = validateMcpServerInput(input);
    if (!/^https?:\/\//.test(publicOrigin)) {
      throw new Error('publicOrigin must be a full https?:// origin.');
    }
    const id = nanoid(8);
    const now = Date.now();
    const headersJson = cfg.headers ? JSON.stringify(cfg.headers) : null;
    const allowedJson = cfg.allowedTools ? JSON.stringify(cfg.allowedTools) : null;
    // SEALED BEFORE THE ATOMIC BOUNDARY. Sealing is an await, and an await is
    // what made the old SELECT-then-INSERT no check at all: two concurrent adds
    // both passed the SELECT while the other was sealing. Every value the
    // transaction writes is now in hand before it opens.
    const sealedHeaders = await this.sealMcpHeaders(id, headersJson);
    this.claimMcpServerName(cfg.name, id, () => {
      this.ctx.storage.sql.exec(
        `INSERT INTO user_mcp_servers
           (id, name, server_url, transport, headers, allowed_tools, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id, cfg.name, cfg.serverUrl, cfg.transport ?? 'auto',
        sealedHeaders, allowedJson, now, now,
      );
    });

    const callbackUrl = `${publicOrigin.replace(/\/+$/, '')}${MCP_OAUTH_CALLBACK_PATH}`;
    const authProvider = new DurableObjectOAuthClientProvider(
      this.ctx.storage, USER_MCP_CLIENT_NAME, callbackUrl,
    );
    authProvider.serverId = id;

    // The credential is a CLOSURE, never data the SDK can persist. See
    // `mcpCredentialTransport`; the row's sealed headers are opened per request.
    const credential = cfg.headers
      ? mcpCredentialTransport(cfg.serverUrl, () => this.openMcpHeaderMap(id))
      : {};

    let authUrl: string | null = null;
    try {
      const mgr = this.userMcp();
      await mgr.registerServer(id, {
        url: cfg.serverUrl,
        name: cfg.name,
        callbackUrl,
        transport: {
          ...credential,
          authProvider,
          type: cfg.transport ?? 'auto',
        },
      });
      const result = await mgr.connectToServer(id);
      if (result.state === 'failed') {
        throw new Error(result.error ?? 'connection failed');
      }
      if (result.state === 'authenticating') {
        authUrl = result.authUrl ?? null;
      } else {
        // Awaited, not detached. This ran under `ctx.waitUntil` with a comment
        // claiming the promise was "held open"; in a Durable Object waitUntil is
        // a no-op (`do.wait_until.no_op`) and an in-flight promise is cancelled
        // silently when the object is reset (`do.background_task.cancelled_on_reset`),
        // so the tool count could simply never appear and nothing would say why.
        // `userMcp_add` already awaits registerServer and connectToServer, so one
        // more round-trip buys a return value that is true when it returns.
        await mgr.discoverIfConnected(id);
      }
    } catch (err) {
      // Rollback both our row AND the SDK's storage entry so the user can
      // retry with a corrected URL rather than have a stuck failed entry.
      this.sqlx(`DELETE FROM user_mcp_servers WHERE id = ?`, id);
      await this.userMcp().removeServer(id);
      throw new Error(`MCP connect failed: ${renderThrownChain({ cause: err })}`, { cause: err });
    }
    return { id, authUrl };
  }

  async userMcp_remove(caller: UserCaller, id: string): Promise<void> {
    await this.requireTier(caller, 'mcp.manage');
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) throw new Error('Invalid server id.');
    try { await this.userMcp().removeServer(id); }
    catch (err) {
      diagnostics.failure('mcp.live_server_removal_failed', toKinuError({
        doing: 'removing a server from the live MCP manager',
        cause: err,
        otherwise: 'unavailable',
      }), { serverId: id });
    }
    this.sqlx(`DELETE FROM user_mcp_servers WHERE id = ?`, id);
  }

  /** Patch-update editable fields. Nothing here reconnects.
   *
   *  `name` and `allowedTools` take effect without one already (a rename
   *  re-keys the tools on the next descriptor fetch; allowedTools is enforced
   *  from SQL at descriptor/dispatch time), and a rotated `headers` value is
   *  now spent by the NEXT REQUEST: the transport reads the sealed column
   *  through a closure rather than at connect time (`mcpCredentialTransport`).
   *  Hydration is still called, because a row that had no credential has no
   *  closure on its live connection yet — that is the only transition that
   *  needs a registration, and hydration is the one place that decides it.
   *  `serverUrl` / `transport` changes still require remove + re-add (the SDK
   *  doesn't support live re-targeting). */
  async userMcp_update<Patch>(caller: UserCaller, id: string, patch: Patch): Promise<void> {
    await this.requireTier(caller, 'mcp.manage');
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) throw new Error('Invalid server id.');
    const parsedPatch = v.safeParse(LooseObjectSchema, patch);
    if (!parsedPatch.success) throw new Error('patch must be a JSON object.');
    const p = parsedPatch.output;
    const sets: string[] = [];
    const args: SqlStorageValue[] = [];
    // ONE name rule, shared with the add path — a rename must not accept a name
    // an add would refuse, since both claim from the same canonical namespace.
    const renamed = p.name === undefined ? null : validateMcpServerName(p.name);
    if (renamed !== null) { sets.push('name = ?'); args.push(renamed); }
    if (p.allowedTools !== undefined) {
      const allowedTools = v.safeParse(NullableStringArraySchema, p.allowedTools);
      if (!allowedTools.success) throw new Error('allowedTools must be string[] or null.');
      if (allowedTools.output === null) {
        sets.push('allowed_tools = ?'); args.push(null);
      } else {
        sets.push('allowed_tools = ?'); args.push(JSON.stringify(allowedTools.output));
      }
    }
    if (p.headers !== undefined) {
      const headers = v.safeParse(NullableStringRecordSchema, p.headers);
      if (!headers.success) throw new Error('headers must be Record<string,string> or null.');
      if (headers.output === null) {
        sets.push('headers = ?'); args.push(null);
      } else {
        sets.push('headers = ?'); args.push(await this.sealMcpHeaders(id, JSON.stringify(headers.output)));
      }
    }
    // Everything above is validated and sealed, so nothing below awaits. The
    // write is the last thing that happens and it happens atomically.
    if (sets.length === 0) return;
    const now = Date.now();
    sets.push('updated_at = ?'); args.push(now);
    args.push(id);
    const write = (): void => {
      this.ctx.storage.sql.exec(`UPDATE user_mcp_servers SET ${sets.join(', ')} WHERE id = ?`, ...args);
    };
    if (renamed === null) write();
    else this.claimMcpServerName(renamed, id, write);

    if (p.headers !== undefined) {
      try { await this.hydrateUserMcp(); }
      catch (err) {
        diagnostics.failure('mcp.header_rotation_hydration_failed', toKinuError({
          doing: 'hydrating an MCP server after a header change',
          cause: err,
          otherwise: 'unavailable',
        }), { serverId: id });
      }
    }
  }

  /**
   * Claim `name` for `serverId` and perform `write`, atomically.
   *
   * THE TRANSACTION IS THE CHECK, and it is the whole of it. `transactionSync`
   * runs the read and the write with no await between them, so no second add or
   * rename can interleave — which is exactly what a bare SELECT-then-INSERT
   * could not promise here, because sealing a row's headers is an await and both
   * callers passed the SELECT while the other was sealing.
   *
   * It holds WITHOUT the UNIQUE index, which is why a database carrying
   * historical duplicates keeps working: the constraint could not be built over
   * those rows (schema.ts), and nothing about a new write depends on it. The
   * index, where it exists, refuses the same thing with the same sentence.
   *
   * `write` MUST NOT await. The type says so — a synchronous body is what
   * `transactionSync` commits atomically; an async one would commit at its first
   * await and take the check with it.
   */
  private claimMcpServerName(name: string, serverId: string, write: () => void): void {
    this.ensureInit();
    try {
      this.ctx.storage.transactionSync(() => {
        const taken = this.ctx.storage.sql.exec(
          `SELECT 1 AS held FROM user_mcp_servers WHERE lower(name) = lower(?) AND id <> ? LIMIT 1`,
          name, serverId,
        ).toArray().length > 0;
        if (taken) throw new Error(mcpNameTakenMessage(name));
        write();
      });
    } catch (err) {
      rethrowMcpNameCollision({ cause: err, name });
    }
  }


  /**
   * Serializable tool descriptors for every ALREADY-CONNECTED MCP server,
   * filtered by per-server `allowed_tools`. The orchestrator wraps each into an
   * AI-SDK Tool whose `execute` closure dispatches back via `userMcp_callTool`.
   *
   * THIS READ STARTS NO NETWORK WORK AND WAITS FOR NONE. It is on the turn's
   * critical path, and it used to hydrate: `hydrateUserMcp` awaits
   * `establishConnection`, which awaits `_connectWithRetry` (3 attempts, 500ms
   * to 5s backoff) plus discovery with no bound at all
   * (`agents/dist/client-zqKcsyFa.js:2046,2073`). The
   * `waitForConnections({ timeout: 5_000 })` that followed could not bound what
   * its prose claimed, because the unbounded await had already happened before
   * the timer started. So the deadline is gone and so is the reason for one:
   * this method reads the CURRENT connection snapshot and returns.
   *
   * Establishment belongs to `userMcp_warmConnections`, which runs off the turn
   * (`user/routes.ts` first hit, under the WORKER's `ctx.waitUntil`), and to
   * `userMcp_callTool`, which hydrates on explicit use. Neither is this.
   *
   * `unavailable` names every configured server whose tools are not on the
   * surface, and the reason says WHY and WHEN they arrive. Without it the model
   * plans as if a capability the user gave it does not exist and cannot explain
   * why. The absence is a DEFERRAL, not a verdict: a tool set is fixed when a
   * turn opens — the AI SDK's `prepareStep` result carries `activeTools` but no
   * `tools` (`ai@6/dist/index.d.ts:986-1023`) and Think hands `streamText` one
   * tool object for the whole turn (`@cloudflare/think/dist/think.js:2707,2728`)
   * — so a connection that completes mid-turn is installed by the NEXT turn's
   * read of this surface. No state carries it: the live connection is the state,
   * and the orchestrator's cache invalidates on this surface's content hash.
   */
  async userMcp_toolDescriptors(caller: UserCaller): Promise<string> {
    await this.requireTier(caller, 'mcp.tools');
    const rows = this.sqlx<{ id: string; name: string; allowed_tools: string | null }>(
      `SELECT id, name, allowed_tools FROM user_mcp_servers`,
    );
    if (rows.length === 0) return JSON.stringify({ descriptors: [], unavailable: [] } satisfies McpToolSurface);

    const allowedById = new Map<string, ReadonlySet<string> | null>();
    for (const r of rows) {
      const allowed = parseAllowedTools(r.allowed_tools);
      allowedById.set(r.id, allowed ? new Set(allowed) : null);
    }

    const out: SerializableToolDescriptor[] = [];
    const connections = this._userMcp?.mcpConnections ?? {};
    for (const [id, conn] of Object.entries(connections)) {
      const allowed = allowedById.get(id);
      if (allowed === undefined) continue; // deleted
      const meta = rows.find((r) => r.id === id);
      if (!meta) continue;
      for (const tool of conn.tools) {
        if (allowed && !allowed.has(tool.name)) continue;
        out.push(describeMcpTool({ id, name: meta.name }, tool));
      }
    }
    // Connection is a property of the SDK connection, NOT of emitted
    // descriptors. A ready server can expose zero tools or have every tool
    // filtered by `allowed_tools`; neither fact means it is still connecting.
    const connected = new Set(
      Object.entries(connections)
        .filter(([, conn]) => mapConnectionStatus(conn.connectionState) === 'ready')
        .map(([id]) => id),
    );
    const unavailable = rows
      .filter((r) => !connected.has(r.id))
      .map((r) => ({
        server: r.name,
        reason: `not connected when this turn opened, so its tools are absent from this turn. They are `
          + `installed by the next turn once the connection completes — a turn's tool set is fixed `
          + `when the turn opens.`,
      }));
    // Sorted by the tool key, because this JSON is what the orchestrator's
    // cache hashes: `Object.entries(connections)` order is whatever the SDK's
    // map happens to hold, so an unsorted surface re-hashes — and rebuilds every
    // tool closure — for a reason nobody changed.
    out.sort((a, b) => (a.toolKey < b.toolKey ? -1 : a.toolKey > b.toolKey ? 1 : 0));
    return JSON.stringify({ descriptors: out, unavailable } satisfies McpToolSurface);
  }

  /** Execute a single MCP tool call. Called over RPC by the orchestrator's
   *  per-tool closure. The result must be JSON-serializable; the SDK already
   *  guarantees this (no closures in CallToolResult). */
  async userMcp_callTool(
    caller: UserCaller,
    serverId: string,
    name: string,
    args: JsonObject,
  ): Promise<string> {
    // Caller identity is proven by the capability token rather than claimed in
    // an argument, so there is no agent name left to spoof: a token exists only
    // for a workspace this user's registry issued one to, and dies with it.
    await this.requireTier(caller, 'mcp.tools');
    const wasCold = this._userMcp === null;
    const manager = this.userMcp();
    if (wasCold) {
      // Cold start: hydrate the manager before dispatching.
      try { await this.hydrateUserMcp(); }
      catch (err) { throw new Error(`MCP not ready: ${renderThrownChain({ cause: err })}`, { cause: err }); }
    }
    // Type-check the server membership inside our SQL so a stale orchestrator
    // closure can't dispatch to a server the user just deleted.
    const row = this.sqlx<{ allowed_tools: string | null }>(
      `SELECT allowed_tools FROM user_mcp_servers WHERE id = ?`, serverId,
    )[0];
    if (!row) throw new Error(`Unknown MCP server: ${serverId}`);
    const allowed = parseAllowedTools(row.allowed_tools);
    if (allowed && !allowed.includes(name)) {
      throw new Error(`Tool '${name}' is not in the allowed_tools list for this server.`);
    }
    const parsedParams = v.safeParse(JsonObjectSchema, args);
    const params = parsedParams.success ? parsedParams.output : {};
    try {
      const result = await manager.callTool({ serverId, name, arguments: params });
      return JSON.stringify(decodeJsonValue({ value: result }));
    } catch (err) {
      await this.convergeMcpAuthState({ serverId, cause: err });
      throw err;
    }
  }

  /**
   * A dispatch that failed on AUTHORIZATION leaves the connection saying
   * `ready`. Converge it to the state the UI already knows how to act on.
   *
   * A refresh that fails mid-session (an expired refresh token, a revoked
   * grant) throws out of `callTool` and touches no connection state: the MCP
   * SDK's own reauthorization path only runs inside connect and discovery. So
   * the server kept reporting `ready` with a null `authUrl`, its tools stayed on
   * the surface, and every call kept failing with nothing anywhere offering the
   * user a way to reconnect.
   *
   * `discoverIfConnected` IS that path — it re-probes the live connection, and
   * an unauthorized probe moves the connection to AUTHENTICATING and persists
   * the authorize URL (`agents/dist/client-zqKcsyFa.js:763,2003`), which is
   * exactly what `userMcp_list` renders as the reconnect link. Nothing is
   * swallowed: the original failure is rethrown by the caller and reaches the
   * model as the tool's error.
   *
   * WHICH failures qualify is `isMcpTransportUnauthorized`'s decision and it is
   * typed: a tool whose own result or error text mentions a 401 gets nothing
   * reconnected on its behalf.
   */
  private async convergeMcpAuthState(input: { serverId: string; cause: unknown }): Promise<void> {
    if (!isMcpTransportUnauthorized(input)) return;
    const { serverId } = input;
    try { await this.userMcp().discoverIfConnected(serverId); }
    catch (err) {
      diagnostics.failure('mcp.auth_state_convergence_failed', toKinuError({
        doing: 'reprobing an MCP connection that failed to authorize',
        cause: err,
        otherwise: 'unavailable',
      }), { serverId });
    }
  }

  /** OAuth callback receiver. The routes layer matches the incoming
   *  `/api/user/mcp/callback` request and forwards it here verbatim. */
  async userMcp_handleOAuthCallback(caller: UserCaller, url: string): Promise<{ ok: boolean; serverId: string | null; error: string | null }> {
    await this.requireTier(caller, 'mcp.manage');
    try {
      const req = new Request(url);
      const result = await this.userMcp().handleCallbackRequest(req);
      if (result.authSuccess) {
        // Awaited, and in its own try: the tokens ARE saved by this point, so a
        // connect failure must not be reported as an auth failure. Detaching it
        // was the same mistake as the two `ctx.waitUntil` calls above — a Durable
        // Object cannot retain an unawaited promise (`do.wait_until.no_op`), so
        // the connection could silently never be established after a successful
        // sign-in.
        try { await this.userMcp().establishConnection(result.serverId); }
        catch (err) { return { ok: true, serverId: result.serverId, error: `connected but not established: ${renderThrownChain({ cause: err })}` }; }
        return { ok: true, serverId: result.serverId, error: null };
      }
      return { ok: false, serverId: result.serverId ?? null, error: result.authError };
    } catch (err) {
      return { ok: false, serverId: null, error: renderThrownChain({ cause: err }) };
    }
  }

  // ── Provider/model surface ─────────────────────────────────────────

  /** Which providers does this user have credentials for? Used by the UI's
   *  model picker to know which providers are connected. */
  async listConnectedProviders(caller: UserCaller): Promise<ConnectedProvider[]> {
    const creds = this.credentialSummaries(await this.requireTier(caller, 'credentials.model'));
    const byKey = new Map(creds.map((c) => [c.key, c]));
    const out: ConnectedProvider[] = [];
    // Built-in providers without credentials are listed by the server, not
    // here — UserDO only knows about credential-gated ones.
    if (byKey.has(CLOUDFLARE_OAUTH_CRED_KEY)) {
      out.push({ id: 'workers-ai', label: 'Cloudflare Workers AI', credentialKeys: [CLOUDFLARE_OAUTH_CRED_KEY] });
      if (this.selectedAIGatewayId()) {
        out.push({ id: 'my-gateway', label: 'Your AI Gateway', credentialKeys: [CLOUDFLARE_OAUTH_CRED_KEY] });
      }
    }
    if (byKey.has(CODEX_CRED_KEY)) out.push({ id: 'codex', label: 'ChatGPT Codex', credentialKeys: [CODEX_CRED_KEY] });
    for (const c of creds) {
      // `<providerId>.bearer` — BYO API keys (bespoke trio + any models.dev
      // catalog provider). Display names come from the catalog client-side.
      const bearer = /^([a-z0-9][a-z0-9._-]*)\.bearer$/.exec(c.key);
      if (bearer) {
        out.push({ id: bearer[1], label: bearer[1], credentialKeys: [c.key] });
        continue;
      }
      // openai-compat is keyed by user-chosen suffix: 'openai-compat.<name>'
      if (c.key.startsWith('openai-compat.')) {
        const name = c.key.slice('openai-compat.'.length);
        out.push({ id: `openai-compat:${name}`, label: `OpenAI-compatible (${name})`, credentialKeys: [c.key] });
      }
    }
    return out;
  }
}
