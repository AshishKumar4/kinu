/**
 * A facet sets no alarm, so its workspace keeps one Lifecycle job per agent, due when the agent next owes work. The
 * agent's own answer replaces it; a wake leases it a lap ahead first, so a reset before the answer wakes it again then.
 */
import * as v from 'valibot';
import { LifecycleCapability, type LifecycleJobContext, type LifecycleJobOutcome } from 'agents/lifecycle';
import { RECOVERY_BACKOFF_CEILING_MS } from '@kinu.run/core';
import { retriedLater } from './advice-jobs';

const AGENT_WAKE_JOB = 'agent-wake';

const AgentWakePayloadSchema = v.object({ actorId: v.string() });

/** Answers told back to back differ only by the milliseconds between them. */
const SAME_LAP_MS = 1000;

function jobId(actorId: string): string {
  return `agent-wake:${actorId}`;
}

export class AgentWakes extends LifecycleCapability {
  readonly #wake: (actorId: string) => Promise<void>;

  constructor(wake: (actorId: string) => Promise<void>) {
    super('kinu-agent-wakes');
    this.#wake = wake;
  }

  /**
   * Soonest wins. The wake's row, its durable intent, is written before this returns, with whatever commit its caller is
   * in: the SDK's queue writes synchronously and only then projects the alarm from its rows, which the answered promise
   * settles. A write the queue refuses fails that promise and leaves no intent: a start reconciles from what is owed.
   */
  arm(actorId: string, atMs: number): Promise<void> {
    const current = this.lifecycle.jobs.get(jobId(actorId));

    if (current !== undefined && current.time <= atMs) return Promise.resolve();

    return this.#push(actorId, atMs);
  }

  /** The alarm projected again from every intent the queue holds: a start sets the one a death kept from being set. */
  async project(): Promise<void> {
    await this.lifecycle.jobs.rearm();
  }

  /**
   * The agent's answer: the instant it next owes work, or none. An answer less than a second after the armed instant is
   * the same lap told again: it writes nothing, and the wake comes at most that second early, to an agent that answers
   * again.
   */
  async owes(actorId: string, next: number | null): Promise<void> {
    if (next !== null) {
      const current = this.lifecycle.jobs.get(jobId(actorId));

      if (current !== undefined && current.time <= next && next - current.time < SAME_LAP_MS) return;

      return await this.#push(actorId, next);
    }

    await this.lifecycle.jobs.cancel(jobId(actorId));
  }

  /** Whether the agent may still owe work: an agent at rest has told its workspace it owes none. */
  armed(actorId: string): boolean {
    return this.lifecycle.jobs.get(jobId(actorId)) !== undefined;
  }

  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    if (job.fn !== AGENT_WAKE_JOB) return undefined;
    const { actorId } = v.parse(AgentWakePayloadSchema, job.payload);

    await this.#push(actorId, Date.now() + RECOVERY_BACKOFF_CEILING_MS);
    await this.#wake(actorId);

    return undefined;
  }

  readonly onJobError = retriedLater("waking an agent's own isolate for what it owes");

  #push(actorId: string, atMs: number): Promise<void> {
    return this.lifecycle.jobs.push({ id: jobId(actorId), fn: AGENT_WAKE_JOB, time: atMs, payload: { actorId } }).then(() => undefined);
  }
}
