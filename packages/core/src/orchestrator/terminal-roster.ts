/**
 * What a settled response owes, in order: the one roster for every backend, so the same questions get
 * the same answers. Callers supply values, never decisions; an effect a backend lacks is an absent part.
 */
import type { JsonValue } from '../utils/json';
import type { WorkMode } from '../types/turn';
import type { RunEndReason } from './turn-lifecycle';
import type { TurnContinuity } from './agent-orchestrator';
import type { OwedEffect } from './terminal-effects';
import type { SubordinateReportStatus } from '../events/hub/types';
import { isPlaceholderMission } from '../identity/soul';

/** `completed` is the driver's verdict; rows keyed to the answer gate on the narrower `durablyAnswered`. */
export interface TerminalTurnFacts {
  /** Empty when the row was never written: no effect may key on it. */
  readonly messageId: string;
  readonly status: RunEndReason;
  readonly workMode: WorkMode;
  readonly continuity: TurnContinuity;
  /** The driver's own verdict, not the stream's. */
  readonly completed: boolean;
  readonly userText: string;
  readonly assistantText: string;
  /** Already scoped by the caller: governor scope is live state a replay does not have. */
  readonly scopedTurn: JsonValue;
  /** A replay stamped with the recovery clock would misorder turns. */
  readonly recordedAt: number;
  /** Recorded so the recording body never reads the ambient gate (`--no-auto-evolve`). */
  readonly evolutionEnabled: boolean;
}

export interface TerminalTurnParts {
  /** `credited` null: captures cannot be attributed and must be purged. */
  readonly takes?: {
    readonly credited: string | null;
    readonly startedAt: number;
    readonly takeIds: readonly string[];
  };
  readonly craftedToolsUsed?: readonly string[];
  /** Each with the request id its reply is dispatched under. */
  readonly eventReplies?: {
    readonly answered: ReadonlySet<string>;
    readonly requestId: string;
  };
  readonly branches?: readonly { readonly id: string; readonly task: string }[];
  /** Raw, not converted: the claim must exist before any await after a persisted answer. A backend that fired turn-end in the turn owes nothing here. */
  readonly turnEndExtensions?: boolean;
  /** Its armed state is RAM-only, so the row alone records the enqueue. */
  readonly completionGate?: { readonly text: string };
  /** Claimed because enqueueing is asynchronous and must survive a process cut. */
  readonly overflowRetry?: boolean;
  /** The one output-limit continuation (core `owesOutputLimitContinuation`), for a backend whose loop cannot continue in the turn; `runChat` passes nothing. */
  readonly outputContinuation?: boolean;
  /** Decided by the caller, the only one that reads the list and the outcome together. */
  readonly taskReminder?: { readonly text: string };
  readonly advisor?: JsonValue;
  readonly shadowTrial?: {
    readonly pendingVersion: number;
    /** Already bounded by the caller: an oversized recorded input fails its insert mid-sequence. */
    readonly trialContext: JsonValue;
  };
  /** The lane reads the transcript, so the row carries no input. */
  readonly sleepTime?: boolean;
  /** `standIn`: the shown title is a new workspace's, replaced by this turn's naming (identity/naming.ts). */
  readonly autoTitle?: { readonly mission: string | null; readonly standIn?: boolean };
  readonly autoGepa?: boolean;
  /** Presence is the caller's decision: a `task` child owes a terminal answer on every ending, a durable child only on completion. */
  readonly parentReport?: {
    readonly text: string;
    /** A task child's terminal answer and a durable child's progress note differ for the parent. */
    readonly status: SubordinateReportStatus;
    /** The parent's ingress dedupes on it. */
    readonly sequenceId: string;
  };
}

/** Order is load-bearing: turn-end, recording, drain; inline effects before detached ones. */
export function declareTerminalRoster(
  facts: TerminalTurnFacts, parts: TerminalTurnParts = {},
): OwedEffect[] {
  const { messageId, assistantText, completed } = facts;
  // One gate, "durable answer": the stream alone must not mark an unanswered event answered.
  const durablyAnswered = completed && messageId !== '';
  const owed: OwedEffect[] = [];

  if (parts.takes) {
    owed.push({
      name: 'takes', scope: messageId, lane: 'inline',
      input: {
        credited: parts.takes.credited,
        startedAt: parts.takes.startedAt,
        // Read here at declaration: a retry re-selecting would claim or purge a later turn's captures.
        takeIds: [...parts.takes.takeIds],
      },
    });
  }

  const craftNames = durablyAnswered ? parts.craftedToolsUsed ?? [] : [];

  if (craftNames.length > 0) {
    owed.push({
      name: 'craft_usage', scope: messageId, lane: 'inline',
      input: { messageId, toolNames: [...craftNames] },
    });
  }

  // One effect per delivery: each closes its own recovery lease.
  if (durablyAnswered && parts.eventReplies) {
    for (const answered of parts.eventReplies.answered) {
      owed.push({
        name: 'event_reply', scope: answered, lane: 'detached',
        input: {
          drainTurnId: answered, answer: assistantText,
          requestId: parts.eventReplies.requestId,
        },
      });
    }
  }

  // One row per branch, keyed on the branch id (the settlement key). An aborted turn aborts the branch.
  for (const branch of parts.branches ?? []) {
    owed.push({
      name: 'branches', scope: branch.id, lane: 'detached',
      input: {
        id: branch.id,
        task: branch.task,
        turnId: completed ? parts.takes?.credited ?? null : null,
        liveText: completed ? assistantText : '',
      },
    });
  }

  // Before the spine: the spine's extension emit may add to the answer.
  if (parts.completionGate) {
    owed.push({
      name: 'completion_gate', scope: messageId, lane: 'inline',
      input: { text: parts.completionGate.text },
    });
  }

  // Four separately claimed, replayed boundaries. No answer row, no extension announcement.
  if (parts.turnEndExtensions && messageId !== '') {
    owed.push({
      name: 'turn_end_extensions', scope: messageId, lane: 'inline',
      input: { messageId },
    });
  }

  if (parts.overflowRetry) {
    owed.push({
      name: 'overflow_retry', scope: messageId, lane: 'inline', input: {},
    });
  }

  // Mutually exclusive with the retry; `completed` decides which.
  if (parts.outputContinuation) {
    owed.push({
      name: 'output_continuation', scope: messageId, lane: 'inline', input: {},
    });
  }

  // Claimed inside the commit so a killed process re-drives delivery. No open tasks, no row.
  if (parts.taskReminder) {
    owed.push({
      name: 'task_reminder', scope: messageId, lane: 'inline',
      input: { text: parts.taskReminder.text },
    });
  }

  owed.push({
    name: 'turn_record', scope: messageId, lane: 'inline',
    input: {
      messageId,
      status: facts.status,
      turn: facts.scopedTurn,
      // Recorded, not re-read: a fresh actor defaults to `conversation` and build.
      continuity: facts.continuity,
      workMode: facts.workMode,
      recordedAt: facts.recordedAt,
      autoEvolve: facts.evolutionEnabled,
    },
  });
  owed.push({ name: 'event_drain', scope: messageId, lane: 'inline', input: {} });
  owed.push({
    name: 'improvement_lanes', scope: messageId, lane: 'inline',
    input: {
      status: facts.status,
      turn: facts.scopedTurn,
      workMode: facts.workMode,
      advisor: parts.advisor ?? null,
    },
  });

  if (parts.parentReport) {
    owed.push({
      name: 'parent_report', scope: messageId, lane: 'detached',
      input: {
        text: parts.parentReport.text,
        status: parts.parentReport.status,
        sequenceId: parts.parentReport.sequenceId,
        // The mode travels: a replay must not turn a Plan report into a Build one.
        mode: facts.workMode,
      },
    });
  }

  const naming = autoTitleEffect(facts, parts);

  // Below is completed-Build only, except a new workspace's naming, which is owed however its first turn ended.
  if (!completed || facts.workMode === 'plan') {
    if (naming?.standIn === true) owed.push(naming.effect);

    return owed;
  }

  owed.push(...completedBuildEffects(facts, parts, naming?.effect ?? null));

  return owed;
}

function completedBuildEffects(
  facts: TerminalTurnFacts, parts: TerminalTurnParts, naming: OwedEffect | null,
): OwedEffect[] {
  const { messageId } = facts;
  const owed: OwedEffect[] = [];

  if (parts.shadowTrial && owesShadowTrial(facts)) {
    owed.push({
      name: 'shadow_trial', scope: messageId, lane: 'inline',
      input: {
        turn: facts.scopedTurn,
        trialContext: parts.shadowTrial.trialContext,
        pendingVersion: parts.shadowTrial.pendingVersion,
      },
    });
  }

  // Each lane is durably gated at its own boundary, so each replays from its recorded input.
  if (parts.sleepTime) {
    owed.push({ name: 'sleep_time', scope: messageId, lane: 'detached', input: {} });
  }

  if (naming !== null) owed.push(naming);

  if (parts.autoGepa) {
    owed.push({ name: 'auto_gepa', scope: messageId, lane: 'detached', input: {} });
  }

  return owed;
}

function autoTitleEffect(
  facts: TerminalTurnFacts, parts: TerminalTurnParts,
): { readonly effect: OwedEffect; readonly standIn: boolean } | null {
  if (parts.autoTitle === undefined) return null;
  const input = autoTitleInput(parts.autoTitle, facts.userText);

  return { effect: { name: 'auto_title', scope: facts.messageId, lane: 'detached', input }, standIn: 'standIn' in input };
}

/** Asked by a host before it reads the sampling plan at all. */
export function owesShadowTrial(facts: Pick<TerminalTurnFacts, 'completed' | 'workMode' | 'evolutionEnabled'>): boolean {
  return facts.completed && facts.workMode !== 'plan' && facts.evolutionEnabled;
}

/** The mission unless it is still a placeholder, then the owner's own words. */
function autoTitleInput(
  title: NonNullable<TerminalTurnParts['autoTitle']>, userText: string,
): { subject: string } | { subject: string; standIn: true } {
  if (title.mission === null || isPlaceholderMission(title.mission)) return { subject: userText };

  return title.standIn === true ? { subject: title.mission, standIn: true } : { subject: title.mission };
}
