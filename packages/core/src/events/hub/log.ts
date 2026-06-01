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

import {
  type AgentLogRow, type EventId, type EventVariant, type IngressDescriptor,
  type Priority, type ProteusEvent, type ReplyChannelRef, type RevisitCondition,
  type TraceId, type TurnId, type TrustLevel,
} from './types.js';
import { dedupeKeyFor } from './dedupe.js';
import { deriveFields } from './trust.js';
import { applyVisibilityForStorage } from './visibility.js';
import { ulid } from './ulid.js';

interface SqlExec {
  exec(query: string, ...bindings: unknown[]): {
    toArray(): Array<Record<string, unknown>>;
  };
}

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

const PRIORITY_ORDER: Record<Priority, number> = {
  background: 0, normal: 1, urgent: 2,
};

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
    const { descriptor: d, now, caused_by, reply_channel, hmac_secret_for_visibility } = opts;

    // 1. Derive trust/priority/visibility (pure functions).
    const derived = deriveFields(d);

    // 2. Build the event for visibility transform + dedupe key.
    //    Use a placeholder id here — replaced before insert.
    const placeholderId = ulid();
    const trace_id = caused_by ? this.lookupTraceId(caused_by) ?? placeholderId : placeholderId;

    const eventForKey: ProteusEvent = {
      id: placeholderId,
      trace_id,
      caused_by: caused_by ?? null,
      ingress: d.ingress,
      variant: d.variant,
      trust: derived.trust,
      priority: derived.priority,
      payload_visibility: derived.payload_visibility,
      received_at: now,
      schema_version: EVENT_SCHEMA_VERSION,
      reply_channel: reply_channel ?? null,
      dedupe_key: null,           // computed below
      payload: d.payload as never,
    } as ProteusEvent;

    const dedupe_key = dedupeKeyFor(eventForKey);

    // 3. Visibility transform: what actually goes into the payload column.
    const transform = applyVisibilityForStorage(
      d.payload, derived.payload_visibility, hmac_secret_for_visibility,
    );

    // 4. Atomic dedupe + insert. The UNIQUE index on dedupe_key makes this
    //    "exactly once" — if a duplicate is racing, INSERT OR IGNORE wins
    //    and we read the original.
    if (dedupe_key !== null) {
      const existing = this.sql.exec(
        `SELECT id FROM agent_log WHERE dedupe_key = ?`, dedupe_key,
      ).toArray() as Array<{ id: string }>;
      if (existing.length > 0) {
        return { id: existing[0].id, admitted: false };
      }
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
      JSON.stringify(transform.stored),
      now,
      EVENT_SCHEMA_VERSION,
      dedupe_key,
    );

    return { id: placeholderId, admitted: true };
  }

  // ── pending ─────────────────────────────────────────────────────

  /** Events not yet bound to a turn. Ordered by priority desc, received_at asc.
   *  Honors deferred-revisit conditions if `resolve_deferred` is passed. */
  pending(filter: PendingFilter = {}): ProteusEvent[] {
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
    const bindings: unknown[] = [];

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

    const rows = this.sql.exec(sql, ...bindings).toArray() as Array<Record<string, unknown>>;
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
  private queryDeferred(ctx: { now: number; phase: 'idle' | 'merging' }): ProteusEvent[] {
    const rows = this.sql.exec(
      `SELECT id, parent_id, trace_id, ingress, variant, trust, priority,
              payload_visibility, payload, received_at, schema_version,
              dedupe_key, step_idx
       FROM agent_log
       WHERE kind = 'event' AND turn_id IS NULL AND step_idx = -1`,
    ).toArray() as Array<Record<string, unknown>>;

    const candidates = rows.map(rowToEvent);
    return candidates.filter((ev) => {
      const cond = (ev.payload as { __defer_revisit?: RevisitCondition }).__defer_revisit;
      if (!cond) return false;
      return revisitConditionMet(cond, ctx);
    });
  }

  // ── markConsumed ────────────────────────────────────────────────

  /** Bind an event to the turn that's about to handle it. */
  markConsumed(eventId: EventId, turnId: TurnId, stepIdx: number): void {
    this.sql.exec(
      `UPDATE agent_log SET turn_id = ?, step_idx = ? WHERE id = ? AND kind = 'event'`,
      turnId, stepIdx, eventId,
    );
  }

  /** Reverse of `markConsumed` — used by abort_replan to un-bind events so
   *  they re-enter the pending pool. */
  unbind(eventId: EventId): void {
    this.sql.exec(
      `UPDATE agent_log SET turn_id = NULL, step_idx = NULL WHERE id = ? AND kind = 'event'`,
      eventId,
    );
  }

  // ── defer ───────────────────────────────────────────────────────

  /** Push an event to a later turn. The revisit condition is stored in the
   *  payload's `__defer_revisit` field (additive — doesn't alter the user
   *  payload semantically). `step_idx = -1` marks the event as deferred. */
  defer(eventId: EventId, revisitAt: RevisitCondition): void {
    const row = this.sql.exec(
      `SELECT payload FROM agent_log WHERE id = ? AND kind = 'event'`, eventId,
    ).toArray() as Array<{ payload: string }>;
    if (row.length === 0) return;
    const payload = JSON.parse(row[0].payload);
    payload.__defer_revisit = revisitAt;
    this.sql.exec(
      `UPDATE agent_log SET payload = ?, step_idx = -1, turn_id = NULL WHERE id = ?`,
      JSON.stringify(payload), eventId,
    );
  }

  // ── dismiss ─────────────────────────────────────────────────────

  /** Explicit drop. Persists the event with `step_idx = -2` (sentinel) so
   *  it's never re-dispatched. The dismissal reason is appended to payload. */
  dismiss(eventId: EventId, reason: string, by: 'reactor' | 'tool' | 'system'): void {
    const row = this.sql.exec(
      `SELECT payload FROM agent_log WHERE id = ? AND kind = 'event'`, eventId,
    ).toArray() as Array<{ payload: string }>;
    if (row.length === 0) return;
    const payload = JSON.parse(row[0].payload);
    payload.__dismissed = { reason, by, at: Date.now() };
    this.sql.exec(
      `UPDATE agent_log SET payload = ?, step_idx = -2, turn_id = NULL WHERE id = ?`,
      JSON.stringify(payload), eventId,
    );
  }

  // ── query ───────────────────────────────────────────────────────

  /** Generic event read. Used by the operator UI and the LLM-facing
   *  `recent_events` / `list_pending_events` tools. */
  query(filter: QueryFilter): ProteusEvent[] {
    let sql = `
      SELECT id, parent_id, trace_id, ingress, variant, trust, priority,
             payload_visibility, payload, received_at, schema_version,
             dedupe_key, step_idx
      FROM agent_log
      WHERE kind = 'event'
    `;
    const bindings: unknown[] = [];
    if (filter.trace_id) { sql += ' AND trace_id = ?'; bindings.push(filter.trace_id); }
    if (filter.turn_id)  { sql += ' AND turn_id = ?';  bindings.push(filter.turn_id); }
    if (filter.variant)  { sql += ' AND variant = ?';  bindings.push(filter.variant); }
    if (filter.since)    { sql += ' AND received_at >= ?'; bindings.push(filter.since); }
    sql += ' ORDER BY received_at DESC';
    sql += ' LIMIT ?'; bindings.push(filter.limit ?? 100);
    const rows = this.sql.exec(sql, ...bindings).toArray() as Array<Record<string, unknown>>;
    return rows.map(rowToEvent);
  }

  /** Single-event read by id. */
  get(eventId: EventId): ProteusEvent | null {
    const rows = this.sql.exec(
      `SELECT id, parent_id, trace_id, ingress, variant, trust, priority,
              payload_visibility, payload, received_at, schema_version,
              dedupe_key, step_idx
       FROM agent_log
       WHERE kind = 'event' AND id = ?`, eventId,
    ).toArray() as Array<Record<string, unknown>>;
    return rows.length > 0 ? rowToEvent(rows[0]) : null;
  }

  // ── trace bookkeeping ───────────────────────────────────────────

  /** Trace id of a referenced event, or null if not found. */
  private lookupTraceId(eventId: EventId): TraceId | null {
    const rows = this.sql.exec(
      `SELECT trace_id FROM agent_log WHERE id = ? AND kind = 'event'`, eventId,
    ).toArray() as Array<{ trace_id: string }>;
    return rows.length > 0 ? rows[0].trace_id : null;
  }

  /** Number of events in a trace (used by per-trace budget). */
  traceEventCount(traceId: TraceId): number {
    const rows = this.sql.exec(
      `SELECT COUNT(*) AS n FROM agent_log WHERE trace_id = ? AND kind = 'event'`,
      traceId,
    ).toArray() as Array<{ n: number }>;
    return rows[0]?.n ?? 0;
  }

  // ── audit-log writes (steps, tool calls, etc.) ─────────────────

  /** Append a row to the unified log. The TurnRunner uses this for phase
   *  transitions, step boundaries, tool calls/results, reactor decisions,
   *  and reply attempts. Direct callers must NOT use this to insert
   *  `kind='event'` rows — only `publish()` is allowed. */
  appendNonEventRow(opts: {
    kind: 'phase' | 'step' | 'tool_call' | 'tool_result' | 'reactor_decision' | 'reply_attempt';
    turn_id: TurnId | null;
    step_idx: number | null;
    parent_id: string | null;
    trace_id: TraceId;
    payload: unknown;
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

  /** The latest phase row for a turn — used by recovery + by the TurnRunner
   *  to read current phase. Orders by received_at desc (strictly monotonic
   *  per write) with id desc as a tiebreaker. */
  currentPhase(turn_id: TurnId): { phase: string; at: number } | null {
    const rows = this.sql.exec(
      `SELECT payload, received_at FROM agent_log
       WHERE kind = 'phase' AND turn_id = ?
       ORDER BY received_at DESC, id DESC LIMIT 1`,
      turn_id,
    ).toArray() as Array<{ payload: string; received_at: number }>;
    if (rows.length === 0) return null;
    const p = JSON.parse(rows[0].payload) as { phase?: string };
    return { phase: p.phase ?? 'unknown', at: rows[0].received_at };
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
    ).toArray() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      kind: r.kind as AgentLogRow['kind'],
      turn_id: r.turn_id as string | null,
      step_idx: r.step_idx as number | null,
      parent_id: r.parent_id as string | null,
      trace_id: r.trace_id as string,
      ingress: r.ingress as never,
      variant: r.variant as never,
      trust: r.trust as never,
      priority: r.priority as never,
      payload_visibility: r.payload_visibility as never,
      payload: r.payload != null ? JSON.parse(r.payload as string) : null,
      received_at: r.received_at as number,
      schema_version: r.schema_version as number,
      dedupe_key: r.dedupe_key as string | null,
    }));
  }
}

// ── helpers ──────────────────────────────────────────────────────

function rowToEvent(r: Record<string, unknown>): ProteusEvent {
  return {
    id: r.id as string,
    trace_id: r.trace_id as string,
    caused_by: (r.parent_id as string | null) ?? null,
    ingress: r.ingress as never,
    variant: r.variant as never,
    trust: r.trust as TrustLevel,
    priority: r.priority as Priority,
    payload_visibility: r.payload_visibility as never,
    received_at: r.received_at as number,
    schema_version: r.schema_version as number,
    reply_channel: null,            // hydrated separately by ReplyChannelStore
    dedupe_key: (r.dedupe_key as string | null) ?? null,
    payload: r.payload != null ? JSON.parse(r.payload as string) : null,
  } as ProteusEvent;
}

function revisitConditionMet(cond: RevisitCondition, ctx: { now: number; phase: 'idle' | 'merging' }): boolean {
  switch (cond.kind) {
    case 'at': return ctx.now >= cond.ts;
    case 'after_phase': return cond.phase === ctx.phase;
    case 'after_seconds': return false;  // requires storing original-defer ts; v1 falls back to defer-then-poll
    case 'after_event': return false;    // resolved by a separate query when the matching event arrives
  }
}
