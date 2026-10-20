import { describe, expect, test } from 'bun:test';
import { recallTable, windowLabel } from './triage-recall';

const verdict = (score: number, corrected = 0) => ({ score, corrected, wrong: null });

describe('what triage must let through', () => {
  test('a batch with a low or a likely-corrected turn must pass; one rated high throughout may stop; a middling one is neither', () => {
    expect([
      windowLabel([verdict(4.5), verdict(2)]),
      windowLabel([verdict(4.5), verdict(3, 0.8)]),
      windowLabel([verdict(4.5), verdict(4)]),
      windowLabel([verdict(4.5), verdict(3)]),
    ]).toEqual(['must', 'must', 'may', null]);
  });

  test('at each threshold, the must-pass batches it passes and the may-stop batches it stops', () => {
    const table = recallTable([{ label: 'must', worth: 0.35 }, { label: 'must', worth: 0.8 }, { label: 'may', worth: 0.2 }, { label: null, worth: 0.9 }]);

    // A must-pass batch passes by rule; Clef alone would have stopped one of them at 0.5.
    expect(table.find((row) => row.threshold === 0.3)).toEqual({ threshold: 0.3, recall: 1, clefAlone: 1, stops: 1, neitherPass: 1 });
    expect(table.find((row) => row.threshold === 0.5)).toEqual({ threshold: 0.5, recall: 1, clefAlone: 0.5, stops: 1, neitherPass: 1 });
  });
});
