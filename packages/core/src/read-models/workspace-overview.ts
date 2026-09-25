/**
 * The roster's summary of one workspace, folded by the workspace from its own stores and pushed to its
 * owner's object when it changes. Only what waits on the owner is a decision; unseen changes and
 * auto-promoted trials are updates.
 */
import * as v from 'valibot';
import type { PendingAction, PendingActionKind } from './pending-actions';
import type { PendingDeviceConsent } from '../safety/device-consent';
import type { PlanReviewStatus } from '../types/plans';
import { workspaceDisplayTitle } from './workspace-title';

const TASK_PREVIEW_MAX = 240;

const WorkspaceOverviewRunSchema = v.object({
  status: v.nullable(v.string()),
  task: v.nullable(v.string()),
});

/** `picture` is the digest of the slate's latest capture, null until its first. */
const WorkspaceOverviewSlateSchema = v.object({
  id: v.string(),
  title: v.string(),
  picture: v.nullable(v.string()),
});

export const WorkspaceOverviewSchema = v.object({
  activity: v.picklist(['working', 'unfinished', 'idle']),
  decisionsWaiting: v.number(),
  hasUpdates: v.boolean(),
  latestRun: v.nullable(WorkspaceOverviewRunSchema),
  slates: v.array(WorkspaceOverviewSlateSchema),
});

export type WorkspaceOverview = v.InferOutput<typeof WorkspaceOverviewSchema>;

export type WorkspaceOverviewSlate = v.InferOutput<typeof WorkspaceOverviewSlateSchema>;

export interface WorkspaceOverviewInputs {
  readonly working: boolean;
  readonly unfinished: boolean;
  readonly pendingActions: readonly PendingAction[];
  readonly pendingConsents: readonly PendingDeviceConsent[];
  readonly activePlan: { readonly status: PlanReviewStatus } | null;
  /** A trial the engine applies itself is an update; one it cannot apply waits on the owner. */
  readonly scaffoldAutoApply: boolean;
  readonly latestRun: { readonly status: string | null; readonly task: string | null } | null;
  readonly slates: readonly WorkspaceOverviewSlate[];
}

type QueueEffect = 'decision' | 'update' | 'ignore';

function pendingActionEffect(kind: PendingActionKind, scaffoldAutoApply: boolean): QueueEffect {
  switch (kind) {
    case 'release_approval':
    case 'deferred_action':
      return 'decision';
    case 'unseen_changes':
      return 'update';
    case 'scaffold_version':
      return scaffoldAutoApply ? 'update' : 'decision';
    case 'curriculum_task':
      return 'ignore';
    case 'plan_review':
      return 'decision';
  }
}

function activityOf(working: boolean, unfinished: boolean): WorkspaceOverview['activity'] {
  if (working) return 'working';

  if (unfinished) return 'unfinished';

  return 'idle';
}

export function buildWorkspaceOverview(inputs: WorkspaceOverviewInputs): WorkspaceOverview {
  let decisionsWaiting = inputs.pendingConsents.length + (inputs.activePlan?.status === 'pending' ? 1 : 0);
  let hasUpdates = false;

  for (const action of inputs.pendingActions) {
    const effect = pendingActionEffect(action.kind, inputs.scaffoldAutoApply);

    if (effect === 'decision') decisionsWaiting += 1;

    if (effect === 'update') hasUpdates = true;
  }

  const task = inputs.latestRun?.task ?? null;

  return {
    activity: activityOf(inputs.working, inputs.unfinished),
    decisionsWaiting,
    hasUpdates,

    latestRun: inputs.latestRun === null
      ? null
      : { status: inputs.latestRun.status, task: task === null ? null : task.slice(0, TASK_PREVIEW_MAX) },

    slates: [...inputs.slates],
  };
}

/** `unreported`: no tile yet, never idle. */
export type RosterBucket = 'needs' | 'working' | 'idle' | 'unreported';

export function rosterBucket(activity: WorkspaceOverview['activity'] | null, decisions: number): RosterBucket {
  if (decisions > 0) return 'needs';

  if (activity === null) return 'unreported';

  return activity === 'working' ? 'working' : 'idle';
}

export function rosterMatches(entry: { readonly name: string; readonly displayName: string }, query: string): boolean {
  const needle = query.trim().toLowerCase();

  return needle === '' || workspaceDisplayTitle(entry).toLowerCase().includes(needle) || entry.name.toLowerCase().includes(needle);
}

/** `needs` waits on the owner; `failed`/`unfinished` are ends and durable leftovers; `updated`/`idle` are quiet. */
export type WorkspaceStatus = 'needs' | 'working' | 'failed' | 'unfinished' | 'updated' | 'idle' | 'unreported';

export interface WorkspaceHeadline {
  readonly label: string;
  readonly status: WorkspaceStatus;
}

function needsYou(decisions: number): WorkspaceHeadline {
  return { label: `Needs you · ${String(decisions)}`, status: 'needs' };
}

/** With no tile, only the owner's approvals are known. */
export function rosterHeadline(overview: WorkspaceOverview | null, decisions: number): WorkspaceHeadline {
  if (overview !== null) return overviewHeadline(overview);

  return decisions > 0 ? needsYou(decisions) : { label: 'Not yet reported', status: 'unreported' };
}

/** First match wins. Working and durable leftovers outrank a failed run: a stale verdict beside live
 * work would say two things. */
function overviewHeadline(o: WorkspaceOverview): WorkspaceHeadline {
  const bucket = rosterBucket(o.activity, o.decisionsWaiting);

  if (bucket === 'needs') return needsYou(o.decisionsWaiting);

  if (bucket === 'working') return { label: 'Working', status: 'working' };

  if (o.latestRun?.status === 'error') return { label: 'Last run failed', status: 'failed' };

  if (o.activity === 'unfinished') return { label: 'Unfinished', status: 'unfinished' };

  if (o.hasUpdates) return { label: 'Updated', status: 'updated' };

  return { label: 'Idle', status: 'idle' };
}
