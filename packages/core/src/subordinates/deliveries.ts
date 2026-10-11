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
import { metadataBroadcastEvent } from '../read-models/background-event';
import type { BroadcastEvent } from '../types/backend-host';
import { SIGNAL_ID_METADATA_KEY, type AgentInbox, type AgentSignal, type SendOutcome } from '../types/signals';
import { MISSION_LABELS_METADATA_KEY } from '../mission-budget';
import { nanoid } from '../utils/nanoid';
import { Effect } from 'effect';
import { KinuError, settleSync, type ErrorCode } from '../obs/index';
import { TierIdSchema } from '../types/profile';
import { WorkModeSchema } from '../types/turn';
import type { TurnAuthorship } from '../orchestrator/turn-authorship';

/** What a delivery asks of its agent. */
const DeliveryInputSchema = v.variant('kind', [
  /** A person's words: a send, or a card the workspace says in their place. */
  v.object({
    kind: v.literal('words'), text: v.string(), files: v.optional(v.array(PromptFileSchema)), mode: v.optional(WorkModeSchema),
    tier: v.optional(TierIdSchema), metadata: v.optional(JsonObjectSchema),
  }),
  /** A turn of the agent's own, opened by what happened: an event, an assignment, a report, an advisor's note. */
  v.object({
    kind: v.literal('turn'), text: v.string(), metadata: v.optional(JsonObjectSchema), yieldsToUserMessage: v.optional(v.boolean()),
  }),
]);

export type DeliveryInput = v.InferOutput<typeof DeliveryInputSchema>;

const AuthorshipSchema = v.picklist(['owner', 'hirer']);

/** One delivery as it crosses, parsed where it lands: its id is the agent's idempotency key for it, which the agent
 *  refuses as it would a person's message id, and its authorship decides its lane. */
export const DeliverySchema = v.object({ id: v.string(), input: DeliveryInputSchema, authorship: AuthorshipSchema });

export interface Delivery {
  readonly id: string;
  readonly input: DeliveryInput;
  readonly authorship: TurnAuthorship;
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
      input: { kind: 'turn', text: signal.text, metadata, ...(signal.yieldsToUserMessage === true && { yieldsToUserMessage: true }) },
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

  return { id: turnId, input: { kind: 'turn', text: batch.text, metadata }, authorship: 'hirer' };
}
