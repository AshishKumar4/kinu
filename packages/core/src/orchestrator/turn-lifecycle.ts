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
  CompletionGateRecord, CraftCycleRecord, ExecutionRecoveryRecord, RunEventInput, TurnSteeringRecord,
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
import { diagnostics, toProteusError } from '../obs/index';

/** The recorder slice this spine writes through — structural (both backends
 *  pass their RunEventRecorder). */
export interface TurnRunRecorder {
  emit(runId: string, input: RunEventInput): void;
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
    diagnostics.failure(
      'turn.start_events_failed',
      toProteusError({ doing: 'emit the run/turn start events', cause: err, otherwise: 'io' }),
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
  reason: string;
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
      toProteusError({ doing: 'emit the turn/run end events', cause: err, otherwise: 'io' }),
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
 *  concrete store lives in @proteus/compaction, which depends on core. */
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
      }).catch((error) => diagnostics.failure(
        'turn.overflow_retry_enqueue_failed',
        toProteusError({ doing: 'enqueue the context-overflow retry turn', cause: error, otherwise: 'io' }),
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
