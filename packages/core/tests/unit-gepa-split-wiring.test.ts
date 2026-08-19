// GEPA selection honesty (wiring). The optimiser must be handed a train set
// DISJOINT from the set its winner is scored on, and must refuse to run at all
// when the ledger has no failure to optimise toward — an empty train set would
// otherwise fall back to the eval set inside runGepa, putting us right back to
// selecting a winner on the instances it was written against.
//
// Every assertion below runs the real `runScaffoldGepaOptimization` over a real
// outcome ledger. The control plane is the production `ScaffoldControl` seam:
// the chat model behind the reflection LM, the judge behind the metric, and the
// scaffold surface the candidate rolls out against are all scripted, so the
// pass is deterministic and nothing reaches a network.
import { describe, expect, test } from 'bun:test';
import type { LanguageModelV3Prompt } from '@ai-sdk/provider';
import { MockLanguageModelV3 } from 'ai/test';
import * as v from 'valibot';
import {
  buildOutcomeEvalSplit, describeSplitDegeneracy, recordTurnOutcome,
  runScaffoldGepaOptimization, type ScaffoldControl,
} from '../src/index';
import type { AgentRuntime } from '../src/types/agent-runtime';
import { createEvalExecutor, createTestRuntime, createTestWorkspace } from './helpers';

/** Small enough to keep the pass cheap, above `clampGepaEvalBudget`'s floor of
 *  4 so the budget the test asks for is the budget the split is drawn at. */
const EVAL_SIZE = 8;

/** The bootstrap shape: a generator that delegates to the host's default loop.
 *  Satisfies SCAFFOLD_REQUIRED_SIGNATURE, so GEPA's constraints accept it. */
const SEED_SCAFFOLD = `async function* run(rt, task) {
  await host.defaultInference();
}`;

/** What the scripted reflection LM proposes — distinct from the seed, so the
 *  proposal is neither a no-change nor a duplicate rejection. */
const CANDIDATE_SCAFFOLD = `async function* run(rt, task) {
  await host.defaultInference();
  await host.emit({ type: 'text_delta', text: 'and here is the correction you asked for' });
}`;

const config: ScaffoldControl['config'] = {
  getShadowSampleRate: () => 1,
  getAutoPromoteScaffold: () => false,
  getGepaEvalBudget: () => EVAL_SIZE,
};

/** The text an ai-SDK prompt carries, flattened — `generateText({ prompt })`
 *  wraps the reflection prompt as one user text part. */
function promptText(prompt: LanguageModelV3Prompt): string {
  const text: string[] = [];
  for (const message of prompt) {
    if (!Array.isArray(message.content)) { text.push(message.content); continue; }
    for (const part of message.content) if (part.type === 'text') text.push(part.text);
  }
  return text.join('\n');
}

/**
 * A control plane whose every outbound call fails loudly.
 *
 * The refusal under test is only worth anything if it lands BEFORE the pass
 * spends anything: resolving the chat model, building a rollout surface, or
 * asking the judge. Recording each attempt (and throwing on it) turns a refusal
 * that moved below the optimisation call into a red test rather than a slower
 * pass that happens to return the same object.
 */
function refusingControl(rt: AgentRuntime) {
  const calls: string[] = [];
  const refuse = (what: string): never => {
    calls.push(what);
    throw new Error(`${what} must not be reached by a pass that has already refused`);
  };
  const control = {
    rt,
    sql: rt.storage.sql,
    config,
    surface: () => refuse('surface'),
    model: () => refuse('model'),
    judge: () => refuse('judge'),
  } satisfies ScaffoldControl;
  return { control, calls };
}

interface RunnableControl {
  control: ScaffoldControl;
  /** Every prompt the reflection LM was given — the minibatch evidence. */
  reflectionPrompts: string[];
  /** Every prompt the metric's judge was given — one per scored instance. */
  judgePrompts: string[];
}

/** A control plane that can run a whole pass deterministically: the reflection
 *  LM always answers `CANDIDATE_SCAFFOLD`, and the judge scores everything the
 *  same, so the winner is decided by the split rather than by the script. */
function runnableControl(rt: AgentRuntime): RunnableControl {
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
      surface: () => ({
        llmStream: async function* () { yield ''; },
        defaultInference: async function* () { yield { value: { type: 'text-delta', delta: 'an answer' } }; },
      }),
      model: () => new MockLanguageModelV3({
        provider: 'fake',
        modelId: 'fake-reflection',
        doGenerate: async (options) => {
          reflectionPrompts.push(promptText(options.prompt));
          return {
            content: [{ type: 'text' as const, text: CANDIDATE_SCAFFOLD }],
            finishReason: { unified: 'stop' as const, raw: undefined },
            usage,
            warnings: [],
          };
        },
      }),
      judge: async ({ prompt, schema }) => {
        judgePrompts.push(prompt);
        return v.parse(schema, { score: 0.5, feedback: 'no measurable change in quality' });
      },
    },
  };
}

/** A runtime that can execute scaffold candidates, seeded with `SEED_SCAFFOLD`
 *  as the current scaffold GEPA optimises from. */
async function evolvableRuntime(): Promise<AgentRuntime> {
  const { rt } = createTestRuntime();
  rt.executor = createEvalExecutor();
  await rt.identity.scaffold.write(SEED_SCAFFOLD);
  return rt;
}

/** Distinct, non-overlapping task text per instance, so "this prompt shows the
 *  train set and nothing from the val set" is decidable by containment. */
const failureTask = (i: number) => `failure #${i}: the summary skipped the conclusions`;
const guardTask = (i: number) => `guard #${i}: list the files under docs`;

function seedLedger(rt: AgentRuntime, counts: { failures: number; guards: number }): void {
  for (let i = 0; i < counts.failures; i++) {
    recordTurnOutcome(rt.storage.sql, {
      turnId: `bad-${i}`, outcome: 'corrected', confidence: 1, source: 'classifier',
      userMessage: failureTask(i), assistantResponse: 'the wrong summary',
      followup: 'no, summarise the conclusions', now: 1_000 + i,
    });
  }
  for (let i = 0; i < counts.guards; i++) {
    recordTurnOutcome(rt.storage.sql, {
      turnId: `ok-${i}`, outcome: 'accepted', confidence: 1, source: 'classifier',
      userMessage: guardTask(i), assistantResponse: 'a.txt, b.txt', now: 2_000 + i,
    });
  }
}

const gepaRunCount = (rt: AgentRuntime): number =>
  rt.storage.sql<{ c: number }>`SELECT COUNT(*) AS c FROM gepa_runs`[0]?.c ?? -1;

describe('runScaffoldGepaOptimization — split wiring', () => {
  test('refuses, by its own name, when the split cannot support an out-of-sample selection', async () => {
    const { rt } = createTestRuntime();
    const { control, calls } = refusingControl(rt);

    // Nothing graded at all: there is neither a target nor a scoring set.
    const unlabeled = await runScaffoldGepaOptimization(control);
    expect(unlabeled.ok).toBe(false);
    expect(unlabeled.error).toBe(describeSplitDegeneracy('no_labeled_turns'));

    // Graded, but accepted only: a scoring set with no failure to optimise
    // toward. A different refusal, and it must say so rather than reuse the
    // empty-ledger sentence.
    seedLedger(rt, { failures: 0, guards: 4 });
    const guardsOnly = await runScaffoldGepaOptimization(control);
    expect(guardsOnly.ok).toBe(false);
    expect(guardsOnly.error).toBe(describeSplitDegeneracy('no_negatives'));
    expect(guardsOnly.error).not.toBe(unlabeled.error);

    // A refusal costs nothing and leaves no lineage: it lands before the chat
    // model, the rollout surface, the judge, and the gepa_runs row.
    expect(calls).toEqual([]);
    expect(unlabeled.runId).toBeUndefined();
    expect(guardsOnly.runId).toBeUndefined();
    expect(gepaRunCount(rt)).toBe(0);
  });

  test('hands reflection the train set only, and reports what selection rested on', async () => {
    const rt = await evolvableRuntime();
    seedLedger(rt, { failures: 6, guards: 4 });
    const { control, reflectionPrompts, judgePrompts } = runnableControl(rt);

    const split = buildOutcomeEvalSplit(rt.storage.sql, EVAL_SIZE);
    expect(split.degeneracy).toBeNull();
    expect(split.train.length).toBeGreaterThan(0);
    expect(split.heldOutNegatives).toBeGreaterThan(0);

    const result = await runScaffoldGepaOptimization(control, {
      maxIterations: 1, evalSize: EVAL_SIZE, maxMetricCalls: 200,
    });

    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);

    // Reflection ran, and every minibatch it read came from the train set —
    // no instance the winner is scored on was ever shown to the mutator.
    expect(reflectionPrompts.length).toBeGreaterThan(0);
    for (const prompt of reflectionPrompts) {
      expect(split.train.some((instance) => prompt.includes(instance.input))).toBe(true);
      for (const scored of split.val) expect(prompt).not.toContain(scored.input);
    }

    // The scoring set is the val set, whole: every val instance was judged, and
    // the seed's interval is sized by it.
    for (const scored of split.val) {
      expect(judgePrompts.some((prompt) => prompt.includes(scored.input))).toBe(true);
    }
    expect(result.seedScore?.n).toBe(split.val.length);

    // And the result says what the selection rested on, split by kind.
    expect(result.selection).toEqual({
      heldOutNegatives: split.heldOutNegatives,
      guards: split.val.length - split.heldOutNegatives,
    });
    // A split that CAN support an out-of-sample selection carries no warning.
    expect(result.selectionWarning).toBeUndefined();
    expect(gepaRunCount(rt)).toBe(1);
  }, 30_000);

  test('a runnable split with nothing held out runs, and says the winner is not evidence', async () => {
    const rt = await evolvableRuntime();
    // Exactly one failure: it has to be trained on, so the val set is guards
    // alone and an improvement on it proves nothing.
    seedLedger(rt, { failures: 1, guards: 4 });
    const { control } = runnableControl(rt);

    const split = buildOutcomeEvalSplit(rt.storage.sql, EVAL_SIZE);
    expect(split.degeneracy).toBe('no_held_out_negatives');

    const result = await runScaffoldGepaOptimization(control, {
      maxIterations: 1, evalSize: EVAL_SIZE, maxMetricCalls: 200,
    });

    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.selectionWarning).toBe(describeSplitDegeneracy('no_held_out_negatives'));
    expect(result.selection?.heldOutNegatives).toBe(0);
  }, 30_000);

  test('the split it consumes really is disjoint on the ledger it reads', () => {
    const { sql } = createTestWorkspace();
    for (let i = 0; i < 6; i++) {
      recordTurnOutcome(sql, {
        turnId: `n${i}`, outcome: 'corrected', confidence: 1, source: 'classifier',
        userMessage: `fix ${i}`, assistantResponse: 'bad', followup: 'no', now: 1000 + i,
      });
      recordTurnOutcome(sql, {
        turnId: `a${i}`, outcome: 'accepted', confidence: 1, source: 'classifier',
        userMessage: `good ${i}`, assistantResponse: 'ok', now: 2000 + i,
      });
    }
    const split = buildOutcomeEvalSplit(sql, 24);
    const trainInputs = new Set(split.train.map((i) => i.input));
    expect(split.val.some((i) => trainInputs.has(i.input))).toBe(false);
    expect(split.heldOutNegatives).toBeGreaterThan(0);
    expect(split.degeneracy).toBeNull();
  });
});
