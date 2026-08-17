/**
 * MUST RUN UNDER BUN: `bun --bun vitest run --config vitest.evals.config.ts`.
 *
 * Not a preference. The spine under test reaches `bun:sqlite` — the agent's
 * whole store is a Bun `Database` (`packages/test-utils/src/sql.ts:7`,
 * `cli-backend/src/runtime.ts`) — and under Node-hosted vitest the suite fails
 * at import with "Cannot find package 'bun:sqlite'". Measured: node-hosted
 * collects 0 tests, Bun-hosted collects 20. `scripts/eval-tier.sh` spells it
 * correctly; this note exists so a hand-run does too.
 */
import { defineConfig } from 'vitest/config';

/**
 * The eval tier's runner. Separate from `packages/cf-backend/vitest.config.ts`
 * on purpose, and it does not touch it.
 *
 * WHY A SECOND CONFIG RATHER THAN A ROOT `projects` ARRAY. The workers pool is a
 * VITE PLUGIN in 0.21.3, so a shared root config would have to scope that plugin
 * to one project entry, and `scripts/ladder.test.ts` asserts the literal string
 * `include: ['tests/workerd/**\/*.test.ts']` inside the cf-backend config as half
 * of the proof that the vitest side names exactly the directory bunfig excludes.
 * Restructuring that would move an assertion for no gain here. Two configs, one
 * vitest version, disjoint includes.
 *
 * WHY `*.eval.ts` AND NOT `*.eval.test.ts`. `bun test` matches only
 * `*.test.*` / `*_test.*` / `*.spec.*`, verified empirically — a directory
 * holding `sample.eval.ts` and `sample.test.ts` runs ONE file. So this tier is
 * disjoint from `bun test ./tests/` by FILE EXTENSION rather than by a second
 * `bunfig.toml` ignore pattern somebody has to maintain in step. That also keeps
 * the four existing bun eval suites under `tests/evals/` exactly where they are,
 * and leaves `ladder.ts`'s `TEST_FILE` (`/\.test\.(ts|tsx|js)$/`) blind to these
 * files, so they create no orphan gate and do not move its pinned file count.
 *
 * NO REPLAY. `VITEST_EVALS_REPLAY_MODE` defaults to `auto`, which RECORDS when no
 * recording exists, and a recording serialises tool `input` and `output`
 * verbatim — for an agent harness that is where an `Authorization: Bearer` lands.
 * A synthetic `ptc_` token was measured surviving verbatim into
 * `.vitest-evals/recordings/`. Sanitising is per-tool and opt-in, so one unhooked
 * tool is enough to leak. This tier turns the mode off outright; `.vitest-evals/`
 * is also gitignored so an accidental recording cannot become a tracked file.
 */
export default defineConfig({
  test: {
    name: 'evals',
    include: ['tests/evals/**/*.eval.ts'],
    environment: 'node',
    // One task is a full agent episode against a remote model: minutes, not
    // seconds. A default 5s timeout would report the tier as broken.
    testTimeout: 1_800_000,
    hookTimeout: 300_000,
    // Each file drives real model calls against one account. Running them
    // concurrently buys little and makes rate-limit failures look like
    // behavioural findings.
    fileParallelism: false,
    env: {
      VITEST_EVALS_REPLAY_MODE: 'off',
    },
  },
});
