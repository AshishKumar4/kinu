/** Workspace archive, driven against the real production schema: BLOB fidelity, FTS rebuilt not dumped,
 *  the capability secret never exported, and a paged export equal to an unpaged one. */

import * as v from 'valibot';
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  archiveSqlFromDatabase,
  initActorClaimTables,
  initAllTables,
  readWorkspaceArchivePage,
  restoreWorkspaceArchive,
  writeWorkspaceArchive,
  workspaceArchiveFiles,
  CHAT_SESSION_ID,
  SessionHistory,
  type ActorHandle,
  type ArchiveCursor,
  type SessionTranscriptReader,
  type SqlValue,
} from '../src/index';
import { createTestActor, createWorkspaceBundle, makeExecRaw, makeSql } from './helpers';
import { ConversationSearchStore } from '../src/memory/conversation-search';
import { openWorkspaceMainActor } from '../src/identity/workspace-actors';
import type { WorkspaceVFS } from '../src/vfs/nimbus-workspace';
import type { RawSqlExec, SqlExec, SqlExecutor } from '../src/types/primitives';
import { testActorHandle, present } from '@kinu.run/test-utils';

/** One in-memory database with every handle this suite drives it through. */
interface Workspace {
  readonly db: Database;
  readonly sql: SqlExecutor;
  readonly execRaw: RawSqlExec;
  readonly archive: SqlExec;
  readonly vfs: WorkspaceVFS;
}

function fresh(): Workspace {
  const db = new Database(':memory:');
  // Built on demand: a restore-target database must stay empty, and building one creates tables.
  let vfs: WorkspaceVFS | null = null;

  return {
    db, sql: makeSql(db), execRaw: makeExecRaw(db), archive: archiveSqlFromDatabase(db),
    get vfs() { return (vfs ??= createWorkspaceBundle(db).vfs); },
  };
}

/** Actor-local state plus the canonical conversation store, minted beside the claim ledger. */
function initSchema(ws: Workspace): void {
  initAllTables(ws.execRaw, ws.sql);
  initActorClaimTables(ws.execRaw);
}

function historyOver(ws: Workspace, actor: ActorHandle): SessionHistory {
  return new SessionHistory({
    sql: ws.sql, actor, transactionSync: (write) => ws.db.transaction(write)(),
    files: async () => ({ vfs: ws.vfs, artifactDirectory: '/actor/.kinu/context' }),
  });
}

/** A transcript's text, oldest first; content lives in message parts, so only a projection answers. */
async function transcriptText(transcript: SessionTranscriptReader): Promise<string[]> {
  const text: string[] = [];

  for (const entry of transcript.ancestry()) {
    const projected = await transcript.project(entry.id);

    if (projected === null) throw new Error(`conversation entry ${entry.id} disappeared while reading it back`);
    text.push(projected.content);
  }

  return text;
}

/** A workspace with the production schema plus content of every awkward kind. */
async function seeded() {
  const ws = fresh();
  initSchema(ws);
  // The restore resolves the main actor out of the directory it just landed.
  const actor = createTestActor(ws.sql, ws.execRaw, 'w1', 'scout');
  const history = historyOver(ws, actor);

  for (let i = 0; i < 5; i++) {
    await history.record(CHAT_SESSION_ID, {
      id: `m${i}`, parentId: i === 0 ? null : `m${i - 1}`, origin: 'input',
      message: { role: 'user', content: `hello sqlite ${i}` },
    });
  }

  // Binary content through the chunked BLOB path.
  const bytes = new Uint8Array(300);

  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) % 256;
  await ws.vfs.mkdir('artifacts', { recursive: true });
  await ws.vfs.writeFile('artifacts/logo.bin', bytes);
  await ws.vfs.mkdir('notes', { recursive: true });
  await ws.vfs.writeFile('notes/plan.md', 'a plan with a "quote" and a \\ backslash');
  await new ConversationSearchStore(ws.sql, actor, (sessionId) => history.transcript(sessionId)).search('sqlite');

  return { ...ws, bytes, actor, history };
}

describe('workspace archive', () => {
  test('the hosted workspace file tree restores binary and nested text through the shared archive', async () => {
    const source = await seeded();
    const files = workspaceArchiveFiles(createWorkspaceBundle(source.db));
    const lines = await writeWorkspaceArchive(source.archive, { workspace: 'scout', source: 'cloud', files });
    const target = fresh();
    const restored = await restoreWorkspaceArchive(target.archive, lines, { files: () => target.vfs });

    expect(restored.files).toBeGreaterThan(0);
    expect(await target.vfs.readFile('artifacts/logo.bin')).toEqual(source.bytes);
    expect(await target.vfs.readFile('notes/plan.md', { encoding: 'utf8' })).toBe('a plan with a "quote" and a \\ backslash');
  });

  test('SQL cannot arrive after the destination filesystem has opened', async () => {
    const source = await seeded();
    const files = workspaceArchiveFiles(createWorkspaceBundle(source.db));
    const lines = await writeWorkspaceArchive(source.archive, { workspace: 'scout', source: 'cloud', files });
    const end = lines.at(-1);

    if (!end) throw new Error('archive has no end record');
    const target = fresh();

    await expect(restoreWorkspaceArchive(target.archive, [
      ...lines.slice(0, -1),
      JSON.stringify({ t: 'schema', kind: 'table', name: 'late_table', sql: 'CREATE TABLE late_table (id INTEGER)' }),
      end,
    ], { files: () => target.vfs })).rejects.toThrow('SQL records after its workspace files');
  });

  test('round-trips a workspace into an empty database, byte-exactly', async () => {
    const source = await seeded();
    const lines = await writeWorkspaceArchive(source.archive, { workspace: 'scout', source: 'local', now: 42 });

    const target = fresh();
    const result = await restoreWorkspaceArchive(target.archive, lines);

    expect(result.workspace).toBe('scout');
    expect(result.source).toBe('local');
    expect(result.exportedAt).toBe(42);
    expect(result.rows).toBeGreaterThan(0);

    const identity = target.sql<{ id: string; name: string }>`SELECT id, name FROM workspace_identity`;
    expect(identity).toEqual([{ id: 'w1', name: 'scout' }]);
    const transcript = historyOver(target, openWorkspaceMainActor(target.sql)).transcript(CHAT_SESSION_ID);
    expect(await transcriptText(transcript)).toEqual([
      'hello sqlite 0', 'hello sqlite 1', 'hello sqlite 2', 'hello sqlite 3', 'hello sqlite 4',
    ]);

    expect(await target.vfs.readFile('artifacts/logo.bin')).toEqual(source.bytes);
    expect(await target.vfs.readFile('notes/plan.md', { encoding: 'utf8' }))
      .toBe('a plan with a "quote" and a \\ backslash');
  });

  test('the restored FTS index is searchable — it is rebuilt, not copied', async () => {
    const source = await seeded();
    const lines = await writeWorkspaceArchive(source.archive, { workspace: 'scout', source: 'local' });

    const target = fresh();
    await restoreWorkspaceArchive(target.archive, lines);

    const restored = openWorkspaceMainActor(target.sql);
    const history = historyOver(target, restored);
    const hits = await new ConversationSearchStore(target.sql, restored, (sessionId) => history.transcript(sessionId)).search('sqlite');
    expect(hits.length).toBe(5);
    // FTS shadow tables are rebuilt on the target, never carried as rows.
    expect(lines.some((l) => l.includes('"table":"conversation_fts_data"'))).toBe(false);

    // A local archive carries no disposable trigger/state pair, so the next durable mutation stays valid.
    await history.record(CHAT_SESSION_ID, {
      id: 'm5', parentId: 'm4', origin: 'input', message: { role: 'user', content: 'local post-import' },
    });
    const after = await new ConversationSearchStore(target.sql, restored, (sessionId) => history.transcript(sessionId)).search('post-import');
    expect(after.map((hit) => hit.messageId)).toEqual(['m5']);
  });
  test('the workspace capability secret is never in an archive', async () => {
    const source = await seeded();
    source.db.exec(`CREATE TABLE workspace_capability (id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT NOT NULL)`);
    void source.sql`INSERT INTO workspace_capability (id, token) VALUES (1, ${'pwc_supersecret'})`;

    const lines = await writeWorkspaceArchive(source.archive, { workspace: 'scout', source: 'cloud' });

    expect(lines.some((l) => l.includes('pwc_supersecret'))).toBe(false);
    expect(lines.some((l) => l.includes('workspace_capability'))).toBe(false);

    const target = fresh();
    await restoreWorkspaceArchive(target.archive, lines);

    const table = target.sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE name = ${'workspace_capability'}`;

    expect(table).toEqual([]);
  });

  test('a paged export reassembles into the same archive as an unpaged one', async () => {
    const source = await seeded();
    const whole = await writeWorkspaceArchive(source.archive, { workspace: 'scout', source: 'cloud', now: 7 });

    const paged: string[] = [];
    let cursor: ArchiveCursor | null = null;
    let pages = 0;

    do {
      const page = await readWorkspaceArchivePage(source.archive, {
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
    await restoreWorkspaceArchive(target.archive, paged);
    expect(target.sql<{ n: number }>`SELECT COUNT(*) AS n FROM conversation_entries`[0].n).toBe(5);
  });

  test('external workspace files page in the same stream and restore byte-exactly', async () => {
    const source = fresh();
    source.execRaw('CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT)');
    void source.sql`INSERT INTO notes (text) VALUES (${'database state'})`;

    const bodies = new Map([
      ['SOUL.md', new TextEncoder().encode('# soul\n')],
      ['memory/project.md', new TextEncoder().encode('remember\n')],
      ['project/data.bin', new Uint8Array([0, 255, 7, 8])],
    ]);

    const files = {
      async listEntries() {
        return [
          { path: 'SOUL.md', type: 'file' as const },
          { path: 'memory', type: 'directory' as const },
          { path: 'memory/project.md', type: 'file' as const },
          { path: 'project', type: 'directory' as const },
          { path: 'project/data.bin', type: 'file' as const },
        ];
      },
      async readFile(path: string) { return present(bodies.get(path), `the archived body of ${path}`).slice(); },
    };

    const whole = await writeWorkspaceArchive(source.archive, {
      workspace: 'external', source: 'cloud', now: 11, files,
    });

    const paged: string[] = [];
    let cursor: ArchiveCursor | null = null;

    do {
      const page = await readWorkspaceArchivePage(source.archive, {
        workspace: 'external', source: 'cloud', now: 11, files, cursor, maxBytes: 1,
      });

      paged.push(...page.lines);
      cursor = page.next;
    } while (cursor);

    expect(paged).toEqual(whole);
    expect(paged.filter((line) => line.includes('"t":"header"'))).toHaveLength(1);

    const target = fresh();
    const restoredBodies = new Map<string, Uint8Array>();

    const restored = await restoreWorkspaceArchive(target.archive, paged, {
      files: () => ({
        async mkdir() {},
        async writeFile(path, data) { restoredBodies.set(path, data.slice()); },
      }),
    });

    expect(restored.files).toBe(3);
    expect(restoredBodies).toEqual(bodies);
    expect(target.sql<{ text: string }>`SELECT text FROM notes`).toEqual([{ text: 'database state' }]);
  });

  test('a page stops at the first row that fills it, however big the rows are', async () => {
    const ws = fresh();
    ws.execRaw(`CREATE TABLE blobs (id INTEGER PRIMARY KEY, data BLOB)`);
    const blob = new ArrayBuffer(64 * 1024);

    // ids start at 0: with an INTEGER PRIMARY KEY the rowid is the id, and a numeric sentinel would skip it.
    for (let i = 0; i < 5; i++) {
      void ws.sql`INSERT INTO blobs (id, data) VALUES (${i}, ${blob})`;
    }

    // One blob exceeds the page budget, so every page carries exactly one row; the export must not buffer a batch.
    let cursor: ArchiveCursor | null = null;
    const rowsPerPage: number[] = [];

    do {
      const page = await readWorkspaceArchivePage(ws.archive, {
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

    for (let i = 0; i < 400; i++) void ws.sql`INSERT INTO notes (text) VALUES (${`note ${i}`})`;
    const blob = new ArrayBuffer(200 * 1024);

    for (let i = 0; i < 4; i++) void ws.sql`INSERT INTO blobs (data) VALUES (${blob})`;

    // The blob table must not inherit `notes`' large batch: one such fetch is hundreds of megabytes.
    const asked: Array<{ table: string; limit: number }> = [];

    const spy = {
      exec(query: string, ...bindings: SqlValue[]) {
        const match = /FROM "([^"]+)"/.exec(query);

        if (match && /LIMIT \?/.test(query)) {
          asked.push({ table: match[1], limit: Number(bindings[bindings.length - 1]) });
        }

        return ws.archive.exec(query, ...bindings);
      },
    };

    let cursor: ArchiveCursor | null = null;

    do {
      const page = await readWorkspaceArchivePage(spy, { workspace: 'mixed', source: 'cloud', cursor });
      cursor = page.next;
    } while (cursor);

    expect(Math.max(...asked.filter((a) => a.table === 'notes').map((a) => a.limit))).toBeGreaterThan(8);
    expect(Math.max(...asked.filter((a) => a.table === 'blobs').map((a) => a.limit))).toBeLessThanOrEqual(8);
  });

  test('a truncated archive is refused, not half-restored', async () => {
    const source = await seeded();
    const lines = await writeWorkspaceArchive(source.archive, { workspace: 'scout', source: 'cloud' });

    const target = fresh();
    await expect(restoreWorkspaceArchive(target.archive, lines.slice(0, lines.length - 1)))
      .rejects.toThrow(/incomplete/);
  });

  test('a damaged archive that lost rows is refused', async () => {
    const source = await seeded();
    const lines = await writeWorkspaceArchive(source.archive, { workspace: 'scout', source: 'cloud' });
    const withoutARow = lines.filter((l, i) => !(l.includes('"t":"row"') && i > 20));

    const target = fresh();
    await expect(restoreWorkspaceArchive(target.archive, withoutARow)).rejects.toThrow(/damaged/);
  });

  test('a file that is not an archive is refused by its first line', async () => {
    const target = fresh();
    await expect(restoreWorkspaceArchive(target.archive, ['SQLite format 3']))
      .rejects.toThrow(/not a Kinu workspace archive/);
    await expect(restoreWorkspaceArchive(target.archive, ['{"t":"row","table":"conversation_entries","values":{}}']))
      .rejects.toThrow(/not a Kinu workspace archive/);
  });

  test('an empty workspace archives and restores to an empty workspace', async () => {
    const source = fresh();
    initSchema(source);
    const lines = await writeWorkspaceArchive(source.archive, { workspace: 'blank', source: 'local' });

    const target = fresh();
    const result = await restoreWorkspaceArchive(target.archive, lines);
    expect(result.tables).toBeGreaterThan(0);
    expect(target.sql<{ n: number }>`SELECT COUNT(*) AS n FROM conversation_entries`[0].n).toBe(0);
  });

  test('omits derived conversation revision triggers and restores a mutable transcript', async () => {
    const source = fresh();
    initSchema(source);
    // Every transcript row names its writer, so a restore files it under that owner, not the archive's main actor.
    const cloudActor = createTestActor(source.sql, source.execRaw, 'cloud', 'cloud');
    const cloud = historyOver(source, cloudActor);
    await cloud.record(CHAT_SESSION_ID, {
      id: 'u1', parentId: null, origin: 'input', message: { role: 'user', content: 'cloud question' },
    });
    await cloud.record(CHAT_SESSION_ID, {
      id: 'a1', parentId: 'u1', origin: 'output', message: { role: 'assistant', content: 'cloud answer' },
    });
    await new ConversationSearchStore(source.sql, openWorkspaceMainActor(source.sql), (sessionId) => cloud.transcript(sessionId)).search('cloud');

    const lines = await writeWorkspaceArchive(source.archive, { workspace: 'cloud', source: 'cloud' });
    expect(lines.some((line) => line.includes('conversation_fts'))).toBe(false);
    expect(lines.some((line) => line.includes('conversation_rev_'))).toBe(false);

    const target = fresh();
    await restoreWorkspaceArchive(target.archive, lines);

    // Read unscoped: an actor-predicated read would answer an empty set and pass for the wrong reason.
    expect(target.sql<{ id: string; actor_id: string }>`
      SELECT id, actor_id FROM conversation_entries ORDER BY id`).toEqual([
      { id: 'a1', actor_id: cloudActor.actorId },
      { id: 'u1', actor_id: cloudActor.actorId },
    ]);
    const landed = openWorkspaceMainActor(target.sql);
    const history = historyOver(target, landed);
    expect(await transcriptText(history.transcript(CHAT_SESSION_ID))).toEqual(['cloud question', 'cloud answer']);
    await history.record(CHAT_SESSION_ID, {
      id: 'u2', parentId: 'a1', origin: 'input', message: { role: 'user', content: 'local continuation' },
    });
    const continued = await new ConversationSearchStore(target.sql, landed, (sessionId) => history.transcript(sessionId)).search('local continuation');
    expect(continued.map((hit) => hit.messageId)).toEqual(['u2']);
  });
});

describe('the table set an export walks is pinned by its first page', () => {
  test('a table born mid-export never joins it, so the archive stays restorable', async () => {
    const source = fresh();
    initSchema(source);
    // A bare bound handle: a registered actor would add its own rows to the count under assertion.
    const actor = testActorHandle(source.sql);
    const history = historyOver(source, actor);

    for (let i = 0; i < 5; i++) {
      await history.record(CHAT_SESSION_ID, {
        id: `m${i}`, parentId: i === 0 ? null : `m${i - 1}`, origin: 'input',
        message: { role: 'user', content: `page boundary ${i}` },
      });
    }

    // Between two pages, create a lazily-created table (the `outbox_<name>` / `swarm_node_records` shape).
    const pages: string[] = [];
    let cursor: ArchiveCursor | null = null;
    let page = 0;

    do {
      if (page === 1) {
        source.execRaw('CREATE TABLE late_arrival (id INTEGER PRIMARY KEY, note TEXT)');
        void source.sql`INSERT INTO late_arrival (note) VALUES (${'born mid-export'})`;
      }

      const one = await readWorkspaceArchivePage(source.archive, {
        workspace: 'pinned', source: 'cloud', now: 5, cursor, maxBytes: 1,
      });

      pages.push(...one.lines);
      cursor = one.next;
      page++;
    } while (cursor);

    // No row or schema record for the late table: the pair that would make the restore throw.
    expect(pages.some((l) => l.includes('"table":"late_arrival"'))).toBe(false);
    expect(pages.some((l) => l.includes('"name":"late_arrival"'))).toBe(false);

    // The total is exactly the seeded conversation: five messages, five entries, one head pointer.
    const target = fresh();
    const result = await restoreWorkspaceArchive(target.archive, pages);
    expect(result.rows).toBe(16);
  });

  test('a WITHOUT ROWID table pages stably under concurrent writes', async () => {
    const ws = fresh();
    ws.execRaw('CREATE TABLE wr (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID');
    void ws.sql`INSERT INTO wr (k, v) VALUES (${'b'}, ${'2'})`;
    void ws.sql`INSERT INTO wr (k, v) VALUES (${'a'}, ${'1'})`;
    void ws.sql`INSERT INTO wr (k, v) VALUES (${'c'}, ${'3'})`;

    // Schema-only pages before the first row carry no rows to compare.
    let cursor: ArchiveCursor | null = { phase: 'sql', table: 'wr', after: null, rows: 0, tables: ['wr'] };

    for (;;) {
      const page = await readWorkspaceArchivePage(ws.archive, {
        workspace: 'wr', source: 'cloud', maxBytes: 1, cursor,
      });

      const rows = page.lines.filter((l) => l.includes('"t":"row"'));

      if (rows.length > 0) {
        // Page boundary: one row emitted, the cursor pointing at the next.
        expect(rows).toHaveLength(1);
        expect(JSON.parse(rows[0]).values.k).toBe('a');
        cursor = page.next;
        break;
      }

      cursor = page.next;

      if (cursor === null) throw new Error('the export finished without emitting a row');
    }

    // A row sorting before every remaining row lands between pages; an offset walk would duplicate 'b'.
    void ws.sql`INSERT INTO wr (k, v) VALUES (${'0'}, ${'0'})`;

    const rest: string[] = [];

    while (cursor !== null && cursor.phase === 'sql') {
      const next = await readWorkspaceArchivePage(ws.archive, {
        workspace: 'wr', source: 'cloud', maxBytes: 1, cursor,
      });

      rest.push(...next.lines);
      cursor = next.next;
    }

    const RowLine = v.object({ values: v.object({ k: v.string() }) });

    const keys = ['a', ...rest
      .filter((l) => l.includes('"t":"row"'))
      .map((l) => v.parse(RowLine, JSON.parse(l)).values.k)];

    // Every row exactly once; '0' is the mid-export write, invisible to this page's membership.
    expect(keys).toEqual(['a', 'b', 'c']);
  });
});
