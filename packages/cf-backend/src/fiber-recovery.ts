/**
 * Recovery of interrupted durable lanes (`bg:<kind>`, `mcts`, `evolution:settle`, ...).
 * Arms only classify and hand off to {@link FiberLaneTransports.redrive}: the scan runs inside the DO
 * init gate (`blockConcurrencyWhile`), and awaiting a lane there trips `do.block_concurrency.cancel_ms`,
 * resetting the object into a re-offer loop. `scripts/do-init-gate.ts` enforces this shape.
 */
import * as v from 'valibot';
import type { FiberRecoveryContext, FiberRecoveryResult } from 'agents';

import {
  BACKGROUND_FIBER_PREFIX, BackgroundJobRunner, recoveryBackoffMs,
  projectJsonValue, type JsonValue,
  type SqlExecutor,
  JsonObjectSchema, type AgentSignal, type SendOutcome,
} from '@kinu.run/core';
import { Cause, Effect } from 'effect';
import { diagnostics, KinuError, settleSync, toKinuError } from '@kinu.run/core/obs';

/** Kinu's value for the SDK's `fiberRecoveryMaxAgeMs` (the SDK default); the one place it lives. */
export const FIBER_RECOVERY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Max rows one activation sweep scans; matches the framework's own scan
 * (`patches/agents@0.26.0.patch`). Shared by every row-budgeted sweep here.
 */
const SWEEP_MAX_ROWS = 4096;

/** One metadata row per read, so a read never holds more than one snapshot candidate. */
const ONE_FIBER_ROW = 1;

/** Metadata only: the `snapshot` column is deliberately absent. */
const FiberMetaRowSchema = v.object({
  rowid: v.number(),
  id: v.string(),
  created_at: v.number(),
});

export type FiberMetaRow = v.InferOutput<typeof FiberMetaRowSchema>;

/** Narrow port over `cf_agents_runs`: no method can return a snapshot blob. */
/** Over `cf_agents_runs`, which the SDK's `Agent` constructor creates (agents 0.26 `_ensureSchema`). */
export interface FiberRowStore {
  /** `MAX(rowid)`, read once and then frozen by the caller. */
  upperBoundary(): number | null;
  /** Expired rows in `(after, through]`, oldest rowid first. The cutoff is in the query
   *  because `created_at` does not reliably track rowid. */
  page(after: number, through: number, cutoff: number): readonly FiberMetaRow[];
  /** Delete one row, re-checking expiry at its own id; `false` if a concurrent pass took it. */
  dropIfExpired(id: string, cutoff: number): boolean;
}

/** {@link FiberRowStore} over a Durable Object's own storage. */
export function fiberRowStore(sql: SqlExecutor): FiberRowStore {
  return {
    upperBoundary: () => sql<{ boundary: number | null }>`
      SELECT MAX(rowid) AS boundary FROM cf_agents_runs`[0]?.boundary ?? null,
    page: (after, through, cutoff) => sql<unknown>`
      SELECT rowid, id, created_at FROM cf_agents_runs
      WHERE rowid > ${after} AND rowid <= ${through} AND created_at <= ${cutoff}
      ORDER BY rowid ASC LIMIT ${ONE_FIBER_ROW}`
      .map((row) => v.parse(FiberMetaRowSchema, row)),
    dropIfExpired: (id, cutoff) => sql<{ id: string }>`
      DELETE FROM cf_agents_runs
      WHERE id = ${id} AND created_at <= ${cutoff}
      RETURNING id`.length > 0,
  };
}

export interface FiberSweepResult {
  readonly dropped: number;
  readonly scanned: number;
  readonly truncated: boolean;
}

/**
 * Drop rows past the recovery max age before `Agent._checkRunFibers` materializes every snapshot.
 * The rowid boundary is frozen so fibers started this activation are never swept; deletes
 * revalidate expiry per id; scanning is bounded by {@link SWEEP_MAX_ROWS}, not a stopwatch.
 * Only rows the framework would already skip (`max_age_exceeded`) are dropped.
 */
export function sweepUnrecoverableFibers(
  store: FiberRowStore,
  now: number,
): FiberSweepResult {
  const cutoff = now - FIBER_RECOVERY_MAX_AGE_MS;
  const nothing: FiberSweepResult = { dropped: 0, scanned: 0, truncated: false };

  const boundary = store.upperBoundary();

  if (boundary === null) return nothing;
  let cursor = 0;
  let dropped = 0;
  let scanned = 0;

  for (;;) {
    if (scanned >= SWEEP_MAX_ROWS) {
      return { dropped, scanned, truncated: true };
    }

    const page = store.page(cursor, boundary, cutoff);

    if (page.length === 0) return { dropped, scanned, truncated: false };

    for (const row of page) {
      scanned++;
      cursor = row.rowid;

      if (store.dropIfExpired(row.id, cutoff)) dropped++;
    }
  }
}

export const EVOLUTION_LANE_FIBER = 'evolution:settle';

/** A row only a deploy before the MCP warm left its fiber can hold; dropped, as the warm itself would be. */
const MCP_WARM_LANE_FIBER = 'mcp:warm';

export const TERMINAL_LANE_FIBER = 'terminal:effects';

export const DELEGATION_LANE_FIBER = 'delegation:drain';

/** Fork-journal recovery notice lane: an eviction replays the delivery, not the reconcile;
 *  the signal's idempotency key dedupes a delivery that already landed. */
const FORK_NOTICE_LANE_FIBER = 'fork:notice';

/** Transports an activation re-resolves for itself; the arms stay shared across backends. */
export interface FiberLaneTransports {
  readonly jobs: Pick<BackgroundJobRunner, 'recover' | 'recoverOrphans'>;
  readonly runDueSessionEvolution: () => Promise<void>;
  /** Arm the terminal ledger's durable wake and replay nothing here (a replay may await SMTP). */
  readonly armOwedTerminalRecovery: () => Promise<void>;
  /** Fork-notice replay body. `undelivered` means the notice is still owed. */
  readonly deliverSignal: (signal: AgentSignal) => Promise<SendOutcome>;
  /**
   * Hand a re-drive to a fresh fiber under `lane` holding `checkpoint`. Returns void on purpose:
   * an awaitable re-drive would be back inside the init gate.
   */
  readonly redrive: (lane: string, checkpoint: JsonValue, body: () => Promise<void>) => void;
}

/**
 * Classify one interrupted fiber and hand its work to a carrier. Never throws: the SDK retains a
 * row whose hook throws and re-offers it every activation until max age. Synchronous (init gate);
 * `completed` means the obligation has a carrier, not that the lane finished.
 */
export function classifyRecoveredFiber(
  transports: FiberLaneTransports,
  ctx: FiberRecoveryContext,
): FiberRecoveryResult {
  diagnostics.event('fiber.recovered', { fiber: ctx.name, fiberId: ctx.id });

  return settleSync(Effect.catchCause(Effect.sync((): FiberRecoveryResult => {
    if (ctx.name.startsWith(BACKGROUND_FIBER_PREFIX)) return redriveBackgroundJobLane(transports, ctx);

    // Not `settleEvolution()`: its promises died with the last isolate. `runDueSessionEvolution()`
    // drains the durable queues and is idempotent.
    if (ctx.name === EVOLUTION_LANE_FIBER) {
      return redriveLane(transports, ctx, { name: EVOLUTION_LANE_FIBER, redrive: 'session-evolution' }, () => transports.runDueSessionEvolution());
    }

    if (ctx.name === MCP_WARM_LANE_FIBER) return recoverMcpWarmLane();

    // Its turn claim is re-pended by the wake an owed claim arms.
    if (ctx.name === DELEGATION_LANE_FIBER) return { status: 'completed', snapshot: { lane: DELEGATION_LANE_FIBER, redrive: 'turn-claim' } };

    // Replay nothing in the init gate (it awaits SMTP, peers, models); arm the ledger's own
    // retry wake, whose alarm replays under the claim join.
    if (ctx.name === TERMINAL_LANE_FIBER) {
      return redriveLane(transports, ctx, { name: TERMINAL_LANE_FIBER, redrive: 'terminal-wake' }, () => transports.armOwedTerminalRecovery());
    }

    if (ctx.name === FORK_NOTICE_LANE_FIBER) return redriveForkNoticeLane(transports, ctx);

    return unrecognisedLane(ctx);
  }), (failed) => Effect.sync((): FiberRecoveryResult => {
    const failure = toKinuError({
      doing: `classifying the "${ctx.name}" fiber after eviction`,
      cause: Cause.squash(failed),
      otherwise: 'io',
    });

    diagnostics.failure('fiber.recovery_failed', failure, { fiber: ctx.name, fiberId: ctx.id });

    // Terminal, not rethrown: a retained row would be re-offered every activation until max age.
    return { status: 'error', error: failure.message, snapshot: { lane: ctx.name, recovered: false } };
  })));
}

/** Hands the lane's `body` to a carrier under its own fiber name. */
function redriveLane(
  transports: FiberLaneTransports,
  ctx: FiberRecoveryContext,
  lane: { readonly name: string; readonly redrive: string },
  body: () => Promise<void>,
): FiberRecoveryResult {
  transports.redrive(lane.name, fiberSnapshot(ctx), body);

  return { status: 'completed', snapshot: { lane: lane.name, redrive: lane.redrive } };
}

/**
 * The fiber row proves this job's executor is dead, so a settled job's lost wake is re-delivered.
 * `recoverOrphans` runs too: on cold start no other `running` row can have a live owner.
 */
function redriveBackgroundJobLane(
  transports: FiberLaneTransports,
  ctx: FiberRecoveryContext,
): FiberRecoveryResult {
  const checkpoint = fiberSnapshot(ctx);
  transports.redrive(ctx.name, checkpoint, async () => {
    const redriven = await transports.jobs.recover(checkpoint);
    const inFlight = await transports.jobs.recoverOrphans();
    // A settled job's re-drive is a wake that resolves only when the queued turn ends,
    // so its outcome can only be reported here, not in the classification.
    diagnostics.event('fiber.job_lane_redriven', {
      fiber: ctx.name,
      redriven: redriven?.id ?? '(none)',
      inFlight: inFlight.length,
    });
  });

  return { status: 'completed', snapshot: { lane: ctx.name, redrive: 'background-job' } };
}

/** Replay a minted, unconfirmed notice; the checkpoint is the whole signal. */
function redriveForkNoticeLane(
  transports: FiberLaneTransports,
  ctx: FiberRecoveryContext,
): FiberRecoveryResult {
  const checkpoint = fiberSnapshot(ctx);
  const parsed = v.safeParse(RecoveredSignalSchema, checkpoint);

  if (!parsed.success) {
    return {
      status: 'error',
      error: 'the interrupted notice left no readable signal to deliver: '
        + parsed.issues.map((issue) => issue.message).join('; '),
      snapshot: { lane: FORK_NOTICE_LANE_FIBER, redrive: null },
    };
  }

  const signal = parsed.output;
  dispatchRecoveredNotice(transports, signal, signal.attempts ?? 0);

  return { status: 'completed', snapshot: { lane: FORK_NOTICE_LANE_FIBER, redrive: 'signal-delivery' } };
}

/**
 * Deliver on a fresh carrier, retrying `undelivered` unbounded at a capped pace. `undelivered`
 * means a submitted turn came back aborted/skipped/errored, so an unpaced retry would loop turns.
 */
export function dispatchRecoveredNotice(
  transports: Pick<FiberLaneTransports, 'redrive' | 'deliverSignal'>,
  signal: RecoveredNotice,
  attempts = 0,
): void {
  const checkpoint: JsonValue = { ...signal, attempts };
  transports.redrive(FORK_NOTICE_LANE_FIBER, checkpoint, async () => {
    // Sleep before the attempt, not after the refusal: the checkpoint carries the count,
    // so an eviction mid-backoff would otherwise skip the pace.
    if (attempts > 0) {
      await new Promise((resolve) => { setTimeout(resolve, recoveryBackoffMs(attempts)); });
    }

    if (await transports.deliverSignal(signal) === 'undelivered') {
      diagnostics.event('fiber.notice_redelivery_owed', {
        key: signal.idempotencyKey ?? '(none)', attempts: attempts + 1,
      });
      dispatchRecoveredNotice(transports, signal, attempts + 1);
    }
  });
}

const RecoveredSignalSchema = v.object({
  kind: v.string(),
  text: v.string(),
  idempotencyKey: v.optional(v.string()),
  metadata: v.optional(JsonObjectSchema),
  /** Rides the checkpoint so the backoff survives an eviction mid-retry. */
  attempts: v.optional(v.number()),
});

export type RecoveredNotice = v.InferOutput<typeof RecoveredSignalSchema>;


/**
 * The MCP warm lane has nothing to re-enter: the next turn warms anyway. Named so
 * `classifyRecoveredFiber`'s closed set does not report it as unrecognised.
 */
function recoverMcpWarmLane(): FiberRecoveryResult {
  return { status: 'completed', snapshot: { lane: MCP_WARM_LANE_FIBER, reentered: false } };
}

/** Unknown lane: classified error, logged once, row released; never a MEMORY.md line. */
function unrecognisedLane(ctx: FiberRecoveryContext): FiberRecoveryResult {
  const failure = new KinuError(
    'unsupported',
    `no recovery is defined for the "${ctx.name}" fiber, so the work it was carrying is lost`,
  );

  diagnostics.failure('fiber.recovery_unrecognised', failure, { fiber: ctx.name, fiberId: ctx.id });

  return { status: 'error', error: failure.message, snapshot: { lane: ctx.name, recovered: false } };
}

function fiberSnapshot(ctx: FiberRecoveryContext): JsonValue {
  return ctx.snapshot === null || ctx.snapshot === undefined
    ? null
    : projectJsonValue({ value: ctx.snapshot });
}
