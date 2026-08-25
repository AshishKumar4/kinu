/**
 * The durable lanes' RECOVERY half — what happens to one when the platform
 * interrupted it.
 *
 * An ActorAgent runs four kinds of work through `runFiber`, so each writes a
 * `cf_agents_runs` row with its stashed identity before it runs and each is
 * handed back to {@link recoverLaneFiber} on the next activation:
 *
 *   • a detached tool call   (`bg:<kind>`, minted by core's BackgroundJobRunner)
 *   • a search               (`mcts`, minted by core's SEARCH_FIBER_NAME)
 *   • the evolution lane     (`evolution:settle`, started by settleTurnSpine)
 *   • the advisor lane       (`advisor:review`, started by reviewTurnInBackground)
 *
 * That activation needs NO client and NO request: with nothing connected, the
 * persisted keepAlive alarm fires on its own and the SDK's housekeeping runs the
 * interrupted-fiber scan. This module owns the ROSTER and each arm's semantics;
 * the actor owns only the transports the arms re-drive through, declared once in
 * {@link FiberLaneTransports}. The two cf-minted lane names live here beside the
 * dispatch that matches them — `BACKGROUND_FIBER_PREFIX` and `SEARCH_FIBER_NAME`
 * stay in core, because there core mints and this backend matches.
 */
import * as v from 'valibot';
import type { FiberRecoveryContext, FiberRecoveryResult } from 'agents';

import {
  BACKGROUND_FIBER_PREFIX, SEARCH_FIBER_NAME, BackgroundJobRunner,
  AdvisorRecoverySnapshotSchema, nanoid, projectJsonValue,
  type AdvisorDisposition, type AdvisorRecoverySnapshot, type JsonValue,
  type SqlExecutor,
} from '@kinu.run/core';
import { diagnostics, KinuError, toKinuError } from '@kinu.run/core/obs';

/** The post-turn evolution lane's durable fiber name. */
export const EVOLUTION_LANE_FIBER = 'evolution:settle';

/** The advisor lane's durable fiber name. */
export const ADVISOR_LANE_FIBER = 'advisor:review';

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
  /** Whether one turn's advisor note already landed — the idempotency guard. */
  readonly hasAdvisorNoteForTurn: (turnId: string) => boolean;
  /** The ONE review body both the live lane and its recovery run. */
  readonly reviewAdvisorSnapshot: (
    snapshot: AdvisorRecoverySnapshot,
  ) => Promise<AdvisorDisposition | null>;
  /** This actor's own SQLite — where the interrupted-search notice is filed. */
  readonly sql: SqlExecutor;
  /** The agent's own memory surface — what tells it about the lost turn. */
  readonly appendMemory: (path: string, text: string) => Promise<void>;
}

/**
 * Decide what to do with one fiber the platform interrupted, and SAY SO.
 *
 * The return value is load-bearing. The SDK deletes an interrupted
 * `cf_agents_runs` row when this hook RETURNS and retains it when this hook
 * THROWS — a retained row is re-offered on every activation until
 * `fiberRecoveryMaxAgeMs` (24h) discards it, keeping the object warm the whole
 * time. So this never throws: every path below ends in a terminal
 * `FiberRecoveryResult`, and a lane nobody here recognises ends in a classified
 * `error` rather than in a poison row that re-enters for a day. For a managed
 * row the same value is what moves the ledger off `interrupted`, which is why
 * the re-drive paths return `completed` rather than nothing.
 *
 * One branch per lane, and the branches are not interchangeable: a background
 * job has durable rows to re-drive from, the evolution lane has durable queues
 * to re-enter, the advisor lane has neither, and a search's tree survives but
 * the turn that was reading it does not.
 */
export async function recoverLaneFiber(
  transports: FiberLaneTransports,
  ctx: FiberRecoveryContext,
): Promise<FiberRecoveryResult> {
  diagnostics.event('fiber.recovered', { fiber: ctx.name, fiberId: ctx.id });
  try {
    if (ctx.name.startsWith(BACKGROUND_FIBER_PREFIX)) return await recoverBackgroundJobLane(transports, ctx);
    if (ctx.name === EVOLUTION_LANE_FIBER) return await recoverEvolutionLane(transports);
    if (ctx.name === ADVISOR_LANE_FIBER) return await recoverAdvisorLane(transports, ctx);
    if (ctx.name === SEARCH_FIBER_NAME) return await recordInterruptedSearch(transports, ctx);
    return unrecognisedLane(ctx);
  } catch (err) {
    const failure = toKinuError({
      doing: `recovering the "${ctx.name}" fiber after eviction`,
      cause: err,
      otherwise: 'io',
    });
    diagnostics.failure('fiber.recovery_failed', failure, { fiber: ctx.name, fiberId: ctx.id });
    // Terminal, not rethrown. Whatever this lane's recovery could not do, it
    // will not do on the fifth attempt either, and re-offering the row is how
    // one broken lane holds a Durable Object open for a day.
    return { status: 'error', error: failure.message, snapshot: { lane: ctx.name, recovered: false } };
  }
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
async function recoverBackgroundJobLane(
  transports: FiberLaneTransports,
  ctx: FiberRecoveryContext,
): Promise<FiberRecoveryResult> {
  const redriven = await transports.jobs.recover(fiberSnapshot(ctx));
  const inFlight = await transports.jobs.recoverOrphans();
  return {
    status: 'completed',
    snapshot: {
      lane: ctx.name,
      redriven: redriven?.id ?? null,
      inFlight: inFlight.map((job) => job.id),
    },
  };
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
async function recoverEvolutionLane(transports: FiberLaneTransports): Promise<FiberRecoveryResult> {
  await transports.runDueSessionEvolution();
  return { status: 'completed', snapshot: { lane: EVOLUTION_LANE_FIBER, reentered: 'session-evolution' } };
}

/**
 * The advisor lane, re-driven from the snapshot the interrupted lane stashed.
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
 */
async function recoverAdvisorLane(
  transports: FiberLaneTransports,
  ctx: FiberRecoveryContext,
): Promise<FiberRecoveryResult> {
  const parsed = v.safeParse(AdvisorRecoverySnapshotSchema, fiberSnapshot(ctx));
  if (!parsed.success) {
    return {
      status: 'error',
      error: 'the interrupted advisor review left no readable snapshot of the turn it was '
        + `about: ${parsed.issues.map((issue) => issue.message).join('; ')}`,
      snapshot: { lane: ADVISOR_LANE_FIBER, reentered: false },
    };
  }
  const snapshot = parsed.output;
  const turnId = snapshot.turn.turnId;
  if (turnId !== undefined && transports.hasAdvisorNoteForTurn(turnId)) {
    return {
      status: 'completed',
      snapshot: { lane: ADVISOR_LANE_FIBER, turnId, reentered: false, alreadyRecorded: true },
    };
  }
  const disposition = await transports.reviewAdvisorSnapshot(snapshot);
  return {
    status: 'completed',
    snapshot: {
      lane: ADVISOR_LANE_FIBER, turnId: turnId ?? null, reentered: true,
      disposition: disposition ?? null,
    },
  };
}

/**
 * A search interrupted mid-iteration. Its tree is durable (the search store)
 * and, when the call had been detached, its job row is what re-drives it —
 * so this branch does not re-drive anything. What it owns is TELLING the
 * agent: the turn that was reading the search is gone, and a future turn that
 * finds a half-expanded tree needs to know why.
 */
async function recordInterruptedSearch(
  transports: FiberLaneTransports,
  ctx: FiberRecoveryContext,
): Promise<FiberRecoveryResult> {
  const snapshot = fiberSnapshot(ctx);
  void transports.sql`INSERT INTO evolution_events (id, type, message, data, created_at)
    VALUES (${nanoid()}, 'fiber_recovered',
            ${`Fiber "${ctx.name}" recovered after interruption`},
            ${JSON.stringify({ name: ctx.name, fiberId: ctx.id, snapshot, createdAt: ctx.createdAt })},
            ${Date.now()})`;
  await transports.appendMemory(
    'memory/MEMORY.md',
    `\n### Fiber recovery (${new Date().toISOString().split('T')[0]})\n`
    + `Fiber "${ctx.name}" was interrupted (likely DO eviction) and recovered. `
    + `Snapshot at interruption: ${JSON.stringify(snapshot).slice(0, 400)}\n`,
  );
  return { status: 'completed', snapshot: { lane: SEARCH_FIBER_NAME, recorded: true } };
}

/**
 * A fiber name this class does not know.
 *
 * It used to fall into the search branch above, which wrote the agent's own
 * MEMORY.md — so any lane added anywhere, by anyone, could put a line in the
 * agent's memory about platform plumbing it has no way to act on. An
 * unrecognised lane is an operational fact: it is classified, it is logged
 * once, and its row is released rather than re-offered for a day.
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
