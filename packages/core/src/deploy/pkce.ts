/**
 * The guided run's authorization leg: a public OAuth client with PKCE.
 *
 * PUBLIC AND PKCE, not a confidential client, and the reason is the whole
 * design (docs/SELF-DEPLOY.md): the deployment keeps its own refresh token and
 * renews it by itself. A confidential client would mean every self-hosted Kinu
 * holding kinu.run's client secret, which is the same as not having one.
 *
 * The verifier never leaves the run's own storage and never reaches a log line
 * or a ledger row; the challenge is what travels. Both doors — the page and
 * `kinu deploy cloudflare` — use this module, so there is one authorization
 * shape and one place its parameters are named.
 */
import * as v from 'valibot';
import { JsonObjectSchema } from '../utils/json';
import { base64Url } from '../utils/crypto';

const CLOUDFLARE_AUTHORIZE_URL = 'https://dash.cloudflare.com/oauth2/auth';

const CLOUDFLARE_TOKEN_URL = 'https://dash.cloudflare.com/oauth2/token';

/**
 * Where the CLI door's authorization comes back to, the way wrangler's does:
 * a loopback listener on a FIXED port, because an OAuth client's redirect URIs
 * are registered ahead of time and an ephemeral port could never be one of
 * them. 8899 rather than 8787, which the local door serves on.
 *
 * One spelling: the CLI listens on it, the owner registers it, and
 * docs/SELF-DEPLOY.md names it from here.
 */
export const CLI_DEPLOY_REDIRECT_PORT = 8899;

export const CLI_DEPLOY_REDIRECT_URI = `http://localhost:${String(CLI_DEPLOY_REDIRECT_PORT)}/oauth/callback`;

/**
 * What the deploy client asks for, and why each one is here.
 *
 * Every scope is a step in the flow: `workers_scripts` uploads the Worker,
 * `workers_kv`/`r2`/`vectorize` create what it binds, `ai`/`aig` give it a
 * model path, `access` puts sign-in in front of it, `dns_records`/`zone` bind a
 * hostname when the person brings a zone, `account`/`user` read who is
 * deploying, and `offline_access` is what makes the token endpoint return the
 * refresh token the deployment keeps. Taken from the 387-scope catalog read
 * 2026-09-15 (`~/kinu-logs/self-deploy/oauth-scopes.json`); which of them a
 * third-party client may hold is settled when the owner creates the client,
 * and an unavailable scope shows up as a refusal at the authorize step rather
 * than as a silent capability loss mid-run.
 */
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

/** Where the person is sent to authorize. Built here so the page, the CLI and
 *  the first-run row all assert one shape. */
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

/** A refusal from the token endpoint, carrying the OAuth error verbatim — the
 *  same rule the Cloudflare API errors follow, for the same reason. */
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

/**
 * The authorization code for a token pair.
 *
 * No client secret and no `Authorization` header: a public client proves itself
 * with the verifier alone. A token answer without a refresh token is refused
 * rather than accepted, because the deployment's whole lifecycle depends on
 * having one — a run that proceeded without it would deploy a Kinu that cannot
 * update itself and would not say so until the first update.
 */
export async function exchangeDeployCode(
  exchange: TokenExchange,
  fetchImpl: typeof fetch = fetch,
): Promise<DeployToken> {
  const response = await fetchImpl(CLOUDFLARE_TOKEN_URL, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: exchange.clientId,
      redirect_uri: exchange.redirectUri,
      code: exchange.code,
      code_verifier: exchange.verifier,
    }),
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
