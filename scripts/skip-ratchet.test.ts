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
  mergeReports, parseJUnit, readSkipLock, reconcileSkips, skipDebt, unmatchedTargets,
  ALL_SKIP_RATCHET_TARGETS, SKIP_RATCHET_TARGETS, SKIP_RATCHET_VITEST_TARGETS, SKIP_LOCK_PATH,
  type TestReport,
} from './skip-ratchet';

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

/**
 * The exact shape VITEST's junit reporter emits, verbatim from a credential-free
 * run of `vitest.evals.config.ts`. Two differences carry the whole defect: there
 * is NO `file` attribute, and `classname` holds the path rather than the suite —
 * with the describe path already folded into `name`.
 */
const VITEST_REPORT = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="3" failures="0" errors="0" time="0.012">
    <testsuite name="tests/evals/behaviour.eval.ts" tests="3" failures="0" errors="0" skipped="2" time="0.012">
        <testcase classname="tests/evals/behaviour.eval.ts" name="Agent behaviour over the run-event ledger &gt; &apos;ws-inventory&apos; rep+0" time="0">
            <skipped/>
        </testcase>
        <testcase classname="tests/evals/behaviour.eval.ts" name="Agent behaviour over the run-event ledger &gt; &apos;ws-inventory&apos; rep1" time="0">
            <skipped/>
        </testcase>
        <testcase classname="tests/evals/behaviour.eval.ts" name="corpus quality — can this corpus rank anything at all &gt; the corpus is large enough for significance to be reachable" time="0.001">
        </testcase>
    </testsuite>
</testsuites>`;

/**
 * The LIVE SWARM arm's report, verbatim from a credential-free run of the third arm.
 *
 * Its own fixture rather than a variant of the one above, because the property the
 * two prove together is that each arm is INDEPENDENTLY provable: both are vitest, so
 * they share the reporter's shape and differ only in which file they name — which is
 * exactly the confusion a single fixture would hide. One skip and one test that runs,
 * which is what this arm reports with no credential.
 */
const SWARM_REPORT = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="2" failures="0" errors="0" time="0.044844334">
    <testsuite name="tests/evals/swarm.eval.ts" tests="2" failures="0" errors="0" skipped="1" time="0.044844334">
        <testcase classname="tests/evals/swarm.eval.ts" name="Swarm evals — a live measured search through the settled tool surface &gt; the settled surface is the path: swarm is offered, and an unknown field is refused by name" time="0.003815921">
        </testcase>
        <testcase classname="tests/evals/swarm.eval.ts" name="Swarm evals — a live measured search through the settled tool surface &gt; MEASURED: a live swarm crowns a winner that beats its own measured baseline" time="0">
            <skipped/>
        </testcase>
    </testsuite>
</testsuites>`;

/**
 * The RESEARCH, OPTIMIZATION and TRAJECTORY arms' reports, verbatim from a
 * credential-free run of each single-family file: the credential-free half runs,
 * the MEASURED half skips. One fixture each for the reason the swarm arm has its
 * own — all five vitest arms share one reporter shape and differ only in the
 * file they name, which is exactly what a shared fixture would hide.
 */
const RESEARCH_REPORT = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="3" failures="0" errors="0" time="0.5">
    <testsuite name="tests/evals/research.eval.ts" tests="3" failures="0" errors="0" skipped="1" time="0.5">
        <testcase classname="tests/evals/research.eval.ts" name="Research evals — a live retrieval from a controlled MCP source &gt; the corpus is controlled: facts in the archive, none of them in the prompt" time="0.001">
        </testcase>
        <testcase classname="tests/evals/research.eval.ts" name="Research evals — a live retrieval from a controlled MCP source &gt; the archive comes up through the product MCP client and both tools answer" time="0.4">
        </testcase>
        <testcase classname="tests/evals/research.eval.ts" name="Research evals — a live retrieval from a controlled MCP source &gt; MEASURED: the agent reads the archive and its report carries the planted facts and the canary" time="0">
            <skipped/>
        </testcase>
    </testsuite>
</testsuites>`;

const OPTIMIZATION_REPORT = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="2" failures="0" errors="0" time="0.1">
    <testsuite name="tests/evals/optimization.eval.ts" tests="2" failures="0" errors="0" skipped="1" time="0.1">
        <testcase classname="tests/evals/optimization.eval.ts" name="Optimization evals — a measured challenge with a pre-registered threshold &gt; the threshold is a bar something can clear and something can miss" time="0.002">
        </testcase>
        <testcase classname="tests/evals/optimization.eval.ts" name="Optimization evals — a measured challenge with a pre-registered threshold &gt; MEASURED: the agent attains the threshold on the metered instrument" time="0">
            <skipped/>
        </testcase>
    </testsuite>
</testsuites>`;

/** The TRAJECTORY arm, which is CLOUD ONLY: `eval-tier.sh` runs it under
 *  `--backend cloud` alone, so a local run names no `--target` for it and this
 *  fixture is what proves the target is satisfiable when the arm DOES run. */
const TRAJECTORY_REPORT = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="6" failures="0" errors="0" time="0.1">
    <testsuite name="tests/evals/trajectory.eval.ts" tests="6" failures="0" errors="0" skipped="3" time="0.1">
        <testcase classname="tests/evals/trajectory.eval.ts" name="Trajectory evals — multi-turn episodes through the public API &gt; every case is multi-turn, uniquely named, and machine-checkable" time="0.002">
        </testcase>
        <testcase classname="tests/evals/trajectory.eval.ts" name="Trajectory evals — multi-turn episodes through the public API &gt; a closed turn with no tool call is refused, and a real trajectory is not" time="0.001">
        </testcase>
        <testcase classname="tests/evals/trajectory.eval.ts" name="Trajectory evals — multi-turn episodes through the public API &gt; a partial run is inadmissible, and a complete one carries the primary metric" time="0.001">
        </testcase>
        <testcase classname="tests/evals/trajectory.eval.ts" name="Trajectory evals — multi-turn episodes through the public API &gt; MEASURED: public-file-artifact" time="0">
            <skipped/>
        </testcase>
        <testcase classname="tests/evals/trajectory.eval.ts" name="Trajectory evals — multi-turn episodes through the public API &gt; MEASURED: public-steer-correction" time="0">
            <skipped/>
        </testcase>
        <testcase classname="tests/evals/trajectory.eval.ts" name="Trajectory evals — multi-turn episodes through the public API &gt; MEASURED: public-failure-recovery" time="0">
            <skipped/>
        </testcase>
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
    expect(report.failed).toEqual([]);
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
    expect(report.failed).toHaveLength(1);
    expect(report.skipped).toHaveLength(1);
  });

  // A live tier fails two ways that need opposite repairs: the model answered
  // wrongly, or the deployment never answered. `failures: number` said the same
  // thing for both, so an outage read as a behavioural regression.
  test('an environment failure is marked infrastructure, a wrong answer is not', () => {
    const outage = REPORT.replace(
      '<skipped />',
      '<failure message="INFRA FAILURE — the deployed worker did not answer: 503" />',
    );
    const [failure] = parseJUnit(outage).failed;
    expect(failure?.infra).toBe(true);

    const wrong = REPORT.replace('<skipped />', '<failure message="expected 4 got 5" />');
    expect(parseJUnit(wrong).failed[0]?.infra).toBe(false);
  });

  // The marker survives the reporter's escaping. Bun writes the message into an
  // XML attribute, so a classifier reading the raw body would miss a marker that
  // arrived beside an escaped character and silently call an outage behavioural.
  test('the marker is read after unescaping, not before', () => {
    const escaped = REPORT.replace(
      '<skipped />',
      '<failure message="INFRA FAILURE &amp;mdash; the worker did not answer" />',
    );
    expect(parseJUnit(escaped).failed[0]?.infra).toBe(true);
  });

  test('an empty report measures nothing, and says so as zero rather than clean', () => {
    const report = parseJUnit('<testsuites name="bun test" tests="0" />');
    expect(report.total).toBe(0);
    expect(report.files.size).toBe(0);
    expect(report.skipped).toEqual([]);
  });

  // RED BEFORE: `file` came back '' for every vitest testcase, so `files` was
  // empty, `unmatchedTargets` called the vitest target missing, and the arm's 35
  // skips could not be reconciled against anything.
  test('a vitest testcase is attributed to the path in classname, not to nothing', () => {
    const report = parseJUnit(VITEST_REPORT);
    expect(report.total).toBe(3);
    expect([...report.files]).toEqual(['tests/evals/behaviour.eval.ts']);
    expect(report.skipped.map((s) => s.file)).toEqual([
      'tests/evals/behaviour.eval.ts', 'tests/evals/behaviour.eval.ts',
    ]);
  });

  test('a vitest key names the file once — the describe path is already in name', () => {
    const [first] = parseJUnit(VITEST_REPORT).skipped;
    expect(first?.key).toBe(
      "tests/evals/behaviour.eval.ts › Agent behaviour over the run-event ledger > 'ws-inventory' rep+0",
    );
  });

  test('bun keys still carry file, suite and name — the fallback did not displace them', () => {
    expect(parseJUnit(REPORT).skipped.map((s) => s.key)).toEqual([
      'tests/a.test.ts › Suite A › skips one',
      'tests/a.test.ts › Suite A › skips two & more',
    ]);
  });
});

describe('mergeReports', () => {
  test('one verdict over both arms, since neither runner can see the other\'s files', () => {
    const merged = mergeReports([parseJUnit(REPORT), parseJUnit(VITEST_REPORT)]);
    expect(merged.total).toBe(6);
    expect(merged.skipped.length).toBe(4);
    expect([...merged.files].sort()).toEqual([
      'tests/a.test.ts', 'tests/evals/behaviour.eval.ts',
    ]);
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

  // A parametrised family is declared once, so the gate does not become a
  // transcript of `corpus × repeats` that any corpus edit or a stray
  // KINU_EVAL_REPEATS turns red for no defect.
  test('a family entry declares every generated case under its prefix', () => {
    const vitest = parseJUnit(VITEST_REPORT);
    const verdict = reconcileSkips(vitest, [{
      key: 'tests/evals/behaviour.eval.ts › Agent behaviour over the run-event ledger',
      reason: 'needs a live model', family: true,
    }]);
    expect(verdict).toEqual({ added: [], stale: [] });
  });

  // The other direction, so a family entry cannot become a check that runs and
  // cannot fail: if the whole arm stopped skipping, the entry is stale.
  test('a family entry nothing matched is stale, not silently satisfied', () => {
    const verdict = reconcileSkips(parseJUnit(REPORT), [
      { key: 'tests/a.test.ts › Suite A › skips one', reason: 'declared' },
      { key: 'tests/a.test.ts › Suite A › skips two & more', reason: 'declared' },
      { key: 'tests/evals/behaviour.eval.ts › Agent behaviour', reason: 'gone', family: true },
    ]);
    expect(verdict.stale).toEqual(['tests/evals/behaviour.eval.ts › Agent behaviour']);
  });

  test('a family prefix declares nothing outside itself', () => {
    const vitest = parseJUnit(VITEST_REPORT.replace(
      'corpus quality — can this corpus rank anything at all &gt; the corpus is large enough for significance to be reachable" time="0.001">',
      'corpus quality — can this corpus rank anything at all &gt; the corpus is not saturated" time="0"><skipped/>',
    ));
    const verdict = reconcileSkips(vitest, [{
      key: 'tests/evals/behaviour.eval.ts › Agent behaviour over the run-event ledger',
      reason: 'needs a live model', family: true,
    }]);
    expect(verdict.added).toEqual([
      'tests/evals/behaviour.eval.ts › corpus quality — can this corpus rank anything at all > the corpus is not saturated',
    ]);
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

  /** The two bun targets added after `./tests/`: a directory nothing else claims
   *  and a named file. Both are needed here because the default list is what
   *  `unmatchedTargets` proves, and a fixture short of it would make the
   *  all-arms assertion below pass over a target nobody reported. */
  const CORE_E2E_REPORT = `<?xml version="1.0"?>
<testsuites name="bun test" tests="1" failures="0" skipped="1">
  <testsuite name="packages/core/tests/e2e/mcts-e2e.test.ts" file="packages/core/tests/e2e/mcts-e2e.test.ts" tests="1">
    <testcase name="full search cycle" classname="E2E MCTS with real LLM" file="packages/core/tests/e2e/mcts-e2e.test.ts" line="122">
      <skipped />
    </testcase>
  </testsuite>
</testsuites>`;
  const BENCH_EXTERNAL_REPORT = `<?xml version="1.0"?>
<testsuites name="bun test" tests="1" failures="0" skipped="0">
  <testsuite name="scripts/bench-external.test.ts" file="scripts/bench-external.test.ts" tests="1">
    <testcase name="the corpus it looks for is inside the tree it runs from" classname="the Terminal-Bench arm before it spends anything" file="scripts/bench-external.test.ts" line="340" />
  </testsuite>
</testsuites>`;

  // RED BEFORE: `./tests/` is satisfied by the bun arm alone, so a run that
  // reported only bun looked complete while the whole vitest arm went unmeasured.
  // The two later bun targets are unmatched here for the same reason: a report
  // from the root suites says nothing about `packages/core/tests/e2e/` or the
  // bench rig, which is exactly why each is its own target.
  test('a report from the root suites alone leaves every other target unmatched', () => {
    expect(unmatchedTargets(parseJUnit(REPORT))).toEqual([
      './packages/core/tests/e2e/', './scripts/bench-external.test.ts',
      ...SKIP_RATCHET_VITEST_TARGETS,
    ]);
  });

  test('every arm reporting satisfies every target', () => {
    const merged = mergeReports(
      [REPORT, CORE_E2E_REPORT, BENCH_EXTERNAL_REPORT,
        VITEST_REPORT, SWARM_REPORT, RESEARCH_REPORT, OPTIMIZATION_REPORT,
        TRAJECTORY_REPORT]
        .map((xml) => parseJUnit(xml)),
    );
    expect(unmatchedTargets(merged)).toEqual([]);
  });

  // ONE ARM AT A TIME, both directions, because the five vitest arms are the set a
  // single target could not tell apart: they run under one config and differ only in
  // the file they select, so a report from any one must leave every OTHER owing one.
  test('a report from one vitest arm leaves the bun target and every other arm unmatched', () => {
    const arms: readonly { readonly file: string; readonly xml: string }[] = [
      { file: './tests/evals/behaviour.eval.ts', xml: VITEST_REPORT },
      { file: './tests/evals/swarm.eval.ts', xml: SWARM_REPORT },
      { file: './tests/evals/research.eval.ts', xml: RESEARCH_REPORT },
      { file: './tests/evals/optimization.eval.ts', xml: OPTIMIZATION_REPORT },
      { file: './tests/evals/trajectory.eval.ts', xml: TRAJECTORY_REPORT },
    ];
    // The fixture set and the target list are the same set, or an arm added to
    // one and not the other would silently shrink this proof.
    expect(arms.map((arm) => arm.file).sort()).toEqual([...SKIP_RATCHET_VITEST_TARGETS].sort());
    for (const arm of arms) {
      expect(unmatchedTargets(parseJUnit(arm.xml))).toEqual([
        ...SKIP_RATCHET_TARGETS,
        ...SKIP_RATCHET_VITEST_TARGETS.filter((target) => target !== arm.file),
      ]);
    }
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

  // A family entry that named only a file would declare every test in it,
  // including ones nobody looked at — this gate's own defect class. Requiring the
  // suite separator is what keeps the prefix narrower than the file.
  test('every family entry names a suite, never a bare file', () => {
    const families = readSkipLock().filter((e) => e.family === true);
    expect(families.length).toBeGreaterThan(0);
    for (const entry of families) {
      expect(entry.key).toContain('.ts › ');
      expect(entry.key.split(' › ')[1]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  test('the gate declares both runners\' targets and its lock path', () => {
    expect(SKIP_RATCHET_TARGETS.length).toBeGreaterThan(0);
    expect(SKIP_RATCHET_VITEST_TARGETS.length).toBeGreaterThan(0);
    // The leading `./` is load bearing — see unmatchedTargets above.
    for (const target of ALL_SKIP_RATCHET_TARGETS) expect(target.startsWith('./')).toBe(true);
    // The vitest arm is named as a FILE on purpose: a directory would be
    // satisfied by the bun suites that sit in the same one.
    for (const target of SKIP_RATCHET_VITEST_TARGETS) expect(target.endsWith('.eval.ts')).toBe(true);
    expect(SKIP_LOCK_PATH).toContain('skip-ratchet.lock.json');
  });
});

/**
 * With a target resolved every locked entry RUNS — all 25 are `skipIf(!TARGET)`,
 * measured: `bun test ./tests/live-smoke.test.ts` under KINU_EVAL_LIVE=1 ran
 * both of its locked entries, 3 model calls, 74.3s. Read as `stale` that made the
 * eval tier's own ratchet return 1 on every credentialed run.
 */
describe('skipDebt', () => {
  const verdict = { added: ['undeclared skip'], stale: ['locked, ran'] };

  test('credential-free, a locked entry that ran is debt — the ratchet tightens', () => {
    expect(skipDebt(verdict, { expectLive: false })).toEqual(['undeclared skip', 'locked, ran']);
  });

  test('with a target, a locked entry that ran is the tier working, not debt', () => {
    expect(skipDebt(verdict, { expectLive: true })).toEqual(['undeclared skip']);
  });

  test('an undeclared skip is debt in BOTH modes — that is the invariant this gate owns', () => {
    for (const expectLive of [true, false]) {
      expect(skipDebt({ added: ['x'], stale: [] }, { expectLive })).toEqual(['x']);
    }
  });
});

/**
 * The two properties `evals:cloud` needed and did not have: a target set that
 * follows the RUN, and a directory target only a file `bun test` can select may
 * answer for.
 */
describe('the target set is the executed set', () => {
  const cloudReport = (): TestReport => parseJUnit(`<?xml version="1.0"?>
<testsuites name="bun test" tests="1" failures="0" skipped="0">
  <testsuite name="tests/live-smoke.test.ts" file="tests/live-smoke.test.ts" tests="1">
    <testcase name="reaches the deployment" classname="Live Smoke" file="tests/live-smoke.test.ts" line="4" />
  </testsuite>
</testsuites>`);

  test('the full target list refuses a run that measured a deliberate subset', () => {
    // The defect: `bun run evals:cloud` runs two of five arms ON PURPOSE, and
    // the default list demanded reports from all five. Three targets came back
    // unmatched and the tier exited 1 having done exactly what it was told, so
    // every reachable "fix" was a weakening.
    const missing = unmatchedTargets(cloudReport(), ALL_SKIP_RATCHET_TARGETS);
    expect(missing).toContain('./tests/evals/behaviour.eval.ts');
    expect(missing).toContain('./tests/evals/research.eval.ts');
    expect(missing).toContain('./tests/evals/optimization.eval.ts');
  });

  test('naming the arms that ran clears it without weakening anything', () => {
    expect(unmatchedTargets(cloudReport(), ['tests/live-smoke.test.ts'])).toEqual([]);
  });

  test('a named target the run did not produce is still refused', () => {
    // The other direction, and the one that keeps `--target` from being an
    // escape hatch: a caller may narrow the CLAIM, never the proof. An arm
    // named and absent from the report is a crash, not a decision.
    expect(unmatchedTargets(cloudReport(), ['tests/live-smoke.test.ts', './tests/evals/swarm.eval.ts']))
      .toEqual(['./tests/evals/swarm.eval.ts']);
  });

  test('a vitest-only file cannot answer for a bun directory target', () => {
    // Narrowest-claim protects the four `*.eval.ts` files that have targets of
    // their own and reopens the hole for a fifth: a new
    // `tests/evals/planning.eval.ts` sits under `./tests/`, has no target, and
    // would have satisfied the BUN arm — so a bun arm that collected nothing
    // could look complete on the strength of a vitest file.
    const vitestOnly = parseJUnit(`<?xml version="1.0"?>
<testsuites name="vitest" tests="1" failures="0" skipped="0">
  <testsuite name="tests/evals/planning.eval.ts" tests="1">
    <testcase name="plans" classname="tests/evals/planning.eval.ts" />
  </testsuite>
</testsuites>`);
    expect(unmatchedTargets(vitestOnly, ['./tests/'])).toEqual(['./tests/']);
  });

  test('and a bun-discoverable file does', () => {
    expect(unmatchedTargets(cloudReport(), ['./tests/'])).toEqual([]);
  });

  test('every bun target is a path form bun actually selects with', () => {
    // `bun test tests` and `bun test tests/` both match NOTHING here; only the
    // leading `./` selects. A directory target must carry the trailing slash too,
    // because that is what marks it as a bun argv rather than a named file.
    for (const target of SKIP_RATCHET_TARGETS) {
      expect(target.startsWith('./')).toBe(true);
      expect(target.endsWith('/') || target.endsWith('.test.ts')).toBe(true);
    }
    expect(SKIP_RATCHET_TARGETS.length).toBeGreaterThan(1);
  });

  test('every locked key sits under some target, so no entry governs nothing', () => {
    // A lock entry whose file no target reaches can never go stale and can never
    // be reconciled: it is a reason nobody will ever have to defend again.
    const prefixes = ALL_SKIP_RATCHET_TARGETS.map((target) => target.replace(/^\.\//, ''));
    const orphans = readSkipLock(SKIP_LOCK_PATH)
      .filter((entry) => !prefixes.some((prefix) => entry.key.startsWith(prefix)))
      .map((entry) => entry.key);
    expect(orphans).toEqual([]);
  });
});
