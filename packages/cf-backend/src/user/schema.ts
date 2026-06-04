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

  // User-level MCP server registry. Tokens + dynamic client registrations
  // live under separate keys written by DurableObjectOAuthClientProvider into
  // the same DO storage; this table holds only the user-visible config.
  //
  // `transport` is one of: 'auto' (streamable-http with SSE fallback) | 'sse'
  // | 'streamable-http'. `headers` is an optional JSON object of static
  // request headers (e.g. CF Access service tokens, Bearer for self-hosted).
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
  // linked via `proteus connect` / the Devices tab. The reverse-WS tunnel + the
  // live socket live on THIS UserDO (the user-level hub) so every one of the
  // user's agents can request the device — not per-agent like the old scheme.
  // `token` is the device's connect secret; the daemon presents it on
  // /pc/connect. os/hostname arrive in the daemon HELLO.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_devices (
      id            TEXT PRIMARY KEY,
      token         TEXT NOT NULL,
      label         TEXT NOT NULL,
      os            TEXT,
      hostname      TEXT,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      connected_at  INTEGER,
      last_seen_at  INTEGER,
      revoked_at    INTEGER
    )
  `);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_user_devices_token ON user_devices (token)`);

  // CLI bearer tokens minted by the browser device-code approval flow. Tokens
  // include the UserDO id as a routing hint, but only their SHA-256 hash is
  // stored. The CLI presents the raw token as Authorization: Bearer <token>.
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

  // Per-(agent, device) consent policy. Ask-once-then-remember: a missing row
  // means ASK (the agent raises a card in chat the first time it touches the
  // device); 'allow' / 'deny' are the remembered decisions. One device, many
  // agents — each agent earns its own consent.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS device_consent (
      agent_name  TEXT NOT NULL,
      device_id   TEXT NOT NULL,
      policy      TEXT NOT NULL,
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      PRIMARY KEY (agent_name, device_id)
    )
  `);
}
