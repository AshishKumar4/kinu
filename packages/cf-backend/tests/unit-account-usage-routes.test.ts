// The owner's spend per provider account across every workspace: each workspace answers from its own
// ledger, the route merges them, and a workspace it could not read is named rather than counted as zero.
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { AccountUsageSchema, type AccessTokenScope, type AccountSpend, type UserCaller } from '@kinu.run/core';
import { handleUserRequest, type UserRoutesEnv } from '../src/user/routes';
import { handleCliRequest, type CliRoutesEnv } from '../src/cli/routes';
import type { AuthIdentity } from '../src/auth/session';
import { asFetchFunction } from '@kinu.run/core';
import { bootstrappedProfile, cliAccount, unreachableAssets, unreachableKv, userAccount, workspaceObject } from './helpers/bindings';
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';

const USER_ID = '0123456789abcdef0123456789abcdef';

const WORKSPACES = ['jarvis', 'scout', 'relay', 'gone'].map((name, index) => ({
  name, displayName: name, createdAt: index, nameOrigin: 'user' as const,
}));

const work = ({ calls, input, usd, at, remaining }: { calls: number; input: number; usd: number; at: number; remaining: number }): AccountSpend => ({
  provider: 'anthropic', account: 'work', calls, callsWithoutUsage: 0, unpricedCalls: 0, floorPricedCalls: 0,
  usage: { input, output: calls }, usd,
  quota: { at, windows: [{ measure: 'requests', limit: 50, remaining }] },
});

/** Each workspace's own ledger; `gone` cannot be reached. */
const LEDGERS = new Map<string, readonly AccountSpend[]>([
  ['jarvis', [work({ calls: 3, input: 900, usd: 0.5, at: 1_000, remaining: 40 })]],
  ['scout', [
    work({ calls: 1, input: 100, usd: 0.25, at: 3_000, remaining: 12 }),
    { provider: 'openai', account: 'main', calls: 2, callsWithoutUsage: 0, unpricedCalls: 2, floorPricedCalls: 0, usage: { input: 10 } },
  ]],
  ['relay', [work({ calls: 2, input: 1_000, usd: 0.25, at: 2_000, remaining: 30 })]],
]);

const workspaces = {
  idFromName: (name: string) => name,
  get: (name: string) => workspaceObject({
    async accountSpend() {
      const ledger = LEDGERS.get(name);

      if (ledger === undefined) throw new Error(`${name} is unreachable`);

      return [...ledger];
    },
  }),
};

const held = (keys: readonly string[]) => keys.map((key) => ({ key, kind: 'bearer' as const, createdAt: 1, updatedAt: 1 }));

const MERGED = {
  accounts: [
    {
      provider: 'anthropic', account: 'work', calls: 6, callsWithoutUsage: 0, unpricedCalls: 0, floorPricedCalls: 0,
      usage: { input: 2_000, output: 6 }, usd: 1,
      quota: { at: 3_000, windows: [{ measure: 'requests', limit: 50, remaining: 12 }] },
    },
    { provider: 'openai', account: 'main', calls: 2, callsWithoutUsage: 0, unpricedCalls: 2, floorPricedCalls: 0, usage: { input: 10 } },
  ],
  workspaces: 3,
  unread: ['gone'],
};

describe('the owner\'s usage per account, across workspaces', () => {
  test('the web route sums each account over the workspaces, keeps its newest quota, reads each OpenRouter key\'s credit, and names what it could not read', async () => {
    const identity: AuthIdentity = { userId: USER_ID, email: 'owner@example.com', sub: 'sub', provider: 'test', authTime: Date.now() };

    const stub = userAccount({
      async ensureProfile(_caller: UserCaller, email: string) { return bootstrappedProfile(email); },
      async userMcp_warmConnections() { return { servers: 0 }; },
      async listActiveWorkspaces() { return WORKSPACES; },
      async listCredentials() { return held(['anthropic.bearer@work', 'openrouter.bearer', 'openrouter.bearer@team']); },
      async getAuthHeaders(_caller: UserCaller, key: string) { return { Authorization: `Bearer ${key}` }; },
    });

    const keysRead: string[] = [];
    const realFetch = globalThis.fetch;

    // The documented `GET /api/v1/key` answer; the `team` key is refused.
    globalThis.fetch = asFetchFunction(async (input, init) => {
      const authorization = new Headers(init?.headers).get('authorization') ?? '';
      keysRead.push(`${input instanceof Request ? input.url : input.toString()} ${authorization}`);

      return authorization.endsWith('@team')
        ? new Response('no', { status: 500 })
        : Response.json({ data: { limit: 10, limit_remaining: 4.12, limit_reset: 'monthly', usage: 30, usage_daily: 1.03, usage_monthly: 5.88 } });
    });

    const env: UserRoutesEnv<string> = {
      UserDO: { idFromName: (n) => n, get: () => stub },
      OrchestratorAgent: workspaces,
      CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    };

    try {
      const response = await handleUserRequest(new Request('https://kinu.example.com/api/user/usage'), env, identity, {
        waitUntil() {},
      });

      expect(response?.status).toBe(200);

      expect(v.parse(AccountUsageSchema, await response?.json())).toEqual({
        ...MERGED,
        unread: ['gone', 'openrouter · team credit'],
        credits: [{
          provider: 'openrouter', account: 'main', at: expect.any(Number),
          limit: 10, remaining: 4.12, reset: 'monthly', usedToday: 1.03, usedThisMonth: 5.88,
        }],
      });

      expect(keysRead.sort()).toEqual([
        'https://openrouter.ai/api/v1/key Bearer openrouter.bearer',
        'https://openrouter.ai/api/v1/key Bearer openrouter.bearer@team',
      ]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('the CLI route answers a workspace.read token and refuses one without it', async () => {
    const tokens = new Map<string, AccessTokenScope[]>([
      [`pta_${USER_ID}_${'r'.repeat(44)}`, ['workspace.read']],
      [`pta_${USER_ID}_${'e'.repeat(44)}`, ['workspace.exec']],
    ]);

    const userDO = cliAccount({
      async verifyAccessToken(_caller: UserCaller, token: string) {
        const scopes = tokens.get(token);

        return scopes === undefined
          ? { ok: false, error: 'invalid token' }
          : { ok: true, tokenHash: token.slice(-8), scopes, user: { id: USER_ID, email: 'owner@example.com', displayName: 'Owner' } };
      },
      async listActiveWorkspaces() { return WORKSPACES; },
      async listCredentials() { return held([]); },
    });

    const env: CliRoutesEnv<string> = {
      UserDO: { idFromName: (n) => n, get: () => userDO },
      OrchestratorAgent: workspaces,
      CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
      AUTH_KV: unreachableKv('AUTH_KV'),
      ASSETS: unreachableAssets(),
    };

    const usageWith = (token: string) => handleCliRequest(new Request('https://kinu.example.com/api/cli/usage', {
      headers: { authorization: `Bearer ${token}` },
    }), env);

    const read = await usageWith(`pta_${USER_ID}_${'r'.repeat(44)}`);
    expect(read?.status).toBe(200);
    expect(v.parse(AccountUsageSchema, await read?.json()).unread).toEqual(['gone']);

    const exec = await usageWith(`pta_${USER_ID}_${'e'.repeat(44)}`);
    expect(exec?.status).toBe(403);
    expect(await exec?.text()).toContain('workspace.read');
  });
});
