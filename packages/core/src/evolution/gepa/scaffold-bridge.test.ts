/**
 * GEPA → scaffold bridge: an improved candidate passes the constraints, lands as a
 * pending row at v+1, and live `scaffold/agent.js` keeps the current content. Plus
 * dry-run, no-improvement and modify-gate rejection.
 */

import { describe, test, expect } from 'bun:test';
import * as v from 'valibot';
import { runScaffoldGepa } from './scaffold-bridge';
import { initScaffoldTables } from '../../scaffold/schemas';
import { createTestRuntime } from '../../../tests/helpers';
import type { EvalInstance, MetricOutcome } from './types';

function seededRng(seed: number): () => number {
  let s = seed;

  return () => {
    s = (s * 1664525 + 1013904223) % 0xffffffff;

    return s / 0xffffffff;
  };
}

const VALID_SEED = `async function* run(rt, task) {
  yield { type: "chunk", data: "seed" };
}`;

const VALID_IMPROVED = `async function* run(rt, task) {
  yield { type: "chunk", data: "improved" };
}`;

describe('runScaffoldGepa', () => {
  test('proposes the winner via modifyScaffold when GEPA finds improvement', async () => {
    const { rt } = createTestRuntime();
    initScaffoldTables(rt.storage.execRaw);
    await rt.identity.scaffold.write(VALID_SEED);

    const evalSet: EvalInstance<string>[] = [
      { id: 'i1', input: 'task A' },
      { id: 'i2', input: 'task B' },
    ];

    // Metric prefers the improved candidate (0.9) over the seed (0.5).
    const metric = async (source: string): Promise<MetricOutcome> =>
      source.includes('improved')
        ? { score: 0.9, feedback: 'great' }
        : { score: 0.5, feedback: 'mediocre — could be more specific' };

    // Reflection LM returns the improved source.
    const reflectionLm = async () => VALID_IMPROVED;

    const result = await runScaffoldGepa({
      rt,
      evalSet,
      metric,
      reflectionLm,
      budget: { maxIterations: 2, maxMetricCalls: 50, minibatchSize: 1 },
      random: seededRng(7),
    });

    expect(result.proposed).toBe(true);
    expect(result.pendingVersion).not.toBeNull();
    expect(result.skipReason).toBeUndefined();

    // The pending code is in scaffold/agent.js.v{pendingVersion}.
    if (result.pendingVersion === null) throw new Error('expected a pending scaffold version');

    const pending = await rt.storage.vfs.readFile(
      `scaffold/agent.js.v${result.pendingVersion}`,
      { encoding: 'utf8' },
    );

    expect(v.parse(v.string(), pending)).toContain('improved');

    // The live scaffold still holds the seed.
    expect(await rt.identity.scaffold.read()).toBe(VALID_SEED);

    // Scores are intervals; 0.9 over two instances is not a fact about the scaffold.
    expect(result.winnerScore).toEqual({ mean: 0.9, lo: expect.any(Number), hi: expect.any(Number), n: 2 });
    expect(result.winnerScore.lo).toBeCloseTo(0.2787, 4);
    expect(result.winnerScore.hi).toBeCloseTo(0.9953, 4);
    expect(result.seedScore.mean).toBe(0.5);

    const [rationale] = rt.storage.sql<{ rationale: string }>`
      SELECT rationale FROM scaffold_versions
      WHERE actor_id = ${rt.actor.actorId} AND version = ${result.pendingVersion}`;

    expect(rationale.rationale).toContain('0.900 (95% CI 0.279–0.995)');
    expect(rationale.rationale).toContain('seed: 0.500 (95% CI 0.095–0.905)');
  });

  test('does NOT propose when winner equals seed', async () => {
    const { rt } = createTestRuntime();
    initScaffoldTables(rt.storage.execRaw);
    await rt.identity.scaffold.write(VALID_SEED);
    const metric = async (): Promise<MetricOutcome> => ({ score: 0.5, feedback: '' });
    const reflectionLm = async () => VALID_SEED; // no-op

    const result = await runScaffoldGepa({
      rt,
      evalSet: [{ id: 'i1', input: 'x' }],
      metric,
      reflectionLm,
      budget: { maxIterations: 1, maxMetricCalls: 20, minibatchSize: 1 },
      random: seededRng(1),
    });

    expect(result.proposed).toBe(false);
    expect(result.skipReason).toBe('winner_equals_seed');
    expect(result.pendingVersion).toBeNull();
  });

  test('does NOT propose when LM produces a different but no-better candidate', async () => {
    // Ties go to the older candidate, so an equal-scoring proposal yields `winner_equals_seed`.
    const { rt } = createTestRuntime();
    initScaffoldTables(rt.storage.execRaw);
    await rt.identity.scaffold.write(VALID_SEED);
    const metric = async (): Promise<MetricOutcome> => ({ score: 0.5, feedback: '' });
    const reflectionLm = async () => VALID_IMPROVED; // different source, same score

    const result = await runScaffoldGepa({
      rt,
      evalSet: [{ id: 'i1', input: 'x' }],
      metric,
      reflectionLm,
      budget: { maxIterations: 1, maxMetricCalls: 20, minibatchSize: 1 },
      random: seededRng(1),
    });

    expect(result.proposed).toBe(false);
    expect(result.skipReason).toBe('winner_equals_seed');
  });

  test('rejects GEPA candidates that fail scaffold structural gates EARLY', async () => {
    const { rt } = createTestRuntime();
    initScaffoldTables(rt.storage.execRaw);
    await rt.identity.scaffold.write(VALID_SEED);
    // Violates the required signature.
    const reflectionLm = async () => 'function notAGenerator(rt, task) { return null; }';
    const metric = async (): Promise<MetricOutcome> => ({ score: 0.9, feedback: '' });

    const result = await runScaffoldGepa({
      rt,
      evalSet: [{ id: 'i1', input: 'x' }],
      metric,
      reflectionLm,
      budget: { maxIterations: 2, maxMetricCalls: 50, minibatchSize: 1 },
      random: seededRng(1),
    });

    // Rejected in-loop: the seed wins and nothing is proposed.
    expect(result.gepa.winner.source).toBe(VALID_SEED);
    expect(result.proposed).toBe(false);
  });

  test('rejects candidates with forbidden imports / globalThis / eval', async () => {
    const { rt } = createTestRuntime();
    initScaffoldTables(rt.storage.execRaw);
    await rt.identity.scaffold.write(VALID_SEED);
    let calls = 0;

    const reflectionLm = async () => {
      calls++;

      switch (calls) {
        case 1: return `import fs from "fs";\n${VALID_IMPROVED}`;
        case 2: return `globalThis.fetch(); ${VALID_IMPROVED}`;
        default: return `eval("x"); ${VALID_IMPROVED}`;
      }
    };

    const metric = async (): Promise<MetricOutcome> => ({ score: 0.9, feedback: '' });

    const result = await runScaffoldGepa({
      rt,
      evalSet: [{ id: 'i1', input: 'x' }],
      metric,
      reflectionLm,
      budget: { maxIterations: 3, maxMetricCalls: 100, minibatchSize: 1 },
      random: seededRng(1),
    });

    // None of the proposed candidates pass; winner stays at seed.
    expect(result.gepa.winner.source).toBe(VALID_SEED);
    expect(result.proposed).toBe(false);
  });
});
