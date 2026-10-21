// The OMP runner's answer phase, resumed: a copy whose process died asks only the requests its answers file lacks.
import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '@kinu.run/test-utils';
import { answeredTurnIds } from './run';

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
