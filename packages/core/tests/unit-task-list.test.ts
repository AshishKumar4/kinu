import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { TaskListStore, initTaskListTable, MAX_TASK_TITLE_CHARS } from '../src/tools/task-store';
import type { SqlValue } from '../src/types/primitives';
import { makeSql, makeExecRaw } from './helpers';
import { createTestActorsOver } from '@kinu.run/test-utils';

function newStore(): TaskListStore {
  const db = new Database(':memory:');
  initTaskListTable(makeExecRaw(db));

  return new TaskListStore(makeSql(db), createTestActorsOver(db).main, write => db.transaction(write)());
}

describe('TaskListStore', () => {
  test('add mints short sequential ids and keeps write order', () => {
    const s = newStore();
    const first = s.add(['Reproduce the 502', 'Patch the timeout'], null, 1);
    expect(first.added.map((t) => t.id)).toEqual(['t1', 't2']);
    const second = s.add(['Add a regression test'], null, 2);
    expect(second.added.map((t) => t.id)).toEqual(['t3']);
    expect(s.list().map((t) => t.title)).toEqual([
      'Reproduce the 502', 'Patch the timeout', 'Add a regression test',
    ]);
  });

  test('ids stay unique after the newest item is dropped', () => {
    const s = newStore();
    s.add(['one', 'two'], null, 1);
    s.update('t2', { status: 'dropped' }, 2);
    // Minting from MAX(seq), not COUNT(*): a reused id would re-label an item the model already cited.
    expect(s.add(['three'], null, 3).added[0].id).toBe('t3');
  });

  test('subtasks hang off a parent and nest exactly one level', () => {
    const s = newStore();
    s.add(['Ship the fix'], null, 1);
    const subs = s.add(['Write it', 'Test it'], 't1', 2);
    expect(subs.added.map((t) => t.parentId)).toEqual(['t1', 't1']);

    const deeper = s.add(['Too deep'], 't2', 3);
    expect(deeper.added).toEqual([]);
    expect(deeper.rejected[0].reason).toContain('subtasks nest one level only');

    const tree = s.list();
    expect(tree.length).toBe(1);
    expect(tree[0].subtasks.map((t) => t.id)).toEqual(['t2', 't3']);
  });

  test('an unknown parent is refused with the id that was wrong', () => {
    const s = newStore();
    const result = s.add(['orphan'], 't9', 1);
    expect(result.added).toEqual([]);
    expect(result.rejected).toEqual([{ title: 'orphan', reason: 'no task t9' }]);
  });

  test('empty and oversized titles are rejected by name, others still land', () => {
    const s = newStore();
    const result = s.add(['  ', 'a real step', 'x'.repeat(MAX_TASK_TITLE_CHARS + 1)], null, 1);
    expect(result.added.map((t) => t.title)).toEqual(['a real step']);
    expect(result.rejected.map((r) => r.reason)).toEqual([
      'empty title', `title over ${MAX_TASK_TITLE_CHARS} characters`,
    ]);
  });

  test('setStatus moves an item and reports an unknown id as null', () => {
    const s = newStore();
    s.add(['step'], null, 1);
    expect(s.update('t1', { status: 'active' }, 2)?.status).toBe('active');
    expect(s.update('t1', { status: 'done' }, 3)?.updatedAt).toBe(3);
    expect(s.update('t7', { status: 'done' }, 4)).toBeNull();
  });

  test('countOpenSubtasks answers what closing a parent would leave behind', () => {
    const s = newStore();
    s.add(['parent'], null, 1);
    s.add(['a', 'b'], 't1', 2);
    expect(s.countOpenSubtasks('t1')).toBe(2);
    s.update('t2', { status: 'done' }, 3);
    expect(s.countOpenSubtasks('t1')).toBe(1);
    s.update('t3', { status: 'dropped' }, 4);
    expect(s.countOpenSubtasks('t1')).toBe(0);
  });

  test('listOpen drops settled items but keeps a parent whose subtasks are live', () => {
    const s = newStore();
    s.add(['done parent', 'live parent'], null, 1);
    s.add(['still to do'], 't1', 2);
    s.add(['finished'], 't2', 3);
    s.update('t1', { status: 'done' }, 4);
    s.update('t4', { status: 'done' }, 5);

    const open = s.listOpen();
    expect(open.items.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(open.total).toBe(3);
    // Done t1 is shown because t3 hangs off it.
    expect(open.items[0].subtasks.map((t) => t.id)).toEqual(['t3']);
    expect(open.items[1].subtasks).toEqual([]);

    s.update('t3', { status: 'done' }, 6);
    expect(s.listOpen().items.map((t) => t.id)).toEqual(['t2']);
  });

  // The open filter must run before the bound, and the true open count rides beside the page.
  test('listOpen filters BEFORE its bound: an open task behind 200 closed ones is still visible', () => {
    const s = newStore();
    s.add(Array.from({ length: 200 }, (_, i) => `closed ${i + 1}`), null, 1);

    for (let i = 1; i <= 200; i++) s.update(`t${i}`, { status: 'done' }, 2);
    s.add(['the one open task'], null, 3);

    const page = s.listOpen();
    expect(page.total).toBe(1);
    expect(page.items.map((t) => t.title)).toEqual(['the one open task']);
  });

  test('listOpen reports the true open row count even past its page bound', () => {
    const s = newStore();

    for (let batch = 0; batch < 5; batch++) {
      const { added } = s.add(Array.from({ length: 5 }, (_, i) => `task ${batch}-${i}`), null, batch + 1);

      if (batch % 2 === 0) for (const t of added) s.update(t.id, { status: 'done' }, 100);
    }

    const page = s.listOpen(4);
    expect(page.items.length).toBeLessThanOrEqual(4);
    expect(page.total).toBe(10);
  });

  test('a capped read takes the head of the list and count reports the whole', () => {
    const s = newStore();
    s.add(['one', 'two'], null, 1);
    s.add(['under two'], 't2', 2);
    expect(s.list(2).map((t) => t.id)).toEqual(['t1', 't2']);
    expect(s.list(2)[1].subtasks).toEqual([]);
    expect(s.count()).toBe(3);
  });
  // A table predating the status CHECK can hold an unminted value: reading it must refuse, naming it.
  test('a stored status outside the vocabulary is refused naming the value', () => {
    const db = new Database(':memory:');
    const actor = createTestActorsOver(db).main;
    const sql = makeSql(db);
    db.exec(`CREATE TABLE agent_tasks (
      actor_id TEXT NOT NULL,
      id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      parent_id TEXT,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (actor_id, id)
    )`);
    db.exec(`CREATE TABLE agent_task_notes (
      actor_id TEXT NOT NULL, task_id TEXT NOT NULL, note TEXT NOT NULL,
      PRIMARY KEY (actor_id, task_id)
    )`);
    void sql`INSERT INTO agent_tasks (actor_id, id, seq, parent_id, title, status, created_at, updated_at)
      VALUES (${actor.actorId}, 't9', 999, NULL, 'x', 'bogus', 1, 1)`;
    const s = new TaskListStore(sql, actor, write => db.transaction(write)());
    expect(() => s.get('t9')).toThrow('bogus');
  });
  // Pinned on the query plan: answering subtasks through the status index shows as "USING INDEX idx_agent_tasks_status".
  test('countOpenSubtasks seeks the parent index', () => {
    const db = new Database(':memory:');
    initTaskListTable(makeExecRaw(db));
    const actor = createTestActorsOver(db).main;
    const inner = makeSql(db);
    let statement = '';

    const capturing: typeof inner = <T,>(strings: TemplateStringsArray, ...values: SqlValue[]): T[] => {
      statement = strings.join('?');

      return inner<T>(strings, ...values);
    };

    const s = new TaskListStore(capturing, actor, write => db.transaction(write)());
    s.add(['parent'], null, 1);
    s.add(['a', 'b'], 't1', 2);
    statement = '';
    expect(s.countOpenSubtasks('t1')).toBe(2);
    const plan = db.query<{ detail: string }, [string, string]>(`EXPLAIN QUERY PLAN ${statement}`).all(actor.actorId, 't1');
    const details = plan.map((row) => row.detail).join('\n');
    expect(details).toContain('idx_agent_tasks_parent (actor_id=? AND parent_id=?)');
    expect(details).not.toMatch(/\bSCAN\b/);
  });
});
