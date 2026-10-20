// Public OAuth client with PKCE (docs/SELF-DEPLOY.md): each deployment renews its own
// refresh token, so no client secret can be shared. The verifier never leaves run storage.
import { Data, Effect } from 'effect';
import {
  NIMBUS_CF_OAUTH_AUTH_URL as CLOUDFLARE_AUTHORIZE_URL,
  NIMBUS_CF_OAUTH_TOKEN_URL as CLOUDFLARE_TOKEN_URL,
} from '@nimbus-sh/sdk/oauth';
import * as v from 'valibot';
import { settle } from '../obs/index';
import { JsonObjectSchema } from '../utils/json';

/** Fixed: redirect URIs are pre-registered. Not 8787, which the local door serves on. */
export const CLI_DEPLOY_REDIRECT_PORT = 8899;

export const CLI_DEPLOY_REDIRECT_URI = `http://localhost:${String(CLI_DEPLOY_REDIRECT_PORT)}/oauth/callback`;

/** Each scope serves a step, named by Cloudflare's OAuth catalog id (`GET /oauth/scopes`): the authorize endpoint refuses
 *  the old colon names (`invalid_scope`, "not allowed to request scope 'account:read'", kinu.run 2026-10-20). The three
 *  mail and computer scopes are the client's optional ones, which the person may leave unticked on Cloudflare's consent
 *  screen.
 *  `offline_access` yields the refresh token. */
export const CLOUDFLARE_DEPLOY_SCOPES: readonly string[] = [
  'user-details.read', 'account-settings.read',
  'workers-scripts.write', 'workers-routes.write', 'workers-kv-storage.write',
  'workers-r2.write', 'vectorize.write', 'aig.write', 'zone.read', 'dns.write',
  'zone-settings.write', 'email-routing-rule.write', 'email-sending.write',
  // The computer: its container application, and the account token its box deletes snapshots with.
  'containers.write', 'account-api-tokens.write',
  'offline_access',
];

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

class DeployAuthError extends Data.TaggedError('DeployAuthError')<{ readonly message: string }> {
  constructor(readonly code: string, message: string) {
    super({ message });
  }
}

export interface TokenExchange {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly code: string;
  readonly verifier: string;
}

/** Refuses an answer without a refresh token: the deployment could never update itself. */
export function exchangeDeployCode(
  exchange: TokenExchange,
  fetchImpl: typeof fetch = fetch,
): Promise<DeployToken> {
  return settle(tokenGrant(new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: exchange.clientId,
    redirect_uri: exchange.redirectUri,
    code: exchange.code,
    code_verifier: exchange.verifier,
  }), fetchImpl));
}

/** Cloudflare may rotate the refresh token; callers must keep the returned one. */
export function refreshDeployToken(
  refresh: { readonly clientId: string; readonly refreshToken: string },
  fetchImpl: typeof fetch = fetch,
): Promise<DeployToken> {
  return settle(tokenGrant(new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: refresh.clientId,
    refresh_token: refresh.refreshToken,
  }), fetchImpl));
}

function tokenGrant(body: URLSearchParams, fetchImpl: typeof fetch): Effect.Effect<DeployToken> {
  return Effect.gen(function* () {
    const response = yield* Effect.promise(() => fetchImpl(CLOUDFLARE_TOKEN_URL, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body,
    }));

    const answer = v.parse(TokenAnswerSchema, v.parse(JsonObjectSchema, yield* Effect.promise(() => response.json())));

    if (answer.error !== undefined || !response.ok) {
      return yield* Effect.die(new DeployAuthError(
        answer.error ?? `http_${response.status}`,
        answer.error_description ?? answer.error ?? `the token endpoint answered HTTP ${response.status}`,
      ));
    }

    if (answer.access_token === undefined || answer.refresh_token === undefined) {
      return yield* Effect.die(new DeployAuthError(
        'no_refresh_token',
        'the token endpoint returned no refresh token, so the deployment could not own its own key',
      ));
    }

    const token: DeployToken = {
      accessToken: answer.access_token,
      refreshToken: answer.refresh_token,
      expiresInSeconds: answer.expires_in ?? 0,
    };

    return token;
  });
}
