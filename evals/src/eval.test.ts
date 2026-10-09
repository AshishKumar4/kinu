import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { runToExit, scratchDir } from '@kinu.run/test-utils';

const REPO = join(import.meta.dirname, '../..');

test('every task file loads under the eval runner, as a run collects it', async () => {
  // Task files load only under vitest's module transform, never under `bun test`, which reads what that transform does
  // not: on 2026-10-07 the browser checks imported a harness reading Bun's `import.meta.dir`, and every task file
  // would have failed to load on the next deploy. A loopback origin needs no identity, and the name filter runs no trial.
  const run = await runToExit(['bun', '--bun', join(REPO, 'node_modules/.bin/vitest'), 'run', '--config', join(REPO, 'evals/vitest.config.ts'),
    '--testNamePattern', '^no trial is named this$', '--passWithNoTests'], {
    env: { ...process.env, KINU_EVAL_ORIGIN: 'http://127.0.0.1:9', KINU_EVAL_COMMIT: '0000000', BENCH_ARTIFACTS: scratchDir('eval-collection', join(REPO, 'bench-artifacts')) },
    cwd: REPO,
  });

  const output = `${run.stdout}${run.stderr}`;

  expect({ status: run.exitCode, failed: output.split('\n').filter((line) => /\bFAIL\b|Failed Suites/.test(line)) }).toEqual({ status: 0, failed: [] });
});
