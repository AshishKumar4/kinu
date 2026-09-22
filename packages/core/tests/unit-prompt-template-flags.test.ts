/**
 * Typed `{{#if}}` flags, red-proven: runs the gate's `tsc` over fixtures/template-flags, where
 * violations.ts must fail naming the slot and allowed.ts must compile. Deliberately no
 * `@ts-expect-error`: it never says which error fired.
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
 * `tsc --noEmit` via the repo's own binary. Indented continuation lines carry the slot name, so
 * they fold into their diagnostic.
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

/** Lines come from the fixture's `[N]` markers, so renumbering cannot detach an assertion. */
function markedLines(file: string): ReadonlyMap<number, number> {
  const source = readFileSync(join(fixtureProject, file), 'utf8').split('\n');
  const byCase = new Map<number, number>();

  for (const [index, text] of source.entries()) {
    const marker = /^\/\/ \[(\d+)\]/u.exec(text);

    if (!marker?.[1]) continue;
    let cursor = index + 1;

    while (cursor < source.length && source[cursor]?.trimStart().startsWith('//')) cursor += 1;
    byCase.set(Number.parseInt(marker[1], 10), cursor + 1);
  }

  return byCase;
}

const compiled = compileFixtures();

describe('a prompt section rendered with the wrong flags does not compile', () => {
  test('the fixture project fails to compile at all', () => {
    // A zero exit would mean the contract is gone and every assertion below reads an empty list.
    expect(compiled.status).not.toBe(0);
    expect(compiled.diagnostics.length).toBeGreaterThan(0);
  });

  /** Each misuse with the slot its diagnostic must name, so a typo cannot pass as this contract. */
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
    // Both directions: an unasserted documented misuse, or a diagnostic on an unmarked line, fails.
    expect([...lines.keys()].sort((a, b) => a - b)).toEqual(cases.map(([id]) => id));
    const expected = new Set(lines.values());
    const stray = violations.filter((d) => !expected.has(d.line));
    expect(stray.map((d) => `${String(d.line)}: ${d.text}`)).toEqual([]);
  });

  test('the ordinary calls compile', () => {
    // TemplateSlots intersects a string map and a boolean map; ordinary shapes are what break it.
    const allowed = compiled.diagnostics.filter((d) => d.file.endsWith('allowed.ts'));
    expect(allowed.map((d) => `${String(d.line)}: ${d.text}`)).toEqual([]);
  });
});
