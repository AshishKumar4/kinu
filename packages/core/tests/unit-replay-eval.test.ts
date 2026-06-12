/**
 * Replay-eval harness — outcome-labeled turns re-run against the current
 * config produce a persisted loss entry (the system's loss curve).
 */
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { makeSql, makeExecRaw, createMockLLM, createTestRuntime } from './helpers.js';
import { initTurnOutcomeTables, recordTurnOutcome } from '../src/evolution/outcomes.js';
import { initReplayTables, runReplayEval, listReplayEvals } from '../src/evolution/replay.js';
import { EvolutionEngine } from '../src/evolution/engine.js';
import { initSearchTables } from '../src/mcts/schemas.js';
import { initScaffoldTables } from '../src/scaffold/schemas.js';
import { initCraftScoreTables } from '../src/craft/schemas.js';

function setup() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  initTurnOutcomeTables(execRaw, sql);
  initReplayTables(execRaw);
  return { sql, execRaw };
}

function seedOutcomes(sql: ReturnType<typeof makeSql>) {
  recordTurnOutcome(sql, {
    turnId: 'good', outcome: 'accepted', confidence: 1, source: 'classifier',
    userMessage: 'list the open ports', assistantResponse: 'Ports 80 and 443 are open.', now: 100,
  });
  recordTurnOutcome(sql, {
    turnId: 'bad', outcome: 'corrected', confidence: 1, source: 'classifier',
    userMessage: 'summarize Q3', assistantResponse: 'Q2 summary...', followup: 'I said Q3, not Q2', now: 200,
  });
}

describe('runReplayEval', () => {
  test('re-runs labeled turns, scores against recorded outcomes, persists the loss entry', async () => {
    const { sql } = setup();
    seedOutcomes(sql);
    const ranTasks: string[] = [];
    const judge = createMockLLM({
      // The accepted instance judges against the reference; the corrected one
      // against the user's correction. Distinct scores prove both paths ran.
      'known-good reference': '{"score": 1.0, "note": "as good"}',
      "User's correction": '{"score": 0.5, "note": "partially addressed"}',
    });

    const summary = await runReplayEval({
      sql, judge,
      runTask: async (task) => { ranTasks.push(task); return `fresh answer to: ${task}`; },
      sampleSize: 6,
    });

    expect(summary).not.toBeNull();
    expect(summary!.sampleSize).toBe(2);
    expect(summary!.acceptedCount).toBe(1);
    expect(summary!.negativeCount).toBe(1);
    expect(summary!.meanScore).toBeCloseTo(0.75);
    expect(summary!.loss).toBeCloseTo(0.25);
    expect(ranTasks.sort()).toEqual(['list the open ports', 'summarize Q3']);

    // Persisted — the loss curve is queryable.
    const stored = listReplayEvals(sql);
    expect(stored).toHaveLength(1);
    expect(stored[0].loss).toBeCloseTo(0.25);
    expect(stored[0].results).toHaveLength(2);
  });

  test('a failed re-run or unusable judge scores 0 — failing to reproduce IS loss', async () => {
    const { sql } = setup();
    seedOutcomes(sql);
    const summary = await runReplayEval({
      sql,
      judge: createMockLLM({ '': 'not json' }),
      runTask: async (task) => {
        if (task.includes('Q3')) throw new Error('runner exploded');
        return 'fresh';
      },
    });
    expect(summary!.meanScore).toBe(0);
    expect(summary!.loss).toBe(1);
    expect(summary!.results.map((r) => r.note).join(' ')).toContain('runner exploded');
  });

  test('returns null (and persists nothing) when no labeled turns exist', async () => {
    const { sql } = setup();
    const summary = await runReplayEval({
      sql, judge: createMockLLM(), runTask: async () => 'x',
    });
    expect(summary).toBeNull();
    expect(listReplayEvals(sql)).toHaveLength(0);
  });
});

describe('EvolutionEngine.runReplayEval — the periodic seam', () => {
  test('lifetime evolution runs the replay eval through the backend runner and emits the loss', async () => {
    const { rt } = createTestRuntime({
      llmResponses: {
        'known-good reference': '{"score": 0.8, "note": "ok"}',
        "User's correction": '{"score": 0.8, "note": "ok"}',
      },
    });
    initSearchTables(rt.storage.execRaw);
    initScaffoldTables(rt.storage.execRaw);
    initCraftScoreTables(rt.storage.execRaw);

    const engine = new EvolutionEngine(rt, {
      replayTaskRunner: async (task) => `current-config answer: ${task}`,
    });
    seedOutcomes(rt.storage.sql);

    const events: Array<{ type: string; message: string }> = [];
    engine.onEvent((e) => events.push(e));
    await engine.onLifetimeEvolution();

    const replayEvents = events.filter((e) => e.type === 'replay_eval');
    expect(replayEvents).toHaveLength(1);
    expect(replayEvents[0].message).toContain('loss 0.20');
    expect(listReplayEvals(rt.storage.sql)).toHaveLength(1);
  });

  test('no runner configured → replay skipped, returns null', async () => {
    const { rt } = createTestRuntime();
    const engine = new EvolutionEngine(rt);
    seedOutcomes(rt.storage.sql);
    expect(await engine.runReplayEval()).toBeNull();
    expect(listReplayEvals(rt.storage.sql)).toHaveLength(0);
  });
});
