// RFC 7009; endpoints from each issuer's discovery document, 2026-09-26.
import type { OAuthCredential } from '../credentials/store';
import { KinuError, toKinuError } from '../obs/index';
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
  const { endpoint, credential } = input;
  const tokens: [string, string][] = [];

  if (credential.refreshToken) tokens.push([credential.refreshToken, 'refresh_token']);
  tokens.push([credential.accessToken, 'access_token']);
  const failures: KinuError[] = [];

  for (const [token, hint] of tokens) {
    const body = new URLSearchParams({ token, token_type_hint: hint, ...endpoint.client.fields });
    const headers = { 'content-type': 'application/x-www-form-urlencoded', ...endpoint.client.headers };

    try {
      const response = await input.fetch(endpoint.url, { method: 'POST', headers, body });

      if (!response.ok) failures.push(new KinuError(response.status === 429 ? 'budget' : 'unavailable', `the provider refused to revoke the ${hint} (HTTP ${String(response.status)})`));
    } catch (cause) {
      failures.push(toKinuError({ doing: `revoking the ${hint} at the provider`, cause, otherwise: 'unavailable' }));
    }
  }

  return failures;
}
