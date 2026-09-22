/**
 * EvolutionEngine: self-evolution at four timescales (docs/EVOLUTION.md).
 *
 * 0 In-episode: craft ledger and execution-recovery findings, no model call.
 * 1 Turn: turn N is graded from user message N+1 in the same conversation. A turn
 *   no follow-up can grade records no outcome, never an inferred `accepted`.
 * 2 Session: reflect when a closed window carries negative signal. The every-N-turns
 *   cadence lives only in AgentOrchestrator over the durable window (session-window.ts).
 * 3 Lifetime: craft consolidation and MCTS exploration. Replay eval is on demand only.
 */

import type { ShadowTrialPlan, ShadowTrialQueueOutcome } from './types';
import type { ModelMessage } from 'ai';
import * as v from 'valibot';

import type { AgentRuntime } from '../types/agent-runtime';
import type { LLM } from '../types/primitives';
import type { SessionWriter } from '../mcts/record-node';
import type {
  CompletedTurn,
  CompletedSession,
  EvolutionEvent,
  EvolutionListener,
  EvolutionConfig,
} from './types';
import { DEFAULT_EVOLUTION_CONFIG } from './types';
import { extractJsonObject, jsonObjectOnlyInstruction, stripMarkdownFences } from '../prompts/structured';
import { renderThrownChain, tolerate } from '../obs/index';
import { EVIDENCE_BUDGETS, evidenceWindow } from '../prompts/evidence-window';
import { upsertCraftedTool } from '../craft/conflict';
import { periodicCraftConsolidation } from '../craft/consolidation';
import { updateCraftScores } from '../craft/ema';
import { createCraftLedger, type CraftLedger } from '../craft/in-episode';
import { recordRecoveryFinding, recoveryFindingText, type RecoveryFinding } from './recovery';
import { effectAlreadyDone, recordEffectDone } from '../identity/effect-tombstones';
import { readSoul, summarizeSoul } from '../identity/soul';
import { conversationTurnPair } from '../identity/conversation-store';
import { CHAT_SESSION_ID } from '../session/transcript-schema';
import {
  ADVISOR_DEDUPE_WINDOW, ADVISOR_EVENT_TYPE, normalizeNote,
  type AdvisorNote, type AdvisorRowData,
} from '../advisor/review';
import {
  type TurnOutcome, type TurnOutcomeSource, type OutcomeClassification,
  initTurnOutcomeTables, isTrivialTurn, isNegativeOutcome, classifyTurnOutcome,
  executionVerdict, executionVerdictOutcome, isUserVerdictSource, isPureLookupCall, promotesProcedure,
  outcomeToFeedback, outcomeQuality,
  recordTurnOutcome, hasNegativeOutcome, takePickOutcome,
  listTurnOutcomes, NEGATIVE_TURN_OUTCOMES,
  recordLesson, recordedTurnVerdict, corroborateLessonsForTurn, renderRecentLessons,
  realOutcomeScaffoldRates, blendRealOutcomeRates,
} from './outcomes';
import {
  bindPendingImports, settleImportsForTurn, type ImportedExperienceRow,
} from '../experience/imports';
import { initReplayTables, runReplayEval, type ReplayEvalSummary } from './replay';
import {
  initCompletedTurnTable, createCompletedTurnStore, type CompletedTurnStore,
  MAX_TURN_REVIEWS_PER_OPEN,
  type DeferredReviewDrain, type RefusedTurnReview, type EnqueueOutcome,
} from './session-window';
import { initRefinementTables } from './refinement';
import { MissionBudgetExhausted } from '../mission-budget';
import { formatScoreInterval, lossInterval } from '../utils/stats';
import { buildChangelog } from './changelog';
import { DELEGATION_RUBRIC, delegationFeatures, renderDelegationFeatures } from './delegation-features';
import { renderScaffoldHandbook } from './scaffold-handbook';
import {
  clusterPathologies, labelPathologyClusters, renderPathologyBlock,
  describePathology, parsePathologyTag, PATHOLOGY_TAG_EXAMPLE,
  type PathologyCluster,
} from './pathology';

import { modifyScaffold } from '../scaffold/modify';
import { SCAFFOLD_HOST_TYPES } from '../scaffold/executor';
import { SCAFFOLD_FORBIDDEN_DESCRIPTION } from '../scaffold/safety-patterns';
import {
  listScaffoldArchive, listRejectedProposals, selectEvolutionBase,
  type EvolutionBaseSelection, type ScaffoldArchiveEntry,
} from '../scaffold/archive';
import { readScaffoldVersion, getCurrentScaffoldVersion } from '../scaffold/shadow';
import { tableExists } from '../identity/schema';

const GeneralizedToolSchema = v.object({
  name: v.optional(v.string()),
  description: v.optional(v.string()),
  code: v.optional(v.string()),
});

import { runMCTS } from '../mcts/engine';
import { createDurableMctsSession } from '../orchestrator/mcts-session';
import type { SessionHistory } from '../session/history';
import type { AgentConfigStore } from '../config/store';
import type { WorkspaceActor } from '../identity/workspace-actors';
import { diagnostics, toKinuError, KinuError } from '../obs/index';

/** The version a proposal branches from and the variants it may cite. */
export interface ProposalArchiveContext {
  base: EvolutionBaseSelection;
  entries: ReadonlyArray<ScaffoldArchiveEntry>;
  realRates?: ReadonlyMap<number, { accepted: number; negative: number }>;
  /** Why each refused version was refused, so a proposal can see what already failed. */
  rejections?: ReadonlyMap<number, string>;
}

function renderArchiveBlock(archive: ProposalArchiveContext): string {
  const lines = archive.entries.slice(0, 8).map((e) => {
    const lineage = e.parentVersion != null ? `parent v${e.parentVersion}` : 'root';
    const record = e.trials > 0 ? `${e.wins}-${e.losses}-${e.ties} W-L-T` : 'untried';
    const real = archive.realRates?.get(e.version);

    const realNote = real && real.accepted + real.negative > 0
      ? `, real ${real.accepted}✓/${real.negative}✗`
      : '';

    const targeted = e.pathology !== null ? `, for ${e.pathology}` : '';
    const rejection = archive.rejections?.get(e.version);
    const why = rejection ? `\n    refused: ${rejection}` : '';

    return `  v${e.version} [${e.status}, ${lineage}, ${record}${realNote}${targeted}] — ${e.rationale.slice(0, 80)}${why}`;
  });

  const baseNote = archive.base.mode === 'explore'
    ? `You are branching from ARCHIVED v${archive.base.version} (a stepping stone, not the live current) — its code is shown above.`
    : `You are branching from the live current v${archive.base.version}.`;

  return (
    `Scaffold archive (your prior variants — lineage + shadow record):\n` +
    `${lines.join('\n')}\n` +
    `${baseNote} You may take ideas from any archived variant; cite its version when you do.\n\n`
  );
}

/**
 * The scaffold-proposal prompt, documenting the real sandbox contract
 * (scaffold/executor.ts): host interaction goes only through the `host.*` bridge,
 * and both `run(rt, task)` parameters receive the task string. When pathologies are
 * mined, the proposal must name the one it targets; with none, the requirement is absent.
 */
export function buildScaffoldProposalPrompt(
  baseScaffold: string,
  reflection: string,
  archive?: ProposalArchiveContext,
  pathologies: ReadonlyArray<PathologyCluster> = [],
): string {
  return (
    `${renderScaffoldHandbook(baseScaffold)}\n` +
    `Current agent scaffold (your agentic loop — it runs inside a sandboxed worker):\n` +
    `\`\`\`js\n${baseScaffold}\n\`\`\`\n\n` +
    (archive ? renderArchiveBlock(archive) : '') +
    (pathologies.length > 0 ? renderPathologyBlock(pathologies) : '') +
    `Based on these session patterns:\n${evidenceWindow(reflection, EVIDENCE_BUDGETS.reflection)}\n\n` +
    `Propose an improved scaffold. The scaffold MUST:\n` +
    `1. Export exactly \`async function* run(rt, task)\`. There is NO host runtime object in the ` +
    `sandbox — BOTH parameters receive the task STRING; read the task from either, e.g. ` +
    `\`const prompt = task;\`. Neither parameter carries members to reach through.\n` +
    `2. Reach the host ONLY through the global \`host\` bridge:\n` +
    `\`\`\`ts\n${SCAFFOLD_HOST_TYPES}\n\`\`\`\n` +
    `\`await host.defaultInference()\` runs the standard inference loop — build on it or replace it ` +
    `with your own strategy via host.llmStream / host.callTool.\n` +
    `3. Stream text to the user by yielding { type: 'chunk', data: '<text>' }.\n` +
    `4. NOT use ${SCAFFOLD_FORBIDDEN_DESCRIPTION}. Also never reference raw network globals ` +
    `(fetch/WebSocket — use host.callTool for I/O), the scaffold version files/tables, ` +
    `promotion/rollout config keys, or shell-approval/consent settings — any of these is a hard ` +
    `misevolution veto.\n` +
    `5. Be a self-contained agentic loop.\n` +
    (pathologies.length > 0
      ? `6. Name the failure pathology it targets, as a tag line in the code: ` +
        `\`${PATHOLOGY_TAG_EXAMPLE}\`, using one of the ids listed above. The archive is ` +
        `read by pathology — a version that names none cannot be compared with the ones ` +
        `that do, and cannot show whether that failure ever went away.\n`
      : '') +
    `\nReturn ONLY the JavaScript code, no explanation.`
  );
}

/** Bounded because the lesson reaches every later turn once corroborated. */
const TURN_REFLECTION_MAX_CHARS = 240;

/**
 * The good/bad pair asks for a trigger and an action; otherwise a model writes about
 * the incident, which the session receiving the lesson cannot use.
 */
function buildTurnReflectionPrompt(input: {
  turn: CompletedTurn;
  outcome: TurnOutcome | null;
  quality: number;
  followup: string | null;
}): string {
  const { turn, outcome, quality, followup } = input;

  const toolSummary = turn.toolCalls.length > 0
    ? `Tools used: ${turn.toolCalls.map((call) => call.name).join(', ')}`
    : 'No tools used';

  return (
    `A recent interaction landed ${outcome ?? 'unobserved'} at ${quality.toFixed(2)}/1.0 quality.\n` +
    `User asked: "${evidenceWindow(turn.userMessage, EVIDENCE_BUDGETS.outcomeUserMessage)}"\n` +
    `Response: "${evidenceWindow(turn.assistantResponse, EVIDENCE_BUDGETS.outcomeAssistantResponse)}"\n` +
    `${toolSummary}\n` +
    `${renderDelegationFeatures(delegationFeatures(turn))}\n` +
    `${DELEGATION_RUBRIC}\n` +
    `${turn.hadError ? 'An error occurred.\n' : ''}` +
    `${followup ? `The user then replied: "${evidenceWindow(followup, EVIDENCE_BUDGETS.outcomeFollowup)}"\n` : ''}\n` +
    `In one sentence of at most ${String(TURN_REFLECTION_MAX_CHARS)} characters, what specifically ` +
    `should be done differently next time? It is stored as a lesson and read by later turns that ` +
    `have none of the evidence above, so name the trigger and the action, not the incident.\n` +
    `  Good: "When a run result's text begins \`Error (exit N)\`, treat it as a failure and re-run ` +
    `before reporting the work done."\n` +
    `  Bad: "Should have been more careful here." — no trigger, no action, and nothing a later reader ` +
    `can apply.`
  );
}

/** Tombstone scope for one turn's two durable grading writes (`turn_outcomes` row
 *  and craft EMA). Distinct from `turn_review`: a refusal after these writes retries
 *  the rest, not the writes. */
const TURN_GRADED_SCOPE = 'turn_graded';

/** Tombstone scope for the review's later writes (reflection lesson, extracted
 * pattern), so a refusal between them resumes rather than repeats. */
const TURN_REVIEW_STEP_SCOPE = 'turn_review_step';

/** An errored abandonment is the one case the error decides; a clean one stays
 *  neutral. Ungraded turns are priced only when they errored. */
function turnQuality(outcome: TurnOutcome | null, source: TurnOutcomeSource, hadError: boolean): number | null {
  if (outcome === null) return hadError ? 0.1 : null;

  if (outcome === 'abandoned' && hadError) return 0.1;

  return outcomeQuality(outcome, source);
}

export class EvolutionEngine {
  private readonly rt: AgentRuntime;
  private readonly history: SessionHistory;
  private readonly config: EvolutionConfig;
  private readonly listeners: EvolutionListener[] = [];
  /** Also holds the durable closed-window count the lifetime timescale paces by. */
  private readonly agentConfig: AgentConfigStore;
  /** Every completed turn still owed evolution work, one row per turn.
     *  AgentOrchestrator owns the cadence; the engine owns the ledger. */
  readonly sessionWindow: CompletedTurnStore;
  /** The crafted-tool ledger the step clock writes through, so both timescales
     *  score crafted tools through one table. */
  readonly craftLedger: CraftLedger;
  readonly recordsTurns: boolean;
  private recoveryPending = true;

  constructor(rt: AgentRuntime, history: SessionHistory, config?: Partial<EvolutionConfig>) {
    this.rt = rt;
    this.history = history;
    this.config = { ...DEFAULT_EVOLUTION_CONFIG, ...config };
    rt.actor.assertCurrent();

    const actor = rt.storage.sql<Pick<WorkspaceActor, 'kind'>>`
      SELECT kind FROM workspace_actors WHERE actor_id = ${rt.actor.actorId}`[0];

    if (actor === undefined) throw new KinuError('missing', 'the evolution actor has no membership record');
    this.recordsTurns = this.config.enabled && actor.kind === 'main';
    this.craftLedger = createCraftLedger({ craftStore: rt.craftStore, sql: rt.storage.sql });

    // Created here so every backend gets the engine's ledgers without schema wiring.
    initTurnOutcomeTables(rt.storage.execRaw);
    initReplayTables(rt.storage.execRaw);
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
     * The fast tier for mechanical calls (classification, pathology labels,
     * reflections, pattern extraction); falls back to the chat model. The scaffold
     * proposal deliberately stays on the chat model.
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

  /** Inline where the backend supplies no transaction seam (a synchronous run is
     *  already atomic inside a Durable Object). */
  private commit(body: () => void): void {
    (this.config.transaction ?? ((run: () => void) => { run(); }))(body);
  }

  get enabled(): boolean {
    return this.config.enabled;
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
    if (!this.config.enabled) return;

    if (!recordRecoveryFinding(this.rt.storage.sql, this.rt.actor, finding)) return;
    this.emit({
      type: 'reflection',
      message: `[execution recovery] ${recoveryFindingText(finding)}`,
    });
  }

  /**
     * The advisor's row on the audit stream. Lives here because `emit` is the one
     * `evolution_events` writer that also reaches the engine's listeners. The row
     * carries the note's class and graded turn id; `advisorNegatives` resolves it
     * through the transcript, so neither message nor response is copied here.
     */
  recordAdvisorNote(note: AdvisorNote, turnId?: string): void {
    const data: AdvisorRowData = {
      severity: note.severity, class: note.class, turnId: turnId ?? null,
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
     * Idempotency guard for a re-entered advisor lane: the note row is the only
     * durable evidence that the review completed.
     */
  hasAdvisorNoteForTurn(turnId: string): boolean {
    const rows = this.rt.storage.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM evolution_events
      WHERE actor_id = ${this.rt.actor.actorId} AND type = ${ADVISOR_EVENT_TYPE}
        AND json_extract(data, '$.turnId') = ${turnId}`;

    return (rows[0]?.n ?? 0) > 0;
  }

  /**
     * Grade turn N from the user's follow-up and run turn-level evolution. `followup`
     * null means no conversational follow-up can grade the turn (programmatic wakes,
     * `kinu exec`). Explicit thumbs beat the classifier; trivial turns skip it; a
     * classifier failure records nothing. `turn.hadError` still drives quality and a
     * provisional reflection.
     */
  async reviewTurn(turn: CompletedTurn, followup: string | null): Promise<void> {
    if (!this.config.enabled) return;

    let outcome: TurnOutcome | null = null;
    let source: TurnOutcomeSource = 'classifier';
    let confidence = 1;
    let evidence = '';
    // An Alternate Takes pick already wrote the ledger row; adopt it without letting
    // the classifier overwrite it.
    let preRecorded = false;

    // Keyed on the turn so a retry after eviction or a later refusal does not repeat
    // the grading writes. An empty id is not an identity.
    const gradedKey = turn.turnId === undefined || turn.turnId === '' ? null : turn.turnId;

    // Checked before the classifier so a resumed review spends no model call. The
    // tombstone, not the row, is the signal: an ungraded errored turn writes no row.
    const graded = gradedKey !== null
      && effectAlreadyDone(this.rt.storage.sql, this.rt.actor, TURN_GRADED_SCOPE, gradedKey);

    const recorded = graded ? recordedTurnVerdict(this.rt.storage.sql, this.rt.actor, gradedKey) : null;

    if (recorded) {
      outcome = recorded.outcome;
      source = recorded.source;
      confidence = recorded.confidence;
    }

    const explicit = graded ? null : this.readExplicitFeedback(turn.turnId);
    const pickedOutcome = graded || explicit ? null : takePickOutcome(this.rt.storage.sql, this.rt.actor, turn.turnId);

    if (graded) {
      // Resumed: the suffix below is what is still owed.
    } else if (explicit) {
      outcome = explicit === 'positive' ? 'accepted' : 'corrected';
      source = 'explicit';
    } else if (pickedOutcome) {
      outcome = pickedOutcome;
      source = 'take_pick';
      preRecorded = true;
    } else if (isTrivialTurn(turn)) {
      return; // pre-filter: nothing to accept or correct, no LLM call
    } else if (followup !== null) {
      const c: OutcomeClassification | null = await classifyTurnOutcome(this.reviewLlm(turn), {
        userMessage: turn.userMessage,
        assistantResponse: turn.assistantResponse,
        followup,
      });

      if (!c) return; // classifier unusable — no signal beats a guessed one
      outcome = c.outcome;
      confidence = c.confidence;
      evidence = c.evidence;
    } else {
      // No user signal, but the environment may still have a verdict on what the turn did.
      const verdict = executionVerdict(turn);

      if (verdict) {
        outcome = executionVerdictOutcome(verdict);
        source = 'execution';
        evidence = verdict === 'succeeded'
          ? 'every tool call this turn ran completed'
          : 'the turn ended in an error';
        // `source: 'execution'` and EXECUTION_QUALITY already discount the proxy.
        confidence = 1;
      }
      // Not written as 'abandoned': a follow-up may still come, and the neutral 0.5
      // would pull the craft EMA on no evidence. It is still announced with `graded: false`.
    }

    // Computed before the writes so all of them fit in one commit.
    const quality = turnQuality(outcome, source, turn.hadError);

    // Crafted tools are codemode-only, so they come from the turn record, not from
    // the non-builtin tool names.
    const craftedToolNames = turn.craftedToolsUsed ?? [];

    // `source`/`confidence` describe a verdict, so they are null on an ungraded turn.
    // Announced once, last inside the commit, so a death cannot replay the writes.
    const announce = (): void => { if (!graded) this.emit({
      type: 'turn_complete',
      message: `Turn outcome: ${outcome ?? 'ungraded (no follow-up)'}` +
        (quality !== null ? ` | quality ${quality.toFixed(2)}` : '') +
        ` | ${turn.toolCalls.length} tool calls | ${turn.steps} steps | ${turn.hadError ? 'had errors' : 'clean'}`,
      data: {
        outcome, graded: outcome !== null,
        source: outcome ? source : null,
        confidence: outcome ? confidence : null,
        evidence, quality,
        toolCount: turn.toolCalls.length, steps: turn.steps, durationMs: turn.durationMs,
      },
    }); };

    // One commit for the verdict row, craft scores, tombstone and announcement: a
    // synchronous run is atomic inside a Durable Object but not against a CLI kill.
    this.commit(() => {
      if (outcome && !graded && !preRecorded) {
        recordTurnOutcome(this.rt.storage.sql, this.rt.actor, {
          turnId: turn.turnId ?? null,
          sessionId: turn.sessionId ?? 'default',
          outcome, confidence, source,
          userMessage: turn.userMessage,
          assistantResponse: turn.assistantResponse,
          followup,
          scaffoldVersion: getCurrentScaffoldVersion(this.rt.storage.sql, this.rt.actor),
          // The classifier's reason or the execution verdict's observation.
          evidence,
        });
      }

      // A failed EMA write silences the retirement signal, so it is not swallowed.
      if (quality !== null && craftedToolNames.length > 0 && !graded) {
        updateCraftScores(this.rt.storage.sql, craftedToolNames, quality);
      }

      if (gradedKey !== null && !graded) {
        recordEffectDone(this.rt.storage.sql, this.rt.actor, { scope: TURN_GRADED_SCOPE, key: gradedKey });
      }

      announce();
    });

    if (outcome && !graded) turn.feedback = outcomeToFeedback(outcome);


    if (quality === null) {
      // Programmatic and clean: the announcement is the whole output, so the marker
      // is written here.
      return;
    }


    const negative = isNegativeOutcome(outcome);
    // Only a person's negative verdict corroborates provisional lessons; an error is
    // not a reader confirming the lesson, though it still warrants a provisional reflection.
    const corroborated = negative && isUserVerdictSource(source);

    if (corroborated) this.corroborateLessons(turn.turnId);

    // Only a user verdict settles imported experience: a command exiting zero is not
    // the corroboration that trust boundary requires.
    if (isUserVerdictSource(source)) await this.settleImports(turn.turnId, outcome);

    // Negative signal of any provenance, or an error on an ungraded turn.
    if (negative || ((outcome === 'abandoned' || outcome === null) && turn.hadError)) {
      // The lesson's own tombstone stops a retry from writing a second copy.
      const reflectionKey = gradedKey === null ? null : `${gradedKey}:reflection`;

      if (reflectionKey === null
        || !effectAlreadyDone(this.rt.storage.sql, this.rt.actor, TURN_REVIEW_STEP_SCOPE, reflectionKey)) {
        const reflection = await this.generateTurnReflection(turn, outcome, quality, followup);

        const lesson = {
          turnIds: turn.turnId ? [turn.turnId] : [],
          text: reflection,
          source: 'turn_reflection',
          status: corroborated ? 'corroborated' : 'provisional',
        } satisfies Parameters<typeof recordLesson>[2];

        // Keyed, so a death between insert and tombstone replays into the same row.
        recordLesson(
          this.rt.storage.sql, this.rt.actor,
          reflectionKey === null ? lesson : { ...lesson, key: reflectionKey },
        );

        if (reflectionKey !== null) {
          recordEffectDone(this.rt.storage.sql, this.rt.actor, { scope: TURN_REVIEW_STEP_SCOPE, key: reflectionKey });
        }

        this.emit({ type: 'reflection', message: corroborated ? reflection : `[provisional] ${reflection}` });
      }
    }

    if (promotesProcedure({ outcome, source, toolCalls: turn.toolCalls.length })) {
      // The key travels into the body so the marker lands beside the writes.
      const patternKey = gradedKey === null ? null : `${gradedKey}:pattern`;

      if (patternKey === null
        || !effectAlreadyDone(this.rt.storage.sql, this.rt.actor, TURN_REVIEW_STEP_SCOPE, patternKey)) {
        await this.extractPattern(turn, quality, patternKey);
      }
    }
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
    if (!this.config.enabled) return 'queued';
    const outcome = this.sessionWindow.enqueueReview(turn, followup, opts);

    if (outcome !== 'queued') {
      diagnostics.failure(
        'evolution.turn_review_not_deferred',
        toKinuError({
          doing: 'defer a turn review for the next host',
          cause: new Error(outcome === 'queue_full'
            ? `the review queue is full (${this.sessionWindow.countQueuedReviews()} owed) — nothing has drained it`
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
    // Before the lease settles, leaving a one-step crash window.
    this.sessionWindow.recordReviewRan(rowId);
    this.sessionWindow.settleReview(rowId);
  }

  /**
     * Drain deferred reviews through `reviewTurn`, at most
     * {@link MAX_TURN_REVIEWS_PER_OPEN} per call so a backlog does not delay the
     * turn being opened. A row is retired only once its review ran. Undecodable rows
     * and missions over cap come back in `refused` with their disposition.
     */
  async runDeferredTurnReviews(): Promise<DeferredReviewDrain> {
    if (!this.config.enabled) return { reviewed: 0, refused: [] };
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

      // Before the lease settles, leaving a one-step crash window.
      this.sessionWindow.recordReviewRan(row.id);
      this.sessionWindow.settleReview(row.id);
      reviewed++;
    }

    return { reviewed, refused };
  }

  /**
     * Explicit thumbs from setTurnFeedback. Upserts the turn_outcomes ledger
     * (explicit overrides the classifier); a negative corroborates provisional lessons.
     */
  async applyExplicitFeedback(messageId: string, feedback: 'positive' | 'negative'): Promise<void> {
    // A failed read is a fault: a row with blank texts would poison downstream evals.
    const pair = await conversationTurnPair(this.history.transcript(CHAT_SESSION_ID), messageId);
    recordTurnOutcome(this.rt.storage.sql, this.rt.actor, {
      turnId: messageId,
      sessionId: pair?.sessionId ?? 'default',
      outcome: feedback === 'positive' ? 'accepted' : 'corrected',
      confidence: 1,
      source: 'explicit',
      userMessage: pair?.request ?? '',
      assistantResponse: pair?.response ?? '',
      followup: null,
      scaffoldVersion: getCurrentScaffoldVersion(this.rt.storage.sql, this.rt.actor),
    });

    if (feedback === 'negative') this.corroborateLessons(messageId);
  }

  /** The ledger row is already written by recordTakePick; a correction
     *  corroborates provisional lessons like a thumbs-down. */
  applyTakePick(turnId: string | null, outcome: 'accepted' | 'corrected'): void {
    if (outcome === 'corrected' && turnId) this.corroborateLessons(turnId);
  }

  /** turn_feedback is cf-backend-only (conformance/manifest.ts), so its absence is
     *  checked explicitly rather than inferred from an exception. */
  private readExplicitFeedback(turnId?: string): 'positive' | 'negative' | null {
    if (!turnId || !tableExists(this.rt.storage.sql, 'turn_feedback')) return null;

    // Scoped: message ids are minted per actor, so an unscoped read can return a sibling's row.
    return this.rt.storage.sql<{ feedback: 'positive' | 'negative' }>`
      SELECT feedback FROM turn_feedback
      WHERE actor_id = ${this.rt.actor.actorId} AND message_id = ${turnId} LIMIT 1`[0]?.feedback ?? null;
  }

  /** A row-status change only; readers derive from that status. */
  private corroborateLessons(turnId?: string): void {
    if (!turnId) return;
    corroborateLessonsForTurn(this.rt.storage.sql, this.rt.actor, turnId);
  }
  /**
     * The only path by which another workspace's imported experience joins this one,
     * settled by a graded turn's verdict. An ungraded turn settles nothing.
     */
  private async settleImports(turnId: string | undefined, outcome: TurnOutcome | null): Promise<void> {
    if (!turnId || outcome === null || outcome === 'abandoned') return;
    // Not caught: a wide catch would also absorb a failed adoption and leave the
    // import staged forever.
    bindPendingImports(this.rt.storage.sql, this.rt.actor, turnId);

    const settled = await settleImportsForTurn(
      this.rt, turnId, outcome === 'accepted' ? 'accepted' : 'rejected',
    );

    if (settled.corroborated.length === 0 && settled.discarded.length === 0) return;

    const describe = (rows: ImportedExperienceRow[]) =>
      rows.map((r) => `${r.kind} "${r.key}" from ${r.sourceWorkspace}`).join(', ');

    this.emit({
      type: 'experience_import',
      message: settled.corroborated.length > 0
        ? `Adopted imported experience after an accepted turn: ${describe(settled.corroborated)}`
        : `Discarded imported experience after a ${outcome} turn: ${describe(settled.discarded)}`,
      data: {
        outcome,
        corroborated: settled.corroborated.map((r) => r.libraryId),
        discarded: settled.discarded.map((r) => r.libraryId),
      },
    });
  }

  /**
     * Called by AgentOrchestrator when a session window closes. Reflects only when the
     * window carries negative signal.
     */
  async onSessionComplete(session: CompletedSession): Promise<void> {
    if (!this.config.enabled) return;

    const windowsClosed = this.agentConfig.countClosedTurnWindow();

    if (session.turns.length >= 3 && this.sessionWarrantsReflection(session)) {
      await this.onSessionReflection(session, windowsClosed);
    }

    if (windowsClosed % this.config.lifetimeEvolutionInterval === 0) {
      await this.onLifetimeEvolution();
    }

    // Session-end changelog digest over the ledgers; never blocks.
    this.emitChangelogDigest(session.startedAt);
  }

  /**
     * Record a completed turn as shadow evidence: one row, no inference. `plan` is
     * the caller's sampling decision (`shadowTrialPlan`), so a replay records the same trial.
     */
  queueShadowTrial(
    turn: CompletedTurn, context: readonly ModelMessage[], plan: ShadowTrialPlan,
  ): ShadowTrialQueueOutcome {
    if (!this.config.enabled) return 'not_sampled';

    return this.config.shadowTrialQueue?.({
      task: turn.userMessage,
      currentOutput: turn.assistantResponse,
      context,
    }, plan) ?? 'not_sampled';
  }

  /**
     * Run queued trials for the pending scaffold. Due whenever a capable host asks,
     * not on the session window: `maybeEvolveScaffold` refuses to propose while one is
     * pending, so gating it there would stall the loop. Absorbs its own failures.
     * Gated on `enabled`; the queue is durable for the next enabled host.
     */
  async runDueShadowTrials(): Promise<void> {
    if (!this.config.enabled || !this.config.shadowTrialRunner) return;

    try {
      await this.config.shadowTrialRunner();
    } catch (err) {
      diagnostics.failure(
        'evolution.shadow_trial_drain_failed',
        toKinuError({ doing: 'drain the due shadow trials', cause: err, otherwise: 'unavailable' }),
      );
    }
  }

  private emitChangelogDigest(since: number): void {
    const entries = buildChangelog(this.rt.storage.sql, this.rt.actor, { since, limit: 20 });

    if (entries.length === 0) return;
    const counts = new Map<string, number>();

    for (const e of entries) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
    const parts = [...counts].map(([kind, n]) => `${n} ${kind}`).join(' · ');
    this.emit({
      type: 'changelog_digest',
      message: `Self-change digest: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} this session (${parts}) — every line is revertable in the changelog`,
      data: { since, counts: Object.fromEntries(counts) },
    });
  }

  /** An error, negative feedback, or a recorded corrected/frustrated outcome. */
  private sessionWarrantsReflection(session: CompletedSession): boolean {
    if (session.turns.some(t => t.hadError || t.feedback === 'negative')) return true;
    const turnIds = session.turns.map(t => t.turnId).filter((id): id is string => id !== undefined && id !== '');

    return hasNegativeOutcome(this.rt.storage.sql, this.rt.actor, turnIds);
  }

  /** Self-scored prose enters corroborated lessons only when a recorded outcome
     *  already backs the window; otherwise it stays provisional. */
  private async onSessionReflection(session: CompletedSession, windowsClosed: number): Promise<void> {
    // Input is the ledger's corroborated lessons, not a memory file's contents.
    const recentLessons = renderRecentLessons(this.rt.storage.sql, this.rt.actor, 5);

    if (!recentLessons.trim()) return;

    const reflection = await this.fastLlm.complete(
      `You are reflecting on your recent interactions to improve yourself.\n\n` +
      `Recent lessons:\n${evidenceWindow(recentLessons, EVIDENCE_BUDGETS.lessons)}\n\n` +
      `In 2-3 bullet points, what patterns do you see? What should you do differently?\n` +
      `Focus on actionable changes to your behavior.`,
    );

    const turnIds = session.turns.map(t => t.turnId).filter((id): id is string => id !== undefined && id !== '');
    const corroborated = hasNegativeOutcome(this.rt.storage.sql, this.rt.actor, turnIds);
    recordLesson(this.rt.storage.sql, this.rt.actor, {
      turnIds,
      text: reflection,
      source: 'session_reflection',
      status: corroborated ? 'corroborated' : 'provisional',
    });

    this.emit({ type: 'reflection', message: `Session reflection${corroborated ? '' : ' [provisional]'}: ${reflection.slice(0, 100)}...` });

    if (windowsClosed >= 3) {
      await this.maybeEvolveScaffold(reflection);
    }
  }

  /** Only an archived stepping stone needs the versioned-backup read (v0 has no backup). */
  private async readBaseScaffold(base: EvolutionBaseSelection | null, currentScaffold: string): Promise<string | null> {
    if (base === null) return null;

    if (base.mode === 'current') return currentScaffold;

    return readScaffoldVersion(this.rt, base.version);
  }

  /** A rejected proposal is a returned value, so nothing here is wrapped in a catch
     *  that would also swallow real faults. */
  private async maybeEvolveScaffold(reflection: string): Promise<void> {
    const scaffoldExists = await this.rt.identity.scaffold.exists();

    if (!scaffoldExists) return;

    // One proposal in flight at a time; consecutive windows would orphan pending versions.
    const pending = this.rt.storage.sql<{ version: number }>`
      SELECT version FROM scaffold_versions
      WHERE actor_id = ${this.rt.actor.actorId} AND status = 'pending' LIMIT 1
    `;

    if (pending.length > 0) {
      this.emit({
        type: 'scaffold_proposed',
        message: `Skipped — scaffold v${pending[0].version} is still pending shadow evaluation`,
      });

      return;
    }

    const currentScaffold = await this.rt.identity.scaffold.read();

    if (!currentScaffold || currentScaffold.length < 50) return;

    // DGM archive branching (scaffold/archive.ts selectEvolutionBase), weighted by
    // shadow record and real turn outcomes, aggregated over descendant lineage.
    const archive = listScaffoldArchive(this.rt.storage.sql, this.rt.actor, 12);
    const realRates = realOutcomeScaffoldRates(this.rt.storage.sql, this.rt.actor);

    const base = selectEvolutionBase(blendRealOutcomeRates(archive, realRates), {
      exploreShare: this.agentConfig.getScaffoldExploreShare(),
    });

    const baseCode = await this.readBaseScaffold(base, currentScaffold);

    // Cells are deterministic (evolution/pathology.ts); the model only phrases titles.
    const pathologies = await labelPathologyClusters(this.fastLlm, clusterPathologies(
      listTurnOutcomes(this.rt.storage.sql, this.rt.actor, { limit: 60, outcomes: NEGATIVE_TURN_OUTCOMES }),
    ));

    const rejections = new Map(
      listRejectedProposals(this.rt.storage.sql, this.rt.actor, 12)
        .flatMap((r) => (r.version === null ? [] : [[r.version, r.reason] as const])),
    );

    const proposed = await this.rt.llm.complete(
      buildScaffoldProposalPrompt(
        baseCode ?? currentScaffold,
        reflection,
        base && baseCode ? { base, entries: archive, realRates, rejections } : undefined,
        pathologies,
      ),
    );

    if (!proposed.includes('async function* run')) return;

    const code = stripMarkdownFences(proposed);

    const branchNote = base && baseCode
      ? `branched from v${base.version}${base.mode === 'explore' ? ' (archive stepping stone)' : ''}`
      : 'branched from the live scaffold';

    const rationale = `Session reflection, ${branchNote}: ${reflection.slice(0, 100)}`;

    const result = await modifyScaffold(
      this.rt, rationale, code,
      base && baseCode ? { baseVersion: base.version } : undefined,
    );

    if (!result.ok) return;
    // The same parse modifyScaffold stamped the row with, so event and row agree.
    const targeted = parsePathologyTag(code);
    this.emit({
      type: 'scaffold_proposed',
      message: `Scaffold evolved to v${result.version} (${branchNote}): ${reflection.slice(0, 60)}` +
        (targeted ? ` — targets ${describePathology(targeted)}` : ''),
    });
  }

  /** Full MCTS evolution cycle; automatic every N windows, or via `kinu evolve`. */
  async onLifetimeEvolution(session?: SessionWriter): Promise<void> {
    const rt = this.rt;

    const purpose = summarizeSoul(await readSoul(rt.agentStateVfs ?? rt.storage.vfs))
      || 'be a helpful assistant';

    this.emit({
      type: 'mcts_started',
      message: `Starting evolution cycle (budget=${this.config.lifetimeMCTSBudget})...`,
    });

    // No replay eval here: GEPA's seed scoring already re-executes the same ledger,
    // and no decision reads the replay curve. It stays available via `runReplayEval`.

    await periodicCraftConsolidation(this.rt);
    this.emit({ type: 'consolidation', message: 'CraftStore consolidation complete' });

    // Default to the durable writer: a resumed search needs the branch ancestry.
    const writer = session ?? createDurableMctsSession(this.history);

    const task = `Given my purpose: "${purpose}", identify one specific improvement ` +
      `to be more effective. Consider: new tools, knowledge gaps, workflow improvements.`;

    try {
      // The iteration budget stays the lifetime cadence cap, not mcts_iterations.
      const overrides = this.agentConfig.getMctsOverrides();

      const result = await runMCTS(this.rt, writer, task, {
        budget: this.config.lifetimeMCTSBudget,
        branches: overrides.branches ?? this.config.lifetimeMCTSBranches,
        maxDepth: overrides.maxDepth,
        explorationWeight: overrides.explorationWeight,
        judgeSamples: overrides.judgeSamples,
        maxEvalLLMCalls: overrides.maxEvalLLMCalls,
        onProgress: this.config.onMctsProgress,
      });

      this.emit({
        type: 'mcts_complete',
        message: `Evolution ${result.converged ? 'converged' : 'explored'} (score: ${result.winnerValue.toFixed(2)})`,
        data: result,
      });
    } catch (err) {
      const message = renderThrownChain({ cause: err });
      this.emit({
        type: 'mcts_complete',
        message: `Evolution failed: ${message}`,
      });
    }
  }

  /**
     * Re-run a sample of outcome-labeled turns against the current config and score
     * against the recorded outcome, persisted to replay_evals. On demand only. Null
     * without a runner or labeled turns. A failed re-run or verdict scores 0.
     */
  async runReplayEval(sampleSize?: number): Promise<ReplayEvalSummary | null> {
    const runTask = this.config.replayTaskRunner;

    if (!runTask) return null;

    const summary = await runReplayEval({
      sql: this.rt.storage.sql,
      actor: this.rt.actor,
      judge: this.rt.judgeModel ?? this.rt.llm,
      runTask,
      sampleSize,
      scaffoldVersion: getCurrentScaffoldVersion(this.rt.storage.sql, this.rt.actor),
    });

    if (summary) {
      this.emit({
        type: 'replay_eval',
        message: `Replay eval: loss ${formatScoreInterval(lossInterval(summary.interval))} ` +
          `over ${summary.sampleSize} labeled turns ` +
          `(${summary.acceptedCount} accepted / ${summary.negativeCount} corrected)`,
        data: summary,
      });
    }

    return summary;
  }

  /** The user's correction is the strongest context when present. The answer is
     *  truncated rather than rejected (as in advisor/review.ts). */
  private async generateTurnReflection(
    turn: CompletedTurn, outcome: TurnOutcome | null, quality: number, followup: string | null,
  ): Promise<string> {
    const raw = await this.reviewLlm(turn).complete(
      buildTurnReflectionPrompt({ turn, outcome, quality, followup }),
    );

    return raw.trim().slice(0, TURN_REFLECTION_MAX_CHARS);
  }

  /** Pure-lookup calls are skipped: they encode no reusable pattern. */
  private async extractPattern(
    turn: CompletedTurn,
    quality: number,
    /** Written next to the upsert so no await separates the tool from its record. */
    patternKey: string | null,
  ): Promise<void> {
    const meaningfulCalls = turn.toolCalls.filter(tc => !isPureLookupCall(tc));

    if (meaningfulCalls.length === 0) return;

    const callSummary = meaningfulCalls
      .map(tc => `${tc.name}(${evidenceWindow(JSON.stringify(tc.args), EVIDENCE_BUDGETS.patternToolCall)}) → ${evidenceWindow(JSON.stringify(tc.result), EVIDENCE_BUDGETS.patternToolCall)}`)
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
      void this.rt.storage.sql`INSERT INTO pattern_extractions (actor_id, effect_key, answer, created_at)
        VALUES (${this.rt.actor.actorId}, ${patternKey}, ${generalized}, ${Date.now()})
        ON CONFLICT(actor_id, effect_key) DO NOTHING`;
    }

    const discovered = (parsed.output.description ?? parsed.output.name).slice(0, 60);

    const acceptance = await upsertCraftedTool(this.rt, {
      name: parsed.output.name,
      description: parsed.output.description ?? '',
      code: parsed.output.code,
      score: quality,
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
