/**
 * Hub tables. Every table is actor-scoped in its primary key, and `dedupe_key` uniqueness is
 * per actor: two actors handed the same upstream event must each keep their own row.
 */

import type { SqlExec } from '../../types/primitives';

const AGENT_LOG_DDL = `
CREATE TABLE IF NOT EXISTS agent_log (
  actor_id            TEXT    NOT NULL,
  id                  TEXT    NOT NULL,
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
  consumed_at         INTEGER,
  PRIMARY KEY (actor_id, id)
)`;

const INDEXES: ReadonlyArray<string> = [
  `CREATE INDEX IF NOT EXISTS idx_agent_log_events_pending
   ON agent_log (actor_id, priority, received_at)
   WHERE kind = 'event' AND turn_id IS NULL`,

  `CREATE INDEX IF NOT EXISTS idx_agent_log_events_consumed
   ON agent_log (actor_id, consumed_at)
   WHERE kind = 'event' AND consumed_at IS NOT NULL`,

  `CREATE INDEX IF NOT EXISTS idx_agent_log_phase_current
   ON agent_log (actor_id, turn_id, id DESC)
   WHERE kind = 'phase'`,

  `CREATE INDEX IF NOT EXISTS idx_agent_log_steps_per_turn
   ON agent_log (actor_id, turn_id, step_idx)
   WHERE kind IN ('step', 'tool_call', 'tool_result', 'reactor_decision')`,

  `CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_log_dedupe
   ON agent_log (actor_id, dedupe_key)
   WHERE dedupe_key IS NOT NULL`,

  `CREATE INDEX IF NOT EXISTS idx_agent_log_trace_events
   ON agent_log (actor_id, trace_id, received_at)
   WHERE kind = 'event'`,

  `CREATE INDEX IF NOT EXISTS idx_agent_log_reply_attempts
   ON agent_log (actor_id, parent_id)
   WHERE kind = 'reply_attempt'`,

  `CREATE INDEX IF NOT EXISTS idx_agent_log_by_trace
   ON agent_log (actor_id, trace_id, id)`,

  `CREATE INDEX IF NOT EXISTS idx_agent_log_received_at
   ON agent_log (actor_id, received_at DESC)`,
];

const VIEWS: ReadonlyArray<string> = [
  `CREATE VIEW IF NOT EXISTS events_v AS
   SELECT actor_id, id, turn_id, parent_id AS caused_by, trace_id, ingress, variant, trust,
          priority, payload_visibility, payload, received_at, schema_version, dedupe_key
   FROM agent_log
   WHERE kind = 'event'`,

  `CREATE VIEW IF NOT EXISTS run_event_v AS
   SELECT actor_id, id, turn_id, step_idx, kind, parent_id, payload, received_at
   FROM agent_log
   WHERE kind IN ('step', 'tool_call', 'tool_result', 'reactor_decision')
   ORDER BY actor_id, turn_id, step_idx, id`,

  `CREATE VIEW IF NOT EXISTS turn_phase_log_v AS
   SELECT actor_id, id, turn_id, payload, received_at
   FROM agent_log
   WHERE kind = 'phase'
   ORDER BY actor_id, received_at`,
];

const REPLY_CHANNELS_DDL = `
CREATE TABLE IF NOT EXISTS reply_channels (
  actor_id            TEXT    NOT NULL,
  id                  TEXT    NOT NULL,
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
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (actor_id, id)
)`;

const REPLY_CHANNELS_INDEXES: ReadonlyArray<string> = [
  `CREATE INDEX IF NOT EXISTS idx_reply_channels_open
   ON reply_channels (actor_id, state, ttl_expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_reply_channels_event
   ON reply_channels (actor_id, event_id)`,
];

const TRIGGERS_DDL = `
CREATE TABLE IF NOT EXISTS triggers (
  actor_id            TEXT    NOT NULL,
  id                  TEXT    NOT NULL,
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
  fire_count          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (actor_id, id)
)`;

const TRIGGERS_INDEXES: ReadonlyArray<string> = [
  `CREATE INDEX IF NOT EXISTS idx_triggers_active_fire
   ON triggers (actor_id, next_fire_at)
   WHERE state = 'active' AND next_fire_at IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_triggers_by_kind
   ON triggers (actor_id, kind, state)`,
];

export function initEventsHubTables(sql: SqlExec): void {
  sql.exec(AGENT_LOG_DDL);

  for (const ix of INDEXES) sql.exec(ix);

  for (const view of VIEWS) sql.exec(view);
  sql.exec(REPLY_CHANNELS_DDL);

  for (const ix of REPLY_CHANNELS_INDEXES) sql.exec(ix);
  sql.exec(TRIGGERS_DDL);

  for (const ix of TRIGGERS_INDEXES) sql.exec(ix);
}
