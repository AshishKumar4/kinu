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
import { attempt, diagnostics, KinuError, settle, toKinuError } from '@kinu.run/core/obs';
import { Effect } from 'effect';

const ADVICE_JOB = 'advisor-answer';

const AdvicePayloadSchema = v.object({ actorId: v.string() });

/** Delivers every answer the hirer holds; false when one stayed undelivered. */
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

    // Undelivered, the job fails, so the queue runs it again; the answer stays stored.
    return settle(attempt({ doing: 'delivering an advisor answer', otherwise: 'unavailable' }, () => this.#deliver(actorId)).pipe(
      Effect.flatMap((delivered) => (delivered
        ? Effect.succeed(undefined)
        : Effect.fail(new KinuError('unavailable', 'An advisor answer is still undelivered.')))),
    ));
  }

  /** A delivery that failed every retry comes back later; the answer is still stored. */
  readonly onJobError: NonNullable<DurableObjectCapability['onJobError']> = ({ job }, cause) => {
    diagnostics.failure('advisor.answer_job_failed', toKinuError({ doing: 'delivering an advisor answer', cause, otherwise: 'io' }), { job: job.id });

    return { rescheduleAt: Date.now() + RECOVERY_BACKOFF_CEILING_MS };
  };
}
