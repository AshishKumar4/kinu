/**
 * An advisor's answer, delivered from a Lifecycle job. The ingress stores the answer and queues this job in
 * one transaction, and the job forgets the answer once its note is delivered, so a death anywhere between
 * them re-delivers on the next alarm and the note's turn key keeps it to one.
 */
import * as v from 'valibot';
import {
  LifecycleCapability, type DurableObjectCapability, type LifecycleJobContext, type LifecycleJobOutcome,
} from 'agents/lifecycle';
import { RECOVERY_BACKOFF_CEILING_MS } from '@kinu.run/core';
import { diagnostics, toKinuError } from '@kinu.run/core/obs';

const ADVICE_JOB = 'advisor-answer';

const AdvicePayloadSchema = v.object({ actorId: v.string() });

/** Delivers every answer the hirer holds; false while one is still held (handed to its turn, or kept after a failure). */
export type DeliverAdvice = (actorId: string) => Promise<boolean>;

export class AdviceJobs extends LifecycleCapability {
  readonly #deliver: DeliverAdvice;

  constructor(deliver: DeliverAdvice) {
    super('kinu-advice');
    this.#deliver = deliver;
  }

  /** Writes its row before its first await, so it lands inside the caller's transaction; one job per hirer, due now.
   *  The promise is the alarm's re-arm. */
  async owe(actorId: string): Promise<void> {
    await this.lifecycle.jobs.push({ id: `advice:${actorId}`, fn: ADVICE_JOB, time: Date.now(), payload: { actorId } });
  }

  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    if (job.fn !== ADVICE_JOB) return undefined;
    const { actorId } = v.parse(AdvicePayloadSchema, job.payload);

    // Never waits on the turn a note opens: the alarm would hold across its inference. An answer still held brings
    // the job back at the ceiling, a backstop for a death before its turn said it.
    const settled = await this.#deliver(actorId);

    return settled ? undefined : { rescheduleAt: Date.now() + RECOVERY_BACKOFF_CEILING_MS };
  }

  /** A delivery that failed every retry comes back later; the answer is still stored. */
  readonly onJobError: NonNullable<DurableObjectCapability['onJobError']> = ({ job }, cause) => {
    diagnostics.failure('advisor.answer_job_failed', toKinuError({ doing: 'delivering an advisor answer', cause, otherwise: 'io' }), { job: job.id });

    return { rescheduleAt: Date.now() + RECOVERY_BACKOFF_CEILING_MS };
  };
}
