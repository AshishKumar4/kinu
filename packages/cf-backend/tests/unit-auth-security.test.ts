import { describe, expect, test } from 'bun:test';
import { asFetchFunction, sha256Hex, type JsonValue, type OAuthCredential } from '@kinu.run/core';
import * as v from 'valibot';
import { getOAuthProvider, listConfiguredOAuthProviders } from '../src/auth/providers';
import {
  CLOUDFLARE_WORKERS_AI_SCOPES,
  accountIdFromCloudflareCredential,
  cloudflareAIGatewayId,
  cloudflareAccountsFromCredential,
  cloudflareTokenToCredential,
  cloudflareWorkersAIBaseURL,
  isCloudflareCredentialUsable,
  withCloudflareAccount,
} from '@kinu.run/core';
import { buildCliInstallCommand } from '@kinu.run/core';
import { handleCliRequest } from '../src/cli/routes';
import { escapeHtml } from '@kinu.run/core';
import { sanitizeReturnTo } from '../src/auth/store';
import { handleAuthRequest, type AuthRoutesAuthority, type AuthRoutesEnv } from '../src/auth/routes';
import {
  bootstrappedProfile, cliAccount, staticRouteCliEnv, unreachableAssets, unreachableNamespace, userAccount,
  workerContext,
} from './helpers/bindings';
import {
  authenticateRequest, CLI_APPROVAL_CSRF_COOKIE_NAME, OAUTH_STATE_COOKIE_NAME, SESSION_COOKIE_NAME, type AuthIdentity,
} from '../src/auth/session';
import { pollCliAuth, startCliAuth } from '../src/cli/auth-store';
import type { CliRoutesEnv } from '../src/cli/routes';
import { handleUserRequest, type UserRoutesEnv } from '../src/user/routes';
import { makeKv } from './helpers/kv';
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import type { BrowserSessionIdentity } from '../src/user/user-do';
import type { UserCaller } from '@kinu.run/core';
import { requestUrl } from '@kinu.run/core';
import { present } from '@kinu.run/test-utils';

// Dynamic: the entry's graph reaches `cloudflare:email` and `cloudflare:workers` through `agents`.
const { default: worker } = await import('../src/server');

const APP = 'https://kinu.example.com';

const ORIGIN = APP;

/** Loopback: the only host where the dev identity stands for a signed-in browser. */
const LOCAL = 'http://localhost';

const CLIENT = '127.0.0.1';

const LANDING_PAGE = '<title>Kinu landing</title>';

const OWNER_IDENTITY: AuthIdentity = {
  userId: '0123456789abcdef0123456789abcdef', email: 'owner@example.com', sub: 'sub', provider: 'test', authTime: 1,
};

/** One signed-out request through the Worker's entry, with only the bindings these routes read. */
function served(url: string, headers: Record<string, string> = {}): Promise<Response> {
  const env: Partial<Env> = {};
  Object.assign(env, {
    AUTH_KV: makeKv(),
    CLI_PUBLIC_ORIGIN: APP,
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    UserDO: unreachableNamespace('UserDO'),
    ASSETS: {
      fetch: async (input: Request | URL | string) => {
        const path = new URL(input instanceof Request ? input.url : input).pathname;

        return new Response(`<!doctype html><head>${path === '/landing.html' ? LANDING_PAGE : ''}</head>`, {
          headers: { 'content-type': 'text/html' },
        });
      },
    },
  });

  // SAFETY: every member the routes under test read is constructed above: a signed-out request answers from
  // the landing page, the sign-in redirect or the ticket check before any other binding is touched.
  return worker.fetch(new Request(url, { headers }), env as Env, workerContext());
}

/** Device-code sign-in on this machine: the dev identity stands for the signed-in browser. */
function terminalSignIn() {
  const userDO = cliAccount({
    async ensureProfile(_caller: UserCaller, email: string) { return bootstrappedProfile(email); },
    async mintCliToken(_caller: UserCaller, userId: string) {
      return { token: `ptc_${userId}_terminal`, tokenHash: 'hash', expiresAt: Date.now() + 60_000 };
    },
  });

  const env: CliRoutesEnv<string> = {
    AUTH_KV: makeKv(),
    UserDO: { idFromName: (name) => name, get: () => userDO },
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    ASSETS: unreachableAssets(),
    OrchestratorAgent: unreachableNamespace('OrchestratorAgent'),
    DEV_USER_EMAIL: OWNER_IDENTITY.email,
  };

  return { env, poll: (deviceToken: string) => pollCliAuth(env, deviceToken, CLIENT) };
}

/** A served page's form fields, by name, as the browser would submit them. */
async function formFields(page: Response): Promise<Map<string, string>> {
  const fields = new Map<string, string>();

  await new HTMLRewriter().on('input[name]', {
    element(element) { fields.set(element.getAttribute('name') ?? '', element.getAttribute('value') ?? ''); },
  }).transform(page).text();

  return fields;
}

function setCookieNamed(response: Response, name: string): string | undefined {
  return response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
}

/** The session cookie a sign-in set: `name=value` to present, or the whole header to read its attributes. */
function sessionCookie(done: Response, whole = false): string {
  const header = present(setCookieNamed(done, SESSION_COOKIE_NAME), 'the session cookie');

  return whole ? header : header.split(';')[0] ?? '';
}

/** Every binding refuses: these public routes must answer before reading any. */
const PUBLIC_ROUTE_ENV = staticRouteCliEnv();

/** Asserts the accounts endpoint is what was asked. */
function oneAccountFetch() {
  return asFetchFunction(async (input) => {
    expect(requestUrl(input)).toBe('https://api.cloudflare.com/client/v4/accounts');

    return new Response(JSON.stringify({
      success: true,
      result: [{ id: 'abc123abc123abc123abc123abc123ab', name: 'User Account' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

describe('auth and desktop security invariants', () => {
  test("opening a terminal's approval link approves nothing; the page's own POST does", async () => {
    const { env, poll } = terminalSignIn();

    const started = await startCliAuth(env, {
      origin: LOCAL, approvalOrigin: LOCAL, deviceName: 'laptop', clientKey: CLIENT,
    });

    const link = new Request(`${LOCAL}/cli/auth?code=${encodeURIComponent(started.userCode)}`);
    const page = present(await handleCliRequest(link, env), 'the approval page');

    expect(page.status).toBe(200);
    expect(await poll(started.deviceToken)).toMatchObject({ status: 'pending' });

    const cookie = present(setCookieNamed(page, CLI_APPROVAL_CSRF_COOKIE_NAME), 'the approval CSRF cookie').split(';')[0];
    const form = new FormData();
    form.set('userCode', started.userCode);
    form.set('csrf', present((await formFields(page)).get('csrf'), 'the approval form\'s csrf field'));

    const approved = await handleCliRequest(new Request(`${LOCAL}/cli/auth`, {
      method: 'POST', headers: { origin: LOCAL, cookie: cookie ?? '' }, body: form,
    }), env);

    expect(approved?.status).toBe(200);
    expect(await poll(started.deviceToken))
      .toMatchObject({ status: 'approved', token: expect.stringMatching(/^ptc_/u) });
  });

  test('the ambient session cookie cannot approve a device flow over JSON', async () => {
    // The CLI module runs ahead of server.ts's CSRF gate, so a cookie-authed JSON approval was
    // reachable same-site and minted an unrestricted token. Approval is the browser form's alone.
    const response = await handleCliRequest(
      new Request('https://kinu.example.com/api/cli/auth/approve', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: '__Host-kinu_session=whatever',
          origin: 'https://preview.kinu.example.com',
        },
        body: JSON.stringify({ userCode: 'ABCD-EFGH' }),
      }),
      PUBLIC_ROUTE_ENV,
    );

    expect(response?.status).toBe(401);
  });

  test('the dashboard hands out the token-free setup commands', async () => {
    // Past the profile every signed-in request ensures, neither route asks the account anything.
    const account = userAccount({
      ensureProfile: async (_caller: UserCaller, email: string) => bootstrappedProfile(email),
    });

    const env: UserRoutesEnv<string> = {
      UserDO: { idFromName: (name) => name, get: () => account },
      OrchestratorAgent: unreachableNamespace('OrchestratorAgent'),
      CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
      CLI_PUBLIC_ORIGIN: APP,
    };

    const answer = async (request: Request) =>
      present(await handleUserRequest(request, env, OWNER_IDENTITY), request.url).json();

    const cli = v.parse(v.object({ installCommand: v.string(), setupCommand: v.string(), authCommand: v.string() }),
      await answer(new Request(`${APP}/api/user/cli`)));

    const devices = new Request(`${APP}/api/user/devices`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: "Ashish's Mac" }),
    });

    const device = v.parse(v.object({ installCommand: v.string() }), await answer(devices));

    // The builder's own output, pinned token-free below; neither route composes a command of its own.
    expect(cli.installCommand).toBe(buildCliInstallCommand({ origin: APP }));
    expect(device.installCommand)
      .toBe(buildCliInstallCommand({ origin: APP, setup: false, connect: true, label: "Ashish's Mac" }));
    expect([cli.setupCommand, cli.authCommand].filter((command) => command.includes('KINU_TOKEN'))).toEqual([]);
  });

  test('a CLI agent ticket opens only a WebSocket, and only when it verifies', async () => {
    const agent = `${APP}/agents/orchestrator-agent/jarvis?ticket=pat_${OWNER_IDENTITY.userId}_x`;

    expect((await served(agent, { accept: 'text/html' })).status).toBe(400);
    const forged = `${APP}/agents/orchestrator-agent/jarvis?ticket=not-a-ticket`;

    expect((await served(forged, { upgrade: 'websocket' })).status).toBe(401);
  });

  test('OAuth provider visibility requires both client id and secret', () => {
    expect(listConfiguredOAuthProviders({})).toEqual([]);
    expect(listConfiguredOAuthProviders({ GOOGLE_OAUTH_CLIENT_ID: 'gid' })).toEqual([]);
    expect(listConfiguredOAuthProviders({ GOOGLE_OAUTH_CLIENT_SECRET: 'gsec' })).toEqual([]);
    expect(listConfiguredOAuthProviders({
      GOOGLE_OAUTH_CLIENT_ID: 'gid',
      GOOGLE_OAUTH_CLIENT_SECRET: 'gsec',
      GITHUB_OAUTH_CLIENT_ID: 'hid',
      GITHUB_OAUTH_CLIENT_SECRET: 'hsec',
      CLOUDFLARE_OAUTH_CLIENT_ID: 'cid',
      CLOUDFLARE_OAUTH_CLIENT_SECRET: 'csec',
    }).map((p) => p.id)).toEqual(['google', 'github', 'cloudflare']);
  });

  test('Cloudflare OAuth requests user billing scopes for Workers AI', () => {
    const provider = getOAuthProvider({
      CLOUDFLARE_OAUTH_CLIENT_ID: 'cid',
      CLOUDFLARE_OAUTH_CLIENT_SECRET: 'csec',
    }, 'cloudflare');

    if (!provider) throw new Error('expected the Cloudflare provider to resolve');
    expect(provider.id).toBe('cloudflare');
    expect(provider.kind).toBe('oauth');
    expect(provider.scopes).toBe(CLOUDFLARE_WORKERS_AI_SCOPES);
    expect(provider.scopes).toContain('account-settings.read');
    expect(provider.scopes).toContain('ai.write');
    expect(provider.scopes).toContain('aig.run');
    // Without offline_access no refresh token is issued, forcing a reconnect every visit.
    expect(provider.scopes).toContain('offline_access');
    expect(provider.scopes).not.toContain('openid');
  });

  test('a Cloudflare API outage does not fail a valid sign-in', async () => {
    const { env, sessions, credentials } = cloudflareCallbackEnv();

    const done = await cloudflareSignIn(env, { access_token: 'cf-a', refresh_token: 'cf-r' }, {
      id: 'cf-user-3', email: 'person@example.com',
    }, {
      accounts: () => Response.json({ success: false, errors: [{ message: 'Service unavailable' }] }, { status: 503 }),
    });

    expect(done.status).toBe(302);
    expect(sessions.size).toBe(1);
    // The refresh token is kept, so Workers AI attaches on the next refresh rather than a second sign-in.
    expect(credentials.map((row) => row.credential.refreshToken)).toEqual(['cf-r']);
  });

  test('Cloudflare OAuth token attachment stores an account-backed Workers AI credential', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = oneAccountFetch();

    try {
      const credential = await cloudflareTokenToCredential({
        access_token: 'cf-access',
        refresh_token: 'cf-refresh',
        token_type: 'bearer',
        expires_in: 3600,
        scope: CLOUDFLARE_WORKERS_AI_SCOPES,
      });

      expect(credential.kind).toBe('oauth');
      expect(credential.accessToken).toBe('cf-access');
      expect(credential.metadata?.accountId).toBe('abc123abc123abc123abc123abc123ab');
      expect(credential.metadata?.scopes).toEqual(CLOUDFLARE_WORKERS_AI_SCOPES.split(' '));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('Cloudflare OAuth token attachment accepts access-token-only responses', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = oneAccountFetch();

    try {
      const credential = await cloudflareTokenToCredential({
        access_token: 'cf-access',
        token_type: 'bearer',
        expires_in: 3600,
        scope: CLOUDFLARE_WORKERS_AI_SCOPES,
      });

      expect(credential.kind).toBe('oauth');
      expect(credential.accessToken).toBe('cf-access');
      expect(credential.refreshToken).toBeUndefined();
      expect(credential.metadata?.accountId).toBe('abc123abc123abc123abc123abc123ab');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('a token that sees no Cloudflare account still yields a credential, just an unusable one', async () => {
    // Sign-in must not depend on Workers AI billing.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchFunction(async () => new Response(
      JSON.stringify({ success: true, result: [] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    try {
      const credential = await cloudflareTokenToCredential({
        access_token: 'cf-access',
        token_type: 'bearer',
        expires_in: 3600,
        scope: CLOUDFLARE_WORKERS_AI_SCOPES,
      });

      expect(credential.accessToken).toBe('cf-access');
      expect(credential.metadata?.accountId).toBeUndefined();
      expect(isCloudflareCredentialUsable(credential)).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('a multi-account token records every account and selects the first', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchFunction(async () => new Response(JSON.stringify({
      success: true,
      result: [
        { id: 'aaa111aaa111aaa111aaa111aaa111aa', name: 'Personal' },
        { id: 'bbb222bbb222bbb222bbb222bbb222bb', name: 'Employer' },
        { id: 'not-an-account-id', name: 'Junk' },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    try {
      const credential = await cloudflareTokenToCredential({
        access_token: 'cf-access', token_type: 'bearer', expires_in: 3600,
        scope: CLOUDFLARE_WORKERS_AI_SCOPES,
      });

      expect(cloudflareAccountsFromCredential(credential)).toEqual([
        { id: 'aaa111aaa111aaa111aaa111aaa111aa', name: 'Personal' },
        { id: 'bbb222bbb222bbb222bbb222bbb222bb', name: 'Employer' },
      ]);
      expect(accountIdFromCloudflareCredential(credential)).toBe('aaa111aaa111aaa111aaa111aaa111aa');

      // Switching rewrites only the selection.
      const switched = withCloudflareAccount(credential, 'bbb222bbb222bbb222bbb222bbb222bb');
      expect(accountIdFromCloudflareCredential(switched)).toBe('bbb222bbb222bbb222bbb222bbb222bb');
      expect(switched.metadata?.accountName).toBe('Employer');
      expect(switched.accessToken).toBe(credential.accessToken);
      // Against the literal list the stub returned, not a second call of the function under test.
      expect(cloudflareAccountsFromCredential(switched)).toEqual([
        { id: 'aaa111aaa111aaa111aaa111aaa111aa', name: 'Personal' },
        { id: 'bbb222bbb222bbb222bbb222bbb222bb', name: 'Employer' },
      ]);
      expect(cloudflareWorkersAIBaseURL('bbb222bbb222bbb222bbb222bbb222bb'))
        .toBe('https://api.cloudflare.com/client/v4/accounts/bbb222bbb222bbb222bbb222bbb222bb/ai/v1');

      expect(() => withCloudflareAccount(credential, 'ccc333ccc333ccc333ccc333ccc333cc')).toThrow(/not one this login can see/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('a single-account token needs no selection and lists just that account', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchFunction(async () => new Response(JSON.stringify({
      success: true, result: [{ id: 'abc123abc123abc123abc123abc123ab', name: 'User Account' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    try {
      const credential = await cloudflareTokenToCredential({
        access_token: 'cf-access', token_type: 'bearer', expires_in: 3600,
      });

      expect(cloudflareAccountsFromCredential(credential))
        .toEqual([{ id: 'abc123abc123abc123abc123abc123ab', name: 'User Account' }]);
      expect(isCloudflareCredentialUsable(credential)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // A throwing accounts lookup would skip setCredential and lose the refresh token.
  test('an accounts API failure still yields a storable credential', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchFunction(async () => new Response(
      JSON.stringify({ success: false, errors: [{ message: 'Service unavailable' }] }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    ));

    try {
      const credential = await cloudflareTokenToCredential({
        access_token: 'cf-access', refresh_token: 'cf-refresh', token_type: 'bearer', expires_in: 3600,
      });

      expect(credential.accessToken).toBe('cf-access');
      expect(credential.refreshToken).toBe('cf-refresh');
      expect(credential.metadata?.accountId).toBeUndefined();
      expect(cloudflareAccountsFromCredential(credential)).toEqual([]);
      expect(isCloudflareCredentialUsable(credential)).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('a credential stored before accounts were recorded reports its selected account', () => {
    expect(cloudflareAccountsFromCredential({
      kind: 'oauth', accessToken: 'cf-access',
      metadata: { accountId: 'abc123abc123abc123abc123abc123ab', accountName: 'User Account' },
    })).toEqual([{ id: 'abc123abc123abc123abc123abc123ab', name: 'User Account' }]);
  });

  test('expired access-token-only Cloudflare credentials stop advertising Workers AI', () => {
    const base = {
      kind: 'oauth' as const,
      accessToken: 'cf-access',
      metadata: { accountId: 'abc123abc123abc123abc123abc123ab' },
    };

    expect(isCloudflareCredentialUsable({ ...base, expiresAt: Date.now() + 3_600_000 })).toBe(true);
    expect(isCloudflareCredentialUsable({ ...base, expiresAt: Date.now() - 1_000 })).toBe(false);
    expect(isCloudflareCredentialUsable({ ...base, refreshToken: 'cf-refresh', expiresAt: Date.now() - 1_000 })).toBe(true);
  });

  test('Cloudflare AI Gateway defaults to the account default gateway unless configured', () => {
    expect(cloudflareAIGatewayId({})).toBe('default');
    expect(cloudflareAIGatewayId({ CLOUDFLARE_AI_GATEWAY_ID: '  custom-gateway  ' })).toBe('custom-gateway');
  });

/** The real /auth/cloudflare/callback handler, faking only the network. */
function cloudflareCallbackEnv() {
  const kv = makeKv();
  const credentials: Array<{ key: string; credential: OAuthCredential }> = [];
  const sessions = new Map<string, { expiresAt: number; identity: BrowserSessionIdentity }>();

  const userDO: AuthRoutesAuthority = {
    async ensureProfile(_caller: UserCaller, email: string) { return bootstrappedProfile(email); },
    async registerBrowserSession(
      _caller: UserCaller, tokenHash: string, expiresAt: number, identity: BrowserSessionIdentity,
    ) { sessions.set(tokenHash, { expiresAt, identity }); },
    async verifyBrowserSession(_caller: UserCaller, tokenHash: string) {
      // Expiry is the real object's rule (see `unit-auth-session-revocation.test.ts`).
      const row = sessions.get(tokenHash);

      return row ? { identity: row.identity } : null;
    },
    async revokeBrowserSession(_caller: UserCaller, tokenHash: string) { sessions.delete(tokenHash); },
    async setCredential(_caller: UserCaller, key: string, credential: OAuthCredential) {
      credentials.push({ key, credential });
    },
    async listActiveWorkspaces(_caller: UserCaller) { return []; },
  };

  const bindings: AuthRoutesEnv<string> = {
    AUTH_KV: kv,
    UserDO: { idFromName: (name) => name, get: () => userDO },
    OrchestratorAgent: {
      idFromName: (name) => name,
      get: () => ({ onCredentialsChanged: async () => ({ ok: true as const }) }),
    },
    CLOUDFLARE_OAUTH_CLIENT_ID: 'cf-client-id',
    CLOUDFLARE_OAUTH_CLIENT_SECRET: 'cf-client-secret',
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
  };

  return { env: bindings, credentials, sessions, kv, userDO };
}

interface SignInOptions {
  readonly returnTo?: string;
  readonly accounts?: () => Response;
  /** Runs after the start hands out its state, before the callback redeems it. */
  readonly between?: (state: string) => Promise<void>;
}

async function cloudflareSignIn(
  env: AuthRoutesEnv<string>, tokenJson: JsonValue, userResult: JsonValue, options: SignInOptions = {},
): Promise<Response> {
  return (await cloudflareSignInSteps(env, tokenJson, userResult, options)).done;
}

async function cloudflareSignInSteps(
  env: AuthRoutesEnv<string>, tokenJson: JsonValue, userResult: JsonValue, options: SignInOptions = {},
): Promise<{ start: Response; done: Response; callback: Request }> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = asFetchFunction(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new Request(input, init).url;

    if (url === 'https://dash.cloudflare.com/.well-known/openid-configuration') {
      return Response.json({
        issuer: 'https://dash.cloudflare.com',
        authorization_endpoint: 'https://dash.cloudflare.com/oauth2/auth',
        token_endpoint: 'https://dash.cloudflare.com/oauth2/token',
      });
    }

    if (url === 'https://dash.cloudflare.com/oauth2/token') return Response.json(tokenJson);

    if (url === 'https://api.cloudflare.com/client/v4/user') {
      return Response.json({ success: true, result: userResult });
    }

    if (url === 'https://api.cloudflare.com/client/v4/accounts') {
      return options.accounts?.() ?? Response.json({ success: true, result: [] });
    }

    throw new Error(`Unexpected fetch in test: ${url}`);
  });

  try {
    const origin = 'https://kinu.example.com';
    const startUrl = new URL(`${origin}/auth/cloudflare/start`);

    if (options.returnTo !== undefined) startUrl.searchParams.set('return_to', options.returnTo);
    const start = await handleAuthRequest(new Request(startUrl), env);

    if (!start) throw new Error('auth route did not handle the sign-in start');
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state');

    const setCookie = start.headers.getSetCookie()
      .find((value) => value.startsWith(`${OAUTH_STATE_COOKIE_NAME}=`));

    if (!state || !setCookie) throw new Error('sign-in start handed out no bound handoff');
    await options.between?.(state);
    const callbackUrl = new URL(`${origin}/auth/cloudflare/callback`);
    callbackUrl.searchParams.set('state', state);
    callbackUrl.searchParams.set('code', 'auth-code-1');
    const redeem = () => new Request(callbackUrl.toString(), { headers: { cookie: setCookie.split(';')[0] } });
    const callback = redeem();
    const done = await handleAuthRequest(redeem(), env);

    if (!done) throw new Error('auth route did not handle the callback');

    return { start, done, callback };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

  test('Cloudflare OAuth profile uses the Cloudflare API user shape', async () => {
    const named = cloudflareCallbackEnv();

    const doneAda = await cloudflareSignIn(named.env, { access_token: 'cf-a' }, {
      id: 'cf-user-2',
      email: 'person@example.com',
      first_name: 'Ada',
      last_name: 'Lovelace',
    });

    expect(doneAda.status).toBe(302);
    expect([...named.sessions.values()].map((row) => row.identity.displayName)).toEqual(['Ada Lovelace']);

    const handle = cloudflareCallbackEnv();

    const doneAsh = await cloudflareSignIn(handle.env, { access_token: 'cf-b' }, {
      id: 'cf-user-1',
      email: 'ashish@example.com',
      first_name: null,
      last_name: null,
      username: 'ashish',
    });

    expect(doneAsh.status).toBe(302);
    expect([...handle.sessions.values()].map((row) => row.identity.displayName)).toEqual(['ashish']);
  });

  test('Cloudflare OAuth token variants survive the callback into the stored credential', async () => {
    const { env, credentials } = cloudflareCallbackEnv();

    const done = await cloudflareSignIn(env, {
      access_token: 'cf-access',
      token_type: 'bearer',
      expires_in: '900',
      scope: ['user-details.read'],
    }, {
      id: 'cf-user-1',
      email: 'ashish@example.com',
      username: 'ashish',
    });

    expect(done.status).toBe(302);
    expect(credentials).toHaveLength(1);
    // Normalized: seconds of lifetime minus clock skew, one scope string.
    expect(credentials[0].credential.metadata?.scopes).toEqual(['user-details.read']);
    const lifetime = (credentials[0].credential.expiresAt ?? 0) - Date.now();
    expect(lifetime).toBeGreaterThan(800_000);
    expect(lifetime).toBeLessThanOrEqual(900_000);
  });

  test('sign-in returns the browser where it was going, and logout ends the session', async () => {
    const { env, sessions } = cloudflareCallbackEnv();

    const done = await cloudflareSignIn(env, { access_token: 'cf-a' }, { id: 'cf-user-4', email: 'p@example.com' }, {
      returnTo: '/agents/jarvis',
    });

    expect(new URL(done.headers.get('location') ?? '', ORIGIN).pathname).toBe('/agents/jarvis');

    const plain = await cloudflareSignIn(cloudflareCallbackEnv().env, { access_token: 'cf-b' }, {
      id: 'cf-user-5', email: 'x@example.com',
    });

    expect(new URL(plain.headers.get('location') ?? '', ORIGIN).pathname).toBe('/');

    const logout = new Request(`${ORIGIN}/logout`, { headers: { cookie: sessionCookie(done) } });
    const out = present(await handleAuthRequest(logout, env), 'logout');

    expect(setCookieNamed(out, SESSION_COOKIE_NAME)).toContain('Max-Age=0');
    expect(sessions.size).toBe(0);
  });


  test('the sign-in handoff and the session are host-only HttpOnly cookies', async () => {
    const { env } = cloudflareCallbackEnv();

    const { start, done } = await cloudflareSignInSteps(env, { access_token: 'cf-a' }, {
      id: 'cf-user-6', email: 'p@example.com',
    });

    for (const [response, name] of [[start, OAUTH_STATE_COOKIE_NAME], [done, SESSION_COOKIE_NAME]] as const) {
      const cookie = present(setCookieNamed(response, name), name);
      const attributes = cookie.split(';').slice(1).map((part) => part.trim().split('=')[0]?.toLowerCase());

      // `__Host-` needs Secure and Path=/ with no Domain, so a preview on a sibling host cannot set it.
      expect(name).toStartWith('__Host-');
      expect(attributes).toEqual(expect.arrayContaining(['httponly', 'secure', 'samesite', 'path']));
      expect(attributes).not.toContain('domain');
      expect(cookie).toContain('SameSite=Lax');
    }
  });

  test('the sign-in state is stored only as its hash and is burned by the callback', async () => {
    const { env, kv } = cloudflareCallbackEnv();
    let held: string[] = [];
    let raw = '';

    const user = { id: 'cf-user-7', email: 'p@example.com' };

    const { done, callback } = await cloudflareSignInSteps(env, { access_token: 'cf-a' }, user, {
      between: async (state) => {
        raw = state;
        held = kv.keys();
      },
    });

    expect(held).toContain(`oauth-state:${await sha256Hex(raw)}`);
    expect(held.filter((key) => key.includes(raw))).toEqual([]);
    expect(done.status).toBe(302);
    expect(kv.keys()).not.toContain(`oauth-state:${await sha256Hex(raw)}`);
    // A second use of the same state and cookie finds nothing to redeem.
    expect((await handleAuthRequest(callback, env))?.status).not.toBe(302);
  });


  test('nothing sign-in leaves in KV outlives the session it opened', async () => {
    const { env, kv } = cloudflareCallbackEnv();
    const done = await cloudflareSignIn(env, { access_token: 'cf-a' }, { id: 'cf-user-8', email: 'p@example.com' });
    const maxAge = Number(/Max-Age=(\d+)/u.exec(sessionCookie(done, true))?.[1]);

    expect(kv.keys().length).toBeGreaterThan(0);
    expect(kv.keys().filter((key) => (kv.ttlOf(key) ?? Infinity) > maxAge)).toEqual([]);
  });

  test("a session is live only while the user's own object says so, and an unreachable object is an outage", async () => {
    const { env, sessions, userDO } = cloudflareCallbackEnv();
    const done = await cloudflareSignIn(env, { access_token: 'cf-a' }, { id: 'cf-user-9', email: 'p@example.com' });
    const request = () => new Request(`${ORIGIN}/api/user/workspaces`, { headers: { cookie: sessionCookie(done) } });

    expect((await authenticateRequest(request(), env)).email).toBe('p@example.com');

    const unreachable: AuthRoutesEnv<string> = {
      ...env,
      UserDO: {
        idFromName: (name) => name,
        get: () => ({ ...userDO, verifyBrowserSession: async () => { throw new Error('the user object is unreachable'); } }),
      },
    };

    await expect(authenticateRequest(request(), unreachable)).rejects.toMatchObject({ status: 503 });

    // The KV record is still there; the object's answer is the one that counts.
    sessions.clear();
    await expect(authenticateRequest(request(), env)).rejects.toMatchObject({ status: 401 });
  });


  test('a Cloudflare Access assertion is not a browser session', async () => {
    const assertion = 'eyJhbGciOiJSUzI1NiJ9.eyJlbWFpbCI6Im93bmVyQGV4YW1wbGUuY29tIn0.c2ln';
    const access = { cookie: `CF_Authorization=${assertion}`, 'cf-access-jwt-assertion': assertion };

    const page = await served(`${APP}/settings`, { ...access, accept: 'text/html' });
    expect(page.status).toBe(302);
    expect(page.headers.get('location')).toStartWith(`${APP}/login?`);
    expect((await served(`${APP}/api/user/workspaces`, access)).status).toBe(401);
  });


  test('the root is the public landing page, and the app behind it asks for sign-in', async () => {
    const root = await served(`${APP}/`, { accept: 'text/html' });
    expect(root.status).toBe(200);
    expect(await root.text()).toContain(LANDING_PAGE);

    const app = await served(`${APP}/settings`, { accept: 'text/html' });
    expect(app.status).toBe(302);
    expect(app.headers.get('location')).toStartWith(`${APP}/login?`);
  });


  test('browser install page is HTML while the terminal installer stays raw shell', async () => {
    const installPage = await handleCliRequest(new Request('https://kinu.example.com/install'), PUBLIC_ROUTE_ENV);
    expect(installPage?.status).toBe(200);
    expect(installPage?.headers.get('content-type')).toContain('text/html');
    expect(installPage?.headers.get('content-security-policy')).toContain('https://static.cloudflareinsights.com');
    const html = await present(installPage, 'the /install response').text();
    expect(html).toContain('Install the Kinu.run CLI');
    expect(html).toContain('curl -fsSL');
    expect(html).toContain('https://kinu.example.com/install.sh');
    expect(html).toContain(escapeHtml(buildCliInstallCommand({ origin: 'https://kinu.example.com' })));
    expect(html).not.toContain('KINU_PARENT_ACTIVATES');
    expect(html).not.toContain('OAuth sign-in required for the dashboard.');
    expect(html).not.toContain('View the raw installer');
    expect(html).not.toContain('href="/install.sh"');

    const installScript = await handleCliRequest(new Request('https://kinu.example.com/install.sh'), PUBLIC_ROUTE_ENV);
    expect(installScript?.status).toBe(200);
    expect(installScript?.headers.get('content-type')).toContain('text/x-shellscript');
    const script = await present(installScript, 'the /install.sh response').text();
    expect(script).toContain('#!/usr/bin/env bash');
    expect(script).toContain('setup --origin "$KINU_ORIGIN" --account-only');
    expect(script).toContain("grep -F '$HOME/.kinu/bin'");

    const installScriptHead = await handleCliRequest(
      new Request('https://kinu.example.com/install.sh', { method: 'HEAD' }),
      PUBLIC_ROUTE_ENV,
    );

    expect(installScriptHead?.status).toBe(200);
    expect(installScriptHead?.headers.get('content-type')).toContain('text/x-shellscript');
    expect(await present(installScriptHead, 'the HEAD /install.sh response').text()).toBe('');
  });

  test('the CLI launcher takes the deployed build artifacts and verifies both checksums', async () => {
    const shim = await handleCliRequest(new Request('https://kinu.example.com/downloads/kinu'), PUBLIC_ROUTE_ENV);
    expect(shim?.status).toBe(200);
    const script = await present(shim, 'the /downloads/kinu response').text();
    expect(script).toContain('CLI_DIR="$CLI_ROOT/current"');
    expect(script).toContain('KINU_ORIGIN="${KINU_ORIGIN:-https://kinu.example.com}"');
    expect(script).toContain('/downloads/kinu-cli-${KINU_OS}-${KINU_ARCH}.tar.gz');
    expect(script).toContain('/downloads/kinu-runtime-cpython.tar.gz');
    expect(script).not.toContain('github.com');
    expect(script).not.toContain('Kinu-main');
    // Only the signed release verifies; no origin-chosen .sha256 is ever fetched (SECURITY-devices C1).
    expect(script).toContain('verify_release "$tmp/kinu-version.json"');
    expect(script).not.toContain('"$url.sha256"');
    expect(script.split('fetch_verified "$').length - 1).toBe(2);
    expect(script).toContain('Checksum mismatch for $url.');
    const syntaxCheck = Bun.spawnSync(['bash', '-n'], { stdin: Buffer.from(script) });
    expect(syntaxCheck.exitCode).toBe(0);

    const shimHead = await handleCliRequest(
      new Request('https://kinu.example.com/downloads/kinu', { method: 'HEAD' }),
      PUBLIC_ROUTE_ENV,
    );

    expect(shimHead?.status).toBe(200);
    expect(shimHead?.headers.get('content-type')).toContain('text/x-shellscript');
    expect(await present(shimHead, 'the HEAD /downloads/kinu response').text()).toBe('');
  });

  test('CLI setup commands are one-command defaults without embedded auth tokens', () => {
    expect(buildCliInstallCommand({ origin: 'https://kinu.example.com/' }))
      .toBe("curl -fsSL 'https://kinu.example.com/install.sh' | bash");
    expect(buildCliInstallCommand({
      origin: 'https://kinu.example.com',
      setup: false,
      connect: true,
      label: "Ashish's Mac",
    })).toBe(
      "curl -fsSL 'https://kinu.example.com/install.sh' | bash -s -- --no-setup --connect --label 'Ashish'\\''s Mac'",
    );
  });

  test('the CLI model menu answers a CLI bearer, never a browser session', async () => {
    const menu = await handleCliRequest(new Request(`${ORIGIN}/api/cli/models`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${'s'.repeat(40)}` },
    }), PUBLIC_ROUTE_ENV);

    expect(menu?.status).toBe(401);
  });


});

describe('sanitizeReturnTo (single strict implementation)', () => {
  test('accepts plain relative paths', () => {
    expect(sanitizeReturnTo('/agents/jarvis')).toBe('/agents/jarvis');
    expect(sanitizeReturnTo('/user/settings?tab=mcp')).toBe('/user/settings?tab=mcp');
  });

  test('rejects absolute, protocol-relative, and backslash escapes', () => {
    expect(sanitizeReturnTo('https://evil.example')).toBe('/');
    expect(sanitizeReturnTo('//evil.example')).toBe('/');
    expect(sanitizeReturnTo('/\\evil.example')).toBe('/');
    expect(sanitizeReturnTo('')).toBe('/');
  });

  test('rejects redirect loops back into the auth flow, on the stored state too', () => {
    expect(sanitizeReturnTo('/auth/github/start')).toBe('/');
    expect(sanitizeReturnTo('/login')).toBe('/');
    expect(sanitizeReturnTo('/logout')).toBe('/');
  });
});
