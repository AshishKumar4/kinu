// The web's Claude sign-in, from the routes to Claude's token endpoint, over the flow `kinu provider connect claude` runs.
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { asFetchFunction, CLAUDE_CRED_KEY, type UserCaller } from '@kinu.run/core';
import { serveFamily } from './helpers/api';
import { createTestUserDO, testOwner, TEST_CREDENTIAL_ENCRYPTION_KEY, type TestUserDO } from './helpers/user-do';
import { bootstrappedProfile, userAccount, workspaceObject } from './helpers/bindings';
import { userRoutes, type UserRoutesEnv } from '../src/user/routes';
import type { AuthIdentity } from '../src/auth/session';
import * as v from 'valibot';

const IDENTITY: AuthIdentity = { userId: '0123456789abcdef0123456789abcdef', email: 'owner@example.com', sub: 'sub', provider: 'test', authTime: Date.now() };

const TOKEN_URL = 'https://api.anthropic.com/v1/oauth/token';

const TokenRequestSchema = v.object({ grant_type: v.string(), code: v.string(), code_verifier: v.string(), state: v.string() });

const FinishedSchema = v.object({ connected: v.boolean(), error: v.optional(v.string()) });

const realFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = realFetch; });

/** Claude's token endpoint, answering every exchange with `answer`; the requests it saw, in order. */
function claudeTokenEndpoint(answer: () => Response): v.InferOutput<typeof TokenRequestSchema>[] {
  const seen: v.InferOutput<typeof TokenRequestSchema>[] = [];

  globalThis.fetch = asFetchFunction(async (input, init) => {
    const request = new Request(input, init);

    expect(request.url).toBe(TOKEN_URL);
    seen.push(v.parse(TokenRequestSchema, await request.json()));

    return answer();
  });

  return seen;
}

function routes(harness: TestUserDO) {
  const notified: string[] = [];
  const pending: Promise<unknown>[] = [];

  const stub = userAccount({
    async ensureProfile(_caller: UserCaller, email: string) { return bootstrappedProfile(email); },
    async userMcp_warmConnections() { return { servers: 0 }; },
    async listActiveWorkspaces() { return [{ name: 'jarvis', displayName: 'Jarvis', createdAt: 1, nameOrigin: 'user' as const }]; },
    startClaudeSignIn: (caller: UserCaller) => harness.userDO.startClaudeSignIn(caller),
    finishClaudeSignIn: (caller: UserCaller, code: string) => harness.userDO.finishClaudeSignIn(caller, code),
  });

  const env: UserRoutesEnv<string> = {
    UserDO: { idFromName: (name) => name, get: () => stub },
    OrchestratorAgent: {
      idFromName: (name) => name,
      get: (id) => workspaceObject({ async onModelSettingsChanged() { notified.push(id);

 return { ok: true as const }; } }),
    },
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
  };

  const call = async (path: string, body?: { code: string }) => {
    const response = await serveFamily(userRoutes, { identity: IDENTITY, ctx: { waitUntil(promise: Promise<unknown>) { pending.push(promise); } } })(
      new Request(`https://kinu.example.com/api/user${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
      }),
      env,
    );

    if (!response) throw new Error(`no route answered ${path}`);

    return response;
  };

  const start = async () => new URL(v.parse(v.object({ url: v.string() }), await (await call('/claude/start')).json()).url);

  return { call, start, notified, settled: () => Promise.all(pending) };
}

const challengeOf = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

const storedKeys = async (harness: TestUserDO) => (await harness.userDO.listCredentials(await testOwner())).map((c) => c.key);

describe('Claude sign-in on the web', () => {
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
      expect(web.notified).toEqual(['jarvis']);
      // The sign-in is spent: the same code cannot land twice.
      expect((await web.call('/claude/finish', { code: `the-code#${state}` })).status).toBe(404);
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
      expect(status.error).toContain('Invalid authorization code');
      expect(await storedKeys(harness)).toEqual([]);
      await web.settled();
      expect(web.notified).toEqual([]);
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

  test('a sign-in started again while Claude answered the first one stores nothing', async () => {
    const harness = createTestUserDO();
    const web = routes(harness);
    let restarted: Promise<unknown> = Promise.resolve();
    claudeTokenEndpoint(() => {
      restarted = web.start();

      return Response.json({ access_token: 'at', refresh_token: 'rt' });
    });

    try {
      const state = (await web.start()).searchParams.get('state') ?? '';
      const finished = await web.call('/claude/finish', { code: `the-code#${state}` });
      await restarted;

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
      await harness.userDO.deleteCredential(await testOwner(), CLAUDE_CRED_KEY);
      const finished = await web.call('/claude/finish', { code: `the-code#${state}` });

      expect(v.parse(FinishedSchema, await finished.json()).connected).toBe(false);
      expect(await storedKeys(harness)).toEqual([]);
    } finally {
      harness.close();
    }
  });

  test('a sign-in Claude answers without a refresh token stores nothing and says why', async () => {
    const harness = createTestUserDO();
    const web = routes(harness);
    claudeTokenEndpoint(() => Response.json({ access_token: 'at', expires_in: 3600 }));

    try {
      const state = (await web.start()).searchParams.get('state') ?? '';
      const status = v.parse(FinishedSchema, await (await web.call('/claude/finish', { code: `the-code#${state}` })).json());

      expect(status.connected).toBe(false);
      expect(status.error).toContain('refresh token');
      expect(await storedKeys(harness)).toEqual([]);
    } finally {
      harness.close();
    }
  });
});
