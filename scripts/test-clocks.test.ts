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

import { auditCorpus, auditFile, CLOCK_KINDS, type ClockKind } from './test-clocks';
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

  test('the live corpus is the one sources.ts enumerates, and it is not empty', () => {
    const tests = readTests();

    expect(tests.size).toBeGreaterThan(100);
    // The census over the real tree runs, whatever it finds: a scan that
    // silently stopped parsing would be a clean report.
    expect(() => auditCorpus(tests)).not.toThrow();
  });
});
