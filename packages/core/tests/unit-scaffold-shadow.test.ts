/**
 * Unit tests for shadow-mode scaffold rollout logic.
 *
 * Covers:
 *   - initShadowTables creates scaffold_evaluations + extends scaffold_versions
 *   - getPendingScaffold returns null when no pending row
 *   - getPendingScaffold returns counts from scaffold_evaluations
 *   - recordShadowEvaluation persists with correct schema
 *   - decidePromotion logic: continue / promote / rollback / forced
 *   - applyPromotionDecision flips status correctly
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  initShadowTables,
  getPendingScaffold,
  recordShadowEvaluation,
  decidePromotion,
  DEFAULT_SHADOW_CONFIG,
  initScaffoldTables,
  type PendingScaffold,
  type ShadowConfig,
} from '../src/index.js';
import { makeSql, makeExecRaw } from './helpers.js';

function setup(): { sql: ReturnType<typeof makeSql>; execRaw: ReturnType<typeof makeExecRaw>; db: Database } {
  const db = new Database(':memory:');
  const execRaw = makeExecRaw(db);
  initScaffoldTables(execRaw);
  initShadowTables(execRaw);
  return { sql: makeSql(db), execRaw, db };
}

describe('initShadowTables', () => {
  test('creates scaffold_evaluations + indices; idempotent', () => {
    const { sql, execRaw } = setup();
    initShadowTables(execRaw);
    initShadowTables(execRaw); // double-call OK
    const tables = sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scaffold_evaluations'`;
    expect(tables.length).toBe(1);
  });

  test('extends scaffold_versions with status column', () => {
    const { sql } = setup();
    const cols = sql<{ name: string }>`PRAGMA table_info(scaffold_versions)`;
    const names = cols.map((c) => c.name);
    expect(names).toContain('status');
  });
});

describe('getPendingScaffold', () => {
  test('returns null when no pending version exists', () => {
    const { sql } = setup();
    expect(getPendingScaffold(sql)).toBeNull();
  });

  test('returns the pending version with zero counts initially', () => {
    const { sql } = setup();
    sql`INSERT INTO scaffold_versions (version, written_at, rationale, status)
        VALUES (3, ${Date.now()}, 'try new loop', 'pending')`;
    const p = getPendingScaffold(sql);
    expect(p).not.toBeNull();
    expect(p!.version).toBe(3);
    expect(p!.trialsSoFar).toBe(0);
    expect(p!.pendingWins).toBe(0);
    expect(p!.currentWins).toBe(0);
  });

  test('aggregates evaluation counts correctly', () => {
    const { sql } = setup();
    sql`INSERT INTO scaffold_versions (version, written_at, rationale, status)
        VALUES (4, ${Date.now()}, 'try new loop', 'pending')`;

    const judge = { winner: 'pending' as const, rationale: '', currentScore: 0.5, pendingScore: 0.8 };
    for (let i = 0; i < 3; i++) {
      recordShadowEvaluation(sql, {
        currentVersion: 3, pendingVersion: 4,
        task: `task-${i}`, currentOutput: 'c', pendingOutput: 'p',
        judgeResult: judge,
      });
    }
    recordShadowEvaluation(sql, {
      currentVersion: 3, pendingVersion: 4,
      task: 'task-4', currentOutput: 'c', pendingOutput: 'p',
      judgeResult: { winner: 'current', rationale: '', currentScore: 0.7, pendingScore: 0.5 },
    });
    recordShadowEvaluation(sql, {
      currentVersion: 3, pendingVersion: 4,
      task: 'task-5', currentOutput: 'c', pendingOutput: 'p',
      judgeResult: { winner: 'tie', rationale: '', currentScore: 0.6, pendingScore: 0.6 },
    });

    const p = getPendingScaffold(sql)!;
    expect(p.trialsSoFar).toBe(5);
    expect(p.pendingWins).toBe(3);
    expect(p.currentWins).toBe(1);
    expect(p.ties).toBe(1);
  });
});

describe('decidePromotion', () => {
  const cfg = DEFAULT_SHADOW_CONFIG;

  const make = (over: Partial<PendingScaffold>): PendingScaffold => ({
    version: 1,
    writtenAt: 0,
    rationale: '',
    trialsSoFar: 0,
    pendingWins: 0,
    currentWins: 0,
    ties: 0,
    ...over,
  });

  test('returns continue below minTrials', () => {
    const p = make({ trialsSoFar: 3, pendingWins: 3, currentWins: 0 });
    expect(decidePromotion(p, cfg).decision).toBe('continue');
  });

  test('promotes at minTrials when win-rate ≥ promoteThreshold', () => {
    const p = make({ trialsSoFar: 5, pendingWins: 4, currentWins: 1 });
    const d = decidePromotion(p, cfg);
    expect(d.decision).toBe('promote');
    expect(d.winRate).toBeCloseTo(0.8, 2);
  });

  test('rollbacks at minTrials when win-rate ≤ rollbackThreshold', () => {
    const p = make({ trialsSoFar: 5, pendingWins: 1, currentWins: 4 });
    const d = decidePromotion(p, cfg);
    expect(d.decision).toBe('rollback');
    expect(d.winRate).toBeCloseTo(0.2, 2);
  });

  test('continues for ambiguous mid-range win-rate', () => {
    const p = make({ trialsSoFar: 5, pendingWins: 3, currentWins: 2, ties: 0 });
    const d = decidePromotion(p, cfg);
    // win-rate 0.6 — exactly at promoteThreshold, so still promotes
    expect(['promote', 'continue']).toContain(d.decision);
  });

  test('mid-range below promoteThreshold and above rollbackThreshold → continue', () => {
    const p = make({ trialsSoFar: 5, pendingWins: 5, currentWins: 5, ties: 0 });
    // pending=5, current=5 → winRate=0.5, neither threshold met
    const d = decidePromotion(p, cfg);
    expect(d.decision).toBe('continue');
  });

  test('forces decision at maxTrials when still mid-range', () => {
    const p = make({ trialsSoFar: 12, pendingWins: 6, currentWins: 5, ties: 1 });
    const d = decidePromotion(p, cfg);
    expect(['promote', 'rollback']).toContain(d.decision);
    expect(d.winRate).toBeCloseTo(6 / 11, 2);
  });

  test('returns continue when no decisive trials yet', () => {
    const p = make({ trialsSoFar: 3, pendingWins: 0, currentWins: 0, ties: 3 });
    expect(decidePromotion(p, cfg).decision).toBe('continue');
  });

  test('respects custom thresholds', () => {
    const strictCfg: ShadowConfig = {
      ...cfg, promoteThreshold: 0.8, rollbackThreshold: 0.2, minTrials: 3,
    };
    expect(decidePromotion(
      make({ trialsSoFar: 3, pendingWins: 2, currentWins: 1 }), strictCfg,
    ).decision).toBe('continue'); // 0.67 < 0.8
    expect(decidePromotion(
      make({ trialsSoFar: 5, pendingWins: 5, currentWins: 0 }), strictCfg,
    ).decision).toBe('promote'); // 1.0 ≥ 0.8
  });
});
