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
  BURNER, DEFAULT_RUNS, HAMMER_SUITE, artifactPath, failingTests, hammerOnce, measuredFiles, reportedCounts,
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

  test('a failing test is named with the file whose heading it follows', () => {
    // What a run's line prints on a red run, so the name has to be the test bun failed and no other.
    expect(failingTests(FAILING_OUTPUT))
      .toEqual(['packages/cf-backend/tests/unit-zz-flake.test.ts > intermittently failing fixture > passes the first time']);
    expect(failingTests(REAL_OUTPUT)).toEqual([]);
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

describe('contention ends with the gate however the gate ends', () => {
  // A SIGKILLed gate runs no cleanup of its own, and the kernel closing its pipes is all a burner then sees: the end
  // of its stdin. A burner that ended only when killed would spin on after the gate.
  test('a burner exits when its stdin ends', async () => {
    const burner = Bun.spawn([...BURNER], { stdin: 'pipe', stdout: 'inherit', stderr: 'inherit' });

    await burner.stdin.end();

    expect(await burner.exited).toBe(0);
  });
});

describe('a run is ended by its silence, never by its length', () => {
  // SLOW IS NOT HUNG. 2026-09-30: five of six runs under load were killed at a per-run wall deadline with not one
  // failing test between them (2,460 to 3,616 of 3,624 passed); the run allowed to finish passed all 3,624. These
  // runs are real processes on the real clock the hang detector reads, which no fake timer in this process drives.
  test('a run that writes throughout is not killed for outlasting its bound', async () => {
    const run = await hammerOnce(1, {
      argv: [process.execPath, '-e', 'for (let line = 0; line < 25; line += 1) { console.log(line); await Bun.sleep(100); }'],
      seconds: 1,
      label: 'a slow run that writes',
    });

    expect(run.killed).toBe(false);
    expect(run.exit).toBe(0);
    expect(run.seconds).toBeGreaterThan(2);
  });

  test('a run that writes nothing for its bound is ended', async () => {
    const run = await hammerOnce(1, {
      argv: [process.execPath, '-e', 'console.log("started"); await Bun.sleep(30_000);'],
      seconds: 1,
      label: 'a silent run',
    });

    expect(run.killed).toBe(true);
    expect(run.seconds).toBeLessThan(15);
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
