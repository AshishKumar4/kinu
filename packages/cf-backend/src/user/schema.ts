// UserDO SQL schema. All tables live inside a single Durable Object instance
// keyed by the stable Kinu userId the auth store derives from the email.
// Idempotent — safe to call on every DO boot.
//
// EVERY COLUMN BELOW IS IN ITS CREATE, so there is nothing to reconcile and no
// backfill to run. The FIRST column any of these tables gains after release
// needs a `reconcileColumns` call added beside that CREATE, listing that column
// and every later one forever — a DO created before it would otherwise break
// with `no such column`. Until then the CREATE is the single description of the
// shape, and a writer naming a column it lacks is a bug in one place.

import {
  initExperienceLibraryTables, initReleaseTables, type SqlExec,
} from '@kinu.run/core';
import { initAccessTokenTable } from '../cli/access-token-store';
import { initDeviceInflightTable } from './device-inflight';
import { initEgressVaultTables } from './egress-vault';
import { initWorkspaceCapabilityTables } from './workspace-capability';

/** The sole account profile-catalog row in user_config. */
export const PROFILE_CATALOG_CONFIG_KEY = 'profile_catalog';

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
      create_pending INTEGER NOT NULL DEFAULT 0
    )
  `);
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
      -- Revocation found a command it could not confirm stopped. This owner-
      -- visible fact survives removal of its active in-flight row; reconnection
      -- cannot clear it because a revoked device never reconnects.
      unstopped_at    INTEGER
    )
  `);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_user_devices_token_hash ON user_devices (token_hash)`);

  // Device commands whose request reached a daemon but has not reached a
  // terminal response. The table and every statement over it live in
  // ./device-inflight.ts, which owns the precedence protocol as well.
  initDeviceInflightTable(sql);

  // Browser sessions, as the ONE authority on whether a session cookie is
  // still live. The cookie's own record lives in KV, where a delete reaches
  // other colos within a minute, so KV cannot answer "was this revoked?" —
  // a cookie copied off the browser replayed at another colo outlived logout
  // by that window. This row does answer it: presence is active, deletion is
  // revoked, and every cookie verification reads it in this user's own
  // Durable Object, which is one place from every colo.
  //
  // Two columns and no more. Revocation is the row's absence, so there is no
  // `revoked_at` bit to disagree with it, and nothing reads a creation time.
  // The index makes the lazy expiry delete on the verify path an indexed range
  // delete, so it stays cheap on an account with a long sign-in history and
  // there is no sweeper and no alarm.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_browser_sessions (
      token_hash TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    )
  `);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_user_browser_sessions_exp
            ON user_browser_sessions (expires_at)`);

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

  initReleaseTables(sql);

  // The owner's cross-workspace experience library: the crafts, lessons, facts
  // and agent loops one workspace proved and published for the owner's others.
  initExperienceLibraryTables(sql);
}
