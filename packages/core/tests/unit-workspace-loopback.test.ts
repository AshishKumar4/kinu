/**
 * The workspace loopback, over a real library workspace.
 *
 * `createDefaultRegistry` binds `node` to a process-global port map and
 * `curl` to no kernel at all, so a server one started was invisible to the
 * other — and a loopback `curl` with nothing listening fell through to the
 * platform `fetch`, which on Cloudflare answers `error code: 1003`.
 * `provisionWorkspaceRuntimes` re-registers both against the workspace's own
 * kernel; asserted here through the shell, the seam the agent actually drives:
 * a listening port answers its bytes, an empty one refuses as a refused
 * connection, and `node` still runs where the host compiles.
 */
import { describe, expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import * as v from 'valibot';
import type { SqlDatabase, SqlRow, SqlValue } from '@nimbus-sh/core/runtime/os-contracts.js';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import { provisionWorkspaceRuntimes } from '../src/vfs/workspace-runtimes';

function sqlBinding(value: SqlValue): SQLQueryBindings {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return v.parse(v.union([v.string(), v.number(), v.bigint(), v.null()]), value);
}

async function loopbackWorkspace(): Promise<{ database: Database; workspace: NimbusWorkspace }> {
  const database = new Database(':memory:');
  const sql: SqlDatabase = {
    exec(query: string, ...bindings: SqlValue[]) {
      const statement = database.prepare<SqlRow, SQLQueryBindings[]>(query);
      const bound = bindings.map(sqlBinding);
      if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) return statement.all(...bound);
      statement.run(...bound);
      return [];
    },
  };
  const workspace = await NimbusWorkspace.create({
    sql,
    transactions: { storage: { transactionSync: <T,>(fn: () => T): T => database.transaction(fn)() } },
    generation: 1,
    cwd: '/home/user',
  });
  await provisionWorkspaceRuntimes({ workspace, runtimes: [] });
  return { database, workspace };
}

describe('the workspace loopback', () => {
  test('a virtual server answers curl with its bytes', async () => {
    const { database, workspace } = await loopbackWorkspace();
    try {
      workspace.kernel.portRegistry.set(4891, (_req, res) => {
        res.statusCode = 200;
        res.headers = { 'content-type': 'text/plain' };
        res.body = 'Kinu live preview loopback';
      });
      const hit = await workspace.shell.execute('curl -sS http://127.0.0.1:4891/', {
        cwd: '/home/user',
      });
      expect(hit.exitCode).toBe(0);
      expect(hit.stdout).toContain('Kinu live preview loopback');
      expect(`${hit.stdout}\n${hit.stderr}`).not.toContain('1003');
    } finally {
      database.close();
    }
  });

  test('an empty loopback port refuses as a refused connection', async () => {
    const { database, workspace } = await loopbackWorkspace();
    try {
      const missed = await workspace.shell.execute('curl -sS http://127.0.0.1:4892/', {
        cwd: '/home/user',
      });
      expect(missed.exitCode).toBe(7);
      expect(missed.stderr).toContain('Failed to connect');
      expect(`${missed.stdout}\n${missed.stderr}`).not.toContain('1003');
    } finally {
      database.close();
    }
  });

  test('node still runs where the host compiles', async () => {
    const { database, workspace } = await loopbackWorkspace();
    try {
      const result = await workspace.shell.execute('node -e \'console.log("node-loops")\'', {
        cwd: '/home/user',
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('node-loops');
    } finally {
      database.close();
    }
  });
});
