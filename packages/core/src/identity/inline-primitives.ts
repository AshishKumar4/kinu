/**
 * Inline primitive implementations over a raw bun:sqlite-style database,
 * shared by createAgent and openAgent. The production backends replace
 * Memory/Executor/Schedule with richer adapters (FTS5 MemoryStore, sandboxed
 * executors), but the VFS here is the same canonical SqliteFS the backends
 * use, so the on-disk vfs_files encoding never diverges.
 */

import { SqliteFS } from '@proteus/agent-utils/vfs';
import type { VFSError } from '@proteus/agent-utils/vfs';
import type { CraftStore } from '../types/agent-runtime.js';
import type {
  Executor, FiberCtx, Memory, RawSqlExec, Schedule, SqlExecutor, VFS,
} from '../types/primitives.js';
import type { CraftedTool } from '../types/craft.js';
import { nanoid } from '../utils/nanoid.js';

/** Database interface — satisfied by bun:sqlite Database */
export interface AgentDatabase {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): void };
  exec(sql: string): void;
  run(sql: string, params?: unknown[]): void;
  query(sql: string): { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
}

/** Wrap a database into our SqlExecutor interface */
export function wrapDatabase(db: AgentDatabase): { sql: SqlExecutor; execRaw: RawSqlExec } {
  const sql = function <T = unknown>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): T[] {
    const query = strings.reduce((acc, s, i) => acc + s + (i < values.length ? '?' : ''), '');
    // SqliteFS encodes BLOBs as ArrayBuffer (Cloudflare DO storage.sql's
    // native type); bun:sqlite only binds TypedArrays — coerce.
    const bound = values.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v));
    const isRead = /^\s*(SELECT|WITH|PRAGMA)/i.test(query);
    const stmt = db.prepare(query);
    if (isRead) return stmt.all(...bound) as T[];
    stmt.run(...bound);
    return [];
  } as SqlExecutor;

  const execRaw: RawSqlExec = (ddl: string) => db.exec(ddl);
  return { sql, execRaw };
}

/** Canonical SqliteFS adapted to core's (simpler) VFS interface. */
export function createInlineVFS(sql: SqlExecutor): VFS {
  const fs = new SqliteFS(sql);
  fs.init();
  return {
    readFile: (path, opts) => fs.readFile(path, opts?.encoding === 'utf8' ? { encoding: 'utf8' } : undefined),
    writeFile: (path, data) => fs.writeFile(path, data),
    readdir: (path) => fs.readdir(path),
    async stat(path) {
      try {
        const s = await fs.stat(path);
        return { size: s.size, mtimeMs: s.mtimeMs, isDir: s.isDirectory() };
      } catch (err) {
        if ((err as VFSError).code === 'ENOENT') return null;
        throw err;
      }
    },
    unlink: (path) => fs.unlink(path),
    mkdir: (path, opts) => fs.mkdir(path, { recursive: opts?.recursive ?? true }),
    exists: (path) => fs.exists(path),
  };
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
        const existing = await vfs.readFile(path, { encoding: 'utf8' }) as string;
        await vfs.writeFile(path, existing + content);
      } catch {
        await vfs.writeFile(path, content);
      }
    },
    async index(path) {
      try {
        const content = await vfs.readFile(path, { encoding: 'utf8' }) as string;
        db.run('INSERT INTO memory_chunks (path, content) VALUES (?, ?)', [path, content]);
      } catch { /* file may not exist */ }
    },
    async search(query, limit = 10) {
      const rows = db.query('SELECT path, content FROM memory_chunks WHERE content LIKE ? LIMIT ?')
        .all(`%${query}%`, limit) as { path: string; content: string }[];
      return rows.map((r, i) => ({
        path: r.path, startLine: 0, endLine: 0,
        snippet: r.content.slice(0, 200), score: 1 - i * 0.1,
      }));
    },
    async read(path) {
      try { return await vfs.readFile(path, { encoding: 'utf8' }) as string; }
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
    get(name) { return db.query('SELECT * FROM crafted_tools WHERE name = ?').get(name) as CraftedTool | undefined; },
    delete(name) { db.run('DELETE FROM crafted_tools WHERE name = ?', [name]); },
    list() { return db.query('SELECT * FROM crafted_tools').all() as CraftedTool[]; },
    search(query, limit = 10) {
      const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      const all = db.query('SELECT * FROM crafted_tools').all() as CraftedTool[];
      return all.filter(t => words.some(w => t.description.toLowerCase().includes(w))).slice(0, limit);
    },
    getAll() { return db.query('SELECT * FROM crafted_tools').all() as CraftedTool[]; },
  };
}

export function createInlineExecutor(): Executor {
  return {
    async execute(code) {
      try {
        // Execute the code, not just parse it. Wrap in async IIFE to support await.
        const fn = new Function(`return (async () => { ${code} })()`);
        const result = await fn();
        return { result: result === undefined ? '(no return value)' : result };
      } catch (e) { return { result: undefined, error: (e as Error).message }; }
    },
  };
}

export function createInlineSchedule(sql: SqlExecutor): Schedule {
  return {
    after: async (_ms, fn) => { await fn(); },
    cron: async () => {},
    fiber: async <T>(name: string, fn: (ctx: FiberCtx) => Promise<T>): Promise<T> => {
      const id = nanoid();
      sql`INSERT INTO fibers (id, name, snapshot, created_at) VALUES (${id}, ${name}, ${null}, ${Date.now()})`;
      const stash = (data: unknown) => {
        sql`UPDATE fibers SET snapshot = ${JSON.stringify(data)} WHERE id = ${id}`;
      };
      try { return await fn({ stash, snapshot: null }); }
      finally { sql`DELETE FROM fibers WHERE id = ${id}`; }
    },
  };
}
