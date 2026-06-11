/**
 * Turn-outcome signal — the ONE pipeline that grades a completed turn from
 * what the user actually did next (Hermes-style per-turn forked review,
 * audit R3 / competitive borrow #1).
 *
 * When user message N+1 arrives, turn N is classified from the follow-up:
 *   accepted   — the user moved on or built on the answer
 *   corrected  — the user re-asked, fixed, or contradicted the answer
 *   frustrated — the user expressed explicit dissatisfaction
 *   abandoned  — the session ended / topic dropped with no follow-up
 *
 * Everything downstream (turn.feedback, evolution gating, craft EMA, GEPA
 * train/val splits, scaffold base-selection priors, lesson corroboration,
 * the replay-eval harness) reads from the durable `turn_outcomes` ledger
 * this module owns. No second classifier exists anywhere else.
 */

import type { SqlExecutor, RawSqlExec, LLM } from '../types/primitives.js';
import type { CompletedTurn } from './types.js';
import type { EvalInstance } from './gepa/types.js';
import { extractJsonObject, jsonObjectOnlyInstruction } from '../prompts/structured.js';
import type { ScaffoldArchiveEntry } from '../scaffold/archive.js';
import { nanoid } from '../utils/nanoid.js';
import { nowMs } from '../utils/date.js';

export type TurnOutcome = 'accepted' | 'corrected' | 'frustrated' | 'abandoned';

/** Where an outcome row came from: the user's explicit thumbs, the LLM
 *  follow-up classifier, or the session-end (abandoned) rule. */
export type TurnOutcomeSource = 'explicit' | 'classifier' | 'session_end';

/** Single source for the explicit-feedback → turn-quality mapping. Used by
 *  the outcome pipeline AND the async setTurnFeedback re-scoring path
 *  (cf-backend), so the 0.9/0.2 constants can't drift between them. */
export function feedbackToQuality(feedback: 'positive' | 'negative'): number {
  return feedback === 'positive' ? 0.9 : 0.2;
}

/** Outcome → the CompletedTurn.feedback value it populates. Abandoned turns
 *  carry no user signal either way, so feedback stays null. */
export function outcomeToFeedback(outcome: TurnOutcome): 'positive' | 'negative' | null {
  if (outcome === 'accepted') return 'positive';
  if (outcome === 'abandoned') return null;
  return 'negative';
}

/** Outcome → turn quality. Accepted/corrected reuse the explicit-feedback
 *  constants (one mapping); frustration is the strongest negative signal;
 *  abandonment is neutral (no signal, not a verdict). */
export function outcomeQuality(outcome: TurnOutcome): number {
  if (outcome === 'frustrated') return 0.1;
  if (outcome === 'abandoned') return 0.5;
  return feedbackToQuality(outcome === 'accepted' ? 'positive' : 'negative');
}

// ── Trivial-turn pre-filter ──────────────────────────────────────

const TRIVIAL_MESSAGE = new RegExp(
  '^\\s*(hi|hiya|hey|hello|yo|sup|thanks?|thank you|thx|ty|ok(ay)?|k|kk|cool|nice|great|awesome|perfect|' +
  'good (morning|afternoon|evening|night)|gm|gn|bye|goodbye|see ya|cya|lol|haha)[\\s!.…]*$',
  'i',
);

/** Greetings/acknowledgements don't warrant an outcome-classification LLM
 *  call — there is nothing to accept or correct. A turn is trivial when it
 *  ran no tools AND the user message is a stock pleasantry (or too short to
 *  be a real request). */
export function isTrivialTurn(turn: Pick<CompletedTurn, 'userMessage' | 'toolCalls'>): boolean {
  if (turn.toolCalls.length > 0) return false;
  const msg = turn.userMessage.trim();
  if (TRIVIAL_MESSAGE.test(msg)) return true;
  return msg.length < 12 && !msg.includes('?');
}

// ── The classifier (one cheap LLM call per non-trivial turn) ─────

export interface OutcomeClassification {
  outcome: Exclude<TurnOutcome, 'abandoned'>;
  confidence: number;
  evidence: string;
}

export function buildOutcomeClassifierPrompt(input: {
  userMessage: string;
  assistantResponse: string;
  followup: string;
}): string {
  return (
    `You are reviewing how a conversation turn landed. The user sent a request, ` +
    `the assistant responded, and the user has now sent a FOLLOW-UP message. ` +
    `Classify what the follow-up reveals about the previous response.\n\n` +
    `Previous user request:\n"${input.userMessage.slice(0, 1000)}"\n\n` +
    `Assistant response:\n"${input.assistantResponse.slice(0, 2000)}"\n\n` +
    `User's follow-up message:\n"${input.followup.slice(0, 1000)}"\n\n` +
    `Outcomes:\n` +
    `- "accepted": the user moved on, built on the answer, or asked something new that presumes it worked.\n` +
    `- "corrected": the user re-asked the same thing, fixed a mistake, contradicted the answer, or had to ` +
    `re-state what they already asked for.\n` +
    `- "frustrated": the user expressed explicit dissatisfaction or negative emotion about the response.\n\n` +
    `JSON shape: {"outcome":"accepted"|"corrected"|"frustrated","confidence":<0..1>,"evidence":"<short reason>"}\n` +
    jsonObjectOnlyInstruction()
  );
}

/** Classify turn N's outcome from the user's follow-up — one small LLM call.
 *  Returns null when the model output is unusable (no signal recorded). */
export async function classifyTurnOutcome(
  llm: LLM,
  input: { userMessage: string; assistantResponse: string; followup: string },
): Promise<OutcomeClassification | null> {
  let raw: string;
  try {
    raw = await llm.complete(buildOutcomeClassifierPrompt(input));
  } catch {
    return null;
  }
  try {
    const parsed = extractJsonObject(raw) as { outcome?: unknown; confidence?: unknown; evidence?: unknown };
    if (parsed.outcome !== 'accepted' && parsed.outcome !== 'corrected' && parsed.outcome !== 'frustrated') {
      return null;
    }
    const confidence = typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
      ? Math.min(1, Math.max(0, parsed.confidence))
      : 0.5;
    return {
      outcome: parsed.outcome,
      confidence,
      evidence: typeof parsed.evidence === 'string' ? parsed.evidence : '',
    };
  } catch {
    return null;
  }
}

// ── The durable outcome ledger ───────────────────────────────────

export function initTurnOutcomeTables(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS turn_outcomes (
    id TEXT PRIMARY KEY,
    turn_id TEXT,
    session_id TEXT NOT NULL DEFAULT 'default',
    outcome TEXT NOT NULL CHECK (outcome IN ('accepted','corrected','frustrated','abandoned')),
    confidence REAL NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('explicit','classifier','session_end')),
    user_message TEXT NOT NULL,
    assistant_response TEXT NOT NULL,
    followup TEXT,
    scaffold_version INTEGER,
    created_at INTEGER NOT NULL
  )`);
  // Lessons ledger — reflection prose with provenance. Self-scored lessons
  // (no real user signal behind them) stay 'provisional' and OUT of
  // MEMORY.md until a real negative outcome on one of their turns
  // corroborates them (the audit's net-negative-lessons fix).
  execRaw(`CREATE TABLE IF NOT EXISTS lessons (
    id TEXT PRIMARY KEY,
    turn_ids TEXT NOT NULL,
    text TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('turn_reflection','session_reflection')),
    status TEXT NOT NULL CHECK (status IN ('provisional','corroborated')),
    created_at INTEGER NOT NULL,
    corroborated_at INTEGER
  )`);
}

export interface TurnOutcomeRow {
  id: string;
  turnId: string | null;
  sessionId: string;
  outcome: TurnOutcome;
  confidence: number;
  source: TurnOutcomeSource;
  userMessage: string;
  assistantResponse: string;
  followup: string | null;
  scaffoldVersion: number | null;
  createdAt: number;
}

export interface RecordTurnOutcomeInput {
  turnId?: string | null;
  sessionId?: string;
  outcome: TurnOutcome;
  confidence: number;
  source: TurnOutcomeSource;
  userMessage: string;
  assistantResponse: string;
  followup?: string | null;
  scaffoldVersion?: number | null;
  now?: number;
}

/** Record (or, for a known turn id, replace — explicit thumbs override the
 *  classifier) one turn's outcome. Texts are truncated to keep rows bounded. */
export function recordTurnOutcome(sql: SqlExecutor, input: RecordTurnOutcomeInput): string {
  const id = `outc-${nanoid()}`;
  if (input.turnId) {
    sql`DELETE FROM turn_outcomes WHERE turn_id = ${input.turnId}`;
  }
  sql`INSERT INTO turn_outcomes
        (id, turn_id, session_id, outcome, confidence, source,
         user_message, assistant_response, followup, scaffold_version, created_at)
      VALUES
        (${id}, ${input.turnId ?? null}, ${input.sessionId ?? 'default'}, ${input.outcome},
         ${input.confidence}, ${input.source}, ${input.userMessage.slice(0, 2000)},
         ${input.assistantResponse.slice(0, 4000)}, ${input.followup?.slice(0, 2000) ?? null},
         ${input.scaffoldVersion ?? null}, ${input.now ?? nowMs()})`;
  return id;
}

interface RawOutcomeRow {
  id: string; turn_id: string | null; session_id: string; outcome: TurnOutcome;
  confidence: number; source: TurnOutcomeSource; user_message: string;
  assistant_response: string; followup: string | null;
  scaffold_version: number | null; created_at: number;
}

function toOutcomeRow(r: RawOutcomeRow): TurnOutcomeRow {
  return {
    id: r.id, turnId: r.turn_id, sessionId: r.session_id, outcome: r.outcome,
    confidence: r.confidence, source: r.source, userMessage: r.user_message,
    assistantResponse: r.assistant_response, followup: r.followup,
    scaffoldVersion: r.scaffold_version, createdAt: r.created_at,
  };
}

/** Recorded outcomes, newest first, optionally filtered by outcome kinds. */
export function listTurnOutcomes(
  sql: SqlExecutor,
  opts: { limit?: number; outcomes?: ReadonlyArray<TurnOutcome> } = {},
): TurnOutcomeRow[] {
  const limit = opts.limit ?? 50;
  try {
    const rows = sql<RawOutcomeRow>`
      SELECT * FROM turn_outcomes ORDER BY created_at DESC, id DESC LIMIT ${limit * 4}`;
    const filtered = opts.outcomes ? rows.filter((r) => opts.outcomes!.includes(r.outcome)) : rows;
    return filtered.slice(0, limit).map(toOutcomeRow);
  } catch {
    return [];
  }
}

/** True when any of the given turn ids has a recorded corrected/frustrated
 *  outcome — the session-reflection gate's real-signal check. */
export function hasNegativeOutcome(sql: SqlExecutor, turnIds: ReadonlyArray<string>): boolean {
  if (turnIds.length === 0) return false;
  try {
    const rows = sql<{ turn_id: string | null; outcome: TurnOutcome }>`
      SELECT turn_id, outcome FROM turn_outcomes
      WHERE outcome IN ('corrected','frustrated') AND turn_id IS NOT NULL`;
    const set = new Set(turnIds);
    return rows.some((r) => r.turn_id !== null && set.has(r.turn_id));
  } catch {
    return false;
  }
}

// ── Real-outcome scaffold rates (route into R2's archive priors) ─

export interface RealOutcomeRate {
  accepted: number;
  negative: number;
}

/** Per-scaffold-version real-outcome record: how turns SERVED by each version
 *  actually landed with the user. The component R2's shadow win-rates lack. */
export function realOutcomeScaffoldRates(sql: SqlExecutor): Map<number, RealOutcomeRate> {
  try {
    const rows = sql<{ scaffold_version: number; accepted: number; negative: number }>`
      SELECT scaffold_version,
             SUM(CASE WHEN outcome = 'accepted' THEN 1 ELSE 0 END) AS accepted,
             SUM(CASE WHEN outcome IN ('corrected','frustrated') THEN 1 ELSE 0 END) AS negative
      FROM turn_outcomes
      WHERE scaffold_version IS NOT NULL
      GROUP BY scaffold_version`;
    return new Map(rows.map((r) => [r.scaffold_version, { accepted: r.accepted ?? 0, negative: r.negative ?? 0 }]));
  } catch {
    return new Map();
  }
}

/** Blend real user outcomes into the archive's shadow-eval win-rates for
 *  branch-base selection: wins/decisive pools with accepted/(accepted+negative),
 *  and real exposure counts toward trials (damping the novelty bonus for
 *  well-exercised versions). Pure — consumes R2's archive API, returns new
 *  entries, never mutates. */
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

// ── GEPA train/val split (upstream gepa-ai/gepa eval discipline) ─

/** What the outcome-aware GEPA metric judges a candidate against. */
export interface OutcomeEvalExpectation {
  outcome: TurnOutcome;
  /** The response the user saw — the regression reference for accepted turns. */
  recordedResponse: string;
  /** The user's follow-up — for corrected/frustrated turns, the correction
   *  the candidate must already address. */
  followup: string | null;
}

export type OutcomeEvalInstance = EvalInstance<string, OutcomeEvalExpectation>;

export interface OutcomeEvalSplit {
  /** Reflection minibatch source — the corrected/frustrated turns the
   *  optimizer must fix. Falls back to `val` when no negatives exist yet. */
  train: OutcomeEvalInstance[];
  /** Scoring set (Pareto/winner selection): the negatives to fix PLUS the
   *  accepted turns the optimizer must not regress. */
  val: OutcomeEvalInstance[];
}

/** Draw a budgeted train/val split from the outcome ledger: negatives first
 *  (up to half the budget — they are the optimization targets), accepted
 *  turns fill the rest as regression guards. Newest outcomes win. */
export function buildOutcomeEvalSplit(sql: SqlExecutor, budget: number): OutcomeEvalSplit {
  const size = Math.max(2, Math.floor(budget));
  const negatives = listTurnOutcomes(sql, { limit: size, outcomes: ['corrected', 'frustrated'] });
  const accepted = listTurnOutcomes(sql, { limit: size, outcomes: ['accepted'] });

  const negativeShare = Math.min(negatives.length, Math.ceil(size / 2));
  const acceptedShare = Math.min(accepted.length, size - negativeShare);
  // Negatives backfill what the accepted pool can't cover (and vice versa).
  const negativeCount = Math.min(negatives.length, size - acceptedShare);

  const toInstance = (row: TurnOutcomeRow, i: number, kind: string): OutcomeEvalInstance => ({
    id: `${kind}-${i}-${row.id}`,
    input: row.userMessage,
    expected: { outcome: row.outcome, recordedResponse: row.assistantResponse, followup: row.followup },
  });

  const train = negatives.slice(0, negativeCount).map((r, i) => toInstance(r, i, 'neg'));
  const val = [...train, ...accepted.slice(0, acceptedShare).map((r, i) => toInstance(r, i, 'pos'))];
  return { train: train.length > 0 ? train : val, val };
}

// ── Lessons ledger (provisional → corroborated) ──────────────────

export type LessonSource = 'turn_reflection' | 'session_reflection';
export type LessonStatus = 'provisional' | 'corroborated';

export interface LessonRow {
  id: string;
  turnIds: string[];
  text: string;
  source: LessonSource;
  status: LessonStatus;
  createdAt: number;
  corroboratedAt: number | null;
}

export function recordLesson(sql: SqlExecutor, input: {
  turnIds: ReadonlyArray<string>;
  text: string;
  source: LessonSource;
  status: LessonStatus;
  now?: number;
}): string {
  const id = `lsn-${nanoid()}`;
  const now = input.now ?? nowMs();
  sql`INSERT INTO lessons (id, turn_ids, text, source, status, created_at, corroborated_at)
      VALUES (${id}, ${JSON.stringify(input.turnIds)}, ${input.text}, ${input.source},
              ${input.status}, ${now}, ${input.status === 'corroborated' ? now : null})`;
  return id;
}

interface RawLessonRow {
  id: string; turn_ids: string; text: string; source: LessonSource;
  status: LessonStatus; created_at: number; corroborated_at: number | null;
}

function toLessonRow(r: RawLessonRow): LessonRow {
  let turnIds: string[] = [];
  try {
    const parsed = JSON.parse(r.turn_ids) as unknown;
    if (Array.isArray(parsed)) turnIds = parsed.filter((v): v is string => typeof v === 'string');
  } catch { /* malformed row — treat as untied */ }
  return {
    id: r.id, turnIds, text: r.text, source: r.source, status: r.status,
    createdAt: r.created_at, corroboratedAt: r.corroborated_at,
  };
}

export function listLessons(
  sql: SqlExecutor,
  opts: { status?: LessonStatus; limit?: number } = {},
): LessonRow[] {
  try {
    const rows = opts.status
      ? sql<RawLessonRow>`SELECT * FROM lessons WHERE status = ${opts.status}
          ORDER BY created_at DESC LIMIT ${opts.limit ?? 100}`
      : sql<RawLessonRow>`SELECT * FROM lessons ORDER BY created_at DESC LIMIT ${opts.limit ?? 100}`;
    return rows.map(toLessonRow);
  } catch {
    return [];
  }
}

/** A real negative outcome landed on `turnId`: flip every provisional lesson
 *  tied to that turn to corroborated. Returns the newly corroborated lessons
 *  so the caller can append them to durable memory (MEMORY.md). */
export function corroborateLessonsForTurn(sql: SqlExecutor, turnId: string, now = nowMs()): LessonRow[] {
  const provisional = listLessons(sql, { status: 'provisional', limit: 200 });
  const matched = provisional.filter((l) => l.turnIds.includes(turnId));
  for (const lesson of matched) {
    sql`UPDATE lessons SET status = 'corroborated', corroborated_at = ${now} WHERE id = ${lesson.id}`;
  }
  return matched.map((l) => ({ ...l, status: 'corroborated' as const, corroboratedAt: now }));
}
