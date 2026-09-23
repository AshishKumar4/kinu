// Inline primitives over a bun:sqlite-style database for createWorkspace; the filesystem is the production one.

import { createWorkspace as createWorkspaceFilesystem, workspaceGenerationStorage } from '../vfs/nimbus-workspace';
import type { WorkspaceBundle, WorkspaceOptions } from '../vfs/nimbus-workspace';
import { readTailWithVfsOps, type VfsNativeReads } from '../vfs/mounts';
import { chunkMarkdown, initMemoryChunkTables } from '@kinu.run/agent-utils/memory';
import { CraftStore as AgentUtilsCraftStore, craftStoreView } from '@kinu.run/agent-utils/stores';
import type { CraftStore } from '../types/agent-runtime';
import type {
  Executor, FiberCtx, Memory, RawSqlExec, Schedule, SqlExec, SqlExecutor, SqlValue, VFS,
} from '../types/primitives';
import type { ActorHandle } from './actor-handle';
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

/** Bun would store an object as NULL, so one is refused. */
const SqlBindingSchema = v.union([
  v.string(), v.number(), v.bigint(), v.boolean(), v.null(),
  v.pipe(v.undefined(), v.transform(() => null)),
  v.pipe(v.instance(ArrayBuffer), v.transform((bytes) => new Uint8Array(bytes))),
  v.pipe(
    v.custom<ArrayBufferView>((value) => ArrayBuffer.isView(value), 'a byte view'),
    v.transform((view) => new Uint8Array(view.buffer, view.byteOffset, view.byteLength)),
  ),
]);

/** Rows for every statement, as DO storage.sql answers a write's `RETURNING`. */
function sqlExecOver(db: Pick<AgentDatabase, 'prepare'>) {
  return <T>(query: string, ...bindings: unknown[]): T[] =>
    db.prepare<T>(query).all(...bindings.map((binding) => v.parse(SqlBindingSchema, binding)));
}

/** DO storage.sql's cursor: a blob reads back as its own ArrayBuffer. */
export function sqlStorageOver(db: Pick<AgentDatabase, 'prepare'>): SqlExec {
  const exec = sqlExecOver(db);

  return {
    exec(query, ...bindings) {
      const rows = exec<Record<string, SqlValue | Uint8Array>>(query, ...bindings).map((row) => Object.fromEntries(
        Object.entries(row).map(([column, value]) => [column, value instanceof Uint8Array ? new Uint8Array(value).buffer : value]),
      ));

      return { toArray: () => rows };
    },
  };
}

export function wrapDatabase(db: AgentDatabase) {
  const exec = sqlExecOver(db);

  const sql: SqlExecutor = <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): T[] =>
    exec<T>(strings.join('?'), ...values);

  const execRaw: RawSqlExec = (ddl: string) => db.exec(ddl);

  return { sql, execRaw };
}

export function inlineWorkspaceStorage(db: AgentDatabase): Pick<WorkspaceOptions, 'sql' | 'transactions'> {
  return {
    sql: { exec: sqlExecOver(db) },
    transactions: { storage: { transactionSync: <T,>(callback: () => T): T => db.transaction(callback)() } },
  };
}

export function createInlineWorkspace(db: AgentDatabase): WorkspaceBundle {
  const storage = inlineWorkspaceStorage(db);

  return createWorkspaceFilesystem({ ...storage, generation: workspaceGenerationStorage(storage.sql) });
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
  return craftStoreView(new AgentUtilsCraftStore(wrapDatabase(db).sql));
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
