// DO-SQL backed CredentialStore. One row per agent + key. Values are JSON-encoded.
import type { Credential, CredentialStore } from '@proteus/core';

interface SqlExec {
  exec(query: string, ...bindings: unknown[]): { toArray(): Array<Record<string, unknown>> };
}

export function initCredentialsTable(sql: SqlExec): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS agent_credentials (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);
}

export function createSqlCredentialStore(sql: SqlExec): CredentialStore {
  initCredentialsTable(sql);

  return {
    async get(key) {
      const rows = sql.exec(
        'SELECT value FROM agent_credentials WHERE key = ?', key,
      ).toArray();
      const raw = rows[0]?.value;
      if (typeof raw !== 'string') return null;
      try { return JSON.parse(raw) as Credential; }
      catch { return null; }
    },

    async set(key, value) {
      sql.exec(
        `INSERT INTO agent_credentials (key, value, updated_at) VALUES (?, ?, unixepoch() * 1000)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        key, JSON.stringify(value),
      );
    },

    async delete(key) {
      sql.exec('DELETE FROM agent_credentials WHERE key = ?', key);
    },

    async update(key, mutate) {
      // DO storage is single-threaded — no external locking needed; cross-
      // request concurrency on the same row is serialized by the DO event loop.
      const rows = sql.exec('SELECT value FROM agent_credentials WHERE key = ?', key).toArray();
      const raw = rows[0]?.value;
      let current: Credential | null = null;
      if (typeof raw === 'string') {
        try { current = JSON.parse(raw) as Credential; } catch { current = null; }
      }
      const next = await mutate(current);
      if (next === null || next === undefined) {
        sql.exec('DELETE FROM agent_credentials WHERE key = ?', key);
        return null;
      }
      sql.exec(
        `INSERT INTO agent_credentials (key, value, updated_at) VALUES (?, ?, unixepoch() * 1000)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        key, JSON.stringify(next),
      );
      return next;
    },
  };
}
