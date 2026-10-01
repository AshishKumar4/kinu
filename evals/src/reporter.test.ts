import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '@kinu.run/test-utils';

const REPO = join(import.meta.dirname, '../..');

test('a task file that did not load and a suite whose hook threw are named in the run\'s output, with why', () => {
  // On 2026-10-01 the staging pass printed "10 failed" with 24 trials "skipped" and no reason: vitest-evals' reporter
  // drops vitest's "Failed Suites" summary for a run of eval files alone. These two task files fail the same two ways:
  // one does not load (chess.js was missing), one's hook throws before its trial (a sweep was refused). They are
  // written for the run, inside the repository so vitest resolves, and outside evals/tasks so no eval run takes them.
  const dir = scratchDir('silent-suites', join(REPO, 'bench-artifacts'));

  writeFileSync(join(dir, 'vitest.config.mjs'), "export default { test: { include: ['*.eval.ts'], globals: true } };\n");
  writeFileSync(join(dir, 'import-throws.eval.ts'), "throw new Error(\"the task file did not load: Cannot find package 'chess.js'\");\n");

  writeFileSync(join(dir, 'hook-throws.eval.ts'), [
    "describe('hook-throws', () => {",
    "  beforeAll(() => { throw new Error('the suite hook failed: no such table: workspace_identity'); });",
    "  test('trial 1', () => undefined);",
    '});',
  ].join('\n'));

  const run = spawnSync('bun', ['--bun', join(REPO, 'node_modules/.bin/vitest'), 'run', '--root', dir,
    '--config', join(dir, 'vitest.config.mjs'), `--reporter=${join(REPO, 'evals/src/reporter.ts')}`], { cwd: REPO, encoding: 'utf8' });

  const output = `${run.stdout}${run.stderr}`;

  expect(run.status, output).toBe(1);
  expect(output).toContain('Failed suites 2: their trials did not run');
  expect(output).toContain("import-throws.eval.ts: the task file did not load: Cannot find package 'chess.js'");
  expect(output).toContain('hook-throws.eval.ts > hook-throws: the suite hook failed: no such table: workspace_identity');
});
