import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initUserTables } from '@kinu.run/core';
import { sqlExec } from './helpers/user-do';

function columns(db: Database, table: string): string[] {
  return db.prepare<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((row) => row.name);
}

function required<Row>(row: Row | null): Row {
  if (row === null) throw new Error('expected query to return one row');

  return row;
}

describe('UserDO schema bootstrap', () => {
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

    const indexes = db.prepare<{ name: string }, []>(`PRAGMA index_list(cli_agent_connect_tickets)`).all()
      .map((row) => row.name);

    expect(indexes).toContain('idx_cli_agent_connect_tickets_exp');
    db.close();
  });

  test('the catalog CAS version is part of user_config, with no parallel table', () => {
    const db = new Database(':memory:');
    initUserTables(sqlExec(db));
    db.run(
      `INSERT INTO user_config (key, value, updated_at) VALUES (?, ?, ?)`,
      ['default_model', 'workers-ai/example', 1],
    );

    expect(columns(db, 'user_config')).toEqual(['key', 'value', 'updated_at', 'version']);

    const row = required(db.query<{ value: string; version: number }, []>(
      `SELECT value, version FROM user_config WHERE key = 'default_model'`,
    ).get());

    expect(row).toEqual({ value: 'workers-ai/example', version: 0 });

    const tables = db.query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type = 'table'`,
    ).all().map((entry) => entry.name);

    expect(tables).not.toContain('profile_catalog');
    db.close();
  });

  test('peer-grant store: default deny, idempotent grant, revoke', () => {
    const db = new Database(':memory:');
    initUserTables(sqlExec(db));

    const has = (u: string, a: string) =>
      Boolean(db.prepare(`SELECT 1 FROM user_peer_grants WHERE sender_user_id = ? AND sender_agent_name = ?`).get(u, a));

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

  test('every column a writer names is in the CREATE that owns the table', () => {
    // A writer naming a column the CREATE lacks fails with `no such column` at runtime, uncaught.
    const db = new Database(':memory:');
    initUserTables(sqlExec(db));

    expect(columns(db, 'user_devices')).toEqual([
      'id', 'token_hash', 'prev_token_hash', 'label', 'os', 'hostname',
      'created_at', 'connected_at', 'last_seen_at', 'expires_at', 'revoked_at',
      'last_ip', 'last_agent', 'replaced_at',
      'consented_root', 'device_home', 'sandbox_capability', 'sandbox_reason', 'sandbox_detail', 'sandbox_gpu',
      'agent_root', 'tier', 'unstopped_at',
    ]);
    // `user_devices` is shipped storage: a column added to it never reaches pre-existing accounts.
    expect(columns(db, 'user_device_builds')).toEqual([
      'device_id', 'version', 'update_check', 'reported_at',
    ]);
    expect(columns(db, 'device_inflight_requests')).toEqual([
      'request_id', 'device_id', 'workspace', 'turn_id', 'background_job_id',
      'cancel_claim', 'cancel_outcome',
    ]);
    expect(columns(db, 'device_consent')).toEqual([
      'agent_name', 'device_id', 'policy', 'last_method',
      'last_summary', 'updated_at',
    ]);
    // `user_mcp_servers` is shipped storage: a column added to it never reaches pre-existing accounts.
    expect(columns(db, 'user_mcp_servers')).toEqual([
      'id', 'name', 'server_url', 'transport', 'headers', 'allowed_tools',
      'created_at', 'updated_at',
    ]);
    expect(columns(db, 'user_mcp_server_presets')).toEqual(['server_id', 'preset_id']);
    expect(columns(db, 'user_workspaces')).toContain('name_origin');
    db.close();
  });

  test('the MCP server-name constraint is built on a database that can hold it', () => {
    const db = new Database(':memory:');
    initUserTables(sqlExec(db));

    const indexes = db.prepare<{ name: string }, []>(`PRAGMA index_list(user_mcp_servers)`).all()
      .map((row) => row.name);

    expect(indexes).toContain('idx_user_mcp_servers_name_unique');
    expect(indexes).not.toContain('idx_user_mcp_servers_name');
    db.close();
  });

  test('a database already holding two case-colliding names still opens', () => {
    // `initUserTables` runs before every `sqlx` read, and `CREATE UNIQUE INDEX` over colliding rows raises,
    // failing every activation for that user. Concurrent adds can already have stored such rows.
    const db = new Database(':memory:');
    initUserTables(sqlExec(db));
    db.run(`DROP INDEX idx_user_mcp_servers_name_unique`);

    for (const [id, name] of [['a', 'GitHub'], ['b', 'github']]) {
      db.run(
        `INSERT INTO user_mcp_servers (id, name, server_url, transport) VALUES (?, ?, ?, ?)`,
        [id, name, 'https://example.invalid/mcp', 'http'],
      );
    }

    expect(() => { initUserTables(sqlExec(db)); }).not.toThrow();

    // Skipped, rows untouched: repairing a user's server names is not a schema pass's decision.
    const indexes = db.prepare<{ name: string }, []>(`PRAGMA index_list(user_mcp_servers)`).all()
      .map((row) => row.name);

    expect(indexes).not.toContain('idx_user_mcp_servers_name_unique');
    expect(db.prepare<{ n: number }, []>(`SELECT COUNT(*) AS n FROM user_mcp_servers`).get()?.n).toBe(2);

    // The condition is read every activation, not remembered.
    expect(() => { initUserTables(sqlExec(db)); }).not.toThrow();
    db.close();
  });
});
