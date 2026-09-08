import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { createTestRuntime, makeSqlExec } from '../../core/tests/helpers';
import { RunEventRecorder, SubordinateIdentityStore, SubordinateRosterStore, SubordinateInspectionRequestSchema, type JsonValue, type SubordinateInspectionRequest } from '@kinu.run/core';
import { inspectSubordinateStorage, type SubordinateInspectionAccess, type SubordinateInspectionPort } from '@kinu.run/core';

function actor(path: string[], owner = 'owner') {
  const { rt, db } = createTestRuntime();
  const raw = makeSqlExec(db);
  const roster = new SubordinateRosterStore(raw);
  roster.ensureSchema();
  const identity = new SubordinateIdentityStore(raw);
  identity.ensureSchema();
  const name = path.at(-1);
  if (name) identity.seed({ name, mission: 'read one file', parentWorkspace: 'workspace', ownerUserId: owner, depth: path.length, lifetime: 'task' });
  let parentPath: JsonValue = [{ className: 'OrchestratorAgent', name: 'workspace' }, ...path.slice(0, -1).map((parent) => ({ className: 'SubordinateAgent', name: parent }))];
  const children = new Map<string, SubordinateInspectionPort>();
  const opened: string[] = [];
  const access: SubordinateInspectionAccess = {
    sql: rt.storage.sql, raw, actor: rt.actor,
    storedParentPath: async () => parentPath,
    storedPhysicalKey: async () => path.at(-1),
    existing: async (child) => { opened.push(child.name); const port = children.get(child.name); return port ? { port, storageKey: child.name } : null; },
  };
  const port: SubordinateInspectionPort = {
    inspectSubordinateStorage: (request, authority) => inspectSubordinateStorage(access, request, authority),
  };
  return {
    rt, db, raw, roster, identity, access, port, opened,
    parentPath: (value: JsonValue) => { parentPath = value; },
    add: (child: string, target: SubordinateInspectionPort) => {
      roster.create({ name: child, actorReference: null, birth: null, deleteRequested: false, createdBy: 'orchestrator', status: 'idle', currentTask: null, createdAt: children.size + 1, dismissedAt: null, lifetime: 'task', taskEventId: null });
      roster.dismiss(child, 5);
      children.set(child, target);
    },
  };
}
function read(root: { port: SubordinateInspectionPort }, request: SubordinateInspectionRequest) {
  return root.port.inspectSubordinateStorage(request, { owner: 'owner', workspace: 'workspace', traversed: [], storagePath: [] });
}

describe('owner reads of retained subordinate paths', () => {
  test('nested archived tool events page without changing the stored work', async () => {
    const root = actor([]); const child = actor(['child']); const leaf = actor(['child', 'leaf']);
    root.add('child', child.port); child.add('leaf', leaf.port);
    const events = new RunEventRecorder(leaf.rt.storage.sql);
    events.emit('run', { type: 'run_start', agentId: 'leaf' });
    events.emit('run', { type: 'tool_call_end', name: 'agents', toolCallId: 'ask-1', args: { action: 'ask', role: 'general' }, result: { agent: 'nested', transcript: 'kept' }, outcome: { success: true } });
    events.emit('run', { type: 'run_end', reason: 'completed' });
    const before = leaf.db.serialize();
    const first = await read(root, { path: ['child', 'leaf'], view: 'events', runId: 'run', query: { limit: 2 } });
    expect(first.view).toBe('events');
    if (first.view !== 'events' || first.page.status !== 'more') throw new Error('Expected another event page');
    expect(first.page.items.map((event) => event.type)).toEqual(['run_start', 'tool_call_end']);
    const last = await read(root, { path: ['child', 'leaf'], view: 'events', runId: 'run', query: { limit: 2, since: first.page.next } });
    expect(last).toMatchObject({ view: 'events', page: { status: 'end', items: [{ type: 'run_end', reason: 'completed' }] } });
    expect(leaf.db.serialize()).toEqual(before);
    expect(child.roster.get('leaf')?.status).toBe('dismissed');
  });

  test('children pagination includes dismissed rows without skipping tied timestamps', async () => {
    const root = actor([]);
    for (const name of ['alpha', 'beta', 'gamma']) root.add(name, actor([name]).port);
    const first = await read(root, { path: [], view: 'children', page: { limit: 2 } });
    if (first.view !== 'children' || first.page.status !== 'more') throw new Error('Expected another roster page');
    expect(first.page.items.map((row) => [row.name, row.status])).toEqual([['alpha', 'dismissed'], ['beta', 'dismissed']]);
    const last = await read(root, { path: [], view: 'children', page: { limit: 2, cursor: first.page.next } });
    expect(last).toMatchObject({ view: 'children', page: { status: 'end', items: [{ name: 'gamma' }] } });
    expect(root.opened).toEqual([]);
  });

  test('unknown, foreign-owner and mismatched parent paths disclose no history', async () => {
    const root = actor([]); const foreign = actor(['foreign'], 'other-owner'); const wrong = actor(['wrong']);
    root.add('foreign', foreign.port); root.add('wrong', wrong.port);
    wrong.parentPath([{ className: 'OrchestratorAgent', name: 'another-workspace' }]);
    for (const name of ['absent', 'foreign', 'wrong']) {
      expect(await read(root, { path: [name], view: 'history', page: {} })).toMatchObject({ view: 'missing', reason: 'missing' });
    }
    expect(root.opened).not.toContain('absent');
  });

  test('stale roster and wiped application identity are missing, never an empty archive', async () => {
    const root = actor([]); const child = actor(['child']);
    root.add('child', child.port);
    child.db.exec('DROP TABLE subordinate_identity');
    const before = child.db.serialize();
    expect(await read(root, { path: ['child'], view: 'history', page: {} })).toMatchObject({ view: 'missing', reason: 'missing' });
    expect(child.db.serialize()).toEqual(before);
  });

  test('run and history pages retain their own continuation cursors', async () => {
    const root = actor([]); const child = actor(['child']); root.add('child', child.port);
    const events = new RunEventRecorder(child.rt.storage.sql);
    for (const id of ['one', 'two', 'three']) {
      events.emit(id, { type: 'run_start', agentId: 'child', userMessage: id });
      void child.rt.storage.sql`INSERT INTO messages (id,role,content,created_at) VALUES (${id}, 'user', ${id}, ${id})`;
    }
    const runs = await read(root, { path: ['child'], view: 'runs', page: { limit: 2 } });
    if (runs.view !== 'runs' || runs.page.status !== 'more') throw new Error('Expected another run page');
    expect(runs.page.items.map((run) => run.runId)).toEqual(['three', 'two']);
    expect(await read(root, { path: ['child'], view: 'runs', page: { limit: 2, cursor: runs.page.next } })).toMatchObject({ page: { status: 'end', items: [{ runId: 'one' }] } });
    const history = await read(root, { path: ['child'], view: 'history', page: { limit: 2 } });
    if (history.view !== 'history' || history.page.status !== 'more') throw new Error('Expected another history page');
    expect(history.page.items.map((message) => message.content)).toEqual(['two', 'three']);
    expect(await read(root, { path: ['child'], view: 'history', page: { limit: 2, cursor: history.page.next } })).toMatchObject({ page: { status: 'end', items: [{ content: 'one' }] } });
  });

  test('request variants reject fields that cannot apply to the selected view', () => {
    expect(v.safeParse(SubordinateInspectionRequestSchema, { path: [], view: 'history', page: {}, runId: 'run' }).success).toBe(false);
    expect(v.safeParse(SubordinateInspectionRequestSchema, { path: [], view: 'events', query: {} }).success).toBe(false);
    expect(v.safeParse(SubordinateInspectionRequestSchema, { path: ['foreign/path'], view: 'children', page: {} }).success).toBe(false);
  });
  test('retained history uses the exact roster name without an inspection-only cap', async () => {
    const name = 'reader'.repeat(30);
    const root = actor([]); const child = actor([name]); root.add(name, child.port);
    void child.rt.storage.sql`INSERT INTO messages (id,role,content,created_at) VALUES ('message', 'user', 'retained answer', 1)`;
    expect(await read(root, { path: [name], view: 'history', page: {} })).toMatchObject({
      view: 'history', path: [name], page: { status: 'end', items: [{ content: 'retained answer' }] },
    });
  });
});
