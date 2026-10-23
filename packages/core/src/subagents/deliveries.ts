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
import type { PromptFile } from '../types/backend-host';
import { buildDrainBatch } from '../events/hub/drain';
import type { EventLog } from '../events/hub/log';
import { delegatedTaskMetadata, metadataBroadcastEvent } from '../read-models/background-event';
import type { BroadcastEvent } from '../types/backend-host';
import { SIGNAL_ID_METADATA_KEY, type AgentInbox, type AgentSignal, type SendOutcome } from '../types/signals';
import { MISSION_LABELS_METADATA_KEY } from '../types/turn-metadata';
import { nanoid } from '../utils/nanoid';
import { Effect } from 'effect';
import { KinuError, settleSync, type ErrorCode } from '../obs/index';
import { TierIdSchema } from '../types/profile';
import { WorkModeSchema, type WorkMode } from '../types/turn';
import type { TurnAuthorship } from '../types/turn';
import { OwnerAnswersSchema } from '../plans/owner-questions';
import type { PlanDecisionOutcome } from '../types/plans';
import { PlanDecisionOutcomeSchema } from '../plans/review';

/** What a delivery asks of its agent. */
const DeliveryInputSchema = v.variant('kind', [
  /** A person's words: a send, or a card the workspace says in their place. */
  v.object({
    kind: v.literal('words'), text: v.string(), files: v.optional(v.array(PromptFileSchema)), mode: v.optional(WorkModeSchema),
    tier: v.optional(TierIdSchema), metadata: v.optional(JsonObjectSchema),
  }),
  /** A turn of the agent's own, opened by what happened: an event, an assignment, a report, an advisor's blocker. A turn
   *  already running takes it at its next step instead, reading `stepText` when it has one; one that `opensTurn` (an
   *  assignment, whose answer is keyed by its id) or yields to the owner's words always waits for a turn of its own. */
  v.object({
    kind: v.literal('turn'), text: v.string(), stepText: v.optional(v.string()), metadata: v.optional(JsonObjectSchema),
    opensTurn: v.optional(v.boolean()), yieldsToUserMessage: v.optional(v.boolean()),
  }),
  /** A run its workspace asks of it whole (a head's, a swarm node's): its own task, run to its end and reported. */
  v.object({
    kind: v.literal('run'), task: v.object({ sequenceId: v.string(), runId: v.string(), body: v.string(), mode: WorkModeSchema }),
  }),
  /** The owner's intents (D6), each crossed as any input is and answered with what it did: their decision on a plan the
   *  agent submitted, at the revision they read; */
  v.object({
    kind: v.literal('decision'), plan: v.string(), revision: v.number(), decision: v.picklist(['request_changes', 'approve']),
    feedback: v.optional(v.string()),
  }),
  /** their answers to the questions the agent asked in its call `questions`; */
  v.object({ kind: v.literal('answers'), questions: v.string(), answers: OwnerAnswersSchema }),
  /** their Retry of the agent's newest turn, whose newest message must still be the one they saw, `messageId`. */
  v.object({ kind: v.literal('retry'), messageId: v.string() }),
]);

export type DeliveryInput = v.InferOutput<typeof DeliveryInputSchema>;

/** A person's words as their send carries them, before a delivery is made of them. */
export type SentWords = Omit<Extract<DeliveryInput, { readonly kind: 'words' }>, 'kind'>;

/**
 * What a send carries beside its text and files, on its chat message's `metadata`, as every client writes it: the work
 * mode, the tier for its turn, and the metadata of a turn it opens (a one-shot run's mark, the folder a CLI sends from).
 * Each is the words' own field; a send that names none steers a turn already running.
 */
export const SendMetadataSchema = v.looseObject({
  kinuMode: v.optional(WorkModeSchema), kinuTier: v.optional(TierIdSchema), kinuTurn: v.optional(JsonObjectSchema),
});

export type SendMetadata = v.InferOutput<typeof SendMetadataSchema>;

/** A send's words, from its text, files and metadata. */
export function sentWords(text: string, files: readonly PromptFile[], metadata: SendMetadata | undefined): SentWords {
  return {
    text, files: [...files],
    ...(metadata?.kinuMode !== undefined && { mode: metadata.kinuMode }),
    ...(metadata?.kinuTier !== undefined && { tier: metadata.kinuTier }),
    ...(metadata?.kinuTurn !== undefined && { metadata: metadata.kinuTurn }),
  };
}

export type TurnDeliveryInput = Extract<DeliveryInput, { readonly kind: 'turn' }>;

/** An owner's intent, which the agent applies as it takes it. */
export type IntentInput = Extract<DeliveryInput, { readonly kind: 'decision' | 'answers' | 'retry' }>;

/** What an owner's intent did, as its agent applied it: a decision's outcome as a direct decision answered it; a Retry's
 *  turn, reopened, which tells its own end. */
export type IntentResult = { readonly kind: 'decision'; readonly outcome: PlanDecisionOutcome } | { readonly kind: 'answers' }
  | { readonly kind: 'retry'; readonly turnId: string };

/** What the agent kept of an intent it applied, read back from its own store. */
export const IntentResultSchema: v.GenericSchema<unknown, IntentResult> = v.variant('kind', [
  v.object({ kind: v.literal('decision'), outcome: PlanDecisionOutcomeSchema }),
  v.object({ kind: v.literal('answers') }),
  v.object({ kind: v.literal('retry'), turnId: v.string() }),
]);

/** An owner's intent on its way: the agent it is owed to, and what it is about (a plan, a call's questions, a turn). */
export interface OwnerIntent {
  readonly actorId: string;
  readonly id: string;
  readonly kind: IntentInput['kind'];
  readonly target: string;
}

/** An owner's intent on its way as their views show it: under its agent's id, null for the workspace's own agent. */
export interface OwedOwnerIntent extends Omit<OwnerIntent, 'actorId'> {
  readonly actor: string | null;
}

export const OwedOwnerIntentSchema = v.object({
  id: v.string(), kind: v.picklist(['decision', 'answers', 'retry']), target: v.string(), actor: v.nullable(v.string()),
});

/** An owner's intent whose crossing did not reach the agent: committed, owed to the agent's next wake, which delivers it. */
export interface OwedIntent {
  readonly owed: string;
}

export const OwedIntentSchema = v.object({ owed: v.string() });

const AuthorshipSchema = v.picklist(['owner', 'hirer']);

/** One delivery as it crosses, parsed where it lands: its id is the agent's idempotency key for it, which the agent
 *  refuses as it would a person's message id, and its authorship decides its lane. `seq` is its producer's order, which a
 *  Stop's cutoff is drawn at. */
export const DeliverySchema = v.object({ id: v.string(), input: DeliveryInputSchema, authorship: AuthorshipSchema, seq: v.number() });

export interface Delivery {
  readonly id: string;
  readonly input: DeliveryInput;
  readonly authorship: TurnAuthorship;
}

/** A delivery as its workspace holds it, owed: in the order its producer committed it. */
export interface OwedDelivery extends Delivery {
  readonly seq: number;
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

/** What a delivery's turn was admitted under: none for a run or an owner's intent, which open no turn of the chat. */
export function deliveryMetadata(delivery: Delivery): JsonObject | undefined {
  return 'metadata' in delivery.input ? delivery.input.metadata : undefined;
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
 *  words, it met words that came first and is consumed unrun; or, an owner's intent, it applied it, with what it did; or
 *  it refused it, as it is, with what it said. A refusal is an answer: the delivery is retired and its sender told. Only a
 *  crossing that does not reach the agent leaves it owed. */
export type DeliveryAnswer = 'taken' | 'duplicate' | 'yielded' | 'cancelled' | { readonly applied: IntentResult }
  | { readonly refused: { readonly code: ErrorCode; readonly message: string } };

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

/** An agent's Stop its own isolate has not yet answered: the newest's generation and the newest cutoff owed. */
export interface OwedStop {
  readonly generation: number;
  readonly cutoff: number | null;
}

export function initAgentStopsTable(execRaw: RawSqlExec): void {
  // `retired`: the newest generation the agent's isolate answered; a Stop is owed while a newer one stands.
  execRaw(`CREATE TABLE IF NOT EXISTS agent_stops (
    actor_id   TEXT PRIMARY KEY,
    generation INTEGER NOT NULL,
    retired    INTEGER NOT NULL DEFAULT 0,
    cutoff     INTEGER
  )`);
}

/**
 * The Stops a workspace owes its agents' isolates (design v3 C): each written in its Stop's own commit, crossed to the
 * agent's isolate before anything else of the agent's is driven, and retired once the isolate answers, having committed
 * the cutoff and cancelled what it had queued. A reset between the two leaves it owed, so the next activation crosses it.
 */
export class AgentStops {
  constructor(private readonly sql: SqlExecutor) {}

  /** Inside the Stop's commit. A Stop still owed is joined: one crossing at the newest of their cutoffs answers both.
   *  Answers the new generation. */
  owe(actorId: string, cutoff: number | null): number {
    const [written] = this.sql<{ generation: number }>`INSERT INTO agent_stops (actor_id, generation, cutoff)
      VALUES (${actorId}, 1, ${cutoff})
      ON CONFLICT (actor_id) DO UPDATE SET generation = agent_stops.generation + 1,
        cutoff = MAX(COALESCE(agent_stops.cutoff, excluded.cutoff), COALESCE(excluded.cutoff, agent_stops.cutoff))
      RETURNING generation`;

    if (written === undefined) return settleSync(Effect.fail(new KinuError('io', `The Stop of ${actorId} was not written.`)));

    return written.generation;
  }

  /** The agent's Stop its isolate has not answered, or null. */
  owed(actorId: string): OwedStop | null {
    return this.sql<OwedStop>`SELECT generation, cutoff FROM agent_stops WHERE actor_id = ${actorId} AND generation > retired`[0] ?? null;
  }

  /** Every Stop an isolate has not answered, by its agent, for the start that crosses them again. */
  owedEach(): (OwedStop & { readonly actorId: string })[] {
    return this.sql<OwedStop & { actorId: string }>`SELECT actor_id AS actorId, generation, cutoff FROM agent_stops WHERE generation > retired`;
  }

  /** The isolate answered the Stop of `generation`: it, and any older, is no longer owed. A newer one stays owed. */
  retire(actorId: string, generation: number): void {
    void this.sql`UPDATE agent_stops SET retired = MAX(retired, ${generation}) WHERE actor_id = ${actorId}`;
  }
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
  unpaid(actorId: string): OwedDelivery[] {
    return this.sql<{ seq: number; id: string; input_json: string; authorship: string }>`
      SELECT seq, id, input_json, authorship FROM agent_deliveries WHERE actor_id = ${actorId} ORDER BY seq ASC`
      .map((row) => ({
        seq: row.seq,
        id: row.id,
        input: v.parse(DeliveryInputSchema, JSON.parse(row.input_json)),
        authorship: v.parse(AuthorshipSchema, row.authorship),
      }));
  }

  /** Whether any delivery for the agent is unpaid: its wake stands while one is. */
  owes(actorId: string): boolean {
    return this.sql<{ seq: number }>`SELECT seq FROM agent_deliveries WHERE actor_id = ${actorId} LIMIT 1`.length > 0;
  }

  /** The owner's intents still owed, oldest first: what the owner's views show on their way. */
  ownerIntents(): OwnerIntent[] {
    return this.sql<{ actor_id: string; id: string; input_json: string }>`
      SELECT actor_id, id, input_json FROM agent_deliveries WHERE authorship = 'owner' ORDER BY seq ASC`
      .flatMap((row): OwnerIntent[] => {
        const input = v.parse(DeliveryInputSchema, JSON.parse(row.input_json));

        switch (input.kind) {
          case 'decision': return [{ actorId: row.actor_id, id: row.id, kind: input.kind, target: input.plan }];
          case 'answers': return [{ actorId: row.actor_id, id: row.id, kind: input.kind, target: input.questions }];
          case 'retry': return [{ actorId: row.actor_id, id: row.id, kind: input.kind, target: input.messageId }];
          case 'words':
          case 'turn':
          case 'run': return [];
        }
      });
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
  cancel(actorId: string): OwedDelivery[] {
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
    // One key names the delivery and its card on both sides: the turn that reads it cards it by the same key.
    const key = signal.idempotencyKey ?? nanoid();
    const cardId = signalCardId(key);
    const metadata: JsonObject = { ...turnMetadata(signal), [SIGNAL_ID_METADATA_KEY]: cardId };

    this.deps.broadcast(metadataBroadcastEvent('signal_card', metadata, { id: cardId, state: 'pending', text: signal.text }));

    const answer = await this.deps.deliver({
      id: key,
      input: {
        kind: 'turn', text: signal.text, metadata,
        ...(signal.stepText !== undefined && { stepText: signal.stepText }),
        ...(signal.opensTurn === true && { opensTurn: true }),
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
  const batch = buildDrainBatch(eventLog.pending({ resolve_deferred: { now, phase: 'idle' } }));

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
