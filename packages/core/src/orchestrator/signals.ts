/**
 * Signal delivery — the ONE way anything asynchronous reaches an agent.
 *
 * A producer states intent and nothing else ({@link SignalDelivery.deliver}).
 * Delivery splices a compatible signal into the live turn's next step boundary.
 * A signal that requires its own turn, whose governing metadata differs from
 * the live turn's, or that reaches an idle agent is queued through
 * BackendHost.enqueueTurn instead, preserving a homogeneous turn surface. The
 * routing read is synchronous, before any await, because the
 * select→bind→deliver decision a producer makes against durable state must be
 * one event-loop tick.
 *
 * Two kinds ride this seam. A user's message — typed while a turn runs — is
 * the user kind: its splice is the DURABLE user row (the walk-back fork cuts
 * at it), an interrupt hands it back to the composer, and anything left over
 * reruns as a USER-origin turn. Everything else is an event: ephemeral,
 * model-visible at the tip and never durable chat history. Governing metadata
 * is the difference: an event's `kinuMode`/mission labels must match the live
 * turn or it gets its own; the user's words always land where the user is
 * looking, whatever mode the composer was in.
 *
 * Everything buffered for a step boundary drains at the step tail (after the
 * latest tool results, so role alternation stays provider-safe), re-applied at
 * its entry index for the rest of the turn — the StepInjections coordinate
 * math. User messages drain as their own splice first; events merge with the
 * turn's own steering into ONE non-durable user message beside it. One buffer
 * and one splice per kind, so no extension registration order can shift
 * another producer's recorded indices.
 *
 * The turn's OWN steering — decided inside the step pipeline from the live
 * turn's state — is not delivered, it is handed to
 * {@link SignalDelivery.prepareStep} as the step being prepared. That is the
 * whole distinction, and it is structural rather than declared: steering
 * enters through a step, so it cannot outlive it, cannot start a turn, and
 * cannot come back after the turn is over (it is re-derived next turn if the
 * condition still holds). Nothing an asynchronous producer can reach makes
 * that choice.
 *
 * Delivery is also where the user's CARD comes from — for the event kind. An
 * event is something that happened at a moment the user cares about, so the
 * seam broadcasts the card when it routes the signal ('pending' — it arrived,
 * the agent has not read it yet) and moves that same card to 'shown' where the
 * agent actually takes it in: the step that splices it, or the turn a queued
 * signal started (which names its card through the `signalId` the seam
 * stamped on it). Nothing else broadcasts a card, so it cannot drift from
 * what the model received. A mechanical steer has none, structurally — it is
 * not delivered, so there is no moment at which it "arrived"; its record is
 * the `turn_steering` run event on the turn that derived it. A user message
 * has none either — its record is the durable user row itself, announced by
 * the steer_status broadcasts the seam emits as it lands, returns, or reruns.
 *
 * A user signal's durable record is the verbatim row a backend writes from
 * the drain (plus the absorbing turn's reply); an event's is its own (the
 * EventLog row consumed by the batch turn id, the `turn_steering` run event).
 * Think's one-assistant-message-per-turn transcript cannot represent an event
 * between steps, and persisting it after the assistant reply would read as an
 * unanswered event next turn.
 */

import type { ModelMessage } from 'ai';
import * as v from 'valibot';
import type { PrepareStepContext } from '../extension';
import type { BackendHost, ProgrammaticTurn } from '../types/backend-host';
import type {
  AgentSignal, SettledSignals, SignalCardState, SignalDeliverer, SignalOutcome,
  SignalUndeliveredReason, UserSignalIdentity,
} from '../types/signals';
import { SIGNAL_ID_METADATA_KEY, USER_MESSAGE_SIGNAL_KIND } from '../types/signals';
import { StepInjections } from '../prompting/step-injections';
import { nanoid } from '../utils/nanoid';
import { metadataBroadcastEvent } from '../read-models/background-event';
import { isWorkMode, type WorkMode } from '../types/turn';
import type { JsonObject } from '../utils/json';
import { stampTurnAuthor, TURN_AUTHOR_METADATA_KEY } from '../utils/ui-message';
import { diagnostics, KinuError, toKinuError } from '../obs/index';
import { readMissionLabels } from '../mission-budget';
import { steerUserMessage, type UserSteer } from './user-steer';

const SignalIdMetadataSchema = v.object({
  [SIGNAL_ID_METADATA_KEY]: v.optional(v.string()),
});

/** A signal once the seam owns it: the producer's statement plus the card
 *  identity delivery gives it. Producers never see or set it. */
interface DeliveredSignal extends AgentSignal {
  readonly cardId: string;
}

/** A delivered signal narrowed to the user kind. */
interface DeliveredUserSignal extends DeliveredSignal {
  readonly user: UserSignalIdentity;
}

/** The governing metadata the live turn runs under: the work mode and mission
 *  scope an event signal must match to ride the turn's next step. */
interface GoverningTurn {
  readonly mode: WorkMode | null;
  readonly missions: readonly string[];
}

/** The user-kind persistence boundary a backend wires when it has one. */
export interface UserSteerDeps {
  /** Persist a drain before the rewritten messages reach the provider (CF: verbatim user rows +
   *  DELETE pending_steers; CLI: push landed rows). Rejection aborts the step; the seam restores
   *  everything drained (users AND events) ahead of pending and moves no card. */
  readonly onDrain?: (steers: readonly UserSteer[], atStep: number) => void | Promise<void>;
  /** The live turn's durable id, for the rerun key. Null when unknown. */
  readonly turnId?: () => string | null;
}

/** The card id a turn carries, when a signal started it — the other half of
 *  the round trip {@link SignalDelivery.queue} stamps. */
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

export class SignalDelivery implements SignalDeliverer {
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
  private readonly injections = new StepInjections<{
    readonly message: ModelMessage;
    readonly durable: boolean;
  }>();

  constructor(
    private readonly host: BackendHost,
    /** Human-readable activity line for a wake that steered the live turn
     *  instead of queueing behind it. */
    private readonly logActivity?: (event: string, detail?: string) => void,
    private readonly activeGoverning?: () => GoverningTurn,
    private readonly steers: UserSteerDeps = {},
  ) {}

  /**
   * Deliver a signal to the agent's next step. The read of whether a turn is
   * running and the buffer push are synchronous (only the start-a-turn path
   * awaits), so a producer that has just bound durable rows to this signal
   * knows the answer in the same tick it bound them.
   *
   * A signal that names its own fact (`idempotencyKey`) gets its card from that
   * name too. The card is the surface's record of the same announcement the
   * durable row is, so a re-delivery the backend collapses onto the existing
   * row must not open a second card beside it — one that would never gain a
   * message and so would render as pending forever.
   */
  deliver(signal: AgentSignal): Promise<SignalOutcome> {
    const cardId = signal.idempotencyKey ? `sig:${signal.idempotencyKey}` : `sig-${nanoid()}`;
    const delivered: DeliveredSignal = { ...signal, cardId };

    // The user kind skips every routing test: no card, no governing check —
    // the words always land in the turn the user is watching, or rerun as a
    // user-origin turn when nothing is running.
    if (isUserSignal(delivered)) {
      if (!this.host.turnInFlight()) return this.queueUsers([delivered], { idempotent: false });
      this.pending.push(delivered);
      this.host.broadcast({
        type: 'steer_status', status: 'queued', steerId: delivered.user.id, text: signal.text,
      });

      return Promise.resolve('mid-turn');
    }

    const active = this.activeGoverning?.();
    const signalMode = signal.metadata?.kinuMode;

    const modeMismatch = isWorkMode(signalMode) && active?.mode !== signalMode;
    const missions = readMissionLabels(signal.metadata);

    const missionMismatch = missions.length > 0
      && JSON.stringify([...missions].sort()) !== JSON.stringify([...(active?.missions ?? [])].sort());

    const ownTurn = signal.requiresOwnTurn === true || modeMismatch || missionMismatch;

    if (!this.host.turnInFlight() || ownTurn) return this.queue(delivered);
    this.pending.push(delivered);
    this.openCard(delivered, stepBody(delivered));
    this.logActivity?.('signal_injected', `${signal.kind} → live turn`);

    return Promise.resolve('mid-turn');
  }

  /**
   * The `prepareStep` body: absorb everything buffered, then admit it at the
   * step tail — the drained users as ONE durable user message first, then the
   * events merged with the turn's own `steering` as ONE non-durable message —
   * each re-applied at its entry index on every later step.
   *
   * `steering` is the turn's own mechanical steering for THIS step, decided
   * by the caller from the live turn's state. It
   * merges into the same message so there is still one splice per step, and it
   * is never buffered: a steer that misses its step is a steer whose moment
   * passed, and it is re-derived at the next one if the condition holds.
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
   * as user-origin turns grouped by contiguous mode, then events as their own
   * turns; on an aborted turn, whose answer is gone, the events it had
   * absorbed requeue too. Absorbed users never come back either way: their
   * durable row already exists. The turn's own steering never appears here:
   * it was handed to a step, not delivered, so it has nothing to come back to.
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

    for (const group of contiguousRuns(leftoverUsers)) {
      void this.queueUsers(group, { idempotent: true }).catch(reportRedeliveryFailure(USER_MESSAGE_SIGNAL_KIND));
    }

    for (const signal of requeue) {
      void this.queue(signal).catch(reportRedeliveryFailure(signal.kind));
    }

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

  /** Turn start: drop splice state a dead turn may have leaked (entry indices
   *  are meaningless against the new turn's messages). A continuation turn
   *  re-queues the just-settled signals (see {@link settled}); a regular turn
   *  drops them — their turn answered. Signals still waiting ride either way.
   *
   *  `signalId` is the card of the signal that STARTED this turn, read back off
   *  the turn's own metadata by the backend. Its durable message is this turn's
   *  input, so the agent is reading it now and its card moves to shown — the
   *  queued half of the same transition {@link prepareStep} makes for a splice.
   *  Absent for a real user turn. */
  beginTurn(continuation: boolean, signalId?: string): void {
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

  /** Compensation runs OUTSIDE the enqueue's catch: a producer whose
   *  compensation itself fails (the background-job wake re-publishes a durable
   *  retry event, and says so by throwing) must surface that failure, not be
   *  re-entered as if the enqueue had thrown.
   *
   *  A producer's `idempotencyKey` rides through to the backend, which derives
   *  the queued turn's message id from it. That is the whole idempotency
   *  mechanism: the durable row cannot duplicate because its identity is the
   *  fact's, so an at-least-once producer needs no flag of its own. */
  private async queue(signal: DeliveredSignal): Promise<SignalOutcome> {
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

      const result = await this.host.enqueueTurn(turn);

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
   * The queued half of the user kind: the operator's own words become their
   * own user turn — one enqueue per contiguous run of one mode, so a group
   * break keeps each run under the mode its words were typed in. No card is
   * opened and none moves: the steer_status broadcasts already told the
   * surface where every steer is, and the durable row the host writes IS the
   * record.
   *
   * `idempotent` names which admission this is: a rerun of a turn's leftovers
   * carries a `steer-rerun:` key so re-delivery collapses onto the row the
   * first attempt wrote; a steer arriving at an idle agent matches the host's
   * ordinary user-turn admission and carries none.
   */
  private async queueUsers(
    group: readonly [DeliveredUserSignal, ...DeliveredUserSignal[]],
    opts: { readonly idempotent: boolean },
  ): Promise<SignalOutcome> {
    const [first] = group;
    const files = group.flatMap((signal) => signal.user.files ?? []);

    const turn: ProgrammaticTurn = {
      text: group.map((signal) => signal.text).join('\n\n'),
      metadata: { [TURN_AUTHOR_METADATA_KEY]: 'operator', kinuMode: first.user.mode },
      origin: 'user',
      steerIds: group.map((signal) => signal.user.id),
      ...(opts.idempotent && {
        idempotencyKey: `steer-rerun:${this.steers.turnId?.() ?? 'live'}:${first.user.mode}:${first.user.id}`,
      }),
      ...(files.length > 0 && { files }),
    };

    try {
      const result = await this.host.enqueueTurn(turn);

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
 *  The producer's metadata spreads FIRST, so the seam owns the reserved keys:
 *  a producer naming `kinuEvent` or `drainTurnId` cannot move its turn under
 *  another provenance or rebind its reply. The author stamp goes on LAST, so
 *  a producer carrying the operator's words keeps them, and nothing else can
 *  overwrite the stamp underneath the seam. */
const turnMetadata = (signal: AgentSignal): JsonObject => {
  const metadata: JsonObject = { ...signal.metadata, kinuEvent: signal.kind };

  if (signal.replyTurnId) metadata.drainTurnId = signal.replyTurnId;

  return stampTurnAuthor(metadata);
};

/** Split pending user signals into contiguous runs of one mode, in arrival
 *  order — the rerun grouping: a group break anywhere starts a fresh turn. */
function contiguousRuns(
  users: readonly DeliveredUserSignal[],
): Array<[DeliveredUserSignal, ...DeliveredUserSignal[]]> {
  const runs: Array<[DeliveredUserSignal, ...DeliveredUserSignal[]]> = [];

  for (const signal of users) {
    const last = runs.at(-1);

    if (last !== undefined && last[0].user.mode === signal.user.mode) {
      last.push(signal);
    } else {
      runs.push([signal]);
    }
  }

  return runs;
}

function reportRedeliveryFailure(kind: string) {
  return <Failure>(failure: Failure): void => {
    diagnostics.failure(
      'signal.redelivery_failed',
      toKinuError({ doing: 're-deliver a signal', cause: failure, otherwise: 'io' }),
      { signal: kind },
    );
  };
}
