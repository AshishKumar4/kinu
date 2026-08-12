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
    expect((db.prepare('SELECT COUNT(*) AS n FROM user_devices').get() as { n: number } | null)!.n).toBe(0);
    expect((db.prepare('SELECT email FROM user_profile WHERE id = 1').get() as { email: string } | null)!.email)
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
    expect((db.prepare('SELECT COUNT(*) AS n FROM user_cli_tokens').get() as { n: number } | null)!.n).toBe(0);
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

    expect((db.prepare('SELECT COUNT(*) AS n FROM user_cli_tokens').get() as { n: number } | null)!.n).toBe(1);
    db.close();
  });

  test('the raw-token reset is one-shot: never re-drops once the migration version is recorded', () => {
    const db = new Database(':memory:');
    initUserTables(sqlExec(db)); // records the migration ledger version

    // Simulate a FUTURE shape change that happens to look "legacy" to the old
    // boot heuristic (a `token` column). Pre-fix, every boot re-triggered the
    // DROP, silently disconnecting devices / signing out CLIs.
    db.exec(`
      ALTER TABLE user_devices ADD COLUMN token TEXT;
      INSERT INTO user_devices (id, token_hash, label, token) VALUES ('dev-1', 'hash', 'laptop', 'future-shape');
    `);

    initUserTables(sqlExec(db));

    expect(columns(db, 'user_devices')).toContain('token');
    expect((db.prepare('SELECT COUNT(*) AS n FROM user_devices').get() as { n: number } | null)!.n).toBe(1);
    db.close();
  });

  test('records the schema version after the first boot', () => {
    const db = new Database(':memory:');
    initUserTables(sqlExec(db));
    const row = db.prepare(`SELECT value FROM user_schema_meta WHERE key = 'version'`).get() as { value: string } | null;
    expect(Number(row!.value)).toBeGreaterThanOrEqual(1);
    db.close();
  });

  test('creates hash-only CLI agent websocket ticket table', () => {
    const db = new Database(':memory:');

    initUserTables(sqlExec(db));

    const ticketColumns = columns(db, 'cli_agent_connect_tickets');
    expect(ticketColumns).toContain('ticket_hash');
    expect(ticketColumns).toContain('agent_class');
    expect(ticketColumns).toContain('agent_name');
    expect(ticketColumns).toContain('cli_token_hash');
    expect(ticketColumns).toContain('capabilities');
    expect(ticketColumns).not.toContain('ticket');
    const indexes = db.prepare(`PRAGMA index_list(cli_agent_connect_tickets)`).all()
      .map((row) => String((row as { name: string }).name));
    expect(indexes).toContain('idx_cli_agent_connect_tickets_exp');
    db.close();
  });

  test('peer-grant store: default deny, idempotent grant, revoke', () => {
    const db = new Database(':memory:');
    initUserTables(sqlExec(db));

    const has = (u: string, a: string) =>
      !!db.prepare(`SELECT 1 FROM user_peer_grants WHERE sender_user_id = ? AND sender_agent_name = ?`).get(u, a);
    const grant = db.prepare(
      `INSERT INTO user_peer_grants (sender_user_id, sender_agent_name, created_at) VALUES (?, ?, ?)
       ON CONFLICT(sender_user_id, sender_agent_name) DO NOTHING`,
    );

    const foreign = 'b'.repeat(32);
    expect(has(foreign, 'scout')).toBe(false);       // default deny

    grant.run(foreign, 'scout', Date.now());
    grant.run(foreign, 'scout', Date.now());         // idempotent
    expect(has(foreign, 'scout')).toBe(true);
    expect(has(foreign, 'other-agent')).toBe(false); // grants are per-agent
    expect((db.prepare('SELECT COUNT(*) AS n FROM user_peer_grants').get() as { n: number } | null)!.n).toBe(1);

    db.prepare(`DELETE FROM user_peer_grants WHERE sender_user_id = ? AND sender_agent_name = ?`)
      .run(foreign, 'scout');
    expect(has(foreign, 'scout')).toBe(false);
    db.close();
  });
});
