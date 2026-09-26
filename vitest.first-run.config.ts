/**
 * MUST RUN UNDER BUN: `bun --bun vitest run --config vitest.first-run.config.ts`.
 *
 * Not a preference, and for two reasons this tier cannot avoid: the pty case
 * drives `Bun.spawnSync` through `packages/cli/tests/helpers/pty-screen.ts`, and
 * the public session opens a WebSocket with headers, which is Bun's
 * constructor. `scripts/first-run-tier.sh` spells the invocation correctly; this
 * note exists so a hand-run does too.
 *
 * WHY A CONFIG OF ITS OWN, beside `evals/vitest.config.ts`. The subject is
 * different: the eval suite measures how well the agent does a task, ten trials
 * each, and reports pass rates; this tier checks that each defect a person found
 * by hand stays fixed, once per deploy, and every row must pass. Folding them
 * into one config would make "which question did this answer" unanswerable from
 * the invocation.
 *
 * WHY `*.first-run.ts` AND NOT `*.test.ts` OR `*.eval.ts`. Three runners must
 * not be able to reach each other's files. `bun test` selects only
 * `*.test.*`/`*.spec.*`/`*_test.*`/`*_spec.*` — so `bun test ./tests/`, a
 * pre-deploy gate, cannot pick these up and try to drive a deployment that does
 * not exist yet. `evals/vitest.config.ts`'s include is `evals/tasks/**` — so the
 * eval suite cannot pick them up either, and `claims()` cannot credit a gate with
 * a file it never runs. The partition is by FILE EXTENSION and DIRECTORY rather
 * than by an ignore list somebody has to keep in step.
 *
 * TWO PROJECTS, RUN SIDE BY SIDE by `scripts/first-run-tier.sh`. Every case
 * opens its own fresh workspace, so cases do not share a workspace, a chat or a
 * file. They share one ACCOUNT, and its device fleet — every machine live on
 * it (docs/EXECUTION-LAYER-SPEC.md) — reaches past the workspace: a live
 * machine sits in every workspace's executor roster and in its agent's
 * context, and the TUI on this host hides its connect card while one carries
 * this host's name. So every case that reads the fleet runs one at a time in
 * `first-run-fleet`: the cases that attach a machine and the cases that drive
 * the TUI, both derived from what they import, and the cases whose verdict
 * reads an executor, declared below with the reason. Every other case runs
 * concurrently in `first-run-cases`.
 *
 * The credential-free half of the tier is `tests/first-run/wiring.test.ts` — a
 * `.test.ts` deliberately, so the existing `bun test ./tests/` gate runs it at
 * ci and at deploy, before anything is deployed and at no cost.
 */
import { configDefaults, defineConfig } from 'vitest/config';
import { promptText } from './packages/cf-backend/vite-prompt-text';
import { modulesReaching } from './scripts/import-closure';
import { isFirstRunSuite, isParseable, readMatching, trackedFiles } from './scripts/sources';

/** The one glob that decides what this tier runs. `wiring.test.ts` holds it
 *  equal to the corpus on disk, so a case file that lands outside it is a
 *  failure rather than a suite nobody runs. */
export const FIRST_RUN_INCLUDE = 'tests/first-run/**/*.first-run.ts';

/** The module that attaches a real machine to the account. */
export const FLEET_MODULE = 'tests/first-run/daemon.ts';

/** The harness that drives the real TUI on this host, whose connect card
 *  reads the fleet (`shouldOfferDeviceConnect`, packages/cli/src/device-connect.ts). */
export const TUI_HARNESS = 'packages/cli/tests/helpers/pty-screen.ts';

/** Cases that attach no machine and drive no TUI but whose verdict reads an
 *  executor, where a live fleet machine can be the one the agent picks. */
export const EXECUTOR_READERS = {
  'every-tool': 'the row reads what the agent\'s shell, file and codemode calls left on an executor',
  'codemode-craft': 'the crafted body runs on an executor the agent picks',
  'sandbox-mount-write': 'the row reads the /sandbox mount the agent wrote through',
  'slate': 'the agent builds and serves the slate from an executor',
  'background-settle': 'the detached job the row waits on runs on an executor the agent picks',
  'files-outside-tree': 'the row reads an executor\'s file plane',
  'command-refusal': 'the row reads an executor\'s refusal and its approval queue',
  'workspace-panes': 'the row diffs the file the agent wrote, which a live machine could have taken',
} as const;

/** The two projects, by the names `scripts/first-run-tier.sh` selects. */
export const FIRST_RUN_PROJECTS = { fleet: 'first-run-fleet', cases: 'first-run-cases' } as const;

const caseFile = (id: string): string => `tests/first-run/${id}.first-run.ts`;

/** The case files that read the account's device fleet: every case whose
 *  import closure reaches {@link FLEET_MODULE} or {@link TUI_HARNESS}, and
 *  every one of `readers`. */
export function fleetCases(
  sources: ReadonlyMap<string, string> = readMatching((file) => (file.startsWith('tests/first-run/') || file === TUI_HARNESS) && isParseable(file)),
  readers: readonly string[] = Object.keys(EXECUTOR_READERS),
): string[] {
  const reaching = modulesReaching(sources, (file) => file === FLEET_MODULE || file === TUI_HARNESS);

  return [...new Set([...[...reaching].filter(isFirstRunSuite), ...readers.map(caseFile)])].sort();
}

const fleet = fleetCases();

const others = trackedFiles().filter((file) => isFirstRunSuite(file) && !fleet.includes(file));

export default defineConfig({
  plugins: [promptText()],
  test: {
    name: 'first-run',
    include: [FIRST_RUN_INCLUDE],
    environment: 'node',
    // Bun already gives an external module its own exports, a CommonJS one included, and vitest's default-export
    // interop misreads them there: a Bun module namespace answers `'__esModule' in ns`, so a package whose default
    // export is a namespace is swapped for that namespace. zod's `export default z` made `import { z } from 'zod'`
    // undefined in every suite that reached core (2026-09-25; vitest 4.1.11, bun 1.4.0).
    deps: { interopDefault: false },
    // The same throwaway KINU_HOME every bun test process gets. Load-bearing
    // here rather than hygiene: the pty case runs the real CLI, which roots a
    // checkpoint engine under `$KINU_HOME`, and the device cases install real
    // daemons — none of that may reach the developer's own `~/.kinu`.
    setupFiles: ['./scripts/test-preload-vitest.ts'],
    // A case is a deployed episode: the scripted model, two real daemons, a real pty.
    // Its completion is decided by the episode, never by elapsed wall time. `0`
    // is Vitest's documented disabled-timeout value.
    testTimeout: 0,
    hookTimeout: 0,
    env: {
      // No replay, for the reason the eval tier states: a recording serialises
      // tool input and output verbatim, which for this tier is where a device
      // token lands.
      VITEST_EVALS_REPLAY_MODE: 'off',
    },
    // Each project is the whole include minus the other's cases: an extending
    // project's `include` is merged with the root's rather than replacing it.
    projects: [
      { extends: true, test: { name: FIRST_RUN_PROJECTS.fleet, maxWorkers: 1, exclude: [...configDefaults.exclude, ...others] } },
      { extends: true, test: { name: FIRST_RUN_PROJECTS.cases, exclude: [...configDefaults.exclude, ...fleet] } },
    ],
  },
});
