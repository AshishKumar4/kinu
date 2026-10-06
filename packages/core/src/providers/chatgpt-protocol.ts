// Sign in with ChatGPT's token protocol (developers.openai.com/siwc, 2026-09-30) for the machine's sign-in
// (pc-agent/src/chatgpt.js, generated) and a deployment's (chatgpt-sign-in.ts); I/O and errors are each side's.

export const ISSUER = 'https://auth.openai.com';

const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;

export const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;

export const REVOKE_URL = `${ISSUER}/api/accounts/oauth/revoke`;

export const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;

export const RESOURCE = 'https://api.openai.com/v1';

/** Lets the tokens pay for inference with the owner's plan. */
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';

export const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', PLAN_SCOPE];

export const DYNAMIC_AGENT_CLIENT = 'dynamic_agent_client';

const AGENT_NAME_HINT = 'Kinu';

/** Refresh this long before the hour-long access token ends. */
const REFRESH_LEAD_MS = 5 * 60_000;

/** As OpenAI's own verification example sets it. */
const CLOCK_SKEW_SEC = 5;

/** Refresh refusals that end the renewable session. */
export const SPENT_REFRESH_CODES: readonly string[] = [
  'invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused',
];

export interface TokenAnswer {
  readonly accessToken: string | undefined;
  readonly refreshToken: string | undefined;
  readonly idToken: string | undefined;
  readonly expiresIn: number | undefined;
  readonly scope: string | undefined;
  readonly error: string | undefined;
  readonly errorDescription: string | undefined;
}

export interface GrantedTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt?: number;
  readonly scopes: string[];
}

export interface TokenRefusal {
  readonly code: string | null;
  readonly message: string;
}

export function tokenRefusal(status: number, answer: TokenAnswer, doing: string): TokenRefusal {
  const code = answer.error ?? null;
  const detail = answer.errorDescription === undefined ? '' : `: ${answer.errorDescription}`;

  return { code, message: `auth.openai.com refused ${doing} (HTTP ${String(status)}${code === null ? '' : ` ${code}`})${detail}` };
}

/** RFC 6749 §5.1: no `scope` granted what was asked, or on refresh what the grant held. */
export function scopesOf(scope: string | undefined, whenAbsent: readonly string[]): string[] {
  return (scope === undefined ? [...whenAbsent] : scope.split(' ').filter((entry) => entry !== '')).sort((left, right) => (left < right ? -1 : 1));
}

export function grantsPlan(scopes: readonly string[] | undefined): boolean {
  return scopes !== undefined && scopes.includes(PLAN_SCOPE);
}

export function expiring(held: { readonly accessToken?: string; readonly expiresAt?: number } | null | undefined, now: number): boolean {
  return held?.accessToken === undefined || held.expiresAt === undefined || now + REFRESH_LEAD_MS >= held.expiresAt;
}

/** No access token renews nothing; the refresh token sent stays when none came back. */
export function refreshedTokens(answer: TokenAnswer, held: { readonly refreshToken: string; readonly scopes: readonly string[] }, now: number): GrantedTokens | { readonly problem: string } {
  if (answer.accessToken === undefined) return { problem: 'auth.openai.com renewed the ChatGPT sign-in without an access token' };

  return {
    accessToken: answer.accessToken,
    refreshToken: answer.refreshToken ?? held.refreshToken,
    ...(answer.expiresIn !== undefined && { expiresAt: now + answer.expiresIn * 1000 }),
    scopes: scopesOf(answer.scope, held.scopes),
  };
}

export function signedInTokens(answer: TokenAnswer, now: number): GrantedTokens | { readonly problem: string } {
  if (answer.accessToken === undefined || answer.refreshToken === undefined) {
    return { problem: 'auth.openai.com answered the sign-in without an access and a refresh token' };
  }

  return {
    accessToken: answer.accessToken,
    refreshToken: answer.refreshToken,
    ...(answer.expiresIn !== undefined && { expiresAt: now + answer.expiresIn * 1000 }),
    scopes: scopesOf(answer.scope, SCOPES),
  };
}

/** Without a registration the sign-in registers Kinu. */
export function authorizeUrl(input: {
  readonly registration: { readonly clientId: string; readonly email?: string | null } | null;
  readonly hostId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly nonce: string;
  readonly challenge: string;
  readonly consent: boolean;
}): string {
  const { registration } = input;
  const loginHint = registration?.email ?? null;

  const params = new URLSearchParams({
    client_id: registration?.clientId ?? DYNAMIC_AGENT_CLIENT,
    ...(registration === null && { agent_name_hint: AGENT_NAME_HINT }),
    ext_agent_host_id: input.hostId,
    ...(loginHint !== null && { login_hint: loginHint }),
    response_type: 'code',
    redirect_uri: input.redirectUri,
    scope: SCOPES.join(' '),
    resource: RESOURCE,
    state: input.state,
    nonce: input.nonce,
    code_challenge_method: 'S256',
    code_challenge: input.challenge,
    ...(input.consent && { prompt: 'consent' }),
  });

  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/** `audience` is `aud` as a list. */
export interface IdToken {
  readonly algorithm: string | undefined;
  readonly keyId: string | undefined;
  readonly issuer: string | undefined;
  readonly audience: readonly string[];
  readonly expires: number | undefined;
  readonly nonce: string | undefined;
  readonly subject: string | undefined;
  readonly email: string | undefined;
}

export interface IdTokenIdentity {
  readonly subject: string;
  readonly email: string | null;
}

export function idTokenKeyId(token: IdToken): { readonly keyId: string } | { readonly problem: string } {
  return token.algorithm !== 'RS256' || token.keyId === undefined
    ? { problem: `the ID token is signed with ${String(token.algorithm)}, not RS256` }
    : { keyId: token.keyId };
}

export function idTokenSignatureVerifies(key: CryptoKey, signed: string, signature: string): Promise<boolean> {
  const padded = signature.replaceAll('-', '+').replaceAll('_', '/');
  const bytes = Uint8Array.from(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4)), (char) => char.charCodeAt(0));

  return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, bytes, new TextEncoder().encode(signed));
}

export function idTokenIdentity(token: IdToken, expected: { readonly clientId: string; readonly nonce: string; readonly now: number }): IdTokenIdentity | { readonly problem: string } {
  const { subject } = token;

  const problem = ([
    [token.issuer !== ISSUER, `the ID token was issued by ${String(token.issuer)}, not ${ISSUER}`],
    [!token.audience.includes(expected.clientId), 'the ID token was issued to another client'],
    [token.expires === undefined || token.expires + CLOCK_SKEW_SEC < expected.now / 1000, 'the ID token has expired'],
    [token.nonce !== expected.nonce, 'the ID token does not answer this sign-in (nonce mismatch)'],
  ] as const).find(([failed]) => failed)?.[1];

  if (problem !== undefined) return { problem };

  return subject === undefined || subject === '' ? { problem: 'the ID token names no subject' } : { subject, email: token.email ?? null };
}
