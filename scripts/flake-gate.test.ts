// The flake gate repeats the test files a commit changes and tells a flake from a failing test. Its red direction is a
// planted flake, run through the gate's own runner.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { childEnv, scratchDir } from '@kinu.run/test-utils';
import {
  REPEATS, movedUnchanged, planFor, repeatAll, stagedTestFiles, sweepRun, sweepVerdict, verdictOf, type Plan, type RunOutcome,
} from './flake-gate';
import { isFirstRunSuite, isPythonSuite, isRunnableSuite, trackedFiles } from './sources';
import { writtenSkips } from './test-census';

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

/** A scratch repository with its own environment: a hook's GIT_DIR and GIT_INDEX_FILE name the commit it gates. */
function scratchRepository(name: string) {
  const cwd = scratchDir(name);
  const env = childEnv({ GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com' });

  const git = (...args: string[]): void => {
    const run = Bun.spawnSync(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd, env, stderr: 'pipe' });

    if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString()}`);
  };

  return { cwd, env, git };
}

describe('the commit a hook gates', () => {
  test('a merge repeats the test files it changes itself, never one it takes whole from a side', () => {
    const { cwd, env, git } = scratchRepository('flake-gate-merge');

    const write = (file: string, text: string): void => { writeFileSync(join(cwd, file), text); };

    git('init', '-q', '-b', 'main');
    write('a.test.ts', 'base\n');
    write('b.test.ts', 'base\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    git('checkout', '-q', '-b', 'side');
    write('a.test.ts', 'side\n');
    git('commit', '-q', '-a', '-m', 'side');
    git('checkout', '-q', 'main');
    write('b.test.ts', 'main\n');
    git('commit', '-q', '-a', '-m', 'main');
    git('merge', '-q', '--no-commit', 'side');

    expect(stagedTestFiles({ cwd, env })).toEqual([]);

    write('a.test.ts', 'side, edited in the merge\n');
    git('add', 'a.test.ts');

    expect(stagedTestFiles({ cwd, env })).toEqual(['a.test.ts']);

    git('commit', '-q', '-m', 'merge');
    write('b.test.ts', 'after the merge\n');
    git('add', 'b.test.ts');

    expect(stagedTestFiles({ cwd, env })).toEqual(['b.test.ts']);
  });
});

describe('a moved test', () => {
  test('is repeated unless its only edits are rewritten import specifiers', () => {
    const { cwd, env, git } = scratchRepository('flake-gate-move');

    const suite = (helper: string, expected: string): string => [
      `import { expect, test } from 'bun:test';`,
      `import { answer } from '${helper}';`,
      '',
      `test('answers', () => { expect(answer()).toBe(${expected}); });`,
      '',
    ].join('\n');

    mkdirSync(join(cwd, 'scripts'));
    mkdirSync(join(cwd, 'tests', 'browser'), { recursive: true });
    writeFileSync(join(cwd, 'scripts', 'a.test.ts'), suite('./helper', '42'));
    writeFileSync(join(cwd, 'scripts', 'b.test.ts'), suite('./helper', '42'));
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');

    git('mv', 'scripts/a.test.ts', 'tests/browser/a.test.ts');
    writeFileSync(join(cwd, 'tests', 'browser', 'a.test.ts'), suite('../../scripts/helper', '42'));
    git('mv', 'scripts/b.test.ts', 'tests/browser/b.test.ts');
    writeFileSync(join(cwd, 'tests', 'browser', 'b.test.ts'), suite('../../scripts/helper', '43'));
    git('add', '-A');

    expect([...movedUnchanged({ cwd, env })]).toEqual(['tests/browser/a.test.ts']);
    expect(stagedTestFiles({ cwd, env })).toEqual(['tests/browser/b.test.ts']);
  });
});

describe('the sweep', () => {
  test('a planted flake comes out flaky under the seeds it was red with, a steady red red, a crash broken', async () => {
    const directory = scratchDir('flake-sweep-planted');
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

    const batch = {
      row: { label: 'planted' }, lane: 'plain' as const,
      argv: ['bun', 'test', '--timeout=0', join(directory, 'flaky.test.ts'), join(directory, 'red.test.ts')],
    };

    const runs = [];

    for (const seed of [11, 22, 33]) runs.push(await sweepRun(batch, seed, directory, 0));

    const verdict = sweepVerdict(runs);

    expect(verdict.flaky.map((entry) => ({ flaky: entry.test.endsWith('passes on odd runs and fails on even ones'), red: entry.red, green: entry.green })))
      .toEqual([{ flaky: true, red: [22], green: [11, 33] }]);
    expect(verdict.red.map((key) => key.endsWith('fails'))).toEqual([true]);
    // Every run here had a red test, and the report keeps what each printed: the failing interleaving is only there.
    expect(runs.map((run) => run.output?.includes('Expected: 2') ?? false)).toEqual([true, true, true]);
    expect(sweepVerdict([{ seed: 7, exitCode: 1, seconds: 0, tests: ['a'], failed: [] }]).broken).toEqual([7]);
  });
});

describe('a suite whose every test skipped', () => {
  test('passes only when each skip waits on a condition: a skip as written is named, and refused', () => {
    const text = [
      "import { describe, test } from 'bun:test';",
      "test.skip('never runs', () => {});",
      "test.skipIf(process.env.CI !== undefined)('runs off CI', () => {});",
      "describe.skip('none of these', () => { test('inner', () => {}); });",
      "test.todo('written later');",
    ].join('\n');

    expect(writtenSkips('scripts/planted.test.ts', text).sort()).toEqual([
      "describe.skip('none of these') at line 4",
      "test.skip('never runs') at line 2",
      "test.todo('written later') at line 5",
    ]);
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
