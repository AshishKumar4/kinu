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

/** The recorder slice this spine writes through — structural (both backends
 *  pass their RunEventRecorder). */
export interface TurnRunRecorder {
  emit(runId: string, input: RunEventInput): void;
}

/**
 * How a run ended, as the durable ledger names it.
 *
 * It is a TYPE because it was a bare string: one backend sealed a user Stop as
 * `'aborted'` and the other sealed the identical action as `'error'`, and every
 * cross-backend reader of the run ledger — Supervise, eval triage — counted
 * local stops as failures. Nothing mechanical held the two spellings together.
 *
 * FOUR VALUES SINCE THE STATE WAS OBSERVED IN PRODUCTION. This reverses the
 * "deliberately still three" decision recorded here and in
 * {@link TURN_ENDED_MID_WORK}, which argued a turn cut mid-work was unreachable
 * once the cloud loop's step ceiling was gone, so a fourth word would be
 * vocabulary no run could carry. The premise was wrong: the owner reported a
 * session that stopped mid-work with the transcript ending on a tool call
 * (issue #16) and the UI showing an ordinary completed turn, because
 * `'completed'` is what the ledger said. A turn that stopped with work still
 * pending did NOT reach an end of its own, and sealing it under the same word
 * as a turn that answered is the loop reporting something it did not observe.
 * The tripwire stays — it is still a defect in the loop — and it is now beside
 * an honest status instead of standing in for one.
 */
export const RUN_END_REASONS = ['completed', 'aborted', 'error', 'incomplete'] as const;

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
 * simply longer than one response. Exactly one continuation answers it, and a
 * SECOND `length` is honest partial completion: the turn keeps what it produced
 * and says how it ended.
 *
 * WHERE that continuation happens is the one thing the two loops cannot share.
 * `runChat` owns its own provider calls, so it continues INSIDE the turn
 * (chat.ts): same meter, same text, same `done`. The cloud loop is Think's, and
 * its agentic loop re-issues a request only while a step ended with tool calls
 * whose outputs all landed — a `length` finish ends it, and no hook can extend
 * it. So there the continuation is the next TURN, armed by
 * {@link owesOutputLimitContinuation} through the same durable signal ledger
 * every other owed follow-up rides.
 */
export const OUTPUT_LIMIT_REACHED = 'length';

/**
 * The finish reason a step reports when the provider named NO end at all.
 *
 * The AI SDK's own word once more, and specifically its FALLBACK: every mapper
 * in the families this tree calls — `@ai-sdk/openai`, `@ai-sdk/openai-compatible`,
 * `@ai-sdk/anthropic` — returns this string for a `finish_reason` that never
 * arrived, and `ai` folds its own `'unknown'` onto it. So a step that says this
 * is a step whose stream ENDED without the producer saying why.
 *
 * That is a definitive failure wearing a clean end's clothes, and it is the one
 * the framing layer cannot catch. `providers/sse-terminal.ts` ends a stream at
 * `data: [DONE]` and closes cleanly when the body ends without one, because the
 * terminator is not universal among the gateways that speak the dialect —
 * absence of the marker is not evidence of a broken pipe at the byte layer.
 * One layer up it is: the SDK parsed every frame the producer sent and none of
 * them named an end, so the answer the user is about to read is whatever had
 * arrived when the socket died.
 *
 * The MIRROR of {@link TOOL_CALLS_PENDING}, and it earns a ledger word where
 * that one earns a tripwire, because the two states differ in what produced
 * them. Tool calls pending could only come from a step ceiling inside our own
 * loop — a defect, not a status. An unnamed end comes from the network, which
 * is neither reachable nor removable from here, so a run CAN carry it and the
 * honest word for a turn whose answer was cut by a dead socket is `error` with
 * the reason written out.
 *
 * One stop reason maps here legitimately: Anthropic's `compaction`, from the
 * vendor's own context-management feature. No request this tree sends asks for
 * it (compaction here is `packages/compaction`, over our own history), so it
 * cannot arrive; if it ever can, the SDK giving it a word of its own is the
 * repair, not a predicate here that guesses which kind of `other` it saw.
 */
export const PROVIDER_NAMED_NO_END = 'other';

/** What the ledger says when a run ended on {@link PROVIDER_NAMED_NO_END}. The
 *  text a person reads in the run history, so it says what happened to the
 *  answer rather than naming a finish reason. */
export const STREAM_ENDED_UNNAMED =
  'The model stream ended without naming a finish reason: the connection stopped producing '
  + 'before the model said it was done, so the answer recorded for this turn is what had '
  + 'arrived by then rather than the whole of it.';

/** The `kinuEvent` name stamped on the ONE continuation turn a truncated cloud
 *  answer earns — the marker that stops the continuation from earning another,
 *  the same way {@link OVERFLOW_RETRY_EVENT} bounds the retry it names. */
export const OUTPUT_CONTINUATION_EVENT = 'output_continuation';

/** The continuation turn's text. It names the fact (the answer was cut by the
 *  provider, not by the model choosing to stop) and refuses the two wrong
 *  readings of it: starting over, and re-running work whose results are already
 *  in the history it is reading. */
export const OUTPUT_CONTINUATION_TEXT =
  'The previous answer stopped at the model output limit before it was finished. '
  + 'Continue it from exactly where it stopped — do not restart it, repeat what it already '
  + 'said, or re-run tool calls whose results are already above.';

/** What a settled turn knows about whether it was cut at the output limit. */
export interface OutputContinuationFacts {
  /** The turn reached its own end. A cut turn was stopped by its owner and a
   *  failed one has its own recovery; neither is an answer waiting to be
   *  finished. */
  readonly completed: boolean;
  /** The `finishReason` of the turn's LAST step (`acc.lastFinishReason`). */
  readonly lastFinishReason: string | undefined;
  /** Whether THIS turn already WAS the continuation — it was driven by the
   *  continuation signal, or absorbed it at a step boundary. Either way its one
   *  continuation is spent, and a second `length` is partial completion. */
  readonly turnWasContinuation: boolean;
}

/** Whether a settled turn owes exactly one output-limit continuation. */
export function owesOutputLimitContinuation(facts: OutputContinuationFacts): boolean {
  return facts.completed
    && facts.lastFinishReason === OUTPUT_LIMIT_REACHED
    && !facts.turnWasContinuation;
}

/**
 * THE INVARIANT: a turn that reached its own end never has tool calls pending.
 *
 * The state was real and it shipped: `@cloudflare/think` OR-s
 * `stepCountIs(this.maxSteps)` — default 10 — ahead of anything a caller passes,
 * so four of four production turns that reached ten steps were cut with the model
 * still emitting tool calls, and all four sealed `'completed'`. The fix recorded
 * here was a tripwire and NO ledger word, on the argument that the ceiling was
 * the only producer and removing it removed the state.
 *
 * THAT ARGUMENT IS RETIRED, by the owner's report on issue #16: a session
 * stopped mid-work, its transcript ending on a tool call, and every surface
 * read it as a turn that answered because `'completed'` is what the ledger
 * carried. Whatever ends a loop mid-work — a vendor release re-introducing a
 * cap, an actor that starts asking for structured output, a client-side tool, a
 * relay the loop waited on — the turn did not reach an end of its own, and the
 * ledger must not say it did. So the classification is `'incomplete'`, which is
 * a status a reader can act on, and this stays as the DEFECT report beside it:
 * whatever produced the state is still broken, and the `failure` severity is
 * what says so.
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
 * {@link TURN_ENDED_MID_WORK}. A turn whose last step still had tool calls
 * pending is `'incomplete'`: it stopped with work outstanding, so it never
 * reached an end of its own, and the defect that stopped it is reported beside
 * the status rather than instead of it.
 *
 * It also refuses the one clean end that was never the model's own — see
 * {@link PROVIDER_NAMED_NO_END}. That one DOES change the reason, because the
 * driver's observation is the thing being corrected: it saw a loop that ran out
 * of work and called it finished, and the reason the loop ran out of work is
 * that the stream feeding it stopped.
 */
export function classifyRunEnd(facts: RunEndFacts): RunEndClassification {
  if (facts.interrupted) return { reason: 'aborted' };

  if (facts.errorText) return { reason: 'error', error: facts.errorText };

  // Neither finished nor threw anything nameable: still a failure, and saying
  // so without inventing a cause is the honest row.
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
  /** The turn this run was opened for, so a later process can re-open the
   *  same turn where this one stopped. Present on runs the turn loop opens. */
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
 * Apply the synchronous half of the shared turn-failure policy. Retry delivery
 * is a durable terminal effect declared by each backend after this returns, so
 * no provider/network await can sit between a persisted answer and its claim.
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
  if (!turn.completed || turn.workMode === 'plan' || turn.messageId === '') return null;

  return turn.messageId;
}
