/**
 * The roster as the owner's object answers it: the tile each workspace pushed rides its entry, with the owner's
 * release approvals among its decisions; a filter or search pages the roster while the counts stay whole; and an
 * open page is told each change once, over its socket, and nothing for a push that changed nothing. On the same
 * socket it hears what account-memory proposals wait on the owner, as it opens and as each is filed or decided,
 * for as long as the browser session it was opened under stands.
 */
import * as v from 'valibot';
import { describe, expect, setSystemTime, test } from 'bun:test';
import { WS_OPEN, type UserCaller, type WorkspaceOverview } from '@kinu.run/core';
import type { AuthIdentity } from '../src/auth/session';
import { SESSION_BEARER_HEADER } from '../src/cli/rpc-gate';
import { userRoutes, type UserRoutesEnv } from '../src/user/routes';
import { serveFamily } from './helpers/api';
import { nextTurn, until } from './helpers/actor-harness';
import { bootstrappedProfile, userAccount } from './helpers/bindings';
import { createTestUserDO, provisionTestWorkspace, TEST_CREDENTIAL_ENCRYPTION_KEY, testOwner, type TestUserDO } from './helpers/user-do';

const USER_ID = '0123456789abcdef0123456789abcdef';

const QUIET: WorkspaceOverview = { activity: 'idle', decisionsWaiting: 0, hasUpdates: false, latestRun: null, slates: [], shares: [] };

const FrameSchema = v.object({
  type: v.literal('workspace'),
  name: v.string(),
  entry: v.nullable(v.object({ name: v.string(), overview: v.nullable(v.object({ activity: v.string(), decisionsWaiting: v.number() })) })),
  counts: v.object({ all: v.number(), needs: v.number(), working: v.number(), idle: v.number(), decisions: v.number() }),
});

const MemoryFrameSchema = v.object({
  type: v.literal('account_memory'),
  pending: v.array(v.object({ id: v.string(), proposal: v.object({ kind: v.string() }) })),
});

type Frame = v.InferOutput<typeof FrameSchema> | v.InferOutput<typeof MemoryFrameSchema>;

/** The owner's page, listening: every frame the object sends it, by kind, and whether its socket is still open. */
interface Page {
  frames(): Frame[];
  open(): boolean;
}

/** Opens the page's roster socket. `session`: the hash the edge writes into the upgrade of a signed-in browser; none,
 *  as under the dev identity. */
async function listen(harness: TestUserDO, session?: string): Promise<Page> {
  const accepted = harness.acceptedSockets.length;
  const headers = new Headers({ Upgrade: 'websocket' });

  if (session !== undefined) headers.set(SESSION_BEARER_HEADER, session);
  const answer = await harness.userDO.fetch(new Request('https://kinu.test/roster/live', { headers }));

  expect(answer.status).toBe(101);
  const socket = harness.acceptedSockets[accepted];

  if (socket === undefined) throw new Error('the object accepted no roster socket');

  return {
    frames: () => socket.sent.map((text) => v.parse(v.variant('type', [FrameSchema, MemoryFrameSchema]), JSON.parse(text))),
    open: () => socket.ws.readyState === WS_OPEN,
  };
}

/** The roster's own frames a page hears. */
async function openPage(harness: TestUserDO): Promise<() => Array<v.InferOutput<typeof FrameSchema>>> {
  const page = await listen(harness);

  return () => page.frames().flatMap((frame) => (frame.type === 'workspace' ? [frame] : []));
}

/** What each frame told a page waits on the owner: the proposals' ids, one list per frame. */
const pendings = (page: Page): string[][] => page.frames().flatMap((frame) => (frame.type === 'account_memory' ? [frame.pending.map((row) => row.id)] : []));

/** An agent of `ledger` asks the account to remember a city. */
function propose(harness: TestUserDO, ledger: UserCaller): Promise<string> {
  return harness.userDO.accountMemory_propose(ledger, { kind: 'fact', key: 'owner_city', value: 'Lisbon' }, { by: 'agent', agent: 'main' });
}

async function workspace(harness: TestUserDO, name: string): Promise<UserCaller> {
  return { workspaceToken: await provisionTestWorkspace(harness, name) };
}

describe('the pushed tile', () => {
  test('rides its roster entry, and a waiting decision files it under needs', async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const owner = await testOwner();
    const ledger = await workspace(harness, 'ledger');
    await harness.userDO.putWorkspaceOverview(ledger, 'ledger', { ...QUIET, decisionsWaiting: 1 });

    const [entry] = (await harness.userDO.listWorkspaces(owner)).entries;
    expect(entry?.overview).toMatchObject({ activity: 'idle', decisionsWaiting: 1 });
    expect((await harness.userDO.listWorkspaces(owner, { bucket: 'needs' })).entries.map((each) => each.name)).toEqual(['ledger']);
    harness.close();
  });

  test('a workspace may push only its own tile', async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const ledger = await workspace(harness, 'ledger');
    await workspace(harness, 'notes');

    await expect(harness.userDO.putWorkspaceOverview(ledger, 'notes', QUIET)).rejects.toThrow('may only push its own overview');
    expect((await harness.userDO.listWorkspaces(await testOwner())).entries.map((each) => each.overview)).toEqual([null, null]);
    harness.close();
  });

  test('a workspace torn down leaves no tile for a later one of the same name', async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const owner = await testOwner();
    const ledger = await workspace(harness, 'ledger');
    await harness.userDO.putWorkspaceOverview(ledger, 'ledger', { ...QUIET, activity: 'working' });
    await harness.userDO.removeWorkspace(owner, 'ledger', USER_ID);
    await harness.userDO.registerWorkspace(owner, 'ledger');

    expect((await harness.userDO.listWorkspaces(owner)).entries[0]?.overview).toBeNull();
    harness.close();
  });
});

describe('workspaces from before tiles existed', () => {
  test('one roster read asks each for its tile, four at a time, so Needs you is right; the next read asks none', async () => {
    const names = ['ledger', 'notes', 'budget', 'garden', 'plans', 'music'];
    const callers = new Map<string, UserCaller>();
    const answer = Promise.withResolvers<void>();
    const reported = new Set<string>();

    const harness: TestUserDO = createTestUserDO({
      durableObjectId: USER_ID,
      // What the workspace does when asked: folds its stores and pushes. Held, so the asks in flight can be counted.
      overviewNudge: async (name) => {
        await answer.promise;
        const caller = callers.get(name);

        if (caller === undefined) throw new Error(`no capability for ${name}`);
        await harness.userDO.putWorkspaceOverview(caller, name, name === 'ledger' ? { ...QUIET, decisionsWaiting: 1 } : QUIET);
        reported.add(name);
      },
    });

    const owner = await testOwner();

    for (const name of names) callers.set(name, await workspace(harness, name));

    expect((await harness.userDO.listWorkspaces(owner)).counts.unreported).toBe(6);
    await until(() => harness.overviewNudges.length === 4, 'four asks in flight');

    for (let lap = 0; lap < 10; lap++) await nextTurn();
    expect(harness.overviewNudges).toHaveLength(4);
    answer.resolve();
    await until(() => reported.size === 6, 'every workspace reports');
    const needs = await harness.userDO.listWorkspaces(owner, { bucket: 'needs' });
    expect(needs.entries.map((each) => each.name)).toEqual(['ledger']);
    expect(needs.counts.unreported).toBe(0);

    await harness.userDO.listWorkspaces(owner);
    expect([...harness.overviewNudges].sort()).toEqual([...names].sort());
    harness.close();
  });

  test('a failed ask is asked again once its backoff has passed, never before', async () => {
    let refuse = true;
    let answered = false;
    const callers = new Map<string, UserCaller>();

    const harness: TestUserDO = createTestUserDO({
      durableObjectId: USER_ID,
      overviewNudge: async (name) => {
        if (refuse) throw new Error('the workspace is unavailable');
        const caller = callers.get(name);

        if (caller === undefined) throw new Error(`no capability for ${name}`);
        await harness.userDO.putWorkspaceOverview(caller, name, QUIET);
        answered = true;
      },
    });

    const owner = await testOwner();
    callers.set('ledger', await workspace(harness, 'ledger'));

    try {
      await harness.userDO.listWorkspaces(owner);
      await until(() => harness.overviewNudges.length === 1, 'the first ask');

      for (let lap = 0; lap < 10; lap++) await nextTurn();
      await harness.userDO.listWorkspaces(owner);

      for (let lap = 0; lap < 10; lap++) await nextTurn();
      expect(harness.overviewNudges).toHaveLength(1);

      refuse = false;
      setSystemTime(new Date(Date.now() + 10 * 60_000));
      await harness.userDO.listWorkspaces(owner);
      await until(() => answered, 'the second ask is answered');
      expect(harness.overviewNudges).toEqual(['ledger', 'ledger']);
      expect((await harness.userDO.listWorkspaces(owner)).counts.unreported).toBe(0);
    } finally {
      setSystemTime();
      harness.close();
    }
  });

  test('a workspace that never answers is asked six times, then left to its own next visit', async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID, overviewNudge: async () => { throw new Error('the workspace is unavailable'); } });
    const owner = await testOwner();
    await workspace(harness, 'ledger');

    try {
      for (let read = 0; read < 8; read++) {
        await harness.userDO.listWorkspaces(owner);

        for (let lap = 0; lap < 10; lap++) await nextTurn();
        setSystemTime(new Date(Date.now() + 10 * 60_000));
      }

      expect(harness.overviewNudges).toHaveLength(6);
    } finally {
      setSystemTime();
      harness.close();
    }
  });

  test('a workspace deleted while the asks ahead of it are held is never woken', async () => {
    const answer = Promise.withResolvers<void>();
    const harness: TestUserDO = createTestUserDO({ durableObjectId: USER_ID, overviewNudge: async () => { await answer.promise; } });
    const owner = await testOwner();
    const names = ['ledger', 'notes', 'budget', 'garden', 'plans'];

    for (const name of names) await workspace(harness, name);

    await harness.userDO.listWorkspaces(owner);
    await until(() => harness.overviewNudges.length === 4, 'four asks in flight');
    const waiting = names.find((name) => !harness.overviewNudges.includes(name));

    if (waiting === undefined) throw new Error('every workspace was asked at once');
    await harness.userDO.removeWorkspace(owner, waiting, USER_ID);
    answer.resolve();

    for (let lap = 0; lap < 20; lap++) await nextTurn();
    expect(harness.overviewNudges).toHaveLength(4);
    expect(harness.overviewNudges).not.toContain(waiting);
    harness.close();
  });
});

describe('a page of the roster', () => {
  test('a filter and a search page the roster while the counts stay whole', async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const owner = await testOwner();

    const tiles: Array<[string, WorkspaceOverview]> = [
      ['ledger', { ...QUIET, decisionsWaiting: 1 }],
      ['notes', { ...QUIET, activity: 'working' }],
      ['budget', { ...QUIET, activity: 'working', decisionsWaiting: 2 }],
      ['garden', QUIET],
    ];

    for (const [name, tile] of tiles) await harness.userDO.putWorkspaceOverview(await workspace(harness, name), name, tile);

    // One that never reported is unknown, never idle.
    await harness.userDO.registerWorkspace(owner, 'silent');

    const needs = await harness.userDO.listWorkspaces(owner, { bucket: 'needs', limit: 1 });
    const moreNeeds = await harness.userDO.listWorkspaces(owner, { bucket: 'needs', limit: 1, cursor: needs.nextCursor });
    expect([...needs.entries, ...moreNeeds.entries].map((each) => each.name).sort()).toEqual(['budget', 'ledger']);
    expect(moreNeeds.nextCursor).toBeNull();
    expect(needs.total).toBe(2);
    expect(needs.counts).toEqual({ all: 5, needs: 2, working: 1, idle: 1, unreported: 1, decisions: 3 });

    expect((await harness.userDO.listWorkspaces(owner, { bucket: 'idle' })).entries.map((each) => each.name)).toEqual(['garden']);
    const silent = (await harness.userDO.listWorkspaces(owner)).entries.find((each) => each.name === 'silent');
    expect(silent).toMatchObject({ overview: null, decisions: 0 });

    const search = await harness.userDO.listWorkspaces(owner, { query: 'GAR' });
    expect(search.entries.map((each) => each.name)).toEqual(['garden']);
    expect(search.total).toBe(1);

    const first = await harness.userDO.listWorkspaces(owner, { limit: 2 });
    const rest = await harness.userDO.listWorkspaces(owner, { limit: 2, cursor: first.nextCursor });
    const last = await harness.userDO.listWorkspaces(owner, { limit: 2, cursor: rest.nextCursor });
    expect([...first.entries, ...rest.entries, ...last.entries].map((each) => each.name).sort())
      .toEqual(['budget', 'garden', 'ledger', 'notes', 'silent']);
    expect(last.nextCursor).toBeNull();
    harness.close();
  });
});

describe("an open page's socket", () => {
  test('hears a change once, and nothing for a push that changed nothing', async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const ledger = await workspace(harness, 'ledger');
    const frames = await openPage(harness);

    await harness.userDO.putWorkspaceOverview(ledger, 'ledger', { ...QUIET, activity: 'working' });
    await harness.userDO.putWorkspaceOverview(ledger, 'ledger', { ...QUIET, activity: 'working' });
    await harness.userDO.putWorkspaceOverview(ledger, 'ledger', QUIET);

    expect(frames().map((frame) => frame.entry?.overview?.activity)).toEqual(['working', 'idle']);
    expect(frames().at(-1)?.counts).toMatchObject({ all: 1, working: 0, idle: 1 });
    harness.close();
  });

  test('hears a workspace leave the roster', async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const owner = await testOwner();
    await workspace(harness, 'ledger');
    const frames = await openPage(harness);

    await harness.userDO.removeWorkspace(owner, 'ledger', USER_ID);

    expect(frames().at(-1)).toMatchObject({ name: 'ledger', entry: null, counts: { all: 0 } });
    harness.close();
  });
});

describe("the owner's page hears what account memory waits on them", () => {
  test('as it opens, and again as a proposal is filed and as it is decided', async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const owner = await testOwner();
    const ledger = await workspace(harness, 'ledger');
    const page = await listen(harness);

    const id = await propose(harness, ledger);
    await harness.userDO.accountMemory_decide(owner, id, 'accept');

    expect(pendings(page)).toEqual([[], [id], []]);
    harness.close();
  });
});

const SESSION_A = 'a'.repeat(64);

const SESSION_B = 'b'.repeat(64);

const SESSION_C = 'c'.repeat(64);

/** A browser session as sign-in registers it: the row every frame to its page is sent under. */
async function signIn(harness: TestUserDO, tokenHash: string, options: { readonly expiresAt?: number; readonly credentialGeneration?: number } = {}): Promise<void> {
  await harness.userDO.registerBrowserSession(await testOwner(), tokenHash, options.expiresAt ?? Date.now() + 60_000, {
    email: 'person@example.com', displayName: 'Person', provider: 'cloudflare', sub: 'cf-1', authTime: Date.now(),
    ...(options.credentialGeneration !== undefined && { credentialGeneration: options.credentialGeneration }),
  });
}

describe('a roster socket lives on the browser session it was opened under', () => {
  test('a page signed out is closed and hears nothing more, while every other page hears the proposal', async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const owner = await testOwner();
    const ledger = await workspace(harness, 'ledger');
    await signIn(harness, SESSION_A);
    await signIn(harness, SESSION_B);
    const signedOut = await listen(harness, SESSION_A);
    const signedIn = await listen(harness, SESSION_B);
    // Opened under no session (the dev identity, which no session backs): no logout is its.
    const unbacked = await listen(harness);

    await harness.userDO.revokeBrowserSession(owner, SESSION_A);
    expect(signedOut.open()).toBe(false);

    const id = await propose(harness, ledger);

    expect(pendings(signedOut)).toEqual([[]]);
    expect([pendings(signedIn), pendings(unbacked)]).toEqual([[[], [id]], [[], [id]]]);
    expect([signedIn.open(), unbacked.open()]).toEqual([true, true]);
    harness.close();
  });

  test('a raised credential floor ends every page of the account, and a sign-in under the new floor hears again', async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const owner = await testOwner();
    const ledger = await workspace(harness, 'ledger');
    await signIn(harness, SESSION_A);
    await signIn(harness, SESSION_B);
    const ended = [await listen(harness, SESSION_A), await listen(harness, SESSION_B)];

    await harness.userDO.raiseCredentialFloor(owner, 1);
    expect(ended.map((page) => page.open())).toEqual([false, false]);

    await signIn(harness, SESSION_C, { credentialGeneration: 1 });
    const renewed = await listen(harness, SESSION_C);
    const id = await propose(harness, ledger);

    expect(ended.map((page) => pendings(page))).toEqual([[[]], [[]]]);
    expect(pendings(renewed)).toEqual([[], [id]]);
    harness.close();
  });

  test('a page whose session has lapsed is closed at the next frame, never sent it', async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const ledger = await workspace(harness, 'ledger');
    await signIn(harness, SESSION_A, { expiresAt: Date.now() + 60_000 });
    const page = await listen(harness, SESSION_A);

    try {
      setSystemTime(new Date(Date.now() + 61_000));
      await propose(harness, ledger);

      expect(pendings(page)).toEqual([[]]);
      expect(page.open()).toBe(false);
    } finally {
      setSystemTime();
      harness.close();
    }
  });
});

describe("the roster socket the edge hands the owner's object", () => {
  test('names the session the edge verified, whichever session the page claims', async () => {
    const handed: Request[] = [];

    const stub = userAccount({
      async ensureProfile(_caller: UserCaller, email: string) { return bootstrappedProfile(email); },
      async userMcp_warmConnections() { return { servers: 0 }; },
      async fetch(request: Request) {
        handed.push(request);

        return new Response(null, { status: 200 });
      },
    });

    const env: UserRoutesEnv<string> = {
      UserDO: { idFromName: (name) => name, get: () => stub },
      OrchestratorAgent: { idFromName: (name) => name, get: () => { throw new Error('a roster upgrade asked a workspace'); } },
      CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    };

    const verified: AuthIdentity = { userId: USER_ID, email: 'owner@example.com', sub: 'sub', provider: 'test', authTime: Date.now(), sessionTokenHash: SESSION_A };

    const answer = await serveFamily(userRoutes, { identity: verified, ctx: { waitUntil() {} } })(
      new Request('https://kinu.example.com/api/user/workspaces/live', { headers: { Upgrade: 'websocket', [SESSION_BEARER_HEADER]: SESSION_B } }), env,
    );

    expect(answer).not.toBeNull();
    expect(handed.map((request) => request.headers.get(SESSION_BEARER_HEADER))).toEqual([SESSION_A]);
  });
});
