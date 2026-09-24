/**
 * Share-gaps rules end to end through the edge route: rate bound, consent page, fork flag, and revoking either kind.
 * Same harness as `unit-slate-live-shares.test.ts`; the per-share daily spend bound pauses a running slate's
 * calls, so it is driven in workerd (`tests/workerd/slate-share.test.ts`).
 */
import { afterEach, expect, test } from 'bun:test';
import * as v from 'valibot';
import {
  LiveShareRecordSchema, BlueprintForkSchema, SHARE_VIEWER_REQUESTS_PER_MINUTE, SharedLibrarySchema,
  type AgentRuntime, type SlateAnswer,
} from '@kinu.run/core';
import { orchestratorHarness, type ActorHarness, type HarnessOrchestratorAgent, workspaceFiles } from './helpers/actor-harness';
import { createTestUserDO, provisionTestWorkspace, testOwner, TEST_USER_ENV, type TestUserDO } from './helpers/user-do';
import { resetRecordedMcp, seedMcpTools } from './helpers/agents-sdk';
import { makeKv } from './helpers/kv';
import { handleSharedPublicRequest, handleSharedRequest } from '../src/shared/routes';
import { handleSlateShareHostRequest } from '../src/slate-share-route';
import type { AuthIdentity } from '../src/auth/session';
import { present } from '@kinu.run/test-utils';

function answered<Schema extends v.GenericSchema>(result: SlateAnswer<unknown>, schema: Schema): v.InferOutput<Schema> {
  if (!result.ok) throw new Error(result.reason + ': ' + result.error);

  return v.parse(schema, result.value);
}

const OWNER_ID = '0123456789abcdef0123456789abcdef';

const VIEWER_ID = 'fedcba9876543210fedcba9876543210';

async function authorIssuesSlate(files: AgentRuntime['storage']['vfs']) {
  await files.mkdir('/home/main/slates/issues', { recursive: true });
  await files.writeFile('/home/main/slates/issues/package.json', JSON.stringify({
    name: 'issues', description: 'Triage the open issues', main: 'src/server.ts',
    slate: { title: 'Issue triage', bindings: {
      GITHUB: { kind: 'mcp', server: 'connection-id', tools: ['read_issue', 'create_issue'] },
      FILES: { kind: 'namespace', namespace: 'workspace', members: ['readFile', 'writeFile'] },
    } },
  }));
  await files.writeFile('/home/main/slates/issues/src/server.ts', 'export default {};');
}

const post = (path: string, body: Record<string, string | boolean | readonly string[] | undefined>) => new Request(`https://app.test${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

const identityOf = (userId: string, email: string): AuthIdentity => ({ userId, email, sub: `sub-${userId}` });

interface World {
  readonly env: Env;
  readonly owner: ActorHarness<HarnessOrchestratorAgent>;
  readonly viewer: ActorHarness<HarnessOrchestratorAgent>;
  readonly ownerUser: TestUserDO;
  readonly close: () => void;
}

async function userWorld(userId: string, workspace: string, kv: ReturnType<typeof makeKv>): Promise<{ user: TestUserDO; agent: ActorHarness<HarnessOrchestratorAgent> }> {
  const user = createTestUserDO({ durableObjectId: userId });
  const capability = await provisionTestWorkspace(user, workspace);
  const agent = orchestratorHarness(undefined, { userDO: user.userDO, workspace, ownerUserId: userId });
  // Declared before anything touches `slates`: its deps memoize.
  agent.agent.harnessDeclareEnv({
    AUTH_KV: kv, PREVIEW_HOST_SUFFIX: 'share.test',
    CREDENTIAL_ENCRYPTION_KEY: TEST_USER_ENV.CREDENTIAL_ENCRYPTION_KEY,
  });
  await agent.agent.installWorkspaceCapability(capability);
  const caller = await testOwner();

  await user.userDO.userMcp_list(caller);
  user.sql.exec(`INSERT INTO user_mcp_servers (id, name, server_url, transport, headers, allowed_tools, created_at, updated_at)
    VALUES ('connection-id', 'github', 'https://github.example/sse', 'auto', NULL, NULL, 0, 0)`);

  return { user, agent };
}

/** The `OrchestratorAgent`/`UserDO` stubs dispatch on name, as `workspaceOwner` and `claimOwnedWorkspace` resolve in production. */
async function twoUserWorld(): Promise<World> {
  resetRecordedMcp();
  // One KV behind the edge route and every workspace object, as AUTH_KV in production.
  const kv = makeKv();
  const ownerSide = await userWorld(OWNER_ID, 'issues-owner', kv);
  const viewerSide = await userWorld(VIEWER_ID, 'viewer-home', kv);

  const agents = new Map<string, HarnessOrchestratorAgent>([
    ['issues-owner', ownerSide.agent.agent],
    ['viewer-home', viewerSide.agent.agent],
  ]);

  const users = new Map<string, TestUserDO>([[OWNER_ID, ownerSide.user], [VIEWER_ID, viewerSide.user]]);

  const partialEnv: Partial<Env> = {};
  Object.assign(partialEnv, {
    ...TEST_USER_ENV,
    PREVIEW_HOST_SUFFIX: 'share.test',
    AUTH_KV: kv,
    OrchestratorAgent: {
      idFromName: (name: string) => name,
      get: (id: string) => present(agents.get(id), `the OrchestratorAgent stub ${id}`),
    },
    UserDO: {
      idFromName: (name: string) => name,
      get: (id: string) => present(users.get(id), `the UserDO stub ${id}`).userDO,
    },
  });

  // SAFETY: constructed above is every member the shared routes and the
  // share rail read — the host suffix, the signing secret, the request
  // bound's KV, and the two object namespaces. Nothing unassigned is
  // reachable from the dispatch the suite drives.
  const env = partialEnv as Env;

  seedMcpTools('connection-id', [
    { name: 'read_issue', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
    { name: 'create_issue', inputSchema: { type: 'object' } },
  ]);
  await authorIssuesSlate(workspaceFiles(ownerSide.agent.agent));

  return {
    env, owner: ownerSide.agent, viewer: viewerSide.agent, ownerUser: ownerSide.user,
    close: () => { ownerSide.user.close(); viewerSide.user.close(); resetRecordedMcp(); },
  };
}

const sharedRequest = (env: Env, identity: AuthIdentity, request: Request) =>
  handleSharedRequest(request, env, identity);

const jsonBody = async <Schema extends v.GenericSchema>(res: Response, schema: Schema): Promise<v.InferOutput<Schema>> =>
  v.parse(schema, await res.json());

const cleanups: (() => void)[] = [];

afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

const sharePublic = (world: World, visibility: 'users' | 'public', fork?: boolean) => world.owner.agent.slate({
  op: 'share', id: 'issues', visibility, approved: [], fork,
}).then((result) => answered(result, v.object({ share: LiveShareRecordSchema, url: v.nullable(v.string()) })));

/** A visit to the share's own URL through the edge route; `ip` is the viewer the edge names by its address. */
function visit(world: World, url: string, ip: string, init?: { path?: string; cookie?: string }) {
  const headers = new Headers({ 'cf-connecting-ip': ip });

  if (init?.cookie !== undefined) headers.set('cookie', init.cookie);

  return handleSlateShareHostRequest(new Request(`${url}${init?.path ?? ''}`, { headers }), world.env);
}

const CONSENT_PATH = '__kinu/viewer?consent=1';

test('S2: the per-viewer request bound refuses past its limit, per viewer and on the exchange', async () => {
  const world = await twoUserWorld();
  cleanups.push(world.close);

  const created = await sharePublic(world, 'public');
  const url = present(created.url, 'the share URL');

  // The bound precedes the consent page, so a viewer who has not consented spends it too.
  for (let n = 0; n < SHARE_VIEWER_REQUESTS_PER_MINUTE; n += 1) {
    expect((await visit(world, url, '203.0.113.1'))?.status).toBe(200);
  }

  const refused = await visit(world, url, '203.0.113.1');

  expect(refused?.status).toBe(429);
  expect(await refused?.text()).toBe('Too many requests');
  expect((await visit(world, url, '203.0.113.2'))?.status).toBe(200);

  const minted = await visit(world, url, '203.0.113.3', { path: CONSENT_PATH });

  expect(minted?.status).toBe(303);
  expect(minted?.headers.get('set-cookie')).toContain('__Host-kinu_viewer');

  for (let n = 0; n < SHARE_VIEWER_REQUESTS_PER_MINUTE; n += 1) await visit(world, url, '203.0.113.3', { path: CONSENT_PATH });
  expect((await visit(world, url, '203.0.113.3', { path: CONSENT_PATH }))?.status).toBe(429);
});

test('D3: a credentialed share answers its consent page until the consent cookie arrives', async () => {
  const world = await twoUserWorld();
  cleanups.push(world.close);

  const created = await sharePublic(world, 'public');
  const url = present(created.url, 'the share URL');

  const before = await visit(world, url, '203.0.113.4');

  expect(before?.status).toBe(200);
  const html = await before?.text() ?? '';

  expect(html).toContain('GITHUB');
  expect(html).toContain('connection-id');
  expect(html).toContain('issues-owner');
  expect(html).toContain(`/${CONSENT_PATH}`);

  const minted = await visit(world, url, '203.0.113.4', { path: CONSENT_PATH });
  const cookie = present(minted?.headers.get('set-cookie')?.split(';')[0], 'the consent cookie');
  const after = await visit(world, url, '203.0.113.4', { cookie });

  // Admitted past the page: the request is audited (no slate process boots here, so it answers no page).
  expect(await after?.text()).not.toContain(`/${CONSENT_PATH}`);
  const requests = answered(await world.owner.agent.slate({ op: 'viewerRequests', share: created.share.id }), v.array(v.looseObject({ viewer: v.string() })));
  expect(requests).toHaveLength(1);
});

test('a users share refuses a viewer it does not name', async () => {
  const world = await twoUserWorld();
  cleanups.push(world.close);

  const created = await sharePublic(world, 'users');

  expect((await visit(world, present(created.url, 'the share URL'), '203.0.113.5'))?.status).toBe(404);
});

test('D1: a live share forks for who it names, refuses who it does not, honors fork:false, and its owner forks it too', async () => {
  const world = await twoUserWorld();
  cleanups.push(world.close);

  const forker = identityOf(VIEWER_ID, 'pat@example.test');
  const fork = (body: { live: string; ownerWorkspace: string; workspace: string }) => sharedRequest(world.env, forker, post('/api/shared/fork', body));
  const created = await sharePublic(world, 'users');

  const unnamed = await fork({ live: created.share.id, ownerWorkspace: 'issues-owner', workspace: 'viewer-home' });

  expect(unnamed?.status).toBe(404);

  await world.owner.agent.shareLiveWith(created.share.id, [{ userId: VIEWER_ID, email: 'pat@example.test' }]);
  const admitted = await fork({ live: created.share.id, ownerWorkspace: 'issues-owner', workspace: 'viewer-home' });

  if (admitted === null || admitted.status !== 201) throw new Error(`the named viewer's fork was refused: ${admitted?.status}`);
  const result = await jsonBody(admitted, BlueprintForkSchema);

  expect(result.workspace).toBe('viewer-home');
  expect(result.bindings.map((binding) => binding.name)).toContain('GITHUB');

  // S8 under a live fork: only the slate's own source lands in the forker's tree.
  const mcpHeader = 'Bearer owner-mcp-header-' + 'a1b2c3d4e5f6';
  world.ownerUser.sql.exec(`UPDATE user_mcp_servers SET headers = ? WHERE id = 'connection-id'`, JSON.stringify({ authorization: mcpHeader }));
  const providerKey = ['sk-ant-', 'owner-provider-key-0123456789'].join('');
  await world.ownerUser.userDO.setCredential(await testOwner(), 'anthropic', { kind: 'bearer', token: providerKey });
  const viewerFiles = workspaceFiles(world.viewer.agent);
  const landed = '/home/main/slates/' + result.slate;

  const admittedTree = JSON.stringify(await viewerFiles.readFile(landed + '/package.json', { encoding: 'utf8' }))
    + JSON.stringify(await viewerFiles.readFile(landed + '/src/server.ts', { encoding: 'utf8' }));

  for (const secret of [mcpHeader, providerKey, 'issues-owner']) expect(admittedTree).not.toContain(secret);

  const closed = await sharePublic(world, 'users', false);
  await world.owner.agent.shareLiveWith(closed.share.id, [{ userId: VIEWER_ID, email: 'pat@example.test' }]);
  const refused = await fork({ live: closed.share.id, ownerWorkspace: 'issues-owner', workspace: 'viewer-home' });

  expect(refused?.status).toBe(404);

  const ownerFork = await sharedRequest(world.env, identityOf(OWNER_ID, 'owner@example.test'),
    post('/api/shared/fork', { live: created.share.id, ownerWorkspace: 'issues-owner', workspace: 'issues-owner' }));

  expect(ownerFork?.status).toBe(201);

  // The owner's Drive row carries the switch, so it offers Fork… on the open share and not on the closed one.
  const library = await jsonBody(present(await sharedRequest(world.env, identityOf(OWNER_ID, 'owner@example.test'),
    new Request('https://app.test/api/shared')), 'the owner\'s library'), SharedLibrarySchema);

  const forks = new Map(library.mine.map((row) => [row.id, row.fork]));

  expect([forks.get(created.share.id), forks.get(closed.share.id)]).toEqual([true, false]);
});

test('D2: one revoke route ends a public live share and a blueprint link', async () => {
  const world = await twoUserWorld();
  cleanups.push(world.close);
  const owner = identityOf(OWNER_ID, 'owner@example.test');
  const revoke = (share: string) => sharedRequest(world.env, owner, post('/api/shared/revoke', { workspace: 'issues-owner', share }));

  const liveResp = present(await sharedRequest(world.env, owner,
    post('/api/shared/live', { workspace: 'issues-owner', slate: 'issues', visibility: 'public' })), 'the live share answer');

  expect(liveResp.status).toBe(201);
  const live = await jsonBody(liveResp, v.object({ share: v.object({ id: v.string() }), url: v.nullable(v.string()) }));
  const url = present(live.url, 'the share URL');

  expect((await visit(world, url, '203.0.113.9'))?.status).toBe(200);
  expect((await revoke(live.share.id))?.status).toBe(200);
  expect((await visit(world, url, '203.0.113.9'))?.status).toBe(404);

  const committed = await world.owner.agent.slate({ op: 'commit', id: 'issues' });

  if (!committed.ok) throw new Error(`commit refused: ${committed.reason}: ${committed.error}`);

  const latest = present(answered(await world.owner.agent.slate({ op: 'history', id: 'issues' }),
    v.object({ versions: v.array(v.object({ id: v.string() })) })).versions.at(-1), 'the latest committed version');

  const publishResp = present(await sharedRequest(world.env, owner,
    post('/api/shared/publish', { workspace: 'issues-owner', slate: 'issues', version: latest.id })), 'the publish answer');

  expect(publishResp.status).toBe(201);
  const blueprint = await jsonBody(publishResp, v.object({ id: v.string(), share: v.string() }));
  const page = () => handleSharedPublicRequest(new Request(`https://app.test/api/shared/blueprint/${encodeURIComponent(blueprint.id)}`), world.env);

  expect((await page())?.status).toBe(200);
  expect((await revoke(blueprint.share))?.status).toBe(200);
  expect((await page())?.status).toBe(404);
});
