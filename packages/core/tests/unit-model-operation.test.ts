// The model-operation lifecycle seam (events/model-call.ts) — the durable
// start/end pair every direct model operation writes, so a process killed
// mid-call leaves a row naming what was in flight instead of nothing at all.
//
// Behaviour tests through the public seams: beginModelOperation around real
// provider stubs, projected onto a real RunEventRecorder over SQLite.
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { MockLanguageModelV3 } from 'ai/test';
import {
  beginModelOperation, createCompletionLLM, createVercelAILLM,
  initRunEventTables, recordModelOperations, RunEventRecorder,
  WORKSPACE_RUN_ID,
  type RunEvent,
} from '../src/index';
import { makeSql, makeExecRaw } from './helpers';

function setup() {
  const db = new Database(':memory:');
  initRunEventTables(makeExecRaw(db));
  const sql = makeSql(db);
  return { db, recorder: new RunEventRecorder(sql), sql };
}

const operationsOf = (recorder: RunEventRecorder, runId: string) =>
  recorder.read(runId).flatMap((event): Extract<RunEvent, { type: 'model_operation' }>[] =>
    event.type === 'model_operation' ? [event] : []);

describe('beginModelOperation — the start row exists while the call runs', () => {
  test('an operation that starts and never ends leaves a start row naming it', () => {
    const { recorder } = setup();
    const sink = recordModelOperations(recorder, () => 'run-1');
    // The frame opens, the call is in flight, the frame's owner dies. Nothing
    // else happens — which is exactly the incident shape the row exists for.
    const op = beginModelOperation({ source: 'fast', report: () => {}, operations: sink }, 'complete');
    void op;

    const rows = operationsOf(recorder, 'run-1');
    expect(rows).toHaveLength(1);
    const start = rows[0]!;
    expect(start.phase).toBe('start');
    expect(start.source).toBe('fast');
    expect(start.op).toBe('complete');
    expect(start.operationId).toMatch(/^op-/);
    expect(start.usage).toBeUndefined();
    // And the read side answers the question the row was written for.
    expect(recorder.unterminatedModelOperations().map((event) => event.operationId))
      .toEqual([start.operationId]);
  });

  test('usage lands on the end row, joined to its start by the operation id', () => {
    const { recorder } = setup();
    const sink = recordModelOperations(recorder, () => 'run-1');
    const op = beginModelOperation(
      { source: 'judge', report: () => {}, operations: sink },
      'generate_json',
      { spec: 'anthropic/claude-x' },
    );
    op.completed({ usage: { input: 41, output: 7 }, modelId: 'claude-x' });

    const rows = operationsOf(recorder, 'run-1');
    expect(rows.map((row) => row.phase)).toEqual(['start', 'end']);
    expect(rows[0]!.operationId).toBe(rows[1]!.operationId);
    const end = rows[1]!;
    expect(end.outcome).toBe('ok');
    expect(end.usage).toEqual({ input: 41, output: 7 });
    expect(end.modelId).toBe('claude-x');
    expect(end.spec).toBe('anthropic/claude-x');
    expect(recorder.unterminatedModelOperations()).toEqual([]);
  });

  test('a failed call ends failed, with a bounded cause and no usage', () => {
    const { recorder } = setup();
    const sink = recordModelOperations(recorder, () => 'run-1');
    const op = beginModelOperation(
      { source: 'reflection', report: () => {}, operations: sink }, 'complete',
    );
    op.failed({ cause: new Error(`provider boom ${'x'.repeat(500)}`) });

    const rows = operationsOf(recorder, 'run-1');
    const end = rows[1]!;
    expect(end.outcome).toBe('failed');
    expect(end.error).toContain('provider boom');
    expect(end.error!.length).toBeLessThanOrEqual(300);
    expect(end.usage).toBeUndefined();
    expect(recorder.unterminatedModelOperations()).toEqual([]);
  });

  test('exactly one end row is written however many times the frame settles', () => {
    const { recorder } = setup();
    const sink = recordModelOperations(recorder, () => 'run-1');
    const op = beginModelOperation(
      { source: 'fast', report: () => {}, operations: sink }, 'stream',
    );
    op.completed({ usage: {} });
    op.failed({ cause: new Error('after the fact') });
    expect(operationsOf(recorder, 'run-1').map((row) => row.phase)).toEqual(['start', 'end']);
  });
});

describe('the optional contract — unwired means unattributed, never fabricated', () => {
  test('no spend, no rows', () => {
    const { recorder } = setup();
    const op = beginModelOperation(undefined, 'complete');
    op.completed({ usage: { input: 1 } });
    op.failed({ cause: new Error('x') });
    expect(recorder.read(WORKSPACE_RUN_ID)).toEqual([]);
    expect(recorder.unterminatedModelOperations()).toEqual([]);
  });

  test('a spend without an operations sink writes no lifecycle rows', () => {
    const { recorder } = setup();
    const op = beginModelOperation({ source: 'fast', report: () => {} }, 'complete');
    op.completed({ usage: {} });
    expect(operationsOf(recorder, WORKSPACE_RUN_ID)).toEqual([]);
  });
});

describe('recordModelOperations — one projection, filed under the live run', () => {
  test('rows ride the run the provider supplies, or the workspace bucket between runs', () => {
    const { recorder } = setup();
    let runId: string = WORKSPACE_RUN_ID;
    const sink = recordModelOperations(recorder, () => runId);
    sink({ operationId: 'op-before', source: 'advisor', op: 'complete', phase: 'start' });
    runId = 'run-open';
    sink({ operationId: 'op-after', source: 'advisor', op: 'complete', phase: 'start' });
    expect(operationsOf(recorder, WORKSPACE_RUN_ID)).toHaveLength(1);
    expect(operationsOf(recorder, 'run-open')).toHaveLength(1);
  });
});

describe('the production seams open the frame before the request', () => {
  function textModel(overrides?: { throwError?: string }): MockLanguageModelV3 {
    return new MockLanguageModelV3({
      doGenerate: async () => {
        if (overrides?.throwError) throw new Error(overrides.throwError);
        return {
          content: [{ type: 'text' as const, text: 'done' }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: {
            inputTokens: { total: 41, noCache: 41, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 7, text: 7, reasoning: undefined },
          },
          warnings: [],
        };
      },
    });
  }

  test('createCompletionLLM writes the pair, with the resolved spec on both rows', async () => {
    const { recorder } = setup();
    const sink = recordModelOperations(recorder, () => WORKSPACE_RUN_ID);
    const llm = createCompletionLLM({
      model: textModel(),
      spec: 'workers-ai/@cf/deepseek-ai/deepseek-v4-pro-0813',
      stage: 'judge',
      spend: { source: 'judge', report: () => {}, operations: sink },
    });
    await llm.complete('grade this');

    const rows = operationsOf(recorder, WORKSPACE_RUN_ID);
    expect(rows.map((row) => row.phase)).toEqual(['start', 'end']);
    expect(rows.every((row) => row.spec === 'workers-ai/@cf/deepseek-ai/deepseek-v4-pro-0813')).toBe(true);
    expect(rows[1]!.usage).toEqual({ input: 41, output: 7 });
  });
  test('createVercelAILLM.complete closes the frame as failed when the endpoint dies', async () => {
    // This factory really dials its baseURL, so the honest stub is an unroutable
    // one — which makes this the transport-failure case: the pair must still
    // close, naming the fault, and leave nothing unterminated.
    const { recorder } = setup();
    const sink = recordModelOperations(recorder, () => WORKSPACE_RUN_ID);
    const llm = createVercelAILLM({
      name: 'workers-ai',
      baseURL: 'https://kinu-operation-test.invalid/',
      headers: {},
      model: '@cf/deepseek-ai/deepseek-v4-pro-0813',
      spend: { source: 'reflection', report: () => {}, operations: sink },
    });
    await expect(llm.complete('reflect')).rejects.toThrow();

    const rows = operationsOf(recorder, WORKSPACE_RUN_ID);
    expect(rows.map((row) => row.phase)).toEqual(['start', 'end']);
    expect(rows[1]!.outcome).toBe('failed');
    expect(recorder.unterminatedModelOperations()).toEqual([]);
  });

  test('a provider fault still closes the frame as failed', async () => {
    const { recorder } = setup();
    const sink = recordModelOperations(recorder, () => WORKSPACE_RUN_ID);
    const llm = createCompletionLLM({
      model: textModel({ throwError: 'socket hung up' }),
      spec: 'openai/gpt-x',
      stage: 'reflection',
      spend: { source: 'fast', report: () => {}, operations: sink },
    });
    await expect(llm.complete('classify')).rejects.toThrow('socket hung up');

    const rows = operationsOf(recorder, WORKSPACE_RUN_ID);
    expect(rows[0]!.phase).toBe('start');
    expect(rows[1]!.outcome).toBe('failed');
    expect(rows[1]!.error).toContain('socket hung up');
  });
});
