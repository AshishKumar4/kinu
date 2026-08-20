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
import type { ModelMessage } from 'ai';
import type { SqlExecutor, RawSqlExec, LLM } from '../types/primitives';
import type { CompletedTurn, ToolCallRecord } from './types';
import type { EvalInstance } from './gepa/types';
import { extractJsonObject, jsonObjectOnlyInstruction } from '../prompts/structured';
import { EVIDENCE_BUDGETS, evidenceWindow } from '../prompts/evidence-window';
import { reconcileColumns } from '../identity/columns';
import type { ScaffoldArchiveEntry } from '../scaffold/archive';
import { RunEventRecorder } from '../events/recorder';
import { nanoid } from '../utils/nanoid';
import { nowMs } from '../utils/date';
import { parseJsonValue, projectJsonValue, JsonObjectSchema, type JsonValue } from '../utils/json';
import { tolerate } from '../obs/index';
import { isFailingResultText } from '../execution/exec-result';
import { delegationFeatures, renderDelegationFeatures } from './delegation-features';

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
 *  list, from which the table's CHECK constraint and its widening migration
 *  both derive:
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
    `- "accepted": the user moved on, built on the answer, or asked something new that presumes it worked.\n` +
    `- "corrected": the user re-asked the same thing, fixed a mistake, contradicted the answer, or had to ` +
    `re-state what they already asked for.\n` +
    `- "frustrated": the user expressed explicit dissatisfaction or negative emotion about the response.\n\n` +
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

/** `evidence` is LAST deliberately. On an existing table it arrives by
 *  ALTER TABLE ADD COLUMN, which appends — so keeping the declared order
 *  identical to the altered order is what lets the rebuilds below copy with
 *  `SELECT *`. */
const TURN_OUTCOMES_DDL = `(
    id TEXT PRIMARY KEY,
    turn_id TEXT,
    session_id TEXT NOT NULL DEFAULT 'default',
    outcome TEXT NOT NULL CHECK (outcome IN (${TURN_OUTCOMES.map((o) => `'${o}'`).join(',')})),
    confidence REAL NOT NULL,
    source TEXT NOT NULL CHECK (source IN (${TURN_OUTCOME_SOURCES.map((s) => `'${s}'`).join(',')})),
    user_message TEXT NOT NULL,
    assistant_response TEXT NOT NULL,
    followup TEXT,
    scaffold_version INTEGER,
    created_at INTEGER NOT NULL,
    evidence TEXT
  )`;

/** Columns added after the ledger shipped. Both sides of a `SELECT *` rebuild
 *  must carry them, or the copy is a column-count mismatch. */
const TURN_OUTCOMES_POST_RELEASE_COLUMNS = { evidence: 'TEXT' } as const;

export function initTurnOutcomeTables(execRaw: RawSqlExec, sql: SqlExecutor): void {
  // The probe decides whether either migration below runs at all, so it must
  // not fail quietly. It used to `catch { return null }` for "exotic executors
  // without sqlite_master" — every real one is SQLite, and the cost of the
  // excuse was that a failing probe silently skipped BOTH the resume branch
  // and the CHECK-widening rebuild: rows left stranded in turn_outcomes_legacy
  // beside a freshly-minted empty turn_outcomes, the history no longer visible
  // and nothing crashing.
  const tableDdl = (name: string): string | null =>
    sql<{ sql: string }>`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${name}`[0]?.sql ?? null;

  // Resume an interrupted CHECK-widening rebuild: a crash mid-sequence leaves
  // rows stranded in turn_outcomes_legacy while a bare CREATE IF NOT EXISTS
  // would silently start an empty ledger. Finish the copy first. INSERT OR
  // IGNORE (PK ids) makes the resume idempotent at every crash point.
  if (tableDdl('turn_outcomes_legacy') !== null) {
    execRaw(`CREATE TABLE IF NOT EXISTS turn_outcomes ${TURN_OUTCOMES_DDL}`);
    // Both sides before the copy: a rebuild interrupted before `evidence`
    // existed leaves a legacy table one column short of the one it feeds.
    reconcileColumns(sql, execRaw, 'turn_outcomes', TURN_OUTCOMES_POST_RELEASE_COLUMNS);
    reconcileColumns(sql, execRaw, 'turn_outcomes_legacy', TURN_OUTCOMES_POST_RELEASE_COLUMNS);
    execRaw(`INSERT OR IGNORE INTO turn_outcomes SELECT * FROM turn_outcomes_legacy`);
    execRaw(`DROP TABLE turn_outcomes_legacy`);
  }

  execRaw(`CREATE TABLE IF NOT EXISTS turn_outcomes ${TURN_OUTCOMES_DDL}`);
  reconcileColumns(sql, execRaw, 'turn_outcomes', TURN_OUTCOMES_POST_RELEASE_COLUMNS);
  // A table created before a source was added carries a narrower CHECK that
  // SQLite cannot ALTER — rebuild it in place (same columns, data kept). The
  // probe is the source LIST, so adding a member is the only edit a future
  // widening needs. No explicit BEGIN/COMMIT: DO SQLite forbids explicit
  // transaction statements, so crash-safety comes from the resume branch
  // above instead — every intermediate state of this sequence is recoverable
  // from it.
  const ddl = tableDdl('turn_outcomes');
  if (ddl !== null && TURN_OUTCOME_SOURCES.some((source) => !ddl.includes(`'${source}'`))) {
    execRaw(`ALTER TABLE turn_outcomes RENAME TO turn_outcomes_legacy`);
    execRaw(`CREATE TABLE turn_outcomes ${TURN_OUTCOMES_DDL}`);
    execRaw(`INSERT OR IGNORE INTO turn_outcomes SELECT * FROM turn_outcomes_legacy`);
    execRaw(`DROP TABLE turn_outcomes_legacy`);
  }
  // Lessons ledger — reflection prose with provenance. Self-scored lessons
  // (no real user signal behind them) stay 'provisional' and OUT of
  // MEMORY.md until a real negative outcome on one of their turns
  // corroborates them (the audit's net-negative-lessons fix). Same
  // CHECK-widening discipline as turn_outcomes above: the probe is the source
  // LIST, the resume branch finishes an interrupted rebuild.
  if (tableDdl('lessons_legacy') !== null) {
    execRaw(`CREATE TABLE IF NOT EXISTS lessons ${LESSONS_DDL}`);
    execRaw(`INSERT OR IGNORE INTO lessons SELECT * FROM lessons_legacy`);
    execRaw(`DROP TABLE lessons_legacy`);
  }
  execRaw(`CREATE TABLE IF NOT EXISTS lessons ${LESSONS_DDL}`);
  const lessonsDdl = tableDdl('lessons');
  if (lessonsDdl !== null && LESSON_SOURCES.some((source) => !lessonsDdl.includes(`'${source}'`))) {
    execRaw(`ALTER TABLE lessons RENAME TO lessons_legacy`);
    execRaw(`CREATE TABLE lessons ${LESSONS_DDL}`);
    execRaw(`INSERT OR IGNORE INTO lessons SELECT * FROM lessons_legacy`);
    execRaw(`DROP TABLE lessons_legacy`);
  }
  // Gold labels — turns a HUMAN judged directly, the calibration set that
  // measures how far the classifier's verdicts are from the truth
  // (calibration.ts). Append-only: a re-label inserts a new row and the newest
  // wins, so nothing a human spent attention on is overwritten in place.
  execRaw(`CREATE TABLE IF NOT EXISTS outcome_labels (
    id TEXT PRIMARY KEY,
    outcome_id TEXT NOT NULL,
    label TEXT NOT NULL CHECK (label IN (${OUTCOME_LABELS.map((l) => `'${l}'`).join(',')})),
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
    label TEXT NOT NULL CHECK (label IN (${OUTCOME_LABELS.map((l) => `'${l}'`).join(',')})),
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
   *  verdict's observation. Null where the source is its own evidence (a thumb)
   *  or the row predates the column. */
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

/** Record (or, for a known turn id, replace — explicit thumbs override the
 *  classifier) one turn's outcome. Texts are windowed to keep rows bounded —
 *  and this is the ceiling for everything downstream, since the GEPA eval
 *  instances and the replay judge both read these rows and can never see more
 *  than was stored. */
export function recordTurnOutcome(sql: SqlExecutor, input: RecordTurnOutcomeInput): string {
  const id = `outc-${nanoid()}`;
  if (input.turnId) {
    void sql`DELETE FROM turn_outcomes WHERE turn_id = ${input.turnId}`;
  }
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
  return sql<RawOutcomeRow>`
    SELECT * FROM turn_outcomes
    WHERE outcome IN (${w0}, ${w1}, ${w2}, ${w3})
    ORDER BY created_at DESC, id DESC LIMIT ${limit}`.map(toOutcomeRow);
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

/** True when any of the given turn ids has a recorded corrected/frustrated
 *  outcome — the session-reflection gate's real-signal check. */
export function hasNegativeOutcome(sql: SqlExecutor, turnIds: ReadonlyArray<string>): boolean {
  if (turnIds.length === 0) return false;
  const rows = sql<{ turn_id: string | null; outcome: TurnOutcome }>`
    SELECT turn_id, outcome FROM turn_outcomes
    WHERE outcome IN ('corrected','frustrated') AND turn_id IS NOT NULL`;
  const wanted = new Set(turnIds);
  return rows.some((r) => r.turn_id !== null && wanted.has(r.turn_id));
}

// ── Real-outcome scaffold rates (route into R2's archive priors) ─

export interface RealOutcomeRate {
  accepted: number;
  negative: number;
}

/** Per-scaffold-version real-outcome record: how turns SERVED by each version
 *  actually landed with the user. The component R2's shadow win-rates lack. */
export function realOutcomeScaffoldRates(sql: SqlExecutor): Map<number, RealOutcomeRate> {
  const rows = sql<{ scaffold_version: number; accepted: number; negative: number }>`
    SELECT scaffold_version,
           SUM(CASE WHEN outcome = 'accepted' THEN 1 ELSE 0 END) AS accepted,
           SUM(CASE WHEN outcome IN ('corrected','frustrated') THEN 1 ELSE 0 END) AS negative
    FROM turn_outcomes
    WHERE scaffold_version IS NOT NULL
    GROUP BY scaffold_version`;
  return new Map(rows.map((r) => [r.scaffold_version, { accepted: r.accepted ?? 0, negative: r.negative ?? 0 }]));
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

/** Only the discriminant and the timestamp are read here: what a turn DID now
 *  comes from the step transcript, not from event names. */
interface StoredRunEvent {
  type: string;
}

const StoredRunEventSchema = v.object({
  type: v.string(),
});

const ChatRunStartSchema = v.object({
  type: v.literal('run_start'),
  caused_by: v.literal('chat'),
  userMessage: v.string(),
});

/** One stored run event, or null when the row is not an event shape this reads.
 *  A payload that is not JSON at all is corruption of a ledger this process
 *  wrote, so it propagates rather than being counted as "no such event". */
function parseRunEvent(payload: string): StoredRunEvent | null {
  const parsed = v.safeParse(StoredRunEventSchema, parseJsonValue(payload));
  return parsed.success ? parsed.output : null;
}

/**
 * The tool calls a turn's durable step transcript records — name, real
 * arguments, and the tool's own output, paired on the provider's call id.
 *
 * Reconstructing them from `tool_call_end` rows instead gave every call an
 * empty `args`, and `delegationFeatures`' fingerprint is null for an
 * argument-less call — so the redundancy and loop counts in a corpus row could
 * never be anything but zero, whatever the turn actually did.
 */
function toolCallsFromTranscript(messages: readonly ModelMessage[]): ToolCallRecord[] {
  const results = new Map<string, JsonValue>();
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    for (const part of message.content) {
      if (part.type === 'tool-result') results.set(part.toolCallId, projectJsonValue({ value: part.output }));
    }
  }
  const calls: ToolCallRecord[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== 'tool-call') continue;
      const args = v.safeParse(JsonObjectSchema, part.input);
      calls.push({
        name: part.toolName,
        args: args.success ? args.output : {},
        result: results.get(part.toolCallId) ?? null,
      });
    }
  }
  return calls;
}

/** Reconstruct non-scoring process evidence from the existing message + run
 *  ledgers. Both tables are created by `initWorkspaceSchema` on every backend,
 *  so a failed read here is a real fault and is not reported as "this turn ran
 *  no tools" — the shape a blanket catch used to give it. */
function turnProcessEvidence(sql: SqlExecutor, turnId: string | null): string | undefined {
  if (!turnId) return undefined;
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
    const parsed = v.safeParse(ChatRunStartSchema, parseJsonValue(payload));
    return parsed.success && parsed.output.userMessage === expectedUserMessage;
  })?.runId;
  if (!runId) return undefined;

  const rows = sql<{ payload: string; ts: string }>`
    SELECT payload, ts FROM run_events WHERE run_id = ${runId} ORDER BY event_index`;
  const events = rows.map((row) => ({ event: parseRunEvent(row.payload), at: Date.parse(row.ts) }))
    .filter((row): row is { event: StoredRunEvent; at: number } => row.event !== null && Number.isFinite(row.at));
  if (events.length === 0) return undefined;

  // The turn's real trajectory, from the rows written as each step finished.
  const toolCalls = toolCallsFromTranscript(new RunEventRecorder(sql).transcript(runId));
  const steps = events.filter(({ event }) => event.type === 'step_finish').length;
  const startAt = events.find(({ event }) => event.type === 'run_start')?.at ?? events[0].at;
  const endAt = [...events].reverse().find(({ event }) => event.type === 'run_end')?.at ??
    events[events.length - 1]?.at ?? startAt;
  return renderDelegationFeatures(delegationFeatures({
    toolCalls,
    steps,
    durationMs: Math.max(0, endAt - startAt),
  }));
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

/** Where a lesson came from, in the ledger's canonical order — the one list
 *  the table's CHECK constraint and its widening migration both derive from:
 *    turn_reflection     — the one-sentence reflection on a turn that went
 *                          wrong (engine.reviewTurn).
 *    session_reflection  — the window-close reflection over recent lessons.
 *    execution_recovery  — the step clock's machine observation: a failure
 *                          streak broken by a changed call that ran clean
 *                          (evolution/recovery.ts). Bound to no turn, so the
 *                          corroboration gate structurally never admits it to
 *                          MEMORY.md — it lives in the dynamic-context
 *                          injection window and nowhere wider. */
export const LESSON_SOURCES = ['turn_reflection', 'session_reflection', 'execution_recovery'] as const;
export type LessonSource = (typeof LESSON_SOURCES)[number];
export type LessonStatus = 'provisional' | 'corroborated';

/** The lessons DDL, with its CHECK derived from the source list — referenced
 *  by `initTurnOutcomeTables` (declared above; function bodies evaluate after
 *  module init, so the order is safe). */
const LESSONS_DDL = `(
    id TEXT PRIMARY KEY,
    turn_ids TEXT NOT NULL,
    text TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN (${LESSON_SOURCES.map((s) => `'${s}'`).join(',')})),
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
}): string {
  const id = `lsn-${nanoid()}`;
  const now = input.now ?? nowMs();
  void sql`INSERT INTO lessons (id, turn_ids, text, source, status, created_at, corroborated_at)
      VALUES (${id}, ${JSON.stringify(input.turnIds)}, ${input.text}, ${input.source},
              ${input.status}, ${now}, ${input.status === 'corroborated' ? now : null})`;
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

/** A real negative outcome landed on `turnId`: flip every provisional lesson
 *  tied to that turn to corroborated. Returns the newly corroborated lessons
 *  so the caller can append them to durable memory (MEMORY.md). */
export function corroborateLessonsForTurn(sql: SqlExecutor, turnId: string, now = nowMs()): LessonRow[] {
  const provisional = listLessons(sql, { status: 'provisional', limit: 200 });
  const matched = provisional.filter((l) => l.turnIds.includes(turnId));
  for (const lesson of matched) {
    void sql`UPDATE lessons SET status = 'corroborated', corroborated_at = ${now} WHERE id = ${lesson.id}`;
  }
  return matched.map((l) => ({ ...l, status: 'corroborated' as const, corroboratedAt: now }));
}
