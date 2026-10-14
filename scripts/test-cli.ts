#!/usr/bin/env bun

import { isRunnableSuite, trackedFiles } from './sources';
import { REPO_ROOT } from './repo-root';

export const CLI_TEST_ROOT = 'packages/cli/tests';


/** `--part=serial` runs the isolated and subprocess-heavy files, `--part=parallel` the rest: CI runs each as a task of
 *  its own (the ladder row's `ciParts`); with neither, both, in that order. */
const PART = process.argv.find((argument) => argument.startsWith('--part='))?.slice('--part='.length);

const TEST_FLAGS = process.argv.slice(2).filter((argument) => !argument.startsWith('--part='));

const ISOLATED = [
  'behavior.test.ts',
  'chat-app.test.tsx',
  'chat-app-consent.test.tsx',
  'tui.test.tsx',
  'tui-messages.test.tsx',
  'tui-product-onboarding.test.tsx',
  'tui-product-shell.test.tsx',
  'tui-product-hubs.test.tsx',
] as const;

const SUBPROCESS_HEAVY = [
  'device-connect.test.ts',
  'local-model-resolver.test.ts',
  'local-run-events.test.ts',
  'profiles.test.ts',
] as const;

function run(files: readonly string[], parallel: number): void {
  const result = Bun.spawnSync(
    [process.execPath, 'test', '--timeout=0', `--parallel=${String(parallel)}`, ...TEST_FLAGS, ...files],
    { cwd: REPO_ROOT, stdout: 'inherit', stderr: 'inherit' },
  );

  if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
}

/** The suite's files as it runs them: each isolated file alone, the subprocess-heavy ones at parallel=2, the rest at 4. */
export function cliStages(tracked: readonly string[]) {
  const files = tracked
    .filter((file) => file.startsWith(`${CLI_TEST_ROOT}/`) && isRunnableSuite(file))
    .map((file) => file.slice(CLI_TEST_ROOT.length + 1))
    .sort();

  for (const required of [...ISOLATED, ...SUBPROCESS_HEAVY]) {
    if (!files.includes(required)) {
      throw new Error(`${required} is absent from ${CLI_TEST_ROOT}`);
    }
  }

  const parallel = files
    .filter((name) => !ISOLATED.some((isolatedName) => isolatedName === name))
    .filter((name) => !SUBPROCESS_HEAVY.some((heavy) => heavy === name))
    .map((name) => `${CLI_TEST_ROOT}/${name}`);

  if (parallel.length === 0) throw new Error(`No parallel CLI tests found under ${CLI_TEST_ROOT}`);

  return {
    isolated: ISOLATED.map((name) => `${CLI_TEST_ROOT}/${name}`),
    subprocessHeavy: SUBPROCESS_HEAVY.map((name) => `${CLI_TEST_ROOT}/${name}`),
    parallel,
  };
}

function main(): void {
  if (PART !== undefined && PART !== 'serial' && PART !== 'parallel') throw new Error(`--part=${PART}: the parts are serial and parallel`);
  const { isolated, subprocessHeavy, parallel } = cliStages(trackedFiles());

  console.log(
    `CLI tests: isolated ${ISOLATED.join(', ')}, `
    + `${SUBPROCESS_HEAVY.length} subprocess-heavy files at parallel=2, `
    + `${String(parallel.length)} other files at parallel=4${PART === undefined ? '' : `; this run: the ${PART} part`}`,
  );

  if (PART !== 'parallel') {
    for (const file of isolated) run([file], 1);
    run(subprocessHeavy, 2);
  }

  if (PART !== 'serial') run(parallel, 4);
}

if (import.meta.main) main();
