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
  archiveSqlFromDatabase, CHAT_SESSION_ID, readWorkspaceArchivePage, restoreWorkspaceArchive,
  SessionHistory, type ActorHandle, type ArchiveCursor, type SqlExec, type VFS,
} from '@kinu.run/core';
import { readTranscriptRows, sqlOver } from '@kinu.run/test-utils';
import { createTestActor, createTestWorkspace } from '../../core/tests/helpers';
import {
  AGENT_RPC_ACCESS, cliScopesConnectionTag, rejectOutOfScopeRpc, requiredRpcAccess,
} from '../src/cli/rpc-gate';

/** Enough chained entries that a 4 KiB page cannot hold the conversation. */
const MESSAGES = 450;

interface WorkspaceFixture {
  sql: SqlExec;
  db: Database;
  actor: ActorHandle;
  vfs: VFS;
  /** The chain's text, root first — what a restore has to reproduce. */
  said: readonly string[];
}

/** A workspace whose storage is reached exactly as the DO reaches its own, and
 *  whose conversation is written by the canonical writer a turn writes through. */
async function workspace(): Promise<WorkspaceFixture> {
  const ws = createTestWorkspace();
  const actor = createTestActor(ws.sql, ws.execRaw, 'SCOUT', 'scout');
  ws.db.exec(`CREATE TABLE workspace_capability (id INTEGER PRIMARY KEY, token TEXT NOT NULL)`);
  ws.db.exec(`INSERT INTO workspace_capability (id, token) VALUES (1, 'pwc_secret')`);
  // The DO's own bookkeeping tables, which belong to the platform, not the user.
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

/** A walk that never reaches `next === null` is the defect, so the runaway
 *  guard REFUSES rather than returning a truncated archive that then fails as
 *  an incomplete one somewhere else. */
const MAX_PAGES = 5_000;

/** What the CLI and the browser both do: walk `next` until it is null. */
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

    // Read back through the production transcript reader, not by counting a
    // table: what an owner is owed is the CONVERSATION, and a restore that
    // landed the rows without their chain reads as an empty one here.
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
    // A browser or interactive CLI connection carries no scope tag at all.
    expect(rejectOutOfScopeRpc([], frame)).toBeNull();
  });
});
