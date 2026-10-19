/**
 * A facet sets no alarm, so its workspace keeps one Lifecycle job per agent, due when the agent next owes work. The
 * agent's own answer replaces it; a wake leases it a lap ahead first, so a reset before the answer wakes it again then.
 */
import * as v from 'valibot';
import { LifecycleCapability, type LifecycleJobContext, type LifecycleJobOutcome } from 'agents/lifecycle';
import { RECOVERY_BACKOFF_CEILING_MS } from '@kinu.run/core';
import { retriedLater } from './wake-jobs';

const AGENT_WAKE_JOB = 'agent-wake';

const AgentWakePayloadSchema = v.object({ actorId: v.string() });

/** Answers told back to back differ only by the milliseconds between them. */
const SAME_LAP_MS = 1000;

function jobId(actorId: string): string {
  return `agent-wake:${actorId}`;
}

export class AgentWakes extends LifecycleCapability {
  readonly #wake: (actorId: string) => Promise<void>;

  /** Told each time an agent's wake begins or ends: that it stands is what its workspace reads it working by. */
  readonly #moved: (actorId: string) => void;

  constructor(wake: (actorId: string) => Promise<void>, moved: (actorId: string) => void) {
    super('kinu-agent-wakes');
    this.#wake = wake;
    this.#moved = moved;
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

    const stood = this.armed(actorId);

    await this.lifecycle.jobs.cancel(jobId(actorId));

    if (stood) this.#moved(actorId);
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

  /** The row is written before the push answers (`arm`): a wake that begins here stands from this call. */
  #push(actorId: string, atMs: number): Promise<void> {
    const begins = !this.armed(actorId);
    const pushed = this.lifecycle.jobs.push({ id: jobId(actorId), fn: AGENT_WAKE_JOB, time: atMs, payload: { actorId } }).then(() => undefined);

    if (begins) this.#moved(actorId);

    return pushed;
  }
}
