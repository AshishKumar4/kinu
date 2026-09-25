/** Typed client for `/api/user/*`; the session rides the HttpOnly cookie (dev synthesizes DEV_USER_EMAIL server-side). */
import {
  DEVICE_SANDBOX_CAPABILITIES, DEVICE_SANDBOX_REASONS, DEVICE_TIERS, DEVICE_UPDATE_STATES,
  ProfileCatalogEnvelopeSchema, REASONING_EFFORTS,
  type Credential,
  type DeviceSandboxStatus,
  type DeviceTier,
  type DeviceUpdateState,
  type JsonValue,
  type ProfileCatalog,
  type ProfileCatalogEnvelope,
  type ReasoningEffort,
  type RosterBucket,
  WorkspaceOverviewSchema,
} from '@kinu.run/core';
import { tolerateAsync } from '@kinu.run/core/obs';
import { DEFAULT_CALL_TIMEOUT_MS } from 'agents/client';
import * as v from 'valibot';

export interface UserProfile {
  email: string;
  displayName: string | null;
  createdAt: number;
  lastSeenAt: number;
  onboardedAt: number | null;
  /** An account that already has a workspace is never sent through the wizard. */
  workspaceCount: number;
  /** Nav visibility only, decided by the function that guards `/api/control/*`; that gate answers for itself every request. */
  controlPlane?: boolean;
}

export interface WorkspaceEntry {
  name: string;
  displayName: string;
  createdAt: number;
  lastVisited: number;
  archivedAt: number | null;
}

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

export interface ModelMenuEntry {
  spec: string;
  label: string;
  provider: string;
  capabilities?: string[];
  contextWindow?: number;
  /** Absent when the catalog could not say; empty when the model takes none. */
  reasoningEfforts?: ReasoningEffort[];
}

/** A provider unreachable while building the menu, shown as a notice rather than an empty picker. */
export interface ProviderFailure {
  provider: string;
  label?: string;
  reason: string;
}

export interface ModelMenu {
  models: ModelMenuEntry[];
  failures: ProviderFailure[];
}

const ErrorBodySchema = v.object({ error: v.optional(v.string()) });

const OkSchema = v.object({ ok: v.boolean() });

const UserProfileSchema = v.nullable(v.object({
  email: v.string(), displayName: v.nullable(v.string()), createdAt: v.number(), lastSeenAt: v.number(),
  onboardedAt: v.nullable(v.number()), workspaceCount: v.number(),
  /** Optional so a client against an older Worker hides the nav entry instead of failing to parse. */
  controlPlane: v.optional(v.boolean()),
}));

const WorkspaceEntrySchema = v.object({
  name: v.string(), displayName: v.string(), createdAt: v.number(), lastVisited: v.number(),
  archivedAt: v.nullable(v.number()),
});

const RosterEntrySchema = v.object({ ...WorkspaceEntrySchema.entries, overview: v.nullable(WorkspaceOverviewSchema), decisions: v.number() });

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
  createdAt: v.number(), updatedAt: v.number(),
});

const ModelMenuEntrySchema = v.object({
  spec: v.string(), label: v.string(), provider: v.string(),
  capabilities: v.optional(v.array(v.string())), contextWindow: v.optional(v.number()),
  reasoningEfforts: v.optional(v.array(v.picklist(REASONING_EFFORTS))),
});

const ProviderFailureSchema = v.object({
  provider: v.string(), label: v.optional(v.string()), reason: v.string(),
});

const ModelMenuSchema = v.object({
  models: v.array(ModelMenuEntrySchema), failures: v.array(ProviderFailureSchema),
});

export interface DeviceFlowStart {
  userCode: string;
  deviceAuthId: string;
  pollIntervalSec: number;
  portalURL: string;
}

export interface CliSetup {
  publicOrigin: string;
  installCommand: string;
  setupCommand?: string;
  authCommand: string;
}

export interface PollResult {
  connected: boolean;
  accountId?: string;
  error?: string;
}

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

export class UserApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function api<Schema extends v.GenericSchema>(
  schema: Schema, method: string, path: string, body?: RequestBody,
): Promise<v.InferOutput<Schema>> {
  const res = await fetch(`/api/user${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    // Reads only: an aborted mutation may already have landed server-side, making a timeout an ambiguous retry (KINU-073).
    signal: method === 'GET' ? AbortSignal.timeout(DEFAULT_CALL_TIMEOUT_MS) : undefined,
  });

  if (!res.ok) throw new UserApiError(`${method} /api/user${path} → ${res.status} ${await errorDetail(res)}`, res.status);

  return v.parse(schema, await res.json());
}

export const getProfile = () => api(UserProfileSchema, 'GET', '/profile');

export const completeOnboarding = () => api(v.object({ onboardedAt: v.number() }), 'POST', '/onboarding/complete');

export const setDisplayName = (displayName: string) => api(UserProfileSchema, 'PATCH', '/profile', { displayName });

/** The confirmation phrase is the account's own email, checked again server-side. */
export const deleteAccount = (confirm: string) =>
  api(v.object({ deleted: v.literal(true) }), 'DELETE', '/account', { confirm });

export const getCliSetup = () => api(CliSetupSchema, 'GET', '/cli');

export function listWorkspaces(query: RosterQuery = {}) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }

  const search = params.size === 0 ? '' : `?${params.toString()}`;

  return api(RosterPageSchema, 'GET', `/workspaces${search}`);
}

// `purpose` is the initial mission; omitting `name` lets the server create the identity with the user's model.
export const registerWorkspace  = (name?: string, purpose?: string, displayName?: string) =>
  api(WorkspaceEntrySchema, 'POST', '/workspaces', { name, displayName, purpose });

export const touchWorkspace     = (name: string) =>
  api(OkSchema, 'POST', `/workspaces/${encodeURIComponent(name)}/touch`);

export const removeWorkspace    = (name: string) =>
  api(OkSchema, 'DELETE', `/workspaces/${encodeURIComponent(name)}`);

export interface UserDevice {
  id: string;
  label: string;
  os: string | null;
  hostname: string | null;
  connected: boolean;
  createdAt: number;
  lastSeenAt: number | null;
  /** Measured from the last rotation (every accepted connect), so a machine in use never reaches it. */
  expiresAt: number | null;
  /** A stolen `device.json` shows up here: an unrecognised address or an uncaused replacement. */
  lastIp: string | null;
  lastAgent: string | null;
  replacedAt: number | null;
  revokedAt: number | null;
  unstoppedAt: number | null;
  /** Revoked because its retired key came back: a copy exists. */
  reuseDetectedAt: number | null;
  wholeMachine: boolean;
  version: string | null;
  servedVersion: string | null;
  update: DeviceUpdateState;
  /** Workspace-specific home and roots live on the runtime status, not here. */
  sandbox: UserDeviceSandbox;
}

export type UserDeviceSandbox = Pick<DeviceSandboxStatus, 'tier' | 'capability' | 'reason' | 'detail' | 'gpu'>;

export interface RegisteredDevice {
  origin: string;
  installCommand: string;
}

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
  connected: v.boolean(), createdAt: v.number(), lastSeenAt: v.nullable(v.number()), expiresAt: v.nullable(v.number()),
  lastIp: v.nullable(v.string()), lastAgent: v.nullable(v.string()), replacedAt: v.nullable(v.number()),
  revokedAt: v.nullable(v.number()), unstoppedAt: v.nullable(v.number()),
  reuseDetectedAt: v.optional(v.nullable(v.number()), null),
  wholeMachine: v.optional(v.boolean(), false),
  sandbox: v.optional(DeviceSandboxSchema, UNREPORTED_SANDBOX),
  version: v.optional(v.nullable(v.string()), null),
  servedVersion: v.optional(v.nullable(v.string()), null),
  update: v.optional(v.picklist(DEVICE_UPDATE_STATES), 'unreported'),
});

const RegisteredDeviceSchema = v.object({ origin: v.string(), installCommand: v.string() });

export const listDevices    = () => api(v.array(UserDeviceSchema), 'GET', '/devices');

export const registerDevice = (label?: string) =>
  api(RegisteredDeviceSchema, 'POST', '/devices', { label });

export const renameDevice   = (id: string, name: string) =>
  api(OkSchema, 'PATCH', `/devices/${encodeURIComponent(id)}`, { name });

export const revokeDevice   = (id: string) =>
  api(v.object({ ok: v.literal(true), unstoppedCommands: v.number() }), 'DELETE', `/devices/${encodeURIComponent(id)}`);

export const acknowledgeUnstoppedDevice = (id: string) =>
  api(OkSchema, 'DELETE', `/devices/${encodeURIComponent(id)}/unstopped`);

/** Owner-session only (403 otherwise). What a command may reach is decided by the machine, not a workspace binding. */
export const setDeviceSandboxTier = (deviceId: string, tier: DeviceTier) =>
  api(OkSchema, 'PUT', `/devices/${encodeURIComponent(deviceId)}/sandbox`, { tier });

/** Per-(workspace, device) binding: may that workspace use the machine at all. No tier: the device switch decides reach. */
const DeviceConsentSchema = v.object({
  agentName: v.string(), deviceId: v.string(), policy: v.string(),
  lastMethod: v.nullable(v.string()), lastSummary: v.nullable(v.string()),
});

export type DeviceConsent = v.InferOutput<typeof DeviceConsentSchema>;

export const listDeviceConsents = () => api(v.array(DeviceConsentSchema), 'GET', '/devices/consents');

/** The row is deleted, so the next device call asks again instead of reading as a standing refusal. */
export const revokeDeviceConsent = (deviceId: string, agentName: string) =>
  api(OkSchema, 'DELETE', `/devices/${encodeURIComponent(deviceId)}/consent?agentName=${encodeURIComponent(agentName)}`);

export const listCredentials  = () => api(v.array(CredentialSummarySchema), 'GET', '/credentials');

export const setCredential    = (key: string, value: Credential) =>
  api(OkSchema, 'POST', `/credentials/${encodeURIComponent(key)}`, value)
    .then((r) => { invalidateModelsCache();

 return r; });

export const deleteCredential = (key: string) =>
  api(OkSchema, 'DELETE', `/credentials/${encodeURIComponent(key)}`)
    .then((r) => { invalidateModelsCache();

 return r; });

const DeviceFlowStartSchema = v.object({
  userCode: v.string(), deviceAuthId: v.string(), pollIntervalSec: v.number(), portalURL: v.string(),
});

const CodexStatusSchema = v.object({
  connected: v.boolean(), accountId: v.nullable(v.string()), expiresAt: v.nullable(v.number()),
  startedFlow: v.nullable(v.object({ userCode: v.string(), portalURL: v.string(), pollIntervalSec: v.number() })),
});

const PollResultSchema = v.object({
  connected: v.boolean(), accountId: v.optional(v.string()), error: v.optional(v.string()),
});

export const codexStatus      = () => api(CodexStatusSchema, 'GET', '/codex');

export const startCodexFlow   = () => api(DeviceFlowStartSchema, 'POST', '/codex/start');

export const pollCodexFlow    = () => api(PollResultSchema, 'POST', '/codex/poll')
  .then((r) => { if (r.connected) invalidateModelsCache();

 return r; });

export const disconnectCodex  = () => api(OkSchema, 'DELETE', '/codex')
  .then((r) => { invalidateModelsCache();

 return r; });

export const getProfileCatalog = (): Promise<ProfileCatalogEnvelope> =>
  api(ProfileCatalogEnvelopeSchema, 'GET', '/profile-catalog');

export const updateProfileCatalog = (
  catalog: ProfileCatalog,
  expectedVersion: number,
): Promise<ProfileCatalogEnvelope> =>
  api(ProfileCatalogEnvelopeSchema, 'PUT', '/profile-catalog', { catalog, expectedVersion });

// Cached for the SPA session; the provider mutators above invalidate it.
let _modelsCache: Promise<ModelMenu> | null = null;

export function listAvailableModels(): Promise<ModelMenu> {
  _modelsCache ??= (async () => {
    try {
      return await api(ModelMenuSchema, 'GET', '/models');
    } catch (cause) {
      _modelsCache = null;
      throw cause;
    }
  })();

  return _modelsCache;
}

function invalidateModelsCache(): void { _modelsCache = null; }

export interface ProviderCatalogEntry {
  id: string;
  credKey: string;
  name: string;
  doc?: string;
  envVar?: string;
  connected: boolean;
}

export const listProviderCatalog = () =>
  api(v.array(v.object({
    id: v.string(), credKey: v.string(), name: v.string(), doc: v.optional(v.string()),
    envVar: v.optional(v.string()), connected: v.boolean(),
  })), 'GET', '/providers/catalog');

export interface CloudflareAccountSummary {
  id: string;
  name: string;
}

export interface CloudflareAccountStatus {
  connected: boolean;
  selectedId: string | null;
  accounts: CloudflareAccountSummary[];
}

export const listCloudflareAccounts = () =>
  api(v.object({
    connected: v.boolean(), selectedId: v.nullable(v.string()),
    accounts: v.array(v.object({ id: v.string(), name: v.string() })),
  }), 'GET', '/cloudflare/accounts');

const putCloudflareSelection = (path: string, id: string | null) =>
  api(OkSchema, 'PUT', path, { id })
    .then((r) => { invalidateModelsCache();

 return r; });

export const selectCloudflareAccount = (id: string) => putCloudflareSelection('/cloudflare/account', id);

export interface CloudflareGatewaySummary {
  id: string;
  authenticated: boolean;
  createdAt: string | null;
}

export interface CloudflareGatewayStatus {
  connected: boolean;
  selectedId: string | null;
  gateways: CloudflareGatewaySummary[];
  error: string | null;
}

export const listCloudflareGateways = () =>
  api(v.object({
    connected: v.boolean(), selectedId: v.nullable(v.string()),
    gateways: v.array(v.object({ id: v.string(), authenticated: v.boolean(), createdAt: v.nullable(v.string()) })),
    error: v.nullable(v.string()),
  }), 'GET', '/cloudflare/gateways');

export const selectCloudflareGateway = (id: string | null) => putCloudflareSelection('/cloudflare/gateway', id);

export function cloudflareReconnectPath(returnTo: string): string {
  const params = new URLSearchParams({
    return_to: returnTo || '/',
    prompt: 'login',
  });

  return `/auth/cloudflare/start?${params.toString()}`;
}

export type McpTransport = 'auto' | 'sse' | 'streamable-http';

export type McpConnectionStatus =
  | 'connecting' | 'authenticating' | 'connected'
  | 'ready' | 'discovering' | 'failed' | 'unknown';

export interface McpServerSummary {
  id: string;
  name: string;
  serverUrl: string;
  transport: McpTransport;
  status: McpConnectionStatus;
  error: string | null;
  toolsCount: number;
  authUrl: string | null;
  allowedTools: string[] | null;
  presetId: string | null;
  createdAt: number;
  updatedAt: number;
}

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
  createdAt: v.number(), updatedAt: v.number(),
});

export const listMcpServers = () => api(v.array(McpServerSummarySchema), 'GET', '/mcp/servers');

/** Whether the preset's OAuth app is configured, which decides sign-in vs fallback. */
export interface McpPresetAvailability {
  id: string;
  appConfigured: boolean;
}

export const listMcpPresets = () =>
  api(v.array(v.object({ id: v.string(), appConfigured: v.boolean() })), 'GET', '/mcp/presets');

export const addMcpServer   = (input: McpServerInput) =>
  api(v.object({ id: v.string(), authUrl: v.nullable(v.string()) }), 'POST', '/mcp/servers', input);

export const removeMcpServer = (id: string) =>
  api(OkSchema, 'DELETE', `/mcp/servers/${encodeURIComponent(id)}`);

export interface CreateWebhookOpts {
  label: string;
  auth_mode: 'hmac' | 'bearer' | 'mtls';
  secret?: string;
  accepted_content_type?: string;
  rate_limit_per_min?: number;
}

export interface CreateWebhookResult {
  trigger_id: string;
  url: string;
  auth_mode: 'hmac' | 'bearer' | 'mtls';
  secret: string | null;       // Returned once at creation; never again.
}

interface AgentRequest<Schema extends v.GenericSchema> {
  schema: Schema;
  method: string;
  agentName: string;
  path: string;
  body?: RequestBody;
}

async function agentApi<Schema extends v.GenericSchema>(
  { schema, method, agentName, path, body }: AgentRequest<Schema>,
): Promise<v.InferOutput<Schema>> {
  const res = await fetch(`/api/workspaces/${encodeURIComponent(agentName)}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    throw new Error(`${method} /api/workspaces/${agentName}${path} → ${res.status} ${await errorDetail(res)}`);
  }

  return v.parse(schema, await res.json());
}

const CreateWebhookResultSchema = v.object({
  trigger_id: v.string(), url: v.string(), auth_mode: v.picklist(['hmac', 'bearer', 'mtls']),
  secret: v.nullable(v.string()),
});

export const createDurableWebhook = (agentName: string, opts: CreateWebhookOpts) =>
  agentApi({ schema: CreateWebhookResultSchema, method: 'POST', agentName, path: '/triggers', body: opts });

export const cancelTrigger = (agentName: string, trigger_id: string) =>
  agentApi({
    schema: v.object({ ok: v.boolean(), changed: v.boolean() }),
    method: 'DELETE',
    agentName,
    path: `/triggers/${encodeURIComponent(trigger_id)}`,
  });
