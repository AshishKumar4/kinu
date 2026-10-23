// The one Google connection: an account's grant to Google's own APIs (Gmail, Calendar, Drive and the Docs, Sheets and
// Slides it holds, contacts), asked of the deployment's Google client, kept as `google.oauth` and renewed by its
// refresh token. Endpoints from accounts.google.com/.well-known/openid-configuration, 2026-10-23.
import { Effect } from 'effect';
import * as v from 'valibot';
import type { OAuthCredential } from '../credentials/store';
import { settle, tolerate } from '../obs/index';
import { parseJsonValue } from '../utils/json';
import { plainFetch } from './fetch-shim';
import { OAuthTokenError } from './oauth-token-error';

export const GOOGLE_OAUTH_CRED_KEY = 'google.oauth';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

/**
 * What the connection asks: who the account is, and the narrowest scope covering each API's reads and writes. Drive's
 * covers the Docs, Sheets and Slides APIs; `gmail.modify` reads, drafts, labels and sends, never deletes outright.
 */
export const GOOGLE_CONNECTION_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/contacts.readonly',
].join(' ');

/** The deployment's Google client for the connection, the one its Workspace project registered. */
export interface GoogleConnectionEnv {
  MCP_GOOGLE_CLIENT_ID?: string;
  MCP_GOOGLE_CLIENT_SECRET?: string;
}

export interface GoogleConnectionClient {
  readonly clientId: string;
  readonly clientSecret: string;
}

export function googleConnectionClient(env: GoogleConnectionEnv): GoogleConnectionClient | null {
  const clientId = env.MCP_GOOGLE_CLIENT_ID?.trim() ?? '';
  const clientSecret = env.MCP_GOOGLE_CLIENT_SECRET?.trim() ?? '';

  return clientId === '' || clientSecret === '' ? null : { clientId, clientSecret };
}

/** Google's access tokens last an hour; one is renewed this long before. */
const GOOGLE_REFRESH_LEAD_MS = 5 * 60_000;

export function googleCredentialExpiring(credential: OAuthCredential): boolean {
  return credential.expiresAt !== undefined && Date.now() + GOOGLE_REFRESH_LEAD_MS >= credential.expiresAt;
}

/** Google's token answer, at a connect or a renewal; its refusal names `error`. */
export const GoogleTokenSchema = v.object({
  access_token: v.optional(v.string()),
  refresh_token: v.optional(v.string()),
  expires_in: v.optional(v.number()),
  scope: v.optional(v.string()),
  error: v.optional(v.string()),
  error_description: v.optional(v.string()),
});

export type GoogleToken = v.InferOutput<typeof GoogleTokenSchema>;

/** The account Google says it connected, and what it granted of what was asked. */
export interface GoogleGrant {
  readonly account: string;
  readonly scopes: readonly string[];
}

const GoogleGrantSchema = v.object({ account: v.string(), scopes: v.array(v.string()) });

/** The scopes and account a stored connection records; null for a row that records none. */
export function googleGrantOf(credential: OAuthCredential): GoogleGrant | null {
  const grant = v.safeParse(GoogleGrantSchema, credential.metadata);

  return grant.success ? grant.output : null;
}

function grantedScopes(scope: string | undefined, held: readonly string[]): string[] {
  return scope === undefined || scope.trim() === '' ? [...held] : scope.split(' ').filter((granted) => granted !== '');
}

/** The connection a connect's token answer makes, for `account`; null when Google returned no access token. */
export function googleTokenToCredential(token: GoogleToken, account: string): OAuthCredential | null {
  if (token.access_token === undefined || token.access_token === '') return null;
  const credential: OAuthCredential = { kind: 'oauth', accessToken: token.access_token, metadata: { account, scopes: grantedScopes(token.scope, []) } };

  if (token.refresh_token !== undefined && token.refresh_token !== '') credential.refreshToken = token.refresh_token;

  if (token.expires_in !== undefined && token.expires_in > 0) credential.expiresAt = Date.now() + token.expires_in * 1_000;

  return credential;
}

/**
 * The connection renewed. Google's answer carries no new refresh token, so the held one stays; a refused renewal
 * (`invalid_grant`: revoked at Google, or the grant lapsed) is an `OAuthTokenError` whose `revoked` retires the row.
 */
export function refreshGoogleCredential(env: GoogleConnectionEnv, current: OAuthCredential, fetchFn: typeof fetch = fetch): Promise<OAuthCredential> {
  return settle(Effect.gen(function* () {
    const client = googleConnectionClient(env);

    if (client === null) return yield* Effect.die(new Error('This deployment has no Google client for the connection (MCP_GOOGLE_CLIENT_ID).'));

    if (current.refreshToken === undefined) return yield* Effect.die(new OAuthTokenError('google', 'invalid_grant', 'The Google connection holds no refresh token. Connect Google again.'));
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: current.refreshToken, client_id: client.clientId, client_secret: client.clientSecret });
    const response = yield* Effect.promise(() => plainFetch(fetchFn)(GOOGLE_TOKEN_URL, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body }));
    const text = yield* Effect.promise(() => response.text());
    const parsed = v.safeParse(GoogleTokenSchema, tolerate(() => parseJsonValue(text), 'malformed-input'));
    const token: GoogleToken = parsed.success ? parsed.output : {};

    if (!response.ok) {
      const code = token.error ?? `http_${response.status}`;

      return yield* Effect.die(new OAuthTokenError('google', code, `Google refused to renew the connection: ${token.error_description ?? code}`));
    }

    if (token.access_token === undefined || token.access_token === '') return yield* Effect.die(new Error('Google renewed the connection without an access token.'));
    const held = googleGrantOf(current);
    const { expiresAt: _lapsed, ...kept } = current;
    const renewed: OAuthCredential = { ...kept, accessToken: token.access_token, metadata: { account: held?.account ?? '', scopes: grantedScopes(token.scope, held?.scopes ?? []) } };

    if (token.expires_in !== undefined && token.expires_in > 0) renewed.expiresAt = Date.now() + token.expires_in * 1_000;

    return renewed;
  }));
}
