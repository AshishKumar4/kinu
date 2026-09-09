import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { createTestWorkspace, makeSqlExec } from '../../core/tests/helpers';
import { createTestActorsOver } from '@kinu.run/test-utils';
import {
  RunEventRecorder,
  SubordinateRosterStore,
  SubordinateInspectionRequestSchema,
  actorReferenceOf,
  inspectSubordinateStorage,
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
}

/**
 * One workspace database, one directory, and real actor handles.
 *
 * Every actor's rows live in this one database, and the directory walk is the
 * only traversal authority. A fixture that gave each actor its own database and
 * reached the next hop through a per-child RPC port — SDK parent-path rows
 * deciding whether the traversal was allowed — would be testing a boundary the
 * product does not have.
 */
function workspaceFixture(): InspectionFixture {
  const created = createTestWorkspace();
  const raw = makeSqlExec(created.db);
  const actors = createTestActorsOver(created.db, { name: 'workspace' });
  const access: SubordinateInspectionAccess = {
    sql: created.sql,
    raw,
    actor: actors.main,
    directory: actors.directory,
  };
  return {
    sql: created.sql,
    raw,
    directory: actors.directory,
    main: actors.main,
    access,
    child(parent: ActorHandle, name: string): ActorHandle {
      return actors.directory.create({
        parent,
        name,
        creationId: `${parent.name}/${name}`,
        kind: 'subordinate',
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
  name: string,
  createdAt: number,
): void {
  fixture.roster(parent).create({
    name,
    actorReference: null,
    birth: null,
    deleteRequested: false,
    createdBy: 'orchestrator',
    status: 'idle',
    currentTask: null,
    createdAt,
    dismissedAt: null,
    lifetime: 'task',
    taskEventId: null,
  });
  fixture.roster(parent).dismiss(name, 5);
}

describe('owner reads of retained subordinate paths', () => {
  test('nested archived tool events page without changing the stored work', () => {
    const fixture = workspaceFixture();
    const child = fixture.child(fixture.main, 'child');
    const leaf = fixture.child(child, 'leaf');
    const events = new RunEventRecorder(fixture.sql, leaf);
    events.emit('run', { type: 'run_start', agentId: 'leaf' });
    events.emit('run', { type: 'tool_call_end', name: 'agents', toolCallId: 'ask-1', args: { action: 'ask', role: 'general' }, result: { agent: 'nested', transcript: 'kept' }, outcome: { success: true } });
    events.emit('run', { type: 'run_end', reason: 'completed' });
    const before = fixture.sql`SELECT run_id, event_index, type FROM run_events ORDER BY run_id, event_index`;
    const first = read(fixture, { path: ['child', 'leaf'], view: 'events', runId: 'run', query: { limit: 2 } });
    expect(first.view).toBe('events');
    if (first.view !== 'events' || first.page.status !== 'more') throw new Error('Expected another event page');
    expect(first.page.items.map((event) => event.type)).toEqual(['run_start', 'tool_call_end']);
    const last = read(fixture, { path: ['child', 'leaf'], view: 'events', runId: 'run', query: { limit: 2, since: first.page.next } });
    expect(last).toMatchObject({ view: 'events', page: { status: 'end', items: [{ type: 'run_end', reason: 'completed' }] } });
    expect(fixture.sql`SELECT run_id, event_index, type FROM run_events ORDER BY run_id, event_index`).toEqual(before);
  });

  test('children pagination includes dismissed rows without skipping tied timestamps', () => {
    const fixture = workspaceFixture();
    for (const [index, name] of ['alpha', 'beta', 'gamma'].entries()) {
      fixture.child(fixture.main, name);
      rosterChild(fixture, fixture.main, name, index + 1);
    }
    const first = read(fixture, { path: [], view: 'children', page: { limit: 2 } });
    if (first.view !== 'children' || first.page.status !== 'more') throw new Error('Expected another roster page');
    expect(first.page.items.map((row) => [row.name, row.status])).toEqual([['alpha', 'dismissed'], ['beta', 'dismissed']]);
    const last = read(fixture, { path: [], view: 'children', page: { limit: 2, cursor: first.page.next } });
    expect(last).toMatchObject({ view: 'children', page: { status: 'end', items: [{ name: 'gamma' }] } });
  });

  test('unknown names, a wrong owner, and a valid name under the wrong parent disclose no history', () => {
    const fixture = workspaceFixture();
    const child = fixture.child(fixture.main, 'child');
    fixture.child(child, 'leaf');
    expect(read(fixture, { path: ['absent'], view: 'history', page: {} })).toMatchObject({ view: 'missing', reason: 'missing' });
    expect(read(
      fixture,
      { path: ['child'], view: 'history', page: {} },
      { owner: 'other-owner', workspace: 'workspace' },
    )).toMatchObject({ view: 'missing', reason: 'missing' });
    expect(read(fixture, { path: ['leaf'], view: 'history', page: {} })).toMatchObject({ view: 'missing', reason: 'missing' });
  });

  test('a retired actor row is missing, never an empty archive', () => {
    const fixture = workspaceFixture();
    const child = fixture.child(fixture.main, 'child');
    const before = fixture.sql<{ actor_id: string; name: string; retiring_at: number | null }>`SELECT actor_id, name, retiring_at FROM workspace_actors ORDER BY actor_id, name`;
    fixture.directory.apply(actorReferenceOf(fixture.main), [], {
      action: 'retire',
      name: 'child',
      reference: actorReferenceOf(child),
    });
    expect(read(fixture, { path: ['child'], view: 'history', page: {} })).toMatchObject({ view: 'missing', reason: 'missing' });
    const after = fixture.sql<{ actor_id: string; name: string; retiring_at: number | null }>`SELECT actor_id, name, retiring_at FROM workspace_actors ORDER BY actor_id, name`;
    expect(after).not.toEqual(before);
    expect(after.filter((row) => row.name === 'child')).toHaveLength(1);
  });

  test('run and history pages retain their own continuation cursors', () => {
    const fixture = workspaceFixture();
    const child = fixture.child(fixture.main, 'child');
    const events = new RunEventRecorder(fixture.sql, child);
    for (const id of ['one', 'two', 'three']) {
      events.emit(id, { type: 'run_start', agentId: 'child', userMessage: id });
      void fixture.sql`INSERT INTO messages (actor_id,id,role,content,created_at)
        VALUES (${child.actorId}, ${id}, 'user', ${id}, ${id})`;
    }
    const runs = read(fixture, { path: ['child'], view: 'runs', page: { limit: 2 } });
    if (runs.view !== 'runs' || runs.page.status !== 'more') throw new Error('Expected another run page');
    expect(runs.page.items.map((run) => run.runId)).toEqual(['three', 'two']);
    expect(read(fixture, { path: ['child'], view: 'runs', page: { limit: 2, cursor: runs.page.next } })).toMatchObject({ page: { status: 'end', items: [{ runId: 'one' }] } });
    const history = read(fixture, { path: ['child'], view: 'history', page: { limit: 2 } });
    if (history.view !== 'history' || history.page.status !== 'more') throw new Error('Expected another history page');
    expect(history.page.items.map((message) => message.content)).toEqual(['two', 'three']);
    expect(read(fixture, { path: ['child'], view: 'history', page: { limit: 2, cursor: history.page.next } })).toMatchObject({ page: { status: 'end', items: [{ content: 'one' }] } });
  });

  test('request variants reject fields that cannot apply to the selected view', () => {
    expect(v.safeParse(SubordinateInspectionRequestSchema, { path: [], view: 'history', page: {}, runId: 'run' }).success).toBe(false);
    expect(v.safeParse(SubordinateInspectionRequestSchema, { path: [], view: 'events', query: {} }).success).toBe(false);
    expect(v.safeParse(SubordinateInspectionRequestSchema, { path: ['foreign/path'], view: 'children', page: {} }).success).toBe(false);
  });

  test('retained history uses the exact roster name without an inspection-only cap', () => {
    const name = `reader-${'r'.repeat(52)}`;
    const fixture = workspaceFixture();
    const child = fixture.child(fixture.main, name);
    void fixture.sql`INSERT INTO messages (actor_id,id,role,content,created_at)
      VALUES (${child.actorId}, 'message', 'user', 'retained answer', 1)`;
    expect(read(fixture, { path: [name], view: 'history', page: {} })).toMatchObject({
      view: 'history', path: [name], page: { status: 'end', items: [{ content: 'retained answer' }] },
    });
  });
});
