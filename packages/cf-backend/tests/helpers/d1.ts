import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function makeD1(db: Database): D1Database {
  const session = {
    prepare(query: string) {
      return {
        bind(...bindings: unknown[]) {
          const stmt = db.prepare(query);
          return {
            async run() {
              stmt.run(...bindings);
              return { success: true };
            },
            async first<T>() {
              return (stmt.get(...bindings) ?? null) as T | null;
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
