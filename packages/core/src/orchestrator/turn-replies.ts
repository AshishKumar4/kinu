/**
 * A slate's `agent.ask` reply: the assistant text of the turn its message lands in, from the moment it lands, as the
 * model writes it. The chat transcript stays the one record; this is only its live view, held in memory, so an
 * eviction or a dropped socket ends it and the stored answer stands.
 *
 * The message lands where its signal card is shown: at the start of the turn it opened, or at the step boundary a live
 * turn takes it in. From then on the turn's text deltas feed it, and the turn's end closes it: cleanly when it
 * finished, with its reason when it was stopped or failed.
 */
import * as v from 'valibot';
import type { BroadcastEvent } from '../types/backend-host';

interface Reply {
  readonly controller: ReadableStreamDefaultController<Uint8Array>;
  closed: boolean;
}

/** A card that moved past pending: the moments a message lands, or is let go. */
const MovedCardSchema = v.object({ type: v.literal('signal_card'), id: v.string(), state: v.picklist(['shown', 'undelivered']) });

const encoder = new TextEncoder();

export class TurnReplies {
  /** By the card of the message asked, until the message lands. */
  readonly #waiting = new Map<string, Reply>();

  /** By the turn each landed in. */
  readonly #landed = new Map<string, Set<Reply>>();

  /** The reply to the message whose card is `cardId`, as UTF-8 bytes; its reader cancelling it lets it go. */
  open(cardId: string): ReadableStream<Uint8Array> {
    let reply: Reply | null = null;

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        reply = { controller, closed: false };
        this.#waiting.set(cardId, reply);
      },
      cancel: () => { if (reply !== null) this.#forget(reply); },
    });

    return stream;
  }

  /**
   * A broadcast from the inbox. A signal card shown means the message landed in `turnId`; undelivered, that no turn
   * will answer it, which the inbox says of every message it does not land, whatever its send then answers.
   */
  card(event: BroadcastEvent, turnId: string | null): void {
    const moved = v.safeParse(MovedCardSchema, event);

    if (!moved.success) return;
    const reply = this.#waiting.get(moved.output.id);

    if (reply === undefined) return;
    this.#waiting.delete(moved.output.id);

    if (moved.output.state === 'undelivered' || turnId === null) {
      this.#close(reply, 'The message was not delivered to the agent, so no turn answers it');

      return;
    }

    const landed = this.#landed.get(turnId) ?? new Set();
    landed.add(reply);
    this.#landed.set(turnId, landed);
  }

  /** A text delta of `turnId`'s answer. */
  feed(turnId: string, delta: string): void {
    for (const reply of this.#landed.get(turnId) ?? []) reply.controller.enqueue(encoder.encode(delta));
  }

  /** `turnId` ended; `failure` is why, when it did not finish (a Stop included). Its first word is kept. */
  ended(turnId: string, failure: string | null): void {
    const landed = this.#landed.get(turnId);

    if (landed === undefined) return;
    this.#landed.delete(turnId);

    for (const reply of landed) this.#close(reply, failure);
  }

  #close(reply: Reply, failure: string | null): void {
    if (reply.closed) return;
    reply.closed = true;

    if (failure === null) reply.controller.close();
    else reply.controller.error(new Error(failure));
  }

  #forget(reply: Reply): void {
    reply.closed = true;

    for (const [card, waiting] of this.#waiting) if (waiting === reply) this.#waiting.delete(card);

    for (const landed of this.#landed.values()) landed.delete(reply);
  }
}
