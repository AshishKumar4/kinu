/** Trial preparation over the browser's account routes and real UserDO storage. */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { DEV_IDENTITY_ACCOUNT_HEADER, DEV_IDENTITY_HEADER } from '@kinu.run/core';
import { prepareTrialAccount, trialTarget } from '../../../evals/src/slot';
import { listWorkspaces, type EvalTarget } from '../../../evals/src/workspace-roster';
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

  try {
    await provisionTestWorkspace(harness, 'eval-order-book-1-abc123');
    await expect(prepareTrialAccount(target, Date.now())).rejects.toThrow();
    expect(await listed()).toEqual(['eval-order-book-1-abc123']);
    expect(harness.destroyedWorkspaces).toEqual([]);
    expect(requests.some((request) => request.method === 'DELETE')).toBe(false);

    db.run('UPDATE user_workspaces SET last_visited = 0');
    const trial = await trialTarget({ ...target, identity: { kind: 'secret', secret: 'eval-secret' } }, 'trial-7', Date.now());
    expect(trial).toEqual({ target, account: 'trial-7' });
    expect(await listed()).toEqual([]);
    expect(harness.destroyedWorkspaces).toEqual(['eval-order-book-1-abc123']);
    expect(await harness.userDO.heldRows(owner)).toMatchObject({ user_credentials: 1 });
    expect(requests.filter((request) => request.method === 'DELETE').map((request) => request.path))
      .toEqual(['/api/user/workspaces/eval-order-book-1-abc123']);

    await provisionTestWorkspace(harness, 'eval-order-book-2-def456');
    db.run('UPDATE user_workspaces SET last_visited = 0');
    await harness.userDO.setConfig(owner, 'theme', 'dark');
    db.run("INSERT INTO user_mcp_servers (id, name, server_url, transport) VALUES ('srv-1', 'github', 'https://mcp.example/v1', 'auto')");
    await harness.userDO.shareCards_put(owner, {
      ownerUserId: 'f'.repeat(32), workspace: 'their-ws', shareId: 'share-1',
      card: { kind: 'blueprint', title: 'Board', description: '', createdAt: 1, owner: 'sam@example.test' },
    });
    await expect(prepareTrialAccount(target, Date.now())).rejects.toThrow();
    expect(await listed()).toEqual([]);
    expect(harness.destroyedWorkspaces).toEqual(['eval-order-book-1-abc123', 'eval-order-book-2-def456']);
    expect(await harness.userDO.heldRows(owner)).toMatchObject({ user_config: 1, user_share_cards: 1, user_mcp_servers: 1 });
    expect(requests.every((request) => request.secret === 'eval-secret' && request.account === 'trial-7')).toBe(true);
    expect(requests.some((request) => request.path === '/api/user/held-rows')).toBe(true);
    await Promise.all(pending);
  } finally {
    await server.stop(true);
    db.close();
  }
});
