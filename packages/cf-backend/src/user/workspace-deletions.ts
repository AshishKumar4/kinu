/**
 * A workspace's deletion, carried to its end by a job of its own: marking its row pushes the job a lap ahead, the
 * teardown that lands cancels it, and one that failed or died with its activation is run again when the job comes due,
 * with no read of the account to drive it. Staging 2026-10-19: eval-office-3-dj5qhl's destroy failed at 11:13:41, its row
 * stayed marked, nothing read its account again, and the workspace woke its agent about once a minute for six hours.
 */
import * as v from 'valibot';
import { LifecycleCapability, type LifecycleJobContext, type LifecycleJobOutcome } from 'agents/lifecycle';
import { RECOVERY_BACKOFF_CEILING_MS } from '@kinu.run/core';
import { hold, logged } from '@kinu.run/core/obs';
import { retriedUnlessRefused } from '../wake-jobs';

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

  /** The workspace this alarm tore down, whose own attempts it runs again (`alarmBegins`). */
  #toreDown: string | null = null;

  /**
   * Its account's alarm begins: it tears down one workspace, and the deletions due behind it wait for the next alarm,
   * which the queue arms at once. A teardown calls into the workspace, which calls back into the account, and the
   * alarm's work went on from inside that call, so each teardown in one alarm began a call deeper. Staging 0e47a6958,
   * 2026-10-24 13:43: one alarm ran 37 due deletions; three failed "Subrequest depth limit exceeded" and landed on their
   * next lap, two minutes on.
   */
  alarmBegins(): void {
    this.#toreDown = null;
  }

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

  /** `workspace`'s deletion runs now, from the account's alarm: a person's delete, answered once this returns. A job
   *  already standing, or one running, is brought to now; one running reads its row again as it ends (`applyOutcome`). */
  async dueNow(workspace: string): Promise<void> {
    await this.lifecycle.jobs.push({ id: jobId(workspace), fn: DELETION_JOB, time: Date.now(), payload: { workspace } });
  }

  /** `workspace`'s deletion landed. */
  async ended(workspace: string): Promise<void> {
    await this.lifecycle.jobs.cancel(jobId(workspace));
  }

  /** A deletion came due: run again, unless its row is no longer marked, or wait for the next alarm once this alarm
   *  has torn another down (`alarmBegins`); a failed attempt of its own is tried again, as its retry policy says. */
  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    if (job.fn !== DELETION_JOB) return undefined;
    const { workspace } = v.parse(DeletionSchema, job.payload);

    if (!this.#deps.marked().includes(workspace)) return undefined;

    if (this.#toreDown !== null && this.#toreDown !== workspace) return 'yield';
    this.#toreDown = workspace;
    await this.#deps.tearDown(workspace);

    return undefined;
  }

  /**
   * A deletion that broke (its object, its box or the platform did not answer) runs again a lap later: waiting can land
   * it. One refused answers the same until something it read changes, so it parks, its row still marked, until its
   * account's next start, which a deploy brings, arms it again.
   */
  readonly onJobError = retriedUnlessRefused('workspaceDeletion');
}

function jobId(workspace: string): string {
  return `${DELETION_JOB}:${workspace}`;
}
