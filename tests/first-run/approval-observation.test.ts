import { expect, test } from 'bun:test';
import { approvalClearsSelection } from './approval-observation';

test('the retained zero-before/zero-after observation proves no checkbox decision', () => {
  expect(approvalClearsSelection({ boxes: 0, checked: 0 }, { boxes: 0, checked: 0 })).toBe(false);
  expect(approvalClearsSelection({ boxes: 1, checked: 0 }, { boxes: 1, checked: 0 })).toBe(false);
});

test('a checked row must become unticked or leave the queue', () => {
  const before = { boxes: 1, checked: 1 };
  expect(approvalClearsSelection(before, { boxes: 1, checked: 1 })).toBe(false);
  expect(approvalClearsSelection(before, { boxes: 1, checked: 0 })).toBe(true);
  expect(approvalClearsSelection(before, { boxes: 0, checked: 0 })).toBe(true);
});
