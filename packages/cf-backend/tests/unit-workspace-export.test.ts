/**
 * Cloud workspace export: the paging contract over DO-style positional SQL (cursor claimed, not trusted), and the access class
 * (interactive-session-only, so exec-scoped CI tokens are refused). Format is core's `unit-workspace-archive`.
 */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  archiveSqlFromDatabase, CHAT_SESSION_ID, readWorkspaceArchivePage, restoreWorkspaceArchive,
  SessionHistory, AGENT_RPC_ACCESS, requiredRpcAccess, type ActorHandle, type ArchiveCursor, type SqlExec, type VFS,
} from '@kinu.run/core';
import { readTranscriptRows, sqlOver } from '@kinu.run/test-utils';
import { createTestActor, createTestWorkspace } from '../../core/tests/helpers';
import { cliScopesConnectionTag, rejectOutOfScopeRpc } from '../src/cli/rpc-gate';

/** Enough chained entries that one page cannot hold the conversation. */
const MESSAGES = 450;

interface WorkspaceFixture {
  sql: SqlExec;
  db: Database;
  actor: ActorHandle;
  vfs: VFS;
  said: readonly string[];
}

async function workspace(): Promise<WorkspaceFixture> {
  const ws = createTestWorkspace();
  const actor = createTestActor(ws.sql, ws.execRaw, 'SCOUT', 'scout');
  ws.db.exec(`CREATE TABLE workspace_capability (id INTEGER PRIMARY KEY, token TEXT NOT NULL)`);
  ws.db.exec(`INSERT INTO workspace_capability (id, token) VALUES (1, 'pwc_secret')`);
  ws.db.exec(`CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB)`);

  const history = new SessionHistory({
    sql: ws.sql, actor,
    transactionSync: (write) => ws.db.transaction(write)(),
    files: async () => ({ vfs: ws.vfs, artifactDirectory: '/home/agent/.kinu/context' }),
  });

  const said: string[] = [];
  let parentId: string | null = null;

  for (let i = 0; i < MESSAGES; i++) {
    const content = `message ${i}`;
    await history.record(CHAT_SESSION_ID, {
      id: `m${i}`, parentId, message: { role: 'user', content }, origin: 'input',
    });
    said.push(content);
    parentId = `m${i}`;
  }

  return { sql: archiveSqlFromDatabase(ws.db), db: ws.db, actor, vfs: ws.vfs, said };
}

/** The runaway guard refuses rather than returning a truncated archive that fails elsewhere. */
const MAX_PAGES = 5_000;

async function drain(sql: SqlExec, maxBytes: number): Promise<{ lines: string[]; pages: number }> {
  const lines: string[] = [];
  let cursor: ArchiveCursor | null = null;
  let pages = 0;

  do {
    const page = await readWorkspaceArchivePage(sql, { workspace: 'scout', source: 'cloud', cursor, maxBytes });
    lines.push(...page.lines);
    cursor = page.next;
    pages++;

    if (pages > MAX_PAGES) throw new Error(`the export did not terminate within ${MAX_PAGES} pages`);
  } while (cursor);

  return { lines, pages };
}

describe('cloud workspace export', () => {
  test('pages bound the response and reassemble into one restorable archive', async () => {
    const source = await workspace();
    const { lines, pages } = await drain(source.sql, 4096);
    expect(pages).toBeGreaterThan(1);

    const target = new Database(':memory:');
    const result = await restoreWorkspaceArchive(archiveSqlFromDatabase(target), lines);
    expect(result.source).toBe('cloud');

    // Read back through the production transcript reader: rows landed without their chain read as empty here.
    const restored = await readTranscriptRows(sqlOver(target), source.actor, source.vfs);
    expect(restored.map((row) => row.content)).toEqual([...source.said]);
  });

  test('neither the capability secret nor Durable Object internals are exported', async () => {
    const { lines } = await drain((await workspace()).sql, 1_000_000);
    expect(lines.some((l) => l.includes('pwc_secret'))).toBe(false);
    expect(lines.some((l) => l.includes('_cf_KV'))).toBe(false);
  });

  test('a resume cursor naming a table that is gone is refused, not guessed', async () => {
    const source = await workspace();
    await expect(readWorkspaceArchivePage(source.sql, {
      workspace: 'scout', source: 'cloud', cursor: { phase: 'sql', table: 'gone', after: 0, rows: 0 },
    })).rejects.toThrow(/no longer exists/);
  });

  test('exporting a workspace database needs an interactive session, not a CI token', () => {
    expect(AGENT_RPC_ACCESS.exportWorkspaceArchive).toBe('interactive');
    expect(requiredRpcAccess('exportWorkspaceArchive')).toBe('interactive');

    const scopeTag = cliScopesConnectionTag('workspace.exec');

    if (!scopeTag) throw new Error('workspace.exec must have a connection tag');
    const execToken = [scopeTag];
    const frame = JSON.stringify({ type: 'rpc', id: '1', method: 'exportWorkspaceArchive', args: [] });
    const denial = rejectOutOfScopeRpc(execToken, frame);
    expect(denial).not.toBeNull();
    expect(denial).toContain('interactive CLI session token');
    expect(rejectOutOfScopeRpc([], frame)).toBeNull();
  });
});
