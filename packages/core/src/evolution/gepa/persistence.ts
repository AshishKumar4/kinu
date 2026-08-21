/**
 * GEPA SQL persistence — survives DO hibernation.
 *
 * Schema:
 *   gepa_runs
 *     run_id            TEXT PK
 *     target            TEXT ('scaffold' | 'prompt_section' | 'crafted_tool' | 'arbitrary')
 *     target_ref        TEXT (e.g. tool name; nullable)
 *     started_at        INTEGER
 *     ended_at          INTEGER (null while in flight)
 *     status            TEXT ('running' | 'completed' | 'aborted')
 *     stop_reason       TEXT (null while in flight)
 *     winner_id         TEXT (FK to gepa_candidates.id; null while in flight)
 *     metric_calls      INTEGER
 *     iterations        INTEGER
 *     budget_json       TEXT (snapshot of GepaBudget)
 *
 *   gepa_candidates
 *     id                TEXT PK
 *     run_id            TEXT (FK)
 *     parent_id         TEXT (null for seed)
 *     source            TEXT (the artifact string)
 *     scores_json       TEXT (Map<instanceId, number> as JSON object)
 *     feedback_json     TEXT (Map<instanceId, string>  as JSON object)
 *     aggregate         REAL
 *     created_at        INTEGER
 *     iteration         INTEGER (0 = seed)
 *     accepted          INTEGER (0/1; whether it entered the pool)
 *
 *   gepa_pareto_membership
 *     run_id            TEXT
 *     instance_id       TEXT
 *     candidate_id      TEXT
 *     score             REAL
 *     PK (run_id, instance_id, candidate_id)
 *
 * Idempotent inits via CREATE TABLE IF NOT EXISTS.
 */

import * as v from 'valibot';
import type { RawSqlExec, SqlExecutor } from '../../types/primitives';
import { nanoid } from '../../utils/nanoid';
import { nowMs } from '../../utils/date';
import {
  computeParetoFront,
} from './pareto';
import { DEFAULT_GEPA_BUDGET } from './types';
import type {
  EvalInstance, GepaBudget, GepaCandidate, GepaResult, GepaIterationState,
} from './types';

const GepaRunStatusSchema = v.picklist(['running', 'completed', 'aborted']);
const ScoreMapSchema = v.record(v.string(), v.number());
const FeedbackMapSchema = v.record(v.string(), v.string());

export function initGepaTables(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS gepa_runs (
    run_id        TEXT PRIMARY KEY,
    target        TEXT NOT NULL,
    target_ref    TEXT,
    started_at    INTEGER NOT NULL,
    ended_at      INTEGER,
    status        TEXT NOT NULL CHECK (status IN ('running','completed','aborted')),
    stop_reason   TEXT,
    winner_id     TEXT,
    metric_calls  INTEGER NOT NULL DEFAULT 0,
    iterations    INTEGER NOT NULL DEFAULT 0,
    budget_json   TEXT NOT NULL
  )`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_gepa_runs_status_started
           ON gepa_runs(status, started_at)`);

  execRaw(`CREATE TABLE IF NOT EXISTS gepa_candidates (
    id             TEXT PRIMARY KEY,
    run_id         TEXT NOT NULL,
    parent_id      TEXT,
    source         TEXT NOT NULL,
    scores_json    TEXT NOT NULL,
    feedback_json  TEXT NOT NULL,
    aggregate      REAL NOT NULL,
    created_at     INTEGER NOT NULL,
    iteration      INTEGER NOT NULL,
    accepted       INTEGER NOT NULL DEFAULT 1
  )`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_gepa_candidates_run_iter
           ON gepa_candidates(run_id, iteration)`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_gepa_candidates_run_aggregate
           ON gepa_candidates(run_id, aggregate DESC)`);

  execRaw(`CREATE TABLE IF NOT EXISTS gepa_pareto_membership (
    run_id        TEXT NOT NULL,
    instance_id   TEXT NOT NULL,
    candidate_id  TEXT NOT NULL,
    score         REAL NOT NULL,
    PRIMARY KEY (run_id, instance_id, candidate_id)
  )`);
}

/** Start a new run row and return its id. Accepts a partial budget (same as
 *  GepaConfig.budget) and persists the FULLY-RESOLVED budget so the snapshot
 *  matches what runGepa actually used. */
export function startGepaRun(
  sql: SqlExecutor,
  opts: {
    target: 'scaffold' | 'prompt_section' | 'crafted_tool' | 'arbitrary';
    targetRef?: string | null;
    budget?: Partial<GepaBudget>;
  },
): string {
  const runId = `gepa-${nanoid()}`;
  const startedAt = nowMs();
  const budgetJson = JSON.stringify({ ...DEFAULT_GEPA_BUDGET, ...opts.budget });
  void sql`INSERT INTO gepa_runs
        (run_id, target, target_ref, started_at, ended_at, status, stop_reason,
         winner_id, metric_calls, iterations, budget_json)
        VALUES (${runId}, ${opts.target}, ${opts.targetRef ?? null}, ${startedAt},
                ${null}, ${'running'}, ${null}, ${null}, ${0}, ${0}, ${budgetJson})`;
  return runId;
}

/** Persist a candidate (seed or mutated) row. */
export function persistGepaCandidate(
  sql: SqlExecutor,
  args: {
    runId: string;
    candidate: GepaCandidate;
    iteration: number;
    accepted: boolean;
  },
): void {
  const scoresJson = JSON.stringify(Object.fromEntries(args.candidate.scores));
  const feedbackJson = JSON.stringify(Object.fromEntries(args.candidate.feedback));
  void sql`INSERT INTO gepa_candidates
        (id, run_id, parent_id, source, scores_json, feedback_json,
         aggregate, created_at, iteration, accepted)
        VALUES (${args.candidate.id}, ${args.runId}, ${args.candidate.parentId},
                ${args.candidate.source}, ${scoresJson}, ${feedbackJson},
                ${args.candidate.aggregateScore}, ${args.candidate.createdAt},
                ${args.iteration}, ${args.accepted ? 1 : 0})`;
}

/** Replace the Pareto-membership snapshot for the current state. Wipes the
 *  prior rows for this run + inserts fresh ones; cheap because pool is
 *  typically tens of candidates. */
export function persistGepaParetoSnapshot(
  sql: SqlExecutor,
  args: {
    runId: string;
    pool: ReadonlyArray<GepaCandidate>;
    instanceIds: ReadonlyArray<string>;
  },
): void {
  void sql`DELETE FROM gepa_pareto_membership WHERE run_id = ${args.runId}`;
  const { perInstanceBest } = computeParetoFront(args.pool, args.instanceIds);
  for (const [instanceId, bests] of perInstanceBest.entries()) {
    for (const c of bests) {
      const score = c.scores.get(instanceId) ?? 0;
      void sql`INSERT OR REPLACE INTO gepa_pareto_membership
            (run_id, instance_id, candidate_id, score)
            VALUES (${args.runId}, ${instanceId}, ${c.id}, ${score})`;
    }
  }
}

/** Update counters mid-run so a hibernating DO can resume. */
export function updateGepaRunCounters(
  sql: SqlExecutor,
  args: { runId: string; metricCalls: number; iterations: number },
): void {
  void sql`UPDATE gepa_runs SET metric_calls = ${args.metricCalls},
                            iterations   = ${args.iterations}
        WHERE run_id = ${args.runId}`;
}

/** Mark a run finished. */
export function finishGepaRun(
  sql: SqlExecutor,
  args: {
    runId: string;
    status: 'completed' | 'aborted';
    stopReason: GepaResult['stopReason'] | 'aborted';
    winnerId: string | null;
    metricCalls: number;
    iterations: number;
  },
): void {
  void sql`UPDATE gepa_runs
        SET ended_at     = ${nowMs()},
            status       = ${args.status},
            stop_reason  = ${args.stopReason},
            winner_id    = ${args.winnerId},
            metric_calls = ${args.metricCalls},
            iterations   = ${args.iterations}
        WHERE run_id = ${args.runId}`;
}

/** List recent runs (newest first). */
export interface GepaRunSummary {
  runId: string;
  target: string;
  targetRef: string | null;
  startedAt: number;
  endedAt: number | null;
  status: 'running' | 'completed' | 'aborted';
  stopReason: string | null;
  winnerId: string | null;
  metricCalls: number;
  iterations: number;
}

export function listGepaRuns(sql: SqlExecutor, limit = 20): GepaRunSummary[] {
  type Row = {
    run_id: string; target: string; target_ref: string | null;
    started_at: number; ended_at: number | null; status: string;
    stop_reason: string | null; winner_id: string | null;
    metric_calls: number; iterations: number;
  };
  const rows = sql<Row>`SELECT run_id, target, target_ref, started_at, ended_at,
                               status, stop_reason, winner_id, metric_calls, iterations
                          FROM gepa_runs
                          ORDER BY started_at DESC
                          LIMIT ${limit}`;
  return rows.map(r => ({
    runId: r.run_id,
    target: r.target,
    targetRef: r.target_ref,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    status: v.parse(GepaRunStatusSchema, r.status),
    stopReason: r.stop_reason,
    winnerId: r.winner_id,
    metricCalls: r.metric_calls,
    iterations: r.iterations,
  }));
}

/** Load every persisted candidate for a run (oldest first). */
export function loadGepaCandidates(
  sql: SqlExecutor,
  runId: string,
): GepaCandidate[] {
  type Row = {
    id: string; parent_id: string | null; source: string;
    scores_json: string; feedback_json: string;
    aggregate: number; created_at: number;
  };
  const rows = sql<Row>`SELECT id, parent_id, source, scores_json, feedback_json,
                               aggregate, created_at
                          FROM gepa_candidates
                          WHERE run_id = ${runId}
                          ORDER BY iteration ASC, created_at ASC`;
  return rows.map(r => {
    const scoresObj = v.parse(ScoreMapSchema, JSON.parse(r.scores_json));
    const feedbackObj = v.parse(FeedbackMapSchema, JSON.parse(r.feedback_json));
    return {
      id: r.id,
      parentId: r.parent_id,
      source: r.source,
      scores: new Map(Object.entries(scoresObj)),
      feedback: new Map(Object.entries(feedbackObj)),
      aggregateScore: r.aggregate,
      createdAt: r.created_at,
    };
  });
}

/** Build an onIteration hook that persists every state snapshot. The hook
 *  inserts each newly-accepted candidate, refreshes the Pareto snapshot,
 *  and updates run counters. */
export function makePersistingHook<I, E>(args: {
  sql: SqlExecutor;
  runId: string;
  evalSet: ReadonlyArray<EvalInstance<I, E>>;
  /** Set of candidate ids already persisted in this hook lifetime so we
   *  don't double-insert. The seed is persisted via persistGepaCandidate
   *  separately before the loop starts; pre-populate that id here. */
  persisted: Set<string>;
}): (state: GepaIterationState) => Promise<void> {
  const instanceIds = args.evalSet.map(i => i.id);
  return async (state) => {
    for (const cand of state.pool) {
      if (args.persisted.has(cand.id)) continue;
      persistGepaCandidate(args.sql, {
        runId: args.runId,
        candidate: cand,
        iteration: state.iteration,
        accepted: state.accepted,
      });
      args.persisted.add(cand.id);
    }
    persistGepaParetoSnapshot(args.sql, {
      runId: args.runId,
      pool: state.pool,
      instanceIds,
    });
    updateGepaRunCounters(args.sql, {
      runId: args.runId,
      metricCalls: state.metricCallsUsed,
      iterations: state.iteration + 1,
    });
  };
}
