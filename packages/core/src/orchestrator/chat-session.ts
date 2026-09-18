/**
 * ChatSession — the ONE turn loop, in core.
 *
 * Seeded from the local backend's session and generalized over the seams both
 * backends already share: `ActorSession`, `Inbox`, `PendingSendStore`, the
 * `SqlExecutor` port behind a {@link TranscriptStore}, the event log, the run
 * recorder and core's terminal ledger. A backend supplies what the loop cannot
 * know — how a turn is assembled, what a settled turn owes, its effect bodies,
 * its driver lease and where events go — through {@link ChatSessionPorts} and
 * {@link ChatTransport}.
 *
 * The invariants, each of which is a line of the loop rather than a note about
 * it:
 *
 *   ONE TURN AT A TIME. A single serialized pump drains a FIFO; a turn that
 *   starts always terminates — exactly one `turn-end`, a closed run, a released
 *   lease — and no second turn opens until it has.
 *
 *   A SEND WHILE A TURN EXISTS SPLICES. `send` while a turn is running, or a
 *   user turn is queued and not yet opened, goes through the actor's inbox and
 *   lands at that turn's next step; nothing running starts a user turn. A
 *   splice that never sees a step boundary reruns as the immediate next turn.
 *
 *   DURABLE BEFORE ACKNOWLEDGED. Every accepted send is a `pending_steers` row
 *   before the caller hears it was taken; a user turn's opening row is on disk
 *   at admission, before the model is asked anything.
 *
 *   LANDED ROWS AT THE DRAIN. A steer the model has read is a durable user row
 *   parented to its turn's opening row, written when the drain saw it and in
 *   the same transaction as the reservation it spends.
 *
 *   THE COMMIT IS ONE TRANSACTION. The answer, the retirement of the
 *   reservations it spends and the frozen roster of what it owes land together
 *   or not at all.
 *
 *   LEFTOVER RERUNS AS ONE USER-ORIGIN TURN. Steers a settling turn could not
 *   splice rerun at the queue front as the operator's next turn, each id
 *   reserved to that turn before it is admitted.
 *
 *   RESTART REPLAYS. On open, acknowledged sends a dead process left are
 *   restored — mid-turn rows into the inbox, idle rows as reruns in acceptance
 *   order; a stranded event delivery is re-pended under the single-driver
 *   lease; owed terminal effects resume through the backend's ledger.
 *
 *   AN INTERRUPTED TURN CONTINUES. A turn the process died inside is re-opened
 *   by the next one where it stopped, not restarted, and ONCE: the
 *   continuation runs under the run the dead process opened, so the run that
 *   was open is the run that closes. The run ledger holds
 *   every completed step's messages (`step_finish`) and the in-flight step's
 *   output at the last partial cadence (`step_partial`, written on the first
 *   delta and then every {@link PARTIAL_FLUSH_EVERY}), and the continuation
 *   re-enters them as the assistant's own prior output, so the model makes
 *   only the remaining calls, no tool whose result is in the ledger runs
 *   again, a tool call cut before it answered is repaired to an explicit
 *   interrupted outcome the model reads, and the answer persisted is the
 *   concatenation the client streamed. A turn cut before any output is the
 *   degenerate case: nothing to re-enter, so it is the same turn run again.
 */

import type { ModelMessage } from 'ai';
import * as v from 'valibot';
import type { ChatEvent } from '../chat';
import { runWorkModeInvocation } from '../execution/work-mode';
import type { EventLog } from '../events/hub/log';
import type { RunEventRecorder } from '../events/recorder';
import type { PartialToolCall, RunEvent } from '../events/types';
import type { CompletedTurn } from '../evolution/types';
import { estimateTokens } from '../llm';
import { diagnostics, KinuError, renderThrownChain, toKinuError, type Refusal } from '../obs/index';
import { stepContextLimit, type ModelWindow } from '../prompting/step-prune';
import { workModeForTurnMetadata } from '../prompting/surface';
import { runOperationProfile } from '../profiles/operation';
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
import type { ActorSession, ActorTurnLease, ActorExecutionInput, ActorExecutionResult } from './actor-session';
import { CompletionGate, COMPLETION_GATE_EVENT } from './completion-gate';
import type { LandedSteerRow, PendingSendRow, PendingSendStore, UserSteer } from './inbox';
import type { OwedEffect } from './terminal-effects';
import type { TerminalTransition, TerminalTransitions } from './terminal-transition';
import {
  applyOverflowRecovery, classifyRunEnd, closeTurnRun, creditedTurnId, openTurnRun,
  owesOutputLimitContinuation, OUTPUT_CONTINUATION_EVENT, persistMeasuredPromptTokens, snapshotCompletedTurn,
  type CompactionTriggerState, type RunEndFacts, type RunEndReason,
} from './turn-lifecycle';
import { olderHistoryNotice, type TranscriptStore } from './transcript-store';
import { RECOVERY_BACKOFF_CEILING_MS } from '../utils/recovery-backoff';
import { subordinateTurnContext } from '../subordinates/support';
import { TaskReminders, TASK_REMINDER_EVENT } from '../tasks/reminder';
import type { TaskListStore } from '../tasks/store';
import { inheritedAsModelMessage } from '../heads/head-inference';

type ToolCallArguments = Extract<ChatEvent, { type: 'tool-call' }>['args'];

/**
 * How often an interrupted answer's partial text is made durable: on its first
 * delta, then every this many. ONE cadence for the two consumers of a partial
 * — the loop's own step ledger, which a continuation re-enters into the model
 * call, and a backend's wire replay store, which a reconnecting client is
 * replayed from — so the two never disagree about how much of the answer
 * survived an eviction.
 */
const PARTIAL_FLUSH_EVERY = 10;

/** What one chunk of an in-flight answer means to the cadence: content that
 *  accrues toward the next flush, a settled tool result that flushes at once,
 *  or nothing the cadence counts. */
export type PartialFlushSignal = 'content' | 'settled' | 'none';

/**
 * The ONE decision of when an in-flight answer is made durable, for both
 * stores the doc above names: the first content chunk flushes, then every
 * {@link PARTIAL_FLUSH_EVERY} content chunks, and a settled tool result
 * flushes at once; a step boundary starts the count over. Each stream maps
 * its own chunk types onto the signal, and the rule is here so the two cannot
 * drift apart.
 */
export interface PartialFlushCadence {
  /** Whether this chunk makes the partial durable now. Counts it either way. */
  flushes(signal: PartialFlushSignal): boolean;
  /** A step boundary: the next content chunk flushes again. */
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

/**
 * The grace this backend allows a stranded event delivery: none.
 *
 * `EventLog.unbindStale` takes a grace because a Durable Object activation can
 * be racing its own predecessor and has no way to exclude it. This loop
 * does: {@link ChatSession.reclaimStrandedEventDeliveries} runs under the
 * single-driver lease, so no other process is driving this conversation and this
 * session has not drained yet — every OPEN lease is a dead process's by
 * construction. Waiting out a clock would only delay work that is already
 * provably abandoned.
 */
const NO_STRANDED_DELIVERY_GRACE = 0;

/**
 * One response's answer and everything it owes, as one durable commit.
 *
 * `facts` travel rather than the classification, because the run row is sealed
 * AFTER this commit while the roster is frozen inside it. `classifyRunEnd` is a
 * pure function of these facts, so the reason the roster carries and the reason
 * the run row is sealed with cannot disagree: there is one value behind both.
 */
interface CommittedTurn {
  readonly messageId: string;
  readonly facts: RunEndFacts;
  readonly turn: CompletedTurn;
  readonly owed: readonly OwedEffect[];
  /** What core claims this sequence under. Null for a response whose turn has
   *  no durable identity: that sequence runs unledgered and records no intent. */
  readonly transition: TerminalTransition | null;
}

/** Whether the turn reached disk. A failure is reported rather than thrown,
 *  because the signal settle after it must run either way. */
type TurnCommit = { readonly committed: CommittedTurn } | { readonly failure: KinuError };

/** What the frontends render. A superset of runChat's ChatEvent with the
 *  lifecycle + side-channel (evolution, broadcast, background) events. */
export type SessionEvent =
  | { type: 'turn-start'; kind: 'user' | 'programmatic'; text: string; event?: string; workMode: WorkMode;
      /** The opening row's id and the answer's id, both minted at admission,
       *  so a transport can key a turn's frames and its persisted row. */
      turnId: string; messageId: string }
  | { type: 'text-delta'; delta: string }
  | { type: 'tool-call'; toolName: string; toolCallId: string; args: ToolCallArguments }
  | ({ type: 'tool-result'; toolName: string; toolCallId: string; result: string } & ToolOutcome)
  | { type: 'turn-end'; turn: CompletedTurn }
  | { type: 'error'; message: string }
  | { type: 'evolution'; event: string; message: string }
  // Job, event-delivery and connection lifecycle — the machinery AROUND a
  // turn, kept apart from `evolution` so "the agent changed itself" and
  // "a background job settled" never share a channel: `kinu exec
  // --no-auto-evolve` pins evolution silent while jobs may still settle.
  | { type: 'background'; event: string; message: string }
  | { type: 'broadcast'; event: BroadcastEvent }
  /** One durable run-event, forwarded live as the recorder writes it. The
   *  run_events table is the agent's instrumentation ledger (nudges, context
   *  budget, refused budgets); a container-scoped database dies with the
   *  container, so the stream is the only way an outside observer sees it. */
  | { type: 'run-event'; event: RunEvent };

interface QueueItem {
  text: string;
  /** Attachments for a user turn — forwarded to the model as file parts. */
  files?: ReadonlyArray<PromptFile>;
  metadata?: ProgrammaticTurn['metadata'];
  /** The producer's name for the fact this programmatic turn announces. The
   *  durable row's id is derived from it, so a re-announcement collides with
   *  the row the first one wrote (see `persist`). */
  idempotencyKey?: string;
  kind: 'user' | 'programmatic';
  /** The turn's durable id, minted at admission — not when the pump happens
   *  to reach it. A steer accepted while the item sits queued binds to it,
   *  the same way a cf steer binds to the turn whose message already exists. */
  turnId?: string;
  /** The pending_steers row this user item was admitted as: present when the
   *  accepted send itself is the message, retired when its user row is durable. */
  pendingSendId?: string;
  /** The durable ids of the pending rows a user-origin rerun merges into its
   *  one row — retired with that row, so a restart cannot re-deliver them. */
  steerIds?: readonly string[];
  /** A user turn the seam reran from a settled turn's leftover steers — placed
   *  at the queue front, behind only earlier reruns of the same settle. */
  rerun?: true;
  /** A programmatic turn that is a move OFFERED, not an event that must be
   *  heard: if an operator message is admitted ahead of it — queued behind it
   *  here, or already durable — the pump yields the slot and settles it
   *  'yielded' without running a turn. See ProgrammaticTurn.yieldsToUserMessage. */
  yieldsToUserMessage?: boolean;
  /** The turn a dead process left open, re-opened here under its own ids:
   *  what it had already produced, re-entered ahead of the remaining calls. */
  continuation?: TurnContinuation;
  /**
   * Settle whoever queued this item — exactly once, and told whether the turn
   * RAN.
   *
   * A refusal is the driver lease saying another process owns this
   * conversation, which means this turn did not happen. That has to reach the
   * producer, because the producer is the only one who can put things back: an
   * event drain has rows bound to a turn nobody will run, and a person has a
   * message that was never sent. Reporting a refused item as a completed one —
   * which a success-only `resolve()` cannot help doing — loses the event and
   * discards the message in silence.
   */
  settle: (refusal: Refusal | null, yielded?: boolean) => void;
}

/** What a re-opened turn resumes from: the answer's id it was streaming under,
 *  the completed steps' messages and the cut step's output. */
interface TurnContinuation {
  /** The run the dead process opened. The continuation runs UNDER it — its
   *  steps and its seal append to that run — so the run that was open is the
   *  run that closes, and a later restart finds nothing to re-open. */
  readonly runId: string;
  readonly messageId: string;
  readonly steps: readonly ModelMessage[];
  readonly partial: { readonly text: string; readonly toolCalls: readonly PartialToolCall[] } | null;
}

/** What a tool that was cut before it answered tells the model on the
 *  continuation: the outcome is stated, never dropped, so the model knows the
 *  call never ran to completion and can decide to make it again. */
const INTERRUPTED_TOOL_OUTPUT = 'This tool call was interrupted before it produced a result; the process running it stopped. Make the call again if its result is still needed.';

/** A turn's input as the model message the working history carries: the
 *  attachments as file parts — the shape ai's convertToModelMessages emits
 *  for FileUIParts, so multimodal models receive them natively — then the
 *  text. */
function turnInputMessage(item: Pick<ChatTurnInput, 'text' | 'files'>): ModelMessage {
  const fileParts = (item.files ?? []).map((f) => ({
    type: 'file' as const, data: f.url, mediaType: f.mediaType, filename: f.filename,
  }));

  return fileParts.length > 0
    ? { role: 'user', content: [...fileParts, { type: 'text' as const, text: item.text }] }
    : { role: 'user', content: item.text };
}

/**
 * A continuation's answer row. The cut step's text the last process left is
 * the answer's own head only when the step this process resumed IS the answer:
 * the cut step issued no tool call and this process finished it in one step
 * (or was cut again, and the streamed text stands). A cut inside a NARRATION
 * step — one that went on to call tools before the turn answered — leaves text
 * that belongs to that step, already in the client's rendering of it, and not
 * in front of the answer. The finished steps' text is never joined: it is in
 * the ledger as those steps' own messages.
 */
function continuedAnswer(
  continuation: TurnContinuation | undefined,
  execution: Pick<ActorExecutionResult, 'text' | 'steps' | 'interrupted'>,
): string {
  const partial = continuation?.partial;

  if (partial === undefined || partial === null || partial.toolCalls.length > 0) return execution.text;

  return execution.interrupted || execution.steps <= 1 ? partial.text + execution.text : execution.text;
}

/**
 * The assistant's prior output for a re-opened turn, as model messages: every
 * finished step's messages as recorded, then the cut step — its text and the
 * tool calls it issued as one assistant message, each call answered by the
 * result the ledger holds or, for a call cut before it answered, by the
 * explicit interrupted outcome (the repair the SDK's own recovery applies to a
 * dangling tool part). A cut step that produced nothing adds nothing.
 */
function priorOutputOf(continuation: TurnContinuation): ModelMessage[] {
  const messages: ModelMessage[] = [...continuation.steps];
  const partial = continuation.partial;

  if (partial === null || (partial.text === '' && partial.toolCalls.length === 0)) return messages;

  messages.push({
    role: 'assistant',
    content: [
      ...(partial.text === '' ? [] : [{ type: 'text' as const, text: partial.text }]),
      ...partial.toolCalls.map((call) => ({ type: 'tool-call' as const, toolCallId: call.toolCallId, toolName: call.toolName, input: call.args })),
    ],
  });

  if (partial.toolCalls.length > 0) {
    messages.push({
      role: 'tool',
      content: partial.toolCalls.map((call) => ({
        type: 'tool-result' as const,
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: call.error !== undefined
          ? { type: 'error-text' as const, value: call.error }
          : { type: 'text' as const, value: call.result ?? INTERRUPTED_TOOL_OUTPUT },
      })),
    });
  }

  return messages;
}

/** How events reach the client: the CLI's in-process callback today, a
 *  WebSocket frame writer on the hosted backend later. May throw — the session
 *  records the failure and the loop continues. */
export interface ChatTransport {
  deliver(event: SessionEvent): void;
}

/** What the backend's assembly reads of an admitted turn. */
export interface ChatTurnInput {
  readonly kind: 'user' | 'programmatic';
  readonly text: string;
  readonly files?: ReadonlyArray<PromptFile>;
  readonly metadata?: ProgrammaticTurn['metadata'];
  /** The producer's name for the fact a programmatic turn announces, when it
   *  named one: what a backend reads to know WHICH decision this turn is the
   *  handoff of. Absent on a user turn. */
  readonly idempotencyKey?: string;
  /** What the turn had already produced when the last process died — the
   *  assistant's own prior output, placed after the input on the working
   *  history so the model continues rather than starts over. Absent on a
   *  turn that is new. */
  readonly priorOutput?: readonly ModelMessage[];
}

/** One assembled turn, ready to execute. */
export interface PreparedTurn {
  /** Everything `ActorSession.execute` runs, except the task text the loop
   *  supplies. */
  readonly execution: Omit<ActorExecutionInput, 'task'>;
  /** The compaction key the turn measured its trigger under. */
  readonly sessionKey: string;
  /** The window the turn was budgeted against, for overflow recovery. */
  readonly contextWindow: number;
  /** The durable history length the compaction measurement was bound to. */
  readonly historyLength: number;
}

/** Every value the roster declaration reads, taken while the turn is still in
 *  memory. */
export interface OwedTerminalEffectsInput {
  readonly turn: CompletedTurn;
  readonly status: RunEndReason;
  readonly credited: string | null;
  readonly messageId: string;
  readonly userText: string;
  readonly assistantText: string;
  readonly completed: boolean;
  /** Whether the turn was CUT rather than failing. A task child's caller is
   *  told which, because "interrupted" and "errored" are different answers to
   *  the question it is blocked on. */
  readonly interrupted: boolean;
  readonly startedAt: number;
  /** The turn's inference history, for the shadow trial's recorded replay. */
  readonly trialContext: readonly ModelMessage[];
  /** The tool surface the turn could reach, for the advisor's reachability
   *  check. A cold replay has no live toolset to ask. */
  readonly reachableTools: readonly string[];
  readonly overflowRetry: boolean;
  /** The event deliveries this turn answered: the drain turn it was queued
   *  for, and every signal it absorbed mid-turn. A backend with reply
   *  channels owes each an outbound reply. */
  readonly answeredDeliveries: ReadonlySet<string>;
  /** The turn's last model step ended at the output limit, and the turn was
   *  not itself a continuation — ONE continuation is owed. */
  readonly outputContinuation: boolean;
  /** The reminder this turn owes because it settled with open tasks: the
   *  already-rendered signal text, or null when the decision said none. */
  readonly taskReminder: { readonly text: string } | null;
}

/**
 * What the loop cannot know and the backend must supply. Each port is asked
 * per call, never captured.
 */
export interface ChatSessionPorts {
  /** Assemble the admitted turn — model, system prompt, tools, extensions —
   *  and place its input on the actor's working history. Runs after the
   *  opening row and the run are durable and before the first model call;
   *  whatever it throws ends the turn as an error with one `turn-end`. */
  prepareTurn(item: ChatTurnInput, lease: ActorTurnLease): Promise<PreparedTurn>;
  /** What the settled turn owes, as the backend's roster declares it. */
  owedTerminalEffects(input: OwedTerminalEffectsInput): OwedEffect[];
  /** The once-only lifecycle over the backend's effect bodies. Asked per
   *  call: the bodies close over stores built after this session. */
  terminal(): TerminalTransitions;
  /** Keep the platform alive until a terminal close settles. */
  holdTerminalClose(transition: TerminalTransition, close: () => Promise<void>): void;
  /** Whether this process may drive the conversation right now. Asked per
   *  item at dequeue and before a drain binds rows; a refusal settles the item
   *  to its producer rather than running it. Null when nothing coordinates. */
  driverGate(): Refusal | null;
  /** Arm the durable wake that re-drives owed work when the isolate dies
   *  inside this turn, at the instant the loop names. Called at the turn's
   *  synchronous open — an isolate killed mid-turn with nothing else owed
   *  would otherwise sleep until an external event. Soonest-wins: free when
   *  a wake already rides. A backend whose process IS the wake (the local
   *  session) arms nothing here: a crashed turn there re-arms from the ledger
   *  on the next start, and a timer inside the process it would have to
   *  outlive is not a wake. */
  armTurnWake(atMs: number): Promise<void>;
  /** This actor's task list — the reminder decision reads it at commit, never
   *  captured earlier: a replayed roster already froze its answer, and a live
   *  one owes the list as it stands when the turn settles. */
  taskList(): TaskListStore;
  /** Whether this actor has background work in flight whose own settle wakes
   *  the session — a reminder fired behind it would race the wake. */
  hasPendingAsyncWake(): boolean;
  /** The model window the transcript restore is budgeted against. */
  modelWindow(): ModelWindow;
  /** The skill bodies a mid-turn send activates that the running turn does
   *  not already carry, rendered for the next step, or null
   *  (`steerSkillsBlock`). */
  steerSkills(text: string): Promise<string | null>;
  /** Why a programmatic PLAN turn cannot be admitted here, or null when it
   *  can: a plan turn ends in a review the operator decides on, and a backend
   *  with no review surface refuses the turn at admission rather than run a
   *  plan nobody can approve. */
  planTurnRefusal(): string | null;
}

export interface ChatSessionOptions {
  readonly actorSession: ActorSession;
  readonly sessionId: string;
  readonly transcript: TranscriptStore;
  /** The ONE pending-send ledger's store — every acknowledged send's row read
   *  and write goes through core's PendingSendStore, the same object the cf
   *  actor holds. Bound to the session's own actor id. */
  readonly pendingSends: PendingSendStore;
  readonly eventLog: EventLog;
  /** Durable per-run event log (run_events) — the same recorder both
   *  backends write. */
  readonly eventRecorder: RunEventRecorder;
  readonly compactionState: CompactionTriggerState;
  /** A REAL transaction. The answer, the run row and the frozen roster are
   *  committed inside one, and so are a drain's landed rows with the
   *  reservations they spend. A torn write that reports success is what an
   *  identity-function stand-in would buy. */
  readonly transaction: <T>(body: () => T) => T;
  readonly transport: ChatTransport;
  readonly ports: ChatSessionPorts;
  /** How the session mints an answer's id — the key every durable row of the
   *  answer is written under. Each owner names its minter: a random UUID, or
   *  the id a harness must assert on before it reads it back. */
  readonly mintAnswerId: () => string;
}

export class ChatSession {
  private readonly actorSession: ActorSession;
  private readonly sessionId: string;
  private readonly transcript: TranscriptStore;
  private readonly pendingSends: PendingSendStore;
  private readonly eventLog: EventLog;
  private readonly eventRecorder: RunEventRecorder;
  private readonly compactionState: CompactionTriggerState;
  private readonly transaction: <T>(body: () => T) => T;
  private readonly transport: ChatTransport;
  private readonly ports: ChatSessionPorts;
  private readonly mintAnswerId: () => string;
  private ended = false;
  /** The run the in-flight turn belongs to; null between turns. */
  private runId: string | null = null;
  /** The id the in-flight turn's opening row carries — minted at turn start,
   *  written by `persist`, and the scope every effect claim this turn makes is
   *  keyed to. Null between turns. */
  private turnId: string | null = null;
  /** The running programmatic turn's opening row, as its commit will write
   *  it, for a steer that lands before the commit; null for a user turn,
   *  whose row is durable from admission. */
  private openingRow: { id: string; text: string; metadata?: JsonObject } | null = null;
  /** The id the in-flight turn's answer is persisted under — minted with the
   *  turn, streamed under, committed under. */
  private messageId = '';
  /** The mechanical completion gate (core completion-gate.ts). Armed only by a
   *  one-shot task turn: on the interactive surface the human reading the
   *  answer is the check, so it never arms and costs nothing. */
  readonly completionGate = new CompletionGate();
  /** The stop-time task reminder's memory for this conversation — attempts
   *  and the unanswered-reminder latch (core tasks/reminder.ts). */
  private readonly taskReminders = new TaskReminders();
  /** FIFO of turns to run — user inputs + programmatic injects (reactor / job
   *  wake), drained by a single serialized pump so turns never interleave. */
  private readonly queue: QueueItem[] = [];
  private pumpActive = false;
  /** The idempotency key of the turn the pump is running RIGHT NOW, or null.
   *  An item is shifted out of the queue before it runs and its durable row
   *  lands at the end, so this is the only thing that says "already being said"
   *  for the whole length of a turn. */
  private runningAnnouncement: string | null = null;
  /** The active pump run's completion, or null when idle — the awaitable
   *  settleBackgroundWork() joins so a one-shot run can wait for wake turns. */
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

    // THE ONE SEND RULE, the loop's half: every send the session
    // acknowledges is a pending_steers row first and a landed row or retired
    // row after — never a buffer the process alone can lose. Bound here, not
    // on the ActorSession's own wiring, because the hosted actor's session is
    // built by the host without a view of this workspace's queue.
    this.actorSession.bindSteerPersistence({
      onAccept: (steer) => { this.pendingSends.reserve({ ...steer, turnId: this.steerTurnId() }); },
      onDrain: (rows) => { this.commitLandedSteers(rows); },
      turnId: () => this.steerTurnId(),
      skills: (text) => this.ports.steerSkills(text),
    });
    this.restoreOpenTurn();
    this.restorePendingSends();
  }

  /** The active pump run's completion, or null when idle. */
  get pumpPromise(): Promise<void> | null { return this.activePump; }
  get pumping(): boolean { return this.pumpActive; }
  get currentRunId(): string | null { return this.runId; }
  /** The runs this loop is driving, for the wake reconcile that seals what a
   *  dead activation left open: the turn running now, and the one
   *  {@link restoreOpenTurn} re-opened but has not yet started — that run is
   *  continued under its own id, so it is open on purpose. */
  drivenRuns(): readonly string[] {
    return [...new Set([this.runId, this.reopenedRunId].filter((runId): runId is string => runId !== null))];
  }
  get currentTurnId(): string | null { return this.turnId; }
  /** No further programmatic turn is admitted, and a send this constructor
   *  restored does not pump. The owner's teardown calls this first. */
  close(): void { this.ended = true; }
  get closed(): boolean { return this.ended; }

  /**
   * Terminal transitions running right now, on the PUMP's own stack.
   *
   * A terminal effect settles a turn from inside the pump that ran it, and one
   * of them (`event_drain`) delivers signals — which for a settling turn take
   * the QUEUE arm, because the turn has no steps left to splice into. Awaiting
   * that queued turn's EXECUTION from here cannot resolve: the executor is the
   * caller. Settle -> inline drain -> enqueue -> wait for the pump -> pump
   * waits for settle, with nothing timing out.
   *
   * So while this is non-zero, {@link enqueueTurn} answers at ADMISSION rather
   * than at execution. That is the answer the drain actually wants — the signal
   * seam compensates on anything but `queued`, and `queued` means accepted, not
   * started. A caller outside the pump keeps the execution-awaiting contract,
   * which the fiber wake path depends on.
   *
   * The terminal roster runs inside the pump, so an inline event drain must
   * wait only for queue admission, not for execution by that same pump. A
   * debounced drain runs outside this stack and does not exercise that
   * re-entrant wait.
   */
  private settlingDepth = 0;

  /** Inject a programmatic turn into the same serialized loop the user drives —
   *  backs the reactor + background-job wake. Self-starts the pump when idle so
   *  a job that settles mid-idle wakes the agent immediately.
   *
   *  A producer that named the fact it is announcing (`idempotencyKey`) gets
   *  that name carried onto the durable row, and a re-announcement of a fact
   *  this session already recorded starts no turn at all: the row is already
   *  there and already answered, so 'queued' is the truth the producer needs
   *  (nothing was lost, do not compensate) without a second turn spent saying
   *  it again. The check reads the same durable table the write lands in — the
   *  ledger IS the store here — so a later process reaches the same answer. */
  enqueueTurn(input: ProgrammaticTurn): Promise<EnqueueTurnResult> {
    // The operator's own words, from the inbox — a settled turn's leftovers
    // rerun, or a message that reached the inbox between one turn's settle
    // and the next send. Either way the operator's IMMEDIATE next turn, ahead
    // of everything else queued, behind only earlier user-origin turns, and
    // answered at admission: the settle that reruns leftovers is on this
    // pump's own stack, so its execution cannot be awaited from here.
    if (input.origin === 'user') {
      const item: QueueItem = {
        text: input.text,
        kind: 'user',
        ...(input.files !== undefined && { files: input.files }),
        metadata: input.metadata,
        rerun: true,
        // The opening row keeps the id the FIRST merged message already
        // carries: the surface that rendered that message finds its row under
        // the name it holds, and a transport that answers a client's request
        // by the turn's id resolves it. Only a rerun of nothing named — no
        // steer ids at all — mints one.
        turnId: input.steerIds?.[0] ?? crypto.randomUUID(),
        // The pending rows this rerun merges are spent by ITS durable row —
        // retired with it in the same transaction, so a restart cannot
        // re-deliver steers the rerun already carries.
        steerIds: input.steerIds,
        settle: () => {},
      };

      // A send that reached the queue while another user turn held the pump is
      // still a send the session acknowledged: each id it merges gets a row
      // bound to THIS turn's id before the item is admitted — `OR IGNORE`
      // because a leftover rerun's ids already carry theirs.
      const mode: WorkMode = workModeForTurnMetadata(input.metadata) === 'plan' ? 'plan' : 'build';

      for (const steerId of item.steerIds ?? []) {
        this.pendingSends.ensureReserved({ id: steerId, turnId: item.turnId ?? null, mode, text: input.text });
      }

      const front = this.queue.findIndex((queued) => queued.rerun !== true);
      this.queue.splice(front === -1 ? this.queue.length : front, 0, item);
      void this.pump();

      return Promise.resolve({ status: 'queued' });
    }

    if (workModeForTurnMetadata(input.metadata) === 'plan') {
      const refusal = this.ports.planTurnRefusal();

      if (refusal !== null) return Promise.reject(new Error(refusal));
    }

    // A reminder signal is admitted only while the ledger still says its row is
    // owed. `hasAnnounced` dedupes a re-delivery of a turn that already ran; a
    // signal whose row closed some other way — the turn's commit rolled back,
    // or a replay that lands after the sequence settled — is answered 'queued'
    // so the producer's row completes, but no turn starts for it.
    if (input.metadata?.kinuEvent === TASK_REMINDER_EVENT
      && !this.ports.terminal().ledger.hasOwed('task_reminder')) {
      return Promise.resolve({ status: 'queued' });
    }

    // A job settling during shutdown must not start a turn the ending session
    // will never drain: 'skipped' sends the caller down its durable-breadcrumb
    // path instead, and the next run drains it from the event log.
    if (this.ended) return Promise.resolve({ status: 'skipped' });

    if (input.idempotencyKey !== undefined && this.hasAnnounced(input.idempotencyKey)) {
      return Promise.resolve({ status: 'queued' });
    }

    const { promise, resolve } = Promise.withResolvers<EnqueueTurnResult>();

    const item: QueueItem = {
      text: input.text,
      metadata: input.metadata,
      kind: 'programmatic',
      // 'skipped' is what a producer with a durable retry plane acts on: the
      // signal seam compensates on anything but 'queued', which is how an event
      // drain gets its rows back when another process holds the driver lease.
      // 'yielded' is neither: the offer was consumed at its slot, so nothing
      // comes back and nothing is retried.
      settle: (refusal, yielded) => resolve({
        status: yielded === true ? 'yielded' : refusal ? 'skipped' : 'queued',
      }),
    };

    if (input.idempotencyKey !== undefined) item.idempotencyKey = input.idempotencyKey;

    if (input.yieldsToUserMessage === true) item.yieldsToUserMessage = true;
    this.queue.push(item);

    if (this.settlingDepth > 0) {
      // Accepted, not started. `item.settle` still runs when the pump reaches
      // it; resolving twice is harmless, and the caller gets an answer it can
      // act on instead of a promise only it could complete.
      void this.pump();

      return Promise.resolve({ status: 'queued' });
    }

    void this.pump();

    return promise;
  }

  /** Is this fact already recorded in the durable transcript, already queued to
   *  be, or being said right now? All three matter: a cold activation asks the
   *  table, a second delivery inside one activation (recover + recoverOrphans
   *  naming the same job) asks the queue, and a producer whose retry falls due
   *  mid-turn asks the running key — neither of the others shows a turn that has
   *  started and not yet persisted. */
  private hasAnnounced(identity: string): boolean {
    return this.announcementInFlight(identity) || this.announcementOnDisk(identity);
  }

  /** Queued, or running right now. */
  announcementInFlight(identity: string): boolean {
    return this.runningAnnouncement === identity
      || this.queue.some((item) => item.idempotencyKey === identity);
  }

  /** Recorded in the durable transcript — the half a later process can read. */
  announcementOnDisk(identity: string): boolean {
    return this.transcript.has(`${PROGRAMMATIC_MESSAGE_ID_PREFIX}${identity}`);
  }

  /** BackendHost seam — will there be a next step for a message to land on?
   *
   *  The actor owns the preparing/running boundary; settling has no next step.
   *  A message received during asynchronous preparation can reach step zero.
   *  A user turn this session has queued and not yet opened counts too: a
   *  message arriving behind it rides that turn's first step rather than
   *  queueing a turn of its own behind it.
   *
   *  A user splice and an event splice land at the same step tail as two
   *  adjacent user-role messages, which every provider adapter groups into one
   *  turn. */
  turnInFlight(): boolean {
    return this.actorSession.inFlight || this.queue.some((item) => item.kind === 'user');
  }

  // ── Public driver API ──────────────────────────────────────────────

  /**
   * Send the user's message — the one entry, whatever the session is doing.
   *
   * A turn is running (or one this session queued has not yet opened): the
   * message goes through the inbox and lands at that turn's next step, where
   * everything pending drains into one merged user message; the answer is
   * `'mid-turn'`, at once. Input that never sees a step boundary (the model
   * was already writing its final answer) reruns as the immediate next turn.
   *
   * Nothing is running: the message starts a user turn (and any programmatic
   * turns it cascades) and the answer is `'turn'` when that turn has finished.
   * Attachments (data-URL PromptFiles) become file parts on the turn's user
   * message either way.
   *
   * REJECTS when another process holds this conversation's driver lease. The
   * message was not sent and no turn ran, so resolving would tell the person
   * their words landed when they were dropped; the rejection names the holder
   * and what to do about it.
   */
  async send(
    input: string | { text: string; files: ReadonlyArray<PromptFile> },
    opts: {
      readonly tier?: TierId;
      /** The message's own id, when the client minted one: the opening row,
       *  the reservation and every announcement then carry the id the client
       *  already renders under. Absent, the session mints one. */
      readonly id?: string;
      /** The composer's mode, a fact on the message: a turn it starts runs
       *  under it, and a splice's leftovers rerun under it. Build by default. */
      readonly mode?: WorkMode;
    } = {},
  ): Promise<SendLanding> {
    const { text, files } = normalizePromptInput(input);

    // The operator spoke: the reminder count starts over, whether these words
    // splice into the live turn or open one of their own.
    this.taskReminders.noteUserPrompt();

    // Nothing to say and nothing attached is not a message: refused at the
    // door, never a blank turn or a blank steer the model is asked to read.
    if (text.trim() === '' && (files === undefined || files.length === 0)) {
      throw new KinuError('bad_input', 'send requires the message text');
    }

    if (this.turnInFlight()) {
      // Identity is assigned on ACCEPTANCE, so the queued announcement, the
      // landed one and the durable row are all the same message to a surface —
      // which is what stops one being rendered twice under two names.
      const id = opts.id ?? `steer-${crypto.randomUUID().slice(0, 12)}`;
      const steer: UserSteer & { readonly id: string; readonly mode?: WorkMode } = { text, id, ...(opts.mode !== undefined && { mode: opts.mode }) };

      if (files !== undefined && files.length > 0) Object.assign(steer, { files });
      const outcome = await this.actorSession.send(steer);

      if (outcome === 'mid-turn') return 'mid-turn';

      if (outcome === 'queued') return 'turn';
      throw new KinuError('unavailable', 'The message could not be handed to the running turn. Send it again.');
    }

    const { promise, resolve, reject } = Promise.withResolvers<SendLanding>();
    const mode = opts.mode ?? 'build';

    // The message's own facts, on the row it becomes: the mode it was typed
    // under (build unless the composer said otherwise) and the tier it named.
    const metadata: JsonObject = {
      ...(opts.tier !== undefined && { profile_tier: opts.tier }),
      kinuMode: mode,
    };

    // The acceptance and the row are the same fact: the pending_steers insert
    // runs BEFORE the pump can begin the turn, so a process that dies after
    // this line still owes the person the message it acknowledged.
    const pendingSendId = opts.id ?? `steer-${crypto.randomUUID().slice(0, 12)}`;
    this.pendingSends.reserve({ id: pendingSendId, turnId: null, mode, text, files });
    this.queue.push({
      text, files, metadata, kind: 'user',
      turnId: opts.id ?? crypto.randomUUID(), pendingSendId,
      settle: (refusal) => {
        // A refusal means this process never owed the message — another driver
        // took it — so the reservation goes with the refusal. Leaving it
        // would re-deliver the words under the next session after the caller
        // was already told no.
        if (refusal) {
          this.pendingSends.retire([pendingSendId]);
          reject(new KinuError(
            refusal.reason,
            `${refusal.error}. Close that session, or send this from it.`,
          ));

          return;
        }

        resolve('turn');
      },
    });
    this.pump();

    return promise;
  }

  /** Abort the in-flight turn (Ctrl+C / Esc). Pending steers are dropped —
   *  an interrupt means "stop", not "stop and do what I typed" — but the
   *  dropped texts are RETURNED so the surface can hand them back to the
   *  user (the composer restore), never lose them silently: the chat already
   *  rendered them as sent. */
  interrupt(): string[] {
    const returned = this.actorSession.interrupt();
    // The words came back to the surface: the reservation they were held under
    // is spent, or a restart would re-deliver a steer the operator watched come
    // back as text. A steer that carries no id never wrote a row to spend.
    this.pendingSends.retire(returned.flatMap((steer) => steer.id === undefined ? [] : [steer.id]));

    return returned.map((steer) => steer.text);
  }

  /** Stop the turn on screen (the composer's Stop button): the in-flight
   *  model request is aborted, and the steers the model never saw STAY
   *  queued — the settle reruns them as the operator's next user-origin turn.
   *  The other verb, {@link interrupt}, hands them back instead. */
  stop(): void {
    this.actorSession.stop();
  }

  /** Run any pending event drain to completion NOW, bypassing the ~250ms
   *  debounce window. The scheduler daemon fires due triggers then ends the
   *  session immediately, so the debounced drain fireDueTriggers armed would
   *  never fire (end() sets `ended`, and the drain timer skips when ended) —
   *  the fired trigger's autonomous turn would be silently dropped. A batch
   *  tick calls this before end() to flush its work synchronously. A direct
   *  drain is safe: pending events are durable in the EventLog until
   *  markConsumed, so drainPendingEvents consumes-or-returns them exactly once.
   *  Interactive sessions keep the debounced path untouched — end() on Ctrl-C
   *  must not suddenly run an autonomous turn. */
  async flushPendingDrains(): Promise<void> {
    if (this.ended) return;
    // Gated HERE as well as at the pump, because the drain BINDS the rows it
    // selects (markConsumed) on its way to the pump. A refusal one step later
    // is recoverable — the queue item settles refused and the drain hands the
    // rows back — but a refusal here means they were never bound at all, which
    // is the outcome to prefer when the answer is already knowable. The gate is
    // the same object either way, and re-asking it costs one row read.
    const refusal = this.ports.driverGate();

    if (refusal) {
      diagnostics.event('driver.drain_deferred', { reason: refusal.reason });

      return;
    }

    await this.actorSession.orchestrator.drainPendingEvents();
  }

  /**
   * Re-pend the event deliveries a dead process left leased.
   *
   * A drain BINDS its selected events to a synthetic `evt-…` turn and opens a
   * recovery lease on them (`consumed_at`), then hands them to the signal seam,
   * which either splices them into the live turn or queues one. Everything from
   * that point until the turn's answer is on disk lives in ONE process's memory:
   * kill it there and the rows stay bound to a turn nobody will ever run —
   * invisible to `pending()`, so no later drain, wake or restart can see them.
   * An event the log admitted then simply never happens.
   *
   * There is no clock here and there does not need to be one — see
   * {@link NO_STRANDED_DELIVERY_GRACE} for why the lease this runs under is the
   * whole argument. An answered delivery is never open, because a turn that
   * reached disk closes its own lease ({@link closeEventDeliveryLeases}), which
   * is what makes reclaiming the rest a recovery rather than a re-delivery.
   *
   * Call once at startup, before the recovery drain, so the rows it hands back
   * are in that same drain's selection.
   */
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

  // ── Internals ──────────────────────────────────────────────────────

  emit(event: SessionEvent): void {
    try {
      this.transport.deliver(event);
    } catch (error) {
      // A frontend render error must not kill the agent loop — but it is still a
      // defect, and the event stream that would have shown it is the thing that
      // just failed, so stderr is the only channel left.
      diagnostics.failure(
        'session.event_listener_failed',
        toKinuError({ doing: 'delivering a session event to the frontend listener', cause: error, otherwise: 'io' }),
        { eventType: event.type },
      );
    }
  }

  /** Kick the serialized turn pump if idle — idempotent, so a concurrent
   *  enqueueTurn just appends and the running pump picks it up. The active
   *  run's promise is tracked (pumpPromise) so settleBackgroundWork() can
   *  await wake turns to completion. */
  pump(): void {
    if (this.pumpActive) return;
    this.pumpActive = true;
    const running = this.runPump();

    // Assigned only if the pump is STILL running. `runPump` on an empty queue
    // reaches no await, so it runs to completion inside this call and clears both
    // fields on its way out — an unconditional assignment would reinstate a
    // resolved promise as the live one, which every later `settleBackgroundWork`
    // spins on forever. An empty kick is legitimate (a startup replay makes one),
    // so the guard belongs here rather than at each caller.
    if (this.pumpActive) this.activePump = running;
  }

  private async runPump(): Promise<void> {
    try {
      let item: QueueItem | undefined;

      while ((item = this.queue.shift())) {
        // Checked per ITEM, immediately before the turn runs. A turn is the
        // longest thing this process does and it writes the conversation, so
        // two processes running turns over one database interleave them. An
        // interactive gate takes the lease from a daemon here, which is what
        // stops a user's turn landing inside a daemon-driven one; a gate that
        // refuses means another process of this same kind is driving, and
        // there is nothing to wait for.
        //
        // Settled with the refusal rather than emitted as an error: this turn
        // did not run, and the ONE thing that must happen is that its producer
        // hears so — an event drain compensates its rows back to pending, a
        // person's send fails loudly. The producer owns what to say about it.
        const refusal = this.ports.driverGate();

        if (refusal) {
          diagnostics.event('driver.turn_deferred', { kind: item.kind, reason: refusal.reason });
          item.settle(refusal);
          continue;
        }

        // A turn that was OFFERED yields inside its slot: the check is here,
        // at dequeue, never at admission — a user item queued after the offer
        // was taken, or an operator row already durable, means somebody spoke
        // first and that message is the turn now. Nothing runs, nothing is
        // persisted; the offer is consumed.
        if (item.yieldsToUserMessage === true
          && (this.queue.some((queued) => queued.kind === 'user')
            || this.transcript.operatorSpoke())) {
          diagnostics.event('genesis.yielded_to_message', {
            signal: v.is(v.string(), item.metadata?.kinuEvent) ? item.metadata.kinuEvent : 'unknown',
          });
          // Durable beside the event: the ledger a reader opens after the fact.
          this.actorSession.orchestrator.logActivity('genesis.yielded_to_message');
          item.settle(null, true);
          continue;
        }

        // The key of the turn about to run, so a producer asking whether this
        // fact is already being said gets a truthful answer while it is.
        this.runningAnnouncement = item.idempotencyKey ?? null;

        try {
          await this.processTurn(item);
        } catch (err) {
          diagnostics.failure(
            'turn.processing_failed',
            toKinuError({ doing: 'processing a queued turn', cause: err, otherwise: 'io' }),
          );
        } finally {
          this.runningAnnouncement = null;
          item.settle(null);
        }
      }
    } finally {
      // Cleared synchronously as the loop exits — NOT in a .finally() callback,
      // whose microtask would run after a just-resolved send()'s continuation
      // and leave `pumping` stale-true, so the next send()'s pump() would no-op
      // and orphan its queued turn.
      this.pumpActive = false;
      this.activePump = null;
    }
  }

  /**
   * A harness turn a terminal effect owes — the completion gate's confirming
   * turn, the overflow retry — appended behind everything queued under the
   * effect's own idempotency key, and kicked.
   *
   * Appended rather than unshifted, so anything already queued runs first — it
   * verifies FINAL state. The pump is a no-op while one is running, which is
   * the live case; on a startup replay there is no pump yet, and without this
   * kick the turn would sit in the queue until some unrelated message arrived.
   * The effect has already asked {@link announcementOnDisk} and
   * {@link announcementInFlight}; a settle of `() => {}` because the effect
   * that queued it does not wait on it — the turn's own durable row is what the
   * effect's next replay finds.
   */
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

  /**
   * Seal the in-flight run via the shared core turn-lifecycle bracket.
   * Idempotent per run — clearing the id makes a second call a no-op.
   *
   * FACTS in, name out. `classifyRunEnd` owns the vocabulary; this method
   * reports what it saw and returns the reason it was given. Computing
   * `hadError ? 'error' : 'completed'` here instead would seal a Stop as
   * `'error'` — an interrupt throws `INTERRUPTED_TURN` and the catch folds that
   * into `hadError` — while the cloud seals it `'aborted'`, counting the same
   * user action as a failure on one backend and a choice on the other.
   */
  private closeRun(facts: RunEndFacts, lease: ActorTurnLease): RunEndReason {
    const end = classifyRunEnd(facts);

    // The durable claim closes under the SAME name the run does. It is settled
    // before the early return below, because a second `closeRun` for one run is
    // a no-op on the run row and must not leave the claim open either — and the
    // claim's own settle is idempotent per turn.
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

  /**
   * Run one queued turn under the guarantee every surface above depends on: a
   * turn that starts always terminates — exactly one `turn-end`, and a run that
   * is always closed.
   *
   * The turn's own stream has a failure path that emits `error`, flags the
   * accumulator and finalizes normally. Everything BEFORE that stream exists —
   * resolving the model, the skills, the system prompt — had no such path and
   * threw straight out of the method, past an opened run and before any
   * `turn-end`. The pump then logged it to stderr and resolved the caller, so a
   * turn that never ran a step was reported as a turn that succeeded.
   */
  private async processTurn(item: QueueItem): Promise<void> {
    const parsedEvent = v.safeParse(v.string(), item.metadata?.kinuEvent);
    const event = parsedEvent.success ? parsedEvent.output : undefined;
    const mode = workModeForTurnMetadata(item.metadata);
    // The id the turn's opening row will carry, decided HERE rather than at
    // persist time: the effect claims a tool makes mid-turn are keyed to it, and
    // a re-announced programmatic turn must key to the same one its first
    // announcement did — which is exactly what its idempotency key gives it.
    this.turnId = item.kind === 'programmatic'
      ? `${PROGRAMMATIC_MESSAGE_ID_PREFIX}${item.idempotencyKey ?? crypto.randomUUID()}`
      : item.turnId ?? crypto.randomUUID();
    // The answer's id, minted with the turn's: the roster keys on it at the
    // commit, and a transport streams the answer under it from the first chunk,
    // so the row the client builds live and the row persisted are one message.
    // A re-opened turn keeps the id it was streaming under: the client that
    // reconnects holds that message, and the answer is one row either way.
    this.messageId = item.continuation?.messageId ?? this.mintAnswerId();

    // A USER turn's opening row is durable at admission, not at commit — a
    // steer landed mid-turn is written when the drain sees it (before the
    // turn's commit could exist), so the row it parents to must already be on
    // disk, and a turn the process kills leaves the question it was asked
    // rather than an answer-less steer. Written BEFORE `turn-start` goes out:
    // the loop is the ONE writer of a user row, so a transport that tells its
    // clients the transcript at the turn's opening reads the row from here and
    // never writes one of its own. A PROGRAMMATIC turn writes at commit
    // exactly as before: `announcementOnDisk` is its dedup — an admitted-but-
    // unfinished gate turn must read as not-yet-said so the retry re-queues it.
    this.openingRow = item.kind === 'programmatic'
      ? { id: this.turnId, text: item.text, ...(item.metadata !== undefined && { metadata: stampTurnAuthor(item.metadata) }) }
      : null;

    if (item.kind === 'user') {
      this.transcript.appendUser({
        id: this.turnId, text: item.text,
        ...(item.files !== undefined && { files: item.files }),
        // ONE row shape per message, whichever transport carried it: the
        // operator's own message says so and names the mode it was typed in.
        metadata: { ...item.metadata, [TURN_AUTHOR_METADATA_KEY]: 'operator' },
      });
    }

    this.emit({ type: 'turn-start', kind: item.kind, text: item.text, event, workMode: mode, turnId: this.turnId, messageId: this.messageId });

    const startedAt = Date.now();
    // Open this turn's run in the durable event log (core turn-lifecycle).
    // Provenance mirrors the DO's: a real chat turn is 'chat', a programmatic
    // one names its trigger. A re-opened turn continues the run it was left
    // in; only a new turn opens a run.
    this.runId = item.continuation?.runId ?? `run-${crypto.randomUUID()}`;

    // The re-opened run is this run now, named by `runId` for as long as it
    // runs; nothing else is held open on its behalf.
    if (this.reopenedRunId === this.runId) this.reopenedRunId = null;

    const lease = this.actorSession.beginTurn(
      { runId: this.runId, turnId: this.turnId }, mode, startedAt, item.metadata,
    );

    // The run row already exists for a continuation: what follows appends to
    // it, and the identity it carries is the one being continued.
    if (item.continuation === undefined) openTurnRun(this.eventRecorder, this.runId, {
      agentId: lease.actorId,
      causedBy: event ?? 'chat',
      userMessage: item.text,
      turnIndex: this.actorSession.orchestrator.sessionTurnIndex,
      // The turn this run is for, so a process that dies inside it leaves the
      // next one enough to re-open the same turn where it stopped.
      turn: {
        turnId: this.turnId, messageId: this.messageId, kind: item.kind, text: item.text,
        ...(item.metadata !== undefined && { metadata: item.metadata }),
        ...(item.pendingSendId !== undefined && { pendingSendId: item.pendingSendId }),
        ...(item.steerIds !== undefined && { steerIds: item.steerIds }),
      },
    });

    // The turn's own wake, armed at its synchronous open: a kill inside the
    // turn leaves the run row and the wake that re-drives it, rather than the
    // row alone with nothing scheduled to notice it. Soonest-wins, so this is
    // free when another wake already rides. At the recovery CEILING, not the
    // first lap: this row seeds the chain for a kill, and the tick it delivers
    // keeps a row while the turn is still open — it is not a maintenance pass
    // inside every turn longer than a second.
    await this.ports.armTurnWake(Date.now() + RECOVERY_BACKOFF_CEILING_MS);

    try {
      await runOperationProfile(null, () => runWorkModeInvocation(mode, () => this.runTurn(item, event, startedAt, lease)));
    } catch (error) {
      const message = renderThrownChain({ cause: error });
      const interrupted = lease.signal.aborted;

      if (!interrupted) this.actorSession.orchestrator.acc.hadError = true;
      this.closeRun({ completed: false, interrupted, errorText: message.slice(0, 500) }, lease);
      this.emit({ type: 'error', message });
      this.emit({ type: 'turn-end', turn: this.snapshotTurn(item, '') });
    } finally {
      // Detached lanes retain the runtime profile of the turn they belong to.
      this.actorSession.finishTurn(lease);
    }
  }

  /**
   * Close the recovery lease on every event delivery THIS turn answered.
   *
   * A drain stamps the synthetic turn its rows are bound to onto whatever
   * absorbed them: `drainTurnId` on the turn it queued, `replyTurnId` on the
   * signal a live turn spliced. Both are read here, because both are ways an
   * event gets answered and only one of them starts a turn of its own.
   *
   * The BINDING stays — it is what stops a second drain re-delivering the same
   * event, and reply-channel and audit reads find the rows by it. The LEASE is
   * the separable claim "a running turn still owes this delivery an answer",
   * and closing it is the whole difference between an answered delivery and one
   * {@link reclaimStrandedEventDeliveries} must hand back. The cloud backend
   * closes it in `completeEventBatch`, after the outbound replies its turn owed;
   * a local session has no transport in front of its reply channels, so the
   * durable answer is all of what it owes.
   */
  /** The event deliveries the turn in flight has answered so far: the drain
   *  turn it was queued for, and the reply turn of every signal absorbed. */
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

  /** The turn as it stands — the one shape the normal end and both failure
   *  paths report. */
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

  /** The turn itself: assemble it, stream it, finalize it. Everything here may
   *  throw; processTurn owns what that means. */
  /**
   * The in-flight step's output, made durable at the partial cadence: the
   * text so far and the tool calls issued so far with their results, written
   * on the step's first delta and then every {@link PARTIAL_FLUSH_EVERY}
   * chunks, and at once when a tool answers. `step_finish` supersedes it for a
   * step that finishes; a step that does not is what a continuation resumes
   * from. Step indices count from the steps a continuation already carries,
   * so the row names the same step the accumulator does.
   */
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
            // Any tool result is progress on the last reminder — the model
            // answered it with work, so the next settle is judged fresh.
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

  private async runTurn(item: QueueItem, event: string | undefined, startedAt: number, lease: ActorTurnLease): Promise<void> {
    const input: ChatTurnInput = item.continuation === undefined ? item : { ...item, priorOutput: priorOutputOf(item.continuation) };

    // The one rule for where the turn's conversation comes from, on both
    // backends: a delivery's reply turn opens on the settled working revision
    // (born from the delivery's conversation when this actor has none), every
    // other turn appends, and prior output follows either. The message shape
    // is a function of the input alone, so it is built here and not in each
    // backend's prepareTurn.
    this.actorSession.openTurnInput(lease, {
      item: input,
      message: turnInputMessage(input),
      birthContext: (drainTurnId) => subordinateTurnContext(this.eventLog, drainTurnId).map(inheritedAsModelMessage),
    });

    const prepared = await this.ports.prepareTurn(input, lease);

    const partial = this.partialLedger(item.continuation);
    /** Whether this process streamed anything of the answer at all — a token
     *  or a call. A Stop before that leaves the operator's row alone. */
    let streamed = item.continuation?.partial !== null && item.continuation?.partial !== undefined;

    const execution = await this.actorSession.execute(lease, {
      task: item.text,
      ...prepared.execution,
    }, (event) => {
      partial.observe(event);

      if (event.type === 'text-delta' || event.type === 'tool-call') streamed = true;

      if (event.type === 'text-delta' || event.type === 'tool-call' || event.type === 'tool-result' || event.type === 'error') this.emit(event);
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

    // The turn's whole durable record, in ONE commit — see {@link commitTurn}.
    const commit = this.commitTurn({
      item,
      event,
      startedAt,
      assistantText: fullText,
      // A turn cut before its first token has no answer row: the operator's
      // row stands alone, on both backends, as it did before the switch — an
      // empty assistant row was an empty bubble on every reload.
      assistantRow: streamed || !interrupted,
      runError,
      interrupted,
      trialContext: execution.admittedMessages,
      reachableTools: Object.keys(prepared.execution.chat.tools ?? {}),
      overflowRetry,
    });

    // Turn over for signal delivery — the same spine the cf backend runs, and
    // for the same reason: exactly once per turn, after the actor enters
    // settling, so late signals re-deliver rather than target a nonexistent step,
    // outside every failure path, so nothing that throws can skip it.
    //
    // The verdict includes DURABILITY. A turn whose answer never reached disk
    // did not answer the events its signals carried, so `completed: false` is
    // the honest report: the seam re-queues them, and a re-delivery that cannot
    // be queued hands their bound event rows back to pending. Settling them as
    // answered leaves those rows bound forever to a turn nothing can read back.
    const durable = runError === null && 'committed' in commit;
    const settled = this.actorSession.orchestrator.inbox.settle({ completed: durable });

    if (durable) this.closeEventDeliveryLeases(item, settled.absorbed);

    if (!('committed' in commit)) {
      const message = renderThrownChain({ cause: commit.failure });
      this.actorSession.orchestrator.acc.hadError = true;
      this.closeRun({
        completed: false,
        interrupted: false,
        errorText: runError ?? message.slice(0, 500),
      }, lease);
      diagnostics.failure('turn.persist_failed', commit.failure);
      // The answer is not durable, so it is not published as one. The stream's
      // deltas already went out — they are what the operator watched happen —
      // but the terminal event carries no final answer, because a restart reads
      // this turn back as a turn that produced nothing.
      this.emit({ type: 'error', message });
      this.emit({ type: 'turn-end', turn: this.snapshotTurn(item, '') });

      return;
    }

    const { facts, turn, owed, transition } = commit.committed;

    try {
      // The NEXT turn's measured compaction trigger (core turn-lifecycle).
      persistMeasuredPromptTokens(this.compactionState, prepared.sessionKey, this.actorSession.orchestrator.acc.lastPromptTokens, prepared.historyLength);

      this.closeRun(facts, lease);
      // Core drives everything the settled turn causes from here: the in-process
      // guard, the durable claim, the roster, the run and the close are ONE
      // state machine, and this backend supplies only what it owns — the effect
      // bodies below and the fiber that keeps the process alive for the
      // detached tail. Until this existed the CLI released its claims the
      // moment the transcript was persisted and had no recovery at all, so a
      // device killed here lost the whole suffix.
      //
      // The core ledger already holds the roster committed with the answer.
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
      // Finalization threw, so whatever the stream reported is superseded by a
      // turn that could not be closed out — and an interrupt does not reach
      // here, since `interrupted` is sealed on the arm above.
      this.closeRun({
        completed: false,
        interrupted: false,
        errorText: runError ?? message.slice(0, 500),
      }, lease);
      diagnostics.failure(
        'turn.finalization_failed',
        toKinuError({ doing: 'finalizing the turn', cause: err, otherwise: 'io' }),
      );
      // The answer IS durable here — the commit ran above, before the signal
      // settle, so what failed is the bookkeeping around a turn a restart can
      // still read back. That is why this path still reports the answer it
      // reports: the failure is stated, and the turn is terminal either way.
      // The intent row STAYS: the transition may never have been claimed.
      this.emit({ type: 'error', message });
      this.emit({ type: 'turn-end', turn });
    }
  }

  /**
   * Make this turn durable — the answer, the verdict its run row is sealed with
   * and the frozen roster of everything the answer owes — as ONE commit.
   *
   * The roster is the only thing a later start can recover the suffix FROM, so
   * it lands in the SAME commit as the answer. A whole finalization later — the
   * assistant row here, core's claim after the signal settle, the compaction
   * bookkeeping and the run seal — a process killed anywhere in between leaves
   * a durable answer with no claim, and `resumeAll()` finds CLAIMS, so it finds
   * nothing and that turn's takes, branches, recording, drain, trial and title
   * are lost with nothing on disk saying they were owed. The intent row written
   * inside this transaction is what closes that window.
   *
   * The transaction is the raw handle's, because `rt.storage.sql` and this
   * session's `db` are the same connection — the runtime is built over it — so
   * the messages, the intent and nothing else commit or roll back together.
   *
   * Never throws. A failure here is a turn whose answer did not reach disk, and
   * the caller reports that as a turn that produced nothing.
   */
  private commitTurn(input: {
    readonly item: QueueItem;
    readonly event: string | undefined;
    readonly startedAt: number;
    readonly assistantText: string;
    /** Whether an assistant row is written at all. False only for a turn
     *  interrupted before it streamed anything. */
    readonly assistantRow: boolean;
    readonly runError: string | null;
    readonly interrupted: boolean;
    /** The turn's inference history, for the shadow trial's recorded replay. */
    readonly trialContext: readonly ModelMessage[];
    /** The tool surface the turn could reach, for the advisor's snapshot. */
    readonly reachableTools: readonly string[];
    readonly overflowRetry: boolean;
  }): TurnCommit {
    const { item, runError } = input;

    // THE OUTPUT-LIMIT CONTINUATION, decided at the one moment all three facts
    // are readable: the accumulator's last finish reason (reset at the next
    // turn's start), the driving item, and what this turn absorbed. A turn
    // already IS the continuation two ways, and both spend it: queued as its
    // own turn (the `kinuEvent` stamp on the item) or spliced into a running
    // one (the same signal at a step boundary). Reading only the first would
    // let a spliced continuation earn a second one; the bound is exactly one.
    const outputContinuation = owesOutputLimitContinuation({
      completed: runError === null,
      lastFinishReason: this.actorSession.orchestrator.acc.lastFinishReason,
      turnWasContinuation: item.metadata?.kinuEvent === OUTPUT_CONTINUATION_EVENT
        || this.actorSession.orchestrator.inbox.absorbedKinds().includes(OUTPUT_CONTINUATION_EVENT),
    });

    try {
      // One durable row PER steer (not per drain): the walk-back fork pivot
      // matches individual user messages verbatim, exactly as surfaces and the
      // JSONL transcript recorded them. A turn the harness enqueued opens on a
      // `programmatic:`-prefixed row that also carries its provenance — the
      // stamped metadata is what states authorship at rest; the prefix only keys
      // the idempotency.
      const turnId = this.turnId ?? crypto.randomUUID();
      // Minted at admission rather than inside `persist`, because the roster
      // keys on it and the roster is frozen before the write.
      const messageId = this.messageId;

      // The confirming turn is over: what the agent did with its free re-look
      // IS the gate's conversion number, and the run row carries it. Before the
      // roster, so the turn that ANSWERED a gate cannot be gated again.
      if (input.event === COMPLETION_GATE_EVENT) {
        this.completionGate.settle({ toolCalls: this.actorSession.orchestrator.acc.toolCalls.length });
      }

      const facts: RunEndFacts = {
        completed: runError === null,
        interrupted: input.interrupted,
        errorText: runError ?? undefined,
        // Unbounded here (runChat hands `stopWhen` straight to streamText), so
        // this reads 'stop' on a turn that finished by itself. Reported anyway:
        // a caller that does pass a real stop condition gets the same honest
        // 'truncated' seal the cloud loop gets, from the same classifier.
        lastFinishReason: this.actorSession.orchestrator.acc.lastFinishReason,
      };

      const status = classifyRunEnd(facts).reason;
      const turn = this.snapshotTurn(item, input.assistantText, messageId);

      // The stop-time reminder, decided where the list, the answer and the
      // outcome are all readable together. The decision mutates the tracker —
      // it IS the firing — so it runs exactly where the roster is frozen.
      // The tracker is RAM anyway: a process cut loses the count wholesale,
      // and the ledger row is what makes the delivery once-only.
      const taskReminder = this.taskReminders.decide({
        open: this.ports.taskList().listOpen(),
        assistantText: input.assistantText,
        workMode: this.actorSession.workMode,
        completed: runError === null,
        asyncWakePending: this.ports.hasPendingAsyncWake(),
      });

      const owed = this.ports.owedTerminalEffects({
        turn,
        status,
        // Alternate Takes and steer branches were both captured mid-turn, before
        // this id existed, and both are attributed to it — one decision, made by
        // core (orchestrator/turn-lifecycle.ts `creditedTurnId`) rather than once
        // here and again in the cf backend's onChatResponse.
        credited: creditedTurnId({
          messageId, completed: runError === null, workMode: this.actorSession.workMode,
        }),
        messageId,
        userText: item.text,
        assistantText: input.assistantText,
        completed: runError === null,
        interrupted: facts.interrupted,
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
        this.persist(
          turnId,
          messageId,
          item.text,
          // The landed ledger, not `drainedTexts()`: same steers in the same
          // order, but each still carrying the id its queued/landed
          // announcements used and the step index it was spliced into — which is
          // what the durable row's parent chain is ordered by. The rows
          // themselves were written by their own drains, at the step boundary.
          this.actorSession.landedSteers,
          input.assistantRow ? input.assistantText : null,
          // The opening row already carries the operator's message's facts;
          // a programmatic turn's row is written here, with the producer's
          // stamp and event.
          item.kind === 'programmatic' ? item.metadata : undefined,
        );

        // The reservation the queue item was admitted as is spent by its own
        // durable row — same transaction, so a restart sees one or neither.
        this.pendingSends.retire([
          ...(item.pendingSendId === undefined ? [] : [item.pendingSendId]),
          ...(item.steerIds ?? []),
        ]);

        this.ports.terminal().record(transition, owed);
      });

      return { committed: { messageId, facts, turn, owed, transition } };
    } catch (cause) {
      // Classified AT the boundary that caught it rather than stored raw and
      // interpreted later: this is the only place that knows what it was doing.
      return {
        failure: toKinuError({
          doing: 'committing the finished turn and the roster its answer owes',
          cause,
          otherwise: 'io',
        }),
      };
    }
  }

  /** Persist the exchange: the user row, any mid-turn steers, the assistant row.
   *
   *  `assistantId` is MINTED BY THE CALLER, because the roster the same
   *  transaction freezes keys on it — a turn cannot record what it owes under an
   *  id this method has not handed back yet.
   *
   *  `turnId` is the identity of the row that OPENS the exchange: derived from
   *  the producer's name for the fact when the harness enqueued this turn, a
   *  fresh uuid when the operator typed it. `INSERT OR IGNORE` is what makes the
   *  first form idempotent — the primary key refuses a second announcement of
   *  the same fact — and is a no-op for the second, whose id is unique by
   *  construction.
   *
   *  A programmatic row also STATES its provenance: `metadata` is stamped here,
   *  at the one seam every durable CLI turn is written through, so authorship
   *  and event kind live in the row itself. The `programmatic:` id prefix
   *  remains only as the read-side fallback for rows that carry no stamp —
   *  never the thing a new row leans on.
   *
   *  A steer row states its provenance the same way, under the two keys core
   *  declares for both backends: that it WAS a steer, and the step it was
   *  spliced into. Its ROW is not written here — the drain wrote it when the
   *  steer landed, inside the running turn; what the `steers` list still does
   *  here is order the parent chain the assistant row hangs off. */
  private persist(
    turnId: string,
    assistantId: string,
    userText: string,
    steers: ReadonlyArray<{ id: string; text: string; atStep: number }>,
    assistantText: string | null,
    metadata?: JsonObject,
  ): void {
    this.transcript.appendUser({
      id: turnId, text: userText,
      ...(metadata !== undefined && { metadata: stampTurnAuthor(metadata) }),
    });
    // The chain only: user → steers → assistant. Each steer row was committed
    // by its own drain at the step boundary it landed on, parented to this
    // turn's opening row.
    const parentId = steers.length > 0 ? steers[steers.length - 1]!.id : turnId;

    if (assistantText !== null) this.transcript.appendAssistant({ id: assistantId, parentId, text: assistantText });
  }

  // ─── The pending-send ledger ─────────────────────────────────────────────
  // One rule, one store, both backends: a send is a row before the client
  // hears it. `this.pendingSends` is core's PendingSendStore over the
  // workspace's own bun:sqlite database; the cf actor holds the same object
  // over its Durable Object storage.

  /** The two facts one drain makes durable, in one transaction: the landed
   *  user rows a surface reads, and the retirement of the reservations they
   *  spent. Either both exist or neither does. The rows chain: the first under
   *  the turn's opening message — durable at admission, so it is always on disk
   *  here — and each later one under the steer before it, so a walk up from
   *  the answer reaches every steer the model read. The stamp is the one
   *  `describeLandedSteers` already gave each row. */
  private commitLandedSteers(rows: readonly LandedSteerRow[]): void {
    this.transaction(() => {
      // A steer chains under the turn's opening row, so that row must be on
      // disk first. A user turn's is, from admission; a programmatic turn's is
      // written at commit, so the first steer to land in one writes it here —
      // idempotent on its id, the commit's write is then the same row.
      const opening = this.openingRow;

      if (opening !== null && this.actorSession.landedSteers.length === 0) this.transcript.appendUser(opening);
      let parentId = this.actorSession.landedSteers.at(-1)?.id ?? this.turnId;

      for (const row of rows) {
        this.transcript.appendUser({
          id: row.id, text: row.text, parentId, metadata: row.metadata,
          ...(row.files !== undefined && { files: row.files }),
        });
        this.pendingSends.retire([row.id]);
        parentId = row.id;
      }
    });
  }

  /** The turn a steer's reservation is bound to: the live turn when one is
   *  running, else the user turn already admitted at the head of the queue —
   *  the steer will land in its first step, so its row must name it. */
  private steerTurnId(): string | null {
    if (this.actorSession.inFlight) return this.turnId;

    return this.queue.find((item) => item.kind === 'user')?.turnId ?? this.turnId;
  }

  /**
   * AN INTERRUPTED TURN CONTINUES — session start's half.
   *
   * The run ledger names the turn the last process died inside (`run_start`
   * carries the turn's identity; `run_end` never came) and holds what it had
   * produced: the finished steps' messages and the cut step's partial. That
   * turn is re-queued FIRST, under its own opening row and answer id, with
   * that output as its prior output, so the model picks up where it stopped.
   * The reservation the turn was admitted from is still on disk — the commit
   * that would have retired it never ran — so it is claimed by the re-opened
   * item here, and {@link restorePendingSends} leaves it alone rather than
   * queueing the same words a second time.
   *
   * The degenerate case: a turn cut before any output has an empty ledger, and
   * the re-opened item is the same turn run again.
   */
  private reopened: string | null = null;
  /** The turn {@link restoreOpenTurn} re-opened, whose bound sends are its own. */
  private reopenedTurnId: string | null = null;
  /** The run that turn continues under, held until the loop runs it. */
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

  /** Session start's half of the send rule: the rows a dead process left
   *  acknowledged, restored before any new work runs. Mid-turn rows re-enter
   *  the inbox (they land in the next turn's first step); idle-queued rows
   *  re-enter the pump in sequence order as turns of their own — the same
   *  sweep the cf backend runs on wake, over this workspace's own store. */
  private restorePendingSends(): void {
    // The row a re-opened turn was admitted from is that turn's, not a send to
    // rerun; the rows bound to the re-opened turn land in its first step.
    const rows = this.pendingSends.restore().filter((row) => row.id !== this.reopened);

    if (rows.length === 0) return;

    const midTurn: (UserSteer & { mode: WorkMode })[] = [];
    // Sends bound to a turn no process is running any more — the activation
    // that owned that turn died before its settle, and this one re-opened a
    // different turn or none. Swept per dead turn into ONE user-origin rerun,
    // the words in the order they were accepted, under the narrower mode any
    // of them was typed in — plan, which admits reads and a review but no
    // effect, so a message typed for review is never run for effect because
    // it was merged with one that was: merging never widens what a message
    // was typed under. Their reservations are spent by that rerun's own row.
    const dead = new Map<string, PendingSendRow[]>();
    let queued = 0;

    for (const row of rows) {
      if (row.turnId === null) {
        this.queue.push({
          text: row.text, kind: 'user', turnId: crypto.randomUUID(),
          // Re-run of an acknowledgement, not a fresh send: kept ahead of
          // anything the new session admits, in the order they were accepted.
          rerun: true,
          pendingSendId: row.id,
          metadata: { kinuMode: row.mode },
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
      // Not synchronous: the driver gate is installed by the caller that
      // owns this session, after the constructor returns. A microtask lands
      // after that hand-off; pumping from inside the constructor would run a
      // turn under no lease at all.
      queueMicrotask(() => {
        if (this.ended) return;
        this.pump();
      });
    }
  }

  /**
   * Restore the working revision on open, falling back to the transcript only
   * when the actor has never recorded a working revision.
   */
  restoreHistory(): void {
    this.actorSession.restoreWorkingHistory(() => this.restoreTranscript());
  }

  /**
   * The transcript fallback is bounded by the model's context window.
   *
   * Bounded by what the model could ever be shown at once — the resolved
   * context window, LESS what is held back for the answer, since a restore that
   * fills the window leaves nothing to reply with and hands the compaction
   * ladder a request that is already over — rather than by a message count.
   * The count was 40, was
   * never overridden by anything, and was applied on EVERY reconnect: a
   * session past 40 messages silently lost everything older each time the CLI
   * restarted, with no marker in the transcript and no way for the model to
   * ask what it had lost. Restoring to the window instead hands the whole
   * conversation to the compaction ladder, which is the thing that actually
   * knows how to shed it (summarize, archive verbatim, cite the archive).
   *
   * A session larger than the window still cannot be restored whole, so what
   * did not fit is STATED: the count, and where it is still readable from.
   */
  private restoreTranscript(): readonly ModelMessage[] {
    const rows = this.transcript.newestFirst();
    const budget = stepContextLimit(this.ports.modelWindow());

    const restored: ModelMessage[] = [];
    let tokens = 0;
    let omitted = 0;

    for (const row of rows) {
      if (row.role !== 'user' && row.role !== 'assistant') continue;

      if (omitted > 0) { omitted++; continue; }

      const cost = estimateTokens(row.content.length);

      // The newest message is always restored. A single over-window message
      // belongs to the compaction ladder, not an empty-history fallback.
      if (restored.length > 0 && tokens + cost > budget) { omitted++; continue; }

      tokens += cost;
      restored.push({ role: row.role, content: row.content });
    }

    return omitted > 0
      ? [olderHistoryNotice(omitted, this.sessionId), ...restored.reverse()]
      : restored.reverse();
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
