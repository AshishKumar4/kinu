/**
 * The hosted Nimbus session's toolchain: `git` runs over the workspace filesystem with no DO behind local history,
 * and a runtime install without `NIMBUS_RUNTIME_CACHE` bound fails by binding name (why `python` is gated on it).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import * as v from 'valibot';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import type { SqlRow, SqlValue } from '@nimbus-sh/core/runtime/os-contracts.js';
import { runGitCommand } from '@nimbus-sh/worker/git';

const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

/** Same binder as unit-workspace-cwd.test.ts: the filesystem binds BLOBs as ArrayBuffer, bun:sqlite only TypedArrays. */
function sqlBinding(value: SqlValue): SQLQueryBindings {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);

  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);

  return v.parse(v.union([v.string(), v.number(), v.bigint(), v.null()]), value);
}

function openWorkspaceDatabase() {
  const database = new Database(':memory:');
  databases.push(database);

  return {
    database,
    sql: {
      exec(query: string, ...bindings: SqlValue[]) {
        const statement = database.prepare<SqlRow, SQLQueryBindings[]>(query);
        const bound = bindings.map(sqlBinding);

        if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) return statement.all(...bound);
        statement.run(...bound);

        return [];
      },
    },
  };
}

async function hostedWorkspace(): Promise<NimbusWorkspace> {
  const { database, sql } = openWorkspaceDatabase();

  const workspace = await NimbusWorkspace.create({
    sql,
    transactions: { storage: { transactionSync: <T,>(fn: () => T): T => database.transaction(fn)() } },
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
