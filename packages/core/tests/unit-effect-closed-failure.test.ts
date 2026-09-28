/**
 * `settle` is the one place an effect meets a Promise, and it accepts only `Effect<A, KinuError>`:
 * a string, a foreign tagged error, a plain `Error` or an unclassified `tryPromise` rejection would
 * reach callers with no class, and the classification every reader keys on would read `null`.
 * Compiles fixtures/effect-closed-failure with the repo's `tsc`: violations.ts must fail on each
 * marked line naming `KinuError`, allowed.ts must compile. Measured 2026-09-23, effect 4.0.0-rc.117.
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const repoRoot = join(here, '..', '..', '..');

const fixtureProject = join(here, 'fixtures', 'effect-closed-failure');

interface Diagnostic {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function compileFixtures() {
  const tsc = join(repoRoot, 'node_modules', '.bin', 'tsc');
  const run = spawnSync(tsc, ['--noEmit', '--pretty', 'false', '-p', fixtureProject], { cwd: repoRoot, encoding: 'utf8' });

  if (run.error) throw new Error(`could not run ${tsc}`, { cause: run.error });

  const diagnostics: Diagnostic[] = [];
  let current: Diagnostic | undefined;

  // A diagnostic's elaboration arrives on indented lines after it; it belongs to that diagnostic.
  for (const raw of `${run.stdout}${run.stderr}`.split('\n')) {
    const match = /^(.*?)\((\d+),\d+\): error (.*)$/u.exec(raw);

    if (match?.[1] && match[2] && match[3]) {
      current = { file: match[1], line: Number.parseInt(match[2], 10), text: match[3] };
      diagnostics.push(current);
    } else if (current !== undefined && raw.startsWith(' ')) {
      diagnostics[diagnostics.length - 1] = { ...current, text: `${current.text}\n${raw.trim()}` };
      current = diagnostics[diagnostics.length - 1];
    }
  }

  return { status: run.status ?? -1, diagnostics };
}

/** The line of the first statement after each `// [n]` marker. */
function markedLines(): ReadonlyMap<number, number> {
  const source = readFileSync(join(fixtureProject, 'violations.ts'), 'utf8').split('\n');
  const byCase = new Map<number, number>();

  for (const [index, text] of source.entries()) {
    const marker = /^\/\/ \[(\d+)\]/u.exec(text);

    if (marker?.[1]) byCase.set(Number.parseInt(marker[1], 10), index + 2);
  }

  return byCase;
}

const compiled = compileFixtures();

const violations = compiled.diagnostics.filter((d) => d.file.endsWith('violations.ts'));

const lines = markedLines();

describe('settle refuses an effect whose failure is not KinuError', () => {
  test('the fixture project fails to compile', () => {
    expect(compiled.status).not.toBe(0);
  });

  const cases: readonly (readonly [number, string])[] = [
    [1, 'a string failure'],
    [2, 'a tagged error that is not KinuError'],
    [3, 'a rejection left unclassified'],
    [4, 'a plain Error'],
  ];

  for (const [id, what] of cases) {
    test(`[${String(id)}] ${what} is rejected, naming KinuError`, () => {
      const reported = violations.filter((d) => d.line === lines.get(id));

      expect(reported.map((d) => d.text).join('\n')).toContain('KinuError');
    });
  }

  test('every marked case is asserted, and no unmarked line errors', () => {
    expect([...lines.keys()].sort((a, b) => a - b)).toEqual(cases.map(([id]) => id));
    const expected = new Set(lines.values());

    expect(violations.filter((d) => !expected.has(d.line)).map((d) => `${String(d.line)}: ${d.text}`)).toEqual([]);
  });

  test('the shapes product code uses compile', () => {
    expect(compiled.diagnostics.filter((d) => d.file.endsWith('allowed.ts')).map((d) => d.text)).toEqual([]);
  });
});
