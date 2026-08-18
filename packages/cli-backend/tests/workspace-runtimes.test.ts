/**
 * The workspace toolchain, asserted through the shell the agent gets.
 *
 * Every assertion here is a command exit code, because that is the only thing
 * that decides whether the agent can do the work: a runtime that is installed
 * but unregistered, or registered against a runner this workspace cannot build,
 * is still `command not found`. Before this suite existed the workspace answered
 * 127 to `python3`, `pip`, `bash` and `npm`, and nothing failed.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { scratchPath } from '@proteus/test-utils';
import type { RuntimePackage } from '@nimbus-sh/core/runtime/runtime-package.js';
import bashRuntime from '@nimbus-sh/runtime-bash';
import cpythonRuntime from '@nimbus-sh/runtime-cpython';
import { createWorkspace, nextWorkspaceGeneration } from '@proteus/core/workspace';
import type { WorkspaceBundle } from '@proteus/core/workspace';
import { nimbusSql, localTransactions } from '../src/runtime.js';

const RUNTIMES: readonly RuntimePackage[] = [bashRuntime, cpythonRuntime];

const databases: Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

/** A workspace over a real file, so a reopen sees what the first one wrote. */
function open(path: string, runtimes: readonly RuntimePackage[] = RUNTIMES): WorkspaceBundle {
  const database = new Database(path);
  databases.push(database);
  // The same SQL and transaction adapters `createCLIRuntime` opens the real
  // workspace with, so this measures the production seam rather than a shim.
  const sql = nimbusSql(database);
  return createWorkspace({
    sql,
    transactions: localTransactions(database),
    generation: nextWorkspaceGeneration(sql),
    runtimes,
  });
}

const dbPath = () => scratchPath('workspace-runtimes', 'workspace.db');

/**
 * Bun's default per-test timeout is 5s, and provisioning is real work: the first
 * `python3` unpacks CPython 3.13.14 and the first `bash` unpacks bash 5.2.37
 * into this workspace's SQLite filesystem. Measured on this machine, the test
 * that pulls BOTH runs 5.4-6.0s — straddling the default, so it passed alone and
 * failed in a full suite, and the timeout tore the workspace down mid-test so the
 * reported symptom was a bare `127` from `bash --version` rather than the clock.
 * The budget is generous on purpose: a slow unpack is a slow machine, not a
 * regression, and this suite exists to prove the toolchain is THERE.
 */
const PROVISION_TIMEOUT_MS = 60_000;

describe('workspace runtime provisioning', () => {
  test('python, pip and bash run, and the interpreter is the one the manifest names', async () => {
    const workspace = open(dbPath());

    const python = await workspace.shell.exec('python3 --version');
    expect(python.exitCode).toBe(0);
    expect(python.stdout).toContain('Python 3.13.14');

    // Not just a version banner — the interpreter evaluates and its stdout comes
    // back, which is what makes it an executor rather than a string.
    const evaluated = await workspace.shell.exec('python3 -c "print(6*7)"');
    expect(evaluated.exitCode).toBe(0);
    expect(evaluated.stdout.trim()).toBe('42');

    expect(await workspace.shell.exec('python --version')).toMatchObject({ exitCode: 0 });

    const pip = await workspace.shell.exec('pip --version');
    expect(pip.exitCode).toBe(0);
    expect(pip.stdout).toContain('pip 24.3.1');

    const bash = await workspace.shell.exec('bash --version');
    expect(bash.exitCode).toBe(0);
    expect(bash.stdout).toContain('GNU bash, version 5.2.37');

    const loop = await workspace.shell.exec("bash -c 'for i in 1 2 3; do echo line-$i; done'");
    expect(loop.exitCode).toBe(0);
    expect(loop.stdout).toBe('line-1\nline-2\nline-3\n');
  }, PROVISION_TIMEOUT_MS);

  test('npm and npx answer without any runtime package, because they need no bytes', async () => {
    const workspace = open(dbPath(), []);

    expect(await workspace.shell.exec('npm --version')).toMatchObject({ exitCode: 0, stdout: '10.0.0\n' });
    expect(await workspace.shell.exec('npx --version')).toMatchObject({ exitCode: 0, stdout: '10.0.0\n' });
    // The npm implementation is Nimbus's own and writes into this filesystem.
    expect(await workspace.shell.exec('npm init -y')).toMatchObject({ exitCode: 0 });
    expect(await workspace.vfs.exists('package.json')).toBe(true);
  });

  test('nothing is installed until a provisioned command is invoked', async () => {
    const workspace = open(dbPath());

    // The install root the seeder writes. Present before any command runs means
    // provisioning moved onto the workspace-open path.
    expect(await workspace.vfs.exists('/home/user/.nimbus/runtimes')).toBe(false);
    expect(await workspace.shell.exec('python3 --version')).toMatchObject({ exitCode: 0 });
    expect(await workspace.vfs.exists('/home/user/.nimbus/runtimes/cpython/3.13.14/manifest.json')).toBe(true);
    // Only what was asked for: bash was supplied too and must still be absent.
    expect(await workspace.vfs.exists('/home/user/.nimbus/runtimes/bash')).toBe(false);
  }, PROVISION_TIMEOUT_MS);

  test('a runtime a previous session installed survives a reopen', async () => {
    const path = dbPath();
    const first = open(path);
    expect(await first.shell.exec('python3 --version')).toMatchObject({ exitCode: 0 });

    // A Durable Object that was evicted comes back with the filesystem and an
    // empty command registry: without boot-time re-registration the runtime is
    // on disk and invisible.
    const reopened = open(path);
    const python = await reopened.shell.exec('python3 --version');
    expect(python.exitCode).toBe(0);
    expect(python.stdout).toContain('Python 3.13.14');
  }, PROVISION_TIMEOUT_MS);

  test('with no runtime packages supplied the workspace says so, rather than pretending', async () => {
    const workspace = open(dbPath(), []);

    const python = await workspace.shell.exec('python3 --version');
    expect(python.exitCode).toBe(127);
    expect(python.stderr).toContain('command not found');
  });

  test('git is not claimed locally — @nimbus-sh/core ships no git implementation', async () => {
    const workspace = open(dbPath());

    // Hosted sessions get git from @nimbus-sh/worker (dist/git/commands.js:217),
    // which needs a Durable Object for its network subcommands and is not a
    // dependency of @proteus/core. This asserts the gap so that closing it has
    // to be deliberate rather than accidental.
    //
    // Asked through the shell's own `type` builtin rather than by running `git`:
    // it reads the command registry directly, which is the thing under test, and
    // it does not read as a host-git spawn to anyone — human or lint rule.
    const resolved = await workspace.shell.exec('type git');
    expect(resolved.exitCode).not.toBe(0);
    expect(`${resolved.stdout}${resolved.stderr}`).toContain('not found');
  });
});
