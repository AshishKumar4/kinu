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
 * `*.test.*` / `*_test.*` / `*.spec.*` / `*_spec.*`, verified empirically — a
 * directory holding `a.test.ts`, `c.spec.ts`, `d_test.ts`, `e_spec.ts`,
 * `g.test.tsx`, `b.eval.ts` and `f.eval.tsx` runs FIVE files under bun 1.4.0,
 * and neither `.eval.` one is among them. So this tier is disjoint from
 * `bun test ./tests/` by FILE EXTENSION rather than by a second `bunfig.toml`
 * ignore pattern somebody has to maintain in step. That also keeps the existing
 * bun eval suites under `tests/evals/` exactly where they are.
 *
 * IT IS NOT INVISIBLE TO THE LADDER, and the note that said it was cost four
 * suites their coverage. This file used to claim `ladder.ts`'s `TEST_FILE` was
 * `/\.test\.(ts|tsx|js)$/` and therefore blind to `*.eval.ts`. `ladder.ts` holds
 * no pattern of its own any more: its denominator is `isRunnableSuite`, one arm
 * of the anti-slop rule's `TEST_SUFFIX`, which matches `.eval.` deliberately —
 * so these files ARE in the ladder's denominator, and a `claims()` that swept a
 * directory prefix credited `bun test ./tests/` with all four of them. Four live
 * eval suites read as covered by a ci-tier bun gate that cannot select any of
 * them. `claims()` now narrows by `isBunDiscoverableSuite`, `bun run test:eval`
 * claims this tier's files, and `scripts/ladder.test.ts` pins both halves of the
 * partition by equality.
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
    // The SAME throwaway KINU_HOME every `bun test` process gets, because
    // `bunfig.toml`'s `preload` reaches only bun's runner and this tier is
    // vitest. It is load-bearing here, not hygiene: the behaviour harness opens
    // the workspace through `createCLIRuntime`, which roots a shadow-git
    // checkpoint engine at `$KINU_HOME/checkpoints`
    // (cli-backend/src/checkpoints.ts:52) and snapshots on every host-FS
    // mutation. `kinuHome()` falls back to `~/.kinu`, and measured here
    // before this line existed, `KINU_HOME` was UNSET under this config — so
    // a live eval run wrote checkpoint stores into the developer's real home,
    // which is the same defect that once put ~580 of them there.
    // The VITEST entry, not `bun test`'s. Both are three lines over the same
    // `scripts/test-scratch-home.ts`; they differ only in which runner's
    // `afterAll` they register, and pointing this at the bun one throws `Cannot
    // use afterAll() outside of the test runner` and fails the tier at
    // collection.
    setupFiles: ['./scripts/test-preload-vitest.ts'],
    // One task is a full agent episode against a remote model. Its completion
    // is decided by the episode, never by elapsed wall time. `0` is Vitest's
    // documented disabled-timeout value; operator cancellation is persisted as
    // `incomplete` by the behaviour runner instead of being turned into a
    // pass/fail verdict here.
    testTimeout: 0,
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
