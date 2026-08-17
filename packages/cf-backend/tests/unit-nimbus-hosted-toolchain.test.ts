/**
 * What the HOSTED Nimbus session's toolchain actually is, and where it stops.
 *
 * Proteus's deployed workspace is `@nimbus-sh/worker`'s session Durable Object,
 * reached through `@nimbus-sh/sdk`. Its extra commands are registered by
 * `initSession` — `git` at dist/session/init.js:457, `npm` at :1927, `npx` at
 * :2311, `node` at :698, `bun` at :847 — and none of them needs a runtime
 * catalog. The interpreter runtimes DO: `nimbus install` reads them out of R2
 * through `env.NIMBUS_RUNTIME_CACHE`, and Proteus does not bind that bucket.
 *
 * These tests pin both halves of that, because both are claims the capability
 * declarations make to the model:
 *
 *   - git runs over a Nimbus workspace filesystem with no Durable Object
 *     behind it for anything local, so declaring `git` on the Nimbus executor
 *     is honest rather than aspirational.
 *   - asking the same session for a runtime with no bucket bound fails with a
 *     named binding error, which is why `python` is declared only when
 *     `NIMBUS_RUNTIME_CACHE` is present (execution/nimbus.ts runtimeCatalog).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import * as v from 'valibot';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import type { SqlRow, SqlValue } from '@nimbus-sh/core/runtime/os-contracts.js';
import { registerGitCommands } from '../../../node_modules/@nimbus-sh/worker/dist/git/commands.js';
import { ensureRuntimesProgrammatic } from '../../../node_modules/@nimbus-sh/worker/dist/runtime/package-manager.js';

const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

/** Identical to the binder in unit-workspace-cwd.test.ts: the filesystem binds
 *  BLOBs as ArrayBuffer, bun:sqlite binds only TypedArrays. */
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
    cwd: '/home/user',
  });
  // The two arguments after the filesystem are the Durable Object's own context
  // and env, which only the NETWORK subcommands reach (clone/fetch/pull/push go
  // through the git-network facet). Local history needs neither.
  registerGitCommands(workspace.registry, workspace.vfs, undefined, {});
  return workspace;
}

describe('hosted Nimbus session toolchain', () => {
  test('git is a real command over the workspace filesystem, not a container capability', async () => {
    const workspace = await hostedWorkspace();

    // Run through the workspace's own `Shell`, which is what `workspace.exec`
    // delegates to, with an explicit cwd rather than a `cd` that has to persist.
    // This git is a command in a Nimbus registry over a SQLite filesystem —
    // there is no child process and nothing reaches the host's git.
    const repo = '/home/user/repo';
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

  test('a runtime install with no catalog bucket names the missing binding', async () => {
    const workspace = await hostedWorkspace();

    // Exactly the deps `rpcEnsureRuntimes` builds from a session, with the env a
    // Worker that never bound the bucket has: empty.
    const [result] = await ensureRuntimesProgrammatic({
      env: {},
      vfs: workspace.vfs,
      registry: workspace.registry,
      getHome: () => '/home/user',
    }, ['python']);

    expect(result?.exitCode).not.toBe(0);
    expect(`${result?.stderr}${result?.stdout}`).toContain('NIMBUS_RUNTIME_CACHE');
  });
});
