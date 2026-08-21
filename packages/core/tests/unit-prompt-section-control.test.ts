/**
 * The prompt-section loop, end to end over a real turn-outcome ledger.
 *
 * `unit-prompt-section-evolution.test.ts` proves the gates in isolation. This
 * one proves the wire: that the drivers read the SAME ledger the scaffold
 * optimiser reads, that reflection is shown the train half only, that a winner
 * reaches the store as PENDING, that trials on the held-out half decide it, and
 * that the live prompt moves on the promotion and not one moment earlier.
 *
 * Every outbound call is scripted, so the pass is deterministic and nothing
 * reaches a network. The control plane is the production `ScaffoldControl`
 * seam, exactly as `unit-gepa-split-wiring.test.ts` uses it.
 */

import { describe, expect, test } from 'bun:test';
import type { LanguageModelV3Prompt } from '@ai-sdk/provider';
import { MockLanguageModelV3 } from 'ai/test';
import * as v from 'valibot';
import {
  activePromptSectionOverrides, buildSystemPromptSync,
  findPromptSectionTarget, recordTurnOutcome, buildOutcomeEvalSplit,
  EvolutionEngine,
  runPromptSectionGepaOptimization, runPromptSectionTrials,
  type ScaffoldControl,
} from '../src/index';
import { getPendingPromptSection, initPromptSectionTables } from '../src/prompting/section-store';
import { initAllTables } from '../src/identity/schema';
import { initTurnOutcomeTables } from '../src/evolution/outcomes';
import { initGepaTables } from '../src/evolution/gepa/persistence';
import type { AgentRuntime } from '../src/types/agent-runtime';
import { createTestRuntime } from './helpers';

const EVAL_SIZE = 8;
const TARGET_ID = 'state/output-format';

const target = findPromptSectionTarget(TARGET_ID);
if (!target) throw new Error(`${TARGET_ID} is not registered`);
const INCUMBENT = target.source;
/** Same byte count as the incumbent, so the size rule is not what this file is
 *  about — it has its own suite. */
const CANDIDATE = `${INCUMBENT.slice(0, -6)}ASKED.`;

const config: ScaffoldControl['config'] = {
  getShadowSampleRate: () => 1,
  getAutoPromoteScaffold: () => false,
  getGepaEvalBudget: () => EVAL_SIZE,
};

function promptText(prompt: LanguageModelV3Prompt): string {
  const text: string[] = [];
  for (const message of prompt) {
    if (!Array.isArray(message.content)) { text.push(message.content); continue; }
    for (const part of message.content) if (part.type === 'text') text.push(part.text);
  }
  return text.join('\n');
}

interface ScriptedControl {
  control: ScaffoldControl;
  reflectionPrompts: string[];
  judgePrompts: string[];
}

/**
 * A control plane that answers deterministically and REFUSES to roll out.
 *
 * `surface` throws on purpose. A section metric that ever ran a scaffold would
 * be paying a whole turn per instance to answer a counterfactual about prose,
 * and this is the assertion that says so: if the metric grows a rollout, every
 * test in this file goes red rather than slow.
 */
function scriptedControl(rt: AgentRuntime, judgeScore: (candidate: string) => number): ScriptedControl {
  const reflectionPrompts: string[] = [];
  const judgePrompts: string[] = [];
  const usage = {
    inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 7, text: 7, reasoning: undefined },
  };
  return {
    reflectionPrompts,
    judgePrompts,
    control: {
      rt,
      sql: rt.storage.sql,
      config,
      surface: () => { throw new Error('a prompt-section pass must not roll out a scaffold'); },
      model: () => new MockLanguageModelV3({
        provider: 'fake',
        modelId: 'fake-reflection',
        doGenerate: async (options) => {
          reflectionPrompts.push(promptText(options.prompt));
          return {
            content: [{ type: 'text' as const, text: CANDIDATE }],
            finishReason: { unified: 'stop' as const, raw: undefined },
            usage,
            warnings: [],
          };
        },
      }),
      judge: async ({ prompt, schema }) => {
        judgePrompts.push(prompt);
        // The candidate wording appears verbatim in the scoring prompt, which
        // is how the judge is told what it is grading.
        return v.parse(schema, {
          score: judgeScore(prompt.includes(CANDIDATE) ? CANDIDATE : INCUMBENT),
          feedback: 'the wording decides it',
        });
      },
    },
  };
}

function evolvableRuntime(): AgentRuntime {
  const { rt } = createTestRuntime();
  initAllTables(rt.storage.execRaw, rt.storage.sql);
  initTurnOutcomeTables(rt.storage.execRaw, rt.storage.sql);
  initGepaTables(rt.storage.execRaw);
  initPromptSectionTables(rt.storage.execRaw);
  return rt;
}

const failureTask = (i: number) => `failure #${i}: the reply buried the answer in JSON`;
const guardTask = (i: number) => `guard #${i}: list the files under docs`;

function seedLedger(rt: AgentRuntime, counts: { failures: number; guards: number }): void {
  for (let i = 0; i < counts.failures; i++) {
    recordTurnOutcome(rt.storage.sql, {
      turnId: `bad-${String(i)}`, outcome: 'corrected', confidence: 1, source: 'classifier',
      userMessage: failureTask(i), assistantResponse: '{"files":["a.txt"]}',
      followup: 'just tell me in prose', now: 1_000 + i,
    });
  }
  for (let i = 0; i < counts.guards; i++) {
    recordTurnOutcome(rt.storage.sql, {
      turnId: `ok-${String(i)}`, outcome: 'accepted', confidence: 1, source: 'classifier',
      userMessage: guardTask(i), assistantResponse: 'a.txt and b.txt', now: 2_000 + i,
    });
  }
}

/**
 * The turns `turn_outcomes` structurally cannot grade, graded.
 *
 * The ledger classifies turn N from user message N+1, so a headless run, a
 * one-shot invocation, and the case the owner asked about — the agent grinding
 * serially through work a search capability was sitting right there for — all
 * leave it silent. Each note goes through the REAL writer and needs a real
 * `messages` pair, because the row stores a turn id and never a copy of the
 * text: a fixture that INSERTed the row by hand would certify a shape the
 * writer does not produce.
 */
function seedAdvisorNotes(rt: AgentRuntime, count: number): void {
  const engine = new EvolutionEngine(rt);
  for (let i = 0; i < count; i++) {
    const turnId = `adv-${String(i)}`;
    void rt.storage.sql`INSERT INTO messages (id, parent_id, role, content, created_at)
      VALUES (${`ask-${String(i)}`}, ${null}, ${'user'}, ${failureTask(i)}, ${3_000 + i})`;
    void rt.storage.sql`INSERT INTO messages (id, parent_id, role, content, created_at)
      VALUES (${turnId}, ${`ask-${String(i)}`}, ${'assistant'}, ${'{"files":["a.txt"]}'}, ${3_100 + i})`;
    engine.recordAdvisorNote({
      note: `you answered this alone; agents was reachable and the work had ${String(i + 2)} angles`,
      severity: 'concern',
      class: 'missed-capability',
    }, turnId);
  }
}

describe('runPromptSectionGepaOptimization — scored on the turn-outcome ledger', () => {
  test('refuses an unregistered section before it spends anything', async () => {
    const rt = evolvableRuntime();
    seedLedger(rt, { failures: 6, guards: 4 });
    const { control, judgePrompts } = scriptedControl(rt, () => 0.9);
    const result = await runPromptSectionGepaOptimization(control, { sectionId: 'state/nope' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not a registered prompt section');
    expect(result.runId).toBeUndefined();
    expect(judgePrompts).toEqual([]);
  });

  test('refuses, by the ledger\'s own name, when there is no failure to optimise toward', async () => {
    const rt = evolvableRuntime();
    const { control } = scriptedControl(rt, () => 0.9);
    const unlabeled = await runPromptSectionGepaOptimization(control, { sectionId: TARGET_ID });
    expect(unlabeled.ok).toBe(false);
    expect(unlabeled.error).toContain('no outcome-labeled turns yet');

    seedLedger(rt, { failures: 0, guards: 4 });
    const guardsOnly = await runPromptSectionGepaOptimization(control, { sectionId: TARGET_ID });
    expect(guardsOnly.ok).toBe(false);
    expect(guardsOnly.error).not.toBe(unlabeled.error);
  });

  /**
   * The closure. Before this, a workspace whose only negative signal was an
   * advisor note got the refusal above — the note was written, read by nothing,
   * and the loop the owner asked for ended in a table.
   */
  test('an advisor note is a failure to optimise toward, where the ledger has none', async () => {
    const rt = evolvableRuntime();
    seedAdvisorNotes(rt, 3);
    const { control, judgePrompts, reflectionPrompts } = scriptedControl(
      rt, (candidate) => (candidate === CANDIDATE ? 0.9 : 0.2),
    );

    const result = await runPromptSectionGepaOptimization(control, {
      sectionId: TARGET_ID, maxIterations: 2, maxMetricCalls: 60,
    });

    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.proposed).toBe(true);
    // Selection rested on a note the candidate was NOT written against: the
    // newest of the three is held out, exactly as a ledger failure would be.
    expect(result.selectionWarning).toBeUndefined();

    // The judge is told who complained, and it is not the user. A prompt that
    // said "the user had to correct it" about a turn no user ever graded would
    // be teaching the judge a fact the record does not hold.
    const negativeScoring = judgePrompts.filter((prompt) => prompt.includes("Reviewer's note"));
    expect(negativeScoring.length).toBeGreaterThan(0);
    for (const prompt of negativeScoring) {
      expect(prompt).toContain('no user ever graded it');
      expect(prompt).not.toContain('the user had to correct it');
      expect(prompt).toContain('agents was reachable');
    }
    // The class reaches the scoring evidence, which is the whole reason the
    // writer stamps it.
    expect(reflectionPrompts.join('\n')).toContain('a capability it had and did not use');
  }, 30_000);

  test('a note about a turn the ledger already graded is not counted twice', async () => {
    const rt = evolvableRuntime();
    seedAdvisorNotes(rt, 3);
    // The user came back and corrected `adv-1` after all. The ledger is the
    // verdict where it spoke, so that turn must appear once — as a ledger row.
    recordTurnOutcome(rt.storage.sql, {
      turnId: 'adv-1', outcome: 'corrected', confidence: 1, source: 'classifier',
      userMessage: failureTask(1), assistantResponse: '{"files":["a.txt"]}',
      followup: 'just tell me in prose', now: 4_000,
    });

    const split = buildOutcomeEvalSplit(rt.storage.sql, EVAL_SIZE);
    const negatives = [...split.train, ...split.val.slice(0, split.heldOutNegatives)];
    expect(negatives).toHaveLength(3);
    expect(new Set(negatives.map((i) => i.input)).size).toBe(3);
    // …and it is the ledger's own complaint that is scored, not the reviewer's.
    const graded = negatives.find((i) => i.input === failureTask(1));
    expect(graded?.expected).toMatchObject({ critic: 'user', followup: 'just tell me in prose' });
  });

  test('reflection sees the train half and the winner lands PENDING, not live', async () => {
    const rt = evolvableRuntime();
    seedLedger(rt, { failures: 6, guards: 4 });
    const { control, reflectionPrompts, judgePrompts } = scriptedControl(
      rt, (candidate) => (candidate === CANDIDATE ? 0.9 : 0.2),
    );

    const result = await runPromptSectionGepaOptimization(control, {
      sectionId: TARGET_ID, maxIterations: 2, maxMetricCalls: 60,
    });

    expect(result.ok).toBe(true);
    expect(result.proposed).toBe(true);
    expect(result.pendingVersion).toBe(1);
    expect(result.byteDelta).toBe(0);
    expect(result.sectionId).toBe(TARGET_ID);

    // Scored on the ledger, by a judge reading the prose — not by a rollout.
    expect(judgePrompts.length).toBeGreaterThan(0);
    for (const prompt of judgePrompts) expect(prompt).toContain(`Section: ${TARGET_ID}`);
    // Selection rested on held-out instances: the newest failures plus the
    // accepted guards, never a task reflection was shown.
    expect(reflectionPrompts.length).toBeGreaterThan(0);
    const shownToReflection = reflectionPrompts.join('\n');
    expect(shownToReflection).toContain('failure #');
    expect(shownToReflection).not.toContain('guard #');

    // The run is in the lineage under its own target, next to scaffold runs.
    const run = rt.storage.sql<{ target: string; target_ref: string | null }>`
      SELECT target, target_ref FROM gepa_runs`[0];
    expect(run).toEqual({ target: 'prompt_section', target_ref: TARGET_ID });

    // And the live prompt has not moved.
    expect(activePromptSectionOverrides(rt.storage.sql)).toEqual({});
    expect(buildSystemPromptSync(rt, {
      sectionOverrides: activePromptSectionOverrides(rt.storage.sql),
    })).toContain(INCUMBENT);
  }, 30_000);
});

describe('runPromptSectionTrials — held-out trials decide it', () => {
  async function propose(rt: AgentRuntime, control: ScaffoldControl): Promise<void> {
    const result = await runPromptSectionGepaOptimization(control, {
      sectionId: TARGET_ID, maxIterations: 2, maxMetricCalls: 60,
    });
    expect(result.proposed).toBe(true);
  }

  test('nothing pending is not an error, and runs no judge', async () => {
    const rt = evolvableRuntime();
    const { control, judgePrompts } = scriptedControl(rt, () => 0.9);
    const result = await runPromptSectionTrials(control, TARGET_ID);
    expect(result).toEqual({ sectionId: TARGET_ID, pending: false, trialsRun: 0 });
    expect(judgePrompts).toEqual([]);
  });

  test('a winning candidate accumulates trials and is promoted into the live prompt', async () => {
    const rt = evolvableRuntime();
    seedLedger(rt, { failures: 6, guards: 4 });
    const { control } = scriptedControl(rt, (candidate) => (candidate === CANDIDATE ? 0.9 : 0.2));
    await propose(rt, control);

    // Each pass scores both sources on the same instances, so the comparison is
    // paired. The ladder needs 5 trials and 5 decisive ones before it can
    // promote, so one pass of three cannot — and must not — decide.
    const first = await runPromptSectionTrials(control, TARGET_ID, { trials: 3 });
    expect(first.trialsRun).toBe(3);
    expect(first.decision).toBe('continue');
    expect(activePromptSectionOverrides(rt.storage.sql)).toEqual({});

    const second = await runPromptSectionTrials(control, TARGET_ID, { trials: 3 });
    expect(second.decision).toBe('promote');
    expect(second.action).toBe('promote');

    const overrides = activePromptSectionOverrides(rt.storage.sql);
    expect(overrides).toEqual({ [TARGET_ID]: CANDIDATE });
    const prompt = buildSystemPromptSync(rt, { sectionOverrides: overrides });
    expect(prompt).toContain(CANDIDATE);
    expect(prompt).not.toContain(INCUMBENT);
    expect(getPendingPromptSection(rt.storage.sql, TARGET_ID)).toBeNull();
  }, 30_000);

  test('a candidate that loses on held-out turns is rolled back, and the prompt never moved', async () => {
    const rt = evolvableRuntime();
    seedLedger(rt, { failures: 6, guards: 4 });
    // Wins during optimisation, loses under trial. The whole reason the winner
    // is not promoted on its own GEPA score: that score is in-sample for the
    // wording, and the trials are the out-of-sample test of it.
    let optimising = true;
    const { control } = scriptedControl(rt, (candidate) => {
      const good = candidate === CANDIDATE ? 0.9 : 0.2;
      const bad = candidate === CANDIDATE ? 0.1 : 0.8;
      return optimising ? good : bad;
    });
    await propose(rt, control);
    optimising = false;

    // The regression veto is checked first and hard: three decisive losses is
    // past `maxRegressions`, so one pass settles it and no further evidence is
    // gathered on a candidate already known to be worse.
    const verdict = await runPromptSectionTrials(control, TARGET_ID, { trials: 3 });
    expect(verdict.decision).toBe('rollback');
    expect(verdict.action).toBe('rollback');
    expect(await runPromptSectionTrials(control, TARGET_ID, { trials: 3 }))
      .toEqual({ sectionId: TARGET_ID, pending: false, trialsRun: 0 });
    expect(activePromptSectionOverrides(rt.storage.sql)).toEqual({});
    expect(buildSystemPromptSync(rt, {
      sectionOverrides: activePromptSectionOverrides(rt.storage.sql),
    })).toContain(INCUMBENT);
  }, 30_000);
});
