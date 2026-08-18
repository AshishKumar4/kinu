/**
 * Inline primitive implementations over a raw bun:sqlite-style database,
 * shared by createWorkspace and openWorkspace. The production backends replace
 * Memory/Executor/Schedule with richer adapters (FTS5 MemoryStore, sandboxed
 * executors); the filesystem is already the production one, so nothing about
 * how bytes are stored differs between this path and a deployed agent.
 */

import { createWorkspace as createWorkspaceFilesystem, nextWorkspaceGeneration } from '../vfs/nimbus-workspace';
import type { WorkspaceBundle } from '../vfs/nimbus-workspace';
import { chunkMarkdown, initMemoryChunkTables } from '@proteus/agent-utils/memory';
import type { CraftStore } from '../types/agent-runtime';
import type {
  Executor, FiberCtx, Memory, RawSqlExec, Schedule, SqlExecutor, VFS,
} from '../types/primitives';
import type { CraftedTool } from '../types/craft';
import { nanoid } from '../utils/nanoid';
import { decodeJsonValue } from '../utils/json';

/** Database interface — satisfied by bun:sqlite Database */
export interface AgentDatabase {
  prepare<T = unknown>(sql: string): { all(...params: unknown[]): T[]; run(...params: unknown[]): void };
  exec(sql: string): void;
  run(sql: string, params?: unknown[]): void;
  transaction?<T>(fn: () => T): () => T;
}

/** Wrap a database into our SqlExecutor interface */
export function wrapDatabase(db: AgentDatabase) {
  const sql: SqlExecutor = function <T = unknown>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): T[] {
    const query = strings.reduce((acc, s, i) => acc + s + (i < values.length ? '?' : ''), '');
    // The filesystem binds BLOBs as ArrayBuffer (Cloudflare DO storage.sql's
    // native type); bun:sqlite only binds TypedArrays — coerce.
    const bound = values.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v));
    const isRead = /^\s*(SELECT|WITH|PRAGMA)/i.test(query);
    const stmt = db.prepare<T>(query);
    if (isRead) return stmt.all(...bound);
    stmt.run(...bound);
    return [];
  };

  const execRaw: RawSqlExec = (ddl: string) => db.exec(ddl);
  return { sql, execRaw };
}

/**
 * The workspace filesystem over a bun:sqlite-style database — Nimbus, the same
 * component a deployed agent runs, so this path and a Durable Object store
 * bytes identically and run the same shell over them.
 */
export function createInlineWorkspace(db: AgentDatabase): WorkspaceBundle {
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      const bound = bindings.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v ?? null));
      const stmt = db.prepare(query);
      if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) return db.prepare<never>(query).all(...bound);
      stmt.run(...bound);
      return [];
    },
  };
  return createWorkspaceFilesystem({
    sql,
    transactions: {
      storage: {
        transactionSync: <T,>(cb: () => T): T =>
          db.transaction ? db.transaction(cb)() : cb(),
      },
    },
    generation: nextWorkspaceGeneration(sql),
  });
}

/**
 * LIKE-based memory over the workspace's `memory_chunks` table. Only the QUERY
 * is simplified — the production MemoryStore (agent-utils) answers the same
 * table through FTS5.
 *
 * The rows are written in the production shape, through the production chunker
 * and the DDL's real owner, because this used to declare a THIRD schema:
 * `(id, path, content)`. Whichever of the two ran first won, so
 * `repairLegacyTables` classified this shape as pre-release and dropped it,
 * every insert afterwards failed on `no column named content`, and the catch
 * that wrapped it reported an indexed file. A fork copies `memory_chunks`, so
 * the same divergence also handed a fork an empty memory index.
 */
export function createInlineMemory(db: AgentDatabase, vfs: VFS): Memory {
  const { sql } = wrapDatabase(db);
  initMemoryChunkTables(sql);
  return {
    async write(path, content) { await vfs.writeFile(path, content); },
    async append(path, content) {
      // SAFETY: The VFS contract returns text when the caller requests utf8 encoding.
      const existing = await vfs.exists(path)
        ? await vfs.readFile(path, { encoding: 'utf8' }) as string
        : '';
      await vfs.writeFile(path, existing + content);
    },
    async index(path) {
      // Asked rather than caught: an unreadable file must not index as an
      // absent one, or the chunk table silently diverges from the filesystem.
      if (!await vfs.exists(path)) return;
      // SAFETY: The VFS contract returns text when the caller requests utf8 encoding.
      const content = await vfs.readFile(path, { encoding: 'utf8' }) as string;
      const now = Date.now();
      // Replace the file's chunk set rather than appending to it, and keep the
      // FTS shadow in step: a row this path adds must be findable by the FTS5
      // reader as well, or a workspace opened with the real MemoryStore
      // searches an index that is missing exactly what the inline path wrote.
      void sql`DELETE FROM memory_chunks_fts WHERE rowid IN (SELECT rowid FROM memory_chunks WHERE path = ${path})`;
      void sql`DELETE FROM memory_chunks WHERE path = ${path}`;
      for (const chunk of await chunkMarkdown(content)) {
        const id = `${path}:${chunk.startLine}-${chunk.endLine}`;
        void sql`INSERT INTO memory_chunks (id, path, start_line, end_line, hash, text, updated_at)
          VALUES (${id}, ${path}, ${chunk.startLine}, ${chunk.endLine}, ${chunk.hash}, ${chunk.text}, ${now})`;
        void sql`INSERT INTO memory_chunks_fts (rowid, text) SELECT rowid, text FROM memory_chunks WHERE id = ${id}`;
      }
    },
    async search(query, limit = 10) {
      const rows = sql<{ path: string; start_line: number; end_line: number; text: string }>`
        SELECT path, start_line, end_line, text FROM memory_chunks
        WHERE text LIKE ${`%${query}%`} LIMIT ${limit}`;
      return rows.map((r, i) => ({
        path: r.path, startLine: r.start_line, endLine: r.end_line,
        snippet: r.text.slice(0, 200), score: 1 - i * 0.1,
      }));
    },
    async read(path) {
      if (!await vfs.exists(path)) return null;
      // SAFETY: The VFS contract returns text when the caller requests utf8 encoding.
      return await vfs.readFile(path, { encoding: 'utf8' }) as string;
    },
  };
}

export function createInlineCraftStore(db: AgentDatabase): CraftStore {
  return {
    create(tool) {
      db.run(
        'INSERT INTO crafted_tools (name, description, params, code, scope, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [tool.name, tool.description, tool.params ? JSON.stringify(tool.params) : null, tool.code, tool.scope, Date.now(), Date.now()],
      );
    },
    update(name, patch) {
      if (patch.code !== undefined) db.run('UPDATE crafted_tools SET code = ?, updated_at = ? WHERE name = ?', [patch.code, Date.now(), name]);
      if (patch.description !== undefined) db.run('UPDATE crafted_tools SET description = ?, updated_at = ? WHERE name = ?', [patch.description, Date.now(), name]);
    },
    get(name) { return db.prepare<CraftedTool>('SELECT * FROM crafted_tools WHERE name = ?').all(name)[0]; },
    delete(name) { db.run('DELETE FROM crafted_tools WHERE name = ?', [name]); },
    list() { return db.prepare<CraftedTool>('SELECT * FROM crafted_tools').all(); },
    search(query, limit = 10) {
      const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      const all = db.prepare<CraftedTool>('SELECT * FROM crafted_tools').all();
      return all.filter(t => words.some(w => t.description.toLowerCase().includes(w))).slice(0, limit);
    },
    getAll() { return db.prepare<CraftedTool>('SELECT * FROM crafted_tools').all(); },
  };
}

export function createInlineExecutor(): Executor {
  return {
    languages: ['javascript'],
    async execute(code) {
      try {
        // Execute the code, not just parse it. Wrap in async IIFE to support await.
        const fn = new Function(`return (async () => { ${code} })()`);
        const result: unknown = await fn();
        return {
          result: result === undefined ? '(no return value)' : decodeJsonValue({ value: result }),
        };
      } catch (error) {
        return {
          result: undefined,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

export function createInlineSchedule(sql: SqlExecutor): Schedule {
  return {
    after: async (_ms, fn) => { await fn(); },
    cron: async () => {},
    fiber: async <T>(name: string, fn: (ctx: FiberCtx) => Promise<T>): Promise<T> => {
      const id = nanoid();
      void sql`INSERT INTO fibers (id, name, snapshot, created_at) VALUES (${id}, ${name}, ${null}, ${Date.now()})`;
      const stash: FiberCtx['stash'] = (data) => {
        void sql`UPDATE fibers SET snapshot = ${JSON.stringify(data)} WHERE id = ${id}`;
      };
      try { return await fn({ stash, snapshot: null }); }
      finally { void sql`DELETE FROM fibers WHERE id = ${id}`; }
    },
  };
}
