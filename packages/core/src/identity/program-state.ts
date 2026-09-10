import * as v from 'valibot';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import { JsonValueSchema, parseJsonValue, type JsonValue } from '../utils/json';

export const KeySchema = v.pipe(v.string(), v.minLength(1), v.maxLength(512));

export interface ProgramStateStore {
  get(key: string): JsonValue;
  set(key: string, value: JsonValue): void;
  delete(key: string): void;
  list(prefix?: string): string[];
}

export function initCodemodeStateTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS actor_program_state (
    actor_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (actor_id, key)
  )`);
}

/** SQL stays in the trusted store. Programs receive only the four state operations. */
export function createProgramStateStore(sql: SqlExecutor, actorId: string, authorize: () => void): ProgramStateStore {
  return {
    get(key) {
      authorize();
      v.parse(KeySchema, key);
      const row = sql<{ value: string }>`SELECT value FROM actor_program_state WHERE actor_id = ${actorId} AND key = ${key}`[0];
      return row === undefined ? null : parseJsonValue(row.value);
    },
    set(key, value) {
      authorize();
      v.parse(KeySchema, key);
      const encoded = JSON.stringify(v.parse(JsonValueSchema, value));
      void sql`INSERT INTO actor_program_state (actor_id, key, value, updated_at) VALUES (${actorId}, ${key}, ${encoded}, ${Date.now()})
        ON CONFLICT(actor_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`;
    },
    delete(key) {
      authorize();
      v.parse(KeySchema, key);
      void sql`DELETE FROM actor_program_state WHERE actor_id = ${actorId} AND key = ${key}`;
    },
    list(prefix) {
      authorize();
      const pattern = `${(prefix ?? '').replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`;
      return sql<{ key: string }>`SELECT key FROM actor_program_state
        WHERE actor_id = ${actorId} AND key LIKE ${pattern} ESCAPE '\\' ORDER BY updated_at ASC, key ASC`
        .map((row) => row.key);
    },
  };
}
