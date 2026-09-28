/**
 * The hosted Nimbus session's toolchain: `git` runs over the workspace filesystem with no DO behind local history,
 * and a runtime install without `NIMBUS_RUNTIME_CACHE` bound fails by binding name (why `python` is gated on it).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import { runGitCommand } from '@nimbus-sh/worker/git';
import { inlineWorkspaceStorage } from '@kinu.run/core/identity';

const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function openWorkspaceDatabase() {
  const database = new Database(':memory:');
  databases.push(database);

  return inlineWorkspaceStorage(database);
}

async function hostedWorkspace(): Promise<NimbusWorkspace> {
  const workspace = await NimbusWorkspace.create({
    ...openWorkspaceDatabase(),
    generation: 1,
    cwd: '/home/main',
  });

  // The DO ctx/env arguments are reached only by network subcommands (clone/fetch/pull/push); local history needs neither.
  workspace.registry.register('git', async (ctx) => runGitCommand(ctx, workspace.vfs, undefined, {}));

  return workspace;
}

describe('hosted Nimbus session toolchain', () => {
  test('git is a real command over the workspace filesystem, not a container capability', async () => {
    const workspace = await hostedWorkspace();

    // A registry command over a SQLite filesystem: no child process, nothing reaches the host's git.
    const repo = '/home/main/repo';
    await workspace.fs.mkdir(repo, { recursive: true });
    await workspace.fs.writeFile(`${repo}/a.txt`, 'first');

    expect(await workspace.shell.execute('git --version', { cwd: repo })).toMatchObject({
      exitCode: 0,
      stdout: 'git version 2.44.0 (isomorphic-git/cf-git)\n',
    });
    expect(await workspace.shell.execute('git init', { cwd: repo })).toMatchObject({ exitCode: 0 });
    expect(await workspace.shell.execute('git add a.txt', { cwd: repo })).toMatchObject({ exitCode: 0 });
    expect(await workspace.shell.execute('git commit -m "first commit"', { cwd: repo }))
      .toMatchObject({ exitCode: 0 });
    const log = await workspace.shell.execute('git log --oneline', { cwd: repo });
    expect(log.exitCode).toBe(0);
    expect(log.stdout).toContain('first commit');
  });
});
