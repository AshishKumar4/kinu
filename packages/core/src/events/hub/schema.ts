/**
 * `agent_log` — the single append-only ledger for every event, phase,
 * step, tool call, tool result, reactor decision, and reply attempt in
 * an agent's lifetime. Discriminated by `kind`.
 *
 * Partial indexes per kind are mandatory — without them recovery scans
 * regress to table-scans on the hot path.
 *
 * Sibling table `reply_channels` carries durable reply-channel rows.
 *
 * Sibling table `triggers` carries registered triggers.
 *
 * Pending outbound peer-agent deliveries live in `outbox_peer`, owned by the
 * shared outbox (`events/outbox.ts`), which creates its own schema.
 *
 * The DDL is idempotent. Safe to call on every DO boot.
 */

import * as v from 'valibot';
import type { SqlExec } from '../../types/primitives';

const SqlDefinitionRowSchema = v.object({ sql: v.nullable(v.string()) });

const AGENT_LOG_DDL = `
CREATE TABLE IF NOT EXISTS agent_log (
  id                  TEXT    PRIMARY KEY,
  kind                TEXT    NOT NULL
                              CHECK(kind IN (
                                'event', 'phase', 'step', 'tool_call',
                                'tool_result', 'reactor_decision', 'reply_attempt'
                              )),
  turn_id             TEXT,
  step_idx            INTEGER,
  parent_id           TEXT,
  trace_id            TEXT    NOT NULL,
  ingress             TEXT,
  variant             TEXT,
  trust               TEXT    CHECK(trust IS NULL OR trust IN ('external', 'authenticated', 'owner', 'self')),
  priority            TEXT    CHECK(priority IS NULL OR priority IN ('urgent', 'normal', 'background')),
  payload_visibility  TEXT    CHECK(payload_visibility IS NULL OR payload_visibility IN ('full', 'redact', 'hash', 'hmac', 'opaque_handle')),
  payload             TEXT    NOT NULL DEFAULT 'null',
  received_at         INTEGER NOT NULL,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  dedupe_key          TEXT,
  consumed_at         INTEGER
)`;

const INDEXES: ReadonlyArray<string> = [
  // Recovery hot path: pending events ordered by priority desc, received_at asc.
  // Partial index keyed on (kind='event' AND turn_id IS NULL).
  `CREATE INDEX IF NOT EXISTS idx_agent_log_events_pending
   ON agent_log (priority, received_at)
   WHERE kind = 'event' AND turn_id IS NULL`,

  // Activation recovery scans only open delivery leases.
  `CREATE INDEX IF NOT EXISTS idx_agent_log_events_consumed
   ON agent_log (consumed_at)
   WHERE kind = 'event' AND consumed_at IS NOT NULL`,

  // Phase lookups: latest phase row per turn.
  `CREATE INDEX IF NOT EXISTS idx_agent_log_phase_current
   ON agent_log (turn_id, id DESC)
   WHERE kind = 'phase'`,

  // Steps per turn: ordered traversal for SSE replay + recovery.
  `CREATE INDEX IF NOT EXISTS idx_agent_log_steps_per_turn
   ON agent_log (turn_id, step_idx)
   WHERE kind IN ('step', 'tool_call', 'tool_result', 'reactor_decision')`,

  // Unique dedupe key. NULL values do not participate in uniqueness.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_log_dedupe
   ON agent_log (dedupe_key)
   WHERE dedupe_key IS NOT NULL`,

  // Per-trace event counting for trace-budget checks.
  `CREATE INDEX IF NOT EXISTS idx_agent_log_trace_events
   ON agent_log (trace_id, received_at)
   WHERE kind = 'event'`,

  // Reply attempt audit: by event.
  `CREATE INDEX IF NOT EXISTS idx_agent_log_reply_attempts
   ON agent_log (parent_id)
   WHERE kind = 'reply_attempt'`,

  // Generic by-trace scan.
  `CREATE INDEX IF NOT EXISTS idx_agent_log_by_trace
   ON agent_log (trace_id, id)`,

  // Recent rows ordered by receipt (operator UI timeline).
  `CREATE INDEX IF NOT EXISTS idx_agent_log_received_at
   ON agent_log (received_at DESC)`,
];

const VIEWS: ReadonlyArray<string> = [
  // Events only. Used by the operator UI's events sidebar and the LLM-facing
  // `recent_events` tool.
  `CREATE VIEW IF NOT EXISTS events_v AS
   SELECT id, turn_id, parent_id AS caused_by, trace_id, ingress, variant, trust,
          priority, payload_visibility, payload, received_at, schema_version, dedupe_key
   FROM agent_log
   WHERE kind = 'event'`,

  // Run-event trace (steps + tool calls + tool results + reactor decisions).
  // SSE streamer reads from this. eventIndex semantics: row id ordering.
  `CREATE VIEW IF NOT EXISTS run_event_v AS
   SELECT id, turn_id, step_idx, kind, parent_id, payload, received_at
   FROM agent_log
   WHERE kind IN ('step', 'tool_call', 'tool_result', 'reactor_decision')
   ORDER BY turn_id, step_idx, id`,

  // Phase transition log.
  `CREATE VIEW IF NOT EXISTS turn_phase_log_v AS
   SELECT id, turn_id, payload, received_at
   FROM agent_log
   WHERE kind = 'phase'
   ORDER BY received_at`,
];

const REPLY_CHANNELS_DDL = `
CREATE TABLE IF NOT EXISTS reply_channels (
  id                  TEXT    PRIMARY KEY,
  event_id            TEXT    NOT NULL,
  kind                TEXT    NOT NULL
                              CHECK(kind IN ('ws_session', 'http_pending', 'peer_back', 'mcp_pending', 'email_thread', 'none')),
  holder_addr         TEXT    NOT NULL DEFAULT '',
  ttl_expires_at      INTEGER NOT NULL,
  payload_policy      TEXT    NOT NULL DEFAULT 'full',
  state               TEXT    NOT NULL DEFAULT 'open'
                              CHECK(state IN ('open', 'replied', 'expired', 'aborted')),
  reply_payload       TEXT,
  attempt_count       INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
)`;

const REPLY_CHANNELS_INDEXES: ReadonlyArray<string> = [
  `CREATE INDEX IF NOT EXISTS idx_reply_channels_open
   ON reply_channels (state, ttl_expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_reply_channels_event
   ON reply_channels (event_id)`,
];

const TRIGGERS_DDL = `
CREATE TABLE IF NOT EXISTS triggers (
  id                  TEXT    PRIMARY KEY,
  kind                TEXT    NOT NULL
                              CHECK(kind IN (
                                'webhook_durable', 'webhook_ephemeral',
                                'timer_oneshot', 'timer_cron',
                                'process_watch', 'file_watch',
                                'peer_inbox', 'mcp_route', 'email_route'
                              )),
  spec                TEXT    NOT NULL DEFAULT '{}',
  creator_trust       TEXT    NOT NULL
                              CHECK(creator_trust IN ('external', 'authenticated', 'owner', 'self')),
  fork_policy         TEXT
                              CHECK(fork_policy IS NULL OR fork_policy IN ('copy', 'sever', 'share')),
  state               TEXT    NOT NULL DEFAULT 'active'
                              CHECK(state IN ('active', 'paused', 'revoked')),
  rate_limit_per_min  INTEGER NOT NULL DEFAULT 60,
  created_at          INTEGER NOT NULL,
  paused_at           INTEGER,
  revoked_at          INTEGER,
  next_fire_at        INTEGER,
  last_fire_at        INTEGER,
  fire_count          INTEGER NOT NULL DEFAULT 0
)`;

const TRIGGERS_INDEXES: ReadonlyArray<string> = [
  `CREATE INDEX IF NOT EXISTS idx_triggers_active_fire
   ON triggers (next_fire_at)
   WHERE state = 'active' AND next_fire_at IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_triggers_by_kind
   ON triggers (kind, state)`,
];

/** Rebuild a table whose CHECK constraints predate a newly-added enum member.
 *  SQLite bakes CHECK text into the stored table definition, so `CREATE TABLE
 *  IF NOT EXISTS` never refreshes it on live DOs — detect the stale definition
 *  via sqlite_master and rebuild in place. The column set is identical (only
 *  constraint text changes), so a straight `INSERT … SELECT *` preserves all
 *  rows; indexes are recreated by the caller's normal index pass. */
function rebuildIfCheckMissing(sql: SqlExec, table: string, marker: string, ddl: string): void {
  const rows = sql.exec(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, table,
  ).toArray().map((row) => v.parse(SqlDefinitionRowSchema, row));
  if (rows.length === 0 || (rows[0].sql ?? '').includes(marker)) return;
  sql.exec(`ALTER TABLE ${table} RENAME TO ${table}_migrating`);
  sql.exec(ddl);
  sql.exec(`INSERT INTO ${table} SELECT * FROM ${table}_migrating`);
  sql.exec(`DROP TABLE ${table}_migrating`);
}

/** Initialize all hub tables, indexes, and views. Idempotent. */
export function initEventsHubTables(sql: SqlExec): void {
  sql.exec(AGENT_LOG_DDL);
  for (const ix of INDEXES) sql.exec(ix);
  for (const v of VIEWS) sql.exec(v);
  // CHECK-widening rebuilds for live DOs created before these enum members
  // existed. Must run before the CREATE IF NOT EXISTS + index passes.
  rebuildIfCheckMissing(sql, 'reply_channels', "'email_thread'", REPLY_CHANNELS_DDL);
  rebuildIfCheckMissing(sql, 'triggers', "'email_route'", TRIGGERS_DDL);
  sql.exec(REPLY_CHANNELS_DDL);
  for (const ix of REPLY_CHANNELS_INDEXES) sql.exec(ix);
  sql.exec(TRIGGERS_DDL);
  for (const ix of TRIGGERS_INDEXES) sql.exec(ix);
}
