import { describe, expect, test } from 'bun:test';
import { agreement } from './decision-agreement';

describe('the decision agreement report', () => {
  test('shares are of the turns both models rated, question by question', () => {
    expect(agreement([
      { clef: { score: 2, corrected: 0.9, wrong: 'misunderstood' }, structured: { score: 2, corrected: 0.9, wrong: 'misunderstood' } },
      { clef: { score: 4.2, corrected: 0.1, wrong: 'nothing' }, structured: { score: 3, corrected: 0.5, wrong: 'nothing' } },
      { clef: { score: 1, corrected: 0.8, wrong: 'incorrect' }, structured: { score: 4, corrected: 0.1, wrong: 'incomplete' } },
      { clef: null, structured: { score: 5, corrected: 0.1, wrong: 'nothing' } },
    ])).toEqual({ turns: 4, both: 3, satisfactionExact: 1 / 3, satisfactionWithinOne: 2 / 3, corrected: 1 / 3, wrong: 2 / 3 });
  });

  test('no turn rated by both says so rather than dividing by zero', () => {
    expect(agreement([{ clef: null, structured: null }])).toMatchObject({ both: 0, corrected: 0 });
  });
});
