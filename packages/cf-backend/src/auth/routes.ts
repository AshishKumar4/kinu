import * as oauth from 'oauth4webapi';
import { AuthError, SESSION_COOKIE_NAME, authenticateRequest, readSessionToken } from './session.js';
import {
  cleanupExpiredAuthRows, clearD1BookmarkCookie, consumeOAuthState, createOAuthState,
  createSession, d1BookmarkCookie, revokeSession, sanitizeReturnTo, withD1Bookmark,
  type OAuthProfile,
} from './d1-store.js';
import { escapeHtml, json } from '../lib/http.js';
import {
  clientAuth, getAuthorizationServer, getOAuthProvider, listConfiguredOAuthProviders,
  type OAuthProviderConfig, type OAuthProviderId,
} from './providers.js';
import {
  CLOUDFLARE_OAUTH_CRED_KEY,
  cloudflareTokenToCredential,
} from '../lib/cloudflare-oauth.js';
import { DEFAULT_WORKERS_AI_MODEL_SPEC } from '../providers/workers-ai-catalog.js';
import { notifyAgentsCredentialsChanged } from '../user/agent-access.js';

export async function handleAuthRequest(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response | null> {
  const url = new URL(request.url);
  const method = request.method;

  if (url.pathname === '/api/auth/providers' && method === 'GET') {
    return json({ providers: listConfiguredOAuthProviders(env) });
  }

  if (url.pathname === '/api/auth/me' && method === 'GET') {
    try {
      const identity = await authenticateRequest(request, env);
      return withD1Bookmark(json({ user: publicIdentity(identity) }), identity.d1Bookmark);
    } catch (e) {
      if (e instanceof AuthError && e.status === 401) return json({ user: null }, { status: 401 });
      throw e;
    }
  }

  if (url.pathname === '/login' && method === 'GET') {
    return renderLogin(request, env);
  }

  if (url.pathname === '/logout' && (method === 'GET' || method === 'POST')) {
    return logout(request, env, ctx);
  }

  const startMatch = url.pathname.match(/^\/auth\/([^/]+)\/start$/);
  if (startMatch && method === 'GET') {
    return startOAuth(request, env, ctx, decodeURIComponent(startMatch[1]));
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
    return redirect(new URL(returnTo, url.origin).toString());
  } catch (e) {
    if (!(e instanceof AuthError) || e.status !== 401) throw e;
  }

  const providers = listConfiguredOAuthProviders(env);
  const buttons = providers.map((provider) => {
    const start = new URL(`/auth/${provider.id}/start`, url.origin);
    start.searchParams.set('return_to', returnTo);
    if (prompt) start.searchParams.set('prompt', prompt);
    return `<a class="provider" href="${escapeHtml(start.pathname + start.search)}">Continue with ${escapeHtml(provider.label)}</a>`;
  }).join('');

  const body = providers.length
    ? buttons
    : `<p>No OAuth providers are configured yet.</p>`;

  return html('Sign in to Proteus', `
    <p class="lede">Choose a configured sign-in method.</p>
    <div class="providers">${body}</div>
  `, { headers: { 'cache-control': 'no-store' } });
}

async function startOAuth(request: Request, env: Env, ctx: ExecutionContext | undefined, providerId: string): Promise<Response> {
  const provider = getOAuthProvider(env, providerId);
  if (!provider) return html('Sign in unavailable', '<p>This sign-in provider is not configured.</p>', { status: 404 });
  if (!env.AUTH_DB) return html('Sign in unavailable', '<p>Browser auth database is not configured.</p>', { status: 503 });

  const url = new URL(request.url);
  const returnTo = sanitizeReturnTo(url.searchParams.get('return_to') ?? '/');
  const redirectUri = new URL(`/auth/${provider.id}/callback`, url.origin).toString();
  const as = await getAuthorizationServer(provider);
  if (!as.authorization_endpoint) throw new Error(`${provider.label} OAuth metadata has no authorization endpoint.`);

  const codeVerifier = oauth.generateRandomCodeVerifier();
  const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier);
  const nonce = provider.kind === 'oidc' ? oauth.generateRandomNonce() : null;
  const { state } = await createOAuthState(env.AUTH_DB, {
    provider: provider.id,
    codeVerifier,
    nonce,
    returnTo,
    redirectUri,
  });
  ctx?.waitUntil(cleanupExpiredAuthRows(env.AUTH_DB));

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

  return redirect(authorizationUrl.toString(), {
    headers: { 'cache-control': 'no-store' },
  });
}

async function finishOAuth(request: Request, env: Env, ctx: ExecutionContext | undefined, providerId: string): Promise<Response> {
  const provider = getOAuthProvider(env, providerId);
  if (!provider) return html('Sign in unavailable', '<p>This sign-in provider is not configured.</p>', { status: 404 });
  if (!env.AUTH_DB) return html('Sign in unavailable', '<p>Browser auth database is not configured.</p>', { status: 503 });

  const url = new URL(request.url);
  const state = url.searchParams.get('state');
  if (!state) return html('Sign in failed', '<p>OAuth callback is missing state.</p>', { status: 400 });

  let stage = 'state';
  try {
    const savedState = await consumeOAuthState(env.AUTH_DB, state, provider.id);
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
    let cloudflareCredential: Awaited<ReturnType<typeof cloudflareTokenToCredential>> | null = null;
    if (provider.id === 'cloudflare') {
      stage = 'cloudflare_credential';
      cloudflareCredential = await cloudflareTokenToCredential(tokens);
    }
    stage = 'session';
    const session = await createSession(env, profile);
    if (cloudflareCredential) {
      stage = 'cloudflare_credential';
      const userDO = env.UserDO.get(env.UserDO.idFromName(session.identity.userId));
      await userDO.setCredential(CLOUDFLARE_OAUTH_CRED_KEY, cloudflareCredential);
      if (!await userDO.getConfig('default_model')) {
        await userDO.setConfig('default_model', DEFAULT_WORKERS_AI_MODEL_SPEC);
      }
      notifyAgentsCredentialsChanged(env, userDO, ctx);
    }
    ctx?.waitUntil(cleanupExpiredAuthRows(env.AUTH_DB));
    const destination = new URL(savedState.returnTo, url.origin).toString();
    const headers = new Headers({ 'cache-control': 'no-store' });
    headers.append('set-cookie', sessionCookie(session.token, session.expiresAt));
    const bookmarkCookie = d1BookmarkCookie(session.bookmark);
    if (bookmarkCookie) headers.append('set-cookie', bookmarkCookie);
    return redirect(destination, {
      headers,
    });
  } catch (e) {
    const failure = summarizeOAuthFailure(e);
    console.warn(`[auth] OAuth callback failed at ${stage}: ${failure.log}`);
    return html('Sign in failed', `
      <p class="lede">The sign-in request could not be completed. Return to sign in and try again.</p>
      <p class="muted">Failure stage: <code>${escapeHtml(stage)}</code></p>
      <p class="muted">Reason: <code>${escapeHtml(failure.reason)}</code></p>
      <div class="actions"><a class="provider" href="/login?prompt=login">Return to sign in</a></div>
    `, { status: 400 });
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

async function logout(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const token = readSessionToken(request);
  if (token && env.AUTH_DB) {
    await revokeSession(env.AUTH_DB, token);
    ctx?.waitUntil(cleanupExpiredAuthRows(env.AUTH_DB));
  }
  const url = new URL(request.url);
  const returnTo = sanitizeReturnTo(url.searchParams.get('return_to') ?? '/');
  const headers = new Headers({ 'cache-control': 'no-store' });
  headers.append('set-cookie', clearSessionCookie());
  headers.append('set-cookie', clearD1BookmarkCookie());
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
    avatarUrl: stringClaim(userinfo?.picture) ?? stringClaim(idClaims?.picture) ?? null,
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

export function cloudflareTokenJsonToResponse(input: unknown): oauth.TokenEndpointResponse {
  if (!input || typeof input !== 'object') {
    throw new Error('Cloudflare token endpoint returned an invalid JSON body.');
  }

  const body = input as Record<string, unknown>;
  const accessToken = stringClaim(body.access_token);
  if (!accessToken) throw new Error('Cloudflare token endpoint did not return an access token.');

  const out: Record<string, oauth.JsonValue | undefined> = {
    access_token: accessToken,
    token_type: (stringClaim(body.token_type) ?? 'bearer').toLowerCase(),
  };

  const expiresIn = numberClaim(body.expires_in);
  if (expiresIn !== null) out.expires_in = expiresIn;

  const refreshToken = stringClaim(body.refresh_token);
  if (refreshToken) out.refresh_token = refreshToken;

  const scope = scopeClaim(body.scope);
  if (scope) out.scope = scope;

  for (const [key, value] of Object.entries(body)) {
    if (key in out) continue;
    if (isJsonValue(value)) out[key] = value;
  }

  return out as unknown as oauth.TokenEndpointResponse;
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
  const body = await res.json() as { success?: boolean; result?: unknown };
  if (body.success === false) throw new Error('Cloudflare user lookup failed.');
  return cloudflareUserResultToProfile(body.result);
}

export function cloudflareUserResultToProfile(input: unknown): OAuthProfile {
  if (!input || typeof input !== 'object') {
    throw new Error('Cloudflare user lookup returned an invalid profile.');
  }
  const user = input as Record<string, unknown>;
  const id = stringClaim(user.id);
  const email = stringClaim(user.email);
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
    avatarUrl: null,
  };
}

async function fetchGitHubProfile(accessToken: string): Promise<OAuthProfile> {
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${accessToken}`,
    'user-agent': 'Proteus',
    'x-github-api-version': '2022-11-28',
  };
  const userRes = await fetch('https://api.github.com/user', { headers });
  if (!userRes.ok) throw new Error(`GitHub user lookup failed: ${userRes.status}`);
  const user = await userRes.json() as {
    id?: number | string; login?: string; name?: string | null; email?: string | null; avatar_url?: string | null;
  };

  const emailsRes = await fetch('https://api.github.com/user/emails', { headers });
  if (!emailsRes.ok) throw new Error(`GitHub email lookup failed: ${emailsRes.status}`);
  const emails = await emailsRes.json() as Array<{ email?: string; primary?: boolean; verified?: boolean }>;
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
    avatarUrl: user.avatar_url ?? null,
  };
}

function publicIdentity(identity: {
  userId: string; email: string; provider?: string; displayName?: string | null;
}): Record<string, string | null | undefined> {
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

function sessionCookie(token: string, expiresAt: number): string {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function clearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function stringClaim(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function boolClaim(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function numberClaim(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function scopeClaim(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (Array.isArray(value)) {
    const scopes = value
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim());
    return scopes.length ? scopes.join(' ') : null;
  }
  return null;
}

async function readJsonObject(response: Response, label: string): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new Error(`${label} did not return JSON.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} returned an invalid JSON body.`);
  }
  return parsed as Record<string, unknown>;
}

function summarizeOAuthFailure(error: unknown): { reason: string; log: string } {
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

function isJsonValue(value: unknown): value is oauth.JsonValue {
  if (value === null) return true;
  if (['string', 'number', 'boolean'].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).every(isJsonValue);
  return false;
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

function html(title: string, body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'text/html; charset=utf-8');
  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #09090b;
      --ink: #fafafa;
      --muted: #a1a1aa;
      --line: rgba(255, 255, 255, 0.08);
      --accent: #a78bfa;
      --accent-soft: rgba(139, 92, 246, 0.12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--ink);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    a { color: inherit; text-decoration: none; }
    .shell {
      width: min(760px, calc(100vw - 28px));
      min-height: 100vh;
      margin: 0 auto;
      border-inline: 1px solid var(--line);
      display: grid;
      grid-template-rows: auto 1fr;
      background: rgba(9, 9, 11, 0.84);
    }
    header {
      min-height: 64px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 24px;
      border-bottom: 1px solid var(--line);
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      font-weight: 720;
    }
    .mark {
      width: 24px;
      height: 24px;
      display: grid;
      place-items: center;
      border: 1px solid rgba(167, 139, 250, 0.55);
      color: var(--accent);
      font-weight: 780;
    }
    main {
      width: min(460px, 100%);
      align-self: center;
      justify-self: center;
      padding: 56px 24px;
    }
    h1 {
      font-size: 44px;
      line-height: 0.96;
      margin: 0;
      font-weight: 780;
      letter-spacing: 0;
    }
    .lede, p {
      color: var(--muted);
      line-height: 1.55;
      margin: 16px 0 0;
      font-size: 15px;
    }
    .providers, .actions {
      display: grid;
      gap: 10px;
      margin-top: 24px;
    }
    .provider {
      min-height: 42px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 1px solid rgba(167, 139, 250, 0.62);
      padding: 0 14px;
      color: var(--ink);
      background: var(--accent-soft);
      font-weight: 660;
    }
    .provider:hover { background: rgba(139, 92, 246, 0.18); }
    @media (max-width: 720px) {
      .shell { width: 100%; border-inline: 0; }
      header { padding: 0 16px; }
      main { padding: 44px 16px; }
      h1 { font-size: 34px; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header><a class="brand" href="/"><span class="mark">P</span><span>Proteus</span></a></header>
    <main><h1>${escapeHtml(title)}</h1>${body}</main>
  </div>
</body>
</html>`, {
    ...init,
    headers,
  });
}

