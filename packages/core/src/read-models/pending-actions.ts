/**
 * The pending-action queue — everything asynchronous that is waiting on the
 * owner, in one list.
 *
 * "Needs the owner" is not a place, it is a state other objects enter: a
 * release approval, a scaffold version under trial, a command parked on
 * consent, a curriculum proposal. A background job that FAILED is not one of
 * them: the runner wakes the agent with the error (`jobs/runner.ts#wake`),
 * and fixing a red build is the agent's work. The job list shows it, with
 * Retry, for an owner who wants to look. Each already has a home, so this is a queue that
 * points at those homes — never a second place to decide, which is how a
 * duplicate rendering goes stale the moment its home evolves.
 *
 * SECURITY: this must never join `SLATE_READ_MODELS`. The same argument that
 * keeps `listPendingConsents` off that list applies with more force here — a
 * Slate that can read the needs-you queue can draw a plausible fake of it,
 * and this queue is precisely the surface an owner reads before authorising
 * something. It stays host-owned. See `slates/read-models.ts`.
 *
 * Pure: the host gathers the reads (some of which cross a DO boundary) and
 * hands them here, so what counts as "pending" and how it is worded is one
 * testable decision rather than five call sites.
 */

import type { DeferredApproval } from '../safety/deferred-approval';
import { planTitle } from '../plans/review';

export type PendingActionKind =
  | 'release_approval'
  /** A gated command the agent parked because nobody was there to decide.
   *  Unlike every other kind, its decision is made HERE — the queue is the
   *  action's only home, and deciding a night's worth in one sitting is the
   *  point. */
  | 'deferred_action'
  | 'scaffold_version'
  | 'unseen_changes'
  | 'curriculum_task'
  /** A plan revision any actor in the workspace submitted and nobody has
   *  decided. Its home is the review itself: the row deep-links to the
   *  full-tab review rather than to another surface. */
  | 'plan_review';

export interface PendingAction {
  /** Stable across polls — the underlying row's id, so a re-read does not
   *  re-key the list and re-animate it. */
  readonly id: string;
  readonly kind: PendingActionKind;
  /** One line naming the decision, in the owner's terms. */
  readonly title: string;
  /** The evidence under it, or null when the title is the whole story. */
  readonly detail: string | null;
  /** When the thing started waiting. */
  readonly at: number;
  /** The plan a `plan_review` row opens — owner name, id and revision, so the
   *  click can find the row in the workspace work read without reparsing an
   *  id the builder formatted. */
  readonly planRef?: { readonly owner: string; readonly id: string; readonly revision: number };
}

export interface PendingActionInputs {
  readonly approvals: ReadonlyArray<{
    id: string; changeId: string; approvalType: string; decision: string; createdAt: number;
  }>;
  readonly changes: ReadonlyArray<{ id: string; userPrompt: string }>;
  readonly scaffoldVersions: ReadonlyArray<{
    version: number; status: string; rationale: string; written_at: number;
  }>;
  /** Gated commands parked on the owner (safety/deferred-approval.ts). Only
   *  the still-queued ones ever reach here — a decided action has stopped
   *  needing anyone. */
  readonly deferredActions: readonly DeferredApproval[];
  /** Evolution Changelog entries the owner has not seen, and the newest one's
   *  timestamp — one queue row, because the digest is one thing to go read.
   *
   *  `revertable` is how many of them actually offer keep/revert. The digest
   *  also carries measurements (a graded turn, a replay eval, a GEPA pass),
   *  which are read and not decided — a brand-new workspace's very first
   *  unseen entry is usually one of those, so a row that says "keep or revert
   *  them" over a card with no keep and no revert is the common case, not the
   *  edge one. */
  readonly unseenChanges: { count: number; revertable: number; latestAt: number };
  readonly curriculum: ReadonlyArray<{
    id: string; task: string; status: string; proposedAt: number;
  }>;
  /** Plan revisions awaiting a decision, workspace-wide: a subordinate's
   *  pending plan asks the same owner the root's does, and the roster stays
   *  retired-inclusive for the same reason the work read's does. */
  readonly pendingPlans: ReadonlyArray<{
    owner: string; id: string; revision: number; content: string; updatedAt: number;
  }>;
}

interface ApprovalLabels {
  [approvalType: string]: string;
}

const APPROVAL_LABEL: ApprovalLabels = {
  apply: 'apply the patch',
  deploy_staging: 'deploy to staging',
  deploy_production: 'deploy to production',
  rollback: 'roll back',
};

export function buildPendingActions(input: PendingActionInputs): PendingAction[] {
  const changeTitle = new Map(input.changes.map((c) => [c.id, c.userPrompt]));
  const actions: PendingAction[] = [];

  for (const approval of input.approvals) {
    if (approval.decision !== 'pending') continue;
    actions.push({
      id: approval.id,
      kind: 'release_approval',
      title: `Approve: ${APPROVAL_LABEL[approval.approvalType] ?? approval.approvalType}`,
      detail: changeTitle.get(approval.changeId) ?? approval.changeId,
      at: approval.createdAt,
    });
  }

  for (const action of input.deferredActions) {
    if (action.status !== 'queued') continue;
    actions.push({
      id: action.id,
      kind: 'deferred_action',
      // The machine is half the decision: `rm -rf build` on the agent's own
      // sandbox never reaches this queue, so anything that does is against a
      // machine the owner should see named before they approve it.
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
