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

import * as v from 'valibot';
import type { SqlExecutor, RawSqlExec, LLM } from '../types/primitives';
import type { CompletedTurn, ToolCallRecord } from './types';
import type { EvalInstance } from './gepa/types';
import { extractJsonObject, jsonObjectOnlyInstruction } from '../prompts/structured';
import { EVIDENCE_BUDGETS, evidenceWindow } from '../prompts/evidence-window';
import { sqlCheckList } from '../identity/schema';
import type { ScaffoldArchiveEntry } from '../scaffold/archive';
import { nanoid } from '../utils/nanoid';
import { nowMs } from '../utils/date';
import { parseJsonValue } from '../utils/json';
import { tolerate } from '../obs/index';
import { isFailingResultText } from '../execution/exec-result';

/** Every outcome kind, in the ledger's canonical order. The one list — the
 *  table's CHECK constraint, the query filter and the changelog tally all
 *  derive from it. */
export const TURN_OUTCOMES = ['accepted', 'corrected', 'frustrated', 'abandoned'] as const;

export type TurnOutcome = (typeof TURN_OUTCOMES)[number];

/** The outcomes that carry a complaint — what "a turn that landed badly"
 *  means everywhere it is drawn as a set (GEPA's optimization targets, the
 *  pathology clustering). `abandoned` is an absence of signal, not a verdict. */
export const NEGATIVE_TURN_OUTCOMES = ['corrected', 'frustrated'] as const;
const NEGATIVE_TURN_OUTCOME_SET: ReadonlySet<TurnOutcome> = new Set(NEGATIVE_TURN_OUTCOMES);

/** The event every rate downstream is really about: a turn the user had to
 *  correct, or was unhappy with. K_align's numerator, the craft-retirement
 *  signal, and the GEPA split's optimization target are all this predicate. */
export function isNegativeOutcome(outcome: TurnOutcome | null): boolean {
  return outcome !== null && NEGATIVE_TURN_OUTCOME_SET.has(outcome);
}

/** What a HUMAN may say about a turn when hand-labeling it (calibration.ts):
 *  any real outcome, or an admission that the follow-up does not settle it.
 *  `unclear` is a verdict, not a skip — it is recorded, then excluded from
 *  every estimate. */
export const OUTCOME_LABELS = [...TURN_OUTCOMES, 'unclear'] as const;

export type OutcomeLabel = (typeof OUTCOME_LABELS)[number];

/** Where an outcome row came from, in the ledger's canonical order — the one
 *  list the table's CHECK constraint derives from:
 *    explicit    — the user's thumbs.
 *    classifier  — the LLM verdict on a real conversational follow-up.
 *    session_end — the session-end (abandoned) rule.
 *    take_pick   — an Alternate Takes pick (mcts/takes.ts): an explicit
 *                  preference between explored takes.
 *    execution   — the ENVIRONMENT's verdict on a turn no user will grade
 *                  (see `executionVerdict`). Machine evidence, not a person's
 *                  judgment; every reader that speaks about user opinion must
 *                  say so and exclude it (alignment.ts does).
 */
export const TURN_OUTCOME_SOURCES = [
  'explicit', 'classifier', 'session_end', 'take_pick', 'execution',
] as const;

export type TurnOutcomeSource = (typeof TURN_OUTCOME_SOURCES)[number];

/** Which observation of one turn is its EFFECTIVE verdict, strongest first:
 *  a thumb outranks a take pick, which outranks the classifier, which outranks
 *  the environment. `session_end` is absent and ranks last. Both ledger reads
 *  that resolve a verdict bind this list into their ORDER BY, so the rule
 *  lives here once. */
export const TURN_OUTCOME_SOURCE_PRECEDENCE = [
  'explicit', 'take_pick', 'classifier', 'execution',
] as const satisfies readonly TurnOutcomeSource[];

/** Sources that carry a HUMAN's opinion of the turn. The complement is
 *  `execution` — real evidence about what happened, silent about whether the
 *  user wanted it. */
export function isUserVerdictSource(source: TurnOutcomeSource): boolean {
  return source !== 'execution';
}

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

/** What an execution-grounded verdict is worth, against the 0.5 neutral.
 *
 *  Strictly inside the poles a USER verdict reaches (0.9 / 0.2): the
 *  environment reporting that the agent's own actions ran is real evidence and
 *  is not someone saying the work was right, so a run of green turns can never
 *  move a crafted tool's score as far as one person actually approving it —
 *  and a run of failures can never sink it as far as one person complaining. */
const EXECUTION_QUALITY = { accepted: 0.7, negative: 0.3 } as const;

/** Outcome → turn quality. Accepted/corrected reuse the explicit-feedback
 *  constants (one mapping); frustration is the strongest negative signal;
 *  abandonment is neutral (no signal, not a verdict). An execution-sourced
 *  row is scored on its own, narrower band — it is a proxy, and is priced
 *  as one. */
export function outcomeQuality(outcome: TurnOutcome, source: TurnOutcomeSource = 'classifier'): number {
  if (outcome === 'abandoned') return 0.5;
  if (source === 'execution') {
    return outcome === 'accepted' ? EXECUTION_QUALITY.accepted : EXECUTION_QUALITY.negative;
  }
  if (outcome === 'frustrated') return 0.1;
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

// ── The execution-grounded verdict (no LLM, no user) ─────────────

/** Calls that only READ state. They prove nothing about whether the turn's
 *  work landed, so a turn made of them alone has no execution verdict — and a
 *  pattern extracted from them encodes nothing reusable, which is why the
 *  extractor skips them too. One definition, both readers.
 *
 *  `fact` was folded into `memory`; stored turns from before that carry the old
 *  name and must still score the same, so it is recognised too. */
export function isPureLookupCall(call: Pick<ToolCallRecord, 'name' | 'args'>): boolean {
  if (call.name === 'memory') return call.args.action === 'search' || call.args.action === 'recall';
  return call.name === 'fact' && call.args.action === 'recall';
}

/** What the environment reported about a turn: it ran, or it did not. */
export type ExecutionVerdict = 'succeeded' | 'failed';

/**
 * The ENVIRONMENT's verdict on a turn — the only evidence available for the
 * turns no user will ever grade (a one-shot `kinu exec`, a reactor or job
 * wake). Deterministic: no model is asked, and nothing the model WROTE is read.
 *
 * The evidence is the tool-execution record the turn already carries, read
 * SYMMETRICALLY: it used to be consulted only when it said "something broke",
 * so a headless ledger could record that a turn went wrong and could never
 * record that one went right, and every downstream estimate (craft EMA and
 * retirement, GEPA's split, the archive's real-outcome priors) inherited that
 * pessimism.
 *
 *   • no non-lookup tool call → null. The turn never acted on the world, so
 *     the world returned no verdict, and an ungraded turn is recorded as
 *     ungraded rather than as a success.
 *   • the transport or the stream died (`hadError`) → 'failed'.
 *   • the turn's LAST acting call came back a failure → 'failed'.
 *   • otherwise → 'succeeded'.
 *
 * `hadError` alone is not the question, and reading only it is what made this
 * a fake reward. The accumulator raises that flag from the transport
 * discriminator (`success === false`), and the `run` tool catches a non-zero
 * exit and hands it back as an ordinary successful result whose text begins
 * `Error (exit N)`. So a turn whose single command exited 3 arrived here
 * flagless and was graded `accepted` at quality 0.70 — evolution paid a reward
 * for a command that failed. The call cards and the model's own steering hints
 * already read that text; `isFailingResultText` is that same one definition.
 *
 * The LAST acting call decides, not any of them, because an intermediate
 * failure the turn went on to fix is the system working: run the suite, see it
 * red, edit, run it green. Grading that turn `corrected` would punish a
 * successful repair, which is the same mistake in the opposite direction (and
 * the recovery clock in recovery.ts already reads a broken failure streak the
 * same way).
 *
 * It remains a PROXY, priced as one (EXECUTION_QUALITY) and sourced as one
 * (`source: 'execution'`): it says the agent's own actions against the world
 * completed, not that the task was solved the way the user wanted. Its worth is
 * that the model cannot write it — it is produced by the tools and the runtime,
 * so no amount of confident prose moves it. Where a task carries its own
 * verification command, running that command IS how ground truth enters this
 * record, which is the whole reason the last call has to be read honestly.
 */
export function executionVerdict(
  turn: Pick<CompletedTurn, 'hadError' | 'toolCalls'>,
): ExecutionVerdict | null {
  const acting = turn.toolCalls.filter((call) => !isPureLookupCall(call));
  const last = acting[acting.length - 1];
  if (last === undefined) return null;
  if (turn.hadError) return 'failed';
  const result = last.result ?? '';
  const text = v.is(v.string(), result) ? result : JSON.stringify(result);
  return isFailingResultText(text) ? 'failed' : 'succeeded';
}

/** The ledger outcome an execution verdict records as. */
export function executionVerdictOutcome(verdict: ExecutionVerdict): TurnOutcome {
  return verdict === 'succeeded' ? 'accepted' : 'corrected';
}

// ── The classifier (one cheap LLM call per non-trivial turn) ─────

export interface OutcomeClassification {
  outcome: Exclude<TurnOutcome, 'abandoned'>;
  confidence: number;
  evidence: string;
}

const OutcomeClassificationSchema = v.object({
  outcome: v.picklist(['accepted', 'corrected', 'frustrated']),
  confidence: v.optional(v.number()),
  evidence: v.optional(v.string()),
});

/**
 * The classifier's prompt.
 *
 * Each outcome definition carries a one-line worked example, and the terse-reply
 * block under them teaches the boundary this verdict is actually wrong on: a flat
 * "no" and an exasperated "again?!" are the same length and are different rows in
 * the ledger. Everything downstream counts these judgements rather than what
 * happened — "if the classifier misses a third of the corrections, all of those
 * numbers are wrong by an unknown amount in an unknown direction"
 * (docs/EVOLUTION.md) — so the boundary is shown by contrast instead of left to be
 * inferred from three one-line definitions by a model that reads them literally.
 *
 * `confidence` is named as the home for a follow-up that settles nothing. Without
 * that, a model asked for one of three labels answers with one of three labels,
 * and the calibration profile (calibration.ts) measures a rater that never admits
 * doubt — which is the one thing its estimator cannot correct for.
 */
export function buildOutcomeClassifierPrompt(input: {
  userMessage: string;
  assistantResponse: string;
  followup: string;
}): string {
  return (
    `You are reviewing how a conversation turn landed. The user sent a request, ` +
    `the assistant responded, and the user has now sent a FOLLOW-UP message. ` +
    `Classify what the follow-up reveals about the previous response.\n\n` +
    `Previous user request:\n"${evidenceWindow(input.userMessage, EVIDENCE_BUDGETS.outcomeUserMessage)}"\n\n` +
    `Assistant response:\n"${evidenceWindow(input.assistantResponse, EVIDENCE_BUDGETS.outcomeAssistantResponse)}"\n\n` +
    `User's follow-up message:\n"${evidenceWindow(input.followup, EVIDENCE_BUDGETS.outcomeFollowup)}"\n\n` +
    `Outcomes:\n` +
    `- "accepted": the user moved on, built on the answer, or asked something new that presumes it ` +
    `worked. ("great, now add the retry" — the next step only makes sense if the last one landed.)\n` +
    `- "corrected": the user re-asked the same thing, fixed a mistake, contradicted the answer, or had to ` +
    `re-state what they already asked for. ("no, I said STAGING" — the same ask, restated because the ` +
    `answer missed it.)\n` +
    `- "frustrated": the user expressed explicit dissatisfaction or negative emotion about the response. ` +
    `("why do you keep breaking the build" — a complaint about the response, not about the build.)\n\n` +
    `A terse follow-up is the one this gets wrong. Read what it is ABOUT, not how sharp it sounds:\n` +
    `- "no" / "wrong file" / "not that one" → corrected. A flat contradiction carries no complaint.\n` +
    `- "no, seriously?" / "again?!" → frustrated. The complaint is about the response itself.\n` +
    `- "ok" / "thanks" → accepted. A short acknowledgement is still an acknowledgement.\n` +
    `- "hm" / "what about the other one?" → nothing is settled. Answer with the outcome the disputed ` +
    `request supports, at a LOW confidence.\n\n` +
    `Not evidence the answer worked: a follow-up that changes the subject while the ask still stands, ` +
    `or one where the user does the work themselves. Moving on and being satisfied are different things.\n` +
    `An unsettled follow-up belongs in confidence rather than in a firmer verdict — an honest 0.4 is ` +
    `worth more than a 0.9 that is wrong, because this field is what the calibration profile measures.\n\n` +
    `JSON shape: {"outcome":"accepted"|"corrected"|"frustrated","confidence":<0..1>,"evidence":"<short reason>"}\n` +
    jsonObjectOnlyInstruction()
  );
}

/** Classify turn N's outcome from the user's follow-up — one small LLM call.
 *
 *  Returns null for exactly one thing: model output with no usable JSON verdict
 *  in it. A transport failure is NOT that and propagates — "the model answered
 *  something we cannot read" and "we never reached the model" are different
 *  facts, and the caller records the first as a deliberately ungraded turn. */
export async function classifyTurnOutcome(
  llm: LLM,
  input: { userMessage: string; assistantResponse: string; followup: string },
): Promise<OutcomeClassification | null> {
  const raw = await llm.complete(buildOutcomeClassifierPrompt(input));
  const json = tolerate(() => extractJsonObject(raw), 'malformed-input');
  if (json === undefined) return null;
  const parsed = v.safeParse(OutcomeClassificationSchema, json);
  if (!parsed.success) return null;
  const confidence = parsed.output.confidence !== undefined && Number.isFinite(parsed.output.confidence)
    ? Math.min(1, Math.max(0, parsed.output.confidence))
    : 0.5;
  return {
    outcome: parsed.output.outcome,
    confidence,
    evidence: parsed.output.evidence ?? '',
  };
}

// ── The durable outcome ledger ───────────────────────────────────

const TURN_OUTCOMES_DDL = `(
    id TEXT PRIMARY KEY,
    turn_id TEXT,
    session_id TEXT NOT NULL DEFAULT 'default',
    outcome TEXT NOT NULL CHECK (outcome IN (${sqlCheckList(TURN_OUTCOMES)})),
    confidence REAL NOT NULL,
    source TEXT NOT NULL CHECK (source IN (${sqlCheckList(TURN_OUTCOME_SOURCES)})),
    user_message TEXT NOT NULL,
    assistant_response TEXT NOT NULL,
    followup TEXT,
    scaffold_version INTEGER,
    created_at INTEGER NOT NULL,
    evidence TEXT
  )`;

export function initTurnOutcomeTables(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS turn_outcomes ${TURN_OUTCOMES_DDL}`);
  // Lessons ledger — reflection prose with provenance. Self-scored lessons
  // (no real user signal behind them) stay 'provisional' and OUT of the
  // derived view until a real negative outcome on one of their turns
  // corroborates them (the audit's net-negative-lessons fix).
  // The generated pattern, held between the model call that produced it and the
  // crafted tool it becomes. Same shape and same reason as `sleep_time_updates`:
  // the answer is expensive and the application is not atomic with it, so a
  // replay applies what was DECIDED rather than asking a model that may decide
  // differently. Retired as soon as its tombstone lands.
  execRaw(`CREATE TABLE IF NOT EXISTS pattern_extractions (
    effect_key TEXT PRIMARY KEY,
    answer     TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  execRaw(`CREATE TABLE IF NOT EXISTS lessons ${LESSONS_DDL}`);
  // Gold labels — turns a HUMAN judged directly, the calibration set that
  // measures how far the classifier's verdicts are from the truth
  // (calibration.ts). Append-only: a re-label inserts a new row and the newest
  // wins, so nothing a human spent attention on is overwritten in place.
  execRaw(`CREATE TABLE IF NOT EXISTS outcome_labels (
    id TEXT PRIMARY KEY,
    outcome_id TEXT NOT NULL,
    label TEXT NOT NULL CHECK (label IN (${sqlCheckList(OUTCOME_LABELS)})),
    labeler TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  // The same verdicts from LLM judges instead of the human — one row per model
  // per turn (evolution/ensemble.ts). Kept beside the gold labels rather than
  // in them so a model's opinion can never be counted as ground truth by a
  // query that forgot to filter; append-only for the same reason as above.
  execRaw(`CREATE TABLE IF NOT EXISTS outcome_ensemble_labels (
    id TEXT PRIMARY KEY,
    outcome_id TEXT NOT NULL,
    model TEXT NOT NULL,
    label TEXT NOT NULL CHECK (label IN (${sqlCheckList(OUTCOME_LABELS)})),
    created_at INTEGER NOT NULL
  )`);
}

export interface OutcomeLabelRow {
  id: string;
  outcomeId: string;
  label: OutcomeLabel;
  labeler: string;
  createdAt: number;
}

/** Append a labeling pass. Returns how many rows were written. */
export function recordOutcomeLabels(sql: SqlExecutor, input: {
  labeler: string;
  labels: ReadonlyArray<{ outcomeId: string; label: OutcomeLabel }>;
  now?: number;
}): number {
  const now = input.now ?? nowMs();
  for (const entry of input.labels) {
    void sql`INSERT INTO outcome_labels (id, outcome_id, label, labeler, created_at)
        VALUES (${`lbl-${nanoid()}`}, ${entry.outcomeId}, ${entry.label}, ${input.labeler}, ${now})`;
  }
  return input.labels.length;
}

interface RawOutcomeLabelRow {
  id: string; outcome_id: string; label: OutcomeLabel; labeler: string; created_at: number;
}

function toOutcomeLabelRow(r: RawOutcomeLabelRow): OutcomeLabelRow {
  return {
    id: r.id, outcomeId: r.outcome_id, label: r.label,
    labeler: r.labeler, createdAt: r.created_at,
  };
}

/** Every stored label, newest first. Unbounded when `limit` is omitted: the
 *  gold set is the whole basis of every corrected number, and a window that
 *  silently dropped the oldest labels would drop the turns they speak for. */
export function listOutcomeLabels(sql: SqlExecutor, limit?: number): OutcomeLabelRow[] {
  const rows = limit === undefined
    ? sql<RawOutcomeLabelRow>`SELECT * FROM outcome_labels ORDER BY created_at DESC, id DESC`
    : sql<RawOutcomeLabelRow>`
        SELECT * FROM outcome_labels ORDER BY created_at DESC, id DESC LIMIT ${limit}`;
  return rows.map(toOutcomeLabelRow);
}

/** The label that counts for each turn: the most recent one. Append-only
 *  storage makes a correction a new row, so "newest wins" is the whole read. */
export function goldLabels(sql: SqlExecutor): Map<string, OutcomeLabelRow> {
  const latest = new Map<string, OutcomeLabelRow>();
  for (const row of listOutcomeLabels(sql)) {
    if (!latest.has(row.outcomeId)) latest.set(row.outcomeId, row);
  }
  return latest;
}

export interface EnsembleLabelRow {
  id: string;
  outcomeId: string;
  /** `<provider>/<modelId>` the verdict came from. */
  model: string;
  label: OutcomeLabel;
  createdAt: number;
}

/** Append one model's pass over a set of turns. */
export function recordEnsembleLabels(sql: SqlExecutor, input: {
  model: string;
  labels: ReadonlyArray<{ outcomeId: string; label: OutcomeLabel }>;
  now?: number;
}): number {
  const now = input.now ?? nowMs();
  for (const entry of input.labels) {
    void sql`INSERT INTO outcome_ensemble_labels (id, outcome_id, model, label, created_at)
        VALUES (${`ens-${nanoid()}`}, ${entry.outcomeId}, ${input.model}, ${entry.label}, ${now})`;
  }
  return input.labels.length;
}

/** The verdict that counts for each (turn, model): the most recent one. Same
 *  "append-only, newest wins" read as `goldLabels`. */
export function ensembleLabels(sql: SqlExecutor): EnsembleLabelRow[] {
  const rows = sql<{
    id: string; outcome_id: string; model: string; label: OutcomeLabel; created_at: number;
  }>`SELECT * FROM outcome_ensemble_labels ORDER BY created_at DESC, id DESC`;
  const latest = new Map<string, EnsembleLabelRow>();
  for (const r of rows) {
    const key = `${r.outcome_id}\n${r.model}`;
    if (latest.has(key)) continue;
    latest.set(key, {
      id: r.id, outcomeId: r.outcome_id, model: r.model, label: r.label, createdAt: r.created_at,
    });
  }
  return [...latest.values()];
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
  /** WHY this verdict: the classifier's one-sentence reason, or the execution
   *  verdict's observation. Null where the source is its own evidence (a thumb). */
  evidence: string | null;
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
  evidence?: string | null;
  now?: number;
}
/** Record one observation of a turn's outcome. APPEND-ONLY: a second verdict
 *  on the same turn inserts another row and never touches prior ones, because
 *  each observation is evidence calibration labels address by id — deleting or
 *  rewriting the classifier's row orphaned every human/ensemble label spent on
 *  it and erased exactly the data calibration exists to measure.
 *
 *  Readers never see both rows as verdicts: `listTurnOutcomes` (and everything
 *  built on it) resolves one EFFECTIVE outcome per turn by source precedence.
 *  Texts are windowed to keep rows bounded — and this is the ceiling for
 *  everything downstream, since the GEPA eval instances and the replay judge
 *  both read these rows and can never see more than was stored. */
export function recordTurnOutcome(sql: SqlExecutor, input: RecordTurnOutcomeInput): string {
  const id = `outc-${nanoid()}`;
  void sql`INSERT INTO turn_outcomes
        (id, turn_id, session_id, outcome, confidence, source,
         user_message, assistant_response, followup, scaffold_version, created_at, evidence)
      VALUES
        (${id}, ${input.turnId ?? null}, ${input.sessionId ?? 'default'}, ${input.outcome},
         ${input.confidence}, ${input.source}, ${evidenceWindow(input.userMessage, EVIDENCE_BUDGETS.storedUserMessage)},
         ${evidenceWindow(input.assistantResponse, EVIDENCE_BUDGETS.storedAssistantResponse)},
         ${input.followup === null || input.followup === undefined ? null : evidenceWindow(input.followup, EVIDENCE_BUDGETS.storedFollowup)},
         ${input.scaffoldVersion ?? null}, ${input.now ?? nowMs()},
         ${input.evidence === null || input.evidence === undefined ? null : evidenceWindow(input.evidence, EVIDENCE_BUDGETS.storedEvidence)})`;
  return id;
}

interface RawOutcomeRow {
  id: string; turn_id: string | null; session_id: string; outcome: TurnOutcome;
  confidence: number; source: TurnOutcomeSource; user_message: string;
  assistant_response: string; followup: string | null;
  scaffold_version: number | null; created_at: number; evidence: string | null;
}

function toOutcomeRow(r: RawOutcomeRow): TurnOutcomeRow {
  return {
    id: r.id, turnId: r.turn_id, sessionId: r.session_id, outcome: r.outcome,
    confidence: r.confidence, source: r.source, userMessage: r.user_message,
    assistantResponse: r.assistant_response, followup: r.followup,
    scaffoldVersion: r.scaffold_version, createdAt: r.created_at,
    evidence: r.evidence ?? null,
  };
}
/** Recorded outcomes resolved to ONE EFFECTIVE verdict per turn, newest first,
 *  optionally filtered by outcome kinds.
 *
 *  The ledger is append-only (every observation stays, because calibration
 *  labels address rows by id), so a raw read would show both a classifier's
 *  guess and the explicit thumb that later overruled it — double-counting the
 *  turn in every rate and split downstream. This read picks, per identified
 *  turn, the observation that wins {@link TURN_OUTCOME_SOURCE_PRECEDENCE},
 *  recency breaking ties within a source. Unidentified observations (no
 *  `turn_id` — possible only for turns that predate ids) each stand alone.
 *
 *  The filter is applied to the EFFECTIVE verdicts, so `limit` bounds the rows
 *  actually wanted without silently dropping the rare outcomes
 *  (`corrected`/`frustrated` — the only ones the optimizer learns from).
 *
 *  A NEGATIVE `limit` is unbounded — the same sentinel
 *  `selectEffectiveTurnOutcomes` already speaks internally. A caller that must
 *  filter the rows itself before cutting them (evolution debt excludes the turns
 *  a refinement already took) cannot use a window: the rows it wants may sit
 *  behind any number of rows it does not.
 *
 *  `turnIds` narrows to a NAMED trajectory rather than a window: a refinement
 *  reviews the turns its request captured, which may be older than any limit
 *  would reach. Filtered here on the effective verdicts, exactly as
 *  `hasNegativeOutcome` does, so the precedence rule stays in one place. */
export function listTurnOutcomes(
  sql: SqlExecutor,
  opts: {
    limit?: number;
    outcomes?: ReadonlyArray<TurnOutcome>;
    turnIds?: ReadonlyArray<string>;
  } = {},
): TurnOutcomeRow[] {
  if (opts.turnIds === undefined) {
    return selectEffectiveTurnOutcomes(sql, opts.limit ?? 50, opts.outcomes);
  }
  if (opts.turnIds.length === 0) return [];
  const wanted = new Set(opts.turnIds);
  return selectEffectiveTurnOutcomes(sql, undefined, opts.outcomes)
    .filter((row) => row.turnId !== null && wanted.has(row.turnId))
    .slice(0, opts.limit ?? wanted.size);
}

/** One effective-verdict read over the append-only ledger, shared by every
 *  operational consumer (rates, splits, gates). The CASE ranks sources by
 *  {@link TURN_OUTCOME_SOURCE_PRECEDENCE}, bound member by member because the
 *  tagged-template executor binds values, never SQL text. A fixed four-slot IN
 *  list expresses every outcome filter with the same fixed-arity binding;
 *  unused slots bind '' — a value the CHECK constraint forbids, so it matches
 *  nothing. */
function selectEffectiveTurnOutcomes(
  sql: SqlExecutor,
  limit: number | undefined,
  outcomes?: ReadonlyArray<TurnOutcome>,
): TurnOutcomeRow[] {
  const wanted = TURN_OUTCOMES.filter((o) => !outcomes || outcomes.includes(o));
  const [w0, w1, w2, w3] = [wanted[0] ?? '', wanted[1] ?? '', wanted[2] ?? '', wanted[3] ?? ''];
  const [p0, p1, p2, p3] = TURN_OUTCOME_SOURCE_PRECEDENCE;
  const ranked = sql<RawOutcomeRow & { eff_rn: number }>`
    SELECT * FROM (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY turn_id
        ORDER BY CASE source WHEN ${p0} THEN 0 WHEN ${p1} THEN 1
                 WHEN ${p2} THEN 2 WHEN ${p3} THEN 3 ELSE 4 END ASC,
                 created_at DESC, id DESC
      ) AS eff_rn
      FROM turn_outcomes
      WHERE turn_id IS NOT NULL
    )
    WHERE eff_rn = 1 AND outcome IN (${w0}, ${w1}, ${w2}, ${w3})
    UNION ALL
    SELECT *, 1 AS eff_rn FROM turn_outcomes WHERE turn_id IS NULL
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit === undefined ? -1 : limit}`;
  return ranked.map(toOutcomeRow);
}

/** The outcome an Alternate Takes pick already recorded for this turn, if
 *  any — the follow-up classifier must not overwrite that explicit signal. */
export function takePickOutcome(sql: SqlExecutor, turnId: string | null | undefined): TurnOutcome | null {
  if (!turnId) return null;
  const rows = sql<{ outcome: TurnOutcome }>`
    SELECT outcome FROM turn_outcomes
    WHERE turn_id = ${turnId} AND source = 'take_pick' LIMIT 1`;
  return rows[0]?.outcome ?? null;
}

/**
 * The verdict a turn's review already RECORDED, for a retry resuming its
 * suffix.
 *
 * A review is a chain of governed model calls, so a retry after a refusal
 * re-classifies — and a classifier that answers differently the second time
 * would run corroboration, import settlement, reflection and pattern extraction
 * against a verdict the ledger does not hold. The recorded row is the verdict.
 * Ranked by the same {@link TURN_OUTCOME_SOURCE_PRECEDENCE} as
 * `selectEffectiveTurnOutcomes`, so this reads the answer the rest of the
 * system reads.
 */
export function recordedTurnVerdict(
  sql: SqlExecutor, turnId: string | null | undefined,
): { outcome: TurnOutcome; source: TurnOutcomeSource; confidence: number } | null {
  if (!turnId) return null;
  const [p0, p1, p2, p3] = TURN_OUTCOME_SOURCE_PRECEDENCE;
  const rows = sql<{ outcome: TurnOutcome; source: TurnOutcomeSource; confidence: number }>`
    SELECT outcome, source, confidence FROM turn_outcomes
    WHERE turn_id = ${turnId}
    ORDER BY CASE source WHEN ${p0} THEN 0 WHEN ${p1} THEN 1
             WHEN ${p2} THEN 2 WHEN ${p3} THEN 3 ELSE 4 END ASC,
             created_at DESC, id DESC
    LIMIT 1`;
  return rows[0] ?? null;
}

/** True when any of the given turn ids has an EFFECTIVE corrected/frustrated
 *  outcome — the session-reflection gate's real-signal check. Effective, not
 *  raw: an old classifier `corrected` that a later explicit thumb overruled
 *  must not keep a turn flagged negative forever. */
export function hasNegativeOutcome(sql: SqlExecutor, turnIds: ReadonlyArray<string>): boolean {
  if (turnIds.length === 0) return false;
  const wanted = new Set(turnIds);
  return selectEffectiveTurnOutcomes(sql, undefined, NEGATIVE_TURN_OUTCOMES)
    .some((r) => r.turnId !== null && wanted.has(r.turnId));
}

// ── Real-outcome scaffold rates (route into R2's archive priors) ─

export interface RealOutcomeRate {
  accepted: number;
  negative: number;
}

/** Per-scaffold-version real-outcome record: how turns SERVED by each version
 *  actually landed with the user. The component R2's shadow win-rates lack.
 *  Counts EFFECTIVE verdicts only — one observation per turn, so a turn the
 *  user explicitly accepted after a classifier `corrected` is counted once,
 *  on their word. */
export function realOutcomeScaffoldRates(sql: SqlExecutor): Map<number, RealOutcomeRate> {
  const rates = new Map<number, RealOutcomeRate>();
  for (const row of selectEffectiveTurnOutcomes(sql, undefined)) {
    if (row.scaffoldVersion === null) continue;
    const rate = rates.get(row.scaffoldVersion) ?? { accepted: 0, negative: 0 };
    if (row.outcome === 'accepted') rate.accepted++;
    else if (isNegativeOutcome(row.outcome)) rate.negative++;
    rates.set(row.scaffoldVersion, rate);
  }
  return rates;
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
  /** The complaint the candidate must already address: the user's follow-up on a
   *  ledger-drawn negative, the advisor's note on an advisor-drawn one. */
  followup: string | null;
  /** WHO complained, so the scoring prompt can say it truthfully.
   *
   *  The ledger's own `source` column already separates who graded a turn from
   *  what the verdict was; this is that distinction on the eval side. A metric
   *  that told a judge "the user had to correct it" about a turn no user ever saw
   *  would be teaching the judge a fact the record does not hold. */
  critic: 'user' | 'advisor';
}

export type OutcomeEvalInstance = EvalInstance<string, OutcomeEvalExpectation>;

/**
 * How a scoring prompt names a negative instance's complaint.
 *
 * One table for every scorer. The scaffold metric scores a fresh rollout, the
 * replay judge scores a fresh response, and the section metric scores a
 * counterfactual about wording. They differ in what they ask and not in who
 * said the turn went wrong, and two copies of that sentence is one copy that
 * eventually says something else.
 *
 * The `user` wording is the sentence the prompts already carried, to the byte:
 * a ledger-drawn instance scores exactly as it did before advisor notes existed.
 */
export const CRITIC_PROSE = {
  user: { verdict: 'the user had to correct it', complaint: "User's correction" },
  advisor: {
    verdict: 'no user ever graded it, and a second model reviewing the turn found this',
    complaint: "Reviewer's note",
  },
} as const satisfies Readonly<
  Record<OutcomeEvalExpectation['critic'], { verdict: string; complaint: string }>
>;

/**
 * The 1.0 / 0.0 sentence a scorer states for each kind of recorded outcome.
 *
 * Each scorer names its own subject here (a fresh response, a candidate
 * wording). Everything else in the criterion, the critic's framing and the
 * windowed evidence, comes from {@link renderOutcomeCriterion}, so three prompts
 * cannot drift on what the record holds.
 */
export interface OutcomeScoringRule {
  readonly accepted: string;
  readonly failed: string;
}

/** The rule for a scorer that compares a FRESH response with the recorded
 *  one: the scaffold metric's rollout and the replay judge's re-run. */
export const FRESH_RESPONSE_RULE: OutcomeScoringRule = {
  accepted: 'Score 1.0 when the new response is at least as good, 0.0 when it regresses.',
  failed: 'Score 1.0 when the new response already addresses the correction, 0.0 when it '
    + 'repeats the failure.',
};

/** The criterion block of a scoring prompt: what the record says about the
 *  turn, who said it, and the windowed evidence behind it. */
export function renderOutcomeCriterion(
  expected: OutcomeEvalExpectation | undefined,
  rule: OutcomeScoringRule,
): string {
  if (expected && expected.outcome === 'accepted') {
    return `The agent's response below was ACCEPTED by the user. ${rule.accepted}\n\n`
      + `Accepted response:\n${evidenceWindow(expected.recordedResponse, EVIDENCE_BUDGETS.replayReferenceResponse)}`;
  }
  const critic = CRITIC_PROSE[expected?.critic ?? 'user'];
  return `The agent's response below FAILED — ${critic.verdict}. ${rule.failed}\n\n`
    + `Failed response:\n${evidenceWindow(expected?.recordedResponse ?? '', EVIDENCE_BUDGETS.replayFailedResponse)}\n\n`
    + `${critic.complaint}:\n${evidenceWindow(expected?.followup ?? '(not recorded)', EVIDENCE_BUDGETS.replayCorrection)}`;
}

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

// ── Lessons ledger (provisional → corroborated) ──────────────────

/** Where a lesson came from, in the ledger's canonical order — the one list
 *  the table's CHECK constraint derives from:
 *    turn_reflection     — the one-sentence reflection on a turn that went
 *                          wrong (engine.reviewTurn).
 *    session_reflection  — the window-close reflection over recent lessons.
 *    execution_recovery  — the step clock's machine observation: a failure
 *                          streak broken by a changed call that ran clean
 *                          (evolution/recovery.ts). Bound to no turn, so the
 *                          corroboration gate structurally never admits it.
 *    import              — an experience imported from another workspace,
 *                          adopted only on this workspace's own accepted-turn
 *                          verdict; born corroborated on that evidence.
 *
 *  Corroboration lives ONLY in the row's status. Nothing is ever copied into
 *  MEMORY.md, and every reader that wants recent lessons reads them here
 *  (`renderRecentLessons`, `listLessons`) — so a workspace reset
 *  can never hide a lesson its corroborated row still holds. */
export const LESSON_SOURCES = [
  'turn_reflection', 'session_reflection', 'execution_recovery', 'import',
] as const;
export type LessonSource = (typeof LESSON_SOURCES)[number];
export type LessonStatus = 'provisional' | 'corroborated';

/** The lessons DDL, with its CHECK derived from the source list — referenced
 *  by `initTurnOutcomeTables` (declared above; function bodies evaluate after
 *  module init, so the order is safe). */
const LESSONS_DDL = `(
    id TEXT PRIMARY KEY,
    turn_ids TEXT NOT NULL,
    text TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN (${sqlCheckList(LESSON_SOURCES)})),
    status TEXT NOT NULL CHECK (status IN ('provisional','corroborated')),
    created_at INTEGER NOT NULL,
    corroborated_at INTEGER
  )`;

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
  /**
   * The STABLE identity of the work that produced this lesson, for a caller that
   * owes it once.
   *
   * A fresh id makes every retry a new row: a reflection whose tombstone had not
   * landed, or an import promoted twice across an interruption, each appended a
   * second copy that later prompts then wove in. Keyed, the retry writes the row
   * it already wrote. Absent for a caller with nothing to replay it.
   */
  key?: string;
}): string {
  const id = input.key === undefined ? `lsn-${nanoid()}` : `lsn-${input.key}`;
  const now = input.now ?? nowMs();
  void sql`INSERT INTO lessons (id, turn_ids, text, source, status, created_at, corroborated_at)
      VALUES (${id}, ${JSON.stringify(input.turnIds)}, ${input.text}, ${input.source},
              ${input.status}, ${now}, ${input.status === 'corroborated' ? now : null})
      ON CONFLICT(id) DO NOTHING`;
  return id;
}

interface RawLessonRow {
  id: string; turn_ids: string; text: string; source: LessonSource;
  status: LessonStatus; created_at: number; corroborated_at: number | null;
}

function toLessonRow(r: RawLessonRow): LessonRow {
  // turn_ids is written by recordLesson as JSON.stringify(string[]), so a row
  // that does not parse is corruption — not a lesson tied to no turn. Reading
  // it as untied left it permanently un-corroboratable, which is the one thing
  // that keeps a lesson out of MEMORY.md forever.
  const turnIds = v.parse(v.array(v.string()), parseJsonValue(r.turn_ids));
  return {
    id: r.id, turnIds, text: r.text, source: r.source, status: r.status,
    createdAt: r.created_at, corroboratedAt: r.corroborated_at,
  };
}

export function listLessons(
  sql: SqlExecutor,
  opts: { status?: LessonStatus; source?: LessonSource; limit?: number } = {},
): LessonRow[] {
  const status = opts.status ?? null;
  const source = opts.source ?? null;
  const rows = sql<RawLessonRow>`SELECT * FROM lessons
    WHERE (${status} IS NULL OR status = ${status})
      AND (${source} IS NULL OR source = ${source})
    ORDER BY created_at DESC LIMIT ${opts.limit ?? 100}`;
  return rows.map(toLessonRow);
}

/** One lesson by id, or null. */
export function getLesson(sql: SqlExecutor, id: string): LessonRow | null {
  const rows = sql<RawLessonRow>`SELECT * FROM lessons WHERE id = ${id} LIMIT 1`;
  return rows[0] ? toLessonRow(rows[0]) : null;
}

/**
 * The newest corroborated lessons as one prose block — what a turn's dynamic
 * context weaves in place of the MEMORY.md copies this module stopped writing.
 * Derived from the ledger, so it is exactly what corroboration admits, no more.
 */
export function renderRecentLessons(sql: SqlExecutor, limit = 5): string {
  return listLessons(sql, { status: 'corroborated', limit })
    .map((lesson) => lesson.text)
    .join('\n');
}

/** A real negative outcome landed on `turnId`: flip every provisional lesson
 *  tied to that turn to corroborated. Corroboration is a row-status change
 *  only — nothing is appended to MEMORY.md; readers derive from these rows. */
export function corroborateLessonsForTurn(sql: SqlExecutor, turnId: string, now = nowMs()): LessonRow[] {
  const provisional = listLessons(sql, { status: 'provisional', limit: 200 });
  const matched = provisional.filter((l) => l.turnIds.includes(turnId));
  for (const lesson of matched) {
    void sql`UPDATE lessons SET status = 'corroborated', corroborated_at = ${now} WHERE id = ${lesson.id}`;
  }
  return matched.map((l) => ({ ...l, status: 'corroborated' as const, corroboratedAt: now }));
}
