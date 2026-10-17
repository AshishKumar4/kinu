/**
 * The needs-you queue: only what blocks the agent on its owner, and never readable by an agent-authored
 * view, which could otherwise fake the surface an owner reads before authorising a deploy.
 */

import { describe, test, expect } from 'bun:test';
import {
  buildPendingActions, needsTheUser, ownerAsks, type PendingAction, type PendingActionInputs, type PersonAsks,
} from '../src/read-models/pending-actions';
import type { PendingConsent } from '../src/protocol';
import type { PlanReview } from '../src/types/plans';
import { SLATE_READ_MODELS } from '../src/slates/read-models';
import type { DeferredApproval } from '../src/safety/deferred-approval';

const EMPTY: PendingActionInputs = {
  scaffoldVersions: [], deferredActions: [], workspaceProposals: [],
  changeApprovals: { count: 0, latestAt: 0 }, pendingPlans: [],
};

function parked(over: Partial<DeferredApproval> = {}): DeferredApproval {
  return {
    id: 'defer-1', actor: 'actor-main', command: 'sudo systemctl restart nginx', executor: 'device', context: {},
    reason: 'Approval review: gate',
    status: 'queued', requestedAt: 2000, decidedAt: null, ...over,
  };
}

describe('buildPendingActions', () => {
  test('nothing waiting is an empty queue', () => {
    expect(buildPendingActions(EMPTY)).toEqual([]);
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

  test('skills waiting on the owner are ONE row that points at the journal, not N rows', () => {
    const actions = buildPendingActions({ ...EMPTY, changeApprovals: { count: 3, latestAt: 6000 } });

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: 'change_approval', at: 6000 });
    expect(actions[0].title).toContain('3');
  });

  test('one waiting skill is singular', () => {
    const [action] = buildPendingActions({ ...EMPTY, changeApprovals: { count: 1, latestAt: 1 } });

    expect(action.title).toBe('A skill the agent wrote waits for your approval');
  });

  test('a command an agent parked on the owner is a needs-you row, raised by that agent', () => {
    const [action] = buildPendingActions({ ...EMPTY, deferredActions: [parked({ actor: 'actor-courier' })] });
    expect(action).toEqual({
      id: 'defer-1',
      kind: 'deferred_action',
      title: 'Approve: a command the agent wants to run on device',
      detail: 'sudo systemctl restart nginx',
      at: 2000,
      raisedBy: 'actor-courier',
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
      scaffoldVersions: [{ version: 8, status: 'pending', rationale: 'r', written_at: 5000 }],
      deferredActions: [parked({ requestedAt: 6000 })],
      changeApprovals: { count: 2, latestAt: 4000 },
      pendingPlans: [],
      workspaceProposals: [],
    });

    expect(actions.map((a) => a.kind)).toEqual([
      'deferred_action', 'scaffold_version', 'change_approval',
    ]);
  });
});

describe('a plan awaiting a decision', () => {
  test('the row names the plan and carries the ref the tab opens', () => {
    const [action] = buildPendingActions({
      ...EMPTY,
      pendingPlans: [{
        owner: 'courier', actor: 'actor-courier', id: 'plan-9', revision: 2, updatedAt: 7000,
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
      raisedBy: 'actor-courier',
    });
  });

  test('the root own pending plan is asked without attribution', () => {
    const [action] = buildPendingActions({
      ...EMPTY,
      pendingPlans: [{
        owner: 'main', actor: 'actor-main', id: 'plan-1', revision: 1, updatedAt: 1000,
        content: '\n\n  \n## Ship the fix\nBody.',
      }],
    });

    expect(action?.title).toContain('Ship the fix');
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
  const nothing: PersonAsks = { pendingActions: [], pendingConsents: [], activePlan: null, ownerQuestions: [] };

  const plan = (status: PlanReview['status']): PlanReview => ({
    id: 'plan-1', sessionId: 's', revision: 1, content: '# Plan', status, annotations: [], feedback: null,
    handoffAccepted: false, createdAt: 1, updatedAt: 1,
  });

  const action: PendingAction = { id: 'a-1', kind: 'deferred_action', title: 'Run rm -rf build', detail: null, at: 1 };
  const consent: PendingConsent = { consentId: 'c-1', deviceLabel: 'laptop', method: 'exec', command: 'ls', createdAt: 1 };

  test('an action or a consent to approve, or a plan to review, opens it', () => {
    for (const kind of ['deferred_action', 'plan_review'] as const) {
      expect(needsTheUser({ ...nothing, pendingActions: [{ ...action, kind }] })).toBe(true);
    }

    expect(needsTheUser({ ...nothing, pendingConsents: [consent] })).toBe(true);
    expect(needsTheUser({ ...nothing, activePlan: plan('pending') })).toBe(true);
  });

  test('a hosted agent\'s open question opens it, and a closed one does not', () => {
    const asked = (status: 'open' | 'answered') => ({
      agent: 'courier', actor: 'actor-courier',
      asked: {
        id: 'ask-1', actor: 'actor-courier', callId: 'c-1', turnId: 't-1', mode: 'build' as const, status, answers: null, askedAt: 1, closedAt: null,
        questions: [{ id: 'units', question: 'Which unit?', options: [{ label: 'Cents' }, { label: 'Dollars' }] }],
      },
    });

    expect([needsTheUser({ ...nothing, ownerQuestions: [asked('open')] }), needsTheUser({ ...nothing, ownerQuestions: [asked('answered')] })])
      .toEqual([true, false]);
  });

  test('what the agent made, and a plan already decided, leave it where it is', () => {
    const made = { ...nothing, slates: [{ id: 'app' }], previewFocus: 'preview:workspace:8788', pinnedPorts: [{ port: 8788 }] };

    expect(needsTheUser(made)).toBe(false);

    const note: PendingAction = {
      id: 'change-approvals', kind: 'change_approval', title: 'A skill the agent wrote waits for your approval',
      detail: null, at: 1790199280964,
    };

    for (const kind of ['change_approval', 'scaffold_version'] as const) {
      expect(needsTheUser({ ...nothing, pendingActions: [{ ...note, kind }] })).toBe(false);
    }

    for (const status of ['changes_requested', 'approved', 'superseded'] as const) {
      expect(needsTheUser({ ...nothing, activePlan: plan(status) })).toBe(false);
    }
  });
});

describe('the attention stack the chat shows', () => {
  const row = (id: string, kind: PendingAction['kind'], at: number): PendingAction => ({ id, kind, title: id, detail: null, at });
  const consent = (consentId: string, createdAt: number): PendingConsent => ({ consentId, deviceLabel: 'studio', method: 'exec', command: 'ls', createdAt });

  test('is what holds the person and every consent, newest first, from the reads Work shows', () => {
    const asks = ownerAsks({
      pendingActions: [row('push', 'deferred_action', 30), row('v8', 'scaffold_version', 90), row('plan', 'plan_review', 10),
        row('skill', 'change_approval', 80), row('pricing', 'workspace_proposal', 50)],
      pendingConsents: [consent('c-1', 40)],
    });

    expect(asks.map((ask) => ask.key)).toEqual(['action:pricing', 'consent:c-1', 'action:push', 'action:plan']);
  });

  test('an agent\'s own pane stacks only the asks it raised; the workspace\'s own stay with the workspace', () => {
    const reads = {
      pendingActions: [row('push', 'deferred_action', 30), { ...row('plan:courier:p:1', 'plan_review', 20), raisedBy: 'actor-courier' },
        { ...row('plan:scout:p:1', 'plan_review', 10), raisedBy: 'actor-scout' }],
      pendingConsents: [consent('c-1', 40)],
    };

    expect(ownerAsks(reads, { raisedBy: 'actor-courier' }).map((ask) => ask.key)).toEqual(['action:plan:courier:p:1']);
    expect(ownerAsks(reads).map((ask) => [ask.key, ask.raisedBy])).toEqual([
      ['consent:c-1', null], ['action:push', null], ['action:plan:courier:p:1', 'actor-courier'], ['action:plan:scout:p:1', 'actor-scout'],
    ]);
  });

  test('holds exactly what holds the inspector open', () => {
    const quiet = { pendingActions: [row('v8', 'scaffold_version', 1)], pendingConsents: [], activePlan: null, ownerQuestions: [] };
    const parkedOne = { ...quiet, pendingActions: [row('push', 'deferred_action', 1)] };

    expect([ownerAsks(quiet).length > 0, needsTheUser(quiet), ownerAsks(parkedOne).length > 0, needsTheUser(parkedOne)])
      .toEqual([false, false, true, true]);
  });
});
