// UserDO SQL schema, one DO per userId. Idempotent; runs on every boot. `user_access_tokens` is
// created adapter-side by `initAccessTokenTable`. Every column the code touches is in its CREATE.

import type { SqlExec } from '../types/primitives';
import { initExperienceLibraryTables } from '../experience/library';
import { initReleaseTables } from '../release/sql-store';
import { initDeviceInflightTable } from '../execution/device-inflight';
import { initEgressVaultTables } from '../safety/egress-vault';
import { initWorkspaceCapabilityTables } from '../safety/workspace-capability';
import { diagnostics } from '../obs/log';

/** The sole account profile-catalog row in user_config. */
export const PROFILE_CATALOG_CONFIG_KEY = 'profile_catalog';

export function initUserTables(sql: SqlExec): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_schema_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_profile (
      id           INTEGER PRIMARY KEY CHECK (id = 1),
      email        TEXT NOT NULL,
      display_name TEXT,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      last_seen_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);
  // A table, not a `user_profile` column: the genesis lock (scripts/schema-drift.ts) refuses new
  // columns on shipped tables. An absent row means not onboarded.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_onboarding (
      id           INTEGER PRIMARY KEY CHECK (id = 1),
      completed_at INTEGER NOT NULL
    )
  `);

  // Workspaces this user has created (each 1:1 with an OrchestratorAgent DO
  // that hosts the workspace + its default agent). UserDO is the source of
  // truth for the registry. No back-compat path for a schema change, by design
  // — pre-production, DB is recreated on deploy (owner decision 2026-06-13).
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
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_user_workspaces_last_visited ON user_workspaces (last_visited DESC)`);

  initWorkspaceCapabilityTables(sql);

  // Cross-owner peer-messaging grants; default deny, same-owner peers need no row.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_peer_grants (
      sender_user_id    TEXT NOT NULL,
      sender_agent_name TEXT NOT NULL,
      created_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      PRIMARY KEY (sender_user_id, sender_agent_name)
    )
  `);

  // Value is a JSON-encoded Credential union.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_credentials (
      key        TEXT PRIMARY KEY,
      kind       TEXT NOT NULL,
      value      TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);

  // Bumped on every write and delete, never removed: an in-flight provider refresh that finds the
  // revision moved drops its token, so a disconnect cannot be undone. Unseen keys read as 0.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_credential_revisions (
      key        TEXT PRIMARY KEY,
      revision   INTEGER NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);
  // Bumped by every CLI/access-token revocation; sockets record the generation they were admitted under.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_auth_generation (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      generation INTEGER NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);

  // Bumped by every credential mutation; cached provider state compares against it, so a lost
  // fan-out notification is still noticed. The fan-out is an optimization, not the mechanism.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_credentials_revision (
      id        INTEGER PRIMARY KEY CHECK (id = 1),
      revision  INTEGER NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);

  // Per-host egress secrets, spent without entering the container.
  initEgressVaultTables(sql);

  // `version` backs the profile_catalog row's compare-and-swap; other rows keep 0.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_config (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      version    INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Settled, never deleted, so `generation` keeps rising. A poll commits only if the row still has
  // its generation and is open, so superseded or post-disconnect replies cannot write tokens.
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

  // OAuth tokens live in separate DO storage keys. `headers` is sealed at rest like a credential.
  // Presets live in `user_mcp_server_presets`: new columns never reach pre-existing accounts.
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

  // Names address tools (`mcp_<server>_<tool>`), so they must be unique. The add/update transaction is
  // the guard; this index is the floor. Building it over existing collisions raises and would fail
  // every `ensureInit`, so collisions are read first and the build is skipped.
  const collidingNames = sql.exec(`
    SELECT lower(name) AS name FROM user_mcp_servers
      GROUP BY lower(name) HAVING COUNT(*) > 1
  `).toArray().length;

  if (collidingNames === 0) {
    sql.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_user_mcp_servers_name_unique
        ON user_mcp_servers (lower(name))
    `);
  } else {
    diagnostics.event('user.mcp_name_index_skipped', { collidingNames });
  }

  // A separate table: a column on `user_mcp_servers` never reaches pre-existing accounts. No row = custom.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_mcp_server_presets (
      -- The server row this tag belongs to; cascade-declared so the tag is a
      -- property of the server, not of the storage that outlives it.
      server_id TEXT PRIMARY KEY REFERENCES user_mcp_servers(id) ON DELETE CASCADE,
      -- The MCP_PRESETS entry the server was added from.
      preset_id TEXT NOT NULL
    )
  `);

  // Devices linked via `kinu connect`; only token hashes are stored. Tokens rotate on every connect
  // and expire an absolute window after the last rotation, so a copied `device.json` goes stale.
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
      -- What the daemon proved about sandboxing, why it could not, the words
      -- behind that verdict, and the GPU nodes it found (JSON array). Absent
      -- reads as files_only.
      sandbox_capability TEXT,
      sandbox_reason  TEXT,
      sandbox_detail  TEXT,
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
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_user_devices_token_hash ON user_devices (token_hash)`);

  // A table, not `user_devices` columns: the genesis lock refuses new columns on shipped tables.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_device_builds (
      -- The device whose daemon reported. Cascade-declared so the row is a
      -- property of the device, not of the storage that outlives it.
      device_id    TEXT PRIMARY KEY REFERENCES user_devices(id) ON DELETE CASCADE,
      -- The build the daemon reported on its last HELLO (NULL only for a row
      -- written before the field existed), and whether its owner lets the hub
      -- push a newer one (updateCheck in the CLI config).
      version      TEXT,
      update_check INTEGER NOT NULL DEFAULT 1,
      -- When this row was last written, so "reported" is a fact with a time.
      reported_at  INTEGER NOT NULL
    )
  `);

  // Superseded device secrets, kept for the token lifetime: one presented again revokes the device.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_device_retired_tokens (
      token_hash        TEXT PRIMARY KEY,
      device_id         TEXT NOT NULL REFERENCES user_devices(id) ON DELETE CASCADE,
      retired_at        INTEGER NOT NULL,
      -- When the secret was presented again and the device revoked for it:
      -- the incident the owner reads on the Devices page until acknowledged.
      reuse_detected_at INTEGER
    )
  `);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_user_device_retired_tokens_retired_at
            ON user_device_retired_tokens (retired_at)`);

  initDeviceInflightTable(sql);

  // The authority on whether a session cookie is live: KV is only a projection and its writes
  // propagate slowly across colos. Presence is active, deletion is revoked; identity columns are
  // immutable. The expiry index keeps the lazy expiry delete cheap without a sweeper.
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
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_user_browser_sessions_exp
            ON user_browser_sessions (expires_at)`);

  // Only SHA-256 hashes are stored. The UNIQUE `authorization_hash` makes one mint per device-flow
  // approval unrepresentable twice (KV has no CAS); NULLs never collide.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_cli_tokens (
      token_hash  TEXT PRIMARY KEY,
      label       TEXT NOT NULL,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      expires_at  INTEGER NOT NULL,
      last_used_at INTEGER,
      revoked_at  INTEGER,
      authorization_hash TEXT UNIQUE
    )
  `);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_user_cli_tokens_active ON user_cli_tokens (expires_at, revoked_at)`);

  // Missing row means ask; 'allow'/'deny' are remembered. The device's own `tier` governs access;
  // a legacy `scope` column may exist and is unused.
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

  // Removed on successful announce; an unreachable workspace keeps its row for the next accept.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS device_notice_pending (
      agent_name   TEXT PRIMARY KEY,
      announced_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);

  // Single-use tickets keep long-lived device tokens out of URLs and edge logs.
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
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_device_connect_tickets_exp ON device_connect_tickets (expires_at, used_at)`);

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

  initExperienceLibraryTables(sql);

  // A projection: every read re-asks the owner's workspace, so a stale row can only list something that refuses.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_shares_received (
      owner_user_id TEXT NOT NULL,
      owner_email   TEXT NOT NULL,
      workspace     TEXT NOT NULL,
      share_id      TEXT NOT NULL,
      title         TEXT NOT NULL,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      PRIMARY KEY (owner_user_id, workspace, share_id)
    )
  `);
}
