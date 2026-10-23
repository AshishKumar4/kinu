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

    if (!this.entries.some((entry) => entry.landed !== true || entry.step === ctx.stepNumber)) return undefined;
    const next = [...ctx.messages];
    let offset = 0;
    // A landed entry of an earlier step stands in the base already: it moves only what its own step recorded after it,
    // whose index was taken before it landed; a later step's index counts it.
    const landedBefore = new Map<number, number>();

    for (const entry of this.entries) {
      const held = landedBefore.get(entry.step) ?? 0;

      if (entry.landed === true && entry.step < ctx.stepNumber) {
        landedBefore.set(entry.step, held + 1);
        continue;
      }

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
