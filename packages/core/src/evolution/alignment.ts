/**
 * K_align — the Alignment Convergence Rate.
 *
 * The one self-improvement metric computable from pure telemetry, with no
 * benchmark, no judge, and no LLM call: how often the user has to correct the
 * agent, per 100 graded turns, and whether that number is moving.
 *
 * It reads the `turn_outcomes` ledger (owned by outcomes.ts) and nothing else —
 * specifically, the rows a USER produced. Execution-sourced rows live in the
 * same ledger (the environment's verdict on turns nobody graded) and are
 * counted separately here rather than folded in: this metric's claim is about
 * how often a person had to correct the agent, and it would stop being true the
 * moment a workspace's headless traffic started moving the number.
 * Turns are segmented by the `scaffold_version` that served them, so each
 * segment is "how the agent behaved while it was THAT version of itself" and
 * the boundaries between segments are exactly the self-evolution events.
 *
 * Honesty is the whole point. A rate over a handful of turns is noise, so
 * every rate here ships with a 95% interval, every segment carries whether it
 * is precise enough to mean anything, and the trend refuses to name a
 * direction it cannot support.
 */

import { wilsonInterval } from '../utils/stats.js';
import type { SqlExecutor } from '../types/primitives.js';

/** A rate is worth reading when its 95% interval spans no more than 20 points
 *  per 100 turns (±10). This replaces an arbitrary minimum-n rule: precision
 *  is what actually decides whether a rate is informative, and the n needed to
 *  reach it falls out of the data (≈60 graded turns at a 20% rate, ≈95 at 50%,
 *  far fewer when the rate is near zero). */
const RELIABLE_INTERVAL_WIDTH = 0.2;

/** A proportion with its uncertainty, expressed per 100 turns. */
export interface RateInterval {
  /** Point estimate, per 100 turns. */
  per100: number;
  /** Bounds of the 95% interval, per 100 turns. */
  lowPer100: number;
  highPer100: number;
  /** False when the interval is too wide to read as a rate (see above). */
  reliable: boolean;
}

export interface AlignmentTotals {
  /** Turns a USER graded — the rate's denominator (accepted + corrected +
   *  frustrated, from explicit/classifier/take_pick rows). */
  turns: number;
  /** corrected + frustrated, among those. */
  negatives: number;
  /** Recorded but ungraded (no user verdict either way); excluded from the rate. */
  abandoned: number;
  /** Rows the ENVIRONMENT graded (source `execution`), not a person. Counted
   *  and reported, never folded into the rate: K_align is defined as how often
   *  the USER has to correct the agent, and a machine verdict about whether the
   *  agent's own commands ran answers a different question. Blending them would
   *  make the headline number drift with how much headless traffic a workspace
   *  saw. */
  executionGraded: number;
  rate: RateInterval;
  firstAt: number;
  lastAt: number;
}

/** One scaffold version's slice of the ledger. */
export interface AlignmentSegment extends AlignmentTotals {
  /** The scaffold version that served these turns; null for rows recorded
   *  before a version was attributed. */
  scaffoldVersion: number | null;
}

export type AlignmentTrend = 'improving' | 'worsening' | 'flat' | 'insufficient';

export interface AlignmentConvergence {
  /** Oldest first — the order the agent lived them. */
  segments: AlignmentSegment[];
  /** Every graded turn in the ledger, pooled. */
  overall: AlignmentTotals;
  trend: AlignmentTrend;
  /** Change in the correction rate from the earliest to the latest reliable
   *  segment, per 100 turns. Negative = fewer corrections = improving.
   *  Null when the trend is 'insufficient'. */
  deltaPer100: number | null;
  /** The two segments the trend compared, when a comparison was possible. */
  comparedVersions: { from: number | null; to: number | null } | null;
  /** Plain-language statement of what this does and does not establish. */
  note: string;
}

/**
 * Wilson score interval for a binomial proportion.
 *
 * Chosen over the textbook Wald interval because Wald is badly miscalibrated
 * exactly where this metric lives — small n and rates near zero, where it
 * produces impossible negative bounds and collapses to zero width at k=0.
 * Wilson holds close to nominal coverage at small n, never leaves [0, 1], and
 * stays informative at k=0 (it reports "at most X%", which is a real finding).
 * Clopper-Pearson would also be defensible but is needlessly conservative and
 * would need an incomplete-beta implementation for no gain here.
 */

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

/**
 * The trend, decided by whether the earliest and latest reliable segments'
 * 95% intervals overlap. Non-overlap is a deliberately conservative test —
 * stricter than a two-proportion test at the same nominal level — because the
 * failure mode this metric exists to prevent is reading a direction into
 * noise. Overlapping intervals report 'flat', which means "no change this
 * ledger can detect", not "provably unchanged".
 */
function decideTrend(
  segments: ReadonlyArray<AlignmentSegment>,
): Pick<AlignmentConvergence, 'trend' | 'deltaPer100' | 'comparedVersions'> {
  const reliable = segments.filter((s) => s.rate.reliable);
  const from = reliable[0];
  const to = reliable[reliable.length - 1];
  if (!from || !to || from === to) {
    return { trend: 'insufficient', deltaPer100: null, comparedVersions: null };
  }
  const trend: AlignmentTrend =
    to.rate.highPer100 < from.rate.lowPer100 ? 'improving'
    : to.rate.lowPer100 > from.rate.highPer100 ? 'worsening'
    : 'flat';
  return {
    trend,
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

/**
 * K_align over the whole `turn_outcomes` ledger. Pure read; returns an empty
 * result rather than throwing when the ledger does not exist — the same
 * contract every other reader over this table offers.
 */
export function alignmentConvergence(sql: SqlExecutor): AlignmentConvergence {
  let rows: RawSegmentRow[];
  try {
    rows = sql<RawSegmentRow>`
      SELECT scaffold_version,
             SUM(CASE WHEN outcome != 'abandoned' AND source != 'execution' THEN 1 ELSE 0 END) AS graded,
             SUM(CASE WHEN outcome IN ('corrected','frustrated') AND source != 'execution' THEN 1 ELSE 0 END) AS negatives,
             SUM(CASE WHEN outcome = 'abandoned' THEN 1 ELSE 0 END) AS abandoned,
             SUM(CASE WHEN source = 'execution' THEN 1 ELSE 0 END) AS execution_graded,
             MIN(created_at) AS first_at,
             MAX(created_at) AS last_at
      FROM turn_outcomes
      GROUP BY scaffold_version`;
  } catch {
    rows = [];
  }
  const segments = rows.map(toSegment).sort((a, b) => a.firstAt - b.firstAt);
  const overall = pool(segments);
  const trend = decideTrend(segments);
  return { segments, overall, ...trend, note: buildNote(segments, overall.turns, trend.trend) };
}

function formatRate(rate: RateInterval): string {
  return `${rate.per100.toFixed(1)} per 100 turns ` +
    `(95% CI ${rate.lowPer100.toFixed(1)}–${rate.highPer100.toFixed(1)}${rate.reliable ? '' : ', too wide to read'})`;
}

/** One compact block for terminal output. */
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
