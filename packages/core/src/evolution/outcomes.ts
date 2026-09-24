/**
 * The one pipeline that grades a completed turn from what the user did next, and
 * the durable `turn_outcomes` ledger every downstream consumer reads. No second
 * classifier exists anywhere else.
 */

import * as v from 'valibot';
import type { SqlExecutor, RawSqlExec, LLM } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import type { CompletedTurn, ToolCallRecord } from './types';
import type { EvalInstance } from './gepa/types';
import { extractJsonObject, jsonObjectOnlyInstruction } from '../prompts/structured';
import { evidenceWindow } from '../prompts/evidence-window';
import { EVIDENCE_BUDGETS } from '../types/evidence';
import { sqlCheckList } from '../identity/schema';
import type { ScaffoldArchiveEntry } from '../scaffold/archive';
import { nanoid } from '../utils/nanoid';
import {
  NEGATIVE_TURN_OUTCOMES, OUTCOME_LABELS, TURN_OUTCOMES,
  TURN_OUTCOME_SOURCES, TURN_OUTCOME_SOURCE_PRECEDENCE,
  type OutcomeLabel, type TurnOutcome, type TurnOutcomeRow, type TurnOutcomeSource,
} from '../types/evolution';

import { nowMs } from '../utils/date';
import { parseJsonValue } from '../utils/json';
import { tolerate } from '../obs/index';

export {
  NEGATIVE_TURN_OUTCOMES, OUTCOME_LABELS, TURN_OUTCOMES,
  TURN_OUTCOME_SOURCES, TURN_OUTCOME_SOURCE_PRECEDENCE,
  type OutcomeLabel, type TurnOutcome, type TurnOutcomeRow, type TurnOutcomeSource,
} from '../types/evolution';

const NEGATIVE_TURN_OUTCOME_SET: ReadonlySet<TurnOutcome> = new Set(NEGATIVE_TURN_OUTCOMES);

/** The event every downstream rate is about: K_align's numerator, craft retirement,
 *  and the GEPA split's target. */
export function isNegativeOutcome(outcome: TurnOutcome | null): boolean {
  return outcome !== null && NEGATIVE_TURN_OUTCOME_SET.has(outcome);
}

/** Sources carrying a human's opinion. `execution` is evidence of what ran, silent
 *  about whether the user wanted it. */
export function isUserVerdictSource(source: TurnOutcomeSource): boolean {
  return source !== 'execution';
}

/** Shared with the async setTurnFeedback re-scoring path (cf-backend) so the
 *  constants cannot drift. */
export function feedbackToQuality(feedback: 'positive' | 'negative'): number {
  return feedback === 'positive' ? 0.9 : 0.2;
}

/** Abandoned turns carry no user signal, so feedback stays null. */
export function outcomeToFeedback(outcome: TurnOutcome): 'positive' | 'negative' | null {
  if (outcome === 'accepted') return 'positive';

  if (outcome === 'abandoned') return null;

  return 'negative';
}

/** Strictly inside the user-verdict poles (0.9 / 0.2): tool runs are evidence, not
 *  approval, so they never move a score as far as one person's verdict. */
const EXECUTION_QUALITY = { accepted: 0.7, negative: 0.3 } as const;

/** Abandonment is neutral; execution-sourced rows use their own narrower band. */
export function outcomeQuality(outcome: TurnOutcome, source: TurnOutcomeSource = 'classifier'): number {
  if (outcome === 'abandoned') return 0.5;

  if (source === 'execution') {
    return outcome === 'accepted' ? EXECUTION_QUALITY.accepted : EXECUTION_QUALITY.negative;
  }

  if (outcome === 'frustrated') return 0.1;

  return feedbackToQuality(outcome === 'accepted' ? 'positive' : 'negative');
}

const TRIVIAL_MESSAGE = new RegExp(
  '^\\s*(hi|hiya|hey|hello|yo|sup|thanks?|thank you|thx|ty|ok(ay)?|k|kk|cool|nice|great|awesome|perfect|' +
  'good (morning|afternoon|evening|night)|gm|gn|bye|goodbye|see ya|cya|lol|haha)[\\s!.…]*$',
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

export type ExecutionVerdict = 'succeeded' | 'failed';

/**
 * The environment's verdict on a turn, for turns no user will grade (`kinu exec`,
 * reactor or job wakes). Deterministic; nothing the model wrote is read. A turn with
 * no acting call is ungraded, not a success; `hadError` fails it; otherwise its last
 * acting call decides, so a failure the turn went on to fix is not punished.
 * Neither stdout nor returned JSON counts as evidence. It remains a proxy, priced
 * by EXECUTION_QUALITY and sourced as `execution`.
 */
export function executionVerdict(
  turn: Pick<CompletedTurn, 'hadError' | 'toolCalls'>,
): ExecutionVerdict | null {
  const acting = turn.toolCalls.filter((call) => !isPureLookupCall(call));
  const last = acting[acting.length - 1];

  if (last === undefined) return null;

  if (turn.hadError) return 'failed';

  if (last.outcome === undefined) return null;

  return last.outcome.success ? 'succeeded' : 'failed';
}

export function executionVerdictOutcome(verdict: ExecutionVerdict): TurnOutcome {
  return verdict === 'succeeded' ? 'accepted' : 'corrected';
}

/**
 * Whether this graded turn may mint a reusable procedure. Only a user-verdict source
 * qualifies: "it ran" does not grade the work, so headless turns never mint one.
 * Execution verdicts still feed the ledger, quality band and negative reflection.
 */
export function promotesProcedure(graded: {
  readonly outcome: TurnOutcome | null;
  readonly source: TurnOutcomeSource;
  readonly toolCalls: number;
}): boolean {
  return graded.outcome === 'accepted' && isUserVerdictSource(graded.source) && graded.toolCalls > 0;
}

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
 * The classifier's prompt. Worked examples and the terse-reply block teach the
 * boundary this verdict is wrong on. `confidence` is the home for a follow-up that
 * settles nothing; a rater that never admits doubt is uncorrectable by calibration.ts.
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

/** Returns null only for model output with no usable JSON verdict, which the
 *  caller records as ungraded. Transport failures propagate. */
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

const TURN_OUTCOMES_DDL = `(
    actor_id TEXT NOT NULL,
    id TEXT NOT NULL,
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
    evidence TEXT,
    PRIMARY KEY (actor_id, id)
  )`;

export function initTurnOutcomeTables(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS turn_outcomes ${TURN_OUTCOMES_DDL}`);
  // Self-scored lessons stay 'provisional' and out of the derived view until a real
  // negative outcome on one of their turns corroborates them.
  // The generated pattern, held so a replay applies what was decided rather than
  // re-asking a model. Retired once its tombstone lands.
  execRaw(`CREATE TABLE IF NOT EXISTS pattern_extractions (
    actor_id   TEXT NOT NULL,
    effect_key TEXT NOT NULL,
    answer     TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (actor_id, effect_key)
  )`);
  execRaw(`CREATE TABLE IF NOT EXISTS lessons ${LESSONS_DDL}`);
  // Gold labels from a human (calibration.ts). Append-only; the newest label wins.
  execRaw(`CREATE TABLE IF NOT EXISTS outcome_labels (
    actor_id TEXT NOT NULL,
    id TEXT NOT NULL,
    outcome_id TEXT NOT NULL,
    label TEXT NOT NULL CHECK (label IN (${sqlCheckList(OUTCOME_LABELS)})),
    labeler TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (actor_id, id)
  )`);
  // LLM judge verdicts (ensemble.ts), kept apart from gold labels so a model's
  // opinion can never be counted as ground truth.
  execRaw(`CREATE TABLE IF NOT EXISTS outcome_ensemble_labels (
    actor_id TEXT NOT NULL,
    id TEXT NOT NULL,
    outcome_id TEXT NOT NULL,
    model TEXT NOT NULL,
    label TEXT NOT NULL CHECK (label IN (${sqlCheckList(OUTCOME_LABELS)})),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (actor_id, id)
  )`);
  // The effective-verdict window partitions by turn per actor, so the owner leads each index.
  execRaw(`CREATE INDEX IF NOT EXISTS idx_turn_outcomes_actor
             ON turn_outcomes(actor_id, created_at DESC, id DESC)`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_turn_outcomes_actor_turn
             ON turn_outcomes(actor_id, turn_id)`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_outcome_labels_actor
             ON outcome_labels(actor_id, created_at DESC, id DESC)`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_outcome_ensemble_labels_actor
             ON outcome_ensemble_labels(actor_id, created_at DESC, id DESC)`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_lessons_actor
             ON lessons(actor_id, created_at DESC)`);
}

export interface OutcomeLabelRow {
  id: string;
  outcomeId: string;
  label: OutcomeLabel;
  labeler: string;
  createdAt: number;
}

export function recordOutcomeLabels(sql: SqlExecutor, actor: ActorHandle, input: {
  labeler: string;
  labels: ReadonlyArray<{ outcomeId: string; label: OutcomeLabel }>;
  now?: number;
}): number {
  actor.assertCurrent();
  const now = input.now ?? nowMs();

  for (const entry of input.labels) {
    void sql`INSERT INTO outcome_labels (actor_id, id, outcome_id, label, labeler, created_at)
        VALUES (${actor.actorId}, ${`lbl-${nanoid()}`}, ${entry.outcomeId}, ${entry.label}, ${input.labeler}, ${now})`;
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

/** Unbounded when `limit` is omitted: the gold set is the basis of every
 *  corrected number. */
export function listOutcomeLabels(sql: SqlExecutor, actor: ActorHandle, limit?: number): OutcomeLabelRow[] {
  actor.assertCurrent();

  const rows = limit === undefined
    ? sql<RawOutcomeLabelRow>`SELECT * FROM outcome_labels WHERE actor_id = ${actor.actorId}
        ORDER BY created_at DESC, id DESC`
    : sql<RawOutcomeLabelRow>`
        SELECT * FROM outcome_labels WHERE actor_id = ${actor.actorId}
        ORDER BY created_at DESC, id DESC LIMIT ${limit}`;

  return rows.map(toOutcomeLabelRow);
}

/** The label that counts for each turn: the most recent one. */
export function goldLabels(sql: SqlExecutor, actor: ActorHandle): Map<string, OutcomeLabelRow> {
  const latest = new Map<string, OutcomeLabelRow>();

  for (const row of listOutcomeLabels(sql, actor)) {
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

export function recordEnsembleLabels(sql: SqlExecutor, actor: ActorHandle, input: {
  model: string;
  labels: ReadonlyArray<{ outcomeId: string; label: OutcomeLabel }>;
  now?: number;
}): number {
  actor.assertCurrent();
  const now = input.now ?? nowMs();

  for (const entry of input.labels) {
    void sql`INSERT INTO outcome_ensemble_labels (actor_id, id, outcome_id, model, label, created_at)
        VALUES (${actor.actorId}, ${`ens-${nanoid()}`}, ${entry.outcomeId}, ${input.model}, ${entry.label}, ${now})`;
  }

  return input.labels.length;
}

/** The verdict that counts for each (turn, model): the most recent one. */
export function ensembleLabels(sql: SqlExecutor, actor: ActorHandle): EnsembleLabelRow[] {
  actor.assertCurrent();

  const rows = sql<{
    id: string; outcome_id: string; model: string; label: OutcomeLabel; created_at: number;
  }>`SELECT * FROM outcome_ensemble_labels WHERE actor_id = ${actor.actorId}
      ORDER BY created_at DESC, id DESC`;

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

/** Append-only: calibration labels address observations by id, so rows are never
 *  rewritten. Readers resolve one effective outcome per turn by source precedence.
 *  Texts are windowed; downstream GEPA and replay can never see more than stored. */
export function recordTurnOutcome(
  sql: SqlExecutor, actor: ActorHandle, input: RecordTurnOutcomeInput,
): string {
  actor.assertCurrent();
  const id = `outc-${nanoid()}`;
  void sql`INSERT INTO turn_outcomes
        (actor_id, id, turn_id, session_id, outcome, confidence, source,
         user_message, assistant_response, followup, scaffold_version, created_at, evidence)
      VALUES
        (${actor.actorId}, ${id}, ${input.turnId ?? null}, ${input.sessionId ?? 'default'}, ${input.outcome},
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

/** One effective verdict per turn, newest first, by
 *  {@link TURN_OUTCOME_SOURCE_PRECEDENCE} with recency, then insertion order, breaking ties. Turns without
 *  `turn_id` each stand alone. The filter applies to effective verdicts before
 *  `limit`; a negative `limit` is unbounded. `turnIds` narrows to a named trajectory. */
export function listTurnOutcomes(
  sql: SqlExecutor,
  actor: ActorHandle,
  opts: {
    limit?: number;
    outcomes?: ReadonlyArray<TurnOutcome>;
    turnIds?: ReadonlyArray<string>;
  } = {},
): TurnOutcomeRow[] {
  if (opts.turnIds === undefined) {
    return selectEffectiveTurnOutcomes(sql, actor, opts.limit ?? 50, opts.outcomes);
  }

  if (opts.turnIds.length === 0) return [];
  const wanted = new Set(opts.turnIds);

  return selectEffectiveTurnOutcomes(sql, actor, undefined, opts.outcomes)
    .filter((row) => row.turnId !== null && wanted.has(row.turnId))
    .slice(0, opts.limit ?? wanted.size);
}

/** Sources are bound member by member because the tagged-template executor binds
 *  values, never SQL text. Unused IN slots bind '', which the CHECK constraint
 *  forbids, so they match nothing. */
function selectEffectiveTurnOutcomes(
  sql: SqlExecutor,
  actor: ActorHandle,
  limit: number | undefined,
  outcomes?: ReadonlyArray<TurnOutcome>,
): TurnOutcomeRow[] {
  actor.assertCurrent();
  const actorId = actor.actorId;
  const wanted = TURN_OUTCOMES.filter((o) => !outcomes || outcomes.includes(o));
  const [w0, w1, w2, w3] = [wanted[0] ?? '', wanted[1] ?? '', wanted[2] ?? '', wanted[3] ?? ''];
  const [p0, p1, p2, p3] = TURN_OUTCOME_SOURCE_PRECEDENCE;

  const ranked = sql<RawOutcomeRow & { eff_rn: number }>`
    SELECT * FROM (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY turn_id
        ORDER BY CASE source WHEN ${p0} THEN 0 WHEN ${p1} THEN 1
                 WHEN ${p2} THEN 2 WHEN ${p3} THEN 3 ELSE 4 END ASC,
                 created_at DESC, rowid DESC
      ) AS eff_rn
      FROM turn_outcomes
      WHERE actor_id = ${actorId} AND turn_id IS NOT NULL
    )
    WHERE eff_rn = 1 AND outcome IN (${w0}, ${w1}, ${w2}, ${w3})
    UNION ALL
    SELECT *, 1 AS eff_rn FROM turn_outcomes
      WHERE actor_id = ${actorId} AND turn_id IS NULL
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit ?? -1}`;

  return ranked.map(toOutcomeRow);
}

/** The follow-up classifier must not overwrite an Alternate Takes pick. */
export function takePickOutcome(
  sql: SqlExecutor, actor: ActorHandle, turnId: string | null | undefined,
): TurnOutcome | null {
  if (!turnId) return null;
  actor.assertCurrent();

  const rows = sql<{ outcome: TurnOutcome }>`
    SELECT outcome FROM turn_outcomes
    WHERE actor_id = ${actor.actorId} AND turn_id = ${turnId} AND source = 'take_pick' LIMIT 1`;

  return rows[0]?.outcome ?? null;
}

/**
 * The verdict a turn's review already recorded, so a retry does not re-classify
 * and act on a verdict the ledger does not hold. Same precedence as
 * `selectEffectiveTurnOutcomes`.
 */
export function recordedTurnVerdict(
  sql: SqlExecutor, actor: ActorHandle, turnId: string | null | undefined,
): { outcome: TurnOutcome; source: TurnOutcomeSource; confidence: number } | null {
  if (!turnId) return null;
  actor.assertCurrent();
  const [p0, p1, p2, p3] = TURN_OUTCOME_SOURCE_PRECEDENCE;

  const rows = sql<{ outcome: TurnOutcome; source: TurnOutcomeSource; confidence: number }>`
    SELECT outcome, source, confidence FROM turn_outcomes
    WHERE actor_id = ${actor.actorId} AND turn_id = ${turnId}
    ORDER BY CASE source WHEN ${p0} THEN 0 WHEN ${p1} THEN 1
             WHEN ${p2} THEN 2 WHEN ${p3} THEN 3 ELSE 4 END ASC,
             created_at DESC, rowid DESC
    LIMIT 1`;

  return rows[0] ?? null;
}

/** Effective, not raw: a classifier `corrected` overruled by an explicit thumb
 *  must not keep a turn flagged negative. */
export function hasNegativeOutcome(
  sql: SqlExecutor, actor: ActorHandle, turnIds: ReadonlyArray<string>,
): boolean {
  if (turnIds.length === 0) return false;
  const wanted = new Set(turnIds);

  return selectEffectiveTurnOutcomes(sql, actor, undefined, NEGATIVE_TURN_OUTCOMES)
    .some((r) => r.turnId !== null && wanted.has(r.turnId));
}

export interface RealOutcomeRate {
  accepted: number;
  negative: number;
}

/** How turns served by each scaffold version landed with the user, counting
 *  effective verdicts only. */
export function realOutcomeScaffoldRates(
  sql: SqlExecutor, actor: ActorHandle,
): Map<number, RealOutcomeRate> {
  const rates = new Map<number, RealOutcomeRate>();

  for (const row of selectEffectiveTurnOutcomes(sql, actor, undefined)) {
    if (row.scaffoldVersion === null) continue;
    const rate = rates.get(row.scaffoldVersion) ?? { accepted: 0, negative: 0 };

    if (row.outcome === 'accepted') rate.accepted++;
    else if (isNegativeOutcome(row.outcome)) rate.negative++;
    rates.set(row.scaffoldVersion, rate);
  }

  return rates;
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

export interface OutcomeEvalExpectation {
  outcome: TurnOutcome;
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

  return `The agent's response below FAILED — ${critic.verdict}. ${rule.failed}\n\n`
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
      return 'no outcome-labeled turns yet — chat with the agent first';
    case 'no_negatives':
      return 'no corrected/frustrated turns yet — there is no failure to optimize toward';
    case 'no_held_out_negatives':
      return 'only one labeled failure exists, and the optimizer must train on it — ' +
        'the winner is selected without any unseen failure, so an improvement here is not evidence of one';
  }
}

export interface OutcomeEvalSplit {
  /** Corrected/frustrated turns the optimizer must fix. Shares no instance with `val`. */
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
export const LESSON_SOURCES = [
  'turn_reflection', 'session_reflection', 'execution_recovery', 'import',
] as const;

export type LessonSource = (typeof LESSON_SOURCES)[number];

export type LessonStatus = 'provisional' | 'corroborated';

/** Referenced by `initTurnOutcomeTables` above; function bodies evaluate after
 *  module init. */
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
