import { expect, test } from 'bun:test';
import { WORKSPACE_LEASE_MS } from './session';
import { sweepEvalWorkspaces } from './sweep';

const NOW = Date.parse('2026-09-26T06:00:00.000Z');

test('a run deletes the eval workspaces whose mark outlived the lease and no one holds, and nothing else', async () => {
  const removed: string[] = [];

  const sweep = await sweepEvalWorkspaces({
    // Marked a beat ago on some machine; stopped marking past the lease; held since long ago; not an eval's.
    list: () => Promise.resolve([
      { name: 'eval-order-book-3-live01', lastVisited: NOW - 60_000 },
      { name: 'eval-order-book-3-edge01', lastVisited: NOW - WORKSPACE_LEASE_MS + 1 },
      { name: 'eval-order-book-2-dead01', lastVisited: NOW - WORKSPACE_LEASE_MS },
      { name: 'eval-trajectory-evals-pu-eedw1v', lastVisited: Date.parse('2026-09-22T12:00:00.000Z') },
      { name: 'fernhill-bakery', lastVisited: Date.parse('2026-09-01T12:00:00.000Z') },
    ]),
    remove: (name) => {
      removed.push(name);

      return Promise.resolve();
    },
    held: new Map([['eval-trajectory-evals-pu-eedw1v', 'the reproduction of the 30 s wake loop']]),
    now: NOW,
  });

  expect(removed).toEqual(['eval-order-book-2-dead01']);
  expect(sweep).toEqual({
    deleted: ['eval-order-book-2-dead01'],
    live: ['eval-order-book-3-live01', 'eval-order-book-3-edge01'],
    held: [{ name: 'eval-trajectory-evals-pu-eedw1v', reason: 'the reproduction of the 30 s wake loop' }],
    failed: [],
  });
});

test('a delete the deployment fails is reported with its reason, and the sweep goes on to the rest', async () => {
  // Measured 2026-10-01 03:16:51Z on staging: nine task files swept the account at once and sent DELETE for the same
  // first workspace within 2 ms; one deleted it and eight were answered 500 "no such table: workspace_identity". Each
  // of those eight sweeps threw, and with it the 24 trials of its task were skipped.
  const removed: string[] = [];
  const dead = (name: string) => ({ name, lastVisited: NOW - WORKSPACE_LEASE_MS });

  const sweep = await sweepEvalWorkspaces({
    list: () => Promise.resolve([dead('eval-budget-board-7-7fo67r'), dead('eval-site-preview-9-s0sgip')]),
    remove: (name) => {
      if (name === 'eval-budget-board-7-7fo67r') {
        return Promise.reject(new Error('could not delete the workspace eval-budget-board-7-7fo67r: 500 Internal Server Error — '
          + '{"error":"deleting this workspace: no such table: workspace_identity: SQLITE_ERROR","code":"io"}'));
      }

      removed.push(name);

      return Promise.resolve();
    },
    held: new Map(),
    now: NOW,
  });

  expect(removed).toEqual(['eval-site-preview-9-s0sgip']);
  expect(sweep.deleted).toEqual(['eval-site-preview-9-s0sgip']);
  expect(sweep.failed).toEqual([{ name: 'eval-budget-board-7-7fo67r', reason: expect.stringContaining('no such table: workspace_identity') }]);
});
