/**
 * `agent_log` — the single append-only ledger for every event, phase,
 * step, tool call, tool result, reactor decision, and reply attempt in
 * an agent's lifetime. Discriminated by `kind`.
 *
 * Partial indexes per kind are mandatory — without them recovery scans
 * regress to table-scans on the hot path.
 *
 * EVERY table here is ACTOR-SCOPED, in the primary key. One workspace database
 * holds every logical actor, and each of them has its OWN inbox: a delegated
 * task admitted for a hired subordinate must not drain on the root, and a
 * reply channel opened for one actor's event is not another's to answer.
 *
 * `dedupe_key` is the sharpest case and is why the uniqueness is composite.
 * The key is the INGRESS's identity — a webhook delivery id, a message id, a
 * peer envelope id — so two actors handed the same upstream event legitimately
 * present the same key. A table-wide unique index would silently dedupe the
 * second actor's ingress against the FIRST actor's row: one actor's inbox
 * swallowing another's event, with nothing anywhere recording the loss.
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
  // Recovery hot path: pending events ordered by priority desc, received_at asc.
  // Partial index keyed on (kind='event' AND turn_id IS NULL).
  `CREATE INDEX IF NOT EXISTS idx_agent_log_events_pending
   ON agent_log (actor_id, priority, received_at)
   WHERE kind = 'event' AND turn_id IS NULL`,

  // Activation recovery scans only open delivery leases.
  `CREATE INDEX IF NOT EXISTS idx_agent_log_events_consumed
   ON agent_log (actor_id, consumed_at)
   WHERE kind = 'event' AND consumed_at IS NOT NULL`,

  // Phase lookups: latest phase row per turn.
  `CREATE INDEX IF NOT EXISTS idx_agent_log_phase_current
   ON agent_log (actor_id, turn_id, id DESC)
   WHERE kind = 'phase'`,

  // Steps per turn: ordered traversal for SSE replay + recovery.
  `CREATE INDEX IF NOT EXISTS idx_agent_log_steps_per_turn
   ON agent_log (actor_id, turn_id, step_idx)
   WHERE kind IN ('step', 'tool_call', 'tool_result', 'reactor_decision')`,

  // Unique dedupe key, PER OWNER. NULL values do not participate in
  // uniqueness. The owner leads because the key is the upstream ingress's
  // identity, not this workspace's: two hosted actors handed the same webhook
  // delivery each owe their own event, and a table-wide index would drop the
  // second one as a duplicate of the first actor's row.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_log_dedupe
   ON agent_log (actor_id, dedupe_key)
   WHERE dedupe_key IS NOT NULL`,

  // Per-trace event counting for trace-budget checks.
  `CREATE INDEX IF NOT EXISTS idx_agent_log_trace_events
   ON agent_log (actor_id, trace_id, received_at)
   WHERE kind = 'event'`,

  // Reply attempt audit: by event.
  `CREATE INDEX IF NOT EXISTS idx_agent_log_reply_attempts
   ON agent_log (actor_id, parent_id)
   WHERE kind = 'reply_attempt'`,

  // Generic by-trace scan.
  `CREATE INDEX IF NOT EXISTS idx_agent_log_by_trace
   ON agent_log (actor_id, trace_id, id)`,

  // Recent rows ordered by receipt (operator UI timeline).
  `CREATE INDEX IF NOT EXISTS idx_agent_log_received_at
   ON agent_log (actor_id, received_at DESC)`,
];

const VIEWS: ReadonlyArray<string> = [
  // Events only. Used by the operator UI's events sidebar and the LLM-facing
  // `recent_events` tool.
  `CREATE VIEW IF NOT EXISTS events_v AS
   SELECT actor_id, id, turn_id, parent_id AS caused_by, trace_id, ingress, variant, trust,
          priority, payload_visibility, payload, received_at, schema_version, dedupe_key
   FROM agent_log
   WHERE kind = 'event'`,

  // Run-event trace (steps + tool calls + tool results + reactor decisions).
  // SSE streamer reads from this. eventIndex semantics: row id ordering.
  `CREATE VIEW IF NOT EXISTS run_event_v AS
   SELECT actor_id, id, turn_id, step_idx, kind, parent_id, payload, received_at
   FROM agent_log
   WHERE kind IN ('step', 'tool_call', 'tool_result', 'reactor_decision')
   ORDER BY actor_id, turn_id, step_idx, id`,

  // Phase transition log.
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

/** Initialize all hub tables, indexes, and views. Idempotent. */
export function initEventsHubTables(sql: SqlExec): void {
  sql.exec(AGENT_LOG_DDL);
  for (const ix of INDEXES) sql.exec(ix);
  for (const view of VIEWS) sql.exec(view);
  sql.exec(REPLY_CHANNELS_DDL);
  for (const ix of REPLY_CHANNELS_INDEXES) sql.exec(ix);
  sql.exec(TRIGGERS_DDL);
  for (const ix of TRIGGERS_INDEXES) sql.exec(ix);
}
