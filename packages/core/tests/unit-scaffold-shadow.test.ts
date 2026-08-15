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
  readShadowVerdict,
  recordShadowEvaluation,
  decidePromotion,
  applyPromotionDecision,
  modifyScaffold,
  DEFAULT_SHADOW_CONFIG,
  initScaffoldTables,
  type PendingScaffold,
  type ShadowConfig,
} from '../src/index.js';
import { makeSql, makeExecRaw } from './helpers.js';
import { createTestRuntime } from './helpers.js';

function setup() {
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
    void sql`INSERT INTO scaffold_versions (version, written_at, rationale, status)
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
    void sql`INSERT INTO scaffold_versions (version, written_at, rationale, status)
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

describe('readShadowVerdict — the promote/rollback decision grid', () => {
  test('empty verdict when no pending version', () => {
    const { sql } = setup();
    const v = readShadowVerdict(sql, null);
    expect(v.version).toBeNull();
    expect(v.trials).toEqual([]);
    expect(v.summary).toEqual({ trials: 0, pendingWins: 0, currentWins: 0, ties: 0, winRate: 0 });
  });

  test('reads scaffold_evaluations, orders regressions-first, aggregates win-rate', () => {
    const { sql } = setup();
    // Seed a mix: 2 pending wins, 1 current win (regression), 1 tie — all for v4.
    recordShadowEvaluation(sql, { currentVersion: 3, pendingVersion: 4, task: 'pw1', currentOutput: 'c', pendingOutput: 'p', judgeResult: { winner: 'pending', rationale: 'better', currentScore: 0.5, pendingScore: 0.8 } });
    recordShadowEvaluation(sql, { currentVersion: 3, pendingVersion: 4, task: 'cw1', currentOutput: 'c', pendingOutput: 'p', judgeResult: { winner: 'current', rationale: 'regressed', currentScore: 0.9, pendingScore: 0.4 } });
    recordShadowEvaluation(sql, { currentVersion: 3, pendingVersion: 4, task: 'pw2', currentOutput: 'c', pendingOutput: 'p', judgeResult: { winner: 'pending', rationale: 'better', currentScore: 0.5, pendingScore: 0.7 } });
    recordShadowEvaluation(sql, { currentVersion: 3, pendingVersion: 4, task: 'tie1', currentOutput: 'c', pendingOutput: 'p', judgeResult: { winner: 'tie', rationale: 'same', currentScore: 0.6, pendingScore: 0.6 } });
    // A row for a DIFFERENT version must be excluded.
    recordShadowEvaluation(sql, { currentVersion: 4, pendingVersion: 5, task: 'other', currentOutput: 'c', pendingOutput: 'p', judgeResult: { winner: 'pending', rationale: '', currentScore: 0.1, pendingScore: 0.9 } });

    const v = readShadowVerdict(sql, 4);
    expect(v.version).toBe(4);
    expect(v.trials.length).toBe(4);
    // Regressions first: the first row is the 'current' winner.
    expect(v.trials[0]!.winner).toBe('current');
    expect(v.trials[0]!.task).toBe('cw1');
    expect(v.trials[0]!.rationale).toBe('regressed');
    expect(v.summary).toEqual({ trials: 4, pendingWins: 2, currentWins: 1, ties: 1, winRate: 2 / 3 });
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

  test('promotes a clean winning record', () => {
    const p = make({ trialsSoFar: 5, pendingWins: 5, currentWins: 0 });
    const d = decidePromotion(p, cfg);
    expect(d.decision).toBe('promote');
    expect(d.winRate).toBeCloseTo(1, 2);
  });

  test('tolerates one loss (maxRegressions=1, Monte-Carlo settled) but vetoes the second', () => {
    // 6-1 (winRate 0.86): within the regression tolerance → promote. The old
    // maxRegressions=0 rolled this back and thereby rejected most genuinely-
    // better variants (see DEFAULT_SHADOW_CONFIG simulation table).
    const oneLoss = make({ trialsSoFar: 8, pendingWins: 6, currentWins: 1 });
    expect(decidePromotion(oneLoss, cfg).decision).toBe('promote');
    // 6-2 (winRate 0.75 — still promotable on win-rate alone): the hard veto
    // fires on the second decisive loss regardless. This is the safety core.
    const twoLosses = make({ trialsSoFar: 9, pendingWins: 6, currentWins: 2 });
    expect(decidePromotion(twoLosses, cfg).decision).toBe('rollback');
  });

  test('a zero-tolerance config (maxRegressions=0) still vetoes on a single loss', () => {
    const strict: ShadowConfig = { ...cfg, maxRegressions: 0 };
    const p = make({ trialsSoFar: 8, pendingWins: 6, currentWins: 1 });
    expect(decidePromotion(p, strict).decision).toBe('rollback');
  });

  test('rollbacks when the pending clearly loses', () => {
    const p = make({ trialsSoFar: 5, pendingWins: 1, currentWins: 4 });
    const d = decidePromotion(p, cfg);
    expect(d.decision).toBe('rollback');
    expect(d.winRate).toBeCloseTo(0.2, 2);
  });

  test('continues below minDecisiveTrials even with a perfect win-rate', () => {
    // 2-0 with 3 ties: winRate 1.0 but only 2 decisive trials < minDecisiveTrials(5).
    const p = make({ trialsSoFar: 5, pendingWins: 2, currentWins: 0, ties: 3 });
    expect(decidePromotion(p, cfg).decision).toBe('continue');
  });

  test('maxTrials force: losses beyond tolerance still roll back (veto wins over the force)', () => {
    const p = make({ trialsSoFar: cfg.maxTrials, pendingWins: 6, currentWins: 5, ties: 9 });
    const d = decidePromotion(p, cfg);
    expect(d.decision).toBe('rollback');
    expect(d.winRate).toBeCloseTo(6 / 11, 2);
  });

  test('maxTrials force decides on a thin decisive record, ignoring minDecisiveTrials', () => {
    // The ceiling is the forced decision: a bare >0.5 majority promotes even
    // with 2 decisive trials. That is why maxTrials is budgeted against the
    // judge's decisive YIELD rather than raw turns (see DEFAULT_SHADOW_CONFIG).
    const ahead = make({ trialsSoFar: cfg.maxTrials, pendingWins: 2, currentWins: 0, ties: cfg.maxTrials - 2 });
    expect(decidePromotion(ahead, cfg).decision).toBe('promote');
    const level = make({ trialsSoFar: cfg.maxTrials, pendingWins: 1, currentWins: 1, ties: cfg.maxTrials - 2 });
    expect(decidePromotion(level, cfg).decision).toBe('rollback');
  });

  test('returns continue when no decisive trials yet', () => {
    const p = make({ trialsSoFar: 3, pendingWins: 0, currentWins: 0, ties: 3 });
    expect(decidePromotion(p, cfg).decision).toBe('continue');
  });

  test('an all-tie record keeps observing PAST the ceiling — the window legitimately extends', () => {
    // The double-win judge makes long tie runs common; the ceiling is not a
    // guaranteed stopping point, and a pure-tie record must not be forced into
    // a coin-flip verdict.
    const p = make({ trialsSoFar: cfg.maxTrials * 3, ties: cfg.maxTrials * 3 });
    expect(decidePromotion(p, cfg).decision).toBe('continue');
  });

  test('a tolerant config (maxRegressions>0) permits promotion despite some losses', () => {
    const tolerant: ShadowConfig = { ...cfg, maxRegressions: 2 };
    // 6-2 (winRate 0.75): 2 regressions allowed → promotes on win-rate.
    expect(decidePromotion(
      make({ trialsSoFar: 8, pendingWins: 6, currentWins: 2 }), tolerant,
    ).decision).toBe('promote');
    // 6-3: exceeds the tolerance → rollback.
    expect(decidePromotion(
      make({ trialsSoFar: 9, pendingWins: 6, currentWins: 3 }), tolerant,
    ).decision).toBe('rollback');
  });

  test('respects custom promote threshold', () => {
    const strictCfg: ShadowConfig = { ...cfg, promoteThreshold: 0.8, minTrials: 3 };
    expect(decidePromotion(
      make({ trialsSoFar: 5, pendingWins: 5, currentWins: 0 }), strictCfg,
    ).decision).toBe('promote'); // 1.0 ≥ 0.8, zero regressions
  });
});

describe('applyPromotionDecision — closes the proposal→promote loop', () => {
  test('promote copies the versioned pending code into the live file', async () => {
    // Regression for `proteus-scaffold-gap`: the pending used to be written
    // to the live file at proposal time, so promote was a SQL flag flip with
    // no on-disk effect. After the fix, the pending lives in
    // scaffold/agent.js.v{N}; promote is a real file swap. This test exercises
    // the full proposal → promote round-trip.
    const { rt } = createTestRuntime();
    initScaffoldTables(rt.storage.execRaw);
    initShadowTables(rt.storage.execRaw);

    const v0Code = 'async function* run(rt, task) { yield "v0"; }';
    await rt.identity.scaffold.write(v0Code);
    void rt.storage.sql`INSERT INTO scaffold_versions (version, written_at, rationale, status)
                   VALUES (0, ${Date.now()}, ${'bootstrap'}, 'current')`;

    const pendingCode = 'async function* run(rt, task) { yield "v1-pending"; }';
    const modResult = await modifyScaffold(
      rt,
      'Pending scaffold version 1 — proves the live file stays untouched on proposal.',
      pendingCode,
    );
    expect(modResult.ok).toBe(true);

    // Live file is still v0 after the proposal.
    expect(await rt.identity.scaffold.read()).toBe(v0Code);

    // Promote: live file now holds the pending code.
    const pending = getPendingScaffold(rt.storage.sql);
    expect(pending).not.toBeNull();
    if (!pending) return;
    const promo = await applyPromotionDecision(rt, pending, 'promote');
    expect(promo.action).toBe('promote');
    expect(promo.newCurrentVersion).toBe(pending.version);
    expect(await rt.identity.scaffold.read()).toBe(pendingCode);
  });

  test('rollback marks pending rolled_back and re-confirms previous version', async () => {
    const { rt } = createTestRuntime();
    initScaffoldTables(rt.storage.execRaw);
    initShadowTables(rt.storage.execRaw);

    const v0Code = 'async function* run(rt, task) { yield "v0"; }';
    await rt.identity.scaffold.write(v0Code);
    void rt.storage.sql`INSERT INTO scaffold_versions (version, written_at, rationale, status)
                   VALUES (0, ${Date.now()}, ${'bootstrap'}, 'current')`;

    await modifyScaffold(
      rt,
      'Pending scaffold version 1 — proves rollback returns to v0 cleanly.',
      'async function* run(rt, task) { yield "v1-pending"; }',
    );
    const pending = getPendingScaffold(rt.storage.sql);
    expect(pending).not.toBeNull();
    if (!pending) return;

    const rb = await applyPromotionDecision(rt, pending, 'rollback');
    expect(rb.action).toBe('rollback');
    expect(rb.newCurrentVersion).toBe(0);
    expect(await rt.identity.scaffold.read()).toBe(v0Code);

    const statuses = rt.storage.sql<{ version: number; status: string }>`
      SELECT version, status FROM scaffold_versions ORDER BY version`;
    expect(statuses.find(s => s.version === 0)?.status).toBe('current');
    expect(statuses.find(s => s.version === 1)?.status).toBe('rolled_back');
  });

  test('modifyScaffold refuses a second pending while one is in flight', async () => {
    const { rt } = createTestRuntime();
    initScaffoldTables(rt.storage.execRaw);
    initShadowTables(rt.storage.execRaw);
    await rt.identity.scaffold.write('async function* run(rt, task) { yield "v0"; }');
    void rt.storage.sql`INSERT INTO scaffold_versions (version, written_at, rationale, status)
                   VALUES (0, ${Date.now()}, ${'bootstrap'}, 'current')`;

    const first = await modifyScaffold(
      rt, 'First pending proposal — should be accepted as v1.',
      'async function* run(rt, task) { yield "v1"; }',
    );
    expect(first.ok).toBe(true);

    // A second proposal while v1 is pending must be refused (not clobber v1).
    const second = await modifyScaffold(
      rt, 'Second pending proposal — must be refused while v1 is in flight.',
      'async function* run(rt, task) { yield "v2"; }',
    );
    expect(second.ok).toBe(false);
    expect(second.stage).toBe(3);
    // v1's versioned code is intact (not clobbered by the refused proposal).
    const v1 = await rt.storage.vfs.readFile('scaffold/agent.js.v1', { encoding: 'utf8' });
    const v1Text = v1 instanceof Uint8Array ? new TextDecoder().decode(v1) : v1;
    expect(v1Text).toContain('v1');
  });

  test('promote → modify → rollback cycle restores the correct current version', async () => {
    // After a promote, a fresh modify, then a rollback, the live file must
    // return to the PROMOTED version — not pending.version-1, which would be
    // the wrong (pre-promote) version under non-contiguous numbering.
    const { rt } = createTestRuntime();
    initScaffoldTables(rt.storage.execRaw);
    initShadowTables(rt.storage.execRaw);
    const v0 = 'async function* run(rt, task) { yield "v0"; }';
    await rt.identity.scaffold.write(v0);
    void rt.storage.sql`INSERT INTO scaffold_versions (version, written_at, rationale, status)
                   VALUES (0, ${Date.now()}, ${'bootstrap'}, 'current')`;

    // Propose + promote v1.
    const v1 = 'async function* run(rt, task) { yield "v1-promoted"; }';
    await modifyScaffold(rt, 'Propose v1 for promotion in the version-cycle regression test.', v1);
    let pending = getPendingScaffold(rt.storage.sql)!;
    await applyPromotionDecision(rt, pending, 'promote');
    expect(await rt.identity.scaffold.read()).toBe(v1);

    // Propose v2, then roll it back. Live must return to v1 (the current).
    const v2 = 'async function* run(rt, task) { yield "v2-rejected"; }';
    const mod = await modifyScaffold(rt, 'Propose v2, which the judge rejects in the cycle regression test.', v2);
    expect(mod.ok).toBe(true);
    pending = getPendingScaffold(rt.storage.sql)!;
    expect(pending.version).toBe(2); // monotonic above the promoted v1
    const rb = await applyPromotionDecision(rt, pending, 'rollback');
    expect(rb.action).toBe('rollback');
    expect(rb.newCurrentVersion).toBe(1); // back to the promoted v1, not pending-1=1 by luck
    expect(await rt.identity.scaffold.read()).toBe(v1);
    const cur = rt.storage.sql<{ version: number }>`
      SELECT version FROM scaffold_versions WHERE status='current' ORDER BY version DESC LIMIT 1`;
    expect(cur[0]?.version).toBe(1);
  });
});
