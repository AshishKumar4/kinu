import type { OAuthCredential } from '@proteus/core';

export const CLOUDFLARE_OAUTH_CRED_KEY = 'cloudflare.oauth';
/** DERIVED credential key — never stored. UserDO serves it from the same
 *  `cloudflare.oauth` row, but the header bundle targets the user's OWN
 *  selected AI Gateway (`cf-aig-gateway-id`). Resolves to null until a
 *  gateway is selected, which is what gates the `my-gateway` provider. */
export const CLOUDFLARE_AI_GATEWAY_CRED_KEY = 'cloudflare.ai-gateway';
// `offline_access` is what makes dash.cloudflare.com issue a refresh token
// (the OAuth client must also have the Refresh Token grant enabled). Without
// it the credential dies at access-token expiry and Workers AI "disconnects".
// `aig.read` (AI Gateway Read) powers gateway discovery + BYOK provider-key
// listing for the my-gateway provider; `aig.run` covers inference. Users who
// connected before a scope was added need one re-login to grant it.
export const CLOUDFLARE_WORKERS_AI_SCOPES = 'user-details.read account-settings.read ai.write aig.read aig.run offline_access';
export const DEFAULT_CLOUDFLARE_AI_GATEWAY_ID = 'default';

const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
const CLOUDFLARE_TOKEN_URL = 'https://dash.cloudflare.com/oauth2/token';

export interface CloudflareOAuthEnv {
  CLOUDFLARE_OAUTH_CLIENT_ID?: string;
  CLOUDFLARE_OAUTH_CLIENT_SECRET?: string;
  CLOUDFLARE_OAUTH_TOKEN_AUTH_METHOD?: string;
  CLOUDFLARE_AI_GATEWAY_ID?: string;
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

/** Token-endpoint rejection carrying the OAuth error code, so callers can
 *  tell a terminal `invalid_grant` (revoked/expired refresh token) apart
 *  from transient failures. */
export class CloudflareOAuthTokenError extends Error {
  constructor(public readonly oauthError: string, message: string) {
    super(message);
    this.name = 'CloudflareOAuthTokenError';
  }
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
    const code = stringField(payload, 'error') ?? `http_${response.status}`;
    const reason = stringField(payload, 'error_description') ?? stringField(payload, 'error') ?? `HTTP ${response.status}`;
    throw new CloudflareOAuthTokenError(code, `Cloudflare token refresh failed: ${reason}`);
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
  const accounts = await fetchCloudflareAccounts(accessToken);
  const account = accounts[0] ?? null;
  if (!account) {
    throw new Error('Cloudflare OAuth did not expose an account for Workers AI billing.');
  }

  const credential: OAuthCredential = {
    kind: 'oauth',
    accessToken,
    expiresAt: expiresAtFromToken(token),
    metadata: {
      accountId: account.id,
      accountName: account.name,
      scopes: scopeList(token.scope),
      tokenType: stringValue(token.token_type) ?? 'bearer',
    },
  };
  if (refreshToken) credential.refreshToken = refreshToken;
  return credential;
}

export async function refreshCloudflareCredential(
  env: CloudflareOAuthEnv,
  current: OAuthCredential,
): Promise<OAuthCredential> {
  if (!current.refreshToken) throw new Error('Cloudflare OAuth credential has no refresh token. Reconnect Cloudflare.');
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

/** Account-scoped management API root recovered from the `/ai/v1` inference
 *  base URL. Lets the my-gateway provider reach the AI Gateway management
 *  endpoints (gateway config, BYOK provider keys, credit balance) with the
 *  same AuthResolution it already holds — no extra plumbing for account ids. */
export function cloudflareAccountAPIRoot(workersAIBaseURL: string): string | null {
  const match = /^(https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/[^/]+)\/ai\/v1\/?$/.exec(workersAIBaseURL);
  return match?.[1] ?? null;
}

export interface CloudflareAIGatewaySummary {
  id: string;
  /** Whether the gateway requires authenticated requests. Informational —
   *  our requests always carry the user's bearer token either way. */
  authenticated: boolean;
  createdAt: string | null;
}

export function isCloudflareAIGatewayId(value: string): boolean {
  return /^[a-zA-Z0-9._-]{1,64}$/.test(value);
}

/** List the account's AI Gateways (GET /accounts/{id}/ai-gateway/gateways).
 *  Requires the `aig.read` OAuth scope — a 401/403 here usually means the
 *  credential predates that scope and the user must reconnect Cloudflare. */
export async function fetchCloudflareAIGateways(
  accountId: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CloudflareAIGatewaySummary[]> {
  const response = await fetchImpl(
    `${CLOUDFLARE_API}/accounts/${encodeURIComponent(accountId)}/ai-gateway/gateways?per_page=50`,
    { headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` } },
  );
  const payload = await readJsonObject(response, 'Cloudflare AI Gateway list endpoint');
  if (!response.ok) {
    const reason = firstCloudflareError(payload) ?? `HTTP ${response.status}`;
    const hint = response.status === 401 || response.status === 403
      ? ' Reconnect Cloudflare to grant AI Gateway access.'
      : '';
    throw new Error(`Cloudflare AI Gateway listing failed: ${reason}.${hint}`);
  }
  const result = Array.isArray(payload.result) ? payload.result : [];
  return result
    .map((item): CloudflareAIGatewaySummary | null => {
      if (!item || typeof item !== 'object') return null;
      const row = item as Record<string, unknown>;
      const id = typeof row.id === 'string' ? row.id : '';
      if (!isCloudflareAIGatewayId(id)) return null;
      return {
        id,
        authenticated: row.authentication === true,
        createdAt: typeof row.created_at === 'string' ? row.created_at : null,
      };
    })
    .filter((item): item is CloudflareAIGatewaySummary => item !== null);
}

export function cloudflareAIGatewayId(env: Pick<CloudflareOAuthEnv, 'CLOUDFLARE_AI_GATEWAY_ID'>): string {
  return cleanEnv(env.CLOUDFLARE_AI_GATEWAY_ID) || DEFAULT_CLOUDFLARE_AI_GATEWAY_ID;
}

export function accountIdFromCloudflareCredential(credential: OAuthCredential): string | null {
  const accountId = credential.metadata?.accountId;
  return typeof accountId === 'string' && isCloudflareAccountId(accountId) ? accountId : null;
}

export function isCloudflareCredentialUsable(credential: OAuthCredential, skewMs = 60_000): boolean {
  if (!accountIdFromCloudflareCredential(credential)) return false;
  if (typeof credential.expiresAt !== 'number') return true;
  if (credential.expiresAt > Date.now() + skewMs) return true;
  return typeof credential.refreshToken === 'string' && credential.refreshToken.length > 0;
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
