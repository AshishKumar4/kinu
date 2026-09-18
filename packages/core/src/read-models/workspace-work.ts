/**
 * The workspace's work, read across every actor: each actor's plan reviews
 * with the tasks linked to that revision, and each actor's unlinked tasks.
 *
 * One read model because the surfaces that ask "what is this workspace doing"
 * ask it about the WORKSPACE, not about whoever the caller's actor happens to
 * be — a plan a hired subordinate wrote is workspace work exactly as the root's
 * is, and a retained actor's rows are still in the database for the archive to
 * read. `list({ retired: true })` is what hands the model that full roster:
 * the live-only read is the one that drops the retained actors' work without
 * saying so.
 *
 * Retired rows read under a weakened binding: `bindActorHandle` normally
 * validates the row is still live, and a retired actor's is not — which is the
 * point of the fence, but it also makes the row unreadable through any store.
 * The model binds each actor a READ-ONLY handle whose fence is the row's
 * presence alone, not its lifecycle: a handle created for reading an actor's
 * rows must not become the thing that makes a retained row's history
 * unreadable. `issue()`'s stronger fence stays on `open()` where it belongs —
 * a handle that can START the actor.
 */
import { bindActorHandle, type ActorHandle, type ActorIdentity } from '../identity/actor-handle';
import type { WorkspaceActor } from '../identity/workspace-actors';
import { readPlanTasks, TaskListStore, type AgentTaskTree } from '../tasks/store';
import { PlanReviewStore, type PlanReview } from '../plans/review';
import { tableExists } from '../identity/schema';
import { KinuError } from '../obs/error';
import type { SqlExecutor } from '../types/primitives';

export interface WorkspaceWorkOwner {
  readonly actorId: string;
  readonly name: string;
}

export interface OwnedPlan {
  readonly owner: WorkspaceWorkOwner;
  readonly plan: PlanReview;
  readonly tasks: AgentTaskTree[];
}

export interface OwnedTask {
  readonly owner: WorkspaceWorkOwner;
  readonly plan: null;
  readonly tasks: AgentTaskTree[];
}

export interface WorkspaceWork {
  readonly plans: OwnedPlan[];
  readonly tasks: OwnedTask[];
}

/** The read-only handle one actor gets inside the model: fences on the row
 *  being present in this workspace at all, never on its lifecycle — reading a
 *  retained row must not require it to still be live. `bindActorHandle` runs
 *  the fence at bind AND before every store access, so a row that disappears
 *  mid-read still stops authorising; it just no longer throws on the states a
 *  retained dismissal legitimately sits in. */
function readHandle(sql: SqlExecutor, row: WorkspaceActor): ActorHandle {
  const identity: ActorIdentity = {
    actorId: row.actorId,
    workspaceId: row.workspaceId,
    parentActorId: row.parentActorId,
    name: row.name,
    storageKey: row.storageKey,
  };

  return bindActorHandle(sql, identity, () => {
    // Presence only, asked fresh on every store access: a retired or released
    // row still reads — the row's physical deletion is the only thing that
    // stops its history mid-read.
    const present = sql<{ x: number }>`SELECT 1 AS x FROM workspace_actors WHERE actor_id = ${row.actorId} LIMIT 1`.length > 0;

    if (!present) throw new KinuError('missing', `The actor ${row.name} is no longer in this workspace.`);
  });
}

/**
 * Read every actor's work in this workspace. `root` binds nothing — it is the
 * actor the caller's authority flows through, held only so the model's caller
 * names who asked; every row is read through the `actors` rows' own handles.
 */
export function readWorkspaceWork(
  sql: SqlExecutor,
  root: ActorHandle,
  actors: readonly WorkspaceActor[],
): WorkspaceWork {
  root.assertCurrent();
  const plans: OwnedPlan[] = [];
  const tasks: OwnedTask[] = [];

  for (const row of actors) {
    const actor = readHandle(sql, row);
    const owner: WorkspaceWorkOwner = { actorId: row.actorId, name: row.name };

    if (tableExists(sql, 'plan_reviews')) {
      const reviews = new PlanReviewStore(sql, actor).listPage('default', { limit: 50 });

      for (const plan of reviews.items) {
        const linked = tableExists(sql, 'plan_task_links') ? readPlanTasks(sql, actor, plan) : [];

        plans.push({ owner, plan, tasks: linked });
      }
    }

    if (tableExists(sql, 'agent_tasks')) {
      const all = new TaskListStore(sql, actor, (write) => write()).list();

      // A task is linked to a plan revision through plan_task_links; the
      // unlinked remainder is this actor's own list.
      const unlinked = tableExists(sql, 'plan_task_links')
        ? all.filter((tree) => sql<{ x: number }>`SELECT 1 AS x FROM plan_task_links WHERE actor_id = ${row.actorId} AND task_id = ${tree.id} LIMIT 1`.length === 0)
        : all;

      if (unlinked.length > 0) tasks.push({ owner, plan: null, tasks: unlinked });
    }
  }

  return { plans, tasks };
}

