/**
 * What the agent's own workspace can execute, measured through the shell the
 * agent actually gets.
 *
 * Opens the workspace exactly as `createCLIRuntime` does — `createWorkspace`
 * over a real `bun:sqlite` database — and runs one command per toolchain,
 * printing the exit code, the wall-clock, and the first output line verbatim.
 *
 * Exists because "the workspace has python" is a claim about a shell registry,
 * and the only way to read a shell registry is to ask the shell. The first
 * `python3` pays for the install; every one after it does not, and the second
 * column is where that shows.
 *
 *   bun scripts/nimbus-runtime-probe.ts            # as the CLI opens it
 *   bun scripts/nimbus-runtime-probe.ts --bare     # with no runtimes supplied
 */
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimePackage } from '@nimbus-sh/core/runtime/runtime-package.js';
import bashRuntime from '@nimbus-sh/runtime-bash';
import cpythonRuntime from '@nimbus-sh/runtime-cpython';
import { createWorkspace, nextWorkspaceGeneration } from '@kinu.run/core/workspace';
import { nimbusSql, localTransactions } from '../packages/cli-backend/src/runtime';

const PROBES = [
  'node --version',
  'python3 --version',
  'python3 --version',
  'python3 -c "import sys, json; print(json.dumps({\'v\': sys.version_info.major}))"',
  'python --version',
  'pip --version',
  'bash --version',
  "bash -c 'for i in 1 2 3; do echo line-$i; done'",
  'npm --version',
  'npx --version',
  'git --version',
  'sh -c "echo ok"',
  'bun --version',
  'make --version',
];

// Only the manifests are read at import time; the blobs stay on disk until a
// provisioned command is invoked.
const runtimes: readonly RuntimePackage[] = process.argv.includes('--bare')
  ? []
  : [bashRuntime, cpythonRuntime];

const db = new Database(join(mkdtempSync(join(tmpdir(), 'nimbus-probe-')), 'probe.db'));
const sql = nimbusSql(db);

const opened = performance.now();
const workspace = createWorkspace({
  sql,
  transactions: localTransactions(db),
  generation: nextWorkspaceGeneration(sql),
  runtimes,
});
// `createWorkspace` returns over a workspace that is still opening; the first
// call is what awaits the boot, so time it separately from the probes.
await workspace.stats();
console.log(`runtimes supplied: ${runtimes.length}   open: ${(performance.now() - opened).toFixed(0)}ms\n`);

for (const command of PROBES) {
  const started = performance.now();
  const result = await workspace.shell.exec(command);
  const elapsed = performance.now() - started;
  const out = (result.stdout || result.stderr).split('\n').find((l) => l.trim()) ?? '';
  console.log(
    `exit ${String(result.exitCode).padStart(3)}  ${String(elapsed.toFixed(0)).padStart(5)}ms  `
    + `${command.slice(0, 46).padEnd(46)}  ${out.trim().slice(0, 76)}`,
  );
}
