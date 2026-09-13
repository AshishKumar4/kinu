/**
 * The home card's fold: which queue entries block the owner, which merely
 * update them, and what the card is allowed to conclude from the last run.
 *
 * The boundary under test is DECISION vs UPDATE — the number a "Needs you"
 * badge may print vs the existence of unread changes — because folding an
 * update into the attention count is how a busy card manufactures a blocked
 * workspace. The scaffold trial swings on the deployment's own auto-promote
 * switch: a trial the engine applies itself is something to read; one it
 * cannot apply is the owner's call. And a curriculum proposal is NEITHER —
 * the card has no badge for it at all.
 */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import {
  buildWorkspaceOverview, workspaceOverviewStatus, WorkspaceOverviewSchema,
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
        consentId: 'con-1', createdAt: NOW, deviceId: 'dev-1', deviceLabel: 'laptop',
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
});

describe('workspaceOverviewStatus', () => {
  test('a decision outranks live work; green is earned only by a sealed run', () => {
    expect(workspaceOverviewStatus({ ...buildWorkspaceOverview(EMPTY), decisionsWaiting: 2 })).toEqual({ kind: 'attention' });

    expect(workspaceOverviewStatus(buildWorkspaceOverview({ ...EMPTY, working: true }))).toEqual({ kind: 'working' });

    expect(workspaceOverviewStatus(buildWorkspaceOverview({ ...EMPTY, unfinished: true }))).toEqual({ kind: 'unfinished' });

    expect(workspaceOverviewStatus(buildWorkspaceOverview(EMPTY))).toEqual({ kind: 'idle' });
  });
});
