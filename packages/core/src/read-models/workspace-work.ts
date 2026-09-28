/**
 * Every actor's work in the workspace, retired actors included (`list({ retired: true })`). Each actor is
 * read through a read-only handle fenced on row presence, not lifecycle, so retained history stays readable.
 */
import * as v from 'valibot';
import { bindActorHandle, type ActorHandle, type ActorIdentity } from '../identity/actor-handle';
import type { WorkspaceActor } from '../identity/workspace-actors';
import { AgentTaskTreeSchema, readPlanTasks, TaskListStore, type AgentTaskTree } from '../tools/task-store';
import { PlanReviewSchema, PlanReviewStore, type PlanReview } from '../plans/review';
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
  /** Retiring or released: shown as retained, not live. */
  readonly retired: boolean;
  /** For `inspectSubordinate`; null: none. */
  readonly path: readonly string[] | null;
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

const OwnerSchema = v.object({ actorId: v.string(), name: v.string(), retired: v.boolean(), path: v.nullable(v.array(v.string())) });

export const WorkspaceWorkSchema = v.object({
  plans: v.array(v.object({ owner: OwnerSchema, plan: PlanReviewSchema, tasks: v.array(AgentTaskTreeSchema) })),
  tasks: v.array(v.object({ owner: OwnerSchema, plan: v.null(), tasks: v.array(AgentTaskTreeSchema) })),
}) satisfies v.GenericSchema<unknown, WorkspaceWork>;

function conversationPath(row: WorkspaceActor, byId: ReadonlyMap<string, WorkspaceActor>, rootId: string): string[] | null {
  const names: string[] = [];

  for (let at: WorkspaceActor | undefined = row; at?.actorId !== rootId; at = byId.get(at.parentActorId ?? '')) {
    if (at === undefined || at.kind !== 'subordinate') return null;
    names.unshift(at.name);
  }

  return names;
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
  const byId = new Map(actors.map((row) => [row.actorId, row]));

  for (const row of actors) {
    const actor = actorReadHandle(sql, row);

    const owner: WorkspaceWorkOwner = {
      actorId: row.actorId, name: row.name, retired: row.retiringAt !== null || row.deletedAt !== null,
      path: conversationPath(row, byId, root.actorId),
    };

    if (tableExists(sql, 'plan_reviews')) {
      const reviews = new PlanReviewStore(sql, actor).listPage('default', { limit: 50 });

      for (const plan of reviews.items) {
        const linked = tableExists(sql, 'agent_tasks') ? readPlanTasks(sql, actor, plan) : [];

        plans.push({ owner, plan, tasks: linked });
      }
    }

    if (tableExists(sql, 'agent_tasks')) {
      const store = new TaskListStore(sql, actor, (write) => write());
      const linkedIds = store.linkedIds();
      const unlinked = store.list().filter((tree) => !linkedIds.has(tree.id));

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

