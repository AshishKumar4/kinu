import { expect, test } from 'bun:test';
import { sweepEvalWorkspaces, WORKSPACE_LEASE_MS } from './sweep';

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
  });
});
