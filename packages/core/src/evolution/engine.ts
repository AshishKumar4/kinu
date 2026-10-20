/**
 * EvolutionEngine: self-evolution at four timescales (docs/EVOLUTION.md).
 *
 * 0 In-episode: craft ledger and execution-recovery findings, no model call.
 * 1 Turn: turn N is rated from user message N+1 in the same conversation (evolution/ratings.ts). A turn no
 *   follow-up answers stays unrated.
 * 2 Session: reflect when a closed window carries negative signal. The every-N-turns
 *   cadence lives only in AgentOrchestrator over the durable window (session-window.ts).
 * 3 Lifetime: craft consolidation.
 */

import * as v from 'valibot';
import { AsyncLocalStorage } from 'node:async_hooks';
import { parseJsonValue } from '../utils/json';

import type { AgentRuntime } from '../types/agent-runtime';
import type { LLM } from '../types/primitives';
import type {
  CompletedTurn,
  CompletedSession,
  ToolCallRecord,
  EvolutionEvent,
  EvolutionListener,
  EvolutionConfig,
} from './types';
import { DEFAULT_EVOLUTION_CONFIG } from './types';
import { extractJsonObject, jsonObjectOnlyInstruction } from '../providers/structured';
import { tolerate } from '../obs/index';
import { EVIDENCE_BUDGETS, evidenceWindow } from '../utils/evidence-window';
import { upsertCraftedTool } from '../craft/conflict';
import { periodicCraftConsolidation } from '../craft/consolidation';
import { countCraftOffers, rateCraftedTools } from '../craft/preference';
import { recordRecoveryFinding, recoveryFindingText, type RecoveryFinding } from './recovery';
import { effectAlreadyDone, recordEffectDone } from '../identity/effect-tombstones';
import type { TurnPairReader } from '../identity/conversation-store';
import {
  ADVISOR_DEDUPE_WINDOW, ADVISOR_EVENT_TYPE, AdvisorRowDataSchema, normalizeNote,
  type AdvisorNote, type AdvisorRowData,
} from '../advisor/review';
import { initLessonTables } from './lessons';
import { dreamChangesFor } from './watch';
import {
  applyStruggleLesson, initStruggleTables, listToolLessons, MAX_TOOL_LESSONS, owesTurnLessons, recordTurnStruggles,
  scoreToolLessons, StruggleLessonSchema, struggleLessonPrompt, teachingStruggle,
} from './struggles';
import {
  initTurnRatingTables, rateTurn, renderActions, recordTurnRating, ratingOf,
  isHighRating, feedbackOf, ratingQuality, thumbsRating, retractThumbs,
  isTrivialTurn,
  type TurnRating,
} from './ratings';
import type { DecisionPort } from '../providers/decision-model';
import {
  bindPendingImports, settleImportsForTurn, type ImportedExperienceRow,
} from '../experience/imports';
import {
  initCompletedTurnTable, completedTurnRanWith, createCompletedTurnStore, type CompletedTurnStore,
  MAX_TURN_REVIEWS_PER_OPEN,
  type DeferredReviewDrain, type RefusedTurnReview, type EnqueueOutcome,
} from './session-window';
import { turnPicks } from './picks';
import { initRefinementTables } from './refinement';
import { MissionBudgetExhausted } from '../mission-budget';
import { buildChangelog } from './changelog';

const GeneralizedToolSchema = v.object({
  name: v.optional(v.string()),
  description: v.optional(v.string()),
  code: v.optional(v.string()),
});

import type { AgentConfigStore } from '../config/store';
import { diagnostics, toKinuError, KinuError } from '../obs/index';
import { nowMs } from '../utils/date';


/** Tombstone scope for one turn's two durable rating writes (`turn_ratings` row
 *  and craft EMA). Distinct from `turn_review`: a refusal after these writes retries
 *  the rest, not the writes. */
const TURN_GRADED_SCOPE = 'turn_graded';

/** Tombstone scope for the review's later writes (an extracted pattern, a turn's
 * struggle lessons), so a refusal between them resumes rather than repeats. */
const TURN_REVIEW_STEP_SCOPE = 'turn_review_step';

/** The rating the review decides by: the ledger's effective row, or an unkeyed turn's own reading. */
type EffectiveRating = Pick<TurnRating, 'score' | 'corrected' | 'wrong' | 'source'>;

/** Read-only calls prove nothing about whether the turn's work landed, so the pattern extractor skips them. */
function isPureLookupCall(call: Pick<ToolCallRecord, 'name' | 'op'>): boolean {
  return call.name === 'memory' && v.is(v.picklist(['recall', 'search', 'searchConversations', 'readConversation', 'listConversations']), call.op);
}

/** Chosen means offered and called: a tool the turn made and then called was not offered to it. */
function chosenCraftedTools(turn: CompletedTurn): string[] {
  const offered = turn.craftedOffered ?? [];

  return (turn.craftedToolsUsed ?? []).filter((name) => offered.includes(name));
}

export class EvolutionEngine {
  private readonly rt: AgentRuntime;
  private readonly turnPair: TurnPairReader;
  private readonly config: EvolutionConfig;
  private readonly listeners: EvolutionListener[] = [];
  /** Also holds the durable closed-window count the lifetime timescale paces by. */
  private readonly agentConfig: AgentConfigStore;
  /** Every completed turn still owed evolution work, one row per turn.
     *  AgentOrchestrator owns the cadence; the engine owns the ledger. */
  readonly sessionWindow: CompletedTurnStore;
  /** A head or node the workspace does not evolve records nothing, whatever the setting. */
  readonly evolves: boolean;
  private recoveryPending = true;
  private readonly learningScope = new AsyncLocalStorage<boolean>();

  constructor(
    rt: AgentRuntime, turnPair: TurnPairReader, config: Partial<EvolutionConfig> = {},
  ) {
    this.rt = rt;
    this.turnPair = turnPair;
    this.config = { ...DEFAULT_EVOLUTION_CONFIG, ...config };
    rt.actor.assertCurrent();

    const actor = rt.storage.sql<{ origin: string }>`
      SELECT origin FROM workspace_actors WHERE actor_id = ${rt.actor.actorId}`[0];

    if (actor === undefined) throw new KinuError('missing', 'the evolution actor has no membership record');
    // Only the workspace agent evolves (`MAIN_PROFILE`).
    this.evolves = actor.origin === 'system';
    // Created here so every backend gets the engine's ledgers without schema wiring.
    initLessonTables(rt.storage.execRaw);
    initTurnRatingTables(rt.storage.execRaw);
    initStruggleTables(rt.storage.execRaw);
    this.agentConfig = rt.actor.config;
    initCompletedTurnTable(rt.storage.execRaw);
    this.sessionWindow = createCompletedTurnStore(rt.storage.sql, rt.actor);
    initRefinementTables(rt.storage.execRaw);
  }

  recoverInterruptedWork(): void {
    if (!this.recoveryPending) return;
    this.sessionWindow.resetStaleClaims();
    this.recoveryPending = false;
  }

  /**
     * The fast tier for mechanical calls, else the chat model. The scaffold proposal
     * deliberately stays on the chat model.
     */
  private get fastLlm(): LLM {
    return this.rt.fastLlm ?? this.rt.llm;
  }

  /**
     * The fast tier governed by the turn's own mission labels, never the governor's
     * active scope: a deferred review runs elsewhere, and debiting the wrong mission
     * is worse than none. An unlabelled turn gets the bare model.
     */
  private reviewLlm(turn: CompletedTurn): LLM {
    const labels = turn.missionLabels ?? [];

    return labels.length === 0
      ? this.fastLlm
      : this.config.governor?.govern(this.fastLlm, labels) ?? this.fastLlm;
  }

  /** The decision model under the turn's mission, as `reviewLlm` is. */
  private reviewDecide(turn: CompletedTurn): DecisionPort | undefined {
    const labels = turn.missionLabels ?? [];
    const decide = this.rt.decide;

    return decide === undefined || labels.length === 0
      ? decide
      : this.config.governor?.governDecision(decide, labels) ?? decide;
  }

  /** Inline where the backend supplies no transaction seam (a synchronous run is
     *  already atomic inside a Durable Object). */
  private commit(body: () => void): void {
    (this.config.transaction ?? ((run: () => void) => { run(); }))(body);
  }

  /** A turn and the async work it starts keep one gate; independent work reads the live setting. */
  withTurnLearning<Result>(body: () => Result): Result {
    return this.learningScope.run(this.config.enabled && this.agentConfig.getLearning(), body);
  }

  get enabled(): boolean {
    return this.config.enabled && (this.learningScope.getStore() ?? this.agentConfig.getLearning());
  }

  get recordsTurns(): boolean {
    return this.evolves && this.enabled;
  }

  onEvent(listener: EvolutionListener): void {
    this.listeners.push(listener);
  }

  private emit(event: EvolutionEvent): void {
    // evolution_events exists on every backend, so a failed INSERT is a real fault.
    void this.rt.storage.sql`INSERT INTO evolution_events (actor_id, type, message, data, created_at)
      VALUES (${this.rt.actor.actorId}, ${event.type}, ${event.message},
              ${event.data ? JSON.stringify(event.data) : null}, ${Date.now()})`;

    for (const listener of this.listeners) {
      listener(event);
    }
  }

  /**
     * Records an execution recovery the step clock observed (evolution/recovery.ts).
     * One lessons row, no model call. Bound to no turn, so it stays provisional forever.
     */
  recordRecovery(finding: RecoveryFinding): void {
    if (!this.enabled) return;

    if (!recordRecoveryFinding(this.rt.storage.sql, this.rt.actor, finding)) return;
    this.emit({
      type: 'reflection',
      message: `[execution recovery] ${recoveryFindingText(finding)}`,
    });
  }

  /**
     * The advisor's row on the audit stream, here because `emit` is the one
     * `evolution_events` writer that also reaches the engine's listeners.
     * `advisorNegatives` resolves the graded turn through the transcript, so neither
     * message nor response is copied here.
     */
  recordAdvisorNote(note: AdvisorNote, turnId?: string, spoken = false): void {
    const data: AdvisorRowData = {
      severity: note.severity, class: note.class, turnId: turnId ?? null, spoken,
    };

    this.emit({ type: ADVISOR_EVENT_TYPE, message: note.note, data });
  }

  /** Normalised text of the last `limit` advisor notes, newest first. */
  recentAdvisorNotes(limit = ADVISOR_DEDUPE_WINDOW): readonly string[] {
    const rows = this.rt.storage.sql<{ message: string }>`
      SELECT message FROM evolution_events
      WHERE actor_id = ${this.rt.actor.actorId} AND type = ${ADVISOR_EVENT_TYPE}
      ORDER BY created_at DESC LIMIT ${limit}`;

    return rows.map((row) => normalizeNote(row.message));
  }

  /**
     * Idempotency guard for a replayed `advisor_review` effect: the note row is the only
     * durable evidence that the review completed.
     */
  /** The note recorded for `turnId`, and whether it is to be said to the actor; null before its review is judged. */
  advisorNoteForTurn(turnId: string): { readonly note: AdvisorNote; readonly spoken: boolean } | null {
    const [row] = this.rt.storage.sql<{ message: string; data: string }>`
      SELECT message, data FROM evolution_events
      WHERE actor_id = ${this.rt.actor.actorId} AND type = ${ADVISOR_EVENT_TYPE}
        AND json_extract(data, '$.turnId') = ${turnId}
      ORDER BY created_at LIMIT 1`;

    if (row === undefined) return null;
    const data = v.parse(AdvisorRowDataSchema, parseJsonValue(row.data));

    return { note: { note: row.message, severity: data.severity, class: data.class }, spoken: data.spoken === true };
  }

  hasAdvisorNoteForTurn(turnId: string): boolean {
    const rows = this.rt.storage.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM evolution_events
      WHERE actor_id = ${this.rt.actor.actorId} AND type = ${ADVISOR_EVENT_TYPE}
        AND json_extract(data, '$.turnId') = ${turnId}`;

    return (rows[0]?.n ?? 0) > 0;
  }

  private announceReview(turn: CompletedTurn, rating: EffectiveRating | null): void {
    this.emit({
      type: 'turn_complete',
      message: `Turn ${rating === null ? 'unrated' : `rated ${rating.score.toFixed(1)}/5 by ${rating.source}`}` +
        ` | ${turn.toolCalls.length} tool calls | ${turn.steps} steps | ${turn.hadError ? 'had errors' : 'clean'}`,
      data: {
        rated: rating !== null,
        score: rating?.score ?? null,
        corrected: rating?.corrected ?? null,
        wrong: rating?.wrong ?? null,
        source: rating?.source ?? null,
        quality: rating === null ? null : ratingQuality(rating.score),
        toolCount: turn.toolCalls.length, steps: turn.steps, durationMs: turn.durationMs,
      },
    });
  }

  /**
     * Rate turn N from the user's follow-up and run turn-level evolution. `followup` null means no
     * conversational follow-up exists (programmatic wakes, `kinu exec`), so only a thumb or pick can rate the
     * turn. Either wins over the decision model's reading; trivial turns are not reviewed.
     */
  async reviewTurn(turn: CompletedTurn, followup: string | null): Promise<void> {
    if (!this.enabled || isTrivialTurn(turn)) return;

    // Keyed on the turn so a retry after eviction or a later refusal does not repeat the rating writes.
    const gradedKey = turn.turnId === undefined || turn.turnId === '' ? null : turn.turnId;

    // Checked before the model so a resumed review spends no call. The tombstone, not the row, is the signal:
    // an unrated turn writes no row.
    const graded = gradedKey !== null
      && effectAlreadyDone(this.rt.storage.sql, this.rt.actor, TURN_GRADED_SCOPE, gradedKey);

    const decide = this.reviewDecide(turn);

    // An answered turn's reading is recorded even under a thumb: the ledger's precedence decides which rating
    // counts, so a thumb cleared later falls back to it.
    const reading = graded || followup === null || decide === undefined ? null : await rateTurn(decide, {
      request: turn.userMessage, actions: renderActions(turn.toolCalls), answer: turn.assistantResponse, followup,
      changes: dreamChangesFor(this.rt.storage.sql, this.rt.actor, turn.artifacts ?? null),
    }, turn.toolCalls.length);

    const effective = (): EffectiveRating | null => {
      if (gradedKey !== null) return ratingOf(this.rt.storage.sql, this.rt.actor, gradedKey);

      return reading === null ? null : { ...reading, source: 'model' };
    };

    // One commit for the rating row, craft scores, tombstone and announcement: a synchronous run is atomic
    // inside a Durable Object but not against a CLI kill. Announced last, so a death cannot replay the writes.
    this.commit(() => {
      if (graded) return;

      if (reading !== null && gradedKey !== null) {
        recordTurnRating(this.rt.storage.sql, this.rt.actor, {
          ...reading,
          turnId: gradedKey,
          source: 'model',
          request: turn.userMessage,
          actions: renderActions(turn.toolCalls),
          answer: turn.assistantResponse,
          followup,
          scaffoldVersion: turn.scaffold?.version ?? null,
          artifacts: turn.artifacts ?? null,
          picks: turnPicks(turn),
        });
      }

      const rated = effective();

      // Under the graded tombstone, so a resumed review rates nothing twice.
      if (rated !== null) rateCraftedTools(this.rt.storage.sql, chosenCraftedTools(turn), rated.score);

      if (gradedKey !== null) {
        recordEffectDone(this.rt.storage.sql, this.rt.actor, { scope: TURN_GRADED_SCOPE, key: gradedKey });
      }

      this.announceReview(turn, rated);
    });

    const rating = effective();

    if (rating === null) return;

    if (!graded) turn.feedback = feedbackOf(rating.score);

    await this.settleImports(turn.turnId, rating.score);

    if (isHighRating(rating.score) && turn.toolCalls.length > 0 && this.agentConfig.getCrafting()) {
      // The key travels into the body so the marker lands beside the writes.
      const patternKey = gradedKey === null ? null : `${gradedKey}:pattern`;

      if (patternKey === null
        || !effectAlreadyDone(this.rt.storage.sql, this.rt.actor, TURN_REVIEW_STEP_SCOPE, patternKey)) {
        await this.extractPattern(turn, patternKey);
      }
    }
  }

  /**
   * The `turn_lessons` terminal effect's body, apart from the turn's rating, which may wait on a reply that never
   * comes: records its struggles and scores the lessons it was shown, then has the fast tier write one lesson about
   * the tool it struggled with most. Each part has its tombstone, so a retry neither rescores nor asks again; a
   * refusal throws, for the ledger to retry or park. A turn with no id has none to key them by.
   */
  async learnFromTurn(completed: CompletedTurn): Promise<void> {
    if (!this.enabled || completed.turnId === undefined || completed.turnId === '' || !owesTurnLessons(completed)) return;
    const turn = { ...completed, turnId: completed.turnId };
    const { sql } = this.rt.storage;
    const { actor } = this.rt;
    const recordKey = `${turn.turnId}:struggles`;

    if (!effectAlreadyDone(sql, actor, TURN_REVIEW_STEP_SCOPE, recordKey)) {
      this.commit(() => {
        recordTurnStruggles(sql, actor, turn);
        scoreToolLessons(sql, actor, turn);
        recordEffectDone(sql, actor, { scope: TURN_REVIEW_STEP_SCOPE, key: recordKey });
      });
    }

    const struggle = teachingStruggle(turn.struggles ?? []);
    const lessonKey = `${turn.turnId}:struggle-lesson`;

    if (struggle === null || effectAlreadyDone(sql, actor, TURN_REVIEW_STEP_SCOPE, lessonKey)) return;
    const prompt = struggleLessonPrompt(turn, struggle, listToolLessons(sql, actor, [struggle.tool], MAX_TOOL_LESSONS));
    const said = await this.reviewLlm(turn).complete(prompt);
    const answer = v.safeParse(StruggleLessonSchema, tolerate(() => extractJsonObject(said), 'malformed-input'));

    // Unusable output is not asked for again.
    this.commit(() => {
      if (answer.success) applyStruggleLesson(sql, actor, { turnId: turn.turnId, tool: struggle.tool, answer: answer.output });
      recordEffectDone(sql, actor, { scope: TURN_REVIEW_STEP_SCOPE, key: lessonKey });
    });

    if (answer.success) this.emit({ type: 'reflection', message: `Lesson for \`${struggle.tool}\`: ${answer.output.text}` });
  }

  /**
     * Durably queue this turn's review with its snapshotted inputs, for the one-shot
     * exit path. With `storedRowId`, the already-claimed `completed_turns` row becomes
     * the owed review. Returns the queue's answer so a refusal can be stated.
     */
  deferTurnReview(
    turn: CompletedTurn,
    followup: string | null,
    opts?: { storedRowId?: string },
  ): EnqueueOutcome {
    if (!this.enabled) return 'queued';
    const outcome = this.sessionWindow.enqueueReview(turn, followup, opts);

    if (outcome !== 'queued') {
      diagnostics.failure(
        'evolution.turn_review_not_deferred',
        toKinuError({
          doing: 'defer a turn review for the next host',
          cause: new Error(outcome === 'queue_full'
            ? `the review queue is full (${this.sessionWindow.countQueuedReviews()} owed): nothing has drained it`
            : 'the turn does not serialize'),
          otherwise: outcome === 'queue_full' ? 'unavailable' : 'bad_input',
        }),
      );
    }

    return outcome;
  }

  /**
     * Run one claimed turn's review inline and settle the row only once it ran. A
     * throw leaves the row `claimed` for activation recovery.
     */
  async runStoredTurnReview(rowId: string, turn: CompletedTurn, followup: string | null): Promise<void> {
    await this.reviewTurn(turn, followup);
    this.sessionWindow.settleReview(rowId);
  }

  /**
     * Drain deferred reviews through `reviewTurn`, at most
     * {@link MAX_TURN_REVIEWS_PER_OPEN} per call so a backlog does not delay the
     * turn being opened. A row is retired only once its review ran. Undecodable rows
     * and missions over cap come back in `refused` with their disposition.
     */
  async runDeferredTurnReviews(): Promise<DeferredReviewDrain> {
    if (!this.enabled) return { reviewed: 0, refused: [] };
    this.recoverInterruptedWork();
    const taken = this.sessionWindow.takeQueuedReviews(MAX_TURN_REVIEWS_PER_OPEN);
    const refused: RefusedTurnReview[] = [...taken.refused];
    let reviewed = 0;

    for (const row of taken.reviews) {
      try {
        await this.reviewTurn(row.turn, row.followup);
      } catch (err) {
        // A governor refusal is a decision: the row goes back unchanged. Any other throw
        // also releases it untombstoned.
        if (err instanceof MissionBudgetExhausted) {
          refused.push({ id: row.id, reason: 'budget' });
        } else {
          diagnostics.failure(
            'evolution.deferred_review_failed',
            toKinuError({ doing: 'run a deferred turn review', cause: err, otherwise: 'unavailable' }),
            { reviewId: row.id },
          );
        }

        this.sessionWindow.releaseQueuedReview(row.id);
        continue;
      }

      this.sessionWindow.settleReview(row.id);
      reviewed++;
    }

    return { reviewed, refused };
  }

  /**
     * A thumb from setTurnFeedback is the user's own rating: it wins over the model's. Cleared, the turn falls back
     * to the model's rating.
     */
  async applyExplicitFeedback(messageId: string, feedback: 'positive' | 'negative' | null): Promise<void> {
    if (feedback === null) {
      retractThumbs(this.rt.storage.sql, this.rt.actor, messageId);

      return;
    }

    // A failed read is a fault: a row with blank texts would poison the bad and good turn sets.
    const pair = await this.turnPair(messageId);
    recordTurnRating(this.rt.storage.sql, this.rt.actor, {
      ...thumbsRating(feedback),
      turnId: messageId,
      source: 'thumbs',
      request: pair?.request ?? '',
      answer: pair?.response ?? '',
      ...completedTurnRanWith(this.rt.storage.sql, this.rt.actor, messageId),
    });

  }

  /**
     * The only path by which another workspace's imported experience joins this one,
     * settled by a graded turn's verdict. An ungraded turn settles nothing.
     */
  private async settleImports(turnId: string | undefined, score: number): Promise<void> {
    const feedback = feedbackOf(score);

    if (!turnId || feedback === null) return;
    const verdict = feedback === 'positive' ? 'accepted' : 'rejected';
    // Not caught: a wide catch would also absorb a failed adoption and leave the
    // import staged forever.
    bindPendingImports(this.rt.storage.sql, this.rt.actor, turnId);

    const settled = await settleImportsForTurn(this.rt, turnId, verdict);

    if (settled.corroborated.length === 0 && settled.discarded.length === 0) return;

    const describe = (rows: ImportedExperienceRow[]) =>
      rows.map((r) => `${r.payload.kind} "${r.key}" from ${r.sourceWorkspace}`).join(', ');

    this.emit({
      type: 'experience_import',
      message: settled.corroborated.length > 0
        ? `Adopted imported experience after a turn rated ${score.toFixed(1)}/5: ${describe(settled.corroborated)}`
        : `Discarded imported experience after a turn rated ${score.toFixed(1)}/5: ${describe(settled.discarded)}`,
      data: {
        score,
        corroborated: settled.corroborated.map((r) => r.libraryId),
        discarded: settled.discarded.map((r) => r.libraryId),
      },
    });
  }

  /** Called by AgentOrchestrator when a session window closes: the lifetime cadence and the changelog digest. */
  async onSessionComplete(session: CompletedSession): Promise<void> {
    if (!this.enabled) return;

    const windowsClosed = this.agentConfig.countClosedTurnWindow();

    if (windowsClosed % this.config.lifetimeEvolutionInterval === 0) {
      await this.onLifetimeEvolution();
    }

    // Session-end changelog digest over the ledgers; never blocks.
    this.emitChangelogDigest(session.startedAt);
  }

  private emitChangelogDigest(since: number): void {
    const entries = buildChangelog(this.rt.storage.sql, this.rt.actor, { since, limit: 20 });

    if (entries.length === 0) return;
    const counts = new Map<string, number>();

    for (const e of entries) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
    const parts = [...counts].map(([kind, n]) => `${n} ${kind}`).join(' · ');
    this.emit({
      type: 'changelog_digest',
      message: `Self-change digest: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} this session (${parts}): every line is revertable in the changelog`,
      data: { since, counts: Object.fromEntries(counts) },
    });
  }

  /** Lifetime cycle, automatic every N windows. */
  /** A recorded turn's offers: each crafted tool its declarations offered, and of those each it called. */
  countCraftOffers(turn: CompletedTurn): void {
    countCraftOffers(this.rt.storage.sql, { offered: turn.craftedOffered ?? [], chosen: chosenCraftedTools(turn), at: nowMs() });
  }

  async onLifetimeEvolution(): Promise<void> {
    await periodicCraftConsolidation(this.rt);
    this.emit({ type: 'consolidation', message: 'CraftStore consolidation complete' });
  }

  /** Pure-lookup calls are skipped: they encode no reusable pattern. */
  private async extractPattern(
    turn: CompletedTurn,
    /** Written next to the upsert so no await separates the tool from its record. */
    patternKey: string | null,
  ): Promise<void> {
    const meaningfulCalls = turn.toolCalls.filter(tc => !isPureLookupCall(tc));

    if (meaningfulCalls.length === 0) return;

    const callSummary = meaningfulCalls
      .map(tc => `${tc.name}(${tc.argsWindow}) -> ${tc.resultWindow ?? 'null'}`)
      .join('\n');

    // The answer is persisted before it is applied, so a replay applies what was
    // decided instead of asking the model again.
    const recorded = patternKey === null
      ? undefined
      : this.rt.storage.sql<{ answer: string }>`
          SELECT answer FROM pattern_extractions
          WHERE actor_id = ${this.rt.actor.actorId} AND effect_key = ${patternKey}`[0]?.answer;

    const generalized = recorded ?? await this.reviewLlm(turn).complete(
      `A successful interaction used these tool calls:\n${callSummary}\n\n` +
      `The user asked: "${evidenceWindow(turn.userMessage, EVIDENCE_BUDGETS.outcomeUserMessage)}"\n\n` +
      `Extract a reusable pattern as a JavaScript async arrow function.\n` +
      `{"name":"snake_case_name","description":"one line description","params":{"type":"object","properties":{...},"required":[...]},"code":"async (args) => { ... }"}\n` +
      `The code must be a self-contained async arrow function that takes an args object.\n` +
      jsonObjectOnlyInstruction(),
    );

    // Only unusable model output is skipped; upsert faults propagate.
    const json = tolerate(() => extractJsonObject(generalized), 'malformed-input');

    if (json === undefined) return;
    const parsed = v.safeParse(GeneralizedToolSchema, json);

    // Shape only; upsertCraftedTool compiles the code before storing it.
    if (!parsed.success || !parsed.output.name || !parsed.output.code) return;

    if (patternKey !== null && recorded === undefined) {
      void this.rt.storage.sql`INSERT INTO pattern_extractions (actor_id, effect_key, answer)
        VALUES (${this.rt.actor.actorId}, ${patternKey}, ${generalized})
        ON CONFLICT(actor_id, effect_key) DO NOTHING`;
    }

    const discovered = (parsed.output.description ?? parsed.output.name).slice(0, 60);

    const acceptance = await upsertCraftedTool(this.rt, {
      name: parsed.output.name,
      description: parsed.output.description ?? '',
      code: parsed.output.code,
    });

    // One commit for the discovery event, marker and answer retirement, so a kill
    // cannot duplicate the event or orphan the answer row.
    this.commit(() => {
      if (acceptance.accepted) {
        this.emit({
          type: 'craft_discovered',
          message: `Discovered pattern: ${discovered}`,
        });
      }

      if (patternKey !== null) {
        recordEffectDone(this.rt.storage.sql, this.rt.actor, { scope: TURN_REVIEW_STEP_SCOPE, key: patternKey });
        void this.rt.storage.sql`DELETE FROM pattern_extractions
          WHERE actor_id = ${this.rt.actor.actorId} AND effect_key = ${patternKey}`;
      }
    });
  }
}
