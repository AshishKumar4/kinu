// At a run's start, every `eval-` workspace on the run's account that no run on any machine still marks
// live, and no one holds, is deleted. Teardown lives in the process that made a workspace, so one that
// dies mid-turn leaves its workspace behind, waking on its own schedule, until something deletes it.
// Liveness is the deployment's own: a run beats its workspace's roster mark (`beatWorkspace`), and a
// mark older than the lease belongs to a run that stopped. Holds are the reviewed held-workspaces.json.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { EVAL_WORKSPACE_PREFIX } from '@kinu.run/test-utils';
import { WORKSPACE_LEASE_MS, type RosterRow } from './session';

const HeldSchema = v.record(v.string(), v.record(v.string(), v.pipe(v.string(), v.minLength(1))));

/** The workspaces a person holds on `origin`, each with why: `evals/held-workspaces.json`, changed by review. */
export function heldWorkspaces(origin: string): ReadonlyMap<string, string> {
  const held = v.parse(HeldSchema, JSON.parse(readFileSync(join(import.meta.dirname, '../held-workspaces.json'), 'utf8')));

  return new Map(Object.entries(held[new URL(origin).origin] ?? {}));
}

/** One deployment's account, as the run's identity reaches it, and the sweeper's own clock. */
export interface SweptAccount {
  list(): Promise<readonly RosterRow[]>;
  remove(name: string): Promise<void>;
  readonly held: ReadonlyMap<string, string>;
  readonly now: number;
}

export interface EvalSweep {
  readonly deleted: readonly string[];
  /** Marked live within the lease, by a run on this machine or any other. */
  readonly live: readonly string[];
  /** Held, with the reason the file gives. */
  readonly held: readonly { readonly name: string; readonly reason: string }[];
}

export async function sweepEvalWorkspaces(account: SweptAccount): Promise<EvalSweep> {
  const deleted: string[] = [];
  const live: string[] = [];
  const held: { name: string; reason: string }[] = [];

  for (const { name, lastVisited } of await account.list()) {
    if (!name.startsWith(EVAL_WORKSPACE_PREFIX)) continue;
    const reason = account.held.get(name);

    if (reason !== undefined) {
      held.push({ name, reason });
    } else if (account.now - lastVisited < WORKSPACE_LEASE_MS) {
      live.push(name);
    } else {
      await account.remove(name);
      deleted.push(name);
    }
  }

  return { deleted, live, held };
}
