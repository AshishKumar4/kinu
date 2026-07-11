import { initProductChangeTables } from '@proteus/core';
import { initAccessTokenTable } from '../cli/access-token-store.js';

// UserDO SQL schema. All tables live inside a single Durable Object instance
// keyed by the stable Proteus userId resolved by the D1 auth store.
// Idempotent — safe to call on every DO boot.

interface SqlExec {
  exec(query: string, ...bindings: unknown[]): { toArray(): Array<Record<string, unknown>> };
}

/** One-shot migration ledger version. Bump it when adding a migration that
 *  must run exactly once (anything destructive or shape-changing); the
 *  idempotent CREATE/ensureColumn statements below need no version. */
const USER_SCHEMA_VERSION = 1;

export function initUserTables(sql: SqlExec): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_schema_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  const fromVersion = schemaVersion(sql);

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

  // Workspaces this user has created (each 1:1 with an OrchestratorAgent DO
  // that hosts the workspace + its default agent). UserDO is the source of
  // truth — replaces the old browser-side localStorage registry.
  // Renamed from user_agents with no back-compat migration by design —
  // pre-production, DB is recreated on deploy (owner decision 2026-06-13).
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_workspaces (
      name          TEXT PRIMARY KEY,
      display_name  TEXT NOT NULL,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      last_visited  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      archived_at   INTEGER
    )
  `);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_user_workspaces_last_visited ON user_workspaces (last_visited DESC)`);

  // Cross-owner peer-messaging grants: which foreign (sender_user_id,
  // sender_agent_name) pairs may message THIS user's agents. Enforced by the
  // receiving agent's receivePeerMessage via UserDO.hasPeerGrant — default
  // deny; same-owner peers never need a row here.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_peer_grants (
      sender_user_id    TEXT NOT NULL,
      sender_agent_name TEXT NOT NULL,
      created_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      PRIMARY KEY (sender_user_id, sender_agent_name)
    )
  `);

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

  // User-level MCP server registry. Tokens + dynamic client registrations
  // live under separate keys written by DurableObjectOAuthClientProvider into
  // the same DO storage; this table holds only the user-visible config.
  //
  // `transport` is one of: 'auto' (streamable-http with SSE fallback) | 'sse'
  // | 'streamable-http'. `headers` is an optional JSON object of static
	  // request headers (e.g. Bearer tokens for self-hosted/private servers).
  // `allowed_tools` is a JSON array of MCP tool names; null = expose all.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_mcp_servers (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      server_url    TEXT NOT NULL,
      transport     TEXT NOT NULL,
      headers       TEXT,
      allowed_tools TEXT,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_user_mcp_servers_name ON user_mcp_servers (name)`);

  // User-level connected devices (laptops/PCs). One row per device the user has
  // linked via `proteus connect`. The reverse-WS tunnel + the live socket live
  // on THIS UserDO (the user-level hub) so every one of the user's agents can
  // request the device. `token_hash` is the device's long-lived connect secret;
  // raw tokens are returned only once to the authenticated CLI and never stored.
  if (fromVersion < 1) resetRawTokenTable(sql, 'user_devices');
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_devices (
      id            TEXT PRIMARY KEY,
      token_hash    TEXT NOT NULL,
      label         TEXT NOT NULL,
      os            TEXT,
      hostname      TEXT,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      connected_at  INTEGER,
      last_seen_at  INTEGER,
      revoked_at    INTEGER
    )
  `);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_user_devices_token_hash ON user_devices (token_hash)`);

  // CLI bearer tokens minted by the browser device-code approval flow. Tokens
  // include the UserDO id as a routing hint, but only their SHA-256 hash is
  // stored. The CLI presents the raw token as Authorization: Bearer <token>.
  if (fromVersion < 1) resetRawTokenTable(sql, 'user_cli_tokens');
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_cli_tokens (
      token_hash  TEXT PRIMARY KEY,
      label       TEXT NOT NULL,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      expires_at  INTEGER NOT NULL,
      last_used_at INTEGER,
      revoked_at  INTEGER
    )
  `);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_user_cli_tokens_active ON user_cli_tokens (expires_at, revoked_at)`);

  // Long-lived, scoped CI access tokens (`pta_…`) — table shape owned by the
  // access-token store next to the rest of the CLI bearer machinery.
  initAccessTokenTable(sql);

  // Per-(agent, device) consent policy. Ask-once-then-remember: a missing row
  // means ASK (the agent raises a card in chat the first time it touches the
  // device); 'allow' / 'deny' are the remembered decisions. One device, many
  // agents — each agent earns its own consent.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS device_consent (
      agent_name  TEXT NOT NULL,
      device_id   TEXT NOT NULL,
      policy      TEXT NOT NULL,
      scope       TEXT NOT NULL DEFAULT 'all_local_actions',
      last_method TEXT,
      last_summary TEXT,
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      PRIMARY KEY (agent_name, device_id)
    )
  `);
  ensureColumn(sql, 'device_consent', 'scope', "TEXT NOT NULL DEFAULT 'all_local_actions'");
  ensureColumn(sql, 'device_consent', 'last_method', 'TEXT');
  ensureColumn(sql, 'device_consent', 'last_summary', 'TEXT');

  // Short-lived, single-use WebSocket tickets for device daemon reconnects.
  // The daemon exchanges its long-lived local device token over HTTPS, then
  // connects the WebSocket with this scoped ticket in the URL. That keeps raw
  // long-lived device tokens out of request URLs and edge logs.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS device_connect_tickets (
      ticket_hash TEXT PRIMARY KEY,
      device_id   TEXT NOT NULL,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      expires_at  INTEGER NOT NULL,
      used_at     INTEGER
    )
  `);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_device_connect_tickets_exp ON device_connect_tickets (expires_at, used_at)`);

  // Short-lived, single-use WebSocket tickets for CLI clients connecting to
  // the real agent DO chat route. Stores only the hash of the raw ticket.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS cli_agent_connect_tickets (
      ticket_hash    TEXT PRIMARY KEY,
      user_id        TEXT NOT NULL,
      agent_class    TEXT NOT NULL,
      agent_name     TEXT NOT NULL,
      cli_token_hash TEXT NOT NULL,
      capabilities   TEXT NOT NULL,
      created_at     INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      expires_at     INTEGER NOT NULL,
      used_at        INTEGER
    )
  `);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_cli_agent_connect_tickets_exp ON cli_agent_connect_tickets (expires_at, used_at)`);

  initProductChangeTables(sql);

  if (fromVersion < USER_SCHEMA_VERSION) {
    sql.exec(
      `INSERT INTO user_schema_meta (key, value) VALUES ('version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      String(USER_SCHEMA_VERSION),
    );
  }
}

function schemaVersion(sql: SqlExec): number {
  const row = sql.exec(`SELECT value FROM user_schema_meta WHERE key = 'version'`).toArray()[0];
  const version = Number(row?.value);
  return Number.isInteger(version) && version > 0 ? version : 0;
}

function ensureColumn(sql: SqlExec, table: string, column: string, ddl: string): void {
  const rows = sql.exec(`PRAGMA table_info(${table})`).toArray();
  if (rows.some((r) => r.name === column)) return;
  sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

/** v1 (one-shot): pre-release builds stored raw tokens or lacked the hash
 *  column. Those rows cannot be safely migrated in a Worker SQLite boot hook,
 *  and retaining them would preserve the old security flaw — so the affected
 *  token tables are reset. Gated on the migration ledger so this destructive
 *  path can never re-trigger against a future table shape. */
function resetRawTokenTable(sql: SqlExec, table: 'user_devices' | 'user_cli_tokens'): void {
  const rows = sql.exec(`PRAGMA table_info(${table})`).toArray();
  if (rows.length === 0) return;
  const names = new Set(rows.map((r) => String(r.name)));
  if (names.has('token_hash') && !names.has('token')) return;
  sql.exec(`DROP TABLE ${table}`);
}
