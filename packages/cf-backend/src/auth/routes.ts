import * as oauth from 'oauth4webapi';
import {
  AuthError, OAUTH_STATE_COOKIE_NAME, SESSION_COOKIE_NAME, authenticateRequest, readCookie,
  readSessionToken,
} from './session';
import {
  consumeOAuthState, createOAuthState, createSession, revokeSession, sanitizeReturnTo,
  type OAuthProfile,
} from './store';
import { escapeHtml, json, KINU_USER_AGENT } from '../lib/http';
import { authDocument, loginDocument } from '../lib/public-pages';
import { publicHtmlHeaders } from '../lib/security-headers';
import {
  clientAuth, getAuthorizationServer, getOAuthProvider, listConfiguredOAuthProviders,
  type OAuthProviderConfig,
} from './providers';
import {
  CLOUDFLARE_OAUTH_CRED_KEY,
  cloudflareTokenToCredential,
  isCloudflareCredentialUsable,
  type CloudflareTokenPayload,
} from '../lib/cloudflare-oauth';
import { DEFAULT_WORKERS_AI_MODEL_SPEC, JsonObjectSchema, JsonValueSchema, type JsonObject } from '@kinu.run/core';
import { diagnostics, toKinuError } from '@kinu.run/core/obs';
import { notifyWorkspacesCredentialsChanged } from '../user/workspace-access';
import { ownerCaller } from '../user/workspace-capability';
import * as v from 'valibot';

const CloudflareUserEnvelopeSchema = v.object({
  success: v.optional(v.boolean()), result: v.optional(JsonValueSchema),
});
const CloudflareUserSchema = v.object({
  id: v.union([v.string(), v.number()]), email: v.string(),
  first_name: v.optional(v.nullable(v.string())),
  last_name: v.optional(v.nullable(v.string())),
  username: v.optional(v.nullable(v.string())),
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

export async function handleAuthRequest(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response | null> {
  const url = new URL(request.url);
  const method = request.method;

  if (url.pathname === '/api/auth/providers' && method === 'GET') {
    return json({ providers: listConfiguredOAuthProviders(env) });
  }

  if (url.pathname === '/api/auth/me' && method === 'GET') {
    try {
      const identity = await authenticateRequest(request, env);
      return json({ user: publicIdentity(identity) });
    } catch (e) {
      if (e instanceof AuthError && e.status === 401) return json({ user: null }, { status: 401 });
      throw e;
    }
  }

  if (url.pathname === '/login' && method === 'GET') {
    return renderLogin(request, env);
  }

  if (url.pathname === '/logout' && (method === 'GET' || method === 'POST')) {
    return logout(request, env);
  }

  const startMatch = url.pathname.match(/^\/auth\/([^/]+)\/start$/);
  if (startMatch && method === 'GET') {
    return startOAuth(request, env, decodeURIComponent(startMatch[1]));
  }

  const callbackMatch = url.pathname.match(/^\/auth\/([^/]+)\/callback$/);
  if (callbackMatch && method === 'GET') {
    return finishOAuth(request, env, ctx, decodeURIComponent(callbackMatch[1]));
  }

  return null;
}

async function renderLogin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const returnTo = sanitizeReturnTo(url.searchParams.get('return_to') ?? '/');
  const prompt = url.searchParams.get('prompt') === 'login' ? 'login' : null;

  try {
    await authenticateRequest(request, env);
    // `prompt=login` is the step-up recovery URL — the page a stale session is
    // SENT to when a mutation refuses its authTime. Answering it with a
    // redirect back to `return_to` would bounce the operator into the very
    // 401 that sent them here, so the signed-in caller falls through to the
    // provider list like an unsigned one, and the provider's own reauth
    // parameter (startOAuth → addProviderPrompt) forces the interactive login.
    if (prompt === null) return redirect(new URL(returnTo, url.origin).toString());
  } catch (e) {
    if (!(e instanceof AuthError) || e.status !== 401) throw e;
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
}

async function startOAuth(request: Request, env: Env, providerId: string): Promise<Response> {
  const provider = getOAuthProvider(env, providerId);
  if (!provider) return html('Sign in unavailable', '<p>This sign-in provider is not configured.</p>', { status: 404 });
  if (!env.AUTH_KV) return html('Sign in unavailable', '<p>Browser auth storage is not configured.</p>', { status: 503 });

  const url = new URL(request.url);
  const returnTo = sanitizeReturnTo(url.searchParams.get('return_to') ?? '/');
  const redirectUri = new URL(`/auth/${provider.id}/callback`, url.origin).toString();
  const as = await getAuthorizationServer(provider);
  if (!as.authorization_endpoint) throw new Error(`${provider.label} OAuth metadata has no authorization endpoint.`);

  const codeVerifier = oauth.generateRandomCodeVerifier();
  const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier);
  const nonce = provider.kind === 'oidc' ? oauth.generateRandomNonce() : null;
  const { state, binding, expiresAt: handoffExpiresAt } = await createOAuthState(env.AUTH_KV, {
    provider: provider.id,
    codeVerifier,
    nonce,
    returnTo,
    redirectUri,
  });

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

  // The binding half of the handoff goes to the browser and nowhere else: the
  // record in KV holds only its hash, so this cookie is what the callback
  // proves the sign-in with.
  const headers = new Headers({ 'cache-control': 'no-store' });
  headers.append('set-cookie', cookie(OAUTH_STATE_COOKIE_NAME, binding, handoffExpiresAt));
  return redirect(authorizationUrl.toString(), { headers });
}

/**
 * A provider callback, and then the handoff cookie burned whatever the outcome.
 *
 * The state record it pairs with is deleted the moment it is read, so leaving
 * the cookie in the browser would leave one spent half of a one-time pair
 * behind — and a browser that keeps it is a browser that keeps offering it.
 */
async function finishOAuth(request: Request, env: Env, ctx: ExecutionContext | undefined, providerId: string): Promise<Response> {
  const response = await completeOAuth(request, env, ctx, providerId);
  response.headers.append('set-cookie', cookie(OAUTH_STATE_COOKIE_NAME, '', 0));
  return response;
}

async function completeOAuth(request: Request, env: Env, ctx: ExecutionContext | undefined, providerId: string): Promise<Response> {
  const provider = getOAuthProvider(env, providerId);
  if (!provider) return html('Sign in unavailable', '<p>This sign-in provider is not configured.</p>', { status: 404 });
  if (!env.AUTH_KV) return html('Sign in unavailable', '<p>Browser auth storage is not configured.</p>', { status: 503 });

  const url = new URL(request.url);
  const state = url.searchParams.get('state');
  if (!state) return html('Sign in failed', '<p>OAuth callback is missing state.</p>', { status: 400 });

  let stage = 'state';
  try {
    const savedState = await consumeOAuthState(
      env.AUTH_KV, state, provider.id, readCookie(request, OAUTH_STATE_COOKIE_NAME),
    );
    stage = 'metadata';
    const as = await getAuthorizationServer(provider);
    const client: oauth.Client = { client_id: provider.clientId };
    stage = 'authorization_response';
    const callbackParams = oauth.validateAuthResponse(as, client, url.searchParams, state);
    stage = 'token_request';
    const tokenResponse = await oauth.authorizationCodeGrantRequest(
      as,
      client,
      clientAuth(provider),
      callbackParams,
      savedState.redirectUri,
      savedState.codeVerifier,
    );
    stage = 'token_response';
    const tokens = await processOAuthTokenResponse(provider, as, client, tokenResponse, savedState.nonce ?? null);
    stage = 'profile';
    const profile = await fetchOAuthProfile(provider, as, client, tokens);
    stage = 'session';
    const session = await createSession(env, profile);
    if (provider.id === 'cloudflare') {
      await attachCloudflareWorkersAI(env, ctx, session.identity.userId, tokens);
    }
    const destination = new URL(savedState.returnTo, url.origin).toString();
    const headers = new Headers({ 'cache-control': 'no-store' });
    headers.append('set-cookie', cookie(SESSION_COOKIE_NAME, session.token, session.expiresAt));
    return redirect(destination, {
      headers,
    });
  } catch (e) {
    const failure = summarizeOAuthFailure(e);
    diagnostics.failure('auth.oauth_callback_failed', toKinuError({
      doing: 'completing the OAuth callback',
      cause: e,
      otherwise: 'unavailable',
    }), { provider: providerId, stage, reason: failure.reason, detail: failure.log });
    return html('Sign in failed', `
      <p class="lede">The sign-in request could not be completed. Return to sign in and try again.</p>
      <p class="muted">Failure stage: <code>${escapeHtml(stage)}</code></p>
      <p class="muted">Reason: <code>${escapeHtml(failure.reason)}</code></p>
      <div class="actions"><a class="provider" href="/login?prompt=login">Return to sign in</a></div>
    `, { status: 400 });
  }
}

/**
 * Attach the Workers AI credential to a Cloudflare sign-in.
 *
 * Runs after the session exists, and never throws: the operator is already
 * signed in by this point, and a billing lookup must not be able to undo that.
 * A token that sees no account — or a Cloudflare API that is down — leaves the
 * credential unusable, which the "Connect Cloudflare Workers AI" notice
 * already reports on its own.
 */
async function attachCloudflareWorkersAI(
  env: Env,
  ctx: ExecutionContext | undefined,
  userId: string,
  tokens: CloudflareTokenPayload,
): Promise<void> {
  try {
    const credential = await cloudflareTokenToCredential(tokens);
    const userDO = env.UserDO.get(env.UserDO.idFromName(userId));
    await userDO.setCredential(await ownerCaller(env), CLOUDFLARE_OAUTH_CRED_KEY, credential);
    // Only default to Workers AI when the credential can actually serve it;
    // otherwise the operator lands on a model they cannot call.
    if (isCloudflareCredentialUsable(credential) && !await userDO.getConfig(await ownerCaller(env), 'default_model')) {
      await userDO.setConfig(await ownerCaller(env), 'default_model', DEFAULT_WORKERS_AI_MODEL_SPEC);
    }
    notifyWorkspacesCredentialsChanged(env, userDO, ctx);
  } catch (e) {
    const failure = summarizeOAuthFailure(e);
    diagnostics.failure('auth.workers_ai_credential_unavailable', toKinuError({
      doing: 'attaching the Workers AI credential to a Cloudflare sign-in',
      cause: e,
      otherwise: 'unavailable',
    }), { reason: failure.reason, detail: failure.log });
  }
}

async function processOAuthTokenResponse(
  provider: OAuthProviderConfig,
  as: oauth.AuthorizationServer,
  client: oauth.Client,
  response: Response,
  nonce: string | null,
): Promise<oauth.TokenEndpointResponse> {
  if (provider.kind === 'oidc') {
    return oauth.processAuthorizationCodeResponse(as, client, response, {
      expectedNonce: nonce ?? oauth.expectNoNonce,
      requireIdToken: true,
    });
  }

  if (provider.id === 'cloudflare') return processCloudflareTokenResponse(response);
  return oauth.processGenericTokenEndpointResponse(as, client, response);
}

/**
 * Sign out of THIS session.
 *
 * The revocation is what ends a session, so the cookie is cleared only after
 * one lands. A failed revocation KEEPS the cookie. That cookie is the only
 * handle that can still revoke this exact session, and clearing it would leave
 * the session live with nothing able to reach it. The answer is then a 503 that
 * says the session is still signed in, and a retry that can end it. Nothing
 * here touches the user's other sessions.
 */
async function logout(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const returnTo = sanitizeReturnTo(url.searchParams.get('return_to') ?? '/');
  const token = readSessionToken(request);

  if (token) {
    try {
      await revokeSession(env, token);
    } catch (e) {
      diagnostics.failure('auth.session_revoke_failed', toKinuError({
        doing: 'revoking a browser session on sign-out',
        cause: e,
        otherwise: 'unavailable',
      }));
      const retry = new URL('/logout', url.origin);
      retry.searchParams.set('return_to', returnTo);
      return html('Sign-out not confirmed', `
        <p class="lede">Kinu could not reach the store that holds your sign-in, so this session is NOT signed out yet.</p>
        <p class="muted">You are still signed in on this browser. Retry to end the session.</p>
        <div class="actions"><a class="provider" href="${escapeHtml(retry.pathname + retry.search)}">Retry sign-out</a></div>
      `, { status: 503 });
    }
  }

  const headers = new Headers({ 'cache-control': 'no-store' });
  headers.append('set-cookie', cookie(SESSION_COOKIE_NAME, '', 0));
  return redirect(new URL(returnTo, url.origin).toString(), {
    headers,
  });
}

async function fetchOAuthProfile(
  provider: OAuthProviderConfig,
  as: oauth.AuthorizationServer,
  client: oauth.Client,
  tokens: oauth.TokenEndpointResponse,
): Promise<OAuthProfile> {
  if (provider.id === 'github') return fetchGitHubProfile(tokens.access_token);
  if (provider.id === 'cloudflare') return fetchCloudflareProfile(tokens.access_token);

  const idClaims = oauth.getValidatedIdTokenClaims(tokens);
  let userinfo: oauth.UserInfoResponse | null = null;
  if (as.userinfo_endpoint && tokens.access_token) {
    const userinfoResponse = await oauth.userInfoRequest(as, client, tokens.access_token);
    userinfo = await oauth.processUserInfoResponse(
      as,
      client,
      idClaims?.sub ?? oauth.skipSubjectCheck,
      userinfoResponse,
    );
  }

  const sub = stringClaim(userinfo?.sub) ?? stringClaim(idClaims?.sub);
  const email = stringClaim(userinfo?.email) ?? stringClaim(idClaims?.email);
  const emailVerified = boolClaim(userinfo?.email_verified) ?? boolClaim(idClaims?.email_verified) ?? false;
  if (!sub) throw new Error(`${provider.label} did not return a stable subject.`);
  if (!email) throw new Error(`${provider.label} did not return an email address.`);

  return {
    provider: provider.id,
    providerSub: sub,
    email,
    emailVerified,
    displayName: stringClaim(userinfo?.name) ?? stringClaim(idClaims?.name) ?? null,
  };
}

class OAuthProviderTokenError extends Error {
  constructor(
    public readonly providerError: string,
    public readonly status?: number,
    public readonly providerDescription?: string,
  ) {
    super(providerDescription || providerError);
    this.name = 'OAuthProviderTokenError';
  }
}

async function processCloudflareTokenResponse(response: Response): Promise<oauth.TokenEndpointResponse> {
  const body = await readJsonObject(response, 'Cloudflare token endpoint');
  if (!response.ok) {
    const providerError = stringClaim(body.error) ?? `http_${response.status}`;
    throw new OAuthProviderTokenError(providerError, response.status, stringClaim(body.error_description) ?? undefined);
  }
  if (stringClaim(body.error)) {
    throw new OAuthProviderTokenError(
      stringClaim(body.error) ?? 'token_error',
      response.status,
      stringClaim(body.error_description) ?? undefined,
    );
  }
  return cloudflareTokenJsonToResponse(body);
}

export function cloudflareTokenJsonToResponse<Input>(input: Input): oauth.TokenEndpointResponse {
  const body = v.parse(JsonObjectSchema, input);
  const accessToken = stringClaim(body.access_token);
  if (!accessToken) throw new Error('Cloudflare token endpoint did not return an access token.');

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
}

async function fetchCloudflareProfile(accessToken: string | undefined): Promise<OAuthProfile> {
  if (!accessToken) throw new Error('Cloudflare token response did not include an access token.');
  const res = await fetch('https://api.cloudflare.com/client/v4/user', {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${accessToken}`,
    },
  });
  if (!res.ok) throw new Error(`Cloudflare user lookup failed: ${res.status}`);
  const body = v.parse(CloudflareUserEnvelopeSchema, await res.json());
  if (body.success === false) throw new Error('Cloudflare user lookup failed.');
  return cloudflareUserResultToProfile(body.result);
}

export function cloudflareUserResultToProfile<Input>(input: Input): OAuthProfile {
  const user = v.parse(CloudflareUserSchema, input);
  const id = String(user.id);
  const email = user.email.trim();
  if (!id) throw new Error('Cloudflare did not return a stable user id.');
  if (!email) throw new Error('Cloudflare did not return an email address.');

  const firstName = stringClaim(user.first_name);
  const lastName = stringClaim(user.last_name);
  const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();
  const username = stringClaim(user.username);

  return {
    provider: 'cloudflare',
    providerSub: id,
    email,
    emailVerified: true,
    displayName: fullName || username || null,
  };
}

async function fetchGitHubProfile(accessToken: string): Promise<OAuthProfile> {
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${accessToken}`,
    'user-agent': KINU_USER_AGENT,
    'x-github-api-version': '2022-11-28',
  };
  const userRes = await fetch('https://api.github.com/user', { headers });
  if (!userRes.ok) throw new Error(`GitHub user lookup failed: ${userRes.status}`);
  const user = v.parse(GitHubUserSchema, await userRes.json());

  const emailsRes = await fetch('https://api.github.com/user/emails', { headers });
  if (!emailsRes.ok) throw new Error(`GitHub email lookup failed: ${emailsRes.status}`);
  const emails = v.parse(v.array(GitHubEmailSchema), await emailsRes.json());
  const verified = emails.filter((e) => e.email && e.verified);
  const primary = verified.find((e) => e.primary) ?? verified[0];
  const email = primary?.email ?? user.email ?? null;
  const emailVerified = !!primary?.email || verified.some((e) => e.email === user.email);

  if (!user.id) throw new Error('GitHub did not return a stable user id.');
  if (!email) throw new Error('GitHub did not return a verified email address.');

  return {
    provider: 'github',
    providerSub: String(user.id),
    email,
    emailVerified,
    displayName: user.name || user.login || null,
  };
}

interface PublicIdentity {
  id: string;
  email: string;
  provider?: string;
  displayName: string | null;
}

function publicIdentity(identity: {
  userId: string; email: string; provider?: string; displayName?: string | null;
}): PublicIdentity {
  return {
    id: identity.userId,
    email: identity.email,
    provider: identity.provider,
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

/** Every cookie this app sets, and the one recipe it sets them with. `__Host-`
 *  requires `Secure` and `Path=/` and forbids a `Domain`, so the cookie is
 *  this exact origin's and no subdomain can write it. `Lax` rather than
 *  `Strict`: an OAuth callback IS a cross-site top-level navigation, and
 *  `Strict` would withhold the handoff cookie from the one request that has to
 *  present it. An `expiresAt` already past clears the cookie. */
function cookie(name: string, value: string, expiresAt: number): string {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function stringClaim<Value>(value: Value): string | null {
  return v.is(v.string(), value) && value.trim() ? value.trim() : null;
}

function boolClaim<Value>(value: Value): boolean | null {
  return v.is(v.boolean(), value) ? value : null;
}

function numberClaim<Value>(value: Value): number | null {
  if (v.is(v.number(), value) && Number.isFinite(value)) return value;
  if (v.is(v.string(), value) && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function scopeClaim<Value>(value: Value): string | null {
  if (v.is(v.string(), value)) return value.trim() || null;
  if (Array.isArray(value)) {
    const scopes = value
      .filter((item): item is string => v.is(v.string(), item) && item.trim().length > 0)
      .map((item) => item.trim());
    return scopes.length ? scopes.join(' ') : null;
  }
  return null;
}

async function readJsonObject(response: Response, label: string): Promise<JsonObject> {
  try {
    return v.parse(JsonObjectSchema, await response.json());
  } catch (error) {
    throw new Error(
      `${label} returned HTTP ${response.status} with a body that is not JSON.`,
      { cause: error },
    );
  }
}

interface OAuthFailureSummary { reason: string; log: string }

function summarizeOAuthFailure<Failure>(error: Failure): OAuthFailureSummary {
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
  return { reason: 'unknown_error', log: String(error) };
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

/** The failure pages the OAuth flow can land on. Sign-in itself renders
 *  through `loginDocument`; this is the same card with prose in it. */
function html(title: string, body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(publicHtmlHeaders())) headers.set(key, value);
  return new Response(authDocument(title, body), { ...init, headers });
}
