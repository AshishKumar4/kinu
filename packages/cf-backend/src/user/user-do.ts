/**
 * Per-user Durable Object keyed by the stable Kinu userId; holds all secrets, agents get headers.
 * Every privileged method takes a `UserCaller` first and gates on `requireTier` before anything else.
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
} from "@kinu.run/core";
import type { MCPClientManager } from "agents/mcp/client";
import {
  DurableObjectOAuthClientProvider,
  type AgentMcpOAuthProvider,
} from "agents/mcp/do-oauth-client-provider";

// Re-exported for tests: the provider binds `agents/mcp/*` at load, so tests must import it
// via user-do (after the stub lands), not mcp.ts directly.
export { RegisteredAppOAuthClientProvider } from './mcp-registered-app';

import {
  DEVICE_CONNECT_PATH,
  DEVICE_TERMINAL_PATH,
  DEVICE_PTY_OPEN_METHOD,
  DEVICE_PTY_OUTPUT,
  DEVICE_PTY_EXIT,
  DEVICE_PTY_MAX_AXIS,
  NO_DEVICE_CONNECTED, SEVERAL_DEVICES_CONNECTED,
  isDeviceUnknownMethodError,
  isWorkspaceName,
  ORCHESTRATOR_AGENT_SLUG,
  nanoid,
  createExperienceLibrary,
  BUILTIN_PROFILE_CATALOG,
  profileCatalogDigest,
  validateProfileCatalog,
  type Credential,
  type ExperienceEntry,
  type ExperienceKind,
  type ProfileCatalog,
  type ProfileCatalogEnvelope,
  type PublishableCandidate,
  CLAUDE_CRED_KEY,
  CODEX_CRED_KEY,
  OAuthTokenError,
  baseCredentialKey,
  createCodexOAuthClient,
  subscriptionIssuer,
  type SubscriptionIssuer,
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
  parseJsonValue,
  autoTitleMayReplace, nameOriginOf,
  type NameOrigin,
} from '@kinu.run/core';
import {
  diagnostics,
  KinuError,
  renderThrownChain,
  tolerate,
  toKinuError,
} from '@kinu.run/core/obs';
import * as v from 'valibot';
import {
  initUserTables, PROFILE_CATALOG_CONFIG_KEY,
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
  DeviceSocketHub, deviceIdFromSocket,
  DeviceTerminalHub, terminalFromSocket,
  DeviceRequestLedger,
  type ClaimedDeviceRequest, type DeviceCancelOutcome,
  credentialToHeaders,
  validateCredential, validateCredentialKey, validateWorkspaceName,
  createCredentialCipher, isSealedCredential, type CredentialCipher,
  listEgressSecrets, putEgressSecret, resolveEgressInjection,
  revokeEgressSecret, rewrapEgressSecrets,
  type EgressInjectionResult, type EgressSecretSummary, type EgressVaultDeps,
  type PutEgressSecretInput,
} from '@kinu.run/core';
import { compareCodeUnits, initAccessTokenTable } from '@kinu.run/core';
import {
  addSkill, ChunkedUpload, deleteDriveEntry, driveFailure, DriveUploadTargetSchema, FILE_CHUNK_BYTES, FILE_TRANSFER_MAX_BYTES,
  listDrive, makeDriveFolder, markAsSkill, normalizeDrivePath, packDriveFolder, receiveDriveUpload, renameDriveEntry,
  SHARED_DRIVE_UNBOUND, SKILL_FOLDER_FILE,
  type DriveFailure, type DriveListing, type DriveUploadOutcome, type DriveUploadTarget, type MarkedSkill, type MossaicVfs,
} from '@kinu.run/core';
import { tenantDrive } from '../drive/tenant';
import { deriveUserId } from '../auth/store';
import { isModelInferenceCredentialKey } from '@kinu.run/core';
import { randomToken, sha256Hex } from '@kinu.run/core';
import { recoveryBackoffMs, resolveWorkspaceTitle, WorkspaceOverviewSchema, type WorkspaceOverview } from '@kinu.run/core';
import { displayNameProblem } from '@kinu.run/core';
import { installAnalyticsDiagnostics } from '@kinu.run/core/analytics';
import { openAnalyticsWindow } from '@kinu.run/core/analytics';
import {
  DEVICE_CONSENT_DENIED, DEVICE_CONSENT_UNANSWERED,
  DEVICE_KEEPALIVE_PING, DEVICE_KEEPALIVE_PONG,
  DEVICE_TOKEN_ROTATION, DEVICE_TOKEN_ROTATION_ACK,
  DEVICE_UPDATE, cliArtifactPath, deviceUpdateState, readBuildStamp, type BuildStamp,
  type DeviceUpdateFrame, type DeviceUpdateState,
  DEVICE_CANCEL_METHOD, DEVICE_CANCEL_PROTOCOL, DEVICE_EXEC_ACK_METHOD, parseDeviceCancelAnswer, nextDeviceRequestId,
  DEVICE_TIERS, SANDBOX_UNAVAILABLE,
  effectiveDeviceMode, parseDeviceTier, parseSandboxCapability, parseSandboxReason, sandboxReasonFix, sandboxCause,
  summarizeDeviceAction,
  type DeviceConsentDecision, type DeviceStatus,
  type DeviceFileScope, type DeviceFleetEntry, type DeviceSandboxStatus, type DeviceTier,
  type McpPresetId, mcpPresetById,
  describeMcpTool, omitEmptyOptionalArgs, type SerializableToolDescriptor,
} from '@kinu.run/core';
import {
  validateMcpServerInput, validateMcpServerName, parseAllowedTools, mapConnectionStatus,
  parseMcpHeaders, mcpCredentialTransport, isMcpTransportUnauthorized, callRenewingExpiredSession,
  storedMcpOptionsCarryCredential, mcpAppCredentials, mcpAppEnvNames, listMcpPresetAvailability, readUndiscoveredToolList,
  mcpListingRefusals,
  type McpPresetAvailability, type McpServerSummary, type McpToolListing, type McpTransport,
} from './mcp';
import {
  acceptRosterSocket, isRosterSocket, libraryTiles, rosterCounts, rosterPage, rosterRow, rosterSockets, sendRosterFrame, unreportedWorkspaces,
  ROSTER_SOCKET_PATH, type RosterPage, type RosterQuery,
} from './roster';
import { deletePictures, picturePrefix } from '../slates/pictures';
import { RegisteredAppOAuthClientProvider } from './mcp-registered-app';
import {
  CLOUDFLARE_AI_GATEWAY_CRED_KEY,
  CLOUDFLARE_OAUTH_CRED_KEY,
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
} from '@kinu.run/core';

export type DriveAnswer<Value> = { readonly ok: true; readonly value: Value } | ({ readonly ok: false } & DriveFailure);

/** One bounded chunk of a Drive upload. `offset === 0` (re)starts the transfer
 *  and fixes its target; every later chunk is checked against that target. */
export interface DriveChunkWrite {
  target: DriveUploadTarget;
  transferId: string;
  offset: number;
  chunk: Uint8Array;
  final: boolean;
}

interface DeviceConsentCheck {
  agentName: string;
  deviceId: string;
  method: string;
  params: JsonValue[];
  /** Present when the caller is the named workspace itself; the card then asks for the
   *  workspace's binding, which is what "always" records. */
  workspaceName?: string;
}

/** A pasted SKILL.md rides one RPC argument, so it stays far under the structured-clone ceiling. */
const DRIVE_PASTED_SKILL_MAX_BYTES = 256 * 1024;

const CLI_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000;

/** Measured from the last rotation (every accepted connect), so a copy of `device.json`
 *  that stops rotating expires on this clock. */
const DEVICE_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000;

const DEVICE_CONNECT_TICKET_TTL_MS = 60 * 1000;

/** Renewed as each fork frame lands, so this bounds the gap between frames, not the transfer. */
const FORK_RESERVATION_LEASE_MS = 5 * 60 * 1000;

const ROSTER_NUDGE_LANES = 4;

const DEVICE_NAME_MAX_LENGTH = 80;

const MINTED_DEVICE_TOKEN = /^pdt_[A-Za-z0-9_-]{32,}$/;


/** Owner-facing checkpoint reads do not execute or write on the device. Every
 * other workspace call, including restore, crosses the consent chokepoint. */
const CONSENT_FREE_DEVICE_METHODS = {
  checkpointStatus: true,
  checkpointList: true,
  checkpointPlan: true,
} as const satisfies Record<string, true>;

const CHECKPOINT_STORE_METHODS = {
  checkpointList: true, checkpointPlan: true, checkpointRestore: true,
} as const satisfies Record<string, true>;

/** Frames the daemon refuses without the owner's Sandbox switch. */
const DEVICE_VIEW_METHODS = {
  exec: true, [DEVICE_PTY_OPEN_METHOD]: true,
  readFile: true, readRange: true, writeFile: true, listFiles: true,
  statPath: true, unlinkPath: true, mkdirPath: true, exists: true,
  checkpointPlan: true, checkpointRestore: true,
} as const satisfies Record<string, true>;

/** The agent a device call's consent is keyed on, or undefined when the call is not gated
 *  (stopping work, or an owner read of a consent-free method). */
function consentAgentFor(
  resolved: ResolvedCaller,
  claimed: string | undefined,
  call: { stopping: boolean; ownerRead: boolean },
): string | undefined {
  if (call.stopping) return undefined;

  if (resolved.kind !== 'workspace') return claimed;

  return call.ownerRead ? undefined : resolved.workspace;
}

const CLI_AGENT_CONNECT_TICKET_TTL_MS = 60 * 1000;

const CLI_AGENT_WEBSOCKET_CAPABILITY = 'agent.websocket' as const;

/** Single per-user OAuth callback path (not the SDK's per-agent default); the full URL is
 *  built from the request origin at add-time. */
const MCP_OAUTH_CALLBACK_PATH = '/api/user/mcp/callback';

/** Keys the SDK's storage (`/{clientName}/{serverId}/...`); every construction and restore
 *  must use the same name. */
const USER_MCP_CLIENT_NAME = 'kinu-user-mcp';

/** Shared refusal text for both name guards: the claim in `claimMcpServerName` and the
 *  UNIQUE index, so UI and API show the same message. */
function mcpNameTakenMessage(name: string): string {
  return `An MCP server named '${name}' already exists.`;
}

/**
 * Rethrow a failed name claim, renaming only the `lower(name)` UNIQUE violation to that sentence.
 * Any other failure is rethrown untouched so storage errors are not reported as duplicates.
 */
function rethrowMcpNameCollision(input: { cause: unknown; name: string }): never {
  if (/UNIQUE constraint failed/i.test(renderThrownChain({ cause: input.cause }))) {
    throw new Error(mcpNameTakenMessage(input.name), { cause: input.cause });
  }

  throw input.cause;
}

export interface McpServerUnavailable {
  server: string;
  reason: string;
}

export interface McpToolSurface {
  descriptors: SerializableToolDescriptor[];
  unavailable: McpServerUnavailable[];
}

/** `headers` stays sealed here; it is opened per request inside the transport closure. */
interface McpHydrationRow extends SqlRow {
  id: string;
  name: string;
  server_url: string;
  transport: McpTransport;
  headers: string | null;
  preset_id: string | null;
}

interface SqlRow extends Record<string, SqlStorageValue> {}

type DeviceCancellationOutcome = {
  requestId: string;
  outcome: DeviceCancelOutcome | 'failed';
  detail?: string;
};

const CancelledRequestIdSchema = v.pipe(v.string(), v.minLength(1));

/**
 * Every field past `type` is optional so older daemons still connect. Absent means absent:
 * a daemon that says nothing about sandboxing is refused commands rather than run unconfined.
 */
/** RFC 1035: a name is at most 255 octets. */
const HOSTNAME_MAX_LENGTH = 255;

const DeviceHelloSchema = v.object({
  type: v.literal('HELLO'),
  os: v.optional(v.string()),
  hostname: v.optional(v.string()),
  /** The directory `kinu connect` ran in, and the machine's home.
   *  Absolute or ignored: a relative path names nothing the hub can scope a call to. */
  root: v.optional(v.string()),
  home: v.optional(v.string()),
  /** What the daemon proved at start. Words stay plain strings, narrowed by
   *  `sandboxVerdictFromHello`; a picklist would reject the whole HELLO over one unknown word. */
  sandbox: v.optional(v.object({
    capability: v.optional(v.nullable(v.string())),
    reason: v.optional(v.nullable(v.string())),
    reasonDetail: v.optional(v.nullable(v.string())),
    gpu: v.optional(v.array(v.string())),
  })),
  /** Where this machine keeps agent homes (`<home>/.kinu/agents`); the hub composes
   *  `<agentRoot>/<workspace>/home` per exec and never guesses a path. */
  agentRoot: v.optional(v.string()),
  /** Build stamp, `os.arch()`, and whether the owner allows pushed updates. All absent on older
   *  daemons, which get no UPDATE and keep the `daemon_outdated` reading. */
  version: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
  arch: v.optional(v.string()),
  updateCheck: v.optional(v.boolean()),
});

/** An object type rather than an interface, so it satisfies the row constraint `sqlx` puts
 *  on its result shape. */
type SandboxColumns = {
  sandbox_capability: string | null;
  sandbox_reason: string | null;
  sandbox_detail: string | null;
  sandbox_gpu: string | null;
};

type SandboxVerdict = Pick<DeviceSandboxStatus, 'capability' | 'reason' | 'detail'>;

/**
 * Unknown status words stay in the detail. No sandbox field means `daemon_outdated`; a proved
 * sandbox with no agent root cannot build a frame, so no command is promised a sandbox.
 */
function sandboxVerdictFromHello(
  hello: v.InferOutput<typeof DeviceHelloSchema>, agentRoot: string | null,
): SandboxVerdict {
  if (hello.sandbox === undefined) return { capability: 'files_only', reason: 'daemon_outdated', detail: null };
  const claimed = parseSandboxCapability(hello.sandbox.capability);

  if (claimed === 'sandboxed' && agentRoot === null) {
    return {
      capability: 'files_only',
      reason: 'daemon_outdated',
      detail: 'the daemon proved a sandbox but did not say where agent homes live',
    };
  }

  const word = hello.sandbox.reason ?? null;
  const line = hello.sandbox.reasonDetail ?? null;
  const reason = parseSandboxReason(word);

  if (reason === null && word !== null) {
    return { capability: claimed, reason, detail: line === null ? word : `${word}: ${line}` };
  }

  return { capability: claimed, reason, detail: line };
}

/** An absent or unrecognised word narrows to "not proved"; detail travels as written. */
function readSandboxColumns(row: SandboxColumns | undefined): SandboxVerdict & Pick<DeviceSandboxStatus, 'gpu'> {
  return {
    capability: parseSandboxCapability(row?.sandbox_capability),
    reason: parseSandboxReason(row?.sandbox_reason),
    detail: row?.sandbox_detail ?? null,
    gpu: v.parse(v.array(v.string()), JSON.parse(row?.sandbox_gpu ?? '[]')),
  };
}

/** Past PATH_MAX a path names no directory. */
const AbsolutePathSchema = v.pipe(v.string(), v.regex(/^\//), v.maxLength(4096));

function absolutePathOrNull(value: string | undefined): string | null {
  const parsed = v.safeParse(AbsolutePathSchema, value);

  if (!parsed.success) return null;

  return parsed.output.replace(/\/+$/, '') || '/';
}

const DeviceRotationAckSchema = v.object({ type: v.literal(DEVICE_TOKEN_ROTATION_ACK) });

/** Read before the RPC correlator: these frames carry no request id, and the correlator
 *  would drop them silently. */
const DeviceTerminalFrameSchema = v.variant('type', [
  v.object({ type: v.literal(DEVICE_PTY_OUTPUT), session: v.string(), data: v.string() }),
  v.object({ type: v.literal(DEVICE_PTY_EXIT), session: v.string(), exitCode: v.number() }),
]);

const TERMINAL_DEFAULT_AXIS = { cols: 80, rows: 24 } as const;

/** Control round-trip timeout, not the terminal's life; also the default for every other
 *  control call on this socket. */
const TERMINAL_OPEN_TIMEOUT_MS = 10_000;

function bytesFromBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);

  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);

  return bytes;
}

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
  /** `null` until the wizard reaches `finish()`. Lives in `user_onboarding` because the
   *  genesis lock refuses a new column on the shipped `user_profile`. */
  onboardedAt: number | null;
  /** Counted like `listWorkspaces`' `total`. An account owning a workspace never sees the
   *  wizard, stamp or not. */
  workspaceCount: number;
}

export interface WorkspaceEntry {
  name: string;
  displayName: string;
  createdAt: number;
  lastVisited: number;
  archivedAt: number | null;
}

/** `title` is cached at share time. `createdAt` is absent on the write side. */
export interface SharedBlueprintReceipt {
  ownerUserId: string;
  ownerEmail: string;
  workspace: string;
  shareId: string;
  title: string;
  createdAt?: number;
}

export interface WorkspaceRegistrationSource {
  purpose?: string;
  nameOrigin?: NameOrigin;
}

/** `reserved` names an uncommitted fork transfer and deliberately carries no entry, so
 *  acting on a half-written fork target is unrepresentable. */
export type WorkspaceRegistration =
  | { readonly status: 'created' | 'active'; readonly entry: WorkspaceEntry }
  | { readonly status: 'reserved' };

/** Publish of something that is not an open reservation. A fork transfer treats it as a rollback
 * trigger, not a transport fault; crosses the DO RPC boundary as its message. */
class WorkspaceReservationNotPendingError extends Error {
  constructor(name: string, why: string) {
    super(`Workspace "${name}" cannot be published: ${why}.`);
    this.name = 'WorkspaceReservationNotPendingError';
  }
}

/** A CLI device-code approval redeemed twice; the poll route answers it as already-delivered.
 * Crosses the DO RPC boundary as its message. */
class CliAuthorizationSpentError extends Error {
  constructor(options: ErrorOptions) {
    super('That CLI authorization has already been redeemed.', options);
    this.name = 'CliAuthorizationSpentError';
  }
}

/** A typed result, not an exception: error classes do not survive the DO RPC boundary. */
export type ProfileCatalogWriteResult =
  | { readonly ok: true; readonly envelope: ProfileCatalogEnvelope }
  | { readonly ok: false; readonly kind: 'conflict'; readonly currentVersion: number; readonly currentDigest: string }
  | { readonly ok: false; readonly kind: 'malformed'; readonly reason: string };

/** Parsed before profile code trusts its SQL values, so a damaged row cannot become a default. */
interface StoredProfileCatalogRow {
  value: string;
  version: number;
}

interface ProfileCatalogState {
  version: number;
  catalog: ProfileCatalog;
}

const StoredProfileCatalogRowSchema: v.GenericSchema<StoredProfileCatalogRow> = v.strictObject({
  value: v.string(),
  version: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

export interface CredentialSummary {
  key: string;
  kind: 'bearer' | 'oauth' | 'openai-compat';
  createdAt: number;
  updatedAt: number;
}

/** What one OAuth refresh established; see `UserDO.refreshOAuthCredential`. */
type OAuthRefresh = OAuthCredential | 'revoked' | { readonly failed: KinuError };

/** A login and the revision it was read at. */
interface HeldLogin {
  readonly cred: OAuthCredential;
  readonly revision: number;
}

/** What a failed refresh names, per base key. */
const REFRESH_DOING: ReadonlyMap<string, string> = new Map([
  [CODEX_CRED_KEY, 'refreshing the Codex credential'],
  [CLAUDE_CRED_KEY, 'refreshing the Claude credential'],
  [CLOUDFLARE_OAUTH_CRED_KEY, 'refreshing the Cloudflare credential'],
]);

export interface CodexStatus {
  connected: boolean;
  accountId: string | null;
  expiresAt: number | null;
  startedFlow: { userCode: string; portalURL: string; pollIntervalSec: number } | null;
}

export interface ConnectedProvider {
  id: string;
  label: string;
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
  /** Present only for tickets minted by a scoped `pta_…` token; the websocket pins to these scopes. */
  scopes?: AccessTokenScope[];
  /** Rides the connection's tags so a later revocation can name every older socket,
   * including one restored from hibernation, whose tags are its only identity. */
  authGeneration?: number;
  error?: string;
}

/** Identity as of the sign-in that minted the cookie. Written once, never updated;
 * a rename lands on the next sign-in. */
export interface BrowserSessionIdentity {
  email: string;
  displayName: string | null;
  provider: string;
  /** `sub`, or the provider's own stable user id. */
  sub: string;
  /** Interactive-auth time in epoch ms, read by step-up checks. */
  authTime: number;
}

/** A revoked or lapsed session has no row and reads as null. `identity` is null only for rows
 * registered before rows carried one; the KV projection is then the only copy. */
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

/**
 * `MCPClientManager.onStart` restores connections on every activation before credential closures
 * exist; retire the call and return the real restore for {@link UserDO.hydrateUserMcp}.
 */
function retireActivationRestore(
  manager: MCPClientManager,
): (clientName: string) => Promise<void> {
  const restore = manager.restoreConnectionsFromStorage.bind(manager);
  manager.restoreConnectionsFromStorage = async (): Promise<void> => {
    diagnostics.event('mcp.inherited_restore_skipped', { manager: USER_MCP_CLIENT_NAME });
  };

  return restore;
}

export class UserDO extends Agent<Env> {
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    sealRpcSurface(this, USER_DO_RPC_SURFACE);
    // A DO is its own isolate, so the Worker's diagnostics sink must be installed here too.
    installAnalyticsDiagnostics(this.env);
  }

  /** Keyed by {@link USER_MCP_CLIENT_NAME}, not this object's name: every stored grant uses that key. */
  override createMcpOAuthProvider(callbackUrl: string): AgentMcpOAuthProvider {
    return new DurableObjectOAuthClientProvider(this.ctx.storage, USER_MCP_CLIENT_NAME, callbackUrl);
  }

  private _initialized = false;

  private readonly restoreUserMcp = retireActivationRestore(this.mcp);

  private _userMcpHydrated = false;

  /** Calls interleave at every await; joining this keeps reconciliation one credential-safe sequence.
   * Cleared after either settlement so a later caller can retry. */
  private _hydratingUserMcp: Promise<void> | null = null;

  private readonly _mcpToolLists = new Map<string, McpToolListing>();


  /** Once per activation. Claims live in isolate memory, so any claim in storage at activation start
   * was abandoned; the activation boundary is the expiry. */
  private ensureInit(): void {
    if (this._initialized) return;
    initUserTables(this.ctx.storage.sql);
    initAccessTokenTable(this.ctx.storage.sql);
    this._inflight.releaseAbandonedClaims();
    this._initialized = true;
  }

  private sqlx<T extends SqlRow = SqlRow>(query: string, ...bindings: SqlStorageValue[]): T[] {
    this.ensureInit();

    return this.ctx.storage.sql.exec<T>(query, ...bindings).toArray();
  }

  /**
   * The attenuation gate: first statement of every privileged method below.
   * Also reopens the analytics window, since the 250-point budget is per invocation.
   */
  private requireTier(caller: UserCaller, capability: WorkspaceCapability): Promise<ResolvedCaller> {
    this.ensureInit();
    openAnalyticsWindow(this.env);

    return requireTier(this.ctx.storage.sql, this.env, { caller }, capability);
  }

  /** Provisioning in flight, per workspace. A DO does not serialize across an RPC await, so
   *  coalescing here keeps concurrent first-touches from installing tokens from different mints. */
  private readonly _provisioning = new Map<string, Promise<void>>();

  /**
   * Reconcile a workspace's identity; any mismatch with `presentedHash` is repaired by minting anew.
   * The only ungated method (it bootstraps identity), so it opens the analytics window itself.
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
   * Shared body for {@link ensureWorkspaceCapability} and {@link publishWorkspaceReservation}.
   * Admission is re-checked in the same synchronous turn as the write, so a delete during minting wins.
   */
  private async reconcileWorkspaceCapability(workspaceName: string, presentedHash: string | null): Promise<void> {
    if (presentedHash && presentedHash === workspaceCapabilityHash(this.ctx.storage.sql, workspaceName)) {
      // Matching hash is done only if no rotation is pending on a replica; the root holds the
      // only plaintext, so it is asked to re-push.
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

  /** Like {@link workspaceRegistered} but also admits fork reservations (`create_pending = 1`);
   *  refuses rows mid-teardown and names absent from the registry. */
  private workspaceMintable(name: string): boolean {
    return this.sqlx(
      `SELECT 1 AS x FROM user_workspaces WHERE name = ? AND delete_pending = 0`, name,
    ).length > 0;
  }

  private onboardingCompletedAt(): number | null {
    const row = this.sqlx<{ completed_at: number }>(
      `SELECT completed_at FROM user_onboarding WHERE id = 1`,
    )[0];

    return row?.completed_at ?? null;
  }

  /** Same predicate as `listWorkspaces`' `total`: pending reservations and teardowns don't count. */
  private rosterCount(): number {
    return this.sqlx<{ n: number }>(
      `SELECT COUNT(*) AS n FROM user_workspaces
       WHERE archived_at IS NULL AND delete_pending = 0 AND create_pending = 0`,
    )[0].n;
  }

  async ensureProfile(caller: UserCaller, email: string, displayName?: string): Promise<UserProfile> {
    await this.requireTier(caller, 'profile');
    const now = Date.now();
    const onboardedAt = this.onboardingCompletedAt();
    const workspaceCount = this.rosterCount();

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
        onboardedAt,
        workspaceCount,
      };
    }

    this.sqlx(
      `INSERT INTO user_profile (id, email, display_name, created_at, last_seen_at) VALUES (1, ?, ?, ?, ?)`,
      email, displayName ?? null, now, now,
    );

    return { email, displayName: displayName ?? null, createdAt: now, lastSeenAt: now, onboardedAt, workspaceCount };
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
      onboardedAt: this.onboardingCompletedAt(),
      workspaceCount: this.rosterCount(),
    };
  }

  // The 'account' capability is floored at owner_only, so no workspace token reaches these methods.

  /** Idempotent: the first completion wins; a retry returns the original timestamp. */
  async completeOnboarding(caller: UserCaller): Promise<{ onboardedAt: number }> {
    await this.requireTier(caller, 'account');

    this.sqlx(
      `INSERT INTO user_onboarding (id, completed_at) VALUES (1, ?) ON CONFLICT (id) DO NOTHING`,
      Date.now(),
    );

    const stamped = this.onboardingCompletedAt();

    if (stamped === null) throw new Error('user_onboarding has no row after the insert');

    return { onboardedAt: stamped };
  }

  async setDisplayName(caller: UserCaller, displayName: string): Promise<UserProfile> {
    await this.requireTier(caller, 'account');
    const name = displayName.trim();
    const problem = displayNameProblem(name);

    if (problem !== null) throw new Error(problem);

    this.sqlx(`UPDATE user_profile SET display_name = ? WHERE id = 1`, name);

    const profile = await this.getProfile(caller);

    if (!profile) throw new Error('No profile row to rename');

    return profile;
  }

  async listWorkspaces(caller: UserCaller, query?: RosterQuery): Promise<RosterPage> {
    const resolved = await this.requireTier(caller, 'workspaces.read');
    // This read is the retry for unfinished teardowns and for stale fork reservations nothing else frees.
    await this.resumePendingDeletions();
    await this.reclaimStaleForkReservations();
    this.nudgeUnreported();
    const page = rosterPage(this.ctx.storage.sql, query);

    // Never whom siblings share with.
    return resolved.kind === 'owner_session' ? page : {
      ...page, entries: page.entries.map((entry) => ({ ...entry, overview: entry.overview === null ? null : { ...entry.overview, shares: [] } })),
    };
  }

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
          if (!this.workspaceRegistered(name)) continue;
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

  /** With no page open, nothing is read. */
  private rosterChanged(name: string): void {
    const sockets = rosterSockets(this.ctx);

    if (sockets.length === 0) return;
    const sql = this.ctx.storage.sql;
    sendRosterFrame(sockets, { type: 'workspace', name, entry: rosterRow(sql, name), counts: rosterCounts(sql) });
  }

  /** A repeat writes and sends nothing. */
  async putWorkspaceOverview(caller: UserCaller, name: string, overview: WorkspaceOverview): Promise<void> {
    const resolved = await this.requireTier(caller, 'workspaces.overview_self');
    validateWorkspaceName(name);

    if (resolved.kind === 'workspace' && resolved.workspace !== name) {
      throw new Error(`Workspace "${resolved.workspace}" may only push its own overview.`);
    }

    const parsed = v.parse(WorkspaceOverviewSchema, overview);

    const changed = this.sqlx(
      `INSERT INTO workspace_overviews (name, overview, activity, decisions, changed_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET overview = excluded.overview, activity = excluded.activity,
         decisions = excluded.decisions, changed_at = excluded.changed_at
       WHERE workspace_overviews.overview <> excluded.overview
       RETURNING name`,
      name, JSON.stringify(parsed), parsed.activity, parsed.decisionsWaiting, Date.now(),
    );

    if (changed.length > 0) this.rosterChanged(name);
  }

  /** Uncapped enumeration of the active roster for server-side fans, where a page would drop targets. */
  async listActiveWorkspaces(caller: UserCaller): Promise<Array<Pick<WorkspaceEntry, 'name' | 'displayName' | 'createdAt'>>> {
    await this.requireTier(caller, 'workspaces.read');

    return this.sqlx<{ name: string; display_name: string; created_at: number }>(
      `SELECT name, display_name, created_at FROM user_workspaces
       WHERE archived_at IS NULL AND delete_pending = 0 AND create_pending = 0
       ORDER BY last_visited DESC`,
    ).map((r) => ({ name: r.name, displayName: r.display_name, createdAt: r.created_at }));
  }

  /**
   * Claim a roster name. `created` is exclusive (read+insert in one turn), and only it may initialize
   * or roll back; `active` must not be re-seeded; `reserved` is an uncommitted fork's hold.
   */
  async registerWorkspace(
    caller: UserCaller, name: string, displayName?: string, from?: WorkspaceRegistrationSource,
  ): Promise<WorkspaceRegistration> {
    const { purpose, nameOrigin } = from ?? {};
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
      // Return the row's own timestamp: keeps the answer stable across retries and lets a
      // rollback match the row it actually inserted.
      this.sqlx(
        `UPDATE user_workspaces SET last_visited = ?, archived_at = NULL WHERE name = ?`,
        now, name,
      );
      this.rosterChanged(name);

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
    // Use the origin the caller decided; a derived title is non-empty and must not read as
    // the owner's choice. A caller that states nothing falls back to the displayName test.
    const origin: NameOrigin = nameOrigin ?? (explicit !== '' ? 'user' : 'auto');
    // No ON CONFLICT: the read above and this write are one turn, so a conflict is unreachable;
    // if an await ever separated them, a silent upsert would be wrong.
    this.sqlx(
      `INSERT INTO user_workspaces (name, display_name, name_origin, created_at, last_visited, create_pending)
       VALUES (?, ?, ?, ?, ?, 0)`,
      name, title, origin, now, now,
    );
    this.rosterChanged(name);

    return {
      status: 'created',
      entry: { name, displayName: title, createdAt: now, lastVisited: now, archivedAt: null },
    };
  }

  /**
   * Hold a name for a pending fork transfer: row is inserted with `create_pending = 1`, invisible
   * until {@link publishWorkspaceReservation} (KINU-027) but still blocking the name.
   * Carries a lease; a lapsed reservation is torn down and adopted by the new caller.
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
   * Extend the reservation lease; called by the sender per frame. Returns false when the
   * reservation is no longer the caller's (published, released, or adopted), so it stops.
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

  /** Tear down the target DO of a lapsed reservation, then drop the row; teardown is idempotent. */
  private async reclaimForkReservation(name: string): Promise<void> {
    const ownerUserId = this.ctx.id.name ?? '';

    if (!/^[a-f0-9]{32}$/.test(ownerUserId)) {
      // Without the owner id the destroy cannot be authorized; the row keeps its lapsed lease
      // and the next attempt retries.
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
   * Reclaim lapsed reservations. Driven by the owner's reads like {@link resumePendingDeletions}:
   * this object has no timer, and the roster hides `create_pending` rows.
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

  /** Commit a reservation; the only place `create_pending` is cleared. */
  async publishWorkspaceReservation(
    caller: UserCaller,
    name: string,
    createdAt: number,
    capabilityHash: string | null,
  ): Promise<void> {
    await this.requireTier(caller, 'workspaces.write');
    validateWorkspaceName(name);

    // Match on timestamp too: by name alone a late reply could publish a later reservation.
    // Rows with teardown started (`delete_pending`) may not be committed.
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

    // Install (cross-DO await) must precede the transaction: `transactionSync` commits when its
    // synchronous body returns. A failed install leaves the row unpublished and releasable.
    await this.reconcileWorkspaceCapability(name, capabilityHash);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `UPDATE user_workspaces SET create_pending = 0, fork_lease_expires_at = NULL
         WHERE name = ? AND created_at = ? AND create_pending = 1`,
        name, createdAt,
      );
    });
    this.rosterChanged(name);
  }

  /** Drop only the exact row a failed fork reservation inserted; never contacts the target DO
   * (used only when the target belongs to another user). */
  async releaseWorkspaceReservation(caller: UserCaller, name: string, createdAt: number): Promise<boolean> {
    await this.requireTier(caller, 'workspaces.write');
    validateWorkspaceName(name);

    if (!Number.isFinite(createdAt)) return false;

    // A `delete_pending` row belongs to an unfinished teardown and must not be dropped.
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
    // Rows being torn down or not yet published are not visitable, matching ordinary reads.
    this.sqlx(
      `UPDATE user_workspaces SET last_visited = ?
       WHERE name = ? AND delete_pending = 0 AND create_pending = 0`,
      Date.now(), name,
    );
    this.rosterChanged(name);
  }

  /**
   * Row is marked before teardown and removed after, so a failed teardown is resumed by the next
   * read (`resumePendingDeletions`); `destroyAgent` is idempotent.
   */
  async removeWorkspace(caller: UserCaller, name: string, ownerUserId: string): Promise<void> {
    await this.requireTier(caller, 'workspaces.write');
    validateWorkspaceName(name);

    if (!/^[a-f0-9]{32}$/.test(ownerUserId)) throw new Error('invalid owner user id');
    await this.tearDownWorkspace(name, ownerUserId);
  }

  /**
   * Mark and revoke in one synchronous turn before the destroy await, so a dying workspace keeps no
   * authority. Destroy the DO before dropping the row; on failure the marked row stays and the
   * revoke is not undone.
   */
  private async tearDownWorkspace(name: string, ownerUserId: string): Promise<void> {
    this.sqlx(`UPDATE user_workspaces SET delete_pending = 1 WHERE name = ?`, name);
    revokeWorkspaceCapability(this.ctx.storage.sql, name);
    this.rosterChanged(name);
    // Grants are read by name, so a surviving row would grant full_filesystem to a same-name recreate.
    this.sqlx(`DELETE FROM device_consent WHERE agent_name = ?`, name);

    try {
      const stub = this.env.OrchestratorAgent.get(this.env.OrchestratorAgent.idFromName(name));
      await stub.destroyAgent(ownerUserId);
    } catch (err) {
      // agents-SDK destroy aborts its own isolate after the wipe; the 'destroyed' error means success.
      if (!(err instanceof Error) || err.message !== 'destroyed') throw err;
    }

    if (this.env.SLATE_PICTURES !== undefined) await deletePictures(this.env.SLATE_PICTURES, picturePrefix(name));
    this.sqlx(`DELETE FROM user_workspaces WHERE name = ?`, name);
    this.sqlx(`DELETE FROM workspace_overviews WHERE name = ?`, name);
    this.sqlx(`DELETE FROM workspace_overview_nudges WHERE name = ?`, name);
    // Re-run for a resumed row whose identity a pre-fence delete could have left registered.
    revokeWorkspaceCapability(this.ctx.storage.sql, name);
  }

  /**
   * Finish teardowns left marked; driven by the owner's reads since this object has no timer.
   * Failures keep the marker (the row is the retry) and do not throw, so listings still succeed.
   */
  private async resumePendingDeletions(): Promise<void> {
    const pending = this.sqlx<{ name: string }>(
      `SELECT name FROM user_workspaces WHERE delete_pending = 1`,
    );

    if (pending.length === 0) return;
    const ownerUserId = this.ctx.id.name ?? '';

    if (!/^[a-f0-9]{32}$/.test(ownerUserId)) {
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
   * Refuse a name whose teardown is pending; the row still owns a DO a recreate would wire into.
   * Retries the teardown first so a transient failure does not dead-end the name.
   */
  private async requireNotDeleting(name: string): Promise<void> {
    const marked = `SELECT 1 AS x FROM user_workspaces WHERE name = ? AND delete_pending = 1`;

    if (this.sqlx(marked, name).length === 0) return;
    await this.resumePendingDeletions();

    if (this.sqlx(marked, name).length === 0) return;
    throw new Error(`Workspace "${name}" is still being deleted; its teardown has not finished.`);
  }

  /**
   * Root title authority: an 'auto' write is refused when the owner has named the workspace.
   * Returns whether the write applied; the workspace actor mirrors only after this succeeds.
   */
  async setWorkspaceDisplayName(
    caller: UserCaller, name: string, displayName: string, origin: NameOrigin,
  ): Promise<{ applied: boolean }> {
    const resolved = await this.requireTier(caller, 'workspaces.rename_self');
    validateWorkspaceName(name);

    // An agent renames only itself; this is what makes rename safe at the `shared` tier.
    if (resolved.kind === 'workspace' && resolved.workspace !== name) {
      throw new Error(`Workspace "${resolved.workspace}" may only rename itself.`);
    }

    const current = this.sqlx<{ name_origin: string }>(
      `SELECT name_origin FROM user_workspaces
       WHERE name = ? AND delete_pending = 0 AND create_pending = 0`, name,
    )[0];

    if (!current) return { applied: false };

    if (origin !== 'user' && !autoTitleMayReplace(nameOriginOf(current.name_origin))) return { applied: false };
    this.sqlx(
      `UPDATE user_workspaces SET display_name = ?, name_origin = ? WHERE name = ?`,
      displayName, origin, name,
    );
    this.rosterChanged(name);

    return { applied: true };
  }

  /** Null when no row exists; actors hydrate their activation cache from this. */
  async getWorkspaceTitle(caller: UserCaller, name: string): Promise<{ displayName: string; nameOrigin: NameOrigin } | null> {
    await this.requireTier(caller, 'workspaces.read');
    validateWorkspaceName(name);

    const row = this.sqlx<{ display_name: string; name_origin: string }>(
      `SELECT display_name, name_origin FROM user_workspaces
       WHERE name = ? AND delete_pending = 0 AND create_pending = 0`, name,
    )[0];

    if (!row) return null;

    return { displayName: row.display_name, nameOrigin: nameOriginOf(row.name_origin) };
  }

  async hasWorkspace(caller: UserCaller, name: string): Promise<boolean> {
    await this.requireTier(caller, 'workspaces.read');

    return this.workspaceRegistered(name);
  }

  /** Ungated; callers (`hasWorkspace`, ticket flows) are gated at their own entry points. */
  private workspaceRegistered(name: string): boolean {
    validateWorkspaceName(name);

    // Pending rows are not openable; every open, including `ensureWorkspaceCapability`, goes through here.
    const row = this.sqlx(
      `SELECT 1 AS x FROM user_workspaces
       WHERE name = ? AND archived_at IS NULL AND delete_pending = 0
         AND create_pending = 0`,
      name,
    )[0];

    return row !== undefined;
  }

  /** Whether a foreign sender may deliver into this user's agents; same-owner peers need no grant. */
  async hasPeerGrant(caller: UserCaller, senderAgentName: string, senderUserId: string): Promise<boolean> {
    await this.requireTier(caller, 'peers.grants');

    const row = this.sqlx(
      `SELECT 1 AS x FROM user_peer_grants WHERE sender_user_id = ? AND sender_agent_name = ?`,
      senderUserId, senderAgentName,
    )[0];

    return row !== undefined;
  }

  // Session authority lives here: KV writes and deletes take up to a minute to reach every colo,
  // so KV can confirm neither revocation nor existence.

  /** Called before the cookie is issued. An existing hash throws; the caller compensates. */
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

  /** This cookie's session, or null when not live. Expired rows are deleted in the same
   * transaction as the read, so expiry needs no sweeper or alarm. */
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

      // All five columns come from one INSERT, so they are present or absent together;
      // an older row without them carries no identity rather than half of one.
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

  /** Revoke exactly this session; the row's absence is the revocation. The write is durable
   * before the fan-out, so a failed push cannot keep a socket authorized (see retireCliAuthority). */
  async revokeBrowserSession(caller: UserCaller, tokenHash: string): Promise<void> {
    await this.requireTier(caller, 'auth_tokens');
    this.sqlx(`DELETE FROM user_browser_sessions WHERE token_hash = ?`, tokenHash);
    await this.pushSessionSocketRevocation(tokenHash);
  }

  /** Close every websocket that named this session at upgrade. Best-effort, like the CLI socket push. */
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

  /** Frame-time liveness check for a session-authenticated websocket; twin of verifyCliSocketBearer.
   * An unreachable workspace is refused by the caller, not answered here. */
  async verifySocketSession(caller: UserCaller, tokenHash: string): Promise<{ live: boolean }> {
    await this.requireTier(caller, 'auth_tokens.socket');

    if (!/^[a-f0-9]{64}$/.test(tokenHash)) return { live: false };

    const row = this.sqlx<{ token_hash: string }>(
      `SELECT token_hash FROM user_browser_sessions WHERE token_hash = ? AND expires_at > ? LIMIT 1`,
      tokenHash, Date.now(),
    )[0];

    return { live: row !== undefined };
  }

  /**
   * Mint a CLI bearer token; only its hash is stored. userId is embedded so edge routes can
   * reach this UserDO before verification. `authorizationHash` is the approval: the unique index
   * makes the mint single-use, since the KV device-code record has no compare-and-swap.
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
      throw new CliAuthorizationSpentError({ cause });
    }

    return { token, tokenHash, expiresAt };
  }

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

  /** Revoke every active CLI session token, for orphans the caller cannot name.
   * One generation rise covers every socket at once. */
  async revokeAllCliTokens(caller: UserCaller): Promise<{ revoked: number }> {
    await this.requireTier(caller, 'auth_tokens');

    const revoked = this.sqlx<{ n: number }>(
      `SELECT COUNT(*) AS n FROM user_cli_tokens WHERE revoked_at IS NULL`,
    )[0]?.n ?? 0;

    this.sqlx(`UPDATE user_cli_tokens SET revoked_at = ? WHERE revoked_at IS NULL`, Date.now());
    await this.retireCliAuthority();

    return { revoked };
  }

  /**
   * Rises with every CLI or access-token revocation. Sockets record the generation they were
   * admitted under, so revocation reaches listening-only sockets that send no frames.
   */
  private authGeneration(): number {
    const row = this.sqlx<{ generation: number }>(
      `SELECT generation FROM user_auth_generation WHERE id = 1`,
    )[0];

    return row?.generation ?? 0;
  }

  /**
   * The write must precede the fan-out: revocation is durable before any cross-DO await, so a
   * failed push only delays closure; the frame-time check still refuses the next frame.
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
   * Frame-time check for a bearer-authenticated websocket, returning the generation it must hold.
   * Reads the same rows revocation writes; connect tickets are only checked at upgrade.
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

  /** Step-up policy is enforced by the CLI routes; this DO owns hash-only storage and
   * name/scope validation. */
  async mintAccessToken(caller: UserCaller, userId: string, name: string, scopes: readonly string[]): Promise<AccessTokenMint> {
    await this.requireTier(caller, 'auth_tokens');

    return mintAccessTokenRow(this.ctx.storage.sql, userId, name, scopes);
  }

  /** Same contract as verifyCliToken, with the granted scopes attached. */
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
    // Unconditional: `revoked: false` also covers an already-revoked token, and a spurious
    // generation rise is cheap while a skipped one leaves a socket open.
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

  /** Scopes of the ticket's bearer: session token → 'all', access token → its scopes, null if invalid.
   * Resolved at verify time so a revoked access token cannot ride a pre-minted ticket. */
  private cliBearerScopes(tokenHash: string, now: number): 'all' | AccessTokenScope[] | null {
    const session = this.sqlx<{ expires_at: number }>(
      `SELECT expires_at FROM user_cli_tokens WHERE token_hash = ? AND revoked_at IS NULL LIMIT 1`,
      tokenHash,
    )[0];

    if (session) return session.expires_at > now ? 'all' : null;

    return getActiveAccessTokenScopes(this.ctx.storage.sql, tokenHash);
  }

  // The reverse-WS tunnel from a user's machine terminates here, not on an agent, so every agent
  // can reach the device via `deviceRpc()`. A WebSocket cannot cross RPC; the worker forwards the upgrade.
  private readonly _devices = new DeviceSocketHub(this.ctx);

  /** Pane sockets paired with device sessions; both live here because the device socket does. */
  private readonly _terminals = new DeviceTerminalHub(this.ctx, this._devices);

  /** Durable record of commands running on devices (see ./device-inflight.ts); the ledger owns the table. */
  private readonly _inflight = new DeviceRequestLedger(this.ctx.storage.sql);

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === DEVICE_CONNECT_PATH) return this.acceptDeviceSocket(request, url);

    if (url.pathname === DEVICE_TERMINAL_PATH) return this.acceptTerminalSocket(request, url);

    if (url.pathname === ROSTER_SOCKET_PATH) return acceptRosterSocket(this.ctx, request);

    return super.fetch(request);
  }

  /**
   * Verify + consume the connect ticket here so the upgrade is safe however it arrived, then rotate
   * the device token over the authenticated socket. A newcomer socket wins the slot.
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

    // Clear offline notices only on tracked workspaces; an unreachable one keeps its row for next accept.
    const label = this.deviceLabel(verified.deviceId);

    for (const { agent_name } of this.sqlx<{ agent_name: string }>(
      `SELECT agent_name FROM device_notice_pending`,
    )) {
      try {
        const workspace = this.env.OrchestratorAgent.get(
          this.env.OrchestratorAgent.idFromName(agent_name),
        );

        await workspace.announceDeviceAvailable({ id: verified.deviceId, label });
        this.sqlx(`DELETE FROM device_notice_pending WHERE agent_name = ?`, agent_name);
      } catch (cause) {
        diagnostics.event('device.available_announce_unreachable', {
          workspace: agent_name, error: renderThrownChain({ cause }),
        });
      }
    }

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
   * The session name is the authority: minted once after ownership and consent checks, spent by first
   * attach. An upgrade carries no `UserCaller`, so the check happens in {@link openDeviceTerminal}.
   */
  private acceptTerminalSocket(request: Request, url: URL): Response {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const session = url.searchParams.get('session') ?? '';
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    let attached: { device: string; workspace: string };

    try {
      attached = this._terminals.attach(session, server);
    } catch (cause) {
      // Unknown or taken session is expected (shell ended or object evicted); the pane opens a new one.
      return new Response(renderThrownChain({ cause }), { status: 409 });
    }

    server.send(JSON.stringify({ type: 'ready' }));
    diagnostics.event('device.terminal_attached', { device: attached.device, workspace: attached.workspace });
    const init: ResponseInit & { webSocket: WebSocket } = { status: 101, webSocket: client };

    return new Response(null, init);
  }

  /** A grace is kept only when the machine used the current secret, so two copies of `device.json`
   *  cannot alternate. The absolute window restarts either way. */
  private async rotateDeviceToken(deviceId: string, keepGrace: boolean): Promise<string> {
    const token = `pdt_${randomToken(32)}`;
    const tokenHash = await sha256Hex(token);
    const now = Date.now();

    // Spending the grace retires the secret it replaced.
    if (!keepGrace) {
      const [dropped] = this.sqlx<{ token_hash: string }>(`SELECT token_hash FROM user_devices WHERE id = ?`, deviceId);
      this.retireDeviceTokens(deviceId, [dropped?.token_hash ?? null], now);
    }

    // One statement: right-hand sides read the old row, so `token_hash` is the prior secret.
    this.sqlx(
      `UPDATE user_devices
          SET prev_token_hash = CASE WHEN ? THEN token_hash ELSE NULL END,
              token_hash = ?,
              expires_at = ?
        WHERE id = ?`,
      keepGrace ? 1 : 0, tokenHash, now + DEVICE_TOKEN_TTL_MS, deviceId,
    );

    return token;
  }

  /** Kept for the token lifetime; an incident stays until the owner acknowledges it. */
  private retireDeviceTokens(deviceId: string, hashes: ReadonlyArray<string | null>, now: number): void {
    this.sqlx(
      `DELETE FROM user_device_retired_tokens WHERE retired_at <= ? AND reuse_detected_at IS NULL`,
      now - DEVICE_TOKEN_TTL_MS,
    );

    for (const hash of hashes) {
      if (hash === null) continue;
      this.sqlx(
        `INSERT OR IGNORE INTO user_device_retired_tokens (token_hash, device_id, retired_at) VALUES (?, ?, ?)`,
        hash, deviceId, now,
      );
    }
  }

  /** Two copies of `device.json` exist and the hub cannot tell the owner's (RFC 9700 §4.14.2). */
  private async revokeOnTokenReuse(caller: UserCaller, tokenHash: string): Promise<void> {
    const [reused] = this.sqlx<{ device_id: string }>(
      `UPDATE user_device_retired_tokens SET reuse_detected_at = COALESCE(reuse_detected_at, ?)
        WHERE token_hash = ? AND device_id IN (SELECT id FROM user_devices WHERE revoked_at IS NULL)
        RETURNING device_id`,
      Date.now(), tokenHash,
    );

    if (!reused) return;
    diagnostics.event('device.token_reuse_revoked', { device: reused.device_id });
    await this.revokeDevice(caller, reused.device_id);
  }

  /* These hibernation handlers are declared here, so `Lifecycle.installHandlers` skips them and there
   * is no `super`; foreign sockets are delegated to the lifecycle directly, as `Agent.fetch` does. */
  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer | ArrayBufferView): Promise<void> {
    if (isRosterSocket(ws)) return;
    // Pane bytes are raw keystrokes; decoding them as text would corrupt them.
    const terminal = terminalFromSocket(ws);

    if (terminal) {
      this.ensureInit();
      this._terminals.fromPane(terminal.session, terminal.device, message);

      return;
    }

    const deviceId = deviceIdFromSocket(ws);

    if (!deviceId) return this.lifecycle.webSocketMessage(ws, message);
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

    // Keepalive answered here, not by platform auto-response, which would eat a pasted "ping" to a shell.
    if (data === DEVICE_KEEPALIVE_PING) {
      ws.send(DEVICE_KEEPALIVE_PONG);

      return;
    }

    // Anything not a HELLO (including non-JSON) is treated as an RPC response.
    const hello = v.safeParse(DeviceHelloSchema, tolerate(() => JSON.parse(data), 'malformed-input'));

    if (hello.success) {
      this.recordDeviceHello(deviceId, hello.output);
      const frame = await this.deviceUpdateFrame(hello.output);

      if (frame !== null) {
        diagnostics.event('device.update_pushed', { device: deviceId, from: hello.output.version ?? '', to: frame.version });
        ws.send(JSON.stringify(frame));
      }

      return;
    }

    const acknowledged = v.safeParse(DeviceRotationAckSchema, tolerate(() => JSON.parse(data), 'malformed-input'));

    if (acknowledged.success) {
      const now = Date.now();

      const [grace] = this.sqlx<{ prev_token_hash: string | null }>(
        `SELECT prev_token_hash FROM user_devices WHERE id = ?`, deviceId,
      );

      this.retireDeviceTokens(deviceId, [grace?.prev_token_hash ?? null], now);
      this.sqlx(`UPDATE user_devices SET prev_token_hash = NULL, last_seen_at = ? WHERE id = ?`, now, deviceId);

      return;
    }

    // Terminal frames have no request id; the RPC correlator would silently drop them.
    if (this.handleTerminalFrame(data)) return;
    this._devices.handleMessage(deviceId, data);
  }

  /** Returns true if the frame was a terminal frame (so skip the RPC correlator); exit closes the pane. */
  private handleTerminalFrame(data: string): boolean {
    const frame = v.safeParse(DeviceTerminalFrameSchema, tolerate(() => JSON.parse(data), 'malformed-input'));

    if (!frame.success) return false;

    if (frame.output.type === DEVICE_PTY_OUTPUT) {
      this._terminals.toPane(frame.output.session, bytesFromBase64(frame.output.data));

      return true;
    }

    this._terminals.paneExit(frame.output.session, frame.output.exitCode);

    return true;
  }

  /**
   * Open a terminal on the owner's machine for one workspace; returns the session its pane attaches to.
   * Goes through `deviceRpc` (tier, per-device grant, Sandbox switch); there is no other way to open one.
   */
  async openDeviceTerminal(
    caller: UserCaller,
    agentName: string,
    window: { cols: number; rows: number },
    deviceId?: string,
  ): Promise<{ session: string }> {
    const bounded = (axis: number, fallback: number): number => (
      Number.isInteger(axis) && axis >= 1 && axis <= DEVICE_PTY_MAX_AXIS ? axis : fallback
    );

    // Gate first: a refused caller must not learn whether a machine is connected.
    await this.requireTier(caller, 'device.rpc');
    const session = `pty-${nanoid(16)}`;
    // Resolved before minting: several live devices and none named is an error.
    const target = await this.resolveDeviceForCall(deviceId, undefined);

    try {
      await this.deviceRpc(
        caller,
        DEVICE_PTY_OPEN_METHOD,
        [session, bounded(window.cols, TERMINAL_DEFAULT_AXIS.cols), bounded(window.rows, TERMINAL_DEFAULT_AXIS.rows)],
        { agentName, deviceId: target, timeoutMs: TERMINAL_OPEN_TIMEOUT_MS },
      );
    } catch (cause) {
      // An install too old for terminals gets an actionable message; other failures pass through.
      if (isDeviceUnknownMethodError({ cause })) {
        throw new Error(`${this.deviceLabel(target)} runs an older Kinu. Run \`kinu update\` on that machine.`, { cause });
      }

      throw new Error('opening a terminal on this machine', { cause });
    }

    this._terminals.register(session, target, agentName);

    // Unattached sessions are swept on the next open: this object's one alarm belongs to other work.
    for (const stale of this._terminals.expired()) this.closeDeviceTerminal(stale.session, stale.device);

    return { session };
  }

  private closeDeviceTerminal(session: string, device: string): void {
    try {
      this._terminals.paneClosed(session, device);
    } catch (cause) {
      // The machine's socket dropped, which already ended every terminal on it.
      diagnostics.event('device.terminal_close_unsent', { device, error: renderThrownChain({ cause }) });
    }
  }

  /**
   * Record a daemon's HELLO. Paths and agent root COALESCE so an older daemon can't erase them;
   * the sandbox verdict is per-boot, so silence overwrites a stale yes.
   */
  private recordDeviceHello(deviceId: string, hello: v.InferOutput<typeof DeviceHelloSchema>): void {
    const agentRoot = absolutePathOrNull(hello.agentRoot);
    const verdict = sandboxVerdictFromHello(hello, agentRoot);
    this.sqlx(
      `UPDATE user_devices
          SET os = ?, hostname = ?, last_seen_at = ?,
              consented_root = COALESCE(?, consented_root),
              device_home = COALESCE(?, device_home),
              agent_root = COALESCE(?, agent_root),
              sandbox_capability = ?, sandbox_reason = ?, sandbox_detail = ?, sandbox_gpu = ?
        WHERE id = ?`,
      hello.os ?? null,
      hello.hostname !== undefined && hello.hostname.length <= HOSTNAME_MAX_LENGTH ? hello.hostname : null,
      Date.now(),
      absolutePathOrNull(hello.root),
      absolutePathOrNull(hello.home),
      agentRoot,
      verdict.capability,
      verdict.reason,
      verdict.detail,
      JSON.stringify(hello.sandbox?.gpu ?? []),
      deviceId,
    );

    // Per-boot fact like the sandbox verdict: silence overwrites, so an older CLI reads as itself.
    this.sqlx(
      `INSERT INTO user_device_builds (device_id, version, update_check, reported_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET
           version = excluded.version,
           update_check = excluded.update_check,
           reported_at = excluded.reported_at`,
      deviceId,
      hello.version ?? null,
      hello.updateCheck === false ? 0 : 1,
      Date.now(),
    );
  }

  /** Null when the deploy published no stamp or names no public origin. Read per HELLO: the stamp
   * changes with every deploy. */
  private async servedBuild(): Promise<string | null> {
    return (await this.servedStamp())?.version ?? null;
  }

  private async servedStamp(): Promise<BuildStamp | null> {
    const origin = this.env.CLI_PUBLIC_ORIGIN;

    if (!origin) return null;

    return readBuildStamp(this.env, origin);
  }

  /**
   * UPDATE frame for a daemon behind the served build, when its owner allows the push.
   * Null for no reported build, unbuilt platform, opted-out owner, or no checksum.
   */
  private async deviceUpdateFrame(hello: v.InferOutput<typeof DeviceHelloSchema>): Promise<DeviceUpdateFrame | null> {
    const stamp = await this.servedStamp();
    const served = stamp?.version ?? null;
    const state = deviceUpdateState({ version: hello.version ?? null, updateCheck: hello.updateCheck !== false }, served);

    if (state !== 'behind' || served === null || stamp === null) return null;
    const tarball = cliArtifactPath(hello.os, hello.arch);

    if (tarball === null) return null;
    // No signature over this artifact means no push: the daemon would refuse it.
    const sha256 = stamp.checksums?.[tarball];

    if (stamp.signature === undefined || stamp.checksums === undefined || sha256 === undefined || !/^[0-9a-f]{64}$/i.test(sha256)) return null;

    return {
      type: DEVICE_UPDATE, version: served, urls: { tarball, checksum: `${tarball}.sha256` }, sha256: sha256.toLowerCase(),
      checksums: stamp.checksums, signature: stamp.signature,
    };
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    if (isRosterSocket(ws)) return;
    // A pane's socket closing hangs up the shell rather than leaving it running with no window.
    const terminal = terminalFromSocket(ws);

    if (terminal) {
      this.ensureInit();
      this.closeDeviceTerminal(terminal.session, terminal.device);

      return;
    }

    const deviceId = deviceIdFromSocket(ws);

    if (!deviceId) return this.lifecycle.webSocketClose(ws, code, reason, wasClean);
    this.ensureInit();
    this._devices.handleClose(deviceId, ws);

    // The daemon hangs up its shells when the socket drops, so tell the panes.
    for (const session of this._terminals.panesForDevice(deviceId)) {
      this._terminals.endPane(session, NO_DEVICE_CONNECTED);
    }

    // A replacing socket may already be live — only then keep connected_at.
    if (!this._devices.isConnected(deviceId)) {
      this.sqlx(`UPDATE user_devices SET connected_at = NULL WHERE id = ?`, deviceId);
    }
  }

  override async webSocketError(...call: Parameters<NonNullable<Agent<Env>['webSocketError']>>): Promise<void> {
    const [ws] = call;

    // Device sockets clean up in webSocketClose, which the runtime fires next.
    if (!deviceIdFromSocket(ws) && !isRosterSocket(ws)) return this.lifecycle.webSocketError(...call);
  }

  /** The raw token is returned once to the CLI; only its hash is stored. 'Your PC' is the default
   * label. `replaces` is the machine's previous token, whose registration this one replaces. */
  async registerDevice(caller: UserCaller, label?: string, replaces?: string): Promise<{ deviceId: string; token: string }> {
    await this.requireTier(caller, 'device.manage');
    const replaced = replaces === undefined ? null : await this.deviceHoldingToken(caller, replaces);
    const deviceId = `dev-${nanoid(10)}`;
    const token = `pdt_${randomToken(32)}`;
    const tokenHash = await sha256Hex(token);
    const now = Date.now();
    const trimmedLabel = label?.trim().slice(0, DEVICE_NAME_MAX_LENGTH) ?? '';
    this.sqlx(
      `INSERT INTO user_devices (id, token_hash, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
      deviceId, tokenHash, trimmedLabel === '' ? 'Your PC' : trimmedLabel, now, now + DEVICE_TOKEN_TTL_MS,
    );

    if (replaced !== null) await this.revokeDevice(caller, replaced);

    return { deviceId, token };
  }

  /** Expired or not, holding the token proves the caller had that machine's `device.json`. */
  private async deviceHoldingToken(caller: UserCaller, token: string): Promise<string | null> {
    if (!MINTED_DEVICE_TOKEN.test(token)) return null;
    const tokenHash = await sha256Hex(token);

    const [held] = this.sqlx<{ id: string }>(
      `SELECT id FROM user_devices WHERE (token_hash = ? OR prev_token_hash = ?) AND revoked_at IS NULL LIMIT 1`,
      tokenHash, tokenHash,
    );

    if (held) return held.id;
    await this.revokeOnTokenReuse(caller, tokenHash);

    return null;
  }

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

  /** The window is absolute from the last rotation; the superseded secret is a one-shot grace
   *  (see {@link acceptDeviceSocket}); `current` says which hash matched. */
  async verifyDeviceToken(caller: UserCaller, token: string): Promise<{ ok: boolean; deviceId?: string; current?: boolean }> {
    await this.requireTier(caller, 'device.manage');

    if (!MINTED_DEVICE_TOKEN.test(token)) return { ok: false };
    const tokenHash = await sha256Hex(token);

    const row = this.sqlx<{ id: string; expires_at: number | null; current: number; prev_token_hash: string | null }>(
      `SELECT id, expires_at, (token_hash = ?) AS current, prev_token_hash
         FROM user_devices
        WHERE (token_hash = ? OR prev_token_hash = ?) AND revoked_at IS NULL
        LIMIT 1`,
      tokenHash, tokenHash, tokenHash,
    )[0];

    if (!row) {
      await this.revokeOnTokenReuse(caller, tokenHash);

      return { ok: false };
    }

    if (row.expires_at !== null && row.expires_at <= Date.now()) return { ok: false };

    // Spent on the ticket it buys: a machine whose connect then fails is refused, not revoked.
    if (row.current === 1) this.retireDeviceTokens(row.id, [row.prev_token_hash], Date.now());
    this.sqlx(`UPDATE user_devices SET prev_token_hash = NULL WHERE id = ?`, row.id);

    return { ok: true, deviceId: row.id, current: row.current === 1 };
  }

  /** Exchange the daemon's long-lived token for a one-minute, single-use WebSocket ticket scoped to
   *  this UserDO. */
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

    // A null column (ticket predating it) reads as not proved current, so no grace is granted.
    return { ok: true, deviceId: row.device_id, tokenWasCurrent: row.token_was_current === 1 };
  }

  /** User-chosen names of live machines only; ids are routing, not for a person. */
  private connectedDeviceNames(): string[] {
    const live = this._devices.connectedDeviceIds();

    return this.sqlx<{ id: string; label: string }>(
      `SELECT id, label FROM user_devices WHERE revoked_at IS NULL`,
    ).filter((row) => live.includes(row.id)).map((row) => row.label);
  }

  private deviceLabel(deviceId: string): string {
    return this.sqlx<{ label: string }>(`SELECT label FROM user_devices WHERE id = ?`, deviceId)[0]?.label ?? 'your device';
  }

  private isActiveDevice(deviceId: string): boolean {
    return this.sqlx<{ id: string }>(
      `SELECT id FROM user_devices WHERE id = ? AND revoked_at IS NULL LIMIT 1`, deviceId,
    )[0] !== undefined;
  }

  /**
   * Unnamed call resolves to the only live machine; several live is an error naming them.
   * With none live, a workspace op is told the registered machines; `undefined` just reports none.
   */
  private async resolveDeviceForCall(
    requested: string | undefined,
    consentAgent: string | undefined,
  ): Promise<string> {
    const deviceId = this.liveDeviceForCall(requested);

    if (deviceId) return deviceId;

    if (consentAgent !== undefined) await this.announceDevicesUnavailable(consentAgent);

    throw new Error(NO_DEVICE_CONNECTED);
  }

  /** Revoked rows are excluded: revoked means gone, not offline. */
  private registeredOfflineDevices(): Array<{ id: string; label: string; lastSeenAt: number | null }> {
    const live = new Set(this._devices.connectedDeviceIds());

    return this.sqlx<{ id: string; label: string; last_seen_at: number | null }>(
      `SELECT id, label, last_seen_at FROM user_devices WHERE revoked_at IS NULL ORDER BY created_at ASC`,
    ).filter((row) => !live.has(row.id)).map((row) => ({
      id: row.id, label: row.label, lastSeenAt: row.last_seen_at,
    }));
  }

  /** The call still fails; the workspace is recorded so the next connect clears this notice. */
  private async announceDevicesUnavailable(workspaceOrAgent: string): Promise<void> {
    try {
      const stub = this.env.OrchestratorAgent.get(this.env.OrchestratorAgent.idFromName(workspaceOrAgent));

      await stub.announceDeviceUnavailable(this.registeredOfflineDevices());
      this.sqlx(
        `INSERT INTO device_notice_pending (agent_name, announced_at) VALUES (?, ?)
         ON CONFLICT (agent_name) DO UPDATE SET announced_at = excluded.announced_at`,
        workspaceOrAgent, Date.now(),
      );
    } catch (error) {
      diagnostics.event('device.unavailable_announce_unreachable', {
        workspace: workspaceOrAgent, error: renderThrownChain({ cause: error }),
      });
    }
  }

  /** Null when none qualifies; an unnamed call with several live is reported as ambiguous. */
  private liveDeviceForCall(requested: string | undefined): string | null {
    const deviceId = this._devices.connectedDeviceId(requested);

    if (deviceId) return deviceId;

    if (requested === undefined && this._devices.connectedDeviceIds().length > 1) {
      throw new Error(`${SEVERAL_DEVICES_CONNECTED}: ${this.connectedDeviceNames().join(', ')}`);
    }

    return null;
  }

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
    const proven = resolved.kind === 'workspace' ? resolved.workspace : null;

    if (proven !== null && Object.hasOwn(CHECKPOINT_STORE_METHODS, method) && params[0] !== proven) {
      throw new Error(`workspace ${proven} reads and restores only its own device checkpoints`);
    }

    // Cancellation is never consent-gated: it only ends a command already allowed, and
    // gating it could leave a live process waiting on an unanswered card.
    const stopping = method === DEVICE_CANCEL_METHOD;
    const ownerRead = opts?.agentName === undefined && Object.hasOwn(CONSENT_FREE_DEVICE_METHODS, method);

    const consentAgent = consentAgentFor(resolved, opts?.agentName, { stopping, ownerRead });

    const deviceId = await this.resolveDeviceForCall(opts?.deviceId, consentAgent);

    if (!stopping && !this.isActiveDevice(deviceId)) throw new Error(NO_DEVICE_CONNECTED);

    if (consentAgent !== undefined) {
      // Consent is keyed on the proven workspace, never the claimed name, so an agent cannot
      // ride a sibling workspace's grant.
      const consent = await this.checkDeviceConsent({
        agentName: consentAgent, deviceId, method, params,
        workspaceName: resolved.kind === 'workspace' ? resolved.workspace : undefined,
      });

      if (!consent.allowed) throw new Error(consent.reason);
    }

    const frameSandbox = Object.hasOwn(DEVICE_VIEW_METHODS, method) ? this.frameSandboxFor(method, deviceId, proven) : null;

    if (!stopping && !this.isActiveDevice(deviceId)) throw new Error(NO_DEVICE_CONNECTED);
    const tunnel = this._devices.tunnel(deviceId);

    if (!tunnel) throw new Error(NO_DEVICE_CONNECTED);
    const rpcOptions: NonNullable<Parameters<typeof tunnel.rpc>[2]> = { extra: { deviceId } };

    if (opts?.checkpoint) {
      rpcOptions.extra = {
        ...rpcOptions.extra,
        checkpoint: {
          agent: proven ?? opts.checkpoint.agent,
          turnId: opts.checkpoint.turnId,
          sessionId: opts.checkpoint.sessionId,
          dir: opts.checkpoint.dir,
        },
      };
    }

    if (frameSandbox !== null) rpcOptions.extra = { ...rpcOptions.extra, sandbox: frameSandbox };

    if (opts?.timeoutMs !== undefined) rpcOptions.timeoutMs = opts.timeoutMs;

    if (opts?.requestId !== undefined) rpcOptions.requestId = opts.requestId;

    // Persist before sending: an insert after send races with eviction. Only a proven
    // workspace command carries a durable turn identity.
    const requestId = opts?.requestId;
    const durableExec = method === 'exec' && requestId !== undefined && resolved.kind === 'workspace';

    if (durableExec) {
      // Probe with a fresh id, never the command's own: ACKing a retry's id before replay
      // would delete its retained terminal result.
      await tunnel.rpc(DEVICE_EXEC_ACK_METHOD, [nextDeviceRequestId(), DEVICE_CANCEL_PROTOCOL]);

      // A revocation sweep can land during the probe await; recheck so no command runs
      // with nothing left to cancel or count it.
      if (!this.isActiveDevice(deviceId)) throw new Error(NO_DEVICE_CONNECTED);
      // A command inside a detached scope belongs to the background job from insert.
      // A blank owner is refused: neither turn nor job sweep could ever select that row.
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

    // A tool's own cancel is recorded where a sweep would put it; the first answer wins.
    if (stopping) this.recordToolPathCancellation(params, result);

    return result === undefined ? undefined : JSON.stringify(result);
  }

  /** `agentHome` is empty only under the raw tier. */
  private frameSandboxFor(method: string, deviceId: string, workspace: string | null): JsonObject {
    const sandbox = this.deviceSandboxFor(deviceId, workspace);

    // Neither end ever downgrades a sandboxed command to raw; files need no kernel.
    if ((method === 'exec' || method === DEVICE_PTY_OPEN_METHOD) && effectiveDeviceMode(sandbox) === 'files_only') {
      throw new Error(this.sandboxRefusal(deviceId, sandbox, sandboxCause(sandbox)));
    }

    if (sandbox.tier === 'sandboxed' && sandbox.agentHome === null) {
      throw new Error(this.sandboxRefusal(deviceId, sandbox, workspace === null
        ? 'an agent home belongs to a workspace, and this call has none'
        : 'the daemon did not report where agent homes live'));
    }

    return { tier: sandbox.tier, agentHome: sandbox.agentHome ?? '', roots: [...sandbox.roots] };
  }

  /** Store the answer from a forwarded cancellation so the durable authority holds one outcome per request.
   *  An answer that does not name the requested id is neither stored nor returned; the row stays live. */
  private recordToolPathCancellation(params: JsonValue[], result: JsonValue | undefined): void {
    const requestId = v.safeParse(CancelledRequestIdSchema, params[0]);

    if (!requestId.success) return;
    const answer = parseDeviceCancelAnswer(requestId.output, result);
    this.ensureInit();
    this._inflight.settleUnclaimed(requestId.output, answer.cancelled);
  }

  /**
   * Cloud-side acceptance of one exec result: acks the daemon, then removes the durable row.
   * A claimed row belongs to an in-flight cancellation, which owns the terminal outcome and ack.
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
   * Stop every live device command of one durable turn after a fresh actor activation.
   * Rows with no turn id are excluded so Stop never widens into a workspace sweep.
   */
  async cancelDeviceRequestsForTurn(
    caller: UserCaller,
    turnId: string,
  ): Promise<DeviceCancellationOutcome[]> {
    // Claim atomically before any device await, so a parallel detach to a background job
    // cannot race this sweep.
    return this.cancelClaimedDeviceRequests(caller, turnId,
      (workspace) => this._inflight.claimTurnRequests(workspace, turnId));
  }

  private async cancelClaimedDeviceRequests(
    caller: UserCaller,
    scopeId: string,
    claim: (workspace: string) => ClaimedDeviceRequest[],
  ): Promise<DeviceCancellationOutcome[]> {
    const resolved = await this.requireTier(caller, 'device.rpc');

    if (resolved.kind !== 'workspace' || scopeId === '') return [];

    return this.cancelDeviceRequests(claim(resolved.workspace));
  }

  /** Move one live device request to its background job; per request because a turn can hold
   *  several parallel device calls and only the detaching one changes hands. */
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

  async cancelDeviceRequestsForBackgroundJob(
    caller: UserCaller,
    jobId: string,
  ): Promise<DeviceCancellationOutcome[]> {
    return this.cancelClaimedDeviceRequests(caller, jobId,
      (workspace) => this._inflight.claimBackgroundJobRequests(workspace, jobId));
  }

  private async cancelDeviceRequests(rows: ClaimedDeviceRequest[]): Promise<DeviceCancellationOutcome[]> {
    const outcomes: DeviceCancellationOutcome[] = [];

    for (const row of rows) {
      // Re-read before any frame: ownership or an answer (e.g. from a tool's own abort via
      // `deviceRpc`) may have changed while an earlier row was awaiting.
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

        // Persist before the ack, which can fail. No row updated means the terminal authority took
        // the claim and reports the request; the returned answer is the one that stands.
        const settled = this._inflight.settleHeld(row.requestId, row.claim, answer);

        if (settled === null) continue;
        outcomes.push({ requestId: row.requestId, outcome: settled });
        await this.cleanUpSettledDeviceRequest(row);
      } catch (err) {
        // Kill failed, so the request is still live. Releasing nothing means the terminal authority
        // took or dropped the row and answers for it.
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
   * Release the daemon's supervisor, then drop the row. Cleanup failure is not cancellation
   * failure: the stored answer stands and the claim is returned so a later sweep can retry.
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


  /** Agent home is composed per call from the root the daemon reported, for one workspace segment. */
  private deviceSandboxFor(deviceId: string, workspace: string | null): DeviceSandboxStatus & { deviceHome: string | null } {
    const row = this.sqlx<SandboxColumns & { tier: string | null; agent_root: string | null; consented_root: string | null; device_home: string | null }>(
      `SELECT tier, sandbox_capability, sandbox_reason, sandbox_detail, sandbox_gpu, agent_root, consented_root, device_home
         FROM user_devices WHERE id = ?`, deviceId,
    )[0];

    const agentRoot = row?.agent_root ?? null;
    const named = workspace !== null && isWorkspaceName(workspace) && workspace !== '.' && workspace !== '..';
    const consented = row?.consented_root ?? null;

    return {
      // Consent to `/` is the whole machine: the switch off.
      tier: consented === '/' ? 'raw' : parseDeviceTier(row?.tier),
      ...readSandboxColumns(row),
      agentHome: agentRoot !== null && named ? `${agentRoot}/${workspace}/home` : null,
      roots: consented === null ? [] : [consented],
      deviceHome: row?.device_home ?? null,
    };
  }

  private sandboxRefusal(deviceId: string, sandbox: DeviceSandboxStatus, cause: string): string {
    return `${SANDBOX_UNAVAILABLE}: ${this.deviceLabel(deviceId)} cannot run commands — `
      + `its Kinu daemon could not start a sandbox (${cause}), and Kinu never runs a command `
      + `unsandboxed unless the owner asked for that. ${sandboxReasonFix(sandbox.reason)} `
      + 'The owner can also turn Sandbox off for this device on the Devices page, '
      + 'which runs commands as them with full access to the machine. '
      + 'Reading and writing files on the device still works.';
  }

  /** Owner session only: a workspace holding `device.manage` must not turn off its own sandbox. */
  async setDeviceTier(caller: UserCaller, deviceId: string, tier: DeviceTier): Promise<{ ok: boolean }> {
    const resolved = await this.requireTier(caller, 'device.manage');

    if (resolved.kind !== 'owner_session') {
      throw new CapabilityDeniedError('Only the account owner can change a device\'s Sandbox setting.');
    }

    if (!v.is(v.picklist(DEVICE_TIERS), tier)) return { ok: false };

    const row = this.sqlx<{ id: string }>(
      `SELECT id FROM user_devices WHERE id = ? AND revoked_at IS NULL LIMIT 1`, deviceId,
    )[0];

    if (!row) return { ok: false };
    this.sqlx(`UPDATE user_devices SET tier = ? WHERE id = ?`, tier, deviceId);

    return { ok: true };
  }

  /** No tier here: what a bound workspace may touch is the device's Sandbox switch, owner-set. */
  private getDeviceBinding(agentName: string, deviceId: string): 'allow' | 'deny' | null {
    const row = this.sqlx<{ policy: string }>(
      `SELECT policy FROM device_consent WHERE agent_name = ? AND device_id = ?`, agentName, deviceId,
    )[0];

    if (row?.policy !== 'allow' && row?.policy !== 'deny') return null;

    return row.policy;
  }

  private setDeviceBinding(
    agentName: string,
    deviceId: string,
    policy: 'allow' | 'deny',
    lastAction?: { method: string; command: string },
  ): void {
    this.sqlx(
      `INSERT INTO device_consent
         (agent_name, device_id, policy, last_method, last_summary, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_name, device_id) DO UPDATE SET
         policy = excluded.policy,
         last_method = excluded.last_method,
         last_summary = excluded.last_summary,
         updated_at = excluded.updated_at`,
      agentName, deviceId, policy,
      lastAction?.method ?? null, lastAction?.command ?? null, Date.now(),
    );
  }

  /**
   * Is this workspace bound to this device? Fails closed, but `reason` distinguishes a refusal from
   * an unanswered prompt, so an unattended agent does not read an expiry as a revoked capability.
   */
  private async checkDeviceConsent(check: DeviceConsentCheck): Promise<{ allowed: true } | { allowed: false; reason: string }> {
    const { agentName, deviceId, method, params, workspaceName } = check;

    const bound = this.getDeviceBinding(agentName, deviceId);

    if (bound === 'allow') return { allowed: true };

    if (bound === 'deny') return { allowed: false, reason: DEVICE_CONSENT_DENIED };
    const action = summarizeDeviceAction(method, params);
    let decision: DeviceConsentDecision;

    try {
      const stub = this.env.OrchestratorAgent.get(this.env.OrchestratorAgent.idFromName(agentName));

      const base: DeviceConsentRequest = {
        deviceId,
        deviceLabel: this.deviceLabel(deviceId),
        method: action.method,
        command: action.command,
      };

      const request: DeviceConsentRequest = workspaceName
        ? { ...base, workspaceName }
        : base;

      decision = await stub.awaitDeviceConsent(request);
    } catch (error) {
      // Nobody was asked, so this is the unanswered case, not a refusal.
      diagnostics.event('device.consent_unreachable', { error: renderThrownChain({ cause: error }) });

      return { allowed: false, reason: DEVICE_CONSENT_UNANSWERED };
    }

    // Only "always" is remembered; "once", "deny" and "timeout" are per-call.
    if (decision === 'deny') return { allowed: false, reason: DEVICE_CONSENT_DENIED };

    if (decision === 'timeout') return { allowed: false, reason: DEVICE_CONSENT_UNANSWERED };

    if (decision === 'always') this.setDeviceBinding(agentName, deviceId, 'allow', action);

    return { allowed: true };
  }


  async listDeviceConsents(caller: UserCaller): Promise<Array<{
    agentName: string;
    deviceId: string;
    policy: string;
    lastMethod: string | null;
    lastSummary: string | null;
  }>> {
    await this.requireTier(caller, 'device.consent');

    return this.sqlx<{
      agent_name: string; device_id: string; policy: string;
      last_method: string | null; last_summary: string | null;
    }>(
      `SELECT agent_name, device_id, policy, last_method, last_summary
       FROM device_consent ORDER BY updated_at DESC`,
    ).map((r) => ({
      agentName: r.agent_name,
      deviceId: r.device_id,
      policy: r.policy,
      lastMethod: r.last_method,
      lastSummary: r.last_summary,
    }));
  }

  /** Deletes the row (not 'deny') so the next call asks again; takes effect on that next call.
   *  Not a stop: running commands continue. `revokeDevice` ends live commands. */
  async revokeDeviceConsent(caller: UserCaller, agentName: string, deviceId: string): Promise<{ ok: boolean }> {
    await this.requireTier(caller, 'device.consent');

    if (!agentName || !deviceId) return { ok: false };
    this.sqlx(`DELETE FROM device_consent WHERE agent_name = ? AND device_id = ?`, agentName, deviceId);

    return { ok: true };
  }

  /** Unconfined only when the owner turned the device's Sandbox switch off; one switch governs
   *  both the daemon and the hub-side path scope so shell and file views cannot drift. */
  async getDeviceFileView(
    caller: UserCaller, agentName: string, device?: string,
  ): Promise<{ scope: DeviceFileScope }> {
    const resolved = await this.requireTier(caller, 'device.consent.read_self');
    // Per machine. Unnamed resolves the only live machine; several with none named is "confined".
    const deviceId = this._devices.connectedDeviceId(device);

    if (!deviceId) return { scope: 'root' };
    // A workspace caller's identity is its token, never its argument, so a facet cannot read a
    // sibling's answer.
    const workspace = resolved.kind === 'workspace' ? resolved.workspace : agentName;
    const { tier } = this.deviceSandboxFor(deviceId, workspace);

    if (tier === 'sandboxed') return { scope: 'sandboxed' };

    return { scope: this.getDeviceBinding(workspace, deviceId) === 'allow' ? 'unconfined' : 'root' };
  }

  /** Revoked rows are hidden, except those with an incident, visible until the owner acknowledges
   *  them; `revokedAt` tells the UI not to offer connect/rename controls. */
  async listDevices(caller: UserCaller): Promise<Array<{
    id: string; label: string; os: string | null; hostname: string | null;
    connected: boolean; createdAt: number; lastSeenAt: number | null; expiresAt: number | null;
    lastIp: string | null; lastAgent: string | null; replacedAt: number | null;
    revokedAt: number | null; unstoppedAt: number | null; reuseDetectedAt: number | null;
    wholeMachine: boolean;
    /** No home or roots here: those are per workspace, and this is the account's device registry. */
    sandbox: Pick<DeviceSandboxStatus, 'tier' | 'capability' | 'reason' | 'detail' | 'gpu'>;
    version: string | null;
    servedVersion: string | null;
    update: DeviceUpdateState;
  }>> {
    await this.requireTier(caller, 'device.manage');
    const served = await this.servedBuild();

    return this.sqlx<SandboxColumns & {
      id: string; label: string; os: string | null; hostname: string | null;
      created_at: number; last_seen_at: number | null; expires_at: number | null;
      last_ip: string | null; last_agent: string | null; replaced_at: number | null;
      revoked_at: number | null; unstopped_at: number | null; reuse_detected_at: number | null;
      tier: string | null; version: string | null; update_check: number | null; consented_root: string | null;
    }>(`SELECT d.id, d.label, d.os, d.hostname, d.created_at, d.last_seen_at, d.expires_at,
               d.last_ip, d.last_agent, d.replaced_at, d.revoked_at, d.unstopped_at, x.reuse_detected_at,
               d.consented_root,
               d.tier, d.sandbox_capability, d.sandbox_reason, d.sandbox_detail, d.sandbox_gpu,
               b.version, b.update_check
          FROM user_devices d
          LEFT JOIN user_device_builds b ON b.device_id = d.id
          LEFT JOIN (SELECT device_id, MAX(reuse_detected_at) AS reuse_detected_at
                       FROM user_device_retired_tokens WHERE reuse_detected_at IS NOT NULL
                      GROUP BY device_id) x ON x.device_id = d.id
         WHERE d.revoked_at IS NULL OR d.unstopped_at IS NOT NULL OR x.reuse_detected_at IS NOT NULL
         ORDER BY d.created_at DESC`)
      .map((r) => ({
        id: r.id, label: r.label, os: r.os, hostname: r.hostname,
        connected: r.revoked_at === null && this._devices.isConnected(r.id),
        createdAt: r.created_at, lastSeenAt: r.last_seen_at, expiresAt: r.expires_at,
        lastIp: r.last_ip, lastAgent: r.last_agent, replacedAt: r.replaced_at,
        revokedAt: r.revoked_at, unstoppedAt: r.unstopped_at, reuseDetectedAt: r.reuse_detected_at,
        wholeMachine: r.consented_root === '/',
        sandbox: { tier: parseDeviceTier(r.tier), ...readSandboxColumns(r) },
        version: r.version,
        servedVersion: served,
        update: deviceUpdateState({ version: r.version, updateCheck: r.update_check !== 0 }, served),
      }));
  }

  /**
   * Toolchain is probed on status read, not in the HELLO handler: the reply arrives on that socket,
   * so awaiting it there would deadlock. Kept separate from `listDevices` to avoid a device round-trip.
   */
  async deviceRuntimeStatus(caller: UserCaller): Promise<DeviceStatus> {
    const resolved = await this.requireTier(caller, 'device.rpc');
    const workspace = resolved.kind === 'workspace' ? resolved.workspace : null;
    // Names and liveness are visible before any grant; seeing grants nothing, every call still goes
    // through the consent chokepoint. Answered per machine: each has its own toolchain, sandbox, grant.
    const now = Date.now();

    const devices = await Promise.all(this.deviceFleet().map(async (device): Promise<DeviceFleetEntry> => {
      if (!device.connected) return device;
      // The sandbox verdict query already holds the consented root and device home; no second SELECT.
      const { deviceHome, ...sandbox } = this.deviceSandboxFor(device.id, workspace);

      const reach: DeviceFleetEntry = {
        ...device,
        toolchain: await this._devices.probeToolchain(device.id, now),
        sandbox,
        consentedRoot: sandbox.roots[0] ?? null,
        deviceHome,
      };

      return workspace === null
        ? reach
        : { ...reach, granted: this.getDeviceBinding(workspace, device.id) === 'allow' };
    }));

    const live = devices.filter((device) => device.connected);

    if (live.length === 0) {
      return { connected: false, registered: devices.length > 0, toolchain: null, devices };
    }

    // Single-machine fields are absent when several machines are live; per-device entries carry them.
    if (live.length > 1) return { connected: true, registered: true, toolchain: null, devices };
    const only = live[0];

    if (!only) return { connected: false, registered: devices.length > 0, toolchain: null, devices };

    const status: DeviceStatus = {
      connected: true,
      registered: true,
      toolchain: only.toolchain ?? null,
      devices,
      consentedRoot: only.consentedRoot ?? null,
      deviceHome: only.deviceHome ?? null,
      // Per caller, not per device: home and roots depend on the workspace.
      sandbox: only.sandbox,
    };

    if (only.granted !== undefined) status.workspaceGranted = only.granted;

    return status;
  }

  /** Pre-grant view of registered devices. Order is newest first and stable across reads:
   *  two renders of the same fleet must be the same bytes. */
  private deviceFleet(): DeviceFleetEntry[] {
    return this.sqlx<{ id: string; label: string; os: string | null; hostname: string | null }>(
      `SELECT id, label, os, hostname FROM user_devices
        WHERE revoked_at IS NULL ORDER BY created_at DESC, id ASC`,
    ).map((r) => ({
      id: r.id,
      name: r.label,
      os: r.os,
      hostname: r.hostname,
      connected: this._devices.isConnected(r.id),
    }));
  }

  /** Records every unconfirmed command on the owner-visible device row before removing its active row,
   *  since a revoked daemon cannot reconnect to act on it. A close is not proof a process stopped. */
  async revokeDevice(
    caller: UserCaller,
    deviceId: string,
  ): Promise<{ ok: boolean; unstoppedCommands: number }> {
    await this.requireTier(caller, 'device.manage');
    // Coalesce concurrent revokes of one device: two sweeps sharing the row could let a confirmed
    // sweep erase unconfirmed commands the other reported. A DO serializes nothing across an await.
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
    // Close admission before the first cancellation await; a device RPC resuming after its consent
    // await rechecks this durable state before send.
    this.sqlx(
      `UPDATE user_devices SET revoked_at = ?, connected_at = NULL
        WHERE id = ? AND revoked_at IS NULL`,
      now, deviceId,
    );
    // Revocation takes the claim from any in-flight sweep; a displaced sweep keeps reporting what it
    // observed and its guarded cleanup finds the row already gone.
    const rows = this._inflight.claimEveryRequestOf(deviceId);

    // Written before the first await so an activation dying mid-sweep leaves a visible unconfirmed
    // marker. `now` is this sweep's provisional value; only it is cleared on success.
    if (rows.length > 0) {
      this.sqlx(`UPDATE user_devices SET unstopped_at = ? WHERE id = ?`, now, deviceId);
    }

    let unstoppedCommands = 0;
    const tunnel = this._devices.tunnel(deviceId);

    for (const row of rows) {
      // A stored answer means nothing runs under this request, so it is not an unstopped command;
      // its cleanup is still owed.
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

          // Durable before the acknowledgement, so a dying activation leaves an answer, not
          // apparent live work.
          this._inflight.settleRevoked(row.requestId, answer);
        }

        try {
          await tunnel.rpc(DEVICE_EXEC_ACK_METHOD, [row.requestId, DEVICE_CANCEL_PROTOCOL]);
        } catch (err) {
          // Kill confirmation is already truthful; this is local replay cleanup, recorded separately so a
          // failed ACK never reads as a possibly running process.
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

    // Only a sweep that swept rows may set or clear the marker; a later revoke of an already-revoked
    // device must not retract an earlier incident, which only the owner may clear.
    if (unstoppedCommands > 0) {
      this.sqlx(`UPDATE user_devices SET unstopped_at = ? WHERE id = ?`, now, deviceId);
    } else if (rows.length > 0) {
      this.sqlx(`UPDATE user_devices SET unstopped_at = NULL WHERE id = ?`, deviceId);
    }

    this._inflight.deleteEveryRequestOf(deviceId);
    // A revoked device is unreachable; drop its grants so the owner's audited roster shows only live
    // permissions.
    this.sqlx(`DELETE FROM device_consent WHERE device_id = ?`, deviceId);
    this._devices.close(deviceId, 'device revoked');
    this.deleteRevokedDeviceWithoutIncident(deviceId);

    return { ok: true, unstoppedCommands };
  }

  private deleteRevokedDeviceWithoutIncident(deviceId: string): boolean {
    return this.sqlx<{ id: string }>(
      `DELETE FROM user_devices
        WHERE id = ? AND revoked_at IS NOT NULL AND unstopped_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM user_device_retired_tokens
                           WHERE device_id = user_devices.id AND reuse_detected_at IS NOT NULL)
        RETURNING id`,
      deviceId,
    ).length === 1;
  }

  /** Clears a revoked device's incidents, removing its row. Refused while request rows remain: the
   *  sweep has not decided. */
  async acknowledgeUnstoppedDevice(caller: UserCaller, deviceId: string): Promise<{ ok: boolean }> {
    await this.requireTier(caller, 'device.manage');

    if (this._inflight.hasRequestsFor(deviceId)) return { ok: false };

    const [incident] = this.sqlx<{ id: string }>(
      `SELECT id FROM user_devices d
        WHERE id = ? AND revoked_at IS NOT NULL
          AND (unstopped_at IS NOT NULL OR EXISTS (SELECT 1 FROM user_device_retired_tokens r
                                                    WHERE r.device_id = d.id AND r.reuse_detected_at IS NOT NULL))`,
      deviceId,
    );

    if (!incident) return { ok: false };
    this.sqlx(`DELETE FROM user_device_retired_tokens WHERE device_id = ?`, deviceId);
    this.sqlx(`UPDATE user_devices SET unstopped_at = NULL WHERE id = ?`, deviceId);

    return { ok: this.deleteRevokedDeviceWithoutIncident(deviceId) };
  }

  private experienceLibrary() {
    this.ensureInit();

    return createExperienceLibrary(this.ctx.storage.sql);
  }

  /**
   * Source workspace comes from the proven caller, never the argument; owner sessions cannot publish.
   */
  async publishExperience(caller: UserCaller, candidate: PublishableCandidate): Promise<ExperienceEntry> {
    const resolved = await this.requireTier(caller, 'experience.write');

    if (resolved.kind !== 'workspace') {
      throw new Error('Only a workspace can publish experience; it publishes under its own name.');
    }

    return this.experienceLibrary().publish(candidate, resolved.workspace);
  }

  /** Excludes the calling workspace's own entries. */
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

  async listCredentials(caller: UserCaller): Promise<CredentialSummary[]> {
    return this.credentialSummaries(await this.requireTier(caller, 'credentials.model'));
  }

  private credentialSummaries(_resolved: ResolvedCaller): CredentialSummary[] {
    return this.sqlx<{ key: string; kind: CredentialSummary['kind']; created_at: number; updated_at: number }>(
      `SELECT key, kind, created_at, updated_at FROM user_credentials ORDER BY key`,
    ).map((r) => ({
        key: r.key,
        kind: r.kind,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
  }

  /** Model-inference credentials survive tainting (headers attach in trusted DO code, never in LLM
   * context); everything else is owner-level. */
  private requireCredentialAccess(caller: UserCaller, key: string): Promise<ResolvedCaller> {
    return this.requireTier(caller, isModelInferenceCredentialKey(key) ? 'credentials.model' : 'credentials.other');
  }

  async setCredential(caller: UserCaller, key: string, credentialJson: Credential | JsonValue): Promise<void> {
    await this.requireTier(caller, 'credentials.other');
    validateCredentialKey(key);

    if (key === CLOUDFLARE_AI_GATEWAY_CRED_KEY) {
      throw new Error(`${CLOUDFLARE_AI_GATEWAY_CRED_KEY} is derived from your Cloudflare login and cannot be stored directly.`);
    }

    const cred = validateCredential({ value: credentialJson });

    if (subscriptionIssuer(key) !== null && cred.kind === 'oauth' && !cred.refreshToken) {
      throw new Error(`${key} requires an OAuth refresh token.`);
    }

    await this.writeCredential(key, cred);

    // Discover AI Gateways right after Cloudflare login so my-gateway works without a settings visit.
    // listAIGateways never throws.
    if (key === CLOUDFLARE_OAUTH_CRED_KEY) await this.listAIGateways(await ownerCaller(this.env));
  }

  async deleteCredential(caller: UserCaller, key: string): Promise<void> {
    await this.requireTier(caller, 'credentials.other');
    validateCredentialKey(key);
    this.dropCredential(key);
  }

  // All reads/writes of `user_credentials.value` go through this pair; the only places plaintext
  // secrets exist in this class (sealed by credential-envelope.ts).

  private _credentialsRewrapped: Promise<void> | null = null;

  private cipher(): Promise<CredentialCipher> {
    return createCredentialCipher(this.env);
  }

  /** AAD binds the DO id (no cross-user reuse) and the credential key (no cross-row moves). */
  private credentialAad(key: string): string {
    return `${this.ctx.id.toString()}:${key}`;
  }

  /** Null when no credential is stored; a stored row that does not open or decode rejects,
   * so callers can tell "not connected" from "connected but unreadable". */
  private async readCredential(key: string): Promise<Credential | null> {
    return (await this.readCredentialAt(key))?.cred ?? null;
  }

  /** The row and its revision, read in one step. */
  private async readCredentialAt(key: string): Promise<{ readonly cred: Credential; readonly revision: number } | null> {
    await this.rewrapCredentials();
    const row = this.sqlx<{ value: string }>(`SELECT value FROM user_credentials WHERE key = ?`, key)[0];
    const revision = this.credentialRevision(key);

    if (!row) return null;
    let plaintext: string;

    try { plaintext = await (await this.cipher()).open(this.credentialAad(key), row.value); }
    catch (err) {
      throw toKinuError({ doing: `opening the stored credential ${key}`, cause: err, otherwise: 'bad_input' });
    }

    // Through `tolerate`, never a caught parse error: a JSON error message
    // quotes the text it choked on, and that text is the decrypted secret.
    const decoded = tolerate(() => parseJsonValue(plaintext), 'malformed-input');

    if (decoded === undefined) throw new KinuError('bad_input', `the stored credential ${key} did not decode as JSON`);

    return { cred: validateCredential({ value: decoded }), revision };
  }

  /** Writes nothing, so {@link commitCredential} can be paired with a fence read in one turn. */
  private async sealCredential(key: string, cred: Credential): Promise<string> {
    await this.rewrapCredentials();

    return (await this.cipher()).seal(this.credentialAad(key), JSON.stringify(cred));
  }

  /**
   * Synchronous so `expectRevision` is a real compare-and-swap; preserves `created_at` on update.
   * `false` means the store moved while the caller was sealing, so nothing was written.
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

  private async writeCredential(key: string, cred: Credential): Promise<void> {
    this.commitCredential({ key, kind: cred.kind, sealed: await this.sealCredential(key, cred) });
  }

  /** Bumps the revision so an in-flight refresh cannot land a rotated token over this deletion. */
  private dropCredential(key: string): void {
    this.sqlx(`DELETE FROM user_credentials WHERE key = ?`, key);
    this.bumpCredentialRevision(key);
    this.bumpCredentialsRevision();
  }

  /** Moves on every write and deletion of the key; 0 for a key never held. */
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

  /** Rises with every credential-store mutation; workspaces compare it before using cached state.
   *  `shared` like `auth_tokens.socket`: it names no secret and mints nothing. */
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
   * Returns the rotated credential, or `'revoked'` if the owner moved it meanwhile, so a late
   * rotation reply cannot reconnect a disconnected account or overwrite a replacement.
   */
  private async commitRefreshedCredential(
    key: string, next: OAuthCredential, expectRevision: number,
  ): Promise<OAuthCredential | 'revoked'> {
    const sealed = await this.sealCredential(key, next);

    if (this.commitCredential({ key, kind: next.kind, sealed, expectRevision })) return next;
    diagnostics.event('credential.refresh_superseded', { outcome: 'denied', credentialKey: key });
    // The store is the authority, not the token this call was carrying.
    const current = await this.readCredential(key);

    return current?.kind === 'oauth' ? current : 'revoked';
  }

  /** No-op if the owner already replaced the credential; the rejection belongs to the old one. */
  private retireRejectedCredential(key: string, expectRevision: number): void {
    if (this.credentialRevision(key) !== expectRevision) return;
    this.dropCredential(key);
  }

  /** Re-seals retired-key rows and a never-sealed store's plaintext once per instance, unless the
   *  marker matches. Unopenable rows are left so only that credential fails. */
  private rewrapCredentials(): Promise<void> {
    this._credentialsRewrapped ??= (async () => {
      const cipher = await this.cipher();

      const marker = this.sqlx<{ value: string }>(
        `SELECT value FROM user_schema_meta WHERE key = ?`, UserDO.CREDENTIAL_ENVELOPE_MARKER,
      )[0];

      if (marker?.value === cipher.keyId) return;
      let clean = true;

      // Only a never-sealed store holds pre-encryption rows.
      const reopen = (aad: string, stored: string): Promise<string> => (
        marker === undefined && !isSealedCredential(stored) ? Promise.resolve(stored) : cipher.open(aad, stored)
      );

      for (const row of this.sqlx<{ key: string; value: string }>(`SELECT key, value FROM user_credentials`)) {
        const aad = this.credentialAad(row.key);

        try {
          this.sqlx(
            `UPDATE user_credentials SET value = ? WHERE key = ?`,
            await cipher.seal(aad, await reopen(aad, row.value)), row.key,
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
            await cipher.seal(aad, await reopen(aad, row.headers)), row.id,
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

      // Egress secrets share the cipher and must rotate in the same pass as the marker.
      if (!await rewrapEgressSecrets(this.egressVaultDeps(cipher))) clean = false;

      // Rotation drops the retired key based on this marker, so only write it if no row was left.
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

  /** MCP headers hold bearer tokens, sealed like credentials; AAD is the server id to prevent
   *  cross-server replay. Null passes through. */
  private mcpHeadersAad(serverId: string): string {
    return `${this.ctx.id.toString()}:mcp:${serverId}`;
  }

  private async sealMcpHeaders(serverId: string, headers: string | null): Promise<string | null> {
    await this.rewrapCredentials();

    return headers === null ? null : (await this.cipher()).seal(this.mcpHeadersAad(serverId), headers);
  }

  /** Stored headers that do not open reject: sent without them, the request would reach
   * the server unauthenticated and read as a server wanting a login. */
  private async openMcpHeaders(serverId: string, stored: string | null): Promise<string | null> {
    await this.rewrapCredentials();

    if (stored === null) return null;

    try { return await (await this.cipher()).open(this.mcpHeadersAad(serverId), stored); }
    catch (err) {
      throw toKinuError({ doing: `opening the stored headers of MCP server ${serverId}`, cause: err, otherwise: 'bad_input' });
    }
  }

  // Egress secret vault: see user/egress-vault.ts for why the row shape is its own table.

  /** AAD names this row in this DO so a ciphertext cannot be replayed elsewhere. */
  private egressVaultDeps(cipher: CredentialCipher): EgressVaultDeps {
    return {
      sql: this.ctx.storage.sql,
      cipher,
      aad: (id) => `${this.ctx.id.toString()}:egress:${id}`,
    };
  }

  /** The only read-back surface; stored secrets are never returned. */
  async listEgressSecrets(caller: UserCaller): Promise<EgressSecretSummary[]> {
    await this.requireTier(caller, 'egress_secrets.manage');

    return listEgressSecrets(this.ctx.storage.sql);
  }

  /** The returned `placeholder` is the only thing that may enter the container; rotating an id
   *  keeps its placeholder. */
  async putEgressSecret(caller: UserCaller, input: PutEgressSecretInput): Promise<EgressSecretBinding> {
    await this.requireTier(caller, 'egress_secrets.manage');
    await this.rewrapCredentials();

    return putEgressSecret(this.egressVaultDeps(await this.cipher()), input);
  }

  /** A later request carrying the placeholder is refused rather than forwarded with a dummy. */
  async revokeEgressSecret(caller: UserCaller, id: string): Promise<{ revoked: boolean }> {
    await this.requireTier(caller, 'egress_secrets.manage');

    return { revoked: revokeEgressSecret(this.ctx.storage.sql, id) };
  }

  /**
   * `active` is already grant-filtered (consent); this decides destination per request.
   * The outbound handler presents the owner capability.
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

  /** baseURL is not a secret and is absent from listCredentials(); provider deps need it. */
  async getCredentialBaseURL(caller: UserCaller, key: string): Promise<string | null> {
    await this.requireCredentialAccess(caller, key);
    validateCredentialKey(key);
    // The my-gateway view uses the same account-scoped /ai/v1 endpoint as Workers AI;
    // only the cf-aig-gateway-id header differs.
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

  /** Headers ready to inject into a fetch. */
  async getAuthHeaders(caller: UserCaller, key: string, opts?: { forceRefresh?: boolean }): Promise<Record<string, string> | null> {
    await this.requireCredentialAccess(caller, key);
    validateCredentialKey(key);
    // `cloudflare.ai-gateway` is a derived view of the Cloudflare login: same bearer and refresh,
    // but cf-aig-gateway-id names the user's selected gateway (null until selected).
    const storedKey = key === CLOUDFLARE_AI_GATEWAY_CRED_KEY ? CLOUDFLARE_OAUTH_CRED_KEY : key;
    const stored = await this.readCredentialAt(storedKey);

    if (!stored) return null;
    // Explicitly non-null so the refresh reassignment below doesn't re-widen to `Credential | null`.
    let cred: Credential = stored.cred;

    const issuer = subscriptionIssuer(storedKey);

    if (issuer !== null && cred.kind === 'oauth') {
      if (!cred.refreshToken) return null;

      if (opts?.forceRefresh === true || issuer.expiring(cred)) {
        const refreshed = await this.refreshSubscriptionLogin(storedKey, { cred, revision: stored.revision }, issuer);

        if (refreshed === 'revoked') return null;

        // A failed refresh keeps the old creds: the call may still succeed, else its 401
        // signals that re-auth is needed.
        if (!('failed' in refreshed)) cred = refreshed;
      }
    }

    if (storedKey === CLOUDFLARE_OAUTH_CRED_KEY && cred.kind === 'oauth') {
      const needRefresh = opts?.forceRefresh === true || isCloudflareCredentialExpiring(cred);

      if (needRefresh) {
        if (!cred.refreshToken) return null;
        const refreshed = await this.refreshCloudflareInternal({ cred, revision: stored.revision });

        if (refreshed === 'revoked') return null;

        if (!('failed' in refreshed)) cred = refreshed;
      }
    }

    // A credential whose stored shape doesn't match its key is a defect and must not reach
    // the caller as "not connected".
    const headers = credentialToHeaders(storedKey, cred);

    if (key === CLOUDFLARE_AI_GATEWAY_CRED_KEY) {
      const gatewayId = this.selectedAIGatewayId();

      if (!gatewayId) return null;
      headers['cf-aig-gateway-id'] = gatewayId;
    } else if (key === CLOUDFLARE_OAUTH_CRED_KEY) {
      // Use the user's selected gateway if any, otherwise the platform's configured default.
      headers['cf-aig-gateway-id'] = this.selectedAIGatewayId() ?? cloudflareAIGatewayId(this.env);
    }

    return headers;
  }

  private static readonly AI_GATEWAY_CONFIG_KEY = 'cloudflare_ai_gateway';

  private selectedAIGatewayId(): string | null {
    const row = this.sqlx<{ value: string }>(
      `SELECT value FROM user_config WHERE key = ?`, UserDO.AI_GATEWAY_CONFIG_KEY,
    )[0];

    return row && isCloudflareAIGatewayId(row.value) ? row.value : null;
  }

  /** Null when no usable Cloudflare credential is stored; rejects when the login
   * is there and its refresh failed. */
  private async cloudflareAPICredential(): Promise<{ accessToken: string; accountId: string } | null> {
    const stored = await this.readCredentialAt(CLOUDFLARE_OAUTH_CRED_KEY);

    if (stored?.cred.kind !== 'oauth' || !isCloudflareCredentialUsable(stored.cred)) return null;
    let cred = stored.cred;

    if (isCloudflareCredentialExpiring(cred)) {
      const refreshed = await this.refreshCloudflareInternal({ cred, revision: stored.revision });

      if (refreshed === 'revoked') return null;

      if ('failed' in refreshed) throw refreshed.failed;
      cred = refreshed;
    }

    const accountId = accountIdFromCloudflareCredential(cred);

    return accountId ? { accessToken: cred.accessToken, accountId } : null;
  }

  /** With exactly one gateway and nothing selected, selects it (persisted). Never throws:
   * unusable login or failed discovery surface in `error`, so login can call this inline. */
  async listAIGateways(caller: UserCaller): Promise<{
    connected: boolean;
    selectedId: string | null;
    gateways: CloudflareAIGatewaySummary[];
    error: string | null;
  }> {
    await this.requireTier(caller, 'ai_gateway.admin');
    let selectedId = this.selectedAIGatewayId();

    try {
      const api = await this.cloudflareAPICredential();

      if (!api) return { connected: false, selectedId, gateways: [], error: null };
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

  /** Reads the stored credential only, no API call, so it cannot fail for a reason the user
   * did not cause. */
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

  /** Point Workers AI at another of this login's accounts. The AI Gateway selection belongs
   * to the old account, so it is dropped and rediscovered. */
  async selectCloudflareAccount(caller: UserCaller, accountId: string): Promise<void> {
    await this.requireTier(caller, 'ai_gateway.admin');
    const cred = await this.readCredential(CLOUDFLARE_OAUTH_CRED_KEY);

    if (cred?.kind !== 'oauth') throw new Error('Cloudflare is not connected.');
    await this.writeCredential(CLOUDFLARE_OAUTH_CRED_KEY, withCloudflareAccount(cred, accountId));
    const owner = await ownerCaller(this.env);
    await this.selectAIGateway(owner, null);
    await this.listAIGateways(owner);
  }

  /** `'revoked'` on `invalid_grant` or a disconnect mid-refresh; `{ failed }` when the issuer could not be asked. One
   *  refresh per login at a time, shared by later callers: two spending one rotating token would lose the login. */
  private async refreshOAuthCredential(
    key: string,
    held: HeldLogin,
    rotate: () => Promise<OAuthCredential>,
    onRevoked: (revision: number) => Promise<void>,
  ): Promise<OAuthRefresh> {
    const inFlight = this._refreshing.get(key);

    if (inFlight) return inFlight;
    const task = this.rotateOAuthCredential(key, held, rotate, onRevoked);
    this._refreshing.set(key, task);

    try { return await task; } finally { this._refreshing.delete(key); }
  }

  private readonly _refreshing = new Map<string, Promise<OAuthRefresh>>();

  private async rotateOAuthCredential(
    key: string,
    held: HeldLogin,
    rotate: () => Promise<OAuthCredential>,
    onRevoked: (revision: number) => Promise<void>,
  ): Promise<OAuthRefresh> {
    // Replaced since this caller read it: the held refresh token may be spent. Writes fence on that revision.
    if (this.credentialRevision(key) !== held.revision) {
      const current = await this.readCredential(key);

      return current?.kind === 'oauth' ? current : 'revoked';
    }

    const doing = REFRESH_DOING.get(baseCredentialKey(key)) ?? `refreshing ${key}`;
    let rotated: OAuthCredential;

    try {
      rotated = await rotate();
    } catch (err) {
      if (err instanceof OAuthTokenError && err.revoked) {
        diagnostics.failure('credential.refresh_revoked', toKinuError({ doing, cause: err, otherwise: 'denied' }), { credentialKey: key });
        await onRevoked(held.revision);

        return 'revoked';
      }

      const failure = toKinuError({ doing, cause: err, otherwise: 'unavailable' });
      diagnostics.failure('credential.refresh_failed', failure, { credentialKey: key });

      return { failed: failure };
    }

    return await this.commitRefreshedCredential(key, rotated, held.revision);
  }

  /** The token still serves management APIs after a rejected refresh; only the refresh token is stripped. */
  private refreshCloudflareInternal(held: HeldLogin): Promise<OAuthRefresh> {
    return this.refreshOAuthCredential(
      CLOUDFLARE_OAUTH_CRED_KEY,
      held,
      () => refreshCloudflareCredential(this.env, held.cred),
      async (revision) => {
        const { refreshToken: _dead, ...rest } = held.cred;
        await this.commitRefreshedCredential(CLOUDFLARE_OAUTH_CRED_KEY, rest, revision);
      },
    );
  }

  /** A rejected refresh deletes only that login's row, so its connect CTA resurfaces. */
  private refreshSubscriptionLogin(key: string, held: HeldLogin, issuer: SubscriptionIssuer): Promise<OAuthRefresh> {
    return this.refreshOAuthCredential(
      key,
      held,
      () => issuer.refresh(held.cred),
      async (revision) => { this.retireRejectedCredential(key, revision); },
    );
  }

  // Codex device flow: calls wait on OpenAI while other calls run. The generation names the
  // attempt a poll belongs to and `settled_at` whether it is still live, fencing stale polls.

  async startCodexDeviceFlow(caller: UserCaller): Promise<DeviceCodeStart> {
    await this.requireTier(caller, 'codex_auth');
    const client = createCodexOAuthClient();
    const result = await client.startDeviceFlow();
    // The generation rises in the write itself so two racing starts cannot get the same number.
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
    // Both fences must be read before the provider wait.
    const generation = row.generation;
    const revision = this.credentialRevision(CODEX_CRED_KEY);

    const client = createCodexOAuthClient();

    try {
      const poll = await client.pollDeviceFlow(row.device_auth_id, row.user_code);

      if (poll.status === 'pending') return { connected: false };

      if (poll.status === 'expired' || poll.status === 'denied') return { connected: false, error: poll.message };
      const accountId = decodeCodexAccountId(poll.tokens.accessToken);
      const cred = tokensToCredential(poll.tokens, accountId ? { accountId } : undefined);
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

  /** Commits credential and flow settlement together; synchronous, with both fences checked
   * before either write, so a poll lands whole against its attempt or not at all. */
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
    // Settled, not deleted: the generation must keep rising, and a poll already waiting on OpenAI
    // must find this attempt closed rather than find no row to fence against.
    this.sqlx(`UPDATE codex_device_flow SET settled_at = ? WHERE id = 1 AND settled_at IS NULL`, Date.now());
  }

  async getCodexStatus(caller: UserCaller): Promise<CodexStatus> {
    await this.requireTier(caller, 'codex_auth');
    const cred = await this.readCredential(CODEX_CRED_KEY);

    // Only an open attempt is an in-progress flow; a settled row just keeps the generation rising.
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

  /**
   * Owner-session only: the role/tier catalog is authority, so even a `full`-tier workspace is
   * refused until the agent runtime adds its narrow read surface.
   */
  private async requireOwnerSession(caller: UserCaller): Promise<void> {
    const resolved = await this.requireTier(caller, 'config');

    if (resolved.kind !== 'owner_session') {
      throw new CapabilityDeniedError(
        'The profile catalog is owner-only. Workspaces cannot read or write the account\'s roles and tiers.',
      );
    }
  }

  /** Corruption is an account configuration error, not permission to substitute other authority. */
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
      return validateProfileCatalog({ value: json });
    } catch (error) {
      throw new Error(
        'The stored account profile catalog violates the profile catalog contract.',
        { cause: error },
      );
    }
  }

  private profileCatalogEnvelope(version: number, catalog: ProfileCatalog): ProfileCatalogEnvelope {
    return {
      authority: { kind: 'account', accountId: this.ctx.id.name ?? this.ctx.id.toString() },
      version,
      digest: profileCatalogDigest(catalog),
      catalog,
    };
  }

  /** A missing row starts at version 0; malformed stored config fails rather than changing roles. */
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

  /** Shared workspaces may read the catalog; only an owner session may mutate it. */
  async getWorkspaceProfileCatalog(caller: UserCaller): Promise<ProfileCatalogEnvelope> {
    await this.requireTier(caller, 'profile.resolve');
    const current = this.readProfileCatalogState();

    return this.profileCatalogEnvelope(current.version, current.catalog);
  }

  /**
   * CAS write: a version mismatch refuses with current state. Validation precedes the write, and
   * the read-check-write has no await, so each accepted write increments the version by one.
   */
  async putProfileCatalog(caller: UserCaller, catalog: JsonValue, expectedVersion: number): Promise<ProfileCatalogWriteResult> {
    await this.requireOwnerSession(caller);

    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      return { ok: false, kind: 'malformed', reason: 'expectedVersion must be a non-negative integer.' };
    }

    let parsed: ProfileCatalog;

    try {
      parsed = validateProfileCatalog({ value: catalog });
    } catch (cause) {
      // Render the whole cause chain: the frame naming the offending path may sit below the wrapper,
      // and this reason is all the owner is shown.
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

  /**
   * A projection: the owner's workspace object is the authority and every read re-asks it, so a
   * revoked share lists once and refuses. Idempotent per (owner, workspace, share).
   */
  async sharesReceived_add(caller: UserCaller, row: SharedBlueprintReceipt): Promise<void> {
    await this.requireTier(caller, 'shares');
    this.sqlx(
      `INSERT INTO user_shares_received (owner_user_id, owner_email, workspace, share_id, title)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (owner_user_id, workspace, share_id) DO UPDATE SET title = excluded.title, owner_email = excluded.owner_email`,
      row.ownerUserId, row.ownerEmail, row.workspace, row.shareId, row.title,
    );
  }

  async libraryTiles(caller: UserCaller): Promise<Array<{ workspace: string; overview: WorkspaceOverview }>> {
    await this.requireTier(caller, 'drive');

    return libraryTiles(this.ctx.storage.sql);
  }

  async sharesReceived_list(caller: UserCaller): Promise<SharedBlueprintReceipt[]> {
    await this.requireTier(caller, 'shares');

    return this.sqlx<{ owner_user_id: string; owner_email: string; workspace: string; share_id: string; title: string; created_at: number }>(
      `SELECT owner_user_id, owner_email, workspace, share_id, title, created_at
       FROM user_shares_received ORDER BY created_at DESC, share_id`,
    ).map((row) => ({
      ownerUserId: row.owner_user_id, ownerEmail: row.owner_email, workspace: row.workspace,
      shareId: row.share_id, title: row.title, createdAt: row.created_at,
    }));
  }

  /**
   * Reverse of `sharesReceived_add`, run on each recipient when the owner deletes their account,
   * so no row lists a blueprint no object can answer for.
   */
  async sharesReceived_forget(caller: UserCaller, ownerUserId: string): Promise<void> {
    await this.requireTier(caller, 'shares');
    this.sqlx(`DELETE FROM user_shares_received WHERE owner_user_id = ?`, ownerUserId);
  }

  // The Mossaic tenant id is the owner's user id, derived from the profile row's email as the
  // edge does, so no caller names a tenant. Every owner workspace mounts it at `/shared`.

  /** Seam: the hosted deployment builds the SDK client from bindings; the bun:sqlite harness fakes it. */
  protected driveFor(tenant: string): MossaicVfs | null {
    return tenantDrive(this.env, tenant);
  }

  private async drive(): Promise<MossaicVfs> {
    const row = this.sqlx<{ email: string }>(`SELECT email FROM user_profile WHERE id = 1`)[0];

    if (!row) throw new KinuError('missing', 'the Drive opens once the account has signed in');
    const files = this.driveFor(await deriveUserId(row.email));

    if (files === null) throw new KinuError('unavailable', SHARED_DRIVE_UNBOUND);

    return files;
  }

  private async driveOp<Value>(caller: UserCaller, op: (drive: MossaicVfs) => Promise<Value>): Promise<DriveAnswer<Value>> {
    await this.requireTier(caller, 'drive');

    try {
      return { ok: true, value: await op(await this.drive()) };
    } catch (cause) {
      return { ok: false, ...driveFailure({ cause }) };
    }
  }

  async drive_list(caller: UserCaller, path: string): Promise<DriveAnswer<DriveListing>> {
    return this.driveOp(caller, (drive) => listDrive(drive, path));
  }

  async drive_mkdir(caller: UserCaller, path: string): Promise<DriveAnswer<void>> {
    return this.driveOp(caller, (drive) => makeDriveFolder(drive, path));
  }

  async drive_rename(caller: UserCaller, from: string, to: string): Promise<DriveAnswer<void>> {
    return this.driveOp(caller, (drive) => renameDriveEntry(drive, from, to));
  }

  async drive_delete(caller: UserCaller, path: string): Promise<DriveAnswer<void>> {
    return this.driveOp(caller, (drive) => deleteDriveEntry(drive, path));
  }

  async drive_markAsSkill(caller: UserCaller, path: string): Promise<DriveAnswer<MarkedSkill>> {
    return this.driveOp(caller, (drive) => markAsSkill(drive, path));
  }

  async drive_addSkill(caller: UserCaller, skillFile: string): Promise<DriveAnswer<MarkedSkill>> {
    return this.driveOp(caller, (drive) => {
      const bytes = new TextEncoder().encode(skillFile);

      if (bytes.byteLength > DRIVE_PASTED_SKILL_MAX_BYTES) {
        throw new KinuError('budget', `a pasted SKILL.md is at most ${String(DRIVE_PASTED_SKILL_MAX_BYTES)} bytes`);
      }

      return addSkill(drive, [{ path: SKILL_FOLDER_FILE, bytes }], null);
    });
  }

  // Chunked transfers as in files-routes.ts: one transfer id per request, an `offset === 0` chunk
  // (re)starts it, and the first chunk fixes the target, checked on every later chunk.
  private readonly driveUploads = new Map<string, { readonly target: DriveUploadTarget; readonly upload: ChunkedUpload }>();
  private readonly driveDownloads = new Map<string, { readonly path: string; readonly bytes: Uint8Array }>();

  async drive_writeChunk(caller: UserCaller, write: DriveChunkWrite): Promise<DriveAnswer<DriveUploadOutcome>> {
    const { transferId, offset } = write;

    return this.driveOp(caller, async (drive) => {
      const target = v.parse(DriveUploadTargetSchema, write.target);

      if (!transferId) throw new KinuError('bad_input', 'upload transfer id required');
      let row = this.driveUploads.get(transferId);

      if (offset === 0) {
        row = { target, upload: new ChunkedUpload() };
        this.driveUploads.set(transferId, row);
      } else if (!row || JSON.stringify(row.target) !== JSON.stringify(target)) {
        throw new KinuError('bad_input', 'file transfer out of sync: no matching open upload');
      }

      const step = row.upload.chunk(offset, write.chunk, write.final);

      if (row.upload.done) this.driveUploads.delete(transferId);

      if ('error' in step) throw new KinuError('bad_input', step.error);

      if (!('assembled' in step)) return { ok: true };

      return receiveDriveUpload(drive, target, step.assembled);
    });
  }

  async drive_abortUpload(caller: UserCaller, transferId: string): Promise<void> {
    await this.requireTier(caller, 'drive');
    this.driveUploads.get(transferId)?.upload.abort();
    this.driveUploads.delete(transferId);
  }

  /** The snapshot is taken here, so later ranges cannot observe a newer write. */
  async drive_startDownload(caller: UserCaller, path: string, transferId: string): Promise<DriveAnswer<{ size: number; name: string }>> {
    return this.driveOp(caller, async (drive) => {
      if (!transferId) throw new KinuError('bad_input', 'download transfer id required');
      const clean = normalizeDrivePath(path);
      const stat = await drive.stat(clean);

      if (stat === null) throw new KinuError('missing', `no such entry: ${clean}`);
      const leaf = clean === '/' ? 'drive' : clean.slice(clean.lastIndexOf('/') + 1);

      if (stat.isDir) {
        const bytes = await packDriveFolder(drive, clean, FILE_TRANSFER_MAX_BYTES);
        this.driveDownloads.set(transferId, { path: clean, bytes });

        return { size: bytes.byteLength, name: `${leaf}.zip` };
      }

      if (stat.size > FILE_TRANSFER_MAX_BYTES) {
        throw new KinuError('budget', `file exceeds the ${String(Math.floor(FILE_TRANSFER_MAX_BYTES / (1024 * 1024)))} MiB transfer limit`);
      }

      const raw = await drive.readFile(clean);
      const bytes = raw instanceof Uint8Array ? raw : new TextEncoder().encode(raw);
      this.driveDownloads.set(transferId, { path: clean, bytes });

      return { size: bytes.byteLength, name: leaf };
    });
  }

  async drive_readChunk(caller: UserCaller, transferId: string, offset: number, length: number): Promise<DriveAnswer<{ bytes: Uint8Array }>> {
    return this.driveOp(caller, async () => {
      const open = this.driveDownloads.get(transferId);

      if (!open) throw new KinuError('bad_input', 'file transfer out of sync: no matching open download');

      if (offset < 0 || length <= 0 || length > FILE_CHUNK_BYTES) throw new KinuError('bad_input', 'chunk range out of bounds');

      if (offset >= open.bytes.byteLength) throw new KinuError('bad_input', 'chunk offset past end of file');
      const bytes = open.bytes.subarray(offset, offset + length);

      if (offset + bytes.byteLength >= open.bytes.byteLength) this.driveDownloads.delete(transferId);

      return { bytes };
    });
  }

  async drive_abortDownload(caller: UserCaller, transferId: string): Promise<void> {
    await this.requireTier(caller, 'drive');
    this.driveDownloads.delete(transferId);
  }

  /**
   * Delete everything under this account, then the object itself; the step order is the contract.
   * Each step leaves no rows, so a failed sweep resumes on retry; errors propagate to the owner.
   */
  async deleteAccount(caller: UserCaller, ownerUserId: string): Promise<{ ok: true; workspaces: number }> {
    await this.requireTier(caller, 'account');

    if (!/^[a-f0-9]{32}$/.test(ownerUserId)) throw new Error('invalid owner user id');

    const workspaces = this.sqlx<{ name: string }>(`SELECT name FROM user_workspaces`);

    for (const { name } of workspaces) {
      await this.tearDownWorkspace(name, ownerUserId);
    }

    const devices = this.sqlx<{ id: string }>(`SELECT id FROM user_devices WHERE revoked_at IS NULL`);

    for (const { id } of devices) {
      await this.revokeDevice(caller, id);
    }

    const servers = this.sqlx<{ id: string }>(`SELECT id FROM user_mcp_servers`);

    for (const { id } of servers) {
      await this.userMcp_remove(caller, id);
    }

    await this.destroy();
    // The isolate abort is a tick away; a request in that tick meets emptied storage, so reset the
    // latch to re-run schema init and answer as the empty account.
    this._initialized = false;

    return { ok: true, workspaces: workspaces.length };
  }

  /** The SDK's manager, with activation restore retired (see {@link retireActivationRestore}).
   *  Its config is `user_mcp_servers`; the SDK rows are derived from it. */
  private userMcp(): MCPClientManager {
    this.ensureInit();

    return this.mcp;
  }

  /**
   * The single hydration path for this user's MCP plane; `user_mcp_servers` is the truth.
   * Order matters: remove orphan SDK rows, re-register rows this plane owns, then let the SDK
   * restore the rest and connect step-2 connections (restore skips CONNECTING ones,
   * `agents/dist/client-zqKcsyFa.js:1541-1549`). Idempotent.
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

  /** Called only through {@link hydrateUserMcp}, which coalesces concurrent callers. */
  private async hydrateUserMcpOnce(): Promise<void> {
    const mgr = this.userMcp();

    const rows = this.sqlx<McpHydrationRow>(
      `SELECT s.id, s.name, s.server_url, s.transport, s.headers, p.preset_id
         FROM user_mcp_servers s
         LEFT JOIN user_mcp_server_presets p ON p.server_id = s.id`,
    );

    const configured = new Set(rows.map((row) => row.id));
    const sdkRows = mgr.listServers();

    for (const stored of sdkRows) {
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
      const live = mgr.mcpConnections[row.id]?.options.transport;
      const seamLive = live !== undefined && 'fetch' in live && live.fetch !== undefined;
      // A sealed credential must run on the seam; a credential the SDK stored as data must go,
      // whether or not our column still holds one.
      const needsSeam = row.headers !== null && !seamLive;

      const holdsPlaintext = storedMcpOptionsCarryCredential(
        sdkRows.find((server) => server.id === row.id)?.server_options,
      );

      if (!needsSeam && !holdsPlaintext) continue;
      await this.registerOwnedMcpTransport(row);
      registered.push(row.id);
    }

    await this.restoreUserMcp(USER_MCP_CLIENT_NAME);

    for (const id of registered) await mgr.establishConnection(id);
    this._userMcpHydrated = true;
  }

  /** Replace the SDK row with a transport this plane owns; tear down any live connection first,
   *  since `createConnection` returns an existing one untouched (`client-zqKcsyFa.js:1719-1720`). */
  private async registerOwnedMcpTransport(row: McpHydrationRow): Promise<void> {
    const mgr = this.userMcp();
    const stored = mgr.listServers().find((server) => server.id === row.id);
    const callbackUrl = stored?.callback_url ?? '';

    if (mgr.mcpConnections[row.id]) {
      try { await mgr.removeServer(row.id); }
      catch (err) {
        diagnostics.failure('mcp.transport_rewrite_teardown_failed', toKinuError({
          doing: 'closing an MCP connection before rewriting the transport it runs on',
          cause: err,
          otherwise: 'unavailable',
        }), { serverId: row.id });
        throw err;
      }
    }

    const transport: NonNullable<Parameters<MCPClientManager['registerServer']>[1]['transport']> =
      row.headers === null
        ? { type: row.transport }
        : {
            ...mcpCredentialTransport(row.server_url, () => this.openMcpHeaderMap(row.id)),
            type: row.transport,
          };

    // `oauth-app` rows use the registered-app provider; the vendor rejects dynamic registration.
    const preset = row.preset_id === null ? undefined : mcpPresetById(row.preset_id);

    const appCredentials = preset?.auth === 'oauth-app'
      ? mcpAppCredentials(this.env, preset)
      : null;

    if (callbackUrl) {
      const authProvider = appCredentials
        ? new RegisteredAppOAuthClientProvider({
            storage: this.ctx.storage,
            clientName: USER_MCP_CLIENT_NAME,
            baseRedirectUrl: callbackUrl,
            clientId: appCredentials.clientId,
            clientSecret: appCredentials.clientSecret,
            scope: preset?.scope,
          })
        : new DurableObjectOAuthClientProvider(
            this.ctx.storage, USER_MCP_CLIENT_NAME, callbackUrl,
          );

      authProvider.serverId = row.id;

      if (!appCredentials && stored?.client_id) authProvider.clientId = stored.client_id;
      transport.authProvider = authProvider;
    }

    const options: Parameters<MCPClientManager['registerServer']>[1] = {
      url: row.server_url, name: row.name, callbackUrl, transport,
    };

    // The env's client id wins over a stale stored id, which would key tokens under an unused client.
    options.clientId = appCredentials?.clientId ?? stored?.client_id ?? undefined;

    if (stored?.auth_url) options.authUrl = stored.auth_url;
    await mgr.registerServer(row.id, options);
  }
  /** Read per request so rotated headers apply without reconnect and no decrypted copy is held. */
  private async openMcpHeaderMap(serverId: string): Promise<Record<string, string> | null> {
    const row = this.sqlx<{ headers: string | null }>(
      `SELECT headers FROM user_mcp_servers WHERE id = ?`, serverId,
    )[0];

    if (!row) return null;

    return parseMcpHeaders(await this.openMcpHeaders(serverId, row.headers));
  }

  /** Idempotent, fire-and-forget boot warmup called by routes on first hit per process.
   *  Runs even with no configured servers so orphan SDK rows are still reconciled. */
  async userMcp_warmConnections(caller: UserCaller): Promise<{ servers: number }> {
    await this.requireTier(caller, 'mcp.manage');
    const rows = this.sqlx<{ n: number }>(`SELECT COUNT(*) AS n FROM user_mcp_servers`)[0];
    const servers = rows?.n ?? 0;

    try {
      await this.hydrateUserMcp();
      await this.userMcp().waitForConnections();
      await this.readMcpToolLists();
    } catch (err) {
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
      allowed_tools: string | null; preset_id: McpPresetId | null;
      created_at: number; updated_at: number;
    }>(
      `SELECT s.id, s.name, s.server_url, s.transport, s.allowed_tools,
              p.preset_id, s.created_at, s.updated_at
         FROM user_mcp_servers s
         LEFT JOIN user_mcp_server_presets p ON p.server_id = s.id
        ORDER BY s.name`,
    );

    // Hydrate unconditionally: an orphaned SDK row can outlive the last config row. Idempotent.
    // A failure here is a storage failure, not per-server; it must not report every server disconnected.
    await this.hydrateUserMcp();
    await this.readMcpToolLists();
    const connections = this.mcp.mcpConnections;

    return rows.map((r): McpServerSummary => {
      const conn = connections[r.id];
      const status = mapConnectionStatus(conn?.connectionState);
      const allowed = parseAllowedTools(r.allowed_tools);
      const listing = conn?.connectionState === 'connected' ? this._mcpToolLists.get(r.id) : undefined;
      const lenient = listing !== undefined && 'listed' in listing ? listing.listed : null;

      const tools = lenient === null
        ? conn?.tools ?? []
        : lenient.tools.filter((tool) => 'admitted' in describeMcpTool({ id: r.id, name: r.name }, tool));

      let problems: string[] = [];

      if (listing !== undefined) {
        problems = 'failure' in listing
          ? [listing.failure]
          : mcpListingRefusals({ id: r.id, name: r.name }, listing.listed).map((refusal) => refusal.reason);
      }

      const toolsCount = allowed ? tools.filter((t: { name: string }) => allowed.includes(t.name)).length : tools.length;

      // authUrl is exposed only while pending, so the UI knows whether to render the authorize link.
      const authUrl = status === 'authenticating'
        ? (conn?.options?.transport?.authProvider?.authUrl ?? null)
        : null;

      return {
        id: r.id,
        name: r.name,
        serverUrl: r.server_url,
        transport: r.transport,
        status,
        error: conn?.connectionError ?? (problems.length === 0 ? null : problems.join('; ')),
        toolsCount,
        presetId: r.preset_id,
        authUrl,
        allowedTools: allowed,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    });
  }
  /** Which presets can offer a sign-in button (OAuth app configured) vs token fallback or nothing. */
  async userMcp_presets(caller: UserCaller): Promise<McpPresetAvailability[]> {
    await this.requireTier(caller, 'mcp.manage');

    return listMcpPresetAvailability(this.env);
  }

  /** `publicOrigin` is the user-facing origin that determines the OAuth callback URL; the routes
   *  layer derives it from the request's `Origin`/`Host`, since UserDO doesn't see the request. */
  async userMcp_add(
    caller: UserCaller,
    input: JsonValue,
    publicOrigin: string,
  ): Promise<{ id: string; authUrl: string | null }> {
    await this.requireTier(caller, 'mcp.manage');
    const cfg = validateMcpServerInput(input);

    if (!/^https?:\/\//.test(publicOrigin)) {
      throw new Error('publicOrigin must be a full https?:// origin.');
    }

    const preset = cfg.presetId === undefined ? undefined : mcpPresetById(cfg.presetId);

    // A preset with no configured OAuth app and no token would dead-end in SDK registration, so the
    // add is refused before the name claim; a refused add must leave no row behind.
    if (preset?.auth === 'oauth-app' && !mcpAppCredentials(this.env, preset) && !cfg.headers) {
      const names = mcpAppEnvNames(preset);

      throw new Error(
        `'${preset.title}' needs either the deployment's ${names?.clientIdEnv ?? 'app'}/`
        + `${names?.clientSecretEnv ?? 'secret'} OAuth app or a token in \`headers\`.`,
      );
    }

    const appCredentials = preset?.auth === 'oauth-app'
      ? mcpAppCredentials(this.env, preset)
      : null;

    const id = nanoid(8);
    const now = Date.now();
    const headersJson = cfg.headers ? JSON.stringify(cfg.headers) : null;
    const allowedJson = cfg.allowedTools ? JSON.stringify(cfg.allowedTools) : null;
    // Seal before the transaction: sealing awaits, and every written value must be in hand first.
    const sealedHeaders = await this.sealMcpHeaders(id, headersJson);
    this.claimMcpServerName(cfg.name, id, () => {
      this.ctx.storage.sql.exec(
        `INSERT INTO user_mcp_servers
           (id, name, server_url, transport, headers, allowed_tools, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id, cfg.name, cfg.serverUrl, cfg.transport ?? 'auto',
        sealedHeaders, allowedJson, now, now,
      );

      // The preset tag lives in its own table; `user_mcp_servers` keeps its shipped shape.
      if (cfg.presetId !== undefined) {
        this.ctx.storage.sql.exec(
          `INSERT INTO user_mcp_server_presets (server_id, preset_id) VALUES (?, ?)`,
          id, cfg.presetId,
        );
      }
    });

    const callbackUrl = `${publicOrigin.replace(/\/+$/, '')}${MCP_OAUTH_CALLBACK_PATH}`;

    const authProvider = appCredentials
      ? new RegisteredAppOAuthClientProvider({
          storage: this.ctx.storage,
          clientName: USER_MCP_CLIENT_NAME,
          baseRedirectUrl: callbackUrl,
          clientId: appCredentials.clientId,
          clientSecret: appCredentials.clientSecret,
          scope: preset?.scope,
        })
      : new DurableObjectOAuthClientProvider(
          this.ctx.storage, USER_MCP_CLIENT_NAME, callbackUrl,
        );

    authProvider.serverId = id;

    // The credential is a closure, never data the SDK can persist; see `mcpCredentialTransport`.
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
        // Persisted on the SDK row so a restore after eviction keys token storage under the same client.
        clientId: appCredentials?.clientId,
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
        // Awaited, not detached: waitUntil is a no-op in a DO (`do.wait_until.no_op`) and in-flight
        // promises are cancelled on reset (`do.background_task.cancelled_on_reset`).
        await mgr.discoverIfConnected(id);
        await this.readMcpToolList(id);
      }
    } catch (err) {
      // Roll back both our row and the SDK's storage entry so the user can retry cleanly.
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
    this._mcpToolLists.delete(id);
  }

  /** Patch-update editable fields; nothing reconnects. Rotated `headers` apply on the next request
   *  via `mcpCredentialTransport`; `serverUrl`/`transport` changes require remove + re-add. */
  async userMcp_update(caller: UserCaller, id: string, patch: JsonValue): Promise<void> {
    await this.requireTier(caller, 'mcp.manage');

    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) throw new Error('Invalid server id.');
    const parsedPatch = v.safeParse(JsonObjectSchema, patch);

    if (!parsedPatch.success) throw new Error('patch must be a JSON object.');
    const p = parsedPatch.output;
    const sets: string[] = [];
    const args: SqlStorageValue[] = [];
    // Same name rule as add: both claim from the same canonical namespace.
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

    // Everything above is validated and sealed; nothing below may await.
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

  /** Claim `name` for `serverId` and run `write` atomically; the transaction is the check and holds
   *  without the UNIQUE index (see `schema.ts`). `write` must not await. */
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


  private async readMcpToolList(id: string): Promise<void> {
    const conn = this.userMcp().mcpConnections[id];

    if (conn?.connectionState !== 'connected') {
      this._mcpToolLists.delete(id);

      return;
    }

    const name = this.sqlx<{ name: string }>(`SELECT name FROM user_mcp_servers WHERE id = ?`, id)[0]?.name ?? id;
    const listing = await readUndiscoveredToolList({ name }, conn.client);
    this._mcpToolLists.set(id, listing);

    for (const refusal of 'listed' in listing ? mcpListingRefusals({ id, name }, listing.listed) : []) {
      diagnostics.failure('mcp.tool_refused', new KinuError('bad_input', refusal.reason), { server: name });
    }
  }

  private async readMcpToolLists(): Promise<void> {
    const ids = new Set([...Object.keys(this.userMcp().mcpConnections), ...this._mcpToolLists.keys()]);

    for (const id of ids) await this.readMcpToolList(id);
  }

  /** Descriptors for already-connected MCP servers, filtered by `allowed_tools`. On the turn's
   *  critical path: starts and awaits no network work; `unavailable` lists servers not yet ready. */
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
    const refused: McpToolSurface['unavailable'] = [];
    const connections = this.mcp.mcpConnections;

    // Readiness comes from the SDK connection, not descriptors: a ready server may expose zero tools.
    const connected = new Set(
      Object.entries(connections)
        .filter(([, conn]) => mapConnectionStatus(conn.connectionState) === 'ready')
        .map(([id]) => id),
    );

    const listingFor = (id: string): McpToolListing | undefined => (connections[id]?.connectionState === 'connected'
      ? this._mcpToolLists.get(id)
      : undefined);

    const offered = new Set<string>();

    for (const [id, conn] of Object.entries(connections)) {
      // Disjoint with `unavailable` by construction: a non-ready connection contributes no descriptors,
      // so a server whose SDK kept cached tools after a 401 is disclaimed once and offered nowhere.
      const listing = listingFor(id);
      const lenient = listing !== undefined && 'listed' in listing ? listing.listed : null;

      if (!connected.has(id) && lenient === null) continue;
      const allowed = allowedById.get(id);

      if (allowed === undefined) continue;
      const meta = rows.find((r) => r.id === id);

      if (!meta) continue;
      offered.add(id);

      for (const tool of lenient?.tools ?? conn.tools) {
        if (allowed && !allowed.has(tool.name)) continue;
        const described = describeMcpTool({ id, name: meta.name }, tool);

        if ('admitted' in described) out.push(described.admitted);
        else refused.push(described.refused);
      }

      refused.push(...(lenient?.refused ?? []));
    }

    const unavailable = [...rows
      .filter((r) => !offered.has(r.id))
      .map((r) => {
        const listing = listingFor(r.id);

        if (listing !== undefined && 'failure' in listing) {
          return { server: r.name, reason: `connected, but its tool list could not be read, so it offers no tools: ${listing.failure}` };
        }

        return {
          server: r.name,
          reason: `not connected when this turn opened, so its tools are absent from this turn. They are `
            + `installed by the next turn once the connection completes — a turn's tool set is fixed `
            + `when the turn opens.`,
        };
      }), ...refused];

    // Sorted because the orchestrator's cache hashes this JSON; SDK map order is unstable and would
    // force needless rebuilds of every tool closure.
    // Code-unit order, so the surface this sorts hashes the same every time.
    out.sort((a, b) => compareCodeUnits(a.toolKey, b.toolKey));

    return JSON.stringify({ descriptors: out, unavailable } satisfies McpToolSurface);
  }

  /** Called over RPC by the orchestrator's per-tool closure; the result must be JSON-serializable. */
  async userMcp_callTool(
    caller: UserCaller,
    serverId: string,
    name: string,
    args: JsonObject,
  ): Promise<string> {
    // Caller identity comes from the capability token, not an argument, so no agent name can be spoofed.
    await this.requireTier(caller, 'mcp.tools');
    const manager = this.userMcp();

    if (!this._userMcpHydrated) {
      try { await this.hydrateUserMcp(); }
      catch (err) { throw new Error(`MCP not ready: ${renderThrownChain({ cause: err })}`, { cause: err }); }
    }

    // Check server membership in SQL so a stale orchestrator closure can't dispatch to a deleted server.
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
    // Clients send untouched optional fields as ""; drop only keys the tool's inputSchema marks optional,
    // never required or undeclared keys (KINU-052).
    const listing = this._mcpToolLists.get(serverId);
    const listed = listing !== undefined && 'listed' in listing ? listing.listed.tools : [];
    const tool = [...(this.mcp.mcpConnections[serverId]?.tools ?? []), ...listed].find((t) => t.name === name);
    const parsedSchema = v.safeParse(JsonObjectSchema, tool?.inputSchema);

    const callArgs = omitEmptyOptionalArgs(
      params,
      parsedSchema.success ? parsedSchema.output : undefined,
    );

    try {
      const result = await callRenewingExpiredSession(manager, serverId, () => manager.callTool({ serverId, name, arguments: callArgs }));

      return JSON.stringify(decodeJsonValue({ value: result }));
    } catch (err) {
      await this.convergeMcpAuthState({ serverId, cause: err });
      throw err;
    }
  }

  /**
   * A mid-session auth failure leaves the connection `ready`; `discoverIfConnected` re-probes it so it
   * moves to authenticating with a reconnect URL. Which failures qualify is `isMcpTransportUnauthorized`'s.
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

  async userMcp_handleOAuthCallback(caller: UserCaller, url: string): Promise<{ ok: boolean; serverId: string | null; error: string | null }> {
    await this.requireTier(caller, 'mcp.manage');

    try {
      const req = new Request(url);
      const result = await this.userMcp().handleCallbackRequest(req);

      if (result.authSuccess) {
        // Awaited in its own try: tokens are already saved, so a connect failure is not an auth failure.
        // A DO cannot retain an unawaited promise (`do.wait_until.no_op`).
        try { await this.userMcp().establishConnection(result.serverId); }
        catch (err) { return { ok: true, serverId: result.serverId, error: `connected but not established: ${renderThrownChain({ cause: err })}` }; }

        await this.readMcpToolList(result.serverId);

        return { ok: true, serverId: result.serverId, error: null };
      }

      return { ok: false, serverId: result.serverId ?? null, error: result.authError };
    } catch (err) {
      return { ok: false, serverId: null, error: renderThrownChain({ cause: err }) };
    }
  }

  async listConnectedProviders(caller: UserCaller): Promise<ConnectedProvider[]> {
    const creds = this.credentialSummaries(await this.requireTier(caller, 'credentials.model'));
    const byKey = new Map(creds.map((c) => [c.key, c]));
    const out: ConnectedProvider[] = [];

    // Built-in providers without credentials are listed by the server; only credential-gated ones here.
    if (byKey.has(CLOUDFLARE_OAUTH_CRED_KEY)) {
      out.push({ id: 'workers-ai', label: 'Cloudflare Workers AI', credentialKeys: [CLOUDFLARE_OAUTH_CRED_KEY] });

      if (this.selectedAIGatewayId()) {
        out.push({ id: 'my-gateway', label: 'Your AI Gateway', credentialKeys: [CLOUDFLARE_OAUTH_CRED_KEY] });
      }
    }

    if (byKey.has(CODEX_CRED_KEY)) out.push({ id: 'codex', label: 'ChatGPT Codex', credentialKeys: [CODEX_CRED_KEY] });

    for (const c of creds) {
      // BYO API keys; display names come from the catalog client-side.
      const bearer = /^([a-z0-9][a-z0-9._-]*)\.bearer$/.exec(c.key);

      if (bearer) {
        out.push({ id: bearer[1], label: bearer[1], credentialKeys: [c.key] });
        continue;
      }

      if (c.key.startsWith('openai-compat.')) {
        const name = c.key.slice('openai-compat.'.length);
        out.push({ id: `openai-compat:${name}`, label: `OpenAI-compatible (${name})`, credentialKeys: [c.key] });
      }
    }

    return out;
  }
}
