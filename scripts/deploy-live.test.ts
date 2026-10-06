import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { handClock, scratchDir } from '@kinu.run/test-utils';
import { DeployLive, LIVE_FILE } from './deploy-live';

const START = Date.parse('2026-10-01T18:00:00.000Z');

const at = (seconds: number): string => new Date(START + seconds * 1000).toISOString();

const MUSE = 'opencode-go/muse-spark-1.3-contributor';

/** The eval pass as a deploy wave pipes it, one line of each kind its trials print (evals/src/harness.ts). */
const EVAL_PASS = {
  step: `[evals] site-preview | ${MUSE} | product | trial 2: turn 1, step 4\n`,
  passed: `[evals] site-preview | ${MUSE} | product | trial 2: passed in 312s; evidence /tmp/evals/site-preview-trial-2\n`,
  waiting: `[evals] site-preview | ${MUSE} | product | trial 1: waiting on job bgjob-2de8dz (workspace: node server.js) since ${at(30)}`,
};

function live() {
  const dir = scratchDir('deploy-live');
  const clock = handClock(START);

  return { status: new DeployLive(dir, 'post-publish,source', clock), clock, read: () => readFileSync(join(dir, LIVE_FILE), 'utf8') };
}

describe("the deploy's live status", () => {
  test('a row is named at once when it starts and gone at once when it ends, with how long it ran and its last line', () => {
    const { status, clock, read } = live();
    const evals = status.started('Eval pass: one trial of every eval task');

    expect(read()).toContain('post-publish,source');
    expect(read()).toContain('Eval pass: one trial of every eval task, 0s:');

    clock.advance(65_000);
    const suite = status.started('Core suites');

    expect(read()).toContain('Eval pass: one trial of every eval task, 1m05s:');
    expect(read()).toContain('Core suites, 0s:');

    evals.ended();
    expect(read()).not.toContain('Eval pass');
    expect(read()).toContain('Core suites, 0s:');

    suite.ended();
    expect(read()).not.toContain('Core suites');
  });

  // A suite of a few thousand files prints thousands of lines a second; a rewrite per line is waste.
  test('output alone rewrites the file at most once a second, with the last whole line printed', () => {
    const { status, clock, read } = live();
    const suite = status.started('Core suites');
    const started = read();

    for (let passed = 1; passed <= 3000; passed += 1) suite.output(`(pass) the core > test ${String(passed)}\n`, 'stdout');

    expect(read()).toBe(started);
    clock.advance(1_000);
    expect(read()).toContain('Core suites, 1s: (pass) the core > test 3000\n');

    suite.output('(pass) the core > test 3001\n', 'stdout');
    clock.advance(999);
    expect(read()).toContain('test 3000\n');
    clock.advance(1);
    expect(read()).toContain('Core suites, 2s: (pass) the core > test 3001\n');
  });

  // Staging f75f06932, 2026-10-01: the eval pass held the deploy for half an hour on a trial whose job never ended.
  test("the eval pass's line names the trial it waits on and the job, whole lines only, as a terminal shows them", () => {
    const { status, clock, read } = live();
    const evals = status.started('Eval pass: one trial of every eval task');

    // A minute after the last write, output is written on the clock's next turn.
    clock.advance(60_000);
    evals.output(`\u001b[32m${EVAL_PASS.step}\u001b[39m${EVAL_PASS.passed}`, 'stdout');
    evals.output('downloading... 10%\rdownloading... 100%\n', 'stderr');
    evals.output(EVAL_PASS.waiting.slice(0, 40), 'stdout');
    clock.tick();
    expect(read()).toContain('Eval pass: one trial of every eval task, 1m00s: downloading... 100%\n');

    evals.output(`${EVAL_PASS.waiting.slice(40)}\n`, 'stdout');
    clock.advance(1_000);
    expect(read()).toContain(`Eval pass: one trial of every eval task, 1m01s: ${EVAL_PASS.waiting}\n`);
  });

  // A cancel exits the runner from scripts/deadline.ts: the file's last word is what still ran then.
  test('closing says the phase ended and which rows still ran, and nothing rewrites it after', () => {
    const { status, clock, read } = live();
    const evals = status.started('Eval pass: one trial of every eval task');

    evals.output(`${EVAL_PASS.waiting}\n`, 'stdout');
    clock.advance(41 * 60_000 + 12_000);
    status.close();

    const last = read();
    expect(last).toContain('post-publish,source');
    expect(last).toContain(at(2472));
    expect(last).toContain(`Eval pass: one trial of every eval task, 41m12s: ${EVAL_PASS.waiting}\n`);
    evals.ended();
    clock.advance(5_000);
    expect(read()).toBe(last);
  });
});
