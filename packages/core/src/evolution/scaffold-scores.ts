import { markStoreChanged } from '@kinu.run/agent-utils';
/** The quality curve: per promoted scaffold version, its score on labeled turns. GEPA's held-out score if it proposed
 *  the version, else a replay (`control.ts`); a failed scoring is a point, never retried. */

import * as v from 'valibot';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import { tolerate } from '../obs/index';
import { parseJsonValue } from '../utils/json';
import { scoreInterval, type ScoreInterval } from '../utils/stats';
import type {
  ScaffoldScore, ScaffoldScoreSource, ScoreDirection, ScoredInstance,
} from '../types/evolution';

export type { ScaffoldScore, ScaffoldScoreSource, ScoreDirection, ScoredInstance } from '../types/evolution';

/** Each costs a rollout and a judge call; the 95% half-width at mean 0.5 is ±0.20 at 20. */
export const REPLAY_SAMPLE_SIZE = 20;

/** The quality panel's floor: below it, a scaffold answers worse than a coin. */
export const DEFAULT_QUALITY_THRESHOLD = 0.5;

const ScoredInstanceSchema = v.object({ id: v.string(), score: v.number(), feedback: v.string() });

export function initScaffoldScoreTables(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS scaffold_scores (
    actor_id TEXT NOT NULL,
    scaffold_version INTEGER NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('gepa', 'replay')),
    promoted_at INTEGER,
    scored_at INTEGER,
    mean_score REAL,
    score_lo REAL,
    score_hi REAL,
    sample_size INTEGER NOT NULL DEFAULT 0,
    failure TEXT,
    details TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (actor_id, scaffold_version)
  )`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_scaffold_scores_promoted
             ON scaffold_scores(actor_id, promoted_at DESC)`);
}

/** GEPA's held-out score of the version it proposes: its point if promoted. */
export function recordProposedScore(
  sql: SqlExecutor, actor: ActorHandle, { version, results, now = Date.now() }: ScoredPoint,
): void {
  actor.assertCurrent();
  const interval = scoreInterval(results.map((r) => r.score));

  void sql`INSERT INTO scaffold_scores
      (actor_id, scaffold_version, source, scored_at, mean_score, score_lo, score_hi, sample_size, details)
    VALUES (${actor.actorId}, ${version}, 'gepa', ${now}, ${interval.mean}, ${interval.lo}, ${interval.hi},
            ${interval.n}, ${JSON.stringify(results)})
    ON CONFLICT (actor_id, scaffold_version) DO NOTHING`;
  markStoreChanged(sql);
}

/** The version went live: scored already by GEPA, or due a replay. */
export function markPromoted(sql: SqlExecutor, actor: ActorHandle, version: number, now: number = Date.now()): void {
  actor.assertCurrent();
  void sql`INSERT INTO scaffold_scores (actor_id, scaffold_version, source, promoted_at)
    VALUES (${actor.actorId}, ${version}, 'replay', ${now})
    ON CONFLICT (actor_id, scaffold_version) DO UPDATE SET promoted_at = excluded.promoted_at`;
  markStoreChanged(sql);
}

/** Promoted versions with no point yet, oldest first. */
export function dueScaffoldScores(sql: SqlExecutor, actor: ActorHandle): number[] {
  actor.assertCurrent();

  return sql<{ scaffold_version: number }>`SELECT scaffold_version FROM scaffold_scores
    WHERE actor_id = ${actor.actorId} AND promoted_at IS NOT NULL AND scored_at IS NULL
    ORDER BY promoted_at ASC`.map((r) => r.scaffold_version);
}

interface ScoredPoint {
  readonly version: number;
  readonly results: readonly ScoredInstance[];
  readonly now?: number;
}

export function recordReplayScore(
  sql: SqlExecutor, actor: ActorHandle, scored: ScoredPoint | (Omit<ScoredPoint, 'results'> & { readonly failure: string }),
): void {
  actor.assertCurrent();
  const { version, now = Date.now() } = scored;

  if ('failure' in scored) {
    void sql`UPDATE scaffold_scores SET scored_at = ${now}, failure = ${scored.failure}
      WHERE actor_id = ${actor.actorId} AND scaffold_version = ${version}`;
  } else {
    const interval = scoreInterval(scored.results.map((r) => r.score));

    void sql`UPDATE scaffold_scores
      SET scored_at = ${now}, mean_score = ${interval.mean}, score_lo = ${interval.lo}, score_hi = ${interval.hi},
          sample_size = ${interval.n}, details = ${JSON.stringify(scored.results)}
      WHERE actor_id = ${actor.actorId} AND scaffold_version = ${version}`;
  }

  markStoreChanged(sql);
}

function scoreDirection(current: ScoreInterval, previous: ScoreInterval | undefined): ScoreDirection {
  if (previous === undefined) return 'reached';

  if (current.lo > previous.hi) return 'improved';

  if (current.hi < previous.lo) return 'declined';

  return 'held';
}

/** The curve, newest promotion first. */
export function listScaffoldScores(sql: SqlExecutor, actor: ActorHandle, limit = 50): ScaffoldScore[] {
  actor.assertCurrent();

  const rows = sql<{
    scaffold_version: number; source: ScaffoldScoreSource; promoted_at: number; scored_at: number;
    mean_score: number | null; score_lo: number | null; score_hi: number | null; sample_size: number;
    failure: string | null; details: string;
  }>`SELECT * FROM scaffold_scores
    WHERE actor_id = ${actor.actorId} AND promoted_at IS NOT NULL AND scored_at IS NOT NULL
    ORDER BY promoted_at DESC, scaffold_version DESC LIMIT ${limit}`;

  const oldest = rows.at(-1);

  // The scored point before the page gives its oldest point a direction.
  const before = oldest === undefined ? [] : sql<{ mean_score: number; score_lo: number; score_hi: number; sample_size: number }>`
    SELECT mean_score, score_lo, score_hi, sample_size FROM scaffold_scores
    WHERE actor_id = ${actor.actorId} AND promoted_at IS NOT NULL AND mean_score IS NOT NULL
      AND (promoted_at < ${oldest.promoted_at} OR (promoted_at = ${oldest.promoted_at} AND scaffold_version < ${oldest.scaffold_version}))
    ORDER BY promoted_at DESC, scaffold_version DESC LIMIT 1`;

  const intervals = [...rows, ...before].map((r) => (r.mean_score === null || r.score_lo === null || r.score_hi === null
    ? null
    : { mean: r.mean_score, lo: r.score_lo, hi: r.score_hi, n: r.sample_size }));

  return rows.map((row, index) => {
    const interval = intervals[index] ?? null;
    // Tolerable: the summary numbers live in the row's own columns.
    const details = v.safeParse(v.array(ScoredInstanceSchema), tolerate(() => parseJsonValue(row.details), 'malformed-input'));
    const previous = intervals.slice(index + 1).find((p) => p !== null) ?? undefined;

    return {
      version: row.scaffold_version,
      source: row.source,
      promotedAt: row.promoted_at,
      scoredAt: row.scored_at,
      interval,
      failure: row.failure,
      direction: interval === null ? null : scoreDirection(interval, previous),
      results: details.success ? details.output : [],
    };
  });
}
