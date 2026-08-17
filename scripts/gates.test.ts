import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findDuplicateGroups } from './ast-duplication.ts';
import { findMovable, withoutComments } from './capability-parity.ts';
import { classify, exportedDeclarations, inScope, keyOf } from './dead-code.ts';
import { assertMeasured, reconcile, writeLock } from './gate-ratchet.ts';
import { configuredScanner, judgeAdvisories } from './dependency-advisory-gate.ts';
import {
  advisoriesFor, queryAdvisories, type Exposure, type ReviewedPackage,
} from './security-scanner.ts';

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

describe('capability parity gate', () => {
  /* `findMovable` reads each package's real tsconfig for its path aliases, so
     these synthetic files sit at real package paths. That is deliberate: the
     alias table is the part most likely to rot, and a fixture that stubbed it
     would keep passing after `@/*` was renamed while the gate stopped seeing
     two thirds of cf-backend. */
  const shared = new Map([
    ['packages/core/src/index.ts', "import * as v from 'valibot';\nexport const x = v.string();\n"],
  ]);
  const withShared = (files: Record<string, string>): Map<string, string> =>
    new Map([...shared, ...Object.entries(files)]);

  test('a backend module importing only what core imports is reported movable', () => {
    const { movable } = findMovable(withShared({
      'packages/cf-backend/src/components/summary.ts':
        "import * as v from 'valibot';\nexport const s = v.string();\n",
    }));
    expect(movable.map((m) => m.file)).toEqual(['packages/cf-backend/src/components/summary.ts']);
    expect(movable[0].closure).toBe('cf');
  });

  test('the same module is silent once it lives in a shared package', () => {
    const { movable } = findMovable(withShared({
      'packages/core/src/summary.ts': "import * as v from 'valibot';\nexport const s = v.string();\n",
    }));
    expect(movable).toEqual([]);
  });

  test('a platform import pins the module where it is', () => {
    const { movable } = findMovable(withShared({
      'packages/cf-backend/src/do.ts': "import { Agent } from 'agents';\nexport const a = Agent;\n",
    }));
    expect(movable).toEqual([]);
  });

  test('the block is transitive: a pure module importing a platform one stays put', () => {
    const { movable } = findMovable(withShared({
      'packages/cf-backend/src/do.ts': "import { Agent } from 'agents';\nexport const a = Agent;\n",
      'packages/cf-backend/src/pure.ts': "import { a } from './do.ts';\nexport const b = a;\n",
    }));
    expect(movable).toEqual([]);
  });

  test("the allowlist is derived: a library core does not use is a blocker", () => {
    const files = {
      'packages/cf-backend/src/pure.ts': "import { z } from 'zod';\nexport const s = z.string();\n",
    };
    expect(findMovable(withShared(files)).movable).toEqual([]);
    // core takes the same dependency, and the same file becomes movable — with
    // nothing about the gate edited.
    const widened = new Map(withShared(files));
    widened.set('packages/core/src/index.ts', "import { z } from 'zod';\nexport const q = z.number();\n");
    expect(findMovable(widened).movable.map((m) => m.file)).toEqual(['packages/cf-backend/src/pure.ts']);
  });

  test('a stylesheet is a real dependency a shared package cannot take', () => {
    const { movable } = findMovable(withShared({
      'packages/cf-backend/src/styled.ts': "import './theme.css';\nexport const s = 1;\n",
    }));
    expect(movable).toEqual([]);
  });

  test('an intra-package import resolving to nothing is fatal, never a pass', () => {
    // The silent version of this reports the importer as dependency-free, which
    // is the shape that turns a resolver bug into a wider finding set.
    expect(() => findMovable(withShared({
      'packages/cf-backend/src/broken.ts': "import { y } from './gone.ts';\nexport const z = y;\n",
    }))).toThrow(/resolves to no tracked source file/);
  });

  test("the `@/` alias resolves, so an aliased platform import still blocks", () => {
    const { movable } = findMovable(withShared({
      'packages/cf-backend/src/do.ts': "import { Agent } from 'agents';\nexport const a = Agent;\n",
      'packages/cf-backend/src/uses.ts': "import { a } from '@/do';\nexport const b = a;\n",
    }));
    expect(movable).toEqual([]);
  });

  test('the resolver reports how many edges it resolved, so a broken one is visible', () => {
    const { edges } = findMovable(withShared({
      'packages/cf-backend/src/a.ts': "export const a = 1;\n",
      'packages/cf-backend/src/b.ts': "import { a } from './a.ts';\nexport const b = a;\n",
    }));
    expect(edges).toBeGreaterThan(0);
  });

  test('a tsconfig with comments is read, because tsconfig is JSONC', () => {
    // Measured: one `//` line added to packages/cf-backend/tsconfig.json took
    // eight tests in this file down with `Unrecognized token '/'`, and not one
    // failure name mentioned tsconfig. The alias table is only reachable
    // through that parse, so the failure mode is total.
    expect(withoutComments('{ // note\n "a": "http://x", /* b */ "c": "\\"//\\"" }'))
      .toBe('{ \n "a": "http://x",  "c": "\\"//\\"" }');
    expect(JSON.parse(withoutComments('{ // note\n "a": 1 }\n'))).toEqual({ a: 1 });
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

describe('dependency advisory gate', () => {
  const exposure = (over: Partial<Exposure> = {}): Exposure => ({
    pkg: 'valibot',
    version: '1.4.1',
    id: 1124298,
    severity: 'moderate',
    title: 'record() issue paths can make flatten() throw',
    url: 'https://github.com/advisories/GHSA-5qjj-4xww-7phc',
    range: '<=1.4.1',
    ...over,
  });
  const reviewed = {
    valibot: { reason: 'flatten() is called nowhere in tracked source', ids: [1124298] },
  } satisfies Record<string, ReviewedPackage>;

  test('an exposure the reviewed set accounts for is accepted, not reported', () => {
    expect(judgeAdvisories([exposure()], reviewed))
      .toEqual({ findings: [], accepted: 1 });
  });

  test('an advisory against a package nobody reviewed fails the gate', () => {
    const { findings, accepted } = judgeAdvisories(
      [exposure(), exposure({ pkg: 'left-pad' })],
      reviewed,
    );
    expect(accepted).toBe(1);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.at).toBe('left-pad@1.4.1 — advisory 1124298');
    expect(findings[0]?.rendered).toContain('never reviewed');
  });

  // The case a per-package acceptance would swallow: the package is known, the
  // vulnerability is not.
  test('a NEW advisory against an already-reviewed package fails the gate', () => {
    const { findings, accepted } = judgeAdvisories(
      [exposure(), exposure({ id: 9999999 })],
      reviewed,
    );
    expect(accepted).toBe(1);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rendered).toContain('gained a new one');
  });

  test('a recorded advisory that stopped reproducing fails the gate too', () => {
    const { findings } = judgeAdvisories([], reviewed);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.at).toBe('valibot — advisory 1124298');
    expect(findings[0]?.rendered).toContain('no matching advisory at all');
  });


  test('only a scanner under [install.security] counts as wired', () => {
    expect(configuredScanner('[install.security]\nscanner = "./scripts/security-scanner.ts"\n'))
      .toBe('./scripts/security-scanner.ts');
    // A `scanner` key in the wrong table configures nothing, and reading it as
    // wired would certify a scan bun never performs.
    expect(configuredScanner('[install]\nscanner = "./scripts/security-scanner.ts"\n'))
      .toBeUndefined();
    expect(configuredScanner('[install]\nlinker = "hoisted"\n')).toBeUndefined();
  });

  const onePackage = [{
    name: 'valibot',
    version: '1.4.1',
    requestedRange: '^1.4.1',
    tarball: 'https://registry.npmjs.org/valibot/-/valibot-1.4.1.tgz',
  }];

  // The whole offline contract. 127.0.0.1:1 refuses instantly, so this is
  // deterministic and needs no network.
  test('a feed that does not answer is unreachable, never a clean scan', async () => {
    const scan = await queryAdvisories(onePackage, 'http://127.0.0.1:1/bulk');
    expect(scan.status).toBe('unreachable');
    if (scan.status !== 'unreachable') throw new Error('unreachable expected');
    expect(scan.reason).toBe('io');
    expect(scan.error.length).toBeGreaterThan(0);
    expect(scan.scanned).toBe(1);
  });

  test('an unreachable feed yields a warn advisory, never an empty list', () => {
    const advisories = advisoriesFor({
      status: 'unreachable', scanned: 1288, reason: 'io', error: 'ConnectionRefused',
    });
    expect(advisories).toHaveLength(1);
    expect(advisories[0]?.level).toBe('warn');
    expect(advisories[0]?.description).toContain('were NOT checked');
  });

  test('a feed answering an unreadable shape is unreachable, not empty', async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ valibot: 'nope' }) });
    try {
      const scan = await queryAdvisories(onePackage, server.url.href);
      expect(scan.status).toBe('unreachable');
      if (scan.status !== 'unreachable') throw new Error('unreachable expected');
      expect(scan.reason).toBe('unreadable');
    } finally {
      await server.stop(true);
    }
  });

  test('a feed answering HTTP 500 is unreachable, not empty', async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response('nope', { status: 500 }) });
    try {
      const scan = await queryAdvisories(onePackage, server.url.href);
      expect(scan.status).toBe('unreachable');
      if (scan.status !== 'unreachable') throw new Error('unreachable expected');
      expect(scan.error).toContain('500');
    } finally {
      await server.stop(true);
    }
  });

  // The feed answers per NAME once any submitted version matches, so attributing
  // an advisory to the version that actually matches is the scanner's job. Both
  // hono copies are asked about; only 4.12.23 is vulnerable.
  test('an advisory is attributed only to the versions its range matches', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({
        hono: [{
          id: 1123999,
          url: 'https://github.com/advisories/x',
          title: 'CORS middleware reflects any Origin',
          severity: 'high',
          vulnerable_versions: '<4.12.25',
        }],
      }),
    });
    try {
      const scan = await queryAdvisories([
        { name: 'hono', version: '4.12.23', requestedRange: '^4.11.4', tarball: 'a' },
        { name: 'hono', version: '4.13.2', requestedRange: '^4.13.0', tarball: 'b' },
      ], server.url.href);
      expect(scan.status).toBe('reported');
      if (scan.status !== 'reported') throw new Error('reported expected');
      expect(scan.exposures.map((each) => each.version)).toEqual(['4.12.23']);
    } finally {
      await server.stop(true);
    }
  });

  test('a feed that matches nothing is a clean scan, distinguishable from an outage', async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({}) });
    try {
      const scan = await queryAdvisories(onePackage, server.url.href);
      expect(scan).toEqual({ status: 'reported', scanned: 1, exposures: [] });
    } finally {
      await server.stop(true);
    }
  });
});
