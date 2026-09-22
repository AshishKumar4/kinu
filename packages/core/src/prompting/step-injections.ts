/**
 * Mid-turn message injection bookkeeping shared by both backends.
 *
 * streamText rebuilds each step's messages from scratch, so every drained
 * injection is re-applied at its base-coordinate index (step-0 message count).
 * It lands at the tail of its step, after tool results, and keeps that index
 * for the turn so the prompt-cache prefix stays stable.
 */

import type { ModelMessage } from 'ai';
import type { PrepareStepContext } from '../extension';

/** `durable`: whether the entry becomes chat history on replay. A steer does; an event
 *  splice does not (its own row is the record; replaying it reads as an unanswered event). */
export type RecordedInjection<E extends { readonly message: ModelMessage; readonly durable: boolean }> =
  E & { readonly index: number };

export class StepInjections<E extends { readonly message: ModelMessage; readonly durable: boolean }> {
  private baseLength = 0;
  private entries: Array<RecordedInjection<E>> = [];

  get recorded(): ReadonlyArray<RecordedInjection<E>> {
    return this.entries;
  }

  drain(ctx: PrepareStepContext, incoming: ReadonlyArray<E>): ModelMessage[] | undefined {
    if (ctx.stepNumber === 0) this.baseLength = ctx.messages.length;

    for (const entry of incoming) {
      this.entries.push({ ...entry, index: ctx.messages.length });
    }

    if (this.entries.length === 0) return undefined;
    const next = [...ctx.messages];
    let offset = 0;

    for (const entry of this.entries) {
      // A tool result now standing at the pinned index answers the call before it;
      // land after the pair rather than between its halves.
      let at = entry.index + offset;

      while (next[at]?.role === 'tool') at += 1;
      next.splice(at, 0, entry.message);
      offset += 1;
    }

    return next;
  }

  /** Replay recorded injections into response messages at the positions the model saw
   *  them (`index - baseLength`). Non-durable entries are skipped and do not advance `spliced`. */
  replayInto(responseMessages: ReadonlyArray<ModelMessage>): ModelMessage[] {
    const merged = [...responseMessages];
    let spliced = 0;

    for (const entry of this.entries) {
      if (!entry.durable) continue;

      const at = Math.max(0, Math.min(merged.length, entry.index - this.baseLength + spliced));
      merged.splice(at, 0, entry.message);
      spliced += 1;
    }

    return merged;
  }

  reset(): void {
    this.entries = [];
    this.baseLength = 0;
  }
}
