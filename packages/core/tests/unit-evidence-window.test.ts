// The evolution loop's evidence budget: the end of a long turn must reach the judge.
import { describe, test, expect } from 'bun:test';
import {
  evidenceWindow,
} from '../src/index';
import { digestJsonValue } from '../src/utils/json';
import { rateTurn } from '../src/evolution/ratings';

/** Decisive material at the very end. */
function trajectory(chars: number, ending: string): string {
  return 'step boilerplate. '.repeat(Math.ceil(chars / 18)).slice(0, chars) + ending;
}

describe('evidenceWindow', () => {
  test('text within budget passes through byte-identical', () => {
    const short = 'a conclusive answer';
    expect(evidenceWindow(short, 100)).toBe(short);
  });

  test('keeps both ends and says how much it dropped', () => {
    const text = `OPENING${'-'.repeat(1000)}CLOSING`;
    const windowed = evidenceWindow(text, 100);
    expect(windowed.startsWith('OPENING')).toBe(true);
    expect(windowed.endsWith('CLOSING')).toBe(true);
  });

  // core-rest review P1-26: a cut through an astral character left a lone surrogate in the evidence and the digest.
  test('no cut splits a character, and the count names exactly what was cut', () => {
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
    const text = '\u{1F600}'.repeat(200);
    const windowed = evidenceWindow(text, 101);
    const [head = '', tail = ''] = windowed.split(/\n\[\.\.\. \d+ chars omitted from the middle \.\.\.\]\n/u);

    expect(loneSurrogate.test(windowed)).toBe(false);
    expect(windowed).toContain(`[... ${String(text.length - head.length - tail.length)} chars omitted`);
    const digest = digestJsonValue({ value: `a${'\u{1F600}'.repeat(500)}` });
    expect(typeof digest === 'string' && digest.endsWith('...') && !loneSurrogate.test(digest)).toBe(true);
  });
});

describe('the readers can see the end of a long turn', () => {
  const ending = 'THE-DECISIVE-STEP';

  test('the decision model sees how the request, the answer and the reply ended', async () => {
    const states: string[] = [];

    await rateTurn(async ({ state }) => {
      states.push(state);

      return { answers: {
        satisfaction: { type: 'score', score: 2 }, corrected: { type: 'noul', noul: 0 }, wrong: { type: 'choice', choice: 'nothing' },
      }, usage: { input: 0, output: 0 } };
    }, {
      request: trajectory(20_000, `ASK-${ending}`),
      actions: '',
      answer: trajectory(40_000, `ANSWER-${ending}`),
      followup: trajectory(20_000, `FOLLOWUP-${ending}`),
    }, 0);

    expect(states[0]).toContain(`ASK-${ending}`);
    expect(states[0]).toContain(`ANSWER-${ending}`);
    expect(states[0]).toContain(`FOLLOWUP-${ending}`);
  });
});
