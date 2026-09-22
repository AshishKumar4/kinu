// Inline primitives over a bun:sqlite-style database for createWorkspace; the filesystem is the production one.

import { createWorkspace as createWorkspaceFilesystem, workspaceGenerationStorage } from '../vfs/nimbus-workspace';
import type { WorkspaceBundle } from '../vfs/nimbus-workspace';
import { readTailWithVfsOps, type VfsNativeReads } from '../vfs/mounts';
import { chunkMarkdown, initMemoryChunkTables } from '@kinu.run/agent-utils/memory';
import type { CraftStore } from '../types/agent-runtime';
import type {
  Executor, FiberCtx, Memory, RawSqlExec, Schedule, SqlExecutor, VFS,
} from '../types/primitives';
import type { ActorHandle } from './actor-handle';
import type { CraftedTool } from '../types/craft';
import { nanoid } from '../utils/nanoid';
import { decodeJsonValue } from '../utils/json';
import { renderThrownChain } from '../obs/index';
import * as v from 'valibot';

export interface AgentDatabase {
  prepare<T = unknown>(sql: string): { all(...params: unknown[]): T[]; run(...params: unknown[]): void };
  exec(sql: string): void;
  run(sql: string, params?: unknown[]): void;
  transaction<T>(fn: () => T): () => T;
}

export function wrapDatabase(db: AgentDatabase) {
  const sql: SqlExecutor = function <T = unknown>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): T[] {
    const query = strings.reduce((acc, s, i) => acc + s + (i < values.length ? '?' : ''), '');
    // DO storage.sql binds BLOBs as ArrayBuffer; bun:sqlite only binds TypedArrays.
    const bound = values.map((binding) => (binding instanceof ArrayBuffer ? new Uint8Array(binding) : binding));
    const isRead = /^\s*(SELECT|WITH|PRAGMA)/i.test(query);
    const stmt = db.prepare<T>(query);

    if (isRead) return stmt.all(...bound);
    stmt.run(...bound);

    return [];
  };

  const execRaw: RawSqlExec = (ddl: string) => db.exec(ddl);

  return { sql, execRaw };
}

/** Nimbus over a bun:sqlite-style database, storing bytes as a Durable Object does. */
export function createInlineWorkspace(db: AgentDatabase): WorkspaceBundle {
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      const bound = bindings.map((binding) => (binding instanceof ArrayBuffer ? new Uint8Array(binding) : binding ?? null));
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
          db.transaction(cb)(),
      },
    },
    generation: workspaceGenerationStorage(sql),
  });
}

/** LIKE-based search over `memory_chunks`, written through the production chunker and its one DDL owner. */
export function createInlineMemory(db: AgentDatabase, vfs: VFS & Pick<VfsNativeReads, 'readRange'>): Memory {
  const { sql } = wrapDatabase(db);
  initMemoryChunkTables(sql);

  return {
    async write(path, content) { await vfs.writeFile(path, content); },
    async append(path, content) {
      const existing = await vfs.exists(path)
        ? v.parse(v.string(), await vfs.readFile(path, { encoding: 'utf8' }))
        : '';

      await vfs.writeFile(path, existing + content);
    },
    async index(path) {
      // Asked, not caught: an unreadable file must not index as absent.
      if (!await vfs.exists(path)) return;
      const content = v.parse(v.string(), await vfs.readFile(path, { encoding: 'utf8' }));
      const now = Date.now();
      // Replace the chunk set and keep the FTS5 shadow in step for the real MemoryStore.
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

      return v.parse(v.string(), await vfs.readFile(path, { encoding: 'utf8' }));
    },
    tail: (path, bytes) => readTailWithVfsOps(vfs, path, bytes),
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
  };
}

export function createInlineExecutor(): Executor {
  return {
    languages: ['javascript'],
    async execute(code) {
      try {
        const fn = new Function(`return (async () => { ${code} })()`);
        const result: unknown = await fn();

        return {
          result: result === undefined ? '(no return value)' : decodeJsonValue({ value: result }),
        };
      } catch (error) {
        return {
          result: undefined,
          error: renderThrownChain({ cause: error }),
        };
      }
    },
  };
}

export function createInlineSchedule(sql: SqlExecutor, actor: ActorHandle): Schedule {
  // Fiber names repeat across actors, so rows are keyed by actor.
  const actorId = actor.actorId;

  return {
    after: async (_ms, fn) => { await fn(); },
    cron: async () => {},
    fiber: async <T>(name: string, fn: (ctx: FiberCtx) => Promise<T>): Promise<T> => {
      actor.assertCurrent();
      const id = nanoid();
      void sql`INSERT INTO fibers (actor_id, id, name, snapshot, created_at)
        VALUES (${actorId}, ${id}, ${name}, ${null}, ${Date.now()})`;

      const stash: FiberCtx['stash'] = (data) => {
        void sql`UPDATE fibers SET snapshot = ${JSON.stringify(data)}
          WHERE actor_id = ${actorId} AND id = ${id}`;
      };

      try { return await fn({ stash, snapshot: null }); }
      finally { void sql`DELETE FROM fibers WHERE actor_id = ${actorId} AND id = ${id}`; }
    },
  };
}
