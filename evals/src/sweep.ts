// At a run's start, every `eval-` workspace on the run's account that no run on any machine still marks
// live is deleted. The account itself tears such a workspace down once its mark is a lease old (its `EvalLeaseJobs`);
// this catches what no mark leased, a workspace older than that rule. Liveness is the deployment's own: a run beats its
// workspace's roster mark (`beatWorkspace`), and a mark older than the lease belongs to a run that stopped. A delete the
// deployment fails is reported, not thrown: a workspace left behind does not change what the run measures, and on
// 2026-10-01 one failed delete cancelled every trial of the task that met it.
import { EVAL_WORKSPACE_LEASE_MS, EVAL_WORKSPACE_PREFIX } from '@kinu.run/core';
import { renderThrownChain } from '@kinu.run/core/obs';
import type { RosterRow } from './workspace-roster';

/** One deployment's account, as the run's identity reaches it, and the sweeper's own clock. */
export interface SweptAccount {
  list(): Promise<readonly RosterRow[]>;
  remove(name: string): Promise<void>;
  readonly now: number;
}

export interface EvalSweep {
  readonly deleted: readonly string[];
  /** Marked live within the lease, by a run on this machine or any other. */
  readonly live: readonly string[];
  /** Due for deletion, and the deployment would not delete it: why, as it answered. */
  readonly failed: readonly { readonly name: string; readonly reason: string }[];
}

export async function sweepEvalWorkspaces(account: SweptAccount): Promise<EvalSweep> {
  const deleted: string[] = [];
  const live: string[] = [];
  const failed: { name: string; reason: string }[] = [];

  for (const { name, lastVisited } of await account.list()) {
    if (!name.startsWith(EVAL_WORKSPACE_PREFIX)) continue;

    if (account.now - lastVisited < EVAL_WORKSPACE_LEASE_MS) {
      live.push(name);
    } else {
      try {
        await account.remove(name);
        deleted.push(name);
      } catch (error) {
        failed.push({ name, reason: renderThrownChain({ cause: error }) });
      }
    }
  }

  return { deleted, live, failed };
}
