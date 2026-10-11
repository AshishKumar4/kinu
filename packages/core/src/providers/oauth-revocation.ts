// RFC 7009; endpoints from each issuer's discovery document, 2026-09-26.
import type { OAuthCredential } from '../credentials/store';
import { Effect } from 'effect';
import * as v from 'valibot';
import { attempt, KinuError, settle, tolerate } from '../obs/index';
import { parseJsonValue } from '../utils/json';
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

export function revokingProviderOf(key: string): string | null {
  return REVOCATION.get(key)?.provider ?? null;
}

export function revocationEndpointFor(key: string, env: CloudflareOAuthEnv): RevocationEndpoint | null {
  const revocation = REVOCATION.get(key);
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
  const { endpoint } = input;
  const issued = endpoint.issuedClient === true ? chatgptRegistrationOf(input.credential)?.clientId : undefined;
  const body = new URLSearchParams({ token, token_type_hint: hint, ...endpoint.client.fields, ...(issued !== undefined && { client_id: issued }) });
  const headers = { 'content-type': 'application/x-www-form-urlencoded', ...endpoint.client.headers };

  const sent = attempt({ doing: `revoking the ${hint} at ${endpoint.provider}`, otherwise: 'unavailable' }, async () => {
    const response = await input.fetch(endpoint.url, { method: 'POST', headers, body, redirect: 'error' });

    return response.ok ? null : { status: response.status, words: refusalWords(response, await response.text()) };
  });

  return Effect.match(sent, {
    onSuccess: (refused) => refused === null
      ? null
      : new KinuError(refused.status === 429 ? 'budget' : 'unavailable', `${endpoint.provider} refused to revoke the ${hint}: ${refused.words}`),
    onFailure: (failure) => failure,
  });
}

const RevocationRefusalSchema = v.looseObject({ error: v.optional(v.string()), error_description: v.optional(v.string()) });

/** RFC 7009 answers a refusal as an OAuth error; its description, else its code, else the status line, in the provider's words. */
function refusalWords(response: Response, text: string): string {
  const refusal = v.safeParse(RevocationRefusalSchema, tolerate<unknown>(() => parseJsonValue(text), 'malformed-input'));
  const said = refusal.success ? refusal.output.error_description ?? refusal.output.error : undefined;

  return said ?? `HTTP ${String(response.status)} ${response.statusText}`.trim();
}
