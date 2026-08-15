import { JsonObjectSchema, type JsonObject, type OAuthCredential } from '@proteus/core';
import * as v from 'valibot';

const CloudflareAccountSchema = v.object({ id: v.string(), name: v.optional(v.string()) });
const CloudflareGatewaySchema = v.object({
  id: v.string(), authentication: v.optional(v.boolean()), created_at: v.optional(v.string()),
});
const CloudflareErrorEnvelopeSchema = v.object({
  errors: v.optional(v.array(v.object({ message: v.optional(v.string()) }))),
});

export const CLOUDFLARE_OAUTH_CRED_KEY = 'cloudflare.oauth';
/** DERIVED credential key — never stored. UserDO serves it from the same
 *  `cloudflare.oauth` row, but the header bundle targets the user's OWN
 *  selected AI Gateway (`cf-aig-gateway-id`). Resolves to null until a
 *  gateway is selected, which is what gates the `my-gateway` provider. */
export const CLOUDFLARE_AI_GATEWAY_CRED_KEY = 'cloudflare.ai-gateway';
// `offline_access` is what makes dash.cloudflare.com issue a refresh token
// (the OAuth client must also have the Refresh Token grant enabled). Without
// it the credential dies at access-token expiry and Workers AI "disconnects".
// `aig.write` (AI Gateway Write — the owner's OAuth client offers no separate
// Read scope; Write covers the gateway/provider-config/billing listing APIs
// the my-gateway provider uses for discovery) and `aig.run` covers inference.
// Users who connected before a scope was added need one re-login to grant it.
export const CLOUDFLARE_WORKERS_AI_SCOPES = 'user-details.read account-settings.read ai.write aig.write aig.run offline_access';
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
): Promise<JsonObject> {
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

  const result = v.safeParse(v.array(CloudflareAccountSchema), payload.result);
  if (!result.success) return [];
  return result
    .output.map((row) => {
      const id = row.id;
      if (!isCloudflareAccountId(id)) return null;
      const name = row.name?.trim() || id;
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
  // An account the token cannot see is not an authentication failure — Workers
  // AI billing is a separate concern from who signed in. The credential is
  // stored without an accountId, which isCloudflareCredentialUsable already
  // reports as unusable, so the operator gets the "Connect Cloudflare Workers
  // AI" notice instead of being locked out of the product entirely.
  const account = (await fetchCloudflareAccounts(accessToken))[0] ?? null;

  const metadata: JsonObject = {
    tokenType: stringValue(token.token_type) ?? 'bearer',
  };
  if (account) {
    metadata.accountId = account.id;
    metadata.accountName = account.name;
  }
  const scopes = scopeList(token.scope);
  if (scopes) metadata.scopes = scopes;
  const credential: OAuthCredential = {
    kind: 'oauth',
    accessToken,
    expiresAt: expiresAtFromToken(token),
    metadata,
  };
  if (refreshToken) credential.refreshToken = refreshToken;
  return credential;
}

export async function refreshCloudflareCredential(
  env: CloudflareOAuthEnv,
  current: OAuthCredential,
): Promise<OAuthCredential> {
  if (!current.refreshToken) throw new Error('Cloudflare OAuth credential has no refresh token. Reconnect Cloudflare.');
  const token: CloudflareTokenPayload = await requestCloudflareOAuthToken(env, {
    grant_type: 'refresh_token',
    refresh_token: current.refreshToken,
  });

  const accessToken = stringValue(token.access_token) ?? current.accessToken;
  const refreshToken = stringValue(token.refresh_token) ?? current.refreshToken;
  const metadata: JsonObject = { ...current.metadata };
  const scopes = scopeList(token.scope);
  if (scopes) metadata.scopes = scopes;
  metadata.tokenType = stringValue(token.token_type) ?? current.metadata?.tokenType ?? 'bearer';
  const credential: OAuthCredential = {
    ...current,
    accessToken,
    refreshToken,
    metadata,
  };
  const expiresAt = expiresAtFromToken(token) ?? current.expiresAt;
  if (expiresAt !== undefined) credential.expiresAt = expiresAt;
  return credential;
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
 *  Requires the `aig.write` OAuth scope — a 401/403 here usually means the
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
  const result = v.safeParse(v.array(CloudflareGatewaySchema), payload.result);
  if (!result.success) return [];
  return result.output
    .map((item): CloudflareAIGatewaySummary | null => {
      const id = item.id;
      if (!isCloudflareAIGatewayId(id)) return null;
      return {
        id,
        authenticated: item.authentication === true,
        createdAt: item.created_at ?? null,
      };
    })
    .filter((item): item is CloudflareAIGatewaySummary => item !== null);
}

export function cloudflareAIGatewayId(env: Pick<CloudflareOAuthEnv, 'CLOUDFLARE_AI_GATEWAY_ID'>): string {
  return cleanEnv(env.CLOUDFLARE_AI_GATEWAY_ID) || DEFAULT_CLOUDFLARE_AI_GATEWAY_ID;
}

export function accountIdFromCloudflareCredential(credential: OAuthCredential): string | null {
  const accountId = credential.metadata?.accountId;
  return v.is(v.string(), accountId) && isCloudflareAccountId(accountId) ? accountId : null;
}

export function isCloudflareCredentialUsable(credential: OAuthCredential, skewMs = 60_000): boolean {
  if (!accountIdFromCloudflareCredential(credential)) return false;
  if (credential.expiresAt === undefined) return true;
  if (credential.expiresAt > Date.now() + skewMs) return true;
  return credential.refreshToken !== undefined && credential.refreshToken.length > 0;
}

export function isCloudflareCredentialExpiring(credential: OAuthCredential, skewMs = 60_000): boolean {
  return credential.expiresAt !== undefined && credential.expiresAt <= Date.now() + skewMs;
}

function cleanEnv<Value>(value: Value): string {
  return v.is(v.string(), value) ? value.trim() : '';
}

function expiresAtFromToken(token: CloudflareTokenPayload): number | undefined {
  const raw = token.expires_in;
  const seconds = v.is(v.number(), raw)
    ? raw
    : v.is(v.string(), raw) && raw.trim()
      ? Number(raw)
      : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Date.now() + Math.max(0, seconds - 30) * 1000;
}

function scopeList<Value>(value: Value): string[] | undefined {
  if (v.is(v.string(), value)) {
    const scopes = value.trim().split(/\s+/).filter(Boolean);
    return scopes.length ? scopes : undefined;
  }
  if (Array.isArray(value)) {
    const scopes = value.filter((item): item is string => v.is(v.string(), item) && item.trim().length > 0);
    return scopes.length ? scopes : undefined;
  }
  return undefined;
}

function stringValue<Value>(value: Value): string | null {
  return v.is(v.string(), value) && value.trim() ? value.trim() : null;
}

function stringField(obj: JsonObject, key: string): string | null {
  return stringValue(obj[key]);
}

function firstCloudflareError(obj: JsonObject): string | null {
  const parsed = v.safeParse(CloudflareErrorEnvelopeSchema, obj);
  for (const error of parsed.success ? parsed.output.errors ?? [] : []) {
    const message = error.message?.trim() || null;
    if (message) return message;
  }
  return null;
}

async function readJsonObject(response: Response, label: string): Promise<JsonObject> {
  let parsed: JsonObject;
  try {
    parsed = v.parse(JsonObjectSchema, await response.json());
  } catch {
    throw new Error(`${label} did not return JSON.`);
  }
  return parsed;
}

function isCloudflareAccountId(value: string): boolean {
  return /^[a-fA-F0-9]{16,64}$/.test(value);
}

function base64(value: string): string {
  return btoa(value);
}
