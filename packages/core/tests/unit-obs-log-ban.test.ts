/**
 * Runs the gate's `tsc` over fixtures/log-ban: violations.ts must fail naming the marker type,
 * allowed.ts must compile. No `@ts-expect-error`: it never says which error fired.
 */

import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createRecordingLogger,
  KinuError,
  toKinuError,
} from '../src/obs/index';

const here = dirname(fileURLToPath(import.meta.url));

const repoRoot = join(here, '..', '..', '..');

const fixtureProject = join(here, 'fixtures', 'log-ban');

interface Diagnostic {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

interface CompileReport {
  readonly status: number;
  readonly diagnostics: readonly Diagnostic[];
}

/** Uses the repo's `node_modules/.bin/tsc`, the binary `bun run check` runs. */
function compileFixtures(): CompileReport {
  const tsc = join(repoRoot, 'node_modules', '.bin', 'tsc');

  const run = spawnSync(tsc, ['--noEmit', '--pretty', 'false', '-p', fixtureProject], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  if (run.error) {
    throw new Error(`could not run ${tsc}`, { cause: run.error });
  }

  const output = `${run.stdout}${run.stderr}`;
  const diagnostics: Diagnostic[] = [];

  for (const raw of output.split('\n')) {
    const match = /^(.*?)\((\d+),\d+\): error (.*)$/u.exec(raw);

    if (!match?.[1] || !match[2] || !match[3]) continue;
    diagnostics.push({ file: match[1], line: Number.parseInt(match[2], 10), text: match[3] });
  }

  return { status: run.status ?? -1, diagnostics };
}

/** Lines come from the fixture's `[N]` markers, so renumbering cannot detach an assertion. */
function markedLines(file: string): ReadonlyMap<number, number> {
  const source = readFileSync(join(fixtureProject, file), 'utf8').split('\n');
  const byCase = new Map<number, number>();

  for (const [index, text] of source.entries()) {
    const marker = /^\/\/ \[(\d+)\]/u.exec(text);

    // The call is the first non-comment line after the `// [n]` marker block.
    if (!marker?.[1]) continue;
    let cursor = index + 1;

    while (cursor < source.length && source[cursor]?.trimStart().startsWith('//')) cursor += 1;
    byCase.set(Number.parseInt(marker[1], 10), cursor + 1);
  }

  return byCase;
}

const compiled = compileFixtures();

describe('a log call carrying a secret does not compile', () => {
  test('the fixture project fails to compile at all', () => {
    // A zero exit would make every per-case assertion vacuous.
    expect(compiled.status).not.toBe(0);
    expect(compiled.diagnostics.length).toBeGreaterThan(0);
  });

  /** Naming the marker type asserts this ban fired, not a typo. */
  const cases: readonly (readonly [number, string, string])[] = [
    [1, 'a reserved field in a literal', 'ReservedFieldIsNotLoggable<"soul">'],
    [2, 'a reserved field through an annotated variable', 'ReservedFieldIsNotLoggable<"apiKey">'],
    [3, 'a reserved field arriving by spread', 'ReservedFieldIsNotLoggable<"apiKey">'],
    [4, 'an open field map', 'UninspectedFieldsAreNotLoggable'],
    [5, 'an open field map with scalar values', 'UninspectedFieldsAreNotLoggable'],
    [6, 'a numeric index signature', 'UninspectedFieldsAreNotLoggable'],
    [7, 'an object nobody looked inside', 'LogFieldValue'],
    [8, 'an event name with no dot', '`${string}.${string}`'],
    [9, 'a failure log with no classification', 'KinuError'],
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
    // Both directions: every documented violation asserted, and no diagnostic on an unmarked line.
    expect([...lines.keys()].sort((a, b) => a - b)).toEqual(cases.map(([id]) => id));
    const expected = new Set(lines.values());
    const stray = violations.filter((d) => !expected.has(d.line));
    expect(stray.map((d) => `${String(d.line)}: ${d.text}`)).toEqual([]);
  });

  test('the ordinary calls compile', () => {
    // False-positive guard: fields held in an annotated interface variable must be accepted
    // (no index signature, so not assignable to a Record).
    const allowed = compiled.diagnostics.filter((d) => d.file.endsWith('allowed.ts'));
    expect(allowed.map((d) => `${String(d.line)}: ${d.text}`)).toEqual([]);
  });
});

describe('the logger records what a code path claimed', () => {
  test('an event carries its dotted name and its fields, and no classification', () => {
    const log = createRecordingLogger();
    log.event('capability.read', { rows: 3 });
    expect(log.emitted).toEqual([
      { event: 'capability.read', code: null, cause: null, fields: { rows: 3 } },
    ]);
  });
  test('a recorded line keeps its own copy of the fields', () => {
    // Mutating the caller's fields after the call must not rewrite captured history.
    const log = createRecordingLogger();
    const eventFields = { rows: 3 };
    log.event('capability.read', eventFields);
    eventFields.rows = 99;
    const failureFields = { table: 'workspace_capability' };
    log.failure(
      'capability.read_failed',
      toKinuError({ doing: 'reading', cause: new Error('gone'), otherwise: 'io' }),
      failureFields,
    );
    failureFields.table = 'other';
    expect(log.emitted[0]?.fields).toEqual({ rows: 3 });
    expect(log.emitted[1]?.fields).toEqual({ table: 'workspace_capability' });
  });

  test('a failure carries the class and the whole cause chain', () => {
    const log = createRecordingLogger();

    const failure = toKinuError({
      doing: 'reading workspace_capability',
      cause: new Error('no such table: workspace_capability'),
      otherwise: 'io',
    });

    log.failure('capability.read_failed', failure, { table: 'workspace_capability' });
    expect(log.emitted).toEqual([{
      event: 'capability.read_failed',
      code: 'io',
      cause: 'reading workspace_capability: no such table: workspace_capability',
      fields: { table: 'workspace_capability' },
    }]);
  });

  test('a failure log cannot omit the class', () => {
    // Runtime half: the line reports the error's classification, with no default.
    const log = createRecordingLogger();
    log.failure('shell.escalation_refused', new KinuError('unavailable', 'not provisioned'));
    expect(log.emitted[0]?.code).toBe('unavailable');
    expect(log.emitted[0]?.fields).toEqual({});
  });
});
