/**
 * The roster as the owner's object answers it: the tile each workspace pushed rides its entry, with the owner's
 * release approvals among its decisions; a filter or search pages the roster while the counts stay whole; and an
 * open page is told each change once, over its socket, and nothing for a push that changed nothing.
 */
import * as v from 'valibot';
import { describe, expect, test } from 'bun:test';
import type { UserCaller, WorkspaceOverview } from '@kinu.run/core';
import { createTestUserDO, provisionTestWorkspace, testOwner, type TestUserDO } from './helpers/user-do';

const USER_ID = '0123456789abcdef0123456789abcdef';

const QUIET: WorkspaceOverview = { activity: 'idle', decisionsWaiting: 0, hasUpdates: false, latestRun: null, slates: [] };

const FrameSchema = v.object({
  type: v.literal('workspace'),
  name: v.string(),
  entry: v.nullable(v.object({ name: v.string(), overview: v.nullable(v.object({ activity: v.string(), decisionsWaiting: v.number() })) })),
  counts: v.object({ all: v.number(), needs: v.number(), working: v.number(), idle: v.number(), decisions: v.number() }),
});

/** The owner's page, listening: every frame the object sends it. */
async function openPage(harness: TestUserDO): Promise<() => Array<v.InferOutput<typeof FrameSchema>>> {
  const accepted = harness.acceptedSockets.length;
  const answer = await harness.userDO.fetch(new Request('https://kinu.test/roster/live', { headers: { Upgrade: 'websocket' } }));

  expect(answer.status).toBe(101);
  const socket = harness.acceptedSockets[accepted];

  if (socket === undefined) throw new Error('the object accepted no roster socket');

  return () => socket.sent.map((text) => v.parse(FrameSchema, JSON.parse(text)));
}

async function workspace(harness: TestUserDO, name: string): Promise<UserCaller> {
  return { workspaceToken: await provisionTestWorkspace(harness, name) };
}

describe('the pushed tile', () => {
  test("rides its roster entry, with the owner's pending release approvals among its decisions", async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const owner = await testOwner();
    const ledger = await workspace(harness, 'ledger');
    await harness.userDO.putWorkspaceOverview(ledger, 'ledger', { ...QUIET, decisionsWaiting: 1 });

    const source = await harness.userDO.upsertReleaseSource(owner, { kind: 'github', label: 'o/r', repoUrl: 'https://github.com/o/r' });
    const change = await harness.userDO.createReleaseChange(owner, 'ledger', { bindingId: source.id, userPrompt: 'ship it' });
    const approval = await harness.userDO.requestReleaseApproval(owner, change.id, 'rollback');

    const [entry] = (await harness.userDO.listWorkspaces(owner)).entries;
    expect(entry?.overview).toMatchObject({ activity: 'idle', decisionsWaiting: 2 });
    expect((await harness.userDO.listWorkspaces(owner, { bucket: 'needs' })).entries.map((each) => each.name)).toEqual(['ledger']);

    await harness.userDO.decideReleaseApproval(owner, { approvalId: approval.id, decision: 'approved', approvedBy: USER_ID });
    expect((await harness.userDO.listWorkspaces(owner)).entries[0]?.overview?.decisionsWaiting).toBe(1);
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

    // One that never pushed reads idle.
    await harness.userDO.registerWorkspace(owner, 'silent');

    const needs = await harness.userDO.listWorkspaces(owner, { bucket: 'needs' });
    expect(needs.entries.map((each) => each.name).sort()).toEqual(['budget', 'ledger']);
    expect(needs.total).toBe(2);
    expect(needs.counts).toEqual({ all: 5, needs: 2, working: 1, idle: 2, decisions: 3 });

    expect((await harness.userDO.listWorkspaces(owner, { bucket: 'idle' })).entries.map((each) => each.name).sort())
      .toEqual(['garden', 'silent']);
    expect((await harness.userDO.listWorkspaces(owner, { query: 'GAR' })).entries.map((each) => each.name)).toEqual(['garden']);

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
