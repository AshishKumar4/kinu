import { describe, expect, test } from 'bun:test';
import { findViolations, keyOf, layerOf } from './core-layering';

const C = 'packages/core/src/';

const corpus = (files: Record<string, string>): Map<string, string> =>
  new Map(Object.entries(files).map(([f, t]) => [`${C}${f}`, t]));

describe('core-layering', () => {
  /** Which layer a path lands in, by directory and by root file name. */
  const placements = [
    {
      name: 'an unlisted directory is the harness',
      files: [['newthing/x.ts', 2], ['vfs/x.ts', 0], ['tools/x.ts', 1]],
    },
    {
      name: 'a root file is placed by name, and an unlisted one is the harness',
      files: [['llm.ts', 0], ['platform-catalog.ts', 0], ['chat.ts', 2]],
    },
  ] as const;

  for (const placement of placements) {
    test(placement.name, () => {
      for (const [file, layer] of placement.files) {
        expect(layerOf(`${C}${file}`), file).toBe(layer);
      }
    });
  }

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

  test('only a declaration-level type import is erased; a specifier-level one still loads', () => {
    const v = findViolations(corpus({
      'types/a.ts': "import type { A } from '../heads/h';\nimport { type B } from '../mcts/m';\nexport type { C } from '../tools/t';",
      'heads/h.ts': 'export type A = 1;',
      'mcts/m.ts': 'export type B = 1;',
      'tools/t.ts': 'export type C = 1;',
    }));

    expect(v.map((x) => [x.to.slice(C.length), x.typeOnly])).toEqual([['heads/h.ts', true], ['mcts/m.ts', false], ['tools/t.ts', true]]);
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

  test('text modules retain their layer boundary without parsing prose as code', () => {
    const sources = corpus({
      'vfs/a.ts': 'import text from "../prompts/role.md" with { type: "text" };',
      'prompts/role.md': '## Instructions\nUse the declared tools.',
    });

    expect(findViolations(sources).map(keyOf)).toEqual([
      `${C}vfs/a.ts -> ${C}prompts/role.md (value)`,
    ]);
    sources.delete(`${C}prompts/role.md`);
    expect(() => findViolations(sources)).toThrow('names no file in the corpus');
  });
});
