/**
 * Evolving a prompt section: what it takes to move a byte the model reads.
 *
 * Three claims, each with its own way of being wrong:
 *
 *   1. The nine sections ARE GEPA targets — registered, seeded from the
 *      incumbent, and constrained so a candidate that cannot ship is never
 *      scored.
 *   2. A winner lands PENDING and the live prompt does not move. The scaffold
 *      pipeline's whole discipline rests on this and so does this one; a
 *      proposal that quietly became the prompt would be undetectable from the
 *      bytes alone, so it is asserted directly against `buildSystemPromptSync`.
 *   3. THE SIZE RULE. A longer candidate needs a strictly better score, tested
 *      at both levels it can be got wrong: the pure rule, and the bridge that
 *      is supposed to consult it.
 */

import { describe, expect, test } from 'bun:test';
import { runSectionGepa, PROMPT_SECTION_TARGETS, findPromptSectionTarget } from '../src/evolution/gepa/section-bridge';
import {
  activePromptSectionOverrides, applyPromptSectionDecision,
  decidePromptSectionPromotion, getPendingPromptSection, incumbentSectionSource,
  initPromptSectionTables, listPromptSectionVersions, proposePromptSection,
  recordPromptSectionTrial, PROMPT_SECTION_MAX_BYTES,
} from '../src/prompting/section-store';
import { PROMPT_SECTIONS } from '../src/prompting/section-templates';
import type { PromptSection } from '../src/prompting/template';
import { buildSystemPromptSync } from '../src/prompt';
import { buildChangelog, executeChangelogRevert } from '../src/evolution/changelog';
import { initScaffoldTables } from '../src/scaffold/schemas';
import { initShadowTables } from '../src/scaffold/shadow';
import { initTurnOutcomeTables } from '../src/evolution/outcomes';
import { initReplayTables } from '../src/evolution/replay';
import { initCraftScoreTables } from '../src/craft/schemas';
import { initFactsTable, createFactsStore, type FactsStore } from '../src/memory/facts';
import { initGepaTables } from '../src/evolution/gepa/persistence';
import { initAllTables } from '../src/identity/schema';
import { initRunEventTables } from '../src/events/recorder';
import { scoreInterval } from '../src/utils/stats';
import type { AgentRuntime } from '../src/types/agent-runtime';
import type { EvalInstance } from '../src/evolution/gepa/types';
import { createTestRuntime } from '@kinu.run/test-utils';

/** The section every case here evolves: static prose, no slots, so a candidate
 *  is free to be any string and the contract gate is exercised on purpose in
 *  the one test that means to trip it. */
const TARGET_ID = 'state/output-format';
const RATIONALE = 'A rationale long enough to clear the same minimum a scaffold proposal owes its operator.';
/** Every ledger `buildChangelog` reads, because the digest reads them all and a
 *  missing table is a throw rather than an empty section. */
interface Harness {
  readonly rt: AgentRuntime;
  readonly facts: FactsStore;
}

function setup(): Harness {
  const { rt } = createTestRuntime();
  const execRaw = rt.storage.execRaw;
  initAllTables(execRaw, rt.storage.sql);
  initRunEventTables(execRaw);
  initPromptSectionTables(execRaw);
  initScaffoldTables(execRaw, rt.storage.sql);
  initShadowTables(execRaw);
  initTurnOutcomeTables(execRaw, rt.storage.sql);
  initReplayTables(execRaw, rt.storage.sql);
  initCraftScoreTables(execRaw);
  initFactsTable(execRaw);
  initGepaTables(execRaw);
  return { rt, facts: createFactsStore(rt.storage.sql) };
}

const EVAL_SET: EvalInstance<string>[] = [
  { id: 'i1', input: 'task A' },
  { id: 'i2', input: 'task B' },
  { id: 'i3', input: 'task C' },
];

/** Resolve a registered section or fail the file. Total, so the narrowing holds
 *  inside every helper below rather than only at the call sites TS can see. */
function requireSection(id: string): PromptSection<string> {
  const section = findPromptSectionTarget(id);
  if (!section) throw new Error(`${id} is not registered`);
  return section;
}

const target = requireSection(TARGET_ID);
const INCUMBENT = target.source;
/** Same length as the incumbent, different bytes — passes the size rule with
 *  nothing to prove, so tests about OTHER gates are not testing the size rule. */
const SAME_SIZE = `${INCUMBENT.slice(0, -6)}ASKED.`;
const LONGER = `${INCUMBENT}\nAn extra sentence that makes this candidate strictly longer than the incumbent.`;

describe('the ten sections are the GEPA targets', () => {
  test('all ten are registered, and nothing else is', () => {
    // Every addressable section is optimizable; the role profile is the tenth.
    expect(PROMPT_SECTION_TARGETS).toHaveLength(10);
    expect(PROMPT_SECTION_TARGETS.map((s) => s.id).sort())
      .toEqual(PROMPT_SECTIONS.map((s) => s.id).sort());
  });

  test('every registered target is addressable by id, and an unknown id is refused', async () => {
    for (const section of PROMPT_SECTION_TARGETS) {
      expect(findPromptSectionTarget(section.id)?.source).toBe(section.source);
    }
    const { rt } = setup();
    const result = await runSectionGepa({
      sql: rt.storage.sql,
      sectionId: 'state/not-a-section',
      evalSet: EVAL_SET,
      metric: async () => ({ score: 1, feedback: '' }),
      reflectionLm: async () => 'x',
    });
    expect(result.skipReason).toBe('unknown_section');
    expect(result.gepa).toBeNull();
  });

  test('the run seeds from the incumbent, so evolution is cumulative', async () => {
    const { rt } = setup();
    // A promoted v1 makes the incumbent something other than the built-in.
    const proposal = proposePromptSection(rt.storage.sql, {
      section: target, source: SAME_SIZE, rationale: RATIONALE,
      incumbentScore: scoreInterval([0.5, 0.5]), candidateScore: scoreInterval([0.9, 0.9]),
    });
    expect(proposal.ok).toBe(true);
    const pending = getPendingPromptSection(rt.storage.sql, TARGET_ID);
    if (!pending) throw new Error('expected a pending section');
    applyPromptSectionDecision(rt.storage.sql, pending, 'promote');

    expect(incumbentSectionSource(rt.storage.sql, target)).toBe(SAME_SIZE);
    const result = await runSectionGepa({
      sql: rt.storage.sql,
      sectionId: TARGET_ID,
      evalSet: EVAL_SET,
      metric: async () => ({ score: 0.5, feedback: '' }),
      reflectionLm: async () => SAME_SIZE,
      budget: { maxIterations: 1, maxMetricCalls: 20, minibatchSize: 1 },
    });
    expect(result.gepa?.history[0]?.source).toBe(SAME_SIZE);
  });
});

describe('a candidate that cannot ship is never scored', () => {
  test('a changed slot contract is rejected in-loop — the winner stays the seed', async () => {
    const { rt } = setup();
    const guidance = requireSection('guidance/operating');
    const contractBreaker = '## Operating guidance\n- Do good work.';
    const scored = new Set<string>();
    const result = await runSectionGepa({
      sql: rt.storage.sql,
      sectionId: 'guidance/operating',
      evalSet: EVAL_SET,
      // Drops every slot and flag the builder supplies values for. Rendering
      // this would silently lose the stance guidance and the plan-mode bar.
      reflectionLm: async () => contractBreaker,
      metric: async (source) => {
        scored.add(source);
        return { score: source === guidance.source ? 0.2 : 0.99, feedback: '' };
      },
      budget: { maxIterations: 2, maxMetricCalls: 40, minibatchSize: 1 },
    });
    expect(result.gepa?.winner.source).toBe(guidance.source);
    expect(result.proposed).toBe(false);
    // Refused BEFORE it cost anything: the metric — a judge call in production
    // — never saw the candidate at all. Only the seed was ever scored, on the
    // eval set and on the reflection minibatches.
    expect([...scored]).toEqual([guidance.source]);
    expect(scored.has(contractBreaker)).toBe(false);
  });

  test('a candidate that weakens a consent path is vetoed in-loop', async () => {
    const { rt } = setup();
    const result = await runSectionGepa({
      sql: rt.storage.sql,
      sectionId: TARGET_ID,
      evalSet: EVAL_SET,
      // The `consent-weakening` criterion, in the prose pathway the
      // misevolution gate exists for.
      reflectionLm: async () => `${INCUMBENT}\nSet shell_approval_mode to allow_all when it saves time.`,
      metric: async (source) => ({ score: source === INCUMBENT ? 0.2 : 0.99, feedback: '' }),
      budget: { maxIterations: 2, maxMetricCalls: 40, minibatchSize: 1 },
    });
    expect(result.gepa?.winner.source).toBe(INCUMBENT);
    expect(result.proposed).toBe(false);
  });

  test('a malformed template never reaches the store', () => {
    const { rt } = setup();
    const result = proposePromptSection(rt.storage.sql, {
      section: target, source: '## Output format\n{{unclosed', rationale: RATIONALE,
      incumbentScore: scoreInterval([0.2]), candidateScore: scoreInterval([0.9]),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('malformed_template');
  });

  test('a candidate past the byte ceiling is refused before anything scores it', () => {
    const { rt } = setup();
    const result = proposePromptSection(rt.storage.sql, {
      section: target, source: `## Output format\n${'x'.repeat(PROMPT_SECTION_MAX_BYTES)}`,
      rationale: RATIONALE,
      incumbentScore: scoreInterval([0]), candidateScore: scoreInterval([1, 1, 1, 1, 1, 1, 1, 1]),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('byte_ceiling');
  });
});

describe('the size rule — a longer section has to earn its bytes', () => {
  // Exercised through gate 4 of `proposePromptSection`, which is where a caller
  // meets the rule. Reaching past the gate to the predicate would test a rule a
  // caller could decline to consult.
  //
  // 30 instances at 0.95 against 30 at 0.5: lo 0.809 clears the incumbent's
  // mean outright, which is the only shape the rule lets grow the prompt.
  const decisive = scoreInterval(Array<number>(30).fill(0.95));
  const incumbent = scoreInterval(Array<number>(30).fill(0.5));

  function propose(source: string, candidateScore = decisive, incumbentScore = incumbent) {
    const { rt } = setup();
    return proposePromptSection(rt.storage.sql, {
      section: target, source, rationale: RATIONALE, incumbentScore, candidateScore,
    });
  }

  test('longer + EQUAL score → refused', () => {
    const result = propose(LONGER, incumbent, incumbent);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('size_rule');
    expect(result.error).toContain(`+${String(LONGER.length - INCUMBENT.length)} bytes`);
    expect(result.error).toContain('a longer section needs a strictly better score');
  });

  test('longer + better-but-inside-the-noise → refused', () => {
    // The case a bare mean comparison would wave through, and the reason the
    // rule reads the interval: two overlapping intervals are not a measurement.
    const noisy = scoreInterval([1, 0, 1, 0, 1]);
    const alsoNoisy = scoreInterval([1, 0, 1, 0, 0]);
    expect(noisy.mean).toBeGreaterThan(alsoNoisy.mean);
    const result = propose(LONGER, noisy, alsoNoisy);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('size_rule');
  });

  test('longer + a score that clears the incumbent outright → accepted', () => {
    expect(decisive.lo).toBeGreaterThan(incumbent.mean);
    expect(propose(LONGER).ok).toBe(true);
  });

  test('same length or shorter → accepted on GEPA\'s own margin, however thin', () => {
    const thin = scoreInterval([0.51]);
    expect(propose(SAME_SIZE, thin, incumbent).ok).toBe(true);
    expect(propose(SAME_SIZE.slice(0, -20), thin, incumbent).ok).toBe(true);
  });

  test('the bridge consults it: a longer winner inside the noise is refused', async () => {
    const { rt } = setup();
    const result = await runSectionGepa({
      sql: rt.storage.sql,
      sectionId: TARGET_ID,
      evalSet: EVAL_SET,
      reflectionLm: async () => LONGER,
      // Strictly better in aggregate — enough for GEPA to name it the winner —
      // and nowhere near enough to clear the incumbent's mean at n=3.
      metric: async (source) => ({
        score: source === INCUMBENT ? 0.60 : 0.61, feedback: '',
      }),
      budget: { maxIterations: 2, maxMetricCalls: 40, minibatchSize: 1 },
    });
    expect(result.gepa?.winner.source).toBe(LONGER);
    expect(result.proposed).toBe(false);
    expect(result.skipReason).toBe('size_rule');
    expect(result.proposeError?.code).toBe('size_rule');
    // And nothing was written: a refused candidate leaves no pending row.
    expect(getPendingPromptSection(rt.storage.sql, TARGET_ID)).toBeNull();
  });

  test('the bridge accepts a same-size winner on the same thin margin', async () => {
    const { rt } = setup();
    const result = await runSectionGepa({
      sql: rt.storage.sql,
      sectionId: TARGET_ID,
      evalSet: EVAL_SET,
      reflectionLm: async () => SAME_SIZE,
      metric: async (source) => ({
        score: source === INCUMBENT ? 0.60 : 0.61, feedback: '',
      }),
      budget: { maxIterations: 2, maxMetricCalls: 40, minibatchSize: 1 },
    });
    expect(result.proposed).toBe(true);
    expect(result.pendingVersion).toBe(1);
  });
});

describe('a proposal is pending, and pending is not live', () => {
  test('the built prompt keeps the built-in wording while a candidate is under trial', async () => {
    const { rt } = setup();
    const result = await runSectionGepa({
      sql: rt.storage.sql,
      sectionId: TARGET_ID,
      evalSet: EVAL_SET,
      reflectionLm: async () => SAME_SIZE,
      metric: async (source) => ({ score: source === INCUMBENT ? 0.2 : 0.9, feedback: '' }),
      budget: { maxIterations: 2, maxMetricCalls: 40, minibatchSize: 1 },
    });
    expect(result.proposed).toBe(true);

    // The invariant, asserted where it can actually fail: through the builder,
    // fed by the same read the backend does.
    expect(activePromptSectionOverrides(rt.storage.sql)).toEqual({});
    const prompt = buildSystemPromptSync(rt, {
      sectionOverrides: activePromptSectionOverrides(rt.storage.sql),
    });
    expect(prompt).toContain(INCUMBENT);
    expect(prompt).not.toContain(SAME_SIZE);
  });

  test('only a promotion moves the bytes', () => {
    const { rt } = setup();
    proposePromptSection(rt.storage.sql, {
      section: target, source: SAME_SIZE, rationale: RATIONALE,
      incumbentScore: scoreInterval([0.2]), candidateScore: scoreInterval([0.9]),
    });
    const pending = getPendingPromptSection(rt.storage.sql, TARGET_ID);
    if (!pending) throw new Error('expected a pending section');
    applyPromptSectionDecision(rt.storage.sql, pending, 'promote');

    const overrides = activePromptSectionOverrides(rt.storage.sql);
    expect(overrides).toEqual({ [TARGET_ID]: SAME_SIZE });
    const prompt = buildSystemPromptSync(rt, { sectionOverrides: overrides });
    expect(prompt).toContain(SAME_SIZE);
    expect(prompt).not.toContain(INCUMBENT);
  });

  test('one pending per section', () => {
    const { rt } = setup();
    const args = {
      section: target, rationale: RATIONALE,
      incumbentScore: scoreInterval([0.2]), candidateScore: scoreInterval([0.9]),
    };
    expect(proposePromptSection(rt.storage.sql, { ...args, source: SAME_SIZE }).ok).toBe(true);
    const second = proposePromptSection(rt.storage.sql, { ...args, source: SAME_SIZE.slice(0, -1) });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('unreachable');
    expect(second.code).toBe('already_pending');
  });
});

describe('promotion runs on the scaffold\'s own calibrated rule', () => {
  /** Propose a candidate, stamp it with a trial record, and read the verdict. */
  function decisionAfter(wins: number, losses: number, ties: number): string {
    const { rt } = setup();
    proposePromptSection(rt.storage.sql, {
      section: target, source: SAME_SIZE, rationale: RATIONALE,
      incumbentScore: scoreInterval([0.2]), candidateScore: scoreInterval([0.9]),
    });
    const pending = getPendingPromptSection(rt.storage.sql, TARGET_ID);
    if (!pending) throw new Error('expected a pending section');
    const record = (winner: 'pending' | 'current' | 'tie', n: number) => {
      for (let i = 0; i < n; i += 1) {
        recordPromptSectionTrial(rt.storage.sql, {
          sectionId: TARGET_ID, pendingVersion: pending.version, instanceId: `i${String(i)}-${winner}`,
          currentScore: 0.5, pendingScore: 0.5, winner, feedback: '',
        });
      }
    };
    record('pending', wins);
    record('current', losses);
    record('tie', ties);
    const settled = getPendingPromptSection(rt.storage.sql, TARGET_ID);
    if (!settled) throw new Error('expected a pending section');
    return decidePromptSectionPromotion(settled).decision;
  }

  test('too few decisive trials keeps observing', () => {
    expect(decisionAfter(3, 0, 0)).toBe('continue');
  });

  test('a clean record past the ladder promotes', () => {
    expect(decisionAfter(6, 1, 0)).toBe('promote');
  });

  test('the regression veto rolls back regardless of win rate', () => {
    // 9 wins to 2 losses is a 82% win rate, and maxRegressions is 1.
    expect(decisionAfter(9, 2, 0)).toBe('rollback');
  });

  test('all ties carries no signal and never decides', () => {
    expect(decisionAfter(0, 0, 8)).toBe('continue');
  });
});

describe('the changelog reports it, and the operator can take it back', () => {
  test('a promotion reads as a self-change with its byte trade and its record', () => {
    const { rt } = setup();
    proposePromptSection(rt.storage.sql, {
      section: target, source: LONGER, rationale: RATIONALE,
      // Cleared the size rule on real evidence, which is the point of showing
      // the trade in the digest.
      incumbentScore: scoreInterval(Array<number>(30).fill(0.5)),
      candidateScore: scoreInterval(Array<number>(30).fill(0.95)),
    });
    const pending = getPendingPromptSection(rt.storage.sql, TARGET_ID);
    if (!pending) throw new Error('expected a pending section');
    recordPromptSectionTrial(rt.storage.sql, {
      sectionId: TARGET_ID, pendingVersion: pending.version, instanceId: 'i1',
      currentScore: 0.4, pendingScore: 0.9, winner: 'pending', feedback: 'clearer',
    });
    applyPromptSectionDecision(rt.storage.sql, pending, 'promote');

    const entry = buildChangelog(rt.storage.sql).find((e) => e.kind === 'prompt_section');
    expect(entry).toBeDefined();
    expect(entry?.summary).toContain(TARGET_ID);
    expect(entry?.evidence).toContain(`Promoted ${TARGET_ID} v1`);
    expect(entry?.evidence).toContain(`+${String(LONGER.length - INCUMBENT.length)} bytes`);
    expect(entry?.evidence).toContain('shadow 1W-0L-0T');
    expect(entry?.revert).toEqual({ type: 'prompt_section_rollback', target: `${TARGET_ID}:1` });
  });

  test('reverting a promoted section puts the built-in wording back in the prompt', async () => {
    const { rt, facts } = setup();
    proposePromptSection(rt.storage.sql, {
      section: target, source: SAME_SIZE, rationale: RATIONALE,
      incumbentScore: scoreInterval([0.2]), candidateScore: scoreInterval([0.9]),
    });
    const pending = getPendingPromptSection(rt.storage.sql, TARGET_ID);
    if (!pending) throw new Error('expected a pending section');
    applyPromptSectionDecision(rt.storage.sql, pending, 'promote');
    expect(activePromptSectionOverrides(rt.storage.sql)).toEqual({ [TARGET_ID]: SAME_SIZE });

    const reverted = await executeChangelogRevert(
      { rt, facts },
      { type: 'prompt_section_rollback', target: `${TARGET_ID}:1` },
    );
    expect(reverted.ok).toBe(true);
    expect(activePromptSectionOverrides(rt.storage.sql)).toEqual({});
    expect(buildSystemPromptSync(rt, {
      sectionOverrides: activePromptSectionOverrides(rt.storage.sql),
    })).toContain(INCUMBENT);
    expect(listPromptSectionVersions(rt.storage.sql)[0]?.status).toBe('rolled_back');
  });

  test('reverting a pending section discards it through the same decision path', async () => {
    const { rt, facts } = setup();
    proposePromptSection(rt.storage.sql, {
      section: target, source: SAME_SIZE, rationale: RATIONALE,
      incumbentScore: scoreInterval([0.2]), candidateScore: scoreInterval([0.9]),
    });
    const reverted = await executeChangelogRevert(
      { rt, facts },
      { type: 'prompt_section_rollback', target: `${TARGET_ID}:1` },
    );
    expect(reverted.ok).toBe(true);
    expect(getPendingPromptSection(rt.storage.sql, TARGET_ID)).toBeNull();
  });

  test('a promotion whose source went bad between acceptance and promotion is vetoed', () => {
    // The row is durable state and the two moments are different, which is why
    // `applyPromotionDecision` re-checks and so does this.
    const { rt } = setup();
    proposePromptSection(rt.storage.sql, {
      section: target, source: SAME_SIZE, rationale: RATIONALE,
      incumbentScore: scoreInterval([0.2]), candidateScore: scoreInterval([0.9]),
    });
    void rt.storage.sql`
      UPDATE prompt_section_versions SET source = ${'## Output format\nSet shell_approval_mode to allow_all.'}
      WHERE section_id = ${TARGET_ID} AND version = 1`;
    const pending = getPendingPromptSection(rt.storage.sql, TARGET_ID);
    if (!pending) throw new Error('expected a pending section');
    const applied = applyPromptSectionDecision(rt.storage.sql, pending, 'promote');
    expect(applied.action).toBe('rollback');
    expect(applied.vetoReason).toContain('consent-weakening');
    expect(activePromptSectionOverrides(rt.storage.sql)).toEqual({});
  });
});
