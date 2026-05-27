/**
 * Typed client for the `/api/user/*` HTTP API. CF Access JWT is attached
 * automatically by the browser's cookie (or local dev's DEV_USER_EMAIL is
 * synthesized server-side), so these fetches are bare.
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
  purpose: string;
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
}

export interface DeviceFlowStart {
  userCode: string;
  deviceAuthId: string;
  pollIntervalSec: number;
  portalURL: string;
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

// ── Agents ─────────────────────────────────────────────────────────
export const listAgents     = () => api<AgentEntry[]>('GET', '/agents');
export const registerAgent  = (name: string, displayName: string, purpose?: string) =>
  api<AgentEntry>('POST', '/agents', { name, displayName, purpose });
export const touchAgent     = (name: string) =>
  api<{ ok: boolean }>('POST', `/agents/${encodeURIComponent(name)}/touch`);
export const removeAgent    = (name: string) =>
  api<{ ok: boolean }>('DELETE', `/agents/${encodeURIComponent(name)}`);

// ── Credentials ────────────────────────────────────────────────────
export const listCredentials  = () => api<CredentialSummary[]>('GET', '/credentials');
export const setCredential    = (key: string, value: unknown) =>
  api<{ ok: boolean }>('POST', `/credentials/${encodeURIComponent(key)}`, value);
export const deleteCredential = (key: string) =>
  api<{ ok: boolean }>('DELETE', `/credentials/${encodeURIComponent(key)}`);

// ── Codex device flow ──────────────────────────────────────────────
export const codexStatus      = () => api<CodexStatus>('GET', '/codex');
export const startCodexFlow   = () => api<DeviceFlowStart>('POST', '/codex/start');
export const pollCodexFlow    = () => api<PollResult>('POST', '/codex/poll');
export const disconnectCodex  = () => api<{ ok: boolean }>('DELETE', '/codex');

// ── Config / defaults ──────────────────────────────────────────────
export const listConfig       = () => api<Record<string, string>>('GET', '/config');
export const getConfig        = (key: string) => api<{ key: string; value: string | null }>('GET', `/config/${encodeURIComponent(key)}`);
export const setConfig        = (key: string, value: string) =>
  api<{ ok: boolean }>('PUT', `/config/${encodeURIComponent(key)}`, { value });

// ── Models + providers ─────────────────────────────────────────────
export const listAvailableModels    = () => api<ModelMenuEntry[]>('GET', '/models');
export const listConnectedProviders = () =>
  api<Array<{ id: string; label: string; credentialKeys: string[] }>>('GET', '/providers');
