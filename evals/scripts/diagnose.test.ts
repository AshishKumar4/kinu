import { expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { childEnv, runToExit, scratchDir } from '@kinu.run/test-utils';

// Run 37725315387: every trial failed as infrastructure, `compare` wrote its refusal, and the review crashed parsing it.
test('legs that were not compared leave nothing to review, and no deployment is asked', async () => {
  const dir = scratchDir('diagnose-refused');
  const out = join(dir, 'why.md');

  writeFileSync(join(dir, 'comparison.json'), JSON.stringify({ refused: 'the candidate\'s report is not complete' }));

  const run = await runToExit([
    process.execPath, join(import.meta.dir, 'diagnose.ts'),
    '--results', join(dir, 'results.json'), '--comparison', join(dir, 'comparison.json'), '--evidence', dir, '--out', out,
  ], { env: childEnv({}) });

  expect(run.exitCode).toBe(0);
  expect(existsSync(out)).toBe(false);
});
