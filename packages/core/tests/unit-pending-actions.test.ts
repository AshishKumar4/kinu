/**
 * The needs-you queue: only what blocks the agent on its owner, and never readable by an agent-authored
 * view, which could otherwise fake the surface an owner reads before authorising a deploy.
 */

import { describe, test, expect } from 'bun:test';
import {
  buildPendingActions, needsTheUser, type PendingAction, type PendingActionInputs, type PersonAsks,
} from '../src/read-models/pending-actions';
import type { PendingConsent } from '../src/protocol';
import type { PlanReview } from '../src/types/plans';
import { SLATE_READ_MODELS } from '../src/slates/read-models';
import type { DeferredApproval } from '../src/safety/deferred-approval';

const EMPTY: PendingActionInputs = {
  approvals: [], changes: [], scaffoldVersions: [], deferredActions: [],
  unseenChanges: { count: 0, revertable: 0, latestAt: 0 }, curriculum: [], pendingPlans: [],
};

function parked(over: Partial<DeferredApproval> = {}): DeferredApproval {
  return {
    id: 'defer-1', command: 'sudo systemctl restart nginx', executor: 'device',
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
    expect(action.title).toContain('v8');
  });

  test('a failed background job is the agent\'s to fix and never reaches the owner queue', () => {
    // A failed job wakes the agent (`jobs/runner.ts#wake`); it is not the owner's to fix.
    expect('jobs' in EMPTY).toBe(false);
  });

  test('unseen self-changes are ONE row that points at the digest, not N rows', () => {
    const actions = buildPendingActions({
      ...EMPTY, unseenChanges: { count: 3, revertable: 3, latestAt: 6000 },
    });

    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe('unseen_changes');
    expect(actions[0].title).toBe('3 self-changes you have not seen');
    expect(actions[0].detail).toBe('Keep or revert them in the journal below.');
  });

  test('one unseen change is singular', () => {
    const [action] = buildPendingActions({
      ...EMPTY, unseenChanges: { count: 1, revertable: 1, latestAt: 1 },
    });

    expect(action.title).toBe('1 self-change you have not seen');
  });

  // A graded turn offers no keep or revert, so it must not promise a decision.
  // as pointing at the wrong tab.
  const UNSEEN_WINDOWS = [
    {
      name: 'an unseen window of pure measurements is offered as a read, not a decision',
      unseenChanges: { count: 1, revertable: 0, latestAt: 1 },
      detail: 'Read them in the journal below.',
    },
    {
      name: 'a mixed window says how many of them can actually be decided',
      unseenChanges: { count: 4, revertable: 1, latestAt: 1 },
      detail: 'Keep or revert 1 of them in the journal below.',
    },
  ];

  for (const window of UNSEEN_WINDOWS) {
    test(window.name, () => {
      const [action] = buildPendingActions({ ...EMPTY, unseenChanges: window.unseenChanges });

      expect(action.detail).toBe(window.detail);
    });
  }

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
      title: 'Approve: a command the agent wants to run on device',
      detail: 'sudo systemctl restart nginx',
      at: 2000,
    });
  });

  test('a decided parked command has stopped needing anyone', () => {
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
      deferredActions: [parked({ requestedAt: 6000 })],
      unseenChanges: { count: 2, revertable: 2, latestAt: 4000 },
      curriculum: [{ id: 'cur', task: 't', status: 'pending', proposedAt: 2000 }],
      pendingPlans: [],
    });

    expect(actions.map((a) => a.kind)).toEqual([
      'deferred_action', 'scaffold_version', 'unseen_changes', 'release_approval',
      'curriculum_task',
    ]);
  });
});

describe('a plan awaiting a decision', () => {
  test('the row names the plan and carries the ref the tab opens', () => {
    const [action] = buildPendingActions({
      ...EMPTY,
      pendingPlans: [{
        owner: 'courier', id: 'plan-9', revision: 2, updatedAt: 7000,
        content: '# Courier rollout\n\nStage the rollout and verify the receipt.',
      }],
    });

    expect(action).toEqual({
      id: 'plan:courier:plan-9:2',
      kind: 'plan_review',
      title: 'Approve the plan · Courier rollout',
      detail: 'Submitted by courier',
      at: 7000,
      planRef: { owner: 'courier', id: 'plan-9', revision: 2 },
    });
  });

  test('the root own pending plan is asked without attribution', () => {
    const [action] = buildPendingActions({
      ...EMPTY,
      pendingPlans: [{
        owner: 'main', id: 'plan-1', revision: 1, updatedAt: 1000,
        content: '\n\n  \n## Ship the fix\nBody.',
      }],
    });

    expect(action?.title).toBe('Approve the plan · Ship the fix');
    expect(action?.detail).toBeNull();
  });
});

describe('the needs-you queue stays host-owned', () => {
  test('listPendingActions is not a read model a Slate may read', () => {
    // Same doctrine as listPendingConsents.
    const readModels = new Set<string>(SLATE_READ_MODELS);
    expect(readModels.has('listPendingActions')).toBe(false);
  });
});

describe('what the inspector opens for on its own', () => {
  // #21: a "hello" turn's self-change note opened the inspector.
  const nothing: PersonAsks = { pendingActions: [], pendingConsents: [], activePlan: null };

  const plan = (status: PlanReview['status']): PlanReview => ({
    id: 'plan-1', sessionId: 's', revision: 1, content: '# Plan', status, annotations: [], feedback: null,
    handoffAccepted: false, createdAt: 1, updatedAt: 1, decidedAt: null,
  });

  const action: PendingAction = { id: 'a-1', kind: 'deferred_action', title: 'Run rm -rf build', detail: null, at: 1 };
  const consent: PendingConsent = { consentId: 'c-1', deviceLabel: 'laptop', method: 'exec', command: 'ls', createdAt: 1 };

  test('an action or a consent to approve, or a plan to review, opens it', () => {
    for (const kind of ['deferred_action', 'release_approval', 'plan_review'] as const) {
      expect(needsTheUser({ ...nothing, pendingActions: [{ ...action, kind }] })).toBe(true);
    }

    expect(needsTheUser({ ...nothing, pendingConsents: [consent] })).toBe(true);
    expect(needsTheUser({ ...nothing, activePlan: plan('pending') })).toBe(true);
  });

  test('what the agent made, and a plan already decided, leave it where it is', () => {
    const made = { ...nothing, slates: [{ id: 'app' }], previewFocus: 'preview:workspace:8788', pinnedPorts: [{ port: 8788 }] };

    expect(needsTheUser(made)).toBe(false);

    // Recorded after a "hello" turn on the dev server, 2026-09-23.
    const note: PendingAction = {
      id: 'unseen-changes', kind: 'unseen_changes', title: '1 self-change you have not seen',
      detail: 'Read them in the journal below.', at: 1790199280964,
    };

    for (const kind of ['unseen_changes', 'scaffold_version', 'curriculum_task'] as const) {
      expect(needsTheUser({ ...nothing, pendingActions: [{ ...note, kind }] })).toBe(false);
    }

    for (const status of ['changes_requested', 'approved', 'superseded'] as const) {
      expect(needsTheUser({ ...nothing, activePlan: plan(status) })).toBe(false);
    }
  });
});
