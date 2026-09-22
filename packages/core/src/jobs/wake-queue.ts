/**
 * In-process `AgentInbox` for agents with no durable message table (swarm nodes): wakes queue in memory and
 * arrive on the loop's next step, as the same message text an actor's `Inbox` would deliver.
 */

import type { ModelMessage } from 'ai';
import type { AgentSignal, AgentInbox, SendOutcome } from '../types/signals';

export class AgentWakeQueue implements AgentInbox {
  private readonly arrived: AgentSignal[] = [];
  /** The turn blocked in {@link next}, if any; at most one, since an agent takes one turn at a time. */
  private resume: (() => void) | null = null;

  async send(signal: AgentSignal): Promise<SendOutcome> {
    this.arrived.push(signal);
    const waiting = this.resume;
    this.resume = null;
    waiting?.();

    // Always 'queued': a step-loop agent has no channel into the request in flight. A queued signal never calls
    // the compensation callback.
    return 'queued';
  }

  /**
   * Messages for the next turn, or `null` when nothing is coming and the run is over. `holding` is asked only
   * after the queue drains. No timer by design: an agent awaiting a wake is healthy however long it waits.
   */
  async next(holding: () => boolean): Promise<readonly ModelMessage[] | null> {
    for (;;) {
      const wakes = this.drain();

      if (wakes.length > 0) return wakes;

      if (!holding()) return null;
      // Synchronous from the drain to here, so a wake cannot land in the gap and find no awaiter.
      await new Promise<void>((settle) => { this.resume = settle; });
    }
  }

  private drain(): ModelMessage[] {
    const wakes = this.arrived.map((signal): ModelMessage => ({ role: 'user', content: signal.text }));
    this.arrived.length = 0;

    return wakes;
  }
}
