// UserDO SQL schema. All tables live inside a single Durable Object instance
// keyed by userId (sha256(email) truncated). Idempotent — safe to call on
// every DO boot.

interface SqlExec {
  exec(query: string, ...bindings: unknown[]): { toArray(): Array<Record<string, unknown>> };
}

export function initUserTables(sql: SqlExec): void {
  // Profile: one row per UserDO instance (this user).
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_profile (
      id           INTEGER PRIMARY KEY CHECK (id = 1),
      email        TEXT NOT NULL,
      display_name TEXT,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      last_seen_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);

  // Agents this user has created. UserDO is the source of truth — replaces
  // the old browser-side localStorage registry.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_agents (
      name          TEXT PRIMARY KEY,
      display_name  TEXT NOT NULL,
      purpose       TEXT,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      last_visited  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      archived_at   INTEGER
    )
  `);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_user_agents_last_visited ON user_agents (last_visited DESC)`);

  // Credentials (the source-of-truth secret store). Value is JSON-encoded
  // Credential discriminated union (kind: bearer | oauth | openai-compat).
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_credentials (
      key        TEXT PRIMARY KEY,
      kind       TEXT NOT NULL,
      value      TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);

  // User-level config (key/value). Defaults that new agents inherit:
  // default_model, default_strategy, default_inference_loop, default_approval_mode.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_config (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);

  // In-flight Codex device-code state (deviceAuthId + userCode), one per
  // attempt. Cleared on successful poll or disconnect.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS codex_device_flow (
      id              INTEGER PRIMARY KEY CHECK (id = 1),
      device_auth_id  TEXT NOT NULL,
      user_code       TEXT NOT NULL,
      poll_interval   INTEGER NOT NULL,
      portal_url      TEXT NOT NULL,
      started_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);
}
