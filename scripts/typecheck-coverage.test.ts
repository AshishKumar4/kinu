/**
 * The typecheck-coverage gate's own logic, plus the assertion that it is not
 * currently lying about this tree.
 *
 * The gate exists because the root `tests/` directory was typechecked by
 * nothing, and four suites rotted against deleted APIs for months without a
 * single signal. Its own decision boundary therefore has to be tested — a gate
 * built to catch an invisible omission is worthless if its parse quietly returns
 * an empty list.
 */
import { describe, test, expect } from 'bun:test';
import {
  checkedProjects, coveredPrefixes, testDirectories, UNTYPECHECKED_TEST_DIRS,
} from './typecheck-coverage';

describe('checkedProjects', () => {
  test('follows `bun run <script>` transitively', () => {
    // `check` runs `lint`, which runs `test:anti-slop`, which is the ONLY thing
    // that typechecks tools/oxlint/anti-slop. A parse stopping at `check`'s own
    // text would demand an exclusion for a directory that is in fact covered —
    // a gate lying in the safe direction, which still trains people to silence
    // it with exclusions.
    const projects = checkedProjects(JSON.stringify({
      scripts: {
        check: 'bun run lint && tsc --noEmit -p packages/core',
        lint: 'bun run test:anti-slop && oxlint',
        'test:anti-slop': 'tsc --noEmit -p tools/oxlint/anti-slop && node x.ts',
      },
    }));
    expect(projects).toEqual(['packages/core', 'tools/oxlint/anti-slop']);
  });

  test('terminates on a cyclic script reference instead of hanging', () => {
    const projects = checkedProjects(JSON.stringify({
      scripts: { check: 'bun run a', a: 'bun run b', b: 'bun run a && tsc --noEmit -p pkg' },
    }));
    expect(projects).toEqual(['pkg']);
  });

  test('a `check` script with no projects parses to an empty list, which the gate treats as fatal', () => {
    // Not an assertion that this is acceptable — the opposite. The gate calls
    // assertMeasured on this count, so an empty parse kills the run rather than
    // reporting a clean tree.
    expect(checkedProjects(JSON.stringify({ scripts: { check: 'echo hi' } }))).toEqual([]);
  });
});

describe('coveredPrefixes', () => {
  test('resolves include patterns relative to the tsconfig, and truncates at the first glob', () => {
    // `include: ["**/*.ts"]` on tests/tsconfig.json must cover `tests` itself,
    // not the literal string `tests/**/*.ts`.
    expect(coveredPrefixes('tests')).toEqual(['tests']);
  });

  test('a package with src and tests covers both', () => {
    expect(coveredPrefixes('packages/test-utils')).toEqual([
      'packages/test-utils/src', 'packages/test-utils/tests',
    ]);
  });
});

describe('testDirectories', () => {
  test('finds a non-empty corpus, so the comparison is never vacuous', () => {
    const dirs = testDirectories();
    expect(dirs.length).toBeGreaterThan(0);
    // The two directories whose omission this gate was built for.
    expect(dirs).toContain('tests');
    expect(dirs).toContain('tests/evals');
  });

  test('does not walk gitignored reference clones or node_modules', () => {
    const dirs = testDirectories();
    for (const dir of dirs) {
      expect(dir.includes('node_modules')).toBe(false);
      expect(dir.startsWith('external')).toBe(false);
    }
  });
});

describe('this tree', () => {
  test('every directory holding a test file is covered by a project `check` runs', () => {
    // The gate's verdict, asserted here as well as in the gate, so `bun test
    // scripts/` fails on a new uncovered folder even where nobody ran the gate.
    const dirs = testDirectories();
    const prefixes = checkedProjects().flatMap(coveredPrefixes);
    const uncovered = dirs.filter((dir) => !UNTYPECHECKED_TEST_DIRS.has(dir)
      && !prefixes.some((prefix) => dir === prefix || dir.startsWith(`${prefix}/`)));
    expect(uncovered).toEqual([]);
  });

  test('the declared-exclusion list holds nothing stale', () => {
    const dirs = testDirectories();
    const stale = [...UNTYPECHECKED_TEST_DIRS.keys()].filter((dir) => !dirs.includes(dir));
    expect(stale).toEqual([]);
  });

  test('`check` includes the root tests project', () => {
    // The fix is not the tsconfig existing; it is `check` running it. A tsconfig
    // nobody runs is the same artifact class as a gate nobody invokes.
    expect(checkedProjects()).toContain('tests');
  });
});
