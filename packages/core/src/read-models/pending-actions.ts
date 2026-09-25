/**
 * Everything waiting on the owner, as rows pointing at each item's home; never a second place to decide.
 * Security: must never join `SLATE_READ_MODELS`: a Slate could draw a fake of this queue (`slates/read-models.ts`).
 */

import type { DeferredApproval } from '../safety/deferred-approval';
import type { PendingConsent } from '../protocol';
import type { PlanReview } from '../types/plans';
import { planTitle } from '../plans/review';

export type PendingActionKind =
  /** Decided here: the queue is this action's only home. */
  | 'deferred_action'
  | 'scaffold_version'
  | 'unseen_changes'
  | 'curriculum_task'
  /** Deep-links to the full-tab review. */
  | 'plan_review';

export interface PendingAction {
  /** The underlying row's id, so a re-read does not re-key and re-animate the list. */
  readonly id: string;
  readonly kind: PendingActionKind;
  readonly title: string;
  readonly detail: string | null;
  readonly at: number;
  /** Lets the click find the row in the work read without reparsing a formatted id. */
  readonly planRef?: { readonly owner: string; readonly id: string; readonly revision: number };
}

/** What a workspace asks of the person now. */
export interface PersonAsks {
  readonly pendingActions: readonly PendingAction[];
  readonly pendingConsents: readonly PendingConsent[];
  readonly activePlan: PlanReview | null;
}

/** Rows holding the person's work until they decide; the agent's own proposals and notes do not (#21). */
const HOLDS_THE_PERSON = {
  deferred_action: true,
  plan_review: true,
  scaffold_version: false,
  curriculum_task: false,
  unseen_changes: false,
} satisfies Record<PendingActionKind, boolean>;

/** What the inspector opens for on its own: an action or a consent to approve, or a plan to review. */
export function needsTheUser(asks: PersonAsks): boolean {
  return asks.pendingActions.some((action) => HOLDS_THE_PERSON[action.kind])
    || asks.pendingConsents.length > 0
    || asks.activePlan?.status === 'pending';
}

export interface PendingActionInputs {
  readonly scaffoldVersions: ReadonlyArray<{
    version: number; status: string; rationale: string; written_at: number;
  }>;
  /** Still-queued only (safety/deferred-approval.ts). */
  readonly deferredActions: readonly DeferredApproval[];
  /** `revertable` counts entries offering keep/revert; measurement entries are read, not decided. */
  readonly unseenChanges: { count: number; revertable: number; latestAt: number };
  readonly curriculum: ReadonlyArray<{
    id: string; task: string; status: string; proposedAt: number;
  }>;
  /** Workspace-wide and retired-inclusive: a subordinate's plan asks the same owner. */
  readonly pendingPlans: ReadonlyArray<{
    owner: string; id: string; revision: number; content: string; updatedAt: number;
  }>;
}

export function buildPendingActions(input: PendingActionInputs): PendingAction[] {
  const actions: PendingAction[] = [];

  for (const action of input.deferredActions) {
    if (action.status !== 'queued') continue;
    actions.push({
      id: action.id,
      kind: 'deferred_action',
      // Name the machine: commands against the agent's own sandbox never reach this queue.
      title: `Approve: a command the agent wants to run on ${action.executor}`,
      detail: action.command,
      at: action.requestedAt,
    });
  }

  for (const version of input.scaffoldVersions) {
    if (version.status !== 'pending') continue;
    actions.push({
      id: `scaffold-v${version.version}`,
      kind: 'scaffold_version',
      title: `Scaffold v${version.version} is waiting to be promoted or rolled back`,
      detail: version.rationale || null,
      at: version.written_at,
    });
  }

  const { count: unseenCount, revertable } = input.unseenChanges;

  if (unseenCount > 0) {
    actions.push({
      id: 'unseen-changes',
      kind: 'unseen_changes',
      title: `${unseenCount} self-change${unseenCount === 1 ? '' : 's'} you have not seen`,
      detail: revertable > 0
        ? `Keep or revert ${revertable === unseenCount ? 'them' : `${revertable} of them`} in the journal below.`
        : 'Read them in the journal below.',
      at: input.unseenChanges.latestAt,
    });
  }

  for (const task of input.curriculum) {
    if (task.status !== 'pending') continue;
    actions.push({
      id: task.id,
      kind: 'curriculum_task',
      title: 'The agent proposed a task for itself',
      detail: task.task,
      at: task.proposedAt,
    });
  }

  for (const plan of input.pendingPlans) {
    actions.push({
      id: `plan:${plan.owner}:${plan.id}:${plan.revision}`,
      kind: 'plan_review',
      title: `Approve the plan · ${planTitle(plan.content)}`,
      detail: plan.owner === 'main' ? null : `Submitted by ${plan.owner}`,
      at: plan.updatedAt,
      planRef: { owner: plan.owner, id: plan.id, revision: plan.revision },
    });
  }

  return actions.sort((a, b) => b.at - a.at);
}
