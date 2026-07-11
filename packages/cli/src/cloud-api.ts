import { resolveCloudOrigin } from './config.js';

export interface CliAuthStart {
  deviceToken: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: string;
  intervalSeconds: number;
}

export interface CliAuthPoll {
  status: 'pending' | 'approved' | 'expired';
  message?: string;
  origin?: string;
  token?: string;
  expiresAt?: string;
  user?: { id: string; email: string };
}

export interface CloudAgent {
  name: string;
  displayName: string;
  createdAt: number;
  lastVisited: number;
  archivedAt: number | null;
}

export interface CloudDeviceRegistration {
  deviceId: string;
  token: string;
  userId: string;
  origin: string;
}

export interface CloudDevice {
  id: string;
  label: string;
  os: string | null;
  hostname: string | null;
  connected: boolean;
  createdAt: number;
  lastSeenAt: number | null;
}

export interface CloudAgentConnectTicket {
  ticket: string;
  expiresAt: number;
}

export interface CloudAgentStatus {
  id: string;
  name: string;
  displayName?: string;
  purpose: string;
  soul: string;
  createdAt: number;
  scaffoldVersion: number;
  searchNodeCount: number;
  craftedToolCount: number;
  messageCount: number;
  model?: string | null;
}

export interface CloudChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string | number;
}

export interface CloudToolDescriptions {
  builtIn: Array<{ name: string; description: string }>;
  crafted: Array<{ name: string; description: string; isLearned?: boolean; qualityScore?: number; usageCount?: number }>;
  executors: unknown[];
}

export interface CloudTriggerList {
  triggers: Array<{
    id: string;
    kind: string;
    spec: unknown;
    state: string;
    created_at: number;
    next_fire_at?: number | null;
    last_fire_at?: number | null;
    fire_count?: number;
  }>;
}

export interface CloudBackgroundJob {
  id: string;
  kind: string;
  status: string;
  createdAt?: number;
  settledAt?: number | null;
  error?: string | null;
}

export interface CloudModelMenuEntry {
  spec: string;
  label: string;
  provider: string;
  capabilities?: string[];
  contextWindow?: number;
}

export interface CloudWebhookTriggerInput {
  label: string;
  auth_mode: 'hmac' | 'bearer' | 'mtls';
  secret?: string;
  accepted_content_type?: string;
  rate_limit_per_min?: number;
}

/**
 * Invoke a named agent method over the generic RPC transport —
 * POST /api/cli/workspaces/:name/rpc `{ method, args }` → `{ result }`.
 * The server's AGENT_RPC_ACCESS table (cf-backend cli/rpc-gate.ts) is the
 * method allowlist and the per-method auth policy; this is the ONE
 * method-shaped path between the CLI and a cloud agent.
 */
export async function callAgentRpc<T>(
  origin: string,
  token: string,
  name: string,
  method: string,
  args: unknown[] = [],
): Promise<T> {
  const body = await cloudJson<{ result: T }>(origin, `/api/cli/workspaces/${encodeURIComponent(name)}/rpc`, {
    method: 'POST',
    token,
    body: { method, args },
  });
  return body.result;
}

export async function startCliAuth(origin: string, deviceName: string): Promise<CliAuthStart> {
  return cloudJson<CliAuthStart>(origin, '/api/cli/auth/start', {
    method: 'POST',
    body: { deviceName },
  });
}

export async function pollCliAuth(origin: string, deviceToken: string): Promise<CliAuthPoll> {
  return cloudJson<CliAuthPoll>(origin, '/api/cli/auth/poll', {
    method: 'POST',
    body: { deviceToken },
  });
}

export async function whoami(origin: string, token: string): Promise<{ user: { id: string; email: string; displayName?: string | null } }> {
  return cloudJson(origin, '/api/cli/me', { token });
}

export async function logout(origin: string, token: string): Promise<{ ok: boolean }> {
  return cloudJson(origin, '/api/cli/logout', { method: 'POST', token });
}

export async function listCloudAgents(origin: string, token: string): Promise<CloudAgent[]> {
  return cloudJson(origin, '/api/cli/workspaces', { token });
}

export async function listCloudAvailableModels(origin: string, token: string): Promise<CloudModelMenuEntry[]> {
  return cloudJson(origin, '/api/cli/models', { token });
}

export async function createCloudAgent(origin: string, token: string, input: {
  name?: string; displayName?: string; purpose?: string;
}): Promise<CloudAgent> {
  return cloudJson(origin, '/api/cli/workspaces', { method: 'POST', token, body: input });
}

export async function createCloudAgentConnectTicket(origin: string, token: string, name: string): Promise<CloudAgentConnectTicket> {
  return cloudJson(origin, `/api/cli/workspaces/${encodeURIComponent(name)}/connect-ticket`, {
    method: 'POST',
    token,
  });
}

/** Webhook creation stays route-shaped: it is step-up gated (fresh
 *  `proteus auth`) server-side, unlike table-gated agent RPCs. */
export async function createCloudWebhookTrigger(
  origin: string,
  token: string,
  name: string,
  input: CloudWebhookTriggerInput,
): Promise<unknown> {
  return cloudJson(origin, `/api/cli/workspaces/${encodeURIComponent(name)}/triggers/webhook`, {
    method: 'POST',
    token,
    body: input,
  });
}

export interface CloudAccessToken {
  tokenHash: string;
  name: string;
  scopes: string[];
  createdAt: number;
  lastUsedAt: number | null;
}

export async function createCliAccessToken(
  origin: string,
  token: string,
  input: { name: string; scopes: string[] },
): Promise<{ token: string; name: string; scopes: string[]; createdAt: number }> {
  return cloudJson(origin, '/api/cli/tokens', { method: 'POST', token, body: input });
}

export async function listCliAccessTokens(origin: string, token: string): Promise<{ tokens: CloudAccessToken[] }> {
  return cloudJson(origin, '/api/cli/tokens', { token });
}

export async function revokeCliAccessToken(origin: string, token: string, ref: string): Promise<{ ok: boolean }> {
  return cloudJson(origin, `/api/cli/tokens/${encodeURIComponent(ref)}`, { method: 'DELETE', token });
}

export async function registerCloudDevice(origin: string, token: string, label?: string): Promise<CloudDeviceRegistration> {
  return cloudJson(origin, '/api/cli/devices', { method: 'POST', token, body: { label } });
}

export async function listCloudDevices(origin: string, token: string): Promise<CloudDevice[]> {
  return cloudJson(origin, '/api/cli/devices', { token });
}

async function cloudJson<T>(
  origin: string,
  path: string,
  opts: { method?: string; body?: unknown; token?: string } = {},
): Promise<T> {
  const res = await fetch(`${origin.replace(/\/+$/, '')}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const contentType = res.headers.get('content-type') ?? '';
  const body = contentType.includes('application/json')
    ? await res.json().catch(() => ({}))
    : { error: await res.text().catch(() => '') };
  if (!res.ok) {
    const message = typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return body as T;
}

export function defaultOrigin(opts?: { origin?: string }): string {
  return resolveCloudOrigin(opts);
}
