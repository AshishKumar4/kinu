/** GEPA run and candidate persistence; survives DO hibernation. */

import * as v from 'valibot';
import type { RawSqlExec, SqlExecutor } from '../../types/primitives';
import type { ActorHandle } from '../../identity/actor-handle';
import { nanoid } from '../../utils/nanoid';
import { nowMs } from '../../utils/date';
import {
  computeParetoFront,
} from './pareto';
import { DEFAULT_GEPA_BUDGET } from './types';
import type {
  GepaBudget, GepaCandidate, GepaResult, GepaProgressHooks,
} from './types';

const GepaRunStatusSchema = v.picklist(['running', 'completed', 'aborted']);

const ScoreMapSchema = v.record(v.string(), v.number());

const FeedbackMapSchema = v.record(v.string(), v.string());

export function initGepaTables(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS gepa_runs (
    actor_id      TEXT NOT NULL,
    run_id        TEXT NOT NULL,
    target        TEXT NOT NULL,
    target_ref    TEXT,
    started_at    INTEGER NOT NULL,
    ended_at      INTEGER,
    status        TEXT NOT NULL CHECK (status IN ('running','completed','aborted')),
    stop_reason   TEXT,
    winner_id     TEXT,
    metric_calls  INTEGER NOT NULL DEFAULT 0,
    iterations    INTEGER NOT NULL DEFAULT 0,
    budget_json   TEXT NOT NULL,
    PRIMARY KEY (actor_id, run_id)
  )`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_gepa_runs_status_started
           ON gepa_runs(actor_id, status, started_at)`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_gepa_runs_target
           ON gepa_runs(actor_id, target, target_ref, started_at DESC)`);

  execRaw(`CREATE TABLE IF NOT EXISTS gepa_candidates (
    actor_id       TEXT NOT NULL,
    id             TEXT NOT NULL,
    run_id         TEXT NOT NULL,
    parent_id      TEXT,
    source         TEXT NOT NULL,
    scores_json    TEXT NOT NULL,
    feedback_json  TEXT NOT NULL,
    aggregate      REAL NOT NULL,
    created_at     INTEGER NOT NULL,
    iteration      INTEGER NOT NULL,
    accepted       INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (actor_id, id)
  )`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_gepa_candidates_run_iter
           ON gepa_candidates(actor_id, run_id, iteration)`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_gepa_candidates_run_aggregate
           ON gepa_candidates(actor_id, run_id, aggregate DESC)`);

}

/** Persists the fully resolved budget so the snapshot matches what runGepa used. */
export function startGepaRun(
  sql: SqlExecutor,
  actor: ActorHandle,
  opts: {
    target: 'scaffold' | 'prompt_section';
    targetRef?: string | null;
    budget?: Partial<GepaBudget>;
  },
): string {
  actor.assertCurrent();
  const runId = `gepa-${nanoid()}`;
  const startedAt = nowMs();
  const budgetJson = JSON.stringify({ ...DEFAULT_GEPA_BUDGET, ...opts.budget });
  void sql`INSERT INTO gepa_runs
        (actor_id, run_id, target, target_ref, started_at, ended_at, status, stop_reason,
         winner_id, metric_calls, iterations, budget_json)
        VALUES (${actor.actorId}, ${runId}, ${opts.target}, ${opts.targetRef ?? null}, ${startedAt},
                ${null}, ${'running'}, ${null}, ${null}, ${0}, ${0}, ${budgetJson})`;

  return runId;
}

export function persistGepaCandidate(
  sql: SqlExecutor,
  actor: ActorHandle,
  args: {
    runId: string;
    candidate: GepaCandidate;
    iteration: number;
    accepted: boolean;
  },
): void {
  actor.assertCurrent();
  const scoresJson = JSON.stringify(Object.fromEntries(args.candidate.scores));
  const feedbackJson = JSON.stringify(Object.fromEntries(args.candidate.feedback));
  void sql`INSERT INTO gepa_candidates
        (actor_id, id, run_id, parent_id, source, scores_json, feedback_json,
         aggregate, created_at, iteration, accepted)
        VALUES (${actor.actorId}, ${args.candidate.id}, ${args.runId}, ${args.candidate.parentId},
                ${args.candidate.source}, ${scoresJson}, ${feedbackJson},
                ${args.candidate.aggregateScore}, ${args.candidate.createdAt},
                ${args.iteration}, ${args.accepted ? 1 : 0})`;
}


/** Mid-run, so a hibernating DO can resume. */
function updateGepaRunCounters(
  sql: SqlExecutor,
  actor: ActorHandle,
  args: { runId: string; metricCalls: number; iterations: number },
): void {
  actor.assertCurrent();
  void sql`UPDATE gepa_runs SET metric_calls = ${args.metricCalls},
                            iterations   = ${args.iterations}
        WHERE actor_id = ${actor.actorId} AND run_id = ${args.runId}`;
}

export function finishGepaRun(
  sql: SqlExecutor,
  actor: ActorHandle,
  args: {
    runId: string;
    status: 'completed' | 'aborted';
    stopReason: GepaResult['stopReason'] | 'aborted';
    winnerId: string | null;
    metricCalls: number;
    iterations: number;
  },
): void {
  actor.assertCurrent();
  void sql`UPDATE gepa_runs
        SET ended_at     = ${nowMs()},
            status       = ${args.status},
            stop_reason  = ${args.stopReason},
            winner_id    = ${args.winnerId},
            metric_calls = ${args.metricCalls},
            iterations   = ${args.iterations}
        WHERE actor_id = ${actor.actorId} AND run_id = ${args.runId}`;
}

/**
 * When each `target_ref` under one target last had a pass started (running and aborted
 * passes count). Lets target rotation be derived from the durable ledger: an in-memory
 * cursor dies with DO eviction at 2-5 minutes idle (`do.facet.eviction_joint`).
 */
export function lastGepaRunPerTarget(
  sql: SqlExecutor, actor: ActorHandle, target: string,
): Map<string, number> {
  actor.assertCurrent();

  const rows = sql<{ target_ref: string; started_at: number }>`
    SELECT target_ref, MAX(started_at) AS started_at FROM gepa_runs
    WHERE actor_id = ${actor.actorId} AND target = ${target} AND target_ref IS NOT NULL
    GROUP BY target_ref`;

  return new Map(rows.map((row) => [row.target_ref, row.started_at]));
}

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

export function listGepaRuns(sql: SqlExecutor, actor: ActorHandle, limit = 20): GepaRunSummary[] {
  actor.assertCurrent();

  type Row = {
    run_id: string; target: string; target_ref: string | null;
    started_at: number; ended_at: number | null; status: string;
    stop_reason: string | null; winner_id: string | null;
    metric_calls: number; iterations: number;
  };

  const rows = sql<Row>`SELECT run_id, target, target_ref, started_at, ended_at,
                               status, stop_reason, winner_id, metric_calls, iterations
                          FROM gepa_runs
                          WHERE actor_id = ${actor.actorId}
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

/** Oldest first. */
export function loadGepaCandidates(
  sql: SqlExecutor,
  actor: ActorHandle,
  runId: string,
): GepaCandidate[] {
  actor.assertCurrent();

  type Row = {
    id: string; parent_id: string | null; source: string;
    scores_json: string; feedback_json: string;
    aggregate: number; created_at: number;
  };

  const rows = sql<Row>`SELECT id, parent_id, source, scores_json, feedback_json,
                               aggregate, created_at
                          FROM gepa_candidates
                          WHERE actor_id = ${actor.actorId} AND run_id = ${runId}
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

/** Retain measured candidates at measurement and counters at iteration completion. */
export function makePersistingHooks(args: {
  sql: SqlExecutor;
  actor: ActorHandle;
  runId: string;
}): Required<GepaProgressHooks> {
  return {
    onCandidate: ({ candidate, iteration }) => {
      persistGepaCandidate(args.sql, args.actor, {
        runId: args.runId, candidate, iteration, accepted: true,
      });
    },
    onIteration: state => {
      updateGepaRunCounters(args.sql, args.actor, { runId: args.runId,
        metricCalls: state.metricCallsUsed, iterations: state.iteration + 1 });
    },
  };
}

/** Computed from score maps; no persisted membership state. */
export interface GepaParetoEntry {
  readonly candidateId: string;
  readonly instanceId: string;
  readonly score: number;
}

/** Derived from accepted candidates' stored score keys; rejected ones never entered the pool. */
export function loadGepaParetoFront(
  sql: SqlExecutor, actor: ActorHandle, runId: string,
): GepaParetoEntry[] {
  actor.assertCurrent();

  const rows = sql<{ id: string; scores_json: string }>`
    SELECT id, scores_json FROM gepa_candidates
    WHERE actor_id = ${actor.actorId} AND run_id = ${runId} AND accepted = 1`;

  if (rows.length === 0) return [];

  const pool = rows.map((r): GepaCandidate => {
    const scoresObj = v.parse(ScoreMapSchema, JSON.parse(r.scores_json));

    return {
      id: r.id,
      parentId: null,
      source: '',
      scores: new Map(Object.entries(scoresObj)),
      feedback: new Map(),
      aggregateScore: 0,
      createdAt: 0,
    };
  });

  const instanceIds = [...new Set(pool.flatMap((c) => [...c.scores.keys()]))];
  const { front } = computeParetoFront(pool, instanceIds);
  const entries: GepaParetoEntry[] = [];

  for (const candidate of front) {
    for (const [instanceId, score] of candidate.scores) {
      entries.push({ candidateId: candidate.id, instanceId, score });
    }
  }

  return entries.sort((a, b) =>
    a.instanceId.localeCompare(b.instanceId) || a.candidateId.localeCompare(b.candidateId));
}
