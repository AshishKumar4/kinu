/**
 * An account's deletion, carried to its end by a job of its own. The person's delete marks the account and each of its
 * workspaces and is answered at once; each workspace's own job tears it down (`WorkspaceDeletionJobs`), and this one
 * clears what the account holds elsewhere once none is left. The destroy itself runs at the next alarm's start, as the
 * SDK runs its own: inside a job it would drop the table the job runner then writes. The last workspace's teardown
 * brings it due, and the account's next start arms it again if a run was cut short. Production 2026-10-23: the delete
 * ran every teardown inside its request, was cut at 30 s, and its retry failed at the Drive.
 */
import { LifecycleCapability, type LifecycleJobContext, type LifecycleJobOutcome } from 'agents/lifecycle';
import { hold, logged } from '@kinu.run/core/obs';
import { retriedUnlessRefused } from '../wake-jobs';

const ACCOUNT_DELETION_JOB = 'account-deletion';

/** The account is being deleted, and by whom: it admits nothing new (`UserLimits`), and its jobs finish it. */
export const ACCOUNT_DELETING_KEY = 'account:deleting';

export interface AccountDeletionDeps {
  /** Whether the account is marked for deletion. */
  readonly marked: () => boolean;
  /** How many of its workspaces are still there. */
  readonly workspacesLeft: () => number;
  /** What the account holds outside its own storage deleted, each step reading what is left; then marked cleared. */
  readonly clear: () => Promise<void>;
}

export class AccountDeletionJob extends LifecycleCapability {
  readonly #deps: AccountDeletionDeps;

  constructor(deps: AccountDeletionDeps) {
    super('kinu-account-deletion');
    this.#deps = deps;
  }

  /** Never awaited: its account's start may not await (`scripts/do-init-gate.ts`), and the arming logs its own failure. */
  #arming: Promise<unknown> = Promise.resolve();

  /** At its account's start: a deletion an earlier activation left unfinished is run. */
  adopt(): void {
    this.#arming = Promise.all([this.#arming, hold(logged('account.deletion_failed',
      { doing: 'arming the deletion of an account marked for it', otherwise: 'io' }, () => this.due()))]);
  }

  /** The account is marked, or a workspace of it went: its deletion runs now if nothing else is left before it. */
  async due(): Promise<void> {
    if (!this.#deps.marked() || this.#deps.workspacesLeft() > 0) return;
    await this.lifecycle.jobs.push({ id: ACCOUNT_DELETION_JOB, fn: ACCOUNT_DELETION_JOB, time: Date.now(), payload: {} });
  }

  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    if (job.fn !== ACCOUNT_DELETION_JOB || !this.#deps.marked() || this.#deps.workspacesLeft() > 0) return undefined;
    await this.#deps.clear();

    // Due again at once, which keeps an alarm armed: that alarm's start destroys the account before any job runs.
    return { rescheduleAt: Date.now() };
  }

  /** A finish that broke runs again a lap later; one refused parks until the account's next start arms it again. */
  readonly onJobError = retriedUnlessRefused('accountDeletion');
}
