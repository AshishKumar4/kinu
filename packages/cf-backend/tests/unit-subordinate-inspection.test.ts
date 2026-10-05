import { seedTranscriptEntry } from '@kinu.run/test-utils';
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { createTestWorkspace, makeSqlExec } from '../../core/tests/helpers';
import { createTestActorsOver } from '@kinu.run/test-utils';
import {
  CHAT_SESSION_ID,
  RunEventRecorder,
  SessionHistory,
  SubordinateRosterStore,
  SubordinateInspectionRequestSchema,
  actorReferenceOf,
  inspectSubordinateStorage, readSessionTranscript, readSubordinateInspection,
  type ActorHandle,
  type SubordinateInspectionAccess,
  type SubordinateInspectionRequest,
  type WorkspaceActorDirectory,
} from '@kinu.run/core';

interface InspectionFixture {
  readonly sql: ReturnType<typeof createTestWorkspace>['sql'];
  readonly raw: ReturnType<typeof makeSqlExec>;
  readonly directory: WorkspaceActorDirectory;
  readonly main: ActorHandle;
  readonly access: SubordinateInspectionAccess;
  child(parent: ActorHandle, name: string): ActorHandle;
  roster(parent: ActorHandle): SubordinateRosterStore;
  history(actor: ActorHandle): SessionHistory;
}

/** One database for every actor, and the directory walk is the only traversal authority, as in the product. */
function workspaceFixture(): InspectionFixture {
  const created = createTestWorkspace();
  const raw = makeSqlExec(created.db);
  const actors = createTestActorsOver(created.db, { name: 'workspace' });
  const histories = new Map<string, SessionHistory>();

  // Memoized: the walk reaches one transcript twice per request, and two stores would be two readers of one row set.
  const history = (actor: ActorHandle): SessionHistory => {
    const existing = histories.get(actor.actorId);

    if (existing !== undefined) return existing;

    const built = new SessionHistory({
      sql: created.sql, actor, transactionSync: (write) => created.db.transaction(write)(),
      files: async () => ({ vfs: created.vfs, artifactDirectory: `/actors/${actor.actorId}/.kinu/context` }),
    });

    histories.set(actor.actorId, built);

    return built;
  };

  const access: SubordinateInspectionAccess = {
    sql: created.sql,
    raw,
    actor: actors.main,
    directory: actors.directory,
    transcriptFor: (actor) => history(actor).transcript(CHAT_SESSION_ID),
    // One database holds every actor's rows here.
    ownRows: (actor, own) => readSubordinateInspection({ sql: created.sql, raw, actor, transcriptFor: () => readSessionTranscript(created.sql, actor, CHAT_SESSION_ID, null) }, own),
  };

  return {
    sql: created.sql,
    raw,
    directory: actors.directory,
    main: actors.main,
    access,
    history,
    child(parent: ActorHandle, name: string): ActorHandle {
      return actors.directory.create({
        parent,
        name,
        creationId: `${parent.name}/${name}`,
        origin: 'agent',
        lifetime: 'task',
      });
    },
    roster(parent: ActorHandle): SubordinateRosterStore {
      const roster = new SubordinateRosterStore(raw, parent);
      roster.ensureSchema();

      return roster;
    },
  };
}

function read(
  fixture: InspectionFixture,
  request: SubordinateInspectionRequest,
  authority = { owner: '', workspace: 'workspace' },
) {
  return inspectSubordinateStorage(fixture.access, request, authority);
}

function rosterChild(
  fixture: InspectionFixture,
  parent: ActorHandle,
  child: ActorHandle,
  createdAt: number,
): void {
  const name = child.name;
  fixture.roster(parent).create({
    name,
    actorReference: { actorId: child.actorId, workspaceId: child.workspaceId, parentActorId: child.parentActorId },
    birth: null,
    deleteRequested: false,
    status: 'idle',
    currentTask: null,
    createdAt,
    dismissedAt: null,
    taskEventId: null,
  });
  fixture.roster(parent).dismiss(name, 5);
}

describe('owner reads of retained subordinate paths', () => {
  test('nested archived tool events page without changing the stored work', async () => {
    const fixture = workspaceFixture();
    const child = fixture.child(fixture.main, 'child');
    const leaf = fixture.child(child, 'leaf');
    const events = new RunEventRecorder(fixture.sql, leaf);
    events.emit('shell', { type: 'run_start', agentId: 'leaf' });
    events.emit('shell', { type: 'tool_call_end', name: 'agents', toolCallId: 'ask-1', args: { action: 'ask', role: 'task' }, result: { agent: 'nested', transcript: 'kept' }, outcome: { success: true } });
    events.emit('shell', { type: 'run_end', reason: 'completed' });
    const before = fixture.sql`SELECT run_id, event_index, type FROM run_events ORDER BY run_id, event_index`;
    const first = await read(fixture, { path: ['child', 'leaf'], view: 'events', runId: 'shell', query: { limit: 2 } });
    expect(first.view).toBe('events');

    if (first.view !== 'events' || first.page.status !== 'more') throw new Error('Expected another event page');
    expect(first.page.items.map((event) => event.type)).toEqual(['run_start', 'tool_call_end']);
    const last = await read(fixture, { path: ['child', 'leaf'], view: 'events', runId: 'shell', query: { limit: 2, since: first.page.next } });
    expect(last).toMatchObject({ view: 'events', page: { status: 'end', items: [{ type: 'run_end', reason: 'completed' }] } });
    expect(fixture.sql`SELECT run_id, event_index, type FROM run_events ORDER BY run_id, event_index`).toEqual(before);
  });

  test('children pagination includes dismissed rows without skipping tied timestamps', async () => {
    const fixture = workspaceFixture();

    for (const [index, name] of ['alpha', 'beta', 'gamma'].entries()) {
      rosterChild(fixture, fixture.main, fixture.child(fixture.main, name), index + 1);
    }

    const first = await read(fixture, { path: [], view: 'children', page: { limit: 2 } });

    if (first.view !== 'children' || first.page.status !== 'more') throw new Error('Expected another roster page');
    expect(first.page.items.map((row) => [row.name, row.status])).toEqual([['alpha', 'dismissed'], ['beta', 'dismissed']]);
    const last = await read(fixture, { path: [], view: 'children', page: { limit: 2, cursor: first.page.next } });
    expect(last).toMatchObject({ view: 'children', page: { status: 'end', items: [{ name: 'gamma' }] } });
  });

  test('unknown names, a wrong owner, and a valid name under the wrong parent disclose no history', async () => {
    const fixture = workspaceFixture();
    const child = fixture.child(fixture.main, 'child');
    fixture.child(child, 'leaf');
    expect(await read(fixture, { path: ['absent'], view: 'history', page: {} })).toMatchObject({ view: 'missing', reason: 'missing' });
    expect(await read(
      fixture,
      { path: ['child'], view: 'history', page: {} },
      { owner: 'other-owner', workspace: 'workspace' },
    )).toMatchObject({ view: 'missing', reason: 'missing' });
    expect(await read(fixture, { path: ['leaf'], view: 'history', page: {} })).toMatchObject({ view: 'missing', reason: 'missing' });
  });

  test('a retired actor row is missing, never an empty archive', async () => {
    const fixture = workspaceFixture();
    const child = fixture.child(fixture.main, 'child');
    const before = fixture.sql<{ actor_id: string; name: string; retiring_at: number | null }>`SELECT actor_id, name, retiring_at FROM workspace_actors ORDER BY actor_id, name`;
    fixture.directory.apply(actorReferenceOf(fixture.main), [], {
      action: 'retire',
      name: 'child',
      reference: actorReferenceOf(child),
    });
    expect(await read(fixture, { path: ['child'], view: 'history', page: {} })).toMatchObject({ view: 'missing', reason: 'missing' });
    const after = fixture.sql<{ actor_id: string; name: string; retiring_at: number | null }>`SELECT actor_id, name, retiring_at FROM workspace_actors ORDER BY actor_id, name`;
    expect(after).not.toEqual(before);
    expect(after.filter((row) => row.name === 'child')).toHaveLength(1);
  });

  test('a finished helper\'s kept history reads by its id, where its name no longer resolves', async () => {
    const fixture = workspaceFixture();
    const child = fixture.child(fixture.main, 'child');
    const leaf = fixture.child(child, 'leaf');
    await seedTranscriptEntry(fixture.history(leaf), CHAT_SESSION_ID, {
      id: 'answer', origin: 'input', message: { role: 'user', content: 'kept answer' },
    });

    for (const action of ['retire', 'release'] as const) {
      fixture.directory.apply(actorReferenceOf(fixture.main), [], { action, name: 'child', reference: actorReferenceOf(child) });
    }

    expect(await read(fixture, { path: ['child', 'leaf'], view: 'history', page: {} })).toMatchObject({ view: 'missing' });
    expect(await read(fixture, { path: [], view: 'history', page: {}, actor: leaf.actorId })).toMatchObject({
      view: 'history', page: { status: 'end', items: [{ content: 'kept answer' }] },
    });
    expect(await read(fixture, { path: [], view: 'history', page: {}, actor: 'not-an-actor' })).toMatchObject({ view: 'missing' });
  });

  test('a finished helper\'s runs and their events read by its id, where its name no longer resolves', async () => {
    const fixture = workspaceFixture();
    const child = fixture.child(fixture.main, 'child');
    const events = new RunEventRecorder(fixture.sql, child);
    events.emit('kept', { type: 'run_start', agentId: 'child' });
    events.emit('kept', { type: 'tool_call_end', name: 'agents', toolCallId: 'hire-1', args: { action: 'hire', lifetime: 'task' }, result: { status: 'completed', answer: 'deep' }, outcome: { success: true } });

    for (const action of ['retire', 'release'] as const) {
      fixture.directory.apply(actorReferenceOf(fixture.main), [], { action, name: 'child', reference: actorReferenceOf(child) });
    }

    expect(await read(fixture, { path: ['child'], view: 'runs', page: {} })).toMatchObject({ view: 'missing' });
    expect(await read(fixture, { path: [], view: 'runs', page: {}, actor: child.actorId })).toMatchObject({
      view: 'runs', page: { items: [{ runId: 'kept' }] },
    });
    expect(await read(fixture, { path: [], view: 'events', runId: 'kept', query: {}, actor: child.actorId })).toMatchObject({
      view: 'events', page: { status: 'end', items: [{ type: 'run_start' }, { type: 'tool_call_end', result: { answer: 'deep' } }] },
    });
  });

  test('a released parent\'s roster reads by its id, so its helpers are still found', async () => {
    const fixture = workspaceFixture();
    const child = fixture.child(fixture.main, 'child');
    const leaf = fixture.child(child, 'leaf');
    rosterChild(fixture, child, leaf, 1);

    for (const action of ['retire', 'release'] as const) {
      fixture.directory.apply(actorReferenceOf(fixture.main), [], { action, name: 'child', reference: actorReferenceOf(child) });
    }

    expect(await read(fixture, { path: ['child'], view: 'children', page: {} })).toMatchObject({ view: 'missing' });
    expect(await read(fixture, { path: [], view: 'children', page: {}, actor: child.actorId })).toMatchObject({
      view: 'children', page: { items: [{ name: 'leaf', actorReference: { actorId: leaf.actorId } }] },
    });
  });

  test('run and history pages retain their own continuation cursors', async () => {
    const fixture = workspaceFixture();
    const child = fixture.child(fixture.main, 'child');
    const events = new RunEventRecorder(fixture.sql, child);

    for (const id of ['one', 'two', 'three']) {
      events.emit(id, { type: 'run_start', agentId: 'child', userMessage: id });
      await seedTranscriptEntry(fixture.history(child), CHAT_SESSION_ID, {
        id, origin: 'input', message: { role: 'user', content: id },
      });
    }

    const runs = await read(fixture, { path: ['child'], view: 'runs', page: { limit: 2 } });

    if (runs.view !== 'runs' || runs.page.status !== 'more') throw new Error('Expected another run page');
    expect(runs.page.items.map((run) => run.runId)).toEqual(['three', 'two']);
    expect(await read(fixture, { path: ['child'], view: 'runs', page: { limit: 2, cursor: runs.page.next } })).toMatchObject({ page: { status: 'end', items: [{ runId: 'one' }] } });
    const history = await read(fixture, { path: ['child'], view: 'history', page: { limit: 2 } });

    if (history.view !== 'history' || history.page.status !== 'more') throw new Error('Expected another history page');
    expect(history.page.items.map((message) => message.content)).toEqual(['two', 'three']);
    expect(await read(fixture, { path: ['child'], view: 'history', page: { limit: 2, cursor: history.page.next } })).toMatchObject({ page: { status: 'end', items: [{ content: 'one' }] } });
  });

  test('request variants reject fields that cannot apply to the selected view', () => {
    expect(v.safeParse(SubordinateInspectionRequestSchema, { path: [], view: 'history', page: {}, runId: 'shell' }).success).toBe(false);
    expect(v.safeParse(SubordinateInspectionRequestSchema, { path: [], view: 'events', query: {} }).success).toBe(false);
    expect(v.safeParse(SubordinateInspectionRequestSchema, { path: ['foreign/path'], view: 'children', page: {} }).success).toBe(false);
  });

  test('retained history uses the exact roster name without an inspection-only cap', async () => {
    const name = `reader-${'r'.repeat(52)}`;
    const fixture = workspaceFixture();
    const child = fixture.child(fixture.main, name);
    await seedTranscriptEntry(fixture.history(child), CHAT_SESSION_ID, {
      id: 'message', origin: 'input', message: { role: 'user', content: 'retained answer' },
    });
    expect(await read(fixture, { path: [name], view: 'history', page: {} })).toMatchObject({
      view: 'history', path: [name], page: { status: 'end', items: [{ content: 'retained answer' }] },
    });
  });
});
