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
  buildWorkspaceOverview, overviewHeadline, workspaceOverviewEvidence, workspaceOverviewStatus, WorkspaceOverviewSchema,
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

    // A slate whose URL would have to be minted — nothing has reserved it —
    // is skipped, not waited for: the card read starts no process, so the
    // picture is the first slate that can already be pointed at.
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

describe('workspaceOverviewStatus', () => {
  test('a decision outranks live work; green is earned only by a sealed run', () => {
    expect(workspaceOverviewStatus({ ...buildWorkspaceOverview(EMPTY), decisionsWaiting: 2 })).toEqual({ kind: 'attention' });

    expect(workspaceOverviewStatus(buildWorkspaceOverview({ ...EMPTY, working: true }))).toEqual({ kind: 'working' });

    expect(workspaceOverviewStatus(buildWorkspaceOverview({ ...EMPTY, unfinished: true }))).toEqual({ kind: 'unfinished' });

    expect(workspaceOverviewStatus(buildWorkspaceOverview(EMPTY))).toEqual({ kind: 'idle' });
  });
});

describe('overviewHeadline', () => {
  test('a waiting decision outranks live work, and its count rides the label', () => {
    expect(overviewHeadline(buildWorkspaceOverview({ ...EMPTY, working: true, pendingActions: [action('release_approval')] })))
      .toEqual({ label: 'Needs you · 1', tone: 'accent' });
  });

  test('live work outranks a failed run', () => {
    expect(overviewHeadline(buildWorkspaceOverview({ ...EMPTY, working: true, latestRun: { status: 'error', task: null } })))
      .toEqual({ label: 'Working', tone: 'live' });
  });

  test('a sealed error outranks durable leftovers', () => {
    expect(overviewHeadline(buildWorkspaceOverview({ ...EMPTY, unfinished: true, latestRun: { status: 'error', task: null } })))
      .toEqual({ label: 'Last run failed', tone: 'danger' });
  });

  test('durable leftovers outrank unread updates', () => {
    expect(overviewHeadline(buildWorkspaceOverview({ ...EMPTY, unfinished: true, pendingActions: [action('unseen_changes')] })))
      .toEqual({ label: 'Unfinished', tone: 'muted' });
  });

  test('unread updates outrank a plain idle line', () => {
    expect(overviewHeadline(buildWorkspaceOverview({ ...EMPTY, pendingActions: [action('unseen_changes')] })))
      .toEqual({ label: 'Updated', tone: 'muted' });
  });

  test('nothing to say is "Idle", never a run word', () => {
    expect(overviewHeadline(buildWorkspaceOverview(EMPTY))).toEqual({ label: 'Idle', tone: 'muted' });
    expect(overviewHeadline(buildWorkspaceOverview({ ...EMPTY, latestRun: { status: 'completed', task: null } })))
      .toEqual({ label: 'Idle', tone: 'muted' });
  });
});

describe('workspaceOverviewEvidence', () => {
  test('an idle card with no run says exactly "No runs yet" — never a run word', () => {
    expect(workspaceOverviewEvidence(buildWorkspaceOverview(EMPTY))).toEqual([
      { key: 'empty', text: 'No runs yet', tone: 'quiet' },
    ]);
  });

  test('an idle card with unread updates lists them — the empty row is the last resort', () => {
    const overview = buildWorkspaceOverview({ ...EMPTY, pendingActions: [action('unseen_changes')] });

    expect(workspaceOverviewStatus(overview)).toEqual({ kind: 'idle' });
    expect(workspaceOverviewEvidence(overview)).toEqual([
      { key: 'updates', text: 'Updates to read', tone: 'muted' },
    ]);
  });

  test('waiting, working, updates and the sealed run each list, in order', () => {
    const overview = buildWorkspaceOverview({
      ...EMPTY,
      working: true,
      pendingActions: [action('release_approval'), action('deferred_action'), action('unseen_changes')],
      latestRun: { status: 'completed', task: 'Sort this week\'s receipts into the ledger' },
    });

    expect(workspaceOverviewEvidence(overview)).toEqual([
      { key: 'decisions', text: '2 decisions waiting', tone: 'warning' },
      { key: 'working', text: 'Working now', tone: 'accent' },
      { key: 'updates', text: 'Updates to read', tone: 'muted' },
      { key: 'run', text: 'Last run: completed', tone: 'success' },
      { key: 'task', text: 'Sort this week\'s receipts into the ledger', tone: 'quiet' },
    ]);
  });

  test('a failed run warns and an unfinished workspace still names its leftovers', () => {
    const overview = buildWorkspaceOverview({
      ...EMPTY,
      unfinished: true,
      pendingActions: [action('unseen_changes')],
      latestRun: { status: 'failed', task: 'Regenerate the token sheet' },
    });

    expect(workspaceOverviewEvidence(overview)).toEqual([
      { key: 'unfinished', text: 'Unfinished work', tone: 'muted' },
      { key: 'updates', text: 'Updates to read', tone: 'muted' },
      { key: 'run', text: 'Last run: failed', tone: 'warning' },
      { key: 'task', text: 'Regenerate the token sheet', tone: 'quiet' },
    ]);
  });

  test('a run whose end recorded no reason is unknown, and error statuses are quoted plainly', () => {
    const unsealed = buildWorkspaceOverview({ ...EMPTY, latestRun: { status: null, task: null } });
    const errored = buildWorkspaceOverview({ ...EMPTY, latestRun: { status: 'error', task: null } });

    expect(workspaceOverviewEvidence(unsealed)).toEqual([
      { key: 'run', text: 'Last run: unknown', tone: 'muted' },
    ]);
    expect(workspaceOverviewEvidence(errored)).toEqual([
      { key: 'run', text: 'Last run: error', tone: 'muted' },
    ]);
  });

  test('the task line holds the wire bound: 240 characters, nothing beyond', () => {
    const overview = buildWorkspaceOverview({ ...EMPTY, latestRun: { status: 'completed', task: 'x'.repeat(400) } });

    const evidence = workspaceOverviewEvidence({
      ...overview,
      latestRun: { status: 'completed', task: 'y'.repeat(400) },
    });

    const task = evidence.find((fact) => fact.key === 'task');

    expect(task?.text.length).toBe(240);
    expect(task?.text.endsWith('y')).toBe(true);
  });
});
