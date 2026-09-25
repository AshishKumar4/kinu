/**
 * ChatSession: the one turn loop, shared by both backends through {@link ChatSessionPorts} and
 * {@link ChatTransport}. Invariants: one turn at a time, and every started turn terminates (one
 * `turn-end`, a closed run, a released lease); a send while a turn exists splices into it; every
 * accepted send is durable before it is acknowledged; the commit is one transaction; leftovers rerun as
 * one user-origin turn; restart replays pending sends and owed effects; an interrupted turn continues
 * once, under the run it was open in.
 */

import type { ModelMessage } from 'ai';
import * as v from 'valibot';
import type { ChatEvent } from '../chat';
import { runWorkModeInvocation } from '../execution/work-mode';
import type { EventLog } from '../events/hub/log';
import type { RunEventRecorder } from '../events/recorder';
import type { PartialToolCall, RunEvent } from '../events/types';
import type { CompletedTurn } from '../evolution/types';
import { diagnostics, KinuError, renderThrownChain, toKinuError, type Refusal } from '../obs/index';
import { workModeForTurnMetadata } from '../prompting/surface';
import { runOperationProfile } from '../profiles/operation';
import type { CacheWarmingLane } from '../providers/cache-warming';
import { DEFAULT_CACHE_RETENTION } from '../providers/types';
import type { ToolOutcome } from '../tools/outcome';
import { OVERFLOW_RETRY_EVENT } from '../turn-failure';
import type {
  BroadcastEvent, EnqueueTurnResult, ProgrammaticTurn, PromptFile,
} from '../types/backend-host';
import type { TierId } from '../types/profile';
import type { SendLanding, SettledSignals } from '../types/signals';
import type { WorkMode } from '../types/turn';
import type { JsonObject } from '../utils/json';
import { PROGRAMMATIC_MESSAGE_ID_PREFIX, stampTurnAuthor, TURN_AUTHOR_METADATA_KEY } from '../utils/ui-message';
import { REVERT_NEEDS_IDLE } from './actor-session';
import type { ActorSession, ActorTurnLease, ActorExecutionInput, ActorExecutionResult } from './actor-session';
import { CompletionGate, COMPLETION_GATE_EVENT } from './completion-gate';
import type { LandedSteerRow, PendingSendRow, PendingSendStore, UserSteer } from './inbox';
import type { OwedEffect } from './terminal-effects';
import type { TerminalTransition, TerminalTransitions } from './terminal-transition';
import {
  applyOverflowRecovery, classifyRunEnd, closeTurnRun, creditedTurnId, openTurnRun,
  owesOutputLimitContinuation, OUTPUT_CONTINUATION_EVENT, persistMeasuredPromptTokens, snapshotCompletedTurn,
  type CompactionTriggerState, type RunEndClassification, type RunEndFacts, type RunEndReason,
} from './turn-lifecycle';
import type { SessionTranscript, PreparedConversationEntry } from '../session/transcript';
import { RECOVERY_BACKOFF_CEILING_MS } from '../utils/recovery-backoff';
import type { MessageReference } from '../session/messages';
import type { ContextSelection } from '../session/context';
import { subordinateTurnContext } from '../subordinates/support';
import { taskTurnEnding, type OwedReport, type TaskTurnEnding } from '../subordinates/temporary';
import { TURN_END_METADATA_KEY } from '../read-models/background-event';
import { TaskReminders, TASK_REMINDER_EVENT } from '../tasks/reminder';
import type { TaskListStore } from '../tasks/store';
import { inheritedAsModelMessage } from '../heads/head-inference';

type ToolCallArguments = Extract<ChatEvent, { type: 'tool-call' }>['args'];

/** One cadence for the step ledger and a backend's wire replay store, so they agree on what survived. */
const PARTIAL_FLUSH_EVERY = 10;

export type PartialFlushSignal = 'content' | 'settled' | 'none';

/** First content chunk flushes, then every {@link PARTIAL_FLUSH_EVERY}, and a settled tool result at once; a step boundary resets. */
export interface PartialFlushCadence {
  flushes(signal: PartialFlushSignal): boolean;
  reset(): void;
}

export function partialFlushCadence(): PartialFlushCadence {
  let sinceFlush = 0;
  let flushedContent = false;

  return {
    flushes: (signal) => {
      if (signal === 'none') return false;
      sinceFlush += 1;

      if (signal !== 'settled' && flushedContent && sinceFlush < PARTIAL_FLUSH_EVERY) return false;
      sinceFlush = 0;
      flushedContent = true;

      return true;
    },
    reset: () => {
      sinceFlush = 0;
      flushedContent = false;
    },
  };
}

/** None: reclamation runs under the single-driver lease, so every open lease is a dead process's. */
const NO_STRANDED_DELIVERY_GRACE = 0;

/** The run end is classified once by `runTurn`, so the roster and the run row cannot disagree. */
interface CommittedTurn {
  readonly messageId: string;
  readonly turn: CompletedTurn;
  readonly owed: readonly OwedEffect[];
  /** Null for a turn with no durable identity: it runs unledgered. */
  readonly transition: TerminalTransition | null;
}

/** Reported rather than thrown, because the signal settle after it must run either way. */
type TurnCommit = { readonly committed: CommittedTurn } | { readonly failure: KinuError };

export type SessionEvent =
  | { type: 'turn-start'; kind: 'user' | 'programmatic'; text: string; event?: string; workMode: WorkMode;
      /** Both minted at admission. */
      turnId: string; messageId: string;
      /** A rerun answers every leftover as one turn; a transport closes their requests with it. */
      carried: readonly string[] }
  | { type: 'text-delta'; delta: string }
  | { type: 'tool-call'; toolName: string; toolCallId: string; args: ToolCallArguments }
  | ({ type: 'tool-result'; toolName: string; toolCallId: string; result: string } & ToolOutcome)
  | { type: 'turn-end'; turn: CompletedTurn }
  | { type: 'error'; message: string }
  | { type: 'evolution'; event: string; message: string }
  // Kept apart from `evolution`: `kinu exec --no-auto-evolve` silences evolution while jobs may still settle.
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
  /** Placed at the queue front, behind only earlier reruns of the same settle. */
  rerun?: true;
  /** An offer, not an event: if an operator message is admitted ahead, it settles 'yielded' without running (ProgrammaticTurn.yieldsToUserMessage). */
  yieldsToUserMessage?: boolean;
  /** Re-opened under its own ids, its prior output re-entered ahead of the remaining calls. */
  continuation?: TurnContinuation;
  /** Exactly once, and told whether the turn ran: a lease refusal must reach the producer, the only one who can put things back. */
  settle: (refusal: Refusal | null, yielded?: boolean) => void;
}

interface TurnContinuation {
  /** The continuation appends to it, so the open run is the run that closes. */
  readonly runId: string;
  readonly messageId: string;
  readonly steps: readonly ModelMessage[];
  readonly partial: { readonly text: string; readonly toolCalls: readonly PartialToolCall[] } | null;
}


/** Attachments as file parts (convertToModelMessages' FileUIPart shape), then the text. */
export function turnInputMessage(item: Pick<ChatTurnInput, 'text' | 'files'>): ModelMessage {
  const fileParts = (item.files ?? []).map((f) => ({
    type: 'file' as const, data: f.url, mediaType: f.mediaType, filename: f.filename,
  }));

  return fileParts.length > 0
    ? { role: 'user', content: [...fileParts, { type: 'text' as const, text: item.text }] }
    : { role: 'user', content: item.text };
}

/** The cut step's text heads the answer only when that step was the answer; narration-step text stays with its step. */
function continuedAnswer(
  continuation: TurnContinuation | undefined,
  execution: Pick<ActorExecutionResult, 'text' | 'steps' | 'interrupted'>,
): string {
  const partial = continuation?.partial;

  if (partial === undefined || partial === null || partial.toolCalls.length > 0) return execution.text;

  return execution.interrupted || execution.steps <= 1 ? partial.text + execution.text : execution.text;
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
  readonly contextWindow: number;
  readonly historyLength: number;
}

/** Taken while the turn is still in memory. */
export interface OwedTerminalEffectsInput {
  readonly turn: CompletedTurn;
  readonly status: RunEndReason;
  readonly credited: string | null;
  readonly messageId: string;
  readonly userText: string;
  /** Read off the settling turn itself; undefined for a person's message. */
  readonly event: string | undefined;
  readonly assistantText: string;
  /** Decided before the commit; null when none is owed. */
  readonly owedReport: OwedReport | null;
  readonly completed: boolean;
  readonly startedAt: number;
  readonly trialContext: readonly ModelMessage[];
  /** A cold replay has no live toolset to ask. */
  readonly reachableTools: readonly string[];
  readonly overflowRetry: boolean;
  /** A backend with reply channels owes each an outbound reply. */
  readonly answeredDeliveries: ReadonlySet<string>;
  /** At most one continuation is owed. */
  readonly outputContinuation: boolean;
  /** Null when the decision said none. */
  readonly taskReminder: { readonly text: string } | null;
}

/** Each port is asked per call, never captured. */
export interface ChatSessionPorts {
  /** Runs after the opening row and run are durable; a throw ends the turn as an error with one `turn-end`. */
  prepareTurn(item: ChatTurnInput, lease: ActorTurnLease): Promise<PreparedTurn>;
  owedTerminalEffects(input: OwedTerminalEffectsInput): OwedEffect[];
  /** The report this ending owes its caller; narration is read only if the report carries it. */
  owedReport?(ending: TaskTurnEnding, assistantText: string, narration: () => Promise<readonly string[]>): Promise<OwedReport | null>;
  /** Asked per call: the bodies close over stores built after this session. */
  terminal(): TerminalTransitions;
  holdTerminalClose(transition: TerminalTransition, close: () => Promise<void>): void;
  /** Asked per item at dequeue and before a drain binds rows; a refusal settles the item to its producer. */
  driverGate(): Refusal | null;
  /** Called at the turn's synchronous open; soonest-wins. A backend whose process is the wake arms nothing. */
  armTurnWake(atMs: number): Promise<void>;
  /** The queue drained and no turn runs. */
  quiet?(): void;
  /** Read at commit, never captured earlier. */
  taskList(): TaskListStore;
  /** A reminder fired behind such work would race its wake. */
  hasPendingAsyncWake(): boolean;
  /** `steerSkillsBlock`. */
  steerSkills(text: string): Promise<string | null>;
  /** A backend with no review surface refuses a plan turn at admission. */
  planTurnRefusal(): string | null;
  /** The session drives it because both instants it needs are the session's; the policy is the lane's. */
  readonly cacheWarming?: CacheWarmingLane;
}

export interface ChatSessionOptions {
  readonly actorSession: ActorSession;
  readonly sessionId: string;
  readonly transcript: SessionTranscript;
  /** Core's PendingSendStore, bound to the session's own actor id. */
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

export class ChatSession {
  private readonly actorSession: ActorSession;
  private readonly sessionId: string;
  private readonly transcript: SessionTranscript;
  private readonly pendingSends: PendingSendStore;
  /** Settled where the fate is decided, never at admission. A send admitted via `admit` has no entry: its fate goes out as steer_status. */
  private readonly landings = new Map<string, SendLandingWaiter>();
  private readonly eventLog: EventLog;
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
  /** Armed only by a one-shot task turn (completion-gate.ts). */
  readonly completionGate = new CompletionGate();
  /** core tasks/reminder.ts. */
  private readonly taskReminders = new TaskReminders();
  /** Drained by a single serialized pump so turns never interleave. */
  private readonly queue: QueueItem[] = [];
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
  }

  get pumpPromise(): Promise<void> | null { return this.activePump; }
  get pumping(): boolean { return this.pumpActive; }
  get currentRunId(): string | null { return this.runId; }
  /** Open on purpose, so the wake reconcile must not seal them. */
  drivenRuns(): readonly string[] {
    return [...new Set([this.runId, this.reopenedRunId].filter((runId): runId is string => runId !== null))];
  }
  get currentTurnId(): string | null { return this.turnId; }
  /** The owner's teardown calls this first. */
  close(): void { this.ended = true; }
  get closed(): boolean { return this.ended; }

  /**
   * Non-zero while a terminal transition runs on the pump's stack: {@link enqueueTurn} then answers at
   * admission, since awaiting execution from inside the pump would deadlock.
   */
  private settlingDepth = 0;

  /** Self-starts the pump when idle. A re-announcement of an already recorded fact starts no turn and answers 'queued'. */
  enqueueTurn(input: ProgrammaticTurn): Promise<EnqueueTurnResult> {
    // The operator's immediate next turn, answered at admission: its settle is on this pump's stack.
    if (input.origin === 'user') {
      const item: QueueItem = {
        text: input.text,
        kind: 'user',
        ...(input.files !== undefined && { files: input.files }),
        metadata: input.metadata,
        rerun: true,
        // Keeps the first merged message's id; only a rerun with no steer ids mints one.
        turnId: input.steerIds?.[0] ?? crypto.randomUUID(),
        // Retired with this rerun's row in the same transaction.
        steerIds: input.steerIds,
        settle: (refusal) => {
          this.settleLandings(input.steerIds ?? [], refusal === null ? 'turn' : refusedLanding(refusal));
        },
      };

      // Each merged id is bound to this turn before admission; `OR IGNORE` because rerun ids already carry theirs.
      const mode: WorkMode = workModeForTurnMetadata(input.metadata) === 'plan' ? 'plan' : 'build';

      for (const steerId of item.steerIds ?? []) {
        this.pendingSends.ensureReserved({ id: steerId, turnId: item.turnId ?? null, mode, text: input.text });
      }

      const front = this.queue.findIndex((queued) => queued.rerun !== true);
      this.queue.splice(front === -1 ? this.queue.length : front, 0, item);
      this.pump();

      return Promise.resolve({ status: 'queued' });
    }

    if (workModeForTurnMetadata(input.metadata) === 'plan') {
      const refusal = this.ports.planTurnRefusal();

      if (refusal !== null) return Promise.reject(new Error(refusal));
    }

    // During shutdown: 'skipped' sends the caller down its durable path; the next run drains it.
    if (this.ended) return Promise.resolve({ status: 'skipped' });

    if (input.idempotencyKey !== undefined && this.hasAnnounced(input.idempotencyKey)) {
      return Promise.resolve({ status: 'queued' });
    }

    const { promise, resolve } = Promise.withResolvers<EnqueueTurnResult>();

    const item: QueueItem = {
      text: input.text,
      metadata: input.metadata,
      kind: 'programmatic',
      // The signal seam compensates on anything but 'queued'. 'yielded' is consumed: nothing is retried.
      settle: (refusal, yielded) => {
        if (yielded === true) {
          resolve({ status: 'yielded' });

          return;
        }

        resolve({ status: refusal ? 'skipped' : 'queued' });
      },
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

  /** Durable table (cold activation), queue (same activation), or the running key (mid-turn). */
  private hasAnnounced(identity: string): boolean {
    return this.announcementInFlight(identity) || this.announcementOnDisk(identity);
  }

  announcementInFlight(identity: string): boolean {
    return this.runningAnnouncement === identity
      || this.queue.some((item) => item.idempotencyKey === identity);
  }

  announcementOnDisk(identity: string): boolean {
    return this.transcript.has(`${PROGRAMMATIC_MESSAGE_ID_PREFIX}${identity}`);
  }

  /** Settling has no next step. A queued, unopened user turn counts: a message behind it rides its first step. */
  turnInFlight(): boolean {
    return this.actorSession.inFlight || this.queue.some((item) => item.kind === 'user');
  }

  /** Send; resolves where it landed (`'mid-turn'` or `'turn'`), never guessed at admission, and rejects if it did not land. */
  async send(input: string | { text: string; files: ReadonlyArray<PromptFile> }, opts: SendOptions): Promise<SendLanding> {
    const landing = Promise.withResolvers<SendLanding>();

    await this.admit(input, opts, landing);

    return landing.promise;
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
      kinuMode: mode,
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
      settle: (refusal) => {
        // A refusal takes the reservation with it, or the words would be re-delivered after the caller was told no.
        if (refusal) this.pendingSends.retire([pendingSendId]);
        this.settleLandings([turnId], refusal === null ? 'turn' : refusedLanding(refusal));
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

    return returned.map((steer) => steer.text);
  }

  /** Unseen steers stay queued and rerun; {@link interrupt} hands them back instead. */
  stop(): void {
    this.actorSession.stop();
  }

  /** The loop's queue and running turn define "in flight" for both backends. The event's delivery is awaited so the redraw precedes the answer. */
  async revertTo(entryId: string): Promise<void> {
    await this.actorSession.revertConversation(this.sessionId, entryId, () => {
      if (this.turnInFlight()) throw new KinuError('denied', REVERT_NEEDS_IDLE);
    });
    this.emit({ type: 'history-reverted', entryId });
    await this.flushEvents();
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

  /** Call once at startup, before the recovery drain; see {@link NO_STRANDED_DELIVERY_GRACE}. Answered deliveries' leases are already closed. */
  reclaimStrandedEventDeliveries(): void {
    const reclaimed = this.eventLog.unbindStale(NO_STRANDED_DELIVERY_GRACE);

    if (reclaimed.length === 0) return;
    diagnostics.event('event.deliveries_reclaimed', { count: reclaimed.length });
    this.emit({
      type: 'background',
      event: 'events_reclaimed',
      message: `${reclaimed.length} event delivery/ies were bound to a turn a previous process did not finish — re-queued`,
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
    const running = this.runPump();

    // Assigned only if still running: an empty-queue run completes synchronously, and reinstating its
    // resolved promise would spin settleBackgroundWork forever.
    if (this.pumpActive) this.activePump = running;
  }

  private async runPump(): Promise<void> {
    try {
      let item: QueueItem | undefined;

      while ((item = this.queue.shift())) {
        // Checked per item, immediately before the turn runs. A refusal settles the item, so its producer
        // compensates.
        const refusal = this.ports.driverGate();

        if (refusal) {
          diagnostics.event('driver.turn_deferred', { kind: item.kind, reason: refusal.reason });
          item.settle(refusal);
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
          item.settle(null, true);
          continue;
        }

        this.runningAnnouncement = item.idempotencyKey ?? null;

        try {
          await this.processTurn(item);
        } catch (err) {
          diagnostics.failure(
            'turn.processing_failed',
            toKinuError({ doing: 'processing a queued turn', cause: err, otherwise: 'io' }),
          );
        } finally {
          await this.flushEvents();
          this.runningAnnouncement = null;
          item.settle(null);
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
  private async processTurn(item: QueueItem): Promise<void> {
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

    const opening = await this.transcript.prepareUser({ id: this.turnId, turnId: this.turnId, runId: this.runId, message: inputReference,
      metadata: item.kind === 'user' ? { ...item.metadata, [TURN_AUTHOR_METADATA_KEY]: 'operator' } : stampTurnAuthor(item.metadata) });

    this.openingRow = item.kind === 'programmatic' ? opening : null;

    if (item.kind === 'user') this.transcript.appendUser(opening);

    this.emit({
      type: 'turn-start', kind: item.kind, text: item.text, event, workMode: mode, turnId: this.turnId, messageId: this.messageId,
      carried: (item.steerIds ?? []).filter((id) => id !== this.turnId),
    });

    const startedAt = Date.now();
    // A re-opened turn continues its run; only a new turn opens one.

    if (this.reopenedRunId === this.runId) this.reopenedRunId = null;

    const lease = this.actorSession.beginTurn(
      { runId: this.runId, turnId: this.turnId }, mode, startedAt, item.metadata,
    );

    if (item.continuation === undefined) openTurnRun(this.eventRecorder, this.runId, {
      agentId: lease.actorId,
      causedBy: event ?? 'chat',
      userMessage: item.text,
      turnIndex: this.actorSession.orchestrator.sessionTurnIndex,
      // Enough for the next process to re-open the same turn.
      turn: {
        turnId: this.turnId, messageId: this.messageId, kind: item.kind, text: item.text,
        ...(item.metadata !== undefined && { metadata: item.metadata }),
        ...(item.pendingSendId !== undefined && { pendingSendId: item.pendingSendId }),
        ...(item.steerIds !== undefined && { steerIds: item.steerIds }),
      },
    });

    // Armed at the synchronous open, at the recovery ceiling; soonest-wins.
    await this.ports.armTurnWake(Date.now() + RECOVERY_BACKOFF_CEILING_MS);

    try {
      await runOperationProfile(null, () => runWorkModeInvocation(mode, () => this.runTurn(item, event, startedAt, lease)));
    } catch (error) {
      const message = renderThrownChain({ cause: error });
      const interrupted = lease.signal.aborted;

      if (!interrupted) this.actorSession.orchestrator.acc.hadError = true;
      this.closeRun(classifyRunEnd({ completed: false, interrupted, errorText: message.slice(0, 500) }), lease);
      this.emit({ type: 'error', message });
      this.emit({ type: 'turn-end', turn: this.snapshotTurn(item, '') });
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

    return snapshotCompletedTurn(this.actorSession.orchestrator.acc, completedTurn);
  }

  /** Everything here may throw; processTurn owns what that means. */
  /** `step_finish` supersedes it; indices count from the steps a continuation already carries. */
  private partialLedger(continuation: TurnContinuation | undefined) {
    let stepIndex = (continuation?.steps.length ?? 0) + 1;
    let text = '';
    let toolCalls: PartialToolCall[] = [];
    const cadence = partialFlushCadence();

    const flush = (signal: PartialFlushSignal): void => {
      if (!cadence.flushes(signal) || this.runId === null) return;
      this.eventRecorder.emit(this.runId, { type: 'step_partial', stepIndex, text, toolCalls });
    };

    return {
      observe: (event: ChatEvent) => {
        switch (event.type) {
          case 'text-delta':
            text += event.delta;
            flush('content');

            return;
          case 'tool-call':
            toolCalls = [...toolCalls, { toolCallId: event.toolCallId, toolName: event.toolName, args: event.args }];
            flush('content');

            return;
          case 'tool-result':
            toolCalls = toolCalls.map((call) => call.toolCallId === event.toolCallId
              ? { ...call, ...(event.success ? { result: event.result } : { error: event.error ?? event.result }) }
              : call);
            flush('settled');
            // Any tool result is progress on the last reminder.
            this.taskReminders.noteToolResult();

            return;
          case 'step-finish':
            stepIndex += 1;
            text = '';
            toolCalls = [];
            cadence.reset();

            return;
          case 'reasoning-delta':
          case 'done':
          case 'error':
            return;
        }
      },
    };
  }

  private async runTurn(item: QueueItem, eventName: string | undefined, startedAt: number, lease: ActorTurnLease): Promise<void> {
    const input: ChatTurnInput = item;

    await this.actorSession.openTurnInput(lease, {
      item: input,
      message: turnInputMessage(input),
      birthContext: async (drainTurnId) => subordinateTurnContext(this.eventLog, drainTurnId).map(inheritedAsModelMessage),
    });

    const prepared = await this.ports.prepareTurn(input, lease);

    const partial = this.partialLedger(item.continuation);
    /** A Stop before any output leaves the operator's row alone. */
    let streamed = item.continuation?.partial !== null && item.continuation?.partial !== undefined;

    // A real request voids any armed warm; the durable counter stops a mid-turn wake from adding a refresh.
    this.ports.cacheWarming?.noteRequest();

    const execution = await this.actorSession.execute(lease, {
      task: item.text,
      ...prepared.execution,
    }, (event) => {
      partial.observe(event);

      if (event.type === 'text-delta' || event.type === 'tool-call') streamed = true;

      if (event.type === 'text-delta' || event.type === 'tool-call' || event.type === 'tool-result' || event.type === 'error') return this.emit(event);
    });

    const fullText = continuedAnswer(item.continuation, execution);
    const interrupted = execution.interrupted;
    let runError: string | null = null;
    let overflowRetry = false;

    if (execution.failure !== null) {
      const message = renderThrownChain({ cause: execution.failure });
      runError = message.slice(0, 500);
      overflowRetry = applyOverflowRecovery({
        error: message,
        lastPromptTokens: this.actorSession.orchestrator.acc.lastPromptTokens,
        contextWindow: prepared.contextWindow,
        turnWasOverflowRetry: item.metadata?.kinuEvent === OVERFLOW_RETRY_EVENT,
        state: this.compactionState,
        sessionKey: prepared.sessionKey,
      }).enqueueRetry;
    }

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

    const preparedAssistant = streamed || !interrupted ? await this.transcript.prepareAssistant({
      id: this.messageId, parentId: this.actorSession.landedSteers.at(-1)?.id ?? lease.turnId,
      turnId: lease.turnId, runId: lease.runId, parts: execution.outputPartReferences, finalText,
      ...(end.reason === 'incomplete' && { metadata: { [TURN_END_METADATA_KEY]: end.reason } }),
    }) : null;

    const owedReport = await this.ports.owedReport?.(
      taskTurnEnding(runError === null, interrupted), fullText, () => this.transcript.narration(execution.outputPartReferences),
    ) ?? null;

    // One commit — see {@link commitTurn}.
    const commit = this.commitTurn({
      item,
      event: eventName,
      startedAt,
      assistantText: fullText,
      owedReport,
      // A turn cut before its first token has no answer row.
      assistantRow: streamed || !interrupted,
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
      this.closeRun(classifyRunEnd({
        completed: false,
        interrupted: false,
        errorText: runError ?? message.slice(0, 500),
      }), lease);
      diagnostics.failure('turn.persist_failed', commit.failure);
      // Not durable, so the terminal event carries no final answer.
      this.emit({ type: 'error', message });
      this.emit({ type: 'turn-end', turn: this.snapshotTurn(item, '') });

      return;
    }

    const { turn, owed, transition } = commit.committed;

    try {
      persistMeasuredPromptTokens(this.compactionState, prepared.sessionKey, this.actorSession.orchestrator.acc.lastPromptTokens, prepared.historyLength);
      // The lane decides whether the prefix is worth keeping.
      this.armCacheWarm(prepared);

      this.closeRun(end, lease);
      // Core drives the settled turn's effects as one state machine; this backend supplies the bodies and
      // the fiber. The ledger already holds the roster committed with the answer.
      this.settlingDepth += 1;

      try {
        await this.ports.terminal().settle({
          transition,
          declare: () => owed,
          hold: (claimed, close) => { this.ports.holdTerminalClose(claimed, close); },
        });
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

  /** No provider in the cache plan means nothing to keep warm. */
  private armCacheWarm(prepared: PreparedTurn): void {
    const lane = this.ports.cacheWarming;
    const cache = prepared.execution.chat.cache;

    if (lane === undefined || cache?.providerId === undefined || cache.modelId === undefined) return;
    lane.armAfterTurn({
      modelSpec: { provider: cache.providerId, modelId: cache.modelId },
      retention: cache.retention ?? DEFAULT_CACHE_RETENTION,
      lastRequest: this.actorSession.orchestrator.acc.lastRequest,
    });
  }

  /**
   * The answer, its run verdict and the frozen roster in one commit, since `resumeAll()` finds claims.
   * Uses the raw handle: `rt.storage.sql` and `db` share the connection. Never throws.
   */
  private commitTurn(input: {
    readonly item: QueueItem;
    readonly event: string | undefined;
    readonly startedAt: number;
    readonly assistantText: string;
    readonly owedReport: OwedReport | null;
    /** False only for a turn interrupted before it streamed anything. */
    readonly assistantRow: boolean;
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
      const turnId = this.turnId ?? crypto.randomUUID();
      // Minted at admission: the roster, frozen before the write, keys on it.
      const messageId = this.messageId;

      // Before the roster, so the turn that answered a gate cannot be gated again.
      if (input.event === COMPLETION_GATE_EVENT) {
        this.completionGate.settle({ toolCalls: this.actorSession.orchestrator.acc.toolCalls.length });
      }

      const status = input.end.reason;
      const turn = this.snapshotTurn(item, input.assistantText, messageId);

      // Decided where the roster is frozen: the decision is the firing. A turn that is the reminder never owes another.
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
        event: input.event,
        assistantText: input.assistantText,
        owedReport: input.owedReport,
        completed: runError === null,
        taskReminder,
        startedAt: input.startedAt,
        trialContext: input.trialContext,
        answeredDeliveries: this.answeredDeliveries(item),
        outputContinuation,
        reachableTools: input.reachableTools,
        overflowRetry: input.overflowRetry,
      });

      // A response with no durable identity runs without a ledger key.
      const transition: TerminalTransition | null = this.turnId === null
        ? null
        : { turnId, messageId };

      this.transaction(() => {
        this.persist(input.preparedAssistant);

        // Same transaction, so a restart sees one or neither.
        this.pendingSends.retire([
          ...(item.pendingSendId === undefined ? [] : [item.pendingSendId]),
          ...(item.steerIds ?? []),
        ]);

        this.ports.terminal().record(transition, owed);
      });

      return { committed: { messageId, turn, owed, transition } };
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

  /** Public rows contain references only; output bytes committed before this terminal transaction. */
  private persist(assistant: PreparedConversationEntry | null): void {
    if (this.openingRow !== null) this.transcript.appendUser(this.openingRow);

    if (assistant !== null) this.transcript.appendAssistant(assistant);
  }

  // The pending-send ledger: a send is a row before the client hears it.

  /** Landed rows and spent reservations in one transaction; rows chain from the opening message. */
  private async prepareLandedSteers(rows: readonly LandedSteerRow[], reference: MessageReference): Promise<(context: ContextSelection) => void> {
    const turnId = this.turnId;
    const runId = this.runId;

    if (turnId === null || runId === null) throw new KinuError('denied', 'steer publication requires an active turn');
    const opening = this.openingRow;
    const parentId = this.actorSession.landedSteers.at(-1)?.id ?? turnId;
    const prepared = await this.transcript.prepareSteers({ rows, reference, turnId, runId, parentId });

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

  /** Re-queues the turn the last process died inside, first, with its output as prior output; its reservation is claimed here so {@link restorePendingSends} skips it. */
  private reopened: string | null = null;
  private reopenedTurnId: string | null = null;
  private reopenedRunId: string | null = null;

  private restoreOpenTurn(): void {
    const open = this.eventRecorder.openTurn();

    if (open === null) return;
    const { runId, turn, steps, partial } = open;

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
        steps,
        partial: partial === null ? null : { text: partial.text, toolCalls: partial.toolCalls },
      },
      settle: () => {},
    };

    if (turn.kind === 'programmatic') item.idempotencyKey = turn.turnId.slice(PROGRAMMATIC_MESSAGE_ID_PREFIX.length);
    this.reopened = turn.pendingSendId ?? null;
    this.reopenedTurnId = turn.turnId;
    this.reopenedRunId = runId;
    this.queue.push(item);

    this.emit({
      type: 'background', event: 'turn_reopened',
      message: `continuing the turn the last process left: ${String(steps.length)} step${steps.length === 1 ? '' : 's'} kept`
        + (partial === null ? '' : `, resuming mid-step ${String(partial.stepIndex)}`),
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
          text: row.text, kind: 'user', turnId: crypto.randomUUID(),
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

      this.queue.push({
        text: group.map((row) => row.text).join('\n\n'), kind: 'user', turnId: crypto.randomUUID(),
        rerun: true,
        steerIds: group.map((row) => row.id),
        metadata: { kinuMode: mode },
        files: group.flatMap((row) => this.pendingSends.files(row.id)),
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
  const text = v.safeParse(v.string(), input);

  if (text.success) return { text: text.output };

  return v.parse(v.object({
    text: v.string(),
    files: v.array(v.object({ filename: v.string(), mediaType: v.string(), url: v.string() })),
  }), input);
}
