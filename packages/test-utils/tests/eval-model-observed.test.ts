/**
 * `modelId` is the claim; `modelObserved`, read from `step_finish` rows, is the check. A record
 * whose check disagrees is not evidence.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { RunEvent } from '@kinu.run/core';
import {
  assessAdmissibility, createObservedModelAccumulator, modelClaimRefuted,
  projectRunEventProvenance, publishRunRecord, type EvalObservation,
} from '../src/eval-run';
import { TASK_OUTCOME } from '../src/eval-outcome';
import type { LiveModelSpend } from '../src/live-model';
import { scratchDir } from '../src/scratch';

let nextIndex = 0;

/** Distributed over the union so each variant keeps its own shape. */
type EventBody<Variant = RunEvent> = Variant extends RunEvent
  ? Omit<Variant, 'runId' | 'eventIndex' | 'timestamp'>
  : never;

function event(body: EventBody): RunEvent {
  nextIndex += 1;

  return {
    ...body,
    runId: 'run-test',
    eventIndex: nextIndex,
    timestamp: new Date(1_700_000_000_000 + nextIndex * 1_000).toISOString(),
  };
}

function steps(...modelIds: Array<string | undefined>): RunEvent[] {
  nextIndex = 0;

  return modelIds.map((modelId, step) =>
    event({ type: 'step_finish', stepIndex: step, reason: 'stop', modelId }));
}

/** One scored observation with a task_outcome row — admissible on its own. */
function scored(): EvalObservation {
  return {
    taskId: 'case-a', repetition: 0, outcome: 'scored',
    scores: [{ name: TASK_OUTCOME, asserts: 'solved', eligible: 1, passed: 1, rate: 1, detail: 'solved' }],
    turns: 2, toolCalls: 3, toolNames: ['shell'], tokensIn: 10, tokensOut: 5, reasoningOut: 0, ms: 7,
    provenance: projectRunEventProvenance([]),
  };
}

const SPEND: LiveModelSpend = {
  calls: 2, callsWithoutUsage: 0, usage: { input: 10, output: 5 },
  episodesUnmeasured: 0, episodesWithoutModel: 0,
};

/** What one accumulator observes over `events`. */
function observed(events: readonly RunEvent[]): string | null {
  const acc = createObservedModelAccumulator();
  acc.note(events);

  return acc.observed;
}

describe('the observed model', () => {
  test('one serving model across the steps is the observed model', () => {
    expect(observed(steps('serving-a', 'serving-a'))).toBe('serving-a');
  });

  test('steps with no serving id observe nothing, rather than a guess', () => {
    expect(observed(steps(undefined, undefined))).toBeNull();
    expect(observed([])).toBeNull();
  });

  test('two serving ids observe nothing, rather than picking one', () => {
    expect(observed(steps('serving-a', 'serving-b'))).toBeNull();
  });

  test('auxiliary lanes do not vote: a judge on another model changes nothing', () => {
    const events: RunEvent[] = [
      ...steps('serving-a', 'serving-a'),
      event({ type: 'model_call', source: 'judge', usage: {}, spec: 'other/judge', modelId: 'judge-model' }),
    ];

    expect(observed(events)).toBe('serving-a');
  });

  test('noted episode by episode, the rule holds across them', () => {
    const acc = createObservedModelAccumulator();
    expect(acc.observed).toBeNull();
    acc.note(steps('serving-a'));
    expect(acc.observed).toBe('serving-a');
    acc.note(steps('serving-a', 'serving-b'));
    expect(acc.observed).toBeNull();
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
  const publishCases = [
    {
      name: 'a mismatch is published inadmissible with the observed model on it',
      scratch: 'model-observed-mismatch', modelId: 'claimed-model', observed: 'serving-model', admissible: false,
    },
    {
      name: 'an agreement is published admissible',
      scratch: 'model-observed-agreement', modelId: 'serving-a', observed: 'serving-a', admissible: true,
    },
  ];

  for (const published of publishCases) {
    test(published.name, () => {
      const record = publishRunRecord({
        family: 'test', tier: 'flash', modelId: published.modelId, modelObserved: published.observed,
        repeats: 1, seed: 1,
        arm: { evolution: false, settle: 'none', tools: [] },
        declaredTasks: ['case-a'], observations: [scored()], spend: SPEND,
        transcripts: scratchDir(published.scratch), repoRoot: join(import.meta.dir, '..', '..', '..'),
      });

      expect(record?.modelObserved).toBe(published.observed);
      expect(record?.admissibility.admissible).toBe(published.admissible);
    });
  }
});
