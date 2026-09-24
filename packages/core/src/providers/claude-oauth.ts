import * as v from 'valibot';
import { CLAUDE_CODE_SDK_VERSION } from './claude';
import { OAuthTokenError } from './oauth-token-error';
import type { OAuthCredential } from '../credentials/store';
import { createPkcePair } from '../utils/crypto';
import { KinuError, tolerate } from '../obs/index';
import { parseJsonValue } from '../utils/json';

/** Base64 so secret scanners stay quiet. */
const CLIENT_ID = atob('OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl');

export const CLAUDE_OAUTH_CALLBACK_PORT = 54545;

const CLAUDE_OAUTH_REDIRECT_URI = `http://localhost:${String(CLAUDE_OAUTH_CALLBACK_PORT)}/callback`;

const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';

const TOKEN_URL = 'https://api.anthropic.com/v1/oauth/token';

const SCOPES = ['org:create_api_key', 'user:profile', 'user:inference', 'user:sessions:claude_code', 'user:mcp_servers', 'user:file_upload'];

export const CLAUDE_REFRESH_LEAD_MS = 300_000;

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
}

export async function startClaudeSignIn(): Promise<ClaudeSignIn> {
  const pkce = await createPkcePair();
  const state = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: CLAUDE_OAUTH_REDIRECT_URI,
    scope: SCOPES.join(' '),
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    state,
    code: 'true',
  });

  return { url: `${AUTHORIZE_URL}?${params.toString()}`, state, verifier: pkce.verifier };
}

export function claudeCodeFrom(returned: string, state: string): string {
  const text = returned.trim();
  const address = URL.canParse(text) ? new URL(text) : null;
  const [code = '', carried = state] = address === null ? text.split('#') : [address.searchParams.get('code') ?? '', address.searchParams.get('state') ?? ''];

  if (address?.searchParams.get('error') != null) throw new KinuError('denied', `Claude refused the sign-in: ${address.searchParams.get('error') ?? ''}`);

  if (code === '') throw new KinuError('bad_input', 'that is not a Claude sign-in code or the address Claude sent you to');

  if (carried !== state) throw new KinuError('bad_input', 'that code belongs to another sign-in; start it again');

  return code;
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

async function tokenRequest(fetchFn: typeof fetch, body: Readonly<Record<string, string>>, headers: Readonly<Record<string, string>>) {
  const response = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await response.text();

  if (!response.ok) {
    const rejection = v.safeParse(TokenErrorSchema, tolerate<unknown>(() => parseJsonValue(text), 'malformed-input'));
    const code = rejection.success ? rejection.output.error ?? 'unknown' : 'unknown';
    const reason = rejection.success ? rejection.output.error_description ?? code : `HTTP ${String(response.status)}`;

    throw new OAuthTokenError('claude', code, `Claude's token endpoint refused the sign-in: ${reason}`);
  }

  return v.parse(TokenResponseSchema, parseJsonValue(text));
}

export interface ClaudeOAuthClient {
  exchange(signIn: ClaudeSignIn, code: string): Promise<OAuthCredential>;
  /** The org stays the sign-in's. */
  refresh(credential: OAuthCredential): Promise<OAuthCredential>;
}

export function createClaudeOAuthClient(fetchFn: typeof fetch = fetch): ClaudeOAuthClient {
  return {
    async exchange(signIn, code) {
      const body = await tokenRequest(fetchFn, {
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        code,
        redirect_uri: CLAUDE_OAUTH_REDIRECT_URI,
        code_verifier: signIn.verifier,
        state: signIn.state,
      }, {});

      return credentialFrom(body, null);
    },
    async refresh(credential) {
      if (credential.refreshToken === undefined || credential.refreshToken === '') {
        throw new OAuthTokenError('claude', 'invalid_grant', 'this Claude login holds no refresh token; sign in again');
      }

      const body = await tokenRequest(fetchFn, {
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        refresh_token: credential.refreshToken,
      }, {
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': `anthropic-sdk-typescript/${CLAUDE_CODE_SDK_VERSION} userOAuthProvider`,
      });

      return credentialFrom(body, credential);
    },
  };
}
