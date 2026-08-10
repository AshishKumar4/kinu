/**
 * Signal delivery — the ONE way anything asynchronous reaches a running agent,
 * at the ONE time anything reaches it: its next step.
 *
 * A producer states intent and nothing else ({@link SignalDelivery.deliver}).
 * There is no timing to pick, because there is only one: the signal is spliced
 * into the live turn's next step boundary. When no turn is running there is no
 * next step, so delivery starts one (BackendHost.enqueueTurn) — that is what
 * "next step" means to an idle agent, not a second timing. The routing read is
 * synchronous, before any await, because the select→bind→deliver decision a
 * producer makes against durable state must be one event-loop tick.
 *
 * Everything buffered for a step boundary drains as ONE synthetic user message
 * at the step tail (after the latest tool results, so role alternation stays
 * provider-safe), re-applied at its entry index for the rest of the turn — the
 * StepInjections coordinate math the CLI's user steer-drain shares. One buffer
 * and one splice for every signal, so no extension registration order can shift
 * another producer's recorded indices.
 *
 * The turn's OWN steering — the delegation nudge, decided inside the step
 * pipeline from the live turn's state — is not delivered, it is handed to
 * {@link SignalDelivery.prepareStep} as the step being prepared. That is the
 * whole distinction, and it is structural rather than declared: steering
 * enters through a step, so it cannot outlive it, cannot start a turn, and
 * cannot come back after the turn is over (it is re-derived next turn if the
 * condition still holds). Nothing an asynchronous producer can reach makes
 * that choice.
 *
 * The spliced message is ephemeral, exactly like the dynamic-context block it
 * rides beside: model-visible at the tip, never durable chat history, gone on
 * a cold start. A signal's durable record is its own (the EventLog row consumed
 * by the batch turn id, the `delegation_nudge` run event) plus the absorbing
 * turn's reply; Think's one-assistant-message-per-turn transcript cannot
 * represent a user message between steps, and persisting it after the assistant
 * reply would read as an unanswered event next turn.
 */

import type { ModelMessage } from 'ai';
import type { PrepareStepContext } from '../extension.js';
import type { BackendHost } from '../types/backend-host.js';
import type {
  AgentSignal, SettledSignals, SignalDeliverer, SignalOutcome, SignalUndeliveredReason,
} from '../types/signals.js';
import { StepInjections } from '../prompting/step-injections.js';

export class SignalDelivery implements SignalDeliverer {
  private pending: AgentSignal[] = [];
  private absorbed: AgentSignal[] = [];
  /** The previous turn's absorbed signals, held one turn so a CONTINUATION
   *  (Think auto-continue / recovery — a separate queued turn) can re-absorb
   *  them: the queued path self-heals across continuations because the durable
   *  turn message rides into every one of them, and spliced signals must match
   *  — re-seen text (the prior handling is visible in the transcript) and
   *  re-dispatch (a settled reply channel no-ops). */
  private settled: AgentSignal[] = [];
  private readonly injections = new StepInjections<{ readonly message: ModelMessage }>();

  constructor(
    private readonly host: BackendHost,
    /** Human-readable activity line for a wake that steered the live turn
     *  instead of queueing behind it. */
    private readonly logActivity?: (event: string, detail?: string) => void,
  ) {}

  /**
   * Deliver a signal to the agent's next step. The read of whether a turn is
   * running and the buffer push are synchronous (only the start-a-turn path
   * awaits), so a producer that has just bound durable rows to this signal
   * knows the answer in the same tick it bound them.
   */
  deliver(signal: AgentSignal): Promise<SignalOutcome> {
    if (!this.host.turnInFlight()) return this.queue(signal);
    this.pending.push(signal);
    this.logActivity?.('signal_injected', `${signal.kind} → live turn`);
    return Promise.resolve('mid-turn');
  }

  /**
   * The `prepareStep` body: absorb everything buffered into ONE user message at
   * the step tail, re-applied at its entry index on every later step.
   *
   * `steering` is the turn's own mechanical steering for THIS step (the
   * delegation nudge), decided by the caller from the live turn's state. It
   * merges into the same message so there is still one splice per step, and it
   * is never buffered: a steer that misses its step is a steer whose moment
   * passed, and it is re-derived at the next one if the condition holds.
   */
  prepareStep(ctx: PrepareStepContext, steering: readonly AgentSignal[] = []): ModelMessage[] | undefined {
    const drained = this.pending.splice(0);
    this.absorbed.push(...drained);
    const bodies = [...drained, ...steering].map(stepBody);
    return this.injections.drain(ctx, bodies.length > 0
      ? [{ message: { role: 'user', content: bodies.join('\n\n') } }]
      : []);
  }

  /**
   * Turn over: report what the model absorbed and reset for the next turn.
   * Everything that did NOT reach the model re-delivers as its own turn —
   * signals still waiting, plus (on an aborted turn, whose answer is gone)
   * the ones it had absorbed. The turn's own steering never appears here: it
   * was handed to a step, not delivered, so it has nothing to come back to.
   *
   * Call exactly once per turn, before anything that can throw. Re-delivery is
   * detached — a turn must never block on the next one's queue slot.
   */
  settle(opts: { completed: boolean }): SettledSignals {
    const absorbed = this.absorbed;
    const leftover = this.pending.splice(0);
    const requeue = opts.completed ? leftover : [...absorbed, ...leftover];
    this.settled = opts.completed ? absorbed : [];
    this.absorbed = [];
    this.injections.reset();
    for (const signal of requeue) {
      void this.queue(signal).catch((err: unknown) =>
        console.warn(`[proteus] signal "${signal.kind}" re-delivery failed:`, err));
    }
    return { absorbed };
  }

  /** Turn start: drop splice state a dead turn may have leaked (entry indices
   *  are meaningless against the new turn's messages). A continuation turn
   *  re-queues the just-settled signals (see {@link settled}); a regular turn
   *  drops them — their turn answered. Signals still waiting ride either way. */
  beginTurn(continuation: boolean): void {
    this.absorbed = [];
    this.injections.reset();
    if (continuation) this.pending.unshift(...this.settled);
    this.settled = [];
  }

  /** Compensation runs OUTSIDE the enqueue's catch: a producer whose
   *  compensation itself fails (the background-job wake re-publishes a durable
   *  retry event, and says so by throwing) must surface that failure, not be
   *  re-entered as if the enqueue had thrown. */
  private async queue(signal: AgentSignal): Promise<SignalOutcome> {
    let reason: SignalUndeliveredReason;
    try {
      const result = await this.host.enqueueTurn({
        text: signal.text,
        metadata: {
          proteusEvent: signal.kind,
          ...(signal.replyTurnId ? { drainTurnId: signal.replyTurnId } : {}),
          ...signal.metadata,
        },
      });
      if (result.status === 'queued') return 'queued';
      reason = 'preempted';
      console.warn(`[proteus] signal "${signal.kind}" pre-empted; compensating`);
    } catch (err) {
      reason = 'failed';
      console.warn(`[proteus] signal "${signal.kind}" enqueue failed:`, (err as Error).message);
    }
    signal.compensate?.(reason);
    return 'undelivered';
  }
}

const stepBody = (signal: AgentSignal): string => signal.stepText ?? signal.text;
