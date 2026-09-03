/**
 * `state.*` — a key/value store the agent's programs keep between
 * `execute_tools` calls.
 *
 * Every sandbox run is a fresh isolate: a variable set in one program is gone
 * in the next. This namespace is the durable half. Values are JSON, stored in
 * the actor's own SQLite beside its conversation, so what a program saved is
 * there on the next call, the next turn and the next activation.
 */
import * as v from 'valibot';
import type { CodemodeProvider } from './sandbox-contract';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import { JsonValueSchema, parseJsonValue, type JsonValue } from '../utils/json';

export const STATE_NAMESPACE = 'state';

const KeySchema = v.pipe(v.string(), v.minLength(1), v.maxLength(512));
const PrefixSchema = v.optional(v.string());

export const STATE_TYPES = `export declare const state: {
  /** Read a value saved by an earlier program. Resolves to null when the key is absent. */
  get(key: string): Promise<unknown>;
  /** Save any JSON value under a key. Overwrites. */
  set(key: string, value: unknown): Promise<{ ok: true }>;
  /** Remove a key. */
  delete(key: string): Promise<{ ok: true }>;
  /** Keys saved so far, optionally under a prefix, oldest first. */
  list(prefix?: string): Promise<string[]>;
};
`;

/** Idempotent DDL for the store. Call once per activation on the actor's SQL. */
export function initCodemodeStateTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS codemode_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
}

/** The `state` sandbox namespace over one actor's SQL executor. */
export function createStateCodemodeProvider(sql: SqlExecutor): CodemodeProvider {
  return {
    name: STATE_NAMESPACE,
    types: STATE_TYPES,
    positionalArgs: true,
    tools: {
      get: {
        description: 'Read a value saved by an earlier program; null when absent.',
        execute: async (...args: unknown[]) => {
          const key = v.safeParse(KeySchema, args[0]);
          if (!key.success) return { error: 'state.get(key): key must be a non-empty string' };
          const rows = sql<{ value: string }>`SELECT value FROM codemode_state WHERE key = ${key.output}`;
          const row = rows[0];
          return row === undefined ? null : parseJsonValue(row.value);
        },
      },
      set: {
        description: 'Save a JSON value under a key (overwrites).',
        execute: async (...args: unknown[]) => {
          const key = v.safeParse(KeySchema, args[0]);
          if (!key.success) return { error: 'state.set(key, value): key must be a non-empty string' };
          const value = v.safeParse(JsonValueSchema, args[1] === undefined ? null : args[1]);
          if (!value.success) return { error: 'state.set(key, value): value must be JSON-serializable' };
          const encoded: JsonValue = value.output;
          void sql`INSERT INTO codemode_state (key, value, updated_at) VALUES (${key.output}, ${JSON.stringify(encoded)}, ${Date.now()})
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`;
          return { ok: true };
        },
      },
      delete: {
        description: 'Remove a key.',
        execute: async (...args: unknown[]) => {
          const key = v.safeParse(KeySchema, args[0]);
          if (!key.success) return { error: 'state.delete(key): key must be a non-empty string' };
          void sql`DELETE FROM codemode_state WHERE key = ${key.output}`;
          return { ok: true };
        },
      },
      list: {
        description: 'Keys saved so far, optionally under a prefix.',
        execute: async (...args: unknown[]) => {
          const prefix = v.safeParse(PrefixSchema, args[0]);
          if (!prefix.success) return { error: 'state.list(prefix?): prefix must be a string' };
          const pattern = `${(prefix.output ?? '').replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`;
          const rows = sql<{ key: string }>`SELECT key FROM codemode_state WHERE key LIKE ${pattern} ESCAPE '\\' ORDER BY updated_at ASC, key ASC`;
          return rows.map((row) => row.key);
        },
      },
    },
  };
}
