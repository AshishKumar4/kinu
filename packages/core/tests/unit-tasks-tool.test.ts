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
  buildSystemPromptSync, createAgentConfigStore,
  BUILTIN_PROFILE_CATALOG, BUILTIN_ROLE_DEFINITIONS, deriveRoleLabel, profileCatalogDigest,
  type AgentRuntime, type CodemodeProvider, type JsonValue, type ProfileCatalogEnvelope,
} from '../src/index';

type TasksResult = object | string | number | boolean | null | undefined;
interface TasksTestInput {
  action: string;
  titles?: (string | number)[];
  parent?: string;
  id?: string;
  status?: string;
  role?: string;
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

const PROFILE_ENVELOPE: ProfileCatalogEnvelope = {
  authority: { kind: 'local' },
  version: 0,
  digest: profileCatalogDigest(BUILTIN_PROFILE_CATALOG),
  catalog: BUILTIN_PROFILE_CATALOG,
};

function nativeTasks(rt: AgentRuntime): Exec {
  const entry = buildBuiltinTools({ rt, roleAuthority: () => PROFILE_ENVELOPE }).tasks;
  if (!entry) throw new Error('Expected tasks tool to be registered');
  return toolExecute<TasksTestInput, TasksResult>(entry);
}

function setup(): Exec {
  const { rt, testSql } = createTestRuntime();
  initAllTables(testSql.execRaw, testSql.sql);
  initTaskListTable(testSql.execRaw, testSql.sql);
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
    initTaskListTable(testSql.execRaw, testSql.sql);
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
    initTaskListTable(testSql.execRaw, testSql.sql);
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

// The wiring this axis stands on: what the agent sets through the tool is what
// the next turn resolves from the catalog.
describe('tasks action=mode — the agent\'s durable role', () => {
  function roleSetup() {
    const { rt, testSql } = createTestRuntime();
    initAllTables(testSql.execRaw, rt.storage.sql);
    initTaskListTable(testSql.execRaw, testSql.sql);
    initAgentConfigTable(testSql.execRaw);
    return { tasks: nativeTasks(rt), rt, config: createAgentConfigStore(rt.storage.sql) };
  }

  function roleSection(roleId: keyof typeof BUILTIN_ROLE_DEFINITIONS) {
    return {
      id: roleId,
      label: deriveRoleLabel(roleId),
      instructions: BUILTIN_ROLE_DEFINITIONS[roleId].instructions,
    };
  }

  test('a role switch persists for the next prompt', async () => {
    const { tasks, rt, config } = roleSetup();
    expect(config.getRoleSelection()).toEqual({ kind: 'catalog', roleId: 'general' });
    expect(await tasks({ action: 'mode', role: 'researcher' })).toEqual({ role: 'researcher'});
    expect(config.getRoleSelection()).toEqual({ kind: 'catalog', roleId: 'researcher' });

    const prompt = buildSystemPromptSync(rt, { roleSection: roleSection('researcher') });
    expect(prompt).toContain('Role: Researcher');
    expect(prompt).toContain(BUILTIN_ROLE_DEFINITIONS.researcher.instructions);
  });

  test('mode with no role reads the current role', async () => {
    const { tasks } = roleSetup();
    expect(await tasks({ action: 'mode' })).toEqual({ role: 'general', roleSource: 'catalog' });
    await tasks({ action: 'mode', role: 'auditor' });
    expect(await tasks({ action: 'mode' })).toEqual({ role: 'auditor', roleSource: 'catalog' });
  });

  test('an unknown role is refused and changes nothing', async () => {
    const { tasks } = roleSetup();
    await tasks({ action: 'mode', role: 'auditor' });
    const refused = await tasks({ action: 'mode', role: 'yolo' });
    // The refusal names the role it could not find and the roles it can.
    expect(refused).toMatchObject({ error: expect.stringMatching(/"yolo"[^]*Known roles: auditor/) });
    expect(await tasks({ action: 'mode' })).toEqual({ role: 'auditor', roleSource: 'catalog' });
  });

  test('switching to implementer during a Plan turn does not lift the Plan bar', async () => {
    const { tasks, rt } = roleSetup();
    expect(await tasks({ action: 'mode', role: 'implementer' })).toEqual({ role: 'implementer'});

    const plan = buildSystemPromptSync(rt, {
      workMode: 'plan',
      planSubmissionAvailable: true,
      roleSection: roleSection('implementer'),
    });
    expect(plan).toContain('Role: Implementer');
    expect(plan).toContain('Do not change files, system state, releases, or deployments');
    expect(plan).toMatch(/do not begin implementation/i);
    expect(Object.keys(buildBuiltinTools({ rt }))).not.toContain('submit_plan');
  });

  test('the model can discover durable role switching from the schema', () => {
    const { rt } = createTestRuntime();
    const entry = buildBuiltinTools({ rt, roleAuthority: () => PROFILE_ENVELOPE }).tasks;
    const description = entry?.description ?? '';
    expect(description).toContain('mode switches your durable role');
    expect(BUILTIN_TOOL_SPECS.tasks.whenToUse).toContain('mode switches your durable role');
  });
});
