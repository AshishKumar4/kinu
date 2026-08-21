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
  CI_EXEMPT, HOOKS_DIR, LADDER, TIERS, bunIgnoredPatterns, bunWouldSkip, claims, deployGates,
  gatesFor, packageScripts, runnableArgv, trackedTestFiles,
} from './ladder';
import { isRunnableSuite } from './sources';

const root = resolve(import.meta.dir, '..');
const tracked = trackedTestFiles();
const deploy = deployGates();

/**
 * Path PREFIXES whose test files deliberately run under no `bun test` tier, each
 * naming the runner that does claim them.
 *
 * `tools/oxlint/anti-slop/` needs Node's raw transfer for oxlint's RuleTester
 * and ERRORS under bun, so it runs through `bun run test:anti-slop`
 * (node --experimental-strip-types) inside `bun run lint`, which is deploy
 * gate 1. A prefix rather than a file list because `rules.test.ts` is an
 * aggregator that IMPORTS the 19 per-rule suites — naming only the files on the
 * command line would leave those 19 reading as unclaimed.
 *
 * Excluding anything from bun's discovery is honest only because this list is
 * asserted, and asserted with a denominator: a prefix matching zero tracked
 * files is an excuse for nothing, and would silently excuse whatever is added
 * under it next.
 */
const NON_BUN_RUNNERS = {
  'tools/oxlint/anti-slop/':
    'bun run test:anti-slop — oxlint RuleTester requires Node raw transfer and throws under bun',
};

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
  'packages/test-utils': 'bun test packages/test-utils/',
  'packages/cf-backend': 'bun test packages/cf-backend/',
  'packages/cli-backend': 'bun test packages/cli-backend/',
  'packages/cli': 'bun test packages/cli/',
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
    // Derived, not counted. This was `toBe(6)`, and it drifted to 8 the moment
    // two `tests/evals/*.eval.test.ts` suites landed — the same defect as the
    // bench glob below, one line apart, blocking every push twice in an hour. A
    // cardinality assertion over a globbed set is drift by construction.
    //
    // Cross-checked rather than tautological: `claims()` resolves COMMAND TEXT,
    // while `isRunnableSuite` is a FILENAME rule, so agreement between them is a
    // real assertion about the recursion — and `./tests/` recursing is exactly
    // why `test:eval` names only that directory.
    const trackedSuitesUnderTests = tracked
      .filter((file) => file.startsWith('tests/') && isRunnableSuite(file))
      .sort();
    expect(trackedSuitesUnderTests.length).toBeGreaterThan(0);
    expect(claims('bun test ./tests/', tracked).sort()).toEqual(trackedSuitesUnderTests);
    // Enumerated, not counted: a bare length drifted from 3 to 4 the moment
    // `bench-inference-proxy.test.ts` landed, and a count cannot say WHICH file
    // the glob gained or lost. Naming the set makes a new bench suite a
    // deliberate edit here rather than a silently absorbed number.
    expect(claims('bun test scripts/bench*.test.ts', tracked).sort()).toEqual([
      'scripts/bench-corpus-gate.test.ts',
      'scripts/bench-external.test.ts',
      'scripts/bench-inference-proxy.test.ts',
      'scripts/bench-pi-worker.test.ts',
      'scripts/bench.test.ts',
    ]);
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
  test('the CI tier plus the declared non-bun runners cover all of them', () => {
    // The failure this prevents: a suite that exists, passes when someone runs
    // it by hand, and is in no pipeline. That was true of packages/compaction
    // (95 tests), agent-utils (12), pc-agent (6), 41 of 42 cli files and the
    // whole root tests/ directory, all of which a green CI badge covered for.
    const covered = new Set(gatesFor('ci', deploy).flatMap((gate) => claims(gate.run, tracked)));
    const unclaimed = tracked
      .filter((path) => !covered.has(path)
        && !Object.keys(NON_BUN_RUNNERS).some((prefix) => path.startsWith(prefix)))
      .map((path) => `${path} — no tier runs this file`);
    expect(unclaimed).toEqual([]);
  });

  test('every declared non-bun runner still claims real files', () => {
    // A prefix that matches nothing reads as a considered decision about a
    // runner that no longer has anything to run, and pre-excuses the next file
    // added under it.
    const empty = Object.keys(NON_BUN_RUNNERS)
      .filter((prefix) => !tracked.some((path) => path.startsWith(prefix)))
      .map((prefix) => `${prefix} — declared as non-bun but matches no tracked test file`);
    expect(empty).toEqual([]);
  });

  test('the CLI suite is the only tier that runs its own files', () => {
    // `bun test packages/cli/` says so in prose, and said "41 of these 42 files"
    // until the 43rd landed. Derived as an empty overlap rather than as a count,
    // for the reason claims() gives above: a cardinality over a globbed set is
    // drift by construction, and this one drifted while nothing noticed.
    const cliGate = 'bun test packages/cli/';
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
    // the 8 workspace packages. Making it cover all 8 was measured and rejected
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
    expect(packages.size).toBe(8);

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
    // commit gates too: 31 entries declaring 68.0s in total. The tier MEASURES
    // 111-126s. The gap is not a stale declaration — `gate:dead-code` declares
    // 5.5s and walls 6.0s — it is 31 process spawns the sum does not model, plus
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
  // deploy.sh also passed the core bench units. The tier declared 398.8s and ran
  // 52 gates of which 50 were described.
  //
  // Synthesis stays: an undeclared deploy gate must still RUN. This is what makes
  // it also fail, by name, until somebody measures it.
  test('every gate the deploy tier runs carries a measured cost and a named blind spot', () => {
    const vague = gatesFor('deploy', deploy)
      .filter((gate) => gate.seconds <= 0 || gate.blind.length < 20 || gate.catches.length < 20)
      .map((gate) => gate.run);
    expect(vague).toEqual([]);
  });

  test('the CLI suite is the costliest gate at ci outside the live eval tier', () => {
    // Its `blind` claims this, and claimed it as "54% of the suite's wall clock
    // for 7.5% of its tests" — two percentages over denominators nobody could
    // reproduce, beside a pass count that had drifted by 17. An ordering over the
    // declared costs cannot rot: a gate that overtakes it turns this red on the
    // commit that makes the sentence wrong.
    const atCi = gatesFor('ci', deploy);
    const cliGate = 'bun test packages/cli/';
    const cli = atCi.find((gate) => gate.run === cliGate);
    if (!cli) throw new Error(`${cliGate} is not a gate at ci`);
    const dearer = atCi
      .filter((gate) => gate.run !== cliGate && gate.run !== 'bun run test:eval')
      .filter((gate) => gate.seconds >= cli.seconds)
      .map((gate) => `${gate.run} — ${String(gate.seconds)}s`);
    expect(dearer).toEqual([]);
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
