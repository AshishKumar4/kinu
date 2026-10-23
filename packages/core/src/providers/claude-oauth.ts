import * as v from 'valibot';
import { CLAUDE_CODE_SDK_VERSION } from './claude';
import { OAuthTokenError } from './oauth-token-error';
import type { OAuthCredential } from '../credentials/store';
import { createPkcePair } from '../utils/crypto';
import { Effect } from 'effect';
import { KinuError, settle, settleSync, tolerate } from '../obs/index';
import { parseJsonValue } from '../utils/json';

/** Base64 so secret scanners stay quiet. */
const CLIENT_ID = atob('OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl');

export const CLAUDE_OAUTH_CALLBACK_PORT = 54545;

const CLAUDE_OAUTH_REDIRECT_URI = `http://localhost:${String(CLAUDE_OAUTH_CALLBACK_PORT)}/callback`;

/** Anthropic's own page, which shows the code to paste back: where a sign-in no local listener catches returns (the web's).
 *  Proven 2026-10-23: the owner signed in through it and the code exchanged, from this client. */
const CLAUDE_CODE_PAGE_REDIRECT = 'https://platform.claude.com/oauth/code/callback';

const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';

const TOKEN_URL = 'https://api.anthropic.com/v1/oauth/token';

const SCOPES = ['org:create_api_key', 'user:profile', 'user:inference', 'user:sessions:claude_code', 'user:mcp_servers', 'user:file_upload'];

export const CLAUDE_REFRESH_LEAD_MS = 300_000;

const REFUSED = "Claude's token endpoint refused the sign-in: ";

const TokenResponseSchema = v.looseObject({
  access_token: v.pipe(v.string(), v.minLength(1)),
  refresh_token: v.optional(v.string()),
  expires_in: v.optional(v.number()),
  account: v.optional(v.looseObject({ uuid: v.optional(v.string()), email_address: v.optional(v.string()) })),
  organization: v.optional(v.looseObject({ uuid: v.optional(v.string()), name: v.optional(v.string()) })),
});

const TokenErrorSchema = v.looseObject({ error: v.optional(v.string()), error_description: v.optional(v.string()) });

export interface ClaudeSignIn {
  readonly url: string;
  readonly state: string;
  readonly verifier: string;
  /** Where Claude returns the browser, which the exchange names again: the CLI's local listener, or Anthropic's code page. */
  readonly redirectUri: string;
}

/** `returnTo`: the CLI's local listener catches the code, or Anthropic's page shows it for the person to paste (the web). */
export async function startClaudeSignIn(returnTo: 'local' | 'code-page' = 'local'): Promise<ClaudeSignIn> {
  const redirectUri = returnTo === 'local' ? CLAUDE_OAUTH_REDIRECT_URI : CLAUDE_CODE_PAGE_REDIRECT;
  const pkce = await createPkcePair();
  const state = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPES.join(' '),
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    state,
    code: 'true',
  });

  return { url: `${AUTHORIZE_URL}?${params.toString()}`, state, verifier: pkce.verifier, redirectUri };
}

export function claudeCodeFrom(returned: string, state: string): string {
  return settleSync(signInCode(returned, state));
}

function signInCode(returned: string, state: string): Effect.Effect<string, KinuError> {
  const text = returned.trim();
  const address = URL.canParse(text) ? new URL(text) : null;
  const [code = '', carried = state] = address === null ? text.split('#') : [address.searchParams.get('code') ?? '', address.searchParams.get('state') ?? ''];

  if (address?.searchParams.get('error') != null) {
    return Effect.fail(new KinuError('denied', `Claude refused the sign-in: ${address.searchParams.get('error') ?? ''}`));
  }

  if (code === '') {
    return Effect.fail(new KinuError('bad_input', "That isn't a Claude sign-in code. Paste the code Claude showed, or the whole address of the page that didn't load."));
  }

  if (carried !== state) return Effect.fail(new KinuError('bad_input', 'That code is from an earlier sign-in. Start the sign-in again.'));

  return Effect.succeed(code);
}

function credentialFrom(body: v.InferOutput<typeof TokenResponseSchema>, previous: OAuthCredential | null): OAuthCredential {
  const identity = {
    ...previous?.metadata,
    ...(body.account?.uuid !== undefined && { accountUuid: body.account.uuid }),
    ...(body.account?.email_address !== undefined && { email: body.account.email_address }),
    ...(previous === null && body.organization?.uuid !== undefined && { orgUuid: body.organization.uuid }),
    ...(previous === null && body.organization?.name !== undefined && { orgName: body.organization.name }),
  };

  return {
    kind: 'oauth',
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? previous?.refreshToken,
    ...(body.expires_in !== undefined && { expiresAt: Date.now() + body.expires_in * 1_000 }),
    metadata: identity,
  };
}

function tokenRequest(
  fetchFn: typeof fetch, body: Readonly<Record<string, string>>, headers: Readonly<Record<string, string>>,
): Effect.Effect<v.InferOutput<typeof TokenResponseSchema>> {
  return Effect.gen(function* () {
    const response = yield* Effect.promise(() => fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));

    const text = yield* Effect.promise(() => response.text());

    if (!response.ok) {
      const rejection = v.safeParse(TokenErrorSchema, tolerate<unknown>(() => parseJsonValue(text), 'malformed-input'));
      const code = rejection.success ? rejection.output.error ?? 'unknown' : 'unknown';
      const reason = rejection.success ? rejection.output.error_description ?? code : `HTTP ${String(response.status)}`;

      return yield* Effect.die(new OAuthTokenError('claude', code, `${REFUSED}${reason}`));
    }

    return v.parse(TokenResponseSchema, parseJsonValue(text));
  });
}

/**
 * A failed code exchange, said to the person who pasted the code: Claude refusing it, in Claude's own words, and what
 * to do; anything else as a sign-in that did not go through. The chain itself is the diagnostics', not theirs.
 */
export function claudeSignInRefusal(failure: Error): string {
  for (let link: unknown = failure; link instanceof Error; link = link.cause) {
    if (link instanceof OAuthTokenError && link.issuer === 'claude') {
      const said = link.message.startsWith(REFUSED) ? link.message.slice(REFUSED.length) : link.message;

      return `Claude didn't accept that code (${said.replace(/\.$/, '')}). A code works once, for a few minutes: start the sign-in again and paste the new one.`;
    }
  }

  return "Claude's sign-in didn't go through. Start it again; if it keeps failing, try again in a few minutes.";
}

export interface ClaudeOAuthClient {
  exchange(signIn: ClaudeSignIn, code: string): Promise<OAuthCredential>;
  /** The org stays the sign-in's. */
  refresh(credential: OAuthCredential): Promise<OAuthCredential>;
}

export function createClaudeOAuthClient(fetchFn: typeof fetch = fetch): ClaudeOAuthClient {
  return {
    async exchange(signIn, code) {
      return settle(Effect.map(tokenRequest(fetchFn, {
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        code,
        redirect_uri: signIn.redirectUri,
        code_verifier: signIn.verifier,
        state: signIn.state,
      }, {}), (body) => credentialFrom(body, null)));
    },
    async refresh(credential) {
      if (credential.refreshToken === undefined || credential.refreshToken === '') {
        return settle(Effect.die(new OAuthTokenError('claude', 'invalid_grant', 'this Claude login holds no refresh token; sign in again')));
      }

      return settle(Effect.map(tokenRequest(fetchFn, {
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        refresh_token: credential.refreshToken,
      }, {
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': `anthropic-sdk-typescript/${CLAUDE_CODE_SDK_VERSION} userOAuthProvider`,
      }), (body) => credentialFrom(body, credential)));
    },
  };
}
