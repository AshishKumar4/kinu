#!/usr/bin/env bun

import { join } from 'node:path';
import { isRunnableSuite, trackedFiles } from './sources';

export const CLI_TEST_ROOT = 'packages/cli/tests';
const REPO_ROOT = join(import.meta.dir, '..');
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
function run(files: readonly string[], parallel: number): void {
  const result = Bun.spawnSync(
    [process.execPath, 'test', `--parallel=${String(parallel)}`, ...files],
    { cwd: REPO_ROOT, env: process.env, stdout: 'inherit', stderr: 'inherit' },
  );
  if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
}

function main(): void {
  const files = trackedFiles()
    .filter((file) => file.startsWith(`${CLI_TEST_ROOT}/`) && isRunnableSuite(file))
    .map((file) => file.slice(CLI_TEST_ROOT.length + 1))
    .sort();
  for (const isolated of ISOLATED) {
    if (!files.includes(isolated)) {
      throw new Error(`${isolated} is absent from ${CLI_TEST_ROOT}`);
    }
  }
  const isolated = ISOLATED.map((name) => `${CLI_TEST_ROOT}/${name}`);
  const parallel = files
    .filter((name) => !ISOLATED.some((isolated) => isolated === name))
    .map((name) => `${CLI_TEST_ROOT}/${name}`);
  if (parallel.length === 0) throw new Error(`No parallel CLI tests found under ${CLI_TEST_ROOT}`);

  console.log(`CLI tests: isolated ${ISOLATED.join(', ')}, then ${String(parallel.length)} files at parallel=4`);
  for (const file of isolated) run([file], 1);
  run(parallel, 4);
}

if (import.meta.main) main();
