#!/usr/bin/env bun

import { join } from 'node:path';
import { isRunnableSuite, trackedFiles } from './sources';

export const CLI_TEST_ROOT = 'packages/cli/tests';
const REPO_ROOT = join(import.meta.dir, '..');
const CONTENTION_SENSITIVE = 'behavior.test.ts';

function run(files: readonly string[]): void {
  const result = Bun.spawnSync(
    [process.execPath, 'test', '--parallel=4', ...files],
    { cwd: REPO_ROOT, env: process.env, stdout: 'inherit', stderr: 'inherit' },
  );
  if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
}

function main(): void {
  const files = trackedFiles()
    .filter((file) => file.startsWith(`${CLI_TEST_ROOT}/`) && isRunnableSuite(file))
    .map((file) => file.slice(CLI_TEST_ROOT.length + 1))
    .sort();
  if (!files.includes(CONTENTION_SENSITIVE)) {
    throw new Error(`${CONTENTION_SENSITIVE} is absent from ${CLI_TEST_ROOT}`);
  }
  const slow = `${CLI_TEST_ROOT}/${CONTENTION_SENSITIVE}`;
  const parallel = files
    .filter((name) => name !== CONTENTION_SENSITIVE)
    .map((name) => `${CLI_TEST_ROOT}/${name}`);
  if (parallel.length === 0) throw new Error(`No parallel CLI tests found under ${CLI_TEST_ROOT}`);

  console.log(`CLI tests: isolated ${CONTENTION_SENSITIVE}, then ${String(parallel.length)} files at parallel=4`);
  run([slow]);
  run(parallel);
}

if (import.meta.main) main();
