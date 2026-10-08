// Sign in with ChatGPT for an account with no machine (paste-back), from the routes to auth.openai.com, and through a
// machine that connects only after the web started (developers.openai.com/siwc/token-sharing-open-source/sign-in).
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as v from 'valibot';
import { accountCredentialKey, asFetchFunction, CHATGPT_CRED_KEY, CHATGPT_PASTE_REDIRECT, DEVICE_CHATGPT, type JsonValue, type UserCaller } from '@kinu.run/core';
import { serveFamily } from './helpers/api';
import { createTestUserDO, provisionTestWorkspace, testOwner, TEST_CREDENTIAL_ENCRYPTION_KEY, type TestUserDO } from './helpers/user-do';
import { bootstrappedProfile, userAccount, workspaceObject } from './helpers/bindings';
import { userRoutes, type UserRoutesEnv } from '../src/user/routes';
import type { AuthIdentity } from '../src/auth/session';

const IDENTITY: AuthIdentity = { userId: '0123456789abcdef0123456789abcdef', email: 'owner@example.com', sub: 'sub', provider: 'test', authTime: Date.now() };

const TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token';

const JWKS_URL = 'https://auth.openai.com/.well-known/jwks.json';

const PLAN_SCOPES = 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke';

const ISSUED = 'oaiapp_issued';

const realFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = realFetch; });

const signer = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'],
);

const KID = 'kinu-test-key';

const PUBLIC_JWK = { ...await crypto.subtle.exportKey('jwk', signer.publicKey), kid: KID, alg: 'RS256', use: 'sig' };

const segment = (value: JsonValue) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** An ID token auth.openai.com would sign for `claims`. */
async function idToken(claims: Record<string, JsonValue>): Promise<string> {
  const signed = `${segment({ alg: 'RS256', kid: KID, typ: 'JWT' })}.${segment(claims)}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signer.privateKey, new TextEncoder().encode(signed));

  return `${signed}.${Buffer.from(signature).toString('base64url')}`;
}

/** auth.openai.com: its signing keys, and a token endpoint answering each form with `answer`; the forms it saw. */
function openaiAuth(answer: (form: URLSearchParams) => Promise<Response> | Response): URLSearchParams[] {
  const forms: URLSearchParams[] = [];

  globalThis.fetch = asFetchFunction(async (input, init) => {
    const request = new Request(input, init);

    if (request.url === JWKS_URL) return Response.json({ keys: [PUBLIC_JWK] });
    expect(request.url).toBe(TOKEN_URL);
    const form = new URLSearchParams(await request.text());
    forms.push(form);

    return answer(form);
  });

  return forms;
}

/** The token answer for a sign-in whose authorize address was `authorize`. */
async function tokens(authorize: URL, overrides: { scope?: string; nonce?: string; expiresIn?: number; access?: string; refresh?: string } = {}): Promise<Response> {
  return Response.json({
    access_token: overrides.access ?? 'at-1',
    refresh_token: overrides.refresh ?? 'rt-1',
    id_token: await idToken({
      iss: 'https://auth.openai.com', aud: [ISSUED], exp: Math.floor(Date.now() / 1000) + 3600, sub: 'user-sub', email: 'owner@example.com',
      nonce: overrides.nonce ?? authorize.searchParams.get('nonce') ?? '',
    }),
    token_type: 'Bearer',
    expires_in: overrides.expiresIn ?? 3600,
    scope: overrides.scope ?? PLAN_SCOPES,
  });
}

const FinishedSchema = v.object({ outcome: v.string(), email: v.nullable(v.string()) });

function routes(harness: TestUserDO) {
  const pending: Promise<unknown>[] = [];

  const stub = userAccount({
    async ensureProfile(_caller: UserCaller, email: string) { return bootstrappedProfile(email); },
    async userMcp_warmConnections() { return { servers: 0 }; },
    async listActiveWorkspaces() { return []; },
    startChatGptPasteSignIn: (caller: UserCaller, account?: string) => harness.userDO.startChatGptPasteSignIn(caller, account),
    finishChatGptPasteSignIn: (caller: UserCaller, url: string) => harness.userDO.finishChatGptPasteSignIn(caller, url),
  });

  const env: UserRoutesEnv<string> = {
    UserDO: { idFromName: (name) => name, get: () => stub },
    OrchestratorAgent: { idFromName: (name) => name, get: () => workspaceObject({}) },
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
  };

  const call = async (path: string, body?: { url: string } | { account: string }) => {
    const response = await serveFamily(userRoutes, { identity: IDENTITY, ctx: { waitUntil(promise: Promise<unknown>) { pending.push(promise); } } })(
      new Request(`https://kinu.example.com/api/user${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
      }),
      env,
    );

    if (!response) throw new Error(`no route answered ${path}`);
    await Promise.all(pending);

    return response;
  };

  const start = async (account?: string) => new URL(v.parse(v.object({ authorizeUrl: v.string(), redirectUri: v.string() }), await (await call('/chatgpt/paste/start', account === undefined ? undefined : { account })).json()).authorizeUrl);

  /** Where the browser ends after `authorize`, with the code and the issued client. */
  const returned = (authorize: URL, extra: Record<string, string> = {}) => `${CHATGPT_PASTE_REDIRECT}?${new URLSearchParams({
    code: 'code-1', scope: PLAN_SCOPES, state: authorize.searchParams.get('state') ?? '', client_id: ISSUED, ...extra,
  }).toString()}`;

  const finish = async (url: string) => call('/chatgpt/paste/finish', { url });

  return { call, start, returned, finish };
}

const storedKeys = async (harness: TestUserDO) => (await harness.userDO.listCredentials(await testOwner())).map((c) => c.key);

describe('ChatGPT sign-in by paste-back', () => {
  test('the pasted address signs the account in: the code is exchanged with PKCE, and the account\'s calls carry its own login', async () => {
    const harness = createTestUserDO();
    const web = routes(harness);
    const authorize = await web.start();

    expect(`${authorize.origin}${authorize.pathname}`).toBe('https://auth.openai.com/api/accounts/authorize');
    expect(authorize.searchParams.get('client_id')).toBe('dynamic_agent_client');
    expect(authorize.searchParams.get('agent_name_hint')).toBe('Kinu');
    expect(authorize.searchParams.get('redirect_uri')).toBe(CHATGPT_PASTE_REDIRECT);
    expect(authorize.searchParams.get('resource')).toBe('https://api.openai.com/v1');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('scope')?.split(' ')).toContain('chatgpt.tokens.use.direct');
    const host = authorize.searchParams.get('ext_agent_host_id');
    expect(host).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // One host for the deployment: every sign-in names the same one.
    expect((await web.start()).searchParams.get('ext_agent_host_id')).toBe(host);
    const latest = await web.start();

    const forms = openaiAuth(() => tokens(latest));
    const finished = await web.finish(web.returned(latest));

    expect(v.parse(FinishedSchema, await finished.json())).toEqual({ outcome: 'signed_in', email: 'owner@example.com' });
    expect(forms.map((form) => Object.fromEntries(form))).toEqual([{
      grant_type: 'authorization_code', client_id: ISSUED, code: 'code-1', code_verifier: expect.any(String),
      redirect_uri: CHATGPT_PASTE_REDIRECT, resource: 'https://api.openai.com/v1',
    }]);
    expect(createHash('sha256').update(forms[0]?.get('code_verifier') ?? '').digest('base64url')).toBe(latest.searchParams.get('code_challenge') ?? '');
    // A workspace's model calls read it as they read any model login.
    const workspace = { workspaceToken: await provisionTestWorkspace(harness, 'jarvis') };
    expect(await harness.userDO.getAuthHeaders(workspace, CHATGPT_CRED_KEY)).toEqual({ Authorization: 'Bearer at-1' });
    expect((await harness.userDO.chatgptPlan(await testOwner())).account).toEqual({ email: 'owner@example.com' });
    harness.close();
  });

  test('a sign-in named for an account seals that account\'s login and leaves the main one as it was', async () => {
    const harness = createTestUserDO();
    const web = routes(harness);
    const named = accountCredentialKey(CHATGPT_CRED_KEY, 'reviewer');
    const authorize = await web.start('reviewer');

    openaiAuth(() => tokens(authorize, { access: 'at-reviewer' }));
    expect(v.parse(FinishedSchema, await (await web.finish(web.returned(authorize))).json()).outcome).toBe('signed_in');
    expect(await storedKeys(harness)).toEqual([named]);
    const workspace = { workspaceToken: await provisionTestWorkspace(harness, 'jarvis') };
    expect(await harness.userDO.getAuthHeaders(workspace, named)).toEqual({ Authorization: 'Bearer at-reviewer' });
    harness.close();
  });

  test('a name that is not an account\'s is refused, and no sign-in is held for it', async () => {
    const harness = createTestUserDO();
    const web = routes(harness);

    expect((await web.call('/chatgpt/paste/start', { account: 'Not An Account' })).status).toBe(400);
    expect((await web.finish(`${CHATGPT_PASTE_REDIRECT}?code=code-1&state=any`)).status).toBe(404);
    harness.close();
  });

  test('an address from another sign-in is refused, nothing is exchanged, and this sign-in stays open', async () => {
    const harness = createTestUserDO();
    const web = routes(harness);
    const authorize = await web.start();
    const forms = openaiAuth(() => tokens(authorize));

    expect((await web.finish(web.returned(authorize, { state: 'another-sign-in' }))).status).toBe(400);
    expect(forms).toEqual([]);
    expect(await storedKeys(harness)).not.toContain(CHATGPT_CRED_KEY);
    expect(v.parse(FinishedSchema, await (await web.finish(web.returned(authorize))).json()).outcome).toBe('signed_in');
    harness.close();
  });

  test('a sign-in the owner replaced while OpenAI answered it changes nothing, whatever it answered', async () => {
    const harness = createTestUserDO();
    const web = routes(harness);
    const first = await web.start();
    let second: URL | null = null;

    openaiAuth(async () => {
      if (second !== null) return tokens(second);
      // The owner starts again while auth.openai.com is still answering the first sign-in's code.
      second = await web.start();

      return tokens(first, { scope: 'email openid profile' });
    });

    expect((await web.finish(web.returned(first))).status).toBe(503);

    if (second === null) throw new Error('the first exchange never reached auth.openai.com');
    expect(v.parse(FinishedSchema, await (await web.finish(web.returned(second))).json())).toEqual({ outcome: 'signed_in', email: 'owner@example.com' });
    harness.close();
  });

  test('an ID token minted for another sign-in\'s nonce stores nothing', async () => {
    const harness = createTestUserDO();
    const web = routes(harness);
    const authorize = await web.start();
    openaiAuth(() => tokens(authorize, { nonce: 'not-this-sign-in' }));

    const refused = await web.finish(web.returned(authorize));

    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain('nonce');
    expect(await storedKeys(harness)).not.toContain(CHATGPT_CRED_KEY);
    harness.close();
  });

  test('a sign-in that withholds plan usage stores no tokens, and the next asks consent of the issued client', async () => {
    const harness = createTestUserDO();
    const web = routes(harness);
    const authorize = await web.start();
    openaiAuth(() => tokens(authorize, { scope: 'email openid profile' }));

    expect(v.parse(FinishedSchema, await (await web.finish(web.returned(authorize))).json())).toEqual({ outcome: 'plan_declined', email: 'owner@example.com' });
    expect(await storedKeys(harness)).not.toContain(CHATGPT_CRED_KEY);
    const again = await web.start();

    expect(again.searchParams.get('client_id')).toBe(ISSUED);
    expect(again.searchParams.get('agent_name_hint')).toBeNull();
    expect(again.searchParams.get('prompt')).toBe('consent');
    expect(again.searchParams.get('login_hint')).toBe('owner@example.com');
    harness.close();
  });

  test('the account renews its login with the issued client and sends the rotated refresh token next time', async () => {
    const harness = createTestUserDO();
    const web = routes(harness);
    const owner = await testOwner();
    const authorize = await web.start();
    let rotation = 0;

    const forms = openaiAuth(async (form) => {
      if (form.get('grant_type') === 'authorization_code') return tokens(authorize, { expiresIn: 60 });
      rotation += 1;

      return Response.json({ access_token: `at-${String(rotation + 1)}`, refresh_token: `rt-${String(rotation + 1)}`, expires_in: 3600, token_type: 'Bearer' });
    });

    await web.finish(web.returned(authorize));
    // Inside the refresh lead: the first call renews before it sends.
    expect(await harness.userDO.getAuthHeaders(owner, CHATGPT_CRED_KEY)).toEqual({ Authorization: 'Bearer at-2' });
    // A refused login renews with the token the last rotation returned.
    expect(await harness.userDO.getAuthHeaders(owner, CHATGPT_CRED_KEY, { rejected: { Authorization: 'Bearer at-2' } })).toEqual({ Authorization: 'Bearer at-3' });
    expect(forms.slice(1).map((form) => Object.fromEntries(form))).toEqual([
      { grant_type: 'refresh_token', client_id: ISSUED, refresh_token: 'rt-1', resource: 'https://api.openai.com/v1' },
      { grant_type: 'refresh_token', client_id: ISSUED, refresh_token: 'rt-2', resource: 'https://api.openai.com/v1' },
    ]);
    harness.close();
  });
});

describe('ChatGPT sign-in through a machine', () => {
  test('started with no machine connected, it waits, and opens on the next machine to connect', async () => {
    const authorizeUrl = 'https://auth.openai.com/api/accounts/authorize?client_id=dynamic_agent_client';

    const harness = createTestUserDO({
      deviceResponder: (frame): JsonValue => (frame.method === DEVICE_CHATGPT.signIn
        ? { authorizeUrl }
        : { signedIn: false, email: null, planEnabled: false, planDeclined: false, pending: false, lastFailure: null, firstSignIn: true }),
    });

    const owner = await testOwner();

    expect(await harness.userDO.startChatGptSignIn(owner)).toEqual({ state: 'waiting_for_machine' });
    expect((await harness.userDO.chatgptPlan(owner)).machineSignIn).toEqual({ state: 'waiting_for_machine' });

    const { deviceId } = await harness.userDO.registerDevice(owner, 'studio');
    harness.attachDevice(deviceId);
    await harness.sendDeviceHello({ type: 'HELLO' });
    await harness.joinFibers();

    expect(harness.deviceFrames.filter((frame) => frame.method === DEVICE_CHATGPT.signIn)).toHaveLength(1);
    expect((await harness.userDO.chatgptPlan(owner)).machineSignIn).toEqual({ state: 'open', authorizeUrl, device: { id: deviceId, label: 'studio' } });
    harness.close();
  });

  test('two machines connecting while it waits open it once, on one of them', async () => {
    const owner = await testOwner();
    const studioAnswers = Promise.withResolvers<void>();
    let studio = '';

    const harness = createTestUserDO({
      deviceResponder: async (frame): Promise<JsonValue> => {
        if (frame.method !== DEVICE_CHATGPT.signIn) return NOT_SIGNED_IN;

        // The studio's daemon answers only once the laptop has finished saying HELLO.
        if (frame.device === studio) await studioAnswers.promise;

        return { authorizeUrl: `https://auth.openai.com/api/accounts/authorize?on=${frame.device ?? ''}` };
      },
    });

    await harness.userDO.startChatGptSignIn(owner);
    studio = (await harness.userDO.registerDevice(owner, 'studio')).deviceId;
    const laptop = (await harness.userDO.registerDevice(owner, 'laptop')).deviceId;
    harness.attachDaemon(studio);
    harness.attachDaemon(laptop);

    const studioHello = harness.sendDeviceHello({ type: 'HELLO' }, studio);
    await harness.sendDeviceHello({ type: 'HELLO' }, laptop);
    studioAnswers.resolve();
    await studioHello;
    await harness.joinFibers();

    const opened = harness.deviceFrames.filter((frame) => frame.method === DEVICE_CHATGPT.signIn);
    expect(opened).toHaveLength(1);
    expect((await harness.userDO.chatgptPlan(owner)).machineSignIn).toMatchObject({ state: 'open', device: { id: opened[0]?.device } });
    harness.close();
  });

  test('a sign-in the owner cancels while the machine opens it stays cancelled', async () => {
    const owner = await testOwner();

    const harness: TestUserDO = createTestUserDO({
      deviceResponder: async (frame): Promise<JsonValue> => {
        if (frame.method !== DEVICE_CHATGPT.signIn) return NOT_SIGNED_IN;
        // The owner cancels while the machine is still answering.
        await harness.userDO.cancelChatGptSignIn(owner);

        return { authorizeUrl: 'https://auth.openai.com/api/accounts/authorize?client_id=dynamic_agent_client' };
      },
    });

    await harness.userDO.startChatGptSignIn(owner);
    const { deviceId } = await harness.userDO.registerDevice(owner, 'studio');
    harness.attachDevice(deviceId);
    await harness.sendDeviceHello({ type: 'HELLO' });
    await harness.joinFibers();

    expect(harness.deviceFrames.filter((frame) => frame.method === DEVICE_CHATGPT.signIn)).toHaveLength(1);

    expect((await harness.userDO.chatgptPlan(owner)).machineSignIn).toBeNull();
    harness.close();
  });

  test('signing out signs out every machine that holds the plan, and none carries it after', async () => {
    const owner = await testOwner();
    const signedOut = new Set<string>();

    const harness = createTestUserDO({
      deviceResponder: (frame): JsonValue => {
        const device = frame.device ?? '';

        if (frame.method === DEVICE_CHATGPT.signOut) {
          signedOut.add(device);

          return { unconfirmed: device === laptop ? 'auth.openai.com answered HTTP 500' : null };
        }

        return signedOut.has(device) ? NOT_SIGNED_IN : { ...NOT_SIGNED_IN, signedIn: true, email: 'owner@example.com', planEnabled: true };
      },
    });

    const studio = (await harness.userDO.registerDevice(owner, 'studio')).deviceId;
    const laptop = (await harness.userDO.registerDevice(owner, 'laptop')).deviceId;
    harness.attachDaemon(studio);
    harness.attachDaemon(laptop);
    await harness.sendDeviceHello({ type: 'HELLO' }, studio);
    await harness.sendDeviceHello({ type: 'HELLO' }, laptop);

    expect(await harness.userDO.signOutChatGpt(owner)).toEqual({ unconfirmed: 'laptop: auth.openai.com answered HTTP 500' });
    expect([...signedOut].sort()).toEqual([studio, laptop].sort());
    expect(await harness.userDO.relayDevice(owner, 'chatgpt')).toBeNull();
    harness.close();
  });
});

const NOT_SIGNED_IN = { signedIn: false, email: null, planEnabled: false, planDeclined: false, pending: false, lastFailure: null, firstSignIn: false };
