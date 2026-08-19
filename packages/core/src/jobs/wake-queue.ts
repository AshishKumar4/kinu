/**
 * The IN-PROCESS wake queue — what makes an agent with no durable message table
 * a place a background wake can ARRIVE.
 *
 * {@link BackgroundJobRunner} ends every settled job by handing a signal to a
 * `SignalDeliverer`, and there is exactly ONE delivery time: the agent's next
 * step. For an actor that seam is `SignalDelivery`, which either splices the
 * signal into the turn in flight or enqueues a durable message row that becomes
 * the next turn. A swarm node has neither — no chat, no message table, no socket
 * a surface can watch — so it implements the SAME seam over an in-memory queue,
 * and its "next step" is the next iteration of its own loop.
 *
 * That is the whole of the mechanism difference, and it is why the runner needs
 * no branch for it: the runner never states a delivery time, never picks a
 * mechanism, and cannot tell the two apart. Everything else — the detach
 * threshold, the concurrency cap, the job row, the settle, the announcement's
 * idempotency — is the code an actor already runs.
 *
 * WHY A WAKE IS A MESSAGE. The actor's delivery ends in a durable user-role
 * message carrying the signal's text, which becomes the next turn's last
 * message. This returns the same message for the same text, so a woken node
 * reads exactly what a woken actor reads, from one wording maintained in one
 * place (`BackgroundJobRunner.wake`).
 */

import type { ModelMessage } from 'ai';
import type { AgentSignal, SignalDeliverer, SignalOutcome } from '../types/signals';

export class AgentWakeQueue implements SignalDeliverer {
  /** Wakes that have arrived and not yet been handed to a turn. */
  private readonly arrived: AgentSignal[] = [];
  /** The turn currently blocked in {@link next}, if any. At most one: an agent
   *  takes one turn at a time, so there is never a second awaiter to fan out to. */
  private resume: (() => void) | null = null;

  async deliver(signal: AgentSignal): Promise<SignalOutcome> {
    this.arrived.push(signal);
    const waiting = this.resume;
    this.resume = null;
    waiting?.();
    // 'queued', never 'mid-turn': this seam hands work to the NEXT turn, because
    // an agent driven by a step loop has no channel into the request already in
    // flight. Nothing downstream branches on it — the runner reads the outcome
    // only to decide whether to compensate, and a queued signal never is.
    return 'queued';
  }

  /**
   * The messages the NEXT turn runs on, or `null` when this agent has nothing
   * coming and its run is therefore over.
   *
   * `holding` answers "is there still work whose result I have not seen" — for a
   * node, how many background jobs its own runner is driving. It is asked only
   * after the queue is found empty, and asked again after every wake, so an agent
   * that backgrounded three jobs takes three turns and then ends.
   *
   * There is no timer here and there must not be: an agent awaiting a wake is
   * HEALTHY however long it waits, and a clock that cannot tell that from an agent
   * that never started is the wrong instrument by construction. What bounds the
   * work is the thing that actually blocks — a step where nothing flows — and that
   * is bounded from inside the turn by the shared loop's stall watchdog.
   */
  async next(holding: () => boolean): Promise<readonly ModelMessage[] | null> {
    for (;;) {
      const wakes = this.drain();
      if (wakes.length > 0) return wakes;
      if (!holding()) return null;
      // Nothing runs between the drain above and this executor — one synchronous
      // stretch on one thread — so a wake cannot land in the gap and find no
      // awaiter to release.
      await new Promise<void>((settle) => { this.resume = settle; });
    }
  }

  private drain(): ModelMessage[] {
    const wakes = this.arrived.map((signal): ModelMessage => ({ role: 'user', content: signal.text }));
    this.arrived.length = 0;
    return wakes;
  }
}
