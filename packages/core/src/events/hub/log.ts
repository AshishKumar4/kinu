/** Append-only ledger over `agent_log`; `publish()` is the only admission path. Identity columns
 *  are immutable after insert; `turn_id`/`step_idx` may rebind, each transition writing a phase row. */

import * as v from 'valibot';
import { WorkModeSchema } from '../../types/turn';
import {
  SUBORDINATE_REPORT_STATUSES,
  type AgentLogRow, type EventId, type EventVariant, type IngressDescriptor,
  type SubordinateReportHandoffField,
  type Priority, type KinuEvent, type RevisitCondition,
  type TraceId, type TurnId,
} from './types';
import type { ActorHandle } from '../../identity/actor-handle';
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
import { boundedInt, boundPageQuery } from '../../utils/bounds';
import { SubordinateInheritedContextSchema } from '../../types/subordinates';
import { diagnostics, toKinuError } from '../../obs/index';

const EVENT_SCHEMA_VERSION = 1;

export interface PublishResult {
  /** The existing id when deduped. */
  id: EventId;
  admitted: boolean;
}

export interface PendingFilter {
  limit?: number;
  min_priority?: Priority;
  variant?: EventVariant;
  resolve_deferred?: { now: number; phase: 'idle' | 'merging' };
}

export interface QueryFilter {
  trace_id?: TraceId;
  turn_id?: TurnId;
  variant?: EventVariant;
  since?: number;
  limit?: number;
}

const EVENT_QUERY_LIMIT_DEFAULT = 100;

/** Sizes one drain's pickup; deliberately independent of `analytics/query.ts` `PANEL_ROW_LIMIT`. */
const PENDING_EVENT_LIMIT_DEFAULT = 50;

/** Boundary ceiling for untrusted callers only; in-object reads are not capped. */
const EVENT_QUERY_LIMIT_MAX = 500;

export interface BoundedQueryFilter extends QueryFilter {
  since: number;
  limit: number;
}

/** Absent and non-finite both mean unstated and take the default. Same policy as
 *  `boundRunEventQuery`, via {@link boundPageQuery}. */
export function boundEventQuery(filter: QueryFilter = {}): BoundedQueryFilter {
  return boundPageQuery(filter, {
    fallback: EVENT_QUERY_LIMIT_DEFAULT, max: EVENT_QUERY_LIMIT_MAX,
  });
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
  body_unsaved: v.optional(v.string()),
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
  stdout_unsaved: v.optional(v.string()),
  stderr_unsaved: v.optional(v.string()),
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
  body_unsaved: v.optional(v.string()),
  kinu_mode: WorkModeSchema,
});

const SubordinateTaskPayloadSchema = v.object({
  from_workspace: v.string(),
  kind: v.picklist(['task', 'message']),
  body: v.string(),
  deliverable: v.optional(v.string()),
  inherited_context: v.optional(SubordinateInheritedContextSchema),
  kinu_mode: WorkModeSchema,
  creation_id: v.optional(v.string()),
  message_id: v.optional(v.string()),
});

/** `v.object` strips unnamed fields; the total `satisfies` makes a forgotten field a compile error. */
const HandoffPayloadEntries = {
  concerns: v.optional(v.array(v.string())),
  deviations: v.optional(v.array(v.string())),
  findings: v.optional(v.array(v.string())),
  open_work: v.optional(v.array(v.string())),
} satisfies Record<SubordinateReportHandoffField, v.GenericSchema<string[] | undefined>>;

const SubordinateReportPayloadSchema = v.object({
  from_subordinate: v.string(),
  status: v.picklist(SUBORDINATE_REPORT_STATUSES),
  content: v.string(),
  sequence_id: v.string(),
  task: v.optional(v.string()),
  content_path: v.optional(v.string()),
  content_unsaved: v.optional(v.string()),
  ...HandoffPayloadEntries,
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
  body_unsaved: v.optional(v.string()),
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
  private readonly actorId: string;

  /** `actorId` is captured once so a re-pointed handle cannot move the log; `assertCurrent()` runs
   *  before every statement so a retired actor stops at once. */
  constructor(private readonly sql: SqlExec, private readonly actor: ActorHandle) {
    this.actorId = actor.actorId;
  }

  /** Without `caused_by` the event roots its own trace. */
  publish(opts: {
    descriptor: IngressDescriptor;
    now: number;
    caused_by?: EventId;
    hmac_secret_for_visibility?: string;
  }): PublishResult {
    this.actor.assertCurrent();
    const { descriptor: d, now, caused_by, hmac_secret_for_visibility } = opts;

    const derived = deriveFields(d);

    const placeholderId = ulid();
    const trace_id = caused_by ? this.lookupTraceId(caused_by) ?? placeholderId : placeholderId;
    const dedupe_key = dedupeKeyForDescriptor(d, now);

    const transform = applyVisibilityForStorage(
      d.payload, derived.payload_visibility, hmac_secret_for_visibility,
    );

    const storedPayload = preserveDelegatedMode(d, derived.payload_visibility, transform.stored);

    if (dedupe_key !== null) {
      const held = this.idForDedupeKey(dedupe_key);

      if (held !== null) return { id: held, admitted: false };
    }

    this.sql.exec(
      `INSERT INTO agent_log
         (actor_id, id, kind, turn_id, step_idx, parent_id, trace_id, ingress, variant,
          trust, priority, payload_visibility, payload, received_at,
          schema_version, dedupe_key)
       VALUES (?, ?, 'event', NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      this.actorId,
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

  /** Replaying ingresses ask this before any work of their own (spill, roster, wake). */
  idForDedupeKey(key: string): EventId | null {
    this.actor.assertCurrent();

    const rows = this.sql.exec(
      `SELECT id FROM agent_log WHERE actor_id = ? AND dedupe_key = ?`, this.actorId, key,
    ).toArray().map((row) => v.parse(IdRowSchema, row));

    return rows[0]?.id ?? null;
  }

  pending(filter: PendingFilter = {}): KinuEvent[] {
    this.actor.assertCurrent();

    const limit = boundedInt(
      filter.limit, PENDING_EVENT_LIMIT_DEFAULT, 1, Number.MAX_SAFE_INTEGER,
    );

    const minPrio = filter.min_priority ?? 'background';
    const minPrioRank = PRIORITY_ORDER[minPrio];

    // Deferred (step_idx=-1) and dismissed (step_idx=-2) are excluded.
    let sql = `
      SELECT id, parent_id, trace_id, ingress, variant, trust, priority,
             payload_visibility, payload, received_at, schema_version,
             dedupe_key, step_idx
      FROM agent_log
      WHERE actor_id = ?
        AND kind = 'event'
        AND turn_id IS NULL
        AND (step_idx IS NULL OR step_idx >= 0)
    `;

    const bindings: SqlValue[] = [this.actorId];

    if (filter.variant) {
      sql += ' AND variant = ?';
      bindings.push(filter.variant);
    }

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

    let events = rows.flatMap((row) => {
      const event = tryRowToEvent(row);

      return event === null ? [] : [event];
    });

    // A row whose revisit condition no longer parses is skipped, never resolved.
    if (filter.resolve_deferred) {
      const deferred = this.queryDeferred(filter.resolve_deferred);
      events = events.concat(deferred);
    }

    return events;
  }

  private queryDeferred(ctx: { now: number; phase: 'idle' | 'merging' }): KinuEvent[] {
    return this.deferredRows()
      .filter(({ cond }) => revisitConditionMet(cond, ctx))
      .map(({ event }) => event);
  }

  private deferredRows(): Array<{ event: KinuEvent; cond: RevisitCondition }> {
    this.actor.assertCurrent();

    const rows = this.sql.exec(
      `SELECT id, parent_id, trace_id, ingress, variant, trust, priority,
              payload_visibility, payload, received_at, schema_version,
              dedupe_key, step_idx
       FROM agent_log
       WHERE actor_id = ? AND kind = 'event' AND turn_id IS NULL AND step_idx = -1`,
      this.actorId,
    ).toArray().map((row) => v.parse(EventRowSchema, row));

    return rows.flatMap((row) => {
      const payload = v.safeParse(JsonObjectSchema, parseJsonValue(row.payload));

      if (!payload.success) return [];
      const cond = v.safeParse(RevisitConditionSchema, payload.output.__defer_revisit);

      return cond.success ? [{ event: rowToEvent(row), cond: cond.output }] : [];
    });
  }

  /**
   * When a drain would next have work, or null. Only the instant: the host must arm a chain whose
   * frame runs `drainPendingEvents`, or the row stays pending. Only `at` conditions name a time.
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

  markConsumed(eventId: EventId, turnId: TurnId, stepIdx: number, now = Date.now()): void {
    this.actor.assertCurrent();
    this.sql.exec(
      `UPDATE agent_log SET turn_id = ?, step_idx = ?, consumed_at = ?
       WHERE actor_id = ? AND id = ? AND kind = 'event'`,
      turnId, stepIdx, now, this.actorId, eventId,
    );
  }

  markTurnCompleted(turnId: TurnId): void {
    this.actor.assertCurrent();
    this.sql.exec(
      `UPDATE agent_log SET consumed_at = NULL
       WHERE actor_id = ? AND turn_id = ? AND kind = 'event'`,
      this.actorId, turnId,
    );
  }

  /** Used by abort_replan to re-pend events. */
  unbind(eventId: EventId): void {
    this.actor.assertCurrent();
    this.sql.exec(
      `UPDATE agent_log SET turn_id = NULL, step_idx = NULL, consumed_at = NULL
       WHERE actor_id = ? AND id = ? AND kind = 'event'`,
      this.actorId, eventId,
    );
  }

  /** Reports open leases; only the caller can tell re-pend from finish-the-reply. */
  openDrainLeases(): TurnId[] {
    this.actor.assertCurrent();

    return this.sql.exec(
      `SELECT DISTINCT turn_id FROM agent_log
       WHERE actor_id = ? AND kind = 'event' AND turn_id LIKE 'evt-%'
         AND consumed_at IS NOT NULL`,
      this.actorId,
    ).toArray().map((row) => v.parse(TurnIdRowSchema, row).turn_id);
  }

  /** Indexed LIMIT-1 read; must not materialize the roster. */
  hasOpenDrainLease(): boolean {
    this.actor.assertCurrent();

    return this.sql.exec(
      `SELECT 1 FROM agent_log
       WHERE actor_id = ? AND kind = 'event' AND turn_id LIKE 'evt-%'
         AND consumed_at IS NOT NULL LIMIT 1`,
      this.actorId,
    ).toArray().length > 0;
  }

  /**
   * `olderThanMs` has no default: `0` only for a host holding an exclusive lease. `answered` turns
   * owe a reply, and re-pending them would silently repeat the question.
   */
  unbindStale(
    olderThanMs: number,
    now = Date.now(),
    answered: ReadonlySet<TurnId> = new Set(),
  ): EventId[] {
    this.actor.assertCurrent();
    const cutoff = now - olderThanMs;
    const keep = [...answered];

    const exclusion = keep.length === 0
      ? ''
      : ` AND turn_id NOT IN (${keep.map(() => '?').join(', ')})`;

    const rows = this.sql.exec(
      `UPDATE agent_log
       SET turn_id = NULL, step_idx = NULL, consumed_at = NULL
       WHERE actor_id = ? AND id IN (
         SELECT id FROM agent_log
         WHERE actor_id = ?
           AND kind = 'event'
           AND turn_id LIKE 'evt-%'
           AND consumed_at IS NOT NULL
           AND consumed_at <= ?${exclusion}
       )
       RETURNING id`,
      this.actorId,
      this.actorId,
      cutoff,
      ...keep,
    ).toArray().map((row) => v.parse(IdRowSchema, row));

    return rows.map((row) => row.id);
  }

  /** Condition stored under the payload's `__defer_revisit`; `step_idx = -1` marks deferred. */
  defer(eventId: EventId, revisitAt: RevisitCondition): void {
    this.actor.assertCurrent();

    const row = this.sql.exec(
      `SELECT payload FROM agent_log WHERE actor_id = ? AND id = ? AND kind = 'event'`,
      this.actorId, eventId,
    ).toArray().map((entry) => v.parse(PayloadRowSchema, entry));

    if (row.length === 0) return;
    const payload = parseJsonObject(row[0].payload);
    payload.__defer_revisit = v.parse(JsonValueSchema, revisitAt);
    this.sql.exec(
      `UPDATE agent_log SET payload = ?, step_idx = -1, turn_id = NULL, consumed_at = NULL
       WHERE actor_id = ? AND id = ?`,
      JSON.stringify(payload), this.actorId, eventId,
    );
  }

  /** `step_idx = -2` so it is never re-dispatched. */
  dismiss(eventId: EventId, reason: string, by: 'reactor' | 'tool' | 'system'): void {
    this.actor.assertCurrent();

    const row = this.sql.exec(
      `SELECT payload FROM agent_log WHERE actor_id = ? AND id = ? AND kind = 'event'`,
      this.actorId, eventId,
    ).toArray().map((entry) => v.parse(PayloadRowSchema, entry));

    if (row.length === 0) return;
    const payload = parseJsonObject(row[0].payload);
    payload.__dismissed = { reason, by, at: Date.now() };
    this.sql.exec(
      `UPDATE agent_log SET payload = ?, step_idx = -2, turn_id = NULL, consumed_at = NULL
       WHERE actor_id = ? AND id = ?`,
      JSON.stringify(payload), this.actorId, eventId,
    );
  }

  /** Only a finite positive limit reaches SQL: SQLite treats a negative LIMIT as unbounded and
   *  rejects NaN. No ceiling here; {@link boundEventQuery} caps untrusted callers. */
  query(filter: QueryFilter): KinuEvent[] {
    this.actor.assertCurrent();

    const limit = boundedInt(
      filter.limit, EVENT_QUERY_LIMIT_DEFAULT, 1, Number.MAX_SAFE_INTEGER,
    );

    let sql = `
      SELECT id, parent_id, trace_id, ingress, variant, trust, priority,
             payload_visibility, payload, received_at, schema_version,
             dedupe_key, step_idx
      FROM agent_log
      WHERE actor_id = ? AND kind = 'event'
    `;

    const bindings: SqlValue[] = [this.actorId];

    if (filter.trace_id) { sql += ' AND trace_id = ?'; bindings.push(filter.trace_id); }

    if (filter.turn_id)  { sql += ' AND turn_id = ?';  bindings.push(filter.turn_id); }

    if (filter.variant)  { sql += ' AND variant = ?';  bindings.push(filter.variant); }

    if (filter.since)    { sql += ' AND received_at >= ?'; bindings.push(filter.since); }

    sql += ' ORDER BY received_at DESC, id DESC';
    sql += ' LIMIT ?'; bindings.push(limit);

    const rows = this.sql.exec(sql, ...bindings).toArray()
      .map((row) => v.parse(EventRowSchema, row));

    return rows.flatMap((row) => {
      const event = tryRowToEvent(row);

      return event === null ? [] : [event];
    });
  }

  get(eventId: EventId): KinuEvent | null {
    this.actor.assertCurrent();

    const rows = this.sql.exec(
      `SELECT id, parent_id, trace_id, ingress, variant, trust, priority,
              payload_visibility, payload, received_at, schema_version,
              dedupe_key, step_idx
       FROM agent_log
       WHERE actor_id = ? AND kind = 'event' AND id = ?`, this.actorId, eventId,
    ).toArray().map((row) => v.parse(EventRowSchema, row));

    return rows.length > 0 ? rowToEvent(rows[0]) : null;
  }

  private lookupTraceId(eventId: EventId): TraceId | null {
    this.actor.assertCurrent();

    const rows = this.sql.exec(
      `SELECT trace_id FROM agent_log WHERE actor_id = ? AND id = ? AND kind = 'event'`,
      this.actorId, eventId,
    ).toArray().map((row) => v.parse(TraceRowSchema, row));

    return rows.length > 0 ? rows[0].trace_id : null;
  }

  traceEventCount(traceId: TraceId): number {
    this.actor.assertCurrent();

    const rows = this.sql.exec(
      `SELECT COUNT(*) AS n FROM agent_log
       WHERE actor_id = ? AND trace_id = ? AND kind = 'event'`,
      this.actorId, traceId,
    ).toArray().map((row) => v.parse(CountRowSchema, row));

    return rows[0]?.n ?? 0;
  }

  /** Never for `kind='event'` rows; only `publish()` inserts those. */
  appendNonEventRow(opts: {
    kind: 'phase' | 'step' | 'tool_call' | 'tool_result' | 'reactor_decision' | 'reply_attempt';
    turn_id: TurnId | null;
    step_idx: number | null;
    parent_id: string | null;
    trace_id: TraceId;
    payload: unknown;
    now: number;
  }): string {
    this.actor.assertCurrent();
    const id = ulid();
    this.sql.exec(
      `INSERT INTO agent_log
         (actor_id, id, kind, turn_id, step_idx, parent_id, trace_id, ingress, variant,
          trust, priority, payload_visibility, payload, received_at,
          schema_version, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, 1, NULL)`,
      this.actorId, id, opts.kind, opts.turn_id, opts.step_idx, opts.parent_id, opts.trace_id,
      JSON.stringify(opts.payload), opts.now,
    );

    return id;
  }

  currentPhase(turn_id: TurnId): { phase: string; at: number } | null {
    this.actor.assertCurrent();

    const rows = this.sql.exec(
      `SELECT payload, received_at FROM agent_log
       WHERE actor_id = ? AND kind = 'phase' AND turn_id = ?
       ORDER BY received_at DESC, id DESC LIMIT 1`,
      this.actorId, turn_id,
    ).toArray().map((row) => v.parse(PhaseRowSchema, row));

    if (rows.length === 0) return null;
    const payload = parseJsonObject(rows[0].payload);
    const phase = v.safeParse(v.string(), payload.phase);

    return { phase: phase.success ? phase.output : 'unknown', at: rows[0].received_at };
  }

  turnSteps(turn_id: TurnId): AgentLogRow[] {
    this.actor.assertCurrent();

    const rows = this.sql.exec(
      `SELECT id, kind, turn_id, step_idx, parent_id, trace_id, ingress, variant,
              trust, priority, payload_visibility, payload, received_at, schema_version, dedupe_key
       FROM agent_log
       WHERE actor_id = ? AND turn_id = ?
         AND kind IN ('step', 'tool_call', 'tool_result', 'reactor_decision')
       ORDER BY step_idx, id`,
      this.actorId, turn_id,
    ).toArray().map((row) => v.parse(AgentLogRowSchema, row));

    return rows.map((row): AgentLogRow => ({
      ...row,
      payload: parseJsonValue(row.payload),
    }));
  }
}

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

/** A corrupt row is reported and skipped so it cannot wedge the drain. */
function tryRowToEvent(row: v.InferOutput<typeof EventRowSchema>): KinuEvent | null {
  try {
    return rowToEvent(row);
  } catch (err) {
    const failure = toKinuError({ doing: 'decode an event row', cause: err, otherwise: 'bad_input' });

    // Other failure classes are this read's own fault and propagate.
    if (failure.code !== 'bad_input') throw failure;
    diagnostics.failure('event.row_unreadable', failure, { id: row.id });

    return null;
  }
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
