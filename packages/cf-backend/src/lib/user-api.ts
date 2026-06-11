/**
 * Typed client for the `/api/user/*` HTTP API. The Proteus browser session is
 * attached automatically by the HttpOnly cookie (or local dev's DEV_USER_EMAIL
 * is synthesized server-side), so these fetches are bare.
 */

export interface UserProfile {
  email: string;
  displayName: string | null;
  createdAt: number;
  lastSeenAt: number;
}

export interface AgentEntry {
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

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/user${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = '';
    try { const j = await res.json() as { error?: string }; detail = j?.error ?? ''; } catch { /* nop */ }
    throw new Error(`${method} /api/user${path} → ${res.status} ${detail}`);
  }
  return await res.json() as T;
}

// ── Profile ────────────────────────────────────────────────────────
export const getProfile = () => api<UserProfile | null>('GET', '/profile');
export const getCliSetup = () => api<CliSetup>('GET', '/cli');

// ── Agents ─────────────────────────────────────────────────────────
export const listAgents     = () => api<AgentEntry[]>('GET', '/agents');
// `purpose` is the initial mission. When `name` is omitted the server creates
// the agent identity using the user's connected model.
export const registerAgent  = (name?: string, purpose?: string, displayName?: string) =>
  api<AgentEntry>('POST', '/agents', { name, displayName, purpose });
export const touchAgent     = (name: string) =>
  api<{ ok: boolean }>('POST', `/agents/${encodeURIComponent(name)}/touch`);
export const removeAgent    = (name: string) =>
  api<{ ok: boolean }>('DELETE', `/agents/${encodeURIComponent(name)}`);

// ── Devices (user-level laptop/PC tunnel) ──────────────────────────
export interface UserDevice {
  id: string;
  label: string;
  os: string | null;
  hostname: string | null;
  connected: boolean;
  createdAt: number;
  lastSeenAt: number | null;
}
export interface RegisteredDevice {
  origin: string;
  installCommand: string;
}
export const listDevices    = () => api<UserDevice[]>('GET', '/devices');
export const registerDevice = (label?: string) =>
  api<RegisteredDevice>('POST', '/devices', { label });
export const revokeDevice   = (id: string) =>
  api<{ ok: boolean }>('DELETE', `/devices/${encodeURIComponent(id)}`);

// ── Credentials ────────────────────────────────────────────────────
export const listCredentials  = () => api<CredentialSummary[]>('GET', '/credentials');
export const setCredential    = (key: string, value: unknown) =>
  api<{ ok: boolean }>('POST', `/credentials/${encodeURIComponent(key)}`, value)
    .then((r) => { invalidateModelsCache(); return r; });
export const deleteCredential = (key: string) =>
  api<{ ok: boolean }>('DELETE', `/credentials/${encodeURIComponent(key)}`)
    .then((r) => { invalidateModelsCache(); return r; });

// ── Codex device flow ──────────────────────────────────────────────
export const codexStatus      = () => api<CodexStatus>('GET', '/codex');
export const startCodexFlow   = () => api<DeviceFlowStart>('POST', '/codex/start');
export const pollCodexFlow    = () => api<PollResult>('POST', '/codex/poll')
  .then((r) => { if (r.connected) invalidateModelsCache(); return r; });
export const disconnectCodex  = () => api<{ ok: boolean }>('DELETE', '/codex')
  .then((r) => { invalidateModelsCache(); return r; });

// ── Config / defaults ──────────────────────────────────────────────
export const listConfig       = () => api<Record<string, string>>('GET', '/config');
export const getConfig        = (key: string) => api<{ key: string; value: string | null }>('GET', `/config/${encodeURIComponent(key)}`);
export const setConfig        = (key: string, value: string) =>
  api<{ ok: boolean }>('PUT', `/config/${encodeURIComponent(key)}`, { value });

// ── Models + providers ─────────────────────────────────────────────
// The model menu only changes when a provider is connected/disconnected, so it
// is cached for the SPA session and invalidated by the provider mutators above.
let _modelsCache: Promise<ModelMenuEntry[]> | null = null;
export function listAvailableModels(): Promise<ModelMenuEntry[]> {
  if (!_modelsCache) {
    _modelsCache = api<ModelMenuEntry[]>('GET', '/models').catch((e) => { _modelsCache = null; throw e; });
  }
  return _modelsCache;
}
export function invalidateModelsCache(): void { _modelsCache = null; }
export const listConnectedProviders = () =>
  api<Array<{ id: string; label: string; credentialKeys: string[] }>>('GET', '/providers');

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
  api<ProviderCatalogEntry[]>('GET', '/providers/catalog');

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
  api<CloudflareGatewayStatus>('GET', '/cloudflare/gateways');
export const selectCloudflareGateway = (id: string | null) =>
  api<{ ok: boolean }>('PUT', '/cloudflare/gateway', { id })
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

export const listMcpServers = () => api<McpServerSummary[]>('GET', '/mcp/servers');
export const addMcpServer   = (input: McpServerInput) =>
  api<{ id: string; authUrl: string | null }>('POST', '/mcp/servers', input);
export const removeMcpServer = (id: string) =>
  api<{ ok: boolean }>('DELETE', `/mcp/servers/${encodeURIComponent(id)}`);
export const updateMcpServer = (id: string, patch: Partial<Pick<McpServerInput, 'name' | 'headers' | 'allowedTools'>>) =>
  api<{ ok: boolean }>('PATCH', `/mcp/servers/${encodeURIComponent(id)}`, patch);

// ── EventsHub: triggers + events (per-agent endpoints) ─────────────

export interface TriggerSummary {
  id: string;
  kind: 'webhook_durable' | 'webhook_ephemeral' | 'timer_oneshot' | 'timer_cron'
      | 'process_watch' | 'file_watch' | 'peer_inbox' | 'mcp_route';
  spec: Record<string, unknown>;
  creator_trust: 'external' | 'authenticated' | 'owner' | 'self';
  state: 'active' | 'paused' | 'revoked';
  created_at: number;
  paused_at: number | null;
  revoked_at: number | null;
  rate_limit_per_min: number;
}

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

export interface EventRow {
  id: string;
  trace_id: string;
  caused_by: string | null;
  ingress: string;
  variant: string;
  trust: 'external' | 'authenticated' | 'owner' | 'self';
  priority: 'urgent' | 'normal' | 'background';
  payload_visibility: 'full' | 'redact' | 'hash' | 'hmac' | 'opaque_handle';
  payload: unknown;
  received_at: number;
}

/** Agent-scoped HTTP fetch; same auth as the user routes. */
async function agentApi<T>(method: string, agentName: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/agents/${encodeURIComponent(agentName)}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = '';
    try { const j = await res.json() as { error?: string }; detail = j?.error ?? ''; } catch { /* nop */ }
    throw new Error(`${method} /api/agents/${agentName}${path} → ${res.status} ${detail}`);
  }
  return await res.json() as T;
}

export const listTriggers = (agentName: string) =>
  agentApi<{ triggers: TriggerSummary[] }>('GET', agentName, '/triggers');

export const createDurableWebhook = (agentName: string, opts: CreateWebhookOpts) =>
  agentApi<CreateWebhookResult>('POST', agentName, '/triggers', opts);

export const cancelTrigger = (agentName: string, trigger_id: string) =>
  agentApi<{ ok: boolean; changed: boolean }>('DELETE', agentName, `/triggers/${encodeURIComponent(trigger_id)}`);

export const listAgentEvents = (agentName: string, opts?: { variant?: string; since?: number; limit?: number }) => {
  const qs = new URLSearchParams();
  if (opts?.variant) qs.set('variant', opts.variant);
  if (opts?.since)   qs.set('since', String(opts.since));
  if (opts?.limit)   qs.set('limit', String(opts.limit));
  const tail = qs.toString();
  return agentApi<{ events: EventRow[] }>('GET', agentName, `/events${tail ? '?' + tail : ''}`);
};
