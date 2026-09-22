/** Home card fold: a decision may count toward the "Needs you" badge; an update never does. */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import {
  buildWorkspaceOverview, overviewHeadline, WorkspaceOverviewSchema,
  type WorkspaceOverviewInputs,
} from '../src/read-models/workspace-overview';
import type { PendingAction } from '../src/read-models/pending-actions';

const NOW = Date.UTC(2026, 8, 12, 12, 0, 0);

function action(kind: PendingAction['kind'], id = kind): PendingAction {
  return { id, kind, title: id, detail: null, at: NOW };
}

const EMPTY: WorkspaceOverviewInputs = {
  observedAt: NOW,
  working: false,
  unfinished: false,
  pendingActions: [],
  pendingConsents: [],
  activePlan: null,
  scaffoldAutoApply: true,
  latestRun: null,
  slates: [],
};

describe('buildWorkspaceOverview', () => {
  test('decisions count; unseen changes are updates; curriculum proposals are neither', () => {
    const overview = buildWorkspaceOverview({
      ...EMPTY,
      pendingActions: [
        action('release_approval'),
        action('deferred_action'),
        action('unseen_changes'),
        action('curriculum_task'),
      ],
    });

    expect(overview.decisionsWaiting).toBe(2);
    expect(overview.hasUpdates).toBe(true);
  });

  test('a scaffold trial follows the auto-promote switch', () => {
    const automatic = buildWorkspaceOverview({ ...EMPTY, pendingActions: [action('scaffold_version')] });

    const manual = buildWorkspaceOverview({
      ...EMPTY, scaffoldAutoApply: false, pendingActions: [action('scaffold_version')],
    });

    expect(automatic.decisionsWaiting).toBe(0);
    expect(automatic.hasUpdates).toBe(true);
    expect(manual.decisionsWaiting).toBe(1);
    expect(manual.hasUpdates).toBe(false);
  });

  test('a pending consent and a pending plan each wait on the owner', () => {
    const overview = buildWorkspaceOverview({
      ...EMPTY,
      pendingConsents: [{
        consentId: 'con-1', createdAt: NOW, deviceId: 'dev-1', deviceLabel: 'device',
        method: 'shell', command: 'git push',
      }],
      activePlan: { status: 'pending' },
    });

    expect(overview.decisionsWaiting).toBe(2);
    expect(overview.hasUpdates).toBe(false);
  });

  test('a decided plan and a quiet queue read as nothing', () => {
    for (const status of ['approved', 'changes_requested', 'superseded'] as const) {
      expect(buildWorkspaceOverview({ ...EMPTY, activePlan: { status } }).decisionsWaiting).toBe(0);
    }
  });

  test('working wins over unfinished; unfinished never reads as active work', () => {
    expect(buildWorkspaceOverview({ ...EMPTY, working: true, unfinished: true }).activity).toBe('working');
    expect(buildWorkspaceOverview({ ...EMPTY, unfinished: true }).activity).toBe('unfinished');
    expect(buildWorkspaceOverview(EMPTY).activity).toBe('idle');
  });

  test('the task preview is trimmed to one card line; the summary stays the wire shape', () => {
    const overview = buildWorkspaceOverview({
      ...EMPTY,
      latestRun: { status: 'aborted', task: 'x'.repeat(400) },
    });

    expect(v.is(WorkspaceOverviewSchema, overview)).toBe(true);
    expect(overview.latestRun?.task?.length).toBe(240);
    expect(overview.latestRun?.status).toBe('aborted');
  });

  test('the tile draws the first slate already addressed; an unaddressed one is not a picture', () => {
    expect(buildWorkspaceOverview(EMPTY).primarySlate).toBeNull();

    // An unreserved slate URL is skipped, not waited for: the card read starts no process.
    const overview = buildWorkspaceOverview({
      ...EMPTY,
      slates: [
        { id: 'sketch', title: 'Sketch', url: null },
        { id: 'board', title: 'Coupon board', url: 'https://board.preview.test/' },
        { id: 'ledger', title: 'Ledger', url: 'https://ledger.preview.test/' },
      ],
    });

    expect(overview.primarySlate).toEqual({ id: 'board', title: 'Coupon board', url: 'https://board.preview.test/' });
    expect(v.is(WorkspaceOverviewSchema, overview)).toBe(true);
    expect(buildWorkspaceOverview({ ...EMPTY, slates: [{ id: 'sketch', title: 'Sketch', url: null }] }).primarySlate).toBeNull();
  });
});


describe('overviewHeadline', () => {
  test('a waiting decision outranks live work, and its count rides the label', () => {
    expect(overviewHeadline(buildWorkspaceOverview({ ...EMPTY, working: true, pendingActions: [action('release_approval')] })))
      .toEqual({ label: 'Needs you · 1', status: 'needs' });
  });

  test('live work outranks a failed run', () => {
    expect(overviewHeadline(buildWorkspaceOverview({ ...EMPTY, working: true, latestRun: { status: 'error', task: null } })))
      .toEqual({ label: 'Working', status: 'working' });
  });

  test('a sealed error outranks durable leftovers', () => {
    expect(overviewHeadline(buildWorkspaceOverview({ ...EMPTY, unfinished: true, latestRun: { status: 'error', task: null } })))
      .toEqual({ label: 'Last run failed', status: 'failed' });
  });

  test('durable leftovers outrank unread updates', () => {
    expect(overviewHeadline(buildWorkspaceOverview({ ...EMPTY, unfinished: true, pendingActions: [action('unseen_changes')] })))
      .toEqual({ label: 'Unfinished', status: 'unfinished' });
  });

  test('unread updates outrank a plain idle line', () => {
    expect(overviewHeadline(buildWorkspaceOverview({ ...EMPTY, pendingActions: [action('unseen_changes')] })))
      .toEqual({ label: 'Updated', status: 'updated' });
  });

  test('nothing to say is "Idle", never a run word', () => {
    expect(overviewHeadline(buildWorkspaceOverview(EMPTY))).toEqual({ label: 'Idle', status: 'idle' });
    expect(overviewHeadline(buildWorkspaceOverview({ ...EMPTY, latestRun: { status: 'completed', task: null } })))
      .toEqual({ label: 'Idle', status: 'idle' });
  });
});

