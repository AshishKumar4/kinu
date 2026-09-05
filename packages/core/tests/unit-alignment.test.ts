/**
 * K_align — the Alignment Convergence Rate over the turn_outcomes ledger:
 * the correction rate per 100 graded turns by scaffold version, its Wilson
 * intervals, and the trend it will (and will not) claim.
 */
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { makeSql, makeExecRaw } from './helpers';
import { initTurnOutcomeTables, recordTurnOutcome } from '../src/evolution/outcomes';
import type { TurnOutcome } from '../src/evolution/outcomes';
import {
  alignmentConvergence, renderAlignmentConvergence,
} from '../src/evolution/alignment';
import type { SqlExecutor } from '../src/types/primitives';

function setup() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  initTurnOutcomeTables(makeExecRaw(db));
  return { sql };
}

/** Record `negatives` corrected turns and `turns - negatives` accepted ones
 *  for one scaffold version, timestamped in the order versions ran. */
function seed(sql: SqlExecutor, opts: {
  scaffoldVersion: number | null; turns: number; negatives: number; startAt: number;
  abandoned?: number;
}): void {
  const write = (outcome: TurnOutcome, i: number): void => {
    recordTurnOutcome(sql, {
      outcome, confidence: 1, source: 'classifier',
      userMessage: 'q', assistantResponse: 'a',
      scaffoldVersion: opts.scaffoldVersion,
      now: opts.startAt + i,
    });
  };
  for (let i = 0; i < opts.turns; i += 1) write(i < opts.negatives ? 'corrected' : 'accepted', i);
  for (let i = 0; i < (opts.abandoned ?? 0); i += 1) write('abandoned', opts.turns + i);
}

describe('alignmentConvergence', () => {
  test('an empty ledger is undefined, not zero', () => {
    const k = alignmentConvergence(setup().sql);
    expect(k.segments).toEqual([]);
    expect(k.overall.turns).toBe(0);
    expect(k.trend).toBe('insufficient');
    expect(k.deltaPer100).toBeNull();
    expect(k.note).toContain('No graded turns');
  });

  test('a missing ledger reads as empty rather than throwing', () => {
    const k = alignmentConvergence(makeSql(new Database(':memory:')));
    expect(k.segments).toEqual([]);
    expect(k.trend).toBe('insufficient');
  });

  test('segments by scaffold version, oldest first, with the rate per 100 graded turns', () => {
    const { sql } = setup();
    seed(sql, { scaffoldVersion: 1, turns: 200, negatives: 60, startAt: 1_000 });
    seed(sql, { scaffoldVersion: 2, turns: 200, negatives: 20, startAt: 9_000 });

    const k = alignmentConvergence(sql);
    expect(k.segments.map((s) => s.scaffoldVersion)).toEqual([1, 2]);
    expect(k.segments[0].rate.per100).toBeCloseTo(30, 10);
    expect(k.segments[1].rate.per100).toBeCloseTo(10, 10);
    expect(k.overall.turns).toBe(400);
    expect(k.overall.negatives).toBe(80);
    expect(k.overall.rate.per100).toBeCloseTo(20, 10);
  });

  test('abandoned turns are counted but kept out of the rate (they carry no verdict)', () => {
    const { sql } = setup();
    seed(sql, { scaffoldVersion: 3, turns: 100, negatives: 25, startAt: 1_000, abandoned: 50 });

    const k = alignmentConvergence(sql);
    expect(k.segments[0].turns).toBe(100);
    expect(k.segments[0].abandoned).toBe(50);
    expect(k.segments[0].rate.per100).toBeCloseTo(25, 10);
    expect(k.overall.abandoned).toBe(50);
  });

  test('an improving trend: the later interval clears the earlier one', () => {
    const { sql } = setup();
    seed(sql, { scaffoldVersion: 1, turns: 200, negatives: 80, startAt: 1_000 });
    seed(sql, { scaffoldVersion: 2, turns: 200, negatives: 20, startAt: 9_000 });

    const k = alignmentConvergence(sql);
    expect(k.trend).toBe('improving');
    expect(k.deltaPer100).toBeCloseTo(-30, 10);
    expect(k.comparedVersions).toEqual({ from: 1, to: 2 });
    expect(k.segments[1].rate.highPer100).toBeLessThan(k.segments[0].rate.lowPer100);
  });

  test('a worsening trend is named just as plainly', () => {
    const { sql } = setup();
    seed(sql, { scaffoldVersion: 1, turns: 200, negatives: 20, startAt: 1_000 });
    seed(sql, { scaffoldVersion: 2, turns: 200, negatives: 80, startAt: 9_000 });

    const k = alignmentConvergence(sql);
    expect(k.trend).toBe('worsening');
    expect(k.deltaPer100).toBeCloseTo(30, 10);
  });

  test('a flat trend says the change is undetectable, not absent', () => {
    const { sql } = setup();
    seed(sql, { scaffoldVersion: 1, turns: 200, negatives: 40, startAt: 1_000 });
    seed(sql, { scaffoldVersion: 2, turns: 200, negatives: 44, startAt: 9_000 });

    const k = alignmentConvergence(sql);
    expect(k.trend).toBe('flat');
    expect(k.note).toContain('not evidence of no change');
  });

  test('a handful of turns reports its own unreliability instead of a rate', () => {
    const { sql } = setup();
    seed(sql, { scaffoldVersion: 1, turns: 6, negatives: 3, startAt: 1_000 });
    seed(sql, { scaffoldVersion: 2, turns: 6, negatives: 0, startAt: 9_000 });

    const k = alignmentConvergence(sql);
    // 3/6 looks like a 50% → 0% collapse. It is nothing.
    expect(k.segments[0].rate.per100).toBeCloseTo(50, 10);
    expect(k.segments[1].rate.per100).toBe(0);
    expect(k.segments.every((s) => s.rate.reliable)).toBe(false);
    expect(k.trend).toBe('insufficient');
    expect(k.deltaPer100).toBeNull();
    expect(k.note).toContain('Nothing here is a signal yet');
  });

  test('one well-measured version alone is not a trend', () => {
    const { sql } = setup();
    seed(sql, { scaffoldVersion: 1, turns: 200, negatives: 20, startAt: 1_000 });

    const k = alignmentConvergence(sql);
    expect(k.segments[0].rate.reliable).toBe(true);
    expect(k.trend).toBe('insufficient');
    expect(k.note).toContain('no before/after');
  });

  test('too-imprecise segments are skipped by the comparison, not allowed to block it', () => {
    const { sql } = setup();
    seed(sql, { scaffoldVersion: 1, turns: 200, negatives: 80, startAt: 1_000 });
    seed(sql, { scaffoldVersion: 2, turns: 3, negatives: 3, startAt: 5_000 });
    seed(sql, { scaffoldVersion: 3, turns: 200, negatives: 20, startAt: 9_000 });

    const k = alignmentConvergence(sql);
    expect(k.trend).toBe('improving');
    expect(k.comparedVersions).toEqual({ from: 1, to: 3 });
  });

  test('turns recorded before versions were attributed still form a segment', () => {
    const { sql } = setup();
    seed(sql, { scaffoldVersion: null, turns: 200, negatives: 80, startAt: 1_000 });
    seed(sql, { scaffoldVersion: 4, turns: 200, negatives: 20, startAt: 9_000 });

    const k = alignmentConvergence(sql);
    expect(k.segments.map((s) => s.scaffoldVersion)).toEqual([null, 4]);
    expect(k.trend).toBe('improving');
    expect(k.comparedVersions).toEqual({ from: null, to: 4 });
  });
});

describe('renderAlignmentConvergence', () => {
  test('shows the rate, its interval, the trend, and every segment', () => {
    const { sql } = setup();
    seed(sql, { scaffoldVersion: 1, turns: 200, negatives: 80, startAt: 1_000 });
    seed(sql, { scaffoldVersion: 2, turns: 200, negatives: 20, startAt: 9_000 });

    const text = renderAlignmentConvergence(alignmentConvergence(sql));
    expect(text).toContain('Overall: 25.0 per 100 turns (95% CI');
    expect(text).toContain('over 400 user-graded turns');
    expect(text).toContain('Trend: improving (-30.0 per 100 turns, v1 → v2)');
    expect(text).toContain('  v1  n=200  40.0 per 100 turns');
    expect(text).toContain('  v2  n=200  10.0 per 100 turns');
  });

  test('marks an interval that is too wide to read', () => {
    const { sql } = setup();
    seed(sql, { scaffoldVersion: 1, turns: 4, negatives: 2, startAt: 1_000 });

    const text = renderAlignmentConvergence(alignmentConvergence(sql));
    expect(text).toContain('too wide to read');
    expect(text).toContain('Trend: insufficient');
  });
});
