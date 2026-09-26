// The flake gate repeats the test files a commit changes and tells a flake from a failing test. Its red direction is a
// planted flake, run through the gate's own runner.
import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '@kinu.run/test-utils';
import { REPEATS, planFor, repeatAll, verdictOf, type Plan, type RunOutcome } from './flake-gate';
import { isFirstRunSuite, isPythonSuite, isRunnableSuite, trackedFiles } from './sources';

/** A suite in `directory`, repeated the way the gate repeats one: `bun test` over the file alone, REPEATS times. */
function planted(directory: string, name: string): Extract<Plan, { kind: 'repeat' }> {
  return { kind: 'repeat', file: name, argv: ['bun', 'test', '--timeout=0', join(directory, name)], runs: REPEATS, lane: 'plain', row: { label: 'planted' } };
}

describe('the runs of a changed suite', () => {
  test('a planted flake is named a flake with the runs it was red in, apart from a steady red and a steady green', async () => {
    const directory = scratchDir('flake-gate-planted');
    const counter = join(directory, 'runs');

    writeFileSync(join(directory, 'flaky.test.ts'), `import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

test('passes on odd runs and fails on even ones', () => {
  const seen = existsSync(${JSON.stringify(counter)}) ? Number(readFileSync(${JSON.stringify(counter)}, 'utf8')) : 0;

  writeFileSync(${JSON.stringify(counter)}, String(seen + 1));
  expect(seen % 2).toBe(0);
});
`);
    writeFileSync(join(directory, 'red.test.ts'), "import { expect, test } from 'bun:test';\n\ntest('fails', () => { expect(1).toBe(2); });\n");
    writeFileSync(join(directory, 'green.test.ts'), "import { expect, test } from 'bun:test';\n\ntest('passes', () => { expect(1).toBe(1); });\n");

    const results = await repeatAll(['flaky.test.ts', 'red.test.ts', 'green.test.ts'].map((name) => planted(directory, name)), directory);
    const flaky = verdictOf(results.get('flaky.test.ts') ?? []);

    expect(flaky.kind === 'flaky' ? [...flaky.red] : flaky.kind).toEqual([2, 4, 6]);
    expect(verdictOf(results.get('red.test.ts') ?? []).kind).toBe('red');
    expect(verdictOf(results.get('green.test.ts') ?? []).kind).toBe('green');
  });

  test('a run that reports no test at all is red, the silent zero, and a suite that skipped every test is not green', () => {
    const run = (report: RunOutcome['report']): RunOutcome => ({ run: 1, exitCode: 0, seconds: 0, report, output: '' });

    expect(verdictOf([run({ total: 0, failed: [], skipped: 0 })]).kind).toBe('red');
    expect(verdictOf([run({ total: 3, failed: [], skipped: 3 })]).kind).toBe('skipped');
  });
});

describe('what a commit can change', () => {
  test('every test file is repeated through the row that runs it, or named as measured elsewhere', () => {
    const tracked = trackedFiles();

    const unrunnable = tracked.filter((file) => isRunnableSuite(file) || isPythonSuite(file) || isFirstRunSuite(file))
      .map((file) => planFor(file, tracked))
      .flatMap((plan) => (plan.kind === 'unrunnable' ? [`${plan.file}: ${plan.why}`] : []));

    expect(unrunnable).toEqual([]);
  });
});
