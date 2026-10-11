/** Trial preparation over the browser's account routes and real UserDO storage. */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { DEV_IDENTITY_ACCOUNT_HEADER, DEV_IDENTITY_HEADER, parseJsonObject } from '@kinu.run/core';
import { prepareTrialAccount } from '../../../evals/src/slot';
import { listWorkspaces, webHeaders, type EvalTarget } from '../../../evals/src/workspace-roster';
import { accountRoutes, type AccountRoutesEnv } from '../src/user/account-routes';
import { userRoutes, type UserRoutesEnv } from '../src/user/routes';
import type { AuthIdentity } from '../src/auth/session';
import { serveFamily } from './helpers/api';
import { createTestUserDO, provisionTestWorkspace, testOwner, TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import { unreachableNamespace } from './helpers/bindings';

test('trial preparation preserves a live slot, deletes stale workspaces and refuses inherited account rows', async () => {
  const userId = '0123456789abcdef0123456789abcdef';
  const db = new Database(':memory:');
  const harness = createTestUserDO({ storage: db, durableObjectId: userId });
  const owner = await testOwner();
  const email = 'eval-service+trial-7@kinu.run';
  await harness.userDO.ensureProfile(owner, email);
  await harness.userDO.setCredential(owner, 'opencode-go.bearer', { kind: 'bearer', token: 'sk-probe' });
  const identity: AuthIdentity = { userId, email, sub: 'eval', provider: 'dev', authTime: Date.now() };
  const UserDO = { idFromName: (name: string) => name, get: () => harness.userDO };
  const userEnv: UserRoutesEnv<string> = { UserDO, OrchestratorAgent: unreachableNamespace('OrchestratorAgent'), CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY };
  const accountEnv: AccountRoutesEnv<string> = { UserDO, CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY };
  const pending: Parameters<ExecutionContext['waitUntil']>[0][] = [];
  const ctx = { waitUntil: (promise: Parameters<ExecutionContext['waitUntil']>[0]) => { pending.push(promise); } };
  const user = serveFamily(userRoutes, { identity, ctx });
  const account = serveFamily(accountRoutes, { identity, ctx });
  const requests: Array<{ method: string; path: string; secret: string | null; account: string | null }> = [];

  const server = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch(request) {
      requests.push({ method: request.method, path: new URL(request.url).pathname,
        secret: request.headers.get(DEV_IDENTITY_HEADER), account: request.headers.get(DEV_IDENTITY_ACCOUNT_HEADER) });

      return await account(request, accountEnv) ?? await user(request, userEnv) ?? new Response(null, { status: 404 });
    },
  });

  const target: EvalTarget = { origin: server.url.origin, identity: { kind: 'secret', secret: 'eval-secret', account: 'trial-7' } };
  const listed = async () => (await listWorkspaces(target.origin, target.identity)).map((row) => row.name);

  const held = async () => {
    const response = await fetch(`${target.origin}/api/user/held-rows`, { headers: webHeaders(target.identity) });
    expect(response.status).toBe(200);

    return parseJsonObject(await response.text());
  };

  try {
    await provisionTestWorkspace(harness, 'eval-order-book-1-abc123');
    await expect(prepareTrialAccount(target, Date.now())).rejects.toThrow();
    expect(await listed()).toEqual(['eval-order-book-1-abc123']);
    expect(harness.destroyedWorkspaces).toEqual([]);
    expect(requests.some((request) => request.method === 'DELETE')).toBe(false);

    db.run('UPDATE user_workspaces SET last_visited = 0');
    await prepareTrialAccount(target, Date.now());
    expect(await listed()).toEqual([]);
    expect(harness.destroyedWorkspaces).toEqual(['eval-order-book-1-abc123']);
    expect(await harness.userDO.heldRows(owner)).toMatchObject({ user_credentials: 1 });
    expect(requests.filter((request) => request.method === 'DELETE').map((request) => request.path))
      .toEqual(['/api/user/workspaces/eval-order-book-1-abc123']);

    const contaminants = [
      {
        table: 'user_config',
        put: () => harness.userDO.setConfig(owner, 'theme', 'dark'),
        clear: async () => { db.run("DELETE FROM user_config WHERE key = 'theme'"); },
      },
      {
        table: 'user_mcp_servers',
        put: async () => { db.run("INSERT INTO user_mcp_servers (id, name, server_url, transport) VALUES ('srv-1', 'github', 'https://mcp.example/v1', 'auto')"); },
        clear: () => harness.userDO.userMcp_remove(owner, 'srv-1'),
      },
      {
        table: 'user_share_cards',
        put: () => harness.userDO.shareCards_put(owner, {
          ownerUserId: 'f'.repeat(32), workspace: 'their-ws', shareId: 'share-1',
          card: { kind: 'blueprint', title: 'Board', description: '', createdAt: 1, owner: 'sam@example.test' },
        }),
        clear: () => harness.userDO.sharesReceived_forget(owner, 'f'.repeat(32)),
      },
    ];

    for (const contaminated of contaminants) {
      await expect(prepareTrialAccount(target, Date.now())).resolves.toBeUndefined();
      await contaminated.put();
      const rows = await held();
      expect(rows[contaminated.table]).toBe(1);

      for (const other of contaminants) {
        if (other !== contaminated) expect(rows[other.table]).toBeUndefined();
      }

      await expect(prepareTrialAccount(target, Date.now())).rejects.toThrow();
      await contaminated.clear();
      await expect(prepareTrialAccount(target, Date.now())).resolves.toBeUndefined();
      expect((await held())[contaminated.table]).toBeUndefined();
    }

    expect(await listed()).toEqual([]);
    expect(requests.every((request) => request.secret === 'eval-secret' && request.account === 'trial-7')).toBe(true);
    expect(requests.some((request) => request.path === '/api/user/held-rows')).toBe(true);
    await Promise.all(pending);
  } finally {
    await server.stop(true);
    db.close();
  }
});
