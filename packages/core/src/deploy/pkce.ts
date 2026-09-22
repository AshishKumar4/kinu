// Public OAuth client with PKCE (docs/SELF-DEPLOY.md): each deployment renews its own
// refresh token, so no client secret can be shared. The verifier never leaves run storage.
import * as v from 'valibot';
import { JsonObjectSchema } from '../utils/json';
import { base64Url } from '../utils/crypto';

const CLOUDFLARE_AUTHORIZE_URL = 'https://dash.cloudflare.com/oauth2/auth';

const CLOUDFLARE_TOKEN_URL = 'https://dash.cloudflare.com/oauth2/token';

/** Fixed: redirect URIs are pre-registered. Not 8787, which the local door serves on. */
export const CLI_DEPLOY_REDIRECT_PORT = 8899;

export const CLI_DEPLOY_REDIRECT_URI = `http://localhost:${String(CLI_DEPLOY_REDIRECT_PORT)}/oauth/callback`;

/** Each scope serves a step; `offline_access` is what yields the refresh token. */
export const CLOUDFLARE_DEPLOY_SCOPES: readonly string[] = [
  'account:read', 'user:read',
  'workers:write', 'workers_scripts:write', 'workers_routes:write', 'workers_kv:write',
  'r2:write', 'vectorize:write', 'ai:write', 'aig:write', 'aig:run',
  'secrets_store:write', 'access:write', 'zone:read', 'dns_records:edit',
  'offline_access',
];

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
}

const VERIFIER_BYTES = 32;

export async function createPkcePair(): Promise<PkcePair> {
  const bytes = new Uint8Array(VERIFIER_BYTES);

  crypto.getRandomValues(bytes);
  const verifier = base64Url(bytes);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));

  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

export interface AuthorizeRequest {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly challenge: string;
  readonly scopes: readonly string[];
}

export function authorizeUrl(request: AuthorizeRequest): string {
  const url = new URL(CLOUDFLARE_AUTHORIZE_URL);

  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', request.clientId);
  url.searchParams.set('redirect_uri', request.redirectUri);
  url.searchParams.set('state', request.state);
  url.searchParams.set('code_challenge', request.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('scope', request.scopes.join(' '));

  return url.href;
}

export interface DeployToken {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresInSeconds: number;
}

const TokenAnswerSchema = v.object({
  access_token: v.optional(v.string()),
  refresh_token: v.optional(v.string()),
  expires_in: v.optional(v.number()),
  error: v.optional(v.string()),
  error_description: v.optional(v.string()),
});

class DeployAuthError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'DeployAuthError';
  }
}

export interface TokenExchange {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly code: string;
  readonly verifier: string;
}

/** Refuses an answer without a refresh token: the deployment could never update itself. */
export async function exchangeDeployCode(
  exchange: TokenExchange,
  fetchImpl: typeof fetch = fetch,
): Promise<DeployToken> {
  return tokenGrant(new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: exchange.clientId,
    redirect_uri: exchange.redirectUri,
    code: exchange.code,
    code_verifier: exchange.verifier,
  }), fetchImpl);
}

/** Cloudflare may rotate the refresh token; callers must keep the returned one. */
export function refreshDeployToken(
  refresh: { readonly clientId: string; readonly refreshToken: string },
  fetchImpl: typeof fetch = fetch,
): Promise<DeployToken> {
  return tokenGrant(new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: refresh.clientId,
    refresh_token: refresh.refreshToken,
  }), fetchImpl);
}

async function tokenGrant(body: URLSearchParams, fetchImpl: typeof fetch): Promise<DeployToken> {
  const response = await fetchImpl(CLOUDFLARE_TOKEN_URL, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  const answer = v.parse(TokenAnswerSchema, v.parse(JsonObjectSchema, await response.json()));

  if (answer.error !== undefined || !response.ok) {
    throw new DeployAuthError(
      answer.error ?? `http_${response.status}`,
      answer.error_description ?? answer.error ?? `the token endpoint answered HTTP ${response.status}`,
    );
  }

  if (answer.access_token === undefined || answer.refresh_token === undefined) {
    throw new DeployAuthError(
      'no_refresh_token',
      'the token endpoint returned no refresh token, so the deployment could not own its own key',
    );
  }

  return {
    accessToken: answer.access_token,
    refreshToken: answer.refresh_token,
    expiresInSeconds: answer.expires_in ?? 0,
  };
}
