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
  purpose: string;
  createdAt: number;
  lastVisited: number;
  archivedAt: number | null;
}

export interface CloudDeviceRegistration {
  deviceId: string;
  token: string;
  userId: string;
  origin: string;
  installCommand: string;
}

export interface CloudTurnResult {
  text: string;
  toolCalls?: Array<{ name: string; args: unknown; result?: string }>;
  steps?: number;
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

export async function createCloudAgent(origin: string, token: string, input: {
  name: string; displayName?: string; purpose?: string;
}): Promise<CloudAgent> {
  return cloudJson(origin, '/api/cli/agents', { method: 'POST', token, body: input });
}

export async function runCloudTurn(origin: string, token: string, name: string, prompt: string, cwd: string): Promise<CloudTurnResult> {
  return cloudJson(origin, `/api/cli/agents/${encodeURIComponent(name)}/turn`, {
    method: 'POST',
    token,
    body: { prompt, cwd },
  });
}

export async function registerCloudDevice(origin: string, token: string, label?: string): Promise<CloudDeviceRegistration> {
  return cloudJson(origin, '/api/cli/devices', { method: 'POST', token, body: { label } });
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
