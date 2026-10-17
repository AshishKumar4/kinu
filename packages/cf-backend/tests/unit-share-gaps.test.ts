import { readText, writeText } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * Share-gaps rules end to end through the edge route: rate bound, consent page, fork flag, and revoking either kind.
 * The per-share daily spend bound pauses a running slate's calls, so it is driven in workerd
 * (`tests/workerd/slate-share.test.ts`).
 */
import { afterEach, expect, setSystemTime, test } from 'bun:test';
import * as v from 'valibot';
import { matchPath } from 'react-router-dom';
import {
  APP_ROUTES, GallerySlateSchema, LIVE_SHARE_LISTING_PATH, LIVE_SHARE_PREAPPROVALS_PATH, LIVE_SHARE_PREAPPROVAL_WITHDRAW_PATH, SlatePreapprovalsSchema, LIVE_SHARE_MODE_PATH, LIVE_SHARE_OPEN_PATH, LiveShareOpenSchema, LiveShareRecordSchema, SlateReachSchema, LiveShareCreatedSchema, BlueprintForkSchema, SHARE_VIEWER_REQUESTS_PER_MINUTE, SharedLibrarySchema,
  type AgentRuntime, type GalleryCategory, type GallerySlate, type JsonValue, type SlateAnswer,
} from '@kinu.run/core';
import type { ControlCaller } from '@kinu.run/core/control-plane';
import { orchestratorHarness, type ActorHarness, type HarnessOrchestratorAgent, until, workspaceFiles } from './helpers/actor-harness';
import { createTestUserDO, provisionTestWorkspace, testOwner, TEST_USER_ENV, type TestUserDO } from './helpers/user-do';
import { resetRecordedMcp, seedConfiguredMcpServer, seedMcpTools } from './helpers/agents-sdk';
import { ROOT_SLATE_CALLER, type GalleryListingSync } from '@kinu.run/core/slates';
import { makeKv } from './helpers/kv';
import { sharedPublicRoutes, sharedRoutes } from '../src/shared/routes';
import { accountRoutes } from '../src/user/account-routes';
import { galleryRoutes } from '../src/gallery/routes';
import { serveFamily } from './helpers/api';
import { handleSlateShareHostRequest } from '../src/slate-share-route';
import type { AuthIdentity } from '../src/auth/session';
import { present } from '@kinu.run/test-utils';
import { KinuError } from '@kinu.run/core/obs';
import { accountIdFor } from '../src/auth/store';

/** A slate's process as its bindings name it, started before any share of it: its sharing's first generation. */
const UNSHARED = { incarnation: 'test', generation: 0 };

function answered<Schema extends v.GenericSchema>(result: SlateAnswer<unknown>, schema: Schema): v.InferOutput<Schema> {
  if (!result.ok) throw new Error(result.reason + ': ' + result.error);

  return v.parse(schema, result.value);
}

/** The owner's account, named by their email as the deployment's sign-in names it. */
const OWNER_ID = await accountIdFor({}, 'owner@example.test');

/** The account pat@example.test is on the harness's deployment, which declares no sign-in provider: a share naming
 *  pat reaches the account pat signs in to. */
const VIEWER_ID = await accountIdFor({}, 'pat@example.test');

const APP_ORIGIN = 'https://app.test';

async function authorIssuesSlate(files: AgentRuntime['storage']['vfs']) {
  await files.mkdir('/slates/issues', { recursive: true });
  await writeText(files, '/slates/issues/package.json', JSON.stringify({
    name: 'issues', description: 'Triage the open issues', main: 'src/server.ts',
    slate: { title: 'Issue triage' },
  }));
  await writeText(files, '/slates/issues/src/server.ts', 'export default {};');
}

/** What the slate reaches, as its owner runs it: the graph a share is cut from is what the host recorded. */
async function exerciseIssuesSlate(owner: HarnessOrchestratorAgent): Promise<void> {
  const source = '/slates/issues/src/server.ts';

  for (const [path, args] of [
    [['mcp', 'github', 'read_issue'], [{}]], [['mcp', 'github', 'create_issue'], [{}]], [['readFile'], [source]], [['writeFile'], [source, 'export default {};']],
  ] as const) {
    await owner.slateCallAs({ caller: ROOT_SLATE_CALLER, id: 'issues', name: 'workspace', lineage: UNSHARED }, { path: [...path], args: [...args], invocation: null });
  }
}

const post = (path: string, body: Readonly<Record<string, JsonValue | undefined>>) => new Request(`https://app.test${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

const identityOf = (userId: string, email: string): AuthIdentity => ({ userId, email, sub: `sub-${userId}` });

interface World {
  readonly env: Env;
  readonly owner: ActorHarness<HarnessOrchestratorAgent>;
  readonly viewer: ActorHarness<HarnessOrchestratorAgent>;
  readonly ownerUser: TestUserDO;
  /** pat@example.test's account, which a card for pat reaches. */
  readonly viewerUser: TestUserDO;
  /** Each workspace object the edge acquired, by name. */
  readonly acquired: string[];
  readonly close: () => void;
}

/** Each account by id, as every account's own `env.UserDO` resolves it: a share's card goes to the account its email names. */
async function userWorld(
  account: { readonly userId: string; readonly email: string }, workspace: string, kv: ReturnType<typeof makeKv>, accounts: ReadonlyMap<string, TestUserDO>,
): Promise<{ user: TestUserDO; agent: ActorHarness<HarnessOrchestratorAgent> }> {
  const { userId } = account;
  const user = createTestUserDO({ durableObjectId: userId, accounts: (id) => present(accounts.get(id), `the account ${id}`).userDO });
  const capability = await provisionTestWorkspace(user, workspace);
  const agent = orchestratorHarness(undefined, { userDO: user.userDO, workspace, ownerUserId: userId });
  // Declared before anything touches `slates`: its deps memoize.
  agent.agent.harnessDeclareEnv({
    AUTH_KV: kv, PREVIEW_HOST_SUFFIX: 'share.test', CLI_PUBLIC_ORIGIN: APP_ORIGIN,
    CREDENTIAL_ENCRYPTION_KEY: TEST_USER_ENV.CREDENTIAL_ENCRYPTION_KEY,
  });
  await agent.agent.installWorkspaceCapability(capability);
  const caller = await testOwner();

  await user.userDO.ensureProfile(caller, account.email);
  await user.userDO.userMcp_list(caller);
  seedConfiguredMcpServer(user.sql, 'connection-id', { name: 'github', url: 'https://github.example/sse', transport: 'auto' });

  return { user, agent };
}

/** The `OrchestratorAgent`/`UserDO` stubs dispatch on name, as `workspaceOwner` and `claimOwnedWorkspace` resolve in production. */
async function twoUserWorld(): Promise<World> {
  resetRecordedMcp();
  // One KV behind the edge route and every workspace object, as AUTH_KV in production.
  const kv = makeKv();
  const users = new Map<string, TestUserDO>();
  const ownerSide = await userWorld({ userId: OWNER_ID, email: 'owner@example.test' }, 'issues-owner', kv, users);

  // Seeded on the newest MCP manager, so before the viewer's account builds its own: these are the owner's tools.
  seedMcpTools('connection-id', [
    { name: 'read_issue', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
    { name: 'create_issue', inputSchema: { type: 'object' } },
  ]);
  const viewerSide = await userWorld({ userId: VIEWER_ID, email: 'pat@example.test' }, 'viewer-home', kv, users);

  const agents = new Map<string, HarnessOrchestratorAgent>([
    ['issues-owner', ownerSide.agent.agent],
    ['viewer-home', viewerSide.agent.agent],
  ]);

  for (const [id, side] of [[OWNER_ID, ownerSide], [VIEWER_ID, viewerSide]] as const) users.set(id, side.user);
  const acquired: string[] = [];

  const partialEnv: Partial<Env> = {};
  Object.assign(partialEnv, {
    ...TEST_USER_ENV,
    PREVIEW_HOST_SUFFIX: 'share.test',
    AUTH_KV: kv,
    OrchestratorAgent: {
      idFromName: (name: string) => name,
      get: (id: string) => {
        acquired.push(id);

        return present(agents.get(id), `the OrchestratorAgent stub ${id}`);
      },
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

  await authorIssuesSlate(workspaceFiles(ownerSide.agent.agent));
  await exerciseIssuesSlate(ownerSide.agent.agent);

  return {
    env, owner: ownerSide.agent, viewer: viewerSide.agent, ownerUser: ownerSide.user, viewerUser: viewerSide.user, acquired,
    close: () => { ownerSide.user.close(); viewerSide.user.close(); resetRecordedMcp(); },
  };
}

const sharedRequest = (env: Env, identity: AuthIdentity, request: Request) =>
  serveFamily(sharedRoutes, { identity })(request, env);

const jsonBody = async <Schema extends v.GenericSchema>(res: Response, schema: Schema): Promise<v.InferOutput<Schema>> =>
  v.parse(schema, await res.json());

const cleanups: (() => void)[] = [];

afterEach(() => {
  setSystemTime();

  for (const cleanup of cleanups.splice(0)) cleanup();
});

const sharePublic = (world: World, visibility: 'users' | 'public', fork?: boolean) => world.owner.agent.slate({
  op: 'share', id: 'issues', visibility, approved: [], fork,
}).then((result) => answered(result, v.object({ share: LiveShareRecordSchema, url: v.nullable(v.string()) })));

/**
 * The app's page for a share asking where to frame it, as `email` signed in on this deployment's own machine (its dev
 * identity), or signed out: the route answers before any session gate.
 */
const openShare = (world: World, body: { workspace: string; share: string }, email?: string) => serveFamily(sharedPublicRoutes)(
  new Request(`http://localhost${LIVE_SHARE_OPEN_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  email === undefined ? world.env : { ...world.env, DEV_USER_EMAIL: email },
);

/** The owner's live shares not yet revoked. */
const openShares = async (world: World) => answered(await world.owner.agent.slate({ op: 'liveShares' }), v.array(LiveShareRecordSchema)).filter((row) => row.revokedAt === null);

/** The control plane, as far as the owner's workspace tells it its Gallery listings: each sync it is sent, in `synced`. */
function tellGalleryInto(world: World, synced: GalleryListingSync[]): void {
  world.owner.agent.harnessDeclareEnv({
    ControlPlaneDO: { idFromName: (name: string) => name, get: () => ({ gallerySync: async (_caller: ControlCaller, sync: GalleryListingSync) => { synced.push(sync); } }) },
  });
}

/** A share's bare host, which only the app's page for it is handed (`LIVE_SHARE_OPEN_PATH`): what a visit reaches. */
const hostOf = async (world: World, handle: string) => present(await world.owner.agent.liveShareUrl(handle), 'the share host');

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
  const url = await hostOf(world, created.share.handle);

  // The ingress count resets on the wall-clock minute; this burst belongs to one window.
  const now = Date.now();
  setSystemTime(now - (now % 60_000) + 60_000);

  // The bound precedes the consent page, so a viewer who has not consented spends it too.
  for (let n = 0; n < SHARE_VIEWER_REQUESTS_PER_MINUTE; n += 1) {
    expect((await visit(world, url, '203.0.113.1'))?.status).toBe(200);
  }

  const refused = await visit(world, url, '203.0.113.1');

  expect(refused?.status).toBe(429);
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
  const url = await hostOf(world, created.share.handle);

  const before = await visit(world, url, '203.0.113.4');

  expect(before?.status).toBe(200);
  const html = await before?.text() ?? '';

  // What the grant reaches: the read-only MCP tool and the file read, by namespace.
  expect(html).toContain('<li>mcp.github</li>');
  expect(html).toContain('<li>workspace</li>');
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

test('a users share link sends each visitor to sign in, then lets in its owner and the people it names as themselves, and no one else', async () => {
  const world = await twoUserWorld();
  cleanups.push(world.close);

  const created = await sharePublic(world, 'users');
  const url = await hostOf(world, created.share.handle);
  await world.owner.agent.shareLiveWith(created.share.id, [{ userId: VIEWER_ID, email: 'pat@example.test' }]);

  // Each follows the link as a browser does: to the app's page for the share, whose open hands them a ticket and names
  // the slate it frames; to anyone else it says nothing of the share.
  const openAs = async (identity: AuthIdentity, ip: string): Promise<readonly [number, number | undefined]> => {
    const sent = present(await visit(world, url, ip), 'the first visit');
    const page = new URL(present(sent.headers.get('location'), 'where the first visit was sent'));

    expect([sent.status, page.origin]).toEqual([303, APP_ORIGIN]);
    const { params } = present(matchPath(APP_ROUTES.sharedLive, page.pathname), 'the share\'s entry page');
    const opened = present(await openShare(world, { workspace: params.workspace ?? '', share: params.share ?? '' }, identity.email), 'the open answer');

    if (opened.status === 404) return [opened.status, undefined];
    const entry = await jsonBody(opened, LiveShareOpenSchema);

    expect([entry.slate, entry.title]).toEqual(['issues', 'Issue triage']);
    const exchanged = await handleSlateShareHostRequest(new Request(entry.url, { headers: { 'cf-connecting-ip': ip } }), world.env);
    const cookie = present(exchanged?.headers.get('set-cookie')?.split(';')[0], 'the viewer cookie');

    return [opened.status, (await visit(world, url, ip, { cookie }))?.status];
  };

  expect(await openAs(identityOf(OWNER_ID, 'owner@example.test'), '203.0.113.5')).toEqual([200, 200]);
  expect(await openAs(identityOf(VIEWER_ID, 'pat@example.test'), '203.0.113.6')).toEqual([200, 200]);
  expect(await openAs(identityOf('00112233445566778899aabbccddeeff', 'sam@example.test'), '203.0.113.7')).toEqual([404, undefined]);
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
  expect(result.requirements.map((requirement) => requirement.name)).toEqual(['mcp.github', 'workspace']);

  // S8 under a live fork: only the slate's own source lands in the forker's tree.
  const mcpHeader = 'Bearer owner-mcp-header-' + 'a1b2c3d4e5f6';
  world.ownerUser.sql.exec(`UPDATE user_mcp_servers SET headers = ? WHERE id = 'connection-id'`, JSON.stringify({ authorization: mcpHeader }));
  const providerKey = ['sk-ant-', 'owner-provider-key-0123456789'].join('');
  await world.ownerUser.userDO.setCredential(await testOwner(), 'anthropic', { kind: 'bearer', token: providerKey });
  const viewerFiles = workspaceFiles(world.viewer.agent);
  const landed = '/slates/' + result.slate;

  const admittedTree = JSON.stringify(await readText(viewerFiles, landed + '/package.json'))
    + JSON.stringify(await readText(viewerFiles, landed + '/src/server.ts'));

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
  const live = await jsonBody(liveResp, v.object({ share: v.object({ id: v.string(), handle: v.string() }), url: v.nullable(v.string()) }));
  const url = await hostOf(world, live.share.handle);

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
  const page = () => serveFamily(sharedPublicRoutes)(new Request(`https://app.test/api/shared/blueprint/${encodeURIComponent(blueprint.id)}`), world.env);

  expect((await page())?.status).toBe(200);
  expect((await revoke(blueprint.share))?.status).toBe(200);
  expect((await page())?.status).toBe(404);
});

test("the owner's Drive lists its slates and shares from the tiles its workspaces pushed, asking no workspace", async () => {
  const world = await twoUserWorld();
  cleanups.push(world.close);
  const owner = identityOf(OWNER_ID, 'owner@example.test');

  const library = async () => {
    world.acquired.length = 0;
    const read = await jsonBody(present(await sharedRequest(world.env, owner, new Request('https://app.test/api/shared')), 'the library'), SharedLibrarySchema);

    expect(world.acquired).toEqual([]);

    return read;
  };

  const live = await sharePublic(world, 'public');
  const committed = answered(await world.owner.agent.slate({ op: 'commit', id: 'issues' }), v.object({ id: v.string() }));

  const published = present(await sharedRequest(world.env, owner,
    post('/api/shared/publish', { workspace: 'issues-owner', slate: 'issues', version: committed.id })), 'the publish answer');

  const blueprint = await jsonBody(published, v.object({ id: v.string(), share: v.string() }));
  const shared = await library();

  expect(shared.slates).toEqual([{ id: 'issues', title: 'Issue triage', workspace: 'issues-owner', visibility: 'public' }]);
  expect(new Set(shared.mine.map((row) => `${row.kind} ${row.id} ${row.title}`))).toEqual(new Set([
    `blueprint ${blueprint.id} Issue triage`,
    `live ${live.share.id} Issue triage`,
  ]));

  expect((await sharedRequest(world.env, owner, post('/api/shared/revoke', { workspace: 'issues-owner', share: live.share.id })))?.status).toBe(200);
  const after = await library();

  expect(after.mine.map((row) => row.kind)).toEqual(['blueprint']);
  expect(after.slates[0]?.visibility).toBeUndefined();
});

test("a slate's picture in its workspace's tile reaches the Drive's row for it, and a live share of it names it", async () => {
  const world = await twoUserWorld();
  cleanups.push(world.close);
  const owner = identityOf(OWNER_ID, 'owner@example.test');
  const userDO = world.ownerUser.userDO;
  const push = userDO.putWorkspaceOverview.bind(userDO);
  const digest = 'ab'.repeat(32);

  // The capture is Browser Rendering's, so here the tile the workspace pushes is handed one.
  Object.assign(userDO, {
    putWorkspaceOverview: (...[caller, name, overview]: Parameters<typeof push>) =>
      push(caller, name, { ...overview, slates: overview.slates.map((slate) => ({ ...slate, picture: digest })) }),
  });
  await sharePublic(world, 'public');
  const shared = await jsonBody(present(await sharedRequest(world.env, owner, new Request('https://app.test/api/shared')), 'the library'), SharedLibrarySchema);

  expect(shared.slates.map((slate) => [slate.id, slate.picture])).toEqual([['issues', digest]]);
  // So the share's tile can find that picture among the owner's slates.
  expect(shared.mine.filter((row) => row.kind === 'live').map((row) => row.slate)).toEqual(['issues']);
});

test('a change whose card cannot reach the tile is made and says the list is behind; a revoke during the backoff still moves it', async () => {
  const world = await twoUserWorld();
  cleanups.push(world.close);
  const owner = identityOf(OWNER_ID, 'owner@example.test');
  const userDO = world.ownerUser.userDO;
  const push = userDO.putWorkspaceOverview.bind(userDO);
  const failing = async () => { throw new KinuError('unavailable', 'the roster is unavailable'); };

  const Made = v.object({ share: v.object({ id: v.string() }), listing: v.optional(v.literal('pending')) });

  const share = async (visibility: 'users' | 'public') => jsonBody(present(await sharedRequest(world.env, owner,
    post('/api/shared/live', { workspace: 'issues-owner', slate: 'issues', visibility })), 'the share answer'), Made);

  const revoke = async (id: string) => present(await sharedRequest(world.env, owner, post('/api/shared/revoke', { workspace: 'issues-owner', share: id })), 'the revoke answer');
  const listed = async () => (await jsonBody(present(await sharedRequest(world.env, owner, new Request('https://app.test/api/shared')), 'the library'), SharedLibrarySchema)).mine;

  const lives = async () => answered(await world.owner.agent.slate({ op: 'liveShares' }), v.array(LiveShareRecordSchema));

  const first = await share('public');

  expect(first.listing).toBeUndefined();

  // Its push fails: the share is made and answered, so a retry would mint a second.
  Object.assign(userDO, { putWorkspaceOverview: failing });
  const second = await share('users');
  Object.assign(userDO, { putWorkspaceOverview: push });

  expect(second.listing).toBe('pending');
  expect(new Set((await lives()).filter((row) => row.revokedAt === null).map((row) => row.id))).toEqual(new Set([first.share.id, second.share.id]));

  // During the backoff that failure left, a revoke still moves the tile, and the next fold lists the second share.
  const revoked = await revoke(first.share.id);

  expect(await jsonBody(revoked, v.object({ listing: v.optional(v.literal('pending')) }))).toEqual({});
  expect((await listed()).map((row) => row.id)).toEqual([second.share.id]);

  Object.assign(userDO, { putWorkspaceOverview: failing });
  const behind = await revoke(second.share.id);

  expect(behind.status).toBe(200);
  expect(await jsonBody(behind, v.object({ listing: v.optional(v.literal('pending')) }))).toEqual({ listing: 'pending' });
});

test("a named person's Drive holds the share's card from the owner's account, wakes no owner workspace, and loses it on revoke", async () => {
  const world = await twoUserWorld();
  cleanups.push(world.close);
  const owner = identityOf(OWNER_ID, 'owner@example.test');
  const viewer = identityOf(VIEWER_ID, 'pat@example.test');

  const library = async () => {
    world.acquired.splice(0);
    const answer = present(await sharedRequest(world.env, viewer, new Request('https://app.test/api/shared')), 'the library answer');

    return { received: (await jsonBody(answer, SharedLibrarySchema)).received, woke: [...world.acquired] };
  };

  const shared = present(await sharedRequest(world.env, owner, post('/api/shared/live', {
    workspace: 'issues-owner', slate: 'issues', visibility: 'users', emails: ['pat@example.test'],
  })), 'the share answer');

  expect(shared.status).toBe(201);
  const created = await jsonBody(shared, LiveShareCreatedSchema);

  // The answer names whom the share was made for, as the share now records them.
  expect(created.share.users).toEqual(['pat@example.test']);

  // Delivered by the owner's account's job, not by the request: until it runs, the Drive holds nothing.
  expect((await library()).received).toEqual([]);
  await world.ownerUser.userDO.alarm();
  const delivered = await library();

  expect(delivered.received).toEqual([expect.objectContaining({
    id: created.share.id, kind: 'live', share: created.share.id, title: 'Issue triage', workspace: 'issues-owner', owner: 'owner@example.test',
  })]);
  expect(delivered.woke).not.toContain('issues-owner');

  const revoked = present(await sharedRequest(world.env, owner, post('/api/shared/revoke', { workspace: 'issues-owner', share: created.share.id })), 'the revoke answer');

  expect(revoked.status).toBe(200);
  await world.ownerUser.userDO.alarm();
  expect((await library()).received).toEqual([]);
});

/** What the person a share names holds, read as their Drive reads it. */
async function heldBy(world: World, identity: AuthIdentity) {
  const answer = present(await sharedRequest(world.env, identity, new Request('https://app.test/api/shared')), 'the library answer');

  return (await jsonBody(answer, SharedLibrarySchema)).received;
}

/** The owner shares the issues slate with pat, live; the card is delivered only when the owner's alarm runs. */
async function shareWithPat(world: World, owner: AuthIdentity) {
  const shared = present(await sharedRequest(world.env, owner, post('/api/shared/live', {
    workspace: 'issues-owner', slate: 'issues', visibility: 'users', emails: ['pat@example.test'],
  })), 'the share answer');

  expect(shared.status).toBe(201);

  return await jsonBody(shared, LiveShareCreatedSchema);
}

test("a share is unseen until its person opens Shared, on any device, and one made after that is unseen again", async () => {
  const world = await twoUserWorld();
  cleanups.push(world.close);
  const owner = identityOf(OWNER_ID, 'owner@example.test');
  const viewer = identityOf(VIEWER_ID, 'pat@example.test');
  const unseen = async () => (await heldBy(world, viewer)).map((row) => row.unseen === true);

  await shareWithPat(world, owner);
  await world.ownerUser.userDO.alarm();
  expect(await unseen()).toEqual([true]);

  expect(present(await sharedRequest(world.env, viewer, post('/api/shared/seen', {})), 'the seen answer').status).toBe(200);
  expect(await unseen()).toEqual([false]);

  // Reaching pat a minute after Shared was opened.
  setSystemTime(new Date(Date.now() + 60_000));

  try {
    const again = present(await sharedRequest(world.env, owner, post('/api/shared/live', {
      workspace: 'issues-owner', slate: 'issues', visibility: 'users', emails: ['pat@example.test'], fork: false,
    })), 'the second share answer');

    expect(again.status).toBe(201);
    await world.ownerUser.userDO.alarm();
    expect((await unseen()).filter(Boolean)).toHaveLength(1);
    expect(await unseen()).toHaveLength(2);
  } finally {
    setSystemTime();
  }
});

/** The account delete as its route runs it: the typed email, then the forget sweep, then the object's teardown. */
async function deleteAccount(world: World, owner: AuthIdentity): Promise<number> {
  const request = new Request('https://app.test/api/user/account', {
    method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: owner.email }),
  });

  // The control plane's Gallery forgets the account's stars and reports; none here to forget.
  const ControlPlaneDO = { idFromName: (name: string) => name, get: () => ({ galleryForget: async () => undefined }) };

  return present(await serveFamily(accountRoutes, { identity: owner })(request, { ...world.env, ControlPlaneDO }), 'the delete answer').status;
}

test("an account deleted while a card's removal is pending tells that person to forget it", async () => {
  const world = await twoUserWorld();
  cleanups.push(world.close);
  const owner = identityOf(OWNER_ID, 'owner@example.test');
  const viewer = identityOf(VIEWER_ID, 'pat@example.test');
  const created = await shareWithPat(world, owner);
  await world.ownerUser.userDO.alarm();
  expect(await heldBy(world, viewer)).toHaveLength(1);

  // The revoke queues the card's removal and drops its sent row; the alarm that would deliver it never runs.
  await sharedRequest(world.env, owner, post('/api/shared/revoke', { workspace: 'issues-owner', share: created.share.id }));
  expect(await deleteAccount(world, owner)).toBe(200);
  expect(await heldBy(world, viewer)).toEqual([]);
});

test("a card's delivery retried after the account's withdrawal sends nothing, and the card stays forgotten", async () => {
  const world = await twoUserWorld();
  cleanups.push(world.close);
  const owner = identityOf(OWNER_ID, 'owner@example.test');
  const viewer = identityOf(VIEWER_ID, 'pat@example.test');
  const recipient = world.viewerUser.userDO;
  const put = recipient.shareCards_put.bind(recipient);
  const refused = Promise.withResolvers<void>();
  let puts = 0;

  // The first delivery fails, so the driver retries it after a backoff the delete lands inside.
  Object.assign(recipient, {
    shareCards_put: async (...args: Parameters<typeof put>) => {
      puts += 1;

      if (puts > 1) return await put(...args);
      refused.resolve();
      throw new KinuError('unavailable', "pat's account is restarting");
    },
  });
  // The longest backoff the driver draws, so its retry comes after the delete rather than racing it.
  const random = Math.random;
  Math.random = () => 0.999;

  try {
    await shareWithPat(world, owner);
    const driving = world.ownerUser.userDO.alarm();
    await refused.promise;
    expect(await deleteAccount(world, owner)).toBe(200);
    await Promise.allSettled([driving]);
  } finally {
    Math.random = random;
  }

  expect(await heldBy(world, viewer)).toEqual([]);
});

test("a share whose recipients' tile cannot be pushed says the list is behind, whichever write it was", async () => {
  const world = await twoUserWorld();
  cleanups.push(world.close);
  const userDO = world.ownerUser.userDO;
  const push = userDO.putWorkspaceOverview.bind(userDO);

  // Only the tile that names the recipient fails: the share's own push lands, and the cards are sent from that tile.
  Object.assign(userDO, {
    putWorkspaceOverview: async (...args: Parameters<typeof push>) => {
      if (args[2].shares.some((share) => share.users.length > 0)) throw new KinuError('unavailable', 'the roster is unavailable');

      return await push(...args);
    },
  });

  const answer = present(await sharedRequest(world.env, identityOf(OWNER_ID, 'owner@example.test'), post('/api/shared/live', {
    workspace: 'issues-owner', slate: 'issues', visibility: 'users', emails: ['pat@example.test'],
  })), 'the share answer');

  expect(answer.status).toBe(201);
  expect(await jsonBody(answer, v.object({ listing: v.optional(v.literal('pending')) }))).toEqual({ listing: 'pending' });
});

test("a share on its owner's access is refused where the slate is not at the revision they reviewed, and none is left made", async () => {
  const world = await twoUserWorld();
  cleanups.push(world.close);
  const owner = identityOf(OWNER_ID, 'owner@example.test');
  const approved = [{ slate: 'issues', namespace: 'mcp.github', member: 'create_issue' }];
  const open = async () => openShares(world);
  const mode = (body: Readonly<Record<string, JsonValue>>) => sharedRequest(world.env, owner, post(LIVE_SHARE_MODE_PATH, { workspace: 'issues-owner', ...body }));

  // No slate process runs here, so the slate has no revision a review could have read.
  expect(answered(await world.owner.agent.slate({ op: 'graph', id: 'issues' }), SlateReachSchema).revision).toBeNull();

  const refused = await sharedRequest(world.env, owner, post('/api/shared/live', {
    workspace: 'issues-owner', slate: 'issues', visibility: 'public', mode: 'owner', revision: 'a-revision-it-is-not-at', approved,
  }));

  expect(refused?.status).toBe(400);
  expect(await open()).toEqual([]);

  const made = await sharePublic(world, 'public');

  expect((await mode({ share: made.share.id, mode: 'owner', revision: 'a-revision-it-is-not-at', approved }))?.status).toBe(400);
  expect((await mode({ share: 'no-such-share', mode: 'own' }))?.status).toBe(404);
  expect(await jsonBody(present(await mode({ share: made.share.id, mode: 'own' }), 'the mode answer'), LiveShareRecordSchema))
    .toMatchObject({ id: made.share.id, mode: 'own', grantRevision: null });
});

test("a live share its owner lists tells the Gallery its card, stays off the owner's access, and leaves the Gallery with its revoke", async () => {
  const world = await twoUserWorld();
  cleanups.push(world.close);
  const owner = identityOf(OWNER_ID, 'owner@example.test');
  const synced: GalleryListingSync[] = [];
  const listing = (body: Readonly<Record<string, JsonValue>>) => sharedRequest(world.env, owner, post(LIVE_SHARE_LISTING_PATH, { workspace: 'issues-owner', ...body }));

  // The workspace tells the Gallery in the background: observed as the control plane receives it.
  const told = async () => {
    await until(() => synced.length > 0, 'the Gallery told of the listing');

    return synced.splice(0);
  };

  tellGalleryInto(world, synced);
  const made = await sharePublic(world, 'public');
  const card = { line: 'Triage the open issues', category: 'work' } satisfies { line: string; category: GalleryCategory };

  expect((await listing({ share: made.share.id, listed: true, line: 'x'.repeat(141), category: 'work' }))?.status).toBe(400);
  expect(await jsonBody(present(await listing({ share: made.share.id, listed: true, ...card }), 'the listing answer'), LiveShareRecordSchema))
    .toMatchObject({ id: made.share.id, mode: 'own', gallery: card });
  expect(await told()).toEqual([{
    share: made.share.id, workspace: 'issues-owner', slate: 'issues', handle: made.share.handle, listed: true, url: present(made.url, 'the share URL'),
    card: { title: 'Issue triage', ...card, ownerName: expect.any(String), picture: null },
  }]);

  // Its Gallery page names, from the share its index lists, the connections a visitor's own parts will ask them for.
  const page = async () => {
    const listed = {
      workspace: 'issues-owner', slate: 'issues', share: made.share.id, title: 'Issue triage', ...card, owner: { name: 'Owner' },
      stars: 0, starred: false, listedAt: 1, featured: false, url: present(made.url, 'the share URL'),
    };

    const ControlPlaneDO = { idFromName: (name: string) => name, get: () => ({ gallerySlate: async (): Promise<GallerySlate | null> => ({ listing: listed }) }) };
    const partialEnv: Partial<Env> = {};

    Object.assign(partialEnv, { ...world.env, ControlPlaneDO });
    // SAFETY: the Gallery's page reaches the control plane's gallerySlate alone; the rest is the world's own env.
    const env = partialEnv as Env;
    const read = present(await serveFamily(galleryRoutes)(new Request('https://app.test/api/gallery/issues-owner/issues'), env), 'the Gallery page');

    return (await jsonBody(read, GallerySlateSchema)).needs;
  };

  expect(await page()).toEqual([{ kind: 'github', title: 'github' }]);

  // Listed, it is never put on the owner's access.
  const refused = present(await sharedRequest(world.env, owner, post(LIVE_SHARE_MODE_PATH, {
    workspace: 'issues-owner', share: made.share.id, mode: 'owner', revision: 'any', approved: [],
  })), 'the mode answer');

  expect({ status: refused.status, body: await refused.text() }).toMatchObject({ status: 400, body: expect.stringContaining('Take it off the Gallery first') });
  expect((await sharedRequest(world.env, owner, post('/api/shared/revoke', { workspace: 'issues-owner', share: made.share.id })))?.status).toBe(200);
  expect(await told()).toEqual([{ share: made.share.id, workspace: 'issues-owner', slate: 'issues', handle: made.share.handle, listed: false }]);
  // Off the Gallery, its share says nothing of what it reaches to a page the index still held.
  expect(await page()).toBeUndefined();
});

test("a slate's first share can start empty: a copy made now, code only, named as a copy, and none made when refused", async () => {
  const world = await twoUserWorld();
  cleanups.push(world.close);
  const owner = identityOf(OWNER_ID, 'owner@example.test');
  const files = workspaceFiles(world.owner.agent);
  const slates = async () => (await world.owner.agent.listSlates()).slates.map((slate) => slate.id);

  const share = (body: Readonly<Record<string, JsonValue>>) => sharedRequest(world.env, owner, post('/api/shared/live', {
    workspace: 'issues-owner', slate: 'issues', visibility: 'public', start: 'empty', ...body,
  }));

  // A copy has run nothing: it is never shared on the owner's access, nor with anything approved on it.
  expect((await share({ mode: 'owner', revision: 'any' }))?.status).toBe(400);
  expect((await share({ approved: [{ slate: 'issues', namespace: 'mcp.github', member: 'create_issue' }] }))?.status).toBe(400);
  expect(await slates()).toEqual(['issues']);

  // A slate whose manifest no copy could carry is refused before any copy is made.
  await files.mkdir('/slates/broken', { recursive: true });
  await writeText(files, '/slates/broken/package.json', '{ not a manifest');
  expect((await share({ slate: 'broken' }))?.status).toBe(400);
  expect([...await files.readdir('/slates')].map((entry) => entry.name).sort()).toEqual(['broken', 'issues']);

  const made = await jsonBody(present(await share({}), 'the share answer'), LiveShareCreatedSchema);
  const copy = made.share.slate;

  expect({ copy: copy === 'issues', mode: made.share.mode, slates: [...await slates()].sort() }).toEqual({ copy: false, mode: 'own', slates: [copy, 'issues'].sort() });
  expect(JSON.parse(await readText(files, `/slates/${copy}/package.json`))).toMatchObject({ slate: { title: 'Issue triage (shared copy)' }, description: 'Triage the open issues' });
  expect(await readText(files, `/slates/${copy}/src/server.ts`)).toBe(await readText(files, '/slates/issues/src/server.ts'));
});

test("a viewer's cookie acts on its share only from the share's own origin: a sibling host's post or socket is refused", async () => {
  const world = await twoUserWorld();
  cleanups.push(world.close);

  const created = await sharePublic(world, 'public');
  const url = await hostOf(world, created.share.handle);
  const minted = await visit(world, url, '203.0.113.4', { path: CONSENT_PATH });
  const cookie = present(minted?.headers.get('set-cookie')?.split(';')[0], 'the viewer cookie');
  const own = new URL(url).origin;

  const send = async (init: { cookie?: string; origin?: string; upgrade?: true }) => {
    const headers = new Headers({ 'cf-connecting-ip': '203.0.113.4', 'content-type': 'application/json' });

    if (init.cookie !== undefined) headers.set('cookie', init.cookie);

    if (init.origin !== undefined) headers.set('origin', init.origin);

    if (init.upgrade) headers.set('upgrade', 'websocket');
    const request = new Request(`${url}__rpc`, init.upgrade ? { headers } : { method: 'POST', headers, body: '[]' });

    return present(await handleSlateShareHostRequest(request, world.env), 'the share host answer').status;
  };

  // A hostile sibling preview is same-site, so the victim's cookie rides along; only the share's own origin acts with it.
  expect(await send({ cookie, origin: 'https://hostile-preview.share.test' })).toBe(403);
  expect(await send({ cookie, origin: 'https://hostile-preview.share.test', upgrade: true })).toBe(403);
  expect(await send({ cookie })).toBe(403);
  expect(await send({ cookie, origin: own })).not.toBe(403);
  // With no cookie a request acts as no one in particular, from wherever it comes.
  expect(await send({ origin: 'https://hostile-preview.share.test' })).not.toBe(403);
});

test("a share's one link is the app's page for it: a public share opens there signed out, a named one asks to sign in", async () => {
  const world = await twoUserWorld();
  cleanups.push(world.close);

  const made = await sharePublic(world, 'public');
  const entry = new URL(present(made.url, 'the share link'));
  const { params } = present(matchPath(APP_ROUTES.sharedLive, entry.pathname), 'the app page for the share');

  expect([entry.origin, params.workspace, params.share]).toEqual([APP_ORIGIN, 'issues-owner', made.share.id]);

  // The page asks where to frame it, signed out, and is told its bare host, which it alone ever holds.
  const open = async (share: string) => present(await openShare(world, { workspace: 'issues-owner', share }), 'the open answer');

  expect(await jsonBody(await open(made.share.id), LiveShareOpenSchema))
    .toEqual({ url: present(await world.owner.agent.liveShareUrl(made.share.handle), 'the share host'), slate: 'issues', title: 'Issue triage' });

  const named = await sharePublic(world, 'users');

  expect((await open(named.share.id)).status).toBe(401);
});

test("a slate removed, or its workspace deleted, ends its shares and takes its listing off the Gallery first", async () => {
  const world = await twoUserWorld();
  cleanups.push(world.close);
  const owner = identityOf(OWNER_ID, 'owner@example.test');
  const synced: GalleryListingSync[] = [];
  const open = async () => openShares(world);

  tellGalleryInto(world, synced);

  const list = async () => {
    const made = await sharePublic(world, 'public');

    await sharedRequest(world.env, owner, post(LIVE_SHARE_LISTING_PATH, { workspace: 'issues-owner', share: made.share.id, listed: true, line: 'Triage', category: 'work' }));
    synced.splice(0);

    return made.share.id;
  };

  const removed = await list();

  // No app runs here for the removal to stop, so the op answers that after the rest; its shares end before it.
  await world.owner.agent.slate({ op: 'remove', id: 'issues' });
  expect(synced.map((sync) => [sync.share, sync.listed])).toEqual([[removed, false]]);
  expect(await open()).toEqual([]);

  // The slate made again and shared, then its whole workspace deleted.
  await authorIssuesSlate(workspaceFiles(world.owner.agent));
  await exerciseIssuesSlate(world.owner.agent);
  const deleted = await list();

  await world.owner.agent.quietForDeletion(OWNER_ID);
  expect(synced.map((sync) => [sync.share, sync.listed])).toEqual([[deleted, false]]);
  expect(await open()).toEqual([]);
});

test("a slate's standing approvals are its owner's to list and take back, from every share of it, and no one else's", async () => {
  const world = await twoUserWorld();
  cleanups.push(world.close);
  const owner = identityOf(OWNER_ID, 'owner@example.test');
  const stranger = identityOf(VIEWER_ID, 'pat@example.test');
  const made = [await sharePublic(world, 'public'), await sharePublic(world, 'public')];
  const create = { slate: 'issues', namespace: 'mcp.github', member: 'create_issue', root: { owner: 'acme', repo: 'kinu' } };

  // As an owner's "Always for this slate" leaves its owner shares (the decision is the queue's): seeded in their rows.
  for (const { share } of made) {
    world.owner.db.query("UPDATE slate_live_shares SET mode = 'owner', grant_revision = 'rev-1', grant_json = ? WHERE id = ?")
      .run(JSON.stringify({ ...share.grant, preapproved: [{ ...create, revision: 'rev-1' }] }), share.id);
  }

  const ask = (identity: AuthIdentity, path: string, body: Readonly<Record<string, JsonValue>>) => sharedRequest(world.env, identity, post(path, { workspace: 'issues-owner', ...body }));
  const held = async () => (await openShares(world)).map((share) => share.grant.preapproved ?? []);

  // Another account reaches no slate of this workspace's, to read or to take back.
  expect((await ask(stranger, LIVE_SHARE_PREAPPROVALS_PATH, { slate: 'issues' }))?.status).toBe(404);
  expect((await ask(stranger, LIVE_SHARE_PREAPPROVAL_WITHDRAW_PATH, { slate: 'issues', entry: create }))?.status).toBe(404);
  expect(await held()).toEqual([[{ ...create, revision: 'rev-1' }], [{ ...create, revision: 'rev-1' }]]);

  // The slate is at no revision here, so none of them stands to list.
  expect(await jsonBody(present(await ask(owner, LIVE_SHARE_PREAPPROVALS_PATH, { slate: 'issues' }), 'the list'), SlatePreapprovalsSchema))
    .toEqual({ slate: 'issues', revision: null, preapproved: [] });

  const withdrawn = present(await ask(owner, LIVE_SHARE_PREAPPROVAL_WITHDRAW_PATH, { slate: 'issues', entry: create }), 'the withdrawal');

  expect(await jsonBody(withdrawn, SlatePreapprovalsSchema)).toEqual({ slate: 'issues', revision: null, preapproved: [] });
  expect(await held()).toEqual([[], []]);
});
