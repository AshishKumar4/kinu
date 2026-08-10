/**
 * Cloud workspace export — the owner's backup of a Durable Object workspace.
 *
 * Asserts the two things the DO seam owns (core's `unit-workspace-archive`
 * owns the format itself):
 *   - the paging contract a caller walks, driven over the positional-binding
 *     SQL interface the DO's `ctx.storage.sql` implements, including a client
 *     cursor that is claimed rather than trusted;
 *   - the access class: a workspace database is interactive-session-only, so
 *     an exec-scoped CI token is refused on every transport.
 */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  archiveSqlFromDatabase, readWorkspaceArchivePage, restoreWorkspaceArchive,
  type ArchiveCursor, type SqlExec,
} from '@proteus/core';
import {
  AGENT_RPC_ACCESS, cliScopesConnectionTag, rejectOutOfScopeRpc, requiredRpcAccess,
} from '../src/cli/rpc-gate.js';

/** A workspace whose storage is reached exactly as the DO reaches its own. */
function workspace(): { sql: SqlExec; db: Database } {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE messages (id TEXT PRIMARY KEY, content TEXT NOT NULL)`);
  db.exec(`CREATE TABLE workspace_capability (id INTEGER PRIMARY KEY, token TEXT NOT NULL)`);
  db.exec(`INSERT INTO workspace_capability (id, token) VALUES (1, 'pwc_secret')`);
  // The DO's own bookkeeping tables, which belong to the platform, not the user.
  db.exec(`CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB)`);
  for (let i = 0; i < 450; i++) {
    db.query(`INSERT INTO messages (id, content) VALUES (?, ?)`).run(`m${i}`, `message ${i}`);
  }
  return { sql: archiveSqlFromDatabase(db), db };
}

/** What the CLI and the browser both do: walk `next` until it is null. */
function drain(sql: SqlExec, maxBytes: number): { lines: string[]; pages: number } {
  const lines: string[] = [];
  let cursor: ArchiveCursor | null = null;
  let pages = 0;
  do {
    const page = readWorkspaceArchivePage(sql, { workspace: 'scout', source: 'cloud', cursor, maxBytes });
    lines.push(...page.lines);
    cursor = page.next;
    pages++;
  } while (cursor && pages < 100);
  return { lines, pages };
}

describe('cloud workspace export', () => {
  test('pages bound the response and reassemble into one restorable archive', () => {
    const source = workspace();
    const { lines, pages } = drain(source.sql, 4096);
    expect(pages).toBeGreaterThan(1);

    const target = new Database(':memory:');
    const result = restoreWorkspaceArchive(archiveSqlFromDatabase(target), lines);
    expect(result.source).toBe('cloud');
    expect(target.query(`SELECT COUNT(*) AS n FROM messages`).get()).toEqual({ n: 450 });
  });

  test('neither the capability secret nor Durable Object internals are exported', () => {
    const { lines } = drain(workspace().sql, 1_000_000);
    expect(lines.some((l) => l.includes('pwc_secret'))).toBe(false);
    expect(lines.some((l) => l.includes('_cf_KV'))).toBe(false);
  });

  test('a resume cursor naming a table that is gone is refused, not guessed', () => {
    const source = workspace();
    expect(() => readWorkspaceArchivePage(source.sql, {
      workspace: 'scout', source: 'cloud', cursor: { table: 'gone', after: 0, rows: 0 },
    })).toThrow(/no longer exists/);
  });

  test('exporting a workspace database needs an interactive session, not a CI token', () => {
    expect(AGENT_RPC_ACCESS.exportWorkspaceArchive).toBe('interactive');
    expect(requiredRpcAccess('exportWorkspaceArchive')).toBe('interactive');

    const execToken = [cliScopesConnectionTag('workspace.exec')!];
    const frame = JSON.stringify({ type: 'rpc', id: '1', method: 'exportWorkspaceArchive', args: [] });
    const denial = rejectOutOfScopeRpc(execToken, frame);
    expect(denial).not.toBeNull();
    expect(denial).toContain('interactive CLI session token');
    // A browser or interactive CLI connection carries no scope tag at all.
    expect(rejectOutOfScopeRpc([], frame)).toBeNull();
  });
});
