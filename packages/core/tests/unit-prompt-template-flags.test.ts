/**
 * The typed-conditional contract, red-proven.
 *
 * `{{#if}}` was deliberately absent from `prompting/template.ts` for one reason,
 * written into its own docstring: an untyped template conditional "is an untyped
 * string lookup that renders empty when it misses — the failure mode that already
 * left two mode overlays dead in the live prompt." The conditional exists now
 * because a flag is a DECLARED boolean slot, so the miss is a compile error.
 *
 * That claim is worth exactly what the compiler enforces, so this suite runs the
 * SAME `tsc` the gate runs (`bun run check`) over a project of two fixtures and
 * reads the diagnostics:
 *
 *   fixtures/template-flags/violations.ts   seven ways to render the wrong bytes,
 *                                           each of which MUST fail to compile
 *                                           with a diagnostic naming the slot
 *   fixtures/template-flags/allowed.ts      the ordinary calls, which MUST
 *                                           compile — the false-positive guard
 *                                           over an intersection contract, which
 *                                           is easy to write too strictly
 *
 * Modelled on `unit-obs-log-ban.test.ts`, deliberately including its refusal to
 * use `@ts-expect-error`: that directive proves an error exists somewhere on the
 * next line and never says WHICH, so a fixture built from it keeps passing when
 * the contract breaks and a typo takes its place.
 */

import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const fixtureProject = join(here, 'fixtures', 'template-flags');

interface Diagnostic {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/** What one `tsc` run over the fixture project reported. */
interface CompileReport {
  readonly status: number;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * `tsc --noEmit` over the fixture project, parsed into diagnostics.
 *
 * The compiler is invoked through the repo's own `node_modules/.bin/tsc`, the
 * same binary `bun run check` uses, so this cannot pass against a compiler the
 * gate does not run. An assignability error reports its reason on INDENTED
 * continuation lines — which is where the slot name lives — so those are folded
 * into the diagnostic they belong to rather than dropped.
 */
function compileFixtures(): CompileReport {
  const tsc = join(repoRoot, 'node_modules', '.bin', 'tsc');
  const run = spawnSync(tsc, ['--noEmit', '--pretty', 'false', '-p', fixtureProject], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (run.error) throw new Error(`could not run ${tsc}`, { cause: run.error });
  const diagnostics: Diagnostic[] = [];
  for (const raw of `${run.stdout}${run.stderr}`.split('\n')) {
    const match = /^(.*?)\((\d+),\d+\): error (.*)$/u.exec(raw);
    if (match?.[1] && match[2] && match[3]) {
      diagnostics.push({ file: match[1], line: Number.parseInt(match[2], 10), text: match[3] });
      continue;
    }
    const previous = diagnostics.at(-1);
    if (previous && raw.startsWith('  ')) {
      diagnostics[diagnostics.length - 1] = { ...previous, text: `${previous.text}\n${raw.trim()}` };
    }
  }
  return { status: run.status ?? -1, diagnostics };
}

/** Line numbers are read from the fixture's own `[N]` markers, so renumbering
 *  the file cannot silently detach an assertion from the line it is about. */
function markedLines(file: string): ReadonlyMap<number, number> {
  const source = readFileSync(join(fixtureProject, file), 'utf8').split('\n');
  const byCase = new Map<number, number>();
  source.forEach((text, index) => {
    const marker = /^\/\/ \[(\d+)\]/u.exec(text);
    if (!marker?.[1]) return;
    let cursor = index + 1;
    while (cursor < source.length && source[cursor]?.trimStart().startsWith('//')) cursor += 1;
    byCase.set(Number.parseInt(marker[1], 10), cursor + 1);
  });
  return byCase;
}

const compiled = compileFixtures();

describe('a prompt section rendered with the wrong flags does not compile', () => {
  test('the fixture project fails to compile at all', () => {
    // The precondition for everything below. A zero exit here would mean the
    // contract is gone and every per-case assertion is reading an empty list.
    expect(compiled.status).not.toBe(0);
    expect(compiled.diagnostics.length).toBeGreaterThan(0);
  });

  /**
   * Every misuse, with the text the diagnostic must carry. A test that only
   * asserted "line N errors" would pass on a typo; naming the slot asserts it is
   * THIS contract that fired.
   */
  const cases: readonly (readonly [number, string, string])[] = [
    [1, 'an undeclared flag', "'hasSandbox' does not exist in type"],
    [2, 'a declared flag omitted', "Property 'hasShell' is missing"],
    [3, 'a flag given a string', "Type 'string' is not assignable to type 'boolean'"],
    [4, 'a text slot given a boolean', "Type 'boolean' is not assignable to type 'string'"],
    [5, 'a declared text slot omitted', "Property 'shellNote' is missing"],
    [6, 'an undeclared text slot', "'footer' does not exist in type"],
    [7, 'a promoted replacement rendered off-contract', "Property 'shellNote' is missing"],
  ];

  const violations = compiled.diagnostics.filter((d) => d.file.endsWith('violations.ts'));
  const lines = markedLines('violations.ts');

  for (const [id, what, marker] of cases) {
    test(`[${String(id)}] ${what} — rejected, naming ${marker}`, () => {
      const line = lines.get(id);
      expect(line).toBeDefined();
      const reported = violations.filter((d) => d.line === line);
      expect(reported.length).toBeGreaterThan(0);
      expect(reported.map((d) => d.text).join('\n')).toContain(marker);
    });
  }

  test('every marked case is covered, and nothing else in the fixture errors', () => {
    // Two directions. A misuse the fixture documents and this suite forgot to
    // assert would be a silent gap; a diagnostic on an UNMARKED line means the
    // fixture has an ordinary mistake in it and one of the assertions above may
    // be passing for the wrong reason.
    expect([...lines.keys()].sort((a, b) => a - b)).toEqual(cases.map(([id]) => id));
    const expected = new Set(lines.values());
    const stray = violations.filter((d) => !expected.has(d.line));
    expect(stray.map((d) => `${String(d.line)}: ${d.text}`)).toEqual([]);
  });

  test('the ordinary calls compile', () => {
    // Not a formality. `TemplateSlots` is an INTERSECTION of a string map and a
    // boolean map, and the shapes that break such a contract are exactly the
    // ordinary ones: a slot object held in a variable, a flag from a comparison,
    // a section whose contract is only flags or only slots, an empty-string value.
    const allowed = compiled.diagnostics.filter((d) => d.file.endsWith('allowed.ts'));
    expect(allowed.map((d) => `${String(d.line)}: ${d.text}`)).toEqual([]);
  });
});
