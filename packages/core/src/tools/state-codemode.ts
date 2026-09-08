import * as v from 'valibot';
import type { CodemodeProvider } from './sandbox-contract';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import { JsonValueSchema, parseJsonValue, type JsonValue } from '../utils/json';
import { KinuError, refusalOf } from '../obs/error';

export const STATE_NAMESPACE = 'state';
const KeySchema = v.pipe(v.string(), v.minLength(1), v.maxLength(512));
const PrefixSchema = v.optional(v.string());

export const STATE_TYPES = `type StateValue = null | boolean | number | string | StateValue[] | { [key: string]: StateValue };
export declare const state: {
  get(key: string): Promise<StateValue>;
  set(key: string, value: StateValue): Promise<{ ok: true }>;
  delete(key: string): Promise<{ ok: true }>;
  list(prefix?: string): Promise<string[]>;
};`;

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

export function createStateCodemodeProvider(state: ProgramStateStore): CodemodeProvider {
  return {
    name: STATE_NAMESPACE, types: STATE_TYPES, positionalArgs: true,
    tools: {
      get: {
        planAllowed: true, description: 'Read a saved JSON value; null when absent.',
        execute: async (...args) => {
          const key = v.safeParse(KeySchema, args[0]);
          if (!key.success) return refusalOf(new KinuError('bad_input', 'state.get(key): key must be a non-empty string'));
          return state.get(key.output);
        },
      },
      set: {
        planAllowed: true, description: 'Save a JSON value under a key.',
        execute: async (...args) => {
          const key = v.safeParse(KeySchema, args[0]);
          if (!key.success) return refusalOf(new KinuError('bad_input', 'state.set(key, value): key must be a non-empty string'));
          const value = v.safeParse(JsonValueSchema, args[1] === undefined ? null : args[1]);
          if (!value.success) return refusalOf(new KinuError('bad_input', 'state.set(key, value): value must be JSON-serializable'));
          state.set(key.output, value.output);
          return { ok: true };
        },
      },
      delete: {
        planAllowed: true, description: 'Remove a saved key.',
        execute: async (...args) => {
          const key = v.safeParse(KeySchema, args[0]);
          if (!key.success) return refusalOf(new KinuError('bad_input', 'state.delete(key): key must be a non-empty string'));
          state.delete(key.output);
          return { ok: true };
        },
      },
      list: {
        planAllowed: true, description: 'List saved keys, optionally under a prefix.',
        execute: async (...args) => {
          const prefix = v.safeParse(PrefixSchema, args[0]);
          if (!prefix.success) return refusalOf(new KinuError('bad_input', 'state.list(prefix?): prefix must be a string'));
          return state.list(prefix.output);
        },
      },
    },
  };
}
