import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initUserTables } from '../src/user/schema';
import { sqlExec, taggedSql } from './helpers/user-do';

function columns(db: Database, table: string): string[] {
  return db.prepare<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((row) => row.name);
}

function required<Row>(row: Row | null): Row {
  if (row === null) throw new Error('expected query to return one row');
  return row;
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

    initUserTables(sqlExec(db), taggedSql(db));

    expect(columns(db, 'user_devices')).toContain('token_hash');
    expect(columns(db, 'user_devices')).not.toContain('token');
    const devices = db.prepare<{ n: number }, []>('SELECT COUNT(*) AS n FROM user_devices').get();
    const profile = db.prepare<{ email: string }, []>('SELECT email FROM user_profile WHERE id = 1').get();
    expect(required(devices).n).toBe(0);
    expect(required(profile).email).toBe('person@example.com');
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

    initUserTables(sqlExec(db), taggedSql(db));

    expect(columns(db, 'user_cli_tokens')).toContain('token_hash');
    expect(columns(db, 'user_cli_tokens')).not.toContain('token');
    const tokens = db.prepare<{ n: number }, []>('SELECT COUNT(*) AS n FROM user_cli_tokens').get();
    expect(required(tokens).n).toBe(0);
    db.close();
  });

  test('preserves current hash-token rows', () => {
    const db = new Database(':memory:');
    initUserTables(sqlExec(db), taggedSql(db));
    db.prepare(`
      INSERT INTO user_cli_tokens (token_hash, label, created_at, expires_at)
      VALUES (?, ?, ?, ?)
    `).run('a'.repeat(64), 'current cli', 1, 2);

    initUserTables(sqlExec(db), taggedSql(db));

    const tokens = db.prepare<{ n: number }, []>('SELECT COUNT(*) AS n FROM user_cli_tokens').get();
    expect(required(tokens).n).toBe(1);
    db.close();
  });

  test('the raw-token reset is one-shot: never re-drops once the migration version is recorded', () => {
    const db = new Database(':memory:');
    initUserTables(sqlExec(db), taggedSql(db)); // records the migration ledger version

    // Simulate a FUTURE shape change that happens to look "legacy" to the old
    // boot heuristic (a `token` column). Pre-fix, every boot re-triggered the
    // DROP, silently disconnecting devices / signing out CLIs.
    db.exec(`
      ALTER TABLE user_devices ADD COLUMN token TEXT;
      INSERT INTO user_devices (id, token_hash, label, token) VALUES ('dev-1', 'hash', 'laptop', 'future-shape');
    `);

    initUserTables(sqlExec(db), taggedSql(db));

    expect(columns(db, 'user_devices')).toContain('token');
    const devices = db.prepare<{ n: number }, []>('SELECT COUNT(*) AS n FROM user_devices').get();
    expect(required(devices).n).toBe(1);
    db.close();
  });

  test('records the schema version after the first boot', () => {
    const db = new Database(':memory:');
    initUserTables(sqlExec(db), taggedSql(db));
    const row = db.prepare<{ value: string }, []>(`SELECT value FROM user_schema_meta WHERE key = 'version'`).get();
    expect(Number(required(row).value)).toBeGreaterThanOrEqual(1);
    db.close();
  });

  test('creates hash-only CLI agent websocket ticket table', () => {
    const db = new Database(':memory:');

    initUserTables(sqlExec(db), taggedSql(db));

    const ticketColumns = columns(db, 'cli_agent_connect_tickets');
    expect(ticketColumns).toContain('ticket_hash');
    expect(ticketColumns).toContain('agent_class');
    expect(ticketColumns).toContain('agent_name');
    expect(ticketColumns).toContain('cli_token_hash');
    expect(ticketColumns).toContain('capabilities');
    expect(ticketColumns).not.toContain('ticket');
    const indexes = db.prepare<{ name: string }, []>(`PRAGMA index_list(cli_agent_connect_tickets)`).all()
      .map((row) => row.name);
    expect(indexes).toContain('idx_cli_agent_connect_tickets_exp');
    db.close();
  });

  test('peer-grant store: default deny, idempotent grant, revoke', () => {
    const db = new Database(':memory:');
    initUserTables(sqlExec(db), taggedSql(db));

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
    const grants = db.prepare<{ n: number }, []>('SELECT COUNT(*) AS n FROM user_peer_grants').get();
    expect(required(grants).n).toBe(1);

    db.prepare(`DELETE FROM user_peer_grants WHERE sender_user_id = ? AND sender_agent_name = ?`)
      .run(foreign, 'scout');
    expect(has(foreign, 'scout')).toBe(false);
    db.close();
  });
});
