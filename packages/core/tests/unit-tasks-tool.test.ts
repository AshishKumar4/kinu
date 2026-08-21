// Behaviour tests for the `tasks` tool — the model-facing surface over
// TaskListStore. The store's own semantics are pinned in unit-task-list.test.ts;
// what is tested here is the contract the model sees: the argument names, what
// a refusal says, and what comes back.
import { describe, test, expect } from 'bun:test';
import { createTestRuntime, toolExecute } from '@kinu.run/test-utils';
import * as v from 'valibot';
import {
  buildBuiltinTools, initAllTables, initTaskListTable, BUILTIN_TOOL_SPECS,
  createTasksCodemodeProvider, TaskListStore, initAgentConfigTable,
  buildSystemPromptSync, createAgentConfigStore, AGENT_STANCES,
  type AgentRuntime, type CodemodeProvider, type JsonValue,
} from '../src/index';

type TasksResult = object | string | number | boolean | null | undefined;
interface TasksTestInput {
  action: string;
  titles?: (string | number)[];
  parent?: string;
  id?: string;
  status?: string;
  stance?: string;
}
type Exec = (args: TasksTestInput) => Promise<TasksResult>;

const AddedSchema = v.object({
  added: v.array(v.object({ id: v.string(), title: v.optional(v.string()), parent: v.optional(v.nullable(v.string())) })),
});
const TaskListSchema = v.object({
  tasks: v.array(v.object({
    id: v.string(), title: v.optional(v.string()), status: v.optional(v.string()),
    subtasks: v.optional(v.array(v.object({
      id: v.string(), title: v.optional(v.string()), status: v.string(),
    }))),
  })),
});

function nativeTasks(rt: AgentRuntime): Exec {
  const entry = buildBuiltinTools({ rt }).tasks;
  if (!entry) throw new Error('Expected tasks tool to be registered');
  return toolExecute<TasksTestInput, TasksResult>(entry);
}

function setup(): Exec {
  const { rt, testSql } = createTestRuntime();
  initAllTables(testSql.execRaw, testSql.sql);
  initTaskListTable(testSql.execRaw);
  return nativeTasks(rt);
}

function codemodeExecute(provider: CodemodeProvider, name: string) {
  const entry = provider.tools[name];
  if (!entry) throw new Error(`Expected ${provider.name}.${name} to be registered`);
  return async (...args: JsonValue[]) => await entry.execute(...args);
}

describe('tasks tool', () => {
  test('add writes the whole plan in one call and returns the ids in order', async () => {
    const tasks = setup();
    const res = v.parse(
      AddedSchema,
      await tasks({ action: 'add', titles: ['Reproduce the 502', 'Patch the timeout'] }),
    );
    expect(res.added.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(res.added[0]?.parent).toBeNull();
  });

  test('parent files new titles as subtasks of a task already written', async () => {
    const tasks = setup();
    await tasks({ action: 'add', titles: ['Ship the fix'] });
    await tasks({ action: 'add', titles: ['Write it', 'Test it'], parent: 't1' });
    const res = v.parse(TaskListSchema, await tasks({ action: 'list' }));
    expect(res.tasks.length).toBe(1);
    expect(res.tasks[0]?.subtasks?.map((subtask) => subtask.id)).toEqual(['t2', 't3']);
  });

  test('update moves an item and names what closing a parent leaves open', async () => {
    const tasks = setup();
    await tasks({ action: 'add', titles: ['Ship the fix'] });
    await tasks({ action: 'add', titles: ['Write it', 'Test it'], parent: 't1' });
    await tasks({ action: 'update', id: 't2', status: 'done' });

    const closed = v.parse(v.object({
      id: v.string(), status: v.string(), open_subtasks: v.optional(v.number()),
    }), await tasks({ action: 'update', id: 't1', status: 'done' }));
    expect(closed.status).toBe('done');
    expect(closed.open_subtasks).toBe(1);

    // Nothing left open ⇒ nothing said about it.
    await tasks({ action: 'update', id: 't3', status: 'done' });
    const clean = v.parse(v.object({
      open_subtasks: v.optional(v.number()),
    }), await tasks({ action: 'update', id: 't1', status: 'done' }));
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
    // This assertion used to pin `unknown tasks action 'sort'` — a refusal that
    // named nothing the model could use next. The gate existed and asserted the
    // defect. It now names the vocabulary AND echoes what arrived, which is the
    // one wording every native dispatcher shares (registry.unknownActionError).
    expect(await tasks({ action: 'sort' })).toEqual({
      error: 'tasks requires `action` — one of add, update, list, mode; got "sort"',
    });
  });

  test('a refused title is reported beside the ones that landed', async () => {
    const tasks = setup();
    const res = v.parse(v.object({
      added: v.array(v.object({ id: v.string() })),
      rejected: v.array(v.object({ title: v.string(), reason: v.string() })),
    }), await tasks({ action: 'add', titles: ['a real step', '   '] }));
    expect(res.added.map((t) => t.id)).toEqual(['t1']);
    expect(res.rejected).toEqual([{ title: '   ', reason: 'empty title' }]);
  });

  test('the documented example is a call this schema accepts', async () => {
    // House rule: a spec's example is one REAL call. Parsing it and running it
    // is what keeps that true as either side changes.
    const example = BUILTIN_TOOL_SPECS.tasks.example;
    const args = v.parse(v.object({
      action: v.literal('add'), titles: v.array(v.string()), parent: v.optional(v.string()),
    }), JSON.parse(
      example
        .replace(/^tasks\(/, '')
        .replace(/\)$/, '')
        .replace(/([{,]\s*)(\w+):/g, '$1"$2":')
        .replace(/'/g, '"'),
    ));

    const entry = buildBuiltinTools({ rt: createTestRuntime().rt }).tasks;
    if (!entry) throw new Error('Expected tasks tool to be registered');
    const schema = v.parse(v.object({ jsonSchema: v.object({
      properties: v.record(v.string(), v.unknown()), required: v.array(v.string()),
    }) }), entry.inputSchema).jsonSchema;
    for (const key of Object.keys(args)) expect(Object.keys(schema.properties)).toContain(key);
    for (const key of schema.required) expect(Object.keys(args)).toContain(key);

    const tasks = setup();
    const res = v.parse(AddedSchema, await tasks(args));
    expect(res.added.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
  });

  // The AI SDK does not validate a jsonSchema-declared tool input: `jsonSchema`
  // leaves `Schema.validate` undefined and `safeValidateTypes` then returns the
  // raw JSON untouched. So `action` is whatever the model emitted, and the
  // declared literal union is a claim about it — which is how
  // `{"action":"list\">"}` reached the dispatcher in production and was answered
  // `unknown tasks action 'list">'`: true, and useless.
  describe('a model-supplied action outside the vocabulary is answered WITH the vocabulary', () => {
    test('the exact production payload is refused by naming all four actions', async () => {
      const tasks = setup();
      const error = v.parse(v.object({ error: v.string() }), await tasks({ action: 'list">' })).error;
      for (const action of ['add', 'update', 'list', 'mode']) expect(error).toContain(action);
      // The old answer named none of them. A refusal the model cannot act on is
      // how a single malformed call becomes a loop.
      expect(error).not.toContain('unknown tasks action');
    });

    test('every wrong shape of action is refused the same way, not crashed on', async () => {
      const tasks = setup();
      for (const action of ['', 'LIST', 'listen', 'add ', '{"action":"list"}']) {
        const result = v.parse(v.object({ error: v.string() }), await tasks({ action }));
        expect(result.error).toContain('one of add, update, list, mode');
      }
    });

    test('a valid action still works, and the list is untouched by a refused call', async () => {
      const tasks = setup();
      await tasks({ action: 'add', titles: ['ship it'] });
      await tasks({ action: 'list">' });
      const listed = v.parse(TaskListSchema, await tasks({ action: 'list' }));
      expect(listed.tasks.map((t) => t.id)).toEqual(['t1']);
    });

    test('titles of the wrong type are refused, not fed to `raw.trim()`', async () => {
      // TaskListStore.add trims each title, so a non-string element threw a
      // TypeError out of the tool instead of answering the model.
      const tasks = setup();
      const bad = await tasks({ action: 'add', titles: [1, 2] });
      expect(v.parse(v.object({ error: v.string() }), bad).error).toContain('array of task titles');
    });
  });
});

describe('tasks.* codemode — the SAME dispatcher and store the native tool uses', () => {
  test('tasks.add/update/list share state with the native tool over the same TaskListStore', async () => {
    const { rt, testSql } = createTestRuntime();
    initAllTables(testSql.execRaw, testSql.sql);
    initTaskListTable(testSql.execRaw);
    const taskList = new TaskListStore(rt.storage.sql);
    const provider = createTasksCodemodeProvider(taskList, createAgentConfigStore(rt.storage.sql));

    const added = v.parse(
      AddedSchema,
      await codemodeExecute(provider, 'add')(['Reproduce the bug', 'Write the fix']),
    );
    expect(added.added.length).toBe(2);

    // The native tool's own dispatcher, over the SAME store, sees it —
    // one implementation, two callers, not a shadow copy.
    const executeNative = nativeTasks(rt);
    const listed = v.parse(TaskListSchema, await executeNative({ action: 'list' }));
    expect(listed.tasks.map((t) => t.title)).toEqual(['Reproduce the bug', 'Write the fix']);

    const firstId = added.added[0]?.id ?? '';
    await codemodeExecute(provider, 'update')(firstId, 'done');
    const after = v.parse(TaskListSchema, await executeNative({ action: 'list' }));
    expect(after.tasks.find((task) => task.id === firstId)?.status).toBe('done');
  });

  test('tasks.list reads the whole list back with subtasks, closed items included', async () => {
    const { rt, testSql } = createTestRuntime();
    initAllTables(testSql.execRaw, testSql.sql);
    initTaskListTable(testSql.execRaw);
    const taskList = new TaskListStore(rt.storage.sql);
    const provider = createTasksCodemodeProvider(taskList, createAgentConfigStore(rt.storage.sql));
    await codemodeExecute(provider, 'add')(['Parent task']);
    await codemodeExecute(provider, 'add')(['Child task'], 't1');
    await codemodeExecute(provider, 'update')('t2', 'dropped');
    const result = v.parse(TaskListSchema, await codemodeExecute(provider, 'list')());
    expect(result.tasks.length).toBe(1);
    expect(result.tasks[0]?.subtasks).toEqual([{ id: 't2', title: 'Child task', status: 'dropped' }]);
  });
});

// The wiring this whole axis stands on: what the agent SETS through the tool
// has to be what the next turn's system prompt CARRIES. Cut any link — the
// dispatcher's write, the config accessor, the prompt's stance option, or the
// render loop — and these fail.
describe('tasks action=mode — the agent\'s own working stance', () => {
  function stanceSetup() {
    const { rt, testSql } = createTestRuntime();
    initAllTables(testSql.execRaw, rt.storage.sql);
    initTaskListTable(testSql.execRaw);
    initAgentConfigTable(testSql.execRaw);
    return { tasks: nativeTasks(rt), rt, config: createAgentConfigStore(rt.storage.sql) };
  }

  test('a stance the agent sets reaches the system prompt it is built with next', async () => {
    const { tasks, rt, config } = stanceSetup();
    // Before: nothing.
    expect(buildSystemPromptSync(rt, { stance: config.getStance() }))
      .not.toContain('Research stance:');

    expect(await tasks({ action: 'mode', stance: 'research' })).toEqual({ stance: 'research' });

    // The backend reads exactly this on the next turn (actor-agent.ts
    // `stance: this.config.getStance()`, local-session.ts likewise).
    const prompt = buildSystemPromptSync(rt, { stance: config.getStance() });
    expect(prompt).toContain('Research stance:');
    expect(prompt).toContain('name the file and line each claim rests on');
  });

  test('mode with no stance reads the current one back, and it is general until set', async () => {
    const { tasks } = stanceSetup();
    expect(await tasks({ action: 'mode' })).toEqual({ stance: 'general' });
    await tasks({ action: 'mode', stance: 'audit' });
    expect(await tasks({ action: 'mode' })).toEqual({ stance: 'audit' });
  });

  test('an unknown stance is refused with the vocabulary, and changes nothing', async () => {
    const { tasks } = stanceSetup();
    await tasks({ action: 'mode', stance: 'audit' });
    expect(await tasks({ action: 'mode', stance: 'yolo' }))
      .toEqual({ error: `tasks.mode requires \`stance\` — one of ${AGENT_STANCES.join(', ')}` });
    expect(await tasks({ action: 'mode' })).toEqual({ stance: 'audit' });
  });

  test('setting a stance mid-Plan-turn does not lift the Plan bar', async () => {
    // The permission axis is the only thing that decides this, and `build` is
    // the hostile stance name to try it with.
    const { tasks, rt, config } = stanceSetup();
    expect(await tasks({ action: 'mode', stance: 'build' })).toEqual({ stance: 'build' });

    const plan = buildSystemPromptSync(rt, {
      workMode: 'plan', planSubmissionAvailable: true, stance: config.getStance(),
    });
    expect(plan).toContain('Build stance:');
    expect(plan).toContain('Do not change files, system state, releases, or deployments');
    expect(plan).toContain('Do not begin implementation until the plan is approved');

    // And the structural half is untouched: submit_plan's presence is decided
    // by the Plan deps, and the stance is not an input to tool construction.
    expect(Object.keys(buildBuiltinTools({ rt }))).not.toContain('submit_plan');
  });

  test('the model can discover the action and its values from the schema alone', async () => {
    // A self-selected stance the agent is never told about is unreachable by
    // construction, so the vocabulary has to be in what the provider reads.
    const { rt } = createTestRuntime();
    const entry = buildBuiltinTools({ rt }).tasks;
    const description = entry?.description ?? '';
    expect(description).toContain('mode sets the stance you work in');
    for (const stance of AGENT_STANCES) expect(description).toContain(`${stance} = `);
    expect(BUILTIN_TOOL_SPECS.tasks.whenToUse).toContain('mode sets the stance you work in');
  });
});
