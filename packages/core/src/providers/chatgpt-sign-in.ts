// Sign in with ChatGPT held by a Kinu deployment (developers.openai.com/siwc/token-sharing-open-source/sign-in, read
// 2026-10-05): the owner signs in in any browser and pastes back the 127.0.0.1 address it ends on. The machine's
// own sign-in is packages/pc-agent/src/chatgpt.js.
import * as v from 'valibot';
import { Effect } from 'effect';
import type { OAuthCredential } from '../credentials/store';
import { OAuthTokenError } from './oauth-token-error';
import type { SubscriptionIssuer } from './subscription-login';
import { KinuError, settle, tolerate } from '../obs/index';
import { createPkcePair, hmacSha256Hex, randomToken, timingSafeEqual } from '../utils/crypto';
import { parseJsonValue } from '../utils/json';
import { CHATGPT_BASE_URL } from './chatgpt';

const ISSUER = 'https://auth.openai.com';

const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;

const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;

export const CHATGPT_REVOKE_URL = `${ISSUER}/api/accounts/oauth/revoke`;

const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;

const PLAN_SCOPE = 'chatgpt.tokens.use.direct';

const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', PLAN_SCOPE];

const DYNAMIC_AGENT_CLIENT = 'dynamic_agent_client';

const AGENT_NAME_HINT = 'Kinu';

/** Nothing listens here: the browser's failed load leaves this address for the owner to paste back. */
export const CHATGPT_PASTE_REDIRECT = 'http://127.0.0.1:1455/auth/callback';

const REFRESH_LEAD_MS = 5 * 60_000;

const CLOCK_SKEW_SEC = 5;

/** An account's issued client, kept across sign-outs so the next sign-in skips registration. */
export const ChatGptRegistrationSchema = v.object({ clientId: v.string(), subject: v.string(), email: v.optional(v.nullable(v.string()), null) });

export type ChatGptRegistration = v.InferOutput<typeof ChatGptRegistrationSchema>;

/** One paste-back sign-in in progress; it never leaves the account's object. */
export const ChatGptPasteSignInSchema = v.object({
  state: v.string(), nonce: v.string(), verifier: v.string(), registration: v.nullable(ChatGptRegistrationSchema),
});

export type ChatGptPasteSignIn = v.InferOutput<typeof ChatGptPasteSignInSchema>;

export type ChatGptPasteOutcome =
  | { readonly outcome: 'declined' }
  | { readonly outcome: 'plan_declined'; readonly registration: ChatGptRegistration }
  | { readonly outcome: 'signed_in'; readonly registration: ChatGptRegistration; readonly credential: OAuthCredential };

const CredentialMetadataSchema = v.object({ clientId: v.string(), scopes: v.optional(v.array(v.string()), []) });

const TokenAnswerSchema = v.looseObject({
  access_token: v.optional(v.string()),
  refresh_token: v.optional(v.string()),
  id_token: v.optional(v.string()),
  expires_in: v.optional(v.number()),
  scope: v.optional(v.string()),
  error: v.optional(v.string()),
  error_description: v.optional(v.string()),
});

type TokenAnswer = v.InferOutput<typeof TokenAnswerSchema>;

const JwksSchema = v.object({ keys: v.array(v.looseObject({ kty: v.string(), kid: v.optional(v.string()) })) });

const JwtHeaderSchema = v.looseObject({ alg: v.string(), kid: v.string() });

const ClaimsSchema = v.looseObject({
  iss: v.string(),
  aud: v.union([v.string(), v.array(v.string())]),
  exp: v.number(),
  nonce: v.optional(v.string()),
  sub: v.pipe(v.string(), v.minLength(1)),
  email: v.optional(v.string()),
});

/** The deployment's one agent host (`ext_agent_host_id`): a UUID URN derived from its credential root, opaque and stable. */
export async function chatgptHostId(credentialRoot: string): Promise<string> {
  const hex = (await hmacSha256Hex(credentialRoot, 'kinu chatgpt ext_agent_host_id')).slice(0, 32).split('');

  hex[12] = '4';
  hex[16] = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  const id = hex.join('');

  return `urn:uuid:${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

/** The authorize address for a paste-back sign-in, and what the account holds until the owner pastes it back. */
export async function startChatGptPasteSignIn(input: {
  readonly hostId: string;
  readonly registration: ChatGptRegistration | null;
  readonly consent: boolean;
}): Promise<{ readonly url: string; readonly held: ChatGptPasteSignIn }> {
  const pkce = await createPkcePair();
  const held: ChatGptPasteSignIn = { state: randomToken(32), nonce: randomToken(32), verifier: pkce.verifier, registration: input.registration };
  const { registration } = input;

  const params = new URLSearchParams({
    client_id: registration?.clientId ?? DYNAMIC_AGENT_CLIENT,
    ...(registration === null && { agent_name_hint: AGENT_NAME_HINT }),
    ext_agent_host_id: input.hostId,
    ...(registration?.email != null && { login_hint: registration.email }),
    response_type: 'code',
    redirect_uri: CHATGPT_PASTE_REDIRECT,
    scope: SCOPES.join(' '),
    resource: CHATGPT_BASE_URL,
    state: held.state,
    nonce: held.nonce,
    code_challenge_method: 'S256',
    code_challenge: pkce.challenge,
    ...(input.consent && { prompt: 'consent' }),
  });

  return { url: `${AUTHORIZE_URL}?${params.toString()}`, held };
}

function tokenCall(fetchFn: typeof fetch, fields: Readonly<Record<string, string>>, doing: string): Effect.Effect<TokenAnswer, KinuError> {
  return Effect.gen(function* () {
    const res = yield* Effect.tryPromise({
      try: () => fetchFn(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams(fields).toString(),
      }),
      catch: (cause) => new KinuError('unavailable', `auth.openai.com could not be reached for ${doing}`, { cause }),
    });

    const text = yield* Effect.tryPromise({
      try: () => res.text(),
      catch: (cause) => new KinuError('unavailable', `auth.openai.com's answer to ${doing} was cut off`, { cause }),
    });

    const parsed = v.safeParse(TokenAnswerSchema, tolerate<unknown>(() => parseJsonValue(text), 'malformed-input'));
    const answer: TokenAnswer = parsed.success ? parsed.output : {};

    if (!res.ok) {
      const code = answer.error ?? 'unknown';
      const detail = answer.error_description === undefined ? '' : `: ${answer.error_description}`;

      return yield* Effect.die(new OAuthTokenError('chatgpt', code, `auth.openai.com refused ${doing} (HTTP ${String(res.status)} ${code})${detail}`));
    }

    return answer;
  });
}

const signingKeys = new Map<string, CryptoKey>();

function signingKey(kid: string, fetchFn: typeof fetch): Effect.Effect<CryptoKey, KinuError> {
  return Effect.gen(function* () {
    const known = signingKeys.get(kid);

    if (known !== undefined) return known;

    const res = yield* Effect.tryPromise({
      try: () => fetchFn(JWKS_URL, { headers: { accept: 'application/json' } }),
      catch: (cause) => new KinuError('unavailable', 'auth.openai.com\'s signing keys could not be read', { cause }),
    });

    const published = v.safeParse(JwksSchema, yield* Effect.tryPromise({
      try: () => res.json(),
      catch: (cause) => new KinuError('unavailable', 'auth.openai.com\'s signing keys could not be read', { cause }),
    }));

    if (!res.ok || !published.success) return yield* Effect.fail(new KinuError('unavailable', `auth.openai.com's signing keys could not be read (HTTP ${String(res.status)})`));

    for (const jwk of published.output.keys) {
      if (jwk.kty !== 'RSA' || jwk.kid === undefined) continue;
      const id = jwk.kid;

      const key = yield* Effect.tryPromise({
        try: () => crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']),
        catch: (cause) => new KinuError('io', `auth.openai.com published an unusable signing key ${id}`, { cause }),
      });

      signingKeys.set(id, key);
    }

    const key = signingKeys.get(kid);

    if (key === undefined) return yield* Effect.fail(new KinuError('denied', `the ID token names signing key ${kid}, which auth.openai.com does not publish`));

    return key;
  });
}

function base64UrlBytes(segment: string): Uint8Array<ArrayBuffer> {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/');

  return Uint8Array.from(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4)), (char) => char.charCodeAt(0));
}

function jwtPart<T extends v.GenericSchema>(schema: T, segment: string): Effect.Effect<v.InferOutput<T>, KinuError> {
  return Effect.try({
    try: () => v.parse(schema, parseJsonValue(new TextDecoder().decode(base64UrlBytes(segment)))),
    catch: (cause) => new KinuError('denied', 'the ID token is not a JWT this sign-in can read', { cause }),
  });
}

/** OpenAI's signature, the issuer, the audience (the issued client), expiry and this attempt's nonce. */
function verifiedIdentity(idToken: string, input: { readonly clientId: string; readonly nonce: string; readonly fetch: typeof fetch }): Effect.Effect<{ subject: string; email: string | null }, KinuError> {
  return Effect.gen(function* () {
    const [head = '', body = '', signature = ''] = idToken.split('.');
    const header = yield* jwtPart(JwtHeaderSchema, head);
    const claims = yield* jwtPart(ClaimsSchema, body);

    if (header.alg !== 'RS256') return yield* Effect.fail(new KinuError('denied', `the ID token is signed with ${header.alg}, not RS256`));
    const key = yield* signingKey(header.kid, input.fetch);

    const verified = yield* Effect.tryPromise({
      try: () => crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64UrlBytes(signature), new TextEncoder().encode(`${head}.${body}`)),
      catch: (cause) => new KinuError('denied', 'the ID token signature could not be checked', { cause }),
    });

    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];

    const refusal = ([
      [!verified, 'its signature does not verify against auth.openai.com\'s keys'],
      [claims.iss !== ISSUER, `it was issued by ${claims.iss}`],
      [!audience.includes(input.clientId), 'it was issued to another client'],
      [claims.exp + CLOCK_SKEW_SEC < Date.now() / 1000, 'it has expired'],
      [claims.nonce !== input.nonce, 'it does not answer this sign-in (nonce mismatch)'],
    ] as const).find(([failed]) => failed)?.[1];

    if (refusal !== undefined) return yield* Effect.fail(new KinuError('denied', `The ID token was refused: ${refusal}`));

    return { subject: claims.sub, email: claims.email ?? null };
  });
}

/** RFC 6749 §5.1: an answer without `scope` granted what was asked, or on refresh what the grant held. */
function scopesOf(scope: string | undefined, whenAbsent: readonly string[]): string[] {
  return (scope === undefined ? [...whenAbsent] : scope.split(' ').filter(Boolean)).sort();
}

/** The owner's pasted address, checked against the sign-in it must answer. */
function returnedCode(returned: string, held: ChatGptPasteSignIn): Effect.Effect<{ code: string; clientId: string } | 'declined', KinuError> {
  const text = returned.trim();
  const url = URL.canParse(text) ? new URL(text) : null;

  if (url === null || `${url.origin}${url.pathname}` !== CHATGPT_PASTE_REDIRECT) {
    return Effect.fail(new KinuError('bad_input', `Paste the whole address the browser ended on; it starts with ${CHATGPT_PASTE_REDIRECT}`));
  }

  if (!timingSafeEqual(url.searchParams.get('state') ?? '', held.state)) {
    return Effect.fail(new KinuError('bad_input', 'That address belongs to another sign-in; start the sign-in again'));
  }

  const problem = url.searchParams.get('error');

  if (problem === 'access_denied') return Effect.succeed('declined');

  if (problem !== null) return Effect.fail(new KinuError('denied', `ChatGPT did not complete the sign-in: ${problem}`));
  const code = url.searchParams.get('code') ?? '';
  const issued = url.searchParams.get('client_id');

  if (code === '') return Effect.fail(new KinuError('bad_input', 'That address carries no sign-in code'));

  if (held.registration === null) {
    return issued === null || issued === DYNAMIC_AGENT_CLIENT
      ? Effect.fail(new KinuError('denied', 'ChatGPT returned no issued client, so the registration did not complete'))
      : Effect.succeed({ code, clientId: issued });
  }

  return issued !== null && issued !== held.registration.clientId
    ? Effect.fail(new KinuError('denied', 'The sign-in came back for a different client than this account\'s registration'))
    : Effect.succeed({ code, clientId: held.registration.clientId });
}

/** Exchanges the pasted address's code with PKCE and checks the ID token and the granted scopes. */
export function finishChatGptPasteSignIn(held: ChatGptPasteSignIn, returned: string, fetchFn: typeof fetch = fetch): Promise<ChatGptPasteOutcome> {
  return settle(Effect.gen(function* () {
    const answered = yield* returnedCode(returned, held);

    if (answered === 'declined') return { outcome: 'declined' } as const;
    const { code, clientId } = answered;

    const answer = yield* tokenCall(fetchFn, {
      grant_type: 'authorization_code', client_id: clientId, code, code_verifier: held.verifier, redirect_uri: CHATGPT_PASTE_REDIRECT, resource: CHATGPT_BASE_URL,
    }, 'the sign-in code');

    const at = Date.now();

    if (answer.id_token === undefined) return yield* Effect.fail(new KinuError('denied', 'auth.openai.com answered the sign-in without an ID token'));
    const identity = yield* verifiedIdentity(answer.id_token, { clientId, nonce: held.nonce, fetch: fetchFn });

    if (held.registration !== null && held.registration.subject !== identity.subject) {
      return yield* Effect.fail(new KinuError('denied', 'The browser signed in to a different ChatGPT account than this account\'s registration'));
    }

    const registration: ChatGptRegistration = { clientId, subject: identity.subject, email: identity.email };
    const scopes = scopesOf(answer.scope, SCOPES);

    if (!scopes.includes(PLAN_SCOPE)) return { outcome: 'plan_declined', registration } as const;

    if (answer.access_token === undefined || answer.refresh_token === undefined) {
      return yield* Effect.fail(new KinuError('denied', 'auth.openai.com answered the sign-in without an access and a refresh token'));
    }

    const credential: OAuthCredential = {
      kind: 'oauth',
      accessToken: answer.access_token,
      refreshToken: answer.refresh_token,
      ...(answer.expires_in !== undefined && { expiresAt: at + answer.expires_in * 1_000 }),
      metadata: { ...registration, issuer: ISSUER, idToken: answer.id_token, scopes },
    };

    return { outcome: 'signed_in', registration, credential } as const;
  }));
}

/** The registration a stored ChatGPT login carries, for the next sign-in to the same account. */
export function chatgptRegistrationOf(credential: OAuthCredential | null): ChatGptRegistration | null {
  const parsed = v.safeParse(ChatGptRegistrationSchema, credential?.metadata);

  return parsed.success ? parsed.output : null;
}

/** Renews with the login's issued client; a spent refresh token rejects as a revoked `OAuthTokenError`. */
export function chatgptLoginIssuer(): SubscriptionIssuer {
  return {
    expiring: (credential) => credential.expiresAt === undefined || Date.now() + REFRESH_LEAD_MS >= credential.expiresAt,
    refresh: (credential, fetchFn = fetch) => settle(Effect.gen(function* () {
      const held = v.safeParse(CredentialMetadataSchema, credential.metadata);
      const refreshToken = credential.refreshToken;

      if (!held.success || refreshToken === undefined) {
        return yield* Effect.die(new OAuthTokenError('chatgpt', 'invalid_grant', 'the stored ChatGPT login has no refresh token or client to renew with'));
      }

      // `scope` stays out so the grant keeps what it had.
      const answer = yield* tokenCall(fetchFn, {
        grant_type: 'refresh_token', client_id: held.output.clientId, refresh_token: refreshToken, resource: CHATGPT_BASE_URL,
      }, 'the refresh');

      if (answer.access_token === undefined) {
        return yield* Effect.die(new OAuthTokenError('chatgpt', 'unknown', 'auth.openai.com renewed the ChatGPT login without an access token'));
      }

      return {
        kind: 'oauth',
        accessToken: answer.access_token,
        refreshToken: answer.refresh_token ?? refreshToken,
        ...(answer.expires_in !== undefined && { expiresAt: Date.now() + answer.expires_in * 1_000 }),
        metadata: { ...credential.metadata, scopes: scopesOf(answer.scope, held.output.scopes) },
      } satisfies OAuthCredential;
    })),
  };
}
