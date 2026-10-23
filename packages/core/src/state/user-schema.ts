// UserDO SQL schema, one DO per userId. Idempotent; runs on every boot. `user_access_tokens` is
// created adapter-side by `initAccessTokenTable`. Every column the code touches is in its CREATE.

import { initAccountLimitTables } from '../limits/schema';
import type { SqlExec } from '../types/primitives';
import { sqlCheckList } from '../utils/sql';
import { initExperienceLibraryTables } from '../experience/library';
import { initDeviceInflightTable } from '../execution/device-inflight';
import { initEgressVaultTables } from '../safety/egress-vault';
import { initAccountMemoryTables } from '../memory/account';

/** `account_epochs`' fences: a trial is held to each one's being set, not to the row's. */
export const ACCOUNT_EPOCH_FIELDS = ['auth_generation', 'credentials_revision', 'credential_floor'] as const;

/** What a connection ticket opens: each purpose mints and spends only its own (`connection_tickets`). */
const CONNECTION_TICKET_PURPOSES = ['device_connect', 'device_join', 'cli_agent_connect'] as const;

export type ConnectionTicketPurpose = (typeof CONNECTION_TICKET_PURPOSES)[number];

/** The sole account profile-catalog row in user_config. */
export const PROFILE_CATALOG_CONFIG_KEY = 'profile_catalog';

export const WORKSPACE_KEYED_ROWS = [
  { table: 'device_consent', column: 'agent_name', removal: 'before-destroy' },
  { table: 'user_secret_grants', column: 'workspace', removal: 'before-destroy' },
  { table: 'connection_tickets', column: 'workspace', removal: 'before-destroy' },
  { table: 'user_workspaces', column: 'name', removal: 'after-destroy' },
  { table: 'workspace_overviews', column: 'name', removal: 'after-destroy' },
  { table: 'workspace_logos', column: 'name', removal: 'after-destroy' },
  { table: 'device_status_watchers', column: 'agent_name', removal: 'after-destroy' },
  { table: 'device_notice_pending', column: 'agent_name', removal: 'after-destroy' },
  { table: 'device_inflight_requests', column: 'workspace', removal: { kept: 'the device protocol removes a row once the daemon acknowledges its end' } },
  { table: 'experience_library', column: 'source_workspace', removal: { kept: "provenance: the owner's library outlives the workspace it came from" } },
  { table: 'user_share_cards', column: 'workspace', removal: { kept: "another owner's workspace" } },
  { table: 'share_cards_sent', column: 'workspace', removal: { kept: "the teardown's share-card reconcile removes each row once its recipient's removal is queued" } },
] as const satisfies readonly WorkspaceKeyedRows[];

export interface WorkspaceKeyedRows {
  readonly table: string;
  readonly column: string;
  readonly removal: 'before-destroy' | 'after-destroy' | { readonly kept: string };
}

export function initUserTables(sql: SqlExec): void {
  // The account's memory: its facts in the same `agent_facts` a workspace's world model uses (memory/account.ts).
  initAccountMemoryTables((ddl) => { sql.exec(ddl); });
  // Its limits: who it is, what of its counted use it spent, and its stores' sizes (limits/schema.ts).
  initAccountLimitTables(sql);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_profile (
      id           INTEGER PRIMARY KEY CHECK (id = 1),
      email        TEXT NOT NULL,
      display_name TEXT,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      last_seen_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      -- Null until the welcome wizard finishes.
      onboarded_at INTEGER
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
      -- is a published workspace: nothing is streaming into it any more.
      fork_lease_expires_at INTEGER,
      -- The account's asks for a first overview of a workspace that has pushed
      -- none, and when it may ask again (user/roster.ts unreportedWorkspaces).
      nudge_attempts INTEGER NOT NULL DEFAULT 0,
      nudge_next_at  INTEGER NOT NULL DEFAULT 0,
      -- The workspace's identity proof: the hash of the capability token that
      -- only that workspace's object holds (safety/workspace-capability.ts).
      -- NULL before one is minted and from the teardown's start, which revokes
      -- it before the object is destroyed.
      token_hash TEXT UNIQUE
    )
  `);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_user_workspaces_roster ON user_workspaces (last_visited DESC, name)`);

  // Value is a JSON-encoded Credential union.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_credentials (
      key        TEXT PRIMARY KEY,
      kind       TEXT NOT NULL,
      value      TEXT NOT NULL
    )
  `);

  // Bumped on every write and delete, never removed: an in-flight provider refresh that finds the
  // revision moved drops its token, so a disconnect cannot be undone. Unseen keys read as 0.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_credential_revisions (
      key        TEXT PRIMARY KEY,
      revision   INTEGER NOT NULL
    )
  `);
  // The account's three fences, independent of each other, each written only by its own column's upsert and NULL until
  // it is first set (a trial account may hold the first two: cloud-wire.ts TRIAL_ACCOUNT_KEEPS):
  // - `auth_generation`: bumped by every CLI/access-token revocation; sockets record the generation they were admitted
  //   under.
  // - `credentials_revision`: bumped by every credential mutation; cached provider state compares against it, so a lost
  //   fan-out notification is still noticed. The fan-out is an optimization, not the mechanism.
  // - `credential_floor`: the oldest built-in password or passkey generation a browser sign-in is admitted under, raised
  //   by a credential reset (user/sessions.ts raiseCredentialFloor).
  sql.exec(`
    CREATE TABLE IF NOT EXISTS account_epochs (
      id                   INTEGER PRIMARY KEY CHECK (id = 1),
      auth_generation      INTEGER,
      credentials_revision INTEGER,
      credential_floor     INTEGER
    )
  `);

  // The last complete provider listing a workspace of this account swept, under the credentials' revision and each
  // provider's account it was swept under: a turn serves it while both are its own (profiles/provider-catalog.ts).
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_provider_listing (
      id                   INTEGER PRIMARY KEY CHECK (id = 1),
      credentials_revision INTEGER NOT NULL,
      accounts             TEXT NOT NULL,
      listing              TEXT NOT NULL
    )
  `);

  // Per-host egress secrets, spent without entering the container.
  initEgressVaultTables(sql);

  // `version` backs the profile_catalog row's compare-and-swap; other rows keep 0.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_config (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      version    INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Kinu's half of each MCP server: what the Agents SDK cannot hold. Its name, endpoint and transport live in the SDK's
  // own catalog (`cf_agents_mcp_servers`, read through `listServers`), under the same id; OAuth tokens live in separate
  // DO storage keys. `headers` is sealed at rest like a credential.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_mcp_servers (
      id            TEXT PRIMARY KEY,
      headers       TEXT,
      allowed_tools TEXT,
      -- The MCP_PRESETS entry the server was added from; null for a custom server.
      preset_id     TEXT
    )
  `);

  // Devices linked via `kinu connect` (device protocol 5): each holds an Ed25519 key whose private half never leaves
  // the machine, so nothing stored here connects anything. A connect expires an absolute window after the last one.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_devices (
      id              TEXT PRIMARY KEY,
      -- The machine's Ed25519 public key, its 32 raw bytes as base64url.
      public_key      TEXT NOT NULL,
      -- The SHA-256 (hex) of the connect secret the machine last confirmed
      -- it stored, and of the one its last accepted connect was handed and
      -- has not confirmed; null for none (the '' a machine holds before its
      -- first connect). A connect signs the one its device.json holds: one
      -- of these two; any other means two machines hold the key.
      connect_secret_hash TEXT,
      pending_secret_hash TEXT,
      -- When two machines were found holding this device's key and it was
      -- revoked for it: the incident the owner reads on the Devices page
      -- until acknowledged.
      clone_detected_at INTEGER,
      label           TEXT NOT NULL,
      os              TEXT,
      hostname        TEXT,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      last_seen_at    INTEGER,
      expires_at      INTEGER,
      revoked_at      INTEGER,
      -- When a second socket took this device's live slot. Rendered in Account
      -- settings: a takeover by another holder of the key shows as a
      -- replacement the owner did not cause.
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
      -- The build the daemon reported on its last HELLO (NULL: it named none), and
      -- whether its owner lets the hub push a newer one (updateCheck in the CLI config).
      version         TEXT,
      update_check    INTEGER NOT NULL DEFAULT 1,
      -- Revocation found a command it could not confirm stopped. This owner-
      -- visible fact survives removal of its active in-flight row; reconnection
      -- cannot clear it because a revoked device never reconnects.
      unstopped_at    INTEGER,
      -- The last update the daemon refused: the build, the runtime it ran on
      -- then, and why. A HELLO on another runtime clears it.
      update_refused_version TEXT,
      update_refused_runtime TEXT,
      update_refusal_reason  TEXT,
      -- Whether the hub refused the last HELLO for its protocol: the daemon
      -- must be updated by hand. An accepted HELLO clears it.
      protocol_refused INTEGER NOT NULL DEFAULT 0 CHECK (protocol_refused IN (0, 1)),
      CHECK ((update_refused_version IS NULL) = (update_refused_runtime IS NULL)
        AND (update_refused_version IS NULL) = (update_refusal_reason IS NULL))
    )
  `);

  // A daemon's connect challenges, kept only as hashes: minted for a minute and spent once, by the signature over one
  // that buys a connect ticket or reports a refused update. Spending deletes it, so a challenge is live or gone.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS device_connect_challenges ( /* refilled by the next challenge a machine asks for: each row lives one minute */
      nonce_hash TEXT PRIMARY KEY,
      device_id  TEXT NOT NULL REFERENCES user_devices(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    )
  `);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_device_connect_challenges_exp ON device_connect_challenges (expires_at)`);

  initDeviceInflightTable(sql);

  // The authority on whether a session cookie is live: KV is only a projection and its writes
  // propagate slowly across colos. Presence is active, deletion is revoked; identity columns are
  // immutable. The expiry index keeps the lazy expiry delete cheap without a sweeper.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_browser_sessions (
      token_hash   TEXT PRIMARY KEY,
      expires_at   INTEGER NOT NULL,
      email        TEXT NOT NULL,
      display_name TEXT,
      provider     TEXT NOT NULL,
      provider_sub TEXT NOT NULL,
      auth_time    INTEGER NOT NULL
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

  // Missing row means ask; 'allow'/'deny' are remembered. The device's own `tier` governs access.
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
      agent_name TEXT PRIMARY KEY
    )
  `);

  sql.exec(`
    CREATE TABLE IF NOT EXISTS device_status_watchers (
      agent_name TEXT PRIMARY KEY
    )
  `);

  // Single-use tickets keep long-lived tokens out of URLs and edge logs; spending one deletes its row, so a ticket is
  // live or gone. Each purpose spends only its own (cf-backend user/single-use-tickets.ts):
  // - `device_connect`: a daemon's socket, bought with a signature over its connect challenge, and spent by the socket's
  //   AUTH frame.
  // - `device_join`: a device the browser asked to connect, issued before the machine registers. The machine claims
  //   `device_id`, so the page that asked watches the one row it will become; `workspace` is the one whose Environment
  //   issued it, granted on registering, or null for none. Thirty minutes, one per device.
  // - `cli_agent_connect`: a CLI bearer's socket to `workspace`; `cli_token_hash` is the bearer that asked, revalidated
  //   when it is spent. Whose it is, the ticket's own text says (`pat_<userId>_...`).
  sql.exec(`
    CREATE TABLE IF NOT EXISTS connection_tickets ( /* refilled by the next ticket a machine or CLI asks for: each row lives one to thirty minutes */
      ticket_hash       TEXT PRIMARY KEY,
      purpose           TEXT NOT NULL CHECK (purpose IN (${sqlCheckList(CONNECTION_TICKET_PURPOSES)})),
      expires_at        INTEGER NOT NULL,
      device_id         TEXT,
      workspace         TEXT,
      cli_token_hash    TEXT,
      CHECK ((purpose = 'device_connect' AND device_id IS NOT NULL AND workspace IS NULL AND cli_token_hash IS NULL)
        OR (purpose = 'device_join' AND device_id IS NOT NULL AND cli_token_hash IS NULL)
        OR (purpose = 'cli_agent_connect' AND device_id IS NULL AND workspace IS NOT NULL AND cli_token_hash IS NOT NULL))
    )
  `);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_connection_tickets_exp ON connection_tickets (expires_at)`);
  sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_connection_tickets_join ON connection_tickets (device_id) WHERE purpose = 'device_join'`);

  initExperienceLibraryTables(sql);

  // The pushed overview is the one source; `activity` and `decisions` are stored derivations of it, read by the roster's
  // counts, and the JSON goes last so a count never reads it.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS workspace_overviews ( /* refilled by each workspace's overview push (user/workspaces.ts) */
      name       TEXT PRIMARY KEY,
      activity   TEXT GENERATED ALWAYS AS (json_extract(overview, '$.activity')) STORED
                   CHECK (activity IN ('working', 'unfinished', 'idle')),
      decisions  INTEGER GENERATED ALWAYS AS (json_extract(overview, '$.decisionsWaiting')) STORED NOT NULL,
      overview   TEXT NOT NULL
    )
  `);

  // Sanitized on the way in (identity/logo.ts).
  sql.exec(`
    CREATE TABLE IF NOT EXISTS workspace_logos (
      name     TEXT PRIMARY KEY,
      svg      TEXT NOT NULL
    )
  `);

  // The cards this account holds of shares given to it, written only by each owner's account.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_share_cards (
      owner_user_id TEXT NOT NULL,
      workspace     TEXT NOT NULL,
      share_id      TEXT NOT NULL,
      card          TEXT NOT NULL,
      -- When the card first reached this account: what Shared's unseen dot is read against. 0 for a card held before
      -- this column was: seen, once Shared was ever opened.
      received_at   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (owner_user_id, workspace, share_id)
    )
  `);

  // What this account last sent each recipient of a share: the share-card reconcile's other side.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS share_cards_sent (
      workspace         TEXT NOT NULL,
      share_id          TEXT NOT NULL,
      recipient_user_id TEXT NOT NULL,
      card              TEXT NOT NULL,
      PRIMARY KEY (workspace, share_id, recipient_user_id)
    )
  `);

  // This account's own model calls made in other people's slates (its own AI grant in their rooms), tallied per provider
  // account as a workspace's ledger tallies its own (`AccountSpend`); each call adds to its row. Its only record: no
  // workspace holds it (the slate's is someone else's) and the room keeps no per-call row. '' names no provider or
  // account; a usage column is null until a call reports it, and `usd` until one is priced.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS slate_ai_spend (
      provider            TEXT NOT NULL,
      account             TEXT NOT NULL,
      calls               INTEGER NOT NULL,
      calls_without_usage INTEGER NOT NULL,
      unpriced_calls      INTEGER NOT NULL,
      usd                 REAL,
      input               INTEGER,
      output              INTEGER,
      cache_read          INTEGER,
      cache_write         INTEGER,
      cache_write_1h      INTEGER,
      reasoning           INTEGER,
      neurons             REAL,
      PRIMARY KEY (provider, account)
    )
  `);

  // A viewer's grants for personal parts belong to this account, never the slate owner's workspace.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS slate_consents (
      workspace TEXT NOT NULL, slate TEXT NOT NULL, server TEXT NOT NULL, root TEXT NOT NULL,
      tools TEXT NOT NULL, effects INTEGER NOT NULL CHECK (effects IN (0, 1)), revision TEXT NOT NULL,
      PRIMARY KEY (workspace, slate, server, root)
    )
  `);
}
