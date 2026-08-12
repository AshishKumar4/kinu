// Behaviour tests for the `tasks` tool — the model-facing surface over
// TaskListStore. The store's own semantics are pinned in unit-task-list.test.ts;
// what is tested here is the contract the model sees: the argument names, what
// a refusal says, and what comes back.
import { describe, test, expect } from 'bun:test';
import type { ToolSet } from 'ai';
import { createTestRuntime } from '@proteus/test-utils';
import {
  buildBuiltinTools, initAllTables, initTaskListTable, BUILTIN_TOOL_SPECS,
  createTasksCodemodeProvider, TaskListStore,
} from '../src/index.ts';

type Exec = (args: Record<string, unknown>) => Promise<unknown>;

function setup(): Exec {
  const { rt, testSql } = createTestRuntime();
  initAllTables(testSql.execRaw);
  initTaskListTable(testSql.execRaw);
  const tools: ToolSet = buildBuiltinTools({ rt });
  return tools.tasks!.execute as unknown as Exec;
}

describe('tasks tool', () => {
  test('add writes the whole plan in one call and returns the ids in order', async () => {
    const tasks = setup();
    const res = await tasks({ action: 'add', titles: ['Reproduce the 502', 'Patch the timeout'] }) as {
      added: Array<{ id: string; title: string; parent: string | null }>;
    };
    expect(res.added.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(res.added[0]!.parent).toBeNull();
  });

  test('parent files new titles as subtasks of a task already written', async () => {
    const tasks = setup();
    await tasks({ action: 'add', titles: ['Ship the fix'] });
    await tasks({ action: 'add', titles: ['Write it', 'Test it'], parent: 't1' });
    const res = await tasks({ action: 'list' }) as {
      tasks: Array<{ id: string; subtasks?: Array<{ id: string; status: string }> }>;
    };
    expect(res.tasks.length).toBe(1);
    expect(res.tasks[0]!.subtasks!.map((s) => s.id)).toEqual(['t2', 't3']);
  });

  test('update moves an item and names what closing a parent leaves open', async () => {
    const tasks = setup();
    await tasks({ action: 'add', titles: ['Ship the fix'] });
    await tasks({ action: 'add', titles: ['Write it', 'Test it'], parent: 't1' });
    await tasks({ action: 'update', id: 't2', status: 'done' });

    const closed = await tasks({ action: 'update', id: 't1', status: 'done' }) as {
      id: string; status: string; open_subtasks?: number;
    };
    expect(closed.status).toBe('done');
    expect(closed.open_subtasks).toBe(1);

    // Nothing left open ⇒ nothing said about it.
    await tasks({ action: 'update', id: 't3', status: 'done' });
    const clean = await tasks({ action: 'update', id: 't1', status: 'done' }) as { open_subtasks?: number };
    expect(clean.open_subtasks).toBeUndefined();
  });

  test('a bad call is refused with what was wrong, never silently', async () => {
    const tasks = setup();
    expect(await tasks({ action: 'add', titles: [] })).toEqual({ error: 'tasks.add requires `titles` — one or more task titles' });
    expect(await tasks({ action: 'update', status: 'done' })).toEqual({ error: 'tasks.update requires `id`' });
    expect(await tasks({ action: 'update', id: 't1', status: 'finished' })).toEqual({
      error: 'tasks.update requires `status` — one of open, active, done, dropped',
    });
    expect(await tasks({ action: 'update', id: 't9', status: 'done' })).toEqual({ error: 'no task t9' });
    expect(await tasks({ action: 'sort' })).toEqual({ error: "unknown tasks action 'sort'" });
  });

  test('a refused title is reported beside the ones that landed', async () => {
    const tasks = setup();
    const res = await tasks({ action: 'add', titles: ['a real step', '   '] }) as {
      added: Array<{ id: string }>; rejected: Array<{ title: string; reason: string }>;
    };
    expect(res.added.map((t) => t.id)).toEqual(['t1']);
    expect(res.rejected).toEqual([{ title: '   ', reason: 'empty title' }]);
  });

  test('the documented example is a call this schema accepts', async () => {
    // House rule: a spec's example is one REAL call. Parsing it and running it
    // is what keeps that true as either side changes.
    const example = BUILTIN_TOOL_SPECS.tasks.example;
    const args = JSON.parse(
      example
        .replace(/^tasks\(/, '')
        .replace(/\)$/, '')
        .replace(/([{,]\s*)(\w+):/g, '$1"$2":')
        .replace(/'/g, '"'),
    ) as Record<string, unknown>;

    const schema = (buildBuiltinTools({ rt: createTestRuntime().rt }).tasks!
      .inputSchema as { jsonSchema: { properties: Record<string, unknown>; required: string[] } }).jsonSchema;
    for (const key of Object.keys(args)) expect(Object.keys(schema.properties)).toContain(key);
    for (const key of schema.required) expect(Object.keys(args)).toContain(key);

    const tasks = setup();
    const res = await tasks(args) as { added: Array<{ id: string }> };
    expect(res.added.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
  });
});

describe('tasks.* codemode — the SAME dispatcher and store the native tool uses', () => {
  test('tasks.add/update/list share state with the native tool over the same TaskListStore', async () => {
    const { rt, testSql } = createTestRuntime();
    initAllTables(testSql.execRaw);
    initTaskListTable(testSql.execRaw);
    const taskList = new TaskListStore(rt.storage.sql);
    const provider = createTasksCodemodeProvider(taskList);

    const added = await provider.tools.add!.execute(['Reproduce the bug', 'Write the fix']) as {
      added: Array<{ id: string }>;
    };
    expect(added.added.length).toBe(2);

    // The native tool's own dispatcher, over the SAME store, sees it —
    // one implementation, two callers, not a shadow copy.
    const nativeTasks = (buildBuiltinTools({ rt }).tasks!.execute) as unknown as
      (args: Record<string, unknown>) => Promise<{ tasks: Array<{ id: string; title: string; status: string }> }>;
    const listed = await nativeTasks({ action: 'list' });
    expect(listed.tasks.map((t) => t.title)).toEqual(['Reproduce the bug', 'Write the fix']);

    await provider.tools.update!.execute(added.added[0]!.id, 'done');
    const after = await nativeTasks({ action: 'list' });
    expect(after.tasks.find((t) => t.id === added.added[0]!.id)?.status).toBe('done');
  });

  test('tasks.list reads the whole list back with subtasks, closed items included', async () => {
    const { rt, testSql } = createTestRuntime();
    initAllTables(testSql.execRaw);
    initTaskListTable(testSql.execRaw);
    const taskList = new TaskListStore(rt.storage.sql);
    const provider = createTasksCodemodeProvider(taskList);
    await provider.tools.add!.execute(['Parent task']);
    await provider.tools.add!.execute(['Child task'], 't1');
    await provider.tools.update!.execute('t2', 'dropped');
    const result = await provider.tools.list!.execute() as {
      tasks: Array<{ id: string; subtasks?: Array<{ id: string; title: string; status: string }> }>;
    };
    expect(result.tasks.length).toBe(1);
    expect(result.tasks[0]!.subtasks).toEqual([{ id: 't2', title: 'Child task', status: 'dropped' }]);
  });
});
