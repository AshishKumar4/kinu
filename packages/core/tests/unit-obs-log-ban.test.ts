/**
 * The reserved-log-field ban, red-proven.
 *
 * A type-level ban that nobody points a compiler at is decoration: it is asserted
 * by the absence of a diagnostic in code nobody wrote. So this suite runs the SAME
 * `tsc` the gate runs (`bun run check`) over a project of two fixtures, and reads
 * the diagnostics:
 *
 *   fixtures/log-ban/violations.ts   nine evasion routes, each of which MUST fail
 *                                    to compile, with a diagnostic that names the
 *                                    uninhabited marker type rather than any old
 *                                    error
 *   fixtures/log-ban/allowed.ts      the ordinary calls, which MUST compile — the
 *                                    half a ban usually skips, and the half that
 *                                    caught two earlier designs of
 *                                    `LoggableFields` rejecting a fields object
 *                                    held in an annotated variable
 *
 * `@ts-expect-error` is deliberately not used for this. It proves an error exists
 * somewhere on the next line and never says WHICH, so a fixture built from it
 * keeps passing if the ban breaks and a typo takes its place.
 *
 * That directory is excluded from `packages/core/tsconfig.json` — it is meant to
 * be uncompilable, and the gate would otherwise fail on it.
 */

import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createRecordingLogger,
  ProteusError,
  RESERVED_LOG_FIELDS,
  toProteusError,
} from '../src/obs/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const fixtureProject = join(here, 'fixtures', 'log-ban');

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
 * The compiler is invoked through the repo's own `node_modules/.bin/tsc`, the same
 * binary eight `bun run check` projects use, so this cannot pass against a
 * compiler the gate does not run.
 */
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

/** Line numbers are read from the fixture's own `[N]` markers, so renumbering the
 *  file cannot silently detach an assertion from the line it is about. */
function markedLines(file: string): ReadonlyMap<number, number> {
  const source = readFileSync(join(fixtureProject, file), 'utf8').split('\n');
  const byCase = new Map<number, number>();
  source.forEach((text, index) => {
    const marker = /^\/\/ \[(\d+)\]/u.exec(text);
    // The call is the first line after the marker's comment block, which the
    // fixture keeps to a fixed shape: `// [n] …` then optional `//` continuation
    // lines, then the statement. Resolved by scanning forward to the first line
    // that is not a comment.
    if (!marker?.[1]) return;
    let cursor = index + 1;
    while (cursor < source.length && source[cursor]?.trimStart().startsWith('//')) cursor += 1;
    byCase.set(Number.parseInt(marker[1], 10), cursor + 1);
  });
  return byCase;
}

const compiled = compileFixtures();

describe('a log call carrying a secret does not compile', () => {
  test('the fixture project fails to compile at all', () => {
    // The precondition for everything below. A zero exit here would mean the ban
    // is gone and every per-case assertion below is vacuously reading an empty
    // diagnostic list.
    expect(compiled.status).not.toBe(0);
    expect(compiled.diagnostics.length).toBeGreaterThan(0);
  });

  /**
   * Every evasion route, with the marker type the diagnostic must name. A test
   * that only asserted "line N errors" would pass on a typo; naming the marker
   * asserts it is THIS ban that fired.
   */
  const cases: readonly (readonly [number, string, string])[] = [
    [1, 'a reserved field in a literal', 'ReservedFieldIsNotLoggable<"soul">'],
    [2, 'a reserved field through an annotated variable', 'ReservedFieldIsNotLoggable<"apiKey">'],
    [3, 'a reserved field arriving by spread', 'ReservedFieldIsNotLoggable<"apiKey">'],
    [4, 'an open field map', 'UninspectedFieldsAreNotLoggable'],
    [5, 'an open field map with scalar values', 'UninspectedFieldsAreNotLoggable'],
    [6, 'a numeric index signature', 'UninspectedFieldsAreNotLoggable'],
    [7, 'an object nobody looked inside', 'LogFieldValue'],
    [8, 'an event name with no dot', '`${string}.${string}`'],
    [9, 'a failure log with no classification', 'ProteusError'],
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
    // Two directions. A violation the fixture documents and this suite forgot to
    // assert would be a silent gap; a diagnostic on an UNMARKED line means the
    // fixture has an ordinary mistake in it and one of the assertions above may be
    // passing for the wrong reason.
    expect([...lines.keys()].sort((a, b) => a - b)).toEqual(cases.map(([id]) => id));
    const expected = new Set(lines.values());
    const stray = violations.filter((d) => !expected.has(d.line));
    expect(stray.map((d) => `${String(d.line)}: ${d.text}`)).toEqual([]);
  });

  test('the ordinary calls compile', () => {
    // The false-positive guard, and not a formality: constraining the fields type
    // to `Record<string, LogFieldValue>` rejected every fields object held in an
    // annotated variable, because an interface without an index signature is not
    // assignable to a Record. Nothing but this fixture would have caught it.
    const allowed = compiled.diagnostics.filter((d) => d.file.endsWith('allowed.ts'));
    expect(allowed.map((d) => `${String(d.line)}: ${d.text}`)).toEqual([]);
  });
});

describe('the reserved list is the one AGENTS.md states', () => {
  test('every field named in the contract is banned, and none is invented', () => {
    // The list is load-bearing prose in AGENTS.md § Errors, Logging &
    // Traceability. Read from the file rather than restated, so the ban and the
    // contract cannot drift — the failure mode `platform-catalog.ts` exists to
    // prevent, one document over.
    const agents = readFileSync(join(repoRoot, 'AGENTS.md'), 'utf8');
    const sentence = /no `apiKey`[^.]*?\./u.exec(agents)?.[0];
    expect(sentence).toBeDefined();
    const named = [...(sentence ?? '').matchAll(/`([A-Za-z()]+)`/gu)].map(([, field]) => field);
    // `header(s)` is how the contract writes the pair; the type spells both.
    const expanded = named.flatMap((field) =>
      field === 'header(s)' ? ['header', 'headers'] : [field]);
    expect(expanded.sort()).toEqual([...RESERVED_LOG_FIELDS].sort());
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

  test('a failure carries the class and the whole cause chain', () => {
    // What makes the log line answer the question the string returns could not:
    // WHICH kind of failure, and what actually failed underneath.
    const log = createRecordingLogger();
    const failure = toProteusError({
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
    // Enforced by the signature, so this asserts the runtime half: whatever
    // classification the error carries is what the line reports, with no default.
    const log = createRecordingLogger();
    log.failure('run.escalation_refused', new ProteusError('unavailable', 'not provisioned'));
    expect(log.emitted[0]?.code).toBe('unavailable');
    expect(log.emitted[0]?.fields).toEqual({});
  });
});
