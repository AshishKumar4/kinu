/**
 * Scaffold variant archive — DGM-style lineage, branch-from-archived
 * round-trip, and the exploration-share selection policy.
 */

import { describe, test, expect } from 'bun:test';
import {
  listScaffoldArchive,
  selectEvolutionBase,
  modifyScaffold,
  applyPromotionDecision,
  getPendingScaffold,
  readScaffoldVersion,
  recordShadowEvaluation,
  initScaffoldTables,
  initShadowTables,
  buildScaffoldProposalPrompt,
  type ScaffoldArchiveEntry,
} from '../src/index.js';
import type { AgentRuntime } from '../src/types/agent-runtime.js';
import { createTestRuntime } from './helpers.js';

const RATIONALE = 'A rationale comfortably longer than the fifty-character gate-1 minimum length.';

function setupRt(): AgentRuntime {
  const { rt } = createTestRuntime();
  initScaffoldTables(rt.storage.execRaw);
  initShadowTables(rt.storage.execRaw);
  return rt;
}

function scaffoldSrc(tag: string): string {
  return `async function* run(rt, task) { yield { type: "chunk", data: "${tag}" }; }`;
}

async function seedV0(rt: AgentRuntime): Promise<void> {
  await rt.identity.scaffold.write(scaffoldSrc('v0'));
  rt.storage.sql`INSERT INTO scaffold_versions (version, written_at, rationale, status)
    VALUES (0, ${Date.now()}, 'bootstrap', 'current')`;
}

function entry(over: Partial<ScaffoldArchiveEntry>): ScaffoldArchiveEntry {
  return {
    version: 1, parentVersion: 0, status: 'historical', rationale: 'r', writtenAt: 0,
    trials: 0, wins: 0, losses: 0, ties: 0, winRate: null,
    ...over,
  };
}

describe('archive lineage + branch-from-archived round-trip', () => {
  test('lineage is recorded, scores aggregate, and a rolled-back variant is branchable', async () => {
    const rt = setupRt();
    await seedV0(rt);

    // v1 branches from v0 (default base = current), then loses a shadow trial
    // and is rolled back — it becomes an archived stepping stone.
    const v1 = await modifyScaffold(rt, RATIONALE, scaffoldSrc('v1'));
    expect(v1.ok).toBe(true);
    recordShadowEvaluation(rt.storage.sql, {
      currentVersion: 0, pendingVersion: v1.version!, task: 't1',
      currentOutput: 'c', pendingOutput: 'p',
      judgeResult: { winner: 'current', rationale: 'regressed', currentScore: 0.8, pendingScore: 0.3 },
    });
    await applyPromotionDecision(rt, getPendingScaffold(rt.storage.sql)!, 'rollback');

    // v2 explicitly BRANCHES FROM the rolled-back v1, not the live current v0.
    const v2 = await modifyScaffold(rt, RATIONALE, scaffoldSrc('v2'), { baseVersion: v1.version });
    expect(v2.ok).toBe(true);

    const archive = listScaffoldArchive(rt.storage.sql);
    const byVersion = new Map(archive.map((e) => [e.version, e]));
    expect(byVersion.get(v1.version!)!.parentVersion).toBe(0);
    expect(byVersion.get(v1.version!)!.status).toBe('rolled_back');
    expect(byVersion.get(v1.version!)!.losses).toBe(1);
    expect(byVersion.get(v1.version!)!.winRate).toBe(0);
    expect(byVersion.get(v2.version!)!.parentVersion).toBe(v1.version);
    expect(byVersion.get(v2.version!)!.status).toBe('pending');
    expect(byVersion.get(0)!.parentVersion).toBeNull();

    // The branch base's code is still recoverable from the single source of
    // truth (the agent.js.vN file) — the full DGM round-trip.
    expect(await readScaffoldVersion(rt, v1.version!)).toBe(scaffoldSrc('v1'));

    // And the v2 pending can win + promote like any trunk proposal.
    recordShadowEvaluation(rt.storage.sql, {
      currentVersion: 0, pendingVersion: v2.version!, task: 't2',
      currentOutput: 'c', pendingOutput: 'p',
      judgeResult: { winner: 'pending', rationale: 'better', currentScore: 0.4, pendingScore: 0.9 },
    });
    const outcome = await applyPromotionDecision(rt, getPendingScaffold(rt.storage.sql)!, 'promote');
    expect(outcome.action).toBe('promote');
    expect(await rt.identity.scaffold.read()).toBe(scaffoldSrc('v2'));
  });

  test('a proposal naming a nonexistent base version is refused', async () => {
    const rt = setupRt();
    await seedV0(rt);
    const result = await modifyScaffold(rt, RATIONALE, scaffoldSrc('vX'), { baseVersion: 42 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('base version v42 not found');
    expect(getPendingScaffold(rt.storage.sql)).toBeNull();
  });
});

describe('selectEvolutionBase — the exploration-share policy', () => {
  const archive: ScaffoldArchiveEntry[] = [
    entry({ version: 3, parentVersion: 2, status: 'current', trials: 5, wins: 4, losses: 0, ties: 1, winRate: 1 }),
    entry({ version: 2, parentVersion: 0, status: 'historical', trials: 4, wins: 3, losses: 1, ties: 0, winRate: 0.75 }),
    entry({ version: 1, parentVersion: 0, status: 'rolled_back', trials: 2, wins: 0, losses: 2, ties: 0, winRate: 0 }),
    entry({ version: 0, parentVersion: null, status: 'historical' }),
  ];

  test('exploits the live current outside the exploration share', () => {
    const pick = selectEvolutionBase(archive, { exploreShare: 0.2, random: () => 0.9 });
    expect(pick).toEqual({ version: 3, mode: 'current' });
  });

  test('explores an archived variant inside the exploration share', () => {
    const pick = selectEvolutionBase(archive, { exploreShare: 0.2, random: () => 0.1 });
    expect(pick!.mode).toBe('explore');
    expect(pick!.version).not.toBe(3); // never the current on an explore roll
    expect([2, 1, 0]).toContain(pick!.version);
  });

  test('exploreShare=0 always picks current; =1 always explores', () => {
    for (const roll of [0, 0.3, 0.7, 0.999]) {
      expect(selectEvolutionBase(archive, { exploreShare: 0, random: () => roll })!.mode).toBe('current');
      expect(selectEvolutionBase(archive, { exploreShare: 1, random: () => roll })!.mode).toBe('explore');
    }
  });

  test('explore weighting favors high win-rate and novel (untried) variants', () => {
    // Weight = (winRate ?? 0.5) + 1/(1+trials):
    //   v2 (0.75 + 0.2 = 0.95), v1 (0 + 1/3 ≈ 0.33), v0 (0.5 + 1 = 1.5).
    // Sample the policy's distribution with a deterministic LCG.
    let s = 7;
    const rng = () => { s = (s * 1664525 + 1013904223) % 0xffffffff; return s / 0xffffffff; };
    const picks = { 0: 0, 1: 0, 2: 0 } as Record<number, number>;
    for (let i = 0; i < 600; i++) {
      const pick = selectEvolutionBase(archive, { exploreShare: 1, random: rng })!;
      picks[pick.version] = (picks[pick.version] ?? 0) + 1;
    }
    // The untried root (max novelty bonus) and the strong v2 must both beat
    // the twice-beaten v1 — yet v1 stays reachable (DGM: no variant is dead).
    expect(picks[0]).toBeGreaterThan(picks[1]);
    expect(picks[2]).toBeGreaterThan(picks[1]);
    expect(picks[1]).toBeGreaterThan(0);
  });

  test('degenerate archives: no current → first explorable; empty → null', () => {
    const noCurrent = [entry({ version: 1, status: 'rolled_back' })];
    expect(selectEvolutionBase(noCurrent, { exploreShare: 0, random: () => 0.9 }))
      .toEqual({ version: 1, mode: 'explore' });
    expect(selectEvolutionBase([], { exploreShare: 0.5 })).toBeNull();
    // Only a pending exists (mid-trial) — fall back to newest row as current-mode.
    const onlyPending = [entry({ version: 2, status: 'pending' })];
    expect(selectEvolutionBase(onlyPending, { exploreShare: 1, random: () => 0 }))
      .toEqual({ version: 2, mode: 'current' });
  });
});

describe('proposal prompt cites the archive', () => {
  test('archive block lists variants with lineage + record and names the branch base', () => {
    const prompt = buildScaffoldProposalPrompt(scaffoldSrc('v1'), 'be terser', {
      base: { version: 1, mode: 'explore' },
      entries: [
        entry({ version: 3, parentVersion: 2, status: 'current', trials: 5, wins: 4, losses: 0, ties: 1, winRate: 1 }),
        entry({ version: 1, parentVersion: 0, status: 'rolled_back', trials: 2, wins: 0, losses: 2, ties: 0, winRate: 0, rationale: 'tried branching heads' }),
      ],
    });
    expect(prompt).toContain('Scaffold archive');
    expect(prompt).toContain('v3 [current, parent v2, 4-0-1 W-L-T]');
    expect(prompt).toContain('v1 [rolled_back, parent v0, 0-2-0 W-L-T] — tried branching heads');
    expect(prompt).toContain('branching from ARCHIVED v1');
    expect(prompt).toContain('cite its version');
  });

  test('without archive context the prompt is unchanged in shape', () => {
    const prompt = buildScaffoldProposalPrompt(scaffoldSrc('v0'), 'be terser');
    expect(prompt).not.toContain('Scaffold archive');
  });
});
