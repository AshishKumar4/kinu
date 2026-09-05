/**
 * The durable lanes' RECOVERY half — what happens to one when the platform
 * interrupted it.
 *
 * An ActorAgent runs four kinds of work through `runFiber`, so each writes a
 * `cf_agents_runs` row with its stashed identity before it runs and each is
 * handed back to {@link classifyRecoveredFiber} on the next activation:
 *
 *   • a detached tool call   (`bg:<kind>`, minted by core's BackgroundJobRunner)
 *   • a search               (`mcts`, minted by core's SEARCH_FIBER_NAME)
 *   • the evolution lane     (`evolution:settle`, started by settleEvolutionInBackground)
 *   • the advisor lane       (`advisor:review`, started by reviewTurnInBackground)
 *
 * That activation needs NO client and NO request: with nothing connected, the
 * persisted keepAlive alarm fires on its own and the SDK's housekeeping runs the
 * interrupted-fiber scan. This module owns the ROSTER and each arm's semantics;
 * the actor owns only the transports the arms re-drive through, declared once in
 * {@link FiberLaneTransports}. The two cf-minted lane names live here beside the
 * dispatch that matches them — `BACKGROUND_FIBER_PREFIX` and `SEARCH_FIBER_NAME`
 * stay in core, because there core mints and this backend matches.
 *
 * ## Every arm CLASSIFIES. No arm re-drives here
 *
 * The scan that offers these rows runs INSIDE the Durable Object's init gate:
 * `fetch`, `webSocketMessage`, `webSocketClose` and `alarm` all await
 * partyserver's `blockConcurrencyWhile`, and the agents SDK awaits
 * `_checkRunFibers` — and so this hook — inside it. A re-drive that ran here
 * would hold every request on the object, pure `@callable` reads included, for
 * as long as the lane takes: an advisor review is a model call, the evolution
 * lane spends model calls and real tool loops, a settled background job's wake
 * resolves only when the turn it queues ENDS, and a terminal sequence replays
 * SMTP round trips and waits on other agents' live heads. Past
 * `do.block_concurrency.cancel_ms` the runtime cancels the gate and RESETS the
 * object, which re-offers the same row on the next wake — a reset loop that can
 * hold a workspace unusable for {@link FIBER_RECOVERY_MAX_AGE_MS}.
 *
 * So each arm does three things, all synchronously: decide what the row means,
 * ask the lane's own idempotency guard whether anything is still owed, and hand
 * the re-drive to {@link FiberLaneTransports.redrive} — the actor's detached
 * durable carrier, a fresh fiber under the same lane name holding the same
 * checkpoint, so an interruption of the RE-DRIVE re-enters this classification
 * with the same inputs. Nothing here awaits, which is what makes "the gate
 * awaits classification only" a property of the code rather than a claim about
 * it; `scripts/do-init-gate.ts` holds the hook and this seam to that shape.
 */
import * as v from 'valibot';
import type { FiberRecoveryContext, FiberRecoveryResult } from 'agents';

import {
  BACKGROUND_FIBER_PREFIX, SEARCH_FIBER_NAME, BackgroundJobRunner, recoveryBackoffMs,
  AdvisorRecoverySnapshotSchema, nanoid, projectJsonValue,
  type AdvisorDisposition, type AdvisorRecoverySnapshot, type JsonValue,
  type SqlExecutor,
  JsonObjectSchema, type AgentSignal, type SignalOutcome,
} from '@kinu.run/core';
import { diagnostics, KinuError, toKinuError } from '@kinu.run/core/obs';

/**
 * How old an unrecovered `cf_agents_runs` row may be before recovery gives up
 * on it — Kinu's declared value for the SDK option of the same name, and the
 * ONE place the number lives.
 *
 * Declared once here: this is the SDK's own 24h default, and a second spelling
 * beside it (such as the schedule sweep's "past it the framework stops
 * recovering the fiber a continuation callback would resume") is a hand-mirror
 * of a vendor default nobody owns. It is read by the schedule sweep and handed
 * to the SDK through `ActorAgent.options` — which makes it the number the
 * framework actually enforces rather than a guess about it.
 */
export const FIBER_RECOVERY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The most rows ONE activation sweep scans — the inherent bound the init
 * ruling requires, and the same number the framework's own scan carries
 * (`patches/agents@0.20.1.patch`, where a stopwatch bounded nothing but the
 * wait). Shared by every row-budgeted sweep in this backend, because three
 * spellings of one budget are three numbers that can drift; a sweep whose
 * per-row cost is different says so with its own constant and its reason
 * (`ORPHAN_SEAL_MAX_ROWS`).
 *
 * Metadata-only pages, so the worst case is a handful of indexed reads; a
 * backlog deeper than this drains on the maintenance wake rather than holding
 * an activation hostage.
 */
export const SWEEP_MAX_ROWS = 4096;

/**
 * One metadata row per read. This is not a policy cap: the framework's own
 * scan carries the same 4096-row budget (patches/agents@0.20.1.patch — a
 * stopwatch bounded nothing but the wait), while the read is structurally
 * incapable of holding more than one snapshot candidate at a time.
 */
const ONE_FIBER_ROW = 1;

/** One `cf_agents_runs` row's METADATA. The `snapshot` column is deliberately
 *  absent — reading it is the allocation this sweep exists to avoid. */
const FiberMetaRowSchema = v.object({
  rowid: v.number(),
  id: v.string(),
  created_at: v.number(),
});

export type FiberMetaRow = v.InferOutput<typeof FiberMetaRowSchema>;

/**
 * The four questions the sweep asks of `cf_agents_runs`, and nothing wider.
 *
 * A port rather than a raw `SqlExecutor`, and the narrowness IS the design: no
 * method here can return a stashed snapshot, so "this pass never materializes a
 * blob" is a property of the interface instead of a claim about a query string.
 * The SQL lives in {@link fiberRowStore}, the only thing that has to know the
 * framework's column names.
 */
export interface FiberRowStore {
  /** The framework creates the table lazily, on the first `runFiber`. */
  present(): boolean;
  /** `MAX(rowid)`, read once and then frozen by the caller. */
  upperBoundary(): number | null;
  /** Metadata for EXPIRED rows in `(after, through]`, oldest rowid first.
   *  The cutoff sits in the query: a fresh row is never scanned at all, so a
   *  backlog of live fibers cannot starve an expired row behind it — the
   *  ordering `created_at` roughly tracks rowid is a tendency, never the
   *  guarantee (imported rows and a stepped clock both break it). */
  page(after: number, through: number, cutoff: number): readonly FiberMetaRow[];
  /** Remove one row, re-checking AT ITS OWN ID that it is still expired.
   *  `false` when a concurrent pass already handled it. */
  dropIfExpired(id: string, cutoff: number): boolean;
}

/** {@link FiberRowStore} over a Durable Object's own storage. */
export function fiberRowStore(sql: SqlExecutor): FiberRowStore {
  return {
    present: () => sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cf_agents_runs'`.length > 0,
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

/**
 * The envelope Think's chat-turn snapshot rides in.
 *
 * Every response — the first and every auto-continuation — runs inside a
 * `runFiber`, and the snapshot the framework writes before the body runs names
 * the request and the user message the turn opened on. The key is a literal
 * `_runChatRecoveryFiber` hands to `wrapChatFiberSnapshot` and the SDK exports
 * it nowhere — think.js spells it at each call site — so this mirrors Think's
 * spelling for the read below.
 *
 * The ENVELOPE is what the read below matches on, not the fiber's name: one
 * coupling to the framework instead of two, and no other lane writes a snapshot
 * shaped like this.
 */
const CHAT_TURN_SNAPSHOT_KEY = '__cfThinkChatFiberSnapshot';
const CHAT_TURN_ID_PATH = `$.${CHAT_TURN_SNAPSHOT_KEY}.latestUserMessageId`;
const CHAT_TURN_REQUEST_PATH = `$.${CHAT_TURN_SNAPSHOT_KEY}.requestId`;

/**
 * The responses of one durable turn that still hold a chat-turn fiber row, by
 * request id.
 *
 * The row exists for exactly as long as its response can still do something:
 * written before the turn body runs, deleted when that body returns, and
 * deleted by the framework's own scan once recovery has handled the row or
 * given up on it. So a row no live response of this activation owns is an
 * interrupted response — an auto-continuation caught mid tool call, say — that
 * chat recovery still owes a replay.
 */
export function openChatTurnResponses(sql: SqlExecutor, turnId: string): string[] {
  if (!fiberRowStore(sql).present()) return [];
  return sql<{ request_id: string }>`
    SELECT json_extract(snapshot, ${CHAT_TURN_REQUEST_PATH}) AS request_id
    FROM cf_agents_runs
    WHERE json_extract(snapshot, ${CHAT_TURN_ID_PATH}) = ${turnId}`
    .map((row) => row.request_id);
}

/** How many rows one sweep dropped, how many it looked at, and whether it ran
 *  out of deadline before reaching the frozen boundary. */
export interface FiberSweepResult {
  readonly dropped: number;
  readonly scanned: number;
  readonly truncated: boolean;
}

/**
 * Drop the interrupted-fiber rows the recovery budget has already given up on,
 * BEFORE the framework allocates their snapshots.
 *
 * `Agent._checkRunFibers` opens with `SELECT id, name, snapshot, created_at FROM
 * cf_agents_runs` — one materialization of every row, snapshot blobs included —
 * and only then walks them, checking its scan deadline per row and its max-age
 * budget after each recovery hook. Both bounds are therefore evaluated after the
 * allocation they exist to bound: a workspace holding many or large stashes pays
 * for all of them at once, and the deadline it then trips is a deadline on work
 * already paid for. The vendored SDK owns that read; this is the same budget,
 * applied first, in the shape the read cannot take:
 *
 *   • FREEZE THE UPPER BOUNDARY. `MAX(rowid)`, read once. Every row at or below
 *     it was written by an earlier activation, so a fiber THIS activation starts
 *     lands above the boundary and is structurally outside the sweep. That is
 *     what makes an "is it live?" check unnecessary rather than racy, and it is
 *     why the boundary is frozen instead of re-read per page.
 *   • PAGE METADATA ONLY. `rowid, id, created_at`. The snapshot column is never
 *     selected, so the memory held is one page of timestamps regardless of what
 *     the lanes stashed.
 *   • REVALIDATE BEFORE ACTING. The delete is guarded on the row still being
 *     over the budget at its own id, so a page — a snapshot of a table a
 *     concurrent framework scan writes to — cannot authorise a stale removal.
 *   • A ROW BUDGET, NOT A STOPWATCH. One activation scans at most
 *     {@link SWEEP_MAX_ROWS} rows — an inherent bound on the work
 *     itself, where the wall-clock cutoff this replaces bounded nothing but
 *     the wait. What the pass does not reach stays for the next wake,
 *     exactly as the framework's own scan leaves it.
 *
 * Only rows the budget has ALREADY refused are dropped, so no recovery decision
 * changes: past `fiberRecoveryMaxAgeMs` the framework discards the row anyway
 * (`fiber:recovery:skipped`, `max_age_exceeded`), and Kinu's schedule sweep
 * already acts on the same rule — a continuation past that age can only replay
 * dead work. Rows inside the budget are untouched and remain the framework's to
 * recover.
 */
export function sweepUnrecoverableFibers(
  store: FiberRowStore,
  now: number,
): FiberSweepResult {
  const cutoff = now - FIBER_RECOVERY_MAX_AGE_MS;
  const nothing: FiberSweepResult = { dropped: 0, scanned: 0, truncated: false };
  // An actor that has never detached durable work has no table. That is not a
  // failure, it is zero rows, and saying so keeps a fresh workspace quiet.
  if (!store.present()) return nothing;
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

/** The post-turn evolution lane's durable fiber name. */
export const EVOLUTION_LANE_FIBER = 'evolution:settle';

/** The advisor lane's durable fiber name. */
export const ADVISOR_LANE_FIBER = 'advisor:review';

/** The post-turn MCP warmup lane's durable fiber name. */
export const MCP_WARM_LANE_FIBER = 'mcp:warm';

/** The terminal-sequence lane's durable fiber name — the effects a settled turn
 *  owes, held open while they report. */
export const TERMINAL_LANE_FIBER = 'terminal:effects';

/** The fork-journal recovery notice in flight — the wake text a reconcile owes
 *  the agent, carried as its own lane so an eviction between the journal's
 *  terminal writes and the notice landing replays the DELIVERY, not the
 *  reconcile. The signal rides the checkpoint whole, and its idempotency key
 *  makes the replay collide with a delivery that already landed. */
const FORK_NOTICE_LANE_FIBER = 'fork:notice';

/** The transports one actor supplies to its lanes' recovery. Every member is
 *  something an activation re-resolves for itself — a stub call, a fresh model
 *  route, its own storage — which is exactly why they are parameters and the
 *  arms below are shared: the arms must not drift per backend, and the
 *  transports cannot be captured at interruption time anyway. */
export interface FiberLaneTransports {
  /** The durable background-job registry: re-drive a lost executor, sweep
   *  jobs whose fiber row did not survive. */
  readonly jobs: Pick<BackgroundJobRunner, 'recover' | 'recoverOrphans'>;
  /** Re-enter every unit the evolution cadence drives from durable storage. */
  readonly runDueSessionEvolution: () => Promise<void>;
  /** Whether one turn's advisor note already landed — the idempotency guard.
   *  Synchronous storage, because the guard is what decides IN the gate whether
   *  anything is handed to a carrier at all. */
  readonly hasAdvisorNoteForTurn: (turnId: string) => boolean;
  /** The ONE review body both the live lane and its recovery run. */
  readonly reviewAdvisorSnapshot: (
    snapshot: AdvisorRecoverySnapshot,
  ) => Promise<AdvisorDisposition | null>;
  /** This actor's own SQLite — where the interrupted-search notice is filed. */
  readonly sql: SqlExecutor;
  /** The agent's own memory surface — what tells it about the lost turn. */
  readonly appendMemory: (path: string, text: string) => Promise<void>;
  /** Arm the durable wake the terminal ledger already owns, and replay nothing:
   *  the owed rows are the record, and the alarm frame they were designed for is
   *  where a replay may await an SMTP round trip. */
  readonly armOwedTerminalRecovery: () => Promise<void>;
  /** Deliver one recovered signal — the fork-notice lane's replay body. The
   *  OUTCOME is load-bearing: `undelivered` means the enqueue was pre-empted
   *  and the notice is still owed. */
  readonly deliverSignal: (signal: AgentSignal) => Promise<SignalOutcome>;
  /**
   * Hand one lane's re-drive to the actor's detached durable carrier.
   *
   * Returns nothing, and the absence IS the contract: an arm that could await
   * the re-drive would be back inside the init gate. What the actor supplies is
   * a fresh fiber under `lane` holding `checkpoint`, so the work is durable
   * before this hook returns — the SDK deletes the row it recovered as soon as
   * it does — and an interruption of the re-drive re-enters this classification
   * with the same inputs.
   */
  readonly redrive: (lane: string, checkpoint: JsonValue, body: () => Promise<void>) => void;
}

/**
 * Decide what to do with one fiber the platform interrupted, SAY SO, and hand
 * the work itself to a carrier that may take as long as the work takes.
 *
 * The return value is load-bearing. The SDK deletes an interrupted
 * `cf_agents_runs` row when this hook RETURNS and retains it when this hook
 * THROWS — a retained row is re-offered on every activation until
 * `fiberRecoveryMaxAgeMs` (24h) discards it, keeping the object warm the whole
 * time. So this never throws: every path below ends in a terminal
 * `FiberRecoveryResult`, and a lane nobody here recognises ends in a classified
 * `error` rather than in a poison row that re-enters for a day. For a managed
 * row the same value is what moves the ledger off `interrupted`, which is why
 * the classified paths return `completed` rather than nothing.
 *
 * SYNCHRONOUS, which is the whole gate argument (see the module header): the row
 * the SDK is about to delete is replaced by the carrier's own row before this
 * returns, so classifying rather than re-driving loses no work and stalls
 * nobody. A `completed` here therefore means "this row's obligation now has a
 * carrier", not "the lane finished".
 *
 * One branch per lane, and the branches are not interchangeable: a background
 * job has durable rows to re-drive from, the evolution lane has durable queues
 * to re-enter, the advisor lane has neither, and a search's tree survives but
 * the turn that was reading it does not.
 */
export function classifyRecoveredFiber(
  transports: FiberLaneTransports,
  ctx: FiberRecoveryContext,
): FiberRecoveryResult {
  diagnostics.event('fiber.recovered', { fiber: ctx.name, fiberId: ctx.id });
  try {
    if (ctx.name.startsWith(BACKGROUND_FIBER_PREFIX)) return redriveBackgroundJobLane(transports, ctx);
    if (ctx.name === EVOLUTION_LANE_FIBER) return redriveEvolutionLane(transports, ctx);
    if (ctx.name === ADVISOR_LANE_FIBER) return redriveAdvisorLane(transports, ctx);
    if (ctx.name === SEARCH_FIBER_NAME) return recordInterruptedSearch(transports, ctx);
    if (ctx.name === MCP_WARM_LANE_FIBER) return recoverMcpWarmLane();
    if (ctx.name === TERMINAL_LANE_FIBER) return armTerminalLaneRecovery(transports, ctx);
    if (ctx.name === FORK_NOTICE_LANE_FIBER) return redriveForkNoticeLane(transports, ctx);
    return unrecognisedLane(ctx);
  } catch (err) {
    const failure = toKinuError({
      doing: `classifying the "${ctx.name}" fiber after eviction`,
      cause: err,
      otherwise: 'io',
    });
    diagnostics.failure('fiber.recovery_failed', failure, { fiber: ctx.name, fiberId: ctx.id });
    // Terminal, not rethrown. A lane whose guard could not be read, or whose
    // carrier could not write its row, will not classify on the fifth attempt
    // either, and re-offering the row is how one broken lane holds a Durable
    // Object open for a day.
    return { status: 'error', error: failure.message, snapshot: { lane: ctx.name, recovered: false } };
  }
}

/**
 * A settled turn whose owed effects were still reporting when the isolate died.
 *
 * Every input is already on the ledger's rows, so there is nothing to
 * reconstruct and — here — nothing to replay: the replay awaits an SMTP round
 * trip, a wait on another agent's live head and a model call per between-turn
 * lane, and this hook runs in the init gate. The arm hands the ledger's own
 * retry wake to the carrier instead, and the alarm frame the ledger was designed
 * for does the replay under the claim join that makes re-entry safe.
 */
function armTerminalLaneRecovery(
  transports: FiberLaneTransports,
  ctx: FiberRecoveryContext,
): FiberRecoveryResult {
  transports.redrive(
    TERMINAL_LANE_FIBER, fiberSnapshot(ctx), () => transports.armOwedTerminalRecovery(),
  );
  return { status: 'completed', snapshot: { lane: TERMINAL_LANE_FIBER, redrive: 'terminal-wake' } };
}

/**
 * A detached tool call whose executor died. The fiber row carries one fact
 * the registry does not — that THIS job's executor is dead — which is what
 * lets a job that already settled get its lost wake re-delivered.
 *
 * The registry sweep runs beside it because a cold start is also the moment
 * jobs whose fiber row did NOT survive become provably orphaned: nothing in
 * this isolate owns a job yet, so any other row still `running` is an orphan
 * no recovery callback will ever arrive for.
 */
function redriveBackgroundJobLane(
  transports: FiberLaneTransports,
  ctx: FiberRecoveryContext,
): FiberRecoveryResult {
  const checkpoint = fiberSnapshot(ctx);
  transports.redrive(ctx.name, checkpoint, async () => {
    const redriven = await transports.jobs.recover(checkpoint);
    const inFlight = await transports.jobs.recoverOrphans();
    // The return value carries no outcome. A settled job's re-drive is a WAKE,
    // and delivering one queues a turn that resolves only when the turn ends —
    // so the outcome cannot be part of a classification, and this is the only
    // place left that can say which job it was.
    diagnostics.event('fiber.job_lane_redriven', {
      fiber: ctx.name,
      redriven: redriven?.id ?? '(none)',
      inFlight: inFlight.length,
    });
  });
  return { status: 'completed', snapshot: { lane: ctx.name, redrive: 'background-job' } };
}

/**
 * The post-turn evolution lane, re-entered from storage.
 *
 * `settleEvolution()` is deliberately NOT called: it joins promises this
 * isolate dispatched, and this isolate dispatched none — the ones that died
 * with the last activation are unreachable and un-rejoinable. What IS
 * recoverable is every unit the lane drives from a DURABLE queue, and
 * `runDueSessionEvolution()` is exactly that: it drains the shadow-trial
 * queue and runs the session pass if the durable window is due, claiming and
 * settling that window itself. Re-entering it is idempotent by construction —
 * a window is claimed in one tick and retired only once its pass has run, and
 * a trial is dropped only after it is scored.
 */
function redriveEvolutionLane(
  transports: FiberLaneTransports,
  ctx: FiberRecoveryContext,
): FiberRecoveryResult {
  transports.redrive(
    EVOLUTION_LANE_FIBER, fiberSnapshot(ctx), () => transports.runDueSessionEvolution(),
  );
  return { status: 'completed', snapshot: { lane: EVOLUTION_LANE_FIBER, redrive: 'session-evolution' } };
}

/**
 * The advisor lane, whose re-drive is a MODEL CALL and therefore leaves here.
 *
 * IDEMPOTENT ON THE NOTE, not on the attempt, and the distinction is the whole
 * correctness argument. A lane can be interrupted on either side of its one
 * durable write: before `recordAdvisorNote`, in which case nothing landed and
 * the review must run; or after it, in which case the review COMPLETED and
 * only the fiber row's release was lost — re-running there would write a
 * second note about one turn and speak it twice. The note row is the only
 * durable evidence of which happened, so it is what decides. The signal is
 * idempotent independently (`advisor:<turnId>` derives the queued turn's
 * durable message id), so the two guards agree rather than one covering for
 * the other.
 *
 * A turn with no durable id cannot be guarded that way and is not given a
 * fabricated one: it re-runs, exactly as its signal goes out unkeyed. That is
 * pre-existing lane behaviour, not a decision taken here.
 *
 * A snapshot that will not parse is the one genuinely terminal case left, and
 * it is a real terminal rather than a lost review: there is no turn to review,
 * so there is nothing a further attempt could do differently.
 *
 * The guard runs HERE, before anything is handed to a carrier, and the ordering
 * is the point: a review that already landed costs one synchronous row read to
 * refuse, so recovery cannot double a note by detaching first and checking
 * later.
 */
function redriveAdvisorLane(
  transports: FiberLaneTransports,
  ctx: FiberRecoveryContext,
): FiberRecoveryResult {
  const checkpoint = fiberSnapshot(ctx);
  const parsed = v.safeParse(AdvisorRecoverySnapshotSchema, checkpoint);
  if (!parsed.success) {
    return {
      status: 'error',
      error: 'the interrupted advisor review left no readable snapshot of the turn it was '
        + `about: ${parsed.issues.map((issue) => issue.message).join('; ')}`,
      snapshot: { lane: ADVISOR_LANE_FIBER, redrive: null },
    };
  }
  const snapshot = parsed.output;
  const turnId = snapshot.turn.turnId;
  if (turnId !== undefined && transports.hasAdvisorNoteForTurn(turnId)) {
    return {
      status: 'completed',
      snapshot: { lane: ADVISOR_LANE_FIBER, turnId, redrive: null, alreadyRecorded: true },
    };
  }
  transports.redrive(ADVISOR_LANE_FIBER, checkpoint, async () => {
    const disposition = await transports.reviewAdvisorSnapshot(snapshot);
    diagnostics.event('fiber.advisor_lane_redriven', {
      turnId: turnId ?? '(none)',
      disposition: disposition ?? '(none)',
    });
  });
  return {
    status: 'completed',
    snapshot: { lane: ADVISOR_LANE_FIBER, turnId: turnId ?? null, redrive: 'advisor-review' },
  };
}

/**
 * A recovery notice that was minted and never confirmed delivered.
 *
 * The checkpoint IS the signal: everything the delivery needs crossed into the
 * fiber row before the reconcile returned, so the replay reconstructs nothing.
 * A checkpoint that will not parse as a signal is terminal — there is no fact
 * left to announce — and the idempotency key the producer stamped is what makes
 * a replay of an already-landed delivery collide instead of duplicating.
 */
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
 * Dispatch one notice on a fresh carrier, retrying an `undelivered` outcome
 * forever at a capped pace.
 *
 * `undelivered` = the enqueue was pre-empted or refused, so the notice is
 * still owed: a FRESH fiber row carries each retry (durable across evictions,
 * with the attempt count in its checkpoint so the backoff resumes where it
 * left off), and the idempotency key makes any landed duplicate collide.
 *
 * WHAT THE PACE PROTECTS is a TURN, not a row. This notice carries an
 * idempotency key, so its delivery goes through `submitMessages`, and
 * `undelivered` there means the submitted turn came back aborted, skipped or
 * errored — after running. An unpaced retry would therefore re-run agent turns
 * in a loop, which is why the sleep is not optional and why it survives an
 * eviction: attempts are UNBOUNDED (a cap loses the notice the carrier exists
 * to keep) and only the pace holds them apart.
 */
export function dispatchRecoveredNotice(
  transports: Pick<FiberLaneTransports, 'redrive' | 'deliverSignal'>,
  signal: RecoveredNotice,
  attempts = 0,
): void {
  const checkpoint: JsonValue = { ...signal, attempts };
  transports.redrive(FORK_NOTICE_LANE_FIBER, checkpoint, async () => {
    // SLEEP FIRST for any attempt after the first, because the checkpoint
    // carries the ATTEMPT COUNT and not the sleep: an eviction mid-backoff
    // recovers this row and re-enters here with the same count, and pacing
    // that ran after the refusal would be skipped by exactly that replay.
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

/** The shape a recovered notice must still have to be deliverable. Structural
 *  and minimal: the delivery seam needs the kind and the text; the key and
 *  metadata ride along when present. */
const RecoveredSignalSchema = v.object({
  kind: v.string(),
  text: v.string(),
  idempotencyKey: v.optional(v.string()),
  metadata: v.optional(JsonObjectSchema),
  /** Delivery attempts so far — rides the checkpoint so the capped backoff
   *  survives an eviction mid-retry. */
  attempts: v.optional(v.number()),
});

/** One notice as the carrier hands it around — the named owner contract for
 *  every dispatch site. */
export type RecoveredNotice = v.InferOutput<typeof RecoveredSignalSchema>;


/**
 * The MCP warmup lane, which has NOTHING to re-enter.
 *
 * Establishing a connection is not a durable unit of work: the live connection
 * IS the state, and the next settled turn warms again unconditionally. So an
 * interrupted warm needs no re-drive and must not get one — a re-entry would
 * open sockets to third parties on an activation no turn asked anything of, for
 * a turn whose successor is about to warm anyway.
 *
 * It exists because `classifyRecoveredFiber` is a CLOSED set: a lane nobody names
 * there is reported as unrecognised, which files a classified error for a fiber
 * whose interruption is not a fault.
 */
function recoverMcpWarmLane(): FiberRecoveryResult {
  return { status: 'completed', snapshot: { lane: MCP_WARM_LANE_FIBER, reentered: false } };
}

/**
 * A search interrupted mid-iteration. Its tree is durable (the search store)
 * and, when the call had been detached, its job row is what re-drives it —
 * so this branch does not re-drive anything. What it owns is TELLING the
 * agent: the turn that was reading the search is gone, and a future turn that
 * finds a half-expanded tree needs to know why.
 *
 * The notice is two writes with different costs. The audit row is this object's
 * own SQLite, synchronous, so it lands in the classification; the MEMORY.md line
 * goes through the workspace filesystem, which for a hosted workspace is another
 * Durable Object, so it rides the carrier like every other lane's work.
 */
function recordInterruptedSearch(
  transports: FiberLaneTransports,
  ctx: FiberRecoveryContext,
): FiberRecoveryResult {
  const snapshot = fiberSnapshot(ctx);
  void transports.sql`INSERT INTO evolution_events (id, type, message, data, created_at)
    VALUES (${nanoid()}, 'fiber_recovered',
            ${`Fiber "${ctx.name}" recovered after interruption`},
            ${JSON.stringify({ name: ctx.name, fiberId: ctx.id, snapshot, createdAt: ctx.createdAt })},
            ${Date.now()})`;
  transports.redrive(SEARCH_FIBER_NAME, snapshot, () => transports.appendMemory(
    'memory/MEMORY.md',
    `\n### Fiber recovery (${new Date().toISOString().split('T')[0]})\n`
    + `Fiber "${ctx.name}" was interrupted (likely DO eviction) and recovered. `
    + `Snapshot at interruption: ${JSON.stringify(snapshot).slice(0, 400)}\n`,
  ));
  return {
    status: 'completed',
    snapshot: { lane: SEARCH_FIBER_NAME, recorded: true, redrive: 'memory-note' },
  };
}

/**
 * A fiber name this class does not know.
 *
 * Falling into the search branch above writes the agent's own MEMORY.md — so
 * any lane added anywhere, by anyone, puts a line in the agent's memory about
 * platform plumbing it has no way to act on. An unrecognised lane is an
 * operational fact: it is classified, it is logged once, and its row is
 * released rather than re-offered for a day.
 */
function unrecognisedLane(ctx: FiberRecoveryContext): FiberRecoveryResult {
  const failure = new KinuError(
    'unsupported',
    `no recovery is defined for the "${ctx.name}" fiber, so the work it was carrying is lost`,
  );
  diagnostics.failure('fiber.recovery_unrecognised', failure, { fiber: ctx.name, fiberId: ctx.id });
  return { status: 'error', error: failure.message, snapshot: { lane: ctx.name, recovered: false } };
}

/** The stashed checkpoint in the portable JSON vocabulary, or null when the
 *  fiber never stashed one. */
function fiberSnapshot(ctx: FiberRecoveryContext): JsonValue {
  return ctx.snapshot === null || ctx.snapshot === undefined
    ? null
    : projectJsonValue({ value: ctx.snapshot });
}
