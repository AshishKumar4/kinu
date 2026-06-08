import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initUserTables } from '../src/user/schema.js';

function sqlExec(db: Database) {
  return {
    exec(query: string, ...bindings: unknown[]) {
      const statement = db.prepare(query);
      const trimmed = query.trim().toUpperCase();
      const reads = trimmed.startsWith('SELECT') || trimmed.startsWith('PRAGMA');
      if (reads) return { toArray: () => statement.all(...(bindings as never[])) as Array<Record<string, unknown>> };
      statement.run(...(bindings as never[]));
      return { toArray: () => [] as Array<Record<string, unknown>> };
    },
  };
}

function columns(db: Database, table: string): string[] {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((r) => String((r as { name: string }).name));
}

describe('UserDO schema bootstrap', () => {
  test('replaces pre-release raw-token device table with hash-only shape', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE user_profile (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        email TEXT NOT NULL,
        display_name TEXT,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      INSERT INTO user_profile (id, email, created_at, last_seen_at)
      VALUES (1, 'person@example.com', 1, 1);
      CREATE TABLE user_devices (
        id TEXT PRIMARY KEY,
        token TEXT NOT NULL,
        label TEXT NOT NULL
      );
      INSERT INTO user_devices (id, token, label) VALUES ('dev-old', 'raw-secret', 'old laptop');
    `);

    initUserTables(sqlExec(db));

    expect(columns(db, 'user_devices')).toContain('token_hash');
    expect(columns(db, 'user_devices')).not.toContain('token');
    expect(db.prepare('SELECT COUNT(*) AS n FROM user_devices').get<{ n: number }>()!.n).toBe(0);
    expect(db.prepare('SELECT email FROM user_profile WHERE id = 1').get<{ email: string }>()!.email)
      .toBe('person@example.com');
    db.close();
  });

  test('replaces malformed CLI token table instead of preserving unhashed rows', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE user_cli_tokens (
        token TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO user_cli_tokens (token, label, created_at)
      VALUES ('raw-cli-token', 'old cli', 1);
    `);

    initUserTables(sqlExec(db));

    expect(columns(db, 'user_cli_tokens')).toContain('token_hash');
    expect(columns(db, 'user_cli_tokens')).not.toContain('token');
    expect(db.prepare('SELECT COUNT(*) AS n FROM user_cli_tokens').get<{ n: number }>()!.n).toBe(0);
    db.close();
  });

  test('preserves current hash-token rows', () => {
    const db = new Database(':memory:');
    initUserTables(sqlExec(db));
    db.prepare(`
      INSERT INTO user_cli_tokens (token_hash, label, created_at, expires_at)
      VALUES (?, ?, ?, ?)
    `).run('a'.repeat(64), 'current cli', 1, 2);

    initUserTables(sqlExec(db));

    expect(db.prepare('SELECT COUNT(*) AS n FROM user_cli_tokens').get<{ n: number }>()!.n).toBe(1);
    db.close();
  });
});
