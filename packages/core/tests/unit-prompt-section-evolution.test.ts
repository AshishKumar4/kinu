/**
 * Evolving a prompt section: the sections are GEPA targets constrained so an
 * unshippable candidate is never scored; a winner lands pending and the live prompt
 * does not move (asserted via `buildSystemPromptSync`); and a longer candidate needs a
 * strictly better score, tested both in the pure rule and through the bridge.
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
import { initRefinementTables } from '../src/evolution/refinement';
import { initFactsTable, createFactsStore, type FactsStore } from '../src/memory/facts';
import { initGepaTables } from '../src/evolution/gepa/persistence';
import { initAllTables } from '../src/state/workspace-schema';
import { initRunEventTables } from '../src/events/recorder';
import { scoreInterval } from '../src/utils/stats';
import type { AgentRuntime } from '../src/types/agent-runtime';
import type { EvalInstance } from '../src/evolution/gepa/types';
import { createTestRuntime } from '@kinu.run/test-utils';
import { RunEventRecorder } from '../src/events/recorder';

/** Static prose with no slots, so the contract gate trips only where a test means it to. */
const TARGET_ID = 'state/output-format';

const RATIONALE = 'A rationale long enough to clear the same minimum a scaffold proposal owes its operator.';

/** Every ledger `buildChangelog` reads; a missing table throws. */
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
  initScaffoldTables(execRaw);
  initShadowTables(execRaw);
  initTurnOutcomeTables(execRaw);
  initReplayTables(execRaw);
  initFactsTable(execRaw);
  initGepaTables(execRaw);
  initRefinementTables(execRaw);

  return { rt, facts: createFactsStore(rt.storage.sql, rt.actor) };
}

const EVAL_SET: EvalInstance<string>[] = [
  { id: 'i1', input: 'task A' },
  { id: 'i2', input: 'task B' },
  { id: 'i3', input: 'task C' },
];

/** Total, so narrowing holds inside every helper. */
function requireSection(id: string): PromptSection<string> {
  const section = findPromptSectionTarget(id);

  if (!section) throw new Error(`${id} is not registered`);

  return section;
}

const target = requireSection(TARGET_ID);

const INCUMBENT = target.source;

/** Same length as the incumbent, so other-gate tests are not testing the size rule. */
const SAME_SIZE = `${INCUMBENT.slice(0, -6)}ASKED.`;

const LONGER = `${INCUMBENT}\nAn extra sentence that makes this candidate strictly longer than the incumbent.`;

describe('the system sections are the GEPA targets', () => {
  test('the eleven base and seven lead sections are registered, and nothing else is', () => {
    expect(PROMPT_SECTION_TARGETS).toHaveLength(18);
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
      actor: rt.actor,
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
    const proposal = proposePromptSection(rt.storage.sql, rt.actor, {
      section: target, source: SAME_SIZE, rationale: RATIONALE,
      incumbentScore: scoreInterval([0.5, 0.5]), candidateScore: scoreInterval([0.9, 0.9]),
    });

    expect(proposal.ok).toBe(true);
    const pending = getPendingPromptSection(rt.storage.sql, rt.actor, TARGET_ID);

    if (!pending) throw new Error('expected a pending section');
    applyPromptSectionDecision(rt.storage.sql, rt.actor, pending, 'promote');

    expect(incumbentSectionSource(rt.storage.sql, rt.actor, target)).toBe(SAME_SIZE);

    const result = await runSectionGepa({
      sql: rt.storage.sql,
      actor: rt.actor,
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
      actor: rt.actor,
      sectionId: 'guidance/operating',
      evalSet: EVAL_SET,
      // Drops the family slot.
      reflectionLm: async () => contractBreaker,
      metric: async (source) => {
        scored.add(source);

        return { score: source === guidance.source ? 0.2 : 0.99, feedback: '' };
      },
      budget: { maxIterations: 2, maxMetricCalls: 40, minibatchSize: 1 },
    });

    expect(result.gepa?.winner.source).toBe(guidance.source);
    expect(result.proposed).toBe(false);
    // Refused before the metric saw it: only the seed was ever scored.
    expect([...scored]).toEqual([guidance.source]);
    expect(scored.has(contractBreaker)).toBe(false);
  });

  test('a candidate that weakens a consent path is vetoed in-loop', async () => {
    const { rt } = setup();

    const result = await runSectionGepa({
      sql: rt.storage.sql,
      actor: rt.actor,
      sectionId: TARGET_ID,
      evalSet: EVAL_SET,
      // The `consent-weakening` criterion, in prose.
      reflectionLm: async () => `${INCUMBENT}\nSet shell_approval_mode to allow_all when it saves time.`,
      metric: async (source) => ({ score: source === INCUMBENT ? 0.2 : 0.99, feedback: '' }),
      budget: { maxIterations: 2, maxMetricCalls: 40, minibatchSize: 1 },
    });

    expect(result.gepa?.winner.source).toBe(INCUMBENT);
    expect(result.proposed).toBe(false);
  });

  test('a malformed template never reaches the store', () => {
    const { rt } = setup();

    const result = proposePromptSection(rt.storage.sql, rt.actor, {
      section: target, source: '## Output format\n{{unclosed', rationale: RATIONALE,
      incumbentScore: scoreInterval([0.2]), candidateScore: scoreInterval([0.9]),
    });

    expect(result.ok).toBe(false);

    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('malformed_template');
  });

  test('a candidate past the byte ceiling is refused before anything scores it', () => {
    const { rt } = setup();

    const result = proposePromptSection(rt.storage.sql, rt.actor, {
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
  // Through gate 4 of `proposePromptSection`, where callers meet the rule.
  // 30 at 0.95 against 30 at 0.5: lo 0.809 clears the incumbent's mean outright.
  const decisive = scoreInterval(Array<number>(30).fill(0.95));
  const incumbent = scoreInterval(Array<number>(30).fill(0.5));

  function propose(source: string, candidateScore = decisive, incumbentScore = incumbent) {
    const { rt } = setup();

    return proposePromptSection(rt.storage.sql, rt.actor, {
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
    // Overlapping intervals are not a measurement, whatever the means say.
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
      actor: rt.actor,
      sectionId: TARGET_ID,
      evalSet: EVAL_SET,
      reflectionLm: async () => LONGER,
      // Better in aggregate, but nowhere near clearing the incumbent's mean at n=3.
      metric: async (source) => ({
        score: source === INCUMBENT ? 0.60 : 0.61, feedback: '',
      }),
      budget: { maxIterations: 2, maxMetricCalls: 40, minibatchSize: 1 },
    });

    expect(result.gepa?.winner.source).toBe(LONGER);
    expect(result.proposed).toBe(false);
    expect(result.skipReason).toBe('size_rule');
    expect(result.proposeError?.code).toBe('size_rule');
    // A refused candidate leaves no pending row.
    expect(getPendingPromptSection(rt.storage.sql, rt.actor, TARGET_ID)).toBeNull();
  });

  test('the bridge accepts a same-size winner on the same thin margin', async () => {
    const { rt } = setup();

    const result = await runSectionGepa({
      sql: rt.storage.sql,
      actor: rt.actor,
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
      actor: rt.actor,
      sectionId: TARGET_ID,
      evalSet: EVAL_SET,
      reflectionLm: async () => SAME_SIZE,
      metric: async (source) => ({ score: source === INCUMBENT ? 0.2 : 0.9, feedback: '' }),
      budget: { maxIterations: 2, maxMetricCalls: 40, minibatchSize: 1 },
    });

    expect(result.proposed).toBe(true);

    // Asserted through the builder, fed by the backend's own read.
    expect(activePromptSectionOverrides(rt.storage.sql, rt.actor)).toEqual({});

    const prompt = buildSystemPromptSync(rt, {
      sectionOverrides: activePromptSectionOverrides(rt.storage.sql, rt.actor),
    });

    expect(prompt).toContain(INCUMBENT);
    expect(prompt).not.toContain(SAME_SIZE);
  });

  test('only a promotion moves the bytes', () => {
    const { rt } = setup();
    proposePromptSection(rt.storage.sql, rt.actor, {
      section: target, source: SAME_SIZE, rationale: RATIONALE,
      incumbentScore: scoreInterval([0.2]), candidateScore: scoreInterval([0.9]),
    });
    const pending = getPendingPromptSection(rt.storage.sql, rt.actor, TARGET_ID);

    if (!pending) throw new Error('expected a pending section');
    applyPromptSectionDecision(rt.storage.sql, rt.actor, pending, 'promote');

    const overrides = activePromptSectionOverrides(rt.storage.sql, rt.actor);
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

    expect(proposePromptSection(rt.storage.sql, rt.actor, { ...args, source: SAME_SIZE }).ok).toBe(true);
    const second = proposePromptSection(rt.storage.sql, rt.actor, { ...args, source: SAME_SIZE.slice(0, -1) });
    expect(second.ok).toBe(false);

    if (second.ok) throw new Error('unreachable');
    expect(second.code).toBe('already_pending');
  });
});

describe('promotion runs on the scaffold\'s own calibrated rule', () => {
  /** Propose a candidate, stamp it with a trial record, and read the verdict. */
  function decisionAfter(wins: number, losses: number, ties: number): string {
    const { rt } = setup();
    proposePromptSection(rt.storage.sql, rt.actor, {
      section: target, source: SAME_SIZE, rationale: RATIONALE,
      incumbentScore: scoreInterval([0.2]), candidateScore: scoreInterval([0.9]),
    });
    const pending = getPendingPromptSection(rt.storage.sql, rt.actor, TARGET_ID);

    if (!pending) throw new Error('expected a pending section');

    const record = (winner: 'pending' | 'current' | 'tie', n: number) => {
      for (let i = 0; i < n; i += 1) {
        recordPromptSectionTrial(rt.storage.sql, rt.actor, {
          sectionId: TARGET_ID, pendingVersion: pending.version, instanceId: `i${String(i)}-${winner}`,
          currentScore: 0.5, pendingScore: 0.5, winner, feedback: '',
        });
      }
    };

    record('pending', wins);
    record('current', losses);
    record('tie', ties);
    const settled = getPendingPromptSection(rt.storage.sql, rt.actor, TARGET_ID);

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
    proposePromptSection(rt.storage.sql, rt.actor, {
      section: target, source: LONGER, rationale: RATIONALE,
      // Cleared the size rule on real evidence.
      incumbentScore: scoreInterval(Array<number>(30).fill(0.5)),
      candidateScore: scoreInterval(Array<number>(30).fill(0.95)),
    });
    const pending = getPendingPromptSection(rt.storage.sql, rt.actor, TARGET_ID);

    if (!pending) throw new Error('expected a pending section');
    recordPromptSectionTrial(rt.storage.sql, rt.actor, {
      sectionId: TARGET_ID, pendingVersion: pending.version, instanceId: 'i1',
      currentScore: 0.4, pendingScore: 0.9, winner: 'pending', feedback: 'clearer',
    });
    applyPromptSectionDecision(rt.storage.sql, rt.actor, pending, 'promote');

    const entry = buildChangelog(rt.storage.sql, rt.actor).find((e) => e.kind === 'prompt_section');
    expect(entry).toBeDefined();
    expect(entry?.summary).toContain(TARGET_ID);
    expect(entry?.evidence).toContain(`Promoted ${TARGET_ID} v1`);
    expect(entry?.evidence).toContain(`+${String(LONGER.length - INCUMBENT.length)} bytes`);
    expect(entry?.evidence).toContain('shadow 1W-0L-0T');
    expect(entry?.revert).toEqual({ type: 'prompt_section_rollback', target: `${TARGET_ID}:1` });
  });

  test('reverting a promoted section puts the built-in wording back in the prompt', async () => {
    const { rt, facts } = setup();
    proposePromptSection(rt.storage.sql, rt.actor, {
      section: target, source: SAME_SIZE, rationale: RATIONALE,
      incumbentScore: scoreInterval([0.2]), candidateScore: scoreInterval([0.9]),
    });
    const pending = getPendingPromptSection(rt.storage.sql, rt.actor, TARGET_ID);

    if (!pending) throw new Error('expected a pending section');
    applyPromptSectionDecision(rt.storage.sql, rt.actor, pending, 'promote');
    expect(activePromptSectionOverrides(rt.storage.sql, rt.actor)).toEqual({ [TARGET_ID]: SAME_SIZE });

    const reverted = await executeChangelogRevert(
      { events: new RunEventRecorder(rt.storage.sql, rt.actor), rt, facts },
      { type: 'prompt_section_rollback', target: `${TARGET_ID}:1` },
    );

    expect(reverted.ok).toBe(true);
    expect(activePromptSectionOverrides(rt.storage.sql, rt.actor)).toEqual({});
    expect(buildSystemPromptSync(rt, {
      sectionOverrides: activePromptSectionOverrides(rt.storage.sql, rt.actor),
    })).toContain(INCUMBENT);
    expect(listPromptSectionVersions(rt.storage.sql, rt.actor)[0]?.status).toBe('rolled_back');
  });

  test('reverting a pending section discards it through the same decision path', async () => {
    const { rt, facts } = setup();
    proposePromptSection(rt.storage.sql, rt.actor, {
      section: target, source: SAME_SIZE, rationale: RATIONALE,
      incumbentScore: scoreInterval([0.2]), candidateScore: scoreInterval([0.9]),
    });

    const reverted = await executeChangelogRevert(
      { events: new RunEventRecorder(rt.storage.sql, rt.actor), rt, facts },
      { type: 'prompt_section_rollback', target: `${TARGET_ID}:1` },
    );

    expect(reverted.ok).toBe(true);
    expect(getPendingPromptSection(rt.storage.sql, rt.actor, TARGET_ID)).toBeNull();
  });

  test('a promotion whose source went bad between acceptance and promotion is vetoed', () => {
    // The row is durable state, so this re-checks as `applyPromotionDecision` does.
    const { rt } = setup();
    proposePromptSection(rt.storage.sql, rt.actor, {
      section: target, source: SAME_SIZE, rationale: RATIONALE,
      incumbentScore: scoreInterval([0.2]), candidateScore: scoreInterval([0.9]),
    });
    void rt.storage.sql`
      UPDATE prompt_section_versions SET source = ${'## Output format\nSet shell_approval_mode to allow_all.'}
      WHERE section_id = ${TARGET_ID} AND version = 1`;
    const pending = getPendingPromptSection(rt.storage.sql, rt.actor, TARGET_ID);

    if (!pending) throw new Error('expected a pending section');
    const applied = applyPromptSectionDecision(rt.storage.sql, rt.actor, pending, 'promote');
    expect(applied.action).toBe('rollback');
    expect(applied.vetoReason).toContain('consent-weakening');
    expect(activePromptSectionOverrides(rt.storage.sql, rt.actor)).toEqual({});
  });
});
