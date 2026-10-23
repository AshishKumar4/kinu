/**
 * Mid-turn message injection bookkeeping shared by both backends.
 *
 * streamText rebuilds each step's messages from scratch, so every drained
 * injection is re-applied at its base-coordinate index (step-0 message count).
 * It lands at the tail of its step, after tool results, and keeps that index
 * for the turn so the prompt-cache prefix stays stable. One `landed` in the
 * session's history is applied only at its own step: every later step's base
 * holds it already, and applying it again sent it twice.
 */

import type { ModelMessage } from 'ai';
import type { PrepareStepContext } from '../extension';

/** `durable`: whether the entry becomes chat history on replay. A steer does, and an event its backend landed as a
 *  row (ADR C3); steering and activated skills do not. `landed`: written to the session's history, which every later
 *  step's base reads. */
export type RecordedInjection<E extends Injection> = E & { readonly index: number; readonly step: number };

interface Injection {
  readonly message: ModelMessage;
  readonly durable: boolean;
  readonly landed?: boolean;
}

export class StepInjections<E extends Injection> {
  private baseLength = 0;
  private entries: Array<RecordedInjection<E>> = [];

  get recorded(): ReadonlyArray<RecordedInjection<E>> {
    return this.entries;
  }

  drain(ctx: PrepareStepContext, incoming: ReadonlyArray<E>): ModelMessage[] | undefined {
    if (ctx.stepNumber === 0) this.baseLength = ctx.messages.length;

    for (const entry of incoming) {
      this.entries.push({ ...entry, index: ctx.messages.length, step: ctx.stepNumber });
    }

    // A landed entry stands in the base once the base has grown past it: a later step's, or this step's asked again
    // after a provider fell back.
    const inBase = (entry: RecordedInjection<E>) => entry.landed === true && ctx.messages.length > entry.index;

    if (this.entries.every(inBase)) return undefined;
    const next = [...ctx.messages];
    let offset = 0;
    // Where the base holds a landed entry, it moves only the entries whose index was taken before it landed.
    const landedAt: number[] = [];

    for (const entry of this.entries) {
      if (inBase(entry)) {
        landedAt.push(entry.index);
        continue;
      }

      const held = landedAt.filter((index) => index >= entry.index).length;
      // A tool result now standing at the pinned index answers the call before it;
      // land after the pair rather than between its halves.
      let at = entry.index + offset + held;

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
