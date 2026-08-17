/**
 * The end-to-end absence contract: a field the provider did not report stays
 * ABSENT from the provider's bytes all the way into a durable run record and the
 * read model built from it.
 *
 * This is deliberately a whole-pipeline test rather than a unit test of each
 * stage, because every stage used to re-introduce the zero independently: the
 * SDK adapter fabricated it, `chat.ts` merged it, the accumulator summed it, the
 * durable valibot schema demanded it, and the read model folded it with `?? 0`.
 * Any one of those regressing puts the zero back, and only a test that carries a
 * real provider payload through every stage catches all five.
 *
 * The stages, in order:
 *   real provider bytes
 *     -> the real @ai-sdk provider adapter
 *     -> normalizeUsage (the SDK seam both backends call)
 *     -> TurnAccumulator.recordStep (the per-turn meter)
 *     -> RunEventRecorder.emit (durable, valibot-gated, JSON in SQLite)
 *     -> RunEventRecorder.read (parsed back through the same schema)
 *     -> getRunSummaries (the cross-run budget view)
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
} from '../src/index.js';
import { makeSql, makeExecRaw } from './helpers.js';

function jsonReply(serialized: string): FetchFunction {
  const stub = async (): Promise<Response> => new Response(serialized, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  // `FetchFunction` is the platform `typeof fetch`, which carries `preconnect`.
  return Object.assign(stub, { preconnect: async (): Promise<void> => {} });
}

/**
 * Verbatim usage from the deployed proxy for
 * `@cf/deepseek-ai/deepseek-v4-pro-0813`. Two properties make it the right
 * fixture for this contract:
 *   - `prompt_tokens_details.cached_tokens: 0` is a REPORTED zero, and must
 *     survive as 0 rather than vanishing.
 *   - there is NO `completion_tokens_details` at all, even though the reply
 *     carried `reasoning_content` — so `reasoning` is UNREPORTED and must stay
 *     absent, even though @ai-sdk/openai-compatible hands over
 *     `reasoningTokens: 0` for it.
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

/** Anthropic reports the cache halves and the 1h retention split, and says
 *  nothing about reasoning — the mirror image of the Workers AI report. */
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
  const recorder = new RunEventRecorder(sql);
  return { recorder };
}

/** Drive one turn of `steps` through the meter and the durable recorder, exactly
 *  as a backend's inference loop does. */
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
  closeTurnRun(recorder, runId, { turnIndex: 0, usage: acc.reportedUsage(), reason: 'stop' });
  recorder.emit(runId, { type: 'run_end', reason: 'done' });
}

describe('an unreported field stays absent through the whole pipeline', () => {
  test('Workers AI: reported zero survives as 0, unreported reasoning never becomes 0', async () => {
    const usage = await workersAIStepUsage();
    const { recorder } = setup();
    runOneTurn(recorder, 'run-wai', [usage]);

    // Stage 1 — the durable step row, read back THROUGH the valibot schema.
    const stored = recorder.read('run-wai');
    const step = stored.find((e) => e.type === 'step_finish');
    if (step?.type !== 'step_finish') throw new Error('no step_finish row was recorded');
    expect(step.usage?.input).toBe(88);
    expect(step.usage?.output).toBe(24);
    // The reported zero is a measurement and is stored as one.
    expect(step.usage?.cacheRead).toBe(0);
    // The provider-reported neuron figure survives the JSON round-trip.
    expect(step.usage?.neurons).toBeCloseTo(19.1999998, 5);
    // THE POINT: reasoning was never reported, so the durable row has no such
    // key. Asserted on the key set, because `toEqual` treats an
    // explicitly-undefined key as absent and would pass vacuously.
    expect(Object.keys(step.usage ?? {}).sort())
      .toEqual(['cacheRead', 'input', 'neurons', 'output']);

    // Stage 2 — the turn row.
    const turn = stored.find((e) => e.type === 'turn_end');
    if (turn?.type !== 'turn_end') throw new Error('no turn_end row was recorded');
    expect(turn.usage?.cacheRead).toBe(0);
    expect('reasoning' in (turn.usage ?? {})).toBe(false);

    // Stage 3 — the cross-run read model.
    const [summary] = getRunSummaries(recorder);
    expect(summary?.usage.input).toBe(88);
    expect(summary?.usage.cacheRead).toBe(0);
    expect('reasoning' in (summary?.usage ?? {})).toBe(false);
    expect(summary?.turnsWithoutUsage).toBe(0);
  });

  test('Anthropic: the 1h cache-write split no SDK type can express reaches the run record', async () => {
    const usage = await anthropicStepUsage();
    const { recorder } = setup();
    runOneTurn(recorder, 'run-ant', [usage]);

    const [summary] = getRunSummaries(recorder);
    expect(summary?.usage.input).toBe(3084);
    expect(summary?.usage.cacheRead).toBe(2048);
    expect(summary?.usage.cacheWrite).toBe(1024);
    // Recovered from the provider's raw payload, carried through the meter, the
    // durable schema and the fold. This is the field the whole `raw`-as-oracle
    // design exists to keep.
    expect(summary?.usage.cacheWrite1h).toBe(1000);
    // Anthropic reports no reasoning and no neurons; neither is invented.
    expect('reasoning' in (summary?.usage ?? {})).toBe(false);
    expect('neurons' in (summary?.usage ?? {})).toBe(false);
  });

  test('a turn whose provider reported nothing is not a turn that cost nothing', () => {
    const { recorder } = setup();
    // Two steps, neither carrying a provider report at all.
    runOneTurn(recorder, 'run-silent', [{}, {}]);

    const stored = recorder.read('run-silent');
    // No usage row is fabricated for a silent step...
    for (const e of stored) {
      if (e.type === 'step_finish') expect(e.usage).toBeUndefined();
      if (e.type === 'turn_end') expect(e.usage).toBeUndefined();
    }
    // ...and the read model says the totals are unknown, not zero.
    const [summary] = getRunSummaries(recorder);
    expect(summary?.usage).toEqual({});
    expect(summary?.turnsWithoutUsage).toBe(1);
  });

  test('a turn that genuinely reported zeros is distinguishable from a silent one', () => {
    const { recorder } = setup();
    runOneTurn(recorder, 'run-zero', [{ input: 0, output: 0 }]);

    const [summary] = getRunSummaries(recorder);
    // A report of zero IS a report: the fields are present and the turn is not
    // counted as unreported. This is the half of the contract that a naive
    // "treat 0 as missing" fix would break.
    expect(summary?.usage).toEqual({ input: 0, output: 0 });
    expect(summary?.turnsWithoutUsage).toBe(0);
  });

  test('mixing providers across steps keeps each provider’s silence', async () => {
    const [wai, ant] = await Promise.all([workersAIStepUsage(), anthropicStepUsage()]);
    const { recorder } = setup();
    runOneTurn(recorder, 'run-mixed', [wai, ant]);

    const [summary] = getRunSummaries(recorder);
    expect(summary?.usage.input).toBe(88 + 3084);
    expect(summary?.usage.cacheRead).toBe(0 + 2048);
    // Reported by exactly one of the two, and not halved or zero-filled.
    expect(summary?.usage.cacheWrite).toBe(1024);
    expect(summary?.usage.cacheWrite1h).toBe(1000);
    expect(summary?.usage.neurons).toBeCloseTo(19.1999998, 5);
    // Reported by NEITHER, so the turn total must not claim zero.
    expect('reasoning' in (summary?.usage ?? {})).toBe(false);
  });
});
