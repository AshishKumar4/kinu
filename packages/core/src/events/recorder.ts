/**
 * RunEventRecorder — durable per-agent event log.
 *
 * Holds an in-memory event index per runId for fast monotonic assignment,
 * persists every event to the run_events table, and exposes:
 *   • emit(runId, ev)            — record one event
 *   • read(runId, opts?)         — paginated query
 *   • readSince(runId, sinceIdx) — replay tail (for SSE Last-Event-ID)
 *
 * Subscribers can hook in via observe(fn) for live streaming (SSE) — the
 * recorder fans out synchronously after persisting to SQLite.
 */

import * as v from 'valibot';
import { modelMessageSchema, type ModelMessage } from 'ai';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import type { RunEvent, RunEventInput, RunEventType } from './types';
import { JsonValueSchema } from '../utils/json';
import { boundedInt, boundPageQuery } from '../utils/bounds';
import { USAGE_FIELDS, UsageSchema, type Usage } from '../usage';
import { ESCALATION_OUTCOMES } from '../execution/escalation';
import {
  SPEND_SOURCES, WORKSPACE_RUN_ID,
  MODEL_OPERATION_KINDS, MODEL_OPERATION_PHASES, MODEL_OPERATION_OUTCOMES,
  type ModelOperationSink, type SpendSource, type SpendTally,
} from './model-call';
import { diagnostics, toKinuError } from '../obs/index';

/** A stored model message, validated by the AI SDK's OWN schema rather than a
 *  hand-written copy of its part unions — the same predicate the compaction
 *  codec narrows native handles with (compaction/src/codec.ts:634-639). */
const StoredModelMessageSchema: v.GenericSchema<ModelMessage> =
  v.custom<ModelMessage>((value) => modelMessageSchema.safeParse(value).success);

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
  })),
});
/**
 * The canonical run-event union, as valibot.
 *
 * Exported for the SAME reason {@link parseStoredRunEvent} is: a reader outside
 * this class must parse through this declaration rather than re-declare event
 * shapes. Two entry points, one schema — `parseStoredRunEvent` for a stored
 * `payload` string, this for a value that arrived already decoded, which is what
 * a caller reading `getRunEvents` over RPC holds. Re-serialising such a value
 * just to reach the string entry point would allocate a round trip to satisfy a
 * signature, and re-declaring the union beside the caller is the drift this
 * comment has always been about.
 */
export const RunEventSchema = v.variant('type', [
  v.object({ ...BaseFields, type: v.literal('run_start'), agentId: v.string(),
    userMessage: v.optional(v.string()), caused_by: v.optional(v.string()),
    ingress_kind: v.optional(v.string()), trigger_id: v.optional(v.string()) }),
  v.object({ ...BaseFields, type: v.literal('turn_start'), turnIndex: v.number() }),
  v.object({ ...BaseFields, type: v.literal('tool_call_end'), name: v.string(),
    toolCallId: v.string(), args: v.optional(JsonValueSchema),
    result: v.optional(JsonValueSchema), error: v.optional(v.string()),
    durationMs: v.optional(v.number()) }),
  v.object({ ...BaseFields, type: v.literal('step_finish'), stepIndex: v.number(),
    reason: v.optional(v.string()), messages: v.optional(v.array(StoredModelMessageSchema)),
    usage: v.optional(UsageSchema), usd: v.optional(v.number()),
    modelId: v.optional(v.string()), context: v.optional(ContextCompositionSchema) }),
  v.object({ ...BaseFields, type: v.literal('model_call'),
    source: v.picklist(SPEND_SOURCES), usage: v.optional(UsageSchema),
    usd: v.optional(v.number()), spec: v.optional(v.string()),
    modelId: v.optional(v.string()) }),
  v.object({ ...BaseFields, type: v.literal('model_operation'),
    operationId: v.string(), source: v.picklist(SPEND_SOURCES),
    op: v.picklist(MODEL_OPERATION_KINDS), phase: v.picklist(MODEL_OPERATION_PHASES),
    outcome: v.optional(v.picklist(MODEL_OPERATION_OUTCOMES)),
    usage: v.optional(UsageSchema), spec: v.optional(v.string()),
    modelId: v.optional(v.string()), error: v.optional(v.string()) }),
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
  v.object({ ...BaseFields, type: v.literal('context_budget'), admittedChars: v.number(),
    omittedChars: v.number(), trips: v.object({
      run: v.optional(v.number()), file_read: v.optional(v.number()), web_fetch: v.optional(v.number()),
      execute_tools: v.optional(v.number()), external_tool: v.optional(v.number()),
      attachment: v.optional(v.number()), pasted_text: v.optional(v.number()),
    }), referenced: v.number(), tightened: v.number(), followUps: v.number() }),
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
    // The picklist IS the exported constant, so an outcome a producer can write
    // is never one this parser would reject.
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

function stampRunEvent<Input extends RunEventInput>(input: Input, eventIndex: number, runId: string) {
  return { ...input, eventIndex, runId, timestamp: new Date().toISOString() };
}

/** Validate one stored `run_events.payload` against the canonical union. The
 *  single place a persisted event becomes a typed one — exported so readers
 *  outside this class parse through it rather than re-declaring event shapes. */
export function parseStoredRunEvent(payload: string): RunEvent {
  return v.parse(RunEventSchema, JSON.parse(payload));
}

export interface RunEventQuery {
  /** Inclusive lower bound on eventIndex. */
  since?: number;
  /** Inclusive upper bound on eventIndex. */
  until?: number;
  /** Filter to a subset of event types. */
  types?: readonly RunEventType[];
  /** Maximum rows to return. Closed by {@link boundRunEventQuery} to
   *  [1, {@link RUN_EVENT_LIMIT_MAX}], defaulting to
   *  {@link RUN_EVENT_LIMIT_DEFAULT}. */
  limit?: number;
}

/** A run-event query whose numeric bounds have been closed — the only shape an
 *  untrusted caller's query may take once it crosses the object boundary. */
export interface BoundedRunEventQuery extends RunEventQuery {
  since: number;
  limit: number;
}

/** Rows one run-event read returns when the caller states no usable limit. */
export const RUN_EVENT_LIMIT_DEFAULT = 200;

/**
 * The ceiling on a read an UNTRUSTED caller asked for — the bound the HTTP route
 * already enforced, applied by {@link boundRunEventQuery} so the route is no
 * longer the only place it holds.
 *
 * It is NOT the recorder's ceiling. An in-object read-model states its own
 * window because it folds an answer out of the whole of it — `getRunSummaries`
 * sums a run's usage and prints the total as the workspace's spend, so a window
 * silently narrowed to a stranger's allowance would be a truncated denominator
 * presented as a settled figure.
 */
export const RUN_EVENT_LIMIT_MAX = 500;

/**
 * Close an untrusted caller's run-event bounds before they cross the object
 * boundary: `limit` becomes a finite integer in [1, {@link RUN_EVENT_LIMIT_MAX}]
 * and `since` a finite non-negative integer, whatever the caller passed.
 *
 * Absent and non-finite both mean UNSTATED and take the default. A route that
 * forwards `Number('abc')` cannot be told apart from one that asked for nothing,
 * and guessing at the difference is not the boundary's job.
 *
 * Applied by the HTTP route and by {@link getRunEvents}, the read-model every
 * RPC into this log goes through — so a direct RPC gets the same ceiling as a
 * request that came through the route. {@link RunEventRecorder.read} enforces
 * its own separate invariant on top, for the in-object callers that never reach
 * this function.
 *
 * `boundEventQuery` is this same policy over `agent_log`. Both are one line
 * over {@link boundPageQuery}, so the two logs cannot drift on what a bound
 * MEANS while stating different numbers for how large it is.
 */
export function boundRunEventQuery(opts: RunEventQuery = {}): BoundedRunEventQuery {
  return boundPageQuery(opts, { fallback: RUN_EVENT_LIMIT_DEFAULT, max: RUN_EVENT_LIMIT_MAX });
}

/** One run as the log lists it: which run, when it was last written to, and how
 *  many events it holds. */
export interface RunListEntry {
  runId: string;
  lastTs: string;
  eventCount: number;
}

export type RunEventListener = (event: RunEvent) => void;

export function initRunEventTables(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS run_events (
    run_id TEXT NOT NULL,
    event_index INTEGER NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    ts TEXT NOT NULL,
    PRIMARY KEY (run_id, event_index)
  )`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_run_events_run_ts ON run_events(run_id, ts)`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_run_events_type ON run_events(type)`);
}

/**
 * One producer's row as SQL summed it, before absence is restored.
 *
 * The usage columns are `Record<keyof Usage, …>` rather than a list of names,
 * so a field added to {@link Usage} widens this row and {@link spendTallyOf}
 * reads it without a second list to keep in step. What the SQL cannot type is
 * that it SELECTed all seven aliases; `unit-run-events.test.ts` seeds a call
 * carrying every field and asserts the aggregate reports each one, which is what
 * makes a forgotten column fail loudly instead of reading as an absent count.
 *
 * `source` is `string | null` because the column is whatever the payload held:
 * the picklist is enforced on the way IN, and narrowing on the way out is how a
 * corrupt row gets named rather than silently attributed.
 */
type SpendAggregateRow = Readonly<Record<keyof Usage, number | null>> & {
  readonly source: string | null;
  readonly calls: number;
  readonly callsWithoutUsage: number;
  readonly unpricedCalls: number;
  readonly usd: number | null;
};

/** Restore absence. SQL says NULL where the fold said undefined: no call in this
 *  group reported the field, which is not the same fact as every call reporting
 *  zero, and only one of the two may be printed as a number. */
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
  };
  return row.usd === null ? tally : { ...tally, usd: row.usd };
}

export class RunEventRecorder {
  // Cached next-index per runId. Loaded lazily from the table on first emit.
  private nextIndex = new Map<string, number>();
  private listeners = new Set<RunEventListener>();

  constructor(private readonly sql: SqlExecutor) {}

  /** Record an event for runId. Returns the assigned monotonic event. */
  emit(runId: string, input: RunEventInput): RunEvent {
    const idx = this.allocateIndex(runId);
    const ev = stampRunEvent(input, idx, runId);
    this.persist(ev);
    for (const l of this.listeners) {
      try { l(ev); } catch (err) {
        diagnostics.failure(
          'event.listener_failed',
          toKinuError({ doing: 'notify a run-event listener', cause: err, otherwise: 'io' }),
          { runId, eventType: ev.type },
        );
      }
    }
    return ev;
  }

  private allocateIndex(runId: string): number {
    const cached = this.nextIndex.get(runId);
    if (cached != null) {
      this.nextIndex.set(runId, cached + 1);
      return cached;
    }
    // Load from DB.
    const rows = this.sql<{ max_idx: number | null }>`
      SELECT MAX(event_index) AS max_idx FROM run_events WHERE run_id = ${runId}`;
    const max = rows[0]?.max_idx ?? -1;
    const next = max + 1;
    this.nextIndex.set(runId, next + 1);
    return next;
  }

  private persist(ev: RunEvent): void {
    void this.sql`INSERT OR REPLACE INTO run_events (run_id, event_index, type, payload, ts)
      VALUES (${ev.runId}, ${ev.eventIndex}, ${ev.type}, ${JSON.stringify(ev)}, ${ev.timestamp})`;
  }

  /**
   * The log's own invariant, applied to EVERY caller including the in-object
   * read-models that never pass through {@link boundRunEventQuery}: only a
   * finite positive integer may reach SQL. SQLite reads `LIMIT -1` as no limit
   * at all — one negative value turns a paged read into a full read, parse and
   * serialize of a run's whole history — and takes a fraction or NaN as a
   * datatype mismatch.
   *
   * No ceiling here, deliberately. The ceiling is a question about how much an
   * UNTRUSTED caller may ask for, which the boundary answers; an in-object fold
   * states the window its answer is correct over and must get it.
   */
  read(runId: string, opts: RunEventQuery = {}): RunEvent[] {
    const limit = boundedInt(opts.limit, RUN_EVENT_LIMIT_DEFAULT, 1, Number.MAX_SAFE_INTEGER);
    const since = boundedInt(opts.since, 0, 0, Number.MAX_SAFE_INTEGER);
    const types = opts.types && opts.types.length > 0 ? new Set<string>(opts.types) : null;

    // Tagged-template SQL can't safely build dynamic IN-clauses across all
    // SqlExecutor implementations (parameter binding is positional). Fetch
    // a window and filter client-side — events are small, and the window is
    // whatever `limit` states, capped at 2000 when a filter widens it.
    const fetchLimit = types ? Math.min(limit * 4, 2000) : limit;
    const rows = this.sql<{ payload: string }>`
      SELECT payload FROM run_events
      WHERE run_id = ${runId} AND event_index >= ${since}
      ORDER BY event_index ASC
      LIMIT ${fetchLimit}`;
    const events = rows.map((r) => parseStoredRunEvent(r.payload));
    if (!types) return events;
    return events.filter((e) => types.has(e.type)).slice(0, limit);
  }

  /**
   * The run that recorded this fork root's `head_split`, or null.
   *
   * A fork outlives the run that dispatched it — that is the normal case, not
   * the exceptional one — so anything settling a fork later has to find its way
   * back to that run. `allocateIndex` reads MAX(event_index) from the table, so
   * appending to a run whose `run_end` was written by a dead activation is
   * ordinary: the index continues where the row left off.
   *
   * Null rather than a guess when no split was recorded (a fork dispatched with
   * no open run, which every benchmark trial does). Attributing a fork's death
   * to an unrelated turn's timeline would be worse than leaving it out.
   *
   * Matched client-side over the `type` index for the same reason {@link read}
   * filters client-side: the match is on ONE field of a bounded window, and
   * `parseStoredRunEvent` has to run over those rows anyway to return a typed
   * event. Pushing the predicate into SQL would buy nothing and would still
   * parse every row it kept.
   *
   * That is a cost argument and no longer a capability one. This method's
   * docstring used to say no production query had ever depended on SQLite's JSON
   * functions being available on both SqlExecutors; {@link spendByProducer} now
   * does, deliberately, and `tests/workerd/do-spend-aggregate.test.ts` runs it on
   * real Durable Object SQLite so the claim is measured rather than assumed.
   */
  runForHeadSplit(rootId: string, window = 500): string | null {
    const rows = this.sql<{ run_id: string; payload: string }>`
      SELECT run_id, payload FROM run_events
      WHERE type = 'head_split'
      ORDER BY ts DESC LIMIT ${window}`;
    for (const row of rows) {
      const ev = parseStoredRunEvent(row.payload);
      if (ev.type === 'head_split' && ev.rootId === rootId) return row.run_id;
    }
    return null;
  }

  /**
   * Runs this ledger opened and never closed — a `run_start` with no `run_end`.
   *
   * WHAT AN UNTERMINATED RUN IS. A run is closed by `closeTurnRun`, which runs
   * in the turn's own frame; nothing writes a terminal row when the platform
   * destroys that frame. So a Durable Object eviction leaves the row open
   * forever, and the durable ledger cannot then distinguish a turn that is
   * running from one that was killed. Measured on the owner's workspace: six
   * `run_start` rows against three `run_end`, including the turn that dispatched
   * the swarm this whole reconciliation is about.
   *
   * The same argument the fork journal makes about a `running` head applies here
   * and is why this is a start-of-life read: an activation that has just started
   * is executing none of these, so every one of them was left by an earlier one.
   *
   * Newest first, bounded, and paired client-side over the `type` index for the
   * reason {@link read} gives: the pairing is over a bounded window whose rows a
   * caller reads anyway.
   */
  unterminatedRuns(window = 500, startedBefore = Number.POSITIVE_INFINITY): string[] {
    const rows = this.sql<{ run_id: string; type: string; ts: string }>`
      SELECT run_id, type, ts FROM run_events
      WHERE type = 'run_start' OR type = 'run_end'
      ORDER BY ts DESC LIMIT ${window}`;
    const closed = new Set(rows.filter((row) => row.type === 'run_end').map((row) => row.run_id));
    const open: string[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (row.type !== 'run_start' || closed.has(row.run_id) || seen.has(row.run_id)) continue;
      seen.add(row.run_id);
      // The ACTIVATION CUTOFF: the caller that closes these no longer runs at
      // start of life, so a run a live request started after the activation
      // began must not read as abandoned.
      if (Date.parse(row.ts) < startedBefore) open.push(row.run_id);
    }
    return open;
  }

  /**
   * Model operations this ledger opened and never closed — a `model_operation`
   * start whose `operationId` reaches no end row.
   *
   * WHAT AN UNTERMINATED OPERATION IS, and it is the same argument
   * {@link unterminatedRuns} makes one level down. An end row is written in the
   * calling frame, so nothing writes one when the platform destroys that frame:
   * a Durable Object eviction, a killed `bun test`, an operator interrupt. The
   * start row is therefore the only evidence of what the dead activation was
   * doing, and this is how it is read back.
   *
   * A start-of-life read, for the reason `unterminatedRuns` gives: an activation
   * that has just started is running none of these, so every one it finds was
   * left by an earlier one. NOTHING here consults a clock. An operation is open
   * because no end row exists, never because one has been open "too long" —
   * a long call and a dead process are different facts, and only one of them is
   * observable from this table.
   *
   * Newest first, bounded, paired client-side over the `type` index for the
   * reason {@link read} gives: every row it keeps is returned as a typed event,
   * so it is parsed either way.
   */
  unterminatedModelOperations(window = 500): Array<Extract<RunEvent, { type: 'model_operation' }>> {
    const rows = this.sql<{ payload: string }>`
      SELECT payload FROM run_events
      WHERE type = ${'model_operation' satisfies RunEventType}
      ORDER BY ts DESC, rowid DESC LIMIT ${window}`;
    const events = rows.map((row) => parseStoredRunEvent(row.payload))
      .flatMap((event) => event.type === 'model_operation' ? [event] : []);
    const ended = new Set(
      events.filter((event) => event.phase === 'end').map((event) => event.operationId),
    );
    return events.filter((event) => event.phase === 'start' && !ended.has(event.operationId));
  }

  /**
   * Completed non-plan turns across ALL runs, strictly after an ISO boundary —
   * the auto-GEPA cadence's durable denominator.
   *
   * This is a SOURCE QUERY, not a counter: the count lives in these rows, so
   * it survives every activation loss that the log survives. `sinceTs` is the
   * timestamp of whatever marks the last GEPA pass (null = count everything).
   * A row without `workMode` predates the field and counts nothing: the
   * denominator starts at the cutover rather than inventing history, and
   * `json_extract` returning NULL for those rows is what makes absence read
   * as "before it started", never as build. Timestamps are millisecond ISO,
   * and a turn stamped in the SAME millisecond as the boundary is excluded —
   * a tie reads as "before", which keeps a re-driven pass from recounting.
   */
  completedWorkTurns(sinceTs: string | null): number {
    const rows = this.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM run_events
      WHERE type = ${'turn_end' satisfies RunEventType}
        AND (${sinceTs} IS NULL OR ts > ${sinceTs})
        AND json_extract(payload, '$.workMode') != 'plan'`;
    return rows[0]?.n ?? 0;
  }

  /** Replay all events strictly after `afterIndex` — for SSE Last-Event-ID resume. */
  readSince(runId: string, afterIndex: number, limit = 500): RunEvent[] {
    const rows = this.sql<{ payload: string }>`
      SELECT payload FROM run_events
      WHERE run_id = ${runId} AND event_index > ${afterIndex}
      ORDER BY event_index ASC
      LIMIT ${limit}`;
    return rows.map((r) => parseStoredRunEvent(r.payload));
  }

  /**
   * The model messages a run's completed steps recorded, in step order.
   *
   * The read side of per-step durability: `step_finish.messages` is appended as
   * each step finishes, so this returns the model's actual output for a run
   * whose turn never reached its backend's once-per-turn message write — a
   * process kill, a DO eviction, a provider throw. Concatenating the rows is
   * enough: pairing is complete inside each row (the SDK reports a step's
   * tool-call parts with their results), so the result assembles into a request
   * without repair.
   *
   * Ordered by `event_index`, which is monotonic per run — the same ordering
   * `read` returns, and the order the steps ran in.
   */
  transcript(runId: string): ModelMessage[] {
    const rows = this.sql<{ payload: string }>`
      SELECT payload FROM run_events
      WHERE run_id = ${runId} AND type = ${'step_finish' satisfies RunEventType}
      ORDER BY event_index ASC`;
    return rows.flatMap((r) => {
      const event = parseStoredRunEvent(r.payload);
      return event.type === 'step_finish' ? event.messages ?? [] : [];
    });
  }

  /**
   * The most recent events of ONE type, across every run, oldest first.
   *
   * This is the retained sample behind the step telemetry: `run_events` is
   * already durable and already indexed by type, so a percentile over recent
   * steps needs no ring buffer and no roll-up table. A single-value equality
   * binds cleanly across every SqlExecutor (unlike `read`'s IN-clause), so the
   * filter runs in SQL and `limit` is a real bound rather than a post-filter
   * slice that can come back short.
   *
   * Ties on `ts` break by rowid — insertion order. `event_index` restarts at 0
   * for every run and is therefore meaningless across runs; using it here put
   * a new run's first step before an old run's last one whenever both landed
   * in the same millisecond.
   */
  readRecentByType(type: RunEventType, limit = 200): RunEvent[] {
    const rows = this.sql<{ payload: string }>`
      SELECT payload FROM run_events
      WHERE type = ${type}
      ORDER BY ts DESC, rowid DESC
      LIMIT ${limit}`;
    return rows.map((r) => parseStoredRunEvent(r.payload)).reverse();
  }

  /**
   * What every model call in the log cost, summed per producer — the WHOLE log.
   *
   * NOT A SAMPLE, and that is the point. {@link readRecentByType} above is the
   * retained sample a percentile needs; a TOTAL read the same way is a floor
   * presented as a measurement, and the ceiling was invisible on the surface
   * that rendered it. A sum is what SQL is for, so the sum happens in SQL over
   * every row and no window bounds it. `spend`'s producer rows are complete
   * however long the log grows; the step telemetry beside them stays windowed,
   * because a cache-hit percentile over the whole of history is not the question
   * anyone asked.
   *
   * TWO ROW KINDS, ONE GROUPING. `step_finish` is the turn loop and is filed
   * under `agent`; every other producer writes `model_call` and names itself.
   * That mapping is the same one the read model applied when it folded these
   * rows by hand, and it lives in the CASE so one pass over the table answers
   * for both. `model_operation` is deliberately absent: it mirrors the same
   * calls for lifecycle purposes, and counting it would double every direct
   * call. No run filter, for the reason `readRecentByType` has none — spend is a
   * workspace question, and a call made between runs is filed under
   * {@link WORKSPACE_RUN_ID} and belongs in the total.
   *
   * THREE PARSES PER ROW, NOT NINE. `payload` is opaque TEXT, so each field
   * costs a JSON walk of the whole row — and a `step_finish` payload carries the
   * step's messages, which makes it the expensive kind. The `call` CTE therefore
   * lifts `$.usage` out ONCE per row and `field` splits that small object, so the
   * seven counts cost seven walks of a usage object rather than seven of a
   * transcript. It is still strictly cheaper than the read it replaces, which
   * ran `JSON.parse` plus a valibot validation of the entire union per row.
   *
   * Reported absences survive the sum: `SUM` skips NULLs and returns NULL when
   * every row was NULL, which is exactly "no call reported this field" and is
   * why {@link spendTallyOf} maps NULL to absent rather than to 0. `usd` is
   * summed only over calls that reported usage, matching the fold this replaced —
   * a call the provider said nothing for cannot be priced either, and is already
   * counted as unmeasured.
   */
  spendByProducer(): ReadonlyMap<SpendSource, SpendTally> {
    const rows = this.sql<SpendAggregateRow>`
      WITH call AS (
        SELECT CASE type
                 WHEN ${'step_finish' satisfies RunEventType} THEN ${'agent' satisfies SpendSource}
                 ELSE json_extract(payload, '$.source')
               END AS source,
               json_extract(payload, '$.usage') AS usage,
               json_extract(payload, '$.usd') AS usd
        FROM run_events
        WHERE type = ${'step_finish' satisfies RunEventType}
           OR type = ${'model_call' satisfies RunEventType}
      ),
      field AS (
        SELECT source, usd,
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
             COUNT(*) AS calls,
             SUM(CASE WHEN reported THEN 0 ELSE 1 END) AS callsWithoutUsage,
             SUM(CASE WHEN reported AND usd IS NULL THEN 1 ELSE 0 END) AS unpricedCalls,
             SUM(CASE WHEN reported THEN usd END) AS usd,
             SUM(input) AS input, SUM(output) AS output, SUM(cacheRead) AS cacheRead,
             SUM(cacheWrite) AS cacheWrite, SUM(cacheWrite1h) AS cacheWrite1h,
             SUM(reasoning) AS reasoning, SUM(neurons) AS neurons
      FROM measured
      GROUP BY source`;
    const byProducer = new Map<SpendSource, SpendTally>();
    for (const row of rows) {
      const source = SPEND_SOURCES.find((known) => known === row.source);
      if (source === undefined) {
        // Unwritable through this recorder: `RunEventSchema` validates `source`
        // against the same picklist on the way in. So a row here is a corrupt
        // one, and it says so rather than vanishing from a total silently.
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

  /** Subscribe to future events; returns an unsubscribe function. */
  observe(listener: RunEventListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Total event count for a run. */
  count(runId: string): number {
    const rows = this.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM run_events WHERE run_id = ${runId}`;
    return rows[0]?.n ?? 0;
  }

  /**
   * One batch of runs, newest first — the run most recently written to leading.
   *
   * Ordered by MAX(rowid), NOT MAX(ts). `ts` is TEXT (see the DDL above) and a
   * turn writes several rows inside one clock tick, so `ORDER BY MAX(ts) DESC`
   * with no tiebreak had no defined MEMBERSHIP when two runs' latest events
   * share a tick — not merely an undefined order between them, but no answer to
   * which one the window contains. rowid is total and is the write order, so
   * for an append-only log this is the "latest event first" that ordering was
   * reaching for, now decidable. `lastTs` is still returned: it is what a
   * surface shows.
   *
   * `before` bounds the scan strictly below a position from {@link runSeq};
   * null starts at the newest. This is the storage half only — the page fold
   * belongs to `read-models/runs.ts`, which owns the contract.
   *
   * {@link WORKSPACE_RUN_ID} is excluded here and only here: it is not a run,
   * it is where a model call that happened between runs is filed, so a run list
   * that showed it would invent a run the agent never had. Every other reader is
   * keyed by an explicit runId and therefore never sees it by accident; the
   * workspace spend read-model asks for it on purpose. The exclusion is a WHERE
   * rather than a HAVING so the pseudo-run's rows never reach the grouping —
   * which is also why it cannot perturb a page anchor: `MAX(rowid)` per real run
   * is computed from that run's own rows either way.
   *
   * Dropping that clause while keeping this signature breaks no type and passes
   * every gate. Its only symptom is a fabricated run at the top of the owner's
   * history, which is why `unit-run-events.test.ts` pins both halves together.
   */
  listRunsBefore(before: number | null, count: number): RunListEntry[] {
    return this.sql<RunListEntry>`
      SELECT run_id AS runId, MAX(ts) AS lastTs, COUNT(*) AS eventCount
      FROM run_events
      WHERE run_id != ${WORKSPACE_RUN_ID}
      GROUP BY run_id
      HAVING ${before} IS NULL OR MAX(rowid) < ${before}
      ORDER BY MAX(rowid) DESC
      LIMIT ${count}`;
  }

  /** Where a run sits in the log's write order, or null when the log no longer
   *  holds it — the resolvable question a page anchor asks, so that a vanished
   *  run raises instead of reading as an exhausted history. */
  runSeq(runId: string): number | null {
    const rows = this.sql<{ seq: number | null }>`
      SELECT MAX(rowid) AS seq FROM run_events WHERE run_id = ${runId}`;
    return rows[0]?.seq ?? null;
  }
}

/**
 * Project one seam's model-operation lifecycle onto this durable log.
 *
 * Shared rather than written per backend for the reason the scaffold-control
 * seam gives about its own two copies: two hand-written mappers of one row
 * drift, and the drift is silent because each backend's tests only ever see its
 * own. One mapper, both backends, one row shape.
 *
 * `runId` is read per event rather than captured, because an operation can open
 * inside a turn and close after it: the evolution lanes fire between runs on
 * purpose (a pass on a fiber, a title before the first turn exists), which is
 * what {@link WORKSPACE_RUN_ID} is for.
 *
 * A failed write is reported and swallowed. This is instrumentation wrapped
 * around a model call; a ledger fault must not become the reason the call the
 * ledger was watching never happened.
 */
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
