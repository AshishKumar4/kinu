/**
 * Every actor's work in the workspace, retired actors included (`list({ retired: true })`). Each actor is
 * read through a read-only handle fenced on row presence, not lifecycle, so retained history stays readable.
 */
import { bindActorHandle, type ActorHandle, type ActorIdentity } from '../identity/actor-handle';
import type { WorkspaceActor } from '../identity/workspace-actors';
import { readPlanTasks, TaskListStore, type AgentTaskTree } from '../tools/task-store';
import { PlanReviewStore, type PlanReview } from '../plans/review';
import { tableExists } from '../identity/schema';
import { KinuError } from '../obs/error';
import type { SqlExecutor } from '../types/primitives';
import type { ChangelogEntry } from '../evolution/changelog';
import type { MemoryNote } from '../memory/note';
import type { BackgroundJob } from '../types/jobs';
import type { PendingAction } from './pending-actions';


export interface WorkspaceWorkOwner {
  readonly actorId: string;
  readonly name: string;
  /** Retiring or released: history stays, but presents as retained, not live. */
  readonly retired: boolean;
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

/** Fences on the row's presence, never its lifecycle; the fence runs at bind and before every store access. */
export function actorReadHandle(sql: SqlExecutor, row: WorkspaceActor): ActorHandle {
  const identity: ActorIdentity = {
    actorId: row.actorId,
    workspaceId: row.workspaceId,
    parentActorId: row.parentActorId,
    name: row.name,
    storageKey: row.storageKey,
  };

  return bindActorHandle(sql, identity, () => {
    const present = sql<{ x: number }>`SELECT 1 AS x FROM workspace_actors WHERE actor_id = ${row.actorId} LIMIT 1`.length > 0;

    if (!present) throw new KinuError('missing', `The actor ${row.name} is no longer in this workspace.`);
  });
}

/** `root` binds nothing; every row is read through its own actor's handle. */
export function readWorkspaceWork(
  sql: SqlExecutor,
  root: ActorHandle,
  actors: readonly WorkspaceActor[],
): WorkspaceWork {
  root.assertCurrent();
  const plans: OwnedPlan[] = [];
  const tasks: OwnedTask[] = [];

  for (const row of actors) {
    const actor = actorReadHandle(sql, row);
    const owner: WorkspaceWorkOwner = { actorId: row.actorId, name: row.name, retired: row.retiringAt !== null || row.deletedAt !== null };

    if (tableExists(sql, 'plan_reviews')) {
      const reviews = new PlanReviewStore(sql, actor).listPage('default', { limit: 50 });

      for (const plan of reviews.items) {
        const linked = tableExists(sql, 'plan_task_links') ? readPlanTasks(sql, actor, plan) : [];

        plans.push({ owner, plan, tasks: linked });
      }
    }

    if (tableExists(sql, 'agent_tasks')) {
      const all = new TaskListStore(sql, actor, (write) => write()).list();

      const unlinked = tableExists(sql, 'plan_task_links')
        ? all.filter((tree) => sql<{ x: number }>`SELECT 1 AS x FROM plan_task_links WHERE actor_id = ${row.actorId} AND task_id = ${tree.id} LIMIT 1`.length === 0)
        : all;

      if (unlinked.length > 0) tasks.push({ owner, plan: null, tasks: unlinked });
    }
  }

  plans.sort((a, b) => b.plan.createdAt - a.plan.createdAt || b.plan.revision - a.plan.revision);

  return { plans, tasks };
}

/** Settled jobs count (the record is the content); a live turn with nothing renderable does not. */
export function hasWorkspaceWork({ work, pending, jobs, changes, notes }: {
  work: WorkspaceWork | null;
  pending: readonly PendingAction[];
  jobs: readonly Pick<BackgroundJob, 'id'>[];
  changes: readonly ChangelogEntry[];
  notes: readonly MemoryNote[];
}): boolean {
  return (work?.plans.length ?? 0) > 0
    || (work?.tasks.some((row) => row.tasks.length > 0) ?? false)
    || pending.length > 0
    || jobs.length > 0
    || changes.length > 0
    || notes.length > 0;
}

