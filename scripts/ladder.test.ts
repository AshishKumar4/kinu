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
import { relative, resolve } from 'node:path';
import { childEnv, git } from '@kinu.run/test-utils';
import * as v from 'valibot';
import {
  BUDGET_TOLERANCE, CI_EXEMPT, HOOKS_DIR, LADDER, LIVE_TIER_SCRIPT, TIERS, bunIgnoredPatterns, bunWouldSkip, claims,
  DEPLOY_PHASES, browserModules, declaredTierCost, deployPlan, gatesFor, judgeBudgets, liveTierTargets, packageScripts,
  printPlan, readBudget, runnableArgv, sharedBrowserModules, sharedOf, trackedTestFiles, type LadderBudget,
} from './ladder';
import {
  ANTI_SLOP_ROOT, isAntiSlopRuleSuite, isAntiSlopSuite, isBunDiscoverableSuite, isParseable, isPythonSuite,
  isVitestEvalSuite, readMatching,
} from './sources';
import { SKIP_RATCHET_TARGETS } from './skip-ratchet';
import { declaredName, parse, walk } from './syntax';
import { auditClosure } from './ladder-audit';
import { gateEnvironment } from './ladder-cache';
import { deriveClosure, repoAt } from './ladder-closure';
import { QUIET_LOAD, readCosts } from './gate-cost';

const root = resolve(import.meta.dir, '..');

const tracked = trackedTestFiles();

/**
 * Suites that deliberately run under no `bun test` tier, and the runner that
 * does claim each.
 *
 * `tools/oxlint/anti-slop/` needs Node's raw transfer for oxlint's RuleTester
 * and ERRORS under bun, so it runs through `bun run test:anti-slop`
 * (node --experimental-strip-types) inside `bun run lint`, which is deploy
 * gate 1.
 *
 * THE EXCUSE IS A PREDICATE, NOT A PATH PREFIX. A prefix is satisfied by one
 * witness, so it excuses the whole directory forever: measured 2026-08-30 the
 * 41 suites here are the disjoint union of 12 named on the `test:anti-slop`
 * command line and 29 the aggregator discovers under `rules/`, and a new
 * top-level `tools/oxlint/anti-slop/<name>.test.ts` would be claimed by the
 * prefix and executed by neither — `gate.test.ts` proves only that every
 * `*.gate.test.ts` is on the command line, which a plain `*.test.ts` is not.
 * The predicate carries a total-coverage assertion behind it, and every count
 * here is a dated measurement rather than a live claim, because a live count
 * rots the moment a suite is added.
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
 * The `*.eval.ts` task files are here because the eval suite measures the
 * deployed product, which a pull request has not changed, and a `bun test` gate
 * cannot select a `.eval.ts` at all — so `bun run evals` is their only runner.
 * The live-app suite and the product flows are here because their own
 * deploy rows are their only runners: CI_EXEMPT carries why a pull request
 * cannot boot the product's dev server.
 */
const AFTER_CI_SUITES = {
  'evals/tasks/budget-board.eval.ts': 'bun run evals',
  'evals/tasks/lending-library.eval.ts': 'bun run evals',
  'evals/tasks/order-book.eval.ts': 'bun run evals',
  'evals/tasks/request-logs.eval.ts': 'bun run evals',
  'scripts/live-app-tier.test.ts': 'bun test --timeout=0 scripts/live-app-tier.test.ts',
  'scripts/product-flows.test.ts': 'bun scripts/with-dev-server.ts bun test --timeout=0 scripts/product-flows.test.ts',
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
 * Eight sequential processes cost ~170s declared. The push tier already declares
 * 379.71s and walls ~360s summed across per-gate runs, so adding 170s of declared
 * work to it is not a near miss — it is nearly half as much again on a hook whose whole
 * purpose is that nobody is tempted by `--no-verify`.
 */
const ROOT_TEST_OMISSIONS = {
  'packages/devbox': 'bun test --timeout=0 packages/devbox/',
  'packages/test-utils': 'bun test --timeout=0 packages/test-utils/',
  'packages/cf-backend': 'bun test --timeout=0 --parallel=4 packages/cf-backend/',
  'packages/cli-backend': 'bun test --timeout=0 --parallel=4 packages/cli-backend/',
  'packages/cli': 'bun run test:cli',
  'packages/pc-agent': 'bun test --timeout=0 packages/pc-agent/',
} satisfies Record<string, string>;

const omittedGate = (directory: string): string | undefined =>
  Object.entries(ROOT_TEST_OMISSIONS).find(([name]) => name === directory)?.[1];

describe('the ladder measures something', () => {
  test('the deploy plan holds every non-evals gate, in phase order, and nothing else', () => {
    // The plan is what `bash scripts/deploy.sh` schedules from — the one copy
    // of what blocks a publish. Until 2026-09-15 this parsed deploy.sh's own
    // `run_required_gate` lines and held them equal to the ladder; the parser
    // and the second list are gone, and the property is that the plan is the
    // ladder: every gate but the evals tier, each once, phases in order.
    const plan = deployPlan();
    expect(plan.length).toBeGreaterThan(10);
    expect(plan.map((row) => row.run).sort()).toEqual(LADDER.filter((gate) => gate.tier !== 'evals').map((gate) => gate.run).sort());
    const phaseIndex = plan.map((row) => DEPLOY_PHASES.indexOf(row.phase));
    expect([...phaseIndex].sort((a, b) => a - b)).toEqual(phaseIndex);
    // The printed form round-trips: what the runner reads is what was planned.
    const printed = printPlan(plan).split('\n').map((line) => line.split('\t'));
    expect(printed.map((fields) => fields[6])).toEqual(plan.map((row) => row.run));
    expect(printed.map((fields) => fields[5])).toEqual(plan.map((row) => row.shared));
    expect(printed.map((fields) => fields[0])).toEqual(plan.map((row) => row.phase));
  });

  test('the concurrent wave starts its longest measured rows first, and every alone phase keeps ladder order', () => {
    // Walls assigned against ladder order, so a plan that kept ladder order
    // inside the wave, or sorted the other way, reads the wrong row first.
    const real = readCosts();
    const ladderOrder = LADDER.map((gate) => gate.run);

    const costs = {
      ...real,
      rows: Object.fromEntries(Object.entries(real.rows).map(([run, cost]) => [run, { ...cost, wallSeconds: ladderOrder.indexOf(run) }])),
    };

    const plan = deployPlan(costs);
    const source = plan.filter((row) => row.phase === 'source').map((row) => costs.rows[row.run]?.wallSeconds ?? -1);

    expect(source.length).toBeGreaterThan(10);
    expect(source).toEqual([...source].sort((left, right) => right - left));

    const alone = plan.filter((row) => row.phase !== 'source').map((row) => ladderOrder.indexOf(row.run));
    expect(alone).toEqual(DEPLOY_PHASES.flatMap((phase) => LADDER.filter((gate) => gate.tier !== 'evals' && gate.phase === phase))
      .map((gate) => ladderOrder.indexOf(gate.run)));
  });

  // THE COST TABLE IS THE WAVE'S ONE SET OF FIGURES, and a figure for a row
  // that no longer exists is the same defect as a row with no figure: both are
  // a scheduler deciding from something nobody measured. `deployPlan()`
  // refuses the second at plan time; this names the first, which it cannot
  // see, and names the rows whose figures were taken on a busy box.
  test('the cost table measures exactly the rows the wave schedules concurrently', () => {
    const costs = readCosts();
    const runs = new Set(LADDER.map((gate) => gate.run));
    const stale = Object.keys(costs.rows).filter((run) => !runs.has(run));
    expect(stale, 'measured figures kept for rows that are no longer gates').toEqual([]);

    const unmeasured = deployPlan()
      .filter((row) => row.phase === 'source' && costs.rows[row.run] === undefined)
      .map((row) => row.run);

    expect(unmeasured, 'rows the wave runs concurrently with no measured cost').toEqual([]);

    // A row measured under load reads its achieved parallelism LOW, and a cost
    // read low is a row the wave over-admits. The runnable-task figure carries
    // such a row (gate-cost.ts), so this is a report and not a verdict — but
    // an unrepeated figure has to be visible somewhere.
    const contended = Object.entries(costs.rows)
      .filter(([, cost]) => cost.loadAtStart >= QUIET_LOAD)
      .map(([run]) => run);

    if (contended.length > 0) {
      console.log(`cost table: ${String(contended.length)} row(s) measured above load ${String(QUIET_LOAD)}; re-run with gate-cost-measure.ts --contended on a quiet box`);
    }
  });

  /* ── The browser-lane census ──────────────────────────────────────────
   *
   * A row that boots a headless browser holds ONE machine resource, and the
   * wave admits one holder at a time (deploy.sh). Which rows those are is
   * derived from the module closure, so nobody edits a list — and the census
   * below is the SECOND, independent detector, because a derivation nobody
   * can see failing is the shape this repository has shipped three times.
   *
   * The two disagree on purpose. The closure follows imports and knows that
   * `computed-style.test.ts` reaches Chrome three hops out; the census reads
   * each file for a browser LAUNCHER by name and knows nothing about imports.
   * A file that names a launcher and sits outside the closure is a row whose
   * browser use the wave cannot see, and that is the finding.
   *
   * Blind spot, written down: a suite that launches a browser while naming
   * neither a launcher nor an import of one — a binary reached through a
   * computed path, a helper in another language. Nothing in the tree does
   * that today, and both detectors would miss it.
   */

  /** A browser launcher, as the tree spells one. Independent of the import
   *  closure by construction: text in the file that claims it, and no import,
   *  which is the closure's to read (a type-only import launches nothing). */
  const BROWSER_LAUNCHER = /puppeteer\.launch|['"]playwright['"]|--headless|chrome-headless-shell|CHROME_PATH|google-chrome/u;

  /** Browser Rendering's client. Its `puppeteer.launch(binding)` drives a
   *  browser on Cloudflare through a Worker binding, so in a file that names
   *  this module and not puppeteer's own, that call launches nothing on this
   *  box — unless a suite's Miniflare binds Browser Rendering, which starts a
   *  local Chrome for it and which the guard below refuses. */
  const RENDERING_CLIENT = /['"]@cloudflare\/puppeteer['"]/u;

  const LOCAL_PUPPETEER = /['"]puppeteer['"]/u;

  function namesLauncher(text: string): boolean {
    const renderingOnly = RENDERING_CLIENT.test(text) && !LOCAL_PUPPETEER.test(text);

    return BROWSER_LAUNCHER.test(renderingOnly ? text.replaceAll('puppeteer.launch', '') : text);
  }

  /** Where Miniflare runs a Worker for a deploy row. */
  const VITEST_CONFIG = /(?:^|\/)vitest[^/]*\.config\.[cm]?[jt]s$/u;

  /** The configs whose Miniflare binds Browser Rendering: an object property
   *  named `browserRendering`, the option Miniflare starts a local Chrome for. */
  function bindingRendering(configs: ReadonlyMap<string, string>): string[] {
    return [...configs].filter(([file, text]) => {
      let binds = false;

      walk(parse(file, text).root, (node) => {
        if (node.type === 'Property' && declaredName(node) === 'browserRendering') binds = true;
      });

      return binds;
    }).map(([file]) => file);
  }

  /** This file, as the corpus names it. The census names the tokens it looks
   *  for, so it matches ITSELF — measured on this test's first run, which
   *  reported `scripts/ladder.test.ts` as an undeclared browser launcher off
   *  the `--headless` inside the pattern above. It is left out of the text
   *  half only: the closure still covers it, and did catch it the run before
   *  that, when the fixture below spelled a puppeteer import as a literal. */
  const censusFile = relative(root, import.meta.path);

  test('every file that names a browser launcher is inside the derivation', () => {
    const corpus = readMatching(isParseable);
    const reaching = browserModules(corpus);

    // The derivation measures something: it reaches further than the text
    // census, and the files below are the proof — each one drives Chrome
    // through a harness while naming no launcher itself.
    expect(reaching.size).toBeGreaterThan(30);
    expect(corpus.has(censusFile)).toBeTrue();

    for (const file of ['scripts/computed-style.test.ts', 'scripts/provider-wait-ux.test.ts', 'tests/live/live-smoke.test.ts']) {
      expect(reaching.has(file), `${file} drives a browser and the closure does not reach it`).toBeTrue();
    }

    const unseen = [...corpus]
      .filter(([file, text]) => file !== censusFile && namesLauncher(text) && !reaching.has(file))
      .map(([file]) => file);

    expect(unseen, 'files that launch a browser by name and reach puppeteer through no import edge').toEqual([]);
  });

  test('no vitest config binds Browser Rendering, so its client launches nothing on this box', () => {
    const configs = readMatching((file) => VITEST_CONFIG.test(file));

    expect([...configs.keys()]).toContain('packages/cf-backend/vitest.config.ts');
    expect(bindingRendering(configs)).toEqual([]);
  });

  // THE RED DIRECTIONS of the exemption, over fixtures: it spares a file whose
  // only puppeteer is the Browser Rendering client, and nothing else, and the
  // binding that would make that client start a local Chrome is refused.
  test('a local launcher still names a browser, and a config that binds Browser Rendering is refused', () => {
    const launch = 'await puppeteer.launch(options);\n';

    expect(namesLauncher(`const puppeteer = require('puppeteer');\n${launch}`)).toBeTrue();
    expect(namesLauncher(`import puppeteer from '@cloudflare/puppeteer';\n${launch}`)).toBeFalse();
    expect(namesLauncher(`import puppeteer from '@cloudflare/puppeteer';\nconst local = require('puppeteer');\n${launch}`))
      .toBeTrue();

    const workers = (miniflare: string): string => `export default { test: { poolOptions: { workers: { miniflare: ${miniflare} } } } };\n`;

    const configs = new Map([
      ['packages/bound/vitest.config.ts', workers("{ browserRendering: { binding: 'BROWSER' } }")],
      ['packages/unbound/vitest.config.ts', workers("{ bindings: { BROWSER_NAME: 'chrome' } }")],
    ]);

    expect(bindingRendering(configs)).toEqual(['packages/bound/vitest.config.ts']);
  });

  test('every deploy row that claims a browser module holds the browser lane', () => {
    const plan = deployPlan();
    const reaching = sharedBrowserModules();
    const undeclared: string[] = [];

    for (const gate of gatesFor('deploy')) {
      const row = plan.find((candidate) => candidate.run === gate.run);
      const reached = claims(gate.run, tracked).filter((file) => reaching.has(file));

      if (reached.length === 0) continue;

      if (row?.shared !== 'browser') {
        undeclared.push(`${gate.label} claims ${reached.join(', ')} and the plan admits it beside another browser row`);
      }
    }

    expect(undeclared).toEqual([]);
    // The whole family, named once so a row LEAVING it is as visible as one
    // joining: this is the set the wave runs one at a time.
    expect(plan.filter((row) => row.shared === 'browser').map((row) => row.label).sort()).toEqual([
      'Chat infinite scroll',
      'Gate self-tests: secrets, corpus, preflight',
      'Live and first-run suites, credential-free',
      'Live app in a browser',
      'Product flows in a browser, on the local dev server',
      'Public pages render',
      'React runtime identity',
      'Swarm-tree geometry',
      'Test browsers end with their launcher',
      'UI gate self-tests',
      'UI gate self-tests: chat and files',
    ]);
  });

  // THE RED DIRECTION, over a fixture rather than the tree: a suite that joins
  // the tree tomorrow, reaching a browser two hops out through harnesses of
  // its own, is derived without an edit anywhere. The last row is the control
  // — a suite that imports neither is not in the closure, so the assertion
  // above is not passing over a set that holds everything.
  test('a new suite that reaches a browser two hops out is derived, and one that does not is not', () => {
    // Literal import lines in strings: the closure reads syntax, so this file stays out of the
    // browser lane, which the plan's browser-row list above pins.
    const fixture = new Map([
      ['scripts/new-harness.ts', "import driver from 'puppeteer';\nexport const launch = driver.launch;\n"],
      ['scripts/new-middle.ts', "import { launch } from './new-harness';\nexport const open = launch;\n"],
      ['scripts/new-thing.test.ts', "import { open } from './new-middle';\ntest('x', () => open());\n"],
      ['scripts/new-quiet.test.ts', "import { readFileSync } from 'node:fs';\ntest('y', () => readFileSync('x'));\n"],
    ]);

    const reaching = browserModules(fixture);
    expect([...reaching].sort()).toEqual([
      'scripts/new-harness.ts', 'scripts/new-middle.ts', 'scripts/new-thing.test.ts',
    ]);

    const row = {
      run: 'bun test --timeout=0 scripts/new-thing.test.ts', label: 'new', tier: 'ci' as const,
      seconds: 1, catches: '', blind: '', inputs: { kind: 'live' as const, why: 'fixture' },
    };

    expect(sharedOf(row, ['scripts/new-thing.test.ts'], reaching)).toBe('browser');
    expect(sharedOf({ ...row, run: 'bun test --timeout=0 scripts/new-quiet.test.ts' }, ['scripts/new-quiet.test.ts'], reaching))
      .toBeUndefined();
  });

  // The shapes a text match on `from 'puppeteer'` read backwards: a load through a `const`
  // specifier and through `require` reach Chrome; a type-only import and a mention in a string do not.
  test('a module loading the browser by a named specifier or require is derived; a type import is not', () => {
    const fixture = new Map([
      ['scripts/named-harness.ts', "const driver = 'puppeteer';\nexport const open = async () => (await import(driver)).default.launch();\n"],
      ['scripts/required-harness.ts', "const driver = require('puppeteer');\nexport const launch = driver.launch;\n"],
      ['scripts/lazy.test.ts', "test('x', async () => (await import('./named-harness')).open());\n"],
      ['scripts/typed.test.ts', "import type { Page } from 'puppeteer';\nexport type Seen = Page;\n"],
      ['scripts/prose.test.ts', "export const doc = \"import puppeteer from 'puppeteer'\";\n"],
    ]);

    expect([...browserModules(fixture)].sort()).toEqual([
      'scripts/lazy.test.ts', 'scripts/named-harness.ts', 'scripts/required-harness.ts',
    ]);
  });

  test('git reports a non-empty set of test files', () => {
    expect(tracked.length).toBeGreaterThan(300);
  });

  test('every tier has gates, and every gate resolves to something runnable', () => {
    const scripts = new Set(Object.keys(packageScripts()));
    const unrunnable: string[] = [];

    for (const gate of gatesFor('deploy')) {
      const words = gate.run.split(/\s+/);

      if (words[0] === 'bun' && words[1] === 'run' && !scripts.has(words[2] ?? '')) {
        unrunnable.push(`${gate.run} — no package.json script named "${words[2] ?? ''}"`);
      }
    }

    expect(unrunnable).toEqual([]);

    for (const tier of TIERS) expect(gatesFor(tier).length).toBeGreaterThan(0);
  });

  test('claims() resolves the invocation forms this repo uses', () => {
    // The resolver decides both assertions below, so a resolver that returns
    // nothing would make both of them pass over an empty set.
    expect(claims('bun test packages/core/', tracked).length).toBeGreaterThan(100);
    expect(claims('bun test scripts/deploy.test.ts', tracked)).toEqual(['scripts/deploy.test.ts']);
    expect(claims('bun run test:cli', tracked).filter((path) => path.startsWith('packages/cli/tests/')).length)
      .toBeGreaterThan(40);

    // Derived, not counted: a cardinality assertion over a globbed set is drift
    // by construction.
    //
    // `isBunDiscoverableSuite`, NOT `isRunnableSuite`. The runnable set counts
    // `.eval.` because the lint rule governs those files; `bun test` does not
    // select them — measured, a directory of `a.test.ts`, `c.spec.ts`,
    // `d_test.ts`, `e_spec.ts`, `g.test.tsx`, `b.eval.ts` and `f.eval.tsx` runs
    // five files. Cross-checked rather than tautological: `claims()` resolves
    // COMMAND TEXT, while `isBunDiscoverableSuite` is a FILENAME rule.
    const bunSuitesUnderTests = tracked
      .filter((file) => file.startsWith('tests/') && isBunDiscoverableSuite(file))
      .sort();

    expect(bunSuitesUnderTests.length).toBeGreaterThan(0);
    expect(claims('bun test ./tests/', tracked).sort()).toEqual(bunSuitesUnderTests);

    // The other half of the partition: every runnable suite no `bun test` can
    // select is an eval task, and `bun run evals` claims exactly those.
    const evalTasks = tracked.filter(isVitestEvalSuite).sort();

    expect(evalTasks.length).toBeGreaterThan(0);
    expect(evalTasks.filter((file) => !file.startsWith('evals/tasks/'))).toEqual([]);
    expect(claims('bun run evals', tracked).sort()).toEqual(evalTasks);
    // The live tier's claim is the bun argv its script runs by default.
    expect(claims('bun run test:live', tracked).sort())
      .toEqual(bunSuitesUnderTests.filter((file) => file.startsWith('tests/live/')));
    // The glob and named-file forms are proved over a FIXTURE tree below
    // (`claims() resolves a glob against whatever tree it is given`), never by
    // naming the live repo's files: this held a thirteen-entry list of bench
    // suites that a new suite had to be added to by hand (46f992845), which is
    // the defect the family rule exists to remove. The live tree's one property
    // worth asserting is that the glob resolves to SOMETHING, so an empty
    // expansion cannot read as a gate that ran nothing.
    expect(claims('bun test scripts/bench*.test.ts', tracked).length).toBeGreaterThan(0);

    const durabilityProbeGate = LADDER.find(gate =>
      gate.run.includes('scripts/sandbox-durability-probe.test.ts'));

    expect(durabilityProbeGate?.tier).toBe('ci');
    // `bun run test` fans out through package.json into three package suites.
    expect(claims('bun run test', tracked).length).toBeGreaterThan(200);
    // The workerd layer resolves from its own command text, so it is
    // monotonicity- and reachability-checked like every bun suite.
    expect(claims('bun run test:workerd', tracked).length).toBeGreaterThan(0);

    // The four rows partition the script's set: no workerd file is in two
    // rows or in none.
    const rows = ['bun run test:workerd:cf', 'bun run test:workerd:cf-long', 'bun run test:workerd:devbox', 'bun run test:workerd:cf-complexity']
      .map((run) => claims(run, tracked));

    expect(rows.every((files) => files.length > 0)).toBe(true);
    expect(rows.flat().sort()).toEqual(claims('bun run test:workerd', tracked).sort());
    expect(new Set(rows.flat()).size).toBe(rows.flat().length);

    // The two UI self-test rows partition the same family: the heavy suite is
    // a row of its own and the family row carves it out with bun's
    // `--path-ignore-patterns`, so no file runs twice and none is dropped.
    // Split on 2026-09-18, when the one row measured 480.42s against a 480s
    // deadline.
    const uiRows = LADDER
      .filter((gate) => gate.label.startsWith('UI gate self-tests'))
      .map((gate) => claims(gate.run, tracked));

    expect(uiRows.length).toBe(2);
    expect(uiRows.every((files) => files.length > 0)).toBe(true);
    expect(new Set(uiRows.flat()).size).toBe(uiRows.flat().length);
    expect(uiRows.flat().sort()).toEqual(
      [...claims('bun test scripts/*-ux.test.ts', tracked), 'scripts/computed-style.test.ts'].sort(),
    );
    // `--cwd` silently loads a different bunfig, so it claims nothing on
    // purpose — a gate spelled that way fails as an orphan instead of passing.
    expect(claims('bun test --cwd packages/core', tracked)).toEqual([]);
    // An unrecognised form claims NOTHING rather than being assumed to claim
    // everything — an optimistic resolver would recreate the defect this file
    // exists to prevent.
    expect(claims('wrangler deploy', tracked)).toEqual([]);
  });
});

describe('claims() resolves a glob against whatever tree it is given', () => {
  // The MECHANISM, over a tree this test owns. A live-tree assertion that
  // names files is a list somebody maintains; this proves the resolver's
  // three forms — glob, directory, named file — on known inputs, and that a
  // file added to the tree is claimed with no edit anywhere.
  const tree = [
    'scripts/bench-a.test.ts', 'scripts/bench-b.test.ts', 'scripts/bench.test.ts',
    'scripts/benchmark-notes.md', 'scripts/other.test.ts', 'scripts/deep/bench-c.test.ts',
    'scripts/x-ux.test.ts', 'scripts/y-ux.test.ts', 'scripts/ux.test.ts', 'scripts/z-ux.helper.ts',
    'packages/p/tests/one.test.ts', 'packages/p/tests/two.spec.ts', 'packages/p/src/lib.ts',
  ];

  test('a glob claims exactly the discoverable suites it matches, one path segment deep', () => {
    expect(claims('bun test scripts/bench*.test.ts', tree)).toEqual([
      'scripts/bench-a.test.ts', 'scripts/bench-b.test.ts', 'scripts/bench.test.ts',
    ]);
    expect(claims('bun test scripts/*-ux.test.ts', tree)).toEqual(['scripts/x-ux.test.ts', 'scripts/y-ux.test.ts']);
  });

  test('a file added to the tree joins its family with no edit', () => {
    const grown = [...tree, 'scripts/bench-new.test.ts', 'scripts/w-ux.test.ts'];
    expect(claims('bun test scripts/bench*.test.ts', grown)).toContain('scripts/bench-new.test.ts');
    expect(claims('bun test scripts/*-ux.test.ts', grown)).toContain('scripts/w-ux.test.ts');
  });

  test('a suite carved out of a family glob is claimed by the row that names it, once', () => {
    // What the family claims over this tree, written out: `ux.test.ts` has no
    // `-ux` before it and `z-ux.helper.ts` is not a suite. The partition is
    // asserted against THIS list rather than against `claims(family)`, so a
    // resolver that dropped a file from both sides could not satisfy it.
    const whole = ['scripts/x-ux.test.ts', 'scripts/y-ux.test.ts'];
    const family = 'bun test scripts/*-ux.test.ts';
    const carved = 'bun test --path-ignore-patterns=scripts/y-ux.test.ts scripts/*-ux.test.ts';

    expect(claims(family, tree)).toEqual(whole);
    expect(claims(carved, tree)).toEqual(['scripts/x-ux.test.ts']);
    // The pair partitions what the one row claimed: nothing runs twice, and
    // the suite the flag removed is still claimed where it is named.
    expect([...claims(carved, tree), ...claims('bun test scripts/y-ux.test.ts', tree)].sort())
      .toEqual(whole);
  });

  test('a glob beside named files claims the union once, in resolution order', () => {
    expect(claims('bun test scripts/bench*.test.ts scripts/other.test.ts scripts/bench.test.ts', tree)).toEqual([
      'scripts/bench-a.test.ts', 'scripts/bench-b.test.ts', 'scripts/bench.test.ts', 'scripts/other.test.ts',
    ]);
  });

  test('a directory claims every discoverable suite beneath it and nothing else', () => {
    expect(claims('bun test packages/p/', tree)).toEqual(['packages/p/tests/one.test.ts', 'packages/p/tests/two.spec.ts']);
  });

  test('a named file not in the tree claims nothing rather than itself', () => {
    expect(claims('bun test scripts/absent.test.ts', tree)).toEqual([]);
  });
});

describe('the ladder is monotone — commit ⊆ push ⊆ ci ⊆ deploy', () => {
  test('no tier claims a test file that a later tier does not', () => {
    // A gate at an early tier and not a later one means the later tier is the
    // WEAKER one, which is how a green deploy ends up compatible with a red
    // local run. Compared by claimed files rather than command text, so a gate
    // that gains an argument does not read as a hole.
    const claimedAt = TIERS.map((tier) => ({
      tier,
      files: new Set(gatesFor(tier).flatMap((gate) => claims(gate.run, tracked))),
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

});

describe('CI is not a silent subset of deploy', () => {
  test('every deploy gate is covered by the CI tier or carries a written exemption', () => {
    // This is the whole point. On 2026-08-17 ci.yml claimed 339 of 400 test
    // files and deploy.sh claimed 395, and nothing anywhere said so — a green
    // badge was meaningfully weaker than a green local run and the delta was
    // invisible. After this assertion the delta can only ever be a decision
    // someone wrote down.
    const ci = gatesFor('ci');
    const atCi = new Set(ci.map((gate) => gate.run));
    const filesAtCi = new Set(ci.flatMap((gate) => claims(gate.run, tracked)));
    const undeclared: string[] = [];

    for (const { run } of deployPlan()) {
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

  test('every exemption names a gate the deploy plan runs', () => {
    // A stale exemption is worse than a missing one: it reads as a considered
    // decision about a gate that no longer exists, and it silently excuses the
    // next gate that happens to be spelled the same way.
    const runs = new Set(deployPlan().map((row) => row.run));
    const stale = Object.keys(CI_EXEMPT).filter((run) => !runs.has(run));
    expect(stale).toEqual([]);
  });

  const Workflow = v.object({
    jobs: v.record(v.string(), v.object({ steps: v.optional(v.array(v.object({ run: v.optional(v.string()) })), []) })),
  });

  /** Every command line a workflow's steps run, off the parsed YAML: a `run: |` block is several, and a
   *  step inside a comment is none. */
  const workflowCommands = (text: string): string[] => Object.values(v.parse(Workflow, Bun.YAML.parse(text)).jobs)
    .flatMap((job) => job.steps.flatMap((step) => (step.run ?? '').split('\n').map((line) => line.trim()).filter((line) => line !== '')));

  const enumerates = (command: string): boolean => /^bun (test|run (test|layergate|check|gate:))/.test(command);

  test('ci.yml delegates to the ladder instead of keeping its own list', () => {
    // Three lists is worse than two. CI must not be able to enumerate suites
    // independently, because that is how it came to skip five packages.
    const commands = workflowCommands(readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8'));

    expect(commands).toContain('bun scripts/ladder.ts --tier=ci');
    expect(commands.filter(enumerates)).toEqual([]);
  });

  test('a commented-out ladder step delegates nothing, and a suite inside a run block is enumerated', () => {
    const commands = workflowCommands([
      'jobs:', '  gate:', '    steps:', '      # - run: bun scripts/ladder.ts --tier=ci',
      '      - run: |', '          bun install', '          bun test packages/core', '',
    ].join('\n'));

    expect(commands).toEqual(['bun install', 'bun test packages/core']);
    expect(commands.filter(enumerates)).toEqual(['bun test packages/core']);
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
    const covered = new Set(gatesFor('evals').flatMap((gate) => claims(gate.run, tracked)));

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
    const atCi = new Set(gatesFor('ci').flatMap((gate) => claims(gate.run, tracked)));
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
    // prefix cannot give: a bare `'tools/oxlint/anti-slop/'` excuse is satisfied
    // by one witness, so a new top-level `*.test.ts` there would be excused and
    // executed by nobody.
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
    const elsewhere = gatesFor('evals')
      .filter((gate) => gate.run !== 'bun run gate:python-suites')
      .flatMap((gate) => claims(gate.run, tracked));

    expect(elsewhere.filter((path) => python.includes(path))).toEqual([]);
  });

  test('the live tier runs one directory, and the skip ratchet proves it non-empty', () => {
    // The script's default argv is what the ladder credits the tier with, and the
    // ratchet's first target is what proves that argv produced tests: one list,
    // read from the script, so a rename moves both.
    const script = readFileSync(resolve(root, LIVE_TIER_SCRIPT), 'utf8');

    expect(liveTierTargets(script)).toEqual(['./tests/live/']);
    expect(SKIP_RATCHET_TARGETS).toContain('./tests/');
    expect(script).toContain('RATCHET_ARGS=(--junit "$JUNIT" --target "${TARGETS[0]}")');
  });

  test('the CLI suite is the only tier that runs its own files', () => {
    // The CLI gate says so in prose, and said "41 of these 42 files" until the
    // 43rd landed. Derived as an empty overlap rather than as a count, for the
    // reason claims() gives above: a cardinality over a globbed set is drift by
    // construction, and this one drifted while nothing noticed.
    const cliGate = 'bun run test:cli';
    const cliFiles = claims(cliGate, tracked);
    expect(cliFiles.length).toBeGreaterThan(0);

    const elsewhere = new Set(gatesFor('ci')
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

    const bunClaimed = gatesFor('ci')
      .filter((gate) => !gate.run.startsWith('bun run test:workerd'))
      .flatMap((gate) => claims(gate.run, tracked));

    expect(bunClaimed.filter((path) => workerd.includes(path))).toEqual([]);
    expect(bunClaimed.length).toBeGreaterThan(300);

    // And vitest's own config selects exactly the files bun skips, asked of
    // vitest itself: a widened `include` is an overlap here and a narrowed one
    // is a workerd suite that runs nowhere, in both directions.
    const listed = Bun.spawnSync(
      [resolve(root, 'node_modules/.bin/vitest'), 'list', '--root', 'packages/cf-backend', '--filesOnly', '--json'],
      { cwd: root, env: childEnv(), stdout: 'pipe', stderr: 'pipe' },
    );

    expect(listed.exitCode, listed.stderr.toString()).toBe(0);

    const selected = v.parse(v.array(v.object({ file: v.string() })), JSON.parse(listed.stdout.toString()))
      .map(({ file }) => relative(root, file));

    const onDisk = tracked.filter((path) => path.startsWith('packages/cf-backend/tests/workerd/') && path.endsWith('.test.ts'));
    expect(onDisk.length).toBeGreaterThan(0);
    expect(selected.filter((path) => !bunWouldSkip(path))).toEqual([]);
    expect(bunClaimed.filter((path) => selected.includes(path))).toEqual([]);
    expect(onDisk.filter((path) => !selected.includes(path))).toEqual([]);
  });

  test('the root test script covers every package or names the omission and its gate', () => {
    // `bun run test` is the most-typed command in the repo and it covers 4 of
    // the 10 workspace packages. Making it cover all 10 was measured and rejected
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

    expect(packages.size).toBe(10);

    const byRootScript = new Set(claims('bun run test', tracked));
    const atCi = gatesFor('ci');
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
  // The two assertions that stood here — commit under 15s, push under a 126.4s wall
  // reading — were fictions by 2026-09-05: OpsProse re-measured the ladder and found
  // the declared seconds stale 2–6x, so neither bound could fail, and with true figures
  // both fail (commit 51.84s then, 53.24s now; push 158.21s then, 379.71s now, once the
  // self-test rows were re-measured too). The ruling was a measured ratchet rather than
  // a raised bound: each tier's declared cost is pinned per gate in
  // `scripts/ladder.lock.json`, and a tier that grows past 20% fails naming the step
  // that grew most. `--lock` re-pins, and refuses without a `--reason` that lands in
  // the lock.
  test('the declared tier costs match the locked ratchet within tolerance', () => {
    // The fraction itself is pinned: moving 20% silently is raising the bound to pass.
    expect(BUDGET_TOLERANCE).toBe(0.2);
    const budget = readBudget();
    // A lock with no reason is a number that moved without a decision.
    expect(budget.reason.length).toBeGreaterThan(40);

    const declared = {
      commit: declaredTierCost('commit'),
      push: declaredTierCost('push'),
    };

    for (const tier of ['commit', 'push'] as const) {
      // The pin is per gate, so the lock cannot drift from the table it governs:
      // every locked step equals the LADDER declaration for that run, and the tier
      // figure is their sum to the cent.
      expect(Object.keys(budget.tiers[tier].steps).length).toBeGreaterThan(0);
      expect(declared[tier].steps).toEqual(budget.tiers[tier].steps);
      expect(Math.abs(budget.tiers[tier].seconds - declared[tier].total)).toBeLessThan(0.01);
    }

    expect(judgeBudgets(declared, budget)).toEqual([]);
  });

  test('a tier that grows past tolerance fails naming the step that grew most', () => {
    // RED direction, against a fixture lock: with `b` moved 20 → 28 the commit total
    // moves 30 → 38 (+26.7%), past the 20% tolerance, and the breach names `b` with
    // both figures. Exactly at tolerance is not "more than": 36 against 30 passes.
    // A NEW gate (`d`, locked at nothing) counts its whole declaration as growth.
    const locked: LadderBudget = {
      reason: 'fixture',
      tiers: {
        commit: { seconds: 30, measuredAt: '2026-09-05', machine: 'fixture', steps: { a: 10, b: 20 } },
        push: { seconds: 150, measuredAt: '2026-09-05', machine: 'fixture', steps: { c: 150 } },
      },
    };

    expect(judgeBudgets(
      {
        commit: { total: 38, steps: { a: 10, b: 28 } },
        push: { total: 150, steps: { c: 150 } },
      },
      locked,
    )).toEqual([
      { tier: 'commit', locked: 30, declared: 38, step: 'b', stepWas: 20, stepNow: 28 },
    ]);
    expect(judgeBudgets(
      {
        commit: { total: 36, steps: { a: 10, b: 26 } },
        push: { total: 150, steps: { c: 150 } },
      },
      locked,
    )).toEqual([]);
    expect(judgeBudgets(
      {
        commit: { total: 30, steps: { a: 10, b: 20 } },
        push: { total: 195, steps: { c: 150, d: 45 } },
      },
      locked,
    )).toEqual([
      { tier: 'push', locked: 150, declared: 195, step: 'd', stepWas: 0, stepNow: 45 },
    ]);
  });

  test('a tier that shrinks passes', () => {
    // The ratchet points one way: a faster tier is the mechanism working, and the
    // lock is re-pinned opportunistically rather than demanded. A removed gate reads
    // as shrinkage to zero, not as a stale lock entry.
    const locked: LadderBudget = {
      reason: 'fixture',
      tiers: {
        commit: { seconds: 30, measuredAt: '2026-09-05', machine: 'fixture', steps: { a: 10, b: 20 } },
        push: { seconds: 150, measuredAt: '2026-09-05', machine: 'fixture', steps: { c: 150 } },
      },
    };

    expect(judgeBudgets(
      {
        commit: { total: 15, steps: { a: 10, b: 5 } },
        push: { total: 150, steps: { c: 150 } },
      },
      locked,
    )).toEqual([]);
    expect(judgeBudgets(
      {
        commit: { total: 10, steps: { a: 10 } },
        push: { total: 150, steps: { c: 150 } },
      },
      locked,
    )).toEqual([]);
  });

  test('a lock that pins nothing cannot pass', () => {
    // Fail-CLOSED direction: an empty corpus must die rather than report a cheap tree.
    const locked: LadderBudget = {
      reason: 'fixture',
      tiers: {
        commit: { seconds: 0, measuredAt: '2026-09-05', machine: 'fixture', steps: {} },
        push: { seconds: 150, measuredAt: '2026-09-05', machine: 'fixture', steps: { c: 150 } },
      },
    };

    expect(() => judgeBudgets(
      {
        commit: { total: 0, steps: {} },
        push: { total: 150, steps: { c: 150 } },
      },
      locked,
    )).toThrow('measured nothing');
  });

  // OVER THE DEPLOY TIER'S REAL MEMBERSHIP, not over LADDER. `gatesFor('deploy')`
  // appends any deploy.sh line no LADDER entry names, at `seconds: 0` — so for as
  // long as this filtered LADDER, a gate could join the deploy path and cost
  // nothing on the tier's own cost line. Two did: `bun run verify:lean`, and the
  // bench command whose LADDER entry stopped at the `scripts/bench*` glob while
  // deploy.sh also passed the core bench units. The tier now declares 1219.73s and
  // runs 66 gates, all described.
  //
  // Synthesis stays: an undeclared deploy gate must still RUN. This is what makes
  // it also fail, by name, until somebody measures it.
  test('every gate the deploy tier runs carries a measured cost and a named blind spot', () => {
    const vague = gatesFor('deploy')
      .filter((gate) => gate.seconds <= 0 || gate.blind.length < 20 || gate.catches.length < 20)
      .map((gate) => gate.run);

    expect(vague).toEqual([]);
  });

  test('heavy package gates use four isolated Bun workers', () => {
    const atCi = gatesFor('ci');

    for (const run of [
      'bun test --timeout=0 --parallel=4 packages/cf-backend/',
      'bun test --timeout=0 --parallel=4 packages/cli-backend/',
      'bun run test:cli',
      'bun run test:core',
    ]) {
      expect(atCi.some((gate) => gate.run === run), `${run} is not a gate at ci`).toBeTrue();
    }

    const packageJson = readFileSync(resolve(root, 'package.json'), 'utf8');
    expect(packageJson).toContain('"test:core": "bun scripts/ladder.ts --run bun test --timeout=0 --parallel=4 packages/core/"');
    // The root script still fans out to every spine package, so `bun run test`
    // stays the most-typed command and `claims()` keeps resolving it whole.
    expect(packageJson).toContain('"test": "bun run test:core && bun run test:spine"');
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

    const unspawnable = gatesFor('deploy')
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
    // The empty-corpus pass. A filter matching nothing is otherwise
    // indistinguishable from a clean run, so it throws rather than reporting
    // green over zero files.
    expect(() => runnableArgv('bun test scripts/no-such-suite*.test.ts', tracked))
      .toThrow('glob matched no tracked test file');
  });

  test('no gate is spelled with shell syntax the runner does not implement', () => {
    // Declaration-time, so the next gate cannot arrive in the quiet mode of the
    // same defect: `bun test --grep 'foo bar'` splits into a silently wrong
    // argv, runs, and reports green over the wrong set. `*` is the one
    // metacharacter the runner resolves, from claims().
    const shellSyntax = gatesFor('deploy')
      .filter((gate) => /['"?$&|<>~`(){}[\]]/.test(gate.run))
      .map((gate) => gate.run);

    expect(shellSyntax).toEqual([]);
  });
});

// 2026-09-24: every row a package script wraps (`bun scripts/ladder.ts --run …`) was keyed on the whole tree,
// because the wrapper's graph reaches `sources.ts`; the workerd suites alone reran 680 s on any change. The
// closure now holds the wrapper's graph as loaded, not what it can enumerate, which is sound only while loading
// the ladder and taking `--run` read no tracked file beyond the modules (`RUNNER_SCRIPT`, ladder-closure.ts).
describe('the deadline wrapper reads only what its closure holds', () => {
  test('a wrapped command, traced, opens no tracked file its closure lacks', () => {
    // The wrapped command is a module that reads nothing, so every tracked file the trace holds is the wrapper's.
    const run = 'bun scripts/ladder.ts --run bun scripts/jsonc.ts';
    const closure = deriveClosure(run, { kind: 'derived' }, repoAt(`${root}/`, (command, files) => claims(command, files)));

    if (closure.kind !== 'derived') throw new Error(`${run} has no derived closure: ${closure.why}`);

    const audit = auditClosure(run.split(' '), root, closure, gateEnvironment(closure));

    expect(closure.corpus).toBe(false);
    expect(audit.undeclared).toEqual([]);
  });
});
