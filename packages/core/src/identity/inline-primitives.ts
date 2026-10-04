// Inline primitives over a bun:sqlite-style database for createWorkspace; the filesystem is the production one.

import { createWorkspace as createWorkspaceFilesystem, workspaceGenerationStorage } from '../vfs/nimbus-workspace';
import type { WorkspaceBundle, WorkspaceOptions } from '../vfs/nimbus-workspace';
import { CraftStore as AgentUtilsCraftStore } from '@kinu.run/agent-utils/stores';
import type { CraftStore } from '../types/agent-runtime';
import type { RawSqlExec, SqlExec, SqlExecutor, SqlValue, Storage } from '../types/primitives';
import * as v from 'valibot';

export interface AgentDatabase {
  /** Compiled once per text and kept by the database (bun:sqlite's statement cache). */
  query<T = unknown>(sql: string): { all(...params: unknown[]): T[]; run(...params: unknown[]): void };
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

const watchers = new WeakMap<Pick<AgentDatabase, 'query'>, (query: string) => void>();

/** `watch` hears each statement these adapters ran over `db`. */
export function watchStatements(db: Pick<AgentDatabase, 'query'>, watch: (query: string) => void): void {
  watchers.set(db, watch);
}

/** Rows for every statement, as DO storage.sql answers a write's `RETURNING`. */
function sqlExecOver(db: Pick<AgentDatabase, 'query'>) {
  return <T>(query: string, ...bindings: unknown[]): T[] => {
    const rows = db.query<T>(query).all(...bindings.map((binding) => v.parse(SqlBindingSchema, binding)));
    watchers.get(db)?.(query);

    return rows;
  };
}

/** DO storage.sql's cursor: a blob reads back as its own ArrayBuffer. */
export function sqlStorageOver(db: Pick<AgentDatabase, 'query'>): SqlExec {
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
  const transactionSync: Storage['transactionSync'] = (write) => db.transaction(write)();

  return { sql, execRaw, transactionSync };
}

export function inlineWorkspaceStorage(db: AgentDatabase): Pick<WorkspaceOptions, 'sql' | 'transactions'> {
  const exec = sqlExecOver(db);

  const pragma = (name: 'page_count' | 'page_size'): number => (
    v.parse(v.record(v.string(), v.number()), exec(`PRAGMA ${name}`)[0])[name] ?? 0
  );

  return {
    // What free space is reckoned from, as DO storage.sql reports it.
    sql: { exec, get databaseSize() { return pragma('page_count') * pragma('page_size'); } },
    transactions: { storage: { transactionSync: <T,>(callback: () => T): T => db.transaction(callback)() } },
  };
}

export function createInlineWorkspace(db: AgentDatabase): WorkspaceBundle {
  const storage = inlineWorkspaceStorage(db);

  return createWorkspaceFilesystem({ ...storage, generation: workspaceGenerationStorage(storage.sql) });
}

export function createInlineCraftStore(db: AgentDatabase): CraftStore {
  return new AgentUtilsCraftStore(wrapDatabase(db).sql);
}

