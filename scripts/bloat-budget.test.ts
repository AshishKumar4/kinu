/**
 * `gate:bloat-budget` over a fixture package: planted comment growth is red and
 * `--lock` will not record it; a cut is green with a stale row and `--lock`
 * lowers the number; a package the lock never held gets no budget for free.
 */

import { expect, test } from 'bun:test';

import { type CommentBudget, judgeComments, lowerBudget, measureComments } from './bloat-budget';

const FIXTURE = 'packages/fixture/src/a.ts';

/** `//one` and `//b`: five and three comment characters. */
const TEXT = '// one\nexport const a = 1;\n';

const measured = (fixture: string, extra: readonly (readonly [string, string])[] = []) => measureComments(new Map([
  [FIXTURE, fixture],
  ['packages/other/src/b.ts', '// b\nexport const b = 2;\n'],
  ...extra,
]));

function firstBudget(): CommentBudget {
  const { budget } = lowerBudget(undefined, measured(TEXT), '2026-09-22');

  if (budget === undefined) throw new Error('a first lock records whatever the tree holds');

  return budget;
}

test('planted comment growth in a package is over budget, and --lock refuses to record it', () => {
  const grown = measured(`/** two */\n${TEXT}`);

  expect(judgeComments(grown, firstBudget()).over).toEqual([{ key: 'fixture', was: 5, now: 13 }]);
  expect(lowerBudget(firstBudget(), grown, '2026-09-23')).toEqual({
    budget: undefined,
    refusals: [{ key: 'fixture', was: 5, now: 13 }],
  });
});

test('a cut is green with a stale row, and --lock lowers the number', () => {
  const cut = measured('export const a = 1;\n');
  const verdict = judgeComments(cut, firstBudget());

  expect(verdict.over).toEqual([]);
  expect(verdict.stale).toEqual([{ key: 'fixture', was: 5, now: 0 }]);
  expect(lowerBudget(firstBudget(), cut, '2026-09-23').budget?.packages).toEqual({ fixture: 0, other: 3 });
});

test('a package the lock never held has a budget of zero, unless it holds no comments', () => {
  const fresh = measured(TEXT, [['packages/fresh/src/c.ts', '// c\nexport const c = 3;\n']]);
  const silent = measured(TEXT, [['packages/silent/src/d.ts', 'export const d = 4;\n']]);

  expect(judgeComments(fresh, firstBudget()).over).toEqual([{ key: 'fresh', was: undefined, now: 3 }]);
  expect(lowerBudget(firstBudget(), fresh, '2026-09-23').budget).toBeUndefined();
  expect(lowerBudget(firstBudget(), silent, '2026-09-23').budget?.packages).toEqual({ fixture: 5, other: 3, silent: 0 });
});
