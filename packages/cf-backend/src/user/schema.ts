// UserDO SQL schema. All tables live inside a single Durable Object instance
// keyed by the stable Kinu userId the auth store derives from the email.
// Idempotent — safe to call on every DO boot.
//
// EVERY COLUMN BELOW IS IN ITS CREATE. Columns added after release also stay in
// the adjacent reconciliation object: CREATE TABLE IF NOT EXISTS is a no-op on
// an older UserDO, while every reader immediately names the current columns.
// This is shape repair, not a migration framework — no versions or data rewrites.

import {
  initExperienceLibraryTables,
  initReleaseTables,
  reconcileSqlExecColumns,
  type SqlExec,
} from '@kinu.run/core';
import { initAccessTokenTable } from '../cli/access-token-store';
import { initDeviceInflightTable } from './device-inflight';
import { initEgressVaultTables } from './egress-vault';
import { initWorkspaceCapabilityTables } from './workspace-capability';

/** The sole account profile-catalog row in user_config. */
export const PROFILE_CATALOG_CONFIG_KEY = 'profile_catalog';

const USER_WORKSPACE_ADDED_COLUMNS = {
  name_origin: "TEXT NOT NULL DEFAULT 'user' CHECK (name_origin IN ('auto', 'user'))",
  delete_pending: 'INTEGER NOT NULL DEFAULT 0',
  create_pending: 'INTEGER NOT NULL DEFAULT 0',
  fork_lease_expires_at: 'INTEGER',
} as const;

const CODEX_DEVICE_FLOW_ADDED_COLUMNS = {
  generation: 'INTEGER NOT NULL DEFAULT 1',
  settled_at: 'INTEGER',
} as const;

const USER_CLI_TOKEN_ADDED_COLUMNS = {
  authorization_hash: 'TEXT',
} as const;

// `user_devices` shipped 2026-06-12 with nine columns; every device security
// hardening since has added one, and a UserDO first created before them keeps
// its old shape because CREATE TABLE IF NOT EXISTS is a no-op on it. That
// reached production as `no such column: unstopped_at` on GET /api/cli/devices,
// which also failed `kinu connect` on a machine whose daemon had connected.
const USER_DEVICES_ADDED_COLUMNS = {
  // Superseded secret, held until the new one is first used, so a rotation
  // message lost with the socket does not brick the machine.
  prev_token_hash: 'TEXT',
  // Rotation window, absolute from the last accept.
  expires_at: 'INTEGER',
  // Provenance of the newest accept and the record that a second socket took
  // the slot — rendered in Account settings because a silent takeover is the
  // shape these three columns exist to expose.
  last_ip: 'TEXT',
  last_agent: 'TEXT',
  replaced_at: 'INTEGER',
  // Revocation found a command it could not confirm stopped. Owner-visible
  // fact; survives removal of the active in-flight row.
  unstopped_at: 'INTEGER',
  // The directory `kinu connect` ran in, and the machine's home, both carried
  // on HELLO. A workspace's file view is scoped to `consented_root`, so it is
  // one directory the owner NAMED rather than a default the hub computed; a
  // row with none has no scoped file access at all. `device_home` is what
  // the file view opens at, and it exists so the hub never has to run a
  // command on the machine to learn a path.
  consented_root: 'TEXT',
  device_home: 'TEXT',
  // What the daemon PROVED about sandboxing when it started, and why it could
  // not. A row with neither reads as `files_only`: a machine that has not
  // proved it can sandbox has not proved it can sandbox, and the sandbox tier
  // then runs nothing rather than quietly running everything unconfined.
  sandbox_capability: 'TEXT',
  sandbox_reason: 'TEXT',
  // GPU device nodes the daemon found, as a JSON array.
  sandbox_gpu: 'TEXT',
  // Where this machine keeps agent homes (`<home>/.kinu/agents`), reported on
  // HELLO. The hub composes `<agent_root>/<workspace>/home` per exec, so it
  // never guesses a path on someone else's machine.
  agent_root: 'TEXT',
  // The owner's Sandbox switch for this device. Defaulted rather than
  // nullable: the switch is ON, and a row written before the column existed
  // must read as on.
  tier: `TEXT NOT NULL DEFAULT 'sandboxed'`,
} as const;

// A ticket bought with the CURRENT device token is the one accept that may
// leave a grace behind. Nullable because SQLite cannot ADD a NOT NULL column
// without a default, and a default would claim something about tickets written
// before this column: a null reads as "not proved current", which is the
// fail-closed answer.
const DEVICE_CONNECT_TICKET_ADDED_COLUMNS = {
  token_was_current: 'INTEGER',
} as const;

const USER_CONFIG_ADDED_COLUMNS = {
  version: 'INTEGER NOT NULL DEFAULT 0',
} as const;

// Nullable, and they have to be: SQLite cannot ADD a NOT NULL column without a
// default, and a default here would be a fabricated identity where the truth is
// an absent one. A row registered before these columns existed reports NULL and
// its KV projection stays the only copy of what it stands for.
const USER_BROWSER_SESSION_ADDED_COLUMNS = {
  email: 'TEXT',
  display_name: 'TEXT',
  provider: 'TEXT',
  provider_sub: 'TEXT',
  auth_time: 'INTEGER',
} as const;

export function initUserTables(sql: SqlExec): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_schema_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
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
      name_origin   TEXT NOT NULL DEFAULT 'user' CHECK (name_origin IN ('auto', 'user')),
      created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      last_visited  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      archived_at   INTEGER,
      -- A teardown was started and has not finished. The row survives it so the
      -- cleanup has an owner and a same-name recreate cannot reconnect to
      -- resources that were never destroyed (KINU-024). No timestamp: nothing
      -- asks WHEN, only whether.
      delete_pending INTEGER NOT NULL DEFAULT 0,
      -- A fork reserved this name and has not committed the transfer yet
      -- (KINU-027). The row holds the name against a same-name race while the
      -- workspace it will become does not exist yet, so it is invisible to
      -- every owner-visible read until publishWorkspaceReservation flips it.
      -- DEFAULT 0 because every other create is published the moment it lands.
      create_pending INTEGER NOT NULL DEFAULT 0,
      -- While a fork transfer holds the reservation above, when its claim on
      -- the name lapses. The sender renews it as frames land, so a transfer
      -- that is still running keeps the name and one whose source DIED stops
      -- holding it: without this a mid-transfer eviction wedged a name that no
      -- roster read could see and no retry could take back. NULL once the row
      -- is a published workspace — nothing is streaming into it any more.
      fork_lease_expires_at INTEGER
    )
  `);
  reconcileSqlExecColumns(sql, 'user_workspaces', USER_WORKSPACE_ADDED_COLUMNS);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_user_workspaces_last_visited ON user_workspaces (last_visited DESC)`);

  // Per-workspace capability tokens + the taint registry — the caller boundary
  // every privileged method below is gated on. Table shape owned by the module
  // that implements the gate.
  initWorkspaceCapabilityTables(sql);

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

  // The monotonic revision of each credential key, INCLUDING its absences: a
  // write bumps it and so does a delete, and no row is ever removed. That is
  // what a provider refresh compares against when its network round trip
  // returns — a refresh that started before the owner disconnected finds the
  // revision moved and drops its rotated token instead of writing it back,
  // which is the only thing that stops a disconnect from being undone by a
  // reply that was already in the air. A revision the store has never seen
  // reads as 0, so a first write needs no seeding.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_credential_revisions (
      key        TEXT PRIMARY KEY,
      revision   INTEGER NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);
  // This account's authorization generation: one number, bumped by every CLI
  // and access-token revocation. A websocket authenticated by a bearer records
  // the generation it was admitted under, so a revocation can name every socket
  // that predates it in one comparison instead of enumerating token hashes.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_auth_generation (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      generation INTEGER NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);

  // This account's credential revision: one number, bumped by every mutation
  // of the credential store — every set, every delete, every connect and
  // disconnect. A workspace's cached provider/model state is measured under the
  // number it was swept at, so a mutation the fan-out notification failed to
  // deliver is still noticed at the next use, by comparison, rather than left
  // to an incidental invalidation. The fan-out stays — it makes the change
  // timely — but it is an optimization over this, never the mechanism.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_credentials_revision (
      id        INTEGER PRIMARY KEY CHECK (id = 1),
      revision  INTEGER NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);

  // Egress secrets: the owner's per-host secrets, spent by an agent's
  // container without ever entering it. Same DO, same cipher, same key as
  // `user_credentials` — a different row shape, because a binding carries a
  // host and a placeholder that the `Credential` union has no room for.
  initEgressVaultTables(sql);

  // User-level config (key/value). Defaults that new agents inherit:
  // default_model, default_strategy, default_inference_loop, default_approval_mode.
  // `version` backs the profile_catalog row's compare-and-swap: a write must
  // name the version it read and lands at version+1. Other rows keep 0 —
  // only the catalog row is CAS-guarded.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_config (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      version    INTEGER NOT NULL DEFAULT 0
    )
  `);
  reconcileSqlExecColumns(sql, 'user_config', USER_CONFIG_ADDED_COLUMNS);

  // In-flight Codex device-code state (deviceAuthId + userCode), one per
  // attempt. SETTLED, never deleted: `generation` has to keep rising across
  // attempts, so the row survives its own completion and `settled_at` is what
  // makes it invisible. A poll captures the generation before its network wait
  // and commits only if the row still carries it and is still open — otherwise
  // a reply from a superseded attempt would write its tokens over the attempt
  // the owner is actually approving, and a reply arriving after `disconnect`
  // would reconnect an account that had just been disconnected.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS codex_device_flow (
      id              INTEGER PRIMARY KEY CHECK (id = 1),
      device_auth_id  TEXT NOT NULL,
      user_code       TEXT NOT NULL,
      poll_interval   INTEGER NOT NULL,
      portal_url      TEXT NOT NULL,
      started_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      generation      INTEGER NOT NULL DEFAULT 1,
      settled_at      INTEGER
    )
  `);
  reconcileSqlExecColumns(sql, 'codex_device_flow', CODEX_DEVICE_FLOW_ADDED_COLUMNS);

  // User-level MCP server registry. Tokens + dynamic client registrations
  // live under separate keys written by DurableObjectOAuthClientProvider into
  // the same DO storage; this table holds only the user-visible config.
  //
  // `transport` is one of: 'auto' (streamable-http with SSE fallback) | 'sse'
  // | 'streamable-http'. `headers` is an optional JSON object of static
	  // request headers (e.g. Bearer tokens for self-hosted/private servers),
  // sealed at rest by user/credential-envelope.ts exactly like a credential —
  // it holds the same class of secret.
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
  // NAME IS THE IDENTITY. Server names address the tools
  // (`mcp_<server>_<tool>`), so two servers sharing one name mint colliding
  // tool keys. This index is what makes that unrepresentable.
  //
  // THE TRANSACTION OWNS THE MESSAGE. `userMcp_add` and `userMcp_update` read
  // `lower(name)` and write in ONE storage transaction with no await inside it,
  // so a refusal names the taken name instead of surfacing a constraint
  // violation. That replaced a SELECT-then-INSERT, which is not a check at all
  // inside a Durable Object: sealing the row's headers was an await between the
  // two, and two concurrent adds both passed the SELECT before either INSERTed.
  // The index is the floor under that boundary, not a substitute for it.
  sql.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_mcp_servers_name_unique
      ON user_mcp_servers (lower(name))
  `);

  // User-level connected devices (laptops/PCs). One row per device the user has
  // linked via `kinu connect`. The reverse-WS tunnel + the live socket live
  // on THIS UserDO (the user-level hub) so every one of the user's agents can
  // request the device. `token_hash` is the device's connect secret; raw tokens
  // are returned only once to the authenticated CLI and never stored.
  //
  // Device tokens are rotated ON EVERY CONNECT and expire on an ABSOLUTE window
  // measured from the last rotation. A machine that keeps connecting keeps
  // rotating and never lapses; a COPY of `device.json` goes stale as soon as the
  // real daemon reconnects, which is what turns theft of that file from an
  // indefinite credential into a race.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_devices (
      id              TEXT PRIMARY KEY,
      token_hash      TEXT NOT NULL,
      -- The superseded secret, held until the new one is first used, so a
      -- rotation message lost with the socket does not brick the machine.
      prev_token_hash TEXT,
      label           TEXT NOT NULL,
      os              TEXT,
      hostname        TEXT,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      connected_at    INTEGER,
      last_seen_at    INTEGER,
      expires_at      INTEGER,
      revoked_at      INTEGER,
      -- Provenance of the newest accept, and the record that a second socket
      -- took the slot. Both are rendered in Account settings, because a silent
      -- takeover is the shape these three columns exist to expose.
      last_ip         TEXT,
      last_agent      TEXT,
      replaced_at     INTEGER,
      -- The directory the owner ran "kinu connect" in, and the machine's own
      -- home, both reported on HELLO. The consented directory is the one place
      -- besides its own agent home a workspace reaches here.
      consented_root  TEXT,
      device_home     TEXT,
      -- What the daemon proved about sandboxing, why it could not, and the GPU
      -- nodes it found (JSON array). Absent reads as files_only.
      sandbox_capability TEXT,
      sandbox_reason  TEXT,
      sandbox_gpu     TEXT,
      -- Where this machine keeps agent homes. The hub composes one per
      -- workspace under it and never guesses a path on the machine.
      agent_root      TEXT,
      -- The owner's Sandbox switch. ON unless the owner turned it off.
      tier            TEXT NOT NULL DEFAULT 'sandboxed',
      -- Revocation found a command it could not confirm stopped. This owner-
      -- visible fact survives removal of its active in-flight row; reconnection
      -- cannot clear it because a revoked device never reconnects.
      unstopped_at    INTEGER
    )
  `);
  reconcileSqlExecColumns(sql, 'user_devices', USER_DEVICES_ADDED_COLUMNS);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_user_devices_token_hash ON user_devices (token_hash)`);

  // Device commands whose request reached a daemon but has not reached a
  // terminal response. The table and every statement over it live in
  // ./device-inflight.ts, which owns the precedence protocol as well.
  initDeviceInflightTable(sql);

  // Browser sessions, as the ONE authority on whether a session cookie is
  // still live AND on what it stands for. KV holds a projection of the same
  // fields, and only a projection, because a KV write and a KV delete both
  // take up to a minute to reach every colo: KV cannot answer "was this
  // revoked?" (a cookie copied off the browser and replayed at a lagging colo
  // outlived logout by that window) and it cannot answer "does this session
  // exist yet?" either (the first request after a sign-in redirect, at a colo
  // the write had not reached, read as signed out and sent the browser back
  // into a sign-in that would lose the same race). This row answers both from
  // every colo: presence is active, deletion is revoked.
  //
  // The identity columns are written once, with the row, and never updated —
  // they are what this cookie has meant since it was minted, so a rename lands
  // on the next sign-in rather than rewriting history here. Revocation is the
  // row's absence, so there is no `revoked_at` bit to disagree with it, and
  // nothing reads a creation time. The index makes the lazy expiry delete on
  // the verify path an indexed range delete, so it stays cheap on an account
  // with a long sign-in history and there is no sweeper and no alarm.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_browser_sessions (
      token_hash   TEXT PRIMARY KEY,
      expires_at   INTEGER NOT NULL,
      email        TEXT,
      display_name TEXT,
      provider     TEXT,
      provider_sub TEXT,
      auth_time    INTEGER
    )
  `);
  reconcileSqlExecColumns(sql, 'user_browser_sessions', USER_BROWSER_SESSION_ADDED_COLUMNS);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_user_browser_sessions_exp
            ON user_browser_sessions (expires_at)`);

  // CLI bearer tokens minted by the browser device-code approval flow. Tokens
  // include the UserDO id as a routing hint, but only their SHA-256 hash is
  // stored. The CLI presents the raw token as Authorization: Bearer <token>.
  //
  // `authorization_hash` IS THE ONE-TIME PROPERTY OF THE APPROVAL. The device
  // flow's own record lives in KV, which has no compare-and-swap and serves
  // reads from each colo's cache, so "mark it consumed, then mint" is not a
  // check: two polls could both read `approved` and both be handed a 180-day
  // token. The row below is the check, because this Durable Object is the thing
  // that mints — the claim and the mint are one INSERT, and the unique index
  // makes a second mint against the same approval unrepresentable rather than
  // merely unlikely. NULL for tokens minted outside that flow, and SQLite
  // treats NULLs in a unique index as distinct, so those never collide.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_cli_tokens (
      token_hash  TEXT PRIMARY KEY,
      label       TEXT NOT NULL,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      expires_at  INTEGER NOT NULL,
      last_used_at INTEGER,
      revoked_at  INTEGER,
      authorization_hash TEXT
    )
  `);
  reconcileSqlExecColumns(sql, 'user_cli_tokens', USER_CLI_TOKEN_ADDED_COLUMNS);
  // A UNIQUE INDEX rather than a UNIQUE column: ALTER TABLE cannot add one, and
  // this table predates the claim, so the constraint has to be reachable by a
  // UserDO that already holds rows.
  sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_cli_tokens_authorization
            ON user_cli_tokens (authorization_hash)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_user_cli_tokens_active ON user_cli_tokens (expires_at, revoked_at)`);

  // Long-lived, scoped CI access tokens (`pta_…`) — table shape owned by the
  // access-token store next to the rest of the CLI bearer machinery.
  initAccessTokenTable(sql);

  // Per-(workspace, device) BINDING. Ask-once-then-remember: a missing row
  // means ASK (the agent raises one card in chat the first time it reaches for
  // the machine); 'allow' / 'deny' are the remembered answers. One device,
  // many workspaces — each workspace earns its own binding.
  //
  // There is no tier column. What a bound workspace may touch is the device's
  // own Sandbox switch (`user_devices.tier`), which only the owner sets. A row
  // written when the tier lived here keeps a defaulted `scope` column that
  // nothing reads or writes.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS device_consent (
      agent_name  TEXT NOT NULL,
      device_id   TEXT NOT NULL,
      policy      TEXT NOT NULL,
      last_method TEXT,
      last_summary TEXT,
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      PRIMARY KEY (agent_name, device_id)
    )
  `);

  // Short-lived, single-use WebSocket tickets for device daemon reconnects.
  // The daemon exchanges its long-lived local device token over HTTPS, then
  // connects the WebSocket with this scoped ticket in the URL. That keeps raw
  // long-lived device tokens out of request URLs and edge logs.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS device_connect_tickets (
      ticket_hash       TEXT PRIMARY KEY,
      device_id         TEXT NOT NULL,
      created_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      expires_at        INTEGER NOT NULL,
      used_at           INTEGER,
      -- Whether the token exchanged for this ticket was the device's CURRENT
      -- secret rather than the one-shot grace. The accept reads it to decide
      -- whether its rotation may leave a grace behind: a machine recovering ON
      -- the grace shares that secret with whoever else holds a copy of
      -- device.json, so re-granting one there is what let two claimants
      -- alternate forever.
      token_was_current INTEGER
    )
  `);
  reconcileSqlExecColumns(sql, 'device_connect_tickets', DEVICE_CONNECT_TICKET_ADDED_COLUMNS);
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

  initReleaseTables(sql);

  // The owner's cross-workspace experience library: the crafts, lessons, facts
  // and agent loops one workspace proved and published for the owner's others.
  initExperienceLibraryTables(sql);
}
