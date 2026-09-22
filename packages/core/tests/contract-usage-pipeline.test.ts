/**
 * Unreported usage fields stay absent from provider bytes through the durable run record and read model.
 * Whole-pipeline on purpose: any stage (adapter, merge, accumulator, schema, fold) can reintroduce the zero.
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { FetchFunction } from '@ai-sdk/provider-utils';
import { generateText } from 'ai';
import {
  initRunEventTables, RunEventRecorder, TurnAccumulator, closeTurnRun,
  getRunSummaries, normalizeUsage, type RunEventInput, type Usage,
} from '../src/index';
import { testActorHandle } from '@kinu.run/test-utils';
import { makeSql, makeExecRaw } from './helpers';

function jsonReply(serialized: string): FetchFunction {
  const stub = async (): Promise<Response> => new Response(serialized, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

  // `FetchFunction` is the platform `typeof fetch`, which carries `preconnect`.
  return Object.assign(stub, { preconnect: async (): Promise<void> => {} });
}

/**
 * Verbatim usage from the deployed proxy: `cached_tokens: 0` is a reported zero, and `reasoning` is
 * unreported even though @ai-sdk/openai-compatible hands over `reasoningTokens: 0`.
 */
const WORKERS_AI_USAGE = {
  prompt_tokens: 88,
  completion_tokens: 24,
  total_tokens: 112,
  prompt_tokens_details: { cached_tokens: 0 },
  neurons: 19.199999809265137,
};

async function workersAIStepUsage(): Promise<Usage> {
  const provider = createOpenAICompatible({
    name: 'workers-ai',
    baseURL: 'https://example.invalid/v1',
    fetch: jsonReply(JSON.stringify({
      id: 'id-1786985048670', object: 'chat.completion', created: 1786985048,
      model: '@cf/deepseek-ai/deepseek-v4-pro-0813',
      choices: [{
        finish_reason: 'stop', index: 0,
        message: { content: 'ok', reasoning_content: 'thinking', role: 'assistant' },
      }],
      usage: WORKERS_AI_USAGE,
    })),
  });

  const r = await generateText({ model: provider('@cf/deepseek-ai/deepseek-v4-pro-0813'), prompt: 'hi' });

  return normalizeUsage(r.usage);
}

async function anthropicStepUsage(): Promise<Usage> {
  const provider = createAnthropic({
    apiKey: 'test',
    fetch: jsonReply(JSON.stringify({
      id: 'msg_01probe', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
      usage: {
        input_tokens: 12, output_tokens: 5,
        cache_creation_input_tokens: 1024, cache_read_input_tokens: 2048,
        cache_creation: { ephemeral_5m_input_tokens: 24, ephemeral_1h_input_tokens: 1000 },
      },
    })),
  });

  const r = await generateText({ model: provider('claude-sonnet-4-5'), prompt: 'hi' });

  return normalizeUsage(r.usage);
}

function setup() {
  const db = new Database(':memory:');
  initRunEventTables(makeExecRaw(db));
  const sql = makeSql(db);
  const recorder = new RunEventRecorder(sql, testActorHandle(sql));

  return { recorder };
}

function runOneTurn(recorder: RunEventRecorder, runId: string, steps: readonly Usage[]): void {
  const acc = new TurnAccumulator({
    onStepEvent: (e) => {
      const event: RunEventInput = { type: 'step_finish', ...e };
      recorder.emit(runId, event);
    },
  });

  acc.reset(0);
  recorder.emit(runId, { type: 'run_start', agentId: 'a' });
  recorder.emit(runId, { type: 'turn_start', turnIndex: 0 });

  for (const usage of steps) {
    acc.recordStep({ usage, response: { messages: [] }, finishReason: 'stop' });
  }

  closeTurnRun(recorder, runId, { turnIndex: 0, usage: acc.reportedUsage(), reason: 'completed' });
  recorder.emit(runId, { type: 'run_end', reason: 'done' });
}

describe('an unreported field stays absent through the whole pipeline', () => {
  test('Workers AI: reported zero survives as 0, unreported reasoning never becomes 0', async () => {
    const usage = await workersAIStepUsage();
    const { recorder } = setup();
    runOneTurn(recorder, 'run-wai', [usage]);

    const stored = recorder.read('run-wai');
    const step = stored.find((e) => e.type === 'step_finish');

    if (step?.type !== 'step_finish') throw new Error('no step_finish row was recorded');
    expect(step.usage?.input).toBe(88);
    expect(step.usage?.output).toBe(24);
    expect(step.usage?.cacheRead).toBe(0);
    expect(step.usage?.neurons).toBeCloseTo(19.1999998, 5);
    // Asserted on the key set: `toEqual` treats an explicitly-undefined key as absent.
    expect(Object.keys(step.usage ?? {}).sort())
      .toEqual(['cacheRead', 'input', 'neurons', 'output']);

    const turn = stored.find((e) => e.type === 'turn_end');

    if (turn?.type !== 'turn_end') throw new Error('no turn_end row was recorded');
    expect(turn.usage?.cacheRead).toBe(0);
    expect('reasoning' in (turn.usage ?? {})).toBe(false);

    const [summary] = getRunSummaries(recorder).items;
    expect(summary?.usage.input).toBe(88);
    expect(summary?.usage.cacheRead).toBe(0);
    expect('reasoning' in (summary?.usage ?? {})).toBe(false);
    expect(summary?.turnsWithoutUsage).toBe(0);
  });

  test('Anthropic: the 1h cache-write split no SDK type can express reaches the run record', async () => {
    const usage = await anthropicStepUsage();
    const { recorder } = setup();
    runOneTurn(recorder, 'run-ant', [usage]);

    const [summary] = getRunSummaries(recorder).items;
    expect(summary?.usage.input).toBe(3084);
    expect(summary?.usage.cacheRead).toBe(2048);
    expect(summary?.usage.cacheWrite).toBe(1024);
    expect(summary?.usage.cacheWrite1h).toBe(1000);
    expect('reasoning' in (summary?.usage ?? {})).toBe(false);
    expect('neurons' in (summary?.usage ?? {})).toBe(false);
  });

  test('a turn whose provider reported nothing is not a turn that cost nothing', () => {
    const { recorder } = setup();
    runOneTurn(recorder, 'run-silent', [{}, {}]);

    const stored = recorder.read('run-silent');

    for (const e of stored) {
      if (e.type === 'step_finish') expect(e.usage).toBeUndefined();

      if (e.type === 'turn_end') expect(e.usage).toBeUndefined();
    }

    const [summary] = getRunSummaries(recorder).items;
    expect(summary?.usage).toEqual({});
    expect(summary?.turnsWithoutUsage).toBe(1);
  });

  test('a turn that genuinely reported zeros is distinguishable from a silent one', () => {
    const { recorder } = setup();
    runOneTurn(recorder, 'run-zero', [{ input: 0, output: 0 }]);

    const [summary] = getRunSummaries(recorder).items;
    // A report of zero is a report; a naive "treat 0 as missing" fix breaks this half.
    expect(summary?.usage).toEqual({ input: 0, output: 0 });
    expect(summary?.turnsWithoutUsage).toBe(0);
  });

  test('mixing providers across steps keeps each provider’s silence', async () => {
    const [wai, ant] = await Promise.all([workersAIStepUsage(), anthropicStepUsage()]);
    const { recorder } = setup();
    runOneTurn(recorder, 'run-mixed', [wai, ant]);

    const [summary] = getRunSummaries(recorder).items;
    expect(summary?.usage.input).toBe(88 + 3084);
    expect(summary?.usage.cacheRead).toBe(0 + 2048);
    expect(summary?.usage.cacheWrite).toBe(1024);
    expect(summary?.usage.cacheWrite1h).toBe(1000);
    expect(summary?.usage.neurons).toBeCloseTo(19.1999998, 5);
    expect('reasoning' in (summary?.usage ?? {})).toBe(false);
  });
});
