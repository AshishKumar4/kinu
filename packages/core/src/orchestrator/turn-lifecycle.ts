/** Turn settle spine both backends share: run-event bracket, graded snapshot, compaction trigger, overflow recovery, credit. */

import type { TurnContextBudget } from '../context-budget';
import type { TurnFileLedger } from '../vfs/file-ledger';
import type {
  CompletionGateRecord, CraftCycleRecord, ExecutionRecoveryRecord,
  OpenTurnIdentity, RunEventInput, TurnSteeringRecord,
} from '../events/types';
import type { TurnEscalationLedger } from '../execution/escalation';
import type { CompletedTurn } from '../evolution/types';
import type { WorkMode } from '../types/turn';
import { usageReported, type Usage } from '../usage';
import type { TurnAccumulator } from './turn-accumulator';
import {
  planOverflowRecovery,
  type OverflowRecoveryDecision,
} from '../turn-failure';
import { diagnostics, toKinuError } from '../obs/index';

/** Structural; both backends pass their RunEventRecorder. */
export interface TurnRunRecorder {
  emit(runId: string, input: RunEventInput): void;
}

/**
 * How a run ended, as the durable ledger names it. `'incomplete'` marks a turn that stopped with
 * tool calls pending (issue #16); it never seals as `'completed'`.
 */
export const RUN_END_REASONS = ['completed', 'aborted', 'error', 'incomplete'] as const;

export type RunEndReason = (typeof RUN_END_REASONS)[number];

/** AI SDK `FinishReason` for a step that emitted tool calls: a last step saying this means the turn was cut mid-work. */
export const TOOL_CALLS_PENDING = 'tool-calls';

/**
 * AI SDK `FinishReason` for a provider output-limit cut; read from the mapped reason, never a provider payload.
 * Earns exactly one continuation; `runChat` continues inside the turn, the cloud loop via the next turn
 * ({@link owesOutputLimitContinuation}).
 */
export const OUTPUT_LIMIT_REACHED = 'length';

/**
 * AI SDK fallback `FinishReason`: the stream ended without the provider naming an end.
 * The framing layer cannot detect this, so it is classified here as `error`.
 */
const PROVIDER_NAMED_NO_END = 'other';

/** Ledger text for a run that ended on {@link PROVIDER_NAMED_NO_END}. */
const STREAM_ENDED_UNNAMED =
  'The model stream ended without naming a finish reason: the connection stopped producing '
  + 'before the model said it was done, so the answer recorded for this turn is what had '
  + 'arrived by then rather than the whole of it.';

/** Marks the one continuation turn a truncated cloud answer earns, so it earns no second one. */
export const OUTPUT_CONTINUATION_EVENT = 'output_continuation';

/** Continuation text: resume where cut, no restart, no re-running tool calls. */
export const OUTPUT_CONTINUATION_TEXT =
  'The previous answer stopped at the model output limit before it was finished. '
  + 'Continue it from exactly where it stopped — do not restart it, repeat what it already '
  + 'said, or re-run tool calls whose results are already above.';

/** What a settled turn knows about whether it was cut at the output limit. */
export interface OutputContinuationFacts {
  /** A cut or failed turn is not an answer waiting to be finished. */
  readonly completed: boolean;
  /** The `finishReason` of the turn's LAST step (`acc.lastFinishReason`). */
  readonly lastFinishReason: string | undefined;
  /** This turn already was the continuation; a second `length` is partial completion. */
  readonly turnWasContinuation: boolean;
}

/** Whether a settled turn owes exactly one output-limit continuation. */
export function owesOutputLimitContinuation(facts: OutputContinuationFacts): boolean {
  return facts.completed
    && facts.lastFinishReason === OUTPUT_LIMIT_REACHED
    && !facts.turnWasContinuation;
}

/**
 * Invariant: a turn that reached its own end never has tool calls pending. The run seals
 * `'incomplete'` and this reports the defect that stopped the loop (issue #16).
 */
export const TURN_ENDED_MID_WORK = 'turn.ended_mid_work';

/** What the driver knows when a turn stops, before anyone has named it. */
export interface RunEndFacts {
  readonly completed: boolean;
  /** User Stop or host cancel (CLI: `INTERRUPTED_TURN` identity; CF: status `'aborted'`). */
  readonly interrupted: boolean;
  /** Failure text when the turn threw something other than an interruption. */
  readonly errorText?: string | undefined;
  /** Last step's `finishReason`, if any; lets {@link TURN_ENDED_MID_WORK} detect a pending-tool clean end. */
  readonly lastFinishReason?: string | undefined;
}

/** Reason and text travel as one decision; callers cannot re-source the text. */
export interface RunEndClassification {
  readonly reason: RunEndReason;
  /** Present only on an arm that has one. */
  readonly error?: string;
}

/**
 * Name a finished run from observed facts, never a chosen string. `interrupted` wins (a Stop is not a failure)
 * and drops its text; a clean end on {@link TOOL_CALLS_PENDING} is `'incomplete'`, on
 * {@link PROVIDER_NAMED_NO_END} is `'error'`.
 */
export function classifyRunEnd(facts: RunEndFacts): RunEndClassification {
  if (facts.interrupted) return { reason: 'aborted' };

  if (facts.errorText) return { reason: 'error', error: facts.errorText };

  // Neither finished nor threw anything nameable.
  if (!facts.completed) return { reason: 'error' };

  if (facts.lastFinishReason === PROVIDER_NAMED_NO_END) {
    return { reason: 'error', error: STREAM_ENDED_UNNAMED };
  }

  if (facts.lastFinishReason === TOOL_CALLS_PENDING) {
    diagnostics.failure(TURN_ENDED_MID_WORK, toKinuError({
      doing: 'seal a turn that reported a clean end',
      cause: new Error(
        'the turn\'s last step still had tool calls pending, so something stopped the loop '
        + 'mid-work while reporting that it finished. The turn is sealed incomplete; what '
        + 'stopped the loop is the defect — a step ceiling, a stop condition, a relay it waited on.',
      ),
      otherwise: 'unavailable',
    }));

    return { reason: 'incomplete' };
  }

  return { reason: 'completed' };
}

/** Emit run_start then turn_start. Never throws: losing a history row must not fail a turn. */
export function openTurnRun(recorder: TurnRunRecorder, runId: string, opts: {
  agentId: string;
  /** 'chat' for a user turn, else the kinuEvent name. */
  causedBy: string;
  userMessage: string;
  turnIndex: number;
  /** Lets a later process re-open the same turn where this one stopped. */
  turn?: OpenTurnIdentity;
}): void {
  try {
    recorder.emit(runId, {
      type: 'run_start',
      agentId: opts.agentId,
      caused_by: opts.causedBy,
      userMessage: opts.userMessage.slice(0, 500),
      ...(opts.turn !== undefined && { turn: opts.turn }),
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

/** Seal the run: per-turn ledgers, then turn_end, then run_end with the failure text. Never throws. */
export function closeTurnRun(recorder: TurnRunRecorder, runId: string, opts: {
  turnIndex: number;
  /** Absent when no step reported usage, so `turn_end` carries no zeros. */
  usage?: Usage | undefined;
  /** Durable GEPA-cadence field; absent rather than invented. */
  workMode?: WorkMode | undefined;
  /** From {@link classifyRunEnd}, never hand-picked. */
  reason: RunEndReason;
  error?: string | undefined;
  /** Each ledger below writes no row when inactive; `turn_end` is the denominator. */
  context?: TurnContextBudget | undefined;
  files?: TurnFileLedger | undefined;
  steering?: readonly TurnSteeringRecord[] | undefined;
  /** One row per gated run; null otherwise. */
  completionGate?: CompletionGateRecord | null | undefined;
  craft?: CraftCycleRecord | null | undefined;
  recoveries?: ExecutionRecoveryRecord | null | undefined;
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

/** `durationMs` uses the accumulator's own start so both backends report the same clock. */
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

/** Structural: the concrete store lives in @kinu.run/compaction, which depends on core. */
export interface CompactionTriggerState {
  savePromptTokens(sessionKey: string, tokens: number, historyLength: number): void;
  armForceCompaction(sessionKey: string): void;
}

/**
 * Persist the final priced prompt size as the next turn's compaction trigger, even on failed turns,
 * bound to durable history length. A reported 0 is a measurement and is persisted; only `undefined` skips.
 */
export function persistMeasuredPromptTokens(
  state: CompactionTriggerState,
  sessionKey: string,
  lastPromptTokens: number | undefined,
  durableLength: number,
): void {
  if (lastPromptTokens !== undefined) state.savePromptTokens(sessionKey, lastPromptTokens, durableLength);
}

/**
 * Apply the synchronous half of the shared turn-failure policy. Retry delivery
 * is a durable terminal effect declared by each backend after this returns, so
 * no provider/network await can sit between a persisted answer and its claim.
 */
export function applyOverflowRecovery(opts: {
  error: string;
  /** Undefined when no step reported one; the size heuristic then does not apply. */
  lastPromptTokens: number | undefined;
  contextWindow: number;
  turnWasOverflowRetry: boolean;
  state: CompactionTriggerState;
  sessionKey: string;
}): OverflowRecoveryDecision {
  const recovery = planOverflowRecovery({
    error: opts.error,
    lastPromptTokens: opts.lastPromptTokens,
    contextWindow: opts.contextWindow,
    turnWasOverflowRetry: opts.turnWasOverflowRetry,
  });

  if (recovery.forceCompaction) opts.state.armForceCompaction(opts.sessionKey);

  return recovery;
}

/** A settled turn, as the credit decision below reads it. */
export interface SettledTurn {
  messageId: string | null;
  /** A terminal failure is not an answer, whatever partial text preceded it. */
  completed: boolean;
  workMode: WorkMode;
}

/**
 * The id mid-turn captures (alternate takes, steer branches) may be credited to, or null:
 * an id exists, the turn ended rather than failed, and it is not a plan. `hadError` is deliberately ignored.
 */
export function creditedTurnId(turn: SettledTurn): string | null {
  if (!turn.completed || turn.workMode === 'plan' || turn.messageId === '') return null;

  return turn.messageId;
}
