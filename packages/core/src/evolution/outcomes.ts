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
import { delegationFeatures, renderDelegationFeatures } from './delegation-features.js';

/** Every outcome kind, in the ledger's canonical order. The one list — the
 *  table's CHECK constraint, the query filter and the changelog tally all
 *  derive from it. */
export const TURN_OUTCOMES = ['accepted', 'corrected', 'frustrated', 'abandoned'] as const;

export type TurnOutcome = (typeof TURN_OUTCOMES)[number];

/** The outcomes that carry a complaint — what "a turn that landed badly"
 *  means everywhere it is drawn as a set (GEPA's optimization targets, the
 *  pathology clustering). `abandoned` is an absence of signal, not a verdict. */
export const NEGATIVE_TURN_OUTCOMES = ['corrected', 'frustrated'] as const;

/** Where an outcome row came from: the user's explicit thumbs, the LLM
 *  follow-up classifier, the session-end (abandoned) rule, or an Alternate
 *  Takes pick (mcts/takes.ts — explicit preference between explored takes). */
export type TurnOutcomeSource = 'explicit' | 'classifier' | 'session_end' | 'take_pick';

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

const TURN_OUTCOMES_DDL = `(
    id TEXT PRIMARY KEY,
    turn_id TEXT,
    session_id TEXT NOT NULL DEFAULT 'default',
    outcome TEXT NOT NULL CHECK (outcome IN (${TURN_OUTCOMES.map((o) => `'${o}'`).join(',')})),
    confidence REAL NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('explicit','classifier','session_end','take_pick')),
    user_message TEXT NOT NULL,
    assistant_response TEXT NOT NULL,
    followup TEXT,
    scaffold_version INTEGER,
    created_at INTEGER NOT NULL
  )`;

export function initTurnOutcomeTables(execRaw: RawSqlExec, sql: SqlExecutor): void {
  // Only the sqlite_master probe may fail silently (exotic executors without
  // it skip the migration probes); a failed rebuild below throws loudly and
  // is finished by the resume branch on the next init.
  const tableDdl = (name: string): string | null => {
    try {
      return sql<{ sql: string }>`
        SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${name}`[0]?.sql ?? null;
    } catch {
      return null;
    }
  };

  // Resume an interrupted CHECK-widening rebuild: a crash mid-sequence leaves
  // rows stranded in turn_outcomes_legacy while a bare CREATE IF NOT EXISTS
  // would silently start an empty ledger. Finish the copy first. INSERT OR
  // IGNORE (PK ids) makes the resume idempotent at every crash point.
  if (tableDdl('turn_outcomes_legacy') !== null) {
    execRaw(`CREATE TABLE IF NOT EXISTS turn_outcomes ${TURN_OUTCOMES_DDL}`);
    execRaw(`INSERT OR IGNORE INTO turn_outcomes SELECT * FROM turn_outcomes_legacy`);
    execRaw(`DROP TABLE turn_outcomes_legacy`);
  }

  execRaw(`CREATE TABLE IF NOT EXISTS turn_outcomes ${TURN_OUTCOMES_DDL}`);
  // Tables created before the 'take_pick' source carry a narrower CHECK that
  // SQLite cannot ALTER — rebuild them in place (same columns, data kept).
  // No explicit BEGIN/COMMIT: DO SQLite forbids explicit transaction
  // statements, so crash-safety comes from the resume branch above instead —
  // every intermediate state of this sequence is recoverable from it.
  const ddl = tableDdl('turn_outcomes');
  if (ddl !== null && !ddl.includes('take_pick')) {
    execRaw(`ALTER TABLE turn_outcomes RENAME TO turn_outcomes_legacy`);
    execRaw(`CREATE TABLE turn_outcomes ${TURN_OUTCOMES_DDL}`);
    execRaw(`INSERT OR IGNORE INTO turn_outcomes SELECT * FROM turn_outcomes_legacy`);
    execRaw(`DROP TABLE turn_outcomes_legacy`);
  }
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

/** Recorded outcomes, newest first, optionally filtered by outcome kinds.
 *
 *  The filter is applied in SQL so `limit` bounds the rows actually wanted.
 *  Filtering a bounded window in JS instead silently dropped the rare outcomes
 *  (`corrected`/`frustrated` — the only ones the optimizer learns from) as soon
 *  as enough newer `accepted` rows existed to fill the window. */
export function listTurnOutcomes(
  sql: SqlExecutor,
  opts: { limit?: number; outcomes?: ReadonlyArray<TurnOutcome> } = {},
): TurnOutcomeRow[] {
  const limit = opts.limit ?? 50;
  // The outcome set is closed, so a fixed four-slot IN list expresses every
  // filter with the tagged-template executor's fixed-arity binding. Unused
  // slots bind '' — a value the CHECK constraint forbids, so it matches nothing.
  const wanted = TURN_OUTCOMES.filter((o) => !opts.outcomes || opts.outcomes.includes(o));
  const [w0, w1, w2, w3] = [wanted[0] ?? '', wanted[1] ?? '', wanted[2] ?? '', wanted[3] ?? ''];
  try {
    return sql<RawOutcomeRow>`
      SELECT * FROM turn_outcomes
      WHERE outcome IN (${w0}, ${w1}, ${w2}, ${w3})
      ORDER BY created_at DESC, id DESC LIMIT ${limit}`.map(toOutcomeRow);
  } catch {
    return [];
  }
}

/** The outcome an Alternate Takes pick already recorded for this turn, if
 *  any — the follow-up classifier must not overwrite that explicit signal. */
export function takePickOutcome(sql: SqlExecutor, turnId: string | null | undefined): TurnOutcome | null {
  if (!turnId) return null;
  try {
    const rows = sql<{ outcome: TurnOutcome }>`
      SELECT outcome FROM turn_outcomes
      WHERE turn_id = ${turnId} AND source = 'take_pick' LIMIT 1`;
    return rows[0]?.outcome ?? null;
  } catch {
    return null;
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

/** Why a split cannot support an out-of-sample winner selection. */
export type OutcomeSplitDegeneracy =
  /** Nothing is graded yet — there is nothing to optimize or to score on. */
  | 'no_labeled_turns'
  /** Only accepted turns exist: no failure to fix, so `train` is empty and a
   *  run would select on regression guards alone. */
  | 'no_negatives'
  /** Exactly one failure exists: it has to be trained on, so nothing unseen
   *  remains to score improvement against. */
  | 'no_held_out_negatives';

/** One honest sentence per degeneracy — what it costs the selection. */
export function describeSplitDegeneracy(degeneracy: OutcomeSplitDegeneracy): string {
  switch (degeneracy) {
    case 'no_labeled_turns':
      return 'no outcome-labeled turns yet — chat with the agent first';
    case 'no_negatives':
      return 'no corrected/frustrated turns yet — there is no failure to optimize toward';
    case 'no_held_out_negatives':
      return 'only one labeled failure exists, and the optimizer must train on it — ' +
        'the winner is selected without any unseen failure, so an improvement here is not evidence of one';
  }
}

export interface OutcomeEvalSplit {
  /** Reflection minibatch source — the corrected/frustrated turns the
   *  optimizer must fix. Shares no instance with `val`. */
  train: OutcomeEvalInstance[];
  /** Scoring set (Pareto/winner selection): failures HELD OUT of `train`
   *  PLUS the accepted turns the optimizer must not regress. */
  val: OutcomeEvalInstance[];
  /** Failures in `val` the optimizer never trained on. Selection is only
   *  evidence of improvement when this is > 0. */
  heldOutNegatives: number;
  /** null when the split supports an out-of-sample selection; otherwise why
   *  it does not — the caller must not read the winner as trustworthy. */
  degeneracy: OutcomeSplitDegeneracy | null;
}

interface TurnMessageWindow {
  userMessage: string;
  startedAt: number;
  endedAt: number;
}

interface StoredRunEvent {
  type: string;
  name?: string;
}

function parseRunEvent(payload: string): StoredRunEvent | null {
  try {
    const value: unknown = JSON.parse(payload);
    if (typeof value !== 'object' || value === null || !('type' in value) || typeof value.type !== 'string') {
      return null;
    }
    return {
      type: value.type,
      ...('name' in value && typeof value.name === 'string' ? { name: value.name } : {}),
    };
  } catch {
    return null;
  }
}

/** Reconstruct non-scoring process evidence from the existing message + run ledgers. */
function turnProcessEvidence(sql: SqlExecutor, turnId: string | null): string | undefined {
  if (!turnId) return undefined;
  try {
    const window = sql<TurnMessageWindow>`
      SELECT u.content AS userMessage, u.created_at AS startedAt, a.created_at AS endedAt
      FROM messages a JOIN messages u ON u.id = a.parent_id
      WHERE a.id = ${turnId} LIMIT 1`[0];
    if (!window) return undefined;

    const from = new Date(window.startedAt).toISOString();
    const to = new Date(window.endedAt).toISOString();
    const starts = sql<{ runId: string; payload: string }>`
      SELECT run_id AS runId, payload FROM run_events
      WHERE type = 'run_start' AND ts >= ${from} AND ts <= ${to}
      ORDER BY ts DESC LIMIT 20`;
    const expectedUserMessage = window.userMessage.slice(0, 500);
    const runId = starts.find(({ payload }) => {
      try {
        const value: unknown = JSON.parse(payload);
        return typeof value === 'object' && value !== null &&
          'type' in value && value.type === 'run_start' &&
          'caused_by' in value && value.caused_by === 'chat' &&
          'userMessage' in value && value.userMessage === expectedUserMessage;
      } catch {
        return false;
      }
    })?.runId;
    if (!runId) return undefined;

    const rows = sql<{ payload: string; ts: string }>`
      SELECT payload, ts FROM run_events WHERE run_id = ${runId} ORDER BY event_index`;
    const events = rows.map((row) => ({ event: parseRunEvent(row.payload), at: Date.parse(row.ts) }))
      .filter((row): row is { event: StoredRunEvent; at: number } => row.event !== null && Number.isFinite(row.at));
    if (events.length === 0) return undefined;

    const toolCalls = events.flatMap(({ event }) =>
      event.type === 'tool_call_end' && event.name
        ? [{ name: event.name, args: {}, result: null }]
        : []);
    const steps = events.filter(({ event }) => event.type === 'step_finish').length;
    const startAt = events.find(({ event }) => event.type === 'run_start')?.at ?? events[0].at;
    const endAt = [...events].reverse().find(({ event }) => event.type === 'run_end')?.at ??
      events[events.length - 1]?.at ?? startAt;
    return renderDelegationFeatures(delegationFeatures({
      toolCalls,
      steps,
      durationMs: Math.max(0, endAt - startAt),
    }));
  } catch {
    return undefined;
  }
}

/** Share of the drawn failures held OUT of the reflection minibatch and
 *  scored on instead. A third keeps most of the (scarce) failures available
 *  to learn from while still leaving a real held-out set — at the default
 *  budget, 8 to train on and 4 to be judged on. */
const NEGATIVE_HOLDOUT_SHARE = 1 / 3;

/** Draw a budgeted, DISJOINT train/val split from the outcome ledger.
 *
 *  Negatives come first (up to half the budget — they are the optimization
 *  targets) and are then partitioned: the newest go to `val` as held-out
 *  failures, the rest to `train`. Holding out the newest is a temporal
 *  holdout — a candidate proves itself on failures more recent than the ones
 *  it was written against. Accepted turns fill the remaining budget as `val`
 *  regression guards. Newest outcomes win throughout.
 *
 *  No instance is ever in both sets: a winner selected on `val` was never
 *  reflected on during training. When the ledger is too thin to hold anything
 *  out, the split says so via `degeneracy` instead of quietly overlapping. */
export function buildOutcomeEvalSplit(sql: SqlExecutor, budget: number): OutcomeEvalSplit {
  const size = Math.max(2, Math.floor(budget));
  const negatives = listTurnOutcomes(sql, { limit: size, outcomes: NEGATIVE_TURN_OUTCOMES });
  const accepted = listTurnOutcomes(sql, { limit: size, outcomes: ['accepted'] });

  const negativeShare = Math.min(negatives.length, Math.ceil(size / 2));
  const acceptedCount = Math.min(accepted.length, size - negativeShare);
  // Negatives backfill what the accepted pool can't cover (and vice versa).
  const negativeCount = Math.min(negatives.length, size - acceptedCount);

  const toInstance = (row: TurnOutcomeRow, i: number, kind: string): OutcomeEvalInstance => ({
    id: `${kind}-${i}-${row.id}`,
    input: row.userMessage,
    evidence: [
      `Outcome: ${row.outcome}`,
      turnProcessEvidence(sql, row.turnId),
    ].filter((line): line is string => line !== undefined).join('\n'),
    expected: { outcome: row.outcome, recordedResponse: row.assistantResponse, followup: row.followup },
  });

  const drawnNegatives = negatives.slice(0, negativeCount);
  // A single failure cannot be both trained on and held out, so it stays in
  // train and the split reports that selection is blind to improvement.
  const holdoutCount = drawnNegatives.length >= 2
    ? Math.max(1, Math.round(drawnNegatives.length * NEGATIVE_HOLDOUT_SHARE))
    : 0;

  const train = drawnNegatives.slice(holdoutCount).map((r, i) => toInstance(r, i, 'neg'));
  const val = [
    ...drawnNegatives.slice(0, holdoutCount).map((r, i) => toInstance(r, i, 'held')),
    ...accepted.slice(0, acceptedCount).map((r, i) => toInstance(r, i, 'pos')),
  ];

  const degeneracy: OutcomeSplitDegeneracy | null =
    drawnNegatives.length === 0
      ? (val.length === 0 ? 'no_labeled_turns' : 'no_negatives')
      : holdoutCount === 0 ? 'no_held_out_negatives' : null;

  return { train, val, heldOutNegatives: holdoutCount, degeneracy };
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
