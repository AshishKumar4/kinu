/**
 * The gate that guards the gates.
 *
 * Three of this repo's gates have reported green over something they never
 * looked at: a sabotage check the injected comment happened to satisfy, an
 * import walk that goes vacuous under an unrelated change, and a conformance
 * gate that flagged a missing table on one backend while tolerating the
 * identical absence on the other. The ladder is a fourth opportunity to do
 * that — a tier list is exactly the kind of thing that reads as complete while
 * claiming nothing — so every assertion here starts by proving its own
 * denominator is not zero.
 *
 * What this file does NOT do: prove that any individual gate can fail. That is
 * each gate's own self-test (`scripts/gates.test.ts` is the model) plus a seeded
 * red→green run that nobody has automated yet. This file proves WIRING only,
 * and the difference matters, because "the ladder is green" has to mean
 * something narrower than "the gates work".
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { git } from '@kinu.run/test-utils';
import * as v from 'valibot';
import {
  CI_EXEMPT, EVAL_TIER_SCRIPT, HOOKS_DIR, LADDER, TIERS, bunIgnoredPatterns, bunWouldSkip, claims,
  deployGates, evalTierArms, gatesFor, packageScripts, runnableArgv, trackedTestFiles,
} from './ladder';
import {
  ANTI_SLOP_ROOT, isAntiSlopRuleSuite, isAntiSlopSuite, isBunDiscoverableSuite, isPythonSuite,
  isRunnableSuite, isVitestEvalSuite,
} from './sources';
import { SKIP_RATCHET_VITEST_TARGETS } from './skip-ratchet';

const root = resolve(import.meta.dir, '..');
const tracked = trackedTestFiles();
const deploy = deployGates();

/**
 * Suites that deliberately run under no `bun test` tier, and the runner that
 * does claim each.
 *
 * `tools/oxlint/anti-slop/` needs Node's raw transfer for oxlint's RuleTester
 * and ERRORS under bun, so it runs through `bun run test:anti-slop`
 * (node --experimental-strip-types) inside `bun run lint`, which is deploy
 * gate 1.
 *
 * THIS WAS A PATH PREFIX AND THAT WAS THE HOLE. A prefix is satisfied by one
 * witness, so it excused the whole directory forever: measured 2026-08-30 the
 * 41 suites here are the disjoint union of 12 named on the `test:anti-slop`
 * command line and 29 the aggregator discovers under `rules/`, and a new
 * top-level `tools/oxlint/anti-slop/foo.test.ts` would have been claimed by the
 * prefix and executed by neither — `gate.test.ts` proves only that every
 * `*.gate.test.ts` is on the command line, which a plain `*.test.ts` is not.
 * So the excuse is now a PREDICATE with a total-coverage assertion behind it,
 * and the docstring quotes no count: the one it used to quote said 19.
 */
const NON_BUN_RUNNERS: readonly {
  readonly what: string;
  readonly holds: (file: string) => boolean;
  readonly runner: string;
}[] = [
  {
    what: 'tools/oxlint/anti-slop/',
    holds: isAntiSlopSuite,
    runner: 'bun run test:anti-slop — oxlint RuleTester requires Node raw transfer and throws under bun',
  },
];

/**
 * Suites whose ONLY runner sits after the CI tier, each naming the gate that
 * claims it. Pinned by equality below, so a new one is a deliberate edit here.
 *
 * These are the `*.eval.ts` files. They exist because the eval tier is the one
 * tier a pull request does not wait on, and until `claims()` learned bun's real
 * matcher they were credited to `bun test ./tests/` at the ci tier — a bun gate
 * that cannot select a `.eval.ts` at all. Four live eval suites therefore read
 * as CI-covered while the only thing that ran them was `bun run test:eval`,
 * which claimed nothing.
 */
const AFTER_CI_SUITES = {
  'tests/evals/behaviour.eval.ts': 'bun run test:eval',
  'tests/evals/device.eval.ts': 'bun run test:eval',
  'tests/evals/optimization.eval.ts': 'bun run test:eval',
  'tests/evals/research.eval.ts': 'bun run test:eval',
  'tests/evals/swarm.eval.ts': 'bun run test:eval',
  'tests/evals/trajectory.eval.ts': 'bun run test:eval',
} satisfies Record<string, string>;

/**
 * Workspace packages `bun run test` does NOT run, each naming the gate that
 * does. Pinned by equality by the test below, so an omission can never be an
 * omission by accident and can never mean "uncovered".
 *
 * The root script stops at three packages because both ways of extending it
 * were measured and both fail. One process (`bun test packages/`) is 4,839
 * tests across 412 files in 126.22s but 10 fail and 2 error, because bun keeps
 * one module mock per specifier for a whole run and the suites were written
 * Eight sequential processes cost ~170s declared. The push tier already MEASURES
 * 111-126s against a 180s ceiling, so adding 170s of declared work to it is not
 * a near miss — it is more than doubling a hook that exists to stay fast enough
 * that nobody is tempted by `--no-verify`.
 */
const ROOT_TEST_OMISSIONS = {
  'packages/devbox': 'bun test packages/devbox/',
  'packages/test-utils': 'bun test packages/test-utils/',
  'packages/cf-backend': 'bun test --parallel=4 packages/cf-backend/',
  'packages/cli-backend': 'bun test --parallel=4 packages/cli-backend/',
  'packages/cli': 'bun run test:cli',
  'packages/pc-agent': 'bun test packages/pc-agent/',
} satisfies Record<string, string>;

const omittedGate = (directory: string): string | undefined =>
  Object.entries(ROOT_TEST_OMISSIONS).find(([name]) => name === directory)?.[1];

describe('the ladder measures something', () => {
  test('deploy.sh parses to a non-empty gate list', () => {
    // A parser that silently matches no `run_required_gate` lines would make
    // every parity assertion below vacuously true. That is the exact shape of
    // unit-layergate.test.ts:70's import walk, and of assertEventSequence.
    expect(deploy.length).toBeGreaterThan(10);
  });

  test('git reports a non-empty set of test files', () => {
    expect(tracked.length).toBeGreaterThan(300);
  });

  test('every tier has gates, and every gate resolves to something runnable', () => {
    const scripts = new Set(Object.keys(packageScripts()));
    const unrunnable: string[] = [];
    for (const gate of gatesFor('deploy', deploy)) {
      const words = gate.run.split(/\s+/);
      if (words[0] === 'bun' && words[1] === 'run' && !scripts.has(words[2] ?? '')) {
        unrunnable.push(`${gate.run} — no package.json script named "${words[2] ?? ''}"`);
      }
    }
    expect(unrunnable).toEqual([]);
    for (const tier of TIERS) expect(gatesFor(tier, deploy).length).toBeGreaterThan(0);
  });

  test('claims() resolves the invocation forms this repo uses', () => {
    // The resolver decides both assertions below, so a resolver that returns
    // nothing would make both of them pass over an empty set.
    expect(claims('bun test packages/core/', tracked).length).toBeGreaterThan(100);
    expect(claims('bun test scripts/deploy.test.ts', tracked)).toEqual(['scripts/deploy.test.ts']);
    expect(claims('bun run test:cli', tracked).filter((path) => path.startsWith('packages/cli/tests/')).length)
      .toBeGreaterThan(40);
    // Derived, not counted. This was `toBe(6)`, and it drifted to 8 the moment
    // two `tests/evals/*.eval.test.ts` suites landed — the same defect as the
    // bench glob below, one line apart, blocking every push twice in an hour. A
    // cardinality assertion over a globbed set is drift by construction.
    //
    // `isBunDiscoverableSuite`, NOT `isRunnableSuite`, and that was the defect.
    // The runnable set counts `.eval.` because the lint rule governs those
    // files; `bun test` does not select them — measured, a directory of
    // `a.test.ts`, `c.spec.ts`, `d_test.ts`, `e_spec.ts`, `g.test.tsx`,
    // `b.eval.ts` and `f.eval.tsx` runs five files. So this assertion held
    // `bun test ./tests/` equal to a set containing four `*.eval.ts` suites bun
    // never runs, and CEMENTED the wrong ownership by equality: the eval tier's
    // whole vitest half read as covered by a ci-tier bun gate.
    //
    // Cross-checked rather than tautological: `claims()` resolves COMMAND TEXT,
    // while `isBunDiscoverableSuite` is a FILENAME rule, so agreement between
    // them is a real assertion about the recursion — and `./tests/` recursing is
    // exactly why `test:eval` names only that directory.
    const bunSuitesUnderTests = tracked
      .filter((file) => file.startsWith('tests/') && isBunDiscoverableSuite(file))
      .sort();
    expect(bunSuitesUnderTests.length).toBeGreaterThan(0);
    expect(claims('bun test ./tests/', tracked).sort()).toEqual(bunSuitesUnderTests);
    // The other half of the SAME partition, and a denominator for it: the files
    // under `tests/` that are runnable and NOT bun-discoverable are exactly the
    // eval tier's vitest suites, and there is at least one — otherwise the line
    // above would be trivially total.
    const vitestUnderTests = tracked
      .filter((file) => file.startsWith('tests/') && isVitestEvalSuite(file))
      .sort();
    expect(vitestUnderTests.length).toBeGreaterThan(0);
    expect(claims('bun test ./tests/', tracked).filter((path) => vitestUnderTests.includes(path)))
      .toEqual([]);
    expect([...bunSuitesUnderTests, ...vitestUnderTests].sort()).toEqual(
      tracked.filter((file) => file.startsWith('tests/') && isRunnableSuite(file)).sort(),
    );
    // The eval tier's own claim: the bun argv it runs plus every vitest eval
    // suite. It claimed NOTHING before `claims()` learned the form, which is why
    // the four files above had to be credited somewhere they could not run.
    expect(claims('bun run test:eval', tracked).sort())
      .toEqual([...bunSuitesUnderTests, ...vitestUnderTests].sort());
    // Enumerated, not counted: a bare length drifted from 3 to 4 the moment
    // `bench-inference-proxy.test.ts` landed, and a count cannot say WHICH file
    // the glob gained or lost. Naming the set makes a new bench suite a
    // deliberate edit here rather than a silently absorbed number.
    expect(claims('bun test scripts/bench*.test.ts', tracked).sort()).toEqual([
      'scripts/bench-corpus-gate.test.ts',
      'scripts/bench-devbox-decision.test.ts',
      'scripts/bench-devbox-workerd.test.ts',
      'scripts/bench-external.test.ts',
      'scripts/bench-fuse-probe.test.ts',
      'scripts/bench-inference-proxy.test.ts',
      'scripts/bench-pi-worker.test.ts',
      'scripts/bench-r2-workspace.test.ts',
      'scripts/bench.test.ts',
    ]);
    const durabilityProbeGate = LADDER.find(gate =>
      gate.run.includes('scripts/sandbox-durability-probe.test.ts'));
    expect(durabilityProbeGate?.tier).toBe('ci');
    // Spelled out, like the glob above and for the same reason: the nine rig
    // suites after the probe are named files, so a tenth is a deliberate edit here
    // rather than a suite that silently joined a measured row.
    expect(durabilityProbeGate?.run).toBe(
      'bun test scripts/bench*.test.ts packages/core/tests/unit-bench*.test.ts'
      + ' scripts/sandbox-durability-probe.test.ts'
      + ' scripts/capture-probe.test.ts scripts/capture-probe-live.test.ts'
      + ' scripts/storage-matrix-admission.test.ts scripts/storage-matrix-cleanup.test.ts'
      + ' scripts/storage-matrix-manifest.test.ts scripts/storage-matrix-protocol.test.ts'
      + ' scripts/deploy-substrate.test.ts scripts/payload-transport.test.ts'
      + ' scripts/devbox-e2e.test.ts',
    );
    // `bun run test` fans out through package.json into three package suites.
    expect(claims('bun run test', tracked).length).toBeGreaterThan(200);
    // The workerd layer resolves from its own command text, so it is
    // monotonicity- and reachability-checked like every bun suite.
    expect(claims('bun run test:workerd', tracked).length).toBeGreaterThan(0);
    // `--cwd` silently loads a different bunfig, so it claims nothing on
    // purpose — a gate spelled that way fails as an orphan instead of passing.
    expect(claims('bun test --cwd packages/core', tracked)).toEqual([]);
    // An unrecognised form claims NOTHING rather than being assumed to claim
    // everything — an optimistic resolver would recreate the defect this file
    // exists to prevent.
    expect(claims('wrangler deploy', tracked)).toEqual([]);
  });
});

describe('the ladder is monotone — commit ⊆ push ⊆ ci ⊆ deploy', () => {
  test('no tier claims a test file that a later tier does not', () => {
    // A gate at an early tier and not a later one means the later tier is the
    // WEAKER one, which is how a green deploy came to be compatible with a red
    // local run. Compared by claimed files rather than command text, so a gate
    // that gains an argument does not read as a hole.
    const claimedAt = TIERS.map((tier) => ({
      tier,
      files: new Set(gatesFor(tier, deploy).flatMap((gate) => claims(gate.run, tracked))),
    }));
    const regressions: string[] = [];
    for (const [index, lower] of claimedAt.entries()) {
      const higher = claimedAt[index + 1];
      if (higher === undefined) continue;
      for (const file of lower.files) {
        if (!higher.files.has(file)) regressions.push(`${file} runs at ${lower.tier} but not at ${higher.tier}`);
      }
    }
    expect(regressions).toEqual([]);
  });

  test('every gate declared here is covered at deploy', () => {
    // A gate that runs at commit and not at deploy would make the deploy path
    // the weaker one. Test gates are compared by the files they claim, so
    // `bun test scripts/bench*.test.ts` at CI is satisfied by deploy.sh's wider
    // `scripts/bench*.test.ts packages/core/tests/unit-bench*.test.ts` line;
    // non-test gates have no files to compare and must match by command.
    const atDeploy = new Set(deploy);
    const filesAtDeploy = new Set(deploy.flatMap((run) => claims(run, tracked)));
    const orphans: string[] = [];
    for (const gate of LADDER) {
      // The `evals` tier is deliberately NOT a deploy gate: live-model
      // behavioural evidence a deploy must not wait on or pay for. Its
      // deliberate runner is `bun run evals:full`, and TIERS' own doc carries
      // the reason. Every other tier must still be covered at deploy.
      if (gate.tier === 'evals') continue;
      if (atDeploy.has(gate.run)) continue;
      const files = claims(gate.run, tracked);
      if (files.length === 0) {
        orphans.push(`${gate.run} (tier ${gate.tier}) runs no test file and is in no deploy.sh gate line`);
        continue;
      }
      const missing = files.filter((file) => !filesAtDeploy.has(file));
      if (missing.length > 0) {
        orphans.push(`${gate.run} (tier ${gate.tier}) claims ${String(missing.length)} file(s) no deploy gate runs, e.g. ${missing[0] ?? ''}`);
      }
    }
    expect(orphans).toEqual([]);
  });
});

describe('CI is not a silent subset of deploy', () => {
  test('every deploy gate is covered by the CI tier or carries a written exemption', () => {
    // This is the whole point. On 2026-08-17 ci.yml claimed 339 of 400 test
    // files and deploy.sh claimed 395, and nothing anywhere said so — a green
    // badge was meaningfully weaker than a green local run and the delta was
    // invisible. After this assertion the delta can only ever be a decision
    // someone wrote down.
    const ci = gatesFor('ci', deploy);
    const atCi = new Set(ci.map((gate) => gate.run));
    const filesAtCi = new Set(ci.flatMap((gate) => claims(gate.run, tracked)));
    const undeclared: string[] = [];
    for (const run of deploy) {
      if (atCi.has(run) || Object.hasOwn(CI_EXEMPT, run)) continue;
      const files = claims(run, tracked);
      const missing = files.filter((file) => !filesAtCi.has(file));
      if (files.length === 0 || missing.length > 0) {
        undeclared.push(
          `${run} — runs at deploy only, with no reason recorded in CI_EXEMPT`
          + (missing.length > 0 ? ` (${String(missing.length)} unclaimed file(s), e.g. ${missing[0] ?? ''})` : ''),
        );
      }
    }
    expect(undeclared).toEqual([]);
  });

  test('every exemption names a gate deploy.sh actually runs', () => {
    // A stale exemption is worse than a missing one: it reads as a considered
    // decision about a gate that no longer exists, and it silently excuses the
    // next gate that happens to be spelled the same way.
    const runs = new Set(deploy);
    const stale = Object.keys(CI_EXEMPT).filter((run) => !runs.has(run));
    expect(stale).toEqual([]);
  });

  test('ci.yml delegates to the ladder instead of keeping its own list', () => {
    // Three lists is worse than two. CI must not be able to enumerate suites
    // independently, because that is how it came to skip five packages.
    const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
    expect(workflow).toContain('scripts/ladder.ts --tier=ci');
    const enumerated = workflow
      .split('\n')
      .filter((line) => /^\s*run:\s*bun (test|run (test|layergate|check|gate:))/.test(line));
    expect(enumerated).toEqual([]);
  });
});

describe('every test file is claimed by some runner', () => {
  test('some tier runs every one of them', () => {
    // The failure this prevents: a suite that exists, passes when someone runs
    // it by hand, and is in no pipeline. That was true of packages/compaction
    // (95 tests), agent-utils (12), pc-agent (6), 41 of 42 cli files and the
    // whole root tests/ directory, all of which a green CI badge covered for.
    // It was also true of `bench/`'s three Python suites — 77 tests — which no
    // tier ran and which this denominator could not even see until
    // `isPythonSuite` put them in it.
    //
    // EVERY tier, up to and including `evals`. The ci-only version of this
    // assertion could not express "the eval tier owns these four files", so the
    // four were credited to a bun gate that cannot select them. The ci delta is
    // the next test's subject, declared file by file.
    const covered = new Set(gatesFor('evals', deploy).flatMap((gate) => claims(gate.run, tracked)));
    const unclaimed = tracked
      .filter((path) => !covered.has(path)
        && !NON_BUN_RUNNERS.some((runner) => runner.holds(path)))
      .map((path) => `${path} — no tier runs this file`);
    expect(unclaimed).toEqual([]);
  });

  test('the CI delta is exactly the declared after-CI suites, each really claimed', () => {
    // What a green CI badge does NOT mean, as a list rather than as a hope. Both
    // directions: a file outside `AFTER_CI_SUITES` that no ci gate claims is a
    // hole, and a file inside it that a ci gate DOES claim is a stale excuse.
    const atCi = new Set(gatesFor('ci', deploy).flatMap((gate) => claims(gate.run, tracked)));
    const declared = Object.keys(AFTER_CI_SUITES).sort();
    const missing = tracked
      .filter((path) => !atCi.has(path) && !NON_BUN_RUNNERS.some((runner) => runner.holds(path)))
      .sort();
    expect(missing).toEqual(declared);
    const wrong: string[] = [];
    for (const [path, gate] of Object.entries(AFTER_CI_SUITES)) {
      if (!claims(gate, tracked).includes(path)) {
        wrong.push(`${path} — declared as claimed by \`${gate}\`, which does not claim it`);
      }
      const tier = LADDER.find((entry) => entry.run === gate)?.tier;
      if (tier === undefined || TIERS.indexOf(tier) <= TIERS.indexOf('ci')) {
        wrong.push(`${path} — \`${gate}\` is at tier ${tier ?? 'none'}, which is ci or below`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test('every declared non-bun runner really reaches every file it excuses', () => {
    // A predicate matching nothing reads as a considered decision about a runner
    // that no longer has anything to run, and pre-excuses the next file added
    // under it. That is the weak half; the strong half is TOTALITY, which a path
    // prefix cannot give: this excuse used to be `'tools/oxlint/anti-slop/'` and
    // one witness satisfied it, so a new top-level `*.test.ts` there would have
    // been excused and executed by nobody.
    //
    // `bun run test:anti-slop` names 12 files on its command line and its first
    // target, `rules.test.ts`, dynamically imports the rest from the SAME
    // predicate this asserts against (`isAntiSlopRuleSuite`). So the executed set
    // is the disjoint union of those two, and the union must be the whole set.
    const empty = NON_BUN_RUNNERS
      .filter((runner) => !tracked.some((path) => runner.holds(path)))
      .map((runner) => `${runner.what} — declared as non-bun but matches no tracked test file`);
    expect(empty).toEqual([]);

    const governed = tracked.filter(isAntiSlopSuite).sort();
    const named = claims('bun run test:anti-slop', tracked).sort();
    const aggregated = tracked.filter(isAntiSlopRuleSuite).sort();
    expect(named.length).toBeGreaterThan(0);
    expect(aggregated.length).toBeGreaterThan(0);
    // Disjoint: a file both named and imported runs twice, and its RuleTester
    // state is per-module, so the second run's failures would report against a
    // suite the reader already saw pass.
    expect(named.filter((path) => aggregated.includes(path))).toEqual([]);
    expect([...named, ...aggregated].sort()).toEqual(governed);
    // The aggregator itself must be on the command line, or the 29 it imports are
    // reached by nothing.
    expect(named).toContain(`${ANTI_SLOP_ROOT}rules.test.ts`);
  });

  test('the Python suites are claimed by their own runner and by nothing else', () => {
    // A second language in the denominator, with the same rule: claimed equals
    // executed. `scripts/python-suites.ts` derives its discovery roots from
    // `isPythonSuite` over the one enumeration, so this compares the gate's claim
    // against the predicate the gate itself narrows by.
    const python = tracked.filter(isPythonSuite).sort();
    expect(python.length).toBeGreaterThan(0);
    expect(claims('bun run gate:python-suites', tracked).sort()).toEqual(python);
    // No bun gate may claim one: `bun test` cannot run Python, and a `.py` under
    // a directory target would be a claim over a file the runner skips.
    const elsewhere = gatesFor('evals', deploy)
      .filter((gate) => gate.run !== 'bun run gate:python-suites')
      .flatMap((gate) => claims(gate.run, tracked));
    expect(elsewhere.filter((path) => python.includes(path))).toEqual([]);
  });

  test('the eval tier\'s arms partition the vitest eval suites exactly once each', () => {
    // CONTAINMENT OVER THE EXECUTED SET, which is what the tier's own comments
    // claimed and nothing checked. The behaviour arm selects the config's
    // `include` and subtracts three named files; each of those three then selects
    // itself. Two spellings of one list, and the script says so twice — "the two
    // spellings have to be one string or the file runs twice and is billed twice"
    // — with nothing holding them equal.
    //
    // What that permits: a fourth single-family arm whose `--exclude` somebody
    // forgot runs ONE live episode in TWO arms, writes two spend files, and both
    // count as liveness. The tier would report more model calls for the same
    // work and read as healthier.
    const arms = evalTierArms();
    const onDisk = tracked.filter(isVitestEvalSuite).sort();
    expect(onDisk.length).toBeGreaterThan(0);

    // The single-family arms and the behaviour arm's exclusions are one list.
    expect([...arms.vitestSelected].sort()).toEqual([...arms.vitestExcluded].sort());
    expect(arms.vitestSelected.length).toBeGreaterThan(0);
    // No arm names a path twice, and every named path is a real tracked suite.
    expect(new Set(arms.vitestSelected).size).toBe(arms.vitestSelected.length);
    expect(arms.vitestSelected.filter((path) => !onDisk.includes(path))).toEqual([]);
    // And the behaviour arm's REMAINDER is the rest of the set, so every file on
    // disk is executed by exactly one arm. `BEHAVIOUR_EVAL` is the ratchet target
    // for that remainder, so it has to be inside it.
    const behaviour = onDisk.filter((path) => !arms.vitestSelected.includes(path));
    expect(behaviour.length).toBeGreaterThan(0);
    expect([...arms.vitestSelected, ...behaviour].sort()).toEqual(onDisk);

    // The bun arm's argv, resolved the same way every other gate's is. One entry,
    // because `arm` in the script carries one ratchet target per arm and refuses
    // more.
    expect(arms.bunTargets).toEqual(['./tests/']);
  });

  test('every eval-tier arm has a ratchet target and every target is an arm', () => {
    // The two lists that decide whether the tier can pass: `eval-tier.sh` names
    // an arm per invocation, and `skip-ratchet.ts` proves one target per arm
    // non-empty. A target with no arm is a report the run cannot produce — which
    // is exactly what made `bun run evals:cloud` exit 1 while measuring what it
    // was asked to — and an arm with no target is an arm whose silent zero
    // nothing catches.
    const script = readFileSync(resolve(root, EVAL_TIER_SCRIPT), 'utf8');
    const arms = evalTierArms(script);
    const vitestTargets = [...SKIP_RATCHET_VITEST_TARGETS].sort();
    const behaviour = tracked
      .filter((path) => isVitestEvalSuite(path) && !arms.vitestSelected.includes(path));
    expect([...arms.vitestSelected, ...behaviour].map((path) => `./${path}`).sort())
      .toEqual(vitestTargets);
    // The script passes each arm's target to the ratchet from the same array it
    // builds the reports from — asserted on the text because bash cannot import
    // the declaration and this is the line that keeps the two in step.
    expect(script).toContain('for target in "${ARM_TARGETS[@]}"; do RATCHET_ARGS+=(--target "$target"); done');
    // Each arm's target must be spelled from the one variable that also names the
    // path vitest selects, so a rename moves both at once.
    for (const name of [
      'BEHAVIOUR_EVAL', 'SWARM_EVAL', 'RESEARCH_EVAL', 'OPTIMIZATION_EVAL', 'TRAJECTORY_EVAL',
      'DEVICE_EVAL',
    ]) {
      expect(script).toContain(`"./$${name}"`);
    }
  });

  test('the CLI suite is the only tier that runs its own files', () => {
    // The CLI gate says so in prose, and said "41 of these 42 files" until the
    // 43rd landed. Derived as an empty overlap rather than as a count, for the
    // reason claims() gives above: a cardinality over a globbed set is drift by
    // construction, and this one drifted while nothing noticed.
    const cliGate = 'bun run test:cli';
    const cliFiles = claims(cliGate, tracked);
    expect(cliFiles.length).toBeGreaterThan(0);
    const elsewhere = new Set(gatesFor('ci', deploy)
      .filter((gate) => gate.run !== cliGate)
      .flatMap((gate) => claims(gate.run, tracked)));
    expect(cliFiles.filter((path) => elsewhere.has(path))).toEqual([]);
  });

  test('bun does not discover the files it cannot run', () => {
    // The other half of the same contract: tools/oxlint/anti-slop errors under
    // bun (oxlint's RuleTester needs Node raw transfer), the gitignored
    // external/ reference clones drag 2,521 foreign test files into a bare
    // `bun test`, and packages/*/tests/workerd imports `cloudflare:workers`,
    // which exists only inside the Workers runtime. Before the first two, the
    // root command never terminated — 900s+, and any real root-level regression
    // was buried. So bunfig excludes all three, and the exclusion is asserted
    // rather than assumed. Read from the parsed table, not grepped, so a
    // pattern that is present but malformed cannot satisfy this.
    const patterns = bunIgnoredPatterns();
    expect(patterns).toEqual(['**/external/**', 'tools/oxlint/anti-slop/**', '**/tests/workerd/**']);
  });

  test('the two runners cannot reach each other', () => {
    // The parallel-systems objection, answered mechanically rather than by
    // convention. Vitest exists here for ONE thing — Durable Object semantics
    // bun cannot express — and the only thing stopping it becoming a second
    // home for ordinary unit tests is that its `include` and bun's discovery
    // are disjoint by construction. Both halves are asserted, both with a
    // denominator, because an empty workerd layer would satisfy disjointness
    // trivially.
    const workerd = claims('bun run test:workerd', tracked);
    expect(workerd.length).toBeGreaterThan(0);
    expect(workerd.every((path) => bunWouldSkip(path))).toBe(true);

    const bunClaimed = gatesFor('ci', deploy)
      .filter((gate) => gate.run !== 'bun run test:workerd')
      .flatMap((gate) => claims(gate.run, tracked));
    expect(bunClaimed.filter((path) => workerd.includes(path))).toEqual([]);
    expect(bunClaimed.length).toBeGreaterThan(300);

    // And the vitest side names the same directory the bunfig pattern excludes,
    // so the two globs cannot drift apart into an overlap or into a gap.
    const vitestConfig = readFileSync(resolve(root, 'packages/cf-backend/vitest.config.ts'), 'utf8');
    expect(vitestConfig).toContain("include: ['tests/workerd/**/*.test.ts']");
  });

  test('the root test script covers every package or names the omission and its gate', () => {
    // `bun run test` is the most-typed command in the repo and it covers 3 of
    // the 9 workspace packages. Making it cover all 9 was measured and rejected
    // twice: as one process, `bun test packages/` is 4,839 tests in 126s with
    // 10 failures from cross-suite interference (bun keeps ONE module mock per
    // specifier for a whole run — see mockAgentsSdk's own docstring); as eight
    // sequential processes it declares ~170s against a 90s push budget. So the
    // omission stays, and this is what makes it a decision instead of an
    // accident: every omitted package is pinned by equality together with the
    // gate that does run it, and that gate must really claim its files.
    const packages = new Set(
      tracked.flatMap((path) => path.split('/').slice(0, 2).join('/'))
        .filter((prefix) => prefix.startsWith('packages/')),
    );
    expect(packages.size).toBe(9);

    const byRootScript = new Set(claims('bun run test', tracked));
    const atCi = gatesFor('ci', deploy);
    const wrong: string[] = [];
    for (const directory of packages) {
      const files = tracked.filter((path) => path.startsWith(`${directory}/`) && !bunWouldSkip(path));
      if (files.every((path) => byRootScript.has(path))) {
        if (omittedGate(directory) !== undefined) {
          wrong.push(`${directory} — declared omitted but \`bun run test\` runs it`);
        }
        continue;
      }
      const gate = omittedGate(directory);
      if (gate === undefined) {
        wrong.push(`${directory} — not in \`bun run test\` and not declared in ROOT_TEST_OMISSIONS`);
        continue;
      }
      const covers = claims(gate, tracked);
      if (!files.every((path) => covers.includes(path))) {
        wrong.push(`${directory} — declared omitted, but \`${gate}\` does not claim all ${String(files.length)} of its files`);
      }
      if (!atCi.some((entry) => entry.run === gate)) {
        wrong.push(`${directory} — declared omitted, and \`${gate}\` is not a gate at ci or below`);
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe('cost, so a tier that stops being run is a decision and not a drift', () => {
  test('the commit tier stays inside its budget', () => {
    // A hook slow enough to tempt `--no-verify` is a design failure, and
    // "never --no-verify" is a standing rule, so the budget is part of the
    // contract rather than an aspiration. 12s is affordable only because
    // TypeScript 7 took the 8-project typecheck from 64.9s to 6.9s.
    const cost = gatesFor('commit', deploy).reduce((sum, gate) => sum + gate.seconds, 0);
    expect(cost).toBeLessThan(15);
  });

  // MEASURED PUSH WALL CLOCK, seconds, one reading per push on 2026-08-19:
  // 111.7 113.4 114.7 116.9 118.1 119.3 120.3 121.0 122.3 123.1 126.4.
  // Re-measure by reading the figure `bun scripts/ladder.ts --tier=push` prints.
  const MEASURED_PUSH_SECONDS = 126.4;

  test('the declared sum is honest about each gate, and the tier is measured', () => {
    // TWO QUANTITIES, and conflating them is how this budget passed while the
    // hook took twice its allowance. `gatesFor` is cumulative, so a push runs the
    // commit gates too: 37 entries declaring 110.5s in total. The tier MEASURES
    // 111-126s. The gap is not a stale declaration — `gate:dead-code` declares
    // 5.5s and walls 6.0s — it is 37 process spawns the sum does not model, plus
    // `bun run` resolving a script before each one.
    //
    // So the declared sum is asserted as a FLOOR on honesty (no entry may claim
    // zero, which the test below covers) and the BUDGET is asserted against the
    // measurement. A budget compared to a sum of parts is a budget that cannot
    // see the thing it is protecting against, which is a hook slow enough to
    // tempt `--no-verify` — and never `--no-verify` is a standing rule, so this
    // budget is part of the contract rather than an aspiration.
    const declared = gatesFor('push', deploy).reduce((sum, gate) => sum + gate.seconds, 0);
    expect(declared).toBeGreaterThan(0);
    expect(declared).toBeLessThan(MEASURED_PUSH_SECONDS);
    expect(MEASURED_PUSH_SECONDS).toBeLessThan(180);
  });

  // OVER THE DEPLOY TIER'S REAL MEMBERSHIP, not over LADDER. `gatesFor('deploy')`
  // appends any deploy.sh line no LADDER entry names, at `seconds: 0` — so for as
  // long as this filtered LADDER, a gate could join the deploy path and cost
  // nothing on the tier's own cost line. Two did: `bun run verify:lean`, and the
  // bench command whose LADDER entry stopped at the `scripts/bench*` glob while
  // deploy.sh also passed the core bench units. The tier now declares 685.0s and
  // runs 57 gates, all described.
  //
  // Synthesis stays: an undeclared deploy gate must still RUN. This is what makes
  // it also fail, by name, until somebody measures it.
  test('every gate the deploy tier runs carries a measured cost and a named blind spot', () => {
    const vague = gatesFor('deploy', deploy)
      .filter((gate) => gate.seconds <= 0 || gate.blind.length < 20 || gate.catches.length < 20)
      .map((gate) => gate.run);
    expect(vague).toEqual([]);
  });

  test('heavy package gates use four isolated Bun workers', () => {
    const atCi = gatesFor('ci', deploy);
    for (const run of [
      'bun test --parallel=4 packages/cf-backend/',
      'bun test --parallel=4 packages/cli-backend/',
      'bun run test:cli',
    ]) {
      expect(atCi.some((gate) => gate.run === run), `${run} is not a gate at ci`).toBeTrue();
    }
    const packageJson = readFileSync(resolve(root, 'package.json'), 'utf8');
    expect(packageJson).toContain(
      '"test": "bun test --parallel=4 packages/agent-utils/ packages/core/ packages/compaction/"',
    );
  });
});

describe('the hooks run the tiers they claim to', () => {
  // A hook that names a tier it does not run is the "correct, wired, dead"
  // shape applied to the ladder itself: it reads as enforcement in review and
  // enforces nothing. Two of these files existing is not evidence that either
  // one invokes anything.
  const HOOKS = {
    'pre-commit': 'bun scripts/ladder.ts --tier=commit',
    'pre-push': 'bun scripts/ladder.ts --tier=push',
  };

  test('each hook exists, is executable, and invokes its tier', () => {
    for (const [name, invocation] of Object.entries(HOOKS)) {
      const path = resolve(root, HOOKS_DIR, name);
      expect(statSync(path).mode & 0o111).toBeGreaterThan(0);
      expect(readFileSync(path, 'utf8')).toContain(invocation);
    }
  });

  /**
   * `commit-msg` is not a tier and cannot be one: every tier takes no argument,
   * and this hook carries the path of the message git is about to write. So it is
   * held to a different, stronger assertion — that it runs the SAME program the
   * ladder declares. That equality is what stops it becoming the fifth list the
   * two tests above exist to prevent.
   */
  const PAYLOAD_HOOKS = {
    'commit-msg': 'bun run gate:commit-message',
  };

  test('the payload hook runs exactly the program its ladder gate runs', () => {
    const scripts = packageScripts();
    for (const [name, gate] of Object.entries(PAYLOAD_HOOKS)) {
      const path = resolve(root, HOOKS_DIR, name);
      expect(statSync(path).mode & 0o111).toBeGreaterThan(0);
      const declared = LADDER.find((entry) => entry.run === gate);
      expect(declared?.tier).toBe('commit');
      // `bun run gate:commit-message` resolves to `bun scripts/commit-hygiene.ts`,
      // and the hook must invoke that same program with git's message path
      // appended. Comparing the resolved body rather than the script NAME is what
      // makes a divergence impossible: renaming the program breaks this.
      const program = scripts[gate.split(' ')[2] ?? ''] ?? '';
      expect(program).toMatch(/^bun scripts\/\S+\.ts$/);
      expect(readFileSync(path, 'utf8')).toContain(`exec ${program} "$1"`);
    }
  });

  test('the installer writes a RELATIVE hooks path', () => {
    // The value git had was an absolute path to the main checkout's empty
    // `.git/hooks`, so all 42 worktrees resolved to one directory with no hooks
    // in it and both cheap tiers were decorative. A relative value is resolved
    // against each working tree's own root, and worktrees SHARE this config, so
    // relative is what makes one invocation cover every checkout. An absolute
    // path here would silently un-gate 41 of them, which is why the shape is
    // asserted and not just documented.
    expect(HOOKS_DIR.startsWith('/')).toBe(false);
    expect(readFileSync(resolve(root, 'scripts/ladder.ts'), 'utf8'))
      .toContain("'git', 'config', 'core.hooksPath', HOOKS_DIR");
    // And something has to run it on a tree nobody has prepared: a fresh
    // worktree, and a fresh CLONE — which setup-worktree.sh never sees.
    expect(readFileSync(resolve(root, 'scripts/setup-worktree.sh'), 'utf8'))
      .toContain('ladder.ts --install-hooks');
    const pkg: unknown = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    const scripts = v.parse(v.object({ scripts: v.record(v.string(), v.string()) }), pkg).scripts;
    expect(scripts.prepare).toContain('ladder.ts --install-hooks');
  });

  test('core.hooksPath IS configured in this checkout', () => {
    // The report inside `ladder --tier=…` states this; nothing failed on it, so
    // the ladder could run all four tiers green in a checkout whose two cheapest
    // tiers never executed. `prepare` now installs the hooks on every `bun
    // install`, in developer checkouts and CI alike, so a wrong value here is
    // unambiguously a fault rather than an artefact of where the gate is running.
    // `git()` gives `-C root` AND a GIT_-free environment, which is what makes
    // this ask about THIS checkout. `cwd` never did: with GIT_DIR pointing at an
    // unrelated repository whose core.hooksPath is WRONG-REPO-HOOKS, the `cwd:
    // root, env: process.env` form returned WRONG-REPO-HOOKS and the GIT_-free
    // form returned .githooks. A hook exports GIT_DIR, so the test named after
    // this checkout was answering about whatever the hook pointed at.
    const configured = git(root, 'config', '--get', 'core.hooksPath').trim();
    expect(configured).toBe(HOOKS_DIR);
  });

  test('no hook invokes a gate directly', () => {
    // The moment a hook runs its own command, the ladder has a fifth list and
    // the subset property that makes "never --no-verify" honest stops holding.
    for (const name of Object.keys(HOOKS)) {
      const body = readFileSync(resolve(root, '.githooks', name), 'utf8')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('#'));
      const direct = body.filter((line) => /\b(bun (test|run)|tsc|oxlint)\b/.test(line));
      expect(direct).toEqual([]);
    }
  });
});

describe('a gate the runner cannot spawn is a gate that does not exist', () => {
  // `Bun.spawnSync(gate.run.split(' '))` runs NO shell, so `bun test
  // scripts/bench*.test.ts` reached bun as a literal filter, matched nothing and
  // failed — while `claims()` credited that gate with three files and the
  // assertion above pinning the count at 3 was green throughout. deploy.sh puts
  // the identical string through bash, which expands it, so one declaration had
  // two semantics and the ci tier could never have passed while the deploy tier
  // always did. The previous checks here only bounded what `claims()`
  // OVER-claims (bunfig-excluded paths); this bounds the inverse.
  test('every gate resolves to an argv the runner can spawn', () => {
    const globbed = LADDER.filter((gate) => gate.run.includes('*'));
    expect(globbed.length).toBeGreaterThan(0);
    const unspawnable = gatesFor('deploy', deploy)
      .filter((gate) => runnableArgv(gate.run, tracked).some((word) => word.includes('*')))
      .map((gate) => gate.run);
    expect(unspawnable).toEqual([]);
  });

  test('a glob gate spawns exactly the files it is credited with', () => {
    for (const gate of LADDER.filter((entry) => entry.run.includes('*'))) {
      const spawned = runnableArgv(gate.run, tracked).filter((word) => word.includes('/'));
      expect(spawned).toEqual(claims(gate.run, tracked));
      expect(spawned.length).toBeGreaterThan(0);
    }
  });

  test('a glob that matches no tracked test file fails loudly', () => {
    // The empty-corpus pass. A filter matching nothing was previously
    // indistinguishable from a clean run, which is how this defect survived.
    expect(() => runnableArgv('bun test scripts/no-such-suite*.test.ts', tracked))
      .toThrow('glob matched no tracked test file');
  });

  test('no gate is spelled with shell syntax the runner does not implement', () => {
    // Declaration-time, so the next gate cannot arrive in the quiet mode of the
    // same defect: `bun test --grep 'foo bar'` splits into a silently wrong
    // argv, runs, and reports green over the wrong set. `*` is the one
    // metacharacter the runner resolves, from claims().
    const shellSyntax = gatesFor('deploy', deploy)
      .filter((gate) => /['"?$&|<>~`(){}[\]]/.test(gate.run))
      .map((gate) => gate.run);
    expect(shellSyntax).toEqual([]);
  });
});
