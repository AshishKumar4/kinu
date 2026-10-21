// Defends: signing in with the Cloudflare IdP must attach the Workers AI credential (with refresh
// token) to the UserDO in the same authorization. Real callback and KV store; only network seams faked.
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import { describe, expect, setSystemTime, test } from 'bun:test';
import { authPageRoutes, type AuthRoutesAuthority, type AuthRoutesEnv } from '../src/auth/routes';
import { bootstrappedProfile, workerContext } from './helpers/bindings';
import { serveFamily } from './helpers/api';
import { OAUTH_HANDOFFS_HELD, oauthStateCookieName, SESSION_COOKIE_NAME } from '../src/auth/cookies';
import { calculatePKCECodeChallenge } from 'oauth4webapi';
import { cloudflareConnectPath, CLOUDFLARE_WORKERS_AI_SCOPES, connectedPath, connectEndedOf, sha256Hex } from '@kinu.run/core';
import { asFetchFunction, type OAuthCredential } from '@kinu.run/core';
import { makeKv } from './helpers/kv';
import type { BrowserSessionIdentity } from '../src/user/sessions';
import type { UserCaller } from '@kinu.run/core';


const authPages = serveFamily(authPageRoutes, { ctx: workerContext() });

const ORIGIN = 'https://kinu.example.com';

function setupEnv() {
  const kv = makeKv();
  const credentials: Array<{ key: string; credential: OAuthCredential }> = [];
  /** Each account a UserDO was asked for, by the name it is addressed under, and the emails given a profile. */
  const profiled: string[] = [];
  const accounts = { credentialsOf: new Map<string, string[]>(), profiled };
  /** Sessions as the real UserDO holds them: the row says a cookie is live and carries the step-up `authTime`. */
  const sessions = new Map<string, { expiresAt: number; identity: BrowserSessionIdentity }>();

  const userDO: AuthRoutesAuthority = {
    // OAuth is configured, so the built-in sign-in this would answer for is never asked.
    async builtinHasOwner() { return true; },
    async builtinInvitedEmail() { return null; },
    async builtinResetAccount() { return null; },
    async ensureProfile(_caller: UserCaller, email: string) {
      accounts.profiled.push(email);

      return bootstrappedProfile(email);
    },
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
    async listActiveWorkspaces(_caller: UserCaller) { return []; },
  };

  const env: AuthRoutesEnv<string> = {
    AUTH_KV: kv,
    UserDO: {
      idFromName: (name) => name,
      // The account a credential lands on, by the object it was written through.
      get: (name) => ({
        ...userDO,
        async setCredential(caller: UserCaller, key: string, credential: OAuthCredential) {
          accounts.credentialsOf.set(name, [...accounts.credentialsOf.get(name) ?? [], credential.accessToken]);
          await userDO.setCredential(caller, key, credential);
        },
      }),
    },
    OrchestratorAgent: {
      idFromName: (name) => name,
      get: () => ({ onModelSettingsChanged: async () => ({ ok: true as const }) }),
    },
    CLOUDFLARE_OAUTH_CLIENT_ID: 'cf-client-id',
    CLOUDFLARE_OAUTH_CLIENT_SECRET: 'cf-client-secret',
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
  };

  return { env, kv, credentials, sessions, accounts };
}

function fakeCloudflareNetwork(tokens: { access_token: string; refresh_token?: string }, email = 'ashish@example.com') {
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
      tokenRequests.push(new URLSearchParams(await new Request(input, init).text()));

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
        result: { id: `cf-${email}`, email, username: email.split('@')[0] },
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

interface CloudflareHandoff {
  state: string;
  codeChallenge: string;
  /** The redirect's `Set-Cookie`, verbatim: the half of the handoff that never travels through the provider. */
  setCookie: string;
  /** So a step-up is read off the provider's own authorization request rather than inferred. */
  authorizeUrl: string;
}

/** The run a connect's starting page names, which its finish page names back. */
const CONNECT_RUN = '5f0c3a8e-2b1d-4c7e-9a64-1d2e3f405162';

async function startCloudflareLogin(
  env: AuthRoutesEnv<string>, prompt?: 'login', connect?: { readonly session: string },
): Promise<CloudflareHandoff> {
  // A connect starts at the address the page's Connect Cloudflare button opens, so dropping its intent is a red test.
  const start = new URL(connect === undefined ? '/auth/cloudflare/start' : cloudflareConnectPath(CONNECT_RUN), ORIGIN);

  if (prompt) start.searchParams.set('prompt', prompt);

  const response = await authPages(new Request(start, connect === undefined ? {} : { headers: { cookie: connect.session } }), env);

  if (!response) throw new Error('auth route did not handle the sign-in start');
  const location = response.headers.get('location');

  if (!location) throw new Error(`sign-in start did not redirect: HTTP ${response.status}`);
  const authorize = new URL(location);
  const state = authorize.searchParams.get('state');
  const codeChallenge = authorize.searchParams.get('code_challenge');

  const handoffName = oauthStateCookieName(await sha256Hex(state ?? ''));
  const setCookie = response.headers.getSetCookie().find((value) => value.startsWith(`${handoffName}=`));

  if (!state || !codeChallenge || !setCookie) {
    throw new Error(`sign-in start handed out no bound handoff: ${location}`);
  }

  return { state, codeChallenge, setCookie, authorizeUrl: location };
}

/** The provider callback; without `setCookie` it is a planted callback link. `session` is the browser's own. */
async function completeCloudflareLogin(
  env: AuthRoutesEnv<string>,
  handoff: { state: string; setCookie?: string },
  session?: string,
): Promise<Response> {
  const callback = new URL(`${ORIGIN}/auth/cloudflare/callback`);
  callback.searchParams.set('state', handoff.state);
  callback.searchParams.set('code', 'auth-code-1');
  const cookies = [...handoff.setCookie === undefined ? [] : [handoff.setCookie.split(';')[0]], ...session === undefined ? [] : [session]];

  const response = await authPages(new Request(callback.toString(), {
    headers: cookies.length === 0 ? {} : { cookie: cookies.join('; ') },
  }), env);

  if (!response) throw new Error('auth route did not handle the callback');

  return response;
}

function sessionCookieIn(response: Response): string | undefined {
  return response.headers.getSetCookie().find((value) => value.startsWith('__Host-kinu_session='));
}

describe('Cloudflare IdP login attaches the Workers AI credential', () => {
  test('one login grants both the app session and a refreshable AI credential', async () => {
    const { env, credentials } = setupEnv();

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

      // PKCE end to end, over a verifier that never left this Worker.
      expect(tokenRequests).toHaveLength(1);
      expect(tokenRequests[0].get('grant_type')).toBe('authorization_code');
      expect(tokenRequests[0].get('code')).toBe('auth-code-1');
      const verifier = tokenRequests[0].get('code_verifier') ?? '';
      expect(await calculatePKCECodeChallenge(verifier)).toBe(handoff.codeChallenge);

      expect(credentials).toHaveLength(1);
      expect(credentials[0].key).toBe('cloudflare.oauth');
      expect(credentials[0].credential.kind).toBe('oauth');
      expect(credentials[0].credential.accessToken).toBe('cf-access-1');
      expect(credentials[0].credential.refreshToken).toBe('cf-refresh-1');
      const expiresAt = credentials[0].credential.expiresAt;

      if (expiresAt === undefined) throw new Error('Cloudflare credential did not include an expiry');
      expect(expiresAt).toBeGreaterThan(Date.now());
      expect(credentials[0].credential.metadata?.accountId).toBe('abc123abc123abc123abc123abc123ab');
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

// The owner's report (2026-10-20): "Connect Cloudflare" ran the sign-in, so connecting a Cloudflare login under another
// email switched the person into another Kinu account instead of attaching the credential to theirs.
describe('connecting Cloudflare attaches to the account that asked, and signs nobody in', () => {
  test('signed in as A, connecting a login whose email is B: A stays signed in, holds the credential, and B is no account', async () => {
    const { env, accounts } = setupEnv();
    const originalFetch = globalThis.fetch;

    try {
      globalThis.fetch = fakeCloudflareNetwork({ access_token: 'cf-a', refresh_token: 'cf-a-refresh' }, 'a@example.com').fetchFake;
      const signedIn = await completeCloudflareLogin(env, await startCloudflareLogin(env));
      const session = (sessionCookieIn(signedIn) ?? '').split(';')[0] ?? '';
      const accountA = [...accounts.credentialsOf.keys()][0];

      globalThis.fetch = fakeCloudflareNetwork({ access_token: 'cf-b', refresh_token: 'cf-b-refresh' }, 'b@example.com').fetchFake;
      const handoff = await startCloudflareLogin(env, 'login', { session });
      const connected = await completeCloudflareLogin(env, handoff, session);

      expect({
        location: connected.headers.get('location'),
        session: sessionCookieIn(connected) ?? null,
        credentials: Object.fromEntries(accounts.credentialsOf),
        profiled: accounts.profiled,
      }).toEqual({
        location: `${ORIGIN}${connectedPath({ run: CONNECT_RUN, service: 'Cloudflare', error: null })}`,
        session: null,
        credentials: { [accountA ?? '']: ['cf-a', 'cf-b'] },
        profiled: ['a@example.com'],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('a connect needs a signed-in account to start, and the same one at its end', async () => {
    const { env, accounts } = setupEnv();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fakeCloudflareNetwork({ access_token: 'cf-a', refresh_token: 'cf-a-refresh' }, 'a@example.com').fetchFake;

    try {
      const signedIn = await completeCloudflareLogin(env, await startCloudflareLogin(env));
      const session = (sessionCookieIn(signedIn) ?? '').split(';')[0] ?? '';
      const unsigned = await authPages(new Request(`${ORIGIN}${cloudflareConnectPath(CONNECT_RUN)}`), env);
      // Its session gone by the callback: the grant is attached to nobody, and the finish page says why.
      const ended = await completeCloudflareLogin(env, await startCloudflareLogin(env, 'login', { session }));

      // Refused at its start, it still ends on the finish page for its run (second review, 2026-10-23: a 401 page in the
      // helper tab left the starting page waiting).
      const refusedAt = new URL(unsigned?.headers.get('location') ?? '', ORIGIN);

      expect({
        unsigned: { status: unsigned?.status, page: refusedAt.pathname, ended: connectEndedOf(refusedAt.searchParams) },
        ended: new URL(ended.headers.get('location') ?? '').searchParams.get('error'), credentials: [...accounts.credentialsOf.values()].flat(),
      }).toEqual({
        unsigned: { status: 302, page: '/connected', ended: { run: CONNECT_RUN, service: 'Cloudflare', error: expect.stringContaining('sign in') } },
        ended: 'The Kinu account that started connecting is no longer signed in here.', credentials: ['cf-a'],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Review finding (2026-10-23): a finish page took any broadcast of its kind, so a stale tab or a forged callback link
  // could end another tab's connect. A start names its page's run, and one without a run is no connect.
  test('a connect start that names no run is refused before Cloudflare is asked', async () => {
    const { env } = setupEnv();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fakeCloudflareNetwork({ access_token: 'cf-a', refresh_token: 'cf-a-refresh' }, 'a@example.com').fetchFake;

    try {
      const signedIn = await completeCloudflareLogin(env, await startCloudflareLogin(env));
      const session = (sessionCookieIn(signedIn) ?? '').split(';')[0] ?? '';
      const started = async (run: string) => authPages(new Request(`${ORIGIN}/auth/cloudflare/start?intent=connect${run}`, { headers: { cookie: session } }), env);

      expect({ none: (await started(''))?.status, malformed: (await started('&run=tab-1'))?.status, named: (await started(`&run=${CONNECT_RUN}`))?.status })
        .toEqual({ none: 400, malformed: 400, named: 302 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// Second review (2026-10-23): the handoff cookie held one binding, so a second sign-in or connect begun in the same
// browser, in any tab, replaced the first one's, whose callback was then refused as not this browser's.
describe('two starts in one browser each finish', () => {
  // Sol's review (2026-10-23): a cookie holding four bindings evicted the first start's at the fifth, so its callback
  // was refused as another browser's. Each handoff has its own cookie now.
  test('five starts in one browser each finish, every callback with only its own cookie', async () => {
    const { env } = setupEnv();
    const originalFetch = globalThis.fetch;

    try {
      globalThis.fetch = fakeCloudflareNetwork({ access_token: 'cf-a', refresh_token: 'cf-a-refresh' }, 'a@example.com').fetchFake;
      const starts = [];

      for (let n = 0; n < 5; n += 1) starts.push(await startCloudflareLogin(env));

      const names = new Set(starts.map((start) => start.setCookie.split('=')[0]));
      const done = [];

      for (const start of starts) done.push(await completeCloudflareLogin(env, start));

      expect({ cookies: names.size, signedIn: done.map((answer) => sessionCookieIn(answer) !== undefined) })
        .toEqual({ cookies: 5, signedIn: [true, true, true, true, true] });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Sol-round review (2026-10-23): a cookie per handoff, unbounded, could fill the browser's cookie budget and evict
  // the session. A start past the budget is refused, and sets no cookie.
  test('a start past the handoff budget is refused and sets no cookie; a connect still ends on its finish page', async () => {
    const { env } = setupEnv();
    const held = Array.from({ length: OAUTH_HANDOFFS_HELD }, (_, n) => `${oauthStateCookieName(n.toString(16).padStart(16, '0'))}=b${String(n)}`).join('; ');
    const signIn = await authPages(new Request(`${ORIGIN}/auth/cloudflare/start`, { headers: { cookie: held } }), env);
    const connect = await authPages(new Request(`${ORIGIN}${cloudflareConnectPath(CONNECT_RUN)}`, { headers: { cookie: held } }), env);
    const connectAt = new URL(connect?.headers.get('location') ?? '', ORIGIN);

    expect({
      signIn: { status: signIn?.status, cookies: signIn?.headers.getSetCookie().length },
      connect: { status: connect?.status, page: connectAt.pathname, run: connectAt.searchParams.get('run'), cookies: connect?.headers.getSetCookie().length },
    }).toEqual({
      signIn: { status: 429, cookies: 0 },
      connect: { status: 302, page: '/connected', run: CONNECT_RUN, cookies: 0 },
    });
  });


  // Third review (2026-10-23): a callback whose handoff could not be read, in a connect's helper tab, offered "Return to
  // sign in" with a forced prompt, and signing in there switched the browser into another account.
  test('a callback no handoff can be read for offers a signed-in browser no sign-in, and a signed-out one its sign-in', async () => {
    const { env } = setupEnv();
    const originalFetch = globalThis.fetch;

    try {
      globalThis.fetch = fakeCloudflareNetwork({ access_token: 'cf-a', refresh_token: 'cf-a-refresh' }, 'a@example.com').fetchFake;
      const signedIn = await completeCloudflareLogin(env, await startCloudflareLogin(env));
      const session = (sessionCookieIn(signedIn) ?? '').split(';')[0] ?? '';

      const offered = async (cookie?: string) => {
        const lost = await authPages(new Request(`${ORIGIN}/auth/cloudflare/callback?state=spent-or-lost&code=c`, cookie === undefined ? {} : { headers: { cookie } }), env);
        const page = await lost?.text() ?? '';

        return { status: lost?.status, signIn: page.includes('/login'), action: /Return to (?:sign in|Kinu)/u.exec(page)?.[0] ?? null };
      };

      // A session no account object can vouch for right now still holds the browser: it is offered no sign-in either.
      expect({ signedIn: await offered(session), unverifiable: await offered(`${SESSION_COOKIE_NAME}=ps_${'0'.repeat(32)}_${'x'.repeat(64)}`), signedOut: await offered() }).toEqual({
        signedIn: { status: 400, signIn: false, action: 'Return to Kinu' },
        unverifiable: { status: 400, signIn: false, action: 'Return to Kinu' },
        signedOut: { status: 400, signIn: true, action: 'Return to sign in' },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('a connect whose callback comes after its state expired still ends on the finish page for its run', async () => {
    const { env } = setupEnv();
    const originalFetch = globalThis.fetch;

    try {
      globalThis.fetch = fakeCloudflareNetwork({ access_token: 'cf-a', refresh_token: 'cf-a-refresh' }, 'a@example.com').fetchFake;
      const signedIn = await completeCloudflareLogin(env, await startCloudflareLogin(env));
      const session = (sessionCookieIn(signedIn) ?? '').split(';')[0] ?? '';
      const handoff = await startCloudflareLogin(env, 'login', { session });

      setSystemTime(new Date(Date.now() + 11 * 60_000));
      const late = new URL((await completeCloudflareLogin(env, handoff, session)).headers.get('location') ?? '', ORIGIN);

      expect({ page: late.pathname, ended: connectEndedOf(late.searchParams) })
        .toEqual({ page: '/connected', ended: { run: CONNECT_RUN, service: 'Cloudflare', error: expect.stringMatching(/expired/) } });
    } finally {
      setSystemTime();
      globalThis.fetch = originalFetch;
    }
  });
});

/** Login CSRF: a callback URL as bearer authority would sign a victim in as the attacker, so the
 *  callback is only half the handoff; the other half lives only in the browser that started the sign-in. */
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

      // The refusal spent the state, so the attacker cannot finish the sign-in they primed either.
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
      // `Lax`: the provider callback is a cross-site top-level navigation, which `Strict` would withhold the cookie from.
      expect(handoff.setCookie).toContain('SameSite=Lax');
      expect(handoff.setCookie).toContain('Path=/');
      // `__Host-` forbids a Domain, so a subdomain cannot write the binding.
      expect(handoff.setCookie).not.toContain('Domain=');

      const done = await completeCloudflareLogin(env, handoff);
      expect(done.status).toBe(302);
      // Its own cookie is cleared, by the name the start set.
      expect(done.headers.getSetCookie()).toContain(`${handoff.setCookie.split('=')[0] ?? ''}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// Step-up recovery: `/login?prompt=login` must mint a fresh authTime rather than redirect an active
// session straight back to the 401, which loops forever.
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

      // The counterexample: plain /login with a live session redirects.
      const plain = await authPages(loginRequest(token, null), env);
      expect(plain?.status).toBe(302);
      expect(plain?.headers.get('location')).toBe(`${ORIGIN}/`);

      // The rendered links carry the parameter so the provider re-authenticates rather than replaying its session.
      const stepUp = await authPages(loginRequest(token, 'login'), env);
      expect(stepUp?.status).toBe(200);
      expect(await stepUp?.text() ?? '').toContain('prompt=login');

      setSystemTime(new Date(Date.now() + 10 * 60_000));
      const handoff = await startCloudflareLogin(env, 'login');
      expect(handoff.authorizeUrl).toContain('prompt=login');

      const restepped = await completeCloudflareLogin(env, handoff);
      expect(restepped.status).toBe(302);
      const freshToken = sessionTokenFrom(restepped);
      expect(freshToken).not.toBe(token);

      // A new session row whose authTime is genuinely newer than the refusing mutation's window.
      const authTimes = [...sessions.values()].map((row) => row.identity.authTime ?? 0);
      expect(Math.max(...authTimes)).toBeGreaterThan(firstAuthTime);
      expect(sessions.size).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
      setSystemTime();
    }
  });
});
