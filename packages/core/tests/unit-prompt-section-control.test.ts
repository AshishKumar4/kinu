/**
 * The prompt-section loop end to end through `advancePromptSectionLane` over a real
 * outcome ledger: reflection sees only the train half, a winner lands pending, held-out
 * trials decide it, and the live prompt moves only on promotion.
 */

import { describe, expect, test } from 'bun:test';
import type { LanguageModelV3Prompt } from '@ai-sdk/provider';
import { MockLanguageModelV3 } from 'ai/test';
import * as v from 'valibot';
import {
  activePromptSectionOverrides, buildSystemPromptSync,
  findPromptSectionTarget, recordTurnOutcome, buildOutcomeEvalSplit,
  EvolutionEngine,
  advancePromptSectionLane, PROMPT_SECTION_TARGETS,
  startGepaRun,
  type ScaffoldControl,
} from '../src/index';
import { getPendingPromptSection, initPromptSectionTables } from '../src/prompting/section-store';
import { initAllTables } from '../src/state/workspace-schema';
import { initTurnOutcomeTables } from '../src/evolution/outcomes';
import { initGepaTables } from '../src/evolution/gepa/persistence';
import type { AgentRuntime } from '../src/types/agent-runtime';
import { createTestRuntime, storesFor } from './helpers';
import { CHAT_SESSION_ID } from '../src/session/transcript-schema';
import { RunEventRecorder } from '../src/events/recorder';
import { unobservedSpend } from '@kinu.run/test-utils';

const EVAL_SIZE = 8;

const TARGET_ID = 'state/output-format';

const target = findPromptSectionTarget(TARGET_ID);

if (!target) throw new Error(`${TARGET_ID} is not registered`);

const INCUMBENT = target.source;

/** Same byte count as the incumbent, so the size rule is not under test here. */
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

/** `surface` throws: a section metric must never run a scaffold. */
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
      reportModelCall: unobservedSpend,
      events: new RunEventRecorder(rt.storage.sql, rt.actor),
      rt,
      sql: rt.storage.sql,
      history: storesFor(rt).history,
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

        // The judge sees the candidate wording verbatim in the scoring prompt.
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
  initTurnOutcomeTables(rt.storage.execRaw);
  initGepaTables(rt.storage.execRaw);
  initPromptSectionTables(rt.storage.execRaw);

  return rt;
}

const failureTask = (i: number) => `failure #${i}: the reply buried the answer in JSON`;

const guardTask = (i: number) => `guard #${i}: list the files under docs`;

function seedLedger(rt: AgentRuntime, counts: { failures: number; guards: number }): void {
  for (let i = 0; i < counts.failures; i++) {
    recordTurnOutcome(rt.storage.sql, rt.actor, {
      turnId: `bad-${String(i)}`, outcome: 'corrected', confidence: 1, source: 'classifier',
      userMessage: failureTask(i), assistantResponse: '{"files":["a.txt"]}',
      followup: 'just tell me in prose', now: 1_000 + i,
    });
  }

  for (let i = 0; i < counts.guards; i++) {
    recordTurnOutcome(rt.storage.sql, rt.actor, {
      turnId: `ok-${String(i)}`, outcome: 'accepted', confidence: 1, source: 'classifier',
      userMessage: guardTask(i), assistantResponse: 'a.txt and b.txt', now: 2_000 + i,
    });
  }
}

/**
 * Advisor notes for turns the ledger cannot grade, written through the real writer
 * over a real conversation pair, since the row stores a turn id and not the text.
 */
async function seedAdvisorNotes(rt: AgentRuntime, count: number): Promise<void> {
  const history = storesFor(rt).history;
  const engine = new EvolutionEngine(rt, history, { reportModelCall: unobservedSpend });

  for (let i = 0; i < count; i++) {
    const turnId = `adv-${String(i)}`;
    await history.record(CHAT_SESSION_ID, { id: `ask-${String(i)}`, parentId: null, origin: 'input',
      message: { role: 'user', content: failureTask(i) } });
    await history.record(CHAT_SESSION_ID, { id: turnId, parentId: `ask-${String(i)}`, origin: 'output',
      message: { role: 'assistant', content: '{"files":["a.txt"]}' } });
    engine.recordAdvisorNote({
      note: `you answered this alone; agents was reachable and the work had ${String(i + 2)} angles`,
      severity: 'concern',
      class: 'missed-capability',
    }, turnId);
  }
}

/** Enters through the orchestrator's own entry point. */
async function lanePass(control: ScaffoldControl) {
  const step = await advancePromptSectionLane(control);

  if (step.step !== 'pass') throw new Error(`the lane took ${String(step.step)}, not a pass`);

  return { ...step.pass, sectionId: step.sectionId };
}

/** The trials a pending candidate is owed. */
async function laneTrials(control: ScaffoldControl) {
  const step = await advancePromptSectionLane(control);

  if (step.step !== 'trials') throw new Error(`the lane took ${String(step.step)}, not trials`);

  return { ...step.trials, sectionId: step.sectionId };
}

/** Every section before `uptoId` has had its pass, so the rotation selects `uptoId` next. */
function seedRotationPast(rt: AgentRuntime, uptoId: string): void {
  for (const section of PROMPT_SECTION_TARGETS) {
    if (section.id === uptoId) break;
    startGepaRun(rt.storage.sql, rt.actor, { target: 'prompt_section', targetRef: section.id });
  }
}

describe('the lane\'s pass — scored on the turn-outcome ledger', () => {
  // The refusal fires before section-specific work, so any rotation target serves.
  test('refuses, by the ledger\'s own name, when nothing was ever labeled', async () => {
    const rt = evolvableRuntime();
    const { control } = scriptedControl(rt, () => 0.9);
    const unlabeled = await lanePass(control);
    expect(unlabeled.ok).toBe(false);
    expect(unlabeled.error).toContain('no outcome-labeled turns yet');
  });

  test('refuses, by a different name, when the ledger holds no failure to optimise toward', async () => {
    const rt = evolvableRuntime();
    seedLedger(rt, { failures: 0, guards: 4 });
    const { control } = scriptedControl(rt, () => 0.9);
    const guardsOnly = await lanePass(control);
    expect(guardsOnly.ok).toBe(false);
    expect(guardsOnly.error).toContain('no corrected/frustrated turns yet');
    expect(guardsOnly.error).not.toContain('no outcome-labeled turns yet');
  });

  /** Advisor notes are negative signal when the ledger has none. */
  test('an advisor note is a failure to optimise toward, where the ledger has none', async () => {
    const rt = evolvableRuntime();
    seedRotationPast(rt, TARGET_ID);
    await seedAdvisorNotes(rt, 3);

    const { control, judgePrompts, reflectionPrompts } = scriptedControl(
      rt, (candidate) => (candidate === CANDIDATE ? 0.9 : 0.2),
    );

    const result = await lanePass(control);

    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.proposed).toBe(true);
    // The newest note is held out, as a ledger failure would be.
    expect(result.selectionWarning).toBeUndefined();

    // The judge is told the complaint came from a reviewer, not the user.
    const negativeScoring = judgePrompts.filter((prompt) => prompt.includes("Reviewer's note"));
    expect(negativeScoring.length).toBeGreaterThan(0);

    for (const prompt of negativeScoring) {
      expect(prompt).toContain('no user ever graded it');
      expect(prompt).not.toContain('the user had to correct it');
      expect(prompt).toContain('agents was reachable');
    }

    // The class reaches the scoring evidence.
    expect(reflectionPrompts.join('\n')).toContain('a capability it had and did not use');
  });

  test('a note about a turn the ledger already graded is not counted twice', async () => {
    const rt = evolvableRuntime();
    await seedAdvisorNotes(rt, 3);
    // Where the ledger spoke it is the verdict, so the turn appears once, as a ledger row.
    recordTurnOutcome(rt.storage.sql, rt.actor, {
      turnId: 'adv-1', outcome: 'corrected', confidence: 1, source: 'classifier',
      userMessage: failureTask(1), assistantResponse: '{"files":["a.txt"]}',
      followup: 'just tell me in prose', now: 4_000,
    });

    const split = await buildOutcomeEvalSplit(rt.storage.sql, rt.actor, storesFor(rt).history.transcript(CHAT_SESSION_ID), EVAL_SIZE);
    const negatives = [...split.train, ...split.val.slice(0, split.heldOutNegatives)];
    expect(negatives).toHaveLength(3);
    expect(new Set(negatives.map((i) => i.input)).size).toBe(3);
    // The ledger's complaint is scored, not the reviewer's.
    const graded = negatives.find((i) => i.input === failureTask(1));
    expect(graded?.expected).toMatchObject({ critic: 'user', followup: 'just tell me in prose' });
  });

  test('reflection sees the train half and the winner lands PENDING, not live', async () => {
    const rt = evolvableRuntime();
    seedRotationPast(rt, TARGET_ID);
    seedLedger(rt, { failures: 6, guards: 4 });

    const { control, reflectionPrompts, judgePrompts } = scriptedControl(
      rt, (candidate) => (candidate === CANDIDATE ? 0.9 : 0.2),
    );

    const result = await lanePass(control);

    expect(result.ok).toBe(true);
    expect(result.proposed).toBe(true);
    expect(result.pendingVersion).toBe(1);
    expect(result.byteDelta).toBe(0);
    expect(result.sectionId).toBe(TARGET_ID);

    // Scored by a judge reading prose, not by a rollout.
    expect(judgePrompts.length).toBeGreaterThan(0);

    for (const prompt of judgePrompts) expect(prompt).toContain(`Section: ${TARGET_ID}`);
    // Selection used held-out instances only.
    expect(reflectionPrompts.length).toBeGreaterThan(0);
    const shownToReflection = reflectionPrompts.join('\n');
    expect(shownToReflection).toContain('failure #');
    expect(shownToReflection).not.toContain('guard #');

    // The run is in the lineage under its own target.
    const run = rt.storage.sql<{ target: string; target_ref: string | null }>`
      SELECT target, target_ref FROM gepa_runs WHERE target_ref = ${TARGET_ID}`[0];

    expect(run).toEqual({ target: 'prompt_section', target_ref: TARGET_ID });

    // The live prompt has not moved.
    expect(activePromptSectionOverrides(rt.storage.sql, rt.actor)).toEqual({});
    expect(buildSystemPromptSync(rt, {
      sectionOverrides: activePromptSectionOverrides(rt.storage.sql, rt.actor),
    })).toContain(INCUMBENT);
  });
});

/**
 * The rotation is derived from `gepa_runs` because an in-memory cursor does not
 * survive eviction. The tie-scored judge keeps every pass proposal-free.
 */
describe('the rotation an eviction cannot reset', () => {
  const firstTwo = PROMPT_SECTION_TARGETS.slice(0, 2).map((section) => section.id);

  test('with nothing passed yet, the registry order decides', async () => {
    const rt = evolvableRuntime();
    const { control } = scriptedControl(rt, () => 0.9);
    const step = await lanePass(control);
    expect(step.sectionId).toBe(firstTwo[0]);
  });

  test('a pass moves the rotation on, and holds no state that could be lost', async () => {
    const rt = evolvableRuntime();
    seedLedger(rt, { failures: 6, guards: 4 });
    startGepaRun(rt.storage.sql, rt.actor, { target: 'prompt_section', targetRef: firstTwo[0] });
    const { control } = scriptedControl(rt, () => 0.5);

    const first = await lanePass(control);
    expect(first.sectionId).toBe(firstTwo[1]);

    // A second caller continues from the ledger row the first pass wrote.
    const second = await lanePass(control);
    expect(second.sectionId).toBe(PROMPT_SECTION_TARGETS[2].id);
  });

  test('every section gets one before any gets a second', async () => {
    const rt = evolvableRuntime();
    seedLedger(rt, { failures: 6, guards: 4 });
    const { control } = scriptedControl(rt, () => 0.5);

    const seen: string[] = [];

    for (let i = 0; i < PROMPT_SECTION_TARGETS.length; i++) {
      const step = await lanePass(control);
      seen.push(step.sectionId);
    }

    expect(seen).toEqual(PROMPT_SECTION_TARGETS.map((section) => section.id));
    // After a full round the rotation wraps within the same nine.
    const roundTwo = await lanePass(control);
    expect(roundTwo.sectionId).toBe(seen[0]);
  });

  test('a scaffold run is not a section pass, and never moves the rotation', async () => {
    const rt = evolvableRuntime();
    startGepaRun(rt.storage.sql, rt.actor, { target: 'scaffold' });
    const { control } = scriptedControl(rt, () => 0.9);
    const step = await lanePass(control);
    expect(step.sectionId).toBe(firstTwo[0]);
  });
});

describe('advancePromptSectionLane — trials before a new proposal', () => {
  test('a candidate under trial is finished before any section is proposed', async () => {
    const rt = evolvableRuntime();
    seedRotationPast(rt, TARGET_ID);
    seedLedger(rt, { failures: 6, guards: 4 });
    const { control } = scriptedControl(rt, (candidate) => (candidate === CANDIDATE ? 0.9 : 0.2));

    const proposed = await lanePass(control);
    expect(proposed.proposed).toBe(true);

    const step = await laneTrials(control);
    expect(step.sectionId).toBe(TARGET_ID);
  });

  test('with nothing pending, the lane runs the rotation\'s own next section', async () => {
    const rt = evolvableRuntime();
    seedLedger(rt, { failures: 6, guards: 4 });
    const { control } = scriptedControl(rt, () => 0.5);
    const expected = PROMPT_SECTION_TARGETS[0].id;

    const step = await lanePass(control);
    expect(step.sectionId).toBe(expected);
    // The pass's own row advances the lane.
    const next = await lanePass(control);
    expect(next.sectionId).not.toBe(expected);
  });
});

describe('the lane\'s trials — held-out trials decide it', () => {
  /** Reached as production reaches it: a lane pass left a candidate pending. */
  async function propose(control: ScaffoldControl): Promise<void> {
    seedRotationPast(control.rt, TARGET_ID);
    const pass = await lanePass(control);
    expect(pass.proposed).toBe(true);
  }

  test('a winning candidate accumulates trials and is promoted into the live prompt', async () => {
    const rt = evolvableRuntime();
    seedLedger(rt, { failures: 6, guards: 4 });
    const { control } = scriptedControl(rt, (candidate) => (candidate === CANDIDATE ? 0.9 : 0.2));
    await propose(control);

    // Paired trials. The ladder needs 5 trials and 5 decisive ones, so one step of three cannot decide.
    const first = await laneTrials(control);
    expect(first.trialsRun).toBe(3);
    expect(first.decision).toBe('continue');
    expect(activePromptSectionOverrides(rt.storage.sql, rt.actor)).toEqual({});

    const second = await laneTrials(control);
    expect(second.decision).toBe('promote');
    expect(second.action).toBe('promote');

    const overrides = activePromptSectionOverrides(rt.storage.sql, rt.actor);
    expect(overrides).toEqual({ [TARGET_ID]: CANDIDATE });
    const prompt = buildSystemPromptSync(rt, { sectionOverrides: overrides });
    expect(prompt).toContain(CANDIDATE);
    expect(prompt).not.toContain(INCUMBENT);
    expect(getPendingPromptSection(rt.storage.sql, rt.actor, TARGET_ID)).toBeNull();
  });

  test('a candidate that loses on held-out turns is rolled back, and the prompt never moved', async () => {
    const rt = evolvableRuntime();
    seedLedger(rt, { failures: 6, guards: 4 });
    // Wins in optimisation, loses under trial: the GEPA score is in-sample.
    let optimising = true;

    const { control } = scriptedControl(rt, (candidate) => {
      const good = candidate === CANDIDATE ? 0.9 : 0.2;
      const bad = candidate === CANDIDATE ? 0.1 : 0.8;

      return optimising ? good : bad;
    });

    await propose(control);
    optimising = false;

    // Three decisive losses exceed `maxRegressions`, so one step settles it.
    const verdict = await laneTrials(control);
    expect(verdict.decision).toBe('rollback');
    expect(verdict.action).toBe('rollback');

    // The candidate is gone and the live prompt never moved.
    expect(getPendingPromptSection(rt.storage.sql, rt.actor, TARGET_ID)).toBeNull();
    expect(activePromptSectionOverrides(rt.storage.sql, rt.actor)).toEqual({});
    expect(buildSystemPromptSync(rt, {
      sectionOverrides: activePromptSectionOverrides(rt.storage.sql, rt.actor),
    })).toContain(INCUMBENT);
  });
});
