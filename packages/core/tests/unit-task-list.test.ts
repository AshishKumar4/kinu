// TaskListStore — the agent's own task list. Behaviour through the store's
// public surface: what an id is, what nesting is allowed, what a capped read
// promises, and what `listOpen` (the live-context roster) actually contains.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { TaskListStore, initTaskListTable, MAX_TASK_TITLE_CHARS } from '../src/tasks/store';
import { makeSql, makeExecRaw } from './helpers';

function newStore(): TaskListStore {
  const db = new Database(':memory:');
  initTaskListTable(makeExecRaw(db));
  return new TaskListStore(makeSql(db));
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
    s.setStatus('t2', 'dropped', 2);
    // Minting from MAX(seq), not COUNT(*): a reused id would silently re-label
    // an item the model already referred to in prose.
    expect(s.add(['three'], null, 3).added[0]!.id).toBe('t3');
  });

  test('subtasks hang off a parent and nest exactly one level', () => {
    const s = newStore();
    s.add(['Ship the fix'], null, 1);
    const subs = s.add(['Write it', 'Test it'], 't1', 2);
    expect(subs.added.map((t) => t.parentId)).toEqual(['t1', 't1']);

    const deeper = s.add(['Too deep'], 't2', 3);
    expect(deeper.added).toEqual([]);
    expect(deeper.rejected[0]!.reason).toContain('subtasks nest one level only');

    const tree = s.list();
    expect(tree.length).toBe(1);
    expect(tree[0]!.subtasks.map((t) => t.id)).toEqual(['t2', 't3']);
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
    expect(s.setStatus('t1', 'active', 2)?.status).toBe('active');
    expect(s.setStatus('t1', 'done', 3)?.updatedAt).toBe(3);
    expect(s.setStatus('t7', 'done', 4)).toBeNull();
  });

  test('countOpenSubtasks answers what closing a parent would leave behind', () => {
    const s = newStore();
    s.add(['parent'], null, 1);
    s.add(['a', 'b'], 't1', 2);
    expect(s.countOpenSubtasks('t1')).toBe(2);
    s.setStatus('t2', 'done', 3);
    expect(s.countOpenSubtasks('t1')).toBe(1);
    s.setStatus('t3', 'dropped', 4);
    expect(s.countOpenSubtasks('t1')).toBe(0);
  });

  test('listOpen drops settled items but keeps a parent whose subtasks are live', () => {
    const s = newStore();
    s.add(['done parent', 'live parent'], null, 1);
    s.add(['still to do'], 't1', 2);
    s.add(['finished'], 't2', 3);
    s.setStatus('t1', 'done', 4);
    s.setStatus('t4', 'done', 5);

    const open = s.listOpen();
    expect(open.map((t) => t.id)).toEqual(['t1', 't2']);
    // t1 itself is done, but it is shown because t3 hangs off it — a subtask
    // rendered without its parent reads as an unrelated item.
    expect(open[0]!.subtasks.map((t) => t.id)).toEqual(['t3']);
    expect(open[1]!.subtasks).toEqual([]);

    s.setStatus('t3', 'done', 6);
    expect(s.listOpen().map((t) => t.id)).toEqual(['t2']);
  });

  test('a capped read takes the head of the list and count reports the whole', () => {
    const s = newStore();
    s.add(['one', 'two'], null, 1);
    s.add(['under two'], 't2', 2);
    expect(s.list(2).map((t) => t.id)).toEqual(['t1', 't2']);
    expect(s.list(2)[1]!.subtasks).toEqual([]);
    expect(s.count()).toBe(3);
  });
});
