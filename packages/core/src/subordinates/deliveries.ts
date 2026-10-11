/**
 * The one way input reaches an agent (design v2 §1, v3 A): a producer commits a delivery for the agent in the same
 * synchronous commit as its own source fact and the agent's wake, then the delivery crosses once into the agent's own
 * inbox. The agent answers `taken` or `duplicate`, either of which retires the row; a row still unpaid at the next wake
 * crosses again under the same id. No transaction spans the two stores.
 */
import * as v from 'valibot';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import { JsonObjectSchema, type JsonObject } from '../utils/json';
import { PromptFileSchema, signalCardId, turnMetadata } from '../orchestrator/inbox';
import { buildDrainBatch } from '../events/hub/drain';
import type { EventLog } from '../events/hub/log';
import { delegatedTaskMetadata, metadataBroadcastEvent } from '../read-models/background-event';
import type { BroadcastEvent } from '../types/backend-host';
import { SIGNAL_ID_METADATA_KEY, type AgentInbox, type AgentSignal, type SendOutcome } from '../types/signals';
import { MISSION_LABELS_METADATA_KEY } from '../mission-budget';
import { nanoid } from '../utils/nanoid';
import { Cause, Effect, Exit } from 'effect';
import { serialQueue } from '@kinu.run/agent-utils';
import { attemptInItsWords, CODE_IS_REFUSAL, diagnostics, hold, KinuError, settleSync, toKinuError, type ErrorCode } from '../obs/index';
import { TierIdSchema } from '../types/profile';
import { WorkModeSchema, type WorkMode } from '../types/turn';
import type { TurnAuthorship } from '../orchestrator/turn-authorship';

/** What a delivery asks of its agent. */
const DeliveryInputSchema = v.variant('kind', [
  /** A person's words: a send, or a card the workspace says in their place. */
  v.object({
    kind: v.literal('words'), text: v.string(), files: v.optional(v.array(PromptFileSchema)), mode: v.optional(WorkModeSchema),
    tier: v.optional(TierIdSchema), metadata: v.optional(JsonObjectSchema),
  }),
  /** A turn of the agent's own, opened by what happened: an event, an assignment, a report, an advisor's note. A turn
   *  already running takes it at its next step instead, reading `stepText` when it has one; one that `opensTurn` (an
   *  assignment, whose answer is keyed by its id) or yields to the owner's words always waits for a turn of its own. */
  v.object({
    kind: v.literal('turn'), text: v.string(), stepText: v.optional(v.string()), metadata: v.optional(JsonObjectSchema),
    opensTurn: v.optional(v.boolean()), yieldsToUserMessage: v.optional(v.boolean()),
  }),
  /** A run its workspace asks of it whole (a head's, a swarm node's): its own task, run to its end and reported. */
  v.object({
    kind: v.literal('run'), task: v.object({ sequenceId: v.string(), body: v.string(), mode: WorkModeSchema }),
  }),
]);

export type DeliveryInput = v.InferOutput<typeof DeliveryInputSchema>;

export type TurnDeliveryInput = Extract<DeliveryInput, { readonly kind: 'turn' }>;

const AuthorshipSchema = v.picklist(['owner', 'hirer']);

/** One delivery as it crosses, parsed where it lands: its id is the agent's idempotency key for it, which the agent
 *  refuses as it would a person's message id, and its authorship decides its lane. */
export const DeliverySchema = v.object({ id: v.string(), input: DeliveryInputSchema, authorship: AuthorshipSchema });

export interface Delivery {
  readonly id: string;
  readonly input: DeliveryInput;
  readonly authorship: TurnAuthorship;
}

/**
 * A turn delivery as the signal a running turn reads at its next step, as its producer's signal was: its kind, and the
 * turn its events are bound to, which that turn's end answers, ride its metadata.
 */
export function deliveredSignal(id: string, input: TurnDeliveryInput): AgentSignal {
  const kind = v.safeParse(v.string(), input.metadata?.kinuEvent);
  const drained = v.safeParse(v.string(), input.metadata?.drainTurnId);

  return {
    kind: kind.success ? kind.output : 'delivery', text: input.text, idempotencyKey: id,
    ...(input.stepText !== undefined && { stepText: input.stepText }),
    ...(drained.success && { replyTurnId: drained.output }),
    ...(input.metadata !== undefined && { metadata: input.metadata }),
  };
}

/** What a delivery's turn was admitted under: none for a run, which opens no turn of the chat. */
export function deliveryMetadata(delivery: Delivery): JsonObject | undefined {
  return delivery.input.kind === 'run' ? undefined : delivery.input.metadata;
}

/** A person's message id, as every chat holds them. */
export const MessageIdSchema = v.pipe(v.string(), v.nonEmpty(), v.maxLength(128));

/** Why a person's words are refused at the door before anything is written, as the agent itself would refuse them. */
export function wordsRefusal(delivery: Delivery): KinuError | null {
  if (!v.is(MessageIdSchema, delivery.id)) return new KinuError('bad_input', 'A message id is 1 to 128 characters.');

  if (delivery.input.kind === 'words' && delivery.input.text.trim() === '' && (delivery.input.files ?? []).length === 0) {
    return new KinuError('bad_input', 'send requires the message text');
  }

  return null;
}

/** What the agent answered: the input is in its own store now, or already was; or, an offer that yields to its owner's
 *  words, it met words that came first and is consumed unrun; or it refused it, as it is, with what it said. A refusal is
 *  an answer: the delivery is retired and its sender told. Only a crossing that does not reach the agent leaves it owed. */
export type DeliveryAnswer = 'taken' | 'duplicate' | 'yielded' | { readonly refused: { readonly code: ErrorCode; readonly message: string } };

export function initAgentDeliveriesTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS agent_deliveries (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id   TEXT NOT NULL,
    id         TEXT NOT NULL,
    input_json TEXT NOT NULL,
    authorship TEXT NOT NULL CHECK (authorship IN ('owner','hirer')),
    UNIQUE (actor_id, id)
  )`);
}

/** The deliveries a workspace owes its agents, each until the agent answers for it. */
export class AgentDeliveries {
  constructor(private readonly sql: SqlExecutor) {}

  /** Inside the producer's own commit. A repeat of the id owes nothing new: answers false. */
  add(actorId: string, delivery: Delivery): boolean {
    return this.sql<{ seq: number }>`INSERT INTO agent_deliveries (actor_id, id, input_json, authorship)
      VALUES (${actorId}, ${delivery.id}, ${JSON.stringify(delivery.input)}, ${delivery.authorship})
      ON CONFLICT (actor_id, id) DO NOTHING RETURNING seq`.length > 0;
  }

  /** The agent's unpaid deliveries, in the order their producers committed them. */
  unpaid(actorId: string): Delivery[] {
    return this.sql<{ id: string; input_json: string; authorship: string }>`
      SELECT id, input_json, authorship FROM agent_deliveries WHERE actor_id = ${actorId} ORDER BY seq ASC`
      .map((row) => ({
        id: row.id,
        input: v.parse(DeliveryInputSchema, JSON.parse(row.input_json)),
        authorship: v.parse(AuthorshipSchema, row.authorship),
      }));
  }

  /** Whether any delivery for the agent is unpaid: its wake stands while one is. */
  owes(actorId: string): boolean {
    return this.sql<{ seq: number }>`SELECT seq FROM agent_deliveries WHERE actor_id = ${actorId} LIMIT 1`.length > 0;
  }

  /** Every agent owed a delivery, for the sweep that crosses them again. */
  actors(): string[] {
    return this.sql<{ actor_id: string }>`SELECT DISTINCT actor_id FROM agent_deliveries`.map((row) => row.actor_id);
  }

  /** The agent answered for it. */
  paid(actorId: string, id: string): void {
    void this.sql`DELETE FROM agent_deliveries WHERE actor_id = ${actorId} AND id = ${id}`;
  }

  /** A Stop's or a retirement's cutoff: every delivery unpaid at that moment is cancelled, and answered as such. */
  cancel(actorId: string): Delivery[] {
    const cancelled = this.unpaid(actorId);

    void this.sql`DELETE FROM agent_deliveries WHERE actor_id = ${actorId}`;

    return cancelled;
  }
}

/**
 * A signal to an agent, as a delivery: committed and crossed by `deliver`, its card opened where the agent's room hears
 * it. The signal's own turn opens under its card, so the surface follows it there. Answered `queued` once committed: a
 * committed delivery is owed until the agent takes it, so nothing is compensated after.
 */
export class DeliveryInbox implements AgentInbox {
  constructor(private readonly deps: {
    /** The agent's answer once it crossed; null while it is owed still, as it is until the agent's wake delivers it. */
    readonly deliver: (delivery: Delivery) => Promise<DeliveryAnswer | null>;
    readonly broadcast: (event: BroadcastEvent) => void;
  }) {}

  async send(signal: AgentSignal): Promise<SendOutcome> {
    if (signal.user !== undefined) return settleSync(Effect.fail(new KinuError('bad_input', "A person's words are delivered as words, never as a signal.")));
    const cardId = signal.idempotencyKey === undefined ? `sig-${nanoid()}` : signalCardId(signal.idempotencyKey);
    const metadata: JsonObject = { ...turnMetadata(signal), [SIGNAL_ID_METADATA_KEY]: cardId };

    this.deps.broadcast(metadataBroadcastEvent('signal_card', metadata, { id: cardId, state: 'pending', text: signal.text }));

    const answer = await this.deps.deliver({
      id: signal.idempotencyKey ?? cardId,
      input: {
        kind: 'turn', text: signal.text, metadata,
        ...(signal.stepText !== undefined && { stepText: signal.stepText }),
        ...(signal.yieldsToUserMessage === true && { yieldsToUserMessage: true }),
      },
      authorship: 'hirer',
    });

    // The owner spoke first: a consumed offer, not a failure.
    if (answer !== 'yielded') return 'queued';
    this.deps.broadcast(metadataBroadcastEvent('signal_card', metadata, { id: cardId, state: 'undelivered', text: signal.text }));

    return 'yielded';
  }
}

/**
 * The agent's pending events as one delivery (design v2 §1.5): its events bound to its turn, inside the commit that
 * writes it, so the event log is the record and the delivery the queue. Null when no event is owed a turn.
 */
export function pendingEventsDelivery(eventLog: EventLog, now: number): Delivery | null {
  const batch = buildDrainBatch(eventLog.pending({ resolve_deferred: { now, phase: 'idle' } }), eventLog.isEvolutionReport);

  if (batch === null) return null;
  const turnId = `evt-${nanoid()}`;

  for (const id of batch.ids) eventLog.markConsumed(id, turnId, 0);

  const metadata: JsonObject = {
    ...turnMetadata({ kind: 'event_drain', text: batch.text, replyTurnId: turnId }),
    ...(batch.mode !== null && { kinuMode: batch.mode }),
    ...(batch.missions.length > 0 && { [MISSION_LABELS_METADATA_KEY]: batch.missions }),
  };

  return { id: turnId, input: { kind: 'turn', text: batch.text, stepText: batch.midTurnText, metadata }, authorship: 'hirer' };
}

/** An assignment admitted to its agent's log, as the delivery that opens its turn. */
export interface DeliveredAssignment {
  /** The assignment's row: the delivery's id, its turn's identity, and what its answer names. */
  readonly id: string;
  readonly body: string;
  readonly mode: WorkMode;
  /** Who assigned it, as the agent's chat shows it. */
  readonly from: string;
}

/**
 * An assignment as its agent's delivery (design v2 §1): its row bound under its own id inside the commit that admits it,
 * so its turn reads the brief's inherited context by that id, its answer names it, and its turn's end closes it.
 */
export function assignmentDelivery(eventLog: EventLog, assignment: DeliveredAssignment): Delivery {
  eventLog.markConsumed(assignment.id, assignment.id, 0);

  return {
    id: assignment.id,
    input: { kind: 'turn', text: assignment.body, metadata: { ...delegatedTaskMetadata(assignment.from, assignment.mode), drainTurnId: assignment.id }, opensTurn: true },
    authorship: 'hirer',
  };
}

/** What a producer wrote, and the delivery it owes the agent for it: none when it wrote nothing new. */
export interface OwedAdmission<A> {
  readonly value: A;
  readonly delivery: Delivery | null;
}

/** An agent's deliveries as a port its orchestrator sends signals and drains through. */
export interface DeliveryPort {
  readonly signals: AgentInbox;
  readonly commit: (bind: () => Delivery | null) => Promise<void>;
}

/**
 * The events a delivery carries that its agent did not take go back: yielded to the owner's words, they are pending
 * again; refused, they wait for the drain something else starts. Taken, they are its turn's, and close with it.
 */
export function handBackCarried(eventLog: EventLog, delivery: Delivery, answer: Exclude<DeliveryAnswer, 'taken' | 'duplicate'>): void {
  const drained = v.safeParse(v.string(), deliveryMetadata(delivery)?.drainTurnId);

  if (!drained.success) return;

  for (const event of eventLog.query({ turn_id: drained.output })) {
    if (answer === 'yielded') eventLog.unbind(event.id);
    else eventLog.park(event.id);
  }
}

/**
 * An agent's deliveries where its chat runs in this process (the CLI): committed with their producer's fact, then handed
 * to the chat once, in commit order. One a death left unpaid is handed again by {@link crossOwed} when the agent next
 * opens; its chat answers a repeat `duplicate`. A refusal, the chat's own or one that would recur, is an answer: retired.
 */
export class InProcessDeliveries implements DeliveryPort {
  readonly signals: AgentInbox;
  private readonly lane = serialQueue();

  constructor(private readonly deps: {
    readonly actorId: string;
    readonly sql: SqlExecutor;
    readonly transaction: <A>(body: () => A) => A;
    readonly eventLog: EventLog;
    readonly admit: (delivery: Delivery) => Promise<DeliveryAnswer>;
    readonly broadcast: (event: BroadcastEvent) => void;
  }) {
    this.signals = new DeliveryInbox({ deliver: (delivery) => this.deliver(delivery), broadcast: deps.broadcast });
  }

  readonly commit = async (bind: () => Delivery | null): Promise<void> => {
    await this.owe(() => ({ value: undefined, delivery: bind() }));
  };

  /** The deliveries taken since it was last asked, by id: a pass that handed them over runs their turns before it ends,
   *  outside the crossing (a crossing made from a turn's own close never waits on the turn queued behind it). */
  takenSince(): readonly string[] {
    return this.taken.splice(0);
  }

  private readonly taken: string[] = [];

  /** What `admit` writes and the delivery it owes the agent, as one commit; then one crossing. */
  async owe<A>(admit: () => OwedAdmission<A>): Promise<A> {
    const { value, delivery } = this.committed(admit);

    if (delivery !== null) await this.lane(() => this.cross(delivery));

    return value;
  }

  /** What `admit` writes and the delivery it owes the agent, as one commit; the agent's next {@link crossOwed} crosses it. */
  record<A>(admit: () => OwedAdmission<A>): A {
    return this.committed(admit).value;
  }

  private committed<A>(admit: () => OwedAdmission<A>): OwedAdmission<A> {
    return this.deps.transaction(() => {
      const admitted = admit();

      if (admitted.delivery !== null) new AgentDeliveries(this.deps.sql).add(this.deps.actorId, admitted.delivery);

      return admitted;
    });
  }

  /** The agent's answer; null while it is owed still, or once it was refused. */
  private async deliver(delivery: Delivery): Promise<DeliveryAnswer | null> {
    this.deps.transaction(() => new AgentDeliveries(this.deps.sql).add(this.deps.actorId, delivery));

    return await this.lane(() => this.cross(delivery));
  }

  /** A Stop's cutoff (design v3 C): what the agent was owed and had not taken is cancelled, and the work it carried
   *  parked; nothing of it crosses after. */
  cancel(): readonly Delivery[] {
    const cancelled = this.deps.transaction(() => new AgentDeliveries(this.deps.sql).cancel(this.deps.actorId));

    for (const delivery of cancelled) handBackCarried(this.deps.eventLog, delivery, { refused: { code: 'cancelled', message: 'The agent was stopped before it took this.' } });

    return cancelled;
  }

  /** What the agent was owed and a death kept from it, in commit order, up to a crossing that fails; answers what its chat
   *  took in this sweep. */
  async crossOwed(): Promise<readonly Delivery[]> {
    return await this.lane(async () => {
      const taken: Delivery[] = [];

      for (const delivery of new AgentDeliveries(this.deps.sql).unpaid(this.deps.actorId)) {
        const answer = await this.cross(delivery);

        if (answer === 'taken') taken.push(delivery);
        // A crossing that did not reach the agent stops the sweep: what is behind it waits for its next open.
        else if (answer === null && this.owed(delivery)) break;
      }

      return taken;
    });
  }

  private owed(delivery: Delivery): boolean {
    return new AgentDeliveries(this.deps.sql).unpaid(this.deps.actorId).some((row) => row.id === delivery.id);
  }

  private async cross(delivery: Delivery): Promise<DeliveryAnswer | null> {
    if (!this.owed(delivery)) return null;
    const crossed = await hold(attemptInItsWords('unavailable', () => this.deps.admit(delivery)));
    const deliveries = new AgentDeliveries(this.deps.sql);

    if (Exit.isFailure(crossed)) {
      const failure = toKinuError({ doing: 'handing the agent what it is owed', cause: Cause.squash(crossed.cause), otherwise: 'unavailable' });

      // Refused where it would be on every crossing: an answer, as the agent's own; else owed still.
      if (CODE_IS_REFUSAL[failure.code]) return this.refused(delivery, failure);
      diagnostics.failure('agent.delivery_crossing_failed', failure, { actorId: this.deps.actorId, deliveryId: delivery.id });

      return null;
    }

    const answer = crossed.value;

    if (typeof answer === 'object') return this.refused(delivery, new KinuError(answer.refused.code, answer.refused.message));
    deliveries.paid(this.deps.actorId, delivery.id);

    if (answer === 'yielded') handBackCarried(this.deps.eventLog, delivery, answer);

    if (answer === 'taken') this.taken.push(delivery.id);

    return answer;
  }

  private refused(delivery: Delivery, failure: KinuError): null {
    diagnostics.failure('agent.delivery_refused', failure, { actorId: this.deps.actorId, deliveryId: delivery.id });
    new AgentDeliveries(this.deps.sql).paid(this.deps.actorId, delivery.id);
    handBackCarried(this.deps.eventLog, delivery, { refused: { code: failure.code, message: failure.message } });

    return null;
  }
}
