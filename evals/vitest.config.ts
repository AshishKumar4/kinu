/**
 * The eval suite's runner: `bun run evals [evals/tasks/<id>.eval.ts]`, under Bun like every suite
 * here. One task file is one task; its trials run at once, each on its own workspace, so a file
 * takes as long as its slowest trial. Two files run at a time.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { promptText } from '../packages/cf-backend/vite-prompt-text';

export default defineConfig({
  plugins: [promptText()],
  test: {
    name: 'evals',
    root: fileURLToPath(new URL('..', import.meta.url)),
    include: ['evals/tasks/**/*.eval.ts'],
    environment: 'node',
    setupFiles: ['./scripts/test-preload-vitest.ts'],
    // A trial ends when the deployment says its turns ended; nothing here races the agent's work.
    testTimeout: 0,
    hookTimeout: 0,
    maxConcurrency: 10,
    maxWorkers: 2,
    env: {
      // A recording would serialise tool input and output verbatim; none is made.
      VITEST_EVALS_REPLAY_MODE: 'off',
    },
  },
});
