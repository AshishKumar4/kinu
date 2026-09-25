/** Durable per-run event log; subscribers are notified synchronously after persisting. */

import * as v from 'valibot';
import type { ModelMessage } from 'ai';
import { decodeModelMessageValues, encodeModelMessageValues } from '../session/message-codec';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import {
  CONTEXT_EDIT_BOUNDARIES, CONTEXT_EDIT_STATUSES, CONTEXT_EDIT_VIA,
  type OpenTurnIdentity, type RunEvent, type RunEventInput, type RunEventType,
} from './types';
import { JsonObjectSchema, JsonValueSchema } from '../utils/json';
import { boundedInt, boundPageQuery } from '../utils/bounds';
import { USAGE_FIELDS, UsageSchema, type Usage } from '../usage';
import { ESCALATION_OUTCOMES } from '../execution/escalation';
import { APP_MUTATIONS, APP_TABLE_SCOPES } from '../types/app-store';
import {
  SPEND_SOURCES, WORKSPACE_RUN_ID,
  MODEL_OPERATION_KINDS, MODEL_OPERATION_PHASES, MODEL_OPERATION_OUTCOMES,
  type ModelOperationSink, type SpendSource, type SpendTally,
} from './model-call';
import { diagnostics, toKinuError } from '../obs/index';
import { ToolOutcomeSchema } from '../types/tool-outcome';
import { turnAuthor } from '../utils/ui-message';

/** Stored model messages validate against the AI SDK's own schema, not a hand-written copy. */
const OpenTurnIdentitySchema: v.GenericSchema<OpenTurnIdentity> = v.object({
  turnId: v.string(), messageId: v.string(), kind: v.picklist(['user', 'programmatic']), text: v.string(),
  metadata: v.optional(JsonObjectSchema), pendingSendId: v.optional(v.string()),
  steerIds: v.optional(v.array(v.string())),
});

const BaseFields = {
  eventIndex: v.number(),
  runId: v.string(),
  timestamp: v.string(),
};

const ContextCompositionSchema = v.object({
  segments: v.array(v.object({
    plane: v.picklist(['system', 'tools', 'messages', 'ephemeral']),
    label: v.string(), chars: v.number(), items: v.number(),
  })),
  measuredChars: v.number(),
  charsPerToken: v.number(),
  estimatedTokens: v.number(),
});

const HeadFileChangeSetSchema = v.object({
  id: v.string(),
  changes: v.array(v.object({
    path: v.string(),
    status: v.picklist(['added', 'removed', 'changed']),
    added: v.number(),
    removed: v.number(),
    binary: v.optional(v.boolean()),
    directory: v.optional(v.boolean()),
    unreadable: v.optional(v.boolean()),
  })),
});

/** For already-decoded values (e.g. over RPC); {@link parseStoredRunEvent} takes the stored string. */
export const RunEventSchema = v.variant('type', [
  v.object({ ...BaseFields, type: v.literal('run_start'), agentId: v.string(),
    userMessage: v.optional(v.string()), caused_by: v.optional(v.string()),
    ingress_kind: v.optional(v.string()), trigger_id: v.optional(v.string()),
    turn: v.optional(OpenTurnIdentitySchema) }),
  v.object({ ...BaseFields, type: v.literal('turn_start'), turnIndex: v.number() }),
  v.object({ ...BaseFields, type: v.literal('tool_call_end'), name: v.string(),
    toolCallId: v.string(), args: v.optional(JsonValueSchema),
    result: v.optional(JsonValueSchema), error: v.optional(v.string()),
    durationMs: v.optional(v.number()), outcome: v.optional(ToolOutcomeSchema) }),
  v.object({ ...BaseFields, type: v.literal('step_finish'), stepIndex: v.number(),
    reason: v.optional(v.string()), messages: v.optional(v.array(JsonValueSchema)),
    usage: v.optional(UsageSchema), usd: v.optional(v.number()),
    usdFloorTokens: v.optional(v.number()),
    modelId: v.optional(v.string()), context: v.optional(ContextCompositionSchema) }),
  v.object({ ...BaseFields, type: v.literal('step_partial'), stepIndex: v.number(), text: v.string(),
    toolCalls: v.array(v.object({ toolCallId: v.string(), toolName: v.string(), args: JsonValueSchema,
      result: v.optional(v.string()), error: v.optional(v.string()) })) }),
  v.object({ ...BaseFields, type: v.literal('model_call'),
    source: v.picklist(SPEND_SOURCES), usage: v.optional(UsageSchema),
    usd: v.optional(v.number()), usdFloorTokens: v.optional(v.number()),
    spec: v.optional(v.string()), modelId: v.optional(v.string()) }),
  v.object({ ...BaseFields, type: v.literal('model_operation'),
    operationId: v.string(), source: v.picklist(SPEND_SOURCES),
    op: v.picklist(MODEL_OPERATION_KINDS), phase: v.picklist(MODEL_OPERATION_PHASES),
    outcome: v.optional(v.picklist(MODEL_OPERATION_OUTCOMES)),
    usage: v.optional(UsageSchema), spec: v.optional(v.string()),
    modelId: v.optional(v.string()), error: v.optional(v.string()) }),
  v.object({ ...BaseFields, type: v.literal('provider_wait'),
    provider: v.string(), modelId: v.optional(v.string()),
    waitMs: v.number(), attempt: v.number(),
    status: v.optional(v.number()),
    source: v.picklist(['header', 'backoff', 'cooldown']) }),
  v.object({ ...BaseFields, type: v.literal('head_split'), rootId: v.string(),
    headIds: v.array(v.string()), rationale: v.string() }),
  v.object({ ...BaseFields, type: v.literal('head_merge'), rootId: v.string(),
    headCount: v.number(), headsWithFindings: v.number(), totalTokens: v.optional(v.number()),
    mergedNarrative: v.string(), fileChanges: v.array(HeadFileChangeSetSchema),
    blindSpots: v.array(v.string()) }),
  v.object({ ...BaseFields, type: v.literal('head_abandoned'), rootId: v.string(),
    headCount: v.number(), abandoned: v.number(), rationale: v.string(), reason: v.string() }),
  v.object({ ...BaseFields, type: v.literal('scaffold_promotion'), fromVersion: v.number(), toVersion: v.number() }),
  v.object({ ...BaseFields, type: v.literal('scaffold_rollback'), fromVersion: v.number(), toVersion: v.number() }),
  v.object({ ...BaseFields, type: v.literal('memory_write'), path: v.string(), bytes: v.number() }),
  v.object({ ...BaseFields, type: v.literal('db_op'), op: v.picklist(APP_MUTATIONS),
    table: v.string(), scope: v.picklist(APP_TABLE_SCOPES), rowsAffected: v.number(),
    batch: v.nullable(v.number()) }),
  v.object({ ...BaseFields, type: v.literal('context_edit'), contextId: v.string(), proposalId: v.string(), revision: v.number(),
    baseRevision: v.number(), messageCount: v.number(), author: v.string(),
    via: v.picklist(CONTEXT_EDIT_VIA), status: v.picklist(CONTEXT_EDIT_STATUSES),
    effectiveAt: v.picklist(CONTEXT_EDIT_BOUNDARIES),
    turnId: v.nullable(v.string()), stepIndex: v.nullable(v.number()) }),
  v.object({ ...BaseFields, type: v.literal('context_budget'), admittedChars: v.number(),
    omittedChars: v.number(), trips: v.object({
      shell: v.optional(v.number()), file_read: v.optional(v.number()), web_fetch: v.optional(v.number()),
      eval: v.optional(v.number()), external_tool: v.optional(v.number()),
      attachment: v.optional(v.number()), pasted_text: v.optional(v.number()),
    }), referenced: v.number(), followUps: v.number() }),
  v.object({ ...BaseFields, type: v.literal('file_edit'), attempts: v.number(), applied: v.number(),
    failures: v.object({
      empty_anchor: v.optional(v.number()), not_found: v.optional(v.number()),
      ambiguous: v.optional(v.number()), overlap: v.optional(v.number()),
      no_change: v.optional(v.number()), unread: v.optional(v.number()),
      stale: v.optional(v.number()), missing: v.optional(v.number()), io: v.optional(v.number()),
    }), recoveredPaths: v.number(), abandonedPaths: v.number() }),
  v.object({ ...BaseFields, type: v.literal('turn_steering'),
    trigger: v.picklist(['repeated_call', 'repeated_failure', 'no_progress']),
    step: v.number(), tool: v.optional(v.string()), converted: v.boolean() }),
  v.object({ ...BaseFields, type: v.literal('profile_resolution'),
    durationMs: v.number(), providerCache: v.picklist(['hit', 'joined', 'miss']),
    providerRevision: v.string(), unavailableProviders: v.number(),
    catalogVersion: v.number(), authority: v.picklist(['local', 'account']) }),
  v.object({ ...BaseFields, type: v.literal('completion_gate'), converted: v.boolean() }),
  v.object({ ...BaseFields, type: v.literal('craft_cycle'), crafted: v.array(v.string()),
    invoked: v.array(v.string()), reused: v.array(v.string()), returned: v.number(),
    raised: v.number(), dropped: v.array(v.string()) }),
  v.object({ ...BaseFields, type: v.literal('execution_recovery'), recoveries: v.array(v.object({
    tool: v.string(), failures: v.number(), failedSignature: v.string(),
  })) }),
  v.object({ ...BaseFields, type: v.literal('execution_escalation'), escalations: v.array(v.object({
    runtime: v.string(), reason: v.nullable(v.string()),
    outcome: v.picklist(ESCALATION_OUTCOMES), count: v.number(),
  })) }),
  v.object({ ...BaseFields, type: v.literal('budget_exhausted'),
    seam: v.picklist(['model_call', 'spawn']), label: v.string(), scope: v.string(),
    limit: v.object({ usd: v.optional(v.number()), tokens: v.optional(v.number()) }),
    spent: v.object({ tokens: v.number(), usd: v.number() }), note: v.string() }),
  v.object({ ...BaseFields, type: v.literal('fiber_recovered'), fiberName: v.string(),
    fiberId: v.string(), snapshot: v.optional(v.unknown()) }),
  v.object({ ...BaseFields, type: v.literal('approval_consumed'), approvalId: v.string(),
    command: v.string(), executor: v.string() }),
  v.object({ ...BaseFields, type: v.literal('error'), message: v.string(), details: v.optional(v.unknown()) }),
  v.object({ ...BaseFields, type: v.literal('turn_end'), turnIndex: v.number(),
    workMode: v.optional(v.picklist(['plan', 'build'])), usage: v.optional(UsageSchema) }),
  v.object({ ...BaseFields, type: v.literal('run_end'), reason: v.optional(v.string()), error: v.optional(v.string()) }),
]);

/** Step messages are stored in the session codec's durable form. */
function stampRunEvent(input: RunEventInput, eventIndex: number, runId: string): RunEvent {
  const base = { eventIndex, runId, timestamp: new Date().toISOString() };

  if (input.type !== 'step_finish') return { ...input, ...base };
  const { messages, ...rest } = input;

  return messages === undefined
    ? { ...rest, ...base }
    : { ...rest, ...base, messages: encodeModelMessageValues(messages) };
}

/** The single place a persisted event becomes typed; readers must not re-declare event shapes. */
export function parseStoredRunEvent(payload: string): RunEvent {
  return v.parse(RunEventSchema, JSON.parse(payload));
}

export interface RunEventQuery {
  since?: number;
  until?: number;
  types?: readonly RunEventType[];
  limit?: number;
}

export interface BoundedRunEventQuery extends RunEventQuery {
  since: number;
  limit: number;
}

export const RUN_EVENT_LIMIT_DEFAULT = 200;

/** Ceiling for untrusted callers only; in-object folds (e.g. `getRunSummaries`) state their own
 *  window, since a narrowed window would be a truncated denominator. */
export const RUN_EVENT_LIMIT_MAX = 500;

/** Absent and non-finite mean unstated and take the default. Applied by the HTTP route and
 *  {@link getRunEvents}; same policy as `boundEventQuery`, via {@link boundPageQuery}. */
export function boundRunEventQuery(opts: RunEventQuery = {}): BoundedRunEventQuery {
  return boundPageQuery(opts, { fallback: RUN_EVENT_LIMIT_DEFAULT, max: RUN_EVENT_LIMIT_MAX });
}

export interface RunListEntry {
  runId: string;
  lastTs: string;
  eventCount: number;
}

export type RunEventListener = (event: RunEvent) => void;

/** See {@link RunEventRecorder.emitDeferred}. */
export interface DeferredRunEvent {
  readonly event: RunEvent;
  /** Call once, after the caller's transaction commits. */
  publish(): void;
}

/** Actor id is in the primary key: `run_id` is per activation and `event_index` restarts per run,
 *  so without it two actors' runs would merge. */
export function initRunEventTables(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS run_events (
    actor_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    event_index INTEGER NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    ts TEXT NOT NULL,
    PRIMARY KEY (actor_id, run_id, event_index)
  )`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_run_events_run_ts ON run_events(actor_id, run_id, ts)`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_run_events_type ON run_events(actor_id, type, ts DESC)`);
}

export interface StepSpendSource {
  readonly actorId: string;
  readonly source: SpendSource;
  readonly coveredSince: string | null;
}

/** Keyed by `keyof Usage` so a new usage field widens the row. `source` is unnarrowed so a corrupt
 *  row gets named, not silently attributed. */
type SpendAggregateRow = Readonly<Record<keyof Usage, number | null>> & {
  readonly source: string | null;
  readonly calls: number;
  readonly callsWithoutUsage: number;
  readonly unpricedCalls: number;
  readonly floorPricedCalls: number;
  readonly usd: number | null;
};

/** SQL NULL means no call reported the field, which is not zero. */
function spendTallyOf(row: SpendAggregateRow): SpendTally {
  const usage: { -readonly [K in keyof Usage]: number } = {};

  for (const field of USAGE_FIELDS) {
    const summed = row[field];

    if (summed !== null) usage[field] = summed;
  }

  const tally = {
    calls: row.calls,
    callsWithoutUsage: row.callsWithoutUsage,
    usage,
    unpricedCalls: row.unpricedCalls,
    floorPricedCalls: row.floorPricedCalls,
  };

  return row.usd === null ? tally : { ...tally, usd: row.usd };
}

export class RunEventRecorder {
  private readonly nextIndex = new Map<string, number>();
  private readonly listeners = new Set<RunEventListener>();
  readonly actorId: string;

  constructor(private readonly sql: SqlExecutor, private readonly actor: ActorHandle) {
    this.actorId = actor.actorId;
  }

  emit(runId: string, input: RunEventInput): RunEvent {
    const deferred = this.emitDeferred(runId, input);
    deferred.publish();

    return deferred.event;
  }

  /**
   * For callers inside a SQL transaction: the row rolls back with it, and `publish()` runs after
   * commit so no subscriber hears of an undone write. A rollback leaves an `event_index` gap.
   */
  emitDeferred(runId: string, input: RunEventInput): DeferredRunEvent {
    const event = stampRunEvent(input, this.allocateIndex(runId), runId);
    this.persist(event);

    return {
      event,
      publish: () => {
        for (const listener of this.listeners) {
          try { listener(event); } catch (err) {
            diagnostics.failure(
              'event.listener_failed',
              toKinuError({ doing: 'notify a run-event listener', cause: err, otherwise: 'io' }),
              { runId, eventType: event.type },
            );
          }
        }
      },
    };
  }

  private allocateIndex(runId: string): number {
    const cached = this.nextIndex.get(runId);

    if (cached != null) {
      this.nextIndex.set(runId, cached + 1);

      return cached;
    }

    const rows = this.sql<{ max_idx: number | null }>`
      SELECT MAX(event_index) AS max_idx FROM run_events
      WHERE actor_id = ${this.actorId} AND run_id = ${runId}`;

    const max = rows[0]?.max_idx ?? -1;
    const next = max + 1;
    this.nextIndex.set(runId, next + 1);

    return next;
  }

  // Plain INSERT: a collision means a second writer, and raises instead of replacing.
  private persist(ev: RunEvent): void {
    this.actor.assertCurrent();
    void this.sql`INSERT INTO run_events (actor_id, run_id, event_index, type, payload, ts)
      VALUES (${this.actorId}, ${ev.runId}, ${ev.eventIndex}, ${ev.type}, ${JSON.stringify(ev)}, ${ev.timestamp})`;
  }

  /** Only a finite positive limit reaches SQL: SQLite treats a negative LIMIT as unbounded and
   *  rejects fractions and NaN. No ceiling here; {@link boundRunEventQuery} caps untrusted callers. */
  read(runId: string, opts: RunEventQuery = {}): RunEvent[] {
    this.actor.assertCurrent();
    const limit = boundedInt(opts.limit, RUN_EVENT_LIMIT_DEFAULT, 1, Number.MAX_SAFE_INTEGER);
    const since = boundedInt(opts.since, 0, 0, Number.MAX_SAFE_INTEGER);
    const types = opts.types && opts.types.length > 0 ? new Set<string>(opts.types) : null;

    if (!types) {
      const rows = this.sql<{ payload: string }>`
        SELECT payload FROM run_events
        WHERE actor_id = ${this.actorId} AND run_id = ${runId} AND event_index >= ${since}
        ORDER BY event_index ASC
        LIMIT ${limit}`;

      return rows.map((r) => parseStoredRunEvent(r.payload));
    }

    // Type filter runs client-side (no portable dynamic IN-clause), paging forward on `event_index`
    // until `limit` matches are filled so sparse matches are not lost.
    const matched: RunEvent[] = [];
    let cursor = since;
    const fetchLimit = Math.min(limit * 4, 2000);

    while (matched.length < limit) {
      const rows = this.sql<{ payload: string; event_index: number }>`
        SELECT payload, event_index FROM run_events
        WHERE actor_id = ${this.actorId} AND run_id = ${runId} AND event_index >= ${cursor}
        ORDER BY event_index ASC
        LIMIT ${fetchLimit}`;

      const last = rows[rows.length - 1];

      if (last === undefined) break;

      for (const row of rows) {
        if (matched.length >= limit) break;
        const event = parseStoredRunEvent(row.payload);

        if (types.has(event.type)) matched.push(event);
      }

      if (rows.length < fetchLimit) break;
      cursor = last.event_index + 1;
    }

    return matched;
  }

  /**
   * Null when no split was recorded rather than guessing a run. Appending to an ended run is fine:
   * `allocateIndex` continues from MAX(event_index). {@link spendByProducer} relies on SQLite JSON
   * functions, exercised on DO SQLite by `tests/workerd/long/do-spend-aggregate.test.ts`.
   */
  runForHeadSplit(rootId: string, window = 500): string | null {
    this.actor.assertCurrent();

    const rows = this.sql<{ run_id: string; payload: string }>`
      SELECT run_id, payload FROM run_events
      WHERE actor_id = ${this.actorId} AND type = 'head_split'
      ORDER BY ts DESC LIMIT ${window}`;

    for (const row of rows) {
      const ev = parseStoredRunEvent(row.payload);

      if (ev.type === 'head_split' && ev.rootId === rootId) return row.run_id;
    }

    return null;
  }

  /** `run_start` without `run_end`: a frame destroyed by eviction writes no terminal row. Read at
   *  start of life, so every one found was left by an earlier activation. */
  unterminatedRuns(window = 500, startedBefore = Number.POSITIVE_INFINITY): string[] {
    this.actor.assertCurrent();

    const rows = this.sql<{ run_id: string; type: string; ts: string }>`
      SELECT run_id, type, ts FROM run_events
      WHERE actor_id = ${this.actorId} AND (type = 'run_start' OR type = 'run_end')
      ORDER BY ts DESC LIMIT ${window}`;

    const closed = new Set(rows.filter((row) => row.type === 'run_end').map((row) => row.run_id));
    const open: string[] = [];
    const seen = new Set<string>();

    for (const row of rows) {
      if (row.type !== 'run_start' || closed.has(row.run_id) || seen.has(row.run_id)) continue;
      seen.add(row.run_id);

      // Runs started after this activation began are live, not abandoned.
      if (Date.parse(row.ts) < startedBefore) open.push(row.run_id);
    }

    return open;
  }

  /** Starts with no end row, read at start of life. No clock is consulted: a long call and a dead
   *  process are different facts, and only the missing row is observable. */
  unterminatedModelOperations(window = 500): Array<Extract<RunEvent, { type: 'model_operation' }>> {
    this.actor.assertCurrent();

    const rows = this.sql<{ payload: string }>`
      SELECT payload FROM run_events
      WHERE actor_id = ${this.actorId} AND type = ${'model_operation' satisfies RunEventType}
      ORDER BY ts DESC, rowid DESC LIMIT ${window}`;

    const events = rows.map((row) => parseStoredRunEvent(row.payload))
      .flatMap((event) => event.type === 'model_operation' ? [event] : []);

    const ended = new Set(
      events.filter((event) => event.phase === 'end').map((event) => event.operationId),
    );

    return events.filter((event) => event.phase === 'start' && !ended.has(event.operationId));
  }

  /**
   * The latest run's end (null if unsealed, never success) and the person's newest words: `turnAuthor` of a run's
   * recorded turn, so no harness run or turn-less row. Excludes WORKSPACE_RUN_ID.
   */
  latestRunHeader(): { status: string | null; userMessage: string | null } | null {
    this.actor.assertCurrent();

    const latest = this.sql<{ run_id: string }>`
      SELECT run_id FROM run_events
      WHERE actor_id = ${this.actorId} AND run_id != ${WORKSPACE_RUN_ID}
      ORDER BY rowid DESC LIMIT 1`;

    const runId = latest[0]?.run_id;

    if (runId === undefined) return null;

    const [end] = this.sql<{ payload: string }>`
      SELECT payload FROM run_events
      WHERE actor_id = ${this.actorId} AND run_id = ${runId} AND type = ${'run_end'}
      ORDER BY event_index DESC LIMIT 1`;

    const sealed = end === undefined ? null : parseStoredRunEvent(end.payload);

    return { status: sealed?.type === 'run_end' ? sealed.reason ?? null : null, userMessage: this.operatorWords() };
  }

  private operatorWords(window = 50): string | null {
    const starts = this.sql<{ payload: string }>`
      SELECT payload FROM run_events
      WHERE actor_id = ${this.actorId} AND type = ${'run_start'}
      ORDER BY ts DESC, rowid DESC LIMIT ${window}`;

    for (const row of starts) {
      const start = parseStoredRunEvent(row.payload);

      if (start.type !== 'run_start' || start.turn === undefined) continue;

      if (turnAuthor({ id: start.turn.turnId, metadata: start.turn.metadata }) === 'operator') return start.userMessage ?? null;
    }

    return null;
  }

  /** Auto-GEPA's durable denominator. Rows without `workMode` count nothing; a turn in the same
   *  millisecond as `sinceTs` counts as before, so a re-driven pass does not recount. */
  completedWorkTurns(sinceTs: string | null): number {
    this.actor.assertCurrent();

    const rows = this.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM run_events
      WHERE actor_id = ${this.actorId} AND type = ${'turn_end' satisfies RunEventType}
        AND (${sinceTs} IS NULL OR ts > ${sinceTs})
        AND json_extract(payload, '$.workMode') != 'plan'`;

    return rows[0]?.n ?? 0;
  }

  /** No live caller; SSE resume goes through `getRunEventsWire`. */
  readSince(runId: string, afterIndex: number, limit = RUN_EVENT_LIMIT_MAX): RunEvent[] {
    this.actor.assertCurrent();
    const capped = boundedInt(limit, RUN_EVENT_LIMIT_MAX, 1, Number.MAX_SAFE_INTEGER);

    const rows = this.sql<{ payload: string }>`
      SELECT payload FROM run_events
      WHERE actor_id = ${this.actorId} AND run_id = ${runId} AND event_index > ${afterIndex}
      ORDER BY event_index ASC
      LIMIT ${capped}`;

    return rows.map((r) => parseStoredRunEvent(r.payload));
  }

  /** Per-step durable output, so a run killed before the backend's per-turn write is recoverable.
   *  Pairing is complete within each row, so concatenation needs no repair. */
  transcript(runId: string): ModelMessage[] {
    this.actor.assertCurrent();

    const rows = this.sql<{ payload: string }>`
      SELECT payload FROM run_events
      WHERE actor_id = ${this.actorId} AND run_id = ${runId} AND type = ${'step_finish' satisfies RunEventType}
      ORDER BY event_index ASC`;

    return rows.flatMap((r) => {
      const event = parseStoredRunEvent(r.payload);

      return event.type === 'step_finish' ? decodeModelMessageValues(event.messages ?? []) : [];
    });
  }

  /** The open turn (no `run_end`) with its completed steps and newest unfinished partial. Runs
   *  without a turn identity are not turns and are not answered. */
  openTurn(): {
    readonly runId: string;
    readonly turn: OpenTurnIdentity;
    readonly steps: ModelMessage[];
    readonly partial: Extract<RunEvent, { type: 'step_partial' }> | null;
  } | null {
    this.actor.assertCurrent();

    const rows = this.sql<{ run_id: string; payload: string }>`
      SELECT run_id, payload FROM run_events
      WHERE actor_id = ${this.actorId} AND type = ${'run_start' satisfies RunEventType}
        AND run_id NOT IN (
          SELECT run_id FROM run_events
          WHERE actor_id = ${this.actorId} AND type = ${'run_end' satisfies RunEventType})
      ORDER BY ts DESC, rowid DESC LIMIT 1`;

    const row = rows[0];

    if (row === undefined) return null;
    // An unparseable start row propagates; a start row without a turn identity is a side lane,
    // passed over (the wake reconcile seals it).
    const start = parseStoredRunEvent(row.payload);

    if (start.type !== 'run_start' || start.turn === undefined) {
      diagnostics.event('run.open_without_turn', { run: row.run_id });

      return null;
    }

    const steps = this.transcript(row.run_id);

    const finishedSteps = this.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM run_events
      WHERE actor_id = ${this.actorId} AND run_id = ${row.run_id} AND type = ${'step_finish' satisfies RunEventType}`[0]?.n ?? 0;

    const partials = this.sql<{ payload: string }>`
      SELECT payload FROM run_events
      WHERE actor_id = ${this.actorId} AND run_id = ${row.run_id} AND type = ${'step_partial' satisfies RunEventType}
      ORDER BY event_index DESC LIMIT 1`;

    const newest = partials[0] === undefined ? null : parseStoredRunEvent(partials[0].payload);
    const partial = newest !== null && newest.type === 'step_partial' && newest.stepIndex > finishedSteps ? newest : null;

    return { runId: row.run_id, turn: start.turn, steps, partial };
  }

  /** Filtered in SQL so `limit` is a real bound. Ties on `ts` break by rowid: `event_index`
   *  restarts per run and is meaningless across runs. */
  readRecentByType(type: RunEventType, limit = RUN_EVENT_LIMIT_DEFAULT): RunEvent[] {
    this.actor.assertCurrent();
    const capped = boundedInt(limit, RUN_EVENT_LIMIT_DEFAULT, 1, Number.MAX_SAFE_INTEGER);

    const rows = this.sql<{ payload: string }>`
      SELECT payload FROM run_events
      WHERE actor_id = ${this.actorId} AND type = ${type}
      ORDER BY ts DESC, rowid DESC
      LIMIT ${capped}`;

    return rows.map((r) => parseStoredRunEvent(r.payload)).reverse();
  }

  /**
   * Whole-log spend per producer, summed in SQL (not a sample). `step_finish` files under `agent`;
   * `model_operation` is excluded to avoid double counting. No run or actor filter: spend is a
   * workspace question, including hired actors and WORKSPACE_RUN_ID. NULL sums stay absent, and
   * `floorPricedCalls` counts the producer's `usdFloorTokens` marker rather than re-pricing.
   */
  spendByProducer(stepSources: readonly StepSpendSource[] = []): ReadonlyMap<SpendSource, SpendTally> {
    this.actor.assertCurrent();

    const rows = this.sql<SpendAggregateRow>`
      WITH step_source AS (
        SELECT json_extract(value, '$.actorId') AS actor_id,
               json_extract(value, '$.source') AS source,
               json_extract(value, '$.coveredSince') AS covered_since
        FROM json_each(${JSON.stringify(stepSources)})
      ), call AS (
        SELECT CASE type
                 WHEN ${'step_finish' satisfies RunEventType} THEN COALESCE(step_source.source, ${'agent' satisfies SpendSource})
                 ELSE json_extract(payload, '$.source')
               END AS source,
               json_extract(payload, '$.usage') AS usage,
               json_extract(payload, '$.usd') AS usd,
               json_extract(payload, '$.usdFloorTokens') AS usdFloorTokens,
               run_events.actor_id AS actor_id,
               type = ${'step_finish' satisfies RunEventType}
                 AND step_source.covered_since IS NOT NULL AND ts >= step_source.covered_since AS covered
        FROM run_events LEFT JOIN step_source ON step_source.actor_id = run_events.actor_id
        WHERE (type = ${'step_finish' satisfies RunEventType}
           OR type = ${'model_call' satisfies RunEventType})
      ),
      field AS (
        SELECT source, usd, usdFloorTokens, actor_id, covered,
               json_extract(usage, '$.input') AS input,
               json_extract(usage, '$.output') AS output,
               json_extract(usage, '$.cacheRead') AS cacheRead,
               json_extract(usage, '$.cacheWrite') AS cacheWrite,
               json_extract(usage, '$.cacheWrite1h') AS cacheWrite1h,
               json_extract(usage, '$.reasoning') AS reasoning,
               json_extract(usage, '$.neurons') AS neurons
        FROM call
      ),
      measured AS (
        SELECT *, COALESCE(input, output, cacheRead, cacheWrite, cacheWrite1h,
                           reasoning, neurons) IS NOT NULL AS reported
        FROM field
      )
      SELECT source,
             SUM(CASE WHEN covered THEN 0 ELSE 1 END) AS calls,
             SUM(CASE WHEN NOT covered AND NOT reported THEN 1 ELSE 0 END) AS callsWithoutUsage,
             SUM(CASE WHEN NOT covered AND reported AND usd IS NULL THEN 1 ELSE 0 END) AS unpricedCalls,
             -- Aggregated from the row, never re-derived here: see the docblock.
             SUM(CASE WHEN NOT covered AND reported AND usdFloorTokens IS NOT NULL THEN 1 ELSE 0 END)
               + COUNT(DISTINCT CASE WHEN covered AND reported AND usdFloorTokens IS NOT NULL THEN actor_id END) AS floorPricedCalls,
             SUM(CASE WHEN reported THEN usd END) AS usd,
             SUM(CASE WHEN NOT covered THEN input END) AS input,
             SUM(CASE WHEN NOT covered THEN output END) AS output,
             SUM(CASE WHEN NOT covered THEN cacheRead END) AS cacheRead,
             SUM(CASE WHEN NOT covered THEN cacheWrite END) AS cacheWrite,
             SUM(CASE WHEN NOT covered THEN cacheWrite1h END) AS cacheWrite1h,
             SUM(CASE WHEN NOT covered THEN reasoning END) AS reasoning,
             SUM(CASE WHEN NOT covered THEN neurons END) AS neurons
      FROM measured
      GROUP BY source`;

    const byProducer = new Map<SpendSource, SpendTally>();

    for (const row of rows) {
      const source = SPEND_SOURCES.find((known) => known === row.source);

      if (source === undefined) {
        // Only a corrupt row can reach here; report it rather than drop it from the total.
        diagnostics.failure(
          'event.spend_source_unknown',
          toKinuError({
            doing: 'attributing a stored model call to a producer',
            cause: `source ${JSON.stringify(row.source)} is not one of ${SPEND_SOURCES.join(', ')}`,
            otherwise: 'bad_input',
          }),
          { calls: row.calls },
        );
        continue;
      }

      byProducer.set(source, spendTallyOf(row));
    }

    return byProducer;
  }

  observe(listener: RunEventListener): () => void {
    this.listeners.add(listener);

    return () => { this.listeners.delete(listener); };
  }

  count(runId: string): number {
    this.actor.assertCurrent();

    const rows = this.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM run_events WHERE actor_id = ${this.actorId} AND run_id = ${runId}`;

    return rows[0]?.n ?? 0;
  }

  /**
   * Ordered by MAX(rowid), not MAX(ts): `ts` ties within a clock tick left page membership
   * undefined. WORKSPACE_RUN_ID is excluded here only (WHERE, so page anchors are unaffected);
   * `unit-run-events.test.ts` pins it.
   */
  listRunsBefore(before: number | null, count: number): RunListEntry[] {
    this.actor.assertCurrent();
    const capped = boundedInt(count, RUN_EVENT_LIMIT_DEFAULT, 1, Number.MAX_SAFE_INTEGER);

    return this.sql<RunListEntry>`
      SELECT run_id AS runId, MAX(ts) AS lastTs, COUNT(*) AS eventCount
      FROM run_events
      WHERE actor_id = ${this.actorId} AND run_id != ${WORKSPACE_RUN_ID}
      GROUP BY run_id
      HAVING ${before} IS NULL OR MAX(rowid) < ${before}
      ORDER BY MAX(rowid) DESC
      LIMIT ${capped}`;
  }

  /** Null when the log no longer holds the run, so a vanished anchor raises. */
  runSeq(runId: string): number | null {
    this.actor.assertCurrent();

    const rows = this.sql<{ seq: number | null }>`
      SELECT MAX(rowid) AS seq FROM run_events WHERE actor_id = ${this.actorId} AND run_id = ${runId}`;

    return rows[0]?.seq ?? null;
  }
}

/** Shared by both backends. `runId` is read per event since an operation can outlive its turn.
 *  A failed write is reported and swallowed so instrumentation never blocks the call. */
export function recordModelOperations(
  recorder: { emit(runId: string, input: RunEventInput): void },
  runId: () => string,
): ModelOperationSink {
  return (event) => {
    try {
      recorder.emit(runId(), { type: 'model_operation', ...event });
    } catch (err) {
      diagnostics.failure(
        'event.model_operation_emit_failed',
        toKinuError({ doing: 'recording a model_operation run event', cause: err, otherwise: 'io' }),
        { operationId: event.operationId, phase: event.phase, source: event.source },
      );
    }
  };
}
