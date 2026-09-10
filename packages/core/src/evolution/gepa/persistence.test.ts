/**
 * GEPA persistence — survives DO hibernation, supports run resumption.
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { testActorHandle } from '@kinu.run/test-utils';
import { makeSql, makeExecRaw } from '../../../tests/helpers';
import {
  initGepaTables, startGepaRun, persistGepaCandidate, finishGepaRun,
  listGepaRuns, loadGepaCandidates, loadGepaParetoFront, makePersistingHooks,
  runGepa,
  type GepaCandidate, type EvalInstance, type MetricOutcome,
} from './index';

function setup() {
  const db = new Database(':memory:');
  const execRaw = makeExecRaw(db);
  initGepaTables(execRaw);
  const sql = makeSql(db);

  // Every gepa row is one actor's: the run ledger, the candidates and the front
  // are all keyed on the owner, so the fixture issues a real bound handle.
  return { sql, execRaw, db, actor: testActorHandle(sql) };
}

function mkCandidate(id: string, source: string, scores: Record<string, number>): GepaCandidate {
  const m = new Map(Object.entries(scores));
  const total = Array.from(m.values()).reduce((a, b) => a + b, 0);

  return {
    id, parentId: null, source,
    scores: m, feedback: new Map([['i1', 'fb']]),
    aggregateScore: m.size === 0 ? 0 : total / m.size,
    createdAt: Date.now(),
  };
}

describe('initGepaTables', () => {
  test('creates gepa_runs and gepa_candidates only — no membership table; idempotent', () => {
    const { sql, execRaw } = setup();
    initGepaTables(execRaw);
    initGepaTables(execRaw); // double-call OK

    const tables = sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'gepa_%'`;

    const names = tables.map(t => t.name).sort();
    expect(names).toEqual(['gepa_candidates', 'gepa_runs']);
  });
});

describe('startGepaRun + finishGepaRun', () => {
  test('round-trips run metadata', () => {
    const { sql, actor } = setup();

    const runId = startGepaRun(sql, actor, {
      target: 'scaffold',
      targetRef: null,
      budget: { maxIterations: 5, maxMetricCalls: 50, minibatchSize: 2 },
    });

    expect(runId).toMatch(/^gepa-/);

    let runs = listGepaRuns(sql, actor);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe('running');
    expect(runs[0].target).toBe('scaffold');

    finishGepaRun(sql, actor, {
      runId,
      status: 'completed',
      stopReason: 'iterations_exhausted',
      winnerId: 'c1',
      metricCalls: 25,
      iterations: 5,
    });

    runs = listGepaRuns(sql, actor);
    expect(runs[0].status).toBe('completed');
    expect(runs[0].stopReason).toBe('iterations_exhausted');
    expect(runs[0].winnerId).toBe('c1');
    expect(runs[0].metricCalls).toBe(25);
    expect(runs[0].iterations).toBe(5);
    expect(runs[0].endedAt).not.toBeNull();
  });
});

describe('persistGepaCandidate + loadGepaCandidates', () => {
  test('round-trips scores Map and feedback Map verbatim', () => {
    const { sql, actor } = setup();

    const runId = startGepaRun(sql, actor, {
      target: 'scaffold',
      budget: { maxIterations: 1, maxMetricCalls: 10, minibatchSize: 1 },
    });

    const cand = mkCandidate('c1', 'source-1', { i1: 0.7, i2: 0.3 });
    persistGepaCandidate(sql, actor, { runId, candidate: cand, iteration: 0, accepted: true });

    const loaded = loadGepaCandidates(sql, actor, runId);
    expect(loaded.length).toBe(1);
    expect(loaded[0].id).toBe('c1');
    expect(loaded[0].source).toBe('source-1');
    expect(loaded[0].scores.get('i1')).toBe(0.7);
    expect(loaded[0].scores.get('i2')).toBe(0.3);
    expect(loaded[0].feedback.get('i1')).toBe('fb');
    expect(loaded[0].aggregateScore).toBeCloseTo(0.5, 5);
  });

  test('orders by iteration then created_at', () => {
    const { sql, actor } = setup();

    const runId = startGepaRun(sql, actor, {
      target: 'scaffold',
      budget: { maxIterations: 5, maxMetricCalls: 50, minibatchSize: 1 },
    });

    const seed = mkCandidate('seed', 'src-0', { i1: 0.5 });
    const it1 = mkCandidate('it1', 'src-1', { i1: 0.6 });
    const it2 = mkCandidate('it2', 'src-2', { i1: 0.7 });
    persistGepaCandidate(sql, actor, { runId, candidate: seed, iteration: 0, accepted: true });
    persistGepaCandidate(sql, actor, { runId, candidate: it1, iteration: 1, accepted: true });
    persistGepaCandidate(sql, actor, { runId, candidate: it2, iteration: 2, accepted: true });
    const loaded = loadGepaCandidates(sql, actor, runId);
    expect(loaded.map(c => c.id)).toEqual(['seed', 'it1', 'it2']);
  });
});

describe('loadGepaParetoFront — the derived front', () => {
  test('derives the per-instance front from accepted candidates alone', () => {
    const { sql, actor } = setup();
    const runId = startGepaRun(sql, actor, { target: 'scaffold', budget: {} });
    // A specialist per instance: neither dominates the other. The old
    // membership table stored this shape after every iteration; the
    // derivation must reproduce it from scores_json with no stored
    // membership at all.
    const a = mkCandidate('a', 'src-a', { i1: 0.9, i2: 0.3 });
    const b = mkCandidate('b', 'src-b', { i1: 0.3, i2: 0.9 });

    for (const cand of [a, b]) {
      persistGepaCandidate(sql, actor, { runId, candidate: cand, iteration: 0, accepted: true });
    }

    expect(loadGepaParetoFront(sql, actor, runId)).toEqual([
      { candidateId: 'a', instanceId: 'i1', score: 0.9 },
      { candidateId: 'b', instanceId: 'i1', score: 0.3 },
      { candidateId: 'a', instanceId: 'i2', score: 0.3 },
      { candidateId: 'b', instanceId: 'i2', score: 0.9 },
    ]);
  });

  test('an empty or absent run yields an empty front', () => {
    const { sql, actor } = setup();
    expect(loadGepaParetoFront(sql, actor, 'gepa-none')).toEqual([]);
  });
});

describe('runGepa with makePersistingHooks end-to-end', () => {
  test('every accepted candidate ends up in gepa_candidates + run counters update', async () => {
    const { sql, actor } = setup();

    const evalSet: EvalInstance<string>[] = [
      { id: 'i1', input: 'a' }, { id: 'i2', input: 'b' },
    ];

    const runId = startGepaRun(sql, actor, {
      target: 'scaffold',
      budget: { maxIterations: 2, maxMetricCalls: 50, minibatchSize: 1 },
    });

    const hooks = makePersistingHooks({ sql, actor, runId });

    let lmCall = 0;

    const reflectionLm = async () => {
      lmCall++;

      return `improved-${lmCall}`;
    };

    const metric = async (source: string): Promise<MetricOutcome> => ({
      score: source.startsWith('improved') ? 0.9 : 0.5,
      feedback: source,
    });

    const result = await runGepa({
      seed: 'seed',
      evalSet,
      metric,
      reflectionLm,
      budget: { maxIterations: 2, maxMetricCalls: 50, minibatchSize: 1 },
      ...hooks,
    });

    finishGepaRun(sql, actor, {
      runId,
      status: 'completed',
      stopReason: result.stopReason,
      winnerId: result.winner.id,
      metricCalls: result.metricCallsUsed,
      iterations: result.iterationsRun,
    });

    const loaded = loadGepaCandidates(sql, actor, runId);
    // Seed + at least one improvement
    expect(loaded.length).toBeGreaterThanOrEqual(2);
    const runs = listGepaRuns(sql, actor);
    expect(runs[0].metricCalls).toBe(result.metricCallsUsed);
    expect(runs[0].winnerId).toBe(result.winner.id);
    expect(runs[0].status).toBe('completed');
  });
});

test('a fully measured seed is retained before the first reflection measurement can fail', async () => {
  const { sql, actor } = setup();
  const runId = startGepaRun(sql, actor, { target: 'scaffold' });
  const hooks = makePersistingHooks({ sql, actor, runId });
  const iterations: number[] = [];
  const failure = new Error('first reflection measurement failed');
  let calls = 0;
  await expect(runGepa({ seed: 'seed', evalSet: [{ id: 'one', input: 'task' }],
    metric: async () => {
      if (++calls === 2) throw failure;

      return { score: 0.7, feedback: 'fully measured seed' };
    },
    reflectionLm: async () => 'candidate',
    ...hooks,
    onIteration: state => {
      iterations.push(state.iteration);

      return hooks.onIteration(state);
    },
    budget: { maxIterations: 1, maxMetricCalls: 10, minibatchSize: 1, useMerge: false },
  })).rejects.toBe(failure);
  expect(iterations).toEqual([]);
  const candidates = loadGepaCandidates(sql, actor, runId);
  expect(candidates.map(candidate => ({ source: candidate.source, score: candidate.aggregateScore,
    measured: Object.fromEntries(candidate.scores) }))).toEqual([{ source: 'seed', score: 0.7, measured: { one: 0.7 } }]);
});
