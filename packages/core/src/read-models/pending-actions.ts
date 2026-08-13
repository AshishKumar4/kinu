/**
 * The pending-action queue — everything asynchronous that is waiting on the
 * owner, in one list.
 *
 * "Needs the owner" is not a place, it is a state other objects enter: a
 * release approval, a scaffold version under trial, a job that failed, a
 * curriculum proposal. Each already has a home, so this is a queue that
 * points at those homes — never a second place to decide, which is how a
 * duplicate rendering goes stale the moment its home evolves.
 *
 * SECURITY: this must never join `VIEW_DATA_SOURCES`. The same argument that
 * keeps `listPendingConsents` off that list applies with more force here — a
 * view that can draw the needs-you queue can draw a plausible fake of it, and
 * this queue is precisely the surface an owner reads before authorising
 * something. It stays host-owned and boring. See `views/sources.ts`.
 *
 * Pure: the host gathers the reads (some of which cross a DO boundary) and
 * hands them here, so what counts as "pending" and how it is worded is one
 * testable decision rather than five call sites.
 */

import type { BackgroundJob } from '../jobs/store.js';
import type { DeferredApproval } from '../safety/deferred-approval.js';

export type PendingActionKind =
  | 'release_approval'
  /** A gated command the agent parked because nobody was there to decide.
   *  Unlike every other kind, its decision is made HERE — the queue is the
   *  action's only home, and deciding a night's worth in one sitting is the
   *  point. */
  | 'deferred_action'
  | 'scaffold_version'
  | 'failed_job'
  | 'unseen_changes'
  | 'curriculum_task';

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
  readonly jobs: readonly BackgroundJob[];
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
}

const APPROVAL_LABEL: Record<string, string> = {
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
      title: 'Approve: a command the agent is waiting on',
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

  for (const job of input.jobs) {
    if (job.status !== 'failed') continue;
    actions.push({
      id: job.id,
      kind: 'failed_job',
      title: `${job.kind} failed`,
      detail: job.error ?? job.label,
      at: job.settledAt ?? job.createdAt,
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

  return actions.sort((a, b) => b.at - a.at);
}
