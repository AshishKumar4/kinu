/**
 * MUST RUN UNDER BUN: `bun --bun vitest run --config vitest.first-run.config.ts`.
 *
 * Not a preference, and for two reasons this tier cannot avoid: the pty case
 * drives `Bun.spawnSync` through `packages/cli/tests/helpers/pty-screen.ts`, and
 * the public session opens a WebSocket with headers, which is Bun's
 * constructor. `scripts/first-run-tier.sh` spells the invocation correctly; this
 * note exists so a hand-run does too.
 *
 * WHY A THIRD CONFIG, beside `vitest.evals.config.ts`. The subject is different
 * and so is WHEN it runs. The eval tier measures behaviour before a deploy, on
 * whichever target the knob names, and it is minutes to hours of model calls.
 * This tier runs AFTER a deploy, against the build that just landed, and it
 * refuses every other target. Folding them into one config would make "which
 * build did this measure" unanswerable from the invocation, which is the one
 * question a post-deploy claim rests on.
 *
 * WHY `*.first-run.ts` AND NOT `*.test.ts` OR `*.eval.ts`. Three runners must
 * not be able to reach each other's files. `bun test` selects only
 * `*.test.*`/`*.spec.*`/`*_test.*`/`*_spec.*` — so `bun test ./tests/`, a
 * pre-deploy gate, cannot pick these up and try to drive a deployment that does
 * not exist yet. `vitest.evals.config.ts`'s include is `tests/evals/**` — so the
 * eval tier cannot pick them up either, and `claims()` cannot credit an arm with
 * a file it never runs. The partition is by FILE EXTENSION and DIRECTORY rather
 * than by an ignore list somebody has to keep in step, which is the same
 * argument the eval config makes about `.eval.ts`.
 *
 * The credential-free half of the tier is `tests/first-run/wiring.test.ts` — a
 * `.test.ts` deliberately, so the existing `bun test ./tests/` gate runs it at
 * ci and at deploy, before anything is deployed and at no cost.
 */
import { defineConfig } from 'vitest/config';

/** The one glob that decides what this tier runs. `wiring.test.ts` holds it
 *  equal to the corpus on disk, so a case file that lands outside it is a
 *  failure rather than a suite nobody runs. */
export const FIRST_RUN_INCLUDE = 'tests/first-run/**/*.first-run.ts';

export default defineConfig({
  test: {
    name: 'first-run',
    include: [FIRST_RUN_INCLUDE],
    environment: 'node',
    // The same throwaway KINU_HOME every bun test process gets. Load-bearing
    // here rather than hygiene: the pty case runs the real CLI, which roots a
    // checkpoint engine under `$KINU_HOME`, and the device cases install real
    // daemons — none of that may reach the developer's own `~/.kinu`.
    setupFiles: ['./scripts/test-preload-vitest.ts'],
    // A case is a deployed episode: a real model, two real daemons, a real pty.
    // Its completion is decided by the episode, never by elapsed wall time. `0`
    // is Vitest's documented disabled-timeout value.
    testTimeout: 0,
    hookTimeout: 300_000,
    // One account, one deployment, and two cases that attach machines to it.
    // Concurrency here would have two cases racing each other's device fleet,
    // which is the very state the fleet case is measuring.
    fileParallelism: false,
    env: {
      // No replay, for the reason the eval tier states: a recording serialises
      // tool input and output verbatim, which for this tier is where a device
      // token lands.
      VITEST_EVALS_REPLAY_MODE: 'off',
    },
  },
});
