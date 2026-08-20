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
