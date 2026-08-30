/**
 * Typed client for the `/api/user/*` HTTP API. The Kinu browser session is
 * attached automatically by the HttpOnly cookie (or local dev's DEV_USER_EMAIL
 * is synthesized server-side), so these fetches are bare.
 */
import {
  ProfileCatalogEnvelopeSchema,
  type Credential,
  type ProfileCatalog,
  type ProfileCatalogEnvelope,
} from '@kinu.run/core';
import { tolerateAsync } from '@kinu.run/core/obs';
import { DEFAULT_CALL_TIMEOUT_MS } from 'agents/client';
import * as v from 'valibot';

export interface UserProfile {
  email: string;
  displayName: string | null;
  createdAt: number;
  lastSeenAt: number;
  /** True when this session's email is on the control-plane operator list.
   *  Decided server-side by the same function that guards `/api/control/*`, so
   *  it drives the nav entry's visibility and nothing else — the gate answers
   *  for itself on every request. */
  controlPlane?: boolean;
}

export interface WorkspaceEntry {
  name: string;
  displayName: string;
  createdAt: number;
  lastVisited: number;
  archivedAt: number | null;
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
}

/** A provider the server could not reach while building the menu (revoked
 *  OAuth grant, unreachable endpoint). Surfaced next to the models so one
 *  broken provider reads as a notice rather than an empty picker. */
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
  /** Whether this session may reach the admin control plane. Optional so a
   *  client running against an older Worker reads `undefined` and hides the nav
   *  entry, rather than failing to parse a profile it otherwise understands. */
  controlPlane: v.optional(v.boolean()),
}));
const WorkspaceEntrySchema = v.object({
  name: v.string(), displayName: v.string(), createdAt: v.number(), lastVisited: v.number(),
  archivedAt: v.nullable(v.number()),
});
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
});
const ProviderFailureSchema = v.object({
  provider: v.string(), label: v.optional(v.string()), reason: v.string(),
});
const ModelMenuSchema = v.object({
  models: v.array(ModelMenuEntrySchema), failures: v.array(ProviderFailureSchema),
});
const StringConfigSchema = v.record(v.string(), v.string());
const ConfigEntrySchema = v.object({ key: v.string(), value: v.nullable(v.string()) });

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

/** The server's `{error}` detail for a failed response, or '' when the body is
 *  not a JSON error envelope. */
async function errorDetail(res: Response): Promise<string> {
  const parsed = v.safeParse(ErrorBodySchema, await tolerateAsync(() => res.json(), 'malformed-input'));
  return parsed.success ? parsed.output.error ?? '' : '';
}

async function api<Schema extends v.GenericSchema, Body>(
  schema: Schema, method: string, path: string, body?: Body,
): Promise<v.InferOutput<Schema>> {
  const res = await fetch(`/api/user${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    // The same deadline every agent RPC already runs under — the agents SDK's
    // own call backstop, imported rather than restated. Bound reads only: an
    // aborted mutation may already have landed server-side, which would turn
    // an honest timeout into an ambiguous retry. A stalled read instead settles
    // as a failure its surface can show and retry (KINU-073).
    signal: method === 'GET' ? AbortSignal.timeout(DEFAULT_CALL_TIMEOUT_MS) : undefined,
  });
  if (!res.ok) throw new Error(`${method} /api/user${path} → ${res.status} ${await errorDetail(res)}`);
  return v.parse(schema, await res.json());
}

// ── Profile ────────────────────────────────────────────────────────
export const getProfile = () => api(UserProfileSchema, 'GET', '/profile');
export const getCliSetup = () => api(CliSetupSchema, 'GET', '/cli');

// ── Agents ─────────────────────────────────────────────────────────
export const listWorkspaces     = () => api(v.object({ entries: v.array(WorkspaceEntrySchema), total: v.number() }), 'GET', '/workspaces');
// `purpose` is the initial mission. When `name` is omitted the server creates
// the agent identity using the user's connected model.
export const registerWorkspace  = (name?: string, purpose?: string, displayName?: string) =>
  api(WorkspaceEntrySchema, 'POST', '/workspaces', { name, displayName, purpose });
export const touchWorkspace     = (name: string) =>
  api(OkSchema, 'POST', `/workspaces/${encodeURIComponent(name)}/touch`);
export const removeWorkspace    = (name: string) =>
  api(OkSchema, 'DELETE', `/workspaces/${encodeURIComponent(name)}`);

// ── Devices (user-level laptop/PC tunnel) ──────────────────────────
export interface UserDevice {
  id: string;
  label: string;
  os: string | null;
  hostname: string | null;
  connected: boolean;
  createdAt: number;
  lastSeenAt: number | null;
  /** When this device's link lapses. Measured from its last ROTATION, which
   *  happens on every accepted connect, so a machine in use never reaches it
   *  and a copy that stopped connecting does. */
  expiresAt: number | null;
  /** Where the newest accepted connection came from, and whether a SECOND
   *  socket ever took this device's slot. A stolen `device.json` shows up
   *  here: an address the owner does not recognise, or a replacement they did
   *  not cause. */
  lastIp: string | null;
  lastAgent: string | null;
  replacedAt: number | null;
  /** Revoked device rows with an unconfirmed-stop incident stay visible until acknowledged. */
  revokedAt: number | null;
  /** The owner revoked this device while a command lacked confirmed termination. */
  unstoppedAt: number | null;
}
export interface RegisteredDevice {
  origin: string;
  installCommand: string;
}
const UserDeviceSchema = v.object({
  id: v.string(), label: v.string(), os: v.nullable(v.string()), hostname: v.nullable(v.string()),
  connected: v.boolean(), createdAt: v.number(), lastSeenAt: v.nullable(v.number()), expiresAt: v.nullable(v.number()),
  lastIp: v.nullable(v.string()), lastAgent: v.nullable(v.string()), replacedAt: v.nullable(v.number()),
  revokedAt: v.nullable(v.number()), unstoppedAt: v.nullable(v.number()),
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

/** Per-(agent, device) remembered consent: native file actions inside the
 *  connected folder, or full-filesystem plus unrestricted shell access. */
export type DeviceConsentScope = 'all_local_actions' | 'full_filesystem';
const DeviceConsentSchema = v.object({
  agentName: v.string(), deviceId: v.string(), policy: v.string(),
  scope: v.picklist(['all_local_actions', 'full_filesystem']),
  lastMethod: v.nullable(v.string()), lastSummary: v.nullable(v.string()),
});
export type DeviceConsent = v.InferOutput<typeof DeviceConsentSchema>;
export const listDeviceConsents = () => api(v.array(DeviceConsentSchema), 'GET', '/devices/consents');
export const setDeviceConsentScope = (deviceId: string, agentName: string, scope: DeviceConsentScope) =>
  api(OkSchema, 'PUT', `/devices/${encodeURIComponent(deviceId)}/consent`, { agentName, scope });
/** Revoke a workspace's grant on a device. The row is deleted, so the next
 *  device call asks again rather than reading as a standing refusal. */
export const revokeDeviceConsent = (deviceId: string, agentName: string) =>
  api(OkSchema, 'DELETE', `/devices/${encodeURIComponent(deviceId)}/consent?agentName=${encodeURIComponent(agentName)}`);

// ── Credentials ────────────────────────────────────────────────────
export const listCredentials  = () => api(v.array(CredentialSummarySchema), 'GET', '/credentials');
export const setCredential    = (key: string, value: Credential) =>
  api(OkSchema, 'POST', `/credentials/${encodeURIComponent(key)}`, value)
    .then((r) => { invalidateModelsCache(); return r; });
export const deleteCredential = (key: string) =>
  api(OkSchema, 'DELETE', `/credentials/${encodeURIComponent(key)}`)
    .then((r) => { invalidateModelsCache(); return r; });

// ── Codex device flow ──────────────────────────────────────────────
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
  .then((r) => { if (r.connected) invalidateModelsCache(); return r; });
export const disconnectCodex  = () => api(OkSchema, 'DELETE', '/codex')
  .then((r) => { invalidateModelsCache(); return r; });

// ── Config / defaults ──────────────────────────────────────────────
export const listConfig       = () => api(StringConfigSchema, 'GET', '/config');
export const getConfig        = (key: string) => api(ConfigEntrySchema, 'GET', `/config/${encodeURIComponent(key)}`);
export const setConfig        = (key: string, value: string) =>
  api(OkSchema, 'PUT', `/config/${encodeURIComponent(key)}`, { value });

// ── Account roles and model tiers ─────────────────────────────────
export const getProfileCatalog = (): Promise<ProfileCatalogEnvelope> =>
  api(ProfileCatalogEnvelopeSchema, 'GET', '/profile-catalog');
export const updateProfileCatalog = (
  catalog: ProfileCatalog,
  expectedVersion: number,
): Promise<ProfileCatalogEnvelope> =>
  api(ProfileCatalogEnvelopeSchema, 'PUT', '/profile-catalog', { catalog, expectedVersion });

// ── Models + providers ─────────────────────────────────────────────
// The model menu only changes when a provider is connected/disconnected, so it
// is cached for the SPA session and invalidated by the provider mutators above.
let _modelsCache: Promise<ModelMenu> | null = null;
export function listAvailableModels(): Promise<ModelMenu> {
  if (!_modelsCache) {
    _modelsCache = api(ModelMenuSchema, 'GET', '/models').catch((...rejection: [unknown]) => { _modelsCache = null; throw rejection[0]; });
  }
  return _modelsCache;
}
export function invalidateModelsCache(): void { _modelsCache = null; }
export const listConnectedProviders = () =>
  api(v.array(v.object({ id: v.string(), label: v.string(), credentialKeys: v.array(v.string()) })), 'GET', '/providers');

/** One connectable provider (BYO API key) from the models.dev catalog. */
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

// ── Cloudflare account (which account serves Workers AI) ───────────
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
export const selectCloudflareAccount = (id: string) =>
  api(OkSchema, 'PUT', '/cloudflare/account', { id })
    .then((r) => { invalidateModelsCache(); return r; });

// ── Cloudflare AI Gateway (the user's own gateway) ─────────────────
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
export const selectCloudflareGateway = (id: string | null) =>
  api(OkSchema, 'PUT', '/cloudflare/gateway', { id })
    .then((r) => { invalidateModelsCache(); return r; });

export function cloudflareReconnectPath(returnTo: string): string {
  const params = new URLSearchParams({
    return_to: returnTo || '/',
    prompt: 'login',
  });
  return `/auth/cloudflare/start?${params.toString()}`;
}

// ── MCP servers ────────────────────────────────────────────────────

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
  createdAt: number;
  updatedAt: number;
}

export interface McpServerInput {
  name: string;
  serverUrl: string;
  transport?: McpTransport;
  headers?: Record<string, string>;
  allowedTools?: string[];
}

const McpServerSummarySchema = v.object({
  id: v.string(), name: v.string(), serverUrl: v.string(),
  transport: v.picklist(['auto', 'sse', 'streamable-http']),
  status: v.picklist(['connecting', 'authenticating', 'connected', 'ready', 'discovering', 'failed', 'unknown']),
  error: v.nullable(v.string()), toolsCount: v.number(), authUrl: v.nullable(v.string()),
  allowedTools: v.nullable(v.array(v.string())), createdAt: v.number(), updatedAt: v.number(),
});

export const listMcpServers = () => api(v.array(McpServerSummarySchema), 'GET', '/mcp/servers');
export const addMcpServer   = (input: McpServerInput) =>
  api(v.object({ id: v.string(), authUrl: v.nullable(v.string()) }), 'POST', '/mcp/servers', input);
export const removeMcpServer = (id: string) =>
  api(OkSchema, 'DELETE', `/mcp/servers/${encodeURIComponent(id)}`);
export const updateMcpServer = (id: string, patch: Partial<Pick<McpServerInput, 'name' | 'headers' | 'allowedTools'>>) =>
  api(OkSchema, 'PATCH', `/mcp/servers/${encodeURIComponent(id)}`, patch);

// ── EventsHub: triggers + events (per-agent endpoints) ─────────────

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
  secret: string | null;       // returned once at creation; never again
}

/** Agent-scoped HTTP fetch; same auth as the user routes. */
async function agentApi<Schema extends v.GenericSchema, Body>(
  schema: Schema, method: string, agentName: string, path: string, body?: Body,
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
  agentApi(CreateWebhookResultSchema, 'POST', agentName, '/triggers', opts);

export const cancelTrigger = (agentName: string, trigger_id: string) =>
  agentApi(v.object({ ok: v.boolean(), changed: v.boolean() }), 'DELETE', agentName, `/triggers/${encodeURIComponent(trigger_id)}`);
