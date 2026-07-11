/**
 * Mid-turn background-event injection — the live-turn half of the reactor's
 * delivery ("injected mid turn if a turn is active", debounced upstream by the
 * DrainScheduler). The backend's `injectIntoActiveTurn` buffers a drained
 * batch here; a `prepareStep` extension on the turn's ExtensionHost splices
 * everything buffered into the next agentic step as one synthetic user message
 * (the StepInjections coordinate math the CLI steer-drain shares); `settle`
 * hands back whatever never saw a step boundary so the backend re-enqueues it
 * as the standard programmatic drain turn.
 *
 * The spliced message is model-visible only — never durable chat history. The
 * events' durable record is the EventLog (consumed_by = the batch turn id) and
 * the absorbing turn's own response; Think's one-assistant-message-per-turn
 * transcript cannot represent a user message between steps, and persisting it
 * after the assistant reply would read as an unanswered event next turn.
 */

import type { ModelMessage } from 'ai';
import type { PrepareStepContext } from '../extension.js';
import type { MidTurnEventBatch } from '../types/backend-host.js';
import { StepInjections } from '../prompting/step-injections.js';

export interface SettledInjections {
  /** Batch turn ids the turn actually absorbed (the model saw them) — the
   *  backend dispatches the turn's answer to their reply channels. */
  readonly absorbed: string[];
  /** Batches that never reached a step boundary (the model was already
   *  finishing) — re-enqueue each as a programmatic drain turn. */
  readonly leftover: MidTurnEventBatch[];
}

export class EventInjectionBuffer {
  private pending: MidTurnEventBatch[] = [];
  private absorbed: string[] = [];
  private readonly injections = new StepInjections<{ readonly message: ModelMessage }>();

  /** Buffer a drained batch for the live turn's next step boundary. */
  push(batch: MidTurnEventBatch): void {
    this.pending.push(batch);
  }

  /** The `prepareStep` extension body: absorb everything buffered into ONE
   *  user message at the step tail (after the latest tool results, so role
   *  alternation stays provider-safe), re-applied at its entry index on every
   *  later step. */
  prepareStep(ctx: PrepareStepContext): ModelMessage[] | undefined {
    const drained = this.pending.splice(0);
    if (drained.length > 0) this.absorbed.push(...drained.map((batch) => batch.turnId));
    return this.injections.drain(ctx, drained.length > 0
      ? [{ message: { role: 'user', content: drained.map((batch) => batch.stepText).join('\n\n') } }]
      : []);
  }

  /** Turn over: report what was absorbed vs left waiting, and reset for the
   *  next turn. Call exactly once per turn, before anything that can throw. */
  settle(): SettledInjections {
    const result = { absorbed: this.absorbed, leftover: this.pending.splice(0) };
    this.absorbed = [];
    this.injections.reset();
    return result;
  }

  /** Turn start: drop splice state a dead turn may have leaked (a turn that
   *  never reached its response hook leaves entry indices that are meaningless
   *  against the new turn's messages — and absorbed ids whose answer never
   *  came). Buffered batches stay: the new turn absorbs them at its first
   *  step boundary. */
  beginTurn(): void {
    this.absorbed = [];
    this.injections.reset();
  }
}
