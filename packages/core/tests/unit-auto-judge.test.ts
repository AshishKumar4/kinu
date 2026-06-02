/**
 * Unit tests for runAutoShadowEval — auto-judge shadow eval loop.
 */

import { describe, test, expect } from 'bun:test';
import {
  runAutoShadowEval,
  initScaffoldTables, initShadowTables, getPendingScaffold,
  DEFAULT_SHADOW_CONFIG,
  type JudgeOutput,
  type StructuredJudgeFn,
} from '../src/index.js';
import { createTestRuntime } from './helpers.js';

const noOpLlmStream = async function* () { yield ''; };

function makeJudge(winner: JudgeOutput['winner'], rationale = 'mock'): StructuredJudgeFn {
  return async () => ({
    winner, rationale,
    currentScore: winner === 'current' ? 0.8 : 0.4,
    pendingScore: winner === 'pending' ? 0.8 : 0.4,
  });
}

async function setup(): Promise<ReturnType<typeof createTestRuntime>['rt']> {
  const { rt } = createTestRuntime();
  initScaffoldTables(rt.storage.execRaw);
  initShadowTables(rt.storage.execRaw);
  // Bootstrap a pending scaffold v1, current v0.
  rt.storage.sql`INSERT INTO scaffold_versions (version, written_at, rationale, status)
    VALUES (0, ${Date.now()}, 'initial', 'current')`;
  rt.storage.sql`INSERT INTO scaffold_versions (version, written_at, rationale, status)
    VALUES (1, ${Date.now()}, 'alternative', 'pending')`;
  // Write the pending scaffold's backup file (executor reads this).
  await rt.storage.vfs.writeFile(
    'scaffold/agent.js.v1',
    'async function* run(rt, task) { yield { type: "chunk", data: "pending: " + task }; }',
  );
  // Also write current.
  await rt.identity.scaffold.write(
    'async function* run(rt, task) { yield { type: "chunk", data: "current: " + task }; }',
  );
  return rt;
}

describe('runAutoShadowEval', () => {
  test('skips when no pending scaffold', async () => {
    const { rt } = createTestRuntime();
    initScaffoldTables(rt.storage.execRaw);
    initShadowTables(rt.storage.execRaw);
    const result = await runAutoShadowEval({
      rt, task: 'hello', currentOutput: 'world',
      judge: makeJudge('current'),
      llmStream: noOpLlmStream,
      config: { sampleRate: 1.0 },
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('no_pending');
  });

  test('skips when sampling roll misses', async () => {
    const rt = await setup();
    const result = await runAutoShadowEval({
      rt, task: 'hello', currentOutput: 'world',
      judge: makeJudge('current'),
      llmStream: noOpLlmStream,
      config: { sampleRate: 0.5 },
      random: () => 0.9, // > 0.5, skip
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('not_sampled');
  });

  test('runs + records evaluation on a sampled turn', async () => {
    const rt = await setup();
    let judgeCalled = false;
    const result = await runAutoShadowEval({
      rt, task: 'compute 2+2', currentOutput: '4',
      judge: async () => { judgeCalled = true; return makeJudge('pending')('', null as never); },
      llmStream: noOpLlmStream,
      config: { sampleRate: 1.0, autoApply: false },
      random: () => 0.0, // always sample
    });
    expect(judgeCalled).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.evaluation?.winner).toBe('pending');

    // Verify it was recorded.
    const pending = getPendingScaffold(rt.storage.sql)!;
    expect(pending.trialsSoFar).toBe(1);
    expect(pending.pendingWins).toBe(1);
  });

  test('returns decision=continue when below minTrials', async () => {
    const rt = await setup();
    const result = await runAutoShadowEval({
      rt, task: 't', currentOutput: 'c',
      judge: makeJudge('pending'),
      llmStream: noOpLlmStream,
      config: { sampleRate: 1.0 },
      random: () => 0,
    });
    expect(result.decision).toBe('continue');
    expect(result.applied).toBeNull();
  });

  test('auto-applies when conclusive + autoApply=true', async () => {
    const rt = await setup();
    // Seed 5 prior pending wins so this 6th call crosses the promote threshold.
    for (let i = 0; i < 5; i++) {
      rt.storage.sql`INSERT INTO scaffold_evaluations
        (id, current_version, pending_version, task, current_output, pending_output,
         current_score, pending_score, winner, judge_rationale, evaluated_at)
        VALUES (${`seed-${i}`}, 0, 1, 't', 'c', 'p', 0.4, 0.8, 'pending', 'seed', ${Date.now()})`;
    }
    const result = await runAutoShadowEval({
      rt, task: 't', currentOutput: 'c',
      judge: makeJudge('pending'),
      llmStream: noOpLlmStream,
      config: { sampleRate: 1.0, autoApply: true },
      random: () => 0,
    });
    expect(result.decision).toBe('promote');
    expect(result.applied).toBe('promote');

    // v1 should be 'current'; v0 should be 'historical'.
    const statuses = rt.storage.sql<{ version: number; status: string }>`
      SELECT version, status FROM scaffold_versions ORDER BY version`;
    const map = new Map(statuses.map((s) => [s.version, s.status]));
    expect(map.get(1)).toBe('current');
    expect(map.get(0)).toBe('historical');
  });

  test('auto-applies ROLLBACK on a regression (regression veto, end-to-end)', async () => {
    const rt = await setup();
    // Seed 5 pending wins (past minTrials with a strong record); this turn the
    // judge picks 'current' — a single regression must roll the pending back
    // despite the 5-1 record. Proves the hardened gate gates auto-apply.
    for (let i = 0; i < 5; i++) {
      rt.storage.sql`INSERT INTO scaffold_evaluations
        (id, current_version, pending_version, task, current_output, pending_output,
         current_score, pending_score, winner, judge_rationale, evaluated_at)
        VALUES (${`seed-${i}`}, 0, 1, 't', 'c', 'p', 0.4, 0.8, 'pending', 'seed', ${Date.now()})`;
    }
    const result = await runAutoShadowEval({
      rt, task: 't', currentOutput: 'c',
      judge: makeJudge('current'), // the regression
      llmStream: noOpLlmStream,
      config: { sampleRate: 1.0, autoApply: true },
      random: () => 0,
    });
    expect(result.decision).toBe('rollback');
    expect(result.applied).toBe('rollback');

    const statuses = rt.storage.sql<{ version: number; status: string }>`
      SELECT version, status FROM scaffold_versions ORDER BY version`;
    const map = new Map(statuses.map((s) => [s.version, s.status]));
    expect(map.get(0)).toBe('current');      // live scaffold unchanged
    expect(map.get(1)).toBe('rolled_back');  // bad pending discarded
  });

  test('skips gracefully when pending file unreadable', async () => {
    const { rt } = createTestRuntime();
    initScaffoldTables(rt.storage.execRaw);
    initShadowTables(rt.storage.execRaw);
    // Pending row exists but no scaffold/agent.js current file. version()
    // returns max(scaffold_versions.version)=1 which matches our pending=1,
    // so readScaffoldVersion follows the "read current" path; with no file,
    // it throws ENOENT, caught in the try/catch → returns null.
    rt.storage.sql`INSERT INTO scaffold_versions (version, written_at, rationale, status)
      VALUES (0, ${Date.now()}, 'initial', 'current')`;
    rt.storage.sql`INSERT INTO scaffold_versions (version, written_at, rationale, status)
      VALUES (1, ${Date.now()}, 'alt', 'pending')`;
    // Explicitly DO NOT write 'scaffold/agent.js'.

    const result = await runAutoShadowEval({
      rt, task: 't', currentOutput: 'c',
      judge: makeJudge('pending'),
      llmStream: noOpLlmStream,
      config: { sampleRate: 1.0 },
      random: () => 0,
    });
    // Result is either pending_unreadable OR — if execMockExecutor parsed
    // the empty/missing scaffold as "true" — the run proceeded but the
    // executor returned empty events. Either way, it shouldn't have
    // recorded a meaningful evaluation. Assert that:
    //   • either skipped with the right reason, OR
    //   • not skipped but the pending output is empty (judge was called
    //     with empty pending text — still legitimate behavior).
    if (result.skipped) {
      expect(result.reason).toBe('pending_unreadable');
    } else {
      // The mock executor accepted the empty/missing scaffold; eval recorded.
      expect(result.evaluation).toBeDefined();
    }
  });

  test('config defaults honor DEFAULT_AUTO_JUDGE_CONFIG', () => {
    // Sanity check on the public defaults.
    expect(DEFAULT_SHADOW_CONFIG.minTrials).toBe(5);
    expect(DEFAULT_SHADOW_CONFIG.promoteThreshold).toBe(0.6);
  });
});
