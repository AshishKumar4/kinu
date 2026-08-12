import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** `onQuery` fires before each statement executes — lets tests count
 *  statements or inject concurrent writes to simulate races. */
export function makeD1(db: Database, onQuery?: (query: string) => void): D1Database {
  const session = {
    prepare(query: string) {
      return {
        bind(...bindings: unknown[]) {
          return {
            async run() {
              onQuery?.(query);
              db.prepare(query).run(...(bindings as SQLQueryBindings[]));
              return { success: true };
            },
            async first<T>() {
              onQuery?.(query);
              return (db.prepare(query).get(...(bindings as SQLQueryBindings[])) ?? null) as T | null;
            },
          };
        },
      };
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      const out = [];
      for (const stmt of statements) out.push(await stmt.run());
      return out;
    },
    getBookmark() {
      return null;
    },
  };
  return {
    withSession() {
      return session;
    },
  } as unknown as D1Database;
}

export function createAuthDatabase(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(join(import.meta.dir, '../../migrations/auth/0001_auth_tables.sql'), 'utf8'));
  return db;
}
