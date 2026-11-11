/**
 * The owner's imports into their account's memory, carried to their end by one job: each run reads one piece of the
 * oldest import on the account's fast tier and comes due again at once while any is left, so a deploy's reset loses at
 * most the piece it was reading, which the next run reads again. Its account's start brings it due again
 * (`adopt`), as a workspace's deletion does (`workspace-deletions.ts`).
 */
import { LifecycleCapability, type LifecycleJobContext, type LifecycleJobOutcome } from 'agents/lifecycle';
import { RECOVERY_BACKOFF_CEILING_MS } from '@kinu.run/core';
import { hold, logged } from '@kinu.run/core/obs';
import { retriedLater } from '../wake-jobs';

const IMPORT_JOB = 'account-import';

/** What a run did: read a piece with more left, read the last, or failed in a way a wait may mend. */
export type ImportRun = 'more' | 'done' | 'later';

export interface AccountImportDeps {
  /** Whether an import has a piece left to read. */
  readonly owed: () => boolean;
  /** Reads the next piece of the oldest import. */
  readonly readNext: () => Promise<ImportRun>;
}

export class AccountImportJobs extends LifecycleCapability {
  readonly #deps: AccountImportDeps;

  constructor(deps: AccountImportDeps) {
    super('kinu-account-imports');
    this.#deps = deps;
  }

  /** Never awaited: its account's start may not await (`scripts/do-init-gate.ts`); the arming logs its own failure. */
  #arming: Promise<unknown> = Promise.resolve();

  /** At its account's start, an import an earlier activation was reading comes due. */
  adopt(): void {
    if (!this.#deps.owed()) return;
    this.#arming = Promise.all([this.#arming, hold(logged('memory.import_failed', { doing: 'arming an account memory import', otherwise: 'io' }, () => this.due()))]);
  }

  /** An import was started or retried: the job runs now, or keeps the time it already stands at. */
  async due(): Promise<void> {
    await this.lifecycle.jobs.push({ id: IMPORT_JOB, fn: IMPORT_JOB, time: Date.now(), payload: {} });
  }

  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    if (job.fn !== IMPORT_JOB) return undefined;
    const run = await this.#deps.readNext();

    if (run === 'later') return { rescheduleAt: Date.now() + RECOVERY_BACKOFF_CEILING_MS };

    return run === 'more' ? { rescheduleAt: Date.now() } : undefined;
  }

  readonly onJobError = retriedLater('reading an account memory import');
}
