// At a run's start, every eval workspace on the run's account that no live run owns and no one holds
// is deleted. Teardown lives in the process that made a workspace, so a process that dies mid-turn
// leaves its workspace behind, waking on its own schedule, until something deletes it.
import { EVAL_WORKSPACE_PREFIX } from '@kinu.run/test-utils';
import { ownerAlive } from '../../scripts/process-owner';
import { evalWorkspaceClaim } from './claims';

/** One deployment's account, as the run's identity reaches it. */
export interface SweptAccount {
  readonly origin: string;
  list(): Promise<readonly string[]>;
  remove(name: string): Promise<void>;
}

export interface EvalSweep {
  readonly deleted: readonly string[];
  /** Claimed by a process that still runs. */
  readonly owned: readonly string[];
  /** Held by a person, with the reason they gave. */
  readonly held: readonly { readonly name: string; readonly reason: string }[];
}

export async function sweepEvalWorkspaces(account: SweptAccount): Promise<EvalSweep> {
  const deleted: string[] = [];
  const owned: string[] = [];
  const held: { name: string; reason: string }[] = [];

  for (const name of await account.list()) {
    if (!name.startsWith(EVAL_WORKSPACE_PREFIX)) continue;
    const claim = evalWorkspaceClaim(account.origin, name);

    if (claim?.kind === 'held') {
      held.push({ name, reason: claim.reason });
    } else if (claim?.kind === 'owned' && ownerAlive(claim.owner)) {
      owned.push(name);
    } else {
      await account.remove(name);
      deleted.push(name);
    }
  }

  return { deleted, owned, held };
}
