/**
 * Shadow-mode scaffold rollout. A pending version is judged against the current
 * one on sampled turns until `decidePromotion` is conclusive.
 *
 * Trials are expensive, so a turn only enqueues into `scaffold_trial_queue`; the
 * cadence lane runs them (evolution/control.ts `runQueuedShadowTrials`). Queued
 * trials stay out of `scaffold_evaluations` so they never count toward `trialsSoFar`.
 *
 * Actor-scoped: `status = 'current'` is a per-actor pointer and `actor_id` is in
 * both tables' primary keys, so one actor's trials never satisfy another's
 * idempotency or promotion gate.
 */

import { modelMessageSchema, type ModelMessage } from 'ai';
import * as v from 'valibot';
import type { AgentRuntime } from '../types/agent-runtime';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import {
  initEffectTombstoneTable, effectAlreadyDone, recordEffectDone,
} from '../identity/effect-tombstones';
import { nowMs } from '../utils/date';
import { diagnostics, toKinuError, KinuError } from '../obs/index';
import { parseJsonValue } from '../utils/json';
import { nanoid } from '../utils/nanoid';
import { checkMisevolution, recordMisevolutionVeto } from './misevolution';
import type { RunEventRecorder } from '../events/recorder';
import { WORKSPACE_RUN_ID } from '../events/model-call';

export type { ScaffoldArchiveEntry, ScaffoldStatus } from '../types/scaffold';

export type ScaffoldDecisionEvents = Pick<RunEventRecorder, 'actorId' | 'emit'>;

/** Outlives the queue row, so a replayed queueing cannot score the same turn twice. */
const TRIAL_SCOPE = 'shadow_trial';

export interface ShadowEvaluationRow {
  id: string;
  current_version: number;
  pending_version: number;
  task: string;
  current_score: number | null;
  pending_score: number | null;
  winner: 'current' | 'pending' | 'tie' | null;
  judge_rationale: string | null;
  evaluated_at: number;
}

export interface PendingScaffold {
  version: number;
  writtenAt: number;
  rationale: string;
  trialsSoFar: number;
  pendingWins: number;
  currentWins: number;
  ties: number;
}

/** One trial's verdict; the promotion rule is calibrated against this contract, not the judge protocol. */
export interface ShadowTrialVerdict {
  winner: 'current' | 'pending' | 'tie';
  rationale: string;
  currentScore: number;
  pendingScore: number;
}

export interface ShadowConfig {
  minTrials: number;
  promoteThreshold: number;
  rollbackThreshold: number;
  /** Forced-decision ceiling, sized to the order-swapped judge's decisive yield. */
  maxTrials: number;
  /** Decisive losses tolerated before rollback; 0 rejects most better variants under judge noise. */
  maxRegressions: number;
  /** Decisive (non-tie) trials required before a promote. */
  minDecisiveTrials: number;
}

/**
 * Settled by binomial Monte Carlo over the real decidePromotion
 * (scripts/shadow-veto-monte-carlo.ts; results in docs/EVOLUTION.md). The
 * promote/rollback band is nearly inert at this operating point; raising
 * maxRegressions would make it load-bearing and require a re-sweep.
 */
export const DEFAULT_SHADOW_CONFIG: ShadowConfig = {
  minTrials: 5,
  promoteThreshold: 0.6,
  rollbackThreshold: 0.4,
  maxTrials: 20,
  maxRegressions: 1,
  minDecisiveTrials: 5,
};

export function initShadowTables(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS scaffold_evaluations (
    actor_id TEXT NOT NULL,
    id TEXT NOT NULL,
    current_version INTEGER NOT NULL,
    pending_version INTEGER NOT NULL,
    task TEXT NOT NULL,
    current_output TEXT,
    pending_output TEXT,
    current_score REAL,
    pending_score REAL,
    winner TEXT,
    judge_rationale TEXT,
    evaluated_at INTEGER NOT NULL,
    PRIMARY KEY (actor_id, id)
  )`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_scaffold_eval_pending ON scaffold_evaluations(actor_id, pending_version)`);
  execRaw(`CREATE TABLE IF NOT EXISTS scaffold_trial_queue (
    actor_id TEXT NOT NULL,
    id TEXT NOT NULL,
    pending_version INTEGER NOT NULL,
    task TEXT NOT NULL,
    current_output TEXT NOT NULL,
    context TEXT NOT NULL,
    queued_at INTEGER NOT NULL,
    PRIMARY KEY (actor_id, id)
  )`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_scaffold_trial_queue_pending ON scaffold_trial_queue(actor_id, pending_version)`);
  initEffectTombstoneTable(execRaw);
}

/** A trial the turn sampled that has not executed yet. */
export interface QueuedShadowTrial {
  readonly id: string;
  readonly pendingVersion: number;
  /** The whole task; the evidence budget applies once, at judging time. */
  readonly task: string;
  readonly currentOutput: string;
  /** The live turn's context, replayed as the candidate's `host.defaultInference`; empty when the host held none. */
  readonly context: readonly ModelMessage[];
  readonly queuedAt: number;
}

/** Queue depth cap for hosts that never drain (e.g. one-shot `kinu exec`); past `maxTrials` extra work is unusable. */
export const MAX_QUEUED_SHADOW_TRIALS = DEFAULT_SHADOW_CONFIG.maxTrials;

/** Serialized context chars per queued trial; keeps the tail and stays well inside one SQLite row. */
export const SHADOW_TRIAL_CONTEXT_CHARS = 64_000;

/**
 * Tail of `messages` within the budget, starting at a user message so no tool
 * result loses its call. Exported for callers recording durable context rows.
 */
export function trimTrialContext(messages: readonly ModelMessage[]): ModelMessage[] {
  const kept: ModelMessage[] = [];
  let spent = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const size = JSON.stringify(messages[i]).length;

    // A single message over budget is dropped, so the row insert cannot fail.
    if (spent + size > SHADOW_TRIAL_CONTEXT_CHARS
      && (kept.length > 0 || size > SHADOW_TRIAL_CONTEXT_CHARS)) break;

    spent += size;
    kept.unshift(messages[i]);
  }

  while (kept.length > 0 && kept[0].role !== 'user') kept.shift();

  return kept;
}

/** Record one trial for later execution. An already-consumed keyed trial reports `queued`. */
export function queueShadowTrial(
  sql: SqlExecutor,
  actor: ActorHandle,
  args: {
    pendingVersion: number;
    task: string;
    currentOutput: string;
    context: readonly ModelMessage[];
    /** Row identity for a queueing the caller may replay; the `shadow_trial` tombstone keeps it idempotent after deletion. */
    id?: string;
    now?: number;
  },
): 'queued' | 'queue_full' {
  actor.assertCurrent();

  // Before the depth check: an already-run trial does not compete for a slot.
  if (args.id !== undefined && effectAlreadyDone(sql, actor, TRIAL_SCOPE, args.id)) return 'queued';

  if (countQueuedShadowTrials(sql, actor, args.pendingVersion) >= MAX_QUEUED_SHADOW_TRIALS) return 'queue_full';
  // DO NOTHING: the runner may already hold the first row.
  void sql`INSERT INTO scaffold_trial_queue (actor_id, id, pending_version, task, current_output, context, queued_at)
      VALUES (${actor.actorId}, ${args.id ?? `trial-${nanoid()}`}, ${args.pendingVersion}, ${args.task}, ${args.currentOutput},
              ${JSON.stringify(trimTrialContext(args.context))}, ${args.now ?? nowMs()})
      ON CONFLICT(actor_id, id) DO NOTHING`;

  return 'queued';
}

export function listQueuedShadowTrials(
  sql: SqlExecutor, actor: ActorHandle, pendingVersion: number,
): QueuedShadowTrial[] {
  actor.assertCurrent();

  type Row = {
    id: string; pending_version: number; task: string; current_output: string;
    context: string; queued_at: number;
  };

  const rows = sql<Row>`
    SELECT id, pending_version, task, current_output, context, queued_at
    FROM scaffold_trial_queue
    WHERE actor_id = ${actor.actorId} AND pending_version = ${pendingVersion}
    ORDER BY queued_at ASC`;

  return rows.map((r) => ({
    id: r.id,
    pendingVersion: r.pending_version,
    task: r.task,
    currentOutput: r.current_output,
    context: parseTrialContext(r.context),
    queuedAt: r.queued_at,
  }));
}

/** Messages that fail the provider vocabulary fall back to the default loop; unparseable JSON is corruption and throws. */
function parseTrialContext(raw: string): ModelMessage[] {
  const parsed = modelMessageSchema.array().safeParse(parseJsonValue(raw));

  return parsed.success ? parsed.data : [];
}

export function countQueuedShadowTrials(
  sql: SqlExecutor, actor: ActorHandle, pendingVersion: number,
): number {
  actor.assertCurrent();

  const rows = sql<{ n: number }>`
    SELECT COUNT(*) AS n FROM scaffold_trial_queue
    WHERE actor_id = ${actor.actorId} AND pending_version = ${pendingVersion}`;

  return rows[0]?.n ?? 0;
}

/** Delete the queue row and write the tombstone in the same pass, for every id. */
export function dropQueuedShadowTrial(sql: SqlExecutor, actor: ActorHandle, id: string): void {
  actor.assertCurrent();
  recordEffectDone(sql, actor, { scope: TRIAL_SCOPE, key: id });
  void sql`DELETE FROM scaffold_trial_queue WHERE actor_id = ${actor.actorId} AND id = ${id}`;
}

/** Discard queued trials not for `keepVersion`; null clears the queue. */
export function purgeQueuedShadowTrials(
  sql: SqlExecutor, actor: ActorHandle, keepVersion: number | null,
): void {
  actor.assertCurrent();

  if (keepVersion === null) {
    void sql`DELETE FROM scaffold_trial_queue WHERE actor_id = ${actor.actorId}`;
  } else {
    void sql`DELETE FROM scaffold_trial_queue
      WHERE actor_id = ${actor.actorId} AND pending_version != ${keepVersion}`;
  }
}

/** The single status='pending' version, or null. */
export function getPendingScaffold(sql: SqlExecutor, actor: ActorHandle): PendingScaffold | null {
  actor.assertCurrent();

  type Row = { version: number; written_at: number; rationale: string };

  const rows = sql<Row>`
    SELECT version, written_at, rationale FROM scaffold_versions
    WHERE actor_id = ${actor.actorId} AND status = 'pending'
    ORDER BY version DESC LIMIT 1`;

  if (rows.length === 0) return null;
  const r = rows[0];

  type CountRow = { winner: string | null; n: number };

  const counts = sql<CountRow>`
    SELECT winner, COUNT(*) AS n FROM scaffold_evaluations
    WHERE actor_id = ${actor.actorId} AND pending_version = ${r.version}
    GROUP BY winner`;

  let trials = 0, pendingWins = 0, currentWins = 0, ties = 0;

  for (const c of counts) {
    trials += c.n;

    if (c.winner === 'pending') pendingWins = c.n;
    else if (c.winner === 'current') currentWins = c.n;
    else if (c.winner === 'tie') ties = c.n;
  }

  return {
    version: r.version, writtenAt: r.written_at, rationale: r.rationale,
    trialsSoFar: trials, pendingWins, currentWins, ties,
  };
}

/** Highest status='current' version. Never `pending - 1`: numbering is non-contiguous after rollbacks. */
export function getCurrentScaffoldVersion(sql: SqlExecutor, actor: ActorHandle): number | null {
  actor.assertCurrent();

  const rows = sql<{ version: number }>`
    SELECT version FROM scaffold_versions
    WHERE actor_id = ${actor.actorId} AND status = 'current'
    ORDER BY version DESC LIMIT 1`;

  return rows[0]?.version ?? null;
}

export interface ShadowVerdictTrial {
  id: string;
  task: string;
  currentScore: number | null;
  pendingScore: number | null;
  winner: 'current' | 'pending' | 'tie' | null;
  rationale: string | null;
  evaluatedAt: number;
}

export interface ShadowVerdict {
  version: number | null;
  trials: ShadowVerdictTrial[];
  summary: { trials: number; pendingWins: number; currentWins: number; ties: number; winRate: number };
}

/** Per-trial verdicts for a pending version, regressions first; `winRate` is over decisive trials. */
export function readShadowVerdict(
  sql: SqlExecutor, actor: ActorHandle, version: number | null,
): ShadowVerdict {
  actor.assertCurrent();

  if (version == null) {
    return { version: null, trials: [], summary: { trials: 0, pendingWins: 0, currentWins: 0, ties: 0, winRate: 0 } };
  }

  type Row = {
    id: string; task: string; current_score: number | null; pending_score: number | null;
    winner: 'current' | 'pending' | 'tie' | null; judge_rationale: string | null; evaluated_at: number;
  };

  const rows = sql<Row>`
    SELECT id, task, current_score, pending_score, winner, judge_rationale, evaluated_at
    FROM scaffold_evaluations
    WHERE actor_id = ${actor.actorId} AND pending_version = ${version}
    ORDER BY CASE winner WHEN 'current' THEN 0 WHEN 'tie' THEN 1 ELSE 2 END, evaluated_at DESC`;

  let pendingWins = 0, currentWins = 0, ties = 0;

  for (const r of rows) {
    if (r.winner === 'pending') pendingWins++;
    else if (r.winner === 'current') currentWins++;
    else if (r.winner === 'tie') ties++;
  }

  const decisive = pendingWins + currentWins;

  return {
    version,
    trials: rows.map((r) => ({
      id: r.id, task: r.task,
      currentScore: r.current_score, pendingScore: r.pending_score,
      winner: r.winner, rationale: r.judge_rationale, evaluatedAt: r.evaluated_at,
    })),
    summary: { trials: rows.length, pendingWins, currentWins, ties, winRate: decisive === 0 ? 0 : pendingWins / decisive },
  };
}

export async function readVersionedScaffoldSource(rt: AgentRuntime, version: number): Promise<string | null> {
  const versioned = `${rt.identity.scaffold.path}.v${version}`;
  const scaffoldVfs = rt.agentStateVfs ?? rt.storage.vfs;

  if (!await scaffoldVfs.exists(versioned)) return null;

  return v.parse(v.string(), await scaffoldVfs.readFile(versioned, { encoding: 'utf8' }));
}

/** Prefers the canonical `agent.js.v{N}` file; the live file holds the current version, not a pending one. */
export async function readScaffoldVersion(rt: AgentRuntime, version: number): Promise<string | null> {
  const versioned = await readVersionedScaffoldSource(rt, version);

  if (versioned !== null) return versioned;

  // No version file (v0): fall back to the live file only for the status='current' version,
  // not `scaffold.version()` (MAX, which includes pending), or a missing pending file
  // would be judged as the current code.
  if (version !== getCurrentScaffoldVersion(rt.storage.sql, rt.actor)) return null;

  return await rt.identity.scaffold.read();
}

/** The score this queued trial already produced, or null; guards a re-run's rollout. */
export function scoredShadowTrial(
  sql: SqlExecutor, actor: ActorHandle, trialId: string,
): ShadowTrialVerdict | null {
  actor.assertCurrent();

  const rows = sql<{
    current_score: number; pending_score: number;
    winner: ShadowTrialVerdict['winner']; judge_rationale: string;
  }>`
    SELECT current_score, pending_score, winner, judge_rationale
    FROM scaffold_evaluations
    WHERE actor_id = ${actor.actorId} AND id = ${`eval-${trialId}`} LIMIT 1`;

  const row = rows[0];

  if (row === undefined) return null;

  return {
    currentScore: row.current_score,
    pendingScore: row.pending_score,
    winner: row.winner,
    rationale: row.judge_rationale,
  };
}

export function recordShadowEvaluation(
  sql: SqlExecutor,
  actor: ActorHandle,
  args: {
    currentVersion: number;
    pendingVersion: number;
    task: string;
    currentOutput: string;
    pendingOutput: string;
    judgeResult: ShadowTrialVerdict;
    /** Queue identity, so a replay writes the same row; bare evals get a fresh id. */
    trialId?: string;
  },
): ShadowEvaluationRow {
  actor.assertCurrent();
  const id = args.trialId === undefined ? `eval-${nanoid()}` : `eval-${args.trialId}`;

  const row: ShadowEvaluationRow = {
    id,
    current_version: args.currentVersion,
    pending_version: args.pendingVersion,
    task: args.task,
    current_score: args.judgeResult.currentScore,
    pending_score: args.judgeResult.pendingScore,
    winner: args.judgeResult.winner,
    judge_rationale: args.judgeResult.rationale,
    evaluated_at: nowMs(),
  };

  void sql`INSERT INTO scaffold_evaluations
    (actor_id, id, current_version, pending_version, task, current_output, pending_output,
     current_score, pending_score, winner, judge_rationale, evaluated_at)
    VALUES (${actor.actorId}, ${row.id}, ${row.current_version}, ${row.pending_version},
            ${row.task}, ${args.currentOutput}, ${args.pendingOutput},
            ${row.current_score}, ${row.pending_score},
            ${row.winner}, ${row.judge_rationale}, ${row.evaluated_at})
    ON CONFLICT(actor_id, id) DO NOTHING`;

  return row;
}

export interface PromotionDecision {
  decision: 'promote' | 'rollback' | 'continue';
  winRate: number;
}

/**
 * The trial record a promotion decision reads. Also used by evolved prompt
 * sections (`prompting/section-store.ts`) so both share one calibrated rule.
 */
export interface ShadowTrialRecord {
  readonly trialsSoFar: number;
  readonly pendingWins: number;
  readonly currentWins: number;
}

export function decidePromotion(
  pending: ShadowTrialRecord,
  config: ShadowConfig,
): PromotionDecision {
  const decisiveTrials = pending.pendingWins + pending.currentWins;

  if (decisiveTrials === 0) {
    // All ties carries no signal: keep observing, even past maxTrials.
    return { decision: 'continue', winRate: 0.5 };
  }

  const winRate = pending.pendingWins / decisiveTrials;

  // Regression veto first; gates promotion regardless of win rate.
  if (pending.currentWins > config.maxRegressions) {
    return { decision: 'rollback', winRate };
  }

  if (pending.trialsSoFar >= config.minTrials && decisiveTrials >= config.minDecisiveTrials) {
    if (winRate >= config.promoteThreshold) return { decision: 'promote', winRate };

    if (winRate <= config.rollbackThreshold) return { decision: 'rollback', winRate };
  }

  if (pending.trialsSoFar >= config.maxTrials) {
    // Forced decision: ignores minDecisiveTrials, which is why maxTrials is sized to decisive yield.
    return { decision: winRate > 0.5 ? 'promote' : 'rollback', winRate };
  }

  return { decision: 'continue', winRate };
}

/**
 * Apply a promotion decision. 'promote' moves the pointer atomically and then
 * refreshes the view; 'rollback' marks the pending rolled_back. A promote becomes
 * a rollback (with `vetoReason`) when the on-disk pending fails misevolution
 * criteria. Callers must report `action`, not their request.
 */
export async function applyPromotionDecision(
  rt: AgentRuntime,
  pending: PendingScaffold,
  decision: 'promote' | 'rollback',
  events: ScaffoldDecisionEvents,
): Promise<{ newCurrentVersion: number; action: 'promote' | 'rollback'; vetoReason?: string }> {
  rt.actor.assertCurrent();

  if (events.actorId !== rt.actor.actorId) throw new KinuError('denied', 'a scaffold decision requires its actor event recorder');
  const sql = rt.storage.sql;

  if (decision === 'promote') {
    // Re-check misevolution against the version file bytes that will actually run.
    const pendingCode = await readScaffoldVersion(rt, pending.version);

    if (pendingCode == null) {
      throw new Error(`promote failed: no scaffold code found for v${pending.version}`);
    }

    const misevolution = checkMisevolution(pendingCode);

    if (!misevolution.ok) {
      recordMisevolutionVeto(sql, rt.actor, {
        surface: 'scaffold', violation: misevolution,
        detail: `promotion of v${pending.version} vetoed; rolled back instead`,
      });
      const result = await applyPromotionDecision(rt, pending, 'rollback', events);

      return { ...result, vetoReason: `Misevolution veto (${misevolution.criterionId}): ${misevolution.reason}` };
    }

    // One actor-scoped statement retires the old current and promotes the pending, so no crash leaves zero or two current rows.
    void sql`UPDATE scaffold_versions
        SET status = CASE WHEN version = ${pending.version} THEN 'current' ELSE 'historical' END
        WHERE actor_id = ${rt.actor.actorId}
          AND (version = ${pending.version}
               OR (status = 'current' AND version != ${pending.version}))`;
    await rt.identity.scaffold.write(pendingCode);
    recordScaffoldDecision(events, { type: 'scaffold_promotion', fromVersion: pending.version - 1, toVersion: pending.version });

    return { newCurrentVersion: pending.version, action: 'promote' };
  }

  void sql`UPDATE scaffold_versions SET status = 'rolled_back'
      WHERE actor_id = ${rt.actor.actorId} AND version = ${pending.version}`;
  const currentVersion = getCurrentScaffoldVersion(sql, rt.actor) ?? (pending.version - 1);
  const currentCode = await readScaffoldVersion(rt, currentVersion);

  if (currentCode != null) {
    await rt.identity.scaffold.write(currentCode);
  }

  recordScaffoldDecision(events, { type: 'scaffold_rollback', fromVersion: pending.version, toVersion: currentVersion });

  return { newCurrentVersion: currentVersion, action: 'rollback' };
}

/**
 * Record the decision on the run-event log (the status flip leaves `written_at`
 * untouched), beside the pointer write so every path records it. Filed under the
 * reserved workspace run.
 */
function recordScaffoldDecision(
  events: ScaffoldDecisionEvents,
  event: { type: 'scaffold_promotion' | 'scaffold_rollback'; fromVersion: number; toVersion: number },
): void {
  try {
    events.emit(WORKSPACE_RUN_ID, event);
  } catch (err) {
    diagnostics.failure('event.scaffold_decision_emit_failed', toKinuError({
      doing: 'recording a scaffold promotion/rollback run event',
      cause: err,
      otherwise: 'io',
    }), { action: event.type });
  }
}
