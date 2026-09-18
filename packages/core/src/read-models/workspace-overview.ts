/**
 * The home card's summary of one workspace.
 *
 * The wire shape is `WorkspaceOverviewSchema`; `buildWorkspaceOverview` folds
 * the caller's own queue reads into it and `workspaceOverviewStatus` names the
 * one slot a card may speak from. Only what can actually wait on the owner —
 * a parked command, a device consent, a plan review, a scaffold trial the
 * deployment does not auto-promote — is a decision; unseen changes and
 * auto-promoted trials are updates, and a curriculum proposal is neither.
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

export const WorkspaceOverviewSchema = v.object({
  observedAt: v.number(),
  activity: v.picklist(['working', 'unfinished', 'idle']),
  decisionsWaiting: v.number(),
  hasUpdates: v.boolean(),
  latestRun: v.nullable(WorkspaceOverviewRunSchema),
});

export type WorkspaceOverview = v.InferOutput<typeof WorkspaceOverviewSchema>;

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
  };
}

/** The one slot a card may speak from, in precedence order. Text and tone are
 *  the caller's; the ordering is shared so no surface can green a run the log
 *  did not seal or outrank a waiting decision with live work. */
export type WorkspaceOverviewStatus =
  | { readonly kind: 'attention' }
  | { readonly kind: 'working' }
  | { readonly kind: 'unfinished' }
  | { readonly kind: 'run'; readonly status: string | null }
  | { readonly kind: 'idle' };

export function workspaceOverviewStatus(overview: WorkspaceOverview): WorkspaceOverviewStatus {
  if (overview.decisionsWaiting > 0) return { kind: 'attention' };

  if (overview.activity === 'working') return { kind: 'working' };

  if (overview.activity === 'unfinished') return { kind: 'unfinished' };

  if (overview.latestRun !== null) return { kind: 'run', status: overview.latestRun.status };

  return { kind: 'idle' };
}

/** What the one chip on a workspace's card says: the label, and the tone the
 *  surface resolves to a token — `accent` needs the owner, `live` is moving,
 *  `danger` is a sealed failure, `muted` is everything quiet. */
export interface WorkspaceHeadline {
  readonly label: string;
  readonly tone: 'accent' | 'live' | 'danger' | 'muted';
}

/** The single state a workspace's card states, first match wins. Where
 *  {@link workspaceOverviewStatus} names a SLOT the surface fills with its own
 *  words, the headline is the shared one-rule answer: text and tone together,
 *  so no surface orders them differently. A run only reads as failed when it
 *  can speak at all — working and durable leftovers outrank its end, because
 *  a stale verdict beside live work would say two things at once. */
export function overviewHeadline(o: WorkspaceOverview): WorkspaceHeadline {
  if (o.decisionsWaiting > 0) return { label: `Needs you · ${o.decisionsWaiting}`, tone: 'accent' };

  if (o.activity === 'working') return { label: 'Working', tone: 'live' };

  if (o.latestRun?.status === 'error') return { label: 'Last run failed', tone: 'danger' };

  if (o.activity === 'unfinished') return { label: 'Unfinished', tone: 'muted' };

  if (o.hasUpdates) return { label: 'Updated', tone: 'muted' };

  return { label: 'Idle', tone: 'muted' };
}

/** One fact a card can show beneath its lead line. `tone` is a surface-
 *  neutral word — `warning`, `accent`, `muted`, `quiet`, `success` — and the
 *  caller owns the class it maps to, same split as the status slot: core
 *  decides WHICH facts exist, the surface decides how they look. */
export interface WorkspaceOverviewFact {
  readonly key: 'decisions' | 'working' | 'unfinished' | 'updates' | 'run' | 'task' | 'empty';
  readonly text: string;
  readonly tone: 'warning' | 'accent' | 'muted' | 'quiet' | 'success';
}

/** Every fact the overview holds, in the order a card lists them: what waits
 *  on the owner, what is moving, what remains, what is unread, then how the
 *  last run sealed and what it was doing.
 *
 *  A run status is quoted verbatim: `completed` earns `success`, a run that
 *  was reported `failed` or `cancelled` warns, and anything else — an
 *  `error`, an `aborted`, a run whose end never recorded a reason — is plain
 *  text, because this row may describe but never decorate. The task preview
 *  re-applies the wire bound so a caller-built overview cannot pin one fact
 *  to a full-width line the row cannot hold.
 *  Idle is evidence of nothing: "No runs yet" is the row's content only when
 *  the list is empty, so a quiet workspace can never sit beside a word that
 *  reads as finished work — and one with unread updates still names them. */
export function workspaceOverviewEvidence(overview: WorkspaceOverview): readonly WorkspaceOverviewFact[] {
  const facts: WorkspaceOverviewFact[] = [];

  if (overview.decisionsWaiting > 0) {
    facts.push({ key: 'decisions', text: `${overview.decisionsWaiting} decisions waiting`, tone: 'warning' });
  }

  if (overview.activity === 'working') facts.push({ key: 'working', text: 'Working now', tone: 'accent' });

  if (overview.activity === 'unfinished') facts.push({ key: 'unfinished', text: 'Unfinished work', tone: 'muted' });

  if (overview.hasUpdates) facts.push({ key: 'updates', text: 'Updates to read', tone: 'muted' });

  const run = overview.latestRun;

  if (run !== null) {
    const status = run.status ?? 'unknown';

    const tone: WorkspaceOverviewFact['tone'] =
      run.status === 'completed' ? 'success'
      : run.status === 'failed' || run.status === 'cancelled' ? 'warning'
      : 'muted';

    facts.push({ key: 'run', text: `Last run: ${status}`, tone });

    if (run.task !== null && run.task !== '') {
      facts.push({ key: 'task', text: run.task.slice(0, TASK_PREVIEW_MAX), tone: 'quiet' });
    }
  }

  return facts.length === 0 ? [{ key: 'empty', text: 'No runs yet', tone: 'quiet' }] : facts;
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
