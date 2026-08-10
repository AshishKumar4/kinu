/**
 * Signal delivery — the ONE way anything asynchronous reaches a running agent.
 *
 * There used to be two doors and no rule for choosing between them: a producer
 * either queued a programmatic turn (BackendHost.enqueueTurn — hub drains,
 * background-job wakes, overflow retries, take picks, MCP run_task) or spliced
 * a message into the live turn's next step (a private StepInjections buffer per
 * producer — the background-event injection and the delegation nudge). The
 * mechanisms are two TIMINGS of one act, so the timing is now a parameter and
 * the producer states intent only: {@link SignalDelivery.deliver}.
 *
 * Routing (synchronous, before any await — the select→bind→deliver decision a
 * producer makes against durable state must be one event-loop tick):
 *
 *   'this-turn'   turn-local steering, produced INSIDE the running turn's own
 *                 step pipeline (the delegation nudge). Always rides the next
 *                 step boundary; never queues, never survives its turn.
 *   'now'         an external wake that would rather steer the live turn than
 *                 queue behind it. Rides the next step boundary when the
 *                 backend accepts mid-turn wakes (BackendHost.acceptsMidTurnWake),
 *                 otherwise queues as a programmatic turn.
 *   'next-turn'   always a queued programmatic turn.
 *
 * Everything buffered for a step boundary drains as ONE synthetic user message
 * at the step tail (after the latest tool results, so role alternation stays
 * provider-safe), re-applied at its entry index for the rest of the turn — the
 * StepInjections coordinate math the CLI's user steer-drain shares. One buffer
 * and one splice for every signal, so no extension registration order can shift
 * another producer's recorded indices.
 *
 * The spliced message is model-visible only — never durable chat history. A
 * signal's durable record is its own (the EventLog row consumed by the batch
 * turn id, the `delegation_nudge` run event) plus the absorbing turn's reply;
 * Think's one-assistant-message-per-turn transcript cannot represent a user
 * message between steps, and persisting it after the assistant reply would read
 * as an unanswered event next turn.
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
   * Deliver a signal. The routing decision and the buffer push are synchronous
   * (only the queued path awaits), so a producer that has just bound durable
   * rows to this signal knows the answer in the same tick it bound them.
   */
  deliver(signal: AgentSignal): Promise<SignalOutcome> {
    if (!this.ridesLiveTurn(signal)) return this.queue(signal);
    this.pending.push(signal);
    if (signal.timing !== 'this-turn') {
      this.logActivity?.('signal_injected', `${signal.kind} → live turn`);
    }
    return Promise.resolve('mid-turn');
  }

  /**
   * The `prepareStep` body: absorb everything buffered into ONE user message at
   * the step tail, re-applied at its entry index on every later step. Driven by
   * the orchestrator's turn extension, which fires the turn-local producers
   * first so their signals ride the step they were decided on.
   */
  prepareStep(ctx: PrepareStepContext): ModelMessage[] | undefined {
    const drained = this.pending.splice(0);
    this.absorbed.push(...drained);
    return this.injections.drain(ctx, drained.length > 0
      ? [{ message: { role: 'user', content: drained.map(stepBody).join('\n\n') } }]
      : []);
  }

  /**
   * Turn over: report what the model absorbed and reset for the next turn.
   * Everything that did NOT reach the model re-delivers as a queued turn —
   * signals still waiting, plus (on an aborted turn, whose answer is gone)
   * the ones it had absorbed. Turn-local signals are simply dropped: their
   * turn is over, and a nudge at a turn that already ended is noise.
   *
   * Call exactly once per turn, before anything that can throw. Re-delivery is
   * detached — a turn must never block on the next one's queue slot.
   */
  settle(opts: { completed: boolean }): SettledSignals {
    const absorbed = this.absorbed;
    const leftover = this.pending.splice(0);
    const requeue = (opts.completed ? leftover : [...absorbed, ...leftover]).filter(isExternal);
    this.settled = opts.completed ? absorbed.filter(isExternal) : [];
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

  /** A turn-local signal is produced inside the running turn's own step
   *  pipeline, so there is no question of whether a turn is live; only an
   *  external wake asks the backend. */
  private ridesLiveTurn(signal: AgentSignal): boolean {
    if (signal.timing === 'next-turn') return false;
    return signal.timing === 'this-turn' || this.host.acceptsMidTurnWake();
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

/** Turn-local signals never queue and never outlive their turn. */
const isExternal = (signal: AgentSignal): boolean => signal.timing !== 'this-turn';
