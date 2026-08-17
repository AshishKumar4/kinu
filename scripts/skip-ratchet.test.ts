/**
 * The skip ratchet's own logic, credential-free.
 *
 * The gate this file guards exists because a skipped test reported green. A gate
 * whose own decision boundary nobody tested is the same defect one level up, so
 * every branch here is driven from a fixture rather than from a live run: an
 * undeclared skip must fail, a locked skip that now runs must fail, a report
 * naming no test must fail, and a target matching nothing must fail LOUDLY
 * rather than reconciling an empty set against the lock.
 */
import { describe, test, expect } from 'bun:test';
import {
  parseJUnit, readSkipLock, reconcileSkips, unmatchedTargets,
  SKIP_RATCHET_TARGETS, SKIP_LOCK_PATH,
} from './skip-ratchet.ts';

/** The exact shape Bun's junit reporter emits: a passing testcase is
 *  self-closing, a skipped one carries a `<skipped />` child. */
const REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="3" assertions="4" failures="0" skipped="2" time="0.15">
  <testsuite name="tests/a.test.ts" file="tests/a.test.ts" tests="3" failures="0" skipped="2">
    <testsuite name="Suite A" file="tests/a.test.ts" line="1" tests="3" failures="0" skipped="2">
      <testcase name="runs" classname="Suite A" time="0.001" file="tests/a.test.ts" line="5" assertions="4" />
      <testcase name="skips one" classname="Suite A" time="0" file="tests/a.test.ts" line="9" assertions="0">
        <skipped />
      </testcase>
      <testcase name="skips two &amp; more" classname="Suite A" time="0" file="tests/a.test.ts" line="12" assertions="0">
        <skipped />
      </testcase>
    </testsuite>
  </testsuite>
</testsuites>`;

describe('parseJUnit', () => {
  test('counts every testcase, not only the self-closing ones', () => {
    // A regex matching only `<testcase ... />` would report 1 test and 0 skips
    // over this report — a green gate over a run that skipped two thirds of
    // itself, which is the precise failure being guarded against.
    const report = parseJUnit(REPORT);
    expect(report.total).toBe(3);
    expect(report.skipped).toHaveLength(2);
    expect(report.failures).toBe(0);
    expect([...report.files]).toEqual(['tests/a.test.ts']);
  });

  test('keys a skip by file, suite and name — never by line', () => {
    // Line numbers move when anything above a test is edited. A line-keyed
    // ratchet would fire on every unrelated edit and be turned off within a day.
    const report = parseJUnit(REPORT);
    expect(report.skipped.map((s) => s.key)).toEqual([
      'tests/a.test.ts › Suite A › skips one',
      'tests/a.test.ts › Suite A › skips two & more',
    ]);
  });

  test('a failure is counted so the skip set is only judged over a passing run', () => {
    const failing = REPORT.replace('<skipped />', '<failure message="boom" />');
    const report = parseJUnit(failing);
    expect(report.failures).toBe(1);
    expect(report.skipped).toHaveLength(1);
  });

  test('an empty report measures nothing, and says so as zero rather than clean', () => {
    const report = parseJUnit('<testsuites name="bun test" tests="0" />');
    expect(report.total).toBe(0);
    expect(report.files.size).toBe(0);
    expect(report.skipped).toEqual([]);
  });
});

describe('reconcileSkips', () => {
  const report = parseJUnit(REPORT);

  test('a skip absent from the lock is new debt', () => {
    const verdict = reconcileSkips(report, [
      { key: 'tests/a.test.ts › Suite A › skips one', reason: 'declared' },
    ]);
    expect(verdict.added).toEqual(['tests/a.test.ts › Suite A › skips two & more']);
    expect(verdict.stale).toEqual([]);
  });

  test('a locked skip that now runs is stale — the ratchet only tightens', () => {
    const verdict = reconcileSkips(report, [
      { key: 'tests/a.test.ts › Suite A › skips one', reason: 'declared' },
      { key: 'tests/a.test.ts › Suite A › skips two & more', reason: 'declared' },
      { key: 'tests/a.test.ts › Suite A › runs', reason: 'was skipping' },
    ]);
    expect(verdict.added).toEqual([]);
    expect(verdict.stale).toEqual(['tests/a.test.ts › Suite A › runs']);
  });

  test('a fully declared skip set reconciles clean', () => {
    const verdict = reconcileSkips(report, [
      { key: 'tests/a.test.ts › Suite A › skips one', reason: 'declared' },
      { key: 'tests/a.test.ts › Suite A › skips two & more', reason: 'declared' },
    ]);
    expect(verdict).toEqual({ added: [], stale: [] });
  });
});

describe('unmatchedTargets', () => {
  test('a target that produced no test is reported, not silently reconciled', () => {
    // `bun test tests` and `bun test tests/` both match NOTHING in this repo;
    // only `./tests/` selects the root suites. A path typo would otherwise make
    // the whole ratchet a comparison against an empty set.
    const report = parseJUnit(REPORT);
    expect(unmatchedTargets(report, ['./packages/'])).toEqual(['./packages/']);
  });

  test('a file under the target satisfies it, `./` prefix and all', () => {
    const report = parseJUnit(REPORT);
    expect(unmatchedTargets(report, ['./tests/'])).toEqual([]);
  });

  test('an empty report leaves every target unmatched', () => {
    const empty = parseJUnit('<testsuites tests="0" />');
    expect(unmatchedTargets(empty, ['./tests/'])).toEqual(['./tests/']);
  });
});

describe('the committed lock', () => {
  test('every entry carries a non-empty reason', () => {
    // The reason is the point: "22 skips" is a number nobody reads, while a list
    // of sentences is something someone has to defend. `readSkipLock` parses
    // through valibot, so an entry with no reason fails here.
    const lock = readSkipLock();
    expect(lock.length).toBeGreaterThan(0);
    for (const entry of lock) {
      expect(entry.reason.trim().length).toBeGreaterThan(0);
      expect(entry.key).toContain('›');
    }
  });

  test('the lock has no duplicate keys', () => {
    const lock = readSkipLock();
    expect(new Set(lock.map((e) => e.key)).size).toBe(lock.length);
  });

  test('the gate declares its targets and its lock path', () => {
    expect(SKIP_RATCHET_TARGETS.length).toBeGreaterThan(0);
    // The leading `./` is load bearing — see unmatchedTargets above.
    for (const target of SKIP_RATCHET_TARGETS) expect(target.startsWith('./')).toBe(true);
    expect(SKIP_LOCK_PATH).toContain('skip-ratchet.lock.json');
  });
});
