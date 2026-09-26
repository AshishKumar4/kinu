/**
 * `gate:error-model` over fixture sources: each mechanism is counted where it appears and not where
 * the target model spells the same word; a planted site is red and `--lock` refuses it; a new file
 * starts at zero; a removed site is green and stale, and `--lock` lowers the number; a declared
 * boundary file grows freely in the mechanisms it declares and in no other.
 */

import { expect, test } from 'bun:test';

import { type ErrorModelLock, judge, lower, measure } from './error-model';

const FILE = 'packages/fixture/src/a.ts';

const LEGACY = `
export class Gone extends Error {}
export class Deeper extends Gone {}
export class Refused extends KinuError {}
export function read(load: () => Promise<string>): Promise<{ ok: true; text: string } | { ok: false }> {
  try {
    if (Math.random() > 1) throw new Gone('x');
  } catch (error) {
    return Promise.reject(error);
  }
  return load().then((text) => ({ ok: true, text }), () => ({ ok: false })).catch(() => ({ ok: false }));
}
`;

/** The target model's own spellings of the same words: none of these is a legacy site. */
const TARGET = `
declare const program: Effect.Effect<string, KinuError>;
export const handled = program.pipe(Effect.catch(() => Effect.succeed('')));
export class Probe extends Data.TaggedError('Probe') {}
export const unrelated = { okay: true, success: 'yes' };
`;

const lockOf = (counts: Readonly<Record<string, number>>): ErrorModelLock => ({ measuredAt: '2026-09-23', counts });

const measured = (text: string, extra: readonly (readonly [string, string])[] = []) => measure(new Map([[FILE, text], ...extra]));

const BASELINE = lockOf(Object.fromEntries(measured(LEGACY).map(({ key, value }) => [key, value])));

test('each mechanism is counted where it appears, and not where the target model spells the same word', () => {
  expect(Object.fromEntries(measured(LEGACY).map(({ key, value }) => [key.slice(FILE.length + 1), value]))).toEqual({
    'catch': 1,
    'error-class': 3,
    'promise-rejection': 3,
    'result-literal': 3,
    'result-type': 2,
    'throw': 1,
  });
  expect(measured(TARGET)).toEqual([]);
});

test('a planted result literal is over its number, and --lock refuses to record it', () => {
  const grown = measured(`${LEGACY}\nexport const planted = { ok: false };\n`);

  expect(judge(grown, BASELINE).over).toEqual([{ key: `${FILE}#result-literal`, was: 3, now: 4 }]);
  expect(lower(BASELINE, grown, '2026-09-24')).toEqual({
    lock: undefined,
    refusals: [{ key: `${FILE}#result-literal`, was: 3, now: 4 }],
  });
});

test('a new file starts at zero: one throw in it is red', () => {
  const fresh = measured(LEGACY, [['packages/fixture/src/new.ts', 'export function f(): never { throw new Error("x"); }\n']]);

  expect(judge(fresh, BASELINE).over).toEqual([{ key: 'packages/fixture/src/new.ts#throw', was: undefined, now: 1 }]);
  expect(lower(BASELINE, fresh, '2026-09-24').lock).toBeUndefined();
});

test('a removed site is green with a stale row, and --lock lowers the number', () => {
  const cut = measured(LEGACY.replace('.catch(() => ({ ok: false }))', ''));
  const verdict = judge(cut, BASELINE);

  expect(verdict.over).toEqual([]);
  expect(verdict.stale).toEqual([
    { key: `${FILE}#promise-rejection`, was: 3, now: 2 },
    { key: `${FILE}#result-literal`, was: 3, now: 2 },
  ]);
  expect(lower(BASELINE, cut, '2026-09-24').lock?.counts).toMatchObject({
    [`${FILE}#promise-rejection`]: 2,
    [`${FILE}#result-literal`]: 2,
  });
});

test('the boundary file grows in the mechanisms it declares and in no other', () => {
  const boundary = 'packages/core/src/obs/effect.ts';
  const outcome = 'packages/core/src/tools/outcome.ts';
  const body = 'export const w = { ok: true, success: false }; export function f(): never { throw new Error("x"); }\n';
  const keysOf = (file: string) => measured(LEGACY, [[file, body]]).filter(({ key }) => key.startsWith(file));

  expect(keysOf(boundary)).toEqual([]);
  expect(keysOf(outcome)).toEqual([{ key: `${outcome}#throw`, value: 1 }]);
});
