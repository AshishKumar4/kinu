/**
 * The one turn loop for both backends. One turn at a time; every started turn ends (one `turn-end`, a closed
 * run, a released lease); a mid-turn send splices in; a send is durable before acknowledged; leftovers rerun as
 * one turn; restart replays pending sends and owed effects; an interrupted turn continues once, in its run.
 */

import { answeredSummary, resumeMetadata, type OwnerAnswer } from '../plans/owner-questions';
import { OWNER_ANSWER_SIGNAL } from '../types/owner-questions';
import type { RewindComputer } from './rewind-notice';
import {
  deliveredSignal, IntentResultSchema, MessageIdSchema, type Delivery, type DeliveryAnswer, type DeliveryInput, type IntentInput, type IntentResult, type OwedDelivery,
  type TurnDeliveryInput,
} from '../subordinates/deliveries';
import type { PlanDecisionOutcome } from '../types/plans';
import { refusedRun, type RunEndOutcome } from '../subordinates/agent-isolate';
import { driveExecution, type AssembledRound, type ClaimedRound } from './execution-driver';
import { authoredTurnMetadata, stampAuthorship, turnTags, type TurnTags } from '../types/turn-metadata';
import type { TurnAuthorship } from '../types/turn';
import type { TrialTurn } from '../evolution/trial-rules';
import type { ModelMessage } from 'ai';
import * as v from 'valibot';
import { Effect, Result } from 'effect';
import { INTERRUPTED_TURN, type ChatEvent } from '../chat';
import type { CompactionTrigger } from '../extension';
import { WORKSPACE_RUN_ID } from '../events/model-call';
import { narrowestMode, runWorkModeInvocation } from '../execution/work-mode';
import type { EventLog } from '../events/hub/log';
import type { RunEventRecorder } from '../events/recorder';
import type { RunEvent } from '../events/types';
import type { CompletedTurn } from '../evolution/types';
import { attempt, attemptInItsWords, classifyErrorCode, inItsWords, diagnostics, hold, KinuError, logged, renderThrownChain, settle as settleEffect, settleLogged, settleLoggedSync, settleSync, toKinuError, type Refusal } from '../obs/index';
import { contextFill, type ContextFill } from '../read-models/context-fill';
import { runOperationProfile } from '../profiles/operation';
import type { ResolvedTurnProfile } from '../profiles';
import type { CacheWarming } from '../providers/cache-warming';
import { DEFAULT_CACHE_RETENTION, parseModelSpec } from '../providers/types';
import { serverCompactor, SERVER_COMPACTION_MIN_TOKENS } from '../providers/server-compaction';
import type { ToolOutcome } from '../tools/outcome';
import { OVERFLOW_RETRY_EVENT } from '../turn-failure';
import type {
  BroadcastEvent, EnqueueTurnResult, OperatorSend, ProgrammaticTurn, PromptFile,
} from '../types/backend-host';
import type { TierId } from '../types/profile';
import type { SendLanding } from '../types/signals';
import type { WorkMode } from '../types/turn';
import type { JsonObject } from '../utils/json';
import { nanoid } from '../utils/nanoid';
import { ASKED, type Holds } from '../utils/held-reads';
import { PROGRAMMATIC_MESSAGE_ID_PREFIX } from '../utils/ui-message';
import { CLEAR_NEEDS_IDLE, COMPACT_NEEDS_IDLE, REVERT_NEEDS_IDLE } from './actor-session';
import type { ActorSession, ActorTurnLease, ActorExecutionInput, ActorExecutionResult } from './actor-session';
import type { ClaimOutcome } from './actor-claims';
import { CompletionGate, COMPLETION_GATE_EVENT } from './completion-gate';
import { turnInputMessage, type InputProducer, type LandedSteerRow, type PendingSendStore, type UserSteer } from './inbox';
import { RETRIED_TURN_EVENT, runItem, runMetadata, tagged, type DeliveredRun, type QueueItem } from './chat-queue';
import { restoreChat } from './chat-restore';
import { DeliveredRunEnds } from './delivered-run-ends';
import type { OwedEffect } from './terminal-effects';
import { turnEndOf, unansweredReport, type TurnEnd } from './terminal-roster';
import type { TerminalTransition, TerminalTransitions } from './terminal-transition';
import {
  classifyRunEnd, closeRunIn, closeTurnRun, creditedTurnId, openTurnRun, recordExecutionEvent, settleExecutionContext,
  owesOutputLimitContinuation, OUTPUT_CONTINUATION_EVENT, snapshotCompletedTurn,
  type CompactionTriggerState, type RunEndClassification, type RunEndFacts, type RunEndReason,
} from './turn-lifecycle';
import type { SessionTranscript, PreparedConversationEntry } from '../session/transcript';
import { RECOVERY_BACKOFF_CEILING_MS } from '../utils/recovery-backoff';
import type { MessageReference } from '../session/messages';
import type { ContextSelection } from '../session/context';
import { subordinateTurnContext } from '../subordinates/support';
import { taskTurnEnding } from '../subordinates/temporary';
import { SIGNALS_SEEN_METADATA_KEY, TURN_END_METADATA_KEY, TURN_FAILURE_METADATA_KEY, type SeenSplice } from '../read-models/background-event';
import { TaskReminders, TASK_REMINDER_EVENT, type TaskReminder } from '../tasks/reminder';
import type { AgentTaskTree } from '../tools/task-store';
import type { ActiveRoster } from '../types/dynamic-context';
import { inheritedAsModelMessage } from '../heads/head-inference';
import type { SerializedMessage } from '../types/heads';
import { sendStateOf, type SendState } from './send-state';

type ToolCallArguments = Extract<ChatEvent, { type: 'tool-call' }>['args'];

/** None: reclamation runs under the single-driver lease, so every open lease is a dead process's. */
const NO_STRANDED_DELIVERY_GRACE = 0;

/** The run end is classified once by `runTurn`, so the roster and the run row cannot disagree. */
interface CommittedTurn {
  readonly turn: CompletedTurn;
  readonly owed: readonly OwedEffect[];
  readonly transition: TerminalTransition;
}

/** Reported rather than thrown, because the signal settle after it must run either way. */
type TurnCommit = { readonly committed: CommittedTurn } | { readonly failure: KinuError };

/** What one commit holds of a turn ({@link ChatSession.commitTurn}): its answer as it lands, what it owes, and how its run ended. */
interface TurnCommitInput {
  readonly item: QueueItem;
  readonly answeredDeliveries: ReadonlySet<string>;
  readonly lease: ActorTurnLease;
  readonly turnId: string;
  readonly event: string | undefined;
  readonly assistantText: string;
  readonly turnEnd: TurnEnd | null;
  /** Null for a turn that owes no reminder. */
  readonly openWork: OpenWork | null;
  readonly preparedAssistant: PreparedConversationEntry | null;
  readonly runError: string | null;
  /** Classified once by the caller — see `closeRun`. */
  readonly end: RunEndClassification;
  readonly trialContext: readonly ModelMessage[];
  readonly reachableTools: readonly string[];
  readonly overflowRetry: boolean;
}

/** A `step-cut` as a chat stream carries it to a client, one that watches the turn from another process. */
export const STEP_CUT_CHUNK = 'data-kinu-step-cut';

export const StepCutDataSchema = v.object({ stepIndex: v.number() });

export type SessionEvent =
  | { type: 'turn-start'; kind: 'user' | 'programmatic'; text: string; event?: string; workMode: WorkMode;
      /** Whom it answers, as its admission stored it (`turn-authorship.ts`). */
      authorship: TurnAuthorship;
      /** Both minted at admission. */
      turnId: string; messageId: string;
      /** A rerun answers every leftover as one turn; a transport closes their requests with it. */
      carried: readonly string[];
      /** Steps before this activation, each recorded in the ledger of run `runId`, the run the turn continues. */
      finishedSteps: number; runId: string }
  | { type: 'step-cut'; stepIndex: number }
  | { type: 'text-delta'; delta: string }
  /** Shown live; never the answer, never stored. */
  | { type: 'reasoning-delta'; delta: string }
  | { type: 'tool-call'; toolName: string; toolCallId: string; args: ToolCallArguments }
  | ({ type: 'tool-result'; toolName: string; toolCallId: string; result: string } & ToolOutcome)
  // `runId` names the execution that ended: its recovery continues the run, its Retry starts another.
  /** `epoch`: the admitted claim the turn ran under, which its close names (design v2 §3); null for one never admitted. */
  | { type: 'turn-end'; turn: CompletedTurn; turnId: string; runId: string; epoch: number | null }
  | { type: 'error'; message: string }
  | { type: 'evolution'; event: string; message: string }
  // Kept apart from `evolution`: an agent with learning off says no evolution while its jobs may still settle.
  | { type: 'background'; event: string; message: string }
  | { type: 'broadcast'; event: BroadcastEvent }
  /** The durable head moved; surfaces redraw from the store. */
  | { type: 'history-reverted'; entryId: string }
  /** Forwarded live: a container-scoped database dies with the container. */
  | { type: 'run-event'; event: RunEvent };

/** A turn's end, which names the execution it closes (its turn, its run, its claim's epoch). */
export type TurnEndEvent = Extract<SessionEvent, { type: 'turn-end' }>;





/** May throw: the session records the failure and the loop continues. */
export interface ChatTransport {
  /** A transport that must read durable state returns a promise, serialized behind earlier events. */
  deliver(event: SessionEvent): void | Promise<void>;
}

export interface ChatTurnInput {
  readonly kind: 'user' | 'programmatic';
  readonly text: string;
  readonly files?: ReadonlyArray<PromptFile>;
  readonly metadata?: ProgrammaticTurn['metadata'];
  /** Absent on a user turn. */
  readonly idempotencyKey?: string;
}

/** A chat turn's round as it assembled: what its projection reads of its preparation. */
interface ChatRound extends AssembledRound {
  readonly prepared: PreparedTurn;
  /** Whether the turn put out anything the owner saw; a Stop before any output leaves their row alone. */
  readonly streamed: { output: boolean };
}

export interface PreparedTurn {
  readonly execution: Omit<ActorExecutionInput, 'task'>;
  readonly sessionKey: string;
  readonly contextWindow: number | null;
  readonly historyLength: number;
  /** The live trial's arm this turn ran (`turnArtifactBodies`), recorded with the completed turn. */
  readonly trial?: TrialTurn | null;
  /** Until when the conversation's warming lane kept the prompt cache warm for its last request, as the preparation
   *  noted this one ({@link TurnOpeningAsk}); null when nothing kept it. */
  readonly cacheKeptAliveUntil: number | null;
}

/** What a backend's turn assembly knows of the turn it opens: the answer's id and whether the prompt cache is cold. */
export interface TurnOpening {
  readonly answerId: string;
  readonly cacheCold: boolean;
}

/**
 * What the session knows of the turn it asks its backend to prepare. A real provider request is starting: where the
 * conversation's warming lane lives, the preparation notes it there, reading first until when the lane kept the cache warm
 * for the last request (`CacheWarmingLane.noteRequest`), and the turn opens cold unless that, or the last request's own
 * lifetime, still holds ({@link openingCacheCold}).
 */
export interface TurnOpeningAsk {
  readonly answerId: string;
  /** When the conversation's last request was sent; null before its first. */
  readonly lastRequestAt: number | null;
  /** Whether the cache is cold unless the warming lane kept it: the last request's own lifetime has run out. */
  readonly coldUnlessKept: boolean;
}

/** Whether a turn asked so opens on a cold cache, its warming lane having kept it until `keptAliveUntil`. */
export function openingCacheCold(ask: TurnOpeningAsk, keptAliveUntil: number | null, now = Date.now()): boolean {
  return ask.coldUnlessKept && !(keptAliveUntil !== null && now < keptAliveUntil);
}

/** Taken while the turn is still in memory. */
export interface OwedTerminalEffectsInput {
  readonly turn: CompletedTurn;
  readonly status: RunEndReason;
  readonly credited: string | null;
  readonly messageId: string;
  readonly userText: string;
  /**
   * This turn opened the conversation: its words are the agent's brief, or its owner's first. Asked only where a child
   * is named, while the turn is in memory, so a root's turn pays no read for it.
   */
  readonly opensConversation: () => boolean;
  /** Read off the settling turn itself; undefined for a person's message. */
  readonly event: string | undefined;
  readonly assistantText: string;
  /** How the turn ended, as its hirer is told it once the answer committed; null for an actor no one hired. */
  readonly turnEnd: TurnEnd | null;
  readonly completed: boolean;
  readonly trialContext: readonly ModelMessage[];
  /** A cold replay has no live toolset to ask. */
  readonly reachableTools: readonly string[];
  readonly overflowRetry: boolean;
  /** A backend with reply channels owes each an outbound reply. */
  readonly answeredDeliveries: ReadonlySet<string>;
  /** At most one continuation is owed. */
  readonly outputContinuation: boolean;
  readonly taskReminder: TaskReminder | null;
}

/** `seen`: the splices the agent read mid-answer, kept once here; none from a turn whose events re-deliver. `slates`: a
 *  failure answer's, taken as it commits ({@link ChatSessionPorts.failedAnswerSlates}). */
function answerMetadata(
  { end, seen = [], slates = null }: { readonly end: RunEndClassification; readonly seen?: readonly SeenSplice[]; readonly slates?: JsonObject | null },
): JsonObject | null {
  const metadata: JsonObject = {
    ...slates,
    ...(end.reason === 'incomplete' && { [TURN_END_METADATA_KEY]: end.reason }),
    ...(end.error !== undefined && { [TURN_FAILURE_METADATA_KEY]: end.error }),
    ...(seen.length > 0 && { [SIGNALS_SEEN_METADATA_KEY]: seen.map((splice) => ({ ...splice })) }),
  };

  return Object.keys(metadata).length === 0 ? null : metadata;
}

export interface ComposedRequest {
  readonly execution: Omit<ActorExecutionInput, 'task'>;
  readonly profile: ResolvedTurnProfile;
  /** What the conversation's compaction state is kept under. */
  readonly sessionKey: string;
}

/** `/compact` folded into Better Compact's summary, armed a server-side compaction, or found nothing to fold. */
export type CompactOutcome = 'folded' | 'armed' | 'nothing';

/** What an agent still has to do as a turn of its settles. */
export interface OpenWork {
  readonly tasks: ActiveRoster<AgentTaskTree>;
  readonly asyncWakePending: boolean;
}

/** Each port is asked per call, never captured. */
export interface ChatSessionPorts {
  /** Runs after the opening row and run are durable, under `round`'s claim: it binds through `round.bind`, and a recovered
   *  execution assembles on `round.frozen`. A throw ends the turn as an error with one `turn-end`. */
  prepareTurn(item: ChatTurnInput, lease: ActorTurnLease, opening: TurnOpeningAsk, round: ClaimedRound): Promise<PreparedTurn>;
  /** Never consumes an armed compaction. */
  composeRequest(): Promise<ComposedRequest>;
  owedTerminalEffects(input: OwedTerminalEffectsInput): OwedEffect[];
  /**
   * A failed turn's slates, stamped on its failure answer as it commits: it owes no roster to carry them. An answered
   * turn's are taken only once its answer committed, by a row of its own roster (`answer_slates`): a crossing before the
   * commit would leave a death there to ask the model again (#75). Absent where there are no slates (the CLI,
   * `FileDeps.slate`).
   */
  failedAnswerSlates?(lease: ActorTurnLease): Promise<JsonObject | null>;
  /** Asked per call: the bodies close over stores built after this session. */
  terminal(): TerminalTransitions;
  /** Asked per item at dequeue and before a drain binds rows; a refusal settles the item to its producer. */
  driverGate(): Refusal | null;
  /**
   * Called at the turn's synchronous open; soonest-wins. Absent where the process is the wake: a person's start is its
   * restart, so a re-opened turn there is asked again at once.
   */
  armTurnWake?(atMs: number): Promise<void>;
  /** Its queue's first turn taken: owed until {@link quiet}. Absent where the process is the wake, as {@link quiet} is: the
   *  agent's isolate holds its port into its workspace between the two (#69). */
  owed?(): void;
  /** The queue drained and no turn runs; absent where the process is the wake, as for {@link armTurnWake}. */
  quiet?(): void;
  /**
   * The agent's open tasks, and whether async work will wake it (a reminder fired behind it would race its wake): read
   * as the turn settles, where its `tasks` tool writes and its jobs run, which may be another object's than its chat's.
   */
  openWork(): Promise<OpenWork>;
  steerSkills(text: string): Promise<string | null>;
  /**
   * A person wrote while the agent's step runs `executing` tool calls: each moves to the background at once where that
   * frees the step, as its foreground window would move it (`BackgroundJobRunner.release`), wherever its jobs run.
   */
  releaseForeground(executing: number): boolean | Promise<boolean>;
  /** Asked at dequeue; false drops the turn. */
  stillOwed(metadata: JsonObject | undefined): boolean;
  /** Where the assignment lives in another database (a facet's hirer's). */
  birthContext?(drainTurnId: string): Promise<readonly SerializedMessage[]>;
  /** The session drives it because both instants it needs are the session's; the policy is the lane's. Absent where
   *  no durable wake can replay a warm between turns, as for {@link armTurnWake}: the CLI. */
  readonly cacheWarming?: CacheWarming;
  /**
   * Runs delivered to the agent (D2): the session queues each as any input, runs it in its turn on its pump, and stops it
   * with the chat; its host supplies its assembly, next input and report. Absent where no run is delivered (the CLI).
   */
  readonly runs?: {
    /** Runs it to its end, which its host owes its caller: `recordEnd` prepares that end as a session payload, spilled as
     *  others are when it outgrows a row, and answers the write that keeps it on its held row, made in the commit that
     *  answers the run, where a restart tells it ({@link ChatSession.runEndsOwed}) and never runs the run again. Never
     *  throws: a run that fails records its refusal. */
    run(run: DeliveredRun, signal: AbortSignal, recordEnd: (outcome: RunEndOutcome) => Promise<() => void>): Promise<void>;
    /** A run's end is kept here untold (a run refused unrun, or ends a restart found): its host tells them. */
    tell(): void;
  };
  /** The owner's decision on a plan the agent submitted, as an intent delivers it (D6): its plans are its host's. Absent
   *  where no plan is delivered (the CLI decides in its own process). */
  readonly decidePlan?: (verdict: Pick<Extract<IntentInput, { kind: 'decision' }>, 'decision' | 'feedback'> & { readonly id: string; readonly revision: number }) => Promise<PlanDecisionOutcome>;
}

export interface ChatSessionOptions {
  readonly actorSession: ActorSession;
  readonly sessionId: string;
  readonly transcript: SessionTranscript;
  readonly pendingSends: PendingSendStore;
  readonly eventLog: EventLog;
  readonly eventRecorder: RunEventRecorder;
  readonly compactionState: CompactionTriggerState;
  /** Must be a real transaction: answer, run row and roster commit together, as do a drain's rows and spent reservations. */
  readonly transaction: <T>(body: () => T) => T;
  readonly transport: ChatTransport;
  readonly ports: ChatSessionPorts;
  /** The key every durable row of the answer is written under. */
  readonly mintAnswerId: () => string;
  /** A Durable Object's held reads; absent, every read asks. */
  readonly holds?: Holds;
}

export interface SendOptions {
  readonly tier?: TierId;
  /** A retry with this id lands once; a rerun keeps it as its turn id. */
  readonly id: string;
  /** A turn it starts, and its leftovers' rerun, run under it. Build by default. */
  readonly mode?: WorkMode;
}

/** Its own turn, under the card its metadata draws. */
export interface CardSend extends SendOptions {
  readonly metadata: JsonObject;
}

export type SendLandingWaiter = Pick<ReturnType<typeof Promise.withResolvers<SendLanding>>, 'resolve' | 'reject'>;

function refusedLanding(refusal: Refusal): KinuError {
  return new KinuError(refusal.reason, `${refusal.error}. Close that session, or send this from it.`);
}

interface OpenedTurn {
  readonly event: string | undefined;
  readonly mode: WorkMode;
  readonly turnId: string;
  readonly runId: string;
}

export class ChatSession {
  private readonly actorSession: ActorSession;
  private readonly sessionId: string;
  private readonly transcript: SessionTranscript;
  private readonly pendingSends: PendingSendStore;
  /** Settled where the fate is decided, never at admission. A send admitted via `admit` has no entry: its fate goes out as steer_status. */
  private readonly landings = new Map<string, SendLandingWaiter>();

  /** The fates of the words this isolate took as deliveries, until their sender asks. */
  private readonly deliveredLandings = new Map<string, Promise<SendLanding | KinuError>>();

  /** A Retry reserved but not yet queued. */
  private reopening = false;
  private readonly eventLog: EventLog;
  private revision: Promise<void> | null = null;
  private readonly unobserveMeasures: () => void;
  private readonly eventRecorder: RunEventRecorder;
  private readonly compactionState: CompactionTriggerState;
  private readonly transaction: <T>(body: () => T) => T;
  /** The ends of the runs delivered to this agent, kept until a report told them. */
  readonly runEnds: DeliveredRunEnds;
  private readonly transport: ChatTransport;
  private delivery: Promise<void> | null = null;
  private readonly ports: ChatSessionPorts;
  private readonly mintAnswerId: () => string;
  private ended = false;

  private runId: string | null = null;
  /** The scope every effect claim this turn makes is keyed to. Null between turns. */
  private turnId: string | null = null;
  /** Null for a user turn, whose row is durable from admission. */
  private openingRow: PreparedConversationEntry | null = null;

  /** The asking turn the running turn continues from, while it is an answer's turn. */
  private resumingAsk: string | null = null;
  private messageId = '';
  private turnTrial: TrialTurn | null = null;
  /** Armed only by a one-shot task turn (completion-gate.ts). */
  readonly completionGate = new CompletionGate();
  private readonly taskReminders = new TaskReminders();
  /** Drained by a single serialized pump so turns never interleave. */
  private readonly queue: QueueItem[] = [];

  /** Producers waiting on an announcement already running or queued. */
  private readonly joiners = new Map<string, ((result: EnqueueTurnResult) => void)[]>();
  private pumpActive = false;
  /** The only record that an item is being said for the whole length of a turn. */
  private runningAnnouncement: string | null = null;
  /** Joined by settleBackgroundWork(). */
  private activePump: Promise<void> | null = null;

  constructor(options: ChatSessionOptions) {
    this.actorSession = options.actorSession;
    this.sessionId = options.sessionId;
    this.transcript = options.transcript;
    this.pendingSends = options.pendingSends;
    this.eventLog = options.eventLog;
    this.eventRecorder = options.eventRecorder;
    this.compactionState = options.compactionState;
    this.transaction = options.transaction;
    this.runEnds = new DeliveredRunEnds({ pendingSends: this.pendingSends, payloads: this.transcript, transaction: this.transaction });
    this.transport = options.transport;
    this.ports = options.ports;
    this.mintAnswerId = options.mintAnswerId;
    // Every conversation_entries write is the transcript's record or truncate, or a fork's reset, over the actor's `sql`.
    this.onDisk = (options.holds ?? ASKED).holdEach(['conversation_entries'], (id: string) => this.transcript.has(id));

    // Every acknowledged send is a pending_steers row first. Bound here because the hosted actor's session
    // is built without a view of this workspace's queue.
    this.actorSession.bindSteerPersistence({
      onAccept: (steer) => { this.pendingSends.reserve({ ...steer, turnId: this.steerTurnId() }); },
      prepareDrain: (rows, _atStep, reference) => this.prepareLandedSteers(rows, reference),
      turnId: () => this.steerTurnId(),
      skills: (text) => this.ports.steerSkills(text),
      releaseForeground: (executing) => this.ports.releaseForeground(executing),
    });
    this.reopenedRunId = restoreChat({
      recorder: this.eventRecorder,
      actor: this.actorSession,
      pendingSends: this.pendingSends,
      announcementInFlight: (identity) => this.announcementInFlight(identity),
      announcementOnDisk: (identity) => this.announcementOnDisk(identity),
      retried: (turnId, text, metadata, heldAs) => this.retriedItem(turnId, text, metadata, heldAs),
      leftover: (sends, metadata) => this.leftoverRerun(sends, metadata),
      restoreMidTurn: (steers) => { this.actorSession.orchestrator.inbox.restorePending(steers); },
      queue: (item) => { this.queue.push(item); },
      notice: (event, message) => { this.emit({ type: 'background', event, message }); },
      pumpSoon: () => { queueMicrotask(() => { if (!this.ended) this.pump(); }); },
      tellRunsSoon: () => { queueMicrotask(() => { if (!this.ended) this.ports.runs?.tell(); }); },
    })?.runId ?? null;
    this.unobserveMeasures = this.eventRecorder.observe((event) => {
      if (event.type === 'context_admitted' || (event.type === 'step_finish' && event.usage?.input !== undefined)) this.broadcastContextFill();
    });
  }

  contextFill(catalogWindow: number | null): ContextFill | null {
    return contextFill(this.eventRecorder.readContextMeasures(), catalogWindow);
  }

  /** A frame with no tokens says no true number exists. */
  private broadcastContextFill(): void {
    const fill = contextFill(this.eventRecorder.readContextMeasures(), null);

    this.emit({
      type: 'broadcast',
      event: fill === null
        ? { type: 'context_fill' }
        : { type: 'context_fill', contextTokens: fill.tokens, ...(fill.window !== null && { contextWindow: fill.window }) },
    });
  }

  get pumpPromise(): Promise<void> | null { return this.activePump; }
  get turnOwed(): boolean { return this.pumpActive || this.queue.length > 0; }
  get pumping(): boolean { return this.pumpActive; }
  get currentRunId(): string | null { return this.runId; }

  /** The words of the turn this session runs next and has not yet recorded the run of: the one its pump took, else the
   *  head of its queue while no turn runs. What its host reports as its latest run from the input's admission, so no
   *  report between the admission and the run's opening shows the run before it. Null once a turn runs. */
  nextRunWords(): string | null {
    if (this.actorSession.inFlight) return null;

    return (this.taken ?? this.queue[0])?.text ?? null;
  }

  /** Open on purpose, so the wake reconcile must not seal them. */
  drivenRuns(): readonly string[] {
    return [...new Set([this.runId, this.reopenedRunId].filter((runId): runId is string => runId !== null))];
  }
  get currentTurnId(): string | null { return this.turnId; }

  /** Whether another response of this turn may still run: the live one, or a run the ledger holds open, which a
   *  restart re-opens as a continuation (the settling response's own run is already closed). */
  turnMayStillRun(turnId: string): boolean {
    return (this.pumping && this.turnId === turnId) || this.eventRecorder.openTurn()?.turn.turnId === turnId;
  }

  /** The owner's teardown calls this first. */
  close(): void {
    this.ended = true;
    this.unobserveMeasures();
  }
  /** Closed: what it is handed now is owed to its next start, not refused. */
  get closed(): boolean { return this.ended; }

  /** Non-zero while a terminal transition runs on the pump's stack, where awaiting execution would deadlock. */
  private settlingDepth = 0;

  /** The settled turn's cache-warm arming, in flight past its end: written as the turn settles (it never fails, its
   *  failure logged), and joined by the next turn's preparation, which notes a request the lane must see after it. */
  private warming: Promise<void> = Promise.resolve();

  /** Self-starts the pump when idle. A re-announcement of an already recorded fact starts no turn and answers 'queued'. */
  enqueueTurn(input: ProgrammaticTurn): Promise<EnqueueTurnResult> {
    // The operator's immediate next turn, answered at admission: its settle is on this pump's stack.
    if (input.origin === 'user') {
      const item = this.leftoverRerun(input.sends ?? [], input.metadata);
      // Each merged id is bound to this turn before admission; `OR IGNORE` because rerun ids already carry theirs.
      const { mode } = item.tags;

      for (const send of item.sends ?? []) {
        this.pendingSends.ensureReserved({ id: send.id, turnId: item.turnId ?? null, mode, text: send.text });
      }

      const front = this.queue.findIndex((queued) => queued.rerun !== true);
      this.queue.splice(front === -1 ? this.queue.length : front, 0, item);
      this.pump();

      return Promise.resolve({ status: 'queued' });
    }

    // During shutdown: 'skipped' sends the caller down its durable path; the next run drains it.
    if (this.ended) return Promise.resolve({ status: 'skipped' });

    // The same announcement running or queued answers when that turn does, so a caller never takes it as done early.
    if (input.idempotencyKey !== undefined && this.announcementInFlight(input.idempotencyKey)) return this.joinAnnounced(input.idempotencyKey);

    if (input.idempotencyKey !== undefined && this.announcementOnDisk(input.idempotencyKey)) {
      return Promise.resolve({ status: 'queued' });
    }

    const { promise, resolve } = Promise.withResolvers<EnqueueTurnResult>();

    const item = tagged({
      text: input.text,
      // Its authorship is the admitting path's, stored with its input over any a caller put there.
      metadata: stampAuthorship(input.metadata, input.authorship ?? 'hirer'),
      kind: 'programmatic',
      // The signal seam compensates on anything but 'queued'. 'yielded' is consumed: nothing is retried.
      settle: (failure, yielded, abandoned) => { resolve(settledAnnouncement(failure, yielded, abandoned)); },
    });

    if (input.idempotencyKey !== undefined) item.idempotencyKey = input.idempotencyKey;

    if (input.yieldsToUserMessage === true) item.yieldsToUserMessage = true;
    this.queue.push(item);

    if (this.settlingDepth > 0) {
      // Accepted, not started; resolving twice is harmless.
      this.pump();

      return Promise.resolve({ status: 'queued' });
    }

    this.pump();

    return promise;
  }

  /** As {@link enqueueTurn}, answered once the turn is queued unless admission already decided it: a caller in another
   *  object, itself mid-settle, never waits out the turn it handed over. */
  async queueTurn(input: ProgrammaticTurn): Promise<EnqueueTurnResult> {
    const queued: EnqueueTurnResult = { status: 'queued' };

    // An offer whose operator already spoke is consumed now: answered once queued, its caller would never hear the
    // yield its dequeue decides.
    if (await this.offerYields({ ...input, tags: turnTags(input) })) return { status: 'yielded' };

    // Its producer takes 'queued' as delivered, so the turn is held durably first, under its key (one minted when it
    // has none): a later process restores it through this queue (`restoreChat`, chat-restore.ts), and its settle retires it.
    const turn = input.origin === 'user' ? input : { ...input, idempotencyKey: input.idempotencyKey ?? `queued:${nanoid()}` };
    const key = turn.idempotencyKey;

    if (turn.origin !== 'user' && key !== undefined && !this.ended && !this.announcementInFlight(key) && !this.announcementOnDisk(key)) {
      this.pendingSends.reserveTurn({ ...turn, id: key, metadata: stampAuthorship(turn.metadata, turn.authorship ?? 'hirer') });
    }

    // An answer decided at admission resolves first; a turn still to run answers 'queued'.
    return await Promise.race([this.enqueueTurn(turn), Promise.resolve(queued)]);
  }

  /** Whether an offer that yields to the operator meets one who spoke first: a user turn queued, or one in the
   *  conversation. It then never runs, and the yield is logged as its activity. */
  private async offerYields(offer: { readonly yieldsToUserMessage?: boolean; readonly tags: TurnTags }): Promise<boolean> {
    if (offer.yieldsToUserMessage !== true) return false;

    if (!this.queue.some((queued) => queued.kind === 'user') && !(await this.transcript.operatorSpoke())) return false;
    diagnostics.event('genesis.yielded_to_message', {
      signal: offer.tags.event ?? 'unknown',
    });
    this.actorSession.orchestrator.logActivity('genesis.yielded_to_message');

    return true;
  }

  /**
   * Each answered question owes the turn that continues from its call. That turn has no input of its own: the
   * answer is the call's result (`plans/owner-questions.ts`), so the model goes on from the call. It runs before
   * what waited behind the question. Asked after an answer and at every wake, so an answer outlives the process.
   */
  resumeAnswered(): void {
    const { questions } = this.actorSession;
    let queued = false;

    for (const owed of questions.owedResumes()) {
      const identity = `owner-answer:${owed.turnId}`;

      if (this.announcementOnDisk(identity)) questions.markResumed(owed.turnId);
      else if (!this.ended && !this.announcementInFlight(identity)) {
        // The owner's answer: its turn is the owner's.
        this.queue.unshift(tagged({
          text: answeredSummary(owed.asked), kind: 'programmatic', idempotencyKey: identity, metadata: stampAuthorship(resumeMetadata(owed), 'owner'), settle: () => {},
        }));
        queued = true;
      }
    }

    // Asked at every wake: one that owes nothing leaves the loop as it was.
    if (queued) this.pump();
  }

  /** The report a turn that ended without its answer owes its caller, why in its own words; none where it has no caller. */
  private callerReport(item: QueueItem, why: string): OwedEffect | null {
    return unansweredReport(this.actorSession.runtime.actor, item, new KinuError('io', why));
  }

  /** A report owed its caller, recorded with `transition` (by the turn's end, where it closed one) and driven. */
  private async settleTold(transition: TerminalTransition, told: OwedEffect): Promise<void> {
    await hold(logged('turn.unanswered_report_failed', { doing: 'telling the caller a turn it is owed ended without an answer', otherwise: 'io' }, async () => {
      await this.ports.terminal().settle({ transition, declare: () => [told] });
    }));
  }

  /**
   * `tellCaller`: the item never opened, and its caller waits on the work, not on a turn, so it is owed a report of why
   * ({@link unansweredReport}): recorded in the commit that retires the item's held row, so no state has the
   * item gone and its report unowed, and driven as a roster is (#76). A refusal at dequeue owes none: the item was not
   * this process's to run.
   */
  private settleItem(
    item: QueueItem,
    failure: KinuError | null,
    { yielded, abandoned, tellCaller = false }: { readonly yielded?: boolean; readonly abandoned?: string; readonly tellCaller?: boolean } = {},
  ): void {
    // A held Retry that never opened (refused, yielded, stopped) is not run by a later process either.
    if (item.heldAs !== undefined && !this.ended) this.pendingSends.retireTurn(item.heldAs);

    // A run its host never ran: its end is the refusal, kept as the run's own would be, and told.
    if (item.run !== undefined && (failure !== null || yielded === true) && !this.ended) {
      // A refusal's words fit its row: no file is written for it.
      const refusal = refusedRun(failure ?? new KinuError('cancelled', 'The run was no longer owed.'));

      this.pendingSends.recordRunEnd(item.run.id, { json: JSON.stringify(refusal), path: null });
      this.ports.runs?.tell();
    }

    item.settle(failure, yielded, abandoned);
    this.wakeSendWaiters();

    if (item.idempotencyKey === undefined) return;
    const key = item.idempotencyKey;
    const told = tellCaller && failure !== null && item.run === undefined && !this.ended ? unansweredReport(this.actorSession.runtime.actor, item, failure) : null;
    const transition: TerminalTransition = { turnId: key, messageId: `unanswered:${key}` };

    let owed = false;

    // A closed session's store may be gone with it: the turn stays owed there, and the next process settles it. A run's
    // held row keeps its end until a report carrying it reached its caller ({@link runEndsTold}). A commit refused here
    // leaves the turn held, and the next process runs it.
    settleLoggedSync('turn.unanswered_report_failed', { doing: "retiring a turn that never ran, with the report its caller is owed", otherwise: 'io' }, () => {
      this.transaction(() => {
        if (item.kind === 'programmatic' && item.run === undefined && !this.ended) this.pendingSends.retireTurn(key);

        if (told !== null) this.ports.terminal().record(transition, [told]);
      });
      owed = told !== null;
    });

    if (owed && told !== null) this.actorSession.orchestrator.track(this.settleTold(transition, told), "telling a turn's caller it never ran");
    const result = settledAnnouncement(failure, yielded, abandoned);

    for (const joined of this.joiners.get(item.idempotencyKey) ?? []) joined(result);
    this.joiners.delete(item.idempotencyKey);
  }

  private joinAnnounced(identity: string): Promise<EnqueueTurnResult> {
    const joined = Promise.withResolvers<EnqueueTurnResult>();

    this.joiners.set(identity, [...this.joiners.get(identity) ?? [], joined.resolve]);

    return joined.promise;
  }

  /** Once the turn announced under `identity` has settled, if it is queued or running; at once otherwise. */
  async announcementSettled(identity: string): Promise<void> {
    if (!this.announcementInFlight(identity)) return;
    await this.joinAnnounced(identity);
  }

  announcementInFlight(identity: string): boolean {
    return this.runningAnnouncement === identity
      || this.queue.some((item) => item.idempotencyKey === identity);
  }

  announcementOnDisk(identity: string): boolean {
    return this.onDisk(`${PROGRAMMATIC_MESSAGE_ID_PREFIX}${identity}`);
  }

  private readonly onDisk: (entryId: string) => boolean;

  /** The one in-flight decision sends, Retry, Clear and Revert take: a Retry between its claim and its queue counts. */
  turnInFlight(): boolean {
    return this.reopening || this.running();
  }

  /** A turn runs or is queued; a Retry claimed but not yet queued aside. A queued, unopened user turn or genesis offer
   *  counts: a message behind it rides its first step, so an offer is consumed only by a message that arrived before it. */
  private running(): boolean {
    return this.actorSession.inFlight || this.queue.some((item) => item.kind === 'user' || item.yieldsToUserMessage === true);
  }

  /**
   * A delivery from the agent's workspace (design v2 §1, v3 A): held in this store before it is answered, so the
   * workspace retires its row only once nothing of it can be lost. A repeat of its id is answered `duplicate`, whatever
   * became of the first; a closed session takes nothing, and the workspace delivers again at its next wake.
   */
  async admitDelivery(delivery: OwedDelivery, producer: InputProducer): Promise<DeliveryAnswer> {
    const { id, input } = delivery;

    if (this.ended) return settleSync(Effect.fail(new KinuError('unavailable', 'The agent is closing; the delivery is owed to its next start.')));
    const gate = this.ports.driverGate();

    // Another process drives this agent: taken here, it would be refused at its turn and lost; owed, the next pass takes it.
    if (gate !== null) return settleSync(Effect.fail(new KinuError('unavailable', `This agent is driven elsewhere (${gate.reason}); the delivery is owed to its next pass.`)));
    // Its producer crosses in order: one at or below a Stop's cutoff was cancelled there, one at or below what was taken
    // was answered before, its answer lost on the way back.
    const marked = this.pendingSends.markOf(producer, delivery.seq);
    // An owner's intent applied before is answered with what it did, as its first crossing was: its caller is owed that.
    const applied = marked === 'duplicate' ? this.pendingSends.applied(producer, delivery.seq) : null;

    if (applied !== null) return { applied: v.parse(IntentResultSchema, JSON.parse(applied)) };

    if (marked !== 'new') return marked;

    if (input.kind === 'run' && this.ports.runs === undefined) return settleSync(Effect.fail(new KinuError('unsupported', 'This agent takes no delivered run.')));

    // Its producer's mark moves once it is applied, with what it did: a repeat applies nothing, and is answered that.
    if (input.kind === 'decision' || input.kind === 'answers' || input.kind === 'retry') {
      const took = (result: IntentResult): void => { this.pendingSends.took(producer, delivery.seq, JSON.stringify(result)); };

      return await settleEffect(Effect.map(this.applyIntent(id, input, took), (result): DeliveryAnswer => ({ applied: result })));
    }

    let answer: DeliveryAnswer;

    if (input.kind === 'words') answer = await this.admitDeliveredWords(id, input);
    else if (input.kind === 'run') {
      const ran = this.admitDeliveredRun({ id, task: input.task });

      // Not taken yet: the crossing fails, and the delivery stays owed.
      if (ran instanceof KinuError) return settleSync(Effect.fail(ran));
      answer = ran;
    }
    else answer = await this.admitDeliveredTurn(id, input, delivery.authorship);

    // Its producer's mark moves once it is held: a repeat of it is answered `duplicate`.
    if (answer === 'taken') this.pendingSends.took(producer, delivery.seq);

    return answer;
  }

  /** An owner's intent, applied as it is taken: what it did is its answer. A refusal (a stale plan revision, a newest turn
   *  that moved, a turn still running) is an answer too, which its producer tells the owner. `took` marks the intent
   *  applied with what it did; a Retry commits it with the turn it holds. */
  private applyIntent(id: string, input: IntentInput, took: (result: IntentResult) => void): Effect.Effect<IntentResult, KinuError> {
    const marking = (result: IntentResult): Effect.Effect<void> => Effect.sync(() => { took(result); });

    switch (input.kind) {
      case 'decision': {
        const { decidePlan } = this.ports;

        if (decidePlan === undefined) return Effect.fail(new KinuError('unsupported', 'This agent takes no plan decision.'));
        const verdict = { id: input.plan, revision: input.revision, decision: input.decision, ...(input.feedback !== undefined && { feedback: input.feedback }) };

        return Effect.tap(Effect.map(attemptInItsWords('io', () => decidePlan(verdict)), (outcome): IntentResult => ({ kind: 'decision', outcome })), marking);
      }

      case 'answers':
        return Effect.tap(Effect.as(this.answerQuestions(input.questions, input.answers), { kind: 'answers' } as const), marking);
      case 'retry':
        return this.retryTurn(id, input.messageId, took);
    }
  }

  private async admitDeliveredWords(id: string, input: Extract<DeliveryInput, { kind: 'words' }>): Promise<DeliveryAnswer> {
    if (this.transcript.has(id) || this.pendingSends.has(id)) return 'duplicate';
    const words = input.files === undefined || input.files.length === 0 ? input.text : { text: input.text, files: input.files };

    // Its fate is heard here as a send's is: where it landed, or why it did not (`awaitLanding`). Held as a value, so a
    // fate no sender asks for is no unheard rejection.
    const fate = Promise.withResolvers<SendLanding | KinuError>();

    this.deliveredLandings.set(id, fate.promise);
    await this.admit(words, {
      id, ...(input.mode !== undefined && { mode: input.mode }), ...(input.tier !== undefined && { tier: input.tier }),
      ...(input.metadata !== undefined && { metadata: input.metadata }),
    }, { resolve: fate.resolve, reject: fate.resolve });

    return 'taken';
  }

  /** Held as its producer's turn is, then queued: a later process restores it from that row (`restoreChat`, chat-restore.ts). */
  private admitDeliveredRun(run: DeliveredRun): DeliveryAnswer | KinuError {
    const held = turnTags({ metadata: this.pendingSends.heldMetadata(run.id) }).run;

    // Another generation of a run held here: its workspace reset and re-drove it, so the held one's caller is gone. One
    // that already ended goes with its untold end; one still owed is replaced or waited out.
    if (held !== undefined && held !== run.task.runId) {
      if (!this.pendingSends.runEnds().some((kept) => kept.id === run.id)) return this.supersede(run);
      this.pendingSends.retireTurn(run.id);
    }

    if (this.pendingSends.hasTurn(run.id) || this.announcementInFlight(run.id)) return 'duplicate';
    this.queue.push(this.heldRun(run));
    this.pump();

    return 'taken';
  }

  /**
   * A re-driven run, in place of the generation held under its id: one still queued is replaced, and runs as the newer.
   * One already taken is cut off, and the newer stays owed until the older's end, which no caller hears, retired its input.
   */
  private supersede(run: DeliveredRun): DeliveryAnswer | KinuError {
    const queued = this.queue.findIndex((item) => item.run?.id === run.id);

    if (queued < 0) {
      if (this.runningRun?.id === run.id) this.runningRun.controller.abort(new KinuError('cancelled', `run ${run.id} was re-driven by its workspace`));

      return new KinuError('unavailable', `An earlier generation of run ${run.id} is still ending; this one is owed until it has.`);
    }

    this.pendingSends.retireTurn(run.id);
    this.queue[queued] = this.heldRun(run);

    return 'taken';
  }

  /** `run` held as its producer's turn is, under its id, and the queue item that runs it. */
  private heldRun(run: DeliveredRun): QueueItem {
    this.pendingSends.reserveTurn({ id: run.id, text: run.task.body, metadata: runMetadata(run.task) });

    return runItem(run);
  }

  /** Stops one run: unrun, its end is the Stop; running, it is aborted and ends as its host records. */
  stopRun(id: string): void {
    const queued = this.queue.findIndex((item) => item.run?.id === id);

    if (queued >= 0) {
      const [item] = this.queue.splice(queued, 1);

      if (item !== undefined) this.settleItem(item, new KinuError('cancelled', 'The run was stopped before it ran.'));

      return;
    }

    if (this.runningRun?.id === id) this.runningRun.controller.abort(new KinuError('cancelled', `run ${id} was stopped`));
  }

  /** The item the pump took and runs now, from its dequeue to its turn's end: a Stop in between cuts it (`interrupt`).
   *  Written by `runPump` as it takes the item, dropped as its turn ended; never across a pump. */
  private taken: QueueItem | null = null;

  /** What waited in the queue as the pump took {@link taken}: a person's words queued after it, before its turn began,
   *  had no turn to steer. Written with `taken`, dropped with it. */
  private queuedAtTake: ReadonlySet<QueueItem> = new Set();

  /** The run this session's pump runs now, and its cut. */
  private runningRun: { readonly id: string; readonly controller: AbortController } | null = null;

  /** Its host runs it to its end, which it keeps on the run's held row as it answers the run, and tells. One restored
   *  where no host takes runs is refused, as one refused at its dequeue is. */
  private async runDelivered(run: DeliveredRun): Promise<KinuError | null> {
    const { runs } = this.ports;

    if (runs === undefined) return new KinuError('unsupported', 'This agent takes no delivered run.');
    const controller = new AbortController();

    this.runningRun = { id: run.id, controller };

    try {
      await runs.run(run, controller.signal, (outcome) => this.runEnds.keep(run.id, outcome));
    } finally {
      this.runningRun = null;
    }

    return null;
  }

  private async admitDeliveredTurn(id: string, input: TurnDeliveryInput, authorship: Delivery['authorship']): Promise<DeliveryAnswer> {
    if (this.pendingSends.hasTurn(id) || this.announcementInFlight(id) || this.announcementOnDisk(id)) return 'duplicate';

    // A turn running: what happened reaches it at its next step, held here first, so an isolate that ends before that
    // step, or a settle that hands it back, runs it as a turn of its own.
    if (input.opensTurn !== true && input.yieldsToUserMessage !== true && this.actorSession.orchestrator.inbox.busy) {
      this.pendingSends.reserveTurn({ id, text: input.text, metadata: stampAuthorship(input.metadata, authorship) });

      if (this.actorSession.orchestrator.inbox.landMidTurn(deliveredSignal(id, input))) return 'taken';
    }

    const queued = await this.queueTurn({
      text: input.text, idempotencyKey: id, authorship,
      ...(input.metadata !== undefined && { metadata: input.metadata }),
      ...(input.yieldsToUserMessage === true && { yieldsToUserMessage: true }),
    });

    return queued.status === 'yielded' ? 'yielded' : 'taken';
  }

  /** Send; resolves where it landed (`'mid-turn'` or `'turn'`), never guessed at admission, and rejects if it did not land. */
  async send(input: string | { text: string; files: ReadonlyArray<PromptFile> }, opts: SendOptions): Promise<SendLanding> {
    const landing = Promise.withResolvers<SendLanding>();

    await this.admit(input, opts, landing);

    return landing.promise;
  }

  /** Where a send stands, from its durable facts ({@link sendStateOf}). */
  sendState(id: string): Promise<SendState> {
    return sendStateOf({ transcript: this.transcript, pendingSends: this.pendingSends, claims: this.actorSession.claims, runs: this.eventRecorder }, id);
  }

  /**
   * Where words under `id` landed once a turn took them: opening it, or read at a running turn's step. Read from durable
   * facts, so it outlives the isolate that admitted them; refused once they were handed back, or were never sent.
   */
  async awaitLanding(id: string): Promise<SendLanding> {
    const heard = this.deliveredLandings.get(id);

    // This isolate admitted them: their fate as the send's own, a refusal and all.
    if (heard !== undefined) {
      const fate = await heard;

      this.deliveredLandings.delete(id);

      if (fate instanceof KinuError) return settleSync(Effect.fail(fate));

      return fate;
    }

    const landed = await this.untilSend(id, (state) => {
      if (state.status === 'running' || state.status === 'settled') return state.landed;

      return state.status === 'none' ? 'handed-back' : undefined;
    });

    if (landed === 'handed-back') return settleSync(Effect.fail(new KinuError('cancelled', `message ${id} was handed back before a turn took it`)));

    return landed;
  }

  /** Its state once settled or none. A change here wakes a fresh read; the wake is never the answer, so a client
   *  that lost its connection asks again (`reacquire` is this call, repeated). */
  async awaitSend(id: string): Promise<SendState> {
    return await this.untilSend(id, (state) => (state.status === 'settled' || state.status === 'none' ? state : undefined));
  }

  /** The first answer `decide` gives `id`'s send state, read afresh each time a claim or a send moves. */
  private async untilSend<T>(id: string, decide: (state: SendState) => T | undefined): Promise<T> {
    for (;;) {
      const moved = Promise.withResolvers<void>();
      const unobserve = this.actorSession.claims.observe(moved.resolve);

      this.sendsMoved.add(moved.resolve);

      try {
        const decided = decide(await this.sendState(id));

        if (decided !== undefined) return decided;
        await moved.promise;
      } finally {
        unobserve();
        this.sendsMoved.delete(moved.resolve);
      }
    }
  }

  /** Woken whenever a turn ends or a send is handed back: what claim changes do not show. */
  private readonly sendsMoved = new Set<() => void>();

  private wakeSendWaiters(): void {
    for (const wake of this.sendsMoved) wake();
  }

  /** An id already landed or reserved would send the same words twice. */
  private refuseUnusableId(id: string): void {
    if (!v.is(MessageIdSchema, id)) throw new KinuError('bad_input', 'A message id is 1 to 128 characters.');

    if (this.transcript.has(id) || this.pendingSends.has(id)) {
      throw new KinuError('bad_input', `message ${id} was already sent`);
    }
  }

  /** Resolves once the words are reserved and owed a landing; a `landing` is registered before the message can move. */
  async admit(
    input: string | { text: string; files: ReadonlyArray<PromptFile> },
    opts: SendOptions | CardSend,
    landing: SendLandingWaiter | null = null,
  ): Promise<void> {
    this.refuseUnusableId(opts.id);
    const card = 'metadata' in opts ? opts : undefined;
    const { text, files } = normalizePromptInput(input);

    // The operator spoke: the reminder count starts over.
    this.taskReminders.noteUserPrompt();

    // Empty and unattached is refused at the door.
    if (text.trim() === '' && (files === undefined || files.length === 0)) {
      throw new KinuError('bad_input', 'send requires the message text');
    }

    if (card === undefined && this.turnInFlight()) {
      const { id } = opts;
      const steer: UserSteer & { readonly id: string; readonly mode?: WorkMode } = { text, id, ...(opts.mode !== undefined && { mode: opts.mode }) };

      if (files !== undefined && files.length > 0) Object.assign(steer, { files });

      if (landing !== null) this.landings.set(id, landing);
      const outcome = await this.actorSession.send(steer);

      if (outcome === 'mid-turn' || outcome === 'queued') return;
      this.landings.delete(id);
      throw new KinuError('unavailable', 'The message could not be handed to the running turn. Send it again.');
    }

    const mode = opts.mode ?? 'build';

    const metadata: JsonObject = {
      ...card?.metadata,
      ...(opts.tier !== undefined && { profile_tier: opts.tier }),
      ...(opts.mode !== undefined && { kinuMode: opts.mode }),
    };

    // The pending_steers insert runs before the pump can begin the turn.
    const pendingSendId = opts.id;
    const turnId = opts.id;

    if (landing !== null) this.landings.set(turnId, landing);
    this.pendingSends.reserve({ id: pendingSendId, turnId: null, mode, text, files, ...(card !== undefined && { metadata: card.metadata }) });
    this.queue.push(tagged({
      text, files, metadata, kind: 'user',
      turnId, pendingSendId,
      settle: (failure) => {
        // A failure takes the reservation with it, or the words would be re-delivered after the caller was told no.
        if (failure) this.pendingSends.retire([pendingSendId]);
        this.settleLandings([turnId], failure ?? 'turn');
      },
    }));
    this.pump();
  }

  private settleLandings(ids: readonly string[], fate: SendLanding | KinuError): void {
    for (const id of ids) {
      const landing = this.landings.get(id);

      if (landing === undefined) continue;
      this.landings.delete(id);

      if (fate instanceof KinuError) landing.reject(fate);
      else landing.resolve(fate);
    }
  }

  /**
   * Stop (design v3 C): queued programmatic turns and the delivered signals the running turn holds are cancelled, the
   * person's unread words handed back, and the turn aborted. `cutoff` is the producer's: nothing it committed at or below
   * it is taken after, even once new input wakes the agent again.
   */
  interrupt(cutoff?: { readonly producer: InputProducer; readonly seq: number }): string[] {
    this.abandonQuestions();
    this.cancelQueued();

    // Taken by the pump, its execution not yet claimed: no lease is there to abort, so its driver reads this.
    if (this.taken !== null) this.taken.cut ??= new KinuError('cancelled', 'The agent was stopped before this turn ran.');
    this.runningRun?.controller.abort(new KinuError('cancelled', 'the agent was stopped'));
    const opened = this.handBackOpeningWords();
    const { steers, cancelled } = this.actorSession.interrupt();
    // The returned words' reservation is spent, or a restart would re-deliver them.
    const ids = steers.flatMap((steer) => steer.id === undefined ? [] : [steer.id]);

    this.transaction(() => {
      this.pendingSends.retire(ids);

      // What the turn held of its deliveries is cancelled with it: no restart runs it either.
      for (const id of cancelled) this.pendingSends.retireTurn(id);

      if (cutoff !== undefined) this.pendingSends.cut(cutoff.producer, cutoff.seq);
    });
    this.settleLandings(ids, new KinuError('cancelled', 'The turn was stopped before the agent read this message; it is back in the composer.'));
    this.wakeSendWaiters();

    if (cancelled.length > 0) diagnostics.event('turn.delivered_signals_cancelled', { count: cancelled.length });

    return [...opened, ...steers.map((steer) => steer.text)];
  }

  /**
   * A person's words sent while the turn the pump took was opening, before its execution began: no turn ran to steer, so
   * they were queued as a turn of their own. A Stop then hands them back with the turn's unread steers; words queued
   * before it was taken wait their turn as ever.
   */
  private handBackOpeningWords(): string[] {
    if (this.taken === null || this.actorSession.inFlight) return [];
    const sent = this.queue.filter((item) => item.kind === 'user' && item.continuation === undefined && !this.queuedAtTake.has(item));

    if (sent.length === 0) return [];
    this.queue.splice(0, this.queue.length, ...this.queue.filter((item) => !sent.includes(item)));

    for (const item of sent) item.settle(new KinuError('cancelled', 'The turn was stopped before the agent read this message; it is back in the composer.'));

    return sent.map((item) => item.text);
  }

  /** A Stop's cutoff on what waits behind the turn: each queued programmatic turn is cancelled unrun and its producer
   *  answered so. A person's queued words are not, as {@link interrupt} hands them back. */
  private cancelQueued(): void {
    const cancelled = this.queue.filter((item) => item.kind === 'programmatic');

    if (cancelled.length === 0) return;
    this.queue.splice(0, this.queue.length, ...this.queue.filter((item) => item.kind !== 'programmatic'));

    const failure = new KinuError('cancelled', 'The agent was stopped before this turn ran.');

    for (const item of cancelled) {
      // Its caller waits on the work, not on a turn: told, as of a turn that never opened. A run's end is its telling.
      this.settleItem(item, failure, { tellCaller: true });
    }

    diagnostics.event('turn.queued_cancelled', { count: cancelled.length });
  }

  /** Unseen steers stay queued and rerun; {@link interrupt} hands them back instead. */
  stop(): void {
    this.abandonQuestions();
    this.actorSession.stop();
  }

  /** The owner's answer: the asking call's result, and the turn that continues from it, owed once its step's every
   *  question has closed. */
  answerQuestions(id: string, answers: readonly OwnerAnswer[]): Effect.Effect<void, KinuError> {
    return Effect.andThen(this.actorSession.questions.answer(id, answers), Effect.sync(() => { this.resumeAnswered(); }));
  }

  /** `id`'s questions closed unanswered: the agent reads that, and a sibling's answer may now be resumed. */
  dismissQuestions(id: string): number {
    const closed = this.actorSession.questions.close('dismissed', id).length;

    this.resumeAnswered();

    // What waited behind the questions may run now.
    if (closed > 0) this.pump();

    return closed;
  }

  /**
   * Whether a queued item's obligation still stands at dequeue: its host's (a plan's handoff), and for an answer's
   * turn, its asking turn's resume, which a Stop, a clear or the owner's message may have retired since it queued.
   */
  private stillOwed(item: QueueItem): boolean {
    if (!this.ports.stillOwed(item.metadata)) return false;

    if (item.tags.event !== OWNER_ANSWER_SIGNAL) return true;
    const asked = item.tags.askTurn;

    return this.actorSession.questions.owedResumes().some((owed) => owed.turnId === asked);
  }

  /** A Stop, a clear or a walk-back: nothing the agent asked is waited on or resumed; what waited behind it may run. */
  private abandonQuestions(): void {
    if (this.actorSession.questions.abandon() > 0) this.pump();
  }

  /** Only a running turn keyed under `prefix`. */
  stopIfRunning(prefix: string): void {
    if (this.runningAnnouncement?.startsWith(prefix) === true) this.stop();
  }

  /** The owner's Retry as its intent delivers it (D6): `messageId`, the newest message they saw, must still be the newest.
   *  Queued here, its turn tells its own end; nothing waits on it, so the delivery that carried it answers at once, with
   *  the turn it reopened. */
  private retryTurn(id: string, messageId: string, took: (result: IntentResult) => void): Effect.Effect<IntentResult, KinuError> {
    return Effect.flatMap(this.reopenForRetry(messageId), (turnId) => {
      const result: IntentResult = { kind: 'retry', turnId };

      // Held as the reopened turn's own row under its intent's id, committed with its marker before the turn is queued:
      // a process that dies before the turn opens runs it on restart (`restoreChat`); its opening retires the row.
      return Effect.as(this.queueRetried(turnId, { id, commit: (text, metadata) => {
        this.transaction(() => {
          this.pendingSends.reserveTurn({ id, text, metadata: { kinuEvent: RETRIED_TURN_EVENT, retryOf: turnId, retried: metadata ?? null } });
          took(result);
        });
      } }), result);
    });
  }

  /**
   * The newest turn, reopened: its opener's id. `seen` must still be the newest message. A turn that
   * answered is asked again from what it had when the owner last spoke, its answer withdrawn from the transcript and the
   * model's context alike; a failed or stopped turn keeps the steps it completed, and its Retry continues them.
   */
  private reopenForRetry(seen: string): Effect.Effect<string, KinuError> {
    return Effect.gen({ self: this }, function* () {
      if (this.turnInFlight()) return yield* Effect.fail(new KinuError('denied', 'This turn is already running; Retry waits for it to end.'));

      if (this.transcript.newestUserId() !== seen) return yield* Effect.fail(new KinuError('bad_input', 'A newer message came since; Retry the newest one.'));
      const answer = this.newestAnswer();

      if (answer !== null) yield* this.withdrawAnswer(answer);
      const opener = this.transcript.reopenNewestTurn();

      if (opener !== null) return opener.id;
      this.reopening = false;

      return yield* Effect.fail(new KinuError('bad_input', 'There is no message to retry.'));
    });
  }

  /** The newest turn's answer, when the turn answered (its claim settled `completed`) and the answer is the last entry. */
  private newestAnswer(): { readonly turnId: string; readonly entryId: string } | null {
    const newest = this.transcript.newestTurn();

    if (newest === null || newest.answer === null) return null;
    const turnId = newest.opener.id;

    return this.actorSession.claims.read(turnId)?.outcome === 'completed' ? { turnId, entryId: newest.answer.id } : null;
  }

  /** Withdraws the answer (`ActorSession.withdrawAnswer`). Claimed against any other turn from here until the Retry is
   *  queued (`queueRetried`), or until the withdrawal fails. */
  private withdrawAnswer(answer: { readonly turnId: string; readonly entryId: string }): Effect.Effect<void, KinuError> {
    this.reopening = true;

    return attemptInItsWords('io', async () => {
      await this.actorSession.withdrawAnswer(this.sessionId, answer, () => (this.running() ? Effect.fail(new KinuError('denied', REVERT_NEEDS_IDLE)) : Effect.void));
      // Its open questions were the withdrawn answer's.
      this.abandonQuestions();
      this.emit({ type: 'history-reverted', entryId: answer.entryId });
    }).pipe(Effect.tapError(() => Effect.sync(() => { this.reopening = false; })));
  }

  /** A retried turn, run as that turn again under its own id: its end answers the opener's words too, should they still
   *  be owed. `heldAs` is the Retry's held input, retired as it runs. */
  private retriedItem(turnId: string, text: string, metadata: JsonObject | undefined, heldAs: string | undefined): QueueItem {
    return tagged({
      text, kind: 'user', turnId, pendingSendId: turnId, ...(metadata !== undefined && { metadata }), ...(heldAs !== undefined && { heldAs }),
      settle: (failure) => { this.settleLandings([turnId], failure ?? 'turn'); },
    });
  }

  /** Held until the turn is queued, which then holds it: no tick between the two leaves the session idle. `held`: the row
   *  an intent's Retry holds it under, committed before it is queued, which its opening retires. */
  private queueRetried(turnId: string, held?: { readonly id: string; readonly commit: (text: string, metadata: JsonObject | undefined) => void }): Effect.Effect<void, KinuError> {
    this.reopening = true;

    return Effect.gen({ self: this }, function* () {
      const message = yield* attemptInItsWords('unavailable', () => this.transcript.message(turnId));
      const metadata = yield* attemptInItsWords('unavailable', () => this.transcript.metadata(turnId));
      const text = message?.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('') ?? '';

      if (held !== undefined) yield* inItsWords('io', Effect.sync(() => { held.commit(text, metadata); }));
      this.queue.push(this.retriedItem(turnId, text, metadata, held?.id));
      this.pump();
    }).pipe(
      // A read that failed queued nothing: its landing goes with it, so no caller waits on a turn that never runs.
      Effect.tapError((failure) => Effect.sync(() => { this.settleLandings([turnId], failure); })),
      Effect.ensuring(Effect.sync(() => { this.reopening = false; })),
    );
  }

  /** Queue and running turn define "in flight"; delivery is awaited so the redraw precedes the answer. With
   *  `computer`, a chat-only rewind: the agent is told what stands on it (`rewind-notice.ts`). */
  async revertTo(entryId: string, computer?: RewindComputer): Promise<void> {
    await this.actorSession.revertConversation(this.sessionId, entryId, () => this.turnInFlight() ? Effect.fail(new KinuError('denied', REVERT_NEEDS_IDLE)) : Effect.void, computer);
    // An open question's call, or an answered one not yet resumed, ends the conversation: a walk-back removes it.
    this.abandonQuestions();
    this.emit({ type: 'history-reverted', entryId });
    await this.flushEvents();
  }

  /** Resolves once the emptied request is measured, with why not if the measure failed; the clear itself stands. */
  async clear(): Promise<KinuError | null> {
    await this.actorSession.clearConversation(this.sessionId, () => this.turnInFlight() ? Effect.fail(new KinuError('denied', CLEAR_NEEDS_IDLE)) : Effect.void);
    this.abandonQuestions();

    return this.measureCleared();
  }

  /** Every client's number after a clear comes from here: the gate's measure of the emptied request. */
  measureCleared(): Promise<KinuError | null> {
    return this.revise(() => settleEffect(Effect.match(
      attemptInItsWords('unavailable', () => this.measureNextRequest({ counted: true, trigger: 'auto' })),
      {
        onSuccess: () => null,
        // Recorded, so every client and every reload reads no number rather than the cleared conversation's.
        onFailure: (failure) => {
          this.eventRecorder.emit(WORKSPACE_RUN_ID, { type: 'context_admitted', tokens: null, contextWindow: null });

          return failure;
        },
      },
    )));
  }

  reviseContext(options: { readonly counted: boolean }): void {
    this.actorSession.orchestrator.track(this.revise(() => this.measureContextRevision(options)), 'measuring the revised context');
  }

  /** A failed fold leaves the conversation as it was and arms nothing; a turn sent meanwhile waits. */
  compact(): Promise<CompactOutcome> {
    return this.revise(() => settleEffect(Effect.result(this.fold())))
      .then((outcome) => settleEffect(Result.isSuccess(outcome) ? Effect.succeed(outcome.success) : Effect.fail(outcome.failure)));
  }

  /** One revision at a time, so a turn's own measure is the newer; `run` settles its failure, so this never rejects. */
  private revise<T>(run: () => Promise<T>): Promise<T> {
    const ran = (this.revision ?? Promise.resolve()).then(run);
    const revision = ran.then(() => undefined);
    this.revision = revision;

    return ran.then((value) => {
      if (this.revision === revision) this.revision = null;

      return value;
    });
  }

  /** A model that compacts server-side folds on its provider, so the next request is armed to ask it to. */
  private fold(): Effect.Effect<CompactOutcome, KinuError> {
    return this.turnOwed
      ? Effect.fail(new KinuError('denied', COMPACT_NEEDS_IDLE))
      : attempt(
        { doing: 'folding the conversation into a summary', otherwise: 'unavailable' },
        async (): Promise<CompactOutcome> => {
          const { measured, chat, sessionKey } = await this.measureNextRequest({ counted: true, trigger: 'user' });

          if (serverCompactor(chat.modelSpec) === null) return 'folded';

          if (measured === null || measured.tokens < SERVER_COMPACTION_MIN_TOKENS) return 'nothing';
          this.compactionState.armCompaction(sessionKey);

          return 'armed';
        },
      );
  }

  /** Register before admitting input; a one-shot opening only waits for its restored history. */
  measureSessionStart(options: { readonly restored?: Promise<unknown>; readonly measure?: boolean } = {}): void {
    const { restored = Promise.resolve(), measure = true } = options;

    this.actorSession.orchestrator.track(this.revise(() => settleEffect(Effect.gen({ self: this }, function* () {
      const history = yield* Effect.result(attempt({ doing: 'restoring working history', otherwise: 'io' }, () => restored));

      if (Result.isFailure(history)) {
        diagnostics.failure('orchestrator.detached_work_failed', history.failure, { work: 'restoring working history' });

        return;
      }

      if (!measure) return;
      const { provider, gate } = this.eventRecorder.readContextMeasures();

      if (provider === null && gate === null && this.actorSession.history.length === 0) yield* this.revisionMeasure({ counted: false });
    }))), 'measuring the start-up context');
  }

  measureContextRevision(options: { readonly counted: boolean }): Promise<void> {
    return settleEffect(this.turnOwed ? Effect.void : this.revisionMeasure(options));
  }

  private revisionMeasure(options: { readonly counted: boolean }): Effect.Effect<void> {
    return attempt(
      { doing: 'measuring the next request after the context changed', otherwise: 'unavailable' },
      () => this.measureNextRequest({ ...options, trigger: 'auto' }),
    ).pipe(Effect.catch((failure) => Effect.sync(() => { diagnostics.failure('context.revision_measure_failed', failure); })));
  }

  private async measureNextRequest(options: { readonly counted: boolean; readonly trigger: CompactionTrigger }) {
    const { execution, profile, sessionKey } = await this.ports.composeRequest();
    const { countInputTokens, ...uncounted } = execution.chat;
    const counted = options.counted && countInputTokens !== undefined ? { ...uncounted, countInputTokens } : uncounted;
    const measured = await this.actorSession.measureNextRequest({ ...execution, chat: { ...counted, transformTrigger: options.trigger } }, profile);

    if (measured !== null) this.eventRecorder.emit(WORKSPACE_RUN_ID, { type: 'context_admitted', ...measured });

    return { measured, chat: execution.chat, sessionKey };
  }

  /** Bypasses the debounce, for a batch tick that ends the session right after. Interactive sessions keep the debounced path. */
  async flushPendingDrains(): Promise<void> {
    if (this.ended) return;
    // Gated here too, because the drain binds rows on its way to the pump.
    const refusal = this.ports.driverGate();

    if (refusal) {
      diagnostics.event('driver.drain_deferred', { reason: refusal.reason });

      return;
    }

    await this.actorSession.orchestrator.drainPendingEvents();
  }

  /** Once at startup, before the recovery drain; see {@link NO_STRANDED_DELIVERY_GRACE}. Answered deliveries' leases are already closed. */
  reclaimStrandedEventDeliveries(): void {
    const reclaimed = this.eventLog.unbindStale(NO_STRANDED_DELIVERY_GRACE);

    if (reclaimed.length === 0) return;
    diagnostics.event('event.deliveries_reclaimed', { count: reclaimed.length });
    this.emit({
      type: 'background',
      event: 'events_reclaimed',
      message: `${reclaimed.length} event delivery/ies were bound to a turn a previous process did not finish: re-queued`,
    });
  }

  emit(event: SessionEvent): void {
    // A listener's throw must not kill the loop; stderr is the one channel left.
    const failed = (cause: KinuError): void => {
      diagnostics.failure('session.event_listener_failed', cause, { eventType: event.type });
    };

    const settle = async (delivered: Promise<void>): Promise<void> => {
      try {
        await delivered;
      } catch (cause) {
        failed(toKinuError({ doing: 'delivering a session event to the frontend listener', cause, otherwise: 'io' }));
      }
    };

    // Only the newest link clears the chain: an older one settling must not let the next event past the ones still owed.
    const chain = (link: Promise<void>): void => {
      const head = link.finally(() => { if (this.delivery === head) this.delivery = null; });

      this.delivery = head;
    };

    if (this.delivery !== null) {
      chain(settle(this.delivery.then(() => this.transport.deliver(event))));

      return;
    }

    try {
      const delivered = this.transport.deliver(event);

      if (delivered instanceof Promise) chain(settle(delivered));
    } catch (cause) {
      failed(toKinuError({ doing: 'delivering a session event to the frontend listener', cause, otherwise: 'io' }));
    }
  }

  async flushEvents(): Promise<void> {
    while (this.delivery !== null) await this.delivery;
  }

  /** Idempotent; the active run's promise is tracked for settleBackgroundWork(). */
  pump(): void {
    if (this.pumpActive) return;
    this.pumpActive = true;
    this.ports.owed?.();
    const running = this.runPump();

    // Assigned only while running: reinstating a resolved promise would spin settleBackgroundWork forever.
    if (this.pumpActive) this.activePump = running;
  }

  private async runPump(): Promise<void> {
    let deferred = false;

    try {
      for (;;) {
        // Before the item leaves the queue, so it still counts as in flight to a message sent meanwhile; and so the
        // turn's own measure is the newer.
        await this.revision;

        // Closed: its actor may be released, and what is still queued stays owed to the next process.
        if (this.ended) break;
        const reaskAt = this.reaskDeferredTo();

        // The re-opened turn waits out its backoff, and the wake that ends it asks again ({@link reaskDue}).
        if (reaskAt !== null) {
          deferred = true;
          diagnostics.event('turn.reask_deferred', { turn: this.queue[0]?.turnId ?? 'unnamed', dueInMs: reaskAt - Date.now() });
          await this.ports.armTurnWake?.(reaskAt);
          break;
        }

        const item = this.nextRunnable();

        if (item === undefined) break;
        this.taken = item;
        this.queuedAtTake = new Set(this.queue);
        // Checked per item, immediately before the turn runs. A refusal settles the item, so its producer
        // compensates.
        const refusal = this.ports.driverGate();

        if (refusal) {
          diagnostics.event('driver.turn_deferred', { kind: item.kind, reason: refusal.reason });
          this.settleItem(item, refusedLanding(refusal));
          continue;
        }

        if (!this.stillOwed(item)) {
          diagnostics.event('turn.no_longer_owed', {
            signal: item.tags.event ?? 'unknown',
          });
          this.settleItem(item, null, { yielded: true });
          continue;
        }

        // Checked at dequeue: somebody spoke first, so the offer is consumed.
        if (await this.offerYields(item)) {
          this.settleItem(item, null, { yielded: true });
          continue;
        }

        this.runningAnnouncement = item.idempotencyKey ?? null;
        const { failure, abandoned } = await this.runTaken(item);

        await this.flushEvents();
        this.runningAnnouncement = null;
        this.taken = null;
        this.queuedAtTake = new Set();
        // One that opened owed its caller's report with its end; one that never opened owes it as its held row retires.
        this.settleItem(item, failure, { ...(abandoned !== null && { abandoned }), tellCaller: true });
      }
    } finally {
      // Cleared synchronously, not in .finally(): the microtask would leave `pumping` stale and orphan a queued turn.
      this.pumpActive = false;
      this.activePump = null;

      if (!deferred) this.ports.quiet?.();
    }
  }

  /** The taken item, run to its end: the failure its producer is told, and the answer it abandoned. Never throws: a
   *  started turn always terminates, with exactly one `turn-end` and a closed run, even when assembly throws. */
  private async runTaken(item: QueueItem): Promise<{ readonly failure: KinuError | null; readonly abandoned: string | null }> {
    let opened = false;

    try {
      // A Stop that came as the pump took it: its end is the Stop, unrun.
      if (item.run !== undefined) return { failure: item.cut ?? await this.runDelivered(item.run), abandoned: null };
      const opening = await this.openTurn(item);

      opened = true;

      return { failure: null, abandoned: await this.actorSession.orchestrator.withTurnLearning(() => this.runOpenedTurn(item, opening)) };
    } catch (err) {
      diagnostics.failure(
        'turn.processing_failed',
        toKinuError({ doing: 'processing a queued turn', cause: err, otherwise: 'io' }),
      );

      // Nothing reached the caller before the open, so a failure there goes to it in its own words.
      return { failure: opened ? null : new KinuError(classifyErrorCode({ cause: err }) ?? 'io', renderThrownChain({ cause: err }), { cause: err }), abandoned: null };
    }
  }

  /**
   * The next item to run. A question to the owner holds the agent as a call to them would: while one is open, only the
   * owner's message, an answer's turn or the asking turn re-opened runs, ahead of the work it holds, which keeps its order.
   */
  private nextRunnable(): QueueItem | undefined {
    const runs = (item: QueueItem): boolean => item.kind === 'user' || item.continuation !== undefined || item.tags.event === OWNER_ANSWER_SIGNAL;
    const head = this.queue[0];

    if (head === undefined || runs(head) || !this.actorSession.questions.hasOpen()) return this.queue.shift();
    const at = this.queue.findIndex(runs);

    return at < 0 ? undefined : this.queue.splice(at, 1)[0];
  }

  /** When the queue's head is a re-opened turn still inside its backoff, on a host whose wake can end it: that end. */
  reaskDeferredTo(): number | null {
    const reaskAt = this.queue[0]?.continuation?.reaskAt ?? null;

    return reaskAt !== null && this.ports.armTurnWake !== undefined && reaskAt > Date.now() ? reaskAt : null;
  }

  /** The wake a deferred re-ask armed: the pump asks it if its backoff is over, and defers it again if not. */
  reaskDue(): void {
    if ((this.queue[0]?.continuation?.reaskAt ?? null) !== null) this.pump();
  }

  /** Appended, not unshifted, so it verifies final state; kicked because a startup replay has no pump yet. `metadata`
   *  is what the person's card says the turn was about, beside its event. */
  appendOwedTurn(input: { text: string; idempotencyKey: string; event: string; metadata?: JsonObject }): void {
    this.queue.push(tagged({
      text: input.text,
      kind: 'programmatic',
      idempotencyKey: input.idempotencyKey,
      metadata: { ...input.metadata, kinuEvent: input.event },
      settle: () => {},
    }));
    this.pump();
  }

  /**
   * The run's close, written in the commit that ends its turn ({@link endTurn}): its claim's verdict and its run's end.
   * The returned call marks both closed here once that commit holds; until then nothing here says the run closed, so a
   * commit that rolls back leaves it open on both sides. Takes the name: `classifyRunEnd` runs once per turn, so a Stop
   * seals `aborted` on both backends.
   */
  private closeTurnRunIn(end: RunEndClassification, lease: ActorTurnLease): () => void {
    // Settled before the early return, under the same name as the run.
    const claimClosed = this.actorSession.claimOpen(lease) ? this.actorSession.closeTurnClaim(lease, end.reason) : null;
    const { runId } = this;

    if (!runId) return () => { claimClosed?.(); };

    const { ledgers } = this.actorSession.orchestrator.acc;

    const outcome: Parameters<typeof closeTurnRun>[2] = {
      turnIndex: this.actorSession.orchestrator.sessionTurnIndex,
      usage: this.actorSession.orchestrator.acc.reportedUsage(),
      context: ledgers.context,
      files: ledgers.files,
      escalations: ledgers.escalations,
      steering: this.actorSession.orchestrator.steering.snapshot(),
      completionGate: this.completionGate.pending,
      craft: ledgers.craft.snapshot(),
      recoveries: this.actorSession.orchestrator.recoverySnapshot(),
      reason: end.reason,
    };

    if (end.error) outcome.error = end.error;
    closeTurnRun(this.eventRecorder, runId, { ...outcome, workMode: this.actorSession.workMode });

    return () => {
      claimClosed?.();

      if (this.runId !== runId) return;
      this.runId = null;
      this.completionGate.taken();
    };
  }

  /** Through the announced start. */
  private async openTurn(item: QueueItem): Promise<OpenedTurn> {
    const { event, mode } = item.tags;
    // Decided here, not at persist: mid-turn effect claims are keyed to it.
    this.turnId = item.kind === 'programmatic'
      ? `${PROGRAMMATIC_MESSAGE_ID_PREFIX}${item.idempotencyKey ?? crypto.randomUUID()}`
      : item.turnId ?? crypto.randomUUID();
    // Minted with the turn; a re-opened turn keeps the id it was streaming under.
    this.messageId = item.continuation?.messageId ?? this.mintAnswerId();

    this.runId = item.continuation?.runId ?? `run-${crypto.randomUUID()}`;
    const message = await this.actorSession.withUploads(turnInputMessage(item));
    const inputReference = await this.actorSession.canonical.admitInput({ id: this.turnId, turnId: this.turnId, message, assertOwner: () => this.actorSession.runtime.actor.assertCurrent() });
    const { questions } = this.actorSession;

    // The owner wrote instead of choosing: their message answers the open questions, and the answers given ride it.
    if (item.kind === 'user' && questions.mayWait()) {
      questions.close('in_chat');
      questions.retireResumes();
    }

    this.resumingAsk = event === OWNER_ANSWER_SIGNAL ? item.tags.askTurn ?? null : null;

    const metadata = authoredTurnMetadata(item);

    const opening = await this.transcript.prepareUser({ id: this.turnId, turnId: this.turnId, runId: this.runId, message: inputReference, metadata });

    this.openingRow = item.kind === 'programmatic' ? opening : null;

    if (item.kind === 'user') {
      // A rerun carrying several sends publishes each under its own id, over the one input they were joined into.
      const entries = item.sends !== undefined && item.sends.length > 1
        ? await this.transcript.prepareSteers({ rows: item.sends.map((send) => ({ ...send, atStep: 0, metadata })), reference: inputReference, turnId: this.turnId, runId: this.runId })
        : [opening];

      for (const entry of entries) this.transcript.appendUser(entry);
    }

    this.emit({
      type: 'turn-start', kind: item.kind, text: item.text, event, authorship: item.tags.authorship, workMode: mode, turnId: this.turnId, messageId: this.messageId,
      carried: (item.steerIds ?? []).filter((id) => id !== this.turnId), finishedSteps: item.continuation?.finishedSteps ?? 0, runId: this.runId,
    });

    return { event, mode, turnId: this.turnId, runId: this.runId };
  }

  /**
   * Null once the turn answered; the reason when it ended before it could. Driven as every execution is
   * ({@link driveExecution}): the turn supplies its opening, its assembly and the projection of its result.
   */
  private async runOpenedTurn(item: QueueItem, { event, mode, turnId, runId }: OpenedTurn): Promise<string | null> {
    // A re-opened turn continues its run; only a new turn opens one.
    if (this.reopenedRunId === this.runId) this.reopenedRunId = null;
    let unanswered: string | null = null;

    await driveExecution<ChatRound>(this.actorSession, {
      runId, turnId, mode, ...(item.metadata !== undefined && { metadata: item.metadata }),
      // A Stop that came after the pump took it, before its claim: it ends here, unrun.
      isAborted: () => item.cut !== undefined,
      within: (body) => runOperationProfile(null, () => runWorkModeInvocation(mode, body)),
      open: async (lease) => {
        // A held Retry's row goes with its opening: a later process re-opens the run, never the Retry again.
        if (item.continuation === undefined) this.transaction(() => {
          openTurnRun(this.eventRecorder, runId, {
            agentId: lease.actorId,
            causedBy: event ?? 'chat',
            userMessage: item.text,
            turnIndex: this.actorSession.orchestrator.sessionTurnIndex,
            // Enough for the next process to re-open the same turn.
            turn: {
              // Its author stamped, as its opening row is.
              turnId, messageId: this.messageId, kind: item.kind, text: item.text, metadata: authoredTurnMetadata(item),
              ...(item.pendingSendId !== undefined && { pendingSendId: item.pendingSendId }),
              ...(item.steerIds !== undefined && { steerIds: item.steerIds }),
            },
          });

          if (item.heldAs !== undefined) this.pendingSends.retireTurn(item.heldAs);
        });

        // Armed at the synchronous open, at the recovery ceiling; soonest-wins.
        await this.ports.armTurnWake?.(Date.now() + RECOVERY_BACKOFF_CEILING_MS);

        // A run a dead process left goes on only if recovery says so; any other ends here as a Stop ends it.
        if (item.continuation !== undefined) await this.actorSession.resumeOrClose(lease);
      },
      assemble: (round) => this.assembleTurn(item, round),
      project: async ({ lease, assembled, outcome }) => ({ claim: await this.projectTurn(item, event, lease, { round: assembled, execution: outcome }), stop: true }),
      // Stopped as it opened, or closed by its recovery: it ran nothing, and ends as an interrupted turn does.
      stopped: async ({ lease, outcome }) => {
        this.turnTrial = null;
        await this.projectTurn(item, event, lease, { round: null, execution: outcome });
      },
      failed: async ({ lease, failure }) => {
        const message = renderThrownChain({ cause: failure });
        const interrupted = lease.signal.aborted || item.cut !== undefined;
        // Its caller's report rides its end's commit: a turn cut off by a Stop owes none.
        const told = interrupted ? null : this.callerReport(item, message);

        const reason = await this.failTurn(lease, message, {
          interrupted, turn: () => this.snapshotTurn(item, ''), close: (end) => this.endFailed(item, lease, end, told),
        });

        unanswered = interrupted ? null : message;

        return reason;
      },
    });

    return unanswered;
  }

  /** The delivery turns this turn answered: every absorbed signal's reply turn, and the drained delivery it ran for. */
  private answeredDeliveries(item: QueueItem): ReadonlySet<string> {
    const answered = new Set(this.actorSession.orchestrator.inbox.answeredDeliveries);
    const queued = item.tags.drainTurnId;

    if (queued !== undefined) answered.add(queued);

    return answered;
  }

  /** Closes each answered delivery's lease, keeping the binding that stops its re-delivery. */
  private closeEventDeliveryLeases(answered: ReadonlySet<string>): void {
    for (const turnId of answered) this.eventLog.markTurnCompleted(turnId);
  }

  private snapshotTurn(item: QueueItem, assistantResponse: string, turnId?: string | null): CompletedTurn {
    const completedTurn: Parameters<typeof snapshotCompletedTurn>[1] = {
      userMessage: item.text,
      assistantResponse,
      sessionId: this.sessionId,
      origin: item.kind,
    };

    if (turnId) completedTurn.turnId = turnId;
    const snapshot = snapshotCompletedTurn(this.actorSession.orchestrator, completedTurn);

    return this.turnTrial === null ? snapshot : { ...snapshot, trial: this.turnTrial };
  }

  /** Everything here may throw; runOpenedTurn owns what that means. */
  private async birthContext(drainTurnId: string): Promise<readonly SerializedMessage[]> {
    return await this.ports.birthContext?.(drainTurnId) ?? subordinateTurnContext(this.eventLog, drainTurnId);
  }

  private settleContext(item: QueueItem, prepared: PreparedTurn, failure: Error | null): boolean {
    const { chat } = prepared.execution;

    return settleExecutionContext({ state: this.compactionState, key: prepared.sessionKey, recorder: this.eventRecorder }, {
      runId: this.runId, failure, turnWasOverflowRetry: item.tags.event === OVERFLOW_RETRY_EVENT,
      lastPromptTokens: this.actorSession.orchestrator.acc.lastPromptTokens, historyLength: prepared.historyLength,
      contextWindow: prepared.contextWindow, model: chat.modelSpec,
    });
  }

  /** The turn's input opened, its prompt cache asked, then its assembly under the round's claim. */
  private async assembleTurn(item: QueueItem, round: ClaimedRound): Promise<ChatRound> {
    const { lease } = round;
    const input: ChatTurnInput = item;

    await this.actorSession.openTurnInput(lease, {
      item: input,
      message: await this.actorSession.withUploads(turnInputMessage(input)),
      birthContext: async (drainTurnId) => (await this.birthContext(drainTurnId)).map(inheritedAsModelMessage),
    });

    // The preparation notes this turn's request where the warming lane lives, reading its keep first: the durable counter
    // it bumps voids any armed warm, and stops a mid-turn wake from adding a refresh. So the warm the turn before armed is
    // in first.
    await this.warming;

    const prepared = await this.ports.prepareTurn(input, lease, {
      answerId: this.messageId, lastRequestAt: this.actorSession.lastRequestAt(), coldUnlessKept: this.actorSession.promptCacheCold(null),
    }, round);

    const { cacheKeptAliveUntil } = prepared;

    this.turnTrial = prepared.trial ?? null;

    const partial = item.continuation === undefined ? null : await this.actorSession.canonical.cutStep(item.continuation.openOutputs);

    if (item.continuation !== undefined && partial === 'text') {
      await this.actorSession.retractCutStep(lease, item.continuation.openOutputs);
      this.emit({ type: 'step-cut', stepIndex: item.continuation.finishedSteps + 1 });
      await this.delivery;
    }

    /** A Stop before any output leaves the operator's row alone. */
    const streamed = { output: partial !== null };

    return {
      prepared, streamed,
      input: {
        task: item.text,
        ...prepared.execution,
        cacheKeptAliveUntil,
        ...(item.continuation !== undefined && {
          resumedSteps: item.continuation.finishedSteps,
          resumedUsage: item.continuation.usage,
          resumedMidStep: partial !== null,
        }),
      },
      onEvent: (event) => {
        // Any tool result is progress on the last reminder.
        if (event.type === 'tool-result') this.taskReminders.noteToolResult();

        recordExecutionEvent(this.eventRecorder, this.runId, event);

        if (event.type === 'model-fallback') {
          this.emit({ type: 'broadcast', event: { type: 'model_fallback', message: `${event.to} took over from ${event.from}: ${event.reason}` } });
        }

        if (event.type === 'text-delta' || event.type === 'tool-call') streamed.output = true;

        if (event.type === 'text-delta' || event.type === 'reasoning-delta' || event.type === 'tool-call' || event.type === 'tool-result'
          || event.type === 'error') return this.emit(event);
      },
    };
  }

  /** The executed turn's answer, committed with its run verdict, and its settled effects: answers its claim's outcome. */
  private async projectTurn(
    item: QueueItem, eventName: string | undefined, lease: ActorTurnLease, executed: { readonly round: ChatRound | null; readonly execution: ActorExecutionResult },
  ): Promise<ClaimOutcome> {
    const answer = await this.answerOf(item, eventName, lease, executed);
    // One commit — see {@link commitTurn}.
    const commit = this.commitTurn(answer);
    const { runError } = answer;

    // Once per turn, after settling begins, outside every failure path; an answer that never reached disk
    // reports `completed: false`, so its events re-queue.
    const durable = runError === null && 'committed' in commit;
    this.actorSession.orchestrator.inbox.settle({ completed: durable });

    if (durable) this.closeEventDeliveryLeases(answer.answeredDeliveries);

    if (!('committed' in commit)) {
      diagnostics.failure('turn.persist_failed', commit.failure);
      // Its caller waits on the work: told it failed, by the commit that closes it, as any failed turn's caller is. Not
      // durable, so the terminal event carries no final answer.
      const message = renderThrownChain({ cause: commit.failure });
      const told = this.callerReport(item, message);

      return await this.failTurn(lease, message, {
        runError, turn: () => this.snapshotTurn(item, ''), close: (failed) => this.endFailed(item, lease, failed, told),
      });
    }

    return await this.settleCommitted(lease, commit.committed, answer);
  }

  /** What the executed turn commits: its answer as it lands on disk, what it owes, and how its run ended, classified once;
   *  with the turn it ran, whose prompt cache its settle may keep warm. */
  private async answerOf(
    item: QueueItem, eventName: string | undefined, lease: ActorTurnLease, { round, execution }: { readonly round: ChatRound | null; readonly execution: ActorExecutionResult },
  ): Promise<TurnCommitInput & { readonly prepared: PreparedTurn | null }> {
    const prepared = round?.prepared ?? null;
    const streamed = round?.streamed ?? { output: false };
    const fullText = execution.text;
    const interrupted = execution.interrupted;
    const runError = execution.failure === null ? null : runErrorOf(renderThrownChain({ cause: execution.failure }));
    // A turn that ran nothing measured no context to settle.
    const overflowRetry = prepared !== null && this.settleContext(item, prepared, execution.failure);

    // Classified once: the classifier also files the mid-work defect.
    const facts: RunEndFacts = {
      completed: runError === null,
      interrupted,
      ...(runError !== null && { errorText: runError }),
      lastFinishReason: this.actorSession.orchestrator.acc.lastFinishReason,
      askedOwner: this.actorSession.orchestrator.acc.askedOwner,
    };

    const end = classifyRunEnd(facts);

    const finalText = execution.claim === null ? execution.finalTextReference
      : await this.actorSession.recordTranscriptText(execution.claim, 'answer', fullText, execution.outputReferences);

    // A failed turn re-queues what it absorbed (`Inbox.settle`), so only a turn without error keeps its splices.
    const seen = runError === null ? this.actorSession.orchestrator.inbox.seenSplices() : [];
    const metadata = answerMetadata({ end, seen });

    const preparedAssistant = streamed.output || !interrupted ? await this.transcript.prepareAssistant({
      id: this.messageId, turnId: lease.turnId, runId: lease.runId, parts: execution.outputPartReferences, finalText,
      ...(metadata !== null && { metadata }),
    }) : null;

    // Read here, crossing nothing: what it owes the hirer is decided after the commit (#75).
    const turnEnd = await turnEndOf(this.actorSession.runtime.actor, item, lease.turnId, {
      ending: taskTurnEnding(runError === null, interrupted), assistantText: fullText,
      narration: () => this.transcript.narration(execution.outputPartReferences),
    });

    // A turn that is the reminder never owes another.
    const openWork = eventName === TASK_REMINDER_EVENT ? null : await this.ports.openWork();

    // Read once, before the settle that decides what re-delivers: the commit records them answered, and once it is durable
    // their leases close.
    const answeredDeliveries = this.answeredDeliveries(item);

    return {
      item, answeredDeliveries, lease, turnId: lease.turnId, event: eventName, assistantText: fullText, turnEnd, openWork,
      preparedAssistant, runError, end, trialContext: execution.admittedMessages,
      reachableTools: Object.keys(prepared?.execution.chat.tools ?? {}), overflowRetry, prepared,
    };
  }

  /** The committed turn's effects, settled by core's one state machine, then its end: answers its run's end. */
  private async settleCommitted(
    lease: ActorTurnLease, { turn, owed, transition }: CommittedTurn,
    { prepared, end, runError }: Pick<TurnCommitInput, 'end' | 'runError'> & { readonly prepared: PreparedTurn | null },
  ): Promise<ClaimOutcome> {
    try {
      // The lane decides whether the prefix is worth keeping; a turn that ran nothing kept none. Its claim and run closed
      // with its answer (`commitTurn`). Its arming is the lane's advice, not the turn's: it is in flight beside the settle,
      // sent in the answer's flush rather than a flush of its own, past the turn's end, and one that fails is logged and
      // leaves the turn as it ended.
      if (prepared !== null) {
        this.warming = settleLogged(
          'turn.cache_warm_unarmed', { doing: "arming the prompt cache's warm after the turn", otherwise: 'unavailable' }, () => this.armCacheWarm(prepared),
        );
      }

      // Core drives the settled turn's effects as one state machine; this backend supplies the bodies and
      // the fiber. The ledger already holds the roster committed with the answer.
      this.settlingDepth += 1;

      try {
        await this.ports.terminal().settle({ transition, declare: () => owed });
      }
      finally { this.settlingDepth -= 1; }

      this.emit({ type: 'turn-end', turn, turnId: lease.turnId, runId: lease.runId, epoch: this.actorSession.closeEpoch(lease) });

      return end.reason;
    } catch (err) {
      diagnostics.failure(
        'turn.finalization_failed',
        toKinuError({ doing: 'finalizing the turn', cause: err, otherwise: 'io' }),
      );

      // Its claim and run closed with its answer; the failure is the bookkeeping's. The intent row stays: the transition
      // may never have been claimed.
      return await this.failTurn(lease, renderThrownChain({ cause: err }), { runError, turn: () => turn, close: null });
    }
  }

  /** The warm replays the turn's last request to the model that served it, a fallback's where one did; no provider in
   *  the cache plan means nothing to keep warm. */
  private async armCacheWarm(prepared: PreparedTurn): Promise<void> {
    const lane = this.ports.cacheWarming;
    const cache = prepared.execution.chat.cache;
    const lastRequest = this.actorSession.orchestrator.acc.lastRequest;

    if (lane === undefined || cache?.providerId === undefined || cache.modelId === undefined) return;
    await lane.armAfterTurn({
      modelSpec: lastRequest?.fallback === undefined ? { provider: cache.providerId, modelId: cache.modelId } : parseModelSpec(lastRequest.fallback),
      retention: cache.retention ?? DEFAULT_CACHE_RETENTION,
      lastRequest,
    });
  }

  /** Answer, run verdict and frozen roster in one commit, since `resumeAll()` finds claims: an isolate that dies after it
   *  finds the turn answered and closed, never one to run again. Never throws. */
  private commitTurn(input: TurnCommitInput): TurnCommit {
    const { item, runError } = input;

    // At most one output-limit continuation: a turn is already one if queued (item stamp) or spliced
    // (absorbed signal).
    const outputContinuation = owesOutputLimitContinuation({
      completed: runError === null,
      lastFinishReason: this.actorSession.orchestrator.acc.lastFinishReason,
      turnWasContinuation: item.tags.event === OUTPUT_CONTINUATION_EVENT
        || this.actorSession.orchestrator.inbox.absorbedKinds().includes(OUTPUT_CONTINUATION_EVENT),
    });

    try {
      // One row per steer: the walk-back pivot matches individual messages. A harness turn's row carries its
      // provenance; the `programmatic:` prefix only keys idempotency.
      const { turnId } = input;
      // Minted at admission: the roster, frozen before the write, keys on it.
      const messageId = this.messageId;

      // Before the roster, so the turn that answered a gate cannot be gated again.
      if (input.event === COMPLETION_GATE_EVENT) {
        this.completionGate.settle({ toolCalls: this.actorSession.orchestrator.acc.toolCalls.length });
      }

      const status = input.end.reason;
      const turn = this.snapshotTurn(item, input.assistantText, messageId);

      // Decided where the roster is frozen, over the work read as the turn settled.
      const { openWork } = input;

      const taskReminder = openWork === null
        ? null
        : this.taskReminders.decide({
          open: openWork.tasks,
          assistantText: input.assistantText,
          workMode: this.actorSession.workMode,
          completed: runError === null,
          asyncWakePending: openWork.asyncWakePending,
        });

      // No answer row: the roster's contract is an empty id.
      const answerId = input.preparedAssistant === null ? '' : messageId;

      const owed = this.ports.owedTerminalEffects({
        turn,
        status,
        // Attribution is core's (`creditedTurnId`, orchestrator/turn-lifecycle.ts).
        credited: creditedTurnId({
          messageId: answerId, completed: runError === null, workMode: this.actorSession.workMode,
        }),
        messageId: answerId,
        userText: item.text,
        // A programmatic opening lands in this turn's commit, below: none yet is this turn's own.
        opensConversation: () => [null, turnId].includes(this.transcript.firstUserTurnId()),
        event: input.event,
        assistantText: input.assistantText,
        turnEnd: input.turnEnd,
        completed: runError === null,
        taskReminder,
        trialContext: input.trialContext,
        answeredDeliveries: input.answeredDeliveries,
        outputContinuation,
        reachableTools: input.reachableTools,
        overflowRetry: input.overflowRetry,
      });

      const transition: TerminalTransition = { turnId, messageId };

      this.endTurn({ item, lease: input.lease, end: input.end, answer: input.preparedAssistant, roster: { transition, owed } });

      return { committed: { turn, owed, transition } };
    } catch (cause) {
      // Classified at the boundary that caught it.
      return {
        failure: toKinuError({
          doing: 'committing the finished turn and the roster its answer owes',
          cause,
          otherwise: 'io',
        }),
      };
    }
  }

  /**
   * How every turn ends, answered, failed, stopped or cut: one commit holds its answer, the retirement of the words it
   * answered, its claim's verdict and its run's end, and the roster its answer owes (an answered turn's: the deliveries
   * its steps read go with it). A restart sees all of it or none, never a closed turn whose words run again or an answered
   * one that runs again. What this process holds of the close moves, and is heard, only once the commit holds; a commit
   * that fails throws, and leaves the turn open for its recovery, here and on disk.
   */
  private endTurn(ending: {
    readonly item: QueueItem;
    readonly lease: ActorTurnLease;
    readonly end: RunEndClassification;
    readonly answer: PreparedConversationEntry | null;
    /** Only an answered turn's: the effects its answer owes, and the deliveries its steps read, answered by it. */
    readonly roster: { readonly transition: TerminalTransition; readonly owed: readonly OwedEffect[] } | null;
    /** Only a failed turn's: the report its caller is owed ({@link unansweredReport}). */
    readonly told?: { readonly transition: TerminalTransition; readonly owed: OwedEffect };
  }): void {
    const { item, roster, told } = ending;
    let closed = (): void => {};

    this.transaction(() => {
      this.persist(ending.answer);
      this.pendingSends.retire([...(item.pendingSendId === undefined ? [] : [item.pendingSendId]), ...(item.steerIds ?? [])]);

      if (roster !== null) {
        for (const id of this.actorSession.orchestrator.inbox.absorbedDeliveries) this.pendingSends.retireTurn(id);
        this.ports.terminal().record(roster.transition, roster.owed);
      }

      if (told !== undefined) this.ports.terminal().record(told.transition, [told.owed]);

      closed = closeRunIn(this.eventRecorder, () => this.closeTurnRunIn(ending.end, ending.lease));
    });
    closed();
  }

  /**
   * A turn that ended on a failure, `message` its rendered chain: the session's accumulator marks it failed unless a
   * Stop cut it, its run's end is classified from its run's own error or else the failure, `close` closes what the turn
   * still owes under that end (nothing once its answer committed), and the stream hears the error, then the turn's end,
   * `turn`, read once the failure is marked and closed.
   */
  private async failTurn(
    lease: ActorTurnLease,
    message: string,
    { interrupted = false, runError = null, turn, close }: {
      readonly interrupted?: boolean;
      readonly runError?: string | null;
      readonly turn: () => CompletedTurn;
      readonly close: ((end: RunEndClassification) => Promise<void>) | null;
    },
  ): Promise<RunEndReason> {
    if (!interrupted) this.actorSession.orchestrator.acc.hadError = true;
    const end = classifyRunEnd({ completed: false, interrupted, errorText: runError ?? runErrorOf(message) });

    await close?.(end);
    // A Stop ends the turn in its one name, whatever failed under it: its tabs read that as a Stop, not a failure.
    this.emit({ type: 'error', message: end.reason === 'aborted' ? INTERRUPTED_TURN : message });
    this.emit({ type: 'turn-end', turn: turn(), turnId: lease.turnId, runId: lease.runId, epoch: this.actorSession.closeEpoch(lease) });

    return end.reason;
  }

  /**
   * A turn that ended before an answer committed: its end ({@link endTurn}) carries the failure on its answer, where a
   * reload reads it. One whose answer cannot be written still closes, without it: its room was told. A close that fails
   * even so is logged, and the turn stays open, as a death there would leave it.
   */
  private async endFailed(item: QueueItem, lease: ActorTurnLease, end: RunEndClassification, owed: OwedEffect | null = null): Promise<void> {
    let answer: PreparedConversationEntry | null = null;
    let closed = false;
    const transition: TerminalTransition = { turnId: lease.turnId, messageId: this.messageId };
    const told = owed === null ? {} : { told: { transition, owed } };

    // Without it, the turn still closes: its failure is told its room, not kept on an answer.
    if (end.error !== undefined && !this.transcript.has(this.messageId)) {
      await settleLogged('turn.failure_unrecorded', { doing: "recording the turn's failure on its answer", otherwise: 'io' }, async () => {
        const metadata = answerMetadata({ end, slates: await this.ports.failedAnswerSlates?.(lease) ?? null });

        answer = await this.transcript.prepareAssistant({
          id: this.messageId, turnId: lease.turnId, runId: lease.runId, parts: [], finalText: null, ...(metadata !== null && { metadata }),
        });
      });
    }

    const failure = answer;

    if (failure !== null) {
      settleLoggedSync('turn.failure_unrecorded', { doing: "closing a turn with its failure's answer", otherwise: 'io' }, () => {
        this.endTurn({ item, lease, end, answer: failure, roster: null, ...told });
        closed = true;
      });
    }

    if (!closed) {
      settleLoggedSync('turn.persist_failed', { doing: 'closing a turn that ended without its answer', otherwise: 'io' }, () => {
        this.endTurn({ item, lease, end, answer: null, roster: null, ...told });
        closed = true;
      });
    }

    // Its caller's report, kept with its end, is told as a roster's effects are: a death before then tells it at the next
    // start.
    if (closed && owed !== null) await this.settleTold(transition, owed);
  }

  /** Public rows contain references only; output bytes committed before this terminal transaction. */
  private persist(assistant: PreparedConversationEntry | null): void {
    if (this.openingRow !== null) this.transcript.appendUser(this.openingRow);

    // Recorded with the turn it owed: a death before leaves the answer owed, and its turn is resumed again.
    if (this.resumingAsk !== null) this.actorSession.questions.markResumed(this.resumingAsk);

    if (assistant !== null) this.transcript.appendAssistant(assistant);
  }

  // The pending-send ledger: a send is a row before the client hears it.

  /** Landed rows and spent reservations in one transaction; rows follow the opening message. */
  private async prepareLandedSteers(rows: readonly LandedSteerRow[], reference: MessageReference): Promise<(context: ContextSelection) => void> {
    const turnId = this.turnId;
    const runId = this.runId;

    if (turnId === null || runId === null) throw new KinuError('denied', 'steer publication requires an active turn');
    const opening = this.openingRow;
    const prepared = await this.transcript.prepareSteers({ rows, reference, turnId, runId });

    return context => {
      if (opening !== null && this.actorSession.landedSteers.length === 0) this.transcript.appendUser(opening);

      for (const entry of prepared) {
        this.transcript.appendUser({ ...entry, context });
        this.pendingSends.retire([entry.id]);
      }

      this.settleLandings(prepared.map((entry) => entry.id), 'mid-turn');
    };
  }

  /** The live turn, else the admitted user turn at the queue head. */
  private steerTurnId(): string | null {
    if (this.actorSession.inFlight) return this.turnId;

    return this.queue.find((item) => item.kind === 'user')?.turnId ?? this.turnId;
  }

  /** The run of the turn the last process died inside, re-opened as this session started; its own until it closes. */
  private reopenedRunId: string | null = null;

  /**
   * Sends a turn left unanswered, rerun as one user turn under its first send's id, the live inbox's and a restart's
   * alike: in acceptance order, under the narrowest of their chosen modes, with the first send's metadata.
   */
  private leftoverRerun(sends: readonly OperatorSend[], metadata: JsonObject | undefined): QueueItem {
    const steerIds = sends.map((send) => send.id);
    const files = sends.flatMap((send) => send.files ?? []);

    return tagged({
      text: sends.map((send) => send.text).join('\n\n'),
      kind: 'user',
      ...(files.length > 0 && { files }),
      metadata: { ...metadata, ...(sends.some((send) => send.mode !== undefined) && { kinuMode: narrowestMode(sends.map((send) => send.mode)) }) },
      rerun: true,
      // Opened under its first send's id; only a rerun carrying none mints one.
      turnId: steerIds[0] ?? crypto.randomUUID(),
      // Retired with this rerun's row in the same transaction.
      steerIds,
      sends: sends.map(({ id, text, files: attached }) => ({ id, text, ...(attached !== undefined && { files: attached }) })),
      settle: (failure) => {
        this.settleLandings(steerIds, failure ?? 'turn');
      },
    });
  }

  /** The working history its last activation left, restored into the actor's session: whether there was one. */
  restoreWorkingHistory(): Promise<boolean> {
    return this.actorSession.restoreWorkingHistory();
  }
}



interface PromptInputParts {
  text: string;
  files?: ReadonlyArray<PromptFile>;
}

function normalizePromptInput(
  input: string | { text: string; files: ReadonlyArray<PromptFile> },
): PromptInputParts {
  return v.is(v.string(), input) ? { text: input } : input;
}

/** What a programmatic announcement's producer is told when its turn settles. */
function settledAnnouncement(failure: KinuError | null, yielded: boolean | undefined, abandoned: string | undefined): EnqueueTurnResult {
  if (yielded === true) return { status: 'yielded' };

  if (failure !== null) return { status: 'skipped' };

  return abandoned === undefined ? { status: 'queued' } : { status: 'failed', reason: abandoned };
}

/** A failed turn's error, `message`, as its run records it. */
function runErrorOf(message: string): string {
  return message.slice(0, 500);
}
