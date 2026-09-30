/**
 * Sign in with ChatGPT on this machine (src/chatgpt.js), the one implementation the CLI and the daemon share.
 *
 * auth.openai.com is faked at the module's network seam (`fetch`): the token endpoint, the published signing
 * keys and the revocation endpoint answer as the SIWC guide documents them (2026-09-30), and each ID token
 * is signed with a key this suite publishes. The browser leg is real: each test drives the loopback listener
 * over HTTP, as the browser's redirect does.
 */
'use strict';

const { describe, expect, test } = require('bun:test');

const fs = require('node:fs');

const path = require('node:path');

const { scratchDir } = require('../../test-utils/src/scratch');

const chatgpt = require('../src/chatgpt.js');

const TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token';

const JWKS_URL = 'https://auth.openai.com/.well-known/jwks.json';

const REVOKE_URL = 'https://auth.openai.com/api/accounts/oauth/revoke';

const FULL_SCOPE = 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke';

let keyCount = 0;

/** A signing key auth.openai.com publishes, and ID tokens signed with it. */
async function signer() {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'],
  );

  keyCount += 1;
  const kid = `test-key-${keyCount}-${Date.now()}`;
  const jwk = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid, use: 'sig', alg: 'RS256' };
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

  return {
    jwks: { keys: [jwk] },
    async idToken(claims) {
      const signed = `${part({ alg: 'RS256', kid, typ: 'JWT' })}.${part(claims)}`;
      const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(signed));

      return `${signed}.${Buffer.from(signature).toString('base64url')}`;
    },
  };
}

/**
 * auth.openai.com at the fetch seam. `answer` builds the token endpoint's reply from the submitted form;
 * every request is recorded with its form fields.
 */
function authServer(keys, answer) {
  const calls = [];

  const fetch = async (input, init) => {
    const url = String(input);
    const form = Object.fromEntries(new URLSearchParams(init?.body === undefined ? '' : String(init.body)));
    calls.push({ url, form });

    if (url === JWKS_URL) return Response.json(keys.jwks);

    if (url === TOKEN_URL) return answer(form);

    if (url === REVOKE_URL) return new Response(null, { status: 200 });

    return new Response('not faked', { status: 599 });
  };

  return { fetch, calls, tokenCalls: () => calls.filter((call) => call.url === TOKEN_URL) };
}

/** The token endpoint's answer to a code exchange, its ID token answering the attempt's nonce. */
function exchangeAnswer(keys, { scope = FULL_SCOPE, subject = 'user-sub', audience, nonce } = {}) {
  return async (form) => Response.json({
    access_token: 'at-1',
    refresh_token: 'rt-1',
    id_token: await keys.idToken({
      iss: 'https://auth.openai.com', aud: audience ?? form.client_id, sub: subject, email: 'owner@example.com',
      nonce: nonce ?? pendingNonce, exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000),
    }),
    token_type: 'Bearer',
    expires_in: 3600,
    ...(scope !== null && { scope }),
  });
}

/** The nonce of the attempt a test is completing, read off its authorize URL. */
let pendingNonce = '';

function started(flow) {
  const authorize = new URL(flow.authorizeUrl);
  pendingNonce = authorize.searchParams.get('nonce') ?? '';

  return authorize;
}

/** @param {unknown} error */
function rejection(error) {
  return error;
}

/** What a promise was rejected with, or null when it resolved. */
function failureOf(pending) {
  return pending.then(() => null, rejection);
}

/** The browser coming back: the redirect OpenAI sends, with the given query. */
async function returnToLoopback(flow, query) {
  const url = new URL(flow.redirectUri);

  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);

  return fetch(url);
}

describe('first sign-in on a machine', () => {
  test('registers Kinu with dynamic_agent_client, exchanges with the issued client, and saves that client', async () => {
    const keys = await signer();
    const auth = authServer(keys, exchangeAnswer(keys));
    const home = scratchDir('siwc-first');
    const flow = await chatgpt.beginSignIn({ home, fetch: auth.fetch });
    const authorize = started(flow);

    expect(`${authorize.origin}${authorize.pathname}`).toBe('https://auth.openai.com/api/accounts/authorize');
    expect(flow.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    expect(Object.fromEntries(authorize.searchParams)).toEqual({
      client_id: 'dynamic_agent_client',
      agent_name_hint: 'Kinu',
      ext_agent_host_id: fs.readFileSync(path.join(home, 'chatgpt-host-id'), 'utf8').trim(),
      response_type: 'code',
      redirect_uri: flow.redirectUri,
      scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
      resource: 'https://api.openai.com/v1',
      state: expect.any(String),
      nonce: expect.any(String),
      code_challenge_method: 'S256',
      code_challenge: expect.any(String),
    });

    const page = await returnToLoopback(flow, { code: 'code-1', state: authorize.searchParams.get('state'), client_id: 'oaiapp_issued', scope: FULL_SCOPE });
    const result = await flow.done;

    expect(page.status).toBe(200);
    expect(result).toMatchObject({ outcome: 'signed-in', registered: true, record: { clientId: 'oaiapp_issued', subject: 'user-sub', email: 'owner@example.com', accessToken: 'at-1', refreshToken: 'rt-1' } });
    const [exchange] = auth.tokenCalls();
    const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(exchange.form.code_verifier))).toString('base64url');

    // The issued client (never dynamic_agent_client), the verifier behind the challenge, the same redirect and resource.
    expect(exchange.form).toEqual({
      grant_type: 'authorization_code', client_id: 'oaiapp_issued', code: 'code-1', code_verifier: exchange.form.code_verifier,
      redirect_uri: flow.redirectUri, resource: 'https://api.openai.com/v1',
    });
    expect(challenge).toBe(authorize.searchParams.get('code_challenge'));
    expect(result.record.scopes).toEqual(FULL_SCOPE.split(' '));
  });

  test('a registration that comes back without an issued client is incomplete, and nothing is exchanged', async () => {
    const keys = await signer();
    const auth = authServer(keys, exchangeAnswer(keys));
    const flow = await chatgpt.beginSignIn({ home: scratchDir('siwc-no-client'), fetch: auth.fetch });
    const authorize = started(flow);
    const refused = failureOf(flow.done);
    const says = 'no issued client ID';

    await returnToLoopback(flow, { code: 'code-1', state: authorize.searchParams.get('state') });
    expect((await refused)?.message).toContain(says);
    expect(auth.tokenCalls()).toEqual([]);
  });

  test('the host id is made once and every later sign-in on the machine sends it', async () => {
    const home = scratchDir('siwc-host');
    const first = chatgpt.hostId(home);

    expect(first).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(chatgpt.hostId(home)).toBe(first);
    expect(fs.statSync(path.join(home, 'chatgpt-host-id')).mode & 0o777).toBe(0o600);
  });
});

describe('a returning sign-in', () => {
  const registration = { clientId: 'oaiapp_saved', subject: 'user-sub', email: 'owner@example.com' };

  test('reuses the saved client with the saved email as a hint, and sends no agent name', async () => {
    const keys = await signer();
    const auth = authServer(keys, exchangeAnswer(keys));
    const flow = await chatgpt.beginSignIn({ home: scratchDir('siwc-return'), registration, fetch: auth.fetch });
    const authorize = started(flow);

    expect(authorize.searchParams.get('client_id')).toBe('oaiapp_saved');
    expect(authorize.searchParams.get('login_hint')).toBe('owner@example.com');
    expect(authorize.searchParams.has('agent_name_hint')).toBe(false);
    expect(authorize.searchParams.has('id_token_hint')).toBe(false);
    expect(authorize.searchParams.has('prompt')).toBe(false);

    await returnToLoopback(flow, { code: 'code-2', state: authorize.searchParams.get('state') });

    expect(await flow.done).toMatchObject({ outcome: 'signed-in', registered: false, record: { clientId: 'oaiapp_saved' } });
    expect(auth.tokenCalls()[0]?.form.client_id).toBe('oaiapp_saved');
  });

  test('a callback naming another client is refused rather than replacing the registration', async () => {
    const keys = await signer();
    const auth = authServer(keys, exchangeAnswer(keys));
    const flow = await chatgpt.beginSignIn({ home: scratchDir('siwc-other-client'), registration, fetch: auth.fetch });
    const authorize = started(flow);
    const refused = failureOf(flow.done);
    const says = 'different client';

    await returnToLoopback(flow, { code: 'code-2', state: authorize.searchParams.get('state'), client_id: 'oaiapp_someone_else' });
    expect((await refused)?.message).toContain(says);
    expect(auth.tokenCalls()).toEqual([]);
  });

  test('a browser signed in to another ChatGPT account is refused before its tokens replace this one', async () => {
    const keys = await signer();
    const auth = authServer(keys, exchangeAnswer(keys, { subject: 'another-sub' }));
    const flow = await chatgpt.beginSignIn({ home: scratchDir('siwc-other-account'), registration, fetch: auth.fetch });
    const authorize = started(flow);
    const refused = failureOf(flow.done);
    const says = 'different ChatGPT account';

    await returnToLoopback(flow, { code: 'code-2', state: authorize.searchParams.get('state') });
    expect((await refused)?.message).toContain(says);
  });

  test('asking again after a decline carries prompt=consent', async () => {
    const keys = await signer();
    const flow = await chatgpt.beginSignIn({ home: scratchDir('siwc-consent'), registration, consent: true, fetch: authServer(keys, exchangeAnswer(keys)).fetch });

    expect(started(flow).searchParams.get('prompt')).toBe('consent');
    await returnToLoopback(flow, { error: 'access_denied', state: started(flow).searchParams.get('state') });
    await flow.done;
  });
});

describe('what the browser brings back', () => {
  test('a declined consent ends the attempt and exchanges nothing', async () => {
    const keys = await signer();
    const auth = authServer(keys, exchangeAnswer(keys));
    const flow = await chatgpt.beginSignIn({ home: scratchDir('siwc-declined'), fetch: auth.fetch });
    const authorize = started(flow);

    await returnToLoopback(flow, { error: 'access_denied', state: authorize.searchParams.get('state') });

    expect(await flow.done).toEqual({ outcome: 'declined' });
    expect(auth.tokenCalls()).toEqual([]);
  });

  test('a grant without plan usage keeps the sign-in and none of its tokens', async () => {
    const keys = await signer();
    const identityOnly = 'email openid profile';
    const flow = await chatgpt.beginSignIn({ home: scratchDir('siwc-no-plan'), fetch: authServer(keys, exchangeAnswer(keys, { scope: identityOnly })).fetch });
    const authorize = started(flow);

    await returnToLoopback(flow, { code: 'code-3', state: authorize.searchParams.get('state'), client_id: 'oaiapp_issued' });
    const result = await flow.done;

    expect(result).toMatchObject({ outcome: 'plan-disabled', registered: true, record: { clientId: 'oaiapp_issued', email: 'owner@example.com', scopes: identityOnly.split(' ') } });
    expect(result.record).not.toHaveProperty('accessToken');
    expect(result.record).not.toHaveProperty('refreshToken');
    expect(chatgpt.planEnabled(result.record)).toBe(false);
  });

  test('an answer that names no scope granted what was asked', async () => {
    const keys = await signer();
    const flow = await chatgpt.beginSignIn({ home: scratchDir('siwc-scope-absent'), fetch: authServer(keys, exchangeAnswer(keys, { scope: null })).fetch });
    const authorize = started(flow);

    await returnToLoopback(flow, { code: 'code-4', state: authorize.searchParams.get('state'), client_id: 'oaiapp_issued' });

    expect((await flow.done).outcome).toBe('signed-in');
  });

  test('a request without this attempt\'s state is not read, and the listener stays for the real one', async () => {
    const keys = await signer();
    const flow = await chatgpt.beginSignIn({ home: scratchDir('siwc-state'), fetch: authServer(keys, exchangeAnswer(keys)).fetch });
    const authorize = started(flow);

    expect((await returnToLoopback(flow, { code: 'forged', state: 'not-the-state', client_id: 'oaiapp_forged' })).status).toBe(404);
    await returnToLoopback(flow, { code: 'code-5', state: authorize.searchParams.get('state'), client_id: 'oaiapp_issued' });

    expect(await flow.done).toMatchObject({ outcome: 'signed-in', record: { clientId: 'oaiapp_issued' } });
  });

  test.each([
    ['answers another attempt', { nonce: 'another-nonce' }, 'nonce mismatch'],
    ['was issued to another client', { audience: 'oaiapp_other' }, 'another client'],
  ])('an ID token that %s is refused', async (_what, claims, message) => {
    const keys = await signer();
    const flow = await chatgpt.beginSignIn({ home: scratchDir('siwc-id-token'), fetch: authServer(keys, exchangeAnswer(keys, claims)).fetch });
    const authorize = started(flow);
    const refused = failureOf(flow.done);
    const says = message;

    await returnToLoopback(flow, { code: 'code-6', state: authorize.searchParams.get('state'), client_id: 'oaiapp_issued' });
    expect((await refused)?.message).toContain(says);
  });

  test('an ID token signed by a key auth.openai.com does not publish is refused', async () => {
    const published = await signer();
    const forger = await signer();
    const auth = authServer(published, exchangeAnswer(forger));
    const flow = await chatgpt.beginSignIn({ home: scratchDir('siwc-forged'), fetch: auth.fetch });
    const authorize = started(flow);
    const refused = failureOf(flow.done);
    const says = 'does not publish';

    await returnToLoopback(flow, { code: 'code-7', state: authorize.searchParams.get('state'), client_id: 'oaiapp_issued' });
    expect((await refused)?.message).toContain(says);
  });
});

describe('refresh', () => {
  test('one rotation: the issued client and the resource go up, the replacement token and the grant come back', async () => {
    const auth = authServer(await signer(), async () => Response.json({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 }));
    const tokens = await chatgpt.refreshTokens({ clientId: 'oaiapp_issued', refreshToken: 'rt-1', scopes: FULL_SCOPE.split(' '), fetch: auth.fetch });

    expect(auth.tokenCalls().map((call) => call.form)).toEqual([
      { grant_type: 'refresh_token', client_id: 'oaiapp_issued', refresh_token: 'rt-1', resource: 'https://api.openai.com/v1' },
    ]);
    expect(tokens).toMatchObject({ accessToken: 'at-2', refreshToken: 'rt-2', scopes: FULL_SCOPE.split(' ') });
  });

  test.each(chatgpt.UNUSABLE_REFRESH_CODES)('%s spends the session', async (code) => {
    const auth = authServer(await signer(), async () => Response.json({ error: code }, { status: 400 }));
    const refresh = chatgpt.refreshTokens({ clientId: 'oaiapp_issued', refreshToken: 'rt-1', fetch: auth.fetch });

    await expect(refresh).rejects.toMatchObject({ code, unusable: true });
  });

  test('a client refusal does not spend the session', async () => {
    const auth = authServer(await signer(), async () => Response.json({ error: 'invalid_client' }, { status: 401 }));

    await expect(chatgpt.refreshTokens({ clientId: 'oaiapp_issued', refreshToken: 'rt-1', fetch: auth.fetch })).rejects.toMatchObject({ code: 'invalid_client', unusable: false });
  });
});

describe('the daemon\'s own sign-in', () => {
  function deviceRecord(home, fields) {
    fs.writeFileSync(path.join(home, chatgpt.DEVICE_RECORD_FILE), JSON.stringify({
      issuer: 'https://auth.openai.com', subject: 'user-sub', email: 'owner@example.com', clientId: 'oaiapp_device',
      idToken: 'id', scopes: FULL_SCOPE.split(' '), savedAt: new Date().toISOString(), ...fields,
    }), { mode: 0o600 });
  }

  const read = (home) => JSON.parse(fs.readFileSync(path.join(home, chatgpt.DEVICE_RECORD_FILE), 'utf8'));

  test('callers that meet an expiring token share one rotation, and the replacement lands owner-only', async () => {
    const home = scratchDir('siwc-device-rotate');
    deviceRecord(home, { accessToken: 'at-old', refreshToken: 'rt-old', expiresAt: Date.now() + 60_000 });
    const answered = Promise.withResolvers();

    const auth = authServer(await signer(), async () => {
      await answered.promise;

      return Response.json({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600 });
    });

    const session = chatgpt.createDeviceSession({ home, fetch: auth.fetch });
    const both = Promise.all([session.bearer(), session.bearer()]);

    answered.resolve();

    expect(await both).toEqual(['at-new', 'at-new']);
    expect(auth.tokenCalls().map((call) => call.form.refresh_token)).toEqual(['rt-old']);
    expect(read(home)).toMatchObject({ accessToken: 'at-new', refreshToken: 'rt-new', clientId: 'oaiapp_device' });
    expect(fs.statSync(path.join(home, chatgpt.DEVICE_RECORD_FILE)).mode & 0o777).toBe(0o600);
    expect(await session.bearer()).toBe('at-new');
    expect(auth.tokenCalls()).toHaveLength(1);
  });

  test('a token api.openai.com refused is rotated even before it expires', async () => {
    const home = scratchDir('siwc-device-rejected');
    deviceRecord(home, { accessToken: 'at-refused', refreshToken: 'rt-old', expiresAt: Date.now() + 3_600_000 });
    const auth = authServer(await signer(), async () => Response.json({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600 }));
    const session = chatgpt.createDeviceSession({ home, fetch: auth.fetch });

    expect(await session.bearer()).toBe('at-refused');
    expect(await session.bearer('at-refused')).toBe('at-new');
  });

  test('a spent refresh token signs the machine out and keeps its registration for the next sign-in', async () => {
    const home = scratchDir('siwc-device-spent');
    deviceRecord(home, { accessToken: 'at-old', refreshToken: 'rt-old', expiresAt: Date.now() - 1 });
    const session = chatgpt.createDeviceSession({ home, fetch: authServer(await signer(), async () => Response.json({ error: 'refresh_token_reused' }, { status: 400 })).fetch });

    await expect(session.bearer()).rejects.toThrow('refresh_token_reused');
    expect(read(home)).not.toHaveProperty('accessToken');
    expect(read(home)).not.toHaveProperty('refreshToken');
    expect(chatgpt.registrationOf(read(home))).toEqual({ clientId: 'oaiapp_device', subject: 'user-sub', email: 'owner@example.com' });
    expect(session.status()).toMatchObject({ signedIn: false, email: 'owner@example.com' });
    expect(await session.bearer()).toBeNull();
  });

  test('signing out revokes the refresh token with the issued client, then forgets the tokens', async () => {
    const home = scratchDir('siwc-device-sign-out');
    deviceRecord(home, { accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() + 3_600_000 });
    const auth = authServer(await signer(), async () => Response.json({}));
    const session = chatgpt.createDeviceSession({ home, fetch: auth.fetch });

    expect(await session.signOut()).toEqual({ unconfirmed: null });
    expect(auth.calls.filter((call) => call.url === REVOKE_URL).map((call) => call.form)).toEqual([
      { token: 'rt-1', token_type_hint: 'refresh_token', client_id: 'oaiapp_device' },
    ]);
    expect(read(home)).not.toHaveProperty('refreshToken');
    expect(session.status().signedIn).toBe(false);
  });

  test('a sign-in the owner starts from the web reuses the CLI\'s registration on this machine', async () => {
    const home = scratchDir('siwc-device-reuse');
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      providers: { chatgpt: { metadata: { clientId: 'oaiapp_cli', subject: 'user-sub', email: 'owner@example.com' } } },
    }));
    const session = chatgpt.createDeviceSession({ home, fetch: authServer(await signer(), async () => Response.json({})).fetch });
    const { authorizeUrl } = await session.signIn();
    const authorize = new URL(authorizeUrl);

    expect(authorize.searchParams.get('client_id')).toBe('oaiapp_cli');
    expect(authorize.searchParams.has('agent_name_hint')).toBe(false);
    expect(session.status().pending).toBe(true);
    await session.signOut();
  });
});
