// Regression test for the primary credential path: signing in with the
// Cloudflare IdP must attach the Workers AI credential (with its refresh
// token) to the user's UserDO in the same authorization — one login grants
// both app access and AI. Drives the real /auth/cloudflare/callback handler
// against the real KV auth store, faking only the network seams.
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import { describe, expect, setSystemTime, test } from 'bun:test';
import { handleAuthRequest } from '../src/auth/routes';
import { OAUTH_STATE_COOKIE_NAME, SESSION_COOKIE_NAME } from '../src/auth/session';
import { calculatePKCECodeChallenge } from 'oauth4webapi';
import { CLOUDFLARE_WORKERS_AI_SCOPES } from '../src/lib/cloudflare-oauth';
import { asFetchFunction, DEFAULT_WORKERS_AI_MODEL_SPEC, type OAuthCredential } from '@kinu.run/core';
import { makeKv, type FakeKv } from './helpers/kv';
import type { BrowserSessionIdentity } from '../src/user/user-do';
import type { UserCaller } from '../src/user/workspace-capability';

const ORIGIN = 'https://kinu.example.com';

interface TestNamespace<Stub> {
  idFromName(name: string): string;
  get(): Stub;
}

interface CloudflareLoginTestBindings<UserStub, AgentStub> {
  AUTH_KV: FakeKv;
  UserDO: TestNamespace<UserStub>;
  OrchestratorAgent: TestNamespace<AgentStub>;
  CLOUDFLARE_OAUTH_CLIENT_ID: string;
  CLOUDFLARE_OAUTH_CLIENT_SECRET: string;
  CREDENTIAL_ENCRYPTION_KEY: string;
}

function testEnv<UserStub, AgentStub>(bindings: CloudflareLoginTestBindings<UserStub, AgentStub>): Env {
  const env: Partial<Env> = {};
  Object.assign(env, bindings);
  // SAFETY: The callback reads exactly the constructed KV namespace, namespaces,
  // OAuth client values, and credential key; every reachable binding is present above.
  return env as Env;
}

function setupEnv() {
  const kv = makeKv();
  const credentials: Array<{ key: string; credential: OAuthCredential }> = [];
  const config = new Map<string, string>();
  /** Sessions this account's authority holds, as the real UserDO holds them:
   *  the row is what says a cookie is live, and it carries the `authTime` a
   *  step-up compares against. */
  const sessions = new Map<string, { expiresAt: number; identity: BrowserSessionIdentity }>();
  const userDO = {
    async ensureProfile(_caller: UserCaller) {},
    async registerBrowserSession(
      _caller: UserCaller, tokenHash: string, expiresAt: number, identity: BrowserSessionIdentity,
    ) { sessions.set(tokenHash, { expiresAt, identity }); },
    async verifyBrowserSession(_caller: UserCaller, tokenHash: string) {
      const row = sessions.get(tokenHash);
      return row && row.expiresAt > Date.now() ? { identity: row.identity } : null;
    },
    async revokeBrowserSession(_caller: UserCaller, tokenHash: string) { sessions.delete(tokenHash); },
    async setCredential(_caller: UserCaller, key: string, credential: OAuthCredential) {
      credentials.push({ key, credential });
    },
    async getConfig(_caller: UserCaller, key: string) { return config.get(key) ?? null; },
    async setConfig(_caller: UserCaller, key: string, value: string) { config.set(key, value); },
    async listActiveWorkspaces(_caller: UserCaller) { return []; },
  };
  const env = testEnv({
    AUTH_KV: kv,
    UserDO: { idFromName: (name: string) => name, get: () => userDO },
    OrchestratorAgent: { idFromName: (name: string) => name, get: () => ({ async onCredentialsChanged() {} }) },
    CLOUDFLARE_OAUTH_CLIENT_ID: 'cf-client-id',
    CLOUDFLARE_OAUTH_CLIENT_SECRET: 'cf-client-secret',
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
  });
  return { env, kv, credentials, config, sessions };
}

function fakeCloudflareNetwork(tokens: { access_token: string; refresh_token?: string }) {
  const tokenRequests: URLSearchParams[] = [];
  const fetchFake = asFetchFunction(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new Request(input, init).url;
    if (url === 'https://dash.cloudflare.com/.well-known/openid-configuration') {
      return Response.json({
        issuer: 'https://dash.cloudflare.com',
        authorization_endpoint: 'https://dash.cloudflare.com/oauth2/auth',
        token_endpoint: 'https://dash.cloudflare.com/oauth2/token',
      });
    }
    if (url === 'https://dash.cloudflare.com/oauth2/token') {
      tokenRequests.push(new URLSearchParams(String(init?.body)));
      return Response.json({
        ...tokens,
        token_type: 'bearer',
        expires_in: 3600,
        scope: CLOUDFLARE_WORKERS_AI_SCOPES,
      });
    }
    if (url === 'https://api.cloudflare.com/client/v4/user') {
      return Response.json({
        success: true,
        result: { id: 'cf-user-1', email: 'ashish@example.com', username: 'ashish' },
      });
    }
    if (url === 'https://api.cloudflare.com/client/v4/accounts') {
      return Response.json({
        success: true,
        result: [{ id: 'abc123abc123abc123abc123abc123ab', name: 'User Account' }],
      });
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  });
  return { fetchFake, tokenRequests };
}

/** One handoff as the `/start` redirect hands it out. */
interface CloudflareHandoff {
  /** What the provider will echo back on the callback. */
  state: string;
  /** What PKCE pinned this authorization to. */
  codeChallenge: string;
  /** The `Set-Cookie` the redirect gave the browser, verbatim — the half of
   *  the handoff that never travels through the provider. */
  setCookie: string;
  /** Where the browser was sent, so a step-up can be read off the provider's
   *  own authorization request rather than inferred. */
  authorizeUrl: string;
}

async function startCloudflareLogin(env: Env, prompt?: 'login'): Promise<CloudflareHandoff> {
  const start = new URL(`${ORIGIN}/auth/cloudflare/start`);
  if (prompt) start.searchParams.set('prompt', prompt);
  const response = await handleAuthRequest(new Request(start), env);
  if (!response) throw new Error('auth route did not handle the sign-in start');
  const location = response.headers.get('location');
  if (!location) throw new Error(`sign-in start did not redirect: HTTP ${response.status}`);
  const authorize = new URL(location);
  const state = authorize.searchParams.get('state');
  const codeChallenge = authorize.searchParams.get('code_challenge');
  const setCookie = response.headers.getSetCookie()
    .find((value) => value.startsWith(`${OAUTH_STATE_COOKIE_NAME}=`));
  if (!state || !codeChallenge || !setCookie) {
    throw new Error(`sign-in start handed out no bound handoff: ${location}`);
  }
  return { state, codeChallenge, setCookie, authorizeUrl: location };
}

/** The provider's callback, as the browser carrying `setCookie` makes it —
 *  or as one carrying none does, which is what a planted callback link is. */
async function completeCloudflareLogin(
  env: Env,
  handoff: { state: string; setCookie?: string },
): Promise<Response> {
  const callback = new URL(`${ORIGIN}/auth/cloudflare/callback`);
  callback.searchParams.set('state', handoff.state);
  callback.searchParams.set('code', 'auth-code-1');
  const response = await handleAuthRequest(new Request(callback.toString(), {
    headers: handoff.setCookie === undefined ? {} : { cookie: handoff.setCookie.split(';')[0] },
  }), env);
  if (!response) throw new Error('auth route did not handle the callback');
  return response;
}

function sessionCookieIn(response: Response): string | undefined {
  return response.headers.getSetCookie().find((value) => value.startsWith('__Host-kinu_session='));
}

describe('Cloudflare IdP login attaches the Workers AI credential', () => {
  test('one login grants both the app session and a refreshable AI credential', async () => {
    const { env, credentials, config } = setupEnv();
    const { fetchFake, tokenRequests } = fakeCloudflareNetwork({
      access_token: 'cf-access-1',
      refresh_token: 'cf-refresh-1',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchFake;
    try {
      const handoff = await startCloudflareLogin(env);
      const response = await completeCloudflareLogin(env, handoff);
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe(`${ORIGIN}/`);
      expect(sessionCookieIn(response)).toContain('__Host-kinu_session=');

      // The token exchange carried the authorization code and the verifier the
      // challenge in the authorization request was derived from — PKCE end to
      // end, over a verifier that never left this Worker.
      expect(tokenRequests).toHaveLength(1);
      expect(tokenRequests[0].get('grant_type')).toBe('authorization_code');
      expect(tokenRequests[0].get('code')).toBe('auth-code-1');
      const verifier = tokenRequests[0].get('code_verifier') ?? '';
      expect(await calculatePKCECodeChallenge(verifier)).toBe(handoff.codeChallenge);

      // The same authorization attached the Workers AI credential.
      expect(credentials).toHaveLength(1);
      expect(credentials[0].key).toBe('cloudflare.oauth');
      expect(credentials[0].credential.kind).toBe('oauth');
      expect(credentials[0].credential.accessToken).toBe('cf-access-1');
      expect(credentials[0].credential.refreshToken).toBe('cf-refresh-1');
      const expiresAt = credentials[0].credential.expiresAt;
      if (expiresAt === undefined) throw new Error('Cloudflare credential did not include an expiry');
      expect(expiresAt).toBeGreaterThan(Date.now());
      expect(credentials[0].credential.metadata?.accountId).toBe('abc123abc123abc123abc123abc123ab');
      expect(config.get('default_model')).toBe(DEFAULT_WORKERS_AI_MODEL_SPEC);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('re-login re-attaches a fresh credential over the stored one', async () => {
    const { env, credentials } = setupEnv();
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = fakeCloudflareNetwork({ access_token: 'cf-access-1', refresh_token: 'cf-refresh-1' }).fetchFake;
      await completeCloudflareLogin(env, await startCloudflareLogin(env));
      globalThis.fetch = fakeCloudflareNetwork({ access_token: 'cf-access-2', refresh_token: 'cf-refresh-2' }).fetchFake;
      await completeCloudflareLogin(env, await startCloudflareLogin(env));
      expect(credentials.map((c) => c.credential.accessToken)).toEqual(['cf-access-1', 'cf-access-2']);
      expect(credentials[1].credential.refreshToken).toBe('cf-refresh-2');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Login CSRF: an attacker who finishes a sign-in in their own browser holds a
 * callback URL that used to be bearer authority. Handed to a victim — a link,
 * an image, a redirect — it signed the victim's browser in as the attacker,
 * who then read whatever the victim did in a session they own.
 *
 * The callback is only half the handoff now. The other half never travels
 * through the provider, so it is only ever in the browser that started the
 * sign-in.
 */
describe('a sign-in cannot be planted in another browser', () => {
  test('a callback link carrying no handoff cookie signs nobody in', async () => {
    const { env, credentials } = setupEnv();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fakeCloudflareNetwork({ access_token: 'cf-access-1' }).fetchFake;
    try {
      const attacker = await startCloudflareLogin(env);
      const planted = await completeCloudflareLogin(env, { state: attacker.state });

      expect(planted.status).toBe(400);
      expect(sessionCookieIn(planted)).toBeUndefined();
      expect(credentials).toEqual([]);

      // The refusal spent the state on the way in, so the attacker cannot
      // finish the sign-in they primed either.
      expect((await completeCloudflareLogin(env, attacker)).status).toBe(400);
      expect(credentials).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('a browser holding its own sign-in cannot spend somebody else\'s', async () => {
    const { env } = setupEnv();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fakeCloudflareNetwork({ access_token: 'cf-access-1' }).fetchFake;
    try {
      const attacker = await startCloudflareLogin(env);
      const victim = await startCloudflareLogin(env);

      const planted = await completeCloudflareLogin(env, {
        state: attacker.state, setCookie: victim.setCookie,
      });
      expect(planted.status).toBe(400);
      expect(sessionCookieIn(planted)).toBeUndefined();

      // Scoped to the handoff it belongs to: the victim's own sign-in, which
      // the same cookie IS bound to, still completes.
      const own = await completeCloudflareLogin(env, victim);
      expect(own.status).toBe(302);
      expect(sessionCookieIn(own)).toContain('__Host-kinu_session=');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('the handoff cookie is host-scoped, script-invisible, and burned by the callback', async () => {
    const { env } = setupEnv();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fakeCloudflareNetwork({ access_token: 'cf-access-1' }).fetchFake;
    try {
      const handoff = await startCloudflareLogin(env);
      expect(handoff.setCookie).toContain('HttpOnly');
      expect(handoff.setCookie).toContain('Secure');
      // `Lax`, because the provider's callback IS a cross-site top-level
      // navigation and `Strict` would withhold the cookie from it.
      expect(handoff.setCookie).toContain('SameSite=Lax');
      expect(handoff.setCookie).toContain('Path=/');
      // `__Host-` forbids a Domain, which is what keeps a subdomain from
      // writing the binding a callback would then be accepted with.
      expect(handoff.setCookie).not.toContain('Domain=');

      const done = await completeCloudflareLogin(env, handoff);
      expect(done.status).toBe(302);
      expect(done.headers.getSetCookie()).toContain(
        `${OAUTH_STATE_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── The step-up recovery URL ────────────────────────────────────────────────
//
// A mutation that needs FRESH authentication refuses a stale session with a 401
// and points the operator at `/login?prompt=login`. That page used to see an
// active session and redirect straight back to where the 401 came from: the
// operator bounced between the two forever, with no way to re-authenticate
// short of clearing cookies by hand.
describe('a stale session sent to re-authenticate', () => {
  function loginRequest(token: string, prompt: 'login' | null): Request {
    const url = new URL(`${ORIGIN}/login`);
    if (prompt) url.searchParams.set('prompt', prompt);
    return new Request(url, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}` },
    });
  }

  function sessionTokenFrom(response: Response): string {
    const cookie = sessionCookieIn(response) ?? '';
    return decodeURIComponent(/__Host-kinu_session=([^;]+)/.exec(cookie)?.[1] ?? '');
  }

  test('prompt=login mints a FRESH authTime instead of redirecting into the 401 that sent it', async () => {
    const { env, sessions } = setupEnv();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fakeCloudflareNetwork({ access_token: 'cf-access-1' }).fetchFake;
    try {
      const signedIn = await completeCloudflareLogin(env, await startCloudflareLogin(env));
      const token = sessionTokenFrom(signedIn);
      const firstAuthTime = [...sessions.values()][0]?.identity.authTime ?? 0;
      expect(firstAuthTime).toBeGreaterThan(0);

      // The counterexample, preserved: plain /login with a live session is a
      // redirect, because a signed-in visitor has nothing to do there.
      const plain = await handleAuthRequest(loginRequest(token, null), env);
      expect(plain?.status).toBe(302);
      expect(plain?.headers.get('location')).toBe(`${ORIGIN}/`);

      // The step-up URL is answered with the provider list, and the links it
      // renders carry the parameter forward so the provider is asked to
      // re-authenticate rather than replay its own session.
      const stepUp = await handleAuthRequest(loginRequest(token, 'login'), env);
      expect(stepUp?.status).toBe(200);
      expect(await stepUp?.text() ?? '').toContain('prompt=login');

      // Time moves, so a fresh sign-in is distinguishable from the stale one.
      setSystemTime(new Date(Date.now() + 10 * 60_000));
      const handoff = await startCloudflareLogin(env, 'login');
      // The provider's own reauth parameter, on the authorization request.
      expect(handoff.authorizeUrl).toContain('prompt=login');

      const restepped = await completeCloudflareLogin(env, handoff);
      expect(restepped.status).toBe(302);
      const freshToken = sessionTokenFrom(restepped);
      expect(freshToken).not.toBe(token);

      // A NEW session row, with a new authTime — which is the whole point: the
      // mutation that refused the stale one now has a sign-in to compare
      // against that is genuinely newer than its window.
      const authTimes = [...sessions.values()].map((row) => row.identity.authTime ?? 0);
      expect(Math.max(...authTimes)).toBeGreaterThan(firstAuthTime);
      expect(sessions.size).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
      setSystemTime();
    }
  });
});
