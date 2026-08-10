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
 *
 * Each existed twice — cf beforeTurn/recordTurnTelemetry and the CLI
 * processTurn/closeRun — with the payload shapes drifting one field at a time.
 */

import type { TurnContextBudget } from '../context-budget.js';
import type { CompletionGateRecord, RunEventInput, TurnSteeringRecord } from '../events/types.js';
import type { CompletedTurn, TurnUsage } from '../evolution/types.js';
import type { TurnAccumulator } from './turn-accumulator.js';
import {
  planOverflowRecovery, OVERFLOW_RETRY_EVENT, OVERFLOW_RETRY_TEXT,
  type OverflowRecoveryDecision,
} from '../turn-failure.js';
import type { SignalDeliverer } from '../types/signals.js';

/** The recorder slice this spine writes through — structural (both backends
 *  pass their RunEventRecorder). */
export interface TurnRunRecorder {
  emit(runId: string, input: RunEventInput): unknown;
}

/** Open the turn's run in the durable event log: run_start (provenance) then
 *  turn_start (session turn index). Never throws — losing a history row must
 *  not fail a turn. */
export function openTurnRun(recorder: TurnRunRecorder, runId: string, opts: {
  agentId: string;
  /** What kicked off this run: 'chat' for a real user turn, the proteusEvent
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
    console.warn('[proteus] event emit failed at turn start:', err);
  }
}

/** Seal the run: the turn's context-budget ledger (when it moved), its
 *  mechanical steer and its completion gate (when either fired), then turn_end (index + token usage),
 *  then run_end (status + the failure text — the durable evidence trail, since
 *  the platform layers keep only the LAST terminal error). Never throws. */
export function closeTurnRun(recorder: TurnRunRecorder, runId: string, opts: {
  turnIndex: number;
  usage: TurnUsage;
  reason: string;
  error?: string | undefined;
  /** The turn's bulk-ingestion budget (acc.context). A turn that neither
   *  admitted nor spilled bulk writes no row — `turn_end` is the denominator. */
  context?: TurnContextBudget | undefined;
  /** The turn's mechanical steering (orch.steering.snapshot()), or null when
   *  the turn was never steered — no row, `turn_end` being the denominator
   *  here too. */
  steering?: TurnSteeringRecord | null | undefined;
  /** The one-shot completion gate's verdict (gate.take()), or null on every
   *  run that is not the confirming turn — one row per gated run. */
  completionGate?: CompletionGateRecord | null | undefined;
}): void {
  try {
    if (opts.context?.active) {
      recorder.emit(runId, { type: 'context_budget', ...opts.context.snapshot() });
    }
    if (opts.steering) recorder.emit(runId, { type: 'turn_steering', ...opts.steering });
    if (opts.completionGate) recorder.emit(runId, { type: 'completion_gate', ...opts.completionGate });
    recorder.emit(runId, {
      type: 'turn_end',
      turnIndex: opts.turnIndex,
      tokenUsage: { input: opts.usage.input, output: opts.usage.output, cached: opts.usage.cached },
    });
    recorder.emit(runId, {
      type: 'run_end',
      reason: opts.reason,
      ...(opts.error ? { error: opts.error } : {}),
    });
  } catch (err) {
    console.warn('[proteus] event emit failed at turn end:', err);
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
  return {
    userMessage: opts.userMessage,
    assistantResponse: opts.assistantResponse,
    toolCalls: acc.toolCalls,
    steps: acc.stepCount,
    durationMs: acc.startedAt > 0 ? Date.now() - acc.startedAt : 0,
    feedback: null,
    hadError: acc.hadError,
    ...(opts.turnId ? { turnId: opts.turnId } : {}),
    sessionId: opts.sessionId,
    origin: opts.origin,
    ...(usage ? { usage } : {}),
  };
}

/** The compaction-state slice this module needs — structural, because the
 *  concrete store lives in @proteus/compaction, which depends on core. */
export interface CompactionTriggerState {
  savePromptTokens(sessionKey: string, tokens: number, historyLength: number): void;
  armForceCompaction(sessionKey: string): void;
}

/** Persist the turn's final provider-priced prompt size — the NEXT turn's
 *  measured compaction trigger. Recorded even on aborted/errored turns (any
 *  step that reported was a real priced request), bound to the turn's durable
 *  history length so a later shrink voids it. No-op when nothing reported. */
export function persistMeasuredPromptTokens(
  state: CompactionTriggerState,
  sessionKey: string,
  lastPromptTokens: number,
  durableLength: number,
): void {
  if (lastPromptTokens > 0) state.savePromptTokens(sessionKey, lastPromptTokens, durableLength);
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
  lastPromptTokens: number;
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
      }).catch((err: unknown) => console.warn('[proteus] overflow retry enqueue failed:', err));
    }
  }
  return recovery;
}
