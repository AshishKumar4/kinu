/**
 * The needs-you queue.
 *
 * Two claims are worth pinning. First, what counts as pending: a release
 * approval awaiting a decision used to badge NOTHING while a running job —
 * which needs no one — carried a number, so the one thing blocking the agent
 * on its owner was invisible from the tab strip. Second, the containment: this
 * queue must never become a data source an agent-authored view can read, or a
 * view could draw a convincing fake of the surface an owner reads right before
 * authorising a deploy.
 */

import { describe, test, expect } from 'bun:test';
import { buildPendingActions, type PendingActionInputs } from '../src/read-models/pending-actions';
import { SLATE_READ_MODELS } from '../src/slates/read-models';
import type { BackgroundJob } from '../src/jobs/store';
import type { DeferredApproval } from '../src/safety/deferred-approval';

function job(over: Partial<BackgroundJob>): BackgroundJob {
  return {
    id: 'bgjob-1', kind: 'run', label: 'bun test', workMode: 'build', status: 'completed',
    result: null, error: null, createdAt: 1000, settledAt: 1100, epoch: 0, resumeAttempts: 0,
    retriedBy: null,
    attemptStartedAt: 1000, resumeAfter: null,
    ...over,
  };
}

const EMPTY: PendingActionInputs = {
  approvals: [], changes: [], scaffoldVersions: [], jobs: [], deferredActions: [],
  unseenChanges: { count: 0, revertable: 0, latestAt: 0 }, curriculum: [],
};

function parked(over: Partial<DeferredApproval> = {}): DeferredApproval {
  return {
    id: 'defer-1', command: 'sudo systemctl restart nginx', executor: 'laptop',
    reason: 'Approval review: gate',
    status: 'queued', requestedAt: 2000, decidedAt: null, ...over,
  };
}

describe('buildPendingActions', () => {
  test('nothing waiting is an empty queue', () => {
    expect(buildPendingActions(EMPTY)).toEqual([]);
  });

  test('a pending release approval is named by the change it authorises', () => {
    const [action] = buildPendingActions({
      ...EMPTY,
      approvals: [{ id: 'apr_1', changeId: 'chg_4f2', approvalType: 'deploy_production', decision: 'pending', createdAt: 5000 }],
      changes: [{ id: 'chg_4f2', userPrompt: 'Warm up the empty-state copy' }],
    });
    expect(action).toEqual({
      id: 'apr_1',
      kind: 'release_approval',
      title: 'Approve: deploy to production',
      detail: 'Warm up the empty-state copy',
      at: 5000,
    });
  });

  test('a decided approval has stopped needing anyone', () => {
    expect(buildPendingActions({
      ...EMPTY,
      approvals: [
        { id: 'a1', changeId: 'c1', approvalType: 'apply', decision: 'approved', createdAt: 1 },
        { id: 'a2', changeId: 'c1', approvalType: 'apply', decision: 'rejected', createdAt: 2 },
      ],
    })).toEqual([]);
  });

  test('a scaffold version under trial is a decision, not a status', () => {
    const [action] = buildPendingActions({
      ...EMPTY,
      scaffoldVersions: [
        { version: 8, status: 'pending', rationale: 'shorter tool preamble', written_at: 9000 },
        { version: 7, status: 'current', rationale: 'the live one', written_at: 8000 },
      ],
    });
    expect(action).toMatchObject({
      id: 'scaffold-v8', kind: 'scaffold_version', detail: 'shorter tool preamble', at: 9000,
    });
    expect(action!.title).toContain('v8');
  });

  test('a failed job queues with its reason; a running one does not queue at all', () => {
    const actions = buildPendingActions({
      ...EMPTY,
      jobs: [
        job({ id: 'bgjob-run', status: 'running', settledAt: null }),
        job({ id: 'bgjob-ok', status: 'completed' }),
        job({ id: 'bgjob-bad', status: 'failed', error: 'exit 1 — binding VECTORIZE not found', settledAt: 7000 }),
      ],
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      id: 'bgjob-bad', kind: 'failed_job', detail: 'exit 1 — binding VECTORIZE not found', at: 7000,
    });
  });

  test('unseen self-changes are ONE row that points at the digest, not N rows', () => {
    const actions = buildPendingActions({
      ...EMPTY, unseenChanges: { count: 3, revertable: 3, latestAt: 6000 },
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]!.kind).toBe('unseen_changes');
    expect(actions[0]!.title).toBe('3 self-changes you have not seen');
    expect(actions[0]!.detail).toBe('Keep or revert them in the journal below.');
  });

  test('one unseen change is singular', () => {
    const [action] = buildPendingActions({
      ...EMPTY, unseenChanges: { count: 1, revertable: 1, latestAt: 1 },
    });
    expect(action!.title).toBe('1 self-change you have not seen');
  });

  // The row a brand-new workspace gets after its very first turn: the digest's
  // first entry is a graded turn, which is a measurement with no keep and no
  // revert. Promising a decision over a card that offers none is the same lie
  // as pointing at the wrong tab.
  test('an unseen window of pure measurements is offered as a read, not a decision', () => {
    const [action] = buildPendingActions({
      ...EMPTY, unseenChanges: { count: 1, revertable: 0, latestAt: 1 },
    });
    expect(action!.detail).toBe('Read them in the journal below.');
  });

  test('a mixed window says how many of them can actually be decided', () => {
    const [action] = buildPendingActions({
      ...EMPTY, unseenChanges: { count: 4, revertable: 1, latestAt: 1 },
    });
    expect(action!.detail).toBe('Keep or revert 1 of them in the journal below.');
  });

  test('only pending curriculum proposals are the owner\'s call', () => {
    const actions = buildPendingActions({
      ...EMPTY,
      curriculum: [
        { id: 'cur_1', task: 'Learn the coupon schema', status: 'pending', proposedAt: 4000 },
        { id: 'cur_2', task: 'Already accepted', status: 'accepted', proposedAt: 4500 },
      ],
    });
    expect(actions.map((a) => a.id)).toEqual(['cur_1']);
  });

  test('a command the agent parked on the owner is a needs-you row', () => {
    const [action] = buildPendingActions({ ...EMPTY, deferredActions: [parked()] });
    expect(action).toEqual({
      id: 'defer-1',
      kind: 'deferred_action',
      title: 'Approve: a command the agent wants to run on laptop',
      detail: 'sudo systemctl restart nginx',
      at: 2000,
    });
  });

  test('a decided parked command has stopped needing anyone', () => {
    // Every non-queued status: an answered action is history, and an approval
    // the agent has since spent doubly so.
    expect(buildPendingActions({
      ...EMPTY,
      deferredActions: [
        parked({ id: 'd1', status: 'approved', decidedAt: 3000 }),
        parked({ id: 'd2', status: 'denied', decidedAt: 3000 }),
      ],
    })).toEqual([]);
  });

  test('the queue is newest-first across every kind', () => {
    const actions = buildPendingActions({
      approvals: [{ id: 'apr', changeId: 'c', approvalType: 'apply', decision: 'pending', createdAt: 3000 }],
      changes: [{ id: 'c', userPrompt: 'a change' }],
      scaffoldVersions: [{ version: 8, status: 'pending', rationale: 'r', written_at: 5000 }],
      jobs: [job({ id: 'bgjob-bad', status: 'failed', error: 'boom', settledAt: 1000 })],
      deferredActions: [parked({ requestedAt: 6000 })],
      unseenChanges: { count: 2, revertable: 2, latestAt: 4000 },
      curriculum: [{ id: 'cur', task: 't', status: 'pending', proposedAt: 2000 }],
    });
    expect(actions.map((a) => a.kind)).toEqual([
      'deferred_action', 'scaffold_version', 'unseen_changes', 'release_approval',
      'curriculum_task', 'failed_job',
    ]);
  });

  test('a successfully retried failure stays in the journal but leaves Needs you', () => {
    expect(buildPendingActions({
      ...EMPTY,
      jobs: [job({
        status: 'failed',
        error: 'old failure',
        retriedBy: 'bgjob-replacement',
      })],
    })).toEqual([]);
  });
});

describe('the needs-you queue stays host-owned', () => {
  test('listPendingActions is not a read model a Slate may read', () => {
    // Same doctrine as listPendingConsents: a Slate that can read the queue an
    // owner reads before approving something can draw a plausible fake of it.
    const readModels = new Set<string>(SLATE_READ_MODELS);
    expect(readModels.has('listPendingActions')).toBe(false);
  });
});
