import type { OAuthCredential } from '@proteus/core';

export const CLOUDFLARE_OAUTH_CRED_KEY = 'cloudflare.oauth';
export const CLOUDFLARE_WORKERS_AI_SCOPES = 'user-details.read';

const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
const CLOUDFLARE_TOKEN_URL = 'https://dash.cloudflare.com/oauth2/token';

export interface CloudflareOAuthEnv {
  CLOUDFLARE_OAUTH_CLIENT_ID?: string;
  CLOUDFLARE_OAUTH_CLIENT_SECRET?: string;
  CLOUDFLARE_OAUTH_TOKEN_AUTH_METHOD?: string;
}

export interface CloudflareAccount {
  id: string;
  name: string;
}

export interface CloudflareTokenPayload {
  access_token?: unknown;
  refresh_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

export async function requestCloudflareOAuthToken(
  env: CloudflareOAuthEnv,
  fields: Record<string, string>,
): Promise<Record<string, unknown>> {
  const clientId = cleanEnv(env.CLOUDFLARE_OAUTH_CLIENT_ID);
  const clientSecret = cleanEnv(env.CLOUDFLARE_OAUTH_CLIENT_SECRET);
  if (!clientId) throw new Error('Cloudflare OAuth client id is not configured.');

  const body = new URLSearchParams({ client_id: clientId, ...fields });
  const headers = new Headers({
    accept: 'application/json',
    'content-type': 'application/x-www-form-urlencoded',
  });

  if (clientSecret) {
    if (env.CLOUDFLARE_OAUTH_TOKEN_AUTH_METHOD === 'client_secret_post') {
      body.set('client_secret', clientSecret);
    } else {
      headers.set('authorization', `Basic ${base64(`${clientId}:${clientSecret}`)}`);
    }
  }

  const response = await fetch(CLOUDFLARE_TOKEN_URL, { method: 'POST', headers, body });
  const payload = await readJsonObject(response, 'Cloudflare token endpoint');
  if (!response.ok) {
    const reason = stringField(payload, 'error_description') ?? stringField(payload, 'error') ?? `HTTP ${response.status}`;
    throw new Error(`Cloudflare token refresh failed: ${reason}`);
  }
  return payload;
}

export async function fetchCloudflareAccounts(accessToken: string): Promise<CloudflareAccount[]> {
  const response = await fetch(`${CLOUDFLARE_API}/accounts`, {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${accessToken}`,
    },
  });
  const payload = await readJsonObject(response, 'Cloudflare accounts endpoint');
  if (!response.ok) {
    const reason = stringField(payload, 'error_description') ?? firstCloudflareError(payload) ?? `HTTP ${response.status}`;
    throw new Error(`Cloudflare account lookup failed: ${reason}`);
  }

  const result = Array.isArray(payload.result) ? payload.result : [];
  return result
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const row = item as Record<string, unknown>;
      const id = typeof row.id === 'string' ? row.id : '';
      if (!isCloudflareAccountId(id)) return null;
      const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : id;
      return { id, name };
    })
    .filter((item): item is CloudflareAccount => item !== null);
}

export async function cloudflareTokenToCredential(
  token: CloudflareTokenPayload,
): Promise<OAuthCredential> {
  const accessToken = stringValue(token.access_token);
  if (!accessToken) throw new Error('Cloudflare OAuth did not return an access token.');

  const refreshToken = stringValue(token.refresh_token);
  if (!refreshToken) {
    throw new Error('Cloudflare OAuth did not return a refresh token. Enable the Refresh Token grant on the OAuth client.');
  }

  const accounts = await fetchCloudflareAccounts(accessToken);
  const account = accounts[0] ?? null;
  if (!account) {
    throw new Error('Cloudflare OAuth did not expose an account for Workers AI billing.');
  }

  return {
    kind: 'oauth',
    accessToken,
    refreshToken,
    expiresAt: expiresAtFromToken(token),
    metadata: {
      accountId: account.id,
      accountName: account.name,
      scopes: scopeList(token.scope),
      tokenType: stringValue(token.token_type) ?? 'bearer',
    },
  };
}

export async function refreshCloudflareCredential(
  env: CloudflareOAuthEnv,
  current: OAuthCredential,
): Promise<OAuthCredential> {
  const token = await requestCloudflareOAuthToken(env, {
    grant_type: 'refresh_token',
    refresh_token: current.refreshToken,
  }) as CloudflareTokenPayload;

  const accessToken = stringValue(token.access_token) ?? current.accessToken;
  const refreshToken = stringValue(token.refresh_token) ?? current.refreshToken;
  return {
    ...current,
    accessToken,
    refreshToken,
    expiresAt: expiresAtFromToken(token) ?? current.expiresAt,
    metadata: {
      ...(current.metadata ?? {}),
      scopes: scopeList(token.scope) ?? current.metadata?.scopes,
      tokenType: stringValue(token.token_type) ?? current.metadata?.tokenType ?? 'bearer',
    },
  };
}

export function cloudflareWorkersAIBaseURL(accountId: string): string | null {
  if (!isCloudflareAccountId(accountId)) return null;
  return `${CLOUDFLARE_API}/accounts/${encodeURIComponent(accountId)}/ai/v1`;
}

export function accountIdFromCloudflareCredential(credential: OAuthCredential): string | null {
  const accountId = credential.metadata?.accountId;
  return typeof accountId === 'string' && isCloudflareAccountId(accountId) ? accountId : null;
}

export function isCloudflareCredentialExpiring(credential: OAuthCredential, skewMs = 60_000): boolean {
  return typeof credential.expiresAt === 'number' && credential.expiresAt <= Date.now() + skewMs;
}

function cleanEnv(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function expiresAtFromToken(token: CloudflareTokenPayload): number | undefined {
  const raw = token.expires_in;
  const seconds = typeof raw === 'number'
    ? raw
    : typeof raw === 'string' && raw.trim()
      ? Number(raw)
      : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Date.now() + Math.max(0, seconds - 30) * 1000;
}

function scopeList(value: unknown): string[] | undefined {
  if (typeof value === 'string') {
    const scopes = value.trim().split(/\s+/).filter(Boolean);
    return scopes.length ? scopes : undefined;
  }
  if (Array.isArray(value)) {
    const scopes = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
    return scopes.length ? scopes : undefined;
  }
  return undefined;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stringField(obj: Record<string, unknown>, key: string): string | null {
  return stringValue(obj[key]);
}

function firstCloudflareError(obj: Record<string, unknown>): string | null {
  const errors = Array.isArray(obj.errors) ? obj.errors : [];
  for (const error of errors) {
    if (!error || typeof error !== 'object') continue;
    const message = stringField(error as Record<string, unknown>, 'message');
    if (message) return message;
  }
  return null;
}

async function readJsonObject(response: Response, label: string): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new Error(`${label} did not return JSON.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} returned an invalid JSON body.`);
  }
  return parsed as Record<string, unknown>;
}

function isCloudflareAccountId(value: string): boolean {
  return /^[a-fA-F0-9]{16,64}$/.test(value);
}

function base64(value: string): string {
  return btoa(value);
}
