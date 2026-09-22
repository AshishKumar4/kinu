/**
 * Most cases cross a simulated process boundary: `openEvalProgress` on a directory a previous
 * store wrote is the next process reading what the last one left.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { scratchDir } from '../src/scratch';

import {
  caseKey, findResumableEvalDir, formatCaseCensus, openEvalProgress,
  type CaseOutcome, type EvalProgressCase, type EvalProgressStore,
} from '../src/eval-progress';

const root = scratchDir('eval-progress');

/** One case end to end, in the order a suite runs it: in flight, finished, recorded downstream. */
function runToSettled(store: EvalProgressStore, taskId: string, outcome: CaseOutcome): void {
  const key = caseKey(taskId, 0);
  store.markStarted(key);
  store.markProgress(key, { taskId }, outcome);
  store.markSettled(key);
}

describe('durable eval case progress', () => {
  test('planned, started, progress and settled are durable at the moment they happen', () => {
    const dir = join(root, 'phases');
    const key = caseKey('case-a', 0);
    const cases = [{ taskId: 'case-a', repetition: 0 }];

    const first = openEvalProgress(dir, 'shape-a');
    // Declared before any work, so an unreached case reads as not-run.
    first.markPlanned(cases);
    const declared = openEvalProgress(dir, 'shape-a');
    expect(declared.record(key)?.phase).toBe('planned');
    expect(declared.census(cases).states.notRun).toEqual(cases);
    expect(declared.plan(cases)).toEqual({ todo: cases, adopt: [] });

    first.markStarted(key);
    expect(openEvalProgress(dir, 'shape-a').record(key)?.phase).toBe('started');

    first.markProgress(key, { output: 'finished episode', ms: 17 }, 'scored');
    const afterProgress = openEvalProgress(dir, 'shape-a');
    expect(afterProgress.record(key)?.phase).toBe('progress');
    expect(afterProgress.record(key)?.outcome).toBe('scored');
    expect(afterProgress.plan(cases)).toEqual({
      todo: [],
      adopt: [{ input: cases[0], output: { output: 'finished episode', ms: 17 } }],
    });

    first.markSettled(key);
    const afterSettle = openEvalProgress(dir, 'shape-a');
    expect(afterSettle.record(key)?.phase).toBe('settled');
    // The verdict travels with the settle stamp; the census cannot count a case without it.
    expect(afterSettle.record(key)?.outcome).toBe('scored');
    expect(afterSettle.plan(cases)).toEqual({ todo: [], adopt: [] });
    expect([...afterSettle.settledKeys()]).toEqual([key]);
  });

  test('re-declaring the corpus never resets a case that already ran', () => {
    const dir = join(root, 'redeclare');
    const cases = [{ taskId: 'paid', repetition: 0 }, { taskId: 'unpaid', repetition: 0 }];
    const key = caseKey('paid', 0);

    const first = openEvalProgress(dir, 'shape-redeclare');
    first.markPlanned(cases);
    first.markStarted(key);
    first.markProgress(key, { answer: 'expensive' }, 'scored');

    // Declaring is not a reset: a finished episode stays adoptable.
    const second = openEvalProgress(dir, 'shape-redeclare');
    second.markPlanned(cases);
    expect(second.record(key)?.phase).toBe('progress');
    expect(second.plan(cases)).toEqual({
      todo: [cases[1]],
      adopt: [{ input: cases[0], output: { answer: 'expensive' } }],
    });
  });

  test('a restart adopts completed progress, skips settled cases, and reruns only unfinished work', () => {
    const dir = join(root, 'resume');
    const settled = { taskId: 'settled', repetition: 0 };
    const completed = { taskId: 'completed', repetition: 0 };
    const unfinished = { taskId: 'unfinished', repetition: 0 };
    const store = openEvalProgress(dir, 'shape-b');

    runToSettled(store, settled.taskId, 'scored');
    store.markStarted(caseKey(completed.taskId, completed.repetition));
    store.markProgress(caseKey(completed.taskId, completed.repetition), { answer: 2 }, 'scored');
    store.markStarted(caseKey(unfinished.taskId, unfinished.repetition));

    const resumed = openEvalProgress(dir, 'shape-b');
    expect(resumed.plan([settled, completed, unfinished])).toEqual({
      todo: [unfinished],
      adopt: [{ input: completed, output: { answer: 2 } }],
    });

    // Cancellation classifies only the in-flight case; settled cases never reappear.
    expect(resumed.markInFlightIncomplete('cancelled by operator'))
      .toEqual([caseKey(unfinished.taskId, unfinished.repetition)]);
    const afterCancel = openEvalProgress(dir, 'shape-b');
    expect(afterCancel.record(caseKey(unfinished.taskId, unfinished.repetition))).toMatchObject({
      phase: 'incomplete',
      reason: 'cancelled by operator',
    });
    expect(afterCancel.record(caseKey(completed.taskId, completed.repetition))?.phase)
      .toBe('progress');
    expect(afterCancel.plan([settled, completed, unfinished])).toEqual({
      todo: [unfinished],
      adopt: [{ input: completed, output: { answer: 2 } }],
    });
  });

  test('state from a different run shape is never resumed into this run', () => {
    const dir = join(root, 'shape-mismatch');
    const old = openEvalProgress(dir, 'old-shape');
    old.markProgress(caseKey('case-a', 0), { paid: true }, 'scored');

    const current = openEvalProgress(dir, 'new-shape');
    expect(current.all()).toEqual({});
    expect(current.plan([{ taskId: 'case-a', repetition: 0 }])).toEqual({
      todo: [{ taskId: 'case-a', repetition: 0 }],
      adopt: [],
    });
  });

  test('run discovery resumes the newest unfinished matching shape, never a completed run', () => {
    const dir = join(root, 'discovery');
    const key = caseKey('case-a', 0);
    const expected = new Set([key]);

    const unfinishedDir = join(dir, 'behaviour-flash-100');
    openEvalProgress(unfinishedDir, 'shape-d').markStarted(key);

    const completed = openEvalProgress(join(dir, 'behaviour-flash-200'), 'shape-d');
    completed.markProgress(key, { answer: 1 }, 'scored');
    completed.markSettled(key);

    // Newest by name but a different run shape: not adopted, and must not hide the older resumable directory.
    openEvalProgress(join(dir, 'behaviour-flash-300'), 'other-shape').markStarted(key);

    expect(findResumableEvalDir(dir, 'behaviour-flash-', 'shape-d', expected))
      .toBe(unfinishedDir);
    openEvalProgress(unfinishedDir, 'shape-d').markProgress(key, { answer: 2 }, 'scored');
    openEvalProgress(unfinishedDir, 'shape-d').markSettled(key);
    expect(findResumableEvalDir(dir, 'behaviour-flash-', 'shape-d', expected))
      .toBeNull();
  });
});

describe('an episode makes its own events durable as they land', () => {
  test('an interrupted case still says what it got through', () => {
    const dir = join(root, 'activity');
    const key = caseKey('long-case', 0);
    const cases = [{ taskId: 'long-case', repetition: 0 }];

    const live = openEvalProgress(dir, 'shape-act');
    live.markPlanned(cases);
    live.markStarted(key);
    // Written per event, before the episode finishes.
    live.markActivity(key, { modelSteps: 1 });
    live.markActivity(key, { toolCalls: 1 });
    live.markActivity(key, { modelSteps: 1 });
    live.markActivity(key, { toolCalls: 1 });
    live.markActivity(key, { turns: 1 });

    // The process dies here. Every line above is already on disk.
    const restarted = openEvalProgress(dir, 'shape-act');
    expect(restarted.record(key)?.phase).toBe('started');
    expect(restarted.record(key)?.activity).toEqual({ turns: 1, toolCalls: 2, modelSteps: 2 });

    restarted.markInFlightIncomplete('cancelled by operator (SIGINT)');
    const classified = openEvalProgress(dir, 'shape-act').record(key);
    expect(classified?.phase).toBe('incomplete');
    // Classification keeps the evidence: an interrupted case that reported nothing looks unstarted.
    expect(classified?.activity).toEqual({ turns: 1, toolCalls: 2, modelSteps: 2 });
    // Never an outcome: an interruption is not pass, fail or inert.
    expect(classified?.outcome).toBeUndefined();

    // A retry restarts the tally; carrying counts forward would double-count.
    restarted.markStarted(key);
    expect(openEvalProgress(dir, 'shape-act').record(key)?.activity).toBeUndefined();
  });

  test('a finished episode keeps the tally its events produced', () => {
    const dir = join(root, 'activity-settled');
    const key = caseKey('short-case', 0);
    const store = openEvalProgress(dir, 'shape-act2');

    store.markStarted(key);
    store.markActivity(key, { turns: 1 });
    store.markActivity(key, { toolCalls: 3 });
    store.markProgress(key, { answer: 'done' }, 'scored');
    store.markSettled(key);

    // What the episode did survives both later transitions.
    expect(openEvalProgress(dir, 'shape-act2').record(key)?.activity)
      .toEqual({ turns: 1, toolCalls: 3, modelSteps: 0 });
  });
});

describe('the five states partition the declared corpus', () => {
  const cases: EvalProgressCase[] = [
    { taskId: 'won', repetition: 0 },
    { taskId: 'did-nothing', repetition: 0 },
    { taskId: 'broke', repetition: 0 },
    { taskId: 'interrupted', repetition: 0 },
    { taskId: 'unreached', repetition: 0 },
  ];

  test('every declared case lands in exactly one state, and they sum to the corpus', () => {
    const dir = join(root, 'census');
    const store = openEvalProgress(dir, 'shape-census');
    store.markPlanned(cases);
    runToSettled(store, 'won', 'scored');
    runToSettled(store, 'did-nothing', 'inert');
    runToSettled(store, 'broke', 'errored');
    store.markStarted(caseKey('interrupted', 0));
    store.markInFlightIncomplete('cancelled by operator (SIGTERM)');

    const census = openEvalProgress(dir, 'shape-census').census(cases);
    expect(census.total).toBe(cases.length);
    expect(Object.values(census.states).reduce((n, list) => n + list.length, 0))
      .toBe(census.total);
    expect(census.states.scored).toEqual([cases[0]]);
    expect(census.states.inert).toEqual([cases[1]]);
    expect(census.states.errored).toEqual([cases[2]]);
    expect(census.states.incomplete).toEqual([cases[3]]);
    expect(census.states.notRun).toEqual([cases[4]]);
    expect(census.complete).toBe(false);
  });

  test('the report names all five counts, and says outright that it is not green', () => {
    const dir = join(root, 'census-format');
    const store = openEvalProgress(dir, 'shape-format');
    store.markPlanned(cases);
    runToSettled(store, 'won', 'scored');
    runToSettled(store, 'did-nothing', 'inert');
    runToSettled(store, 'broke', 'errored');
    store.markStarted(caseKey('interrupted', 0));
    store.markInFlightIncomplete('cancelled by operator (SIGTERM)');

    const printed = formatCaseCensus(store.census(cases));
    expect(printed).toContain('cases 5 declared');
    expect(printed).toContain('1 scored, 1 inert, 1 errored, 1 incomplete');
    expect(printed).toContain('1 not-run');
    expect(printed).toContain('INCOMPLETE RUN — this is not a green result.');
    // Named, not counted.
    expect(printed).toContain('never settled:    interrupted#0');
    expect(printed).toContain('never attempted:  unreached#0');
  });

  /**
   * Each partial state alone: with an interrupted case present, a `complete` that ignored
   * `notRun` would still report false.
   */
  test('either partial state alone is enough to keep a run from reading as green', () => {
    const declared: EvalProgressCase[] = [
      { taskId: 'ran', repetition: 0 },
      { taskId: 'other', repetition: 0 },
    ];

    const unreachedOnly = openEvalProgress(join(root, 'census-notrun-only'), 'shape-notrun');
    unreachedOnly.markPlanned(declared);
    runToSettled(unreachedOnly, 'ran', 'scored');
    const notRun = unreachedOnly.census(declared);
    expect(notRun.states.incomplete).toEqual([]);
    expect(notRun.states.notRun).toEqual([declared[1]]);
    expect(notRun.complete).toBe(false);
    expect(formatCaseCensus(notRun)).toContain('INCOMPLETE RUN');

    const interruptedOnly = openEvalProgress(join(root, 'census-cancel-only'), 'shape-cancel');
    interruptedOnly.markPlanned(declared);
    runToSettled(interruptedOnly, 'ran', 'scored');
    interruptedOnly.markStarted(caseKey('other', 0));
    interruptedOnly.markInFlightIncomplete('cancelled by operator (SIGINT)');
    const cancelled = interruptedOnly.census(declared);
    expect(cancelled.states.notRun).toEqual([]);
    expect(cancelled.states.incomplete).toEqual([declared[1]]);
    expect(cancelled.complete).toBe(false);
    expect(formatCaseCensus(cancelled)).toContain('INCOMPLETE RUN');
  });

  test('a finished episode counts even when the run died before recording it', () => {
    const dir = join(root, 'census-progress');
    const key = caseKey('paid-for', 0);
    const declared = [{ taskId: 'paid-for', repetition: 0 }];
    const store = openEvalProgress(dir, 'shape-progress');
    store.markPlanned(declared);
    store.markStarted(key);
    store.markProgress(key, { answer: 'expensive' }, 'scored');

    // `progress`, never `settled`: the work is done, so the case is scored rather than re-bought.
    const census = openEvalProgress(dir, 'shape-progress').census(declared);
    expect(census.states.scored).toEqual(declared);
    expect(census.complete).toBe(true);
  });

  test('inert and errored are finished verdicts, so a run of them is complete', () => {
    const dir = join(root, 'census-complete');

    const declared: EvalProgressCase[] = [
      { taskId: 'did-nothing', repetition: 0 },
      { taskId: 'broke', repetition: 0 },
    ];

    const store = openEvalProgress(dir, 'shape-complete');
    store.markPlanned(declared);
    runToSettled(store, 'did-nothing', 'inert');
    runToSettled(store, 'broke', 'errored');

    // Agent inaction plus a broken harness is a bad but complete run; only interrupted and
    // unreached cases make it partial.
    const census = store.census(declared);
    expect(census.complete).toBe(true);
    expect(formatCaseCensus(census)).not.toContain('INCOMPLETE RUN');
  });
});

describe('a run killed mid-corpus resumes, and cannot report as green', () => {
  /** What a `kill -9` between cases leaves: two settled, one unrecorded, one in flight, two unreached. */
  const cases: EvalProgressCase[] = [
    { taskId: 'alpha', repetition: 0 },
    { taskId: 'alpha', repetition: 1 },
    { taskId: 'beta', repetition: 0 },
    { taskId: 'beta', repetition: 1 },
    { taskId: 'gamma', repetition: 0 },
    { taskId: 'gamma', repetition: 1 },
  ];

  const signature = 'shape-killed';

  function killedMidCorpus(dir: string): void {
    const store = openEvalProgress(dir, signature);
    store.markPlanned(cases);
    runToSettled(store, 'alpha', 'scored');
    store.markStarted(caseKey('alpha', 1));
    store.markProgress(caseKey('alpha', 1), { answer: 'second rep' }, 'scored');
    store.markSettled(caseKey('alpha', 1));
    // Finished, and the process died before the observation reached the record.
    store.markStarted(caseKey('beta', 0));
    store.markActivity(caseKey('beta', 0), { turns: 1, toolCalls: 4, modelSteps: 3 });
    store.markProgress(caseKey('beta', 0), { answer: 'paid for' }, 'scored');
    // In flight when the process died.
    store.markStarted(caseKey('beta', 1));
    store.markActivity(caseKey('beta', 1), { toolCalls: 2, modelSteps: 1 });
    // `gamma` rep 0 and rep 1 were never reached.
  }

  test('the rerun does exactly the remainder — nothing repeated, nothing dropped', () => {
    const root2 = join(root, 'killed');
    const dir = join(root2, 'behaviour-flash-1000');
    killedMidCorpus(dir);

    // Finds the unfinished run; a completed run is not offered.
    const expected = new Set(cases.map((c) => caseKey(c.taskId, c.repetition)));
    expect(findResumableEvalDir(root2, 'behaviour-flash-', signature, expected)).toBe(dir);

    // Classify what was in flight, declare the corpus, then plan.
    const rerun = openEvalProgress(dir, signature);
    expect(rerun.markInFlightIncomplete('previous process ended before the case settled'))
      .toEqual([caseKey('beta', 1)]);
    rerun.markPlanned(cases);

    const plan = rerun.plan(cases);
    // Adopted, not re-run: that episode was paid for and its output is here.
    expect(plan.adopt).toEqual([{ input: cases[2], output: { answer: 'paid for' } }]);
    // Exactly the remainder: the interrupted case and the two never reached.
    expect(plan.todo).toEqual([cases[3], cases[4], cases[5]]);
    expect([...plan.todo, ...plan.adopt.map((a) => a.input)])
      .not.toContainEqual(cases[0]);
    // The interrupted attempt's evidence survived into the rerun's own state.
    expect(rerun.record(caseKey('beta', 1))?.activity)
      .toEqual({ turns: 0, toolCalls: 2, modelSteps: 1 });

    for (const input of plan.todo) {
      const key = caseKey(input.taskId, input.repetition);
      rerun.markStarted(key);
      rerun.markProgress(key, { answer: `${input.taskId} finished on the rerun` }, 'scored');
      rerun.markSettled(key);
    }

    for (const adopted of plan.adopt) {
      rerun.markSettled(caseKey(adopted.input.taskId, adopted.input.repetition));
    }

    const finished = openEvalProgress(dir, signature).census(cases);
    expect(finished.states.scored).toEqual(cases);
    expect(finished.complete).toBe(true);
    expect(findResumableEvalDir(root2, 'behaviour-flash-', signature, expected)).toBeNull();
  });

  test('a case the run never reached keeps the run from reading as complete', () => {
    const dir = join(root, 'killed-census', 'behaviour-flash-2000');
    killedMidCorpus(dir);
    const store = openEvalProgress(dir, signature);
    store.markInFlightIncomplete('previous process ended before the case settled');

    // The behaviour suite's last test asserts this, so false here is a red run.
    const census = store.census(cases);
    expect(census.complete).toBe(false);
    expect(census.states.notRun).toEqual([cases[4], cases[5]]);
    expect(census.states.incomplete).toEqual([cases[3]]);
    expect(Object.values(census.states).reduce((n, list) => n + list.length, 0))
      .toBe(cases.length);
    expect(formatCaseCensus(census)).toContain('never attempted:  gamma#0, gamma#1');
  });
});
