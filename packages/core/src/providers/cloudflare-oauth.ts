import { JsonObjectSchema, type JsonObject } from '../utils/json';
import { OAuthTokenError } from './oauth-token-error';
import { nonEmptyString } from '../utils/json';
import type { OAuthCredential } from '../credentials/store';
import { diagnostics, toKinuError } from '../obs/index';
import * as v from 'valibot';

const CloudflareAccountSchema = v.object({ id: v.string(), name: v.optional(v.string()) });

const CloudflareGatewaySchema = v.object({
  id: v.string(), authentication: v.optional(v.boolean()), created_at: v.optional(v.string()),
});

const CloudflareErrorEnvelopeSchema = v.object({
  errors: v.optional(v.array(v.object({ message: v.optional(v.string()) }))),
});

export const CLOUDFLARE_OAUTH_CRED_KEY = 'cloudflare.oauth';

/** Derived credential key, never stored: the `cloudflare.oauth` row aimed at the user's selected AI Gateway.
 *  Null until a gateway is selected, which gates `my-gateway`. */
export const CLOUDFLARE_AI_GATEWAY_CRED_KEY = 'cloudflare.ai-gateway';

// `offline_access` makes Cloudflare issue a refresh token; `aig.write` covers the gateway management APIs
// (no separate Read scope) and `aig.run` covers inference.
export const CLOUDFLARE_WORKERS_AI_SCOPES = 'user-details.read account-settings.read ai.write aig.write aig.run offline_access';

const DEFAULT_CLOUDFLARE_AI_GATEWAY_ID = 'default';

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

async function requestCloudflareOAuthToken(
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
    throw new OAuthTokenError('cloudflare', code, `Cloudflare token refresh failed: ${reason}`);
  }

  return payload;
}

async function fetchCloudflareAccounts(accessToken: string): Promise<CloudflareAccount[]> {
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
      const name = nonEmptyString({ value: row.name }) ?? id;

      return { id, name };
    })
    .filter((item): item is CloudflareAccount => item !== null);
}

export async function cloudflareTokenToCredential(
  token: CloudflareTokenPayload,
): Promise<OAuthCredential> {
  const accessToken = nonEmptyString({ value: token.access_token });

  if (!accessToken) throw new Error('Cloudflare OAuth did not return an access token.');

  const refreshToken = nonEmptyString({ value: token.refresh_token });
  // Account discovery is not authentication: a failed lookup must still store the credential
  // (a missing account already reports "Connect Cloudflare Workers AI").
  let accounts: CloudflareAccount[] = [];

  try {
    accounts = await fetchCloudflareAccounts(accessToken);
  } catch (err) {
    diagnostics.failure('oauth.cloudflare_account_lookup_failed', toKinuError({
      doing: "looking up the Cloudflare login's accounts",
      cause: err,
      otherwise: 'unavailable',
    }));
  }

  const metadata: JsonObject = {
    tokenType: nonEmptyString({ value: token.token_type }) ?? 'bearer',
  };

  // Record every visible account so a multi-account user can switch without another API call; the first is selected.
  if (accounts.length > 0) {
    metadata.accounts = accounts.map((account) => ({ id: account.id, name: account.name }));
    metadata.accountId = accounts[0].id;
    metadata.accountName = accounts[0].name;
  }

  const scopes = scopeList({ value: token.scope });

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

  const accessToken = nonEmptyString({ value: token.access_token }) ?? current.accessToken;
  const refreshToken = nonEmptyString({ value: token.refresh_token }) ?? current.refreshToken;
  const metadata: JsonObject = { ...current.metadata };
  const scopes = scopeList({ value: token.scope });

  if (scopes) metadata.scopes = scopes;
  metadata.tokenType = nonEmptyString({ value: token.token_type }) ?? current.metadata?.tokenType ?? 'bearer';

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

/** Account-scoped management API root recovered from the `/ai/v1` inference base URL. */
export function cloudflareAccountAPIRoot(workersAIBaseURL: string): string | null {
  const match = /^(https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/[^/]+)\/ai\/v1\/?$/.exec(workersAIBaseURL);

  return match?.[1] ?? null;
}

export interface CloudflareAIGatewaySummary {
  id: string;
  /** Whether the gateway requires authenticated requests; ours always carry the bearer. */
  authenticated: boolean;
  createdAt: string | null;
}

export function isCloudflareAIGatewayId(value: string): boolean {
  return /^[a-zA-Z0-9._-]{1,64}$/.test(value);
}

/** List the account's AI Gateways. Needs the `aig.write` scope; 401/403 usually means reconnect Cloudflare. */
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

/** Every Cloudflare account this login can see; older tokens report just the selected one. */
export function cloudflareAccountsFromCredential(credential: OAuthCredential): CloudflareAccount[] {
  const stored = v.safeParse(v.array(CloudflareAccountSchema), credential.metadata?.accounts);

  const accounts = stored.success
    ? stored.output
        .filter((row) => isCloudflareAccountId(row.id))
        .map((row): CloudflareAccount => ({ id: row.id, name: nonEmptyString({ value: row.name }) ?? row.id }))
    : [];

  if (accounts.length > 0) return accounts;
  const selected = accountIdFromCloudflareCredential(credential);

  if (!selected) return [];
  const name = credential.metadata?.accountName;

  return [{ id: selected, name: v.is(v.string(), name) && name.trim() ? name.trim() : selected }];
}

/** The same credential pointed at another of its accounts (the metadata `cloudflareWorkersAIBaseURL` reads). */
export function withCloudflareAccount(credential: OAuthCredential, accountId: string): OAuthCredential {
  const account = cloudflareAccountsFromCredential(credential).find((row) => row.id === accountId);

  if (!account) throw new Error('That Cloudflare account is not one this login can see. Reconnect Cloudflare and try again.');

  return {
    ...credential,
    metadata: { ...credential.metadata, accountId: account.id, accountName: account.name },
  };
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

function cleanEnv(value: string | undefined): string {
  return value?.trim() ?? '';
}

/** A token lifetime, given as seconds or a digit string; anything else is not a lifetime. */
const ExpiresInSchema = v.union([
  v.number(),
  v.pipe(v.string(), v.trim(), v.nonEmpty(), v.transform(Number)),
]);

function expiresAtFromToken(token: CloudflareTokenPayload): number | undefined {
  const parsed = v.safeParse(ExpiresInSchema, token.expires_in);

  if (!parsed.success) return undefined;
  const seconds = parsed.output;

  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;

  return Date.now() + Math.max(0, seconds - 30) * 1000;
}

function scopeList(input: { value: unknown }): string[] | undefined {
  const { value } = input;

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

/** A payload field as non-empty text; blank counts as absent. */
function stringField(obj: JsonObject, key: string): string | undefined {
  return nonEmptyString({ value: obj[key] });
}

function firstCloudflareError(obj: JsonObject): string | null {
  const parsed = v.safeParse(CloudflareErrorEnvelopeSchema, obj);

  for (const error of parsed.success ? parsed.output.errors ?? [] : []) {
    const message = nonEmptyString({ value: error.message });

    if (message !== undefined) return message;
  }

  return null;
}

/** A JSON object answer, or a named failure carrying the upstream status and parse cause. */
export async function readJsonObject(response: Response, label: string): Promise<JsonObject> {
  try {
    return v.parse(JsonObjectSchema, await response.json());
  } catch (error) {
    throw new Error(
      `${label} returned HTTP ${response.status} with a body that is not JSON.`,
      { cause: error },
    );
  }
}

function isCloudflareAccountId(value: string): boolean {
  return /^[a-fA-F0-9]{16,64}$/.test(value);
}

function base64(value: string): string {
  return btoa(value);
}
