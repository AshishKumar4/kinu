// Defends: a model's tool call is checked against the tool's one schema before the tool runs, and a refusal reaches the
// durable outcome as `bad_input`. Before, the SDK was handed an unvalidated JSON literal and every tool re-parsed alone.
import { describe, expect, test } from 'bun:test';
import { scriptedTurnModel, type ScriptedTurnResult } from '@kinu.run/test-utils/turn-model';
import { createMemoryVfs, createTestRuntime, toolExecute } from '@kinu.run/test-utils';
import { runChat, UNBOUNDED_STEPS, type ChatEvent } from '../src/index';
import { createFileTool } from '../src/tools/file-tool';
import { TurnFileLedger } from '../src/vfs/file-ledger';
import { TurnContextBudget } from '../src/context-budget';
import { createTasksCodemodeProvider } from '../src/tools/tasks-codemode';
import { createReportCodemodeProvider } from '../src/delegation/report-codemode';
import { buildBuiltinTools, type ReportToolDeps } from '../src/tools/builtins';
import { initAllTables, initTaskListTable, TaskListStore } from '../src/index';
import type { VFS } from '../src/types/primitives';
import type { JsonObject, JsonValue } from '../src/utils/json';
import type { FactsStore } from '../src/memory/facts';
import type { PlanEdit, SubmitPlanToolDeps } from '../src/types/plans';
import { storesFor } from './helpers';

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

/** A memory file store that records every write, so a refused call can be shown to have written nothing. */
function recordingVfs(seed: Record<string, string>) {
  const memory = createMemoryVfs();
  const writes: string[] = [];

  for (const [path, text] of Object.entries(seed)) memory.files.set(path, text);

  const vfs: VFS = {
    ...memory.vfs,
    async writeFile(path, content) {
      writes.push(path);
      await memory.vfs.writeFile(path, content);
    },
  };

  return { vfs, files: memory.files, writes };
}

/** One model step calling `file` with `input`, then a closing text step. */
function modelCalling(input: JsonObject) {
  let step = 0;

  return scriptedTurnModel({
    doGenerate: (): ScriptedTurnResult => (step++ === 0
      ? {
        content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'file', input: JSON.stringify(input) }],
        finishReason: { unified: 'tool-calls', raw: undefined }, usage: USAGE, warnings: [],
      }
      : { content: [{ type: 'text', text: 'done' }], finishReason: { unified: 'stop', raw: undefined }, usage: USAGE, warnings: [] }),
  });
}

async function toolResults(input: JsonObject, seed: Record<string, string>) {
  const store = recordingVfs(seed);
  const file = createFileTool({ vfs: store.vfs, ledger: new TurnFileLedger(), budget: new TurnContextBudget() });
  const results: Extract<ChatEvent, { type: 'tool-result' }>[] = [];
  const model = modelCalling(input);

  for await (const event of runChat({
    model, system: 's', history: [{ role: 'user', content: 'go' }], tools: { file }, stopWhen: UNBOUNDED_STEPS,
  })) {
    if (event.type === 'tool-result') results.push(event);
  }

  const fedBack = (model.doStreamCalls.at(-1)?.prompt ?? []).flatMap((message) => message.role === 'tool'
    ? message.content.flatMap((part) => part.type === 'tool-result' ? [part.output] : [])
    : []);

  return { results, store, fedBack };
}

describe('a tool call the schema refuses', () => {
  test('never reaches the tool, and is recorded as the model\'s bad input naming the field', async () => {
    // An edit without new_text: before the schema was checked, the missing field could reach the edit as a deletion.
    const { results, store } = await toolResults({ action: 'edit', path: 'a.ts', edits: [{ old_text: 'alpha' }] }, { 'a.ts': 'alpha\n' });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ success: false, reason: 'bad_input' });
    expect(results[0]?.error).toContain('new_text');
    expect({ file: store.files.get('a.ts'), writes: store.writes }).toEqual({ file: 'alpha\n', writes: [] });
  });

  test('the model is told why in the schema\'s words, classified, not the SDK\'s JSON dump', async () => {
    const { results, fedBack } = await toolResults({ action: 'edit', path: 'a.ts', edits: [{ old_text: 'alpha' }] }, { 'a.ts': 'alpha\n' });

    expect(fedBack).toEqual([{ type: 'error-json', value: { reason: 'bad_input', error: expect.stringContaining('new_text') } }]);
    // Neither the event nor the model's feedback carries zod's or the SDK's JSON dump of the issues.
    expect(JSON.stringify([results[0]?.error, fedBack])).not.toContain('\\"code\\"');
  });

  test('an off-vocabulary action is refused the same way, before any read', async () => {
    const { results } = await toolResults({ action: 'delete', path: 'a.ts' }, { 'a.ts': 'alpha\n' });

    expect(results[0]).toMatchObject({ success: false, reason: 'bad_input' });
    expect(results[0]?.error).toContain('action');
  });

  test('a well-formed call still runs', async () => {
    const { results } = await toolResults({ action: 'stat', path: 'a.ts' }, { 'a.ts': 'alpha\n' });

    expect(results[0]).toMatchObject({ success: true });
  });
});

describe('a program calling a namespace with a value the tool\'s schema refuses', () => {
  test('is refused as bad input by the same schema, and the store is untouched', async () => {
    const { rt, tasks } = taskWorld();
    const [task] = tasks.add(['ship it'], null, 1).added;

    if (task === undefined) throw new Error('the store added no task');
    const provider = createTasksCodemodeProvider(tasks, rt.actor.config);

    const outcome = await provider.tools.update?.execute(task.id, 'finished');

    expect(outcome).toMatchObject({ success: false, reason: 'bad_input' });
    expect(JSON.stringify(outcome)).toContain('status');
    expect(JSON.stringify(outcome)).not.toContain('\\"code\\"');
    expect(tasks.list().map((listed) => listed.status)).toEqual(['open']);
  });
});

/** A task list on a fresh runtime, and its store. */
function taskWorld() {
  const { rt, testSql } = createTestRuntime();
  initAllTables(testSql.execRaw, testSql.sql);
  initTaskListTable(testSql.execRaw);

  return { rt, tasks: new TaskListStore(rt.storage.sql, rt.actor, rt.storage.transactionSync) };
}

describe('a call base ran is still run', () => {
  test('does not refuse a call that ran before: a report longer than the advertised 20,000 characters is delivered', async () => {
    const delivered: string[] = [];

    const report: ReportToolDeps['report'] = async ({ content }) => {
      delivered.push(content);

      return { ok: true };
    };

    const provider = createReportCodemodeProvider(() => ({ report }));

    const outcome = await provider.tools.send?.execute('completed', 'x'.repeat(20_001));

    expect(outcome).toEqual({ ok: true });
    expect(delivered.map((content) => content.length)).toEqual([20_001]);
  });

  test('a confidence given as a percentage is clamped and saved, as the facts store clamps it', async () => {
    const saved: Array<number | undefined> = [];
    const { rt } = createTestRuntime();

    const facts: FactsStore = {
      upsert: (_key, _value, opts) => {
        saved.push(opts?.confidence);

        return 'created';
      },
      recall: () => null, forget: () => {}, recentTopK: () => [], all: () => [],
    };

    const memory = toolExecute<{ action: string; key: string; value: string; confidence: number }, JsonValue>(
      buildBuiltinTools({ rt, facts, history: storesFor(rt).history }).memory,
    );

    expect(await memory({ action: 'remember', key: 'deploy.target', value: 'production', confidence: 95 })).toMatchObject({ ok: true });
    expect(saved).toEqual([1]);
  });

  test('a plan edit with a key it does not read, in a batch over 100, is submitted without it', async () => {
    const received: Array<readonly PlanEdit[]> = [];
    const { rt } = createTestRuntime();

    const submit: SubmitPlanToolDeps['submit'] = (edits) => {
      received.push(edits);

      return { ok: false, error: 'recorded', plan: null };
    };

    const submitPlan = toolExecute<{ edits: Array<PlanEdit & { reason: string }> }, JsonValue>(
      buildBuiltinTools({ rt, history: storesFor(rt).history, submitPlan: { submit } }).submit_plan,
    );

    await submitPlan({ edits: Array.from({ length: 101 }, (_, index) => ({ start: index + 1, content: 'x', reason: 'first' })) });

    expect(received.map((edits) => [edits.length, edits[0]])).toEqual([[101, { start: 1, content: 'x' }]]);
  });

  test('tasks.mode(null) reads the active role, as no argument does', async () => {
    const { rt, tasks } = taskWorld();
    const provider = createTasksCodemodeProvider(tasks, rt.actor.config);

    expect(await provider.tools.mode?.execute(null)).toEqual(await provider.tools.mode?.execute());
    expect(await provider.tools.mode?.execute(null)).toMatchObject({ role: expect.any(String) });
  });
});
