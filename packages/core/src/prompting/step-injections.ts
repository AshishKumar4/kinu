/**
 * Mid-turn message injection bookkeeping (the Hermes steer-drain shape), shared
 * by both backends' step pipelines: the CLI's user steering and the cf
 * backend's background-event injection ride the same coordinate math.
 *
 * streamText rebuilds each step's messages from scratch (a prepareStep
 * override never feeds the next step's input), so every drained injection must
 * be re-applied at the position — in base-message coordinates — where it first
 * entered the conversation. Base coordinates are the step-0 message count,
 * captured before any injection is recorded, so the math holds whatever the
 * turn assembly (ledger weave, turn-local tail) appended. An injection lands
 * at the tail of the step it drains into — after the latest tool results, so
 * role alternation stays provider-safe — and stays at that index for the rest
 * of the turn, keeping the prompt-cache prefix stable across steps.
 */

import type { ModelMessage } from 'ai';
import type { PrepareStepContext } from '../extension.js';

/** A recorded injection: the caller's entry (message + any bookkeeping it
 *  carries) pinned to the base-coordinate index where the model first saw it. */
export type RecordedInjection<E extends { readonly message: ModelMessage }> =
  E & { readonly index: number };

export class StepInjections<E extends { readonly message: ModelMessage }> {
  private baseLength = 0;
  private entries: Array<RecordedInjection<E>> = [];

  /** Everything injected so far this turn, in drain order. */
  get recorded(): ReadonlyArray<RecordedInjection<E>> {
    return this.entries;
  }

  /**
   * The prepareStep body: capture base coordinates at step 0, admit `incoming`
   * at the current tail, then re-apply every recorded injection. Returns the
   * rewritten messages, or `undefined` when nothing is injected.
   */
  drain(ctx: PrepareStepContext, incoming: ReadonlyArray<E>): ModelMessage[] | undefined {
    if (ctx.stepNumber === 0) this.baseLength = ctx.messages.length;
    for (const entry of incoming) {
      this.entries.push({ ...entry, index: ctx.messages.length });
    }
    if (this.entries.length === 0) return undefined;
    const next = [...ctx.messages];
    let offset = 0;
    for (const entry of this.entries) {
      next.splice(entry.index + offset, 0, entry.message);
      offset += 1;
    }
    return next;
  }

  /**
   * Replay the recorded injections into the turn's response messages at the
   * exact positions the model saw them (base-coordinate indices sit at
   * `index - baseLength` relative to the response array) — the durable-history
   * merge for backends that persist the spliced conversation.
   */
  replayInto(responseMessages: ReadonlyArray<ModelMessage>): ModelMessage[] {
    const merged = [...responseMessages];
    let spliced = 0;
    for (const entry of this.entries) {
      const at = Math.max(0, Math.min(merged.length, entry.index - this.baseLength + spliced));
      merged.splice(at, 0, entry.message);
      spliced += 1;
    }
    return merged;
  }

  /** Drop all recorded state — a fresh turn starts clean. */
  reset(): void {
    this.entries = [];
    this.baseLength = 0;
  }
}
