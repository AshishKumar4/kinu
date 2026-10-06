// Sign in with ChatGPT held by a Kinu deployment: the owner signs in in any browser and pastes back the 127.0.0.1
// address it ends on. The protocol is chatgpt-protocol.ts.
import * as v from 'valibot';
import { Effect } from 'effect';
import type { OAuthCredential } from '../credentials/store';
import { OAuthTokenError } from './oauth-token-error';
import type { SubscriptionIssuer } from './subscription-login';
import { KinuError, settle, tolerate } from '../obs/index';
import { createPkcePair, hmacSha256Hex, randomToken, timingSafeEqual } from '../utils/crypto';
import { parseJsonValue } from '../utils/json';
import {
  DYNAMIC_AGENT_CLIENT, ISSUER, JWKS_URL, RESOURCE, REVOKE_URL, SCOPES, TOKEN_URL,
  authorizeUrl, expiring, grantsPlan, idTokenIdentity, idTokenKeyId, idTokenSignatureVerifies, refreshedTokens, scopesOf, signedInTokens, tokenRefusal,
  type IdToken, type IdTokenIdentity, type TokenAnswer,
} from './chatgpt-protocol';

export const CHATGPT_REVOKE_URL = REVOKE_URL;

/** Nothing listens here: the failed load leaves this address to paste back. */
export const CHATGPT_PASTE_REDIRECT = 'http://127.0.0.1:1455/auth/callback';

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

const TokenAnswerSchema = v.pipe(v.looseObject({
  access_token: v.optional(v.string()),
  refresh_token: v.optional(v.string()),
  id_token: v.optional(v.string()),
  expires_in: v.optional(v.number()),
  scope: v.optional(v.string()),
  error: v.optional(v.string()),
  error_description: v.optional(v.string()),
}), v.transform((body): TokenAnswer => ({
  accessToken: body.access_token, refreshToken: body.refresh_token, idToken: body.id_token, expiresIn: body.expires_in,
  scope: body.scope, error: body.error, errorDescription: body.error_description,
})));

const JwksSchema = v.object({ keys: v.array(v.looseObject({ kty: v.string(), kid: v.optional(v.string()) })) });

const JwtHeaderSchema = v.looseObject({ alg: v.optional(v.string()), kid: v.optional(v.string()) });

const ClaimsSchema = v.looseObject({
  iss: v.optional(v.string()),
  aud: v.optional(v.union([v.string(), v.array(v.string())])),
  exp: v.optional(v.number()),
  nonce: v.optional(v.string()),
  sub: v.optional(v.string()),
  email: v.optional(v.string()),
});

/** `ext_agent_host_id`: a UUID URN derived from the deployment's credential root, opaque and stable. */
export async function chatgptHostId(credentialRoot: string): Promise<string> {
  const hex = (await hmacSha256Hex(credentialRoot, 'kinu chatgpt ext_agent_host_id')).slice(0, 32).split('');

  hex[12] = '4';
  hex[16] = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  const id = hex.join('');

  return `urn:uuid:${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

/** The authorize address, and what the account holds until the owner pastes it back. */
export async function startChatGptPasteSignIn(input: {
  readonly hostId: string;
  readonly registration: ChatGptRegistration | null;
  readonly consent: boolean;
}): Promise<{ readonly url: string; readonly held: ChatGptPasteSignIn }> {
  const pkce = await createPkcePair();
  const held: ChatGptPasteSignIn = { state: randomToken(32), nonce: randomToken(32), verifier: pkce.verifier, registration: input.registration };
  const { registration } = input;

  const url = authorizeUrl({
    registration, hostId: input.hostId, redirectUri: CHATGPT_PASTE_REDIRECT, state: held.state, nonce: held.nonce, challenge: pkce.challenge, consent: input.consent,
  });

  return { url, held };
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
    const answer = parsed.success ? parsed.output : v.parse(TokenAnswerSchema, {});

    if (!res.ok) {
      const refusal = tokenRefusal(res.status, answer, doing);

      return yield* Effect.die(new OAuthTokenError('chatgpt', refusal.code ?? 'unknown', refusal.message));
    }

    return answer;
  });
}

const signingKeys = new Map<string, CryptoKey>();

function signingKey(kid: string, fetchFn: typeof fetch): Effect.Effect<CryptoKey, KinuError> {
  return Effect.gen(function* () {
    if (!signingKeys.has(kid)) {
      const res = yield* Effect.tryPromise({
        try: () => fetchFn(JWKS_URL, { headers: { accept: 'application/json' } }),
        catch: (cause) => new KinuError('unavailable', 'auth.openai.com\'s signing keys could not be read', { cause }),
      });

      if (!res.ok) return yield* Effect.fail(new KinuError('unavailable', `auth.openai.com's signing keys could not be read (HTTP ${String(res.status)})`));

      const published = v.safeParse(JwksSchema, yield* Effect.tryPromise({
        try: () => res.json(),
        catch: (cause) => new KinuError('unavailable', 'auth.openai.com\'s signing keys could not be read', { cause }),
      }));

      if (!published.success) return yield* Effect.fail(new KinuError('unavailable', 'auth.openai.com\'s signing keys could not be read'));

      for (const jwk of published.output.keys) {
        const id = jwk.kid;

        if (jwk.kty !== 'RSA' || id === undefined) continue;

        signingKeys.set(id, yield* Effect.tryPromise({
          try: () => crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']),
          catch: (cause) => new KinuError('io', `auth.openai.com published an unusable signing key ${id}`, { cause }),
        }));
      }
    }

    const key = signingKeys.get(kid);

    if (key === undefined) return yield* Effect.fail(new KinuError('denied', `the ID token names signing key ${kid}, which auth.openai.com does not publish`));

    return key;
  });
}

function base64UrlText(segment: string): string {
  const padded = segment.replaceAll('-', '+').replaceAll('_', '/');

  return new TextDecoder().decode(Uint8Array.from(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4)), (char) => char.charCodeAt(0)));
}

function jwtPart<T extends v.GenericSchema>(schema: T, segment: string): Effect.Effect<v.InferOutput<T>, KinuError> {
  return Effect.try({
    try: () => v.parse(schema, parseJsonValue(base64UrlText(segment))),
    catch: (cause) => new KinuError('denied', 'the ID token is not a JWT this sign-in can read', { cause }),
  });
}

function verifiedIdentity(idToken: string, input: { readonly clientId: string; readonly nonce: string; readonly fetch: typeof fetch }): Effect.Effect<IdTokenIdentity, KinuError> {
  return Effect.gen(function* () {
    const [head = '', body = '', signature = ''] = idToken.split('.');
    const header = yield* jwtPart(JwtHeaderSchema, head);
    const claims = yield* jwtPart(ClaimsSchema, body);

    const token: IdToken = {
      algorithm: header.alg, keyId: header.kid, issuer: claims.iss, audience: claims.aud === undefined ? [] : [claims.aud].flat(),
      expires: claims.exp, nonce: claims.nonce, subject: claims.sub, email: claims.email,
    };

    const named = idTokenKeyId(token);

    if ('problem' in named) return yield* Effect.fail(new KinuError('denied', `The ID token was refused: ${named.problem}`));
    const key = yield* signingKey(named.keyId, input.fetch);

    const verified = yield* Effect.tryPromise({
      try: () => idTokenSignatureVerifies(key, `${head}.${body}`, signature),
      catch: (cause) => new KinuError('denied', 'the ID token signature could not be checked', { cause }),
    });

    if (!verified) return yield* Effect.fail(new KinuError('denied', 'The ID token was refused: its signature does not verify against auth.openai.com\'s keys'));
    const identity = idTokenIdentity(token, { clientId: input.clientId, nonce: input.nonce, now: Date.now() });

    return 'problem' in identity ? yield* Effect.fail(new KinuError('denied', `The ID token was refused: ${identity.problem}`)) : identity;
  });
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

export function finishChatGptPasteSignIn(held: ChatGptPasteSignIn, returned: string, fetchFn: typeof fetch = fetch): Promise<ChatGptPasteOutcome> {
  return settle(Effect.gen(function* () {
    const answered = yield* returnedCode(returned, held);

    if (answered === 'declined') return { outcome: 'declined' } as const;
    const { code, clientId } = answered;

    const answer = yield* tokenCall(fetchFn, {
      grant_type: 'authorization_code', client_id: clientId, code, code_verifier: held.verifier, redirect_uri: CHATGPT_PASTE_REDIRECT, resource: RESOURCE,
    }, 'the sign-in code');

    const at = Date.now();

    if (answer.idToken === undefined) return yield* Effect.fail(new KinuError('denied', 'auth.openai.com answered the sign-in without an ID token'));
    const identity = yield* verifiedIdentity(answer.idToken, { clientId, nonce: held.nonce, fetch: fetchFn });

    if (held.registration !== null && held.registration.subject !== identity.subject) {
      return yield* Effect.fail(new KinuError('denied', 'The browser signed in to a different ChatGPT account than this account\'s registration'));
    }

    const registration: ChatGptRegistration = { clientId, subject: identity.subject, email: identity.email };

    if (!grantsPlan(scopesOf(answer.scope, SCOPES))) return { outcome: 'plan_declined', registration } as const;
    const tokens = signedInTokens(answer, at);

    if ('problem' in tokens) return yield* Effect.fail(new KinuError('denied', tokens.problem));
    const { scopes, ...granted } = tokens;

    const credential: OAuthCredential = {
      kind: 'oauth', ...granted, metadata: { ...registration, issuer: ISSUER, idToken: answer.idToken, scopes },
    };

    return { outcome: 'signed_in', registration, credential } as const;
  }));
}

export function chatgptRegistrationOf(credential: OAuthCredential | null): ChatGptRegistration | null {
  const parsed = v.safeParse(ChatGptRegistrationSchema, credential?.metadata);

  return parsed.success ? parsed.output : null;
}

/** Renews with the login's issued client; a spent refresh token rejects as a revoked `OAuthTokenError`. */
export function chatgptLoginIssuer(): SubscriptionIssuer {
  return {
    expiring: (credential) => expiring(credential, Date.now()),
    refresh: (credential, fetchFn = fetch) => settle(Effect.gen(function* () {
      const held = v.safeParse(CredentialMetadataSchema, credential.metadata);
      const refreshToken = credential.refreshToken;

      if (!held.success || refreshToken === undefined) {
        return yield* Effect.die(new OAuthTokenError('chatgpt', 'invalid_grant', 'the stored ChatGPT login has no refresh token or client to renew with'));
      }

      // `scope` stays out so the grant keeps what it had.
      const answer = yield* tokenCall(fetchFn, {
        grant_type: 'refresh_token', client_id: held.output.clientId, refresh_token: refreshToken, resource: RESOURCE,
      }, 'the refresh');

      const tokens = refreshedTokens(answer, { refreshToken, scopes: held.output.scopes }, Date.now());

      if ('problem' in tokens) return yield* Effect.die(new OAuthTokenError('chatgpt', 'unknown', tokens.problem));
      const { scopes, ...renewed } = tokens;

      return { kind: 'oauth', ...renewed, metadata: { ...credential.metadata, scopes } } satisfies OAuthCredential;
    })),
  };
}
