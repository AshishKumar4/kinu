import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findDuplicateGroups } from './ast-duplication.ts';
import { classify, exportedDeclarations, inScope, keyOf } from './dead-code.ts';
import { assertMeasured, reconcile, writeLock } from './gate-ratchet.ts';

/** A body large enough to clear a real threshold, written twice with every
 *  identifier renamed. A text- or token-similarity tool matches on the names;
 *  this gate must not need them. */
const ORIGINAL = `
export function summarise(input: string): string {
  const trimmed = input.trim();
  const parts = trimmed.split(',');
  const kept: string[] = [];
  for (const part of parts) {
    if (part.length > 0) kept.push(part.toUpperCase());
  }
  return kept.join('|');
}
`;

const RENAMED = `
export function condense(raw: string): string {
  const clean = raw.trim();
  const chunks = clean.split(',');
  const keep: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length > 0) keep.push(chunk.toUpperCase());
  }
  return keep.join('|');
}
`;

/** Same shape as ORIGINAL, one literal changed. */
const RELITERALLED = ORIGINAL.replace("split(',')", "split(';')");

describe('ast duplication gate', () => {
  test('a copy with every identifier renamed is still one group', () => {
    const groups = findDuplicateGroups(new Map([
      ['packages/core/src/a.ts', ORIGINAL],
      ['packages/core/src/b.ts', RENAMED],
    ]), 25);
    expect(groups).toHaveLength(1);
    expect(groups[0].members.map((m) => `${m.file}#${m.name}`)).toEqual([
      'packages/core/src/a.ts#summarise',
      'packages/core/src/b.ts#condense',
    ]);
  });

  test('a body differing only by one literal is not a copy', () => {
    const groups = findDuplicateGroups(new Map([
      ['packages/core/src/a.ts', ORIGINAL],
      ['packages/core/src/b.ts', RELITERALLED],
    ]), 25);
    expect(groups).toEqual([]);
  });

  test('SQL inside a template literal is part of the identity', () => {
    const insert = (tail: string): string => `
      export function write(sql: Exec, row: Row): void {
        sql.exec(\`INSERT INTO t (a, b, c) VALUES (?, ?, ?)${tail}\`,
          row.a, row.b, row.c, row.a, row.b, row.c, row.a, row.b);
      }
    `;
    const groups = findDuplicateGroups(new Map([
      ['packages/core/src/a.ts', insert('')],
      ['packages/core/src/b.ts', insert(' ON CONFLICT(a) DO UPDATE SET b = excluded.b')],
    ]), 20);
    expect(groups).toEqual([]);
  });

  test('a duplicate below the threshold is not reported', () => {
    const groups = findDuplicateGroups(new Map([
      ['packages/core/src/a.ts', ORIGINAL],
      ['packages/core/src/b.ts', RENAMED],
    ]), 500);
    expect(groups).toEqual([]);
  });

  test('a copy across two packages is ranked as cross-package', () => {
    const groups = findDuplicateGroups(new Map([
      ['packages/core/src/a.ts', ORIGINAL],
      ['packages/cf-backend/src/b.ts', RENAMED],
      ['packages/cli/src/c.ts', ORIGINAL],
    ]), 25);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe('cross-package');
    expect(groups[0].members).toHaveLength(3);
  });

  test('a duplicate nested inside a duplicate is reported once, outermost', () => {
    const groups = findDuplicateGroups(new Map([
      ['packages/core/src/a.ts', ORIGINAL],
      ['packages/core/src/b.ts', RENAMED],
    ]), 5);
    expect(groups).toHaveLength(1);
    expect(groups[0].members.map((m) => m.name)).toEqual(['summarise', 'condense']);
  });

  test('an anonymous callback is reported under its owner and its call', () => {
    const component = (tail: string): string => `
      export function Panel(): unknown {
        const grow = useCallback(() => {
          const el = ref.current;
          if (!el) return;
          el.style.height = 'auto';
          el.style.height = \`\${el.scrollHeight}px\`;
          el.dataset.grown = 'yes';
        }, [value]);
        ${tail}
        return grow;
      }
    `;
    const groups = findDuplicateGroups(new Map([
      ['packages/cf-backend/src/a.tsx', component('log("a");')],
      ['packages/cf-backend/src/b.tsx', component('warn("b", 2);')],
    ]), 20);
    expect(groups).toHaveLength(1);
    expect(groups[0].members.map((m) => m.name)).toEqual([
      'grow > useCallback',
      'grow > useCallback',
    ]);
  });
});

describe('dead code gate', () => {
  test('a declaration is in scope whether exported inline or later', () => {
    const names = exportedDeclarations('packages/core/src/a.ts', `
      export function inline(): void {}
      function later(): void {}
      export { later };
      export const one = 1, two = 2;
      export interface Shape { a: string }
      const unexported = 3;
    `);
    expect([...names].sort()).toEqual(['Shape', 'inline', 'later', 'one', 'two']);
  });

  test('a re-export is not a declaration', () => {
    const names = exportedDeclarations('packages/core/src/index.ts', `
      import { local } from './other.js';
      export { computeParetoFront, sampleParentByWeight } from './pareto.js';
      export type { MergePair } from './merge.js';
      export * from './engine.js';
      export { local };
    `);
    expect([...names]).toEqual([]);
  });

  test('only-a-test references is a distinct verdict from no references', () => {
    const productionOnly = new Map([
      ['packages/cf-backend/src/user/capability.ts', [
        { name: 'setTier', line: 10 },
        { name: 'orphan', line: 20 },
      ]],
    ]);
    const everywhere = new Map([
      ['packages/cf-backend/src/user/capability.ts', [{ name: 'orphan', line: 20 }]],
    ]);
    const source = `
      export function setTier(): void {}
      export function orphan(): void {}
    `;
    expect(classify(productionOnly, everywhere, () => source).map(keyOf)).toEqual([
      'packages/cf-backend/src/user/capability.ts#orphan (unreferenced)',
      'packages/cf-backend/src/user/capability.ts#setTier (test-only)',
    ]);
  });

  test('test scaffolding and script entry points are out of scope', () => {
    const finding = [{ name: 'makeSqlExec', line: 1 }];
    const source = 'export function makeSqlExec(): void {}';
    const dead = classify(
      new Map([
        ['packages/core/tests/helpers.ts', finding],
        ['packages/test-utils/src/workspace-resolution.ts', finding],
        ['scripts/eval.ts', finding],
        ['tools/oxlint/anti-slop/shared/reflect-method.ts', finding],
      ]),
      new Map(),
      () => source,
    );
    expect(dead).toEqual([]);
  });

  test('scope is product source, and it is the same predicate for files', () => {
    expect(inScope('packages/core/src/config.ts')).toBe(true);
    expect(inScope('packages/cf-backend/src/pages/HomePage.tsx')).toBe(true);
    expect(inScope('packages/test-utils/src/workspace-resolution.ts')).toBe(false);
    expect(inScope('packages/core/tests/helpers.ts')).toBe(false);
    expect(inScope('scripts/eval.ts')).toBe(false);
  });
});

describe('gate ratchet', () => {
  // A module-level mkdtemp with no cleanup is how 388,700 inodes leaked out of
  // one other test file on this box. Same pattern as deploy.test.ts.
  const temporaryDirectories: string[] = [];
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  const lockPath = (keys: readonly string[]): string => {
    const directory = mkdtempSync(join(tmpdir(), 'proteus-ratchet-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'lock.json');
    writeFileSync(path, `${JSON.stringify(keys, null, 2)}\n`);
    return path;
  };

  test('a new violation is added and a fixed one goes stale', () => {
    const path = lockPath(['a', 'b']);
    expect(reconcile(['b', 'c'], path)).toEqual({ added: ['c'], stale: ['a'] });
  });

  test('an unchanged inventory reconciles empty', () => {
    const path = lockPath(['a', 'b']);
    expect(reconcile(['b', 'a'], path)).toEqual({ added: [], stale: [] });
  });

  test('a gate that scanned nothing dies instead of reporting a clean tree', () => {
    expect(() => assertMeasured('probe', [['source files', 0]]))
      .toThrow(/measured nothing \(source files is zero\)/);
    expect(() => assertMeasured('probe', [['files', 12], ['declarations', 0]]))
      .toThrow(/declarations is zero/);
  });

  test('a measured gate reports every denominator it counted', () => {
    expect(assertMeasured('probe', [['source files', 587], ['function bodies', 5818]]))
      .toBe('587 source files, 5818 function bodies');
  });

  test('the lock is written sorted and deduplicated', () => {
    const path = lockPath([]);
    expect(writeLock(['b', 'a', 'b'], path)).toBe(2);
    expect(reconcile(['a', 'b'], path)).toEqual({ added: [], stale: [] });
  });

  test('a lock that is not a list of strings is rejected, not ignored', () => {
    const path = lockPath([]);
    writeFileSync(path, '{"a":1}');
    expect(() => reconcile([], path)).toThrow();
  });
});
