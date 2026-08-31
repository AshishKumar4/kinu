/**
 * The hammer gate's own decision boundaries.
 *
 * Every direction here was RED before the gate carried the check, and the two
 * that matter most are the ones a green exit code hides: a run that reported
 * nothing, and a governed suite file that never ran. Both are the same defect
 * the ladder was built for, one level down — a lane reporting on a population
 * it never measured.
 *
 * The fixtures are bun's REAL output shapes, captured from
 * `bun test --parallel=4 packages/cf-backend/` on 2026-08-31: the per-test
 * `(pass) path > name [1.00ms]` lines, the bare `path:` heading bun prints per
 * file, and the `N pass` / `N fail` summary. A parser tested against invented
 * text proves nothing about the runner it reads.
 */

import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_RUNS, HAMMER_SUITE, artifactPath, measuredFiles, reportedCounts, spawnContention,
} from './hammer';
import { claims, LADDER } from './ladder';
import { trackedFiles } from './sources';

/** Bun's real output, trimmed to the shapes the parse reads. */
const REAL_OUTPUT = `bun test v1.4.0 (34cbb9a40)

packages/cf-backend/tests/unit-facet-reconciliation.test.ts:
[test-preload] ignoring ambient NO_COLOR — a signed-in shell is not an input to a suite
(pass) reconcileExplorationFacets > a terminal-ledger facet is reclaimed [1.19ms]
(pass) reconcileExplorationFacets > a resumable-ledger facet is preserved even when idle [0.31ms]

packages/cf-backend/tests/unit-backend-twins.test.ts:
(pass) backend twin methods > no NEW twin: logic added to both backends belongs in core [0.20ms]

 2698 pass
 0 fail
 9806 expect() calls
Ran 2698 tests across 198 files. [9.47s]
`;

/** The same run with one file failing, as bun prints a failure. */
const FAILING_OUTPUT = `bun test v1.4.0 (34cbb9a40)

packages/cf-backend/tests/unit-zz-flake.test.ts:
11 |   test('passes the first time this suite is run and fails afterwards', () => {
                                                            ^
error: expect(received).toBe(expected)
(fail) intermittently failing fixture > passes the first time [0.83ms]

 2698 pass
 1 fail
 9807 expect() calls
Ran 2699 tests across 199 files. [11.02s]
`;

describe('what a run REPORTED, read from bun\'s own output', () => {
  test('every file bun names is measured, from the per-test line and from the heading', () => {
    // BOTH shapes, because a file whose every test fails contributes no
    // `(pass)` line: reading only those would make a fully-red file look
    // like a file that never ran, which is a different finding with a
    // different fix.
    expect(measuredFiles(REAL_OUTPUT)).toEqual([
      'packages/cf-backend/tests/unit-backend-twins.test.ts',
      'packages/cf-backend/tests/unit-facet-reconciliation.test.ts',
    ]);
    expect(measuredFiles(FAILING_OUTPUT)).toEqual([
      'packages/cf-backend/tests/unit-zz-flake.test.ts',
    ]);
  });

  test('an output with no summary measures NOTHING rather than passing', () => {
    // The silent zero, and the whole reason the gate reads counts at all: a
    // `bun test` whose target selected no file exits 0 and prints no summary.
    // RED before this: the gate read the exit code and reported a clean tree
    // over a run that did nothing.
    expect(reportedCounts('bun test v1.4.0\nRan 0 tests across 0 files.')).toEqual({
      passed: 0, failed: 0,
    });
    expect(measuredFiles('bun test v1.4.0\nRan 0 tests across 0 files.')).toEqual([]);
  });

  test('the summary counts are read as bun writes them', () => {
    expect(reportedCounts(REAL_OUTPUT)).toEqual({ passed: 2698, failed: 0 });
    expect(reportedCounts(FAILING_OUTPUT)).toEqual({ passed: 2698, failed: 1 });
  });

  test('a governed file absent from the measured set is visible in both directions', () => {
    // The comparison the gate makes per run, over the two real shapes. A
    // governed file that reported nothing (it stopped being selected, or it
    // failed to load) and a reported file the enumeration does not carry are
    // different findings, and both must be nameable.
    const governed = [
      'packages/cf-backend/tests/unit-backend-twins.test.ts',
      'packages/cf-backend/tests/unit-facet-reconciliation.test.ts',
      'packages/cf-backend/tests/unit-never-selected.test.ts',
    ];
    const measured = measuredFiles(REAL_OUTPUT);
    expect(governed.filter((file) => !measured.includes(file)))
      .toEqual(['packages/cf-backend/tests/unit-never-selected.test.ts']);
    expect(measuredFiles(FAILING_OUTPUT).filter((file) => !governed.includes(file)))
      .toEqual(['packages/cf-backend/tests/unit-zz-flake.test.ts']);
  });
});

describe('the governed set is the ladder\'s, not the gate\'s own', () => {
  test('the hammered command is a real gate, resolved through the one enumeration', () => {
    // The gate hammers what a tier already runs — the same string, resolved by
    // the same `claims()` the ladder uses. A private spelling here would let
    // the two drift, and the hammer would be reporting on a set no tier owns.
    expect(LADDER.some((gate) => gate.run === HAMMER_SUITE)).toBe(true);
    const governed = claims(HAMMER_SUITE, trackedFiles());
    expect(governed.length).toBeGreaterThan(100);
    expect(governed.every((file) => file.startsWith('packages/cf-backend/'))).toBe(true);
  });

  test('the default run count is more than one, or the lane is just another tier', () => {
    // A one-run hammer is the tier above it with extra steps: the intermittent
    // failure this gate exists for was green on run 1 and red on run 2.
    expect(DEFAULT_RUNS).toBeGreaterThan(1);
  });
});

describe('contention is real, bounded, and released', () => {
  test('the burners run and stop being ours when the handle is dropped', () => {
    // A gate claiming to measure under load while spawning nothing would read
    // green over the ordinary tier's conditions. Two burners for a moment, so
    // the assertion is about the mechanism rather than about the box.
    const burners = spawnContention(2, 2_000);
    expect(burners.length).toBe(2);
    for (const burner of burners) burner.kill();
    // The spin is SELF-BOUNDED as well as killed, so a SIGKILLed gate cannot
    // leave a machine at 100% forever; killing twice is safe.
    for (const burner of burners) burner.kill();
  });
});

describe('the evidence has a durable home', () => {
  test('the artifact lands under bench-artifacts, never the swept temp directory', () => {
    // `scripts/bench-retention.ts` refuses `/tmp` for evidence because the test
    // preload sweeps it: an artifact written there is gone by the time somebody
    // reads the failure.
    const path = artifactPath(new Date('2026-08-31T17:01:41.002Z'));
    expect(path).toContain('/bench-artifacts/hammer/');
    expect(path).not.toContain('/tmp/');
    expect(path.endsWith('.json')).toBe(true);
    // A stamp per run, so a second failure never overwrites the first one's
    // block — which is the whole point of keeping it.
    expect(artifactPath(new Date('2026-08-31T17:01:42.002Z'))).not.toBe(path);
  });
});
