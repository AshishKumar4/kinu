/**
 * RED PROOF for the lcov merge. The merge feeds `bun run coverage` and
 * `coverage:check`, so a merger that drops or double-counts a record would
 * report a number nobody measured while every other gate stays green.
 *
 * Each test below names the defect it defends against, and each fixture pair
 * is INDEPENDENTLY derived: the expected sums are written by hand from the
 * fixture data, never produced by running the merger (a fixture regenerated
 * by the code under test is a tautology, not a proof).
 */
import { describe, expect, test } from 'bun:test';

import { mergeLcov, parseLcov, type LcovRecord } from './coverage-lcov';

/** Two records for ONE file, as two suite runs would produce them. */
const RUN_A = [
  'TN:',
  'SF:src/thing.ts',
  'FNDA:3,one',
  'FNDA:0,two',
  'FNF:2',
  'FNH:1',
  'DA:1,3',
  'DA:2,0',
  'DA:3,3',
  'LF:3',
  'LH:2',
  'BRDA:2,0,0,3',
  'BRDA:2,0,1,0',
  'BRF:2',
  'BRH:1',
  'end_of_record',
  '',
].join('\n');

const RUN_B = [
  'TN:',
  'SF:src/thing.ts',
  'FNDA:2,one',
  'FNDA:4,two',
  'FNF:2',
  'FNH:2',
  'DA:1,2',
  'DA:2,4',
  'DA:4,4',
  'LF:3',
  'LH:3',
  'BRDA:2,0,0,2',
  'BRDA:2,0,1,4',
  'BRF:2',
  'BRH:2',
  'end_of_record',
  '',
].join('\n');

/** A record for a DIFFERENT file: the merge must keep both, never coalesce. */
const OTHER_FILE = [
  'TN:',
  'SF:src/other.ts',
  'DA:1,1',
  'LF:1',
  'LH:1',
  'end_of_record',
  '',
].join('\n');
/**
 * What `bun test --coverage-reporter=lcov` (1.4.0) really writes: `FNF`
 * and `FNH` totals with NO `FNDA` records behind them, and no branch section
 * at all. Copied from coverage/agent-utils/lcov.info of a real run, trimmed.
 * Before this shape was handled, the summary printed `-` for function coverage
 * on every bun package while printing a real number for the two istanbul
 * pools — blank exactly where most of the code lives.
 */
const BUN_LCOV_ONE = [
  'TN:',
  'SF:src/thing.ts',
  'FNF:6',
  'FNH:2',
  'DA:1,1',
  'DA:2,0',
  'LF:2',
  'LH:1',
  'end_of_record',
  '',
].join('\n');

/** The same file from a second bun group: identical declared totals, one more
 *  line executed. */
const BUN_LCOV_TWO = [
  'TN:',
  'SF:src/thing.ts',
  'FNF:6',
  'FNH:3',
  'DA:1,2',
  'DA:2,4',
  'LF:2',
  'LH:2',
  'end_of_record',
  '',
].join('\n');


describe('parseLcov', () => {
  test('reads DA, FNDA and BRDA with their totals', () => {
    const [record] = parseLcov(RUN_A);
    if (record === undefined) throw new Error('no record parsed');
    expect(record.file).toBe('src/thing.ts');
    expect(record.lines.found).toBe(3);
    expect(record.lines.hit).toBe(2);
    expect(record.functions.found).toBe(2);
    expect(record.functions.hit).toBe(1);
    expect(record.branches.found).toBe(2);
    expect(record.branches.hit).toBe(1);
    expect(record.lines.data.map((d) => [d.line, d.count])).toEqual([[1, 3], [2, 0], [3, 3]]);
  });

  test('a line shape it does not recognise throws rather than skipping', () => {
    // A parser that skipped unknown lines would undercount silently.
    expect(() => parseLcov('SF:x.ts\nGARBAGE:1,2\nend_of_record\n')).toThrow(/unrecognised/);
  });
});

describe('mergeLcov', () => {
  test('line and function hits SUM across runs of one file', () => {
    const merged = mergeLcov([...parseLcov(RUN_A), ...parseLcov(RUN_B)]);
    expect(merged).toHaveLength(1);
    const [record] = merged;
    if (record === undefined) throw new Error('no merged record');
    // Hand-derived: DA 1 = 3+2, DA 2 = 0+4, DA 3 = 3+0, DA 4 = 0+4 → 4 lines, 4 hit.
    expect(record.lines.data.map((d) => [d.line, d.count])).toEqual([[1, 5], [2, 4], [3, 3], [4, 4]]);
    expect(record.lines.found).toBe(4);
    expect(record.lines.hit).toBe(4);
    // FNDA one = 3+2, FNDA two = 0+4 → both executed.
    expect(record.functions.hit).toBe(2);
    expect(record.functions.data.find((f) => f.name === 'one')?.count).toBe(5);
    expect(record.functions.data.find((f) => f.name === 'two')?.count).toBe(4);
  });

  test('branch hits take the MAXIMUM per branch key, not the sum', () => {
    const merged = mergeLcov([...parseLcov(RUN_A), ...parseLcov(RUN_B)]);
    const [record] = merged;
    if (record === undefined) throw new Error('no merged record');
    // BRDA 2,0,0: max(3,2)=3 · 2,0,1: max(0,4)=4 → both hit, 2 of 2.
    expect(record.branches.data.map((b) => [b.branch, b.count])).toEqual([[0, 3], [1, 4]]);
    expect(record.branches.hit).toBe(2);
    // The load-bearing assertion: a merger that SUMMED would say 5 and 4.
    expect(record.branches.data[0]?.count).toBe(3);
  });

  test('records for different files survive as separate records', () => {
    const merged = mergeLcov([...parseLcov(RUN_A), ...parseLcov(OTHER_FILE)]);
    expect(merged.map((r: LcovRecord) => r.file).sort()).toEqual(['src/other.ts', 'src/thing.ts']);
  });

  test('recomputed totals ignore the input files own LF/LH claims', () => {
    // RUN_B claims LF:3 LH:3, but the merged file has 4 instrumented lines
    // because RUN_A contributes line 3 that RUN_B never saw. A merger that
    // copied totals through would report 3 and drop a line.
    const merged = mergeLcov([...parseLcov(RUN_A), ...parseLcov(RUN_B)]);
    expect(merged[0]?.lines.found).toBe(4);
    expect(merged[0]?.lines.hit).toBe(4);
  });

  test('the emitted raw form round-trips through the parser', () => {
    const merged = mergeLcov([...parseLcov(RUN_A), ...parseLcov(RUN_B)]);
    const reparsed = parseLcov(merged.map((r) => r.raw).join(''));
    expect(reparsed[0]?.lines.found).toBe(4);
    expect(reparsed[0]?.lines.hit).toBe(4);
    expect(reparsed[0]?.branches.hit).toBe(2);
  });

  test('three runs merge associatively', () => {
    const left = mergeLcov([...mergeLcov([...parseLcov(RUN_A), ...parseLcov(RUN_B)]), ...parseLcov(RUN_A)]);
    const right = mergeLcov([...parseLcov(RUN_A), ...mergeLcov([...parseLcov(RUN_B), ...parseLcov(RUN_A)])]);
    expect(left[0]?.lines.data).toEqual(right[0]?.lines.data);
    expect(left[0]?.lines.hit).toBe(right[0]?.lines.hit);
  });

  test("bun's FNF/FNH-only shape yields a function number, not a blank", () => {
    const [record] = parseLcov(BUN_LCOV_ONE);
    // The defect this defends: counting functions only from FNDA reports
    // found: 0, which the summary renders as `-` for every bun package.
    expect(record?.functions.found).toBe(6);
    expect(record?.functions.hit).toBe(2);
    expect(record?.functions.data).toHaveLength(0);
  });

  test('declared function totals merge by MAX, never summed', () => {
    const merged = mergeLcov([...parseLcov(BUN_LCOV_ONE), ...parseLcov(BUN_LCOV_TWO)]);
    expect(merged).toHaveLength(1);
    // Hand-derived: both groups declare FNF:6 for the same file, and 2 vs 3 hit.
    // Summing would claim 12 functions found and 5 hit for a 6-function file.
    expect(merged[0]?.functions.found).toBe(6);
    expect(merged[0]?.functions.hit).toBe(3);
    // Lines still SUM, because those have per-item records behind them.
    expect(merged[0]?.lines.data.map((d) => [d.line, d.count])).toEqual([[1, 3], [2, 4]]);
    expect(merged[0]?.lines.hit).toBe(2);
  });

  test('a declared-totals merge survives the raw round-trip', () => {
    const merged = mergeLcov([...parseLcov(BUN_LCOV_ONE), ...parseLcov(BUN_LCOV_TWO)]);
    const reparsed = parseLcov(merged.map((r) => r.raw).join(''));
    expect(reparsed[0]?.functions.found).toBe(6);
    expect(reparsed[0]?.functions.hit).toBe(3);
  });

  test('a bun record and an istanbul record for one file keep the real data', () => {
    // Mixed producers: the istanbul side has FNDA records, the bun side only
    // declares totals. The per-item data must win rather than being erased by
    // a declared 6, and the branch section comes from the only producer that
    // has one.
    const merged = mergeLcov([...parseLcov(BUN_LCOV_ONE), ...parseLcov(RUN_A)]);
    expect(merged[0]?.functions.data.map((f) => f.name).sort()).toEqual(['one', 'two']);
    expect(merged[0]?.functions.found).toBe(2);
    expect(merged[0]?.branches.found).toBe(2);
    expect(merged[0]?.branches.hit).toBe(1);
  });
});
