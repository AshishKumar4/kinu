/**
 * A watcher's verified deliveries, each kept by a Lifecycle job of its own until its check consumes it, so the route
 * answers once the job's row is written: GitHub counts an answer slower than 10 s as failed and never sends it again by
 * itself. A check a reset cut off runs again when its job does. The job's row goes only after the check's fire or
 * no-fire committed with the delivery's claim, so a job run again after that fires nothing.
 */
import * as v from 'valibot';
import { LifecycleCapability, type LifecycleJobContext, type LifecycleJobOutcome } from 'agents/lifecycle';
import { PendingDeliverySchema, type PendingCheck, type PendingDelivery } from '@kinu.run/core';
import { retriedUnlessRefused } from './wake-jobs';

const PENDING_DELIVERY_JOB = 'pending-delivery';

/** The queue keeps a job only with a time: a delivery whose watcher is parked waits for its resume, which runs it at
 *  once, and otherwise comes due a month on to find the watcher still parked. */
const PARKED_RECHECK_MS = 30 * 24 * 60 * 60 * 1000;

/** The jobs of `trigger`'s kept deliveries share this start. */
function jobsOf(trigger: string): string {
  return `${PENDING_DELIVERY_JOB}:${trigger}:`;
}

export class PendingDeliveries extends LifecycleCapability {
  readonly #check: (pending: PendingDelivery) => Promise<PendingCheck>;

  /** The last check of each trigger this activation began, which the next one waits for. */
  readonly #checking = new Map<string, Promise<PendingCheck>>();

  constructor(check: (pending: PendingDelivery) => Promise<PendingCheck>) {
    super('kinu-pending-deliveries');
    this.#check = check;
  }

  /** `pending` kept until its check consumes it, its job due now; false when a job keeps it already. The read and the
   *  queue's write run with no await between them, and the row is written before this answers. */
  async keep(pending: PendingDelivery): Promise<boolean> {
    const id = `${jobsOf(pending.trigger)}${pending.claim.key}`;

    if (this.lifecycle.jobs.get(id) !== undefined) return false;
    await this.lifecycle.jobs.push({ id, fn: PENDING_DELIVERY_JOB, time: Date.now(), payload: pending });

    return true;
  }

  /** `trigger`'s watcher checks again: its parked deliveries are checked now. */
  async resume(trigger: string): Promise<void> {
    const now = Date.now();

    for (const job of this.lifecycle.jobs.list()) {
      if (job.id.startsWith(jobsOf(trigger))) await this.lifecycle.jobs.reschedule(job.id, now);
    }
  }

  /** `trigger` was cancelled: its kept deliveries go with it. */
  async forget(trigger: string): Promise<void> {
    for (const job of this.lifecycle.jobs.list()) {
      if (job.id.startsWith(jobsOf(trigger))) await this.lifecycle.jobs.cancel(job.id);
    }
  }

  /**
   * One check of a trigger at a time, each to its own commit. Alarm invocations overlap (the SDK's deadman, or the
   * platform's re-fire of a long one), and run a job again while it runs: a check folded into a running one would
   * return at once, and its row would go before its claim commits.
   */
  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    if (job.fn !== PENDING_DELIVERY_JOB) return undefined;
    const pending = v.parse(PendingDeliverySchema, job.payload);
    const before = this.#checking.get(pending.trigger);

    const checked = (async () => {
      if (before !== undefined) await Promise.allSettled([before]);

      return await this.#check(pending);
    })();

    this.#checking.set(pending.trigger, checked);

    try {
      const next = await checked;

      if (next.kind === 'done') return undefined;

      return { rescheduleAt: next.kind === 'again' ? next.at : Date.now() + PARKED_RECHECK_MS };
    } finally {
      if (this.#checking.get(pending.trigger) === checked) this.#checking.delete(pending.trigger);
    }
  }

  /** A reset or the platform's own failure keeps the job for a fresh invocation, so what reaches here failed the check
   *  itself through every attempt: one no retry can mend is dropped, and any other runs again a lap later. */
  readonly onJobError = retriedUnlessRefused('pendingDelivery');
}
