/**
 * The home card's summary of one workspace. Only what waits on the owner is a decision; unseen changes
 * and auto-promoted trials are updates. A card read looks; it never launches a slate.
 */
import * as v from 'valibot';
import type { PendingAction, PendingActionKind } from './pending-actions';
import type { PendingDeviceConsent } from '../safety/device-consent';
import type { PlanReviewStatus } from '../types/plans';

const TASK_PREVIEW_MAX = 240;

const WorkspaceOverviewRunSchema = v.object({
  status: v.nullable(v.string()),
  task: v.nullable(v.string()),
});

/** Durable preview URL: outlives the process, so the picture is the live app. */
const WorkspaceOverviewSlateSchema = v.object({
  id: v.string(),
  title: v.string(),
  url: v.string(),
});

export const WorkspaceOverviewSchema = v.object({
  observedAt: v.number(),
  activity: v.picklist(['working', 'unfinished', 'idle']),
  decisionsWaiting: v.number(),
  hasUpdates: v.boolean(),
  latestRun: v.nullable(WorkspaceOverviewRunSchema),
  primarySlate: v.nullable(WorkspaceOverviewSlateSchema),
});

export type WorkspaceOverview = v.InferOutput<typeof WorkspaceOverviewSchema>;

/** `url` is null without a durable reservation; reservations are minted only by starting the app. */
export interface WorkspaceOverviewSlate {
  readonly id: string;
  readonly title: string;
  readonly url: string | null;
}

export interface WorkspaceOverviewInputs {
  readonly observedAt: number;
  readonly working: boolean;
  readonly unfinished: boolean;
  readonly pendingActions: readonly PendingAction[];
  readonly pendingConsents: readonly PendingDeviceConsent[];
  readonly activePlan: { readonly status: PlanReviewStatus } | null;
  /** A trial the engine applies itself is an update; one it cannot apply waits on the owner. */
  readonly scaffoldAutoApply: boolean;
  readonly latestRun: { readonly status: string | null; readonly task: string | null } | null;
  /** Store order; `url` is null where showing it would mean starting a process. */
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

function reservedSlate(slates: readonly WorkspaceOverviewSlate[]): WorkspaceOverview['primarySlate'] {
  for (const slate of slates) {
    if (slate.url !== null) return { id: slate.id, title: slate.title, url: slate.url };
  }

  return null;
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
    observedAt: inputs.observedAt,
    activity: activityOf(inputs.working, inputs.unfinished),
    decisionsWaiting,
    hasUpdates,

    latestRun: inputs.latestRun === null
      ? null
      : { status: inputs.latestRun.status, task: task === null ? null : task.slice(0, TASK_PREVIEW_MAX) },

    // First addressable slate; unaddressed ones are skipped so no card read boots a process.
    primarySlate: reservedSlate(inputs.slates),
  };
}

/** `needs` waits on the owner; `failed`/`unfinished` are ends and durable leftovers; `updated`/`idle` are quiet. */
export type WorkspaceStatus = 'needs' | 'working' | 'failed' | 'unfinished' | 'updated' | 'idle';

export interface WorkspaceHeadline {
  readonly label: string;
  readonly status: WorkspaceStatus;
}

/** First match wins. Working and durable leftovers outrank a failed run: a stale verdict beside live
 * work would say two things. */
export function overviewHeadline(o: WorkspaceOverview): WorkspaceHeadline {
  if (o.decisionsWaiting > 0) return { label: `Needs you · ${o.decisionsWaiting}`, status: 'needs' };

  if (o.activity === 'working') return { label: 'Working', status: 'working' };

  if (o.latestRun?.status === 'error') return { label: 'Last run failed', status: 'failed' };

  if (o.activity === 'unfinished') return { label: 'Unfinished', status: 'unfinished' };

  if (o.hasUpdates) return { label: 'Updated', status: 'updated' };

  return { label: 'Idle', status: 'idle' };
}

export interface RosterActivity {
  readonly working: boolean;
  readonly decisions: number;
}

export function rosterActivity(overviews: readonly WorkspaceOverview[]): RosterActivity {
  let working = false;
  let decisions = 0;

  for (const overview of overviews) {
    if (overview.activity === 'working') working = true;
    decisions += overview.decisionsWaiting;
  }

  return { working, decisions };
}
