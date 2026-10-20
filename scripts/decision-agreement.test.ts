import { describe, expect, test } from 'bun:test';
import { agreement } from './decision-agreement';

describe('the decision agreement report', () => {
  test('shares are of the turns both models rated, each question read as its consumer reads it', () => {
    expect(agreement([
      { clef: { score: 2, corrected: 0.9, wrong: 'misunderstood' }, structured: { score: 2, corrected: 0.9, wrong: 'misunderstood' } },
      // Satisfaction by band: 4.2 is high and 3 is mid; corrected at 0.5, so 0.5 reads as corrected.
      { clef: { score: 4.2, corrected: 0.1, wrong: 'nothing' }, structured: { score: 3, corrected: 0.5, wrong: 'nothing' } },
      { clef: { score: 1, corrected: 0.8, wrong: 'incorrect' }, structured: { score: 4, corrected: 0.1, wrong: 'incomplete' } },
      { clef: { score: 3.5, corrected: 0.2, wrong: 'nothing' }, structured: { score: 4.9, corrected: 0.3, wrong: 'nothing' } },
      { clef: null, structured: { score: 5, corrected: 0.1, wrong: 'nothing' } },
    ])).toEqual({
      // A constant answer matches Clef on 2 of 4 for each: low or high, yes or no, and `nothing`.
      satisfaction: { both: 4, agrees: 2 / 4, constant: 2 / 4 },
      corrected: { both: 4, agrees: 2 / 4, constant: 2 / 4 },
      wrong: { both: 4, agrees: 3 / 4, constant: 2 / 4 },
    });
  });

  test('no turn rated by both says so rather than dividing by zero', () => {
    expect(agreement([{ clef: null, structured: null }])).toMatchObject({ corrected: { both: 0, agrees: 0, constant: 0 } });
  });
});
