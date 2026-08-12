/**
 * Workspace archive — the portable backup format both backends produce.
 *
 * Driven against the REAL production schema (initAllTables + the FTS5 session
 * index + a memory-store table), because the properties that matter are all
 * schema-shaped: BLOB fidelity through the VFS chunk store, an external-content
 * FTS index that must be rebuilt rather than dumped, the capability secret that
 * must never leave the workspace, and a paged export reassembling into exactly
 * the archive an unpaged one would have written.
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  archiveSqlFromDatabase,
  initAllTables,
  readWorkspaceArchivePage,
  restoreWorkspaceArchive,
  writeWorkspaceArchive,
  type ArchiveCursor,
} from '../src/index.js';
import { makeSql, makeExecRaw } from './helpers.js';
import { createWorkspaceBundle } from './helpers.js';
import { SessionSearchStore } from "../src/memory/session-search.js";

function fresh() {
  const db = new Database(':memory:');
  // The filesystem is built on demand: a database used only as a RESTORE
  // TARGET must stay genuinely empty, and building one creates tables.
  let vfs: ReturnType<typeof createWorkspaceBundle>['vfs'] | null = null;
  return {
    db, sql: makeSql(db), execRaw: makeExecRaw(db), archive: archiveSqlFromDatabase(db),
    get vfs() { return (vfs ??= createWorkspaceBundle(db).vfs); },
  };
}

/** A workspace with the production schema plus content of every awkward kind. */
async function seeded() {
  const ws = fresh();
  initAllTables(ws.execRaw);
  ws.sql`INSERT INTO workspace_identity (id, name, created_at) VALUES (${'w1'}, ${'scout'}, ${100})`;
  for (let i = 0; i < 5; i++) {
    ws.sql`INSERT INTO messages (id, session_id, parent_id, role, content, created_at)
           VALUES (${`m${i}`}, ${'default'}, ${null}, ${'user'}, ${`hello sqlite ${i}`}, ${100 + i})`;
  }
  // Binary content through the canonical VFS writer — the chunked BLOB path.
  const bytes = new Uint8Array(300);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) % 256;
  await ws.vfs.mkdir('artifacts', { recursive: true });
  await ws.vfs.writeFile('artifacts/logo.bin', bytes);
  await ws.vfs.mkdir('notes', { recursive: true });
  await ws.vfs.writeFile('notes/plan.md', 'a plan with a "quote" and a \\ backslash');
  // External-content FTS5 over `messages`, maintained by triggers.
  new SessionSearchStore(ws.sql).search('sqlite');
  return { ...ws, bytes };
}

describe('workspace archive', () => {
  test('round-trips a workspace into an empty database, byte-exactly', async () => {
    const source = await seeded();
    const lines = writeWorkspaceArchive(source.archive, { workspace: 'scout', source: 'local', now: 42 });

    const target = fresh();
    const result = restoreWorkspaceArchive(target.archive, lines);

    expect(result.workspace).toBe('scout');
    expect(result.source).toBe('local');
    expect(result.exportedAt).toBe(42);
    expect(result.rows).toBeGreaterThan(0);

    const identity = target.sql<{ id: string; name: string }>`SELECT id, name FROM workspace_identity`;
    expect(identity).toEqual([{ id: 'w1', name: 'scout' }]);
    const messages = target.sql<{ id: string; content: string }>`SELECT id, content FROM messages ORDER BY id`;
    expect(messages.map((m) => m.content)).toEqual([
      'hello sqlite 0', 'hello sqlite 1', 'hello sqlite 2', 'hello sqlite 3', 'hello sqlite 4',
    ]);

    // BLOB fidelity, asserted where it matters: the restored workspace opens
    // its own files and gets the same bytes back, awkward ones included.
    expect(await target.vfs.readFile('artifacts/logo.bin')).toEqual(source.bytes);
    expect(await target.vfs.readFile('notes/plan.md', { encoding: 'utf8' }))
      .toBe('a plan with a "quote" and a \\ backslash');
  });

  test('the restored FTS index is searchable — it is rebuilt, not copied', async () => {
    const source = await seeded();
    const lines = writeWorkspaceArchive(source.archive, { workspace: 'scout', source: 'local' });

    const target = fresh();
    restoreWorkspaceArchive(target.archive, lines);

    const hits = new SessionSearchStore(target.sql).search('sqlite');
    expect(hits.length).toBe(5);
    // The FTS shadow tables are the index's private storage: rebuilt on the
    // target, never carried as rows.
    expect(lines.some((l) => l.includes('"table":"messages_fts_data"'))).toBe(false);
  });

  test('the workspace capability secret is never in an archive', async () => {
    const source = await seeded();
    source.db.exec(`CREATE TABLE workspace_capability (id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT NOT NULL)`);
    source.sql`INSERT INTO workspace_capability (id, token) VALUES (1, ${'pwc_supersecret'})`;

    const lines = writeWorkspaceArchive(source.archive, { workspace: 'scout', source: 'cloud' });

    expect(lines.some((l) => l.includes('pwc_supersecret'))).toBe(false);
    expect(lines.some((l) => l.includes('workspace_capability'))).toBe(false);

    const target = fresh();
    restoreWorkspaceArchive(target.archive, lines);
    const table = target.sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE name = ${'workspace_capability'}`;
    expect(table).toEqual([]);
  });

  test('a paged export reassembles into the same archive as an unpaged one', async () => {
    const source = await seeded();
    const whole = writeWorkspaceArchive(source.archive, { workspace: 'scout', source: 'cloud', now: 7 });

    const paged: string[] = [];
    let cursor: ArchiveCursor | null = null;
    let pages = 0;
    do {
      const page = readWorkspaceArchivePage(source.archive, {
        workspace: 'scout', source: 'cloud', now: 7, cursor, maxBytes: 1,
      });
      paged.push(...page.lines);
      cursor = page.next;
      pages++;
      expect(pages).toBeLessThan(500);
    } while (cursor);

    expect(pages).toBeGreaterThan(1);
    expect(paged).toEqual(whole);

    const target = fresh();
    restoreWorkspaceArchive(target.archive, paged);
    expect(target.sql<{ n: number }>`SELECT COUNT(*) AS n FROM messages`[0]!.n).toBe(5);
  });

  test('a page stops at the first row that fills it, however big the rows are', async () => {
    const ws = fresh();
    ws.execRaw(`CREATE TABLE blobs (id INTEGER PRIMARY KEY, data BLOB)`);
    const big = new Uint8Array(64 * 1024);
    // ids start at 0 on purpose: with an INTEGER PRIMARY KEY the rowid IS the
    // id, so the first row's key is 0 and a numeric "start here" sentinel
    // would skip it.
    for (let i = 0; i < 5; i++) {
      ws.sql`INSERT INTO blobs (id, data) VALUES (${i}, ${big.buffer})`;
    }

    // One blob is far larger than the page budget, so every page must carry
    // exactly one row — the export must never buffer a batch of them.
    let cursor: ArchiveCursor | null = null;
    const rowsPerPage: number[] = [];
    do {
      const page = readWorkspaceArchivePage(ws.archive, {
        workspace: 'blobby', source: 'cloud', cursor, maxBytes: 4096,
      });
      rowsPerPage.push(page.lines.filter((l) => l.includes('"t":"row"')).length);
      cursor = page.next;
    } while (cursor);
    expect(rowsPerPage.filter((n) => n > 0)).toEqual([1, 1, 1, 1, 1]);
  });

  test('a table of big rows is never fetched in the batch size small rows earned', async () => {
    const ws = fresh();
    ws.execRaw(`CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT)`);
    ws.execRaw(`CREATE TABLE blobs (id INTEGER PRIMARY KEY, data BLOB)`);
    for (let i = 0; i < 400; i++) ws.sql`INSERT INTO notes (text) VALUES (${`note ${i}`})`;
    const big = new Uint8Array(200 * 1024);
    for (let i = 0; i < 4; i++) ws.sql`INSERT INTO blobs (data) VALUES (${big.buffer})`;

    // Record what each row query asks for. `notes` earns a large batch; the
    // blob table must not inherit it — one such fetch is hundreds of megabytes.
    const asked: Array<{ table: string; limit: number }> = [];
    const spy = {
      exec(query: string, ...bindings: unknown[]) {
        const match = /FROM "([^"]+)"/.exec(query);
        if (match && /LIMIT \?/.test(query)) {
          asked.push({ table: match[1]!, limit: Number(bindings[bindings.length - 1]) });
        }
        return ws.archive.exec(query, ...bindings);
      },
    };

    let cursor: ArchiveCursor | null = null;
    do {
      const page = readWorkspaceArchivePage(spy, { workspace: 'mixed', source: 'cloud', cursor });
      cursor = page.next;
    } while (cursor);

    expect(Math.max(...asked.filter((a) => a.table === 'notes').map((a) => a.limit))).toBeGreaterThan(8);
    expect(Math.max(...asked.filter((a) => a.table === 'blobs').map((a) => a.limit))).toBeLessThanOrEqual(8);
  });

  test('a truncated archive is refused, not half-restored', async () => {
    const source = await seeded();
    const lines = writeWorkspaceArchive(source.archive, { workspace: 'scout', source: 'cloud' });

    const target = fresh();
    expect(() => restoreWorkspaceArchive(target.archive, lines.slice(0, lines.length - 1)))
      .toThrow(/incomplete/);
  });

  test('a damaged archive that lost rows is refused', async () => {
    const source = await seeded();
    const lines = writeWorkspaceArchive(source.archive, { workspace: 'scout', source: 'cloud' });
    const withoutARow = lines.filter((l, i) => !(l.includes('"t":"row"') && i > 20));

    const target = fresh();
    expect(() => restoreWorkspaceArchive(target.archive, withoutARow)).toThrow(/damaged/);
  });

  test('a file that is not an archive is refused by its first line', async () => {
    const target = fresh();
    expect(() => restoreWorkspaceArchive(target.archive, ['SQLite format 3']))
      .toThrow(/not a Proteus workspace archive/);
    expect(() => restoreWorkspaceArchive(target.archive, ['{"t":"row","table":"messages","values":{}}']))
      .toThrow(/not a Proteus workspace archive/);
  });

  test('an empty workspace archives and restores to an empty workspace', async () => {
    const source = fresh();
    initAllTables(source.execRaw);
    const lines = writeWorkspaceArchive(source.archive, { workspace: 'blank', source: 'local' });

    const target = fresh();
    const result = restoreWorkspaceArchive(target.archive, lines);
    expect(result.tables).toBeGreaterThan(0);
    expect(target.sql<{ n: number }>`SELECT COUNT(*) AS n FROM messages`[0]!.n).toBe(0);
  });
});
