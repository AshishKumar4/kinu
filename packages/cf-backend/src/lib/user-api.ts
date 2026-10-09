/** Typed client for `/api/user/*`; the session rides the HttpOnly cookie (dev synthesizes DEV_USER_EMAIL server-side). */
import { Cause, Data, Effect } from 'effect';
import {
  DEVICE_SANDBOX_CAPABILITIES, DEVICE_SANDBOX_REASONS, DEVICE_TIERS, DEVICE_UPDATE_STATES,
  AccountUsageSchema, ProfileCatalogEnvelopeSchema, REASONING_EFFORTS,
  type Credential,
  type DeviceTier,
  type JsonValue,
  JsonValueSchema,
  ModelTestResultSchema,
  type ModelTestResult,
  type ProfileCatalog,
  type ProfileCatalogEnvelope,
  type RosterBucket,
  WorkspaceOverviewSchema,
} from '@kinu.run/core';
import { tolerateAsync, settle } from '@kinu.run/core/obs';
import { DEFAULT_CALL_TIMEOUT_MS } from 'agents/client';
import * as v from 'valibot';
import type { BoxSize } from '@kinu.run/devbox/sizes';
import { accountSandboxSize, SANDBOX_SIZE_CONFIG_KEY } from '../sandbox-size';

export type UserProfile = NonNullable<v.InferOutput<typeof UserProfileSchema>>;

export type WorkspaceEntry = v.InferOutput<typeof WorkspaceEntrySchema>;

export type RosterEntry = v.InferOutput<typeof RosterEntrySchema>;

export type RosterCounts = v.InferOutput<typeof RosterCountsSchema>;

export type RosterPage = v.InferOutput<typeof RosterPageSchema>;

export type RosterFrame = v.InferOutput<typeof RosterFrameSchema>;

export type RosterFilterBucket = Exclude<RosterBucket, 'unreported'>;

export interface RosterQuery {
  readonly cursor?: string | null;
  readonly limit?: number;
  readonly bucket?: RosterFilterBucket;
  readonly q?: string;
}

export type CredentialSummary = v.InferOutput<typeof CredentialSummarySchema>;

export type ModelMenuEntry = v.InferOutput<typeof ModelMenuEntrySchema>;

/** A provider unreachable while building the menu, shown as a notice rather than an empty picker. */
export type ProviderFailure = v.InferOutput<typeof ProviderFailureSchema>;

export type ModelMenu = v.InferOutput<typeof ModelMenuSchema>;

const ErrorBodySchema = v.object({ error: v.optional(v.string()) });

const OkSchema = v.object({ ok: v.boolean() });

const UserProfileSchema = v.nullable(v.object({
  email: v.string(), displayName: v.nullable(v.string()), createdAt: v.number(), lastSeenAt: v.number(),
  onboardedAt: v.nullable(v.number()),
  /** An account that already has a workspace is never sent through the wizard. */
  workspaceCount: v.number(),
  /** Nav visibility only, decided by the function that guards `/api/control/*`; that gate answers for itself every request.
   *  Optional so a client against an older Worker hides the nav entry instead of failing to parse. */
  controlPlane: v.optional(v.boolean()),
}));

const WorkspaceEntrySchema = v.object({
  name: v.string(), displayName: v.string(), createdAt: v.number(), lastVisited: v.number(),
});

const RosterEntrySchema = v.object({
  ...WorkspaceEntrySchema.entries, overview: v.nullable(WorkspaceOverviewSchema), decisions: v.number(), logo: v.optional(v.nullable(v.string())),
});

const RosterCountsSchema = v.object({
  all: v.number(), needs: v.number(), working: v.number(), idle: v.number(), unreported: v.number(), decisions: v.number(),
});

const RosterPageSchema = v.object({
  entries: v.array(RosterEntrySchema), total: v.number(), nextCursor: v.nullable(v.string()), counts: RosterCountsSchema,
});

/** `entry` is null once the workspace has left the roster. */
export const RosterFrameSchema = v.object({
  type: v.literal('workspace'), name: v.string(), entry: v.nullable(RosterEntrySchema), counts: RosterCountsSchema,
});

export const ROSTER_SOCKET_ROUTE = '/api/user/workspaces/live';

export function pictureUrl(workspace: string, slate: string, digest: string): string {
  return `/api/user/pictures/${encodeURIComponent(workspace)}/${encodeURIComponent(slate)}/${digest}`;
}

const CliSetupSchema = v.object({
  publicOrigin: v.string(), installCommand: v.string(), setupCommand: v.optional(v.string()), authCommand: v.string(),
});

const CredentialSummarySchema = v.object({
  key: v.string(), kind: v.picklist(['bearer', 'oauth', 'openai-compat']),
});

const ModelMenuEntrySchema = v.object({
  spec: v.string(), label: v.string(), provider: v.string(), providerLabel: v.optional(v.string()),
  capabilities: v.optional(v.array(v.string())), contextWindow: v.optional(v.number()),
  /** Absent when the catalog could not say; empty when the model takes none. */
  reasoningEfforts: v.optional(v.array(v.picklist(REASONING_EFFORTS))),
});

const ProviderFailureSchema = v.object({
  provider: v.string(), label: v.optional(v.string()), reason: v.string(),
});

const ModelMenuSchema = v.object({
  models: v.array(ModelMenuEntrySchema), failures: v.array(ProviderFailureSchema),
  accounts: v.optional(v.record(v.string(), v.array(v.string()))),
});

export type CliSetup = v.InferOutput<typeof CliSetupSchema>;

/** '' when the body is not a JSON `{error}` envelope. */
async function errorDetail(res: Response): Promise<string> {
  const parsed = v.safeParse(ErrorBodySchema, await tolerateAsync(() => res.json(), 'malformed-input'));

  return parsed.success ? parsed.output.error ?? '' : '';
}

/** The shaped payloads are named because a TypeScript interface never satisfies an index signature. */
type RequestBody =
  | Record<string, JsonValue | undefined>
  | Credential
  | CreateWebhookOpts
  | McpServerInput
  | { catalog: ProfileCatalog; expectedVersion: number };

export class UserApiError extends Data.TaggedError('UserApiError')<{ readonly message: string }> {
  constructor(message: string, readonly status: number) {
    super({ message });
    this.name = 'Error';
  }
}

function api<Schema extends v.GenericSchema>(
  schema: Schema, method: string, path: string, body?: RequestBody,
): Effect.Effect<v.InferOutput<Schema>> {
  return Effect.gen(function* () {
    const ask = Effect.promise(() => fetch(`/api/user${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      // Reads only: an aborted mutation may already have landed server-side, making a timeout an ambiguous retry (KINU-073).
      signal: method === 'GET' ? AbortSignal.timeout(DEFAULT_CALL_TIMEOUT_MS) : undefined,
    }));

    // Reads only: a write may have landed.
    const res = yield* (method === 'GET' ? Effect.catchDefect(ask, (dropped) => (dropped instanceof TypeError ? ask : Effect.die(dropped))) : ask);

    if (!res.ok) {
      const detail = yield* Effect.promise(() => errorDetail(res));

      return yield* Effect.die(new UserApiError(`${method} /api/user${path} → ${res.status} ${detail}`, res.status));
    }

    return v.parse(schema, yield* Effect.promise(() => res.json()));
  });
}

export const getProfile = () => settle(api(UserProfileSchema, 'GET', '/profile'));

export const completeOnboarding = () => settle(api(v.object({ onboardedAt: v.number() }), 'POST', '/onboarding/complete'));

export const setDisplayName = (displayName: string) => settle(api(UserProfileSchema, 'PATCH', '/profile', { displayName }));

/** The confirmation phrase is the account's own email, checked again server-side. */
export const builtinAuthStatus = () => settle(api(v.object({ enabled: v.boolean(), owner: v.boolean() }), 'GET', '/builtin-auth'));

export const listBuiltinAccounts = () => settle(api(v.object({
  accounts: v.array(v.object({ email: v.string(), role: v.picklist(['owner', 'member']), createdAt: v.number() })),
}), 'GET', '/builtin-auth/accounts'));

export const createBuiltinLink = (kind: 'invites' | 'resets', email: string) =>
  settle(api(v.object({ url: v.string(), email: v.string(), expiresAt: v.number() }), 'POST', `/builtin-auth/${kind}`, { email }));

export const deleteAccount = (confirm: string) =>
  settle(api(v.object({ deleted: v.literal(true) }), 'DELETE', '/account', { confirm }));

export const getCliSetup = () => settle(api(CliSetupSchema, 'GET', '/cli'));

export function listWorkspaces(query: RosterQuery = {}) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }

  const search = params.size === 0 ? '' : `?${params.toString()}`;

  return settle(api(RosterPageSchema, 'GET', `/workspaces${search}`));
}

// `purpose` is the initial mission; omitting `name` lets the server create the identity with the user's model.
export const registerWorkspace  = (name?: string, purpose?: string, displayName?: string) =>
  settle(api(WorkspaceEntrySchema, 'POST', '/workspaces', { name, displayName, purpose }));

/** Records a visit to `name`, and says whether the roster took it. A 404 is the roster no longer holding the
 *  workspace, an answer rather than a failed visit; any other failure throws. */
export function touchWorkspace(name: string): Promise<boolean> {
  return settle(Effect.gen(function* () {
    return yield* Effect.catchCause(Effect.gen(function* () {
      yield* api(OkSchema, 'POST', `/workspaces/${encodeURIComponent(name)}/touch`);

      return true;
    }), (failed) => Effect.gen(function* () {
      const error = Cause.squash(failed);

      if (error instanceof UserApiError && error.status === 404) return false;

      return yield* Effect.failCause(failed);
    }));
  }));
}

export const removeWorkspace    = (name: string) =>
  settle(api(OkSchema, 'DELETE', `/workspaces/${encodeURIComponent(name)}`));

export type UserDevice = v.InferOutput<typeof UserDeviceSchema>;

const DeviceSandboxSchema = v.object({
  tier: v.picklist(DEVICE_TIERS),
  capability: v.picklist(DEVICE_SANDBOX_CAPABILITIES),
  reason: v.nullable(v.picklist(DEVICE_SANDBOX_REASONS)),
  detail: v.optional(v.nullable(v.string()), null),
  gpu: v.pipe(v.array(v.string()), v.readonly()),
});

/** Pre-sandbox rows: switch on by default, capability unproved (the same reading `parseSandboxCapability` gives silence). */
const UNREPORTED_SANDBOX: v.InferOutput<typeof DeviceSandboxSchema> =
  { tier: 'sandboxed', capability: 'files_only', reason: null, detail: null, gpu: [] };

const UserDeviceSchema = v.object({
  id: v.string(), label: v.string(), os: v.nullable(v.string()), hostname: v.nullable(v.string()),
  connected: v.boolean(), createdAt: v.number(), lastSeenAt: v.nullable(v.number()),
  /** Measured from the last rotation (every accepted connect), so a machine in use never reaches it. */
  expiresAt: v.nullable(v.number()),
  /** A stolen `device.json` shows up here as a replacement nobody caused. */
  replacedAt: v.nullable(v.number()),
  revokedAt: v.nullable(v.number()), unstoppedAt: v.nullable(v.number()),
  /** Revoked because its retired key came back: a copy exists. */
  reuseDetectedAt: v.optional(v.nullable(v.number()), null),
  wholeMachine: v.optional(v.boolean(), false),
  /** Workspace-specific home and roots live on the runtime status, not here. */
  sandbox: v.optional(DeviceSandboxSchema, UNREPORTED_SANDBOX),
  version: v.optional(v.nullable(v.string()), null),
  servedVersion: v.optional(v.nullable(v.string()), null),
  update: v.optional(v.picklist(DEVICE_UPDATE_STATES), 'unreported'),
  updateRefusal: v.optional(v.nullable(v.string()), null),
});

const RegisteredDeviceSchema = v.object({ origin: v.string(), installCommand: v.string() });

export const listDevices    = () => settle(api(v.array(UserDeviceSchema), 'GET', '/devices'));

export const registerDevice = (label?: string) =>
  settle(api(RegisteredDeviceSchema, 'POST', '/devices', { label }));

export const renameDevice   = (id: string, name: string) =>
  settle(api(OkSchema, 'PATCH', `/devices/${encodeURIComponent(id)}`, { name }));

export const revokeDevice   = (id: string) =>
  settle(api(v.object({ ok: v.literal(true), unstoppedCommands: v.number() }), 'DELETE', `/devices/${encodeURIComponent(id)}`));

export const acknowledgeUnstoppedDevice = (id: string) =>
  settle(api(OkSchema, 'DELETE', `/devices/${encodeURIComponent(id)}/unstopped`));

/** Owner-session only (403 otherwise). What a command may reach is decided by the machine, not a workspace binding. */
export const setDeviceSandboxTier = (deviceId: string, tier: DeviceTier) =>
  settle(api(OkSchema, 'PUT', `/devices/${encodeURIComponent(deviceId)}/sandbox`, { tier }));

/** Per-(workspace, device) binding: may that workspace use the machine at all. No tier: the device switch decides reach. */
const DeviceConsentSchema = v.object({
  agentName: v.string(), deviceId: v.string(), policy: v.string(),
  lastMethod: v.nullable(v.string()), lastSummary: v.nullable(v.string()),
});

export type DeviceConsent = v.InferOutput<typeof DeviceConsentSchema>;

export const listDeviceConsents = () => settle(api(v.array(DeviceConsentSchema), 'GET', '/devices/consents'));

/** The row is deleted, so the next device call asks again instead of reading as a standing refusal. */
export const revokeDeviceConsent = (deviceId: string, agentName: string) =>
  settle(api(OkSchema, 'DELETE', `/devices/${encodeURIComponent(deviceId)}/consent?agentName=${encodeURIComponent(agentName)}`));

export const listCredentials  = () => settle(api(v.array(CredentialSummarySchema), 'GET', '/credentials'));

export const setCredential    = (key: string, value: Credential) =>
  settle(api(OkSchema, 'POST', `/credentials/${encodeURIComponent(key)}`, value));

export const deleteCredential = (key: string) =>
  settle(api(OkSchema, 'DELETE', `/credentials/${encodeURIComponent(key)}`));

const CodexStatusSchema = v.object({
  connected: v.boolean(), accountId: v.nullable(v.string()), expiresAt: v.nullable(v.number()),
  startedFlow: v.nullable(v.object({ userCode: v.string(), portalURL: v.string(), pollIntervalSec: v.number() })),
});

const PollResultSchema = v.object({
  connected: v.boolean(), accountId: v.optional(v.string()), error: v.optional(v.string()),
});

export const codexStatus      = () => settle(api(CodexStatusSchema, 'GET', '/codex'));

/** Where the owner reviews and limits what Kinu spends of their ChatGPT plan. */
export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage';

/** A sign-in through a machine: waiting for one to connect, or open at the URL for a browser on that machine. */
const ChatGptMachineSignInSchema = v.variant('state', [
  v.object({ state: v.literal('waiting_for_machine') }),
  v.object({ state: v.literal('open'), authorizeUrl: v.string(), device: v.object({ id: v.string(), label: v.string() }) }),
]);

const ChatGptPlanSchema = v.object({
  device: v.nullable(v.object({ id: v.string(), label: v.string() })),
  status: v.nullable(v.object({
    signedIn: v.boolean(), email: v.nullable(v.string()), planEnabled: v.boolean(), planDeclined: v.optional(v.boolean(), false), pending: v.boolean(),
    lastFailure: v.nullable(v.string()), firstSignIn: v.boolean(),
  })),
  account: v.nullable(v.object({ email: v.nullable(v.string()) })),
  machineSignIn: v.nullable(ChatGptMachineSignInSchema),
});

export type ChatGptPlan = v.InferOutput<typeof ChatGptPlanSchema>;

export const chatgptPlan = () => settle(api(ChatGptPlanSchema, 'GET', '/chatgpt'));

/** The URL is for a browser on that device: the sign-in comes back to a port there. */
export const startChatGptSignIn = () => settle(api(ChatGptMachineSignInSchema, 'POST', '/chatgpt/sign-in'));

export const signOutChatGpt = () => settle(api(v.object({ unconfirmed: v.nullable(v.string()) }), 'DELETE', '/chatgpt'));

export const cancelChatGptSignIn = () => settle(api(v.object({ cancelled: v.boolean() }), 'DELETE', '/chatgpt/sign-in'));

/** The browser that opens `authorizeUrl` lands on `redirectUri`; that address is pasted back. */
export const startChatGptPaste = () => settle(api(v.object({ authorizeUrl: v.string(), redirectUri: v.string() }), 'POST', '/chatgpt/paste/start'));

export const finishChatGptPaste = (url: string) => settle(api(
  v.object({ outcome: v.picklist(['signed_in', 'declined', 'plan_declined']), email: v.nullable(v.string()) }), 'POST', '/chatgpt/paste/finish', { url },
));

export const startClaudeSignIn = () => settle(api(v.object({ url: v.string() }), 'POST', '/claude/start'));

/** `code` is what Claude showed: the code, or the address it sent the browser to. */
export const finishClaudeSignIn = (code: string) => settle(api(PollResultSchema, 'POST', '/claude/finish', { code }));

const UnrevokedGrantSchema = v.object({ key: v.string(), reasons: v.array(v.string()), recordedAt: v.number() });

export type UnrevokedGrant = v.InferOutput<typeof UnrevokedGrantSchema>;

export const listUnrevokedGrants = () => settle(api(v.array(UnrevokedGrantSchema), 'GET', '/unrevoked-grants'));

export const dismissUnrevokedGrant = (key: string) => settle(api(OkSchema, 'DELETE', `/unrevoked-grants/${encodeURIComponent(key)}`));

export const disconnectCodex  = () => settle(api(OkSchema, 'DELETE', '/codex'));

export const getAccountUsage = (refresh = false) => settle(api(AccountUsageSchema, 'GET', refresh ? '/usage?refresh=1' : '/usage'));

export const getProfileCatalog = (): Promise<ProfileCatalogEnvelope> =>
  settle(api(ProfileCatalogEnvelopeSchema, 'GET', '/profile-catalog'));

export const updateProfileCatalog = (
  catalog: ProfileCatalog,
  expectedVersion: number,
): Promise<ProfileCatalogEnvelope> =>
  settle(api(ProfileCatalogEnvelopeSchema, 'PUT', '/profile-catalog', { catalog, expectedVersion }));

export const listAvailableModels = (): Promise<ModelMenu> => settle(api(ModelMenuSchema, 'GET', '/models'));

const SANDBOX_SIZE_PATH = `/config/${SANDBOX_SIZE_CONFIG_KEY}`;

export const getAccountSandboxSize = (): Promise<BoxSize | null> =>
  settle(Effect.map(api(v.object({ key: v.string(), value: v.nullable(v.string()) }), 'GET', SANDBOX_SIZE_PATH), (row) => accountSandboxSize(row.value)));

export const setAccountSandboxSize = (size: BoxSize) => settle(api(OkSchema, 'PUT', SANDBOX_SIZE_PATH, { value: size }));

const MemoryOriginSchema = v.nullable(v.object({ by: v.picklist(['agent', 'background', 'owner', 'import']), workspace: v.optional(v.string()), agent: v.optional(v.string()) }));

/** A proposal waiting on the owner, as the account's memory lists it. */
const PendingProposalSchema = v.object({
  id: v.string(),
  proposal: v.variant('kind', [
    v.object({ kind: v.literal('fact'), key: v.string(), value: JsonValueSchema }),
    v.object({ kind: v.literal('note'), content: v.string() }),
  ]),
  origin: MemoryOriginSchema,
  createdAt: v.number(),
});

export type PendingAccountProposal = v.InferOutput<typeof PendingProposalSchema>;

/** On the roster's socket beside its workspace frames: the proposals waiting on the owner, sent as a socket opens and
 *  again whenever one is filed or decided. */
export const AccountMemoryFrameSchema = v.object({ type: v.literal('account_memory'), pending: v.array(PendingProposalSchema) });

const AccountMemorySchema = v.object({
  facts: v.array(v.object({
    key: v.string(), value: JsonValueSchema, importance: v.number(), veracity: v.string(), lastObservedAt: v.number(), origin: MemoryOriginSchema,
    history: v.array(v.object({ forgotten: v.boolean(), value: v.nullable(JsonValueSchema), origin: MemoryOriginSchema, at: v.number() })),
  })),
  notes: v.array(v.object({ id: v.string(), content: v.string(), origin: MemoryOriginSchema, createdAt: v.number() })),
  pending: v.array(PendingProposalSchema),
});

export type AccountMemoryState = v.InferOutput<typeof AccountMemorySchema>;

export type MemoryOrigin = v.InferOutput<typeof MemoryOriginSchema>;

const MEMORY_PATH = '/memory';

export const getAccountMemory = (): Promise<AccountMemoryState> => settle(api(AccountMemorySchema, 'GET', MEMORY_PATH));

export const decideAccountMemory = (id: string, decision: 'accept' | 'decline') =>
  settle(api(OkSchema, 'POST', `${MEMORY_PATH}/proposals/${encodeURIComponent(id)}`, { decision }));

/** An edit, or a workspace fact promoted to the account: `workspace` names where it came from. */
export const putAccountFact = (key: string, value: JsonValue, workspace?: string) =>
  settle(api(v.object({ key: v.string() }), 'PUT', `${MEMORY_PATH}/facts/${encodeURIComponent(key)}`, { value, ...(workspace !== undefined && { workspace }) }));

export const forgetAccountFact = (key: string) => settle(api(v.object({ existed: v.boolean() }), 'DELETE', `${MEMORY_PATH}/facts/${encodeURIComponent(key)}`));

export const forgetAccountNote = (id: string) => settle(api(v.object({ existed: v.boolean() }), 'DELETE', `${MEMORY_PATH}/notes/${encodeURIComponent(id)}`));

export type { ModelTestResult };

export function testModel(spec: string, signal: AbortSignal): Promise<ModelTestResult> {
  return settle(Effect.gen(function* () {
    const res = yield* Effect.promise(async () => fetch('/api/user/models/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec }),
      signal,
    }));

    if (!res.ok) return yield* Effect.die(new Error(`POST /api/user/models/test → ${res.status} ${yield* Effect.promise(async () => errorDetail(res))}`));

    return v.parse(ModelTestResultSchema, yield* Effect.promise(async () => res.json()));
  }));
}

export type ProviderCatalogEntry = v.InferOutput<typeof ProviderCatalogEntrySchema>;

const ProviderCatalogEntrySchema = v.object({
  id: v.string(), credKey: v.string(), name: v.string(), doc: v.optional(v.string()),
  envVar: v.optional(v.string()), connected: v.boolean(),
});

export const listProviderCatalog = () =>
  settle(api(v.array(ProviderCatalogEntrySchema), 'GET', '/providers/catalog'));

export type CloudflareAccountStatus = v.InferOutput<typeof CloudflareAccountStatusSchema>;

const CloudflareAccountStatusSchema = v.object({
  connected: v.boolean(), selectedId: v.nullable(v.string()),
  accounts: v.array(v.object({ id: v.string(), name: v.string() })),
});

export const listCloudflareAccounts = () =>
  settle(api(CloudflareAccountStatusSchema, 'GET', '/cloudflare/accounts'));

const putCloudflareSelection = (path: string, id: string | null) =>
  api(OkSchema, 'PUT', path, { id });

export const selectCloudflareAccount = (id: string) => settle(putCloudflareSelection('/cloudflare/account', id));

export type CloudflareGatewayStatus = v.InferOutput<typeof CloudflareGatewayStatusSchema>;

const CloudflareGatewayStatusSchema = v.object({
  connected: v.boolean(), selectedId: v.nullable(v.string()),
  gateways: v.array(v.object({ id: v.string(), authenticated: v.boolean(), createdAt: v.nullable(v.string()) })),
  error: v.nullable(v.string()),
});

export const listCloudflareGateways = () =>
  settle(api(CloudflareGatewayStatusSchema, 'GET', '/cloudflare/gateways'));

export const selectCloudflareGateway = (id: string | null) => settle(putCloudflareSelection('/cloudflare/gateway', id));

export function cloudflareReconnectPath(returnTo: string): string {
  const params = new URLSearchParams({
    return_to: returnTo || '/',
    prompt: 'login',
  });

  return `/auth/cloudflare/start?${params.toString()}`;
}

export type McpTransport = 'auto' | 'sse' | 'streamable-http';

export interface McpServerInput {
  name?: string;
  serverUrl?: string;
  transport?: McpTransport;
  headers?: Record<string, string>;
  allowedTools?: string[];
  /** A `MCP_PRESETS` id: the catalog supplies name, endpoint and transport. */
  presetId?: string;
}

export const McpServerSummarySchema = v.object({
  id: v.string(), name: v.string(), serverUrl: v.string(),
  transport: v.picklist(['auto', 'sse', 'streamable-http']),
  status: v.picklist(['connecting', 'authenticating', 'connected', 'ready', 'discovering', 'failed', 'unknown']),
  error: v.nullable(v.string()), toolsCount: v.number(), authUrl: v.nullable(v.string()),
  allowedTools: v.nullable(v.array(v.string())), presetId: v.nullable(v.string()),
});

export type McpServerSummary = v.InferOutput<typeof McpServerSummarySchema>;

export const listMcpServers = () => settle(api(v.array(McpServerSummarySchema), 'GET', '/mcp/servers'));

/** Whether the preset's OAuth app is configured, which decides sign-in vs fallback. */
export interface McpPresetAvailability {
  id: string;
  appConfigured: boolean;
}

export const listMcpPresets = () =>
  settle(api(v.array(v.object({ id: v.string(), appConfigured: v.boolean() })), 'GET', '/mcp/presets'));

export const addMcpServer   = (input: McpServerInput) =>
  settle(api(v.object({ id: v.string(), authUrl: v.nullable(v.string()) }), 'POST', '/mcp/servers', input));

export const removeMcpServer = (id: string) =>
  settle(api(OkSchema, 'DELETE', `/mcp/servers/${encodeURIComponent(id)}`));

export interface CreateWebhookOpts {
  label: string;
  auth_mode: 'hmac' | 'bearer' | 'mtls';
  secret?: string;
  accepted_content_type?: string;
  rate_limit_per_min?: number;
}

export type CreateWebhookResult = v.InferOutput<typeof CreateWebhookResultSchema>;

interface AgentRequest<Schema extends v.GenericSchema> {
  schema: Schema;
  method: string;
  agentName: string;
  path: string;
  body?: RequestBody;
}

function agentApi<Schema extends v.GenericSchema>(
  { schema, method, agentName, path, body }: AgentRequest<Schema>,
): Effect.Effect<v.InferOutput<Schema>> {
  return Effect.gen(function* () {
    const res = yield* Effect.promise(() => fetch(`/api/workspaces/${encodeURIComponent(agentName)}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }));

    if (!res.ok) {
      const detail = yield* Effect.promise(() => errorDetail(res));

      return yield* Effect.die(new Error(`${method} /api/workspaces/${agentName}${path} → ${res.status} ${detail}`));
    }

    return v.parse(schema, yield* Effect.promise(() => res.json()));
  });
}

const CreateWebhookResultSchema = v.object({
  trigger_id: v.string(), url: v.string(), auth_mode: v.picklist(['hmac', 'bearer', 'mtls']),
  /** Returned once at creation; never again. */
  secret: v.nullable(v.string()),
});

export const createDurableWebhook = (agentName: string, opts: CreateWebhookOpts) =>
  settle(agentApi({ schema: CreateWebhookResultSchema, method: 'POST', agentName, path: '/triggers', body: opts }));

export const cancelTrigger = (agentName: string, trigger_id: string) =>
  settle(agentApi({
    schema: v.object({ ok: v.boolean(), changed: v.boolean() }),
    method: 'DELETE',
    agentName,
    path: `/triggers/${encodeURIComponent(trigger_id)}`,
  }));
