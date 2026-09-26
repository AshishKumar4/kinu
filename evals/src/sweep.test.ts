import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scratchDir } from '@kinu.run/test-utils';
import { claimEvalWorkspace, holdEvalWorkspace } from './claims';
import { sweepEvalWorkspaces } from './sweep';

const ORIGIN = 'https://kinu.run';

let home: string | undefined;

beforeEach(() => {
  home = process.env.HOME;
  process.env.HOME = scratchDir('eval-claims');
});

afterEach(() => {
  process.env.HOME = home;
});

/** A claim left by a process that has ended: another boot's. */
function claimedByTheDead(name: string): void {
  const dir = join(homedir(), '.config', 'kinu', 'eval-workspaces', 'kinu.run');

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify({ kind: 'owned', owner: { bootId: 'a-boot-that-ended', pid: 1, startTicks: 0 } }));
}

test('a run deletes the eval workspaces no live run owns and no one holds, and nothing else', async () => {
  claimEvalWorkspace(ORIGIN, 'eval-order-book-3-live01');
  holdEvalWorkspace(ORIGIN, 'eval-trajectory-evals-pu-eedw1v', 'the reproduction of the 30 s wake loop');
  claimedByTheDead('eval-order-book-2-dead01');

  const removed: string[] = [];

  const sweep = await sweepEvalWorkspaces({
    origin: ORIGIN,
    list: () => Promise.resolve([
      'eval-order-book-3-live01', 'eval-trajectory-evals-pu-eedw1v', 'eval-order-book-2-dead01',
      'eval-budget-board-1-lost01', 'fernhill-bakery',
    ]),
    remove: (name) => {
      removed.push(name);

      return Promise.resolve();
    },
  });

  expect(removed).toEqual(['eval-order-book-2-dead01', 'eval-budget-board-1-lost01']);
  expect(sweep).toEqual({
    deleted: ['eval-order-book-2-dead01', 'eval-budget-board-1-lost01'],
    owned: ['eval-order-book-3-live01'],
    held: [{ name: 'eval-trajectory-evals-pu-eedw1v', reason: 'the reproduction of the 30 s wake loop' }],
  });
});
