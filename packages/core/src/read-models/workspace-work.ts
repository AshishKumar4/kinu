/**
 * Every actor's work in the workspace, retired actors included (`list({ retired: true })`). Each actor is
 * read through a read-only handle fenced on row presence, not lifecycle, so retained history stays readable.
 */
import * as v from 'valibot';
import { Effect } from 'effect';
import { bindActorHandle, type ActorHandle, type ActorIdentity } from '../identity/actor-handle';
import { isSubordinateOrigin, type WorkspaceActor } from '../identity/workspace-actors';
import { AgentTaskTreeSchema, readPlanTasks, TaskListStore, type AgentTaskTree } from '../tools/task-store';
import { PlanReviewSchema, PlanReviewStore, type PlanReview } from '../plans/review';
import { tableExists } from '../identity/schema';
import type { SqlExecutor } from '../types/primitives';
import type { InspectedWork } from './work-inspection';
import type { ChangelogEntry } from '../evolution/changelog';
import type { MemoryNote } from '../memory/note';
import type { BackgroundJob } from '../types/jobs';
import type { PendingAction } from './pending-actions';


export interface WorkspaceWorkOwner {
  readonly actorId: string;
  readonly name: string;
  /** What the owner calls it: its display name, else `name`. */
  readonly title: string;
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

const OwnerSchema = v.object({ actorId: v.string(), name: v.string(), title: v.string(), retired: v.boolean(), path: v.nullable(v.array(v.string())) });

export const WorkspaceWorkSchema = v.object({
  plans: v.array(v.object({ owner: OwnerSchema, plan: PlanReviewSchema, tasks: v.array(AgentTaskTreeSchema) })),
  tasks: v.array(v.object({ owner: OwnerSchema, plan: v.null(), tasks: v.array(AgentTaskTreeSchema) })),
}) satisfies v.GenericSchema<unknown, WorkspaceWork>;

function conversationPath(row: WorkspaceActor, byId: ReadonlyMap<string, WorkspaceActor>, rootId: string): string[] | null {
  const names: string[] = [];

  for (let at: WorkspaceActor | undefined = row; at?.actorId !== rootId; at = byId.get(at.parentActorId ?? '')) {
    if (at === undefined || !isSubordinateOrigin(at.origin)) return null;
    names.unshift(at.name);
  }

  return names;
}

/** `workspace_actors` rows are never deleted, so a row read once stays present: nothing to fence. */
export function actorReadHandle(sql: SqlExecutor, row: WorkspaceActor): ActorHandle {
  const identity: ActorIdentity = {
    actorId: row.actorId,
    workspaceId: row.workspaceId,
    parentActorId: row.parentActorId,
    name: row.name,
    storageKey: row.storageKey,
  };

  return bindActorHandle(sql, identity, () => Effect.void);
}

/** `root` binds nothing; every row is read through its own actor's handle. */
export function readWorkspaceWork(
  sql: SqlExecutor,
  root: ActorHandle,
  actors: readonly WorkspaceActor[],
): WorkspaceWork {
  root.assertCurrent();
  const hasReviews = tableExists(sql, 'plan_reviews');
  const hasTasks = tableExists(sql, 'agent_tasks');
  const plans: OwnedPlan[] = [];
  const tasks: OwnedTask[] = [];
  const byId = new Map(actors.map((row) => [row.actorId, row]));

  for (const row of actors) {
    const actor = actorReadHandle(sql, row);

    const owner: WorkspaceWorkOwner = {
      actorId: row.actorId, name: row.name, title: actor.config.getDisplayName() ?? row.name,
      retired: row.retiringAt !== null || row.deletedAt !== null,
      path: conversationPath(row, byId, root.actorId),
    };

    if (hasReviews) {
      const reviews = new PlanReviewStore(sql, actor).listPage('default', { limit: 50 });

      for (const plan of reviews.items) {
        const linked = hasTasks ? readPlanTasks(sql, actor, plan) : [];

        plans.push({ owner, plan, tasks: linked });
      }
    }

    if (hasTasks) {
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
export function hasWorkspaceWork({ work, pending, jobs, changes, notes, owed }: {
  work: WorkspaceWork | null;
  pending: readonly PendingAction[];
  jobs: readonly Pick<BackgroundJob, 'id'>[];
  changes: readonly ChangelogEntry[];
  notes: readonly MemoryNote[];
  /** Turns and effects still owed, as Work → Now lists them (`inspectWork`). Only what is blocked is Work's on its
   *  own: a turn or effect that runs or waits settles by itself, and every turn's own close owes effects for a moment,
   *  which must not show Work after each turn. */
  owed: readonly Pick<InspectedWork, 'phase'>[];
}): boolean {
  return owed.some((row) => row.phase === 'blocked')
    || (work?.plans.length ?? 0) > 0
    || (work?.tasks.some((row) => row.tasks.length > 0) ?? false)
    || pending.length > 0
    || jobs.length > 0
    || changes.length > 0
    || notes.length > 0;
}

