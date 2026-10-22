// The OMP runner's answer phase, resumed: a copy whose process died asks only the requests its answers file lacks.
import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '@kinu.run/test-utils';
import { answeredTurnIds, askedRow } from './run';

describe("a copy's answers file", () => {
  test('names the requests already answered, and a torn last line answers nothing', () => {
    const answers = join(scratchDir('omp-answers'), 'answers-0.jsonl');

    writeFileSync(answers, `${JSON.stringify({ turnId: 'a', answer: 'done' })}\n${JSON.stringify({ turnId: 'b', answer: null })}\n{"turnId":"c","ans`);

    expect([...answeredTurnIds(answers)].sort()).toEqual(['a', 'b']);
  });

  test('that does not exist yet names none', () => {
    expect(answeredTurnIds(join(scratchDir('omp-answers'), 'answers-1.jsonl')).size).toBe(0);
  });
});

describe('a request the provider refused before any model call', () => {
  const unasked = { answer: null, spent: { modelCalls: 0 } };
  const asked = { answer: 'done', spent: { modelCalls: 3 } };
  const failed = { answer: null, spent: { modelCalls: 2 } };

  test('is asked again after the wait until it is asked, and a request that was asked and failed is not', async () => {
    const rows = [unasked, unasked, asked];
    const waits: number[] = [];

    expect(await askedRow(async () => rows.shift() ?? asked, async (ms) => { waits.push(ms); })).toBe(asked);
    expect(waits).toEqual([60_000, 60_000]);
    expect(await askedRow(async () => failed, async () => { throw new Error('a failed answer was asked again'); })).toBe(failed);
  });

  test('stands as it came once the attempts are spent', async () => {
    let asks = 0;

    const ask = async () => {
      asks += 1;

      return unasked;
    };

    expect(await askedRow(ask, async () => {}, 1, 3)).toBe(unasked);
    expect(asks).toBe(3);
  });
});
