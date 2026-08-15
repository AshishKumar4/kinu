/**
 * Inline primitive implementations over a raw bun:sqlite-style database,
 * shared by createWorkspace and openWorkspace. The production backends replace
 * Memory/Executor/Schedule with richer adapters (FTS5 MemoryStore, sandboxed
 * executors); the filesystem is already the production one, so nothing about
 * how bytes are stored differs between this path and a deployed agent.
 */

import { createWorkspace as createWorkspaceFilesystem, nextWorkspaceGeneration } from '../vfs/nimbus-workspace.js';
import type { WorkspaceBundle } from '../vfs/nimbus-workspace.js';
import type { CraftStore } from '../types/agent-runtime.js';
import type {
  Executor, FiberCtx, Memory, RawSqlExec, Schedule, SqlExecutor, VFS,
} from '../types/primitives.js';
import type { CraftedTool } from '../types/craft.js';
import { nanoid } from '../utils/nanoid.js';
import { decodeJsonValue } from '../utils/json.js';

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

/** LIKE-based memory over a simplified memory_chunks table. The production
 *  MemoryStore (agent-utils) replaces this with FTS5 + markdown chunking. */
export function createInlineMemory(db: AgentDatabase, vfs: VFS): Memory {
  db.exec(`CREATE TABLE IF NOT EXISTS memory_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, content TEXT NOT NULL
  )`);
  return {
    async write(path, content) { await vfs.writeFile(path, content); },
    async append(path, content) {
      try {
        // SAFETY: The VFS contract returns text when the caller requests utf8 encoding.
        const existing = await vfs.readFile(path, { encoding: 'utf8' }) as string;
        await vfs.writeFile(path, existing + content);
      } catch {
        await vfs.writeFile(path, content);
      }
    },
    async index(path) {
      try {
        // SAFETY: The VFS contract returns text when the caller requests utf8 encoding.
        const content = await vfs.readFile(path, { encoding: 'utf8' }) as string;
        db.run('INSERT INTO memory_chunks (path, content) VALUES (?, ?)', [path, content]);
      } catch { /* file may not exist */ }
    },
    async search(query, limit = 10) {
      const rows = db.prepare<{ path: string; content: string }>(
        'SELECT path, content FROM memory_chunks WHERE content LIKE ? LIMIT ?',
      ).all(`%${query}%`, limit);
      return rows.map((r, i) => ({
        path: r.path, startLine: 0, endLine: 0,
        snippet: r.content.slice(0, 200), score: 1 - i * 0.1,
      }));
    },
    async read(path) {
      try {
        // SAFETY: The VFS contract returns text when the caller requests utf8 encoding.
        return await vfs.readFile(path, { encoding: 'utf8' }) as string;
      }
      catch { return null; }
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
