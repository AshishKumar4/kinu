import { expect, test } from 'bun:test';
import { resultOwed, taskReminderOf } from '../src/tasks/reminder';
import type { AgentTaskTree } from '../src/tools/task-store';
import type { ActiveRoster } from '../src/types/dynamic-context';
import { present } from '@kinu.run/test-utils';

function tree(over: Partial<AgentTaskTree> & { title: string }): AgentTaskTree {
  return {
    id: over.id ?? `t-${over.title}`,
    parentId: null,
    status: 'open',
    updatedAt: 0,
    note: null,
    subtasks: [],
    ...over,
  };
}

function roster(items: AgentTaskTree[]): ActiveRoster<AgentTaskTree> {
  return { items, total: items.length };
}

function decideAt(open: AgentTaskTree[], over: {
  assistantText?: string;
  workMode?: 'plan' | 'build';
  completed?: boolean;
  resultOwed?: boolean;
} = {}) {
  return taskReminderOf({
    open: roster(open),
    assistantText: over.assistantText ?? 'All done.',
    workMode: over.workMode ?? 'build',
    completed: over.completed ?? true,
    resultOwed: over.resultOwed ?? false,
  });
}

test('a turn that settles with open tasks owes a reminder naming the open ones', () => {
  const decision = present(decideAt([
    tree({ title: 'ship the feature', status: 'active' }),
    tree({ title: 'done already', status: 'done', subtasks: [
      { id: 's1', parentId: 'x', title: 'write the test', status: 'open', updatedAt: 0, note: null },
    ] }),
  ]), 'the reminder decision');

  // What the person's card names: the open ones, not the finished parent.
  expect(decision.titles).toEqual(['ship the feature', 'write the test']);
});

test('one state of the list is one reminder: the same list owes the same one, a moved task a new one', () => {
  const open = [tree({ id: 't1', title: 'x' }), tree({ id: 't2', title: 'y' })];
  const first = present(decideAt(open), 'the first reminder').state;

  expect(present(decideAt(open), 'the same list').state).toBe(first);
  expect(present(decideAt([tree({ id: 't1', title: 'x', status: 'active' }), tree({ id: 't2', title: 'y' })]), 'a status moved').state).not.toBe(first);
  expect(present(decideAt([tree({ id: 't2', title: 'y' })]), 'a task closed').state).not.toBe(first);
});

test('an empty list, an errored turn and a plan owe nothing', () => {
  expect(decideAt([])).toBeNull();
  expect(decideAt([tree({ title: 'x' })], { completed: false })).toBeNull();
  expect(decideAt([tree({ title: 'x' })], { workMode: 'plan' })).toBeNull();
});

test('a result owed to the agent holds the reminder, whatever is open', () => {
  expect(decideAt([tree({ title: 'x' })], { resultOwed: true })).toBeNull();
});

test("what is owed: a hire's open assignment or a job that ends on its own, not a hire waiting on the agent", () => {
  expect(resultOwed(['working'], 0)).toBe(true);
  expect(resultOwed([], 1)).toBe(true);
  expect(resultOwed(['awaiting_input', 'idle'], 0)).toBe(false);
});

test('the awaiting-answer skip ports the OMP line-shape predicates', () => {
  // A turn whose last line asks a question or cues an answer owes no reminder; a flat statement owes one.
  const open = [tree({ title: 'x' })];

  for (const assistantText of [
    'I finished the refactor.\nShall I continue?',
    'Done so far.\nWhich approach do you prefer?',
    'Here are the results.\nLet me know.',
    'Question: proceed anyway?',
  ]) {
    expect(decideAt(open, { assistantText })).toBeNull();
  }

  // A question mark mid-line is incidental punctuation, not an ask; empty and flat answers owe the reminder.
  for (const assistantText of ['I finished the refactor. Shall I continue?', 'All tasks are complete.', '   ']) {
    expect(decideAt(open, { assistantText })).not.toBeNull();
  }
});
