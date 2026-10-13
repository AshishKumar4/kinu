// RFC 7009; endpoints from each issuer's discovery document, 2026-09-26.
import type { OAuthCredential } from '../credentials/store';
import { Effect } from 'effect';
import { attempt, KinuError, settle, tolerate } from '../obs/index';
import { parseJsonValue } from '../utils/json';
import { refusalWords } from '../safety/provider-refusal';
import { baseCredentialKey } from '../credentials/accounts';
import { CODEX_CLIENT_ID } from './codex-oauth';
import { CODEX_CRED_KEY } from './codex';
import { CLOUDFLARE_OAUTH_CRED_KEY, cloudflareClientAuth, type CloudflareOAuthEnv } from './cloudflare-oauth';
import { CHATGPT_CRED_KEY } from './chatgpt';
import { CHATGPT_REVOKE_URL, chatgptRegistrationOf } from './chatgpt-sign-in';

export interface RevocationEndpoint {
  /** Named in a refusal, so the owner knows whose words they read. */
  readonly provider: string;
  readonly url: string;
  readonly client: { readonly fields: Readonly<Record<string, string>>; readonly headers: Readonly<Record<string, string>> };
  /** The client is the one the login was issued to (Sign in with ChatGPT's dynamic registration). */
  readonly issuedClient?: true;
}

/** The one list of keys a disconnect can also revoke at their provider; a key absent here can only be disconnected. */
const REVOCATION = new Map<string, { readonly provider: string; readonly endpoint: (env: CloudflareOAuthEnv) => Omit<RevocationEndpoint, 'provider'> | null }>([
  [CODEX_CRED_KEY, { provider: 'OpenAI', endpoint: () => ({ url: 'https://auth.openai.com/api/accounts/oauth/revoke', client: { fields: { client_id: CODEX_CLIENT_ID }, headers: {} } }) }],
  [CHATGPT_CRED_KEY, { provider: 'OpenAI', endpoint: () => ({ url: CHATGPT_REVOKE_URL, client: { fields: {}, headers: {} }, issuedClient: true }) }],
  [CLOUDFLARE_OAUTH_CRED_KEY, { provider: 'Cloudflare', endpoint: (env) => {
    const client = cloudflareClientAuth(env);

    return client === null ? null : { url: 'https://dash.cloudflare.com/oauth2/revoke', client };
  } }],
]);

/** A named account (`codex.oauth@work`) revokes as its provider's main one does, with its own tokens. */
export function revokingProviderOf(key: string): string | null {
  return REVOCATION.get(baseCredentialKey(key))?.provider ?? null;
}

export function revocationEndpointFor(key: string, env: CloudflareOAuthEnv): RevocationEndpoint | null {
  const revocation = REVOCATION.get(baseCredentialKey(key));
  const endpoint = revocation?.endpoint(env) ?? null;

  return revocation === undefined || endpoint === null ? null : { provider: revocation.provider, ...endpoint };
}

export type RevocationFailures = readonly KinuError[];

/** A disconnect's answer: `unrevoked` is null unless revoking was asked and the provider did not, then its words. */
export interface DisconnectOutcome {
  readonly unrevoked: string | null;
}

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
  const { endpoint, credential } = input;
  const issued = endpoint.issuedClient === true ? chatgptRegistrationOf(credential)?.clientId : undefined;
  const body = new URLSearchParams({ token, token_type_hint: hint, ...endpoint.client.fields, ...(issued !== undefined && { client_id: issued }) });
  const headers = { 'content-type': 'application/x-www-form-urlencoded', ...endpoint.client.headers };
  // Whatever the call carried that a refusal could echo: the grant's tokens and the client's own secret.
  const clientSecrets = Object.entries(endpoint.client.fields).filter(([field]) => field !== 'client_id').map(([, value]) => value);
  const submitted = [credential.accessToken, credential.refreshToken ?? '', ...clientSecrets, ...Object.values(endpoint.client.headers).flatMap(authorizationSecrets)];

  const sent = attempt({ doing: `revoking the ${hint} at ${endpoint.provider}`, otherwise: 'unavailable' }, async () => {
    const response = await input.fetch(endpoint.url, { method: 'POST', headers, body, redirect: 'error' });

    if (response.ok) return null;
    const text = await response.text();

    return {
      status: response.status,
      words: refusalWords({ status: response.status, statusText: response.statusText, body: tolerate(() => parseJsonValue(text), 'malformed-input') ?? null, submitted }),
    };
  });

  return Effect.match(sent, {
    onSuccess: (refused) => refused === null
      ? null
      : new KinuError(refused.status === 429 ? 'budget' : 'unavailable', `${endpoint.provider} refused to revoke the ${hint}: ${refused.words}`),
    onFailure: (failure) => failure,
  });
}

/** An authorization header's secret in each form a refusal could echo it: whole, its credentials, and a Basic
 *  pair decoded with its secret alone (RFC 7617). */
function authorizationSecrets(header: string): string[] {
  const [scheme = '', credentials = ''] = header.split(' ');

  if (scheme.toLowerCase() !== 'basic' || credentials === '') return [header, credentials];
  const pair = tolerate(() => atob(credentials), 'malformed-input') ?? '';

  return [header, credentials, pair, pair.slice(pair.indexOf(':') + 1)];
}
