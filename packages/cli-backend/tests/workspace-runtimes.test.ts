/** The workspace toolchain, asserted through shell exit codes: an unregistered runtime is still `command not found`. */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { scratchPath } from '@kinu.run/test-utils';
import type { RuntimePackage } from '@nimbus-sh/core/runtime/runtime-package.js';
import { localFacetHost } from '@nimbus-sh/core/runtime/local-facet-host.js';
import bashRuntime from '@nimbus-sh/runtime-bash';
import cpythonRuntime from '@nimbus-sh/runtime-cpython';
import { createWorkspace, workspaceGenerationStorage } from '@kinu.run/core/workspace';
import type { WorkspaceBundle } from '@kinu.run/core/workspace';
import { inlineWorkspaceStorage } from '@kinu.run/core/identity';

const RUNTIMES: readonly RuntimePackage[] = [bashRuntime, cpythonRuntime];

const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function open(path: string, runtimes: readonly RuntimePackage[] = RUNTIMES): WorkspaceBundle {
  const database = new Database(path);
  databases.push(database);
  const storage = inlineWorkspaceStorage(database);

  return createWorkspace({
    ...storage,
    generation: workspaceGenerationStorage(storage.sql),
    runtimes,
    runtimeFacets: localFacetHost(),
  });
}

const dbPath = () => scratchPath('workspace-runtimes', 'workspace.db');

describe('workspace runtime provisioning', () => {
  test('python, pip and bash run, and the interpreter is the one the manifest names', async () => {
    const workspace = open(dbPath());

    const python = await workspace.shell.exec('python3 --version');
    expect(python.exitCode).toBe(0);
    expect(python.stdout).toContain('Python 3.13.14');

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
  });

  test('npm and npx answer without any runtime package, because they need no bytes', async () => {
    const workspace = open(dbPath(), []);

    expect(await workspace.shell.exec('npm --version')).toMatchObject({ exitCode: 0, stdout: '10.0.0\n' });
    expect(await workspace.shell.exec('npx --version')).toMatchObject({ exitCode: 0, stdout: '10.0.0\n' });
    expect(await workspace.shell.exec('npm init -y')).toMatchObject({ exitCode: 0 });
    expect(await workspace.vfs.exists('package.json')).toBe(true);
  });

  test('nothing is installed until a provisioned command is invoked', async () => {
    const workspace = open(dbPath());

    // Present before any command runs: provisioning happens on the workspace-open path.
    expect(await workspace.vfs.exists('/home/main/.nimbus/runtimes')).toBe(false);
    expect(await workspace.shell.exec('python3 --version')).toMatchObject({ exitCode: 0 });
    expect(await workspace.vfs.exists('/home/main/.nimbus/runtimes/cpython/3.13.14/manifest.json')).toBe(true);
    expect(await workspace.vfs.exists('/home/main/.nimbus/runtimes/bash')).toBe(false);
  });

  test('a runtime a previous session installed survives a reopen', async () => {
    const path = dbPath();
    const first = open(path);
    expect(await first.shell.exec('python3 --version')).toMatchObject({ exitCode: 0 });

    // An evicted Durable Object returns with the filesystem and an empty command registry; boot must re-register.
    const reopened = open(path);
    const python = await reopened.shell.exec('python3 --version');
    expect(python.exitCode).toBe(0);
    expect(python.stdout).toContain('Python 3.13.14');
  });

  test('with no runtime packages supplied the workspace says so, rather than pretending', async () => {
    const workspace = open(dbPath(), []);

    const python = await workspace.shell.exec('python3 --version');
    expect(python.exitCode).toBe(127);
    expect(python.stderr).toContain('command not found');
  });

  test('git is not claimed locally — @nimbus-sh/core ships no git implementation', async () => {
    const workspace = open(dbPath());

    // Hosted git comes from @nimbus-sh/worker (dist/git/commands.js:217), not @kinu.run/core; the gap is asserted so closing
    // it is deliberate. Asked via `type`, which reads the command registry rather than spawning host git.
    const resolved = await workspace.shell.exec('type git');
    expect(resolved.exitCode).not.toBe(0);
    expect(`${resolved.stdout}${resolved.stderr}`).toContain('not found');
  });
});
