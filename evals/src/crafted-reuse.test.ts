import { expect, test } from 'bun:test';
import { reusedInLaterTurn } from '../tasks/crafted-reuse';

const tool = (uses: number) => [{ name: 'manifest_totals', description: 'Shipping manifest totals', usageCount: uses }];

test('jcnu57: one September call and two October calls count as two reviewed turns', () => {
  expect(reusedInLaterTurn(tool(1), tool(2), 'manifest_totals')).toBe(true);
});

test('an unchanged counter does not prove later-turn reuse', () => {
  expect(reusedInLaterTurn(tool(3), tool(3), 'manifest_totals')).toBe(false);
});

test('a tool built in the first turn can first be used in the later turn', () => {
  expect(reusedInLaterTurn(tool(0), tool(1), 'manifest_totals')).toBe(true);
});
