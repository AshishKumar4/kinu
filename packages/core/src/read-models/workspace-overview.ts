/**
 * The home card's summary of one workspace.
 *
 * The wire shape is `WorkspaceOverviewSchema`; `buildWorkspaceOverview` folds
 * the caller's own queue reads into it and `workspaceOverviewStatus` names the
 * one slot a card may speak from. Only what can actually wait on the owner —
 * a parked command, a device consent, a plan review, a scaffold trial the
 * deployment does not auto-promote — is a decision; unseen changes and
 * auto-promoted trials are updates, and a curriculum proposal is neither.
 *
 * `primarySlate` is the one slate a tile can draw: the first the caller's
 * store already holds an address for. A slate whose URL exists only after
 * something starts is not one — a card read looks, it never launches.
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

/** The slate a tile draws: its durable preview URL, which outlives the
 *  process behind it, so the picture is the live app and not a capture. */
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

/** One slate as the store answers it for a card read: `url` is the address
 *  its durable reservation already holds, and `null` where there is none to
 *  read — a reservation is minted by the act that starts the app, never by
 *  looking at it. */
export interface WorkspaceOverviewSlate {
  readonly id: string;
  readonly title: string;
  readonly url: string | null;
}

export interface WorkspaceOverviewInputs {
  readonly observedAt: number;
  /** A live turn on this actor or a hosted child. */
  readonly working: boolean;
  /** Durable unfinished work — owed turns, recovery, parked effects. */
  readonly unfinished: boolean;
  readonly pendingActions: readonly PendingAction[];
  readonly pendingConsents: readonly PendingDeviceConsent[];
  readonly activePlan: { readonly status: PlanReviewStatus } | null;
  /** auto_promote_scaffold: a pending trial the engine applies itself is an
   *  update to read; one it cannot apply waits on the owner. */
  readonly scaffoldAutoApply: boolean;
  readonly latestRun: { readonly status: string | null; readonly task: string | null } | null;
  /** The workspace's slates in the order the store lists them, each with the
   *  URL its held reservation already answers — `null` where showing it would
   *  mean starting a process, which a card read never does. */
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
    activity: inputs.working ? 'working' : inputs.unfinished ? 'unfinished' : 'idle',
    decisionsWaiting,
    hasUpdates,

    latestRun: inputs.latestRun === null
      ? null
      : { status: inputs.latestRun.status, task: task === null ? null : task.slice(0, TASK_PREVIEW_MAX) },

    // The tile's picture is the FIRST slate the store can already address:
    // the order is the store's, and a slate whose URL would have to be minted
    // is skipped rather than waited for, so no card read boots a process.
    primarySlate: reservedSlate(inputs.slates),
  };
}

/** What the one chip on a workspace's card says: the label, and the status
 *  the surface resolves to its tone classes — `needs` waits on the owner,
 *  `working` is moving, `failed` and `unfinished` are ends and durable
 *  leftovers, `updated` and `idle` are everything quiet. */
export type WorkspaceStatus = 'needs' | 'working' | 'failed' | 'unfinished' | 'updated' | 'idle';

export interface WorkspaceHeadline {
  readonly label: string;
  readonly status: WorkspaceStatus;
}

/** The single state a workspace's card states, first match wins: text and
 *  status together, one rule, so no surface orders them differently. A run only reads as failed when it
 *  can speak at all — working and durable leftovers outrank its end, because
 *  a stale verdict beside live work would say two things at once. */
export function overviewHeadline(o: WorkspaceOverview): WorkspaceHeadline {
  if (o.decisionsWaiting > 0) return { label: `Needs you · ${o.decisionsWaiting}`, status: 'needs' };

  if (o.activity === 'working') return { label: 'Working', status: 'working' };

  if (o.latestRun?.status === 'error') return { label: 'Last run failed', status: 'failed' };

  if (o.activity === 'unfinished') return { label: 'Unfinished', status: 'unfinished' };

  if (o.hasUpdates) return { label: 'Updated', status: 'updated' };

  return { label: 'Idle', status: 'idle' };
}

/** What the workspaces a shell watches add up to: whether any turn is live,
 *  and how many decisions wait on the owner across them. The shell's living
 *  background reads this and nothing else — a workspace's own card still
 *  speaks for itself. */
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
