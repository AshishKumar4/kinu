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
import * as v from 'valibot';
import { CompletedTurnSchema } from '../evolution/session-window';
import { owesTurnLessons } from '../evolution/struggles';

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
  /** The turn a settled branch's take set is attributed to; null when the turn earned no credit. */
  readonly credited?: string | null;
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
  /** The lane reads the transcript, so the row carries no input. */
  readonly sleepTime?: boolean;
  /** `standIn`: the shown title is a new workspace's, replaced by this turn's naming (identity/naming.ts). */
  readonly autoTitle?: { readonly mission: string | null; readonly standIn?: boolean };
  /** Presence is the caller's decision: a `task` child owes a terminal answer on every ending, a durable child only on completion. */
  readonly parentReport?: {
    readonly text: string;
    /** A task child's terminal answer and a durable child's progress note differ for the parent. */
    readonly status: SubordinateReportStatus;
    /** The parent's ingress dedupes on it. */
    readonly sequenceId: string;
    /** A Stop: wakes no one. */
    readonly quiet?: true;
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
        turnId: completed ? parts.credited ?? null : null,
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
  owed.push(...turnLessonsEffect(facts));
  owed.push({ name: 'event_drain', scope: messageId, lane: 'inline', input: {} });
  owed.push({
    name: 'improvement_lanes', scope: messageId, lane: 'inline',
    input: {
      status: facts.status,
      turn: facts.scopedTurn,
      workMode: facts.workMode,
    },
  });

  if (parts.advisor !== undefined) {
    owed.push({
      name: 'advisor_review', scope: messageId, lane: 'detached',
      input: { status: facts.status, workMode: facts.workMode, advisor: parts.advisor },
    });
  }

  if (parts.parentReport) {
    owed.push({
      name: 'parent_report', scope: messageId, lane: 'detached',
      input: {
        text: parts.parentReport.text,
        status: parts.parentReport.status,
        sequenceId: parts.parentReport.sequenceId,
        // The mode travels: a replay must not turn a Plan report into a Build one.
        mode: facts.workMode,
        quiet: parts.parentReport.quiet === true,
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

/** Owed whether or not a reply ever rates the turn, only by a turn with something to learn from (`owesTurnLessons`);
 *  recorded, so a session with evolution off learns nothing. */
function turnLessonsEffect(facts: TerminalTurnFacts): OwedEffect[] {
  if (!facts.evolutionEnabled || facts.workMode === 'plan') return [];
  const turn = v.safeParse(CompletedTurnSchema, facts.scopedTurn);

  if (turn.success && !owesTurnLessons(turn.output)) return [];

  return [{ name: 'turn_lessons', scope: facts.messageId, lane: 'detached', input: { turn: facts.scopedTurn } }];
}

function completedBuildEffects(
  facts: TerminalTurnFacts, parts: TerminalTurnParts, naming: OwedEffect | null,
): OwedEffect[] {
  const { messageId } = facts;
  const owed: OwedEffect[] = [];

  // Each lane is durably gated at its own boundary, so each replays from its recorded input.
  if (parts.sleepTime) {
    owed.push({ name: 'sleep_time', scope: messageId, lane: 'detached', input: {} });
  }

  if (naming !== null) owed.push(naming);

  return owed;
}

function autoTitleEffect(
  facts: TerminalTurnFacts, parts: TerminalTurnParts,
): { readonly effect: OwedEffect; readonly standIn: boolean } | null {
  if (parts.autoTitle === undefined) return null;
  const input = autoTitleInput(parts.autoTitle, facts.userText);

  return { effect: { name: 'auto_title', scope: facts.messageId, lane: 'detached', input }, standIn: 'standIn' in input };
}

/** The mission unless it is still a placeholder, then the owner's own words. */
function autoTitleInput(
  title: NonNullable<TerminalTurnParts['autoTitle']>, userText: string,
): { subject: string } | { subject: string; standIn: true } {
  if (title.mission === null || isPlaceholderMission(title.mission)) return { subject: userText };

  return title.standIn === true ? { subject: title.mission, standIn: true } : { subject: title.mission };
}
