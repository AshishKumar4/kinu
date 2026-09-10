import { describe, expect, test } from 'bun:test';
import { findViolations, keyOf, layerOf } from './core-layering';

const C = 'packages/core/src/';
const corpus = (files: Record<string, string>): Map<string, string> =>
  new Map(Object.entries(files).map(([f, t]) => [`${C}${f}`, t]));

describe('core-layering', () => {
  test('a root file and an unlisted directory are the harness', () => {
    expect(layerOf(`${C}chat.ts`)).toBe(2);
    expect(layerOf(`${C}newthing/x.ts`)).toBe(2);
    expect(layerOf(`${C}vfs/x.ts`)).toBe(0);
    expect(layerOf(`${C}tools/x.ts`)).toBe(1);
  });

  test('imports that point down are not findings', () => {
    const v = findViolations(corpus({
      'orchestrator/a.ts': "import { x } from '../vfs/b';\nimport { t } from '../tools/c';",
      'tools/c.ts': "import { x } from '../vfs/b';",
      'vfs/b.ts': 'export const x = 1;',
    }));
    expect(v).toEqual([]);
  });

  test('an upward value import is a value finding, keyed without its line', () => {
    const v = findViolations(corpus({
      'vfs/b.ts': "// moved\n\nimport { y } from '../orchestrator/a';",
      'orchestrator/a.ts': 'export const y = 1;',
    }));
    expect(v.map(keyOf)).toEqual([`${C}vfs/b.ts -> ${C}orchestrator/a.ts (value)`]);
    expect(v[0]?.line).toBe(3);
  });

  test('type-only imports are findings of their own kind, whichever spelling', () => {
    const v = findViolations(corpus({
      'types/a.ts': "import type { A } from '../heads/h';\nimport { type B } from '../mcts/m';\nexport type { C } from '../tools/t';",
      'heads/h.ts': 'export type A = 1;',
      'mcts/m.ts': 'export type B = 1;',
      'tools/t.ts': 'export type C = 1;',
    }));
    expect(v.map((x) => x.typeOnly)).toEqual([true, true, true]);
    expect(v.map(keyOf).every((k) => k.endsWith('(type)'))).toBe(true);
  });

  test('a mixed import is a value finding', () => {
    const v = findViolations(corpus({
      'events/e.ts': "import { type A, b } from '../prompting/p';",
      'prompting/p.ts': 'export type A = 1; export const b = 1;',
    }));
    expect(v.map((x) => x.typeOnly)).toEqual([false]);
  });

  test('a relative import naming no corpus file is fatal, never skipped', () => {
    expect(() => findViolations(corpus({ 'vfs/b.ts': "import { y } from '../gone/a';" })))
      .toThrow(/names no file in the corpus/);
  });
});
