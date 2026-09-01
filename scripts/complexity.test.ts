/**
 * The complexity budget, proven RED IN EVERY DIRECTION IT CLAIMS, and its
 * measurement proven equal to the linter already in this repository.
 *
 * Three obligations, and the third is the one a home-rolled metric usually
 * skips. A budget must fail on growth, or it is decoration. It must go green
 * again the moment the growth is taken back out, or the next person deletes it.
 * And its NUMBER must be reproducible by something that was not written here —
 * otherwise "complexity 126" is a claim about one walk of one tree, and nobody
 * can check it. `oxlint -c … complexity: max 0` is that second implementation:
 * it reports every function it sees with its own count, and this suite joins the
 * two on the byte offset both carry.
 */

import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BLIND_SPOTS, census, distribution, inventory, isGreen, judge, keyOf, measureFile, readBudget,
  topTier,
  type Budget, type Measured,
} from './complexity';
import { isParseable, readMatching } from './sources';

const root = new URL('..', import.meta.url).pathname;

/* ── The counting rule, construct by construct ─────────────────────────── */

/** One function's complexity, by the census, over a one-function fixture. */
function score(body: string): number {
  const measured = measureFile('packages/probe/src/probe.ts', body);
  return measured[0]?.complexity ?? 0;
}

describe('the counted set', () => {
  test('a straight-line function is 1', () => {
    expect(score('export function f(): number { return 1; }')).toBe(1);
  });

  test('each branching statement adds one', () => {
    expect(score('export function f(a: number): number { if (a) return 1; return 2; }')).toBe(2);
    expect(score('export function f(xs: number[]): void { for (const x of xs) void x; }')).toBe(2);
    expect(score('export function f(n: number): void { while (n > 0) n -= 1; }')).toBe(2);
    expect(score('export function f(): number { try { return 1; } catch { return 2; } }')).toBe(2);
    expect(score('export function f(a: number): number { return a ? 1 : 2; }')).toBe(2);
  });

  test('a `case` with a test counts and `default` does not', () => {
    expect(score(`export function f(a: number): number {
      switch (a) { case 1: return 1; case 2: return 2; default: return 3; } }`)).toBe(3);
  });

  test('every logical operator counts, `??` included', () => {
    expect(score('export function f(a: number, b: number): unknown { return a && b || a; }')).toBe(3);
    expect(score('export function f(a: number | null): number { return a ?? 1; }')).toBe(2);
    expect(score('export function f(a: { x?: number }): void { a.x ??= 1; }')).toBe(2);
  });

  test('a default value and an optional link each count, which is where oxlint is stricter than ESLint', () => {
    expect(score('export function f(a = 1): number { return a; }')).toBe(2);
    expect(score('export function f(a?: { b?: { c?: number } }): unknown { return a?.b?.c; }')).toBe(3);
  });

  test('a nested function keeps its own branches', () => {
    // The property that makes the number per-function: an outer function does
    // not inherit the branching of the callbacks it declares, so extracting a
    // helper genuinely moves complexity rather than hiding it twice.
    const measured = measureFile('packages/probe/src/probe.ts', `
      export function outer(a: number): () => number {
        const inner = (b: number): number => (b > 1 ? 1 : 2);
        if (a) return () => inner(a);
        return () => inner(0);
      }`);
    const byName = new Map(measured.map((entry) => [entry.name, entry.complexity]));
    expect(byName.get('outer')).toBe(2);
    expect(byName.get('outer>inner')).toBe(2);
  });
});

describe('the name a function is locked under', () => {
  test('qualifies a method with its class and a callback with what it is passed to', () => {
    const measured = measureFile('packages/probe/src/probe.tsx', `
      export class Widget {
        render(): void {
          useKeyboard((key: string) => { if (key) return; });
          useKeyboard((key: string) => { if (key) return; });
        }
      }`);
    expect(measured.map((entry) => entry.name).sort()).toEqual([
      'Widget.render',
      'Widget.render>useKeyboard',
      'Widget.render>useKeyboard#2',
    ]);
  });

  test('so two callbacks to the same function are separable, which a line number is not', () => {
    // Both callbacks would key on the same `(anonymous)` without this, and a
    // lock that cannot say WHICH of them grew is a lock nobody can act on.
    const measured = measureFile('packages/probe/src/probe.ts', `
      export function run(): void { walk(() => 1); walk(() => 2); }`);
    expect(new Set(measured.map(keyOf)).size).toBe(measured.length);
  });
});

/* ── Red in every direction the gate claims ────────────────────────────── */

/** A function with `branches` decisions, so its complexity is `branches + 1`. */
function injected(branches: number): string {
  const lines = Array.from({ length: branches }, (_, index) =>
    `  if (input === ${String(index)}) return ${String(index)};`);
  return `export function injectedDispatch(input: number): number {\n${lines.join('\n')}\n  return -1;\n}\n`;
}

const PROBE = 'packages/probe/src/probe.ts';

/** The tree, as a corpus of one file, plus the budget measured over it. The
 *  fixture's line is the Nth-worst complexity rather than a percentile: three
 *  functions cannot have a 99.9th percentile that means anything, and the
 *  property under test is the ratchet, not the choice of quantile. */
interface Fixture {
  readonly measured: Measured[];
  readonly budget: Budget;
}

function budgetFor(text: string, held = 3): Fixture {
  const measured = census(new Map([[PROBE, text]]));
  const spread = distribution(measured);
  const line = [...measured].map((entry) => entry.complexity)
    .sort((a, b) => b - a)[Math.min(held - 1, measured.length - 1)] ?? 1;
  return {
    measured,
    budget: {
      measuredAt: '2026-09-01',
      files: 1,
      functions: measured.length,
      ceiling: spread.ceiling,
      line,
      inventory: inventory(measured, line).map((entry) => ({
        key: keyOf(entry), complexity: entry.complexity,
      })),
    },
  };
}

/** Three ordinary functions, none of them near the budget. */
const BASELINE = `
export function alpha(a: number): number { return a > 1 ? 1 : 2; }
export function beta(a: number, b: number): number { return a && b ? 1 : 2; }
export function gamma(xs: number[]): number { let n = 0; for (const x of xs) n += x; return n; }
`;

describe('an injected 40-branch function', () => {
  const base = budgetFor(BASELINE);

  test('fails the budget it was not measured into', () => {
    const grown = census(new Map([[PROBE, `${BASELINE}${injected(40)}`]]));
    const verdict = judge(grown, base.budget);
    expect(isGreen(verdict)).toBe(false);
    // Both directions of the same growth: past the ceiling AND into the tier.
    expect(verdict.over.map((entry) => entry.name)).toEqual(['injectedDispatch']);
    expect(verdict.entrants.map((entry) => entry.name)).toEqual(['injectedDispatch']);
    expect(verdict.over[0]?.complexity).toBe(41);
  });

  test('and the same tree passes once it is removed', () => {
    // The other direction, on the SAME budget: nothing about the lock changed.
    expect(isGreen(judge(census(new Map([[PROBE, BASELINE]])), base.budget))).toBe(true);
  });

  test('is still caught when it stays under the ceiling but enters the tier', () => {
    // The ceiling alone would miss this: a function smaller than the worst one
    // in the tree, and bigger than the twentieth. The tier is what catches it,
    // and it is the case that matters on a tree whose worst function is 126.
    const withCeiling = `${BASELINE}${injected(60)}`;
    const pinned = budgetFor(withCeiling, 2);
    const entrant = census(new Map([[PROBE, `${withCeiling}\n${injected(30).replace('injectedDispatch', 'secondDispatch')}`]]));
    const verdict = judge(entrant, pinned.budget);
    expect(verdict.over).toEqual([]);
    expect(verdict.entrants.map((entry) => entry.name)).toEqual(['secondDispatch']);
  });
});

describe('a locked function', () => {
  const locked = budgetFor(`${BASELINE}${injected(40)}`);

  test('fails when it grows, even inside the ceiling', () => {
    const grown = census(new Map([[PROBE, `${BASELINE}${injected(40).replace(
      '  return -1;', '  if (input === 99) return 99;\n  return -1;',
    )}`]]));
    const verdict = judge(grown, {
      ...locked.budget, ceiling: 1000,
    });
    expect(verdict.grown.map(({ entry, was }) => `${entry.name} ${String(was)}->${String(entry.complexity)}`))
      .toEqual(['injectedDispatch 41->42']);
  });

  test('fails as STALE when it is simplified, so the lock cannot keep a cleaned-up entry', () => {
    const simplified = census(new Map([[PROBE, `${BASELINE}${injected(10)}`]]));
    const verdict = judge(simplified, locked.budget);
    expect(verdict.grown).toEqual([]);
    expect(verdict.stale.some((line) => line.includes('injectedDispatch'))).toBe(true);
    expect(isGreen(verdict)).toBe(false);
  });

  test('fails as STALE when it is deleted, naming it as absent', () => {
    const verdict = judge(census(new Map([[PROBE, BASELINE]])), locked.budget);
    expect(verdict.stale.some((line) => line.includes('injectedDispatch') && line.includes('absent')))
      .toBe(true);
  });

  test('and passes unchanged, which is the green this gate has to be able to reach', () => {
    expect(isGreen(judge(census(new Map([[PROBE, `${BASELINE}${injected(40)}`]])), locked.budget)))
      .toBe(true);
  });
});

/* ── The measurement equals the linter's ───────────────────────────────── */

/** oxlint's own reading of the same corpus: `kind` and complexity per byte
 *  offset, per file. */
function oxlintComplexity(files: readonly string[]): Map<string, Map<number, { kind: string; complexity: number }>> {
  const config = join(tmpdir(), `kinu-complexity-parity-${String(process.pid)}.json`);
  writeFileSync(config, JSON.stringify({
    categories: {
      correctness: 'off', suspicious: 'off', pedantic: 'off', perf: 'off',
      style: 'off', restriction: 'off', nursery: 'off',
    },
    rules: { complexity: ['error', { max: 0 }] },
  }));
  const run = Bun.spawnSync({
    cmd: ['./node_modules/.bin/oxlint', '-c', config, '-f', 'json', ...files],
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = run.stdout.toString();
  if (output.length === 0) {
    throw new Error(`oxlint produced no report: ${run.stderr.toString().slice(0, 800)}`);
  }
  const DiagnosticText = /^(.*?) has a complexity of (\d+)\./;
  const parsed: { diagnostics: { message: string; filename: string; labels: { span: { offset: number } }[] }[] }
    /* SAFETY: oxlint's own JSON reporter output, read for two fields this
       function immediately validates by regex; a shape change makes the regex
       miss and the parity assertion below fail loudly rather than silently. */
    = JSON.parse(output);
  const byFile = new Map<string, Map<number, { kind: string; complexity: number }>>();
  for (const diagnostic of parsed.diagnostics) {
    const match = DiagnosticText.exec(diagnostic.message);
    const span = diagnostic.labels[0]?.span;
    if (match === null || span === undefined) continue;
    const perFile = byFile.get(diagnostic.filename) ?? new Map<number, { kind: string; complexity: number }>();
    perFile.set(span.offset, {
      kind: (match[1] ?? '').replace(/`[^`]*`/, '').trim(),
      complexity: Number(match[2]),
    });
    byFile.set(diagnostic.filename, perFile);
  }
  return byFile;
}

/**
 * UTF-16 index -> UTF-8 byte offset for one file.
 *
 * The join needs this and it is not incidental: `oxc-parser`'s JS bindings
 * report spans in UTF-16 code units (JS string indices) and the oxlint CLI
 * reports them in bytes. This repository's docstrings are full of em dashes, so
 * on a 30 KB source the two disagree by hundreds of positions — comparing them
 * raw matched 3,521 functions of 47,994 and would have read as a broken parity
 * check rather than as an encoding difference.
 */
function byteOffsets(text: string): Int32Array {
  const offsets = new Int32Array(text.length + 1);
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    offsets[index] = bytes;
    const code = text.codePointAt(index) ?? 0;
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code < 0x10000) bytes += 3;
    else {
      bytes += 4;
      offsets[index + 1] = bytes;
      index += 1;
    }
  }
  offsets[text.length] = bytes;
  return offsets;
}

/** The live corpus, measured ONCE. Three describes below ask different
 *  questions of the same walk, and re-walking 1,900 files per question cost
 *  3.5s of the suite's 8.4s for no extra evidence. */
const LIVE_FILES = readMatching(isParseable);
const LIVE_BY_FILE = new Map<string, Measured[]>(
  [...LIVE_FILES].map(([file, text]) => [file, measureFile(file, text)]),
);
const LIVE = [...LIVE_BY_FILE.values()].flat();

describe('the census and oxlint report the same number', () => {
  const theirs = oxlintComplexity([...LIVE_FILES.keys()]);

  test('for every function this census measures, over the whole governed corpus', () => {
    const missing: string[] = [];
    const different: string[] = [];
    let compared = 0;
    for (const [file, text] of LIVE_FILES) {
      const offsets = byteOffsets(text);
      const reported = theirs.get(file) ?? new Map();
      for (const entry of LIVE_BY_FILE.get(file) ?? []) {
        const theirEntry = reported.get(offsets[entry.offset] ?? -1);
        if (theirEntry === undefined) {
          missing.push(`${file}:${String(entry.line)} ${entry.name}`);
          continue;
        }
        compared += 1;
        if (theirEntry.complexity !== entry.complexity) {
          different.push(`${file}:${String(entry.line)} ${entry.name} `
            + `census=${String(entry.complexity)} oxlint=${String(theirEntry.complexity)}`);
        }
      }
    }
    expect(compared).toBeGreaterThan(40_000);
    expect(missing.slice(0, 5)).toEqual([]);
    expect(different.slice(0, 5)).toEqual([]);
  });

  test('and everything oxlint reports beyond it is a bodiless declaration scoring 1', () => {
    // The other half of the equivalence: not just "we agree where we both look",
    // but "what only oxlint sees cannot change the budget". A class field
    // initializer is not a function; a TS overload signature and an `abstract`
    // member have no body. All of them score 1 against a budget line of 39.
    const extras: { kind: string; complexity: number }[] = [];
    for (const [file, text] of LIVE_FILES) {
      const offsets = byteOffsets(text);
      const mine = new Set((LIVE_BY_FILE.get(file) ?? []).map((entry) => offsets[entry.offset] ?? -1));
      for (const [offset, entry] of theirs.get(file) ?? new Map()) {
        if (!mine.has(offset)) extras.push(entry);
      }
    }
    expect(extras.length).toBeGreaterThan(0);
    expect(extras.filter((entry) => entry.complexity > 1)).toEqual([]);
  });
});

/* ── The live tree, and the denominator ────────────────────────────────── */

describe('over the live tree', () => {
  const files = LIVE_FILES;
  const measured = LIVE;
  const spread = distribution(measured);
  const budget = readBudget();

  test('the corpus, the function count and the ceiling are all non-zero', () => {
    expect(files.size).toBeGreaterThan(1000);
    expect(spread.functions).toBeGreaterThan(10_000);
    expect(spread.ceiling).toBeGreaterThan(spread.p99);
  });

  test('the distribution is ordered, so a broken counter cannot read as a flat tree', () => {
    expect(spread.p50).toBeLessThanOrEqual(spread.p90);
    expect(spread.p90).toBeLessThanOrEqual(spread.p99);
    expect(spread.p99).toBeLessThanOrEqual(spread.line);
    expect(spread.line).toBeLessThanOrEqual(spread.ceiling);
  });

  test('the printed twenty are the head of the pinned inventory', () => {
    // The report and the budget have to be the same list, or the names a reader
    // sees are not the names the gate holds.
    const held = new Set(inventory(measured, spread.line).map(keyOf));
    expect(topTier(measured).length).toBe(20);
    expect(topTier(measured).filter((entry) => !held.has(keyOf(entry)))).toEqual([]);
  });

  test('the lock names functions that still exist, at the numbers recorded', () => {
    // Not the same assertion as the gate's own green: this one fails when a lock
    // entry names a function nothing in the tree declares, which is how a lock
    // rots into a list of historical names.
    const current = new Map(measured.map((entry) => [keyOf(entry), entry.complexity]));
    const absent = budget.inventory.filter((entry) => !current.has(entry.key))
      .map((entry) => entry.key);
    expect(absent).toEqual([]);
  });

  test('the tree is inside its own budget', () => {
    expect(judge(measured, budget)).toEqual({ over: [], entrants: [], grown: [], stale: [] });
  });
});

describe('blind spots', () => {
  test('each one states a verdict rather than a topic', () => {
    const VERDICT = /NOT MEASURED|NOT DETECTED|OUT OF SCOPE/;
    expect(BLIND_SPOTS.length).toBeGreaterThan(0);
    expect(BLIND_SPOTS.filter((spot) => !VERDICT.test(spot))).toEqual([]);
  });

  test('the two a per-function count cannot see are named', () => {
    const joined = BLIND_SPOTS.join('\n');
    expect(joined).toContain('NESTING DEPTH');
    expect(joined).toContain('COMPLEXITY MOVED RATHER THAN REMOVED');
  });
});
