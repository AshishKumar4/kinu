/**
 * Turn lifecycle — the settle spine both backends share around one turn:
 *
 *   openTurnRun / closeTurnRun    the durable run-event bracket
 *                                 (run_start+turn_start … turn_end+run_end)
 *   snapshotCompletedTurn         the CompletedTurn the evolution loop grades,
 *                                 built from the shared TurnAccumulator
 *   persistMeasuredPromptTokens   the NEXT turn's measured compaction trigger
 *   applyOverflowRecovery         the turn-failure policy APPLIED: arm force-
 *                                 compaction + deliver exactly one retry signal
 *   creditedTurnId                which id, if any, the work captured INSIDE
 *                                 the turn may be attributed to
 *
 * Each existed twice — cf beforeTurn/recordTurnTelemetry and the CLI
 * processTurn/closeRun — with the payload shapes drifting one field at a time.
 */

import type { TurnContextBudget } from '../context-budget';
import type { TurnFileLedger } from '../tools/file-ledger';
import type {
  CompletionGateRecord, CraftCycleRecord, DelegationOpportunityRecord, ExecutionRecoveryRecord,
  RunEventInput, TurnSteeringRecord,
} from '../events/types';
import type { TurnEscalationLedger } from '../execution/escalation';
import type { CompletedTurn } from '../evolution/types';
import type { WorkMode } from '../prompting/surface';
import { usageReported, type Usage } from '../usage';
import type { TurnAccumulator } from './turn-accumulator';
import {
  planOverflowRecovery, OVERFLOW_RETRY_EVENT, OVERFLOW_RETRY_TEXT,
  type OverflowRecoveryDecision,
} from '../turn-failure';
import type { SignalDeliverer } from '../types/signals';
import { diagnostics, toKinuError } from '../obs/index';

/** The recorder slice this spine writes through — structural (both backends
 *  pass their RunEventRecorder). */
export interface TurnRunRecorder {
  emit(runId: string, input: RunEventInput): void;
}

/**
 * How a run ended, as the durable ledger names it.
 *
 * Three values, and they are the same three the CF turn driver already reports,
 * so nothing here invents a vocabulary. It is a TYPE because it was a bare
 * string: one backend sealed a user Stop as `'aborted'` and the other sealed the
 * identical action as `'error'`, and every cross-backend reader of the run
 * ledger — Supervise, eval triage — counted local stops as failures. Nothing
 * mechanical held the two spellings together.
 *
 * DELIBERATELY STILL THREE. A fourth word for a turn cut mid-work was designed
 * and dropped: the cloud loop's step ceiling was the only thing that could
 * produce that state, and removing the ceiling removes the state. See
 * {@link TURN_ENDED_MID_WORK} for what guards it instead, and why a ledger word
 * no run can carry would have been worse than none.
 */
export const RUN_END_REASONS = ['completed', 'aborted', 'error'] as const;
export type RunEndReason = (typeof RUN_END_REASONS)[number];

/**
 * The finish reason a step reports when it emitted tool calls.
 *
 * The AI SDK's own word (`ai`'s `FinishReason`), not ours. A step that ends this
 * way had its tool results delivered and a further step due: the model was
 * mid-work. So a turn whose LAST step says this did not reach an end of its
 * own — something stopped it.
 */
export const TOOL_CALLS_PENDING = 'tool-calls';

/**
 * The finish reason a step reports when the PROVIDER cut the answer at its
 * output limit — the model had more to say and was not allowed to say it.
 *
 * The AI SDK's own word again (`FinishReason`'s `'length'`), normalized by the
 * provider adapter from whatever the endpoint called it (`max_tokens`,
 * `MAX_TOKENS`, `length`), which is why this is read from the mapped reason and
 * never pattern-matched on a provider payload.
 *
 * A turn whose last step says this did NOT reach an end of its own either, and
 * unlike {@link TOOL_CALLS_PENDING} it is entirely ordinary — the answer was
 * simply longer than one response. `runChat` answers it with exactly one
 * continuation request (chat.ts), and a SECOND one is honest partial
 * completion: the turn keeps what it produced and says how it ended.
 */
export const OUTPUT_LIMIT_REACHED = 'length';

/**
 * THE INVARIANT: a turn that reached its own end never has tool calls pending.
 *
 * Reported as a DEFECT rather than named in the ledger, and that is a decision
 * with an argument behind it.
 *
 * The state was real and it shipped: `@cloudflare/think` OR-s
 * `stepCountIs(this.maxSteps)` — default 10 — ahead of anything a caller passes,
 * so four of four production turns that reached ten steps were cut with the model
 * still emitting tool calls, and all four sealed `'completed'`. The obvious fix
 * is a fourth ledger word. It is the wrong one, because the ceiling was the ONLY
 * producer. Once the bound is a step count no turn can reach, nothing else can
 * end a clean loop mid-work: Think's other stop condition
 * (`hasToolCall(finalAnswerToolName)`) fires only for structured output, which no
 * actor here requests — and would be a legitimate end if one did; every tool on
 * the surface executes server-side, so no client-side tool can suspend the loop;
 * a user Stop seals `'aborted'` and a throw seals `'error'`, both ahead of this
 * check; a turn killed with its host writes no `run_end` row at all, which
 * `RunEventRecorder.unterminatedModelOperations` already detects. Heads and swarm
 * nodes DO run bounded stop conditions, and they journal rather than sealing a
 * run, so they never reach here.
 *
 * A fourth word would therefore have been vocabulary no run could carry, spread
 * across a union, a valibot mirror, two read models, a status dot and an
 * analytics arm — every one of them a branch nothing reaches, and each one a
 * thing a reader has to understand before concluding it never happens.
 *
 * What is owed instead is a tripwire. If this fires, one of the facts above
 * stopped being true — a vendor release re-introducing a cap, an actor that
 * starts asking for structured output, a client-side tool — and it is a defect in
 * the loop, not a status for a user. It is `failure` and not `event` for exactly
 * that reason: the run still seals `'completed'` because that is what the driver
 * observed, and the diagnostic is the only thing that says the observation is
 * impossible.
 */
export const TURN_ENDED_MID_WORK = 'turn.ended_mid_work';

/** What the driver knows when a turn stops, before anyone has named it. */
export interface RunEndFacts {
  /** The turn reached its own end. */
  readonly completed: boolean;
  /** The turn was CUT — the user pressed Stop, or the host cancelled it. On the
   *  CLI this is the `INTERRUPTED_TURN` identity check on the thrown error; on
   *  CF it is the driver reporting status `'aborted'`. */
  readonly interrupted: boolean;
  /** The failure text, when the turn ended by throwing something that was not
   *  an interruption. */
  readonly errorText?: string | undefined;
  /** The `finishReason` of the turn's LAST step (`acc.lastFinishReason`), or
   *  absent when no step reported one. Carried for one purpose: a clean end whose
   *  last word was {@link TOOL_CALLS_PENDING} is impossible, and this is the fact
   *  that lets {@link TURN_ENDED_MID_WORK} say so. */
  readonly lastFinishReason?: string | undefined;
}

/** A named run end, ready for {@link closeTurnRun}. Named rather than an
 *  anonymous shape so the two fields travel as one decision — a caller cannot
 *  take the reason and re-source the text from somewhere else. */
export interface RunEndClassification {
  readonly reason: RunEndReason;
  /** The failure text, present only on an arm that HAS one. */
  readonly error?: string;
}

/**
 * Name a finished run from what the driver observed.
 *
 * Backends pass FACTS, never a chosen string — that is the whole point. The
 * precedence is `interrupted` first: a cut turn is `'aborted'` even though it
 * also threw, because a user who stopped the work did not cause a failure, and
 * a ledger that records their Stop as an error makes the agent look broken
 * every time somebody changes their mind.
 *
 * The interruption's own text is DROPPED on that arm. It is not evidence being
 * discarded: the two arms are mutually exclusive at the throw site — a driver
 * throws either the interruption or the provider's failure, and whichever it
 * threw is what sets `interrupted` — so on this arm `errorText` can only ever be
 * the interruption sentence restating the flag beside it. A run sealed
 * `'aborted'` that still carries a failure sentence is the same drift wearing a
 * new label.
 *
 * The completed arm additionally CHECKS its own impossibility — see
 * {@link TURN_ENDED_MID_WORK}. The reason it reports is unchanged: this function
 * names what the driver saw, and a defect in the loop is not a status for a user.
 */
export function classifyRunEnd(facts: RunEndFacts): RunEndClassification {
  if (facts.interrupted) return { reason: 'aborted' };
  if (facts.errorText) return { reason: 'error', error: facts.errorText };
  // Neither finished nor threw anything nameable: still a failure, and saying
  // so without inventing a cause is the honest row.
  if (!facts.completed) return { reason: 'error' };
  if (facts.lastFinishReason === TOOL_CALLS_PENDING) {
    diagnostics.failure(TURN_ENDED_MID_WORK, toKinuError({
      doing: 'seal a turn that reported a clean end',
      cause: new Error(
        'the turn\'s last step still had tool calls pending, so something stopped the loop '
        + 'mid-work while reporting that it finished. The only thing that could do that was a '
        + 'step ceiling the caller cannot widen; if this fired, a bound is back.',
      ),
      otherwise: 'unavailable',
    }));
  }
  return { reason: 'completed' };
}

/** Open the turn's run in the durable event log: run_start (provenance) then
 *  turn_start (session turn index). Never throws — losing a history row must
 *  not fail a turn. */
export function openTurnRun(recorder: TurnRunRecorder, runId: string, opts: {
  agentId: string;
  /** What kicked off this run: 'chat' for a real user turn, the kinuEvent
   *  name for a programmatic one. */
  causedBy: string;
  userMessage: string;
  turnIndex: number;
}): void {
  try {
    recorder.emit(runId, {
      type: 'run_start',
      agentId: opts.agentId,
      caused_by: opts.causedBy,
      userMessage: opts.userMessage.slice(0, 500),
    });
    recorder.emit(runId, { type: 'turn_start', turnIndex: opts.turnIndex });
  } catch (err) {
    diagnostics.failure(
      'turn.start_events_failed',
      toKinuError({ doing: 'emit the run/turn start events', cause: err, otherwise: 'io' }),
      { runId },
    );
  }
}

/** Seal the run: the turn's context-budget ledger (when it moved), what its
 *  file edits did, its mechanical steer, its completion gate and its in-episode
 *  craft record (when each fired), then turn_end (index + token usage), then
 *  run_end (status + the failure text — the durable evidence trail, since the
 *  platform layers keep only the LAST terminal error). Never throws. */
export function closeTurnRun(recorder: TurnRunRecorder, runId: string, opts: {
  turnIndex: number;
  /** What the turn spent, as the provider reported it (acc.reportedUsage()).
   *  Absent when no step reported anything — then `turn_end` carries no usage
   *  rather than a row of zeros nothing measured. */
  usage?: Usage | undefined;
  /** The turn's resolved work mode. Present on every completed turn_end a
   *  current backend writes — the durable GEPA-cadence field; absent rather
   *  than invented when a caller does not supply one. */
  workMode?: WorkMode | undefined;
  /** From {@link classifyRunEnd}, never hand-picked — a bare string here is
   *  what let one backend seal a user Stop as `'error'`. */
  reason: RunEndReason;
  error?: string | undefined;
  /** The turn's bulk-ingestion budget (acc.context). A turn that neither
   *  admitted nor spilled bulk writes no row — `turn_end` is the denominator. */
  context?: TurnContextBudget | undefined;
  /** The turn's file ledger (acc.files). A turn that attempted no edit writes
   *  no row — `turn_end` is the denominator here too. */
  files?: TurnFileLedger | undefined;
  /** The turn's mechanical steers (orch.steering.snapshot()) — one row each,
   *  empty on a turn that was never steered, `turn_end` being the denominator
   *  here too. */
  steering?: readonly TurnSteeringRecord[] | undefined;
  /** The turn's delegation opportunities (orch.steering.delegationSnapshot())
   *  — the hint arm when a hint was delivered, the unprompted arm when the
   *  model delegated with no hint. Each arm's denominator is its own; see the
   *  row type for why they are not folded into `turn_steering`. */
  delegation?: readonly DelegationOpportunityRecord[] | undefined;
  /** The one-shot completion gate's verdict (gate.take()), or null on every
   *  run that is not the confirming turn — one row per gated run. */
  completionGate?: CompletionGateRecord | null | undefined;
  /** The turn's in-episode craft loop (orch.craft.snapshot()), or null when the
   *  turn neither crafted nor called a crafted tool — no row, `turn_end` being
   *  the denominator here too. */
  craft?: CraftCycleRecord | null | undefined;
  /** The turn's execution recoveries (orch.recoverySnapshot()), or null when
   *  no failure streak broke — no row, `turn_end` being the denominator here
   *  too. */
  recoveries?: ExecutionRecoveryRecord | null | undefined;
  /** The turn's escalations (acc.escalations). A turn that never left its own
   *  shell writes no row — `turn_end` is the denominator here too. */
  escalations?: TurnEscalationLedger | undefined;
}): void {
  try {
    if (opts.context?.active) {
      recorder.emit(runId, { type: 'context_budget', ...opts.context.snapshot() });
    }
    if (opts.files?.active) {
      recorder.emit(runId, { type: 'file_edit', ...opts.files.snapshot() });
    }
    for (const steer of opts.steering ?? []) recorder.emit(runId, { type: 'turn_steering', ...steer });
    // The delegation opportunities ride the same settle spine, AFTER the
    // steering rows: a hint row and its opportunity describe one delivery, and
    // reading them in delivery order keeps that pairing visible in the raw log.
    for (const delegation of opts.delegation ?? []) {
      recorder.emit(runId, { type: 'delegation_opportunity', ...delegation });
    }
    if (opts.completionGate) recorder.emit(runId, { type: 'completion_gate', ...opts.completionGate });
    if (opts.craft) recorder.emit(runId, { type: 'craft_cycle', ...opts.craft });
    if (opts.recoveries) recorder.emit(runId, { type: 'execution_recovery', ...opts.recoveries });
    if (opts.escalations?.active) {
      recorder.emit(runId, { type: 'execution_escalation', ...opts.escalations.snapshot() });
    }
    const turnEnd: Extract<RunEventInput, { type: 'turn_end' }> = {
      type: 'turn_end',
      turnIndex: opts.turnIndex,
    };
    if (opts.workMode) turnEnd.workMode = opts.workMode;
    if (opts.usage !== undefined && usageReported(opts.usage)) turnEnd.usage = opts.usage;
    recorder.emit(runId, turnEnd);
    const runEnd: Extract<RunEventInput, { type: 'run_end' }> = {
      type: 'run_end',
      reason: opts.reason,
    };
    if (opts.error) runEnd.error = opts.error;
    recorder.emit(runId, runEnd);
  } catch (err) {
    diagnostics.failure(
      'turn.end_events_failed',
      toKinuError({ doing: 'emit the turn/run end events', cause: err, otherwise: 'io' }),
      { runId },
    );
  }
}

/** The CompletedTurn the evolution loop grades, from the shared accumulator.
 *  `durationMs` is measured from the accumulator's own turn start so both
 *  backends report the same clock. */
export function snapshotCompletedTurn(acc: TurnAccumulator, opts: {
  userMessage: string;
  assistantResponse: string;
  turnId?: string | undefined;
  sessionId: string;
  origin: 'user' | 'programmatic';
}): CompletedTurn {
  const usage = acc.reportedUsage();
  const completed: CompletedTurn = {
    userMessage: opts.userMessage,
    assistantResponse: opts.assistantResponse,
    toolCalls: acc.toolCalls,
    craftedToolsUsed: acc.craftedToolsUsed(),
    steps: acc.stepCount,
    durationMs: acc.startedAt > 0 ? Date.now() - acc.startedAt : 0,
    feedback: null,
    hadError: acc.hadError,
    sessionId: opts.sessionId,
    origin: opts.origin,
  };
  if (opts.turnId !== undefined) completed.turnId = opts.turnId;
  if (usage !== undefined) completed.usage = usage;
  return completed;
}

/** The compaction-state slice this module needs — structural, because the
 *  concrete store lives in @kinu.run/compaction, which depends on core. */
export interface CompactionTriggerState {
  savePromptTokens(sessionKey: string, tokens: number, historyLength: number): void;
  armForceCompaction(sessionKey: string): void;
}

/** Persist the turn's final provider-priced prompt size — the NEXT turn's
 *  measured compaction trigger. Recorded even on aborted/errored turns (any
 *  step that reported was a real priced request), bound to the turn's durable
 *  history length so a later shrink voids it.
 *
 *  `undefined` means no step of the turn reported a prompt size, which is the
 *  only case that writes nothing: a provider-reported 0 IS a measurement (an
 *  empty request is a real request) and would overwrite a stale trigger, so it
 *  is persisted like any other number. */
export function persistMeasuredPromptTokens(
  state: CompactionTriggerState,
  sessionKey: string,
  lastPromptTokens: number | undefined,
  durableLength: number,
): void {
  if (lastPromptTokens !== undefined) state.savePromptTokens(sessionKey, lastPromptTokens, durableLength);
}

/**
 * The shared turn-failure policy, applied: a context_length-class provider
 * failure arms force-compaction for the next assembly and delivers ONE retry
 * signal — a failed retry never delivers another. Rate limits never
 * force-compact (throughput is not size) unless the measured PER-REQUEST
 * prompt crossed half the window. Returns the plan for the caller's logging.
 */
export function applyOverflowRecovery(opts: {
  error: string;
  /** The turn's last provider-reported prompt size, or undefined when no step
   *  reported one — the size heuristic then simply does not apply. */
  lastPromptTokens: number | undefined;
  contextWindow: number;
  turnWasOverflowRetry: boolean;
  state: CompactionTriggerState;
  sessionKey: string;
  signals: SignalDeliverer;
}): OverflowRecoveryDecision {
  const recovery = planOverflowRecovery({
    error: opts.error,
    lastPromptTokens: opts.lastPromptTokens,
    contextWindow: opts.contextWindow,
    turnWasOverflowRetry: opts.turnWasOverflowRetry,
  });
  if (recovery.forceCompaction) {
    opts.state.armForceCompaction(opts.sessionKey);
    if (recovery.enqueueRetry) {
      void opts.signals.deliver({
        kind: OVERFLOW_RETRY_EVENT,
        text: OVERFLOW_RETRY_TEXT,
      }).catch((error: unknown) => diagnostics.failure(
        'turn.overflow_retry_enqueue_failed',
        toKinuError({ doing: 'enqueue the context-overflow retry turn', cause: error, otherwise: 'io' }),
        { sessionKey: opts.sessionKey },
      ));
    }
  }
  return recovery;
}

/** A settled turn, as the credit decision below reads it. */
export interface SettledTurn {
  /** The durable assistant message id this turn produced, or null when it
   *  produced none (no id to attribute anything to). */
  messageId: string | null;
  /** Whether the turn reached its own end. A terminal failure — a dead provider
   *  stream, an abort — is not an answer, whatever partial text preceded it. */
  completed: boolean;
  /** The turn's work mode. A plan turn answers with a plan. */
  workMode: WorkMode;
}

/**
 * The id the work captured mid-turn may be credited to, or null.
 *
 * Alternate takes (a think-mcts fan-out) and steer branches are both captured
 * while the turn is still running, BEFORE its assistant message exists, and
 * both are attributed to that message when the turn settles — a claimed take
 * enters the preference ledger, an unclaimed one is dropped. Whether they may
 * be attributed is therefore ONE question with one answer, and it was asked
 * twice with two:
 *
 *   cf   (orchestrator.onChatResponse) `result.status === 'completed'` and a
 *        message id — so a completed PLAN turn credited its captures.
 *   CLI  (local-session.runTurn) a message id, not plan mode, and
 *        `!acc.hadError` — so any turn in which a single tool call came back a
 *        failure dropped its captures, though the turn finished and answered.
 *
 * The surviving policy is the intersection of what each side was reaching for:
 * an id exists, the turn ended rather than failed, and the answer is an answer
 * rather than a plan. `hadError` deliberately does NOT appear: the accumulator
 * raises it from the transport discriminator on any failed tool result, and
 * evolution/outcomes.ts already records by name that "`hadError` alone is not
 * the question, and reading only it is what made this a fake reward". A turn
 * that ran the suite, saw it red, fixed it and answered has an answer for its
 * captures to have competed against.
 */
export function creditedTurnId(turn: SettledTurn): string | null {
  if (!turn.completed || turn.workMode === 'plan') return null;
  return turn.messageId;
}
