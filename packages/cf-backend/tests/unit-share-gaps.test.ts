/**
 * The share-gaps rules, asserted end to end through the same surfaces the
 * brief named: the rate bound in `admitViewerRequest` and the exchange, the
 * consent page a credentialed share answers before a viewer reaches it, the
 * per-share per-day spend bound in the viewer's own binding call, the fork
 * flag on a live share, and the public index a blueprint publish lands on.
 *
 * Same harness as `unit-slate-live-shares.test.ts`: a real owner world, and —
 * where the route crosses workspaces — a second user's world behind the same
 * `handleSharedRequest` the app host serves.
 */
import { afterEach, expect, test } from 'bun:test';
import * as v from 'valibot';
import {
  LiveShareRecordSchema, BlueprintForkSchema,
  SHARE_SPEND_CAP_USD_PER_DAY, SHARE_VIEWER_REQUESTS_PER_MINUTE, shareSpendLabel,
  type AgentRuntime, type SlateAnswer,
} from '@kinu.run/core';
import { orchestratorHarness, type ActorHarness, type HarnessOrchestratorAgent } from './helpers/actor-harness';
import { createTestUserDO, provisionTestWorkspace, sqlExec, testOwner, TEST_USER_ENV, type TestUserDO } from './helpers/user-do';
import { resetRecordedMcp, seedMcpTools } from './helpers/agents-sdk';
import { makeKv } from './helpers/kv';
import { ROOT_SLATE_CALLER, type SlateCaller } from '../src/slates/bindings';
import { handleSharedRequest } from '../src/shared/routes';
import { handleSlateShareHostRequest } from '../src/slate-share-route';
import type { AuthIdentity } from '../src/auth/session';
import type { UserCaller } from '@kinu.run/core';
import { Database } from 'bun:sqlite';
import { initControlPlaneSchema } from '@kinu.run/core/control-plane/store';
import { indexPublicShare as indexRow, listPublicShares as listRows, forgetPublicShare as forgetRow } from '@kinu.run/core/control-plane';

function answered<Schema extends v.GenericSchema>(result: SlateAnswer<unknown>, schema: Schema): v.InferOutput<Schema> {
  if (!result.ok) throw new Error(result.reason + ': ' + result.error);

  return v.parse(schema, result.value);
}

const OWNER_ID = '0123456789abcdef0123456789abcdef';

const VIEWER_ID = 'fedcba9876543210fedcba9876543210';

/** The fixture slate `unit-slate-live-shares.test.ts` authors: one credentialed
 *  binding for the consent page to name, one executor for calls to spend. */
async function authorIssuesSlate(files: AgentRuntime['storage']['vfs']) {
  await files.mkdir('/home/user/slates/issues', { recursive: true });
  await files.writeFile('/home/user/slates/issues/package.json', JSON.stringify({
    name: 'issues', description: 'Triage the open issues', main: 'src/server.ts',
    slate: { title: 'Issue triage', bindings: {
      GITHUB: { kind: 'mcp', server: 'connection-id', tools: ['read_issue', 'create_issue'] },
      FILES: { kind: 'namespace', namespace: 'workspace', members: ['readFile', 'writeFile'] },
    } },
  }));
  await files.writeFile('/home/user/slates/issues/src/server.ts', 'export default {};');
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

/** One user's world on the shared harness: registry, capability, MCP row. */
async function userWorld(userId: string, workspace: string, kv: ReturnType<typeof makeKv>): Promise<{ user: TestUserDO; agent: ActorHarness<HarnessOrchestratorAgent> }> {
  const user = createTestUserDO({ durableObjectId: userId });
  const capability = await provisionTestWorkspace(user, workspace);
  const agent = orchestratorHarness(undefined, { userDO: user.userDO, workspace, ownerUserId: userId });
  // The bindings the share rail reads off the agent's OWN env: the request
  // bound's KV, the suffix share URLs are minted under, and the signing
  // secret. Declared before anything touches `slates` — its deps memoize.
  agent.agent.harnessDeclareEnv({
    AUTH_KV: kv, PREVIEW_HOST_SUFFIX: 'share.test',
    CREDENTIAL_ENCRYPTION_KEY: TEST_USER_ENV.CREDENTIAL_ENCRYPTION_KEY,
  });
  await agent.agent.installWorkspaceCapability(capability);
  const caller = await testOwner();

  // The catalog reads the MCP row the credentialed binding's capability is
  // drawn from; the list primes the same read the owner flow makes.
  await user.userDO.userMcp_list(caller);
  user.sql.exec(`INSERT INTO user_mcp_servers (id, name, server_url, transport, headers, allowed_tools, created_at, updated_at)
    VALUES ('connection-id', 'github', 'https://github.example/sse', 'auto', NULL, NULL, 0, 0)`);

  return { user, agent };
}

/**
 * Two users on one env, the way the shared routes actually run: the
 *   `OrchestratorAgent`/`UserDO` stubs dispatch on name, so the owner's object
 *   and the viewer's are the same pair `workspaceOwner` and
 *   `claimOwnedWorkspace` resolve in production.
 */
async function twoUserWorld(): Promise<World> {
  resetRecordedMcp();
  // One KV behind both the edge route and every workspace object: the rail
  // counts on it from both sides, the way AUTH_KV counts in production.
  const kv = makeKv();
  const ownerSide = await userWorld(OWNER_ID, 'issues-owner', kv);
  const viewerSide = await userWorld(VIEWER_ID, 'viewer-home', kv);

  const agents = new Map<string, HarnessOrchestratorAgent>([
    ['issues-owner', ownerSide.agent.agent],
    ['viewer-home', viewerSide.agent.agent],
  ]);

  const users = new Map<string, TestUserDO>([[OWNER_ID, ownerSide.user], [VIEWER_ID, viewerSide.user]]);
  const controlDb = new Database(':memory:');
  const controlSql = sqlExec(controlDb);
  initControlPlaneSchema(controlSql);

  // The public index, backed by the real store: the gate is the route's own
  // caller mint, so a route that forgot to authorize is refused exactly as
  // the object would refuse it.
  const controlPlane = {
    publicShares_put: async (_caller: UserCaller, row: Parameters<typeof indexRow>[1]) => indexRow(controlSql, row),
    publicShares_forget: async (_caller: UserCaller, key: Parameters<typeof forgetRow>[1]) => forgetRow(controlSql, key),
    publicShares_list: async (_caller: UserCaller) => listRows(controlSql),
  };

  const partialEnv: Partial<Env> = {};
  Object.assign(partialEnv, {
    ...TEST_USER_ENV,
    PREVIEW_HOST_SUFFIX: 'share.test',
    AUTH_KV: kv,
    ControlPlaneDO: { idFromName: (name: string) => name, get: () => controlPlane },
    OrchestratorAgent: {
      idFromName: (name: string) => name,
      get: (id: string) => agents.get(id)!,
    },
    UserDO: {
      idFromName: (name: string) => name,
      get: (id: string) => users.get(id)!.userDO,
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
  await authorIssuesSlate(ownerSide.agent.agent.observeRuntime().storage.vfs);

  return {
    env, owner: ownerSide.agent, viewer: viewerSide.agent, ownerUser: ownerSide.user,
    close: () => { ownerSide.user.close(); viewerSide.user.close(); controlDb.close(); resetRecordedMcp(); },
  };
}

const sharedRequest = (env: Env, identity: AuthIdentity, request: Request) =>
  handleSharedRequest(request, env, identity);

const jsonBody = async <Schema extends v.GenericSchema>(res: Response, schema: Schema): Promise<v.InferOutput<Schema>> =>
  v.parse(schema, await res.json());

const cleanups: (() => void)[] = [];

afterEach(() => { while (cleanups.length > 0) cleanups.pop()!(); });

const sharePublic = (world: World, visibility: 'users' | 'public', fork?: boolean) => world.owner.agent.slate({
  op: 'share', id: 'issues', visibility, approved: [], fork,
}).then((result) => answered(result, v.object({ share: LiveShareRecordSchema, url: v.nullable(v.string()) })));

test('S2: the per-viewer request bound refuses past its limit, per viewer and on the exchange', async () => {
  const world = await twoUserWorld();
  cleanups.push(world.close);

  const created = await sharePublic(world, 'public');
  const host = world.owner.agent.observeSlateHost();
  const claim = { userId: null, source: 's', consented: true };

  for (let n = 0; n < SHARE_VIEWER_REQUESTS_PER_MINUTE; n += 1) {
    const admission = await host.admitViewerRequest({ handle: created.share.handle, claim, pathname: '/' });

    if (admission instanceof Response) throw new Error(`request ${n + 1} refused: ${admission.status}`);
    admission.settle('ok');
  }

  const refused = await host.admitViewerRequest({ handle: created.share.handle, claim, pathname: '/' });

  if (!(refused instanceof Response)) throw new Error('the bound admitted a request past its limit');
  expect(refused.status).toBe(429);
  expect(await refused.text()).toBe('Too many requests');

  // A different viewer is a different counter — the bound never pauses the share.
  const other = await host.admitViewerRequest({ handle: created.share.handle, claim: { userId: null, source: 'other', consented: true }, pathname: '/' });

  if (other instanceof Response) throw new Error(`another viewer was refused: ${other.status}`);
  other.settle('ok');

  // The exchange is the same rail: the consent mint answers 303 until the same
  // per-viewer key fills, then the same 429.
  if (created.url === null) throw new Error('the share minted no URL');
  const exchange = (url: string) => handleSlateShareHostRequest(new Request(`${url}__kinu/viewer?consent=1`), world.env);
  const minted = await exchange(created.url);

  expect(minted?.status).toBe(303);
  expect(minted?.headers.get('set-cookie')).toContain('__Host-kinu_viewer');

  for (let n = 0; n < SHARE_VIEWER_REQUESTS_PER_MINUTE; n += 1) await exchange(created.url);
  const denied = await exchange(created.url);

  expect(denied?.status).toBe(429);
});

test('D3: a credentialed share answers its consent page until the consent cookie arrives', async () => {
  const world = await twoUserWorld();
  cleanups.push(world.close);

  const created = await sharePublic(world, 'public');
  const host = world.owner.agent.observeSlateHost();

  const before = await host.admitViewerRequest({
    handle: created.share.handle, claim: { userId: null, source: 's', consented: false }, pathname: '/',
  });

  if (!(before instanceof Response)) throw new Error('an unconsented viewer was admitted');
  expect(before.status).toBe(200);
  const html = await before.text();

  expect(html).toContain('GITHUB');
  expect(html).toContain('connection-id');
  expect(html).toContain('issues-owner');
  expect(html).toContain('/__kinu/viewer?consent=1');

  const after = await host.admitViewerRequest({
    handle: created.share.handle, claim: { userId: null, source: 's', consented: true }, pathname: '/',
  });

  if (after instanceof Response) throw new Error(`a consented viewer was refused: ${after.status}`);
  after.settle('ok');
});

test('S2: the per-share per-day spend bound refuses viewer calls as budget and marks the share paused', async () => {
  const world = await twoUserWorld();
  cleanups.push(world.close);

  const created = await sharePublic(world, 'public');
  const host = world.owner.agent.observeSlateHost();

  const admission = await host.admitViewerRequest({
    handle: created.share.handle, claim: { userId: null, source: 's', consented: true }, pathname: '/',
  });

  if (admission instanceof Response) throw new Error(`admission refused: ${admission.status}`);
  const viewerCaller: SlateCaller = { ...ROOT_SLATE_CALLER, share: created.share.id };

  const call = () => world.owner.agent.slateBindingCallAs(
    viewerCaller, 'issues', 'FILES', { member: 'readFile', args: ['/home/user/slates/issues/package.json'], invocation: admission.invocation });

  expect(await call()).toMatchObject({ ok: true });

  // Spend the day's bound the way a day's worth of calls would: the ledger's
  // own estimate takes the label over the cap and `guard` stamps it.
  world.owner.agent.budget.declare(shareSpendLabel(created.share.id), { usd: SHARE_SPEND_CAP_USD_PER_DAY });
  world.owner.agent.budget.debit(Math.ceil(SHARE_SPEND_CAP_USD_PER_DAY / 0.003 * 1000) + 1000, { labels: [shareSpendLabel(created.share.id)] });

  expect(await call()).toMatchObject({ ok: false, reason: 'budget', error: expect.stringContaining('paused for today') });

  const rows = answered(await world.owner.agent.slate({ op: 'liveShares' }),
    v.array(v.looseObject({ id: v.string(), paused: v.optional(v.boolean()) })));

  expect(rows.find((row) => row.id === created.share.id)?.paused).toBe(true);

  const requests = answered(await world.owner.agent.slate({ op: 'viewerRequests', share: created.share.id }),
    v.array(v.looseObject({ calls: v.array(v.looseObject({ ok: v.boolean() })) })));

  expect(requests[0]?.calls.map((entry) => entry.ok)).toEqual([true, false]);
});

test('D1: a live share forks for who it names, refuses who it does not, and honors fork:false', async () => {
  const world = await twoUserWorld();
  cleanups.push(world.close);

  const forker = identityOf(VIEWER_ID, 'pat@example.test');
  const fork = (body: { live: string; ownerWorkspace: string; workspace: string }) => sharedRequest(world.env, forker, post('/api/shared/fork', body));
  const created = await sharePublic(world, 'users');

  // The whole signed-in world is not admitted — only who the share names.
  const unnamed = await fork({ live: created.share.id, ownerWorkspace: 'issues-owner', workspace: 'viewer-home' });

  expect(unnamed?.status).toBe(404);

  await world.owner.agent.shareLiveWith(created.share.id, [{ userId: VIEWER_ID, email: 'pat@example.test' }]);
  const admitted = await fork({ live: created.share.id, ownerWorkspace: 'issues-owner', workspace: 'viewer-home' });

  if (admitted === null || admitted.status !== 201) throw new Error(`the named viewer's fork was refused: ${admitted?.status}`);
  const result = await jsonBody(admitted, BlueprintForkSchema);

  expect(result.workspace).toBe('viewer-home');
  expect(result.bindings.map((binding) => binding.name)).toContain('GITHUB');

  // S8 under a live fork too: what lands in the forker's tree is the slate's
  // own source — none of the owner's is carried, the way a blueprint's admit
  // already proves.
  const mcpHeader = 'Bearer owner-mcp-header-' + 'a1b2c3d4e5f6';
  world.ownerUser.sql.exec(`UPDATE user_mcp_servers SET headers = ? WHERE id = 'connection-id'`, JSON.stringify({ authorization: mcpHeader }));
  const providerKey = ['sk-ant-', 'owner-provider-key-0123456789'].join('');
  await world.ownerUser.userDO.setCredential(await testOwner(), 'anthropic', { kind: 'bearer', token: providerKey });
  const viewerFiles = world.viewer.agent.observeRuntime().storage.vfs;
  const landed = '/home/user/slates/' + result.slate;

  const admittedTree = JSON.stringify(await viewerFiles.readFile(landed + '/package.json', { encoding: 'utf8' }))
    + JSON.stringify(await viewerFiles.readFile(landed + '/src/server.ts', { encoding: 'utf8' }));

  for (const secret of [mcpHeader, providerKey, 'issues-owner']) expect(admittedTree).not.toContain(secret);

  // The flag turns: fork:false shares refuse the same viewer that just forked.
  const closed = await sharePublic(world, 'users', false);
  await world.owner.agent.shareLiveWith(closed.share.id, [{ userId: VIEWER_ID, email: 'pat@example.test' }]);
  const refused = await fork({ live: closed.share.id, ownerWorkspace: 'issues-owner', workspace: 'viewer-home' });

  expect(refused?.status).toBe(404);

  // The owner's own share is theirs to fork regardless of the user list.
  const ownerFork = await sharedRequest(world.env, identityOf(OWNER_ID, 'owner@example.test'),
    post('/api/shared/fork', { live: created.share.id, ownerWorkspace: 'issues-owner', workspace: 'issues-owner' }));

  expect(ownerFork?.status).toBe(201);
});

test('D2: a public blueprint publish lands on the shared index a stranger reads', async () => {
  const world = await twoUserWorld();
  cleanups.push(world.close);

  // A blueprint is cut from a committed version: commit, then publish that id.
  const committed = await world.owner.agent.slate({ op: 'commit', id: 'issues' });

  if (!committed.ok) throw new Error(`commit refused: ${committed.reason}: ${committed.error}`);

  const latest = answered(await world.owner.agent.slate({ op: 'history', id: 'issues' }),
    v.object({ versions: v.array(v.object({ id: v.string() })) })).versions.at(-1)!;

  const published = await sharedRequest(world.env, identityOf(OWNER_ID, 'owner@example.test'),
    post('/api/shared/publish', { workspace: 'issues-owner', slate: 'issues', version: latest.id, public: true }));

  if (published === null) throw new Error('publish answered null');
  expect(published.status).toBe(201);
  const body = await jsonBody(published, v.object({ id: v.string() }));

  const listed = await sharedRequest(world.env, identityOf(VIEWER_ID, 'pat@example.test'),
    new Request('https://app.test/api/shared', { method: 'GET' }));

  if (listed === null) throw new Error('the library answered null');

  const library = await jsonBody(listed, v.object({
    public: v.array(v.looseObject({ id: v.string(), kind: v.string(), title: v.string() })),
  }));

  expect(library.public.some((row) => row.id === body.id && row.kind === 'blueprint' && row.title === 'Issue triage')).toBe(true);

  // A share the owner closed to forking is indexed like any other — then
  // excluded from the list, because a row that cannot be forked is not
  // something the public page can offer.
  const closedResp = await sharedRequest(world.env, identityOf(OWNER_ID, 'owner@example.test'),
    post('/api/shared/live', { workspace: 'issues-owner', slate: 'issues', visibility: 'public', fork: false }));

  if (closedResp === null || closedResp.status !== 201) throw new Error(`the fork-closed share was refused: ${closedResp?.status}`);
  const closed = (await jsonBody(closedResp, v.object({ share: v.object({ id: v.string() }) }))).share;

  const relisted = await jsonBody((await sharedRequest(world.env, identityOf(VIEWER_ID, 'pat@example.test'),
    new Request('https://app.test/api/shared', { method: 'GET' })))!, v.object({
    public: v.array(v.looseObject({ id: v.string(), kind: v.string() })),
  }));

  expect(relisted.public.some((row) => row.id === closed.id && row.kind === 'live')).toBe(false);
});
