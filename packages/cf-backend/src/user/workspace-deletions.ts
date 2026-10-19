/**
 * A workspace's deletion, carried to its end by a job of its own: marking its row pushes the job a lap ahead, the
 * teardown that lands cancels it, and one that failed or died with its activation is run again when the job comes due,
 * with no read of the account to drive it. Staging 2026-10-19: eval-office-3-dj5qhl's destroy failed at 11:13:41, its row
 * stayed marked, nothing read its account again, and the workspace woke its agent about once a minute for six hours.
 */
import * as v from 'valibot';
import { LifecycleCapability, type DurableObjectCapability, type LifecycleJobContext, type LifecycleJobOutcome } from 'agents/lifecycle';
import { RECOVERY_BACKOFF_CEILING_MS } from '@kinu.run/core';
import { CODE_IS_REFUSAL, diagnostics, hold, logged, toKinuError } from '@kinu.run/core/obs';

const DELETION_JOB = 'workspace-deletion';

const DeletionSchema = v.object({ workspace: v.string() });

export interface WorkspaceDeletionDeps {
  /** The workspaces whose rows are marked for deletion. */
  readonly marked: () => readonly string[];
  /** The account's own deletion of `workspace`. */
  readonly tearDown: (workspace: string) => Promise<void>;
}

export class WorkspaceDeletionJobs extends LifecycleCapability {
  readonly #deps: WorkspaceDeletionDeps;

  constructor(deps: WorkspaceDeletionDeps) {
    super('kinu-workspace-deletions');
    this.#deps = deps;
  }

  /** Never awaited: its account's start may not await (`scripts/do-init-gate.ts`), and each arming logs its own failure. */
  #arming: Promise<unknown> = Promise.resolve();

  /** At its account's start, each marked row holds its job: one an earlier build marked, or one a refusal parked, holds
   *  none. */
  adoptMarked(): void {
    this.#arming = Promise.all([this.#arming, ...this.#deps.marked().map(async (workspace) => await hold(logged('workspace.deletion_failed',
      { doing: 'arming the deletion of a workspace marked for it', otherwise: 'io' }, () => this.begun(workspace), { workspace })))]);
  }

  /** `workspace`'s row is marked: its deletion runs again a lap from now unless it lands first. The job's row is written
   *  before this returns, with the mark's commit; one already standing keeps its time, and a failure of its own run is
   *  answered by `onJobError`. */
  begun(workspace: string): Promise<void> {
    if (this.lifecycle.jobs.get(jobId(workspace)) !== undefined) return Promise.resolve();

    return this.lifecycle.jobs.push({ id: jobId(workspace), fn: DELETION_JOB, time: Date.now() + RECOVERY_BACKOFF_CEILING_MS, payload: { workspace } })
      .then(() => undefined);
  }

  /** `workspace`'s deletion landed. */
  async ended(workspace: string): Promise<void> {
    await this.lifecycle.jobs.cancel(jobId(workspace));
  }

  /** A deletion came due: run again, unless its row is no longer marked. */
  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    if (job.fn !== DELETION_JOB) return undefined;
    const { workspace } = v.parse(DeletionSchema, job.payload);

    if (!this.#deps.marked().includes(workspace)) return undefined;
    await this.#deps.tearDown(workspace);

    return undefined;
  }

  /**
   * A deletion that broke (its object, its box or the platform did not answer) runs again a lap later: waiting can land
   * it. One refused answers the same until something it read changes, so it parks, its row still marked, until its
   * account's next start, which a deploy brings, arms it again.
   */
  readonly onJobError: NonNullable<DurableObjectCapability['onJobError']> = ({ job }, cause) => {
    const failure = toKinuError({ doing: 'finishing a workspace deletion that has not landed', cause, otherwise: 'unavailable' });
    const parked = CODE_IS_REFUSAL[failure.code];

    diagnostics.failure('workspace.deletion_failed', failure, { job: job.id, parked });

    return parked ? undefined : { rescheduleAt: Date.now() + RECOVERY_BACKOFF_CEILING_MS };
  };
}

function jobId(workspace: string): string {
  return `${DELETION_JOB}:${workspace}`;
}
