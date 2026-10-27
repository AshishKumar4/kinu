// The Google connection's sign-in. Started from the owner's own page, it asks Google with the deployment's Workspace
// client and ends where that client returns: its registered `MCP_OAUTH_CALLBACK_PATH`, which hands a state with this
// prefix here. What Google grants is kept as `google.oauth`.
import { Effect } from 'effect';
import * as oauth from 'oauth4webapi';
import * as v from 'valibot';
import {
  connectedPath, ConnectRunSchema, GOOGLE_CONNECTION_SCOPES, MCP_OAUTH_CALLBACK_PATH, googleConnectionClient, googleTokenToCredential, GoogleTokenSchema, sha256Hex,
  type GoogleConnectionEnv, type OAuthCredential,
} from '@kinu.run/core';
import { diagnostics, KinuError, renderThrownChain, settle } from '@kinu.run/core/obs';
import type { KvStore } from '@kinu.run/agent-utils';
import { handoffCookie, oauthStateCookieName, readCookie, readHandoff, setCookie, startedHere } from '../auth/cookies';
import { consumeOAuthState, createOAuthState } from '../auth/store';
import { isListedOperator } from '../control-plane/admin-caller';

/** A Google connect's state begins so: the callback it shares with the MCP servers' sign-ins hands it here. */
export const GOOGLE_CONNECT_STATE_PREFIX = 'google-connect.';


/** Google's endpoints (accounts.google.com/.well-known/openid-configuration, 2026-10-23), so a connect fetches none. */
const GOOGLE: oauth.AuthorizationServer = {
  issuer: 'https://accounts.google.com',
  authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  token_endpoint: 'https://oauth2.googleapis.com/token',
};

const SERVICE = 'Google';

export interface GoogleConnectEnv extends GoogleConnectionEnv {
  AUTH_KV?: KvStore;
  CONTROL_PLANE_ADMINS?: string;
}

/** Who is connecting: the signed-in account and its email, which must be on the deployment's operator list. */
export interface GoogleConnecting {
  readonly account: string;
  readonly email: string;
}

/** Whether this account may connect Google here: the deployment has the client, and the account is an operator's. */
export function googleConnectable(env: GoogleConnectEnv, email: string): boolean {
  return googleConnectionClient(env) !== null && isListedOperator(env, email);
}

function finish(origin: string, run: string | null, error: string | null, headers: Headers = new Headers()): Response {
  headers.set('location', new URL(connectedPath({ run, service: SERVICE, error }), origin).toString());
  headers.set('cache-control', 'no-store');

  return new Response(null, { status: 302, headers });
}

/** The connect's start: Google's consent for the connection's scopes, with a refresh token, for this account. */
export function startGoogleConnect(request: Request, env: GoogleConnectEnv, connecting: GoogleConnecting): Promise<Response> {
  return settle(Effect.gen(function* () {
    const url = new URL(request.url);
    const run = v.safeParse(ConnectRunSchema, url.searchParams.get('run'));

    if (!run.success) return new Response('A connect starts from the page that asks for it.', { status: 400 });

    if (!startedHere(request)) return finish(url.origin, run.output, 'Connecting Google starts from Kinu itself.');
    const client = googleConnectionClient(env);

    if (client === null) return finish(url.origin, run.output, 'This deployment has no Google client set up for the connection.');

    if (!isListedOperator(env, connecting.email)) return finish(url.origin, run.output, 'Google is open to this deployment\'s operators only, for now.');

    if (env.AUTH_KV === undefined) return finish(url.origin, run.output, 'This deployment has no sign-in storage (AUTH_KV) set up.');
    const kv = env.AUTH_KV;
    const codeVerifier = oauth.generateRandomCodeVerifier();
    const nonce = oauth.generateRandomNonce();
    const redirectUri = new URL(MCP_OAUTH_CALLBACK_PATH, url.origin).toString();

    const { state, binding } = yield* Effect.promise(() => createOAuthState(kv, {
      provider: 'google', codeVerifier, nonce, returnTo: '/', redirectUri, connectFor: connecting.account, connectRun: run.output, statePrefix: GOOGLE_CONNECT_STATE_PREFIX,
    }));

    const consent = new URL(GOOGLE.authorization_endpoint ?? '');

    for (const [name, value] of Object.entries({
      client_id: client.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: GOOGLE_CONNECTION_SCOPES,
      state,
      nonce,
      code_challenge: yield* Effect.promise(() => oauth.calculatePKCECodeChallenge(codeVerifier)),
      code_challenge_method: 'S256',
      // A refresh token, every time: Google issues one only at a consent it shows.
      access_type: 'offline',
      prompt: 'consent select_account',
    })) consent.searchParams.set(name, value);

    const headers = new Headers({ location: consent.toString(), 'cache-control': 'no-store' });

    headers.append('set-cookie', handoffCookie(oauthStateCookieName(sha256Hex(state)), { binding, run: run.output }));

    return new Response(null, { status: 302, headers });
  }));
}

/**
 * The connect's end at the shared callback: the state is spent by the browser it was issued to, for the account still
 * signed in, and what Google granted is kept by `keep`. It ends on the finish page, in its own words whatever failed.
 */
export function completeGoogleConnect(input: {
  readonly request: Request;
  readonly env: GoogleConnectEnv;
  readonly account: string;
  readonly keep: (credential: OAuthCredential) => Promise<void>;
}): Promise<Response> {
  return settle(Effect.gen(function* () {
    const url = new URL(input.request.url);
    const state = url.searchParams.get('state') ?? '';
    const handoffName = oauthStateCookieName(sha256Hex(state));
    const held = readHandoff(readCookie(input.request, handoffName));
    const headers = new Headers();

    headers.append('set-cookie', setCookie(handoffName, '', 0));

    const ended = yield* Effect.match(connectedGrant({ ...input, url, state, binding: held?.binding ?? null }), {
      onFailure: (failure) => {
        diagnostics.failure('google.connect_failed', failure);

        return { run: held?.run ?? null, error: failure.message };
      },
      onSuccess: (run) => ({ run, error: null }),
    });

    return finish(url.origin, ended.run, ended.error, headers);
  }));
}

/** The grant exchanged and kept; its run, for the finish page. */
function connectedGrant(input: {
  readonly env: GoogleConnectEnv;
  readonly account: string;
  readonly keep: (credential: OAuthCredential) => Promise<void>;
  readonly url: URL;
  readonly state: string;
  readonly binding: string | null;
}): Effect.Effect<string | null, KinuError> {
  return Effect.gen(function* () {
    const kv = input.env.AUTH_KV;

    if (kv === undefined) return yield* new KinuError('unavailable', 'This deployment has no sign-in storage (AUTH_KV) set up.');

    // Spent, expired, or issued to another browser: said in the store's words on the finish page.
    const consumed = yield* Effect.tryPromise({
      try: () => consumeOAuthState(kv, input.state, 'google', input.binding),
      catch: (cause) => new KinuError('denied', renderThrownChain({ cause })),
    });

    const record = consumed.record;

    if (consumed.refusal !== null) return yield* new KinuError('denied', consumed.refusal);

    if (record.connectFor !== input.account) return yield* new KinuError('denied', 'The Kinu account that started connecting Google is no longer signed in here.');
    const client = googleConnectionClient(input.env);

    if (client === null) return yield* new KinuError('unavailable', 'This deployment has no Google client set up for the connection.');
    const oauthClient: oauth.Client = { client_id: client.clientId };

    const granted = yield* Effect.tryPromise({
      try: async () => {
        const params = oauth.validateAuthResponse(GOOGLE, oauthClient, input.url.searchParams, input.state);
        const response = await oauth.authorizationCodeGrantRequest(GOOGLE, oauthClient, oauth.ClientSecretPost(client.clientSecret), params, record.redirectUri, record.codeVerifier);
        const tokens = await oauth.processAuthorizationCodeResponse(GOOGLE, oauthClient, response, { expectedNonce: record.nonce ?? oauth.expectNoNonce, requireIdToken: true });

        return { tokens, account: oauth.getValidatedIdTokenClaims(tokens)?.['email'] };
      },
      catch: (cause) => new KinuError('unavailable', `Google did not finish the connection: ${renderThrownChain({ cause })}`),
    });

    const token = v.parse(GoogleTokenSchema, { ...granted.tokens });
    const credential = googleTokenToCredential(token, typeof granted.account === 'string' ? granted.account : '');

    if (credential === null) return yield* new KinuError('unavailable', 'Google connected without an access token.');

    if (credential.refreshToken === undefined) return yield* new KinuError('unavailable', 'Google connected without a refresh token, so the connection would end within the hour. Connect Google again.');
    yield* Effect.tryPromise({ try: () => input.keep(credential), catch: (cause) => new KinuError('io', `Kinu could not keep the Google connection: ${renderThrownChain({ cause })}`) });

    return record.connectRun;
  });
}
