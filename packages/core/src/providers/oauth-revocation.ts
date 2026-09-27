// RFC 7009; endpoints from each issuer's discovery document, 2026-09-26.
import type { OAuthCredential } from '../credentials/store';
import { Effect } from 'effect';
import { attempt, KinuError, settle } from '../obs/index';
import { CODEX_CLIENT_ID } from './codex-oauth';
import { CODEX_CRED_KEY } from './codex';
import { CLOUDFLARE_OAUTH_CRED_KEY, cloudflareClientAuth, type CloudflareOAuthEnv } from './cloudflare-oauth';

export interface RevocationEndpoint {
  readonly url: string;
  readonly client: { readonly fields: Readonly<Record<string, string>>; readonly headers: Readonly<Record<string, string>> };
}

export function revocationEndpointFor(key: string, env: CloudflareOAuthEnv): RevocationEndpoint | null {
  if (key === CODEX_CRED_KEY) {
    return { url: 'https://auth.openai.com/api/accounts/oauth/revoke', client: { fields: { client_id: CODEX_CLIENT_ID }, headers: {} } };
  }

  if (key === CLOUDFLARE_OAUTH_CRED_KEY) {
    const client = cloudflareClientAuth(env);

    return client === null ? null : { url: 'https://dash.cloudflare.com/oauth2/revoke', client };
  }

  return null;
}

export interface UnrevokedGrant {
  readonly key: string;
  readonly reasons: readonly string[];
  readonly recordedAt: number;
}

export type RevocationFailures = readonly KinuError[];

/** Refresh token first (it ends the grant at most servers), then access; failures returned. */
export async function revokeOAuthGrant(input: {
  readonly endpoint: RevocationEndpoint;
  readonly credential: OAuthCredential;
  readonly fetch: typeof fetch;
}): Promise<RevocationFailures> {
  const { credential } = input;
  const tokens: [string, string][] = [];

  if (credential.refreshToken) tokens.push([credential.refreshToken, 'refresh_token']);
  tokens.push([credential.accessToken, 'access_token']);

  return settle(Effect.map(Effect.forEach(tokens, ([token, hint]) => revokeOne(input, token, hint)), (answers) => answers.filter((failure) => failure !== null)));
}

function revokeOne(input: Parameters<typeof revokeOAuthGrant>[0], token: string, hint: string): Effect.Effect<KinuError | null> {
  const { endpoint } = input;
  const body = new URLSearchParams({ token, token_type_hint: hint, ...endpoint.client.fields });
  const headers = { 'content-type': 'application/x-www-form-urlencoded', ...endpoint.client.headers };

  return Effect.match(attempt({ doing: `revoking the ${hint} at the provider`, otherwise: 'unavailable' },
    () => input.fetch(endpoint.url, { method: 'POST', headers, body, redirect: 'error' })), {
    onSuccess: (response) => response.ok
      ? null
      : new KinuError(response.status === 429 ? 'budget' : 'unavailable', `the provider refused to revoke the ${hint} (HTTP ${String(response.status)})`),
    onFailure: (failure) => failure,
  });
}
