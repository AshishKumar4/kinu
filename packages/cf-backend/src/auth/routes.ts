import { Effect, Cause, Data } from 'effect';
import * as oauth from 'oauth4webapi';
import { Hono } from 'hono';
import { AuthError, authenticateRequest, devIdentityEmail, readSessionToken, requestIdentity } from './session';
import { handoffCookie, oauthStateCookieName, readCookie, readHandoff, SESSION_COOKIE_NAME, sessionCookie, setCookie, startedHere } from './cookies';
import {
  consumeOAuthState, createOAuthState, createSession, revokeSession,
  type OAuthProfile, type SessionAuthority,
} from './store';
import { connectedPath, ConnectRunSchema, objectNamed, sanitizeReturnTo } from '@kinu.run/core';
import { escapeHtml, json, KINU_USER_AGENT, nonEmptyString, scopeList, sha256Hex } from '@kinu.run/core';
import { authDocument, loginDocument, type BuiltinSignIn } from '@kinu.run/core';
import { builtinAccounts } from './builtin';
import { builtinSignInOn, firstOwnerLinkEmail, grantOf, OAUTH_PROVIDER_ENV, type SignInDeclarationEnv } from '@kinu.run/core/identity';
import { publicHtmlHeaders } from '@kinu.run/core';
import {
  clientAuth, getAuthorizationServer, getOAuthProvider, listConfiguredOAuthProviders,
  type OAuthProviderConfig,
} from './providers';
import {
  CLOUDFLARE_OAUTH_CRED_KEY,
  cloudflareTokenToCredential,
  readJsonObject,
  type CloudflareTokenPayload,
} from '@kinu.run/core';
import { JsonValueSchema, type JsonObject, type JsonValue } from '@kinu.run/core';
import { diagnostics, KinuError, renderThrownChain, toKinuError, settle } from '@kinu.run/core/obs';
import { notifyWorkspacesModelSettingsChanged, type ModelSettingsFanoutTarget } from '../user/workspace-access';
import type { UserDO } from '../user/user-do';
import type { ObjectNamespace } from '@kinu.run/core';
import type { KvStore } from '@kinu.run/agent-utils';
import type { OwnerCapabilityEnv } from '@kinu.run/core';
import { ownerCaller } from '@kinu.run/core';
import * as v from 'valibot';
import { noHead, rawParam, type FamilyEnv } from '../api/context';

const CloudflareUserEnvelopeSchema = v.object({
  success: v.optional(v.boolean()), result: v.optional(JsonValueSchema),
});

const CloudflareUserSchema = v.object({
  id: v.union([v.string(), v.number()]), email: v.string(),
  first_name: v.optional(v.nullable(v.string())),
  last_name: v.optional(v.nullable(v.string())),
});

const GitHubUserSchema = v.object({
  id: v.union([v.number(), v.string()]), login: v.optional(v.string()), name: v.nullable(v.optional(v.string())),
  email: v.nullable(v.optional(v.string())),
});

const GitHubEmailSchema = v.object({
  email: v.optional(v.string()), primary: v.optional(v.boolean()), verified: v.optional(v.boolean()),
});

interface MutableTokenEndpointResponse {
  [parameter: string]: oauth.JsonValue | undefined;
  access_token: string;
  token_type: 'bearer' | 'dpop';
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

export type AuthRoutesAuthority = SessionAuthority
  & Pick<UserDO, 'setCredential' | 'listActiveWorkspaces' | 'builtinHasOwner' | 'builtinInvitedEmail' | 'builtinResetAccount'>;

/** Nothing optional that the session port leaves optional: sign-out revokes through `AUTH_KV` unguarded. */
export interface AuthRoutesEnv<Id = DurableObjectId> extends SignInDeclarationEnv, OwnerCapabilityEnv {
  KINU_SETUP_TOKEN?: string;
  KINU_FIRST_OWNER_LINK?: string;
  AUTH_KV: KvStore;
  UserDO: ObjectNamespace<Id, AuthRoutesAuthority>;
  OrchestratorAgent: ObjectNamespace<Id, ModelSettingsFanoutTarget>;
  DEV_USER_EMAIL?: string;
  DEV_IDENTITY_SECRET?: string;
}

/** Sign-in state reads; other `/api/auth/*` paths are the app's. */
export const authApiRoutes = new Hono<FamilyEnv<AuthRoutesEnv<unknown>, object>>();

authApiRoutes.get('/api/auth/providers', async (c) => json({ body: { providers: listConfiguredOAuthProviders(c.env) } }));

authApiRoutes.get('/api/auth/me', (c) => {
  return settle(Effect.gen(function* () {
    return yield* Effect.catchCause(Effect.gen(function* () {
      const identity = yield* Effect.promise(async () => authenticateRequest(c.req.raw, c.env));

      return json({ body: { user: publicIdentity(identity) } });
    }), (failed) => Effect.gen(function* () {
      const e = Cause.squash(failed);

      if (e instanceof AuthError && e.status === 401) return json({ body: { user: null } }, { status: 401 });

      return yield* Effect.failCause(failed);
    }));
  }));
});

/**
 * The dev identity's sign-in: the header it is accepted in, exchanged once on the app's origin for the session any
 * sign-in mints, so a browser holds a cookie its origin scopes rather than a header it sends everywhere
 * (`devIdentityEmail`). Gated by the same possession check every route applies, so it grants nothing the header did
 * not: the same user (`accountIdFor` of the same email, as the header path mints it), now revocable as any session is.
 */
authApiRoutes.post('/api/auth/dev-session', (c) => settle(Effect.gen(function* () {
  const email = yield* devIdentityEmail(c.req.raw, c.env);

  if (email === null) return json({ body: { error: 'This request holds no dev identity.' } }, { status: 401 });

  const session = yield* Effect.promise(async () => createSession(c.env, { provider: 'dev', providerSub: 'dev', email, emailVerified: true }));
  const headers = new Headers({ 'cache-control': 'no-store' });

  headers.append('set-cookie', sessionCookie(session));

  return json({ body: { user: publicIdentity(session.identity) } }, { headers });
})));

/** Sign-in pages and OAuth legs. */
type AuthPagesEnv = FamilyEnv<AuthRoutesEnv<unknown>, object>;

export const authPageRoutes = new Hono<AuthPagesEnv>();

authPageRoutes.get('/login', noHead<AuthPagesEnv>((c) => renderLogin(c.req.raw, c.env)));

authPageRoutes.on(['GET', 'POST'], '/logout', noHead<AuthPagesEnv>((c) => logout(c.req.raw, c.env)));

authPageRoutes.get('/auth/:provider/start', noHead<AuthPagesEnv>((c) => Effect.suspend(() =>
  startOAuth(c.req.raw, c.env, decodeURIComponent(rawParam(c, 'provider'))))));

authPageRoutes.get('/auth/:provider/callback', noHead<AuthPagesEnv>((c) => Effect.suspend(() =>
  completeOAuth(c.req.raw, c.env, c.executionCtx, decodeURIComponent(rawParam(c, 'provider'))))));

function renderLogin<Id>(request: Request, env: AuthRoutesEnv<Id>): Effect.Effect<Response, KinuError> {
  return Effect.gen(function* () {
    const url = new URL(request.url);
    const returnTo = sanitizeReturnTo(url.searchParams.get('return_to') ?? '/', url.origin);
    const prompt = url.searchParams.get('prompt') === 'login' ? 'login' : null;

    const signedIn = yield* Effect.catchCause(Effect.as(Effect.promise(() => authenticateRequest(request, env)), true), (failed) => {
      const e = Cause.squash(failed);

      return e instanceof AuthError && e.status === 401 ? Effect.succeed(false) : Effect.failCause(failed);
    });

    // `prompt=login` is the step-up recovery URL; redirecting a signed-in caller back to `return_to` would
    // bounce them into the same 401, so fall through and force interactive reauth (addProviderPrompt).
    if (signedIn && prompt === null) return redirect(new URL(returnTo, url.origin).toString());

    if (builtinSignInOn(env)) {
      return new Response(loginDocument([], { ...yield* builtinSignIn(env, url, returnTo), instance: url.host }), {
        headers: { ...publicHtmlHeaders(), 'cache-control': 'no-store' },
      });
    }

    const providers = listConfiguredOAuthProviders(env).map((provider) => {
      const start = new URL(`/auth/${provider.id}/start`, url.origin);
      start.searchParams.set('return_to', returnTo);

      if (prompt) start.searchParams.set('prompt', prompt);

      return { href: escapeHtml(start.pathname + start.search), label: provider.label, id: provider.id };
    });

    return new Response(loginDocument(providers), {
      headers: { ...publicHtmlHeaders(), 'cache-control': 'no-store' },
    });
  });
}

function builtinSignIn<Id>(env: AuthRoutesEnv<Id>, url: URL, returnTo: string): Effect.Effect<Omit<BuiltinSignIn, 'instance'>, KinuError> {
  return Effect.gen(function* () {
    const invite = url.searchParams.get('invite');

    const accounts = builtinAccounts(env);
    const caller = yield* Effect.promise(async () => ownerCaller(env));

    const reset = url.searchParams.get('reset');

    if (reset !== null && reset !== '') {
      const account = yield* Effect.promise(async () => accounts.builtinResetAccount(caller, grantOf({ reset }, undefined)));

      return account === null
        ? { mode: 'sign-in', notice: 'This reset link was already used or has expired. Ask the owner for a new one.', returnTo }
        : { mode: 'reset', reset, email: account.email, returnTo };
    }

    if (invite !== null && invite !== '') {
      const email = yield* Effect.promise(async () => accounts.builtinInvitedEmail(caller, await sha256Hex(invite)));

      return email === null
        ? { mode: 'sign-in', notice: 'This invite link was already used or has expired. Ask for a new one.', returnTo }
        : { mode: 'invite', invite, email, returnTo };
    }

    const hasOwner = yield* Effect.promise(async () => accounts.builtinHasOwner(caller));
    const setup = url.searchParams.get('setup');

    if (setup !== null) {
      const email = firstOwnerLinkEmail(env.KINU_FIRST_OWNER_LINK, setup, Date.now());

      return hasOwner || email === null
        ? {
          mode: 'sign-in', returnTo,
          notice: 'This setup link was already used or has expired. Open the deploy flow for this Kinu again to get a new one.',
        }
        : { mode: 'owner', setup, email, returnTo };
    }

    if (hasOwner) return { mode: 'sign-in', returnTo };

    if ((env.KINU_SETUP_TOKEN ?? '').trim() !== '') return { mode: 'owner', returnTo };

    // A Kinu the deploy flow made: its owner account is made through the setup link its deploy page showed.
    if ((env.KINU_FIRST_OWNER_LINK ?? '').trim() !== '') {
      return {
        mode: 'setup', returnTo,
        notice: `${url.host} has no owner yet. Open the setup link the deploy page showed when it made this Kinu. `
          + 'If the link ran out, get a new one at kinu.run/deploy.',
      };
    }

    return {
      mode: 'setup', returnTo,
      notice: 'This deployment has no owner yet. Its deployer sets a setup token as the KINU_SETUP_TOKEN secret, '
        + 'keeps it in a password manager, and types it here.',
    };
  });
}

function startOAuth<Id>(request: Request, env: AuthRoutesEnv<Id>, providerId: string): Effect.Effect<Response, KinuError> {
  return Effect.gen(function* () {
    const provider = getOAuthProvider(env, providerId);

    if (!provider) return html('Sign in unavailable', '<p>This deployment has no sign-in set up for that provider. Go back and choose another one.</p>', { status: 404 });

    if (!env.AUTH_KV) return html('Sign in unavailable', '<p>This deployment has no sign-in storage (<code>AUTH_KV</code>) set up, so no one can sign in yet.</p>', { status: 503 });

    // Minted only for a start begun here: a sibling origin (a guest's preview) could otherwise mint handoffs in the
    // person's browser, each a cookie of its own, until the browser drops the oldest, the session among them.
    if (!startedHere(request)) {
      return html('Start from Kinu', '<p>Signing in and connecting start from Kinu itself: <a href="/login">sign in</a>.</p>', { status: 403 });
    }

    const url = new URL(request.url);
    const returnTo = sanitizeReturnTo(url.searchParams.get('return_to') ?? '/', url.origin);
    const redirectUri = new URL(`/auth/${provider.id}/callback`, url.origin).toString();
    // A connect attaches what the provider grants to the account asking, and signs nobody in.
    const connecting = url.searchParams.get('intent') === 'connect';
    // The starting page's run, kept in the state alone: the provider never sees it, so it cannot name it.
    const run = v.safeParse(ConnectRunSchema, url.searchParams.get('run'));

    if (connecting && !run.success) return html('Nothing to connect', '<p>A connect starts from the page that asks for it.</p>', { status: 400 });
    // A connect refused before it reaches the provider ends where every connect ends, for the run that asked.
    const refused = (error: string) => redirect(new URL(connectedPath({ run: run.success ? run.output : null, service: provider.label, error }), url.origin).toString());

    if (connecting && !CONNECTS.has(provider.id)) return refused(`Kinu keeps nothing from ${provider.label} to connect.`);
    const connectFor = connecting ? (yield* Effect.promise(async () => requestIdentity(request, env)))?.userId ?? null : null;

    if (connecting && connectFor === null) return refused('Connecting a service needs the Kinu account it is for: sign in, then connect again.');

    const as = yield* Effect.promise(async () => getAuthorizationServer(provider));

    if (!as.authorization_endpoint) return yield* Effect.die(new Error(`${provider.label} OAuth metadata has no authorization endpoint.`));

    const codeVerifier = oauth.generateRandomCodeVerifier();
    const codeChallenge = yield* Effect.promise(async () => oauth.calculatePKCECodeChallenge(codeVerifier));
    const nonce = provider.kind === 'oidc' ? oauth.generateRandomNonce() : null;

    const { state, binding } = yield* Effect.promise(async () => createOAuthState(env.AUTH_KV, {
      provider: provider.id,
      codeVerifier,
      nonce,
      returnTo,
      redirectUri,
      connectFor,
      connectRun: run.success ? run.output : null,
    }));

    const authorizationUrl = new URL(as.authorization_endpoint);
    authorizationUrl.searchParams.set('client_id', provider.clientId);
    authorizationUrl.searchParams.set('redirect_uri', redirectUri);
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('scope', provider.scopes);
    authorizationUrl.searchParams.set('state', state);
    authorizationUrl.searchParams.set('code_challenge', codeChallenge);
    authorizationUrl.searchParams.set('code_challenge_method', 'S256');

    if (nonce) authorizationUrl.searchParams.set('nonce', nonce);

    if (url.searchParams.get('prompt') === 'login') {
      addProviderPrompt(authorizationUrl, provider);
    }

    // KV holds only the binding's hash; this cookie is what the callback proves the sign-in with, beside the bindings of
    // this browser's other starts still under way.
    const headers = new Headers({ 'cache-control': 'no-store' });
    headers.append('set-cookie', handoffCookie(oauthStateCookieName(yield* Effect.promise(async () => sha256Hex(state))), { binding, run: run.success && connecting ? run.output : null }));

    return redirect(authorizationUrl.toString(), { headers });
  });
}

/** A provider's callback. Its handoff's own binding cookie is cleared whatever the outcome (its state record is spent);
 *  the browser's other starts keep theirs. */
function completeOAuth<Id>(
  request: Request, env: AuthRoutesEnv<Id>, ctx: Pick<ExecutionContext, 'waitUntil'>, providerId: string,
): Effect.Effect<Response, KinuError> {
  return Effect.gen(function* () {
    const provider = getOAuthProvider(env, providerId);

    if (!provider) return html('Sign in unavailable', '<p>This deployment has no sign-in set up for that provider. Go back and choose another one.</p>', { status: 404 });

    if (!env.AUTH_KV) return html('Sign in unavailable', '<p>This deployment has no sign-in storage (<code>AUTH_KV</code>) set up, so no one can sign in yet.</p>', { status: 503 });

    const url = new URL(request.url);
    const state = url.searchParams.get('state');

    if (!state) return html('Sign in failed', '<p>The sign-in response came back without its state. Return to <a href="/login">sign in</a> and try again.</p>', { status: 400 });

    let stage = 'state';
    // A connect whose handoff this browser holds ends on the finish page, naming its run, whatever fails after: its
    // state expired or another provider's included.
    // This handoff's own cookie, spent with it whatever the outcome; the browser's other starts keep theirs. A connect's
    // names its run, so a callback its record no longer names (expired, already used) still ends that run.
    const handoffName = oauthStateCookieName(yield* Effect.promise(async () => sha256Hex(state)));
    const held = readHandoff(readCookie(request, handoffName));
    const heldRun = v.safeParse(ConnectRunSchema, held?.run);
    let connecting: { readonly run: string | null } | null = heldRun.success ? { run: heldRun.output } : null;

    const response = yield* Effect.catchCause(Effect.gen(function* () {
      const consumed = yield* Effect.promise(async () => consumeOAuthState(env.AUTH_KV, state, provider.id, held?.binding ?? null));
      const savedState = consumed.record;

      connecting = savedState.connectFor === null ? null : { run: savedState.connectRun };

      if (consumed.refusal !== null) return yield* Effect.die(new Error(consumed.refusal));

      stage = 'metadata';
      const as = yield* Effect.promise(async () => getAuthorizationServer(provider));
      const client: oauth.Client = { client_id: provider.clientId };
      stage = 'authorization_response';
      const callbackParams = oauth.validateAuthResponse(as, client, url.searchParams, state);
      stage = 'token_request';

      const tokenResponse = yield* Effect.promise(async () => oauth.authorizationCodeGrantRequest(
        as,
        client,
        clientAuth(provider),
        callbackParams,
        savedState.redirectUri,
        savedState.codeVerifier,
      ));

      stage = 'token_response';
      const tokens = yield* processOAuthTokenResponse({ provider, as, client, response: tokenResponse, nonce: savedState.nonce ?? null });

      if (savedState.connectFor !== null) {
        stage = 'connect';

        return yield* connectGranted({ request, env, ctx, account: savedState.connectFor, run: savedState.connectRun, tokens, provider });
      }

      stage = 'profile';
      const profile = yield* fetchOAuthProfile(provider, as, client, tokens);
      stage = 'session';
      const session = yield* Effect.promise(async () => createSession(env, profile));

      if (provider.id === 'cloudflare') {
        // Never fails the sign-in: the person is signed in, and the "Connect Cloudflare Workers AI" notice reports an
        // unusable credential.
        yield* Effect.catch(attachCloudflareWorkersAI(env, ctx, session.identity.userId, tokens), (failure) => Effect.sync(() => {
          diagnostics.failure('auth.workers_ai_credential_unavailable', failure);
        }));
      }

      const destination = new URL(savedState.returnTo, url.origin).toString();
      const headers = new Headers({ 'cache-control': 'no-store' });
      headers.append('set-cookie', sessionCookie(session));

      return redirect(destination, {
        headers,
      });
    }), (failed) => Effect.sync(() => {
      const e = Cause.squash(failed);
      const failure = summarizeOAuthFailure({ cause: e });
      diagnostics.failure('auth.oauth_callback_failed', toKinuError({
        doing: 'completing the OAuth callback',
        cause: e,
        otherwise: 'unavailable',
      }), { provider: providerId, stage, reason: failure.reason, detail: failure.log });

      // A connect ends on the finish page whatever happened, in its own words.
      if (connecting !== null) {
        return redirect(new URL(connectedPath({ run: connecting.run, service: provider.label, error: failure.reason }), url.origin).toString());
      }

      // A browser holding a session needs no sign-in, and one forced here could switch it into another account: a
      // connect whose handoff could not be read ends here in its helper tab. It is told to start again from Kinu. Read
      // off the cookie alone, so an account object that cannot answer neither fails this page nor holds it up.
      const signedIn = readSessionToken(request) !== null;

      const action = signedIn
        ? '<div class="actions"><a class="provider" href="/">Return to Kinu</a></div>'
        : '<div class="actions"><a class="provider" href="/login?prompt=login">Return to sign in</a></div>';

      return html(signedIn ? 'Could not finish' : 'Sign in failed', `
      <p class="lede">${signedIn ? 'Kinu could not finish this. Close this tab and start again from Kinu.' : 'Kinu could not finish signing you in. Return to sign in and try again.'}</p>
      <p class="muted">Failure stage: <code>${escapeHtml(stage)}</code></p>
      <p class="muted">Reason: <code>${escapeHtml(failure.reason)}</code></p>
      ${action}
    `, { status: 400 });
    }));

    response.headers.append('set-cookie', setCookie(handoffName, '', 0));

    return response;
  });
}

/** The providers whose grant Kinu keeps for an account, so a connect can attach it: each one's attach. */
const CONNECTS = new Map([['cloudflare', attachCloudflareWorkersAI]]);

/**
 * A connect's end: what the provider granted is attached to the account that started it, whose session this browser
 * must still hold; no session is minted and no cookie set, so connecting a provider login under another email cannot
 * move the person into another account. It ends on the finish page, which tells the tab that started it (or, run in
 * that tab, returns it to its step).
 */
function connectGranted<Id>(input: {
  readonly request: Request; readonly env: AuthRoutesEnv<Id>; readonly ctx: Pick<ExecutionContext, 'waitUntil'>;
  readonly account: string; readonly run: string | null; readonly tokens: CloudflareTokenPayload; readonly provider: OAuthProviderConfig;
}): Effect.Effect<Response, KinuError> {
  return Effect.gen(function* () {
    const { request, env, provider } = input;
    const origin = new URL(request.url).origin;
    const signedIn = yield* Effect.promise(async () => requestIdentity(request, env));
    const attach = CONNECTS.get(provider.id) ?? (() => Effect.fail(new KinuError('unsupported', `Kinu keeps nothing from ${provider.label} to connect.`)));

    const error = signedIn?.userId === input.account
      ? yield* Effect.match(attach(env, input.ctx, input.account, input.tokens), { onFailure: (failure) => failure.message, onSuccess: () => null })
      : 'The Kinu account that started connecting is no longer signed in here.';

    return redirect(new URL(connectedPath({ run: input.run, service: provider.label, error }), origin).toString(), { headers: { 'cache-control': 'no-store' } });
  });
}

/** The Workers AI credential a Cloudflare grant carries, attached to `userId`; fails in its own words. */
function attachCloudflareWorkersAI<Id>(
  env: AuthRoutesEnv<Id>,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
  userId: string,
  tokens: CloudflareTokenPayload,
): Effect.Effect<void, KinuError> {
  return Effect.catchCause(Effect.gen(function* () {
    const credential = yield* Effect.promise(async () => cloudflareTokenToCredential(tokens));
    const userDO = objectNamed(env.UserDO, userId);
    yield* Effect.promise(async () => userDO.setCredential(await ownerCaller(env), CLOUDFLARE_OAUTH_CRED_KEY, credential));
    // No model seeding: the built-in default tier already names the native Workers AI model.
    notifyWorkspacesModelSettingsChanged(env, userDO, ctx);
  }), (failed) => Effect.fail(toKinuError({ doing: 'attaching the Workers AI credential Cloudflare granted', cause: Cause.squash(failed), otherwise: 'unavailable' })));
}

interface OAuthTokenExchange {
  provider: OAuthProviderConfig;
  as: oauth.AuthorizationServer;
  client: oauth.Client;
  response: Response;
  nonce: string | null;
}

function processOAuthTokenResponse(
  exchange: OAuthTokenExchange,
): Effect.Effect<oauth.TokenEndpointResponse, KinuError> {
  return Effect.gen(function* () {
    const { provider, as, client, response, nonce } = exchange;

    if (provider.kind === 'oidc') {
      return yield* Effect.promise(() => oauth.processAuthorizationCodeResponse(as, client, response, {
        expectedNonce: nonce ?? oauth.expectNoNonce,
        requireIdToken: true,
      }));
    }

    if (provider.id === 'cloudflare') return yield* processCloudflareTokenResponse(response);

    return yield* Effect.promise(() => oauth.processGenericTokenEndpointResponse(as, client, response));
  });
}

/** The cookie is cleared only after revocation lands: a failed revocation keeps it (503) because it is
 *  the only handle that can still revoke this session. Other sessions are untouched. */
function logout<Id>(request: Request, env: AuthRoutesEnv<Id>): Effect.Effect<Response> {
  const url = new URL(request.url);
  const returnTo = sanitizeReturnTo(url.searchParams.get('return_to') ?? '/', url.origin);
  const token = readSessionToken(request);
  const headers = new Headers({ 'cache-control': 'no-store' });
  headers.append('set-cookie', setCookie(SESSION_COOKIE_NAME, '', 0));
  const signedOut = redirect(new URL(returnTo, url.origin).toString(), { headers });

  if (!token) return Effect.succeed(signedOut);

  return Effect.catchCause(Effect.as(Effect.promise(() => revokeSession(env, token)), signedOut), (failed) => Effect.sync(() => {
    diagnostics.failure('auth.session_revoke_failed', toKinuError({
      doing: 'revoking a browser session on sign-out',
      cause: Cause.squash(failed),
      otherwise: 'unavailable',
    }));
    const retry = new URL('/logout', url.origin);
    retry.searchParams.set('return_to', returnTo);

    return html('Sign-out not confirmed', `
      <p class="lede">Kinu could not reach the store that holds your sign-in, so this session is NOT signed out yet.</p>
      <p class="muted">You are still signed in on this browser. Retry to end the session.</p>
      <div class="actions"><a class="provider" href="${escapeHtml(retry.pathname + retry.search)}">Retry sign-out</a></div>
    `, { status: 503 });
  }));
}

function fetchOAuthProfile(
  provider: OAuthProviderConfig,
  as: oauth.AuthorizationServer,
  client: oauth.Client,
  tokens: oauth.TokenEndpointResponse,
): Effect.Effect<OAuthProfile, KinuError> {
  return Effect.gen(function* () {
    if (provider.id === 'github') return yield* fetchGitHubProfile(tokens.access_token);

    if (provider.id === 'cloudflare') return yield* fetchCloudflareProfile(tokens.access_token);

    const idClaims = oauth.getValidatedIdTokenClaims(tokens);
    let userinfo: oauth.UserInfoResponse | null = null;

    if (as.userinfo_endpoint && tokens.access_token) {
      const userinfoResponse = yield* Effect.promise(async () => oauth.userInfoRequest(as, client, tokens.access_token));
      userinfo = yield* Effect.promise(async () => oauth.processUserInfoResponse(
        as,
        client,
        idClaims?.sub ?? oauth.skipSubjectCheck,
        userinfoResponse,
      ));
    }

    const sub = stringClaim(userinfo?.sub) ?? stringClaim(idClaims?.sub);
    const email = stringClaim(userinfo?.email) ?? stringClaim(idClaims?.email);
    const emailVerified = boolClaim(userinfo?.email_verified) ?? boolClaim(idClaims?.email_verified) ?? false;

    if (!sub) return yield* Effect.die(new Error(`${provider.label} did not return a stable subject.`));

    if (!email) return yield* Effect.die(new Error(`${provider.label} did not return an email address.`));

    return {
      provider: provider.id,
      providerSub: sub,
      email,
      emailVerified,
      displayName: stringClaim(userinfo?.name) ?? stringClaim(idClaims?.name) ?? null,
    } satisfies OAuthProfile;
  });
}

class OAuthProviderTokenError extends Data.TaggedError('OAuthProviderTokenError')<{ readonly message: string }> {
  constructor(
    public readonly providerError: string,
    public readonly status?: number,
    public readonly providerDescription?: string,
  ) {
    super({ message: providerDescription ?? providerError });
  }
}

function processCloudflareTokenResponse(response: Response): Effect.Effect<oauth.TokenEndpointResponse, KinuError> {
  return Effect.gen(function* () {
    const body = yield* Effect.promise(async () => readJsonObject(response, 'Cloudflare token endpoint'));

    if (!response.ok) {
      const providerError = stringClaim(body.error) ?? `http_${response.status}`;

      return yield* Effect.die(new OAuthProviderTokenError(providerError, response.status, stringClaim(body.error_description) ?? undefined));
    }

    if (stringClaim(body.error)) {
      return yield* Effect.die(new OAuthProviderTokenError(
        stringClaim(body.error) ?? 'token_error',
        response.status,
        stringClaim(body.error_description) ?? undefined,
      ));
    }

    return yield* cloudflareTokenJsonToResponse(body);
  });
}

function cloudflareTokenJsonToResponse(body: JsonObject): Effect.Effect<oauth.TokenEndpointResponse, KinuError> {
  return Effect.gen(function* () {
    const accessToken = stringClaim(body.access_token);

    if (!accessToken) return yield* Effect.die(new Error('Cloudflare token endpoint did not return an access token.'));

    const tokenType = stringClaim(body.token_type)?.toLowerCase() === 'dpop' ? 'dpop' : 'bearer';

    const out: MutableTokenEndpointResponse = {
      access_token: accessToken,
      token_type: tokenType,
    };

    const expiresIn = numberClaim(body.expires_in);

    if (expiresIn !== null) out.expires_in = expiresIn;

    const refreshToken = stringClaim(body.refresh_token);

    if (refreshToken) out.refresh_token = refreshToken;

    const scope = scopeClaim(body.scope);

    if (scope) out.scope = scope;

    for (const [key, value] of Object.entries(body)) {
      if (key in out) continue;

      if (v.is(JsonValueSchema, value)) out[key] = value;
    }

    return out;
  });
}

function fetchCloudflareProfile(accessToken: string | undefined): Effect.Effect<OAuthProfile, KinuError> {
  return Effect.gen(function* () {
    if (!accessToken) return yield* Effect.die(new Error('Cloudflare token response did not include an access token.'));

    const res = yield* Effect.promise(async () => fetch('https://api.cloudflare.com/client/v4/user', {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
    }));

    if (!res.ok) return yield* Effect.die(new Error(`Cloudflare user lookup failed: ${res.status}`));
    const body = v.parse(CloudflareUserEnvelopeSchema, yield* Effect.promise(async () => res.json()));

    if (body.success === false) return yield* Effect.die(new Error('Cloudflare user lookup failed.'));

    return yield* cloudflareUserResultToProfile(body.result);
  });
}

function cloudflareUserResultToProfile(result: JsonValue | undefined): Effect.Effect<OAuthProfile, KinuError> {
  return Effect.gen(function* () {
    const user = v.parse(CloudflareUserSchema, result);
    const id = String(user.id);
    const email = user.email.trim();

    if (!id) return yield* Effect.die(new Error('Cloudflare did not return a stable user id.'));

    if (!email) return yield* Effect.die(new Error('Cloudflare did not return an email address.'));

    const firstName = stringClaim(user.first_name);
    const lastName = stringClaim(user.last_name);
    const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();

    return {
      provider: 'cloudflare',
      providerSub: id,
      email,
      emailVerified: true,
      displayName: fullName === '' ? null : fullName,
    } satisfies OAuthProfile;
  });
}

function fetchGitHubProfile(accessToken: string): Effect.Effect<OAuthProfile, KinuError> {
  return Effect.gen(function* () {
    const headers = {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${accessToken}`,
      'user-agent': KINU_USER_AGENT,
      'x-github-api-version': '2022-11-28',
    };

    const userRes = yield* Effect.promise(async () => fetch('https://api.github.com/user', { headers }));

    if (!userRes.ok) return yield* Effect.die(new Error(`GitHub user lookup failed: ${userRes.status}`));
    const user = v.parse(GitHubUserSchema, yield* Effect.promise(async () => userRes.json()));

    const emailsRes = yield* Effect.promise(async () => fetch('https://api.github.com/user/emails', { headers }));

    if (!emailsRes.ok) return yield* Effect.die(new Error(`GitHub email lookup failed: ${emailsRes.status}`));
    const emails = v.parse(v.array(GitHubEmailSchema), yield* Effect.promise(async () => emailsRes.json()));
    const verified = emails.filter((e) => e.email && e.verified);
    const primary = verified.find((e) => e.primary) ?? verified[0];
    const email = primary?.email ?? user.email ?? null;
    const emailVerified = Boolean(primary?.email) || verified.some((e) => e.email === user.email);

    if (!user.id) return yield* Effect.die(new Error('GitHub did not return a stable user id.'));

    if (!email) return yield* Effect.die(new Error('GitHub did not return a verified email address.'));

    return {
      provider: 'github',
      providerSub: String(user.id),
      email,
      emailVerified,
      displayName: stringClaim(user.name) ?? stringClaim(user.login),
    } satisfies OAuthProfile;
  });
}

interface PublicIdentity {
  id: string;
  email: string;
  provider?: string;
  /** The provider's name as a person knows it; null for a sign-in that is not a provider's (a password). */
  signedInWith: string | null;
  displayName: string | null;
}

function publicIdentity(identity: {
  userId: string; email: string; provider?: string; displayName?: string | null;
}): PublicIdentity {
  const provider = Object.entries(OAUTH_PROVIDER_ENV).find(([id]) => id === identity.provider)?.[1];

  return {
    id: identity.userId,
    email: identity.email,
    provider: identity.provider,
    signedInWith: provider?.label ?? null,
    displayName: identity.displayName ?? null,
  };
}

function addProviderPrompt(url: URL, provider: OAuthProviderConfig): void {
  if (provider.id === 'google') {
    url.searchParams.set('prompt', 'select_account');

    return;
  }

  if (provider.id === 'cloudflare') {
    url.searchParams.set('prompt', 'login');
  }
}

function stringClaim(value: oauth.JsonValue | undefined): string | null {
  return nonEmptyString({ value }) ?? null;
}

function boolClaim(value: oauth.JsonValue | undefined): boolean | null {
  return v.is(v.boolean(), value) ? value : null;
}

function numberClaim(value: oauth.JsonValue | undefined): number | null {
  if (v.is(v.number(), value) && Number.isFinite(value)) return value;

  if (v.is(v.string(), value) && value.trim()) {
    const parsed = Number(value);

    if (Number.isFinite(parsed)) return parsed;
  }

  return null;
}

function scopeClaim(value: oauth.JsonValue | undefined): string | null {
  return scopeList({ value })?.join(' ') ?? null;
}

interface OAuthFailureSummary { reason: string; log: string }

function summarizeOAuthFailure(thrown: { cause: unknown }): OAuthFailureSummary {
  const error = thrown.cause;

  if (error instanceof OAuthProviderTokenError) {
    const reason = `provider_${sanitizeReason(error.providerError)}`;

    return {
      reason,
      log: `${reason}${error.status ? ` status=${error.status}` : ''}${error.providerDescription ? ` description=${error.providerDescription}` : ''}`,
    };
  }

  if (error instanceof oauth.ResponseBodyError) {
    const reason = `provider_${sanitizeReason(error.error)}`;

    return {
      reason,
      log: `${reason} status=${error.status}${error.error_description ? ` description=${error.error_description}` : ''}`,
    };
  }

  if (error instanceof oauth.AuthorizationResponseError) {
    const reason = `authorization_${sanitizeReason(error.error)}`;

    return {
      reason,
      log: `${reason}${error.error_description ? ` description=${error.error_description}` : ''}`,
    };
  }

  if (error instanceof oauth.WWWAuthenticateChallengeError) {
    return { reason: 'www_authenticate_challenge', log: `www_authenticate_challenge status=${error.status}` };
  }

  if (error instanceof oauth.OperationProcessingError) {
    return { reason: sanitizeReason(error.code ?? error.name), log: `${error.code ?? error.name}: ${error.message}` };
  }

  if (error instanceof Error) {
    const message = error.message || error.name || 'error';

    return { reason: sanitizeReason(message), log: message };
  }

  return { reason: 'unknown_error', log: renderThrownChain({ cause: error }) };
}

function sanitizeReason(value: string | undefined): string {
  const cleaned = (value ?? 'unknown_error').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

  return cleaned || 'unknown_error';
}

function redirect(location: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('location', location);

  return new Response(null, {
    ...init,
    status: init.status ?? 302,
    headers,
  });
}

/** Same card as `loginDocument`, with failure prose. */
function html(title: string, body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);

  for (const [key, value] of Object.entries(publicHtmlHeaders())) headers.set(key, value);

  return new Response(authDocument(title, body), { ...init, headers });
}
