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

export interface CloudPendingConsent {
  consentId: string;
  deviceLabel: string;
  method: string;
  command: string;
  scope: string;
  createdAt: number;
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
  return cloudJson(origin, '/api/cli/agents', { token });
}

export async function listCloudAvailableModels(origin: string, token: string): Promise<CloudModelMenuEntry[]> {
  return cloudJson(origin, '/api/cli/models', { token });
}

export async function createCloudAgent(origin: string, token: string, input: {
  name?: string; displayName?: string; purpose?: string;
}): Promise<CloudAgent> {
  return cloudJson(origin, '/api/cli/agents', { method: 'POST', token, body: input });
}

export async function createCloudAgentConnectTicket(origin: string, token: string, name: string): Promise<CloudAgentConnectTicket> {
  return cloudJson(origin, `/api/cli/agents/${encodeURIComponent(name)}/connect-ticket`, {
    method: 'POST',
    token,
  });
}

export async function getCloudAgentStatus(origin: string, token: string, name: string): Promise<CloudAgentStatus> {
  return cloudJson(origin, `/api/cli/agents/${encodeURIComponent(name)}/status`, { token });
}

export async function getCloudAgentTools(origin: string, token: string, name: string): Promise<CloudToolDescriptions> {
  return cloudJson(origin, `/api/cli/agents/${encodeURIComponent(name)}/tools`, { token });
}

export async function getCloudAgentMessages(origin: string, token: string, name: string, limit = 100): Promise<CloudChatMessage[]> {
  return cloudJson(origin, `/api/cli/agents/${encodeURIComponent(name)}/messages?limit=${encodeURIComponent(String(limit))}`, { token });
}

export async function listCloudPendingConsents(origin: string, token: string, name: string): Promise<CloudPendingConsent[]> {
  return cloudJson(origin, `/api/cli/agents/${encodeURIComponent(name)}/consents`, { token });
}

export async function resolveCloudDeviceConsent(
  origin: string,
  token: string,
  name: string,
  consentId: string,
  decision: 'once' | 'always' | 'deny',
): Promise<{ ok: boolean }> {
  return cloudJson(origin, `/api/cli/agents/${encodeURIComponent(name)}/consents/${encodeURIComponent(consentId)}`, {
    method: 'POST',
    token,
    body: { decision },
  });
}

export async function getCloudAgentModel(origin: string, token: string, name: string): Promise<{ spec: string | null }> {
  return cloudJson(origin, `/api/cli/agents/${encodeURIComponent(name)}/model`, { token });
}

export async function setCloudAgentModel(origin: string, token: string, name: string, spec: string): Promise<{ ok: true; spec: string }> {
  return cloudJson(origin, `/api/cli/agents/${encodeURIComponent(name)}/model`, {
    method: 'PUT',
    token,
    body: { spec },
  });
}

export async function listCloudTriggers(origin: string, token: string, name: string): Promise<CloudTriggerList> {
  return cloudJson(origin, `/api/cli/agents/${encodeURIComponent(name)}/triggers`, { token });
}

export async function createCloudTimerTrigger(
  origin: string,
  token: string,
  name: string,
  input: { cron?: string; atMs?: number; label?: string; payload?: Record<string, unknown> },
): Promise<{ id: string; kind: 'timer_cron' | 'timer_oneshot'; nextFireAt: number | null }> {
  return cloudJson(origin, `/api/cli/agents/${encodeURIComponent(name)}/triggers/timer`, {
    method: 'POST',
    token,
    body: input,
  });
}

export async function cancelCloudTrigger(origin: string, token: string, name: string, triggerId: string): Promise<{ ok: true; changed: boolean }> {
  return cloudJson(origin, `/api/cli/agents/${encodeURIComponent(name)}/triggers/${encodeURIComponent(triggerId)}`, {
    method: 'DELETE',
    token,
  });
}

export async function listCloudJobs(origin: string, token: string, name: string, limit = 20): Promise<CloudBackgroundJob[]> {
  return cloudJson(origin, `/api/cli/agents/${encodeURIComponent(name)}/jobs?limit=${encodeURIComponent(String(limit))}`, { token });
}

export async function cancelCloudJob(origin: string, token: string, name: string, jobId: string): Promise<{ ok: boolean }> {
  return cloudJson(origin, `/api/cli/agents/${encodeURIComponent(name)}/jobs/${encodeURIComponent(jobId)}`, {
    method: 'DELETE',
    token,
  });
}

export async function stopCloudAgent(origin: string, token: string, name: string): Promise<unknown> {
  return cloudJson(origin, `/api/cli/agents/${encodeURIComponent(name)}/stop`, { method: 'POST', token });
}

export async function getCloudAgentState(origin: string, token: string, name: string): Promise<unknown> {
  return cloudJson(origin, `/api/cli/agents/${encodeURIComponent(name)}/state`, { token });
}

export async function getCloudMemoryContent(origin: string, token: string, name: string): Promise<{ content: string }> {
  return cloudJson(origin, `/api/cli/agents/${encodeURIComponent(name)}/memory`, { token });
}

export async function searchCloudMemory(origin: string, token: string, name: string, query: string, limit = 10): Promise<unknown[]> {
  const qs = new URLSearchParams({ q: query, limit: String(limit) });
  return cloudJson(origin, `/api/cli/agents/${encodeURIComponent(name)}/memory?${qs.toString()}`, { token });
}

export async function listCloudEvents(origin: string, token: string, name: string, opts: { variant?: string; since?: number; limit?: number } = {}): Promise<unknown> {
  return cloudJson(origin, `/api/cli/agents/${encodeURIComponent(name)}/events${query(opts)}`, { token });
}

export async function listCloudTimeline(origin: string, token: string, name: string, opts: { runId?: string; limit?: number } = {}): Promise<unknown[]> {
  return cloudJson(origin, `/api/cli/agents/${encodeURIComponent(name)}/timeline${query(opts)}`, { token });
}

export async function getCloudMctsTree(origin: string, token: string, name: string): Promise<unknown[]> {
  return cloudJson(origin, `/api/cli/agents/${encodeURIComponent(name)}/mcts`, { token });
}

export async function getCloudMctsNode(origin: string, token: string, name: string, nodeId: string): Promise<unknown> {
  return cloudJson(origin, `/api/cli/agents/${encodeURIComponent(name)}/mcts/${encodeURIComponent(nodeId)}`, { token });
}

export async function listCloudHeads(origin: string, token: string, name: string, limit = 20): Promise<unknown[]> {
  return cloudJson(origin, `/api/cli/agents/${encodeURIComponent(name)}/heads?limit=${encodeURIComponent(String(limit))}`, { token });
}

export async function listCloudGepaRuns(origin: string, token: string, name: string, limit = 20): Promise<unknown[]> {
  return cloudJson(origin, `/api/cli/agents/${encodeURIComponent(name)}/gepa?limit=${encodeURIComponent(String(limit))}`, { token });
}

export async function getCloudGepaRun(origin: string, token: string, name: string, runId: string): Promise<unknown> {
  return cloudJson(origin, `/api/cli/agents/${encodeURIComponent(name)}/gepa/${encodeURIComponent(runId)}`, { token });
}

export async function listCloudExecutors(origin: string, token: string, name: string): Promise<unknown[]> {
  return cloudJson(origin, `/api/cli/agents/${encodeURIComponent(name)}/executors`, { token });
}

export async function executeCloudExecutor(origin: string, token: string, name: string, executorId: string, command: string): Promise<unknown> {
  return cloudJson(origin, `/api/cli/agents/${encodeURIComponent(name)}/executors/${encodeURIComponent(executorId)}/exec`, {
    method: 'POST',
    token,
    body: { command },
  });
}

export async function getCloudProductBoard(origin: string, token: string, name: string, limit = 20): Promise<unknown> {
  return cloudJson(origin, `/api/cli/agents/${encodeURIComponent(name)}/product?limit=${encodeURIComponent(String(limit))}`, { token });
}

export async function createCloudWebhookTrigger(
  origin: string,
  token: string,
  name: string,
  input: CloudWebhookTriggerInput,
): Promise<unknown> {
  return cloudJson(origin, `/api/cli/agents/${encodeURIComponent(name)}/triggers/webhook`, {
    method: 'POST',
    token,
    body: input,
  });
}

export async function registerCloudDevice(origin: string, token: string, label?: string): Promise<CloudDeviceRegistration> {
  return cloudJson(origin, '/api/cli/devices', { method: 'POST', token, body: { label } });
}

function query(opts: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(opts)) {
    if (value !== undefined) qs.set(key, String(value));
  }
  const text = qs.toString();
  return text ? `?${text}` : '';
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
