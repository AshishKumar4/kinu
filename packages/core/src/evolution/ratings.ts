/**
 * How satisfied the user was with a turn, read from their next message: the one signal evolution decides by
 * (docs/EVOLUTION-REDESIGN.md §1). A thumb or a take pick is the user's own word and wins; otherwise the decision
 * model rates. A turn nobody answered stays unrated: no rule infers a verdict from tool exits.
 */

import * as v from 'valibot';
import { markStoreChanged } from '@kinu.run/agent-utils';
import type { SqlExecutor, RawSqlExec } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import type { CompletedTurn, ToolCallRecord } from './types';
import type { DecisionPort, DecisionQuestion } from '../providers/decision-model';
import { evidenceWindow } from '../utils/evidence-window';
import { EVIDENCE_BUDGETS } from '../types/evidence';
import { sqlCheckList } from '../identity/schema';
import { nanoid } from '../utils/nanoid';
import { nowMs } from '../utils/date';
import { scoreInterval, wilsonInterval, type ScoreInterval } from '../utils/stats';
import { KinuError, settle } from '../obs/index';
import type { QualityDay } from '../types/quality';
import { Effect } from 'effect';
import type { ScaffoldArchiveEntry } from '../scaffold/archive';

const TRIVIAL_MESSAGE = new RegExp(
  '^\\s*(hi|hiya|hey|hello|yo|sup|thanks?|thank you|thx|ty|ok(ay)?|k|kk|cool|nice|great|awesome|perfect|' +
  'good (morning|afternoon|evening|night)|gm|gn|bye|goodbye|see ya|cya|lol|haha)[\\s!.\\u2026]*$',
  'i',
);

/** A trivial turn is not rated: it ran no tools and the user message is a stock
 *  pleasantry or too short to be a real request. */
export function isTrivialTurn(turn: Pick<CompletedTurn, 'userMessage' | 'toolCalls'>): boolean {
  if (turn.toolCalls.length > 0) return false;
  const msg = turn.userMessage.trim();

  if (TRIVIAL_MESSAGE.test(msg)) return true;

  return msg.length < 12 && !msg.includes('?');
}

/** High and low ratings per scaffold version, the archive's real-use evidence. */
export interface RealOutcomeRate {
  accepted: number;
  negative: number;
}

/** Blends rated outcomes into archive win-rates and trials for branch-base
 *  selection. Pure; never mutates. */
export function blendRealOutcomeRates(
  archive: ReadonlyArray<ScaffoldArchiveEntry>,
  rates: ReadonlyMap<number, RealOutcomeRate>,
): ScaffoldArchiveEntry[] {
  return archive.map((e) => {
    const real = rates.get(e.version);
    const realDecisive = real ? real.accepted + real.negative : 0;

    if (!real || realDecisive === 0) return e;
    const shadowDecisive = e.wins + e.losses;

    return {
      ...e,
      trials: e.trials + realDecisive,
      winRate: (e.wins + real.accepted) / (shadowDecisive + realDecisive),
    };
  });
}

/** Strongest first; the effective rating of a turn is its strongest source's newest row. */
export const RATING_SOURCES = ['thumbs', 'take_pick', 'model'] as const;

export type RatingSource = (typeof RATING_SOURCES)[number];

const WRONG_REASONS = [
  'nothing', 'misunderstood', 'incomplete', 'incorrect', 'ignored_instruction', 'broke_something',
  'unrecovered_error', 'verbose_or_slow', 'needless_question',
] as const;

export type WrongReason = (typeof WRONG_REASONS)[number];

/** Measured on 185 Kinu turns (kinu-logs/evals-fast/clef-satisfaction): this `corrected` wording keeps new
 *  information and changed requirements out of corrections while catching every written correction and repeat. */
const RATING_QUESTIONS = {
  satisfaction: {
    type: 'score',
    instructions: "Judge the agent's turn by the user's next message. How satisfied is the user with that turn?",
    criteria: [
      'Very dissatisfied: the user rejects the result, complains, or gives up',
      'Dissatisfied: the user corrects the agent or asks again for what they already asked',
      'Neutral: the reply says nothing about the turn either way',
      'Satisfied: the user builds on the result or moves to the next task',
      'Very satisfied: the user explicitly approves or thanks',
    ],
  },
  corrected: {
    type: 'noul',
    instructions: "Did the user's next message say the agent got something wrong, left part of the request undone, "
      + 'or ask again for something the agent should already have done? New information, a changed requirement '
      + 'or a new task is not a correction.',
  },
  wrong: {
    type: 'choice',
    instructions: "What went wrong in the agent's turn, as the user's next message shows it?",
    criteria: {
      nothing: 'Nothing; the user accepts the turn, moves on, or brings new information or a changed requirement',
      misunderstood: 'The agent misread what the user asked',
      incomplete: 'The agent did only part of the task',
      incorrect: 'The result or answer is wrong',
      ignored_instruction: 'The agent ignored an explicit instruction or constraint',
      broke_something: 'The agent damaged or removed something the user had',
      unrecovered_error: 'A tool or step failed and the agent did not recover',
      verbose_or_slow: 'Too long, too slow, or too much back-and-forth',
      needless_question: 'The agent asked something it could have found out itself',
    } satisfies Record<WrongReason, string>,
  },
} as const satisfies Record<string, DecisionQuestion>;

/** A rating on the 1-5 scale; `corrected` is a probability; `wrong` is null where the source gives no reason. */
export interface RatingVerdict {
  readonly score: number;
  readonly corrected: number;
  readonly wrong: WrongReason | null;
}

export interface TurnRating extends RatingVerdict {
  readonly id: string;
  readonly turnId: string;
  readonly source: RatingSource;
  readonly request: string;
  readonly actions: string;
  readonly answer: string;
  readonly followup: string | null;
  readonly scaffoldVersion: number | null;
  readonly createdAt: number;
}

/** Below this a rating rounds to 2 or lower: the user corrected, repeated or gave up. */
const LOW_BELOW = 2.5;

/** From this a rating rounds to 4 or 5: the user built on the turn or approved it. */
const HIGH_FROM = 3.5;

export function isLowRating(score: number): boolean {
  return score < LOW_BELOW;
}

export function isHighRating(score: number): boolean {
  return score >= HIGH_FROM;
}

/** The turn's feedback as the review hands it on: a neutral rating is none. */
export function feedbackOf(score: number): 'positive' | 'negative' | null {
  if (isLowRating(score)) return 'negative';

  return isHighRating(score) ? 'positive' : null;
}

/** The craft EMA's quality for a rated turn. */
export function ratingQuality(score: number): number {
  return score / 5;
}

export function thumbsRating(feedback: 'positive' | 'negative'): RatingVerdict {
  return feedback === 'positive'
    ? { score: 5, corrected: 0, wrong: null }
    : { score: 1, corrected: 1, wrong: null };
}

/** Picking the delivered answer builds on it; picking an alternate rejects it. */
export function takePickRating(delivered: boolean): RatingVerdict {
  return delivered
    ? { score: 4, corrected: 0, wrong: null }
    : { score: 2, corrected: 1, wrong: null };
}

const ACTIONS_LISTED = 40;

const ACTION_TARGET_CHARS = 80;

const TargetSchema = v.pipe(v.string(), v.trim(), v.nonEmpty());

/** The first line of the argument that says what a call acted on. */
function actionTarget(args: ToolCallRecord['args']): string {
  for (const key of ['path', 'action', 'command', 'code']) {
    const value = v.safeParse(TargetSchema, args[key]);

    if (value.success) return (value.output.split('\n')[0] ?? '').slice(0, ACTION_TARGET_CHARS);
  }

  return '';
}

function callStatus(call: ToolCallRecord): string {
  if (call.outcome === undefined) return 'unknown';

  return call.outcome.success ? 'ok' : 'failed';
}

/** One line per call with its status: what the agent did, without the bulk of what came back. */
export function renderActions(calls: readonly ToolCallRecord[]): string {
  const lines = calls.slice(0, ACTIONS_LISTED).map((call) => {
    const target = actionTarget(call.args);

    return `- ${call.name}${target ? ` ${target}` : ''} -> ${callStatus(call)}`;
  });

  if (calls.length > ACTIONS_LISTED) lines.push(`- ... ${calls.length - ACTIONS_LISTED} more calls`);

  return lines.join('\n');
}

export interface RatedTurnInput {
  readonly request: string;
  readonly actions: string;
  readonly answer: string;
  readonly followup: string;
}

function renderState(turn: RatedTurnInput, calls: number): string {
  return [
    `USER REQUEST:\n${evidenceWindow(turn.request, EVIDENCE_BUDGETS.outcomeUserMessage)}`,
    `AGENT ACTIONS (${calls} tool calls):\n${turn.actions || '(none)'}`,
    `AGENT FINAL ANSWER:\n${evidenceWindow(turn.answer, EVIDENCE_BUDGETS.outcomeAssistantResponse)}`,
    `USER'S NEXT MESSAGE:\n${evidenceWindow(turn.followup, EVIDENCE_BUDGETS.outcomeFollowup)}`,
  ].join('\n\n');
}

/**
 * The decision model's rating of one answered turn; its `score` is 0-based, the scale here 1-5. Null when the model
 * refused for a reason only the owner can fix: the turn stays unrated and nothing retries it.
 */
export async function rateTurn(decide: DecisionPort, turn: RatedTurnInput, calls: number): Promise<RatingVerdict | null> {
  const result = await decide({ state: renderState(turn, calls), questions: RATING_QUESTIONS });

  if (result === null) return null;
  const { satisfaction, corrected, wrong } = result.answers;
  const reason = wrong?.type === 'choice' ? WRONG_REASONS.find((r) => r === wrong.choice) : undefined;

  if (satisfaction?.type !== 'score' || corrected?.type !== 'noul' || reason === undefined) {
    return settle(Effect.fail(new KinuError('bad_input', 'the decision model left a rating question unanswered')));
  }

  return {
    score: Math.min(5, Math.max(1, satisfaction.score + 1)),
    corrected: Math.min(1, Math.max(0, corrected.noul)),
    wrong: reason,
  };
}

const TURN_RATINGS_DDL = `(
    actor_id TEXT NOT NULL,
    id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    score REAL NOT NULL CHECK (score >= 1 AND score <= 5),
    corrected REAL NOT NULL CHECK (corrected >= 0 AND corrected <= 1),
    wrong TEXT CHECK (wrong IN (${sqlCheckList(WRONG_REASONS)})),
    source TEXT NOT NULL CHECK (source IN (${sqlCheckList(RATING_SOURCES)})),
    request TEXT NOT NULL,
    actions TEXT NOT NULL,
    answer TEXT NOT NULL,
    followup TEXT,
    scaffold_version INTEGER,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (actor_id, id)
  )`;

export function initTurnRatingTables(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS turn_ratings ${TURN_RATINGS_DDL}`);
  execRaw('CREATE INDEX IF NOT EXISTS idx_turn_ratings_actor ON turn_ratings(actor_id, created_at DESC, id DESC)');
  execRaw('CREATE INDEX IF NOT EXISTS idx_turn_ratings_actor_turn ON turn_ratings(actor_id, turn_id)');
}

export interface RecordTurnRatingInput extends RatingVerdict {
  readonly turnId: string;
  readonly source: RatingSource;
  readonly request: string;
  readonly actions?: string;
  readonly answer: string;
  readonly followup?: string | null;
  readonly scaffoldVersion?: number | null;
  readonly now?: number;
}

/** Append-only; readers resolve the effective rating per turn. */
export function recordTurnRating(sql: SqlExecutor, actor: ActorHandle, input: RecordTurnRatingInput): string {
  actor.assertCurrent();

  const id = `rate-${nanoid()}`;

  const followup = input.followup === null || input.followup === undefined
    ? null
    : evidenceWindow(input.followup, EVIDENCE_BUDGETS.storedFollowup);

  void sql`INSERT INTO turn_ratings
      (actor_id, id, turn_id, score, corrected, wrong, source, request, actions, answer, followup, scaffold_version, created_at)
    VALUES
      (${actor.actorId}, ${id}, ${input.turnId}, ${input.score}, ${input.corrected}, ${input.wrong}, ${input.source},
       ${evidenceWindow(input.request, EVIDENCE_BUDGETS.storedUserMessage)}, ${input.actions ?? ''},
       ${evidenceWindow(input.answer, EVIDENCE_BUDGETS.storedAssistantResponse)}, ${followup},
       ${input.scaffoldVersion ?? null}, ${input.now ?? nowMs()})`;
  markStoreChanged(sql);

  return id;
}

interface RawRatingRow {
  id: string; turn_id: string; score: number; corrected: number; wrong: WrongReason | null; source: RatingSource;
  request: string; actions: string; answer: string; followup: string | null; scaffold_version: number | null;
  created_at: number;
}

function toRating(row: RawRatingRow): TurnRating {
  return {
    id: row.id, turnId: row.turn_id, score: row.score, corrected: row.corrected, wrong: row.wrong,
    source: row.source, request: row.request, actions: row.actions, answer: row.answer, followup: row.followup,
    scaffoldVersion: row.scaffold_version, createdAt: row.created_at,
  };
}

export interface RatingQuery {
  /** Newest first; unbounded when absent. */
  readonly limit?: number;
  /** These turns' ratings, whenever made; `since` bounds only a window. */
  readonly turnIds?: readonly string[];
  readonly since?: number;
  readonly low?: boolean;
  readonly high?: boolean;
}

/**
 * One effective rating per turn, newest first: the row no stronger source and no newer row of its source outranks
 * (`RATING_SOURCES`). Turn ids lead the join so each probes `idx_turn_ratings_actor_turn`; a window walks
 * `idx_turn_ratings_actor` in order and stops at the limit.
 */
export function listTurnRatings(sql: SqlExecutor, actor: ActorHandle, query: RatingQuery = {}): TurnRating[] {
  actor.assertCurrent();
  const [p0, p1] = RATING_SOURCES;
  // Unfiltered bounds sit outside the 1-5 scale.
  const below = query.low === true ? LOW_BELOW : 6;
  const from = query.high === true ? HIGH_FROM : 0;
  const limit = query.limit ?? -1;

  const rows = query.turnIds === undefined
    ? sql<RawRatingRow>`
      SELECT r.* FROM turn_ratings r
      WHERE r.actor_id = ${actor.actorId} AND r.created_at >= ${query.since ?? 0}
        AND r.score < ${below} AND r.score >= ${from}
        AND NOT EXISTS (SELECT 1 FROM turn_ratings s
          WHERE s.actor_id = r.actor_id AND s.turn_id = r.turn_id AND s.rowid != r.rowid
            AND (CASE s.source WHEN ${p0} THEN 0 WHEN ${p1} THEN 1 ELSE 2 END
                   < CASE r.source WHEN ${p0} THEN 0 WHEN ${p1} THEN 1 ELSE 2 END
              OR (s.source = r.source AND (s.created_at > r.created_at
                OR (s.created_at = r.created_at AND s.rowid > r.rowid)))))
      ORDER BY r.created_at DESC, r.id DESC LIMIT ${limit}`
    : sql<RawRatingRow>`
      SELECT r.* FROM json_each(${JSON.stringify([...new Set(query.turnIds)])}) AS wanted CROSS JOIN turn_ratings r
      WHERE r.actor_id = ${actor.actorId} AND r.turn_id = wanted.value
        AND r.score < ${below} AND r.score >= ${from}
        AND NOT EXISTS (SELECT 1 FROM turn_ratings s
          WHERE s.actor_id = r.actor_id AND s.turn_id = r.turn_id AND s.rowid != r.rowid
            AND (CASE s.source WHEN ${p0} THEN 0 WHEN ${p1} THEN 1 ELSE 2 END
                   < CASE r.source WHEN ${p0} THEN 0 WHEN ${p1} THEN 1 ELSE 2 END
              OR (s.source = r.source AND (s.created_at > r.created_at
                OR (s.created_at = r.created_at AND s.rowid > r.rowid)))))
      ORDER BY r.created_at DESC, r.id DESC LIMIT ${limit}`;

  return rows.map(toRating);
}

export function ratingOf(sql: SqlExecutor, actor: ActorHandle, turnId: string): TurnRating | null {
  return listTurnRatings(sql, actor, { turnIds: [turnId] })[0] ?? null;
}

/** The user's current thumb per turn, for the surface that shows it. */
export function listThumbs(sql: SqlExecutor, actor: ActorHandle): Map<string, 'positive' | 'negative'> {
  actor.assertCurrent();

  const rows = sql<{ turn_id: string; score: number }>`
    SELECT turn_id, score FROM turn_ratings
    WHERE actor_id = ${actor.actorId} AND source = 'thumbs'
    ORDER BY created_at ASC, rowid ASC`;

  return new Map(rows.map((row) => [row.turn_id, row.score >= 3 ? 'positive' : 'negative'] as const));
}

/** A cleared thumb: the turn falls back to whatever else rated it. */
export function retractThumbs(sql: SqlExecutor, actor: ActorHandle, turnId: string): void {
  actor.assertCurrent();
  void sql`DELETE FROM turn_ratings WHERE actor_id = ${actor.actorId} AND turn_id = ${turnId} AND source = 'thumbs'`;
  markStoreChanged(sql);
}

/** How turns served by each scaffold version were rated: high counts as accepted, low as negative. */
export function realRatingScaffoldRates(sql: SqlExecutor, actor: ActorHandle): Map<number, RealOutcomeRate> {
  const rates = new Map<number, RealOutcomeRate>();

  for (const rating of listTurnRatings(sql, actor)) {
    if (rating.scaffoldVersion === null) continue;
    const rate = rates.get(rating.scaffoldVersion) ?? { accepted: 0, negative: 0 };

    if (isHighRating(rating.score)) rate.accepted++;
    else if (isLowRating(rating.score)) rate.negative++;
    rates.set(rating.scaffoldVersion, rate);
  }

  return rates;
}

/** Effective, so a thumbs-up over a low model rating clears the turn. */
export function hasLowRating(sql: SqlExecutor, actor: ActorHandle, turnIds: readonly string[]): boolean {
  return turnIds.length > 0 && listTurnRatings(sql, actor, { turnIds, low: true }).length > 0;
}

/** Mean satisfaction on the 1-5 scale with its 95% interval: scores map to [0,1] for the interval. */
export function satisfactionInterval(scores: readonly number[]): ScoreInterval {
  const unit = scoreInterval(scores.map((score) => (score - 1) / 4));

  return { mean: 1 + 4 * unit.mean, lo: 1 + 4 * unit.lo, hi: 1 + 4 * unit.hi, n: unit.n };
}

/** The series as text, newest day last: what `kinu quality` prints. */
export function renderQualitySeries(days: readonly QualityDay[]): string {
  const rated = days.filter((day) => day.rated > 0);

  if (rated.length === 0) return 'No rated turns yet: a turn is rated from the reply to it, or by a thumb.';

  return [
    'Satisfaction per day (1-5, 95% interval) · rated turns · corrected',
    ...rated.map((day) => `${day.day}  ${day.satisfaction.mean.toFixed(2)} (${day.satisfaction.lo.toFixed(2)}-`
      + `${day.satisfaction.hi.toFixed(2)})  ${day.rated}/${day.turns} rated`
      + `${day.thumbs > 0 ? `, ${day.thumbs} by thumbs` : ''}  ${Math.round(day.corrected.mean * 100)}% corrected`),
  ].join('\n');
}

const DAY_MS = 86_400_000;

/** Satisfaction over time, oldest day first, over the last `days` days. */
export function qualitySeries(
  sql: SqlExecutor, actor: ActorHandle, opts: { readonly days?: number; readonly now?: number } = {},
): QualityDay[] {
  const now = opts.now ?? nowMs();
  const since = Math.floor(now / DAY_MS) * DAY_MS - ((opts.days ?? 30) - 1) * DAY_MS;
  const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10);
  const byDay = new Map<string, TurnRating[]>();

  for (const rating of listTurnRatings(sql, actor, { since })) {
    const day = dayOf(rating.createdAt);
    byDay.set(day, [...byDay.get(day) ?? [], rating]);
  }

  const reviewed = sql<{ created_at: number }>`
    SELECT created_at FROM evolution_events
    WHERE actor_id = ${actor.actorId} AND type = 'turn_complete' AND created_at >= ${since}`;

  const turns = new Map<string, number>();

  for (const row of reviewed) turns.set(dayOf(row.created_at), (turns.get(dayOf(row.created_at)) ?? 0) + 1);

  return [...new Set([...byDay.keys(), ...turns.keys()])].sort().map((day) => {
    const ratings = byDay.get(day) ?? [];
    const corrected = ratings.reduce((sum, rating) => sum + rating.corrected, 0);

    return {
      day,
      satisfaction: satisfactionInterval(ratings.map((rating) => rating.score)),
      corrected: wilsonInterval(corrected, ratings.length),
      rated: ratings.length,
      thumbs: ratings.filter((rating) => rating.source === 'thumbs').length,
      turns: Math.max(turns.get(day) ?? 0, ratings.length),
    };
  });
}
