/**
 * An eval run's workspaces, torn down by their account once the run stops marking them live. Teardown otherwise lives
 * in the process that made a workspace, so a run that dies leaves it running: staging 2026-10-16, a coding trial's run
 * died at 22:14 and left its job streaming on its devbox, the box and the workspace awake, until the next run took
 * its slot at 05:11. Each mark of an `eval-` workspace on an eval account moves that workspace's one Lifecycle job to
 * the mark plus the lease (core `EVAL_WORKSPACE_LEASE_MS`); a job that comes due finds the run gone and tears the
 * workspace down through the account's own deletion, which stops its jobs and destroys its devbox. A workspace
 * deleted any other way takes its job with it, so nothing is armed once no eval workspace holds a lease.
 */
import * as v from 'valibot';
import { LifecycleCapability, type LifecycleJobContext, type LifecycleJobOutcome } from 'agents/lifecycle';
import { EVAL_WORKSPACE_LEASE_MS, EVAL_WORKSPACE_PREFIX } from '@kinu.run/core';
import { retriedLater } from '../wake-jobs';

const EVAL_LEASE_JOB = 'eval-lease';

const LeaseSchema = v.object({ workspace: v.string() });

export interface EvalLeaseDeps {
  /** Whether this account is one of the deployment's eval accounts, whose `eval-` workspaces runs lease. */
  readonly evalAccount: () => boolean;
  /** `workspace`'s last mark, or null once it is gone or being torn down. */
  readonly markOf: (workspace: string) => number | null;
  /** The account's own deletion of `workspace`. */
  readonly tearDown: (workspace: string) => Promise<void>;
}

export class EvalLeaseJobs extends LifecycleCapability {
  readonly #deps: EvalLeaseDeps;

  constructor(deps: EvalLeaseDeps) {
    super('kinu-eval-leases');
    this.#deps = deps;
  }

  /** `workspace` was marked live at `at`: its lease, if it holds one, now ends a lease later. */
  async marked(workspace: string, at: number): Promise<void> {
    if (!workspace.startsWith(EVAL_WORKSPACE_PREFIX) || !this.#deps.evalAccount()) return;
    await this.lifecycle.jobs.push({ id: jobId(workspace), fn: EVAL_LEASE_JOB, time: at + EVAL_WORKSPACE_LEASE_MS, payload: { workspace } });
  }

  /** `workspace` is gone: it holds no lease. */
  async ended(workspace: string): Promise<void> {
    await this.lifecycle.jobs.cancel(jobId(workspace));
  }

  /** A lease came due: torn down unless a mark landed since, which leases it on from that mark. */
  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    if (job.fn !== EVAL_LEASE_JOB) return undefined;
    const { workspace } = v.parse(LeaseSchema, job.payload);
    const mark = this.#deps.markOf(workspace);

    if (mark === null) return undefined;

    if (mark + EVAL_WORKSPACE_LEASE_MS > Date.now()) return { rescheduleAt: mark + EVAL_WORKSPACE_LEASE_MS };
    await this.#deps.tearDown(workspace);

    return undefined;
  }

  /** A teardown that failed leaves its row marked for deletion; it is tried again a lap later. */
  readonly onJobError = retriedLater('tearing down an eval workspace whose run stopped');
}

function jobId(workspace: string): string {
  return `${EVAL_LEASE_JOB}:${workspace}`;
}
