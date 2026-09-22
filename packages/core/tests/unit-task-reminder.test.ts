import { expect, test } from 'bun:test';
import { TaskReminders, TASK_REMINDER_EVENT } from '../src/tasks/reminder';
import type { AgentTaskTree } from '../src/tasks/store';
import type { ActiveRoster } from '../src/prompting/volatile-context';
import { present } from '@kinu.run/test-utils';

function tree(over: Partial<AgentTaskTree> & { title: string }): AgentTaskTree {
  return {
    id: over.id ?? `t-${over.title}`,
    parentId: null,
    status: 'open',
    createdAt: 0,
    updatedAt: 0,
    note: null,
    subtasks: [],
    ...over,
  };
}

function roster(items: AgentTaskTree[]): ActiveRoster<AgentTaskTree> {
  return { items, total: items.length };
}

function decideAt(reminders: TaskReminders, open: AgentTaskTree[], over: {
  assistantText?: string;
  workMode?: 'plan' | 'build';
  completed?: boolean;
  asyncWakePending?: boolean;
} = {}) {
  return reminders.decide({
    open: roster(open),
    assistantText: over.assistantText ?? 'All done.',
    workMode: over.workMode ?? 'build',
    completed: over.completed ?? true,
    asyncWakePending: over.asyncWakePending ?? false,
  });
}

test('a turn that settles with open tasks owes a reminder naming them', () => {
  const reminders = new TaskReminders();

  const decision = present(decideAt(reminders, [
    tree({ title: 'ship the feature', status: 'active' }),
    tree({ title: 'done already', status: 'done', subtasks: [
      { id: 's1', parentId: 'x', title: 'write the test', status: 'open', createdAt: 0, updatedAt: 0, note: null },
    ] }),
  ]), 'the reminder decision');

  expect(decision).not.toBeNull();
  expect(decision.text).toContain('ship the feature');
  expect(decision.text).toContain('  - write the test');
  expect(decision.text).toContain('(Reminder 1/2)');
  expect(decision.text).toContain('<system-reminder>');
  expect(decision.text).toContain('2 open task(s)');
});

test('an empty open list owes nothing and resets the count', () => {
  const reminders = new TaskReminders();
  decideAt(reminders, [tree({ title: 'x' })]);
  decideAt(reminders, []);
  // The list went empty: the count parked, so a fresh list starts over rather
  // than inheriting the old attempts.
  const decision = present(decideAt(reminders, [tree({ title: 'y' })]), 'the reminder decision');
  expect(decision.text).toContain('(Reminder 1/2)');
});

test('a turn that errored or is a plan owes no reminder', () => {
  const reminders = new TaskReminders();
  expect(decideAt(reminders, [tree({ title: 'x' })], { completed: false })).toBeNull();
  expect(decideAt(reminders, [tree({ title: 'x' })], { workMode: 'plan' })).toBeNull();
});

test('the cap is honored: two reminders then silence without progress', () => {
  const reminders = new TaskReminders();
  const open = [tree({ title: 'x' })];

  const first = decideAt(reminders, open);
  expect(first).not.toBeNull();
  reminders.noteToolResult();

  const second = present(decideAt(reminders, open), 'the second reminder');
  expect(second.text).toContain('(Reminder 2/2)');
  reminders.noteToolResult();

  expect(decideAt(reminders, open)).toBeNull();
});

test('a fired reminder with no tool result blocks the next one', () => {
  const reminders = new TaskReminders();
  const open = [tree({ title: 'x' })];

  expect(decideAt(reminders, open)).not.toBeNull();
  // No progress since: the second settle must not lecture again.
  expect(decideAt(reminders, open)).toBeNull();
  // A tool result is progress: the latch releases.
  reminders.noteToolResult();
  expect(decideAt(reminders, open)).not.toBeNull();
});

test('the operator speaking resets the count', () => {
  const reminders = new TaskReminders();
  const open = [tree({ title: 'x' })];

  decideAt(reminders, open);
  reminders.noteToolResult();
  decideAt(reminders, open);
  expect(decideAt(reminders, open)).toBeNull(); // cap reached

  reminders.noteUserPrompt();
  expect(decideAt(reminders, open)).not.toBeNull();
});

test('an awaiting-answer turn and pending async work both skip', () => {
  const reminders = new TaskReminders();
  const open = [tree({ title: 'x' })];

  expect(decideAt(reminders, open, { assistantText: 'Done so far.\nWhich approach do you prefer?' })).toBeNull();
  expect(decideAt(reminders, open, { asyncWakePending: true })).toBeNull();
});

test('the awaiting-answer skip ports the OMP line-shape predicates', () => {
  // Exercised through `decide`: a turn whose last line asks a question or cues
  // an answer owes no reminder; a flat statement owes one.
  const open = [tree({ title: 'x' })];

  for (const assistantText of [
    'I finished the refactor.\nShall I continue?',
    'Done so far.\nWhich approach do you prefer?',
    'Here are the results.\nLet me know.',
    'Question: proceed anyway?',
  ]) {
    expect(decideAt(new TaskReminders(), open, { assistantText })).toBeNull();
  }

  // A question mark mid-line is incidental punctuation, not an ask; empty and
  // flat answers owe the reminder.
  for (const assistantText of ['I finished the refactor. Shall I continue?', 'All tasks are complete.', '   ']) {
    expect(decideAt(new TaskReminders(), open, { assistantText })).not.toBeNull();
  }
});

test('the event name the signal carries is task_reminder', () => {
  expect(TASK_REMINDER_EVENT).toBe('task_reminder');
});
