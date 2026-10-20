/**
 * Kinu's two durable wakes, one Lifecycle job each. A job id is one row, so a resetting object can no
 * longer pile up due wakes (AGENTS.md Waste, 2026-09-21: 16, then 57, overdue rows in one alarm).
 */
import * as v from 'valibot';
import {
  LifecycleCapability, type DurableObjectCapability, type LifecycleJob, type LifecycleJobContext, type LifecycleJobOutcome,
} from 'agents/lifecycle';
import { RECOVERY_BACKOFF_CEILING_MS } from '@kinu.run/core';
import { CODE_IS_REFUSAL, diagnostics, toKinuError } from '@kinu.run/core/obs';

/** Triggers, outboxes, pending reactions: every source `nextWakeAt` folds. */
export const KINU_TIMER_JOB = 'kinu-timer';

/** A dead activation's terminal sequence and the owed work that rides it. */
export const TERMINAL_RETRY_JOB = 'terminal-retry';

export type WakeJob = typeof KINU_TIMER_JOB | typeof TERMINAL_RETRY_JOB;

/** A lap wake's streak, in its job's payload so eviction keeps the pace. */
export interface WakePace {
  readonly laps: number;
  /** Comma-joined arms last named; null outside a streak. */
  readonly arms: string | null;
}

const WakePaceSchema = v.object({ laps: v.pipe(v.number(), v.integer(), v.minValue(0)), arms: v.nullable(v.string()) });

function paceOf(job: LifecycleJob): WakePace | undefined {
  const parsed = v.safeParse(WakePaceSchema, job.payload);

  return parsed.success ? parsed.output : undefined;
}

export interface WakeHandlers {
  readonly [KINU_TIMER_JOB]: () => Promise<void>;
  readonly [TERMINAL_RETRY_JOB]: (pace: WakePace | undefined) => Promise<void>;
}

function isWakeJob(fn: string): fn is WakeJob {
  return fn === KINU_TIMER_JOB || fn === TERMINAL_RETRY_JOB;
}

/**
 * Every queue mutation writes synchronously before its first await, so an arm or a cancel is atomic
 * against every other: no in-flight bookkeeping is needed.
 */
export class WakeJobs extends LifecycleCapability {
  /** The job whose pass is running and has not re-armed it: its due row is deleted when the pass
   *  returns, so it is not an armed wake. */
  #dispatching: WakeJob | null = null;

  readonly #handlers: WakeHandlers;

  constructor(handlers: WakeHandlers) {
    super('kinu-wakes');
    this.#handlers = handlers;
  }

  /**
   * Soonest wins; an arm with no pace keeps the streak of the wake it lands on. A wake lands on a whole second,
   * the next at the earliest, as it did on the SDK's second-grained schedules: an arm for now leaves a turn's
   * own release time to take it before it fires.
   */
  async arm(id: WakeJob, atMs: number, pace?: WakePace): Promise<void> {
    const current = this.#pending(id);
    const carried = pace ?? current?.pace;
    const target = Math.max(Math.ceil(atMs / 1000), Math.floor(Date.now() / 1000) + 1) * 1000;
    const time = current !== undefined && current.time <= target ? current.time : target;

    if (current !== undefined && time === current.time && JSON.stringify(carried) === JSON.stringify(current.pace)) return;

    const pushed = this.lifecycle.jobs.push({
      id, fn: id, time, payload: carried ?? null,
      // The memory-limit breaker backs off and seals a recovery loop that keeps killing the object.
      recoveryLoop: id === TERMINAL_RETRY_JOB,
    });

    if (this.#dispatching === id) this.#dispatching = null;
    await pushed;
  }

  /** Drops `id`; a running pass that has not re-armed decides its own row. */
  async cancel(id: WakeJob): Promise<void> {
    if (this.#pending(id) !== undefined) await this.lifecycle.jobs.cancel(id);
  }

  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    const id = job.fn;

    if (!isWakeJob(id)) return undefined;
    this.#dispatching = id;

    try {
      if (id === KINU_TIMER_JOB) await this.#handlers[KINU_TIMER_JOB]();
      else await this.#handlers[TERMINAL_RETRY_JOB](paceOf(job));
    } finally {
      if (this.#dispatching === id) this.#dispatching = null;
    }

    return undefined;
  }

  /**
   * A pass that failed every retry comes back later rather than ending the chain, unless the retry wake's failure is
   * definitive: one no retry can mend (a refusal's class) parks, with the next lap its pass armed first, until an
   * activation (new code, new work) arms it again (AGENTS.md Waste, 2026-10-20). The timer wake keeps its clock: its
   * instants are its triggers', and nothing else would wake a workspace whose only visitor is its own trigger.
   */
  readonly onJobError: NonNullable<DurableObjectCapability['onJobError']> = async ({ job }, cause) => {
    const failure = toKinuError({ doing: `running the ${job.fn} wake`, cause, otherwise: 'io' });

    if (job.fn === TERMINAL_RETRY_JOB && CODE_IS_REFUSAL[failure.code]) {
      diagnostics.failure('schedule.wake_parked', failure, { job: job.fn });
      // The row by its id, whichever it is now: the pass's own next lap replaced the one that ran.
      await this.lifecycle.jobs.cancel(job.id);

      return undefined;
    }

    diagnostics.failure('schedule.wake_failed', failure, { job: job.fn });

    return { rescheduleAt: Date.now() + RECOVERY_BACKOFF_CEILING_MS };
  };

  #pending(id: WakeJob): { time: number; pace: WakePace | undefined } | undefined {
    if (this.#dispatching === id) return undefined;
    const job = this.lifecycle.jobs.get(id);

    return job === undefined ? undefined : { time: job.time, pace: paceOf(job) };
  }
}

/** A job that failed every retry comes back a lap later rather than ending: what it was for is still stored. */
export function retriedLater(doing: string): NonNullable<DurableObjectCapability['onJobError']> {
  return ({ job }, cause) => {
    diagnostics.failure('schedule.job_failed', toKinuError({ doing, cause, otherwise: 'io' }), { job: job.id });

    return { rescheduleAt: Date.now() + RECOVERY_BACKOFF_CEILING_MS };
  };
}
