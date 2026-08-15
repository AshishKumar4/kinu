/**
 * Scaffold variant archive — DGM-style lineage, branch-from-archived
 * round-trip, and the exploration-share selection policy.
 */

import { describe, test, expect } from 'bun:test';
import {
  listScaffoldArchive,
  listRejectedProposals,
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
import { clusterPathologies } from '../src/evolution/pathology.js';
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
  void rt.storage.sql`INSERT INTO scaffold_versions (version, written_at, rationale, status)
    VALUES (0, ${Date.now()}, 'bootstrap', 'current')`;
}

function entry(over: Partial<ScaffoldArchiveEntry>): ScaffoldArchiveEntry {
  return {
    version: 1, parentVersion: 0, status: 'historical', rationale: 'r', pathology: null, writtenAt: 0,
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
    expect(byVersion.get(v2.version!)!.parentVersion).toBe(v1.version!);
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
    const picks = new Map([[0, 0], [1, 0], [2, 0]]);
    for (let i = 0; i < 600; i++) {
      const pick = selectEvolutionBase(archive, { exploreShare: 1, random: rng })!;
      picks.set(pick.version, (picks.get(pick.version) ?? 0) + 1);
    }
    // The untried root (max novelty bonus) and the strong v2 must both beat
    // the twice-beaten v1 — yet v1 stays reachable (DGM: no variant is dead).
    expect(picks.get(0) ?? 0).toBeGreaterThan(picks.get(1) ?? 0);
    expect(picks.get(2) ?? 0).toBeGreaterThan(picks.get(1) ?? 0);
    expect(picks.get(1) ?? 0).toBeGreaterThan(0);
  });

  test('the exploit path ignores lineage entirely — exploreShare still governs', () => {
    // The live current is a proven dead end (its only child regressed hard).
    // Outside the exploration share the policy must still branch from it:
    // clade-metaproductivity ranks stepping stones, it does not decide whether
    // to explore at all — that stays the exploreShare seam's job.
    const deadEndTrunk: ScaffoldArchiveEntry[] = [
      entry({ version: 2, parentVersion: 1, status: 'historical', trials: 9, wins: 0, losses: 9, winRate: 0 }),
      entry({ version: 1, parentVersion: 0, status: 'current', trials: 9, wins: 9, losses: 0, winRate: 1 }),
      entry({ version: 0, parentVersion: null, status: 'historical', trials: 4, wins: 2, losses: 2, winRate: 0.5 }),
    ];
    expect(selectEvolutionBase(deadEndTrunk, { exploreShare: 0.2, random: () => 0.9 }))
      .toEqual({ version: 1, mode: 'current' });
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

describe('selectEvolutionBase — clade-metaproductivity', () => {
  /** Feeds the injected RNG a fixed script: draw 1 is the explore/exploit
   *  roll, draw 2 is the weighted sample. No test touches real randomness. */
  function seq(...rolls: number[]): () => number {
    let i = 0;
    return () => rolls[i++] ?? 0;
  }

  /** The pre-clade policy — weight a stepping stone by its OWN win rate plus
   *  the novelty bonus. Kept here as the reference the cold-start path has to
   *  reproduce exactly, and as the baseline the lineage signal must beat. */
  function legacyExplorePick(archive: ReadonlyArray<ScaffoldArchiveEntry>, roll: number): number {
    const explorable = archive.filter((e) => e.status === 'historical' || e.status === 'rolled_back');
    const weight = (e: ScaffoldArchiveEntry): number => (e.winRate ?? 0.5) + 1 / (1 + e.trials);
    const total = explorable.reduce((acc, e) => acc + weight(e), 0);
    let r = roll * total;
    for (const e of explorable) {
      r -= weight(e);
      if (r <= 0) return e.version;
    }
    return explorable[explorable.length - 1]!.version;
  }

  // v1 is the archive's best-scoring variant (0.9 over 10 observations) and a
  // dead end — its only child regressed to zero. v3 scored mediocre (0.4) but
  // every good version descends from it. HGM's finding in one lineage.
  const lineage: ScaffoldArchiveEntry[] = [
    entry({ version: 5, parentVersion: 4, status: 'current', trials: 10, wins: 10, losses: 0, winRate: 1 }),
    entry({ version: 4, parentVersion: 3, status: 'historical', trials: 10, wins: 10, losses: 0, winRate: 1 }),
    entry({ version: 3, parentVersion: null, status: 'historical', trials: 5, wins: 2, losses: 3, winRate: 0.4 }),
    entry({ version: 2, parentVersion: 1, status: 'historical', trials: 10, wins: 0, losses: 10, winRate: 0 }),
    entry({ version: 1, parentVersion: null, status: 'historical', trials: 10, wins: 9, losses: 1, winRate: 0.9 }),
  ];

  test('a productive ancestor outranks a higher-scoring dead end', () => {
    // The same roll that the own-score policy spends on the dead end now buys
    // the productive ancestor instead — the selection genuinely inverted.
    expect(legacyExplorePick(lineage, 0.7)).toBe(1);
    expect(selectEvolutionBase(lineage, { exploreShare: 1, random: seq(0, 0.7) }))
      .toEqual({ version: 3, mode: 'explore' });
  });

  test('over the whole distribution the productive lineage wins the compute', () => {
    let s = 11;
    const rng = () => { s = (s * 1664525 + 1013904223) % 0xffffffff; return s / 0xffffffff; };
    const clade = new Map([[1, 0], [2, 0], [3, 0], [4, 0]]);
    const legacy = new Map([[1, 0], [2, 0], [3, 0], [4, 0]]);
    for (let i = 0; i < 800; i++) {
      const cladeVersion = selectEvolutionBase(lineage, { exploreShare: 1, random: rng })!.version;
      clade.set(cladeVersion, (clade.get(cladeVersion) ?? 0) + 1);
      const legacyVersion = legacyExplorePick(lineage, rng());
      legacy.set(legacyVersion, (legacy.get(legacyVersion) ?? 0) + 1);
    }
    expect(clade.get(3) ?? 0).toBeGreaterThan(clade.get(1) ?? 0);
    expect(legacy.get(1) ?? 0).toBeGreaterThan(legacy.get(3) ?? 0);
    // The dead-end lineage keeps a share — no variant is ever unreachable.
    expect(clade.get(1) ?? 0).toBeGreaterThan(0);
  });

  test('cold start: with no scored descendants the policy is the old one exactly', () => {
    // Shape 1 — a pre-lineage archive (every parent_version null), i.e. what
    // the table holds before the first generation of branching.
    const flat: ScaffoldArchiveEntry[] = [
      entry({ version: 3, parentVersion: null, status: 'current', trials: 5, wins: 4, losses: 0, ties: 1, winRate: 1 }),
      entry({ version: 2, parentVersion: null, status: 'historical', trials: 4, wins: 3, losses: 1, winRate: 0.75 }),
      entry({ version: 1, parentVersion: null, status: 'rolled_back', trials: 2, wins: 0, losses: 2, winRate: 0 }),
      entry({ version: 0, parentVersion: null, status: 'historical' }),
    ];
    // Shape 2 — one generation deep, but the child has never been tried, so
    // the clade carries no information its parent didn't already have.
    const untriedChild: ScaffoldArchiveEntry[] = [
      entry({ version: 2, parentVersion: 1, status: 'current' }),
      entry({ version: 1, parentVersion: 0, status: 'historical' }),
      entry({ version: 0, parentVersion: null, status: 'historical', trials: 4, wins: 3, losses: 1, winRate: 0.75 }),
    ];
    for (const archive of [flat, untriedChild]) {
      for (const roll of [0, 0.05, 0.2, 0.37, 0.5, 0.63, 0.8, 0.99]) {
        expect(selectEvolutionBase(archive, { exploreShare: 1, random: seq(0, roll) })!.version)
          .toBe(legacyExplorePick(archive, roll));
      }
    }
  });

  test('the same injected RNG always yields the same base', () => {
    const first = selectEvolutionBase(lineage, { exploreShare: 0.5, random: seq(0.1, 0.42) });
    const second = selectEvolutionBase(lineage, { exploreShare: 0.5, random: seq(0.1, 0.42) });
    expect(first).toEqual(second);
    expect(first!.mode).toBe('explore');
  });
});

describe('pathology coverage — the diversity signal beside the clade score', () => {
  function seq(...rolls: number[]): () => number {
    let i = 0;
    return () => rolls[i++] ?? 0;
  }

  /** The policy WITHOUT the diversity term — clade + novelty only. The
   *  reference a pathology-free archive has to reproduce exactly. */
  function noDiversityPick(archive: ReadonlyArray<ScaffoldArchiveEntry>, roll: number): number {
    return selectEvolutionBase(
      archive.map((e) => ({ ...e, pathology: null })),
      { exploreShare: 1, random: seq(0, roll) },
    )!.version;
  }

  test('a pathology-free archive reproduces the pre-pathology policy exactly', () => {
    const archive: ScaffoldArchiveEntry[] = [
      entry({ version: 3, parentVersion: 2, status: 'current', trials: 5, wins: 4, losses: 1, winRate: 0.8 }),
      entry({ version: 2, parentVersion: 1, status: 'historical', trials: 4, wins: 3, losses: 1, winRate: 0.75 }),
      entry({ version: 1, parentVersion: null, status: 'rolled_back', trials: 2, wins: 0, losses: 2, winRate: 0 }),
    ];
    for (const roll of [0, 0.05, 0.2, 0.37, 0.5, 0.63, 0.8, 0.99]) {
      expect(selectEvolutionBase(archive, { exploreShare: 1, random: seq(0, roll) })!.version)
        .toBe(noDiversityPick(archive, roll));
    }
  });

  test('a thinly-covered cell outranks a crowded one at equal clade and trials', () => {
    // Identical in every scored respect; they differ only in how many
    // versions already target the cell each was written for.
    const crowded: ScaffoldArchiveEntry[] = [
      entry({ version: 4, parentVersion: null, status: 'current', pathology: 'error/code', trials: 4, wins: 2, losses: 2, winRate: 0.5 }),
      entry({ version: 3, parentVersion: null, status: 'historical', pathology: 'error/code', trials: 4, wins: 2, losses: 2, winRate: 0.5 }),
      entry({ version: 2, parentVersion: null, status: 'historical', pathology: 'error/code', trials: 4, wins: 2, losses: 2, winRate: 0.5 }),
      entry({ version: 1, parentVersion: null, status: 'historical', pathology: 'overreach/prose', trials: 4, wins: 2, losses: 2, winRate: 0.5 }),
    ];
    let s = 7;
    const rng = () => { s = (s * 1664525 + 1013904223) % 0xffffffff; return s / 0xffffffff; };
    const picks = new Map([[1, 0], [2, 0], [3, 0]]);
    for (let i = 0; i < 600; i++) {
      const version = selectEvolutionBase(crowded, { exploreShare: 1, random: rng })!.version;
      picks.set(version, (picks.get(version) ?? 0) + 1);
    }
    // v1 owns a cell of its own; v2 and v3 share theirs with the live current.
    expect(picks.get(1) ?? 0).toBeGreaterThan(picks.get(2) ?? 0);
    expect(picks.get(1) ?? 0).toBeGreaterThan(picks.get(3) ?? 0);
    // …and the crowded cell keeps a real share — this is a tilt, not a filter.
    expect((picks.get(2) ?? 0) + (picks.get(3) ?? 0)).toBeGreaterThan(picks.get(1) ?? 0);
  });

  test('diversity never overrides a clade score', () => {
    // v1 is the only version in its cell, but its lineage produced nothing.
    // v2 shares a crowded cell and its lineage is proven. Clade wins.
    const archive: ScaffoldArchiveEntry[] = [
      entry({ version: 4, parentVersion: 2, status: 'current', pathology: 'error/code', trials: 40, wins: 40, losses: 0, winRate: 1 }),
      entry({ version: 3, parentVersion: null, status: 'historical', pathology: 'error/code', trials: 40, wins: 40, losses: 0, winRate: 1 }),
      entry({ version: 2, parentVersion: null, status: 'historical', pathology: 'error/code', trials: 40, wins: 40, losses: 0, winRate: 1 }),
      entry({ version: 1, parentVersion: null, status: 'historical', pathology: 'repeat/terse', trials: 40, wins: 0, losses: 40, winRate: 0 }),
    ];
    let s = 3;
    const rng = () => { s = (s * 1664525 + 1013904223) % 0xffffffff; return s / 0xffffffff; };
    const picks = new Map([[1, 0], [2, 0], [3, 0]]);
    for (let i = 0; i < 600; i++) {
      const version = selectEvolutionBase(archive, { exploreShare: 1, random: rng })!.version;
      picks.set(version, (picks.get(version) ?? 0) + 1);
    }
    expect(picks.get(2) ?? 0).toBeGreaterThan(picks.get(1) ?? 0);
    expect(picks.get(3) ?? 0).toBeGreaterThan(picks.get(1) ?? 0);
  });

  test('a version that named no cell claims no coverage credit', () => {
    // Two unlabelled versions do not form a "cell" that dilutes each other,
    // and they earn nothing for being unlabelled.
    const archive: ScaffoldArchiveEntry[] = [
      entry({ version: 3, parentVersion: null, status: 'current', trials: 4, wins: 2, losses: 2, winRate: 0.5 }),
      entry({ version: 2, parentVersion: null, status: 'historical', trials: 4, wins: 2, losses: 2, winRate: 0.5 }),
      entry({ version: 1, parentVersion: null, status: 'historical', trials: 4, wins: 2, losses: 2, winRate: 0.5 }),
    ];
    for (const roll of [0.1, 0.4, 0.9]) {
      expect(selectEvolutionBase(archive, { exploreShare: 1, random: seq(0, roll) })!.version)
        .toBe(noDiversityPick(archive, roll));
    }
  });
});

describe('rejected proposals are queryable evidence', () => {
  test('a rolled-back version reports its reason and the judge’s own words', async () => {
    const rt = setupRt();
    await seedV0(rt);

    const proposal = `// pathology: error/code\n${scaffoldSrc('v1')}`;
    const result = await modifyScaffold(rt, RATIONALE, proposal);
    expect(result.ok).toBe(true);
    for (const winner of ['current', 'current', 'pending'] as const) {
      recordShadowEvaluation(rt.storage.sql, {
        currentVersion: 0, pendingVersion: result.version!, task: 't',
        currentOutput: 'a', pendingOutput: 'b',
        judgeResult: { winner, rationale: `${winner} was clearer`, currentScore: 1, pendingScore: 0 },
      });
    }
    await applyPromotionDecision(rt, getPendingScaffold(rt.storage.sql)!, 'rollback');

    const [rejected] = listRejectedProposals(rt.storage.sql);
    expect(rejected!.kind).toBe('rolled_back');
    expect(rejected!.version).toBe(result.version!);
    expect(rejected!.reason).toBe('lost 2 of 3 decisive shadow trials');
    expect(rejected!.pathology).toBe('error/code');
    expect(rejected!.judgeRationales).toEqual(['current was clearer', 'current was clearer']);
  });

  test('a proposal discarded before any decisive trial says so', async () => {
    const rt = setupRt();
    await seedV0(rt);
    await modifyScaffold(rt, RATIONALE, scaffoldSrc('v1'));
    await applyPromotionDecision(rt, getPendingScaffold(rt.storage.sql)!, 'rollback');

    const [rejected] = listRejectedProposals(rt.storage.sql);
    expect(rejected!.reason).toBe('discarded before any decisive shadow trial (0 trials, all ties)');
    expect(rejected!.pathology).toBeNull();
  });

  test('a misevolution veto is rejection evidence too, with no version behind it', async () => {
    const rt = setupRt();
    await seedV0(rt);
    rt.storage.execRaw(`CREATE TABLE IF NOT EXISTS evolution_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, message TEXT, data TEXT, created_at INTEGER)`);

    const vetoed = `async function* run(rt, task) { await fetch("https://x"); }`;
    expect((await modifyScaffold(rt, RATIONALE, vetoed)).ok).toBe(false);

    const [rejected] = listRejectedProposals(rt.storage.sql);
    expect(rejected!.kind).toBe('misevolution_veto');
    expect(rejected!.version).toBeNull();
    expect(rejected!.reason).toContain('network-egress');
    expect(rejected!.rationale).toBe(RATIONALE);
  });

  test('an archive with nothing refused answers with nothing', async () => {
    const rt = setupRt();
    await seedV0(rt);
    expect(listRejectedProposals(rt.storage.sql)).toEqual([]);
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

  test('a version’s pathology and why it was refused ride along on its line', () => {
    const prompt = buildScaffoldProposalPrompt(scaffoldSrc('v1'), 'be terser', {
      base: { version: 2, mode: 'current' },
      entries: [
        entry({ version: 2, parentVersion: 1, status: 'current', pathology: 'repeat/prose' }),
        entry({ version: 1, parentVersion: 0, status: 'rolled_back', pathology: 'error/code', trials: 3, wins: 1, losses: 2, winRate: 1 / 3 }),
      ],
      rejections: new Map([[1, 'lost 2 of 3 decisive shadow trials']]),
    });
    expect(prompt).toContain('for repeat/prose');
    expect(prompt).toContain('refused: lost 2 of 3 decisive shadow trials');
  });
});

describe('proposal prompt requires a named pathology when cells exist', () => {
  const cells = clusterPathologies([{
    turnId: 't1', outcome: 'corrected', userMessage: 'add retries to the uploader',
    assistantResponse: 'Sure, here is what I would do.\n'.repeat(40),
    followup: 'you did not actually run anything', scaffoldVersion: 1,
  }]);

  test('the cells and the tag requirement both appear', () => {
    const prompt = buildScaffoldProposalPrompt(scaffoldSrc('v0'), 'be terser', undefined, cells);
    expect(prompt).toContain('Failure pathologies mined from turns');
    expect(prompt).toContain(cells[0]!.id);
    expect(prompt).toContain('6. Name the failure pathology');
    expect(prompt).toContain('// pathology: <id>');
  });

  test('with no cells mined there is nothing to name and nothing is asked for', () => {
    const prompt = buildScaffoldProposalPrompt(scaffoldSrc('v0'), 'be terser');
    expect(prompt).not.toContain('Failure pathologies');
    expect(prompt).not.toContain('6. Name the failure pathology');
  });
});

describe('the named pathology is stamped on the version it belongs to', () => {
  test('modifyScaffold reads the tag off the code, for every proposal path', async () => {
    const rt = setupRt();
    await seedV0(rt);
    const tagged = `// pathology: no_action/prose\n${scaffoldSrc('v1')}`;
    const result = await modifyScaffold(rt, RATIONALE, tagged);

    const [row] = listScaffoldArchive(rt.storage.sql).filter((e) => e.version === result.version);
    expect(row!.pathology).toBe('no_action/prose');
  });

  test('an untagged or invented pathology stamps nothing rather than a guess', async () => {
    for (const code of [scaffoldSrc('v1'), `// pathology: made_up/cell\n${scaffoldSrc('v1')}`]) {
      const rt = setupRt();
      await seedV0(rt);
      const result = await modifyScaffold(rt, RATIONALE, code);
      const [row] = listScaffoldArchive(rt.storage.sql).filter((e) => e.version === result.version);
      expect(row!.pathology).toBeNull();
    }
  });
});
