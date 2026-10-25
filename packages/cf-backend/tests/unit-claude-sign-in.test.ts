// The web's Claude sign-in, from the routes to Claude's token endpoint, over the flow `kinu provider connect claude` runs.
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { asFetchFunction, CLAUDE_CRED_KEY, type UserCaller } from '@kinu.run/core';
import { serveFamily } from './helpers/api';
import { createTestUserDO, testOwner, TEST_CREDENTIAL_ENCRYPTION_KEY, type TestUserDO } from './helpers/user-do';
import { bootstrappedProfile, userAccount, workspaceObject } from './helpers/bindings';
import { acrossRpc } from './helpers/jsrpc-stub';
import { userRoutes, type UserRoutesEnv } from '../src/user/routes';
import type { AuthIdentity } from '../src/auth/session';
import * as v from 'valibot';

const IDENTITY: AuthIdentity = { userId: '0123456789abcdef0123456789abcdef', email: 'owner@example.com', sub: 'sub', provider: 'test', authTime: Date.now() };

const TOKEN_URL = 'https://api.anthropic.com/v1/oauth/token';

const TokenRequestSchema = v.object({ grant_type: v.string(), code: v.string(), code_verifier: v.string(), state: v.string(), redirect_uri: v.string() });

const FinishedSchema = v.object({ connected: v.boolean(), error: v.optional(v.string()) });

const RefusalSchema = v.looseObject({ error: v.string() });

const realFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = realFetch; });

/** Claude's token endpoint, answering every exchange with `answer`; the requests it saw, in order. */
function claudeTokenEndpoint(answer: () => Response | Promise<Response>): v.InferOutput<typeof TokenRequestSchema>[] {
  const seen: v.InferOutput<typeof TokenRequestSchema>[] = [];

  globalThis.fetch = asFetchFunction(async (input, init) => {
    const request = new Request(input, init);

    expect(request.url).toBe(TOKEN_URL);
    seen.push(v.parse(TokenRequestSchema, await request.json()));

    return await answer();
  });

  return seen;
}

function routes(harness: TestUserDO) {
  const pending: Promise<unknown>[] = [];

  const stub = userAccount({
    async ensureProfile(_caller: UserCaller, email: string) { return bootstrappedProfile(email); },
    async listActiveWorkspaces() { return [{ name: 'jarvis', displayName: 'Jarvis', createdAt: 1, lastVisited: 1, nameOrigin: 'user' as const }]; },
    startClaudeSignIn: (caller: UserCaller, account?: string) => harness.userDO.startClaudeSignIn(caller, account),
    // As production calls it: across RPC, where the object's refusal arrives as no KinuError.
    finishClaudeSignIn: (caller: UserCaller, code: string) => acrossRpc((pasted: string) => harness.userDO.finishClaudeSignIn(caller, pasted))(code),
  });

  const env: UserRoutesEnv<string> = {
    UserDO: { idFromName: (name) => name, get: () => stub },
    OrchestratorAgent: {
      idFromName: (name) => name,
      get: () => workspaceObject({ async onModelSettingsChanged() { return { ok: true as const }; } }),
    },
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
  };

  const call = async (path: string, body?: { code: string } | { account: string }) => {
    const response = await serveFamily(userRoutes, { identity: IDENTITY, ctx: { waitUntil(promise: Promise<unknown>) { pending.push(promise); } } })(
      new Request(`https://kinu.example.com/api/user${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
      }),
      env,
    );

    if (!response) throw new Error(`no route answered ${path}`);

    return response;
  };

  const start = async (account?: string) =>
    new URL(v.parse(v.object({ url: v.string() }), await (await call('/claude/start', account === undefined ? undefined : { account })).json()).url);

  return { call, start, settled: () => Promise.all(pending) };
}

const challengeOf = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

const storedKeys = async (harness: TestUserDO) => (await harness.userDO.listCredentials(await testOwner())).map((c) => c.key);

describe('Claude sign-in on the web', () => {
  // The owner, 2026-10-23: nothing should land on a page that fails. Claude returns the browser to Anthropic's own page,
  // which shows the code; the exchange names the same address.
  test("Claude returns the browser to Anthropic's code page, and the code it shows connects Claude", async () => {
    const harness = createTestUserDO();
    const web = routes(harness);
    const seen = claudeTokenEndpoint(() => Response.json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, account: { email_address: 'owner@example.com' } }));

    try {
      const authorize = await web.start();
      const state = authorize.searchParams.get('state') ?? '';

      expect(authorize.searchParams.get('redirect_uri')).toBe('https://platform.claude.com/oauth/code/callback');

      const finished = await web.call('/claude/finish', { code: `the-code#${state}` });

      expect(v.parse(FinishedSchema, await finished.json())).toEqual({ connected: true });
      expect(seen[0]).toMatchObject({ code: 'the-code', state, redirect_uri: 'https://platform.claude.com/oauth/code/callback' });
      await web.settled();
    } finally {
      harness.close();
    }
  });

  test('the address Claude sent the browser to connects Claude with the verifier the sign-in began with', async () => {
    const harness = createTestUserDO();
    const web = routes(harness);
    const seen = claudeTokenEndpoint(() => Response.json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, account: { email_address: 'owner@example.com' } }));

    try {
      const authorize = await web.start();
      const state = authorize.searchParams.get('state') ?? '';
      expect(authorize.origin + authorize.pathname).toBe('https://claude.ai/oauth/authorize');

      const finished = await web.call('/claude/finish', { code: `http://localhost:54545/callback?code=the-code&state=${state}` });
      expect(v.parse(FinishedSchema, await finished.json())).toEqual({ connected: true });
      await web.settled();

      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ grant_type: 'authorization_code', code: 'the-code', state });
      expect(challengeOf(seen[0]?.code_verifier ?? '')).toBe(authorize.searchParams.get('code_challenge') ?? '');
      expect(await storedKeys(harness)).toEqual([CLAUDE_CRED_KEY]);
      // The sign-in is spent: the same code cannot land twice.
      expect((await web.call('/claude/finish', { code: `the-code#${state}` })).status).toBe(404);
    } finally {
      harness.close();
    }
  });

  test('a second Claude account signs in under its name, beside the first', async () => {
    const harness = createTestUserDO();
    const web = routes(harness);

    claudeTokenEndpoint(() => Response.json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, account: { email_address: 'owner@example.com' } }));

    try {
      for (const account of [undefined, 'work']) {
        const state = (await web.start(account)).searchParams.get('state') ?? '';

        expect(v.parse(FinishedSchema, await (await web.call('/claude/finish', { code: `the-code#${state}` })).json())).toEqual({ connected: true });
      }

      expect((await storedKeys(harness)).sort()).toEqual([CLAUDE_CRED_KEY, `${CLAUDE_CRED_KEY}@work`]);
      await web.settled();
    } finally {
      harness.close();
    }
  });

  test('a name that is no account\'s is refused before a sign-in is held', async () => {
    const harness = createTestUserDO();
    const web = routes(harness);
    const seen = claudeTokenEndpoint(() => Response.json({ access_token: 'at', refresh_token: 'rt' }));

    try {
      const refused = await web.call('/claude/start', { account: 'Work Laptop' });

      expect(refused.status).toBe(400);
      expect(v.parse(RefusalSchema, await refused.json()).error).toContain('is not an account name');
      // Nothing held: a code pasted now has no sign-in to finish.
      expect((await web.call('/claude/finish', { code: 'the-code#state' })).status).toBe(404);
      expect([seen, await storedKeys(harness)]).toEqual([[], []]);
    } finally {
      harness.close();
    }
  });

  test('a refused exchange stores nothing and says why', async () => {
    const harness = createTestUserDO();
    const web = routes(harness);
    claudeTokenEndpoint(() => Response.json({ error: 'invalid_grant', error_description: 'Invalid authorization code' }, { status: 400 }));

    try {
      const state = (await web.start()).searchParams.get('state') ?? '';
      const finished = await web.call('/claude/finish', { code: `bad-code#${state}` });

      const status = v.parse(FinishedSchema, await finished.json());

      expect(status.connected).toBe(false);
      // Claude's own words, in a sentence that says what to do; not the chain of what Kinu was doing when it failed.
      expect(status.error).toStartWith("Claude didn't accept that code (Invalid authorization code).");
      expect(status.error).toContain('start the sign-in again');
      expect(status.error).not.toContain('token endpoint');
      expect(await storedKeys(harness)).toEqual([]);
      await web.settled();
    } finally {
      harness.close();
    }
  });

  // Production, 2026-10-23: a paste that is no code answered "The request is not valid."
  test('a paste that is no Claude code is refused in words that say so, before it reaches Claude', async () => {
    const harness = createTestUserDO();
    const web = routes(harness);
    const seen = claudeTokenEndpoint(() => Response.json({ access_token: 'at', refresh_token: 'rt' }));

    try {
      await web.start();
      const finished = await web.call('/claude/finish', { code: 'https://claude.ai/oauth/authorize?client_id=x' });

      expect(finished.status).toBe(400);
      expect(v.parse(RefusalSchema, await finished.json()).error).toStartWith("That isn't a Claude sign-in code.");
      expect(seen).toEqual([]);
    } finally {
      harness.close();
    }
  });

  test('a code from an earlier sign-in is refused before it reaches Claude', async () => {
    const harness = createTestUserDO();
    const web = routes(harness);
    const seen = claudeTokenEndpoint(() => Response.json({ access_token: 'at', refresh_token: 'rt' }));

    try {
      const earlier = (await web.start()).searchParams.get('state') ?? '';
      await web.start();
      const finished = await web.call('/claude/finish', { code: `old-code#${earlier}` });

      expect(finished.status).toBe(400);
      expect(seen).toEqual([]);
      expect(await storedKeys(harness)).toEqual([]);
    } finally {
      harness.close();
    }
  });

  // The restart lands while Claude is still answering: before the first sign-in's credential is committed.
  test('a sign-in started again while Claude answered the first one stores nothing', async () => {
    const harness = createTestUserDO();
    const web = routes(harness);

    claudeTokenEndpoint(async () => {
      await web.start();

      return Response.json({ access_token: 'at', refresh_token: 'rt' });
    });

    try {
      const state = (await web.start()).searchParams.get('state') ?? '';
      const finished = await web.call('/claude/finish', { code: `the-code#${state}` });

      expect(v.parse(FinishedSchema, await finished.json()).connected).toBe(false);
      expect(await storedKeys(harness)).toEqual([]);
    } finally {
      harness.close();
    }
  });

  test('a disconnect while a sign-in is open spends it: its code no longer connects Claude', async () => {
    const harness = createTestUserDO();
    const web = routes(harness);
    claudeTokenEndpoint(() => Response.json({ access_token: 'at', refresh_token: 'rt' }));

    try {
      const state = (await web.start()).searchParams.get('state') ?? '';
      await harness.userDO.deleteCredential(await testOwner(), CLAUDE_CRED_KEY, false);
      const finished = await web.call('/claude/finish', { code: `the-code#${state}` });

      expect(v.parse(FinishedSchema, await finished.json()).connected).toBe(false);
      expect(await storedKeys(harness)).toEqual([]);
    } finally {
      harness.close();
    }
  });

  test('a sign-in Claude answers without a refresh token is kept until it expires', async () => {
    const harness = createTestUserDO();
    const web = routes(harness);
    claudeTokenEndpoint(() => Response.json({ access_token: 'at', expires_in: 3600 }));

    try {
      const state = (await web.start()).searchParams.get('state') ?? '';
      const status = v.parse(FinishedSchema, await (await web.call('/claude/finish', { code: `the-code#${state}` })).json());

      expect({ connected: status.connected, stored: await storedKeys(harness) }).toEqual({ connected: true, stored: ['claude.oauth'] });
    } finally {
      harness.close();
    }
  });
});
