/**
 * A run record carries the model the ledger observed and refuses a mismatch.
 *
 * The defect this pins: a workspace's pinned model was accepted and never run
 * on, so every record since account profiles named the pinned model while the
 * turns ran on the account default. `modelId` alone cannot disprove that — it
 * is the claim. `modelObserved` is the check, read off the turn loop's own
 * `step_finish` rows, and a record whose check disagrees with its claim is not
 * evidence.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { JsonObject, RunEvent } from '@kinu.run/core';
import {
  assessAdmissibility, createObservedModelAccumulator, modelClaimRefuted, modelObservedFromEvents,
  publishRunRecord, type EvalObservation,
} from '../src/eval-run';
import { TASK_OUTCOME } from '../src/eval-outcome';
import type { LiveModelSpend } from '../src/live-model';
import { scratchDir } from '../src/scratch';

let nextIndex = 0;

/** One stamped event; the caller passes the discriminated body. */
function event(body: JsonObject): RunEvent {
  nextIndex += 1;

  // SAFETY: each call site passes exactly one variant's own fields beside its
  // `type` discriminator, and this adds the three base fields every variant
  // carries.
  return {
    ...body,
    runId: 'run-test',
    eventIndex: nextIndex,
    timestamp: new Date(1_700_000_000_000 + nextIndex * 1_000).toISOString(),
  } as RunEvent;
}

function steps(...modelIds: Array<string | undefined>): RunEvent[] {
  nextIndex = 0;

  return modelIds.map((modelId, step) => {
    const body: JsonObject = { type: 'step_finish', stepIndex: step, reason: 'stop' };

    if (modelId !== undefined) body['modelId'] = modelId;

    return event(body);
  });
}

/** One scored observation with a task_outcome row — admissible on its own. */
function scored(): EvalObservation {
  return {
    taskId: 'case-a', repetition: 0, outcome: 'scored',
    scores: [{ name: TASK_OUTCOME, asserts: 'solved', eligible: 1, passed: 1, rate: 1, detail: 'solved' }],
    turns: 2, toolCalls: 3, toolNames: ['run'], tokensIn: 10, tokensOut: 5, ms: 7,
  };
}

const SPEND: LiveModelSpend = {
  calls: 2, callsWithoutUsage: 0, usage: { input: 10, output: 5 },
  episodesUnmeasured: 0, episodesWithoutModel: 0,
};

describe('modelObservedFromEvents', () => {
  test('one serving model across the steps is the observed model', () => {
    expect(modelObservedFromEvents(steps('serving-a', 'serving-a'))).toBe('serving-a');
  });

  test('steps with no serving id observe nothing, rather than a guess', () => {
    expect(modelObservedFromEvents(steps(undefined, undefined))).toBeNull();
    expect(modelObservedFromEvents([])).toBeNull();
  });

  test('two serving ids observe nothing, rather than picking one', () => {
    expect(modelObservedFromEvents(steps('serving-a', 'serving-b'))).toBeNull();
  });

  test('auxiliary lanes do not vote: a judge on another model changes nothing', () => {
    const events: RunEvent[] = [
      ...steps('serving-a', 'serving-a'),
      event({ type: 'model_call', source: 'judge', usage: {}, spec: 'other/judge', modelId: 'judge-model' }),
    ];

    expect(modelObservedFromEvents(events)).toBe('serving-a');
  });
});

describe('modelClaimRefuted', () => {
  test('a different serving model refutes the claim', () => {
    expect(modelClaimRefuted('claimed-model', 'serving-model')).toBe(true);
  });

  test('agreement and absence never refute', () => {
    expect(modelClaimRefuted('same-model', 'same-model')).toBe(false);
    expect(modelClaimRefuted('claimed-model', null)).toBe(false);
  });

  test('a respelled spec is agreement, the way the pin check reads it', () => {
    expect(modelClaimRefuted('deepseek-v4-flash-0731', '@cf/deepseek-ai/deepseek-v4-flash-0731')).toBe(false);
  });
});

describe('createObservedModelAccumulator', () => {
  test('notes episode by episode and answers the single-or-null rule', () => {
    const acc = createObservedModelAccumulator();
    expect(acc.observed).toBeNull();
    acc.note(steps('serving-a'));
    expect(acc.observed).toBe('serving-a');
    acc.note(steps('serving-a', 'serving-b'));
    expect(acc.observed).toBeNull();
  });
});

describe('assessAdmissibility — the model-claim refusal', () => {
  test('an observed model that matches the claim keeps the run admissible', () => {
    const verdict = assessAdmissibility(['case-a'], [scored()], {
      modelId: 'serving-a', modelObserved: 'serving-a',
    });

    expect(verdict.admissible).toBe(true);
    expect(verdict.failures).toEqual([]);
  });

  test('an observed model that differs refuses the run, naming both', () => {
    const verdict = assessAdmissibility(['case-a'], [scored()], {
      modelId: 'claimed-model', modelObserved: 'serving-model',
    });

    expect(verdict.admissible).toBe(false);
    expect(verdict.failures.some((f) => f.includes('claimed-model') && f.includes('serving-model'))).toBe(true);
  });

  test('no observation refuses nothing: a caller that never looked cannot fail here', () => {
    expect(assessAdmissibility(['case-a'], [scored()]).admissible).toBe(true);
    expect(assessAdmissibility(['case-a'], [scored()], {
      modelId: 'claimed-model', modelObserved: null,
    }).admissible).toBe(true);
  });
});

describe('publishRunRecord — the record carries the observed model', () => {
  test('a mismatch is published inadmissible with the observed model on it', () => {
    const transcripts = scratchDir('model-observed-mismatch');

    const record = publishRunRecord({
      family: 'test', tier: 'flash', modelId: 'claimed-model', modelObserved: 'serving-model',
      repeats: 1, seed: 1,
      arm: { evolution: false, settle: 'none', tools: [] },
      declaredTasks: ['case-a'], observations: [scored()], spend: SPEND,
      transcripts, repoRoot: join(import.meta.dir, '..', '..', '..'),
    });

    expect(record?.modelObserved).toBe('serving-model');
    expect(record?.admissibility.admissible).toBe(false);
  });

  test('an agreement is published admissible', () => {
    const transcripts = scratchDir('model-observed-agreement');

    const record = publishRunRecord({
      family: 'test', tier: 'flash', modelId: 'serving-a', modelObserved: 'serving-a',
      repeats: 1, seed: 1,
      arm: { evolution: false, settle: 'none', tools: [] },
      declaredTasks: ['case-a'], observations: [scored()], spend: SPEND,
      transcripts, repoRoot: join(import.meta.dir, '..', '..', '..'),
    });

    expect(record?.modelObserved).toBe('serving-a');
    expect(record?.admissibility.admissible).toBe(true);
  });
});
