/**
 * Replay-eval harness — outcome-labeled turns re-run against the current
 * config produce a persisted loss entry (the system's loss curve).
 */
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { makeSql, makeExecRaw, createMockLLM, createTestRuntime } from './helpers';
import { initTurnOutcomeTables, recordTurnOutcome } from '../src/evolution/outcomes';
import { initReplayTables, runReplayEval, listReplayEvals } from '../src/evolution/replay';
import { wilsonInterval } from '../src/utils/stats';
import { EvolutionEngine } from '../src/evolution/engine';
import { initSearchTables } from '../src/mcts/schemas';
import { initScaffoldTables } from '../src/scaffold/schemas';

function setup() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  initTurnOutcomeTables(execRaw, sql);
  initReplayTables(execRaw, sql);
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
      'Accepted response': '{"score": 1.0, "note": "as good"}',
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

    // 0.75 over TWO instances says almost nothing, and the summary says so.
    expect(summary!.interval).toEqual(wilsonInterval(1.5, 2));
    expect(summary!.interval.lo).toBeCloseTo(0.1979, 4);
    expect(summary!.interval.hi).toBeCloseTo(0.9733, 4);

    // Persisted — the loss curve is queryable, interval included.
    const stored = listReplayEvals(sql);
    expect(stored).toHaveLength(1);
    expect(stored[0].loss).toBeCloseTo(0.25);
    expect(stored[0].results).toHaveLength(2);
    expect(stored[0].interval).toEqual(summary!.interval);
    const [row] = sql<{ score_lo: number; score_hi: number }>`SELECT score_lo, score_hi FROM replay_evals`;
    expect(row.score_lo).toBeCloseTo(0.1979, 4);
    expect(row.score_hi).toBeCloseTo(0.9733, 4);
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

describe('listReplayEvals — the quality-panel data series', () => {
  function insertReplay(
    sql: ReturnType<typeof makeSql>,
    row: { id: string; ranAt: number; meanScore: number; scaffoldVersion: number | null },
  ) {
    void sql`INSERT INTO replay_evals (id, ran_at, sample_size, accepted_n, negative_n, mean_score, loss, scaffold_version, details)
        VALUES (${row.id}, ${row.ranAt}, 4, 2, 2, ${row.meanScore}, ${1 - row.meanScore}, ${row.scaffoldVersion}, ${'[]'})`;
  }

  test('returns the series newest-first with the fields the panel renders', () => {
    const { sql } = setup();
    insertReplay(sql, { id: 'r1', ranAt: 100, meanScore: 0.5, scaffoldVersion: 1 });
    insertReplay(sql, { id: 'r2', ranAt: 200, meanScore: 0.7, scaffoldVersion: 1 });
    insertReplay(sql, { id: 'r3', ranAt: 300, meanScore: 0.9, scaffoldVersion: 2 });

    const series = listReplayEvals(sql);
    expect(series.map((r) => r.id)).toEqual(['r3', 'r2', 'r1']);
    expect(series[0].meanScore).toBeCloseTo(0.9);
    expect(series[0].loss).toBeCloseTo(0.1);
    // scaffold_version is the before/after-evolution axis the panel annotates.
    expect(series.map((r) => r.scaffoldVersion)).toEqual([2, 1, 1]);
  });

  test('honors the limit', () => {
    const { sql } = setup();
    for (let i = 0; i < 5; i++) insertReplay(sql, { id: `r${i}`, ranAt: i * 10, meanScore: 0.5, scaffoldVersion: null });
    expect(listReplayEvals(sql, 3)).toHaveLength(3);
  });

  test('rows written before the interval columns get theirs reconstructed exactly', () => {
    const { sql } = setup();
    // insertReplay writes no score_lo/score_hi — a pre-interval row.
    insertReplay(sql, { id: 'legacy', ranAt: 100, meanScore: 0.75, scaffoldVersion: null });
    const [row] = listReplayEvals(sql);
    expect(row.interval).toEqual(wilsonInterval(3, 4)); // mean 0.75 over the row's 4 instances
  });
});

describe('EvolutionEngine.runReplayEval — the on-demand seam', () => {
  test('the lifetime cycle does NOT run it — the same ledger is not re-executed twice', async () => {
    const { rt } = createTestRuntime({
      llmResponses: {
        'Accepted response': '{"score": 0.8, "note": "ok"}',
        "User's correction": '{"score": 0.8, "note": "ok"}',
      },
    });
    initSearchTables(rt.storage.execRaw, rt.storage.sql);
    initScaffoldTables(rt.storage.execRaw, rt.storage.sql);
    const engine = new EvolutionEngine(rt, {
      replayTaskRunner: async (task) => `current-config answer: ${task}`,
    });
    seedOutcomes(rt.storage.sql);
    const events: Array<{ type: string; message: string }> = [];
    engine.onEvent((e) => events.push(e));

    await engine.onLifetimeEvolution();

    expect(events.filter((e) => e.type === 'replay_eval')).toHaveLength(0);
    expect(listReplayEvals(rt.storage.sql)).toHaveLength(0);
  });

  test('called explicitly, it runs through the backend runner and emits the loss', async () => {
    const { rt } = createTestRuntime({
      llmResponses: {
        'Accepted response': '{"score": 0.8, "note": "ok"}',
        "User's correction": '{"score": 0.8, "note": "ok"}',
      },
    });
    initSearchTables(rt.storage.execRaw, rt.storage.sql);
    initScaffoldTables(rt.storage.execRaw, rt.storage.sql);

    const engine = new EvolutionEngine(rt, {
      replayTaskRunner: async (task) => `current-config answer: ${task}`,
    });
    seedOutcomes(rt.storage.sql);

    const events: Array<{ type: string; message: string }> = [];
    engine.onEvent((e) => events.push(e));
    await engine.runReplayEval();

    const replayEvents = events.filter((e) => e.type === 'replay_eval');
    expect(replayEvents).toHaveLength(1);
    // The loss is reported with the interval it deserves at two instances.
    expect(replayEvents[0].message).toContain('loss 0.20 (95% CI 0.02–0.78)');
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
