/**
 * K_align: user corrections per 100 user-graded turns, segmented by the
 * `scaffold_version` that served them. Execution-sourced rows are counted
 * separately, never folded into the rate. Every rate ships with a 95% interval.
 */

import { wilsonInterval } from '../utils/stats';
import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import { tableExists } from '../identity/schema';

/** A rate is readable when its 95% interval spans at most 20 points per 100 turns; precision, not a minimum n, decides. */
const RELIABLE_INTERVAL_WIDTH = 0.2;

export interface RateInterval {
  per100: number;
  /** 95% interval bounds, per 100 turns. */
  lowPer100: number;
  highPer100: number;
  reliable: boolean;
}

export interface AlignmentTotals {
  /** User-graded turns (accepted + corrected + frustrated): the denominator. */
  turns: number;
  negatives: number;
  /** Recorded but ungraded; excluded from the rate. */
  abandoned: number;
  /** Environment-graded rows; reported, never folded into the rate. */
  executionGraded: number;
  rate: RateInterval;
  firstAt: number;
  lastAt: number;
}

export interface AlignmentSegment extends AlignmentTotals {
  /** Null for rows recorded before a version was attributed. */
  scaffoldVersion: number | null;
}

export type AlignmentTrend = 'improving' | 'worsening' | 'flat' | 'insufficient';

export interface AlignmentConvergence {
  /** Oldest first. */
  segments: AlignmentSegment[];
  overall: AlignmentTotals;
  trend: AlignmentTrend;
  /** Earliest to latest reliable segment; negative = improving. Null when the trend is 'insufficient'. */
  deltaPer100: number | null;
  comparedVersions: { from: number | null; to: number | null } | null;
  note: string;
}

/** Wilson score interval: unlike Wald, stays within [0, 1] and informative at small n and k=0. */

function rateInterval(negatives: number, turns: number): RateInterval {
  const { lo: low, hi: high } = wilsonInterval(negatives, turns);

  return {
    per100: turns > 0 ? (negatives / turns) * 100 : 0,
    lowPer100: low * 100,
    highPer100: high * 100,
    reliable: turns > 0 && high - low <= RELIABLE_INTERVAL_WIDTH,
  };
}

interface RawSegmentRow {
  scaffold_version: number | null;
  graded: number;
  negatives: number;
  abandoned: number;
  execution_graded: number;
  first_at: number;
  last_at: number;
}

function toSegment(row: RawSegmentRow): AlignmentSegment {
  return {
    scaffoldVersion: row.scaffold_version,
    turns: row.graded,
    negatives: row.negatives,
    abandoned: row.abandoned,
    executionGraded: row.execution_graded,
    rate: rateInterval(row.negatives, row.graded),
    firstAt: row.first_at,
    lastAt: row.last_at,
  };
}

function pool(segments: ReadonlyArray<AlignmentSegment>): AlignmentTotals {
  const sum = (pick: (s: AlignmentSegment) => number): number => segments.reduce((n, s) => n + pick(s), 0);
  const turns = sum((s) => s.turns);
  const negatives = sum((s) => s.negatives);

  return {
    turns,
    negatives,
    abandoned: sum((s) => s.abandoned),
    executionGraded: sum((s) => s.executionGraded),
    rate: rateInterval(negatives, turns),
    firstAt: segments.length > 0 ? Math.min(...segments.map((s) => s.firstAt)) : 0,
    lastAt: segments.length > 0 ? Math.max(...segments.map((s) => s.lastAt)) : 0,
  };
}

function intervalTrend(from: RateInterval, to: RateInterval): AlignmentTrend {
  if (to.highPer100 < from.lowPer100) return 'improving';

  if (to.lowPer100 > from.highPer100) return 'worsening';

  return 'flat';
}

/** Direction only when the earliest and latest reliable segments' 95% intervals do not overlap; 'flat' means no detectable change. */
function decideTrend(
  segments: ReadonlyArray<AlignmentSegment>,
): Pick<AlignmentConvergence, 'trend' | 'deltaPer100' | 'comparedVersions'> {
  const reliable = segments.filter((s) => s.rate.reliable);
  const from = reliable[0];
  const to = reliable[reliable.length - 1];

  if (!from || !to || from === to) {
    return { trend: 'insufficient', deltaPer100: null, comparedVersions: null };
  }

  return {
    trend: intervalTrend(from.rate, to.rate),
    deltaPer100: to.rate.per100 - from.rate.per100,
    comparedVersions: { from: from.scaffoldVersion, to: to.scaffoldVersion },
  };
}

function buildNote(segments: ReadonlyArray<AlignmentSegment>, gradedTurns: number, trend: AlignmentTrend): string {
  if (gradedTurns === 0) return 'No graded turns recorded yet — K_align is undefined.';

  if (trend === 'insufficient') {
    return segments.some((s) => s.rate.reliable)
      ? 'Only one scaffold version has enough graded turns to read — there is no before/after to compare yet.'
      : `Too few graded turns to read a rate: every scaffold segment's 95% interval is wider than ` +
        `±${(RELIABLE_INTERVAL_WIDTH / 2) * 100} points per 100 turns. Nothing here is a signal yet.`;
  }

  if (trend === 'flat') {
    return 'The intervals overlap: no change is detectable at this sample size. That is not evidence of no change.';
  }

  return `The correction rate ${trend === 'improving' ? 'fell' : 'rose'} by more than both 95% intervals allow for chance.`;
}

/** Pure read; empty result when the ledger does not exist. */
export function alignmentConvergence(sql: SqlExecutor, actor: ActorHandle): AlignmentConvergence {
  actor.assertCurrent();

  // Asked rather than caught: a catch cannot tell a missing table from a locked database.
  const rows: RawSegmentRow[] = tableExists(sql, 'turn_outcomes')
    ? sql<RawSegmentRow>`
        SELECT scaffold_version,
               SUM(CASE WHEN outcome != 'abandoned' AND source != 'execution' THEN 1 ELSE 0 END) AS graded,
               SUM(CASE WHEN outcome IN ('corrected','frustrated') AND source != 'execution' THEN 1 ELSE 0 END) AS negatives,
               SUM(CASE WHEN outcome = 'abandoned' THEN 1 ELSE 0 END) AS abandoned,
               SUM(CASE WHEN source = 'execution' THEN 1 ELSE 0 END) AS execution_graded,
               MIN(created_at) AS first_at,
               MAX(created_at) AS last_at
        FROM turn_outcomes
        WHERE actor_id = ${actor.actorId}
        GROUP BY scaffold_version`
    : [];

  const segments = rows.map(toSegment).sort((a, b) => a.firstAt - b.firstAt);
  const overall = pool(segments);
  const trend = decideTrend(segments);

  return { segments, overall, ...trend, note: buildNote(segments, overall.turns, trend.trend) };
}

function formatRate(rate: RateInterval): string {
  return `${rate.per100.toFixed(1)} per 100 turns ` +
    `(95% CI ${rate.lowPer100.toFixed(1)}–${rate.highPer100.toFixed(1)}${rate.reliable ? '' : ', too wide to read'})`;
}

export function renderAlignmentConvergence(k: AlignmentConvergence): string {
  const delta = k.deltaPer100 === null ? '' :
    ` (${k.deltaPer100 > 0 ? '+' : ''}${k.deltaPer100.toFixed(1)} per 100 turns` +
    `${k.comparedVersions ? `, v${k.comparedVersions.from ?? '?'} → v${k.comparedVersions.to ?? '?'}` : ''})`;

  const lines = [
    'K_align — correction rate (corrected + frustrated), 95% Wilson intervals',
    `Overall: ${formatRate(k.overall.rate)} over ${k.overall.turns} user-graded turns` +
      (k.overall.abandoned > 0 ? ` (+${k.overall.abandoned} abandoned, ungraded)` : '') +
      (k.overall.executionGraded > 0
        ? ` (+${k.overall.executionGraded} execution-graded, not a user verdict — excluded)`
        : ''),
    `Trend: ${k.trend}${delta}`,
    k.note,
  ];

  if (k.segments.length > 0) {
    lines.push('By scaffold version (oldest first):');

    for (const s of k.segments) {
      lines.push(`  v${s.scaffoldVersion ?? '?'}  n=${s.turns}  ${formatRate(s.rate)}`);
    }
  }

  return lines.join('\n');
}
