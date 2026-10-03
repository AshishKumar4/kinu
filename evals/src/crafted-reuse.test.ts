import { expect, test } from 'bun:test';
import type { RunEvent } from '@kinu.run/core';
import { invokedInTurn } from '../tasks/crafted-reuse';

function cycle(at: number, invoked: string[]): RunEvent {
  return { type: 'craft_cycle', eventIndex: 1, runId: `run-${String(at)}`, timestamp: new Date(at).toISOString(),
    crafted: [], invoked, reused: [], returned: 1, raised: 0, dropped: [] };
}

test('a lagging use counter does not erase this turn’s invocation', () => {
  expect(invokedInTurn([cycle(110, ['manifest_totals'])], 'manifest_totals', 100)).toBe(true);
});

test('a previous turn’s invocation does not count in this turn', () => {
  expect(invokedInTurn([cycle(90, ['manifest_totals']), cycle(110, [])], 'manifest_totals', 100)).toBe(false);
});

test('an invocation of a different tool is not reuse of this one', () => {
  expect(invokedInTurn([cycle(110, ['other_totals'])], 'manifest_totals', 100)).toBe(false);
});
