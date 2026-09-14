/**
 * The inbox — the ONE way anything reaches an agent, and the ONE verb: `send`.
 *
 * A message is either the user's own words (the user kind) or an event (a hub
 * drain, a settled background job, an overflow retry, a take pick, an MCP
 * task, the genesis offer). Whatever the kind, delivery has ONE rule:
 *
 *   - a turn is running (or one this inbox started has not opened yet): the
 *     message is buffered and lands at the turn's next step boundary;
 *   - nothing is running: the message starts a turn, through
 *     BackendHost.enqueueTurn.
 *
 * Nothing else routes. A message's work mode and mission labels are facts it
 * carries (the card and the model text say where it came from); the LIVE
 * turn's mode governs the tool surface, and a fact spliced into it changes
 * none of that. The routing read is synchronous, before any await, so a
 * producer that has just bound durable rows to its message knows the answer
 * in the same tick it bound them.
 *
 * Everything buffered for a step boundary drains at the step tail (after the
 * latest tool results, so role alternation stays provider-safe), re-applied
 * at its entry index for the rest of the turn — the StepInjections coordinate
 * math. User messages drain as ONE durable user message first; events merge
 * with the turn's own steering into ONE non-durable user message beside it.
 *
 * The user kind keeps three properties, and they are the whole reason the
 * kind exists:
 *
 *   1. its splice persists as a VERBATIM user row (a backend's `onDrain`),
 *      because the walk-back fork cuts the conversation at a user message and
 *      a message the model acted on is one;
 *   2. an interrupt HANDS IT BACK to the composer rather than eating it —
 *      the surface already rendered it as sent;
 *   3. anything left over when the turn ends reruns as ONE USER-origin turn,
 *      so it is the user's next turn and reads that way in the transcript.
 *
 * An event's durable record is its own row (the EventLog row consumed by the
 * batch turn id, the job row, the approval row); its splice is ephemeral —
 * model-visible at the tip and never chat history. Think's
 * one-assistant-message-per-turn transcript cannot represent an event between
 * steps, and persisting it after the assistant reply would read as an
 * unanswered event next turn.
 *
 * The turn's OWN steering — decided inside the step pipeline from the live
 * turn's state — is not sent, it is handed to {@link Inbox.prepareStep} as
 * the step being prepared: it enters through a step, so it cannot outlive it,
 * cannot start a turn, and cannot come back after the turn is over.
 *
 * The user's CARD comes from here, for the event kind: 'pending' where the
 * event is routed, 'shown' where the agent takes it in (the step that splices
 * it, or the turn it started, which names its card through the `signalId`
 * stamped on it). A user message has no card — its record is the durable row,
 * announced by the steer_status broadcasts as it lands, returns, or reruns.
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

// ── The user kind's vocabulary ─────────────────────────────────────

/** One thing the user typed, with any attachments it carried. */
export interface UserSteer {
  readonly text: string;
  readonly files?: ReadonlyArray<PromptFile>;
  /** Stable identity assigned when the steer is ACCEPTED, so the "queued" and
   *  "landed" announcements are the same object to a surface, and the durable
   *  user row can carry it too. Absent on surfaces that render steers locally
   *  (the TUI) rather than from broadcasts. */
  readonly id?: string;
}

/** An attachment as a client sends it over the wire — the PromptFile shape,
 *  parsed rather than trusted at the RPC boundary. */
export const PromptFileSchema: v.GenericSchema<PromptFile> = v.object({
  filename: v.string(),
  mediaType: v.string(),
  url: v.string(),
});

/** Merge steers into ONE user ModelMessage — text joined in arrival order,
 *  attachments carried as file parts (the runChat user-message shape). */
function steerUserMessage(drained: ReadonlyArray<UserSteer>): ModelMessage {
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

/** Metadata on the durable row a landed steer becomes: that it WAS a steer, so
 *  the thread can say why a user bubble appears inside another turn's work. */
export const STEER_METADATA_KEY = 'kinuSteer';

/** The step index the steer was spliced into, on that same row — the durable
 *  half of what {@link SteerStatusEvent} carries live, so the position a
 *  reader sees during the turn is the position they see after a reload. */
export const STEER_STEP_METADATA_KEY = 'kinuSteerAtStep';

/** Where one steer is in its life, as a backend states it. */
export type SteerStatusDetail =
  /** Buffered — it lands at the running turn's next step boundary. */
  | { status: 'queued'; steerId: string; text: string }
  /** The model has it: it was spliced into the step `atStep` started. That
   *  index is what lets a surface draw the steer inside the assistant message
   *  the turn is still writing, rather than under it. */
  | { status: 'landed'; steerId: string; text: string; atStep: number }
  /** An interrupt dropped it before the model saw it — the composer takes it
   *  back. */
  | { status: 'returned'; steerId: string; text: string };

/** The progress event both backends broadcast for a user steer, so every open
 *  surface shows the same thing: the text was accepted, then the model saw it,
 *  or an interrupt handed it back. Compatible with BroadcastEvent's
 *  `{ type: string; … }` shape. */
export type SteerStatusEvent = SteerStatusDetail & { type: 'steer_status' };

/** One landed steer as a durable user row, before a backend writes it. */
export interface LandedSteerRow {
  readonly id: string;
  readonly text: string;
  readonly atStep: number;
  /** Both steer keys, always together — see {@link describeLandedSteers}. */
  readonly metadata: JsonObject;
}

/**
 * The durable rows one drain of landed steers becomes.
 *
 * BOTH KEYS OR NEITHER. A row carrying {@link STEER_METADATA_KEY} without
 * {@link STEER_STEP_METADATA_KEY} reads as a steer whose position in the turn is
 * unknown, which is the one thing the step index exists to state — and at rest
 * that row is indistinguishable from an ordinary user turn.
 *
 * ONE ID SCHEME. A steer that reached a surface already has an id, and the queued
 * and landed announcements must be the same object to that surface, so a
 * pre-assigned id is kept. Only a steer that never had one is named here.
 *
 * What stays per backend is genuinely irreducible: one appends Durable Object
 * messages, the other inserts SQLite rows, and each broadcasts on its own
 * channel.
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
  }));
}

/**
 * ONE pending-send ledger, one schema, both backends: the reservation every
 * accepted send leaves — on cf, written before the queued broadcast; on the
 * CLI, before `send()` resolves.
 *
 * `turn_id` is NULLABLE because the row carries two states the cf backend
 * does not share: bound (a steer accepted into a live or queued turn) and
 * idle-queued (NULL — the CLI's own send lane admits the message as the
 * queue's record while no turn owns it; cf admits such a send as an
 * `assistant_messages` row before it is ever read). cf simply never writes
 * NULL. Same-named tables MUST share one declaration, or first-creation order
 * would pick the shape.
 *
 * The files live in their own table because a shipped table's shape never
 * moves: one row per part, in message order, retired with the steer row.
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
 * ONE pending-send ledger, one store, both backends: every row read and write
 * against `pending_steers` and `pending_steer_files` (declared above by
 * {@link initPendingSendTables}) goes through here.
 *
 * The ledger holds two states, and `turn_id` is how they are told apart:
 *
 *   - BOUND — the steer was accepted into a live or admitted turn; the row
 *     names the turn it lands in, so a reset restores it into that turn's
 *     first step rather than starting a turn of its own;
 *   - IDLE-QUEUED — `turn_id` NULL; the CLI's own send lane admits the
 *     message as the queue's record while no turn owns it (cf admits such a
 *     send as an `assistant_messages` row first and never writes NULL).
 *
 * `actor_id` scopes every statement: one workspace database hosts a root and
 * every actor beneath it, and the `UNIQUE (actor_id, id)` key means an id is
 * an actor's to spend — never a workspace's. A backend owns nothing but the
 * two facts it alone knows: WHICH actor it serves and WHICH turn it calls
 * live. Each statement is committed by its own statement boundary; a caller
 * that needs a retirement atomic with another write wraps the call in its own
 * transaction — the executor speaks over one connection, so no store-side
 * transaction shape is needed.
 */
export class PendingSendStore {
  constructor(
    private readonly sql: SqlExecutor,
    private readonly actorId: string,
  ) {}

  /**
   * The durable half of acceptance: the reservation exists before the client
   * hears the send was taken. `turnId` is null only on the CLI's idle send
   * lane — a send a backend accepted mid-turn or into a queued turn carries
   * that turn's id, and the cf side refuses to reserve without one.
   */
  reserve(steer: AcceptedSteer & { readonly turnId: string | null }): void {
    void this.sql`INSERT INTO pending_steers (actor_id, id, turn_id, mode, text)
      VALUES (${this.actorId}, ${steer.id}, ${steer.turnId}, ${steer.mode}, ${steer.text})`;

    for (const file of steer.files ?? []) {
      void this.sql`INSERT INTO pending_steer_files (actor_id, steer_id, filename, media_type, url)
        VALUES (${this.actorId}, ${steer.id}, ${file.filename}, ${file.mediaType}, ${file.url})`;
    }
  }

  /**
   * The rerun admission's row: a steer a user-origin turn carries must exist
   * as a row before the turn is admitted, bound to that turn's id when it has
   * none — `OR IGNORE` because a leftover rerun's ids already carry theirs.
   * Attachments are not written here: a rerun's files ride the reservation it
   * already has, and a fresh row carries none.
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

  /**
   * Spend reservations: the row and its attachments together, so a restart
   * has nothing left to hand back. The files go FIRST — a crash between the
   * two statements leaves steer rows whose files are gone rather than the
   * reservation itself re-delivered.
   */
  retire(ids: readonly string[]): void {
    for (const id of ids) {
      void this.sql`DELETE FROM pending_steer_files
        WHERE actor_id = ${this.actorId} AND steer_id = ${id}`;
      void this.sql`DELETE FROM pending_steers
        WHERE actor_id = ${this.actorId} AND id = ${id}`;
    }
  }

  /** The attachments a reservation carried, in the order the steer was sent —
   *  restored with it so a restart does not lose the files a dead process
   *  acknowledged. */
  files(steerId: string): PromptFile[] {
    return this.sql<{ filename: string; media_type: string; url: string }>`
      SELECT filename, media_type, url FROM pending_steer_files
      WHERE actor_id = ${this.actorId} AND steer_id = ${steerId}
      ORDER BY seq ASC`
      .map((row) => ({ filename: row.filename, mediaType: row.media_type, url: row.url }));
  }

  /**
   * Every acknowledged send this actor still owes, in the order it was
   * accepted — the bound rows a live turn re-reads and the idle-queued rows
   * that rerun as turns of their own. Attachments stay beside the steer row
   * and ride {@link files}, not this row set.
   */
  restore(): PendingSendRow[] {
    return this.sql<{ id: string; turn_id: string | null; mode: WorkMode; text: string }>`
      SELECT id, turn_id, mode, text FROM pending_steers
      WHERE actor_id = ${this.actorId}
      ORDER BY seq ASC`
      .map(toPendingSendRow);
  }

  /** The reservations bound to one turn — the rows a reset restores into
   *  that turn's first step. */
  forTurn(turnId: string): PendingSendRow[] {
    return this.sql<{ id: string; turn_id: string | null; mode: WorkMode; text: string }>`
      SELECT id, turn_id, mode, text FROM pending_steers
      WHERE actor_id = ${this.actorId} AND turn_id = ${turnId}
      ORDER BY seq ASC`
      .map(toPendingSendRow);
  }

  /**
   * The reservations whose turn is GONE — bound to a turn id nobody holds.
   * NULL rows are not dead: `turn_id <> live` is NULL and so not TRUE, which
   * is the one line keeping a backend that writes idle-queued rows from
   * sweeping the queue as orphans.
   */
  sweepDead(liveTurnId: string): PendingSendRow[] {
    return this.sql<{ id: string; turn_id: string | null; mode: WorkMode; text: string }>`
      SELECT id, turn_id, mode, text FROM pending_steers
      WHERE actor_id = ${this.actorId} AND turn_id <> ${liveTurnId}
      ORDER BY seq ASC`
      .map(toPendingSendRow);
  }
}

/** The row shape `pending_steers` answers in, mapped to the store's public
 *  vocabulary once so the three reads cannot drift on a column name. */
const toPendingSendRow = (row: {
  id: string; turn_id: string | null; mode: WorkMode; text: string;
}): PendingSendRow => ({ id: row.id, turnId: row.turn_id, mode: row.mode, text: row.text });


/** One acknowledged send as the ledger holds it: its id, the turn it is bound
 *  to (null while idle-queued), the composer's mode and its words. */
export interface PendingSendRow {
  readonly id: string;
  readonly turnId: string | null;
  readonly mode: WorkMode;
  readonly text: string;
}

/** A user steer as a backend's durable reservation sees it: the words, the
 *  attachments, and the composer's mode that rides a rerun. */
export type AcceptedSteer = UserSteer & { readonly id: string; readonly mode: WorkMode };

/** The user-kind persistence boundary a backend wires when it has one. */
export interface UserSteerDeps {
  /** Reserve a user message the inbox is about to buffer, BEFORE the buffer
   *  push and the 'queued' announcement: the row must exist before the client
   *  hears it was taken. Synchronous, in the same slice as the routing read.
   *  Rejection refuses the send and buffers nothing. */
  readonly onAccept?: (steer: AcceptedSteer) => void;
  /** Persist a drain before the rewritten messages reach the provider (CF: verbatim user rows +
   *  DELETE pending_steers; CLI: push landed rows). Rejection aborts the step; the inbox restores
   *  everything drained (users AND events) ahead of pending and moves no card. */
  readonly onDrain?: (steers: readonly UserSteer[], atStep: number) => void | Promise<void>;
  /** The live turn's durable id, for the rerun key. Null when unknown. */
  readonly turnId?: () => string | null;
}

// ── Delivery ───────────────────────────────────────────────────────

const SignalIdMetadataSchema = v.object({
  [SIGNAL_ID_METADATA_KEY]: v.optional(v.string()),
});

/** A signal once the inbox owns it: the producer's statement plus the card
 *  identity delivery gives it. Producers never see or set it. */
interface DeliveredSignal extends AgentSignal {
  readonly cardId: string;
}

/** A delivered signal narrowed to the user kind. */
interface DeliveredUserSignal extends DeliveredSignal {
  readonly user: UserSignalIdentity;
}

/** The card id a turn carries, when a signal started it — the other half of
 *  the round trip {@link Inbox.queue} stamps. */
export function readSignalId<Metadata>(metadata: Metadata): string | undefined {
  const parsed = v.safeParse(SignalIdMetadataSchema, metadata);
  const id = parsed.success ? parsed.output[SIGNAL_ID_METADATA_KEY] : undefined;

  return id || undefined;
}

const isUserSignal = (signal: DeliveredSignal): signal is DeliveredUserSignal =>
  signal.user !== undefined;

/** The verbatim UserSteer a user signal carries — the shape a backend's
 *  durable rows and the merged splice are built from. */
const toUserSteer = (signal: DeliveredUserSignal): UserSteer => ({
  id: signal.user.id,
  text: signal.text,
  ...(signal.user.files !== undefined && { files: signal.user.files }),
});

export class Inbox implements AgentInbox {
  private pending: DeliveredSignal[] = [];
  private absorbed: DeliveredSignal[] = [];
  /** The drain currently crossing the durable boundary — everything the step
   *  is about to absorb. Nonempty only while onDrain is awaited; the restore
   *  guard reads it, and onDrain failure puts it back ahead of pending. */
  private landing: DeliveredSignal[] = [];
  /** The previous turn's absorbed signals, held one turn so a CONTINUATION
   *  (Think auto-continue / recovery — a separate queued turn) can re-absorb
   *  them: the queued path self-heals across continuations because the durable
   *  turn message rides into every one of them, and spliced signals must match
   *  — re-seen text (the prior handling is visible in the transcript) and
   *  re-dispatch (a settled reply channel no-ops). Only ever events: a landed
   *  user message is already its own durable row. */
  private settled: DeliveredSignal[] = [];
  /** The turn this inbox is starting: the host's enqueue, from the moment it
   *  is issued until the turn opens ({@link beginTurn}) or the host answers
   *  without opening one. While it is set the agent is not idle — a message
   *  arriving now rides that turn's first step rather than starting a second
   *  turn behind it. */
  private starting: Promise<EnqueueTurnResult> | null = null;
  private readonly injections = new StepInjections<{
    readonly message: ModelMessage;
    readonly durable: boolean;
  }>();

  constructor(
    private readonly host: BackendHost,
    /** Human-readable activity line for a wake that steered the live turn
     *  instead of queueing behind it. */
    private readonly logActivity?: (event: string, detail?: string) => void,
    private steers: UserSteerDeps = {},
  ) {}

  /** Whether a message sent now rides a turn that already exists — running,
   *  or admitted by this inbox and not yet open. The same read {@link send}
   *  makes, for a backend that must decide before it hands a message over. */
  get busy(): boolean {
    return this.starting !== null || this.host.turnInFlight();
  }

  /**
   * Send a message to the agent. The read of whether a turn exists and the
   * buffer push are synchronous (only the start-a-turn path awaits), so a
   * producer that has just bound durable rows to this message knows the
   * answer in the same tick it bound them.
   *
   * A signal that names its own fact (`idempotencyKey`) gets its card from that
   * name too. The card is the surface's record of the same announcement the
   * durable row is, so a re-delivery the backend collapses onto the existing
   * row must not open a second card beside it — one that would never gain a
   * message and so would render as pending forever.
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

  /** Bind the user-signal persistence half once, at the owning session's
   *  construction — the inbox itself is created earlier (inside the
   *  orchestrator), before a backend knows which store the accepted sends
   *  commit to. Binding past the first accepted user signal is a lifecycle
   *  bug: it would silently change which backend the buffer's pending rows
   *  drain into. */
  bindSteerDeps(steers: UserSteerDeps): void {
    if ([...this.pending, ...this.landing, ...this.absorbed].some(isUserSignal)) {
      throw new Error('cannot bind steer persistence once user signals have been accepted');
    }

    this.steers = steers;
  }

  /**
   * The `prepareStep` body: absorb everything buffered, then admit it at the
   * step tail — the drained users as ONE durable user message first, then the
   * events merged with the turn's own `steering` as ONE non-durable message —
   * each re-applied at its entry index on every later step.
   *
   * `steering` is the turn's own mechanical steering for THIS step, decided
   * by the caller from the live turn's state. It merges into the same message
   * so there is still one splice per step, and it is never buffered: a steer
   * that misses its step is a steer whose moment passed, and it is re-derived
   * at the next one if the condition holds.
   *
   * The drain's persistence is awaited BEFORE any card moves or word is
   * returned: a backend that cannot record the landed rows must not show the
   * model a steer whose durable half was never written.
   */
  async prepareStep(
    ctx: PrepareStepContext,
    steering: readonly AgentSignal[] = [],
  ): Promise<ModelMessage[] | undefined> {
    const drained = this.pending.splice(0);
    const users = drained.filter(isUserSignal);
    const events = drained.filter((signal) => !isUserSignal(signal));

    if (users.length > 0) {
      this.landing = drained;

      try {
        await this.steers.onDrain?.(users.map(toUserSteer), ctx.stepNumber);
      } catch (cause) {
        // New signals may arrive while persistence is awaited. The failed
        // prefix — users AND events, in order — goes back ahead of them.
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
      entries.push({ message: steerUserMessage(users.map(toUserSteer)), durable: true });
    }

    const bodies = [...events, ...steering].map(stepBody);

    if (bodies.length > 0) {
      entries.push({ message: { role: 'user', content: bodies.join('\n\n') }, durable: false });
    }

    return this.injections.drain(ctx, entries);
  }

  /**
   * Turn over: report what the model absorbed and reset for the next turn.
   * Everything that did NOT reach the model re-delivers — pending users FIRST,
   * as ONE user-origin turn, then events as their own turns; on an aborted
   * turn, whose answer is gone, the events it had absorbed requeue too.
   * Absorbed users never come back either way: their durable row already
   * exists. The turn's own steering never appears here: it was handed to a
   * step, not sent, so it has nothing to come back to.
   *
   * Call exactly once per turn, before anything that can throw. Re-delivery is
   * detached — a turn must never block on the next one's queue slot.
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

  /**
   * Interrupt: drop the user-kind signals the model never saw and RETURN
   * them, broadcasting 'returned' per steer so the composer takes its words
   * back. Events stay pending — an interrupt is "stop", and an event that
   * never landed still owes its own turn at settle.
   */
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

  /** Replace the process-local user queue from its durable authority on
   *  reset. Only valid before a step drain is in flight or this turn has
   *  recorded an injection — mixing two authorities would duplicate delivery.
   *  Restored rows land AHEAD of whatever is still pending; pending events
   *  keep their place. */
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

  /** Turn start: the turn this inbox may have been starting is now open, and
   *  splice state a dead turn may have leaked is dropped (entry indices are
   *  meaningless against the new turn's messages). A continuation turn
   *  re-queues the just-settled signals (see {@link settled}); a regular turn
   *  drops them — their turn answered. Signals still waiting ride either way.
   *
   *  `signalId` is the card of the signal that STARTED this turn, read back off
   *  the turn's own metadata by the backend. Its durable message is this turn's
   *  input, so the agent is reading it now and its card moves to shown — the
   *  queued half of the same transition {@link prepareStep} makes for a splice.
   *  Absent for a real user turn. */
  beginTurn(continuation: boolean, signalId?: string): void {
    this.starting = null;
    this.absorbed = [];
    this.injections.reset();

    if (continuation) this.pending.unshift(...this.settled);
    this.settled = [];

    if (signalId) this.moveCard(signalId, 'shown');
  }

  /** The spliced conversation as durable history: the turn's response messages
   *  with each durable injection back at the position the model saw it. Only
   *  the user kind is durable — an event splice is gone at replay. */
  replayInto(responseMessages: ReadonlyArray<ModelMessage>): ModelMessage[] {
    return this.injections.replayInto(responseMessages);
  }

  /** The durable messages themselves, for a backend whose failure path appends
   *  them without a response array to replay into. */
  recordedMessages(): ModelMessage[] {
    return this.injections.recorded
      .filter((entry) => entry.durable)
      .map((entry) => entry.message);
  }

  /**
   * Start a turn through the host, and hold {@link starting} for as long as
   * the turn is admitted but not yet open. The hold ends at {@link beginTurn}
   * — the turn is running and `turnInFlight` answers for it — or when the
   * host answers first: a refused, pre-empted, yielded or already-recorded
   * turn never opens, and whatever was buffered for its first step is sent
   * again so it starts a turn of its own instead of waiting for one that will
   * not come.
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

    // Registered before the caller's own await, so the hold is released
    // ahead of the caller's continuation and costs it no extra tick.
    attempt.then(settled, settled);

    return attempt;
  }

  /** Send again what no step will take: the users as ONE user-origin turn,
   *  then each event as a turn of its own. Detached — a turn must never block
   *  on the next one's queue slot. */
  private redeliver(users: readonly DeliveredUserSignal[], events: readonly DeliveredSignal[]): void {
    const [first, ...rest] = users;

    if (first !== undefined) {
      void this.queueUsers([first, ...rest], { idempotent: true }).catch(reportRedeliveryFailure(USER_MESSAGE_SIGNAL_KIND));
    }

    for (const signal of events) {
      void this.queue(signal).catch(reportRedeliveryFailure(signal.kind));
    }
  }

  /** Compensation runs OUTSIDE the enqueue's catch: a producer whose
   *  compensation itself fails (the background-job wake re-publishes a durable
   *  retry event, and says so by throwing) must surface that failure, not be
   *  re-entered as if the enqueue had thrown.
   *
   *  A producer's `idempotencyKey` rides through to the backend, which derives
   *  the queued turn's message id from it. That is the whole idempotency
   *  mechanism: the durable row cannot duplicate because its identity is the
   *  fact's, so an at-least-once producer needs no flag of its own. */
  private async queue(signal: DeliveredSignal): Promise<SendOutcome> {
    this.openCard(signal, signal.text);
    let reason: SignalUndeliveredReason;

    try {
      const metadata = { ...turnMetadata(signal), [SIGNAL_ID_METADATA_KEY]: signal.cardId };
      const { text, yieldsToUserMessage } = signal;
      // Requeues keep their server card identity across durable admission.
      // A yielding offer must still take the host's slot-time offer check.
      const idempotencyKey = signal.idempotencyKey ?? (yieldsToUserMessage === true ? undefined : signal.cardId);

      const turn: ProgrammaticTurn = {
        text, metadata,
        ...(idempotencyKey !== undefined && { idempotencyKey }),
        ...(yieldsToUserMessage === true && { yieldsToUserMessage }),
      };

      const result = await this.startTurn(() => this.host.enqueueTurn(turn));

      // The offer reached its slot and found the operator already speaking.
      // That is a consumed offer, not a failed one: no failure row, no
      // compensate — the message, not a retry, is what happens next. Its card
      // is withdrawn exactly like an undelivered one: nothing ever read it.
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
   * The turn half of the user kind: the operator's own words become their own
   * user turn — ONE enqueue for the whole group, joined in arrival order, under
   * the narrowest mode any of them was typed in. No card is opened and none
   * moves: the steer_status broadcasts already told the surface where every
   * steer is, and the durable row the host writes IS the record.
   *
   * `idempotent` names which admission this is: a rerun of a turn's leftovers
   * carries a `steer-rerun:` key so re-delivery collapses onto the row the
   * first attempt wrote; a message arriving at an idle agent matches the
   * host's ordinary user-turn admission and carries none.
   */
  private async queueUsers(
    group: readonly [DeliveredUserSignal, ...DeliveredUserSignal[]],
    opts: { readonly idempotent: boolean },
  ): Promise<SendOutcome> {
    const [first] = group;
    const files = group.flatMap((signal) => signal.user.files ?? []);
    // Plan is the narrower grant: merging never widens what a message was
    // typed under, so one plan-mode message makes the whole turn plan.
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

      if (result.status === 'queued') return 'queued';
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

  /** The card's opening, at the moment the signal arrived. It carries the same
   *  `kinuEvent` metadata a queued signal's durable message is stamped with,
   *  so one classifier renders both, and `text` is THIS delivery's rendering —
   *  what the model will actually read, never the other path's. */
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

/** The turn metadata a signal carries: its `kinuEvent` provenance, the
 *  reply binding its source rows are bound to, and the producer's own.
 *
 *  The producer's metadata spreads FIRST, so the inbox owns the reserved keys:
 *  a producer naming `kinuEvent` or `drainTurnId` cannot move its turn under
 *  another provenance or rebind its reply. The author stamp goes on LAST, so
 *  a producer carrying the operator's words keeps them, and nothing else can
 *  overwrite the stamp underneath the seam. */
const turnMetadata = (signal: AgentSignal): JsonObject => {
  const metadata: JsonObject = { ...signal.metadata, kinuEvent: signal.kind };

  if (signal.replyTurnId) metadata.drainTurnId = signal.replyTurnId;

  return stampTurnAuthor(metadata);
};

function reportRedeliveryFailure(kind: string) {
  return <Failure>(failure: Failure): void => {
    diagnostics.failure(
      'signal.redelivery_failed',
      toKinuError({ doing: 're-deliver a signal', cause: failure, otherwise: 'io' }),
      { signal: kind },
    );
  };
}
