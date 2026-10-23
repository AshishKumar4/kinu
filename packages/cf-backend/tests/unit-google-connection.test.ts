// The Google connection: an operator connects it from their own page, Google's grant is kept as `google.oauth`, renewed
// when due, retired when Google refuses it, and revoked with one token on disconnect. Real state store and vault; only
// Google's endpoints are faked.
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { asFetchFunction, CapabilityDeniedError, GOOGLE_CONNECTION_SCOPES, GOOGLE_OAUTH_CRED_KEY, type JsonValue, type OAuthCredential } from '@kinu.run/core';
import { completeGoogleConnect, GOOGLE_CONNECT_STATE_PREFIX, startGoogleConnect, type GoogleConnectEnv } from '../src/user/google-connect';
import { makeKv } from './helpers/kv';
import { createTestUserDO, provisionTestWorkspace, testOwner } from './helpers/user-do';

const ORIGIN = 'https://kinu.example.com';

const RUN = '7d1f0e9a-3c2b-4a5d-8e6f-1a2b3c4d5e6f';

const ACCOUNT = 'account-0123';

const CLIENT_ID = 'test-google-client-id';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

const realFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = realFetch; });

function connectEnv(overrides: Partial<GoogleConnectEnv> = {}): GoogleConnectEnv {
  return { AUTH_KV: makeKv(), CONTROL_PLANE_ADMINS: 'ops@example.com', MCP_GOOGLE_CLIENT_ID: CLIENT_ID, MCP_GOOGLE_CLIENT_SECRET: 'test-google-client-secret', ...overrides };
}

const segment = (value: JsonValue) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** An ID token as Google's token endpoint returns it; its signature is never checked there (OIDC Core §3.1.3.7). */
function idToken(nonce: string): string {
  const now = Math.floor(Date.now() / 1_000);

  return `${segment({ alg: 'RS256', typ: 'JWT' })}.${segment({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: '1093', email: 'owner@gmail.com', nonce, iat: now, exp: now + 3_600 })}.c2ln`;
}

/** Google's token endpoint answering `answer`; the forms it was sent. */
function google(answer: (form: URLSearchParams) => Record<string, JsonValue>, status = 200): URLSearchParams[] {
  const forms: URLSearchParams[] = [];

  globalThis.fetch = asFetchFunction(async (input, init) => {
    const request = new Request(input, init);
    const form = new URLSearchParams(await request.text());

    forms.push(form);
    expect([TOKEN_URL, REVOKE_URL]).toContain(request.url);

    return Response.json(answer(form), { status });
  });

  return forms;
}

/** The connect's start, as the owner's helper tab opens it. */
async function start(env: GoogleConnectEnv, email = 'ops@example.com'): Promise<Response> {
  const request = new Request(`${ORIGIN}/api/user/google/connect?run=${RUN}`, { headers: { 'sec-fetch-site': 'same-origin' } });

  return startGoogleConnect(request, env, { account: ACCOUNT, email });
}

/** What a connect's finish page is told: the run it ended, and why it failed. */
interface Ended {
  readonly run: string | null;
  readonly error: string | null;
}

/** Where a response sends the browser, and what the finish page is told. */
function ended(response: Response): Ended {
  const at = new URL(response.headers.get('location') ?? '');

  return { run: at.searchParams.get('run'), error: at.searchParams.get('error') };
}

/** A connect run from start to Google's return, Google answering the code with `granted`. */
async function connect(env: GoogleConnectEnv, granted: (nonce: string) => Record<string, JsonValue>, account = ACCOUNT) {
  const started = await start(env);
  const consent = new URL(started.headers.get('location') ?? '');
  const state = consent.searchParams.get('state') ?? '';
  const cookie = (started.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const kept: OAuthCredential[] = [];

  google(() => granted(consent.searchParams.get('nonce') ?? ''));
  const back = new Request(`${ORIGIN}/api/user/mcp/callback?${new URLSearchParams({ state, code: 'four-slash-code' }).toString()}`, { headers: { cookie } });
  const response = await completeGoogleConnect({ request: back, env, account, keep: async (credential) => { kept.push(credential); } });

  return { consent, response, kept };
}

describe('connecting Google', () => {
  test("asks Google for the connection's scopes and a refresh token, returning to the Workspace client's callback", async () => {
    const response = await start(connectEnv());
    const consent = new URL(response.headers.get('location') ?? '');

    expect(response.status).toBe(302);
    expect(consent.origin + consent.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries([...consent.searchParams].filter(([name]) => !['state', 'nonce', 'code_challenge'].includes(name)))).toEqual({
      client_id: CLIENT_ID,
      redirect_uri: `${ORIGIN}/api/user/mcp/callback`,
      response_type: 'code',
      scope: GOOGLE_CONNECTION_SCOPES,
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent select_account',
    });
    expect(consent.searchParams.get('state')).toStartWith(GOOGLE_CONNECT_STATE_PREFIX);
  });

  test('keeps what Google granted, for the account Google names', async () => {
    const { response, kept } = await connect(connectEnv(), (nonce) => ({
      access_token: 'ya29.first', refresh_token: '1//refresh', expires_in: 3_599, token_type: 'Bearer', scope: GOOGLE_CONNECTION_SCOPES, id_token: idToken(nonce),
    }));

    expect(ended(response)).toEqual({ run: RUN, error: null });
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ kind: 'oauth', accessToken: 'ya29.first', refreshToken: '1//refresh', metadata: { account: 'owner@gmail.com', scopes: GOOGLE_CONNECTION_SCOPES.split(' ') } });
  });

  test('is refused before Google to anyone off the operator list, and where the deployment has no client', async () => {
    expect(ended(await start(connectEnv(), 'someone@example.com')).error).toContain('operators only');
    expect(ended(await start(connectEnv({ MCP_GOOGLE_CLIENT_SECRET: '' }))).error).toContain('no Google client');
  });

  test('a callback replayed, or from another browser, ends on the finish page in the store\'s words', async () => {
    const env = connectEnv();
    const first = await connect(env, (nonce) => ({ access_token: 'ya29.first', refresh_token: '1//refresh', expires_in: 3_599, token_type: 'Bearer', id_token: idToken(nonce) }));
    const state = first.consent.searchParams.get('state') ?? '';

    const replayed = await completeGoogleConnect({
      request: new Request(`${ORIGIN}/api/user/mcp/callback?${new URLSearchParams({ state, code: 'again' }).toString()}`),
      env, account: ACCOUNT, keep: async () => { throw new Error('a replay keeps nothing'); },
    });

    expect(replayed.status).toBe(302);
    expect(ended(replayed).error).toContain('OAuth state');
  });

  test('ends in its own words, keeping nothing, for another account or a grant with no refresh token', async () => {
    const grant = (nonce: string) => ({ access_token: 'ya29.first', expires_in: 3_599, token_type: 'Bearer', id_token: idToken(nonce) });
    const elsewhere = await connect(connectEnv(), grant, 'another-account');
    const noRefresh = await connect(connectEnv(), grant);

    expect(ended(elsewhere.response)).toEqual({ run: RUN, error: 'The Kinu account that started connecting Google is no longer signed in here.' });
    expect(ended(noRefresh.response).error).toContain('without a refresh token');
    expect([...elsewhere.kept, ...noRefresh.kept]).toEqual([]);
  });
});

describe('the kept connection', () => {
  async function connected(expiresAt: number) {
    const harness = createTestUserDO({ mcpAppCredentials: ['google'] });
    const owner = await testOwner();
    const credential: OAuthCredential = { kind: 'oauth', accessToken: 'ya29.held', refreshToken: '1//refresh', expiresAt, metadata: { account: 'owner@gmail.com', scopes: ['openid'] } };

    await harness.userDO.setCredential(owner, GOOGLE_OAUTH_CRED_KEY, credential);

    return { harness, owner };
  }

  test('is renewed when due, keeping its refresh token, and served as it stands until then', async () => {
    const { harness, owner } = await connected(Date.now() + 60_000);
    const forms = google(() => ({ access_token: 'ya29.renewed', expires_in: 3_599, token_type: 'Bearer' }));

    expect(await harness.userDO.googleToken(owner)).toBe('ya29.renewed');
    expect(forms.map((form) => [form.get('grant_type'), form.get('refresh_token'), form.get('client_id')])).toEqual([['refresh_token', '1//refresh', CLIENT_ID]]);
    expect(await harness.userDO.googleToken(owner)).toBe('ya29.renewed');
    expect(forms).toHaveLength(1);
    expect(await harness.userDO.googleConnection(owner)).toEqual({ account: 'owner@gmail.com', scopes: ['openid'] });
    harness.close();
  });

  test('a renewal that names no lifetime or scopes is still renewed within the hour, its scopes kept', async () => {
    const { harness, owner } = await connected(Date.now() + 60_000);

    google(() => ({ access_token: 'ya29.bare', token_type: 'Bearer' }));

    expect(await harness.userDO.googleToken(owner)).toBe('ya29.bare');
    expect(await harness.userDO.googleConnection(owner)).toEqual({ account: 'owner@gmail.com', scopes: ['openid'] });

    const forms = google(() => ({ access_token: 'ya29.later', expires_in: 3_599, token_type: 'Bearer' }));

    setSystemTime(new Date(Date.now() + 56 * 60_000));
    expect(await harness.userDO.googleToken(owner)).toBe('ya29.later');
    setSystemTime();
    expect(forms).toHaveLength(1);
    harness.close();
  });

  test('refused by Google, it is retired, so Settings offers Connect again', async () => {
    const { harness, owner } = await connected(Date.now() + 60_000);

    google(() => ({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }), 400);

    expect(await harness.userDO.googleToken(owner)).toBeNull();
    expect(await harness.userDO.googleConnection(owner)).toBeNull();
    harness.close();
  });

  test('its token is the owner\'s alone: a workspace asking is refused, through the generic credential reads too', async () => {
    const { harness, owner } = await connected(Date.now() + 3_600_000);
    const shop = { workspaceToken: await provisionTestWorkspace(harness, 'shop') };

    await expect(harness.userDO.googleToken(shop)).rejects.toBeInstanceOf(CapabilityDeniedError);
    await expect(harness.userDO.getAuthHeaders(shop, GOOGLE_OAUTH_CRED_KEY)).rejects.toBeInstanceOf(CapabilityDeniedError);
    await expect(harness.userDO.getAuth(shop, GOOGLE_OAUTH_CRED_KEY)).rejects.toBeInstanceOf(CapabilityDeniedError);
    await expect(harness.userDO.getCredentialEndpoint(shop, GOOGLE_OAUTH_CRED_KEY)).rejects.toBeInstanceOf(CapabilityDeniedError);
    expect(await harness.userDO.getAuthHeaders(owner, GOOGLE_OAUTH_CRED_KEY)).toEqual({ Authorization: 'Bearer ya29.held' });
    harness.close();
  });

  test('a disconnect that revokes asks Google once, with the refresh token, which ends the whole grant', async () => {
    const { harness, owner } = await connected(Date.now() + 3_600_000);
    const forms = google(() => ({}));

    expect(await harness.userDO.deleteCredential(owner, GOOGLE_OAUTH_CRED_KEY, true)).toEqual({ unrevoked: null });
    expect(forms.map((form) => [form.get('token'), form.get('token_type_hint')])).toEqual([['1//refresh', 'refresh_token']]);
    expect(await harness.userDO.googleConnection(owner)).toBeNull();
    harness.close();
  });
});
