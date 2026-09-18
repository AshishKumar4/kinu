/**
 * The test-clock gate's own decision boundary: every kind it claims, proved
 * red on the shape as it appeared in this tree and green on the repair, plus
 * the runner side it relies on.
 *
 * Fixtures live in `scripts/fixtures/test-clocks/red/` and `green/` as files
 * rather than strings, so a shape is a thing on disk a reader can open and
 * `bun build` can parse. Every red fixture must produce exactly the kinds its
 * name promises, and every green fixture none: a gate that fires on the
 * defect AND on its repair has no green state to reach.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { LADDER } from './ladder';
import {
  auditCorpus, auditFile, CLOCK_KINDS, readClockCorpus, readLock, reconcileLock, tally, writeShrinkingLock,
  type ClockKind, type ClockSite,
} from './test-clocks';
import { scratchDir } from '@kinu.run/test-utils';
import { readTests } from './sources';

const FIXTURES = join(import.meta.dir, 'fixtures', 'test-clocks');

/** `<kind>[+<kind>].<name>.test.ts` under `red/` promises exactly those kinds. */
function promisedKinds(name: string): readonly ClockKind[] {
  const [head] = name.split('.');

  return (head ?? '').split('+').map((kind) => {
    const known = CLOCK_KINDS.find((claimed) => claimed === kind);

    if (known === undefined) throw new Error(`${name}: ${kind} is not a kind this gate claims`);

    return known;
  });
}

function fixtures(direction: 'red' | 'green'): readonly (readonly [string, string])[] {
  const dir = join(FIXTURES, direction);

  return readdirSync(dir).sort().map((name) => [name, readFileSync(join(dir, name), 'utf8')] as const);
}

describe('test-clocks gate', () => {
  test('every claimed kind has at least one red fixture', () => {
    const covered = new Set(fixtures('red').flatMap(([name]) => promisedKinds(name)));

    expect([...covered].sort()).toEqual([...CLOCK_KINDS].sort());
  });

  test.each(fixtures('red'))('red: %s is refused for exactly the kinds it names', (name, text) => {
    const found = auditFile(`packages/core/tests/${name}`, text).map((site) => site.kind);

    expect(found.length).toBeGreaterThan(0);
    expect([...new Set(found)].sort()).toEqual([...new Set(promisedKinds(name))].sort());
  });

  test.each(fixtures('green'))('green: %s is accepted', (name, text) => {
    expect(auditFile(`packages/core/tests/${name}`, text)).toEqual([]);
  });

  test('a site is reported with its file, line and first source line', () => {
    const [site] = auditFile('packages/core/tests/x.test.ts', 'const a = 1;\nawait new Promise((r) => setTimeout(r, 50));\n');

    expect(site).toEqual({
      file: 'packages/core/tests/x.test.ts', line: 2, kind: 'sleep', text: 'setTimeout(r, 50)',
    });
  });

  test('the runner side is pinned: bun and every vitest config run with no per-test clock', () => {
    const preload = readFileSync(join(import.meta.dir, 'test-preload.ts'), 'utf8');

    expect(preload).toContain('setDefaultTimeout(0)');

    for (const config of [
      'vitest.evals.config.ts', 'vitest.first-run.config.ts',
      'packages/cf-backend/vitest.config.ts', 'packages/devbox/vitest.config.ts',
    ]) {
      const text = readFileSync(join(import.meta.dir, '..', config), 'utf8');

      expect(text, config).toMatch(/testTimeout: 0\b/u);
      expect(text, config).toMatch(/hookTimeout: 0\b/u);
    }
  });

  test('every bun test row on the ladder runs with the per-test clock off', () => {
    // A preload's `setDefaultTimeout(0)` reaches the first file of a run only
    // (measured 2026-09-15 on bun 1.4.0: the second of two files timed out at
    // 5000 ms under it), so the flag on the invocation is the switch that
    // covers every file, and the rows are where the deploy's invocations live.
    const rows = LADDER.filter((row) => row.run.startsWith('bun test '));

    expect(rows.length).toBeGreaterThan(10);

    for (const row of rows) expect(row.run, row.label).toContain('bun test --timeout=0 ');
  });

  describe('the shrink-only lock', () => {
    const site = (file: string, kind: ClockKind, line = 1): ClockSite => ({ file, kind, line, text: kind });

    const locked = tally([
      site('packages/core/tests/a.test.ts', 'sleep'),
      site('packages/core/tests/a.test.ts', 'sleep', 2),
      site('packages/core/tests/b.test.ts', 'clock-compare'),
    ], '2026-09-15');

    test('the tree as locked is green', () => {
      expect(reconcileLock(locked, locked)).toEqual({ unlocked: [], raised: [], stale: [] });
    });

    test('red: a site in a file the lock does not name', () => {
      const current = tally([
        site('packages/core/tests/a.test.ts', 'sleep'), site('packages/core/tests/a.test.ts', 'sleep', 2),
        site('packages/core/tests/b.test.ts', 'clock-compare'),
        site('packages/core/tests/c.test.ts', 'test-timeout'),
      ], '2026-09-16');

      expect(reconcileLock(current, locked).unlocked).toEqual(['packages/core/tests/c.test.ts']);
    });

    test('red: a count above the locked count, per kind', () => {
      const current = tally([
        site('packages/core/tests/a.test.ts', 'sleep'), site('packages/core/tests/a.test.ts', 'sleep', 2),
        site('packages/core/tests/a.test.ts', 'sleep', 3),
        site('packages/core/tests/b.test.ts', 'clock-compare'),
      ], '2026-09-16');

      expect(reconcileLock(current, locked).raised).toEqual(['packages/core/tests/a.test.ts [sleep]: 3 > 2']);
      expect(reconcileLock(current, locked).unlocked).toEqual([]);
    });

    test('red: a paid-down count no longer reproduces the lock, so the lock is rewritten', () => {
      const current = tally([site('packages/core/tests/a.test.ts', 'sleep')], '2026-09-16');

      expect(reconcileLock(current, locked).stale).toEqual([
        'packages/core/tests/a.test.ts [sleep]: 1 < 2',
        'packages/core/tests/b.test.ts: no longer holds a site',
      ]);
    });

    test('--lock refuses to raise the total and records a pay-down', () => {
      const path = join(scratchDir('test-clocks-lock'), 'test-clocks.lock.json');
      writeShrinkingLock(locked, path);
      expect(readLock(path).total).toBe(3);

      const raised = tally([
        site('packages/core/tests/a.test.ts', 'sleep'), site('packages/core/tests/a.test.ts', 'sleep', 2),
        site('packages/core/tests/b.test.ts', 'clock-compare'), site('packages/core/tests/b.test.ts', 'sleep'),
      ], '2026-09-16');

      expect(() => writeShrinkingLock(raised, path)).toThrow(/refusing to raise the lock from 3 to 4/u);
      expect(readLock(path).total).toBe(3);

      const paidDown = tally([site('packages/core/tests/a.test.ts', 'sleep')], '2026-09-16');
      writeShrinkingLock(paidDown, path);
      expect(readLock(path)).toEqual(paidDown);
    });

    test('--lock refuses an equal total that moved a site, per file and kind', () => {
      const path = join(scratchDir('test-clocks-lock-move'), 'test-clocks.lock.json');
      writeShrinkingLock(locked, path);

      // Three sites, three sites: one sleep left a.test.ts and a sleep
      // arrived in b.test.ts — a new site the gate refuses, laundered by
      // the total alone.
      const moved = tally([
        site('packages/core/tests/a.test.ts', 'sleep'),
        site('packages/core/tests/b.test.ts', 'clock-compare'), site('packages/core/tests/b.test.ts', 'sleep'),
      ], '2026-09-16');

      expect(() => writeShrinkingLock(moved, path)).toThrow(/packages\/core\/tests\/b\.test\.ts \[sleep\]: 1 > 0/u);

      // And a new file arriving as another is paid down, equal total.
      const arrived = tally([
        site('packages/core/tests/a.test.ts', 'sleep'), site('packages/core/tests/a.test.ts', 'sleep', 2),
        site('packages/core/tests/c.test.ts', 'clock-compare'),
      ], '2026-09-16');

      expect(() => writeShrinkingLock(arrived, path)).toThrow(/adds a site: packages\/core\/tests\/c\.test\.ts/u);
      expect(readLock(path)).toEqual(locked);
    });

    test('a moved file is re-keyed on the path half with its counts byte-identical', () => {
      const moved = tally([
        site('packages/core/tests/moved/a.test.ts', 'sleep'), site('packages/core/tests/moved/a.test.ts', 'sleep', 2),
        site('packages/core/tests/b.test.ts', 'clock-compare'),
      ], '2026-09-16');

      expect(moved.files['packages/core/tests/moved/a.test.ts']).toEqual(locked.files['packages/core/tests/a.test.ts']);
      expect(moved.total).toBe(locked.total);
    });

    test('the live lock reproduces the tree', () => {
      const current = tally(auditCorpus(readClockCorpus()), '2026-09-16');

      expect(reconcileLock(current, readLock())).toEqual({ unlocked: [], raised: [], stale: [] });
    });
  });

  test('the live corpus is every test sources.ts enumerates plus the helpers tests wait through', () => {
    const tests = readTests();
    const corpus = readClockCorpus();

    expect(tests.size).toBeGreaterThan(100);
    // The helpers are inside the corpus: a wait moved into test-utils or the
    // browser harness is read where it is written.
    expect(corpus.size).toBeGreaterThan(tests.size);
    expect(corpus.has('scripts/gallery-harness.ts')).toBe(true);
    expect([...corpus.keys()].some((file) => file.startsWith('packages/test-utils/src/'))).toBe(true);
    // The census over the real tree runs, whatever it finds: a scan that
    // silently stopped parsing would be a clean report.
    expect(() => auditCorpus(tests)).not.toThrow();
  });
});
