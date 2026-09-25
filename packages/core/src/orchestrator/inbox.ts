/**
 * The inbox: the one way anything reaches an agent. A message buffers to the running turn's next step
 * boundary, or starts a turn via BackendHost.enqueueTurn. The routing read is synchronous, before any await.
 * User messages persist as a verbatim user row, are handed back on interrupt, and rerun as one user-origin
 * turn; an event's splice is ephemeral, its durable record its own row.
 */

import type { ModelMessage } from 'ai';
import * as v from 'valibot';
import type { PrepareStepContext } from '../extension';
import type { BackendHost, EnqueueTurnResult, ProgrammaticTurn, PromptFile } from '../types/backend-host';
import type {
  AgentInbox, AgentSignal, SendOutcome, SettledSignals, SignalCardState,
  SignalUndeliveredReason, UserSignalIdentity,
} from '../types/signals';
import { SIGNAL_ID_METADATA_KEY, USER_MESSAGE_SIGNAL_KIND } from '../types/signals';
import { StepInjections } from '../prompting/step-injections';
import { nanoid } from '../utils/nanoid';
import { metadataBroadcastEvent } from '../read-models/background-event';
import type { WorkMode } from '../types/turn';
import type { JsonObject } from '../utils/json';
import { stampTurnAuthor, TURN_AUTHOR_METADATA_KEY } from '../utils/ui-message';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import { diagnostics, KinuError, toKinuError } from '../obs/index';

export interface UserSteer {
  readonly text: string;
  readonly files?: ReadonlyArray<PromptFile>;
  /** Assigned on accept so queued and landed announcements share identity; absent where steers render locally. */
  readonly id?: string;
}

/** Parsed, not trusted, at the RPC boundary. */
export const PromptFileSchema: v.GenericSchema<PromptFile> = v.object({
  filename: v.string(),
  mediaType: v.string(),
  url: v.string(),
});

export function steerUserMessage(drained: ReadonlyArray<UserSteer>): ModelMessage {
  const text = drained.map((steer) => steer.text).join('\n\n');
  const files = drained.flatMap((steer) => steer.files ?? []);

  if (files.length === 0) return { role: 'user', content: text };

  return {
    role: 'user',
    content: [
      ...files.map((f) => ({ type: 'file' as const, data: f.url, mediaType: f.mediaType, filename: f.filename })),
      { type: 'text' as const, text },
    ],
  };
}

/** Marks a durable user row as a landed steer. */
export const STEER_METADATA_KEY = 'kinuSteer';

/** Step index the steer was spliced into; durable half of {@link SteerStatusEvent}. */
export const STEER_STEP_METADATA_KEY = 'kinuSteerAtStep';

export type SteerStatusDetail =
  /** Lands at the running turn's next step boundary. */
  | { status: 'queued'; steerId: string; text: string }
  /** Spliced into the step `atStep` started, so a surface draws it inside the in-progress message. */
  | { status: 'landed'; steerId: string; text: string; atStep: number }
  /** An interrupt dropped it; the composer takes it back. */
  | { status: 'returned'; steerId: string; text: string }
  /** Ran as its own turn; that turn's opening row, same id, is its record. */
  | { status: 'turn'; steerId: string; text: string };

/** Broadcast by both backends for a user steer. */
export type SteerStatusEvent = SteerStatusDetail & { type: 'steer_status' };

export interface LandedSteerRow {
  readonly id: string;
  readonly text: string;
  readonly atStep: number;
  /** Both steer keys, always together; see {@link describeLandedSteers}. */
  readonly metadata: JsonObject;
  readonly files?: ReadonlyArray<PromptFile>;
}

/**
 * The durable rows one drain of landed steers becomes. Both metadata keys or neither;
 * a pre-assigned id is kept so queued and landed announcements match.
 */
export function describeLandedSteers(
  steers: readonly UserSteer[],
  atStep: number,
): readonly LandedSteerRow[] {
  return steers.map((steer) => ({
    id: steer.id ?? `steer-${nanoid(12)}`,
    text: steer.text,
    atStep,
    metadata: { [STEER_METADATA_KEY]: true, [STEER_STEP_METADATA_KEY]: atStep },
    ...(steer.files !== undefined && { files: steer.files }),
  }));
}

/**
 * The pending-send ledger shared by both backends. `turn_id` is nullable for the CLI's idle-queued rows;
 * same-named tables must share one declaration, or first-creation order would pick the shape.
 */
export function initPendingSendTables(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS pending_steers (
    seq      INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id TEXT NOT NULL,
    id       TEXT NOT NULL,
    turn_id  TEXT,
    mode     TEXT NOT NULL CHECK (mode IN ('plan','build')),
    text     TEXT NOT NULL,
    UNIQUE (actor_id, id)
  )`);
  execRaw(`CREATE TABLE IF NOT EXISTS pending_steer_files (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id   TEXT NOT NULL,
    steer_id   TEXT NOT NULL,
    filename   TEXT NOT NULL,
    media_type TEXT NOT NULL,
    url        TEXT NOT NULL
  )`);
}

/**
 * All reads and writes against the pending-send ledger. `turn_id` null means idle-queued (CLI only).
 * `actor_id` scopes every statement; callers needing atomicity wrap the call in their own transaction.
 */
export class PendingSendStore {
  constructor(
    private readonly sql: SqlExecutor,
    private readonly actorId: string,
  ) {}

  /** Reserve before the client hears the send was taken. `turnId` is null only on the CLI's idle lane. */
  reserve(steer: AcceptedSteer & { readonly turnId: string | null }): void {
    void this.sql`INSERT INTO pending_steers (actor_id, id, turn_id, mode, text)
      VALUES (${this.actorId}, ${steer.id}, ${steer.turnId}, ${steer.mode}, ${steer.text})`;

    for (const file of steer.files ?? []) {
      void this.sql`INSERT INTO pending_steer_files (actor_id, steer_id, filename, media_type, url)
        VALUES (${this.actorId}, ${steer.id}, ${file.filename}, ${file.mediaType}, ${file.url})`;
    }
  }

  /**
   * Rerun admission's row; `OR IGNORE` because a leftover rerun's ids already exist.
   * Attachments ride the existing reservation.
   */
  ensureReserved(steer: {
    readonly id: string;
    readonly turnId: string | null;
    readonly mode: WorkMode;
    readonly text: string;
  }): void {
    void this.sql`INSERT OR IGNORE INTO pending_steers (actor_id, id, turn_id, mode, text)
      VALUES (${this.actorId}, ${steer.id}, ${steer.turnId}, ${steer.mode}, ${steer.text})`;
  }

  /** Files are deleted first: a crash in between must not re-deliver the reservation. */
  retire(ids: readonly string[]): void {
    for (const id of ids) {
      void this.sql`DELETE FROM pending_steer_files
        WHERE actor_id = ${this.actorId} AND steer_id = ${id}`;
      void this.sql`DELETE FROM pending_steers
        WHERE actor_id = ${this.actorId} AND id = ${id}`;
    }
  }

  /** Whether this actor still owes a send under this id; lets a transport dedupe a repeated message. */
  has(id: string): boolean {
    return this.sql<{ id: string }>`
      SELECT id FROM pending_steers WHERE actor_id = ${this.actorId} AND id = ${id}`.length > 0;
  }

  /** Attachments in send order, restored so a restart keeps acknowledged files. */
  files(steerId: string): PromptFile[] {
    return this.sql<{ filename: string; media_type: string; url: string }>`
      SELECT filename, media_type, url FROM pending_steer_files
      WHERE actor_id = ${this.actorId} AND steer_id = ${steerId}
      ORDER BY seq ASC`
      .map((row) => ({ filename: row.filename, mediaType: row.media_type, url: row.url }));
  }

  /** Every owed send in acceptance order; attachments via {@link files}. */
  restore(): PendingSendRow[] {
    return this.sql<{ id: string; turn_id: string | null; mode: WorkMode; text: string }>`
      SELECT id, turn_id, mode, text FROM pending_steers
      WHERE actor_id = ${this.actorId}
      ORDER BY seq ASC`
      .map(toPendingSendRow);
  }

  /** Reservations bound to one turn; a reset restores them into its first step. */
  forTurn(turnId: string): PendingSendRow[] {
    return this.sql<{ id: string; turn_id: string | null; mode: WorkMode; text: string }>`
      SELECT id, turn_id, mode, text FROM pending_steers
      WHERE actor_id = ${this.actorId} AND turn_id = ${turnId}
      ORDER BY seq ASC`
      .map(toPendingSendRow);
  }

  /**
   * Reservations bound to a turn nobody holds. NULL rows are excluded because `turn_id <> live` is
   * NULL, not TRUE; this keeps idle-queued rows from being swept as orphans.
   */
  sweepDead(liveTurnId: string): PendingSendRow[] {
    return this.sql<{ id: string; turn_id: string | null; mode: WorkMode; text: string }>`
      SELECT id, turn_id, mode, text FROM pending_steers
      WHERE actor_id = ${this.actorId} AND turn_id <> ${liveTurnId}
      ORDER BY seq ASC`
      .map(toPendingSendRow);
  }
}

/** Single column mapping so the reads cannot drift on a column name. */
const toPendingSendRow = (row: {
  id: string; turn_id: string | null; mode: WorkMode; text: string;
}): PendingSendRow => ({ id: row.id, turnId: row.turn_id, mode: row.mode, text: row.text });

/** One acknowledged send; `turnId` is null while idle-queued. */
export interface PendingSendRow {
  readonly id: string;
  readonly turnId: string | null;
  readonly mode: WorkMode;
  readonly text: string;
}

export type AcceptedSteer = UserSteer & { readonly id: string; readonly mode: WorkMode };

export interface UserSteerDeps {
  /** Reserve before the buffer push and 'queued' announcement, synchronously. Rejection refuses the send. */
  readonly onAccept?: (steer: AcceptedSteer) => void;
  /** Persist a drain before the messages reach the provider. Rejection aborts the step; the inbox restores
   *  everything drained ahead of pending and moves no card. */
  readonly onDrain?: (steers: readonly UserSteer[], atStep: number) => void | ModelMessage | Promise<void | ModelMessage>;
  /** The live turn's durable id, for the rerun key. */
  readonly turnId?: () => string | null;
  /** Skill bodies the landed words activate; spliced as step reference, never a durable row. */
  readonly skills?: (text: string) => Promise<string | null>;
}

const SignalIdMetadataSchema = v.object({
  [SIGNAL_ID_METADATA_KEY]: v.optional(v.string()),
});

/** Producers never see or set `cardId`. */
interface DeliveredSignal extends AgentSignal {
  readonly cardId: string;
}

interface DeliveredUserSignal extends DeliveredSignal {
  readonly user: UserSignalIdentity;
}

/** Card id a turn carries when a signal started it; pairs with {@link Inbox.queue}. */
export function readSignalId(metadata: JsonObject | undefined): string | undefined {
  const parsed = v.safeParse(SignalIdMetadataSchema, metadata);
  const id = parsed.success ? parsed.output[SIGNAL_ID_METADATA_KEY] : undefined;

  return id === '' ? undefined : id;
}

const isUserSignal = (signal: DeliveredSignal): signal is DeliveredUserSignal =>
  signal.user !== undefined;

const toUserSteer = (signal: DeliveredUserSignal): UserSteer => ({
  id: signal.user.id,
  text: signal.text,
  ...(signal.user.files !== undefined && { files: signal.user.files }),
});

export class Inbox implements AgentInbox {
  private pending: DeliveredSignal[] = [];
  private absorbed: DeliveredSignal[] = [];
  /** The drain crossing the durable boundary; nonempty only while onDrain is awaited. */
  private landing: DeliveredSignal[] = [];
  /** Previous turn's absorbed events, held one turn so a continuation turn can re-absorb them. */
  private settled: DeliveredSignal[] = [];
  /** The host enqueue in flight until the turn opens; while set, a message rides that turn's first step. */
  private starting: Promise<EnqueueTurnResult> | null = null;
  private readonly injections = new StepInjections<{
    readonly message: ModelMessage;
    readonly durable: boolean;
  }>();

  constructor(
    private readonly host: BackendHost,
    private readonly logActivity?: (event: string, detail?: string) => void,
    private steers: UserSteerDeps = {},
  ) {}

  /** Reply turns of every absorbed signal. Read at the commit, before `settle` decides what re-delivers. */
  get answeredDeliveries(): ReadonlySet<string> {
    const answered = new Set<string>();

    for (const signal of this.absorbed) {
      if (signal.replyTurnId) answered.add(signal.replyTurnId);
    }

    return answered;
  }

  absorbedKinds(): readonly string[] {
    return this.absorbed.map((signal) => signal.kind);
  }

  /** Whether a message sent now rides an existing (running or admitted) turn; the same read {@link send} makes. */
  get busy(): boolean {
    return this.starting !== null || this.host.turnInFlight();
  }

  /**
   * The busy read and buffer push are synchronous. A signal with `idempotencyKey` derives its card id from it,
   * so a collapsed re-delivery never opens a second, forever-pending card.
   */
  send(signal: AgentSignal): Promise<SendOutcome> {
    const cardId = signal.idempotencyKey ? `sig:${signal.idempotencyKey}` : `sig-${nanoid()}`;
    const delivered: DeliveredSignal = { ...signal, cardId };
    // Read once, before any await.
    const { busy } = this;

    if (isUserSignal(delivered)) {
      if (!busy) return this.queueUsers([delivered], { idempotent: false });
      this.steers.onAccept?.({ ...toUserSteer(delivered), id: delivered.user.id, mode: delivered.user.mode });
      this.pending.push(delivered);
      this.host.broadcast({
        type: 'steer_status', status: 'queued', steerId: delivered.user.id, text: signal.text,
      });

      return Promise.resolve('mid-turn');
    }

    if (!busy) return this.queue(delivered);
    this.pending.push(delivered);
    this.openCard(delivered, stepBody(delivered));
    this.logActivity?.('signal_injected', `${signal.kind} → live turn`);

    return Promise.resolve('mid-turn');
  }

  /** Bind once at session construction; rebinding after a user signal is accepted would change the drain target. */
  bindSteerDeps(steers: UserSteerDeps): void {
    if ([...this.pending, ...this.landing, ...this.absorbed].some(isUserSignal)) {
      throw new Error('cannot bind steer persistence once user signals have been accepted');
    }

    this.steers = steers;
  }

  /**
   * Absorb everything buffered and admit it at the step tail: users as one durable message, then events plus
   * this step's `steering` as one non-durable message. `steering` is never buffered. The drain's persistence
   * is awaited before any card moves, so the model never sees a steer whose durable half is missing.
   */
  async prepareStep(
    ctx: PrepareStepContext,
    steering: readonly AgentSignal[] = [],
  ): Promise<ModelMessage[] | undefined> {
    const drained = this.pending.splice(0);
    const users = drained.filter(isUserSignal);
    const events = drained.filter((signal) => !isUserSignal(signal));
    let landedMessage: ModelMessage | undefined;

    if (users.length > 0) {
      this.landing = drained;

      try {
        const landed = await this.steers.onDrain?.(users.map(toUserSteer), ctx.stepNumber);

        if (landed !== undefined) landedMessage = landed;
      } catch (cause) {
        // Signals may arrive during the await; the failed prefix goes back ahead of them.
        this.pending = [...drained, ...this.pending];
        this.landing = [];
        throw cause;
      }

      this.landing = [];
    }

    this.absorbed.push(...drained);

    for (const event of events) this.moveCard(event.cardId, 'shown');

    for (const user of users) {
      this.host.broadcast({
        type: 'steer_status', status: 'landed',
        steerId: user.user.id, text: user.text, atStep: ctx.stepNumber,
      });
    }

    const entries: Array<{ readonly message: ModelMessage; readonly durable: boolean }> = [];

    if (users.length > 0) {
      entries.push({ message: landedMessage ?? steerUserMessage(users.map(toUserSteer)), durable: true });
    }

    const bodies = [...events, ...steering].map(stepBody);
    const activated = users.length > 0 ? await this.steers.skills?.(users.map((user) => user.text).join('\n\n')) : null;

    if (activated !== null && activated !== undefined) bodies.unshift(activated);

    if (bodies.length > 0) {
      entries.push({ message: { role: 'user', content: bodies.join('\n\n') }, durable: false });
    }

    return this.injections.drain(ctx, entries);
  }

  /**
   * Turn over: everything that did not reach the model re-delivers (users as one turn the events ride); an aborted
   * turn also requeues its absorbed events. Call exactly once per turn, before anything that can throw.
   * Re-delivery is detached so a turn never blocks on the next one's queue slot.
   */
  settle(opts: { completed: boolean }): SettledSignals {
    const absorbed = this.absorbed;
    const leftover = this.pending.splice(0);
    const leftoverUsers = leftover.filter(isUserSignal);
    const leftoverEvents = leftover.filter((signal) => !isUserSignal(signal));
    const absorbedEvents = absorbed.filter((signal) => !isUserSignal(signal));
    const requeue = opts.completed ? leftoverEvents : [...absorbedEvents, ...leftoverEvents];
    this.settled = opts.completed ? absorbedEvents : [];
    this.absorbed = [];
    this.injections.reset();
    this.redeliver(leftoverUsers, requeue);

    return { absorbed: absorbedEvents };
  }

  /** Return user signals the model never saw to the composer. Events stay pending and still owe their turn. */
  interrupt(): UserSteer[] {
    const returned = this.pending.filter(isUserSignal);
    this.pending = this.pending.filter((signal) => !isUserSignal(signal));

    for (const signal of returned) {
      this.host.broadcast({
        type: 'steer_status', status: 'returned', steerId: signal.user.id, text: signal.text,
      });
    }

    return returned.map(toUserSteer);
  }

  /** Replace the user queue from its durable authority on reset, ahead of pending events.
   *  Invalid once a drain or injection has happened this turn: two authorities would duplicate delivery. */
  restorePending(steers: readonly (UserSteer & { readonly mode?: WorkMode })[]): void {
    if (this.landing.length > 0 || this.injections.recorded.length > 0) {
      throw new Error('cannot restore pending steers after this turn started draining');
    }

    const restored: DeliveredUserSignal[] = steers.map((steer) => ({
      kind: USER_MESSAGE_SIGNAL_KIND,
      text: steer.text,
      cardId: `sig-${nanoid()}`,
      user: {
        id: steer.id ?? `steer-${nanoid(12)}`,
        mode: steer.mode ?? 'build',
        ...(steer.files !== undefined && { files: steer.files }),
      },
    }));

    this.pending = [...restored, ...this.pending.filter((signal) => !isUserSignal(signal))];
  }

  /** Turn start: drop leaked splice state; a continuation re-queues {@link settled}. `signalId` is the card
   *  of the signal that started this turn, which moves to shown. */
  beginTurn(continuation: boolean, signalId?: string): void {
    this.starting = null;
    this.absorbed = [];
    this.injections.reset();

    if (continuation) this.pending.unshift(...this.settled);
    this.settled = [];

    if (signalId) this.moveCard(signalId, 'shown');
  }

  /** The turn's response messages with each durable (user-kind) injection back where the model saw it. */
  replayInto(responseMessages: ReadonlyArray<ModelMessage>): ModelMessage[] {
    return this.injections.replayInto(responseMessages);
  }

  /** Durable injections, for a failure path with no response array to replay into. */
  recordedMessages(): ModelMessage[] {
    return this.injections.recorded
      .filter((entry) => entry.durable)
      .map((entry) => entry.message);
  }

  /**
   * Hold {@link starting} until {@link beginTurn} or the host answers. A turn that never opens re-sends
   * whatever was buffered for its first step.
   */
  private startTurn(enqueue: () => Promise<EnqueueTurnResult>): Promise<EnqueueTurnResult> {
    const attempt = enqueue();
    this.starting = attempt;

    const settled = (): void => {
      if (this.starting !== attempt) return;
      this.starting = null;

      if (this.host.turnInFlight() || this.pending.length === 0) return;
      const stranded = this.pending.splice(0);
      this.redeliver(stranded.filter(isUserSignal), stranded.filter((signal) => !isUserSignal(signal)));
    };

    // Registered before the caller's await, so the hold releases ahead of its continuation.
    attempt.then(settled, settled);

    return attempt;
  }

  /** Users as one user-origin turn, its first step carrying the events; with no users, each event is its own turn. */
  private redeliver(users: readonly DeliveredUserSignal[], events: readonly DeliveredSignal[]): void {
    const [first, ...rest] = users;

    if (first === undefined) {
      for (const signal of events) {
        void this.queue(signal).catch(reportRedeliveryFailure(signal.kind));
      }

      return;
    }

    for (const signal of events) {
      this.pending.push(signal);
      this.openCard(signal, stepBody(signal));
    }

    void this.queueUsers([first, ...rest], { idempotent: true }).catch(reportRedeliveryFailure(USER_MESSAGE_SIGNAL_KIND));
  }

  /** Compensation runs outside the enqueue's catch so a failing compensation surfaces instead of re-entering.
   *  `idempotencyKey` rides to the backend, which derives the queued message id from it. */
  private async queue(signal: DeliveredSignal): Promise<SendOutcome> {
    this.openCard(signal, signal.text);
    let reason: SignalUndeliveredReason;

    try {
      const metadata = { ...turnMetadata(signal), [SIGNAL_ID_METADATA_KEY]: signal.cardId };
      const { text, yieldsToUserMessage } = signal;
      // Requeues keep their card identity across durable admission; a yielding offer must still take the
      // host's slot-time offer check.
      const idempotencyKey = signal.idempotencyKey ?? (yieldsToUserMessage === true ? undefined : signal.cardId);

      const turn: ProgrammaticTurn = {
        text, metadata,
        ...(idempotencyKey !== undefined && { idempotencyKey }),
        ...(yieldsToUserMessage === true && { yieldsToUserMessage }),
      };

      const result = await this.startTurn(() => this.host.enqueueTurn(turn));

      // Operator already speaking: a consumed offer, not a failure. No compensate; card withdrawn.
      if (result.status === 'yielded') {
        this.moveCard(signal.cardId, 'undelivered');

        return 'yielded';
      }

      if (result.status === 'queued') return 'queued';
      reason = 'preempted';
      diagnostics.failure(
        'signal.preempted',
        new KinuError('unavailable', 'the host pre-empted the signal turn; compensating'),
        { signal: signal.kind },
      );
    } catch (err) {
      reason = 'failed';
      diagnostics.failure(
        'signal.enqueue_failed',
        toKinuError({ doing: 'enqueue a signal turn', cause: err, otherwise: 'io' }),
        { signal: signal.kind },
      );
    }

    this.moveCard(signal.cardId, 'undelivered');
    signal.compensate?.(reason);

    return 'undelivered';
  }

  /**
   * Operator words become one user turn under the narrowest mode; no card moves. `idempotent` marks a rerun
   * of leftovers (`steer-rerun:` key), versus an idle-agent send that matches ordinary user-turn admission.
   */
  private async queueUsers(
    group: readonly [DeliveredUserSignal, ...DeliveredUserSignal[]],
    opts: { readonly idempotent: boolean },
  ): Promise<SendOutcome> {
    const [first] = group;
    const files = group.flatMap((signal) => signal.user.files ?? []);
    // Plan is narrower: merging never widens what a message was typed under.
    const mode: WorkMode = group.some((signal) => signal.user.mode === 'plan') ? 'plan' : 'build';

    const turn: ProgrammaticTurn = {
      text: group.map((signal) => signal.text).join('\n\n'),
      metadata: { ...first.metadata, [TURN_AUTHOR_METADATA_KEY]: 'operator', kinuMode: mode },
      origin: 'user',
      steerIds: group.map((signal) => signal.user.id),
      ...(opts.idempotent && {
        idempotencyKey: `steer-rerun:${this.steers.turnId?.() ?? 'live'}:${mode}:${first.user.id}`,
      }),
      ...(files.length > 0 && { files }),
    };

    try {
      const result = await this.startTurn(() => this.host.enqueueTurn(turn));

      if (result.status === 'queued') {
        for (const signal of group) {
          this.host.broadcast({ type: 'steer_status', status: 'turn', steerId: signal.user.id, text: signal.text });
        }

        return 'queued';
      }

      diagnostics.failure(
        'signal.preempted',
        new KinuError('unavailable', 'the host pre-empted the signal turn'),
        { signal: USER_MESSAGE_SIGNAL_KIND },
      );
    } catch (err) {
      diagnostics.failure(
        'signal.enqueue_failed',
        toKinuError({ doing: 'enqueue a signal turn', cause: err, otherwise: 'io' }),
        { signal: USER_MESSAGE_SIGNAL_KIND },
      );
    }

    return 'undelivered';
  }

  /** Same `kinuEvent` metadata as a queued signal's message; `text` is this delivery's rendering. */
  private openCard(signal: DeliveredSignal, text: string): void {
    this.host.broadcast(metadataBroadcastEvent(
      'signal_card', turnMetadata(signal), { id: signal.cardId, state: 'pending', text },
    ));
  }

  private moveCard(cardId: string, state: Exclude<SignalCardState, 'pending'>): void {
    this.host.broadcast({ type: 'signal_card', id: cardId, state });
  }
}

const stepBody = (signal: AgentSignal): string => signal.stepText ?? signal.text;

/** Producer metadata spreads first so the inbox owns `kinuEvent`/`drainTurnId`; the author stamp goes last. */
const turnMetadata = (signal: AgentSignal): JsonObject => {
  const metadata: JsonObject = { ...signal.metadata, kinuEvent: signal.kind };

  if (signal.replyTurnId) metadata.drainTurnId = signal.replyTurnId;

  return stampTurnAuthor(metadata);
};

function reportRedeliveryFailure(kind: string) {
  return (...rejection: [unknown]): void => {
    diagnostics.failure(
      'signal.redelivery_failed',
      toKinuError({ doing: 're-deliver a signal', cause: rejection[0], otherwise: 'io' }),
      { signal: kind },
    );
  };
}
