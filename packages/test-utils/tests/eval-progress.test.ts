/**
 * The durable progress store's own tests.
 *
 * The property this module exists for is that an eval tier which dies mid-corpus
 * loses nothing, repeats nothing, and still COUNTS what it did not do. So almost
 * every case here crosses a simulated process boundary: `openEvalProgress` on a
 * directory a previous store already wrote IS the next process reading what the
 * last one left behind, and a store that only holds together inside one process
 * solves none of the problem it was built for.
 *
 * The three shapes worth naming, because each one was a real defect:
 *
 *   - work that finished and was thrown away, because the process died before
 *     the observation reached the record;
 *   - work that was repeated, because a restart could not tell a finished
 *     episode from an unstarted one;
 *   - work that was never done and never noticed, because a case the run did
 *     not reach was an ABSENCE, and nothing counts an absence. That is the one
 *     the five-state census exists for.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { scratchDir } from '../src/scratch';

import {
  caseKey, findResumableEvalDir, formatCaseCensus, openEvalProgress,
  type CaseOutcome, type EvalProgressCase, type EvalProgressStore,
} from '../src/eval-progress';

const root = scratchDir('eval-progress');

/** One case run end to end, the way a suite runs it: in flight, then finished
 *  with its output and its verdict, then recorded downstream. Three call sites
 *  need this sequence identically — a census that read a phase written out of
 *  order would be measuring the helper rather than the store. */
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
    // Declared before any work: a run that dies here still knows what it owed,
    // and the case reads as not-run rather than as nothing at all.
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
    // The verdict travels with the settle stamp. A settled case that forgot how
    // it ended cannot be counted, and the census is total or it is nothing.
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

    // The next process declares the same corpus on the way in. Declaring is not
    // a reset: a finished episode stays adoptable, or resuming would repeat the
    // one thing resuming exists to avoid.
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

    // Operator cancellation classifies the in-flight case alone. Completed
    // progress stays adoptable, and a settled case never reappears in either
    // list — completed work is not repeated.
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

    // Newest by name, but a different run shape — it is neither adopted nor
    // allowed to hide the older resumable directory.
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
    // The episode's own event stream, one call per event as the recorder writes
    // it. Nothing here waits for the episode to finish, which is the point: the
    // episode is about to not finish.
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
    // The classification does not erase the evidence. An interrupted case that
    // reported nothing is indistinguishable from one that never began, and the
    // difference is exactly what that spend bought.
    expect(classified?.activity).toEqual({ turns: 1, toolCalls: 2, modelSteps: 2 });
    // Never an outcome: an interruption is not pass, fail or inert.
    expect(classified?.outcome).toBeUndefined();

    // The retry starts the tally over, because the retry starts the episode
    // over. Carrying the old counts forward would double-count the work.
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

    // What the episode DID is a fact about the episode, not about the reporting
    // that followed it, so it survives both later transitions.
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
    // Named, not counted: a reader who has to diff two lists to find the case
    // that was dropped will not do it.
    expect(printed).toContain('never settled:    interrupted#0');
    expect(printed).toContain('never attempted:  unreached#0');
  });

  /**
   * Each partial state ALONE, because together they hide each other.
   *
   * A run in which everything that ran came back scored looks finished from
   * every angle except the corpus it declared. That is the shape the census was
   * built for and the shape a test with both states present cannot prove: with
   * an interrupted case in the fixture too, a `complete` that had forgotten
   * about `notRun` entirely would still report false.
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

    // `progress`, never `settled`: the episode finished and the process died on
    // the way to the record. The work is done, so the case is scored — counting
    // it as incomplete would ask the next run to buy it a second time.
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

    // A run in which the agent did nothing and the harness broke is a bad run
    // and a COMPLETE one. Only an interruption and an unreached case make a run
    // partial; conflating a finding with an unfinished run is how a red result
    // gets retried until it goes away.
    const census = store.census(declared);
    expect(census.complete).toBe(true);
    expect(formatCaseCensus(census)).not.toContain('INCOMPLETE RUN');
  });
});

describe('a run killed mid-corpus resumes, and cannot report as green', () => {
  /** Six cases: two settled, one finished but unrecorded, one in flight, two
   *  never reached. That is what a `kill -9` between cases actually leaves. */
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

    // The next invocation finds the unfinished run rather than starting a new
    // one. A completed run would not be offered.
    const expected = new Set(cases.map((c) => caseKey(c.taskId, c.repetition)));
    expect(findResumableEvalDir(root2, 'behaviour-flash-', signature, expected)).toBe(dir);

    // What the suite does on the way in: classify what was in flight, declare
    // the corpus, then plan.
    const rerun = openEvalProgress(dir, signature);
    expect(rerun.markInFlightIncomplete('previous process ended before the case settled'))
      .toEqual([caseKey('beta', 1)]);
    rerun.markPlanned(cases);

    const plan = rerun.plan(cases);
    // Adopted, not re-run: that episode was paid for and its output is here.
    expect(plan.adopt).toEqual([{ input: cases[2], output: { answer: 'paid for' } }]);
    // Exactly the remainder: the interrupted case and the two never reached.
    expect(plan.todo).toEqual([cases[3], cases[4], cases[5]]);
    // The two settled cases are in neither list.
    expect([...plan.todo, ...plan.adopt.map((a) => a.input)])
      .not.toContainEqual(cases[0]);
    // The interrupted attempt's evidence survived into the rerun's own state.
    expect(rerun.record(caseKey('beta', 1))?.activity)
      .toEqual({ turns: 0, toolCalls: 2, modelSteps: 1 });

    // Finish the remainder, and only the remainder.
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
    // And the completed directory is no longer offered for resumption.
    expect(findResumableEvalDir(root2, 'behaviour-flash-', signature, expected)).toBeNull();
  });

  test('a case the run never reached keeps the run from reading as complete', () => {
    const dir = join(root, 'killed-census', 'behaviour-flash-2000');
    killedMidCorpus(dir);
    const store = openEvalProgress(dir, signature);
    store.markInFlightIncomplete('previous process ended before the case settled');

    // This is the expression the behaviour suite's last test asserts on, so a
    // false here IS a red run. Before the census existed the unreached cases
    // were absent from the record and the shorter denominator read as a
    // finished measurement.
    const census = store.census(cases);
    expect(census.complete).toBe(false);
    expect(census.states.notRun).toEqual([cases[4], cases[5]]);
    expect(census.states.incomplete).toEqual([cases[3]]);
    expect(Object.values(census.states).reduce((n, list) => n + list.length, 0))
      .toBe(cases.length);
    expect(formatCaseCensus(census)).toContain('never attempted:  gamma#0, gamma#1');
  });
});
