/**
 * Lessons (`lessons`) and the turn shapes the turn review reads. The rating every reader decides by is in
 * `ratings.ts`; the GEPA split's instance types are here until the proposer replaces it.
 */

import * as v from 'valibot';
import type { SqlExecutor, RawSqlExec } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import type { CompletedTurn, ToolCallRecord } from './types';
import type { EvalInstance } from './gepa/types';
import { evidenceWindow } from '../utils/evidence-window';
import { EVIDENCE_BUDGETS } from '../types/evidence';
import { sqlCheckList } from '../identity/schema';
import type { ScaffoldArchiveEntry } from '../scaffold/archive';
import { nanoid } from '../utils/nanoid';
import { nowMs } from '../utils/date';
import { parseJsonValue } from '../utils/json';

const TRIVIAL_MESSAGE = new RegExp(
  '^\\s*(hi|hiya|hey|hello|yo|sup|thanks?|thank you|thx|ty|ok(ay)?|k|kk|cool|nice|great|awesome|perfect|' +
  'good (morning|afternoon|evening|night)|gm|gn|bye|goodbye|see ya|cya|lol|haha)[\\s!.\\u2026]*$',
  'i',
);

/** A turn is trivial when it ran no tools and the user message is a stock
 *  pleasantry or too short to be a real request. */
export function isTrivialTurn(turn: Pick<CompletedTurn, 'userMessage' | 'toolCalls'>): boolean {
  if (turn.toolCalls.length > 0) return false;
  const msg = turn.userMessage.trim();

  if (TRIVIAL_MESSAGE.test(msg)) return true;

  return msg.length < 12 && !msg.includes('?');
}

/** Read-only calls prove nothing about whether the turn's work landed; the
 *  pattern extractor skips them too. `fact` and `memory` name the same recall. */
export function isPureLookupCall(call: Pick<ToolCallRecord, 'name' | 'args'>): boolean {
  if (call.name === 'memory') return call.args.action === 'search' || call.args.action === 'recall';

  return call.name === 'fact' && call.args.action === 'recall';
}

export interface RealOutcomeRate {
  accepted: number;
  negative: number;
}

/** Blends real outcomes into archive win-rates and trials for branch-base
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

/** The two sides of a GEPA split: a turn rated high, or one rated low. */
export type EvalVerdict = 'accepted' | 'corrected';

export interface OutcomeEvalExpectation {
  outcome: EvalVerdict;
  recordedResponse: string;
  /** The user's follow-up on a ledger-drawn negative, the advisor's note on an
     *  advisor-drawn one. */
  followup: string | null;
  /** Who complained, so the scoring prompt does not tell a judge a user corrected a
     *  turn no user saw. */
  critic: 'user' | 'advisor';
}

export type OutcomeEvalInstance = EvalInstance<string, OutcomeEvalExpectation>;

/**
 * How every scorer names a negative instance's complaint. The `user` wording is the
 * sentence the prompts carried before advisor notes existed, byte for byte.
 */
const CRITIC_PROSE = {
  user: { verdict: 'the user had to correct it', complaint: "User's correction" },
  advisor: {
    verdict: 'no user ever graded it, and a second model reviewing the turn found this',
    complaint: "Reviewer's note",
  },
} as const satisfies Readonly<
  Record<OutcomeEvalExpectation['critic'], { verdict: string; complaint: string }>
>;

/**
 * The 1.0 / 0.0 sentence a scorer states for each recorded outcome. The rest of
 * the criterion comes from {@link renderOutcomeCriterion}.
 */
export interface OutcomeScoringRule {
  readonly accepted: string;
  readonly failed: string;
}

/** For scorers comparing a fresh response with the recorded one. */
export const FRESH_RESPONSE_RULE: OutcomeScoringRule = {
  accepted: 'Score 1.0 when the new response is at least as good, 0.0 when it regresses.',
  failed: 'Score 1.0 when the new response already addresses the correction, 0.0 when it '
    + 'repeats the failure.',
};

export function renderOutcomeCriterion(
  expected: OutcomeEvalExpectation | undefined,
  rule: OutcomeScoringRule,
): string {
  if (expected && expected.outcome === 'accepted') {
    return `The agent's response below was ACCEPTED by the user. ${rule.accepted}\n\n`
      + `Accepted response:\n${evidenceWindow(expected.recordedResponse, EVIDENCE_BUDGETS.replayReferenceResponse)}`;
  }

  const critic = CRITIC_PROSE[expected?.critic ?? 'user'];

  return `The agent's response below FAILED: ${critic.verdict}. ${rule.failed}\n\n`
    + `Failed response:\n${evidenceWindow(expected?.recordedResponse ?? '', EVIDENCE_BUDGETS.replayFailedResponse)}\n\n`
    + `${critic.complaint}:\n${evidenceWindow(expected?.followup ?? '(not recorded)', EVIDENCE_BUDGETS.replayCorrection)}`;
}

export type OutcomeSplitDegeneracy =
  | 'no_labeled_turns'
  /** Only accepted turns exist, so `train` is empty. */
  | 'no_negatives'
  /** The single failure must be trained on, leaving nothing unseen to score. */
  | 'no_held_out_negatives';

export function describeSplitDegeneracy(degeneracy: OutcomeSplitDegeneracy): string {
  switch (degeneracy) {
    case 'no_labeled_turns':
      return 'no outcome-labeled turns yet: chat with the agent first';
    case 'no_negatives':
      return 'no low-rated turns yet: there is no failure to optimize toward';
    case 'no_held_out_negatives':
      return 'only one labeled failure exists, and the optimizer must train on it: ' +
        'the winner is selected without any unseen failure, so an improvement here is not evidence of one';
  }
}

export interface OutcomeEvalSplit {
  /** Low-rated turns the optimizer must fix. Shares no instance with `val`. */
  train: OutcomeEvalInstance[];
  /** Failures held out of `train` plus accepted turns the optimizer must not regress. */
  val: OutcomeEvalInstance[];
  /** Selection is evidence of improvement only when this is > 0. */
  heldOutNegatives: number;
  /** Non-null means the caller must not trust the winner. */
  degeneracy: OutcomeSplitDegeneracy | null;
}

/** Lesson sources in canonical order; the table's CHECK constraint derives from
 *  this list. `execution_recovery` is bound to no turn, so it is never corroborated;
 *  `import` is born corroborated. Corroboration lives only in the row's status. */
const LESSON_SOURCES = [
  'turn_reflection', 'session_reflection', 'execution_recovery', 'import',
] as const;

export type LessonSource = (typeof LESSON_SOURCES)[number];

export type LessonStatus = 'provisional' | 'corroborated';

const LESSONS_DDL = `(
    actor_id TEXT NOT NULL,
    id TEXT NOT NULL,
    turn_ids TEXT NOT NULL,
    text TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN (${sqlCheckList(LESSON_SOURCES)})),
    status TEXT NOT NULL CHECK (status IN ('provisional','corroborated')),
    created_at INTEGER NOT NULL,
    corroborated_at INTEGER,
    PRIMARY KEY (actor_id, id)
  )`;

export function initLessonTables(execRaw: RawSqlExec): void {
  // Self-scored lessons stay 'provisional' and out of the derived view until the user's own negative on one of
  // their turns corroborates them.
  execRaw(`CREATE TABLE IF NOT EXISTS lessons ${LESSONS_DDL}`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_lessons_actor
             ON lessons(actor_id, created_at DESC)`);
  // The generated pattern, held so a replay applies what was decided rather than
  // re-asking a model. Retired once its tombstone lands.
  execRaw(`CREATE TABLE IF NOT EXISTS pattern_extractions (
    actor_id   TEXT NOT NULL,
    effect_key TEXT NOT NULL,
    answer     TEXT NOT NULL,
    PRIMARY KEY (actor_id, effect_key)
  )`);
}

export interface LessonRow {
  id: string;
  turnIds: string[];
  text: string;
  source: LessonSource;
  status: LessonStatus;
  createdAt: number;
  corroboratedAt: number | null;
}

export function recordLesson(sql: SqlExecutor, actor: ActorHandle, input: {
  turnIds: ReadonlyArray<string>;
  text: string;
  source: LessonSource;
  status: LessonStatus;
  now?: number;
  /**
     * Stable identity of the producing work, so a retry rewrites the same row
     * instead of appending a duplicate.
     */
  key?: string;
}): string {
  actor.assertCurrent();
  const id = input.key === undefined ? `lsn-${nanoid()}` : `lsn-${input.key}`;
  const now = input.now ?? nowMs();
  void sql`INSERT INTO lessons (actor_id, id, turn_ids, text, source, status, created_at, corroborated_at)
      VALUES (${actor.actorId}, ${id}, ${JSON.stringify(input.turnIds)}, ${input.text}, ${input.source},
              ${input.status}, ${now}, ${input.status === 'corroborated' ? now : null})
      ON CONFLICT(actor_id, id) DO NOTHING`;

  return id;
}

interface RawLessonRow {
  id: string; turn_ids: string; text: string; source: LessonSource;
  status: LessonStatus; created_at: number; corroborated_at: number | null;
}

function toLessonRow(r: RawLessonRow): LessonRow {
  // A row that does not parse is corruption, not a lesson tied to no turn.
  const turnIds = v.parse(v.array(v.string()), parseJsonValue(r.turn_ids));

  return {
    id: r.id, turnIds, text: r.text, source: r.source, status: r.status,
    createdAt: r.created_at, corroboratedAt: r.corroborated_at,
  };
}

export function listLessons(
  sql: SqlExecutor,
  actor: ActorHandle,
  opts: { status?: LessonStatus; source?: LessonSource; limit?: number } = {},
): LessonRow[] {
  actor.assertCurrent();
  const status = opts.status ?? null;
  const source = opts.source ?? null;

  const rows = sql<RawLessonRow>`SELECT * FROM lessons
    WHERE actor_id = ${actor.actorId}
      AND (${status} IS NULL OR status = ${status})
      AND (${source} IS NULL OR source = ${source})
    ORDER BY created_at DESC LIMIT ${opts.limit ?? 100}`;

  return rows.map(toLessonRow);
}

export function getLesson(sql: SqlExecutor, actor: ActorHandle, id: string): LessonRow | null {
  actor.assertCurrent();

  const rows = sql<RawLessonRow>`SELECT * FROM lessons
    WHERE actor_id = ${actor.actorId} AND id = ${id} LIMIT 1`;

  return rows[0] ? toLessonRow(rows[0]) : null;
}

/** The newest corroborated lessons as one prose block for a turn's dynamic context. */
export function renderRecentLessons(sql: SqlExecutor, actor: ActorHandle, limit = 5): string {
  return listLessons(sql, actor, { status: 'corroborated', limit })
    .map((lesson) => lesson.text)
    .join('\n');
}

/** Flip every provisional lesson tied to `turnId` to corroborated. */
export function corroborateLessonsForTurn(
  sql: SqlExecutor, actor: ActorHandle, turnId: string, now = nowMs(),
): LessonRow[] {
  const provisional = listLessons(sql, actor, { status: 'provisional', limit: 200 });
  const matched = provisional.filter((l) => l.turnIds.includes(turnId));

  for (const lesson of matched) {
    void sql`UPDATE lessons SET status = 'corroborated', corroborated_at = ${now}
      WHERE actor_id = ${actor.actorId} AND id = ${lesson.id}`;
  }

  return matched.map((l) => ({ ...l, status: 'corroborated' as const, corroboratedAt: now }));
}
