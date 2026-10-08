/**
 * The one turn loop for both backends. One turn at a time; every started turn ends (one `turn-end`, a closed
 * run, a released lease); a mid-turn send splices in; a send is durable before acknowledged; leftovers rerun as
 * one turn; restart replays pending sends and owed effects; an interrupted turn continues once, in its run.
 */

import type { TrialTurn } from '../evolution/trial-rules';
import type { ModelMessage } from 'ai';
import * as v from 'valibot';
import { Effect, Result } from 'effect';
import type { ChatEvent } from '../chat';
import type { CompactionTrigger } from '../extension';
import { WORKSPACE_RUN_ID } from '../events/model-call';
import { runWorkModeInvocation } from '../execution/work-mode';
import type { EventLog } from '../events/hub/log';
import type { RunEventRecorder } from '../events/recorder';
import type { RunEvent } from '../events/types';
import type { CompletedTurn } from '../evolution/types';
import { attempt, attemptInItsWords, classifyErrorCode, diagnostics, KinuError, renderThrownChain, settle as settleEffect, settleLogged, toKinuError, type Refusal } from '../obs/index';
import { contextFill, type ContextFill } from '../read-models/context-fill';
import { workModeForTurnMetadata } from '../prompting/surface';
import { runOperationProfile } from '../profiles/operation';
import type { ResolvedTurnProfile } from '../profiles';
import type { CacheWarmingLane } from '../providers/cache-warming';
import { DEFAULT_CACHE_RETENTION, parseModelSpec } from '../providers/types';
import { serverCompactor, SERVER_COMPACTION_MIN_TOKENS } from '../providers/server-compaction';
import type { ToolOutcome } from '../tools/outcome';
import { OVERFLOW_RETRY_EVENT } from '../turn-failure';
import type {
  BroadcastEvent, EnqueueTurnResult, OperatorSend, ProgrammaticTurn, PromptFile,
} from '../types/backend-host';
import type { TierId } from '../types/profile';
import type { SendLanding, SettledSignals } from '../types/signals';
import type { WorkMode } from '../types/turn';
import type { JsonObject } from '../utils/json';
import type { Usage } from '../usage';
import { announcementOf, authoredTurnMetadata, PROGRAMMATIC_MESSAGE_ID_PREFIX } from '../utils/ui-message';
import { CLEAR_NEEDS_IDLE, COMPACT_NEEDS_IDLE, REVERT_NEEDS_IDLE } from './actor-session';
import type { ActorSession, ActorTurnLease, ActorExecutionInput } from './actor-session';
import { CompletionGate, COMPLETION_GATE_EVENT } from './completion-gate';
import { turnInputMessage, type LandedSteerRow, type PendingSendRow, type PendingSendStore, type UserSteer } from './inbox';
import type { OwedEffect } from './terminal-effects';
import type { TerminalTransition, TerminalTransitions } from './terminal-transition';
import {
  classifyRunEnd, closeTurnRun, creditedTurnId, openTurnRun, recordExecutionEvent, settleExecutionContext,
  owesOutputLimitContinuation, OUTPUT_CONTINUATION_EVENT, snapshotCompletedTurn,
  type CompactionTriggerState, type RunEndClassification, type RunEndFacts, type RunEndReason,
} from './turn-lifecycle';
import { answerParts, type SessionTranscript, type PreparedConversationEntry } from '../session/transcript';
import { RECOVERY_BACKOFF_CEILING_MS } from '../utils/recovery-backoff';
import type { MessageReference } from '../session/messages';
import type { ContextSelection } from '../session/context';
import { subordinateTurnContext } from '../subordinates/support';
import { taskTurnEnding, type OwedReport, type TaskTurnEnding } from '../subordinates/temporary';
import { TURN_END_METADATA_KEY, TURN_FAILURE_METADATA_KEY } from '../read-models/background-event';
import { TaskReminders, TASK_REMINDER_EVENT } from '../tasks/reminder';
import type { TaskListStore } from '../tools/task-store';
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

export type SessionEvent =
  | { type: 'turn-start'; kind: 'user' | 'programmatic'; text: string; event?: string; workMode: WorkMode;
      /** Both minted at admission. */
      turnId: string; messageId: string;
      /** A rerun answers every leftover as one turn; a transport closes their requests with it. */
      carried: readonly string[];
      /** Steps before this activation. */
      finishedSteps: number }
  | { type: 'step-cut'; stepIndex: number }
  | { type: 'text-delta'; delta: string }
  /** Shown live; never the answer, never stored. */
  | { type: 'reasoning-delta'; delta: string }
  | { type: 'tool-call'; toolName: string; toolCallId: string; args: ToolCallArguments }
  | ({ type: 'tool-result'; toolName: string; toolCallId: string; result: string } & ToolOutcome)
  | { type: 'turn-end'; turn: CompletedTurn }
  | { type: 'error'; message: string }
  | { type: 'evolution'; event: string; message: string }
  // Kept apart from `evolution`: an agent with learning off says no evolution while its jobs may still settle.
  | { type: 'background'; event: string; message: string }
  | { type: 'broadcast'; event: BroadcastEvent }
  /** The durable head moved; surfaces redraw from the store. */
  | { type: 'history-reverted'; entryId: string }
  /** Forwarded live: a container-scoped database dies with the container. */
  | { type: 'run-event'; event: RunEvent };

interface QueueItem {
  text: string;
  files?: ReadonlyArray<PromptFile>;
  metadata?: ProgrammaticTurn['metadata'];
  /** The durable row id derives from it, so a re-announcement collides with the first row (see `persist`). */
  idempotencyKey?: string;
  kind: 'user' | 'programmatic';
  /** Minted at admission, so a steer accepted while queued binds to it. */
  turnId?: string;
  /** Retired when its user row is durable. */
  pendingSendId?: string;
  /** Retired with the rerun's row, so a restart cannot re-deliver them. */
  steerIds?: readonly string[];
  /** The sends a rerun carries, each published under its own id when the turn first opens. */
  sends?: readonly OperatorSend[];
  /** Placed at the queue front, behind only earlier reruns of the same settle. */
  rerun?: true;
  /** An offer: an operator message admitted ahead settles it 'yielded' unrun. */
  yieldsToUserMessage?: boolean;
  /** Re-opened under its own ids, its prior output re-entered ahead of the remaining calls. */
  continuation?: TurnContinuation;
  /** Exactly once, and told whether the turn ran: a failure must reach the producer, the only one who can put things back.
   *  `abandoned` names why an opened turn ended before it could answer. */
  settle: (failure: KinuError | null, yielded?: boolean, abandoned?: string) => void;
}

interface TurnContinuation {
  /** The continuation appends to it, so the open run is the run that closes. */
  readonly runId: string;
  readonly messageId: string;
  readonly finishedSteps: number;
  readonly usage: Usage;
  /** The outputs the cut step left open, named before a claim seals them. */
  readonly openOutputs: readonly string[];
}



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

export interface PreparedTurn {
  readonly execution: Omit<ActorExecutionInput, 'task'>;
  readonly sessionKey: string;
  readonly contextWindow: number | null;
  readonly historyLength: number;
  /** The live trial's arm this turn ran (`turnArtifactBodies`), recorded with the completed turn. */
  readonly trial?: TrialTurn | null;
}

/** What a backend's turn assembly knows of the turn it opens: the answer's id and whether the prompt cache is cold. */
export interface TurnOpening {
  readonly answerId: string;
  readonly cacheCold: boolean;
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
  /** Decided before the commit; null when none is owed. */
  readonly owedReport: OwedReport | null;
  readonly completed: boolean;
  readonly trialContext: readonly ModelMessage[];
  /** A cold replay has no live toolset to ask. */
  readonly reachableTools: readonly string[];
  readonly overflowRetry: boolean;
  /** A backend with reply channels owes each an outbound reply. */
  readonly answeredDeliveries: ReadonlySet<string>;
  /** At most one continuation is owed. */
  readonly outputContinuation: boolean;
  readonly taskReminder: { readonly text: string } | null;
}

async function answerMetadata(
  ports: ChatSessionPorts, turnId: string, texts: () => Promise<readonly string[]>, end: RunEndClassification,
): Promise<JsonObject | null> {
  const metadata: JsonObject = {
    ...await ports.answerMetadata?.(turnId, texts),
    ...(end.reason === 'incomplete' && { [TURN_END_METADATA_KEY]: end.reason }),
    ...(end.error !== undefined && { [TURN_FAILURE_METADATA_KEY]: end.error }),
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

/** Each port is asked per call, never captured. */
export interface ChatSessionPorts {
  /** Runs after the opening row and run are durable; a throw ends the turn as an error with one `turn-end`. */
  prepareTurn(item: ChatTurnInput, lease: ActorTurnLease, opening: TurnOpening): Promise<PreparedTurn>;
  /** Never consumes an armed compaction. */
  composeRequest(): Promise<ComposedRequest>;
  owedTerminalEffects(input: OwedTerminalEffectsInput): OwedEffect[];
  answerMetadata?(turnId: string, texts: () => Promise<readonly string[]>): Promise<JsonObject | null>;
  /** The report this ending owes its caller; narration is read only if the report carries it. */
  owedReport?(ending: TaskTurnEnding, assistantText: string, narration: () => Promise<readonly string[]>): Promise<OwedReport | null>;
  /** Asked per call: the bodies close over stores built after this session. */
  terminal(): TerminalTransitions;
  /** Asked per item at dequeue and before a drain binds rows; a refusal settles the item to its producer. */
  driverGate(): Refusal | null;
  /** Called at the turn's synchronous open; soonest-wins. A backend whose process is the wake arms nothing. */
  armTurnWake(atMs: number): Promise<void>;
  /** Owed until {@link quiet}. */
  owed?(): void;
  /** The queue drained and no turn runs. */
  quiet?(): void;
  /** Read at commit, never captured earlier. */
  taskList(): TaskListStore;
  /** A reminder fired behind such work would race its wake. */
  hasPendingAsyncWake(): boolean;
  steerSkills(text: string): Promise<string | null>;
  /** Asked at dequeue; false drops the turn. */
  stillOwed(metadata: JsonObject | undefined): boolean;
  /** Where the assignment lives in another database (a facet's hirer's). */
  birthContext?(drainTurnId: string): Promise<readonly SerializedMessage[]>;
  /** The session drives it because both instants it needs are the session's; the policy is the lane's. */
  readonly cacheWarming?: CacheWarmingLane;
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
}

export interface SendOptions {
  readonly tier?: TierId;
  /** A retry with this id lands once; a rerun keeps it as its turn id. */
  readonly id: string;
  /** A turn it starts, and its leftovers' rerun, run under it. Build by default. */
  readonly mode?: WorkMode;
}

/** Its own turn; `consume` runs in reserve's transaction. */
export interface CardSend extends SendOptions {
  readonly metadata: JsonObject;
  readonly consume: () => void;
}

export type SendLandingWaiter = Pick<ReturnType<typeof Promise.withResolvers<SendLanding>>, 'resolve' | 'reject'>;

/** A caller-named message: the key its row and reservation are stored under. */
const MessageIdSchema = v.pipe(v.string(), v.nonEmpty(), v.maxLength(128));

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

  /** A Retry reserved but not yet queued. */
  private reopening = false;
  private readonly eventLog: EventLog;
  private revision: Promise<void> | null = null;
  private readonly unobserveMeasures: () => void;
  private readonly eventRecorder: RunEventRecorder;
  private readonly compactionState: CompactionTriggerState;
  private readonly transaction: <T>(body: () => T) => T;
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
    this.transport = options.transport;
    this.ports = options.ports;
    this.mintAnswerId = options.mintAnswerId;

    // Every acknowledged send is a pending_steers row first. Bound here because the hosted actor's session
    // is built without a view of this workspace's queue.
    this.actorSession.bindSteerPersistence({
      onAccept: (steer) => { this.pendingSends.reserve({ ...steer, turnId: this.steerTurnId() }); },
      prepareDrain: (rows, _atStep, reference) => this.prepareLandedSteers(rows, reference),
      turnId: () => this.steerTurnId(),
      skills: (text) => this.ports.steerSkills(text),
    });
    this.restoreOpenTurn();
    this.restorePendingSends();
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
  get closed(): boolean { return this.ended; }

  /** Non-zero while a terminal transition runs on the pump's stack, where awaiting execution would deadlock. */
  private settlingDepth = 0;

  /** Self-starts the pump when idle. A re-announcement of an already recorded fact starts no turn and answers 'queued'. */
  enqueueTurn(input: ProgrammaticTurn): Promise<EnqueueTurnResult> {
    // The operator's immediate next turn, answered at admission: its settle is on this pump's stack.
    if (input.origin === 'user') {
      const sends = input.sends ?? [];
      const steerIds = sends.map((send) => send.id);
      const files = sends.flatMap((send) => send.files ?? []);

      const item: QueueItem = {
        text: input.text,
        kind: 'user',
        ...(files.length > 0 && { files }),
        metadata: input.metadata,
        rerun: true,
        // Opened under its first send's id; only a rerun carrying none mints one.
        turnId: steerIds[0] ?? crypto.randomUUID(),
        // Retired with this rerun's row in the same transaction.
        steerIds,
        sends,
        settle: (failure) => {
          this.settleLandings(steerIds, failure ?? 'turn');
        },
      };

      // Each merged id is bound to this turn before admission; `OR IGNORE` because rerun ids already carry theirs.
      const mode: WorkMode = workModeForTurnMetadata(input.metadata) === 'plan' ? 'plan' : 'build';

      for (const send of sends) {
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

    const item: QueueItem = {
      text: input.text,
      metadata: input.metadata,
      kind: 'programmatic',
      // The signal seam compensates on anything but 'queued'. 'yielded' is consumed: nothing is retried.
      settle: (failure, yielded, abandoned) => { resolve(settledAnnouncement(failure, yielded, abandoned)); },
    };

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
  queueTurn(input: ProgrammaticTurn): Promise<EnqueueTurnResult> {
    const queued: EnqueueTurnResult = { status: 'queued' };

    // An answer decided at admission resolves first; a turn still to run answers 'queued'.
    return Promise.race([this.enqueueTurn(input), Promise.resolve(queued)]);
  }

  /** Its producer is told, and so is every caller that joined it: a turn restored after a reset has only joiners. */
  private settleItem(item: QueueItem, failure: KinuError | null, yielded?: boolean, abandoned?: string): void {
    item.settle(failure, yielded, abandoned);
    this.wakeSendWaiters();

    if (item.idempotencyKey === undefined) return;
    const result = settledAnnouncement(failure, yielded, abandoned);

    for (const joined of this.joiners.get(item.idempotencyKey) ?? []) joined(result);
    this.joiners.delete(item.idempotencyKey);
  }

  private joinAnnounced(identity: string): Promise<EnqueueTurnResult> {
    const joined = Promise.withResolvers<EnqueueTurnResult>();

    this.joiners.set(identity, [...this.joiners.get(identity) ?? [], joined.resolve]);

    return joined.promise;
  }

  announcementInFlight(identity: string): boolean {
    return this.runningAnnouncement === identity
      || this.queue.some((item) => item.idempotencyKey === identity);
  }

  announcementOnDisk(identity: string): boolean {
    return this.transcript.has(`${PROGRAMMATIC_MESSAGE_ID_PREFIX}${identity}`);
  }

  /** Settling has no next step. A queued, unopened user turn or genesis offer counts: a message behind it rides its
   *  first step, so an offer is consumed only by a message that arrived before it. */
  /** The one in-flight decision sends, Retry, Clear and Revert take: a Retry between its claim and its queue counts. */
  turnInFlight(): boolean {
    return this.reopening || this.actorSession.inFlight || this.queue.some((item) => item.kind === 'user' || item.yieldsToUserMessage === true);
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

  /** Its state once settled or none. A change here wakes a fresh read; the wake is never the answer, so a client
   *  that lost its connection asks again (`reacquire` is this call, repeated). */
  async awaitSend(id: string): Promise<SendState> {
    for (;;) {
      const moved = Promise.withResolvers<void>();
      const unobserve = this.actorSession.claims.observe(moved.resolve);

      this.sendsMoved.add(moved.resolve);

      try {
        const state = await this.sendState(id);

        if (state.status === 'settled' || state.status === 'none') return state;
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
    this.transaction(() => {
      card?.consume();
      this.pendingSends.reserve({ id: pendingSendId, turnId: null, mode, text, files, ...(card !== undefined && { metadata: card.metadata }) });
    });
    this.queue.push({
      text, files, metadata, kind: 'user',
      turnId, pendingSendId,
      settle: (failure) => {
        // A failure takes the reservation with it, or the words would be re-delivered after the caller was told no.
        if (failure) this.pendingSends.retire([pendingSendId]);
        this.settleLandings([turnId], failure ?? 'turn');
      },
    });
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

  /** Pending steers are dropped and returned so the surface can restore them. */
  interrupt(): string[] {
    const returned = this.actorSession.interrupt();
    // The returned words' reservation is spent, or a restart would re-deliver them.
    const ids = returned.flatMap((steer) => steer.id === undefined ? [] : [steer.id]);
    this.pendingSends.retire(ids);
    this.settleLandings(ids, new KinuError('cancelled', 'The turn was stopped before the agent read this message; it is back in the composer.'));
    this.wakeSendWaiters();

    return returned.map((steer) => steer.text);
  }

  /** Unseen steers stay queued and rerun; {@link interrupt} hands them back instead. */
  stop(): void {
    this.actorSession.stop();
  }

  /** Only a running turn keyed under `prefix`. */
  stopIfRunning(prefix: string): void {
    if (this.runningAnnouncement?.startsWith(prefix) === true) this.stop();
  }

  /** Reruns the newest turn as its opener (a steer is not resent); `claim` runs before any await. */
  retry(claim: (turnId: string) => void): Promise<SendLanding> {
    return settleEffect(Effect.gen({ self: this }, function* () {
      if (this.turnInFlight()) return yield* Effect.fail(new KinuError('denied', 'This turn is already running; Retry waits for it to end.'));
      const opener = this.transcript.reopenNewestTurn();

      if (opener === null) return yield* Effect.fail(new KinuError('bad_input', 'There is no message to retry.'));
      const turnId = opener.id;
      const landing = Promise.withResolvers<SendLanding>();

      this.reopening = true;
      this.landings.set(turnId, landing);
      claim(turnId);

      // Held until the turn is queued, which then holds it: no tick between the two leaves the session idle.
      yield* Effect.gen({ self: this }, function* () {
        const message = yield* attemptInItsWords('unavailable', () => this.transcript.message(turnId));
        const metadata = yield* attemptInItsWords('unavailable', () => this.transcript.metadata(turnId));

        this.queue.push({
          text: message?.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('') ?? '',
          kind: 'user', turnId, ...(metadata !== undefined && { metadata }),
          settle: (failure) => { this.settleLandings([turnId], failure ?? 'turn'); },
        });
      }).pipe(
        // A read that failed queued nothing: its landing goes with it, so no caller waits on a turn that never runs.
        Effect.tapError((failure) => Effect.sync(() => { this.settleLandings([turnId], failure); })),
        Effect.ensuring(Effect.sync(() => { this.reopening = false; })),
      );
      this.pump();

      return yield* attemptInItsWords('unavailable', () => landing.promise);
    }));
  }

  /** Queue and running turn define "in flight"; delivery is awaited so the redraw precedes the answer. */
  async revertTo(entryId: string): Promise<void> {
    await this.actorSession.revertConversation(this.sessionId, entryId, () => this.turnInFlight() ? Effect.fail(new KinuError('denied', REVERT_NEEDS_IDLE)) : Effect.void);
    this.emit({ type: 'history-reverted', entryId });
    await this.flushEvents();
  }

  /** Resolves once the emptied request is measured, with why not if the measure failed; the clear itself stands. */
  async clear(): Promise<KinuError | null> {
    await this.actorSession.clearConversation(this.sessionId, () => this.turnInFlight() ? Effect.fail(new KinuError('denied', CLEAR_NEEDS_IDLE)) : Effect.void);

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
    return this.pumpActive || this.queue.length > 0
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
    return settleEffect(this.pumpActive || this.queue.length > 0 ? Effect.void : this.revisionMeasure(options));
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

    if (this.delivery !== null) {
      this.delivery = settle(this.delivery.then(() => this.transport.deliver(event))).finally(() => { this.delivery = null; });

      return;
    }

    try {
      const delivered = this.transport.deliver(event);

      if (delivered instanceof Promise) this.delivery = settle(delivered).finally(() => { this.delivery = null; });
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
    try {
      for (;;) {
        // Before the item leaves the queue, so it still counts as in flight to a message sent meanwhile; and so the
        // turn's own measure is the newer.
        await this.revision;
        const item = this.queue.shift();

        if (item === undefined) break;
        // Checked per item, immediately before the turn runs. A refusal settles the item, so its producer
        // compensates.
        const refusal = this.ports.driverGate();

        if (refusal) {
          diagnostics.event('driver.turn_deferred', { kind: item.kind, reason: refusal.reason });
          this.settleItem(item, refusedLanding(refusal));
          continue;
        }

        if (!this.ports.stillOwed(item.metadata)) {
          diagnostics.event('turn.no_longer_owed', {
            signal: v.is(v.string(), item.metadata?.kinuEvent) ? item.metadata.kinuEvent : 'unknown',
          });
          this.settleItem(item, null, true);
          continue;
        }

        // Checked at dequeue, never admission: somebody spoke first, so the offer is consumed.
        if (item.yieldsToUserMessage === true
          && (this.queue.some((queued) => queued.kind === 'user')
            || await this.transcript.operatorSpoke())) {
          diagnostics.event('genesis.yielded_to_message', {
            signal: v.is(v.string(), item.metadata?.kinuEvent) ? item.metadata.kinuEvent : 'unknown',
          });
          this.actorSession.orchestrator.logActivity('genesis.yielded_to_message');
          this.settleItem(item, null, true);
          continue;
        }

        this.runningAnnouncement = item.idempotencyKey ?? null;
        let failure: KinuError | null = null;
        let abandoned: string | null = null;

        let opened: OpenedTurn | null = null;

        try {
          const opening = await this.openTurn(item);
          opened = opening;
          abandoned = await this.actorSession.orchestrator.withTurnLearning(() => this.runOpenedTurn(item, opening));
        } catch (err) {
          diagnostics.failure(
            'turn.processing_failed',
            toKinuError({ doing: 'processing a queued turn', cause: err, otherwise: 'io' }),
          );

          // Nothing reached the caller before the open, so a failure there goes to it in its own words.
          if (opened === null) failure = new KinuError(classifyErrorCode({ cause: err }) ?? 'io', renderThrownChain({ cause: err }), { cause: err });
        } finally {
          await this.flushEvents();
          this.runningAnnouncement = null;
          this.settleItem(item, failure, undefined, abandoned ?? undefined);
        }
      }
    } finally {
      // Cleared synchronously, not in .finally(): the microtask would leave `pumping` stale and orphan a queued turn.
      this.pumpActive = false;
      this.activePump = null;
      this.ports.quiet?.();
    }
  }

  /** Appended, not unshifted, so it verifies final state; kicked because a startup replay has no pump yet. */
  appendOwedTurn(input: { text: string; idempotencyKey: string; event: string }): void {
    this.queue.push({
      text: input.text,
      kind: 'programmatic',
      idempotencyKey: input.idempotencyKey,
      metadata: { kinuEvent: input.event },
      settle: () => {},
    });
    this.pump();
  }

  /** Idempotent per run. Takes the name: `classifyRunEnd` runs once per turn, so a Stop seals `aborted` on both backends. */
  private closeRun(end: RunEndClassification, lease: ActorTurnLease): RunEndReason {
    // Settled before the early return, under the same name as the run.
    if (this.actorSession.turnClaim !== null) this.actorSession.settleTurnClaim(lease, end.reason);

    if (!this.runId) return end.reason;

    const outcome: Parameters<typeof closeTurnRun>[2] = {
      turnIndex: this.actorSession.orchestrator.sessionTurnIndex,
      usage: this.actorSession.orchestrator.acc.reportedUsage(),
      context: this.actorSession.orchestrator.acc.context,
      files: this.actorSession.orchestrator.acc.files,
      escalations: this.actorSession.orchestrator.acc.escalations,
      steering: this.actorSession.orchestrator.steering.snapshot(),
      completionGate: this.completionGate.take(),
      craft: this.actorSession.orchestrator.craft.snapshot(),
      recoveries: this.actorSession.orchestrator.recoverySnapshot(),
      reason: end.reason,
    };

    if (end.error) outcome.error = end.error;
    closeTurnRun(this.eventRecorder, this.runId, { ...outcome, workMode: this.actorSession.workMode });
    this.runId = null;

    return end.reason;
  }

  /** A started turn always terminates: exactly one `turn-end` and a closed run, even when assembly throws. */
  /** Through the announced start. */
  private async openTurn(item: QueueItem): Promise<OpenedTurn> {
    const parsedEvent = v.safeParse(v.string(), item.metadata?.kinuEvent);
    const event = parsedEvent.success ? parsedEvent.output : undefined;
    const mode = workModeForTurnMetadata(item.metadata);
    // Decided here, not at persist: mid-turn effect claims are keyed to it.
    this.turnId = item.kind === 'programmatic'
      ? `${PROGRAMMATIC_MESSAGE_ID_PREFIX}${item.idempotencyKey ?? crypto.randomUUID()}`
      : item.turnId ?? crypto.randomUUID();
    // Minted with the turn; a re-opened turn keeps the id it was streaming under.
    this.messageId = item.continuation?.messageId ?? this.mintAnswerId();

    this.runId = item.continuation?.runId ?? `run-${crypto.randomUUID()}`;
    const inputReference = await this.actorSession.canonical.admitInput({ id: this.turnId, turnId: this.turnId, message: turnInputMessage(item), assertOwner: () => this.actorSession.runtime.actor.assertCurrent() });

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
      type: 'turn-start', kind: item.kind, text: item.text, event, workMode: mode, turnId: this.turnId, messageId: this.messageId,
      carried: (item.steerIds ?? []).filter((id) => id !== this.turnId), finishedSteps: item.continuation?.finishedSteps ?? 0,
    });

    return { event, mode, turnId: this.turnId, runId: this.runId };
  }

  /** Null once the turn answered; the reason when it ended before it could. */
  private async runOpenedTurn(item: QueueItem, { event, mode, turnId, runId }: OpenedTurn): Promise<string | null> {
    const startedAt = Date.now();
    // A re-opened turn continues its run; only a new turn opens one.

    if (this.reopenedRunId === this.runId) this.reopenedRunId = null;

    const lease = this.actorSession.beginTurn({ runId, turnId }, mode, startedAt, item.metadata);

    if (item.continuation === undefined) openTurnRun(this.eventRecorder, runId, {
      agentId: lease.actorId,
      causedBy: event ?? 'chat',
      userMessage: item.text,
      turnIndex: this.actorSession.orchestrator.sessionTurnIndex,
      // Enough for the next process to re-open the same turn.
      turn: {
        turnId, messageId: this.messageId, kind: item.kind, text: item.text,
        ...(item.metadata !== undefined && { metadata: item.metadata }),
        ...(item.pendingSendId !== undefined && { pendingSendId: item.pendingSendId }),
        ...(item.steerIds !== undefined && { steerIds: item.steerIds }),
      },
    });

    // Armed at the synchronous open, at the recovery ceiling; soonest-wins.
    await this.ports.armTurnWake(Date.now() + RECOVERY_BACKOFF_CEILING_MS);

    try {
      // A run a dead process left goes on only if recovery says so; any other ends here as a Stop ends it.
      if (item.continuation !== undefined) await this.actorSession.resumeOrClose(lease);

      await runOperationProfile(null, () => runWorkModeInvocation(mode, () => this.runTurn(item, event, lease)));

      return null;
    } catch (error) {
      const message = renderThrownChain({ cause: error });
      const interrupted = lease.signal.aborted;

      if (!interrupted) this.actorSession.orchestrator.acc.hadError = true;
      const end = classifyRunEnd({ completed: false, interrupted, errorText: message.slice(0, 500) });

      this.closeRun(end, lease);
      await this.recordFailure(end, lease);
      this.emit({ type: 'error', message });
      this.emit({ type: 'turn-end', turn: this.snapshotTurn(item, '') });

      return interrupted ? null : message;
    } finally {
      // Detached lanes retain the runtime profile of the turn they belong to.
      this.actorSession.finishTurn(lease);
    }
  }

  /** Closes the lease, keeping the binding that stops re-delivery. Reads both `drainTurnId` and `replyTurnId`. */
  private answeredDeliveries(item: QueueItem): ReadonlySet<string> {
    const answered = new Set(this.actorSession.orchestrator.inbox.answeredDeliveries);
    const queued = v.safeParse(v.string(), item.metadata?.drainTurnId);

    if (queued.success) answered.add(queued.output);

    return answered;
  }

  private closeEventDeliveryLeases(item: QueueItem, absorbed: SettledSignals['absorbed']): void {
    const drainTurns = new Set<string>();
    const queued = v.safeParse(v.string(), item.metadata?.drainTurnId);

    if (queued.success) drainTurns.add(queued.output);

    for (const signal of absorbed) {
      if (signal.replyTurnId) drainTurns.add(signal.replyTurnId);
    }

    for (const turnId of drainTurns) this.eventLog.markTurnCompleted(turnId);
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
      runId: this.runId, failure, turnWasOverflowRetry: item.metadata?.kinuEvent === OVERFLOW_RETRY_EVENT,
      lastPromptTokens: this.actorSession.orchestrator.acc.lastPromptTokens, historyLength: prepared.historyLength,
      contextWindow: prepared.contextWindow, model: chat.modelSpec,
    });
  }

  private async runTurn(item: QueueItem, eventName: string | undefined, lease: ActorTurnLease): Promise<void> {
    const input: ChatTurnInput = item;

    await this.actorSession.openTurnInput(lease, {
      item: input,
      message: turnInputMessage(input),
      birthContext: async (drainTurnId) => (await this.birthContext(drainTurnId)).map(inheritedAsModelMessage),
    });

    // Before this turn's request voids the lane.
    const lastRequestAt = this.actorSession.lastRequestAt();
    const cacheKeptAliveUntil = lastRequestAt === null ? null : this.ports.cacheWarming?.keptAliveUntil(lastRequestAt) ?? null;

    const prepared = await this.ports.prepareTurn(input, lease, {
      answerId: this.messageId, cacheCold: this.actorSession.promptCacheCold(cacheKeptAliveUntil),
    });

    this.turnTrial = prepared.trial ?? null;

    const partial = item.continuation === undefined ? null : await this.actorSession.canonical.cutStep(item.continuation.openOutputs);

    if (item.continuation !== undefined && partial === 'text') {
      await this.actorSession.retractCutStep(lease, item.continuation.openOutputs);
      this.emit({ type: 'step-cut', stepIndex: item.continuation.finishedSteps + 1 });
      await this.delivery;
    }

    /** A Stop before any output leaves the operator's row alone. */
    let streamed = partial !== null;

    // A real request voids any armed warm; the durable counter stops a mid-turn wake from adding a refresh.
    this.ports.cacheWarming?.noteRequest();

    const execution = await this.actorSession.execute(lease, {
      task: item.text,
      ...prepared.execution,
      cacheKeptAliveUntil,
      ...(item.continuation !== undefined && {
        resumedSteps: item.continuation.finishedSteps,
        resumedUsage: item.continuation.usage,
        resumedMidStep: partial !== null,
      }),
    }, (event) => {
      // Any tool result is progress on the last reminder.
      if (event.type === 'tool-result') this.taskReminders.noteToolResult();

      recordExecutionEvent(this.eventRecorder, this.runId, event);

      if (event.type === 'model-fallback') {
        this.emit({ type: 'broadcast', event: { type: 'model_fallback', message: `${event.to} took over from ${event.from}: ${event.reason}` } });
      }

      if (event.type === 'text-delta' || event.type === 'tool-call') streamed = true;

      if (event.type === 'text-delta' || event.type === 'reasoning-delta' || event.type === 'tool-call' || event.type === 'tool-result'
        || event.type === 'error') return this.emit(event);
    });

    const fullText = execution.text;
    const interrupted = execution.interrupted;
    const runError = runErrorOf(execution.failure);
    const overflowRetry = this.settleContext(item, prepared, execution.failure);

    // Classified once: the classifier also files the mid-work defect.
    const facts: RunEndFacts = {
      completed: runError === null,
      interrupted,
      ...(runError !== null && { errorText: runError }),
      lastFinishReason: this.actorSession.orchestrator.acc.lastFinishReason,
    };

    const end = classifyRunEnd(facts);

    const finalText = execution.claim === null ? execution.finalTextReference
      : await this.actorSession.recordTranscriptText(execution.claim, 'answer', fullText, execution.outputReferences);

    const metadata = await answerMetadata(this.ports, lease.turnId, () => this.transcript.narration(answerParts(execution.outputPartReferences, finalText)), end);

    const preparedAssistant = streamed || !interrupted ? await this.transcript.prepareAssistant({
      id: this.messageId, turnId: lease.turnId, runId: lease.runId, parts: execution.outputPartReferences, finalText,
      ...(metadata !== null && { metadata }),
    }) : null;

    const owedReport = await this.ports.owedReport?.(
      taskTurnEnding(runError === null, interrupted), fullText, () => this.transcript.narration(execution.outputPartReferences),
    ) ?? null;

    // One commit — see {@link commitTurn}.
    const commit = this.commitTurn({
      item,
      turnId: lease.turnId,
      event: eventName,
      assistantText: fullText,
      owedReport,
      preparedAssistant,
      runError,
      end,
      trialContext: execution.admittedMessages,
      reachableTools: Object.keys(prepared.execution.chat.tools ?? {}),
      overflowRetry,
    });

    // Once per turn, after settling begins, outside every failure path; an answer that never reached disk
    // reports `completed: false`, so its events re-queue.
    const durable = runError === null && 'committed' in commit;
    const settled = this.actorSession.orchestrator.inbox.settle({ completed: durable });

    if (durable) this.closeEventDeliveryLeases(item, settled.absorbed);

    if (!('committed' in commit)) {
      const message = renderThrownChain({ cause: commit.failure });
      this.actorSession.orchestrator.acc.hadError = true;
      const failed = classifyRunEnd({ completed: false, interrupted: false, errorText: runError ?? message.slice(0, 500) });

      this.closeRun(failed, lease);
      diagnostics.failure('turn.persist_failed', commit.failure);
      await this.recordFailure(failed, lease);
      // Not durable, so the terminal event carries no final answer.
      this.emit({ type: 'error', message });
      this.emit({ type: 'turn-end', turn: this.snapshotTurn(item, '') });

      return;
    }

    const { turn, owed, transition } = commit.committed;

    try {
      // The lane decides whether the prefix is worth keeping.
      this.armCacheWarm(prepared);

      this.closeRun(end, lease);
      // Core drives the settled turn's effects as one state machine; this backend supplies the bodies and
      // the fiber. The ledger already holds the roster committed with the answer.
      this.settlingDepth += 1;

      try {
        await this.ports.terminal().settle({ transition, declare: () => owed });
      }
      finally { this.settlingDepth -= 1; }

      this.emit({ type: 'turn-end', turn });
    } catch (err) {
      const message = renderThrownChain({ cause: err });
      this.actorSession.orchestrator.acc.hadError = true;
      this.closeRun(classifyRunEnd({
        completed: false,
        interrupted: false,
        errorText: runError ?? message.slice(0, 500),
      }), lease);
      diagnostics.failure(
        'turn.finalization_failed',
        toKinuError({ doing: 'finalizing the turn', cause: err, otherwise: 'io' }),
      );
      // The answer is durable; only bookkeeping failed. The intent row stays: the transition may never have been claimed.
      this.emit({ type: 'error', message });
      this.emit({ type: 'turn-end', turn });
    }
  }

  /** The warm replays the turn's last request to the model that served it, a fallback's where one did; no provider in
   *  the cache plan means nothing to keep warm. */
  private armCacheWarm(prepared: PreparedTurn): void {
    const lane = this.ports.cacheWarming;
    const cache = prepared.execution.chat.cache;
    const lastRequest = this.actorSession.orchestrator.acc.lastRequest;

    if (lane === undefined || cache?.providerId === undefined || cache.modelId === undefined) return;
    lane.armAfterTurn({
      modelSpec: lastRequest?.fallback === undefined ? { provider: cache.providerId, modelId: cache.modelId } : parseModelSpec(lastRequest.fallback),
      retention: cache.retention ?? DEFAULT_CACHE_RETENTION,
      lastRequest,
    });
  }

  /** Answer, run verdict and frozen roster in one commit, since `resumeAll()` finds claims. Never throws. */
  private commitTurn(input: {
    readonly item: QueueItem;
    readonly turnId: string;
    readonly event: string | undefined;
    readonly assistantText: string;
    readonly owedReport: OwedReport | null;
    readonly preparedAssistant: PreparedConversationEntry | null;
    readonly runError: string | null;
    /** Classified once by the caller — see `closeRun`. */
    readonly end: RunEndClassification;
    readonly trialContext: readonly ModelMessage[];
    readonly reachableTools: readonly string[];
    readonly overflowRetry: boolean;
  }): TurnCommit {
    const { item, runError } = input;

    // At most one output-limit continuation: a turn is already one if queued (item stamp) or spliced
    // (absorbed signal).
    const outputContinuation = owesOutputLimitContinuation({
      completed: runError === null,
      lastFinishReason: this.actorSession.orchestrator.acc.lastFinishReason,
      turnWasContinuation: item.metadata?.kinuEvent === OUTPUT_CONTINUATION_EVENT
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

      // Decided where the roster is frozen; a turn that is the reminder never owes another.
      const taskReminder = input.event === TASK_REMINDER_EVENT
        ? null
        : this.taskReminders.decide({
          open: this.ports.taskList().listOpen(),
          assistantText: input.assistantText,
          workMode: this.actorSession.workMode,
          completed: runError === null,
          asyncWakePending: this.ports.hasPendingAsyncWake(),
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
        owedReport: input.owedReport,
        completed: runError === null,
        taskReminder,
        trialContext: input.trialContext,
        answeredDeliveries: this.answeredDeliveries(item),
        outputContinuation,
        reachableTools: input.reachableTools,
        overflowRetry: input.overflowRetry,
      });

      const transition: TerminalTransition = { turnId, messageId };

      this.transaction(() => {
        this.persist(input.preparedAssistant);

        // Same transaction, so a restart sees one or neither.
        this.pendingSends.retire([
          ...(item.pendingSendId === undefined ? [] : [item.pendingSendId]),
          ...(item.steerIds ?? []),
        ]);

        this.ports.terminal().record(transition, owed);
      });

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

  /** A turn that failed before its answer was recorded leaves one carrying the failure, where a reload reads it. */
  private async recordFailure(end: RunEndClassification, lease: ActorTurnLease): Promise<void> {
    if (end.error === undefined || this.transcript.has(this.messageId)) return;

    await settleLogged('turn.failure_unrecorded', { doing: 'recording the turn\'s failure on its answer', otherwise: 'io' }, async () => {
      const metadata = await answerMetadata(this.ports, lease.turnId, async () => [], end);

      const answer = await this.transcript.prepareAssistant({
        id: this.messageId, turnId: lease.turnId, runId: lease.runId, parts: [], finalText: null, ...(metadata !== null && { metadata }),
      });

      this.transaction(() => this.persist(answer));
    });
  }

  /** Public rows contain references only; output bytes committed before this terminal transaction. */
  private persist(assistant: PreparedConversationEntry | null): void {
    if (this.openingRow !== null) this.transcript.appendUser(this.openingRow);

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

  /** Re-queues first the turn the last process died inside, claiming its reservation so {@link restorePendingSends} skips it. */
  private reopened: string | null = null;
  private reopenedTurnId: string | null = null;
  private reopenedRunId: string | null = null;

  private restoreOpenTurn(): void {
    const open = this.eventRecorder.openTurn();

    if (open === null) return;
    const { runId, turn, steps, finishedSteps, usage } = open;
    const openOutputs = this.actorSession.canonical.openOutputs(runId);

    const item: QueueItem = {
      text: turn.text,
      kind: turn.kind,
      turnId: turn.turnId,
      ...(turn.metadata !== undefined && { metadata: turn.metadata }),
      ...(turn.pendingSendId !== undefined && { pendingSendId: turn.pendingSendId, files: this.pendingSends.files(turn.pendingSendId) }),
      ...(turn.steerIds !== undefined && { steerIds: turn.steerIds }),
      rerun: true,
      continuation: {
        runId,
        messageId: turn.messageId,
        finishedSteps,
        usage,
        openOutputs,
      },
      settle: () => {},
    };

    if (turn.kind === 'programmatic') item.idempotencyKey = announcementOf(turn.turnId);
    this.reopened = turn.pendingSendId ?? null;
    this.reopenedTurnId = turn.turnId;
    this.reopenedRunId = runId;
    this.queue.push(item);

    this.emit({
      type: 'background', event: 'turn_reopened',
      message: `continuing the turn the last process left: ${String(steps.length)} step${steps.length === 1 ? '' : 's'} kept`
        + (openOutputs.length === 0 ? '' : `, resuming mid-step ${String(finishedSteps + 1)}`),
    });

    queueMicrotask(() => {
      if (this.ended) return;
      this.pump();
    });
  }

  /** Mid-turn rows re-enter the inbox; idle rows re-enter the pump in sequence order. */
  private restorePendingSends(): void {
    // Rows bound to the re-opened turn land in its first step.
    const rows = this.pendingSends.restore().filter((row) => row.id !== this.reopened);

    if (rows.length === 0) return;

    const midTurn: (UserSteer & { mode: WorkMode })[] = [];
    // Sends bound to a dead turn: one rerun per turn, in acceptance order, under the narrowest mode (plan).
    // Merging never widens a message's mode.
    const dead = new Map<string, PendingSendRow[]>();
    let queued = 0;

    for (const row of rows) {
      if (row.turnId === null) {
        this.queue.push({
          text: row.text, kind: 'user', turnId: row.id,
          // Kept ahead of anything the new session admits.
          rerun: true,
          pendingSendId: row.id,
          metadata: { ...this.pendingSends.metadata(row.id), kinuMode: row.mode },
          files: this.pendingSends.files(row.id),
          settle: () => {},
        });
        queued += 1;
      } else if (row.turnId === this.reopenedTurnId) {
        midTurn.push({
          id: row.id, text: row.text, mode: row.mode,
          files: this.pendingSends.files(row.id),
        });
      } else {
        dead.set(row.turnId, [...(dead.get(row.turnId) ?? []), row]);
      }
    }

    for (const group of dead.values()) {
      const mode: WorkMode = group.some((row) => row.mode === 'plan') ? 'plan' : 'build';

      const sends = group.map((row) => ({ id: row.id, text: row.text, files: this.pendingSends.files(row.id) }));

      this.queue.push({
        text: group.map((row) => row.text).join('\n\n'), kind: 'user', turnId: group[0]?.id,
        rerun: true,
        steerIds: sends.map((send) => send.id),
        sends,
        metadata: { kinuMode: mode },
        files: sends.flatMap((send) => send.files),
        settle: () => {},
      });
      queued += 1;
    }

    if (midTurn.length > 0) this.actorSession.orchestrator.inbox.restorePending(midTurn);

    this.emit({
      type: 'background', event: 'pending_sends_restored',
      message: `restored ${rows.length} acknowledged send${rows.length === 1 ? '' : 's'} the last process left`,
    });

    if (queued > 0) {
      // Not synchronous: the driver gate is installed after the constructor returns.
      queueMicrotask(() => {
        if (this.ended) return;
        this.pump();
      });
    }
  }

  restoreHistory(): Promise<boolean> {
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

/** A failed turn's error as its run records it. */
function runErrorOf(cause: Error | null): string | null {
  return cause === null ? null : renderThrownChain({ cause }).slice(0, 500);
}
