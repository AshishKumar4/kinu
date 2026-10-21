/**
 * What a settled response owes, in order: the one roster for every backend, so the same questions get
 * the same answers. Callers supply values, never decisions: what the actor's role owes (its naming, its logo,
 * its sleep-time, its review) is decided here; an effect a backend lacks is an absent part.
 */
import { JsonValueSchema, projectJsonValue, type JsonValue } from '../utils/json';
import { WorkModeSchema, type WorkMode } from '../types/turn';
import type { RunEndReason } from './turn-lifecycle';
import type { TurnContinuity } from './evolution-lanes';
import type { OwedEffect } from './terminal-effects';
import type { OwedTerminalEffectsInput } from './chat-session';
import { isPlaceholderMission, WORKSPACE_CREATED_EVENT } from '../identity/soul';
import type { ActorAdvisor } from '../advisor/actor-advisor';
import type { CompletedTurn } from '../evolution/types';
import * as v from 'valibot';
import { CompletedTurnSchema } from '../evolution/session-window';
import { RunEndReasonSchema } from './terminal-effects';
import { TurnFactsSchema } from './turn-facts';
import { owesTurnLessons } from '../evolution/struggles';
import type { ChatTurnInput } from './chat-session';
import type { ActorIdentity } from '../identity/actor-handle';
import type { KinuError } from '../obs/index';
import { reportReadsNarration, type TaskTurnEnding } from '../subagents/temporary';
import { turnTags } from '../types/turn-metadata';
import type { TaskReminder } from '../tasks/reminder';
import { announcementOf } from '../utils/ui-message';
import type { TurnReportFacts } from './terminal-effects';
import { turnLane } from '../delegation/turn-reach';

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
  /** Raw: the claim must exist before any await after a persisted answer. */
  readonly turnEndExtensions?: boolean;
  /** Its armed state is RAM-only, so the row alone records the enqueue. */
  readonly completionGate?: { readonly text: string };
  /** Claimed because enqueueing is asynchronous and must survive a process cut. */
  readonly overflowRetry?: boolean;
  /** The one output-limit continuation turn (`owesOutputLimitContinuation`). */
  readonly outputContinuation?: boolean;
  /** Decided by the caller, the only one that reads the list and the outcome together. */
  readonly taskReminder?: TaskReminder;
  /** The turn's end, owed its hirer ({@link TurnEnd}), keyed as the hirer's ingress dedupes. */
  readonly turnReport?: TurnEnd & { readonly sequenceId: string };
}

/** The settled turn's actor: what its role owes is decided by the roster, from these values. */
export interface TerminalActor {
  readonly role:
    /** The workspace's own agent: named from the workspace's mission, its conversation compressed into the workspace's
     *  facts by sleep-time, and the turn that answered the workspace's creation names and draws a new workspace. */
    | { readonly kind: 'workspace'; readonly mission: string | null; readonly event: string | null }
    /** Any other agent: named once, from the brief its conversation opened on, however that turn ended. */
    | { readonly kind: 'agent'; readonly opensConversation: () => boolean };
  /** Reviews the turn, on the tools it could reach, if it reviews turns at all. */
  readonly advisor: Pick<ActorAdvisor, 'reviewsTurns' | 'snapshot'>;
  /** As scoped for its recording. */
  readonly turn: CompletedTurn;
  readonly reachableTools: readonly string[];
}

/** The parts the chat loop decides, mapped here once so no backend drops one. */
export function chatTurnParts(input: Pick<OwedTerminalEffectsInput, 'credited' | 'overflowRetry' | 'outputContinuation' | 'taskReminder'>): TerminalTurnParts {
  return {
    credited: input.credited,
    ...(input.overflowRetry && { overflowRetry: true }),
    ...(input.outputContinuation && { outputContinuation: true }),
    ...(input.taskReminder !== null && { taskReminder: input.taskReminder }),
  };
}

/** Order is load-bearing: turn-end, recording, drain; inline effects before detached ones. */
export function declareTerminalRoster(
  facts: TerminalTurnFacts, actor: TerminalActor, parts: TerminalTurnParts = {},
): OwedEffect[] {
  const { messageId, assistantText, completed } = facts;
  // One gate, "durable answer": the stream alone must not mark an unanswered event answered.
  const durablyAnswered = completed && messageId !== '';
  const owed: OwedEffect[] = [];

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

  owed.push(...followUpTurns(messageId, parts));

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
      autoEvolve: facts.evolutionEnabled,
    },
  });

  // Recorded, not re-read on replay: the tool surface can change.
  if (actor.advisor.reviewsTurns) {
    owed.push({
      name: 'advisor_review', scope: messageId, lane: 'detached',
      input: { status: facts.status, workMode: facts.workMode, advisor: projectJsonValue({ value: actor.advisor.snapshot(actor.turn, actor.reachableTools) }) },
    });
  }

  // Composed after the commit, where the hirer's roster is: nothing crosses before it (#75).
  if (parts.turnReport) {
    const report: TurnReportFacts = { ...parts.turnReport, narration: [...parts.turnReport.narration], mode: facts.workMode };

    owed.push({ name: 'turn_report', scope: messageId, lane: 'detached', input: { ...report } });
  }

  const naming = autoTitleEffect(facts, actor);

  owed.push(...logoEffect(facts, actor));

  // Below is completed-Build only, except a new workspace's naming, which is owed however its first turn ended.
  if (!completed || facts.workMode === 'plan') {
    if (naming?.standIn === true) owed.push(naming.effect);

    return owed;
  }

  owed.push(...completedBuildEffects(facts, actor, naming?.effect ?? null));

  return owed;
}

/** The chat's own follow-up turns, each claimed inside the commit so a killed process re-drives its delivery. */
function followUpTurns(messageId: string, parts: Pick<TerminalTurnParts, 'overflowRetry' | 'outputContinuation' | 'taskReminder'>): OwedEffect[] {
  const owed: OwedEffect[] = [];

  if (parts.overflowRetry) owed.push({ name: 'overflow_retry', scope: messageId, lane: 'inline', input: {} });

  // Mutually exclusive with the retry; `completed` decides which.
  if (parts.outputContinuation) owed.push({ name: 'output_continuation', scope: messageId, lane: 'inline', input: {} });

  // No open tasks, no row.
  if (parts.taskReminder) {
    const { text, titles } = parts.taskReminder;

    owed.push({ name: 'task_reminder', scope: messageId, lane: 'inline', input: { text, titles: [...titles] } });
  }

  return owed;
}

/** How a hired actor's turn ended, as its hirer is told it: read at its commit, with nothing crossed for it. */
export interface TurnEnd {
  readonly turnId: string;
  readonly ending: TaskTurnEnding;
  readonly assistantText: string;
  /** Each step's words, oldest first: read only for a turn that did not answer. */
  readonly narration: readonly string[];
  readonly ownerDriven: boolean;
  /** The assignment this turn answers, if one opened it. */
  readonly taskId: string | null;
}

/** A hired actor's turn end, or null for an actor no one hired. */
export async function turnEndOf(
  actor: Pick<ActorIdentity, 'parentActorId'>, item: ChatTurnInput, turnId: string,
  ended: { readonly ending: TaskTurnEnding; readonly assistantText: string; readonly narration: () => Promise<readonly string[]> },
): Promise<TurnEnd | null> {
  if (actor.parentActorId === null) return null;
  const { authorship } = turnTags(item);

  return {
    turnId, ending: ended.ending, assistantText: ended.assistantText,
    narration: reportReadsNarration(ended.ending) ? await ended.narration() : [],
    ownerDriven: authorship === 'owner',
    taskId: authorship === 'hirer' ? announcementOf(turnId) : null,
  };
}

/**
 * The report a hirer is owed for its assignment that ended without an answer, `failure` why: the hirer waits on the
 * work, not on a turn, so it is answered as blocked, keyed by the work. None for a turn in the owner's lane, an agent
 * with no hirer, or a turn with no work to key it by.
 */
export function unansweredReport(actor: Pick<ActorIdentity, 'name' | 'parentActorId'>, item: ChatTurnInput, failure: KinuError): OwedEffect | null {
  const tags = turnTags(item);

  if (turnLane({ hirer: actor.parentActorId }, tags.authorship) !== 'hirer' || item.idempotencyKey === undefined) return null;

  return {
    name: 'parent_report', scope: item.idempotencyKey, lane: 'detached',
    input: {
      text: `${actor.name} failed to run its assigned turn: ${failure.message}`,
      status: 'blocked', mode: tags.mode, sequenceId: item.idempotencyKey, quiet: false,
    },
  };
}

/** The run a turn settled on, as its agent tells the workspace that kept its tools' receipts. */
export const SettledRunSchema = v.object({
  turnId: v.string(),
  runId: v.string(),
  /** The epoch it was claimed under, which its close names (design v2 §3). */
  epoch: v.nullable(v.number()),
});

export type SettledRun = v.InferOutput<typeof SettledRunSchema>;

/** A settled turn as its chat hands it to the object that owes its lanes; that object scopes and declares the rest. */
export const HandedOffTurnSchema = v.object({
  ...SettledRunSchema.entries,
  messageId: v.string(),
  status: RunEndReasonSchema,
  completed: v.boolean(),
  workMode: WorkModeSchema,
  userText: v.string(),
  assistantText: v.string(),
  /** The event the turn answered; null for a person's message. */
  event: v.nullable(v.string()),
  /** Unscoped: the receiving object's governor scopes it. */
  turn: JsonValueSchema,
  credited: v.nullable(v.string()),
  answeredDeliveries: v.array(v.string()),
  reachableTools: v.array(v.string()),
  recordedAt: v.number(),
  /** What the workspace decided as the turn opened, as the agent froze it then. */
  facts: TurnFactsSchema,
});

export type HandedOffTurn = v.InferOutput<typeof HandedOffTurnSchema>;

/**
 * A turn whose lanes are another object's (the workspace's own agent, whose evolution, event log and titles are the
 * workspace's): its chat's follow-up turns, then the settled turn handed to that object, which declares and owes the
 * rest of the roster itself.
 */
export function declareHandoffRoster(
  parts: Pick<TerminalTurnParts, 'overflowRetry' | 'outputContinuation' | 'taskReminder'>, settled: HandedOffTurn,
): OwedEffect[] {
  return [...followUpTurns(settled.messageId, parts), { name: 'workspace_settle', scope: settled.messageId, lane: 'detached', input: { ...settled } }];
}

/** An agent whose lanes are its own tells the workspace its run settled, as {@link declareHandoffRoster}'s handoff does. */
export function runSettleEffect(messageId: string, run: SettledRun): OwedEffect {
  return { name: 'run_settle', scope: messageId, lane: 'detached', input: { ...run } };
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
  facts: TerminalTurnFacts, actor: TerminalActor, naming: OwedEffect | null,
): OwedEffect[] {
  const { messageId } = facts;
  const owed: OwedEffect[] = [];

  // Each lane is durably gated at its own boundary, so each replays from its recorded input. The lane reads the
  // transcript, so the row carries no input.
  if (actor.role.kind === 'workspace') {
    owed.push({ name: 'sleep_time', scope: messageId, lane: 'detached', input: {} });
  }

  if (naming !== null) owed.push(naming);

  return owed;
}

/** Owed by a new workspace's first turn. */
function logoEffect(facts: TerminalTurnFacts, actor: TerminalActor): OwedEffect[] {
  const { role } = actor;

  if (role.kind !== 'workspace' || role.event !== WORKSPACE_CREATED_EVENT) return [];

  return [{ name: 'workspace_logo', scope: facts.messageId, lane: 'detached', input: { subject: autoTitleInput({ mission: role.mission }, facts.userText).subject } }];
}

function autoTitleEffect(
  facts: TerminalTurnFacts, actor: TerminalActor,
): { readonly effect: OwedEffect; readonly standIn: boolean } | null {
  const title = titleOf(actor, facts.userText);

  if (title === null) return null;
  const input = autoTitleInput(title, facts.userText);

  return { effect: { name: 'auto_title', scope: facts.messageId, lane: 'detached', input }, standIn: 'standIn' in input };
}

/** `standIn`: a new workspace's shown title, or an agent's, replaced by this turn's naming. */
interface TitleSource { readonly mission: string | null; readonly standIn?: boolean }

/** The workspace's agent is named from its mission every turn, a new workspace's stand-in by the turn that answered its
 *  creation; any other agent once, from the brief its conversation opened on: a later turn's words ("Continue") are no
 *  name for it. */
function titleOf(actor: TerminalActor, userText: string): TitleSource | null {
  const { role } = actor;

  if (role.kind === 'workspace') return { mission: role.mission, standIn: role.event === WORKSPACE_CREATED_EVENT };

  return role.opensConversation() ? { mission: userText, standIn: true } : null;
}

/** The mission unless it is still a placeholder, then the owner's own words. */
function autoTitleInput(
  title: TitleSource, userText: string,
): { subject: string } | { subject: string; standIn: true } {
  if (title.mission === null || isPlaceholderMission(title.mission)) return { subject: userText };

  return title.standIn === true ? { subject: title.mission, standIn: true } : { subject: title.mission };
}
