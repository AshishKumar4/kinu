/**
 * The triage instrument's own decisions, which are the part that can be wrong
 * quietly.
 *
 * Every case here is a record shape the real corpus produces or will produce:
 * a legacy detail carrying a usage histogram, an attempt whose turn never closed,
 * a failure mix with one key in each census part, two runs of one arm disagreeing,
 * and a stored admissibility verdict that today's policy overturns. The classes
 * are asserted through `triage`, never through a private helper, so a rewrite of
 * the grouping cannot pass this file while changing what a reader is told.
 *
 * The legacy case is the one that matters most. `flash-a`'s `tool_outcomes`
 * detail reads `103/126 tool calls returned; run×88, file×21` — a USAGE
 * histogram whose keys look exactly like failure keys. An instrument that read it
 * as an attribution would report `run×88` as 88 broken calls and file the whole
 * corpus as a product defect.
 */
import { describe, expect, test } from 'bun:test';
import {
  assessAdmissibility, TASK_OUTCOME,
  type EvalObservation, type EvalRunRecord, type EvalScoreRow,
} from '@kinu.run/test-utils';
import { render, triage, type Loaded, type Triage, type Verdict } from './eval-triage';

function row(over: Partial<EvalScoreRow> & { name: string }): EvalScoreRow {
  const eligible = over.eligible ?? 1;
  const passed = over.passed ?? 0;
  return {
    asserts: 'asserted', eligible, passed, rate: eligible === 0 ? null : passed / eligible,
    detail: 'detail', ...over,
  };
}

function scored(
  taskId: string, repetition: number, scores: readonly EvalScoreRow[],
): EvalObservation {
  return {
    taskId, repetition, outcome: 'scored', scores, turns: 1, toolCalls: 4,
    toolNames: ['run'], tokensIn: 10, tokensOut: 2, ms: 100,
  };
}

let clock = 0;

function loaded(over: Partial<EvalRunRecord> & { runId: string }, path?: string): Loaded {
  const observations = over.observations ?? [];
  const declaredTasks = over.declaredTasks ?? observations.map((o) => o.taskId);
  clock += 1000;
  const record: EvalRunRecord = {
    schema: 1,
    createdAt: new Date(clock).toISOString(),
    family: 'behaviour',
    gitSha: 'aaaaaaaa',
    gitDirty: false,
    tier: 'flash',
    modelId: 'model-x',
    repeats: 2,
    seed: 1,
    arm: { evolution: true, settle: 'none', tools: ['run', 'file'] },
    executedTasks: [...new Set(observations.map((o) => o.taskId))],
    spend: { calls: 1, tokensIn: 10, tokensOut: 2 },
    // A directory that exists, so the evidence-pointer check is not the finding
    // under test in cases that are about something else.
    transcripts: import.meta.dir,
    ...over,
    declaredTasks,
    observations,
    admissibility: over.admissibility ?? assessAdmissibility(declaredTasks, observations),
  };
  return { path: path ?? `/tmp/${over.runId}.json`, record };
}

/** `tool_outcomes` as a run written today records it. */
function withMix(passed: number, eligible: number, mix: string): EvalScoreRow {
  return row({
    name: 'tool_outcomes',
    eligible,
    passed,
    detail: `${String(passed)}/${String(eligible)} tool calls returned; 0 refused, 0 work failed, `
      + `0 runtime absent, 0 broke; failed: ${mix}`,
  });
}

function classOf(result: Triage, key: string): string | undefined {
  return result.groups.find((group) => group.key === key)?.cls;
}

describe('a failure key is classed by the census part it sat in', () => {
  const result = triage([loaded({
    runId: 'mixed',
    observations: [
      scored('t-broke', 0, [withMix(3, 4, 'file·edit·threw×1')]),
      scored('t-absent', 0, [withMix(3, 4, 'run·command_not_found×2')]),
      scored('t-work', 0, [withMix(3, 4, 'run·exit_1×3')]),
      scored('t-refused', 0, [withMix(3, 4, 'file·edit·not_found×4')]),
    ],
  })], []);

  test('a tool that broke is a product defect', () => {
    expect(classOf(result, 'behaviour/tool-failure/file·edit·threw/t-broke')).toBe('product-defect');
  });

  test('a program the workspace does not have is an eval defect', () => {
    expect(classOf(result, 'behaviour/tool-failure/run·command_not_found/t-absent'))
      .toBe('eval-defect');
  });

  test('a command that ran and failed is the finding, not a defect', () => {
    expect(classOf(result, 'behaviour/tool-failure/run·exit_1/t-work')).toBe('model-behaviour');
  });

  test('a correct refusal is excluded from the worklist and counted as the contract working', () => {
    expect(classOf(result, 'behaviour/tool-failure/file·edit·not_found/t-refused'))
      .toBeUndefined();
    expect(result.refusedCalls).toBe(4);
  });

  test('the worklist ranks the product defect above the behaviour finding', () => {
    const keys = result.groups.map((group) => group.key);
    expect(keys.indexOf('behaviour/tool-failure/file·edit·threw/t-broke'))
      .toBeLessThan(keys.indexOf('behaviour/tool-failure/run·exit_1/t-work'));
  });
});

describe('a legacy detail carries no attribution and is never read as one', () => {
  const result = triage([loaded({
    runId: 'legacy',
    observations: [scored('ws-fix-broken', 0, [row({
      name: 'tool_outcomes', eligible: 39, passed: 30,
      detail: '30/39 tool calls returned; run×29, execute_tools×6, file×4',
    })])],
  })], []);

  test('the usage histogram produces no tool-failure group', () => {
    expect(result.groups.filter((group) => group.kind === 'tool-failure')).toEqual([]);
  });

  test('the attempt is reported as unattributed, so the empty product class reads as unmeasured', () => {
    expect(result.unattributedAttempts).toBe(1);
    expect(render(result)).toContain('read the empty product-defect class as UNMEASURED, not as clean.');
  });

  test('its scorer group says the part is unknown rather than blaming the model', () => {
    const group = result.groups.find((g) => g.key === 'behaviour/scorer/tool_outcomes/ws-fix-broken');
    expect(group?.why).toContain('names NO key');
  });
});

describe('dispersion is only dispersion inside one commit and one arm', () => {
  const passing = row({ name: 'edit_landing', eligible: 2, passed: 2 });
  const failing = row({ name: 'edit_landing', eligible: 2, passed: 1 });

  test('two repetitions of one run disagreeing is a flake', () => {
    const result = triage([loaded({
      runId: 'same-arm',
      observations: [scored('ws-edit', 0, [passing]), scored('ws-edit', 1, [failing])],
    })], []);
    expect(classOf(result, 'behaviour/scorer/edit_landing/ws-edit')).toBe('flake');
  });

  test('the same disagreement across two commits is not a flake', () => {
    const result = triage([
      loaded({ runId: 'before', gitSha: 'aaaaaaaa', observations: [scored('ws-edit', 0, [passing])] }),
      loaded({ runId: 'after', gitSha: 'bbbbbbbb', observations: [scored('ws-edit', 0, [failing])] }),
    ], []);
    expect(classOf(result, 'behaviour/scorer/edit_landing/ws-edit')).toBe('model-behaviour');
  });

  test('an unsolved task with a verified outcome is the model, not a defect', () => {
    const result = triage([loaded({
      runId: 'outcome',
      observations: [scored('ws-edit', 0, [row({ name: TASK_OUTCOME, eligible: 4, passed: 1 })])],
    })], []);
    expect(classOf(result, `behaviour/scorer/${TASK_OUTCOME}/ws-edit`)).toBe('model-behaviour');
  });
});

describe('an attempt that produced no score is classed by WHY it produced none', () => {
  test('a trajectory the ledger never closed is an eval defect', () => {
    const result = triage([loaded({
      runId: 'inert',
      observations: [{
        taskId: 'tool-001', repetition: 0, outcome: 'inert', reason: '0 turns, 12 tool calls',
      }],
    })], []);
    expect(classOf(result, 'behaviour/attempt/inert/tool-001')).toBe('eval-defect');
  });

  test('an attempt that raised out of the code under test is a product defect', () => {
    const result = triage([loaded({
      runId: 'errored',
      observations: [{
        taskId: 'tool-001', repetition: 0, outcome: 'errored', reason: 'TypeError: x is not a function',
      }],
    })], []);
    expect(classOf(result, 'behaviour/attempt/errored/tool-001')).toBe('product-defect');
  });
});

describe('the record is never trusted about itself', () => {
  test('a stored admissible verdict that today overturns is its own finding', () => {
    const result = triage([loaded({
      runId: 'stale',
      observations: [scored('ws-edit', 0, [row({ name: 'edit_landing', eligible: 1, passed: 1 })])],
      admissibility: {
        admissible: true, scored: 1, inert: 0, incomplete: 0,
        gradedTurns: 1, toolCalls: 4, outcomesScored: 0,
        mechanismsExercised: ['edit_landing'], mechanismsAbsent: [], failures: [],
      },
    })], []);
    expect(classOf(result, 'behaviour/run/stored admissibility verdict is stale/*'))
      .toBe('eval-defect');
    expect(classOf(result, 'behaviour/run/no observation carried a task_outcome row/*'))
      .toBe('eval-defect');
  });

  test('a run that attempted nothing is one finding, and its missing transcript is not held against it', () => {
    const result = triage([loaded({
      runId: 'empty', declaredTasks: ['a', 'b'], observations: [], transcripts: '/tmp/gone-xyz',
    })], []);
    expect(result.groups.map((group) => group.key)).toEqual([
      'behaviour/run/the run attempted nothing and still wrote a record/*',
    ]);
  });

  test('a run that measured something and kept no trajectory cannot be investigated', () => {
    const result = triage([loaded({
      runId: 'no-transcript',
      observations: [scored('ws-edit', 0, [row({ name: 'edit_landing', eligible: 1, passed: 0 })])],
      transcripts: '/tmp/eval-triage-absent-dir',
    })], []);
    expect(classOf(result, 'behaviour/run/the named transcripts directory is gone/*'))
      .toBe('eval-defect');
  });
});

describe('the verdicts file annotates and cannot suppress', () => {
  const observations = [scored('ws-edit', 0, [row({ name: 'edit_landing', eligible: 1, passed: 0 })])];
  const verdict: Verdict = {
    group: 'behaviour/scorer/edit_landing/ws-edit',
    verdict: 'eval-defect',
    reviewed: '2026-08-20',
    read: 'the record',
    note: 'the eligibility predicate is too wide here',
  };

  test('a verdict that disagrees with the machine prints both', () => {
    const result = triage([loaded({ runId: 'verdicted', observations })], [verdict]);
    const group = result.groups.find((g) => g.key === verdict.group);
    expect(group?.cls).toBe('model-behaviour');
    expect(render(result).join('\n')).toContain('OVERRIDES to eval-defect');
  });

  test('a verdict naming a group no failure produced is reported stale', () => {
    const result = triage([loaded({ runId: 'verdicted', observations })], [
      { ...verdict, group: 'behaviour/scorer/edit_landing/ws-gone' },
    ]);
    expect(result.staleVerdicts.map((stale) => stale.group))
      .toEqual(['behaviour/scorer/edit_landing/ws-gone']);
    expect(render(result).join('\n')).toContain('STALE VERDICT');
  });

  test('a group with no verdict says so instead of reading as settled', () => {
    const result = triage([loaded({ runId: 'verdicted', observations })], []);
    expect(render(result).join('\n')).toContain('UNVERIFIED');
  });
});
