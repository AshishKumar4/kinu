/**
 * EventLog — append-only ledger over the `agent_log` table.
 *
 * The only entry point that admits new events into the system is `publish()`.
 * It derives trust/priority/visibility from the ingress descriptor (never from
 * payload, never from caller), persists atomically with dedupe, and returns
 * an `EventId`.
 *
 * Operations:
 *
 *   publish(IngressDescriptor)                — admit a new event
 *   pending(opts?)                            — events not yet bound to a turn
 *   markConsumed(eventId, turnId, stepIdx)    — bind event to its handling turn
 *   defer(eventId, revisitCondition)          — push to a later turn
 *   dismiss(eventId, reason)                  — explicit drop (audit-only)
 *   query(opts)                               — generic read for UI / replay
 *
 * Append-only invariants:
 *
 *   - `id`, `trace_id`, `caused_by`, `ingress`, `variant`, `trust`,
 *     `priority`, `payload_visibility`, `received_at`, `dedupe_key` are
 *     immutable post-insert.
 *
 *   - `turn_id` and `step_idx` may transition from NULL to a value (binding)
 *     and from a value to a different value (replay-with-new-turn after an
 *     abort_replan). Each transition writes a `phase` row for audit.
 *
 *   - The dedupe UNIQUE index makes `publish()` idempotent at the storage
 *     level — duplicate idempotency keys return the existing event id.
 */

import * as v from 'valibot';
import {
  SUBORDINATE_REPORT_STATUSES,
  type AgentLogRow, type EventId, type EventVariant, type IngressDescriptor,
  type Priority, type KinuEvent, type ReplyChannelRef, type RevisitCondition,
  type TraceId, type TurnId,
} from './types';
import { dedupeKeyForDescriptor } from './dedupe';
import { wakesADrain } from './drain';
import { deriveFields } from './trust';
import { applyVisibilityForStorage } from './visibility';
import { ulid } from './ulid';
import type { SqlExec, SqlValue } from '../../types/primitives';
import {
  JsonObjectSchema,
  JsonValueSchema,
  parseJsonObject,
  parseJsonValue,
} from '../../utils/json';

const EVENT_SCHEMA_VERSION = 1;

export interface PublishResult {
  /** The event id. If the event was a duplicate, this is the EXISTING id. */
  id: EventId;
  /** True if this was a brand-new admission; false if dedupe rejected. */
  admitted: boolean;
}

export interface PendingFilter {
  /** Max number of events to return. Default 50. */
  limit?: number;
  /** Minimum priority. Defaults to 'background'. */
  min_priority?: Priority;
  /** Restrict to a specific variant. */
  variant?: EventVariant;
  /** Only events whose deferred revisit condition is now satisfied. */
  resolve_deferred?: { now: number; phase: 'idle' | 'merging' };
}

export interface QueryFilter {
  trace_id?: TraceId;
  turn_id?: TurnId;
  variant?: EventVariant;
  since?: number;
  limit?: number;
}

const PRIORITY_ORDER = {
  background: 0, normal: 1, urgent: 2,
} satisfies Record<Priority, number>;

const IngressSchema = v.picklist([
  'chat_ws', 'webhook_hmac', 'webhook_bearer', 'webhook_mtls', 'timer_alarm',
  'sandbox_cb', 'process_watch', 'file_watch', 'peer_async', 'mcp_streamable',
  'email_inbound', 'subordinate', 'self_emit', 'reply_request',
]);
const VariantSchema = v.picklist([
  'chat', 'webhook', 'process_done', 'timer', 'peer_agent', 'subordinate_task',
  'subordinate_report', 'file_changed', 'email', 'internal', 'reply_request',
  'mcp_chat', 'mcp_third_party',
]);
const TrustSchema = v.picklist(['external', 'authenticated', 'owner', 'self']);
const PrioritySchema = v.picklist(['urgent', 'normal', 'background']);
const PayloadPolicySchema = v.picklist(['full', 'redact', 'hash', 'hmac', 'opaque_handle']);
const AgentLogKindSchema = v.picklist([
  'event', 'phase', 'step', 'tool_call', 'tool_result', 'reactor_decision', 'reply_attempt',
]);
const WorkModeSchema = v.picklist(['plan', 'build']);
const NullableString = v.nullable(v.string());
const NullableNumber = v.nullable(v.number());
const IdRowSchema = v.object({ id: v.string() });
const TurnIdRowSchema = v.object({ turn_id: v.string() });
const PayloadRowSchema = v.object({ payload: v.string() });
const TraceRowSchema = v.object({ trace_id: v.string() });
const CountRowSchema = v.object({ n: v.number() });
const PhaseRowSchema = v.object({ payload: v.string(), received_at: v.number() });

const EventRowSchema = v.object({
  id: v.string(),
  parent_id: NullableString,
  trace_id: v.string(),
  ingress: IngressSchema,
  variant: VariantSchema,
  trust: TrustSchema,
  priority: PrioritySchema,
  payload_visibility: PayloadPolicySchema,
  payload: v.string(),
  received_at: v.number(),
  schema_version: v.number(),
  dedupe_key: NullableString,
  step_idx: NullableNumber,
});

const AgentLogRowSchema = v.object({
  id: v.string(),
  kind: AgentLogKindSchema,
  turn_id: NullableString,
  step_idx: NullableNumber,
  parent_id: NullableString,
  trace_id: v.string(),
  ingress: v.nullable(IngressSchema),
  variant: v.nullable(VariantSchema),
  trust: v.nullable(TrustSchema),
  priority: v.nullable(PrioritySchema),
  payload_visibility: v.nullable(PayloadPolicySchema),
  payload: v.string(),
  received_at: v.number(),
  schema_version: v.number(),
  dedupe_key: NullableString,
});

const ChatPayloadSchema = v.object({ text: v.string() });
const WebhookPayloadSchema = v.object({
  webhook_id: v.string(),
  http_method: v.string(),
  http_headers: v.record(v.string(), v.string()),
  body: v.unknown(),
  delivery_id: v.string(),
  body_path: v.optional(v.string()),
});
const ProcessDonePayloadSchema = v.object({
  process_id: v.string(),
  command: v.string(),
  exit_code: v.number(),
  stdout_excerpt: v.string(),
  stderr_excerpt: v.string(),
  duration_ms: v.number(),
  full_stdout_handle: v.optional(v.string()),
  full_stderr_handle: v.optional(v.string()),
});
const TimerPayloadSchema = v.object({
  trigger_id: v.string(),
  scheduled_fire_at: v.number(),
  label: v.optional(v.string()),
  user_payload: v.optional(v.unknown()),
  mission_label: v.optional(v.string()),
});
const PeerAgentPayloadSchema = v.object({
  from_agent_name: v.string(),
  from_user_id: v.string(),
  topic: v.string(),
  body: JsonValueSchema,
  sender_event_id: v.string(),
  reply_expected: v.optional(v.boolean()),
  body_path: v.optional(v.string()),
  kinu_mode: WorkModeSchema,
});
const SubordinateTaskPayloadSchema = v.object({
  from_workspace: v.string(),
  kind: v.picklist(['task', 'message']),
  body: v.string(),
  deliverable: v.optional(v.string()),
  deadline_hint: v.optional(v.string()),
  inherited_context: v.optional(v.string()),
  kinu_mode: WorkModeSchema,
});
const SubordinateReportPayloadSchema = v.object({
  from_subordinate: v.string(),
  status: v.picklist(SUBORDINATE_REPORT_STATUSES),
  content: v.string(),
  // Optional on the STORED shape: see SubordinateReportPayload. Ingress
  // requires it, so nothing new is written without one.
  sequence_id: v.optional(v.string()),
  task: v.optional(v.string()),
  content_path: v.optional(v.string()),
  kinu_mode: WorkModeSchema,
});
const FileChangedPayloadSchema = v.object({
  path: v.string(),
  change: v.picklist(['created', 'modified', 'deleted']),
  size: v.optional(v.number()),
});
const EmailPayloadSchema = v.object({
  from: v.string(),
  to: v.string(),
  subject: v.string(),
  body_text: v.string(),
  message_id: NullableString,
  in_reply_to: NullableString,
  references: NullableString,
  attachments: v.array(v.object({
    filename: v.string(),
    content_type: v.string(),
    size: v.number(),
  })),
  body_path: v.optional(v.string()),
});
const InternalPayloadSchema = v.object({ kind: v.string(), data: v.unknown() });
const ReplyRequestPayloadSchema = v.object({
  question: v.string(),
  schema: v.optional(v.unknown()),
  awaiting_event_id: v.string(),
});
const McpChatPayloadSchema = v.object({
  client_id: v.string(), method: v.string(), arguments: v.unknown(), request_id: v.string(),
});
const McpThirdPartyPayloadSchema = v.object({
  client_id: v.string(), client_label: v.string(), method: v.string(),
  arguments: v.unknown(), request_id: v.string(),
});
const RevisitConditionSchema = v.variant('kind', [
  v.object({ kind: v.literal('at'), ts: v.number() }),
  v.object({ kind: v.literal('after_phase'), phase: v.picklist(['idle', 'merging']) }),
  v.object({ kind: v.literal('after_event'), variant: VariantSchema, source: v.optional(v.string()) }),
  v.object({ kind: v.literal('after_seconds'), n: v.number() }),
]);

export class EventLog {
  constructor(private readonly sql: SqlExec) {}

  // ── publish ─────────────────────────────────────────────────────

  /**
   * Admit a new event. Derives trust/priority/visibility from the ingress
   * descriptor, persists in one transaction with dedupe, returns the id.
   *
   * The caused_by parameter, if present, links the new event to its causing
   * event (sharing trace_id, advancing causal depth). If null, the new event
   * is the root of its own trace.
   */
  publish(opts: {
    descriptor: IngressDescriptor;
    now: number;
    caused_by?: EventId;
    reply_channel?: ReplyChannelRef;
    hmac_secret_for_visibility?: string;
  }): PublishResult {
    const { descriptor: d, now, caused_by, hmac_secret_for_visibility } = opts;

    // 1. Derive trust/priority/visibility (pure functions).
    const derived = deriveFields(d);

    // 2. Build the durable identity + dedupe key.
    const placeholderId = ulid();
    const trace_id = caused_by ? this.lookupTraceId(caused_by) ?? placeholderId : placeholderId;
    const dedupe_key = dedupeKeyForDescriptor(d, now);

    // 3. Visibility transform: what actually goes into the payload column.
    const transform = applyVisibilityForStorage(
      d.payload, derived.payload_visibility, hmac_secret_for_visibility,
    );
    const storedPayload = preserveDelegatedMode(d, derived.payload_visibility, transform.stored);

    // 4. Atomic dedupe + insert. The UNIQUE index on dedupe_key makes this
    //    "exactly once" — if a duplicate is racing, INSERT OR IGNORE wins
    //    and we read the original.
    if (dedupe_key !== null) {
      const held = this.idForDedupeKey(dedupe_key);
      if (held !== null) return { id: held, admitted: false };
    }

    this.sql.exec(
      `INSERT INTO agent_log
         (id, kind, turn_id, step_idx, parent_id, trace_id, ingress, variant,
          trust, priority, payload_visibility, payload, received_at,
          schema_version, dedupe_key)
       VALUES (?, 'event', NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      placeholderId,
      caused_by ?? null,
      trace_id,
      d.ingress,
      d.variant,
      derived.trust,
      derived.priority,
      derived.payload_visibility,
      JSON.stringify(storedPayload),
      now,
      EVENT_SCHEMA_VERSION,
      dedupe_key,
    );

    return { id: placeholderId, admitted: true };
  }

  /**
   * The event already admitted under this idempotency key, if any.
   *
   * `publish` asks it to answer a duplicate with the original id, and an
   * ingress whose sender REPLAYS asks it before doing any work of its own —
   * a spill, a roster transition, a wake — so a replayed delivery is
   * recognised as the one already held rather than acted on twice.
   */
  idForDedupeKey(key: string): EventId | null {
    const rows = this.sql.exec(
      `SELECT id FROM agent_log WHERE dedupe_key = ?`, key,
    ).toArray().map((row) => v.parse(IdRowSchema, row));
    return rows[0]?.id ?? null;
  }

  // ── pending ─────────────────────────────────────────────────────

  /** Events not yet bound to a turn. Ordered by priority desc, received_at asc.
   *  Honors deferred-revisit conditions if `resolve_deferred` is passed. */
  pending(filter: PendingFilter = {}): KinuEvent[] {
    const limit = filter.limit ?? 50;
    const minPrio = filter.min_priority ?? 'background';
    const minPrioRank = PRIORITY_ORDER[minPrio];

    // Exclude deferred (step_idx=-1) and dismissed (step_idx=-2) events from
    // the normal pending list. Deferred rows surface via `resolve_deferred`.
    let sql = `
      SELECT id, parent_id, trace_id, ingress, variant, trust, priority,
             payload_visibility, payload, received_at, schema_version,
             dedupe_key, step_idx
      FROM agent_log
      WHERE kind = 'event'
        AND turn_id IS NULL
        AND (step_idx IS NULL OR step_idx >= 0)
    `;
    const bindings: SqlValue[] = [];

    if (filter.variant) {
      sql += ' AND variant = ?';
      bindings.push(filter.variant);
    }

    // Priority filter via CASE-mapped order.
    sql += `
      AND (
        CASE priority
          WHEN 'urgent' THEN 2
          WHEN 'normal' THEN 1
          WHEN 'background' THEN 0
        END
      ) >= ?
    `;
    bindings.push(minPrioRank);

    sql += `
      ORDER BY
        CASE priority
          WHEN 'urgent' THEN 2
          WHEN 'normal' THEN 1
          WHEN 'background' THEN 0
        END DESC,
        received_at ASC
      LIMIT ?
    `;
    bindings.push(limit);

    const rows = this.sql.exec(sql, ...bindings).toArray()
      .map((row) => v.parse(EventRowSchema, row));
    let events = rows.map(rowToEvent);

    // Resolve deferred events: those whose revisit condition is now satisfied.
    // Deferred state is encoded by `step_idx = -1` (marker) + a JSON
    // condition stored in `payload_visibility` — but visibility is already
    // a column. We instead use a separate `deferrals` table for the
    // condition; markConsumed clears it. For simplicity in v1 we store the
    // revisit_at as a JSON-encoded blob in step_idx via a dedicated
    // `defer_until` shadow column we'll add via migration if needed.
    // For now: deferred events have `step_idx = -1` and are excluded from
    // `pending()` unless `resolve_deferred` is set.
    if (filter.resolve_deferred) {
      const deferred = this.queryDeferred(filter.resolve_deferred);
      events = events.concat(deferred);
    }

    return events;
  }

  /** Deferred events whose revisit condition is satisfied. */
  private queryDeferred(ctx: { now: number; phase: 'idle' | 'merging' }): KinuEvent[] {
    return this.deferredRows()
      .filter(({ cond }) => revisitConditionMet(cond, ctx))
      .map(({ event }) => event);
  }

  /** Every deferred row that still carries a readable revisit condition, paired
   *  with it. One read for the two questions asked of deferred rows: which are
   *  due now (`queryDeferred`), and when the next one becomes due
   *  ({@link nextPendingDrainAt}). */
  private deferredRows(): Array<{ event: KinuEvent; cond: RevisitCondition }> {
    const rows = this.sql.exec(
      `SELECT id, parent_id, trace_id, ingress, variant, trust, priority,
              payload_visibility, payload, received_at, schema_version,
              dedupe_key, step_idx
       FROM agent_log
       WHERE kind = 'event' AND turn_id IS NULL AND step_idx = -1`,
    ).toArray().map((row) => v.parse(EventRowSchema, row));

    return rows.flatMap((row) => {
      const payload = v.safeParse(JsonObjectSchema, parseJsonValue(row.payload));
      if (!payload.success) return [];
      const cond = v.safeParse(RevisitConditionSchema, payload.output.__defer_revisit);
      return cond.success ? [{ event: rowToEvent(row), cond: cond.output }] : [];
    });
  }

  /**
   * The earliest moment a drain would have work to do, or null when it would
   * have none. The DURABLE half of the reactor's wake.
   *
   * A pending row is a promise the workspace made to itself, and until this
   * existed the only thing that kept that promise was an in-memory debounce
   * timer: an event admitted seconds before an eviction, or re-pended by a
   * compensating signal, sat in `agent_log` with nothing scheduled to look at
   * it again. The activation reconcile could not see it either, because the
   * wake fold it reads (`nextWakeAt`) knew only about triggers and the two
   * outboxes. So the row waited for the next unrelated ingress — hours, or
   * never.
   *
   * Derived, never stored. `now` for anything drainable this instant; otherwise
   * the soonest deferred `at`, which is the only revisit condition that names a
   * time. `after_phase`, `after_event` and `after_seconds` resolve against
   * something other than the clock, so no wake can be derived from them and
   * arming one would only busy-loop the alarm.
   */
  nextPendingDrainAt(now = Date.now()): number | null {
    const drainableNow = this.pending({ resolve_deferred: { now, phase: 'idle' } })
      .some(wakesADrain);
    if (drainableNow) return now;
    const scheduled = this.deferredRows()
      .filter(({ event }) => wakesADrain(event))
      .flatMap(({ cond }) => cond.kind === 'at' && cond.ts > now ? [cond.ts] : []);
    return scheduled.length === 0 ? null : Math.min(...scheduled);
  }

  // ── markConsumed ────────────────────────────────────────────────

  /** Bind an event to the turn that's about to handle it. */
  markConsumed(eventId: EventId, turnId: TurnId, stepIdx: number, now = Date.now()): void {
    this.sql.exec(
      `UPDATE agent_log SET turn_id = ?, step_idx = ?, consumed_at = ?
       WHERE id = ? AND kind = 'event'`,
      turnId, stepIdx, now, eventId,
    );
  }

  /** Close the recovery lease after a drain turn completed. The durable
   *  turn binding remains available for reply dispatch and audit queries. */
  markTurnCompleted(turnId: TurnId): void {
    this.sql.exec(
      `UPDATE agent_log SET consumed_at = NULL
       WHERE turn_id = ? AND kind = 'event'`,
      turnId,
    );
  }

  /** Reverse of `markConsumed` — used by abort_replan to un-bind events so
   *  they re-enter the pending pool. */
  unbind(eventId: EventId): void {
    this.sql.exec(
      `UPDATE agent_log SET turn_id = NULL, step_idx = NULL, consumed_at = NULL
       WHERE id = ? AND kind = 'event'`,
      eventId,
    );
  }

  /**
   * The synthetic drain turns whose recovery lease is still open.
   *
   * The same rows {@link unbindStale} would re-pend, read rather than reclaimed.
   * An open lease means a turn was handed these events and has not closed them;
   * that is either work nobody will answer (re-pend it) or a reply the turn
   * already answered and never dispatched (finish it). Only the caller can tell
   * which, because only the caller can see whether the turn produced a durable
   * answer — so this reports, and the caller decides.
   */
  openDrainLeases(): TurnId[] {
    return this.sql.exec(
      `SELECT DISTINCT turn_id FROM agent_log
       WHERE kind = 'event' AND turn_id LIKE 'evt-%' AND consumed_at IS NOT NULL`,
    ).toArray().map((row) => v.parse(TurnIdRowSchema, row).turn_id);
  }

  /** Whether ANY drain lease is open — one indexed LIMIT-1 read, for the
   *  activation-time arm decision that must not materialize the roster. */
  hasOpenDrainLease(): boolean {
    return this.sql.exec(
      `SELECT 1 FROM agent_log
       WHERE kind = 'event' AND turn_id LIKE 'evt-%' AND consumed_at IS NOT NULL LIMIT 1`,
    ).toArray().length > 0;
  }

  /**
   * Re-pend synthetic drain deliveries whose recovery lease is still open — a
   * turn was handed these events and never closed the lease on them, so nobody
   * is going to answer them and no later drain can see them.
   *
   * `olderThanMs` is REQUIRED, and it is a grace rather than a policy: a backend
   * that cannot exclude the holder (a DO activation may be racing its own
   * predecessor) reclaims only leases stranded that long, while a backend that
   * holds an exclusive lease over the conversation states `0` and says at its
   * call site why every open lease it can see is already dead. No default,
   * because the two answers are opposite and a caller must pick one.
   *
   * `answered` names the drain turns that DID produce an answer and therefore
   * owe a reply rather than a second asking. Re-pending one of those is the
   * quiet data loss this sweep used to cause on its own: the sender was still
   * waiting on a reply that already existed, and got a repeat of the question
   * instead. The exclusion is a predicate and not an execution order on
   * purpose — an ordering between this and the resume would have to hold on
   * every path, and this holds whatever runs first.
   */
  unbindStale(
    olderThanMs: number,
    now = Date.now(),
    answered: ReadonlySet<TurnId> = new Set(),
  ): EventId[] {
    const cutoff = now - olderThanMs;
    const keep = [...answered];
    const exclusion = keep.length === 0
      ? ''
      : ` AND turn_id NOT IN (${keep.map(() => '?').join(', ')})`;
    const rows = this.sql.exec(
      `UPDATE agent_log
       SET turn_id = NULL, step_idx = NULL, consumed_at = NULL
       WHERE id IN (
         SELECT id FROM agent_log
         WHERE kind = 'event'
           AND turn_id LIKE 'evt-%'
           AND consumed_at IS NOT NULL
           AND consumed_at <= ?${exclusion}
       )
       RETURNING id`,
      cutoff,
      ...keep,
    ).toArray().map((row) => v.parse(IdRowSchema, row));
    return rows.map((row) => row.id);
  }

  // ── defer ───────────────────────────────────────────────────────

  /** Push an event to a later turn. The revisit condition is stored in the
   *  payload's `__defer_revisit` field (additive — doesn't alter the user
   *  payload semantically). `step_idx = -1` marks the event as deferred. */
  defer(eventId: EventId, revisitAt: RevisitCondition): void {
    const row = this.sql.exec(
      `SELECT payload FROM agent_log WHERE id = ? AND kind = 'event'`, eventId,
    ).toArray().map((entry) => v.parse(PayloadRowSchema, entry));
    if (row.length === 0) return;
    const payload = parseJsonObject(row[0].payload);
    payload.__defer_revisit = v.parse(JsonValueSchema, revisitAt);
    this.sql.exec(
      `UPDATE agent_log SET payload = ?, step_idx = -1, turn_id = NULL, consumed_at = NULL WHERE id = ?`,
      JSON.stringify(payload), eventId,
    );
  }

  // ── dismiss ─────────────────────────────────────────────────────

  /** Explicit drop. Persists the event with `step_idx = -2` (sentinel) so
   *  it's never re-dispatched. The dismissal reason is appended to payload. */
  dismiss(eventId: EventId, reason: string, by: 'reactor' | 'tool' | 'system'): void {
    const row = this.sql.exec(
      `SELECT payload FROM agent_log WHERE id = ? AND kind = 'event'`, eventId,
    ).toArray().map((entry) => v.parse(PayloadRowSchema, entry));
    if (row.length === 0) return;
    const payload = parseJsonObject(row[0].payload);
    payload.__dismissed = { reason, by, at: Date.now() };
    this.sql.exec(
      `UPDATE agent_log SET payload = ?, step_idx = -2, turn_id = NULL, consumed_at = NULL WHERE id = ?`,
      JSON.stringify(payload), eventId,
    );
  }

  // ── query ───────────────────────────────────────────────────────

  /** Generic event read. Used by the operator UI and the LLM-facing
   *  `recent_events` / `list_pending_events` tools. */
  query(filter: QueryFilter): KinuEvent[] {
    let sql = `
      SELECT id, parent_id, trace_id, ingress, variant, trust, priority,
             payload_visibility, payload, received_at, schema_version,
             dedupe_key, step_idx
      FROM agent_log
      WHERE kind = 'event'
    `;
    const bindings: SqlValue[] = [];
    if (filter.trace_id) { sql += ' AND trace_id = ?'; bindings.push(filter.trace_id); }
    if (filter.turn_id)  { sql += ' AND turn_id = ?';  bindings.push(filter.turn_id); }
    if (filter.variant)  { sql += ' AND variant = ?';  bindings.push(filter.variant); }
    if (filter.since)    { sql += ' AND received_at >= ?'; bindings.push(filter.since); }
    sql += ' ORDER BY received_at DESC';
    sql += ' LIMIT ?'; bindings.push(filter.limit ?? 100);
    const rows = this.sql.exec(sql, ...bindings).toArray()
      .map((row) => v.parse(EventRowSchema, row));
    return rows.map(rowToEvent);
  }

  /** Single-event read by id. */
  get(eventId: EventId): KinuEvent | null {
    const rows = this.sql.exec(
      `SELECT id, parent_id, trace_id, ingress, variant, trust, priority,
              payload_visibility, payload, received_at, schema_version,
              dedupe_key, step_idx
       FROM agent_log
       WHERE kind = 'event' AND id = ?`, eventId,
    ).toArray().map((row) => v.parse(EventRowSchema, row));
    return rows.length > 0 ? rowToEvent(rows[0]) : null;
  }

  // ── trace bookkeeping ───────────────────────────────────────────

  /** Trace id of a referenced event, or null if not found. */
  private lookupTraceId(eventId: EventId): TraceId | null {
    const rows = this.sql.exec(
      `SELECT trace_id FROM agent_log WHERE id = ? AND kind = 'event'`, eventId,
    ).toArray().map((row) => v.parse(TraceRowSchema, row));
    return rows.length > 0 ? rows[0].trace_id : null;
  }

  /** Number of events in a trace (used by per-trace budget). */
  traceEventCount(traceId: TraceId): number {
    const rows = this.sql.exec(
      `SELECT COUNT(*) AS n FROM agent_log WHERE trace_id = ? AND kind = 'event'`,
      traceId,
    ).toArray().map((row) => v.parse(CountRowSchema, row));
    return rows[0]?.n ?? 0;
  }

  // ── audit-log writes (steps, tool calls, etc.) ─────────────────

  /** Append a non-event row to the unified log (phase transitions, step
   *  boundaries, tool calls/results, reactor decisions, reply attempts —
   *  e.g. the email dispatcher's reply_attempt audit rows). Direct callers
   *  must NOT use this to insert `kind='event'` rows — only `publish()` is
   *  allowed. */
  appendNonEventRow<Payload>(opts: {
    kind: 'phase' | 'step' | 'tool_call' | 'tool_result' | 'reactor_decision' | 'reply_attempt';
    turn_id: TurnId | null;
    step_idx: number | null;
    parent_id: string | null;
    trace_id: TraceId;
    payload: Payload;
    now: number;
  }): string {
    const id = ulid();
    this.sql.exec(
      `INSERT INTO agent_log
         (id, kind, turn_id, step_idx, parent_id, trace_id, ingress, variant,
          trust, priority, payload_visibility, payload, received_at,
          schema_version, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, 1, NULL)`,
      id, opts.kind, opts.turn_id, opts.step_idx, opts.parent_id, opts.trace_id,
      JSON.stringify(opts.payload), opts.now,
    );
    return id;
  }

  /** The latest phase row for a turn. Orders by received_at desc (strictly
   *  monotonic per write) with id desc as a tiebreaker. */
  currentPhase(turn_id: TurnId): { phase: string; at: number } | null {
    const rows = this.sql.exec(
      `SELECT payload, received_at FROM agent_log
       WHERE kind = 'phase' AND turn_id = ?
       ORDER BY received_at DESC, id DESC LIMIT 1`,
      turn_id,
    ).toArray().map((row) => v.parse(PhaseRowSchema, row));
    if (rows.length === 0) return null;
    const payload = parseJsonObject(rows[0].payload);
    const phase = v.safeParse(v.string(), payload.phase);
    return { phase: phase.success ? phase.output : 'unknown', at: rows[0].received_at };
  }

  /** All step / tool rows of a turn, ordered. Used by reactor snapshot
   *  + recovery + SSE replay. */
  turnSteps(turn_id: TurnId): AgentLogRow[] {
    const rows = this.sql.exec(
      `SELECT id, kind, turn_id, step_idx, parent_id, trace_id, ingress, variant,
              trust, priority, payload_visibility, payload, received_at, schema_version, dedupe_key
       FROM agent_log
       WHERE turn_id = ? AND kind IN ('step', 'tool_call', 'tool_result', 'reactor_decision')
       ORDER BY step_idx, id`,
      turn_id,
    ).toArray().map((row) => v.parse(AgentLogRowSchema, row));
    return rows.map((row): AgentLogRow => ({
      ...row,
      payload: parseJsonValue(row.payload),
    }));
  }
}

// ── helpers ──────────────────────────────────────────────────────

function preserveDelegatedMode(
  descriptor: IngressDescriptor,
  policy: v.InferOutput<typeof PayloadPolicySchema>,
  stored: v.InferOutput<typeof JsonValueSchema>,
): v.InferOutput<typeof JsonValueSchema> {
  if (policy === 'full' || policy === 'redact') return stored;
  if (
    descriptor.variant !== 'peer_agent'
    && descriptor.variant !== 'subordinate_task'
    && descriptor.variant !== 'subordinate_report'
  ) return stored;
  const envelope = v.safeParse(JsonObjectSchema, stored);
  if (!envelope.success) return stored;
  return { ...envelope.output, kinu_mode: descriptor.payload.kinu_mode };
}

function rowToEvent(row: v.InferOutput<typeof EventRowSchema>): KinuEvent {
  const payload = parseJsonValue(row.payload);
  const base = {
    id: row.id,
    trace_id: row.trace_id,
    caused_by: row.parent_id,
    ingress: row.ingress,
    trust: row.trust,
    priority: row.priority,
    received_at: row.received_at,
    schema_version: row.schema_version,
    reply_channel: null,
    dedupe_key: row.dedupe_key,
  };

  if (row.payload_visibility !== 'full' && row.payload_visibility !== 'redact') {
    return {
      ...base,
      variant: row.variant,
      payload_visibility: row.payload_visibility,
      payload,
    };
  }

  const readable = { ...base, payload_visibility: row.payload_visibility };
  switch (row.variant) {
    case 'chat':
      return { ...readable, variant: row.variant, payload: v.parse(ChatPayloadSchema, payload) };
    case 'webhook':
      return { ...readable, variant: row.variant, payload: v.parse(WebhookPayloadSchema, payload) };
    case 'process_done':
      return { ...readable, variant: row.variant, payload: v.parse(ProcessDonePayloadSchema, payload) };
    case 'timer':
      return { ...readable, variant: row.variant, payload: v.parse(TimerPayloadSchema, payload) };
    case 'peer_agent':
      return { ...readable, variant: row.variant, payload: v.parse(PeerAgentPayloadSchema, payload) };
    case 'subordinate_task':
      return { ...readable, variant: row.variant, payload: v.parse(SubordinateTaskPayloadSchema, payload) };
    case 'subordinate_report':
      return { ...readable, variant: row.variant, payload: v.parse(SubordinateReportPayloadSchema, payload) };
    case 'file_changed':
      return { ...readable, variant: row.variant, payload: v.parse(FileChangedPayloadSchema, payload) };
    case 'email':
      return { ...readable, variant: row.variant, payload: v.parse(EmailPayloadSchema, payload) };
    case 'internal':
      return { ...readable, variant: row.variant, payload: v.parse(InternalPayloadSchema, payload) };
    case 'reply_request':
      return { ...readable, variant: row.variant, payload: v.parse(ReplyRequestPayloadSchema, payload) };
    case 'mcp_chat':
      return { ...readable, variant: row.variant, payload: v.parse(McpChatPayloadSchema, payload) };
    case 'mcp_third_party':
      return { ...readable, variant: row.variant, payload: v.parse(McpThirdPartyPayloadSchema, payload) };
  }
}

function revisitConditionMet(cond: RevisitCondition, ctx: { now: number; phase: 'idle' | 'merging' }): boolean {
  switch (cond.kind) {
    case 'at': return ctx.now >= cond.ts;
    case 'after_phase': return cond.phase === ctx.phase;
    case 'after_seconds': return false;  // requires storing original-defer ts; v1 falls back to defer-then-poll
    case 'after_event': return false;    // resolved by a separate query when the matching event arrives
  }
}
