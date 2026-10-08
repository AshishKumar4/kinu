/**
 * The eval suite's runner: `bun run evals [evals/tasks/<id>.eval.ts]`, under Bun like every suite
 * here. One task file is one task, each trial on its own workspace. Every file runs at once, each in
 * its own worker, and every trial of a file at once unless `KINU_EVAL_FILES` and `KINU_EVAL_CONCURRENCY` cap them: a trial
 * waits on the deployment and its model, so the suite takes as long as its slowest trial.
 */
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { promptText } from '../packages/cf-backend/vite-prompt-text';
import { evalConcurrency, evalFiles } from './src/config';

const TASK_FILES = readdirSync(new URL('tasks', import.meta.url)).filter((name) => name.endsWith('.eval.ts')).length;

export default defineConfig({
  plugins: [promptText()],
  test: {
    name: 'evals',
    root: fileURLToPath(new URL('..', import.meta.url)),
    // `bun run evals:reactive` runs §8's reactive-user run over the same tasks instead.
    include: process.env.KINU_REACTIVE === '1' ? ['evals/reactive/*.run.ts'] : ['evals/tasks/**/*.eval.ts'],
    outputFile: { json: `${process.env.BENCH_ARTIFACTS ?? 'bench-artifacts/evals'}/results.json` },
    environment: 'node',
    // Bun already gives an external module its own exports, a CommonJS one included, and vitest's default-export
    // interop misreads them there: a Bun module namespace answers `'__esModule' in ns`, so a package whose default
    // export is a namespace is swapped for that namespace. zod's `export default z` made `import { z } from 'zod'`
    // undefined in every suite that reached core (2026-09-25; vitest 4.1.11, bun 1.4.0).
    deps: { interopDefault: false },
    setupFiles: ['./scripts/test-preload-vitest.ts'],
    // A trial ends when the deployment says its turns ended; nothing here races the agent's work.
    testTimeout: 0,
    hookTimeout: 0,
    maxConcurrency: evalConcurrency(process.env),
    maxWorkers: Math.min(TASK_FILES, evalFiles(process.env)),
    env: {
      // A recording would serialise tool input and output verbatim; none is made.
      VITEST_EVALS_REPLAY_MODE: 'off',
    },
  },
});
