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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { childEnv, git, initRepo, scratchDir } from '@kinu.run/test-utils';
import * as v from 'valibot';
import {
  CI_EXEMPT, LADDER, LIVE_TIER_SCRIPT, TIERS, bunIgnoredPatterns, bunWouldSkip, claims,
  DEPLOY_PHASES, browserModules, deployOrder, deployPlan, gatesFor, liveTierTargets, packageScripts, phaseWave,
  localDeployGates, reportCIVerdicts, runnableArgv, sharedBrowserModules, sharedOf, tierRun, tierSchedule, tierWave, trackedTestFiles, waveCaps, type WaveRow,
  HAMMER_REPEATS, ciUnits, changedTestGate, splitCIGate, type Gate, armadaPhaseRows, armadaRowVerdicts, onArmada,
} from './ladder';
import {
  ANTI_SLOP_ROOT, isAntiSlopRuleSuite, isAntiSlopSuite, isBunDiscoverableSuite, isParseable, isPythonSuite,
  isVitestEvalSuite, readMatching,
} from './sources';
import { parseJUnit, SKIP_RATCHET_TARGETS } from './skip-ratchet';
import { declaredName, parse, walk } from './syntax';
import { auditClosure } from './ladder-audit';
import { gateEnvironment } from './ladder-cache';
import { deriveClosure, repoAt } from './ladder-closure';
import { armadaVerdict, readFileTimings, readHostedCosts, withRunnerCosts } from './ci-verdicts';
import { COST_TABLE, type CostTable } from './gate-cost';
import { costTableFaults } from './cost-table';

const root = resolve(import.meta.dir, '..');

const tracked = trackedTestFiles();

// Plan behavior uses deterministic figures; gate:cost-table checks the real recorded table.
function planCosts(): CostTable {
  const cost = { wallSeconds: 1, cpuSeconds: 1, peakRssMb: 1, peakRunnable: 1, peakCpuThreads: 1, meanThreads: 1, samples: 1, loadAtStart: 0, exit: 0 };

  return { measuredAt: 'fixture', machine: 'fixture', method: 'fixture', rows: Object.fromEntries(deployOrder().map((gate) => [gate.run, cost])) };
}

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
 * The live-app suite is here because its own deploy rows are its only
 * runners: CI_EXEMPT carries why a pull request cannot boot the product's dev
 * server. The product flows run only against the deployment a deploy publishes,
 * in its post-publish wave, which a pull request has none of. The capability suite needs a user
 * systemd manager that grants a unit an ambient capability, which a CI runner's
 * does not; CI_EXEMPT carries that too.
 */
const AFTER_CI_SUITES = {
  'evals/tasks/budget-board.eval.ts': 'bun run evals',
  'evals/tasks/chess.eval.ts': 'bun run evals',
  'evals/tasks/file-housekeeping.eval.ts': 'bun run evals',
  'evals/tasks/freight-desk.eval.ts': 'bun run evals',
  'evals/tasks/latency-chart.eval.ts': 'bun run evals',
  'evals/tasks/launch-prep.eval.ts': 'bun run evals',
  'evals/tasks/ledger-reconcile.eval.ts': 'bun run evals',
  'evals/tasks/memory-recall.eval.ts': 'bun run evals',
  'evals/tasks/offsite-venue.eval.ts': 'bun run evals',
  'evals/tasks/order-book.eval.ts': 'bun run evals',
  'evals/tasks/pricing-treatments.eval.ts': 'bun run evals',
  'evals/tasks/request-logs.eval.ts': 'bun run evals',
  'evals/tasks/site-preview.eval.ts': 'bun run evals',
  'evals/tasks/swarm-audit.eval.ts': 'bun run evals',
  'evals/tasks/swarm-optimise.eval.ts': 'bun run evals',
  'evals/tasks/swarm-research.eval.ts': 'bun run evals',
  'evals/tasks/true-myth-combinators.eval.ts': 'bun run evals',
  'scripts/deadline-capability.test.ts': 'bun test --timeout=0 scripts/deadline-capability.test.ts',
  'tests/browser/live-app-layout.test.ts': 'bun test --timeout=0 tests/browser/live-app-layout.test.ts',
  'tests/browser/live-app-plans.test.ts': 'bun test --timeout=0 tests/browser/live-app-plans.test.ts',
  'tests/browser/live-app-sleep.test.ts': 'bun test --timeout=0 tests/browser/live-app-sleep.test.ts',
  'tests/browser/live-app-turns.test.ts': 'bun test --timeout=0 tests/browser/live-app-turns.test.ts',
  'tests/browser/product-flows.test.ts': 'bash scripts/product-flows-tier.sh',
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
  'packages/devbox': 'bun test --timeout=0 --isolate packages/devbox/',
  'packages/test-utils': 'bun test --timeout=0 --isolate packages/test-utils/',
  'packages/cf-backend': 'bun test --timeout=0 --parallel=4 packages/cf-backend/',
  'packages/cli-backend': 'bun test --timeout=0 --parallel=4 packages/cli-backend/',
  'packages/cli': 'bun run test:cli',
  'packages/pc-agent': 'bun test --timeout=0 --isolate packages/pc-agent/',
} satisfies Record<string, string>;

const omittedGate = (directory: string): string | undefined =>
  Object.entries(ROOT_TEST_OMISSIONS).find(([name]) => name === directory)?.[1];

describe('the ladder measures something', () => {
  test('the deploy plan holds every non-evals gate, in phase order, and each phase runs exactly its rows', () => {
    // The plan is the one copy of what blocks a publish. Until 2026-09-15 this
    // parsed deploy.sh's own `run_required_gate` lines and held them equal to
    // the ladder; the parser and the second list are gone, and the property is
    // that the plan is the ladder: every gate but the evals tier, each once,
    // phases in order. deploy.sh runs each phase as `--deploy-phase`, which is
    // the plan's rows of that phase and no other.
    const plan = deployPlan(planCosts());
    expect(plan.length).toBeGreaterThan(10);
    expect(plan.map((row) => row.run).sort()).toEqual(LADDER.filter((gate) => gate.tier !== 'evals').map((gate) => gate.run).sort());
    const phaseIndex = plan.map((row) => DEPLOY_PHASES.indexOf(row.phase));
    expect([...phaseIndex].sort((a, b) => a - b)).toEqual(phaseIndex);

    for (const phase of DEPLOY_PHASES) {
      expect(phaseWave([phase], planCosts()).map(({ gate }) => gate.run)).toEqual(plan.filter((row) => row.phase === phase).map((row) => row.run));
    }
  });

  test('a wave of deploy phases launches its longest measured rows first, whichever phase each is in', async () => {
    // Walls assigned against ladder order, so a wave that launched in ladder
    // order, or sorted the other way, starts the wrong row first.
    const real = planCosts();
    const ladderOrder = LADDER.map((gate) => gate.run);

    const costs = {
      ...real,
      rows: Object.fromEntries(Object.entries(real.rows).map(([run, cost]) => [run, { ...cost, wallSeconds: ladderOrder.indexOf(run) }])),
    };

    // Under caps of nothing the wave admits a row only when none runs, so the start order is the launch order.
    const launched = async (phases: readonly (typeof DEPLOY_PHASES)[number][]): Promise<number[]> => {
      const started: string[] = [];

      await tierWave(phaseWave(phases, costs).map(({ gate, row }) => ({ entry: gate.run, row })), async (run) => {
        started.push(run);
      }, () => false, { threads: 0, rssMb: 0 });

      return started.map((run) => costs.rows[run]?.wallSeconds ?? -1);
    };

    // The deploy's one wave: the rows that read the deployment beside every source row.
    const wave = await launched(['post-publish', 'source']);

    expect(wave.length).toBe(deployPlan(planCosts()).filter((row) => row.phase === 'post-publish' || row.phase === 'source').length);
    expect(wave).toEqual([...wave].sort((left, right) => right - left));

    for (const phase of DEPLOY_PHASES) {
      const walls = await launched([phase]);

      expect(walls).toEqual([...walls].sort((left, right) => right - left));
    }
  });

  test('a row whose figure is of a failed run, or is missing, has no measured cost, and the plan refuses it', () => {
    const real = planCosts();
    // Every figure green but the one planted, so the refusal names the plant whatever the committed table holds.
    const green = { ...real, rows: Object.fromEntries(Object.entries(real.rows).map(([run, cost]) => [run, { ...cost, exit: 0 }])) };
    const [planted] = deployPlan(green).filter((row) => row.phase === 'source');

    if (planted === undefined) throw new Error('the deploy plan has no source row to plant a failed run on');
    const cost = green.rows[planted.run];

    if (cost === undefined) throw new Error(`${planted.run} has no figure to plant a failed run on`);
    const without = Object.fromEntries(Object.entries(green.rows).filter(([run]) => run !== planted.run));

    expect(() => deployPlan({ ...green, rows: { ...green.rows, [planted.run]: { ...cost, exit: 1 } } }))
      .toThrow(`${planted.run} is a row of the deploy plan with no measured cost in ${COST_TABLE}: its figure is of a run that exited 1`);
    expect(() => deployPlan({ ...green, rows: without }))
      .toThrow(`${planted.run} is a row of the deploy plan with no measured cost in ${COST_TABLE}. `);
  });

  // The soak's eval pass exits 1 whenever a trial fails, so its figure is a red run's: refused as a source row's would be,
  // every soak died planning before it ran a trial (staging deploy 2026-10-08T04-35-00-344Z).
  test('a soak row is planned on its live figure, red or missing, as a row that reads the deployment', () => {
    const real = planCosts();
    const [soak] = deployOrder().filter((gate) => gate.phase === 'soak');

    if (soak === undefined) throw new Error('the deploy plan has no soak row');
    const red = { ...real, rows: { ...real.rows, [soak.run]: { ...real.rows[soak.run], wallSeconds: 900, exit: 1 } } };
    const missing = { ...real, rows: Object.fromEntries(Object.entries(real.rows).filter(([run]) => run !== soak.run)) };

    expect(deployPlan(red).find((row) => row.run === soak.run)?.wall).toBe(900);
    expect(deployPlan(missing).find((row) => row.run === soak.run)?.threads).toBe(Number.POSITIVE_INFINITY);
  });

  // THE BOOTSTRAP. A row that reads the deployment can be measured only against a deployment of the build it was
  // written for, so the plan cannot refuse it unmeasured: the deploy that first ships it could never run. It takes
  // the whole box instead, so the wave starts it only once nothing else runs and admits nothing beside it.
  test('a row that reads the deployment with no measured cost runs alone, with nothing admitted beside it', async () => {
    const real = planCosts();
    const [live] = deployOrder().filter((gate) => gate.phase === 'post-publish');

    if (live === undefined) throw new Error('the deploy plan has no post-publish row');
    const costs = { ...real, rows: Object.fromEntries(Object.entries(real.rows).filter(([run]) => run !== live.run)) };
    const row = deployPlan(costs).find((candidate) => candidate.run === live.run);

    expect([row?.threads, row?.rssMb]).toEqual([Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]);

    // Under the box's own caps, whatever runs when the live row starts, and whatever starts while it runs.
    const running = new Set<string>();
    const beside: string[][] = [];

    await tierWave(phaseWave(['post-publish', 'source'], costs).map(({ gate, row: wave }) => ({ entry: gate.run, row: wave })), async (run) => {
      running.add(run);

      if (run === live.run || running.has(live.run)) beside.push([...running].filter((other) => other !== live.run));
      await Promise.resolve();
      running.delete(run);
    }, () => false);

    expect(beside.flat()).toEqual([]);
  });

  // THE COST TABLE IS THE WAVE'S ONE SET OF FIGURES, checked at commit by `gate:cost-table`: a figure for a row
  // that no longer exists is the same defect as a row with no figure. Both, and a figure from a failed run, name
  // the row; a full table names nothing.
  // A row outside the source wave is no exemption, and a row that reads the deployment is, since only a deployment of
  // its own build can measure it (the plan gives it the whole box instead).
  test('the cost table gate names a stale figure, an unmeasured row and a failed figure', () => {
    const costs = planCosts();
    const first = deployOrder().find((gate) => gate.phase === 'hammer');
    const second = deployOrder().find((gate) => (gate.phase ?? 'source') === 'source');
    const live = deployOrder().find((gate) => gate.phase === 'post-publish');

    if (first === undefined || second === undefined || live === undefined) {
      throw new Error('the deploy plan holds no hammer, no source or no post-publish row');
    }

    const failed = costs.rows[second.run];

    if (failed === undefined) throw new Error(`${second.run} has no figure`);
    const rows = Object.fromEntries(Object.entries(costs.rows).filter(([run]) => run !== first.run && run !== live.run));
    rows['bun test --timeout=0 gone.test.ts'] = failed;

    expect(costTableFaults(costs)).toEqual([]);
    expect(costTableFaults({ ...costs, rows: { ...rows, [second.run]: { ...failed, exit: 1 } } })).toEqual([
      'a figure for a row that is no longer a gate: bun test --timeout=0 gone.test.ts',
      `a figure taken from a run that exited 1: ${second.run}`,
      `a row of the deploy plan with no measured cost: ${first.run}`,
    ]);
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

    for (const file of ['tests/browser/computed-style.test.ts', 'tests/browser/provider-wait-ux.test.ts', 'tests/live-model/live-smoke.test.ts']) {
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
    const plan = deployPlan(planCosts());
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
      'Devbox contracts on real golden containers',
      'Eval framework logic',
      'Gate self-tests: secrets, corpus, preflight',
      'Live and first-run suites, credential-free',
      'Live app in a browser: a long chat and its plans',
      'Live app in a browser: a page that loses the turn',
      'Live app in a browser: a running turn',
      'Live app in a browser: the inspector column\'s layout',
      'Product flows in a browser, on the deployment',
      'Public pages render',
      'React runtime identity',
      'Swarm-tree geometry',
      'Test browsers end with their launcher',
      'UI gate self-tests',
      'UI gate self-tests: account, drive and slates',
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
      .filter((file) => file.startsWith('tests/') && !file.startsWith('tests/browser/') && isBunDiscoverableSuite(file))
      .sort();

    expect(bunSuitesUnderTests.length).toBeGreaterThan(0);
    expect(claims('bun test ./tests/live-model/ ./tests/first-run/', tracked).sort()).toEqual(bunSuitesUnderTests);

    // The other half of the partition: every runnable suite no `bun test` can
    // select is an eval task, and `bun run evals` claims exactly those.
    const evalTasks = tracked.filter(isVitestEvalSuite).sort();

    expect(evalTasks.length).toBeGreaterThan(0);
    expect(evalTasks.filter((file) => !file.startsWith('evals/tasks/'))).toEqual([]);
    expect(claims('bun run evals', tracked).sort()).toEqual(evalTasks);
    // The live tier's claim is the bun argv its script runs by default.
    expect(claims('bun run test:live', tracked).sort())
      .toEqual(bunSuitesUnderTests.filter((file) => file.startsWith('tests/live-model/')));
    // The glob and named-file forms are proved over a FIXTURE tree below
    // (`claims() resolves a glob against whatever tree it is given`), never by
    // naming the live repo's files: this held a thirteen-entry list of bench
    // suites that a new suite had to be added to by hand (46f992845), which is
    // the defect the family rule exists to remove. The live tree's one property
    // worth asserting is that the glob resolves to SOMETHING, so an empty
    // expansion cannot read as a gate that ran nothing.
    expect(claims('bun test scripts/bench*.test.ts', tracked).length).toBeGreaterThan(0);

    const benchRigGate = LADDER.find(gate =>
      gate.run.includes('scripts/deploy-substrate.test.ts'));

    expect(benchRigGate?.tier).toBe('ci');
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

    // The UI rows partition the family without duplicate or omitted suites, including future glob matches.
    const uiRows = LADDER
      .filter((gate) => gate.label.startsWith('UI gate self-tests'))
      .map((gate) => claims(gate.run, tracked));

    expect(uiRows.every((files) => files.length > 0)).toBe(true);
    expect(new Set(uiRows.flat()).size).toBe(uiRows.flat().length);
    expect(uiRows.flat().sort()).toEqual(
      [...claims('bun test tests/browser/*-ux.test.ts', tracked), 'tests/browser/computed-style.test.ts'].sort(),
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

describe('a deploy\'s armada rows', () => {
  test('are every deploy row that does not say why it runs here, none of which the CI tier runs', () => {
    const atCi = new Set(tierRun('ci').map((gate) => gate.run));
    const rows = armadaPhaseRows(DEPLOY_PHASES);

    expect({
      every: rows.length === LADDER.filter((gate) => gate.tier === 'deploy' && gate.here === undefined).length,
      atCi: rows.filter((gate) => atCi.has(gate.run)).map((gate) => gate.run), exempt: rows.filter((gate) => !Object.hasOwn(CI_EXEMPT, gate.run)).map((gate) => gate.run),
    }).toEqual({ every: true, atCi: [], exempt: [] });
  });

  test('leave this machine only the rows that say why, each with its reason, and only rows a deploy runs say it', () => {
    const here = LADDER.filter((gate) => gate.here !== undefined);
    const atDeploy = new Set(localDeployGates(deployOrder()).map((gate) => gate.run));

    expect({
      rows: here.map((gate) => `${gate.phase ?? 'source'} ${gate.run}`), reasons: here.every((gate) => (gate.here ?? '').length > 40),
      atDeploy: here.every((gate) => atDeploy.has(gate.run)), local: localDeployGates(deployOrder()).filter((gate) => !onArmada(gate)).length,
    }).toEqual({
      rows: [
        'preflight bun scripts/preflight.ts', 'source bun test --timeout=0 scripts/deadline-capability.test.ts', 'upload bun run gate:infra',
        'post-publish bun run gate:devbox-e2e',
      ],
      reasons: true, atDeploy: true, local: here.length,
    });
  });
});

describe('a deploy phase\'s armada report', () => {
  // The post-publish job of the staging deploy of 04a4dd0ab (2026-10-08, job 20261008081731-1d7c41dd): first-run was cut
  // off at armada's task limit with no verdict, and product-flows was killed for its silence with one of its own. Both
  // rows were told first-run's problems.
  test('gives each row its own verdict, and only the problems armada names for its own task', () => {
    const rows = armadaPhaseRows(['post-publish']).filter((gate) => ['bun run gate:first-run', 'bash scripts/product-flows-tier.sh'].includes(gate.run));

    const read = armadaRowVerdicts(rows, {
      job: '20261008081731-1d7c41dd',
      problems: ['first-run-tier has no verdict for bun run gate:first-run; missing is not green', 'first-run-tier reported first-run-tier, which its plan entry does not name'],
      verdicts: {
        rows: [
          { name: 'first-run-tier', exitCode: 124, seconds: 1805, output: 'the task exited 124 and reported no row' },
          { run: 'bash scripts/product-flows-tier.sh', exitCode: 124, seconds: 538, output: 'KILLED  Product flows in a browser, on the deployment  after 480s with no output' },
        ],
      },
    }, 2);

    expect(read.map(({ gate, verdict, found }) => [gate.run, verdict?.seconds, found])).toEqual([
      ['bun run gate:first-run', 1805, 'job 20261008081731-1d7c41dd; first-run-tier has no verdict for bun run gate:first-run; missing is not green; '
        + 'first-run-tier reported first-run-tier, which its plan entry does not name'],
      ['bash scripts/product-flows-tier.sh', 538, 'job 20261008081731-1d7c41dd'],
    ]);
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

    for (const { run } of deployPlan(planCosts())) {
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
    const runs = new Set(deployPlan(planCosts()).map((row) => row.run));
    const stale = Object.keys(CI_EXEMPT).filter((run) => !runs.has(run));
    expect(stale).toEqual([]);
  });

  test('CI on armada delegates to the ladder instead of keeping its own list', () => {
    // Three lists is worse than two. CI must not be able to enumerate suites
    // independently, because that is how it came to skip five packages.
    const config = v.parse(v.object({ plan: v.object({ command: v.array(v.string()) }), task: v.object({ command: v.array(v.string()) }) }), JSON.parse(readFileSync(resolve(root, '.armada.json'), 'utf8')));

    expect([config.plan.command.slice(0, 3), config.task.command.slice(0, 4)])
      .toEqual([['bun', 'scripts/ladder.ts', '--ci-plan'], ['bun', 'scripts/ladder.ts', '--tier=ci', '--ci-row={row}']]);
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

    expect(liveTierTargets(script)).toEqual(['./tests/live-model/']);
    expect(SKIP_RATCHET_TARGETS).toContain('./tests/live-model/');
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

describe('a tier runs its gates as a wave', () => {
  // Review of d35c1060fe: the commit wave admitted the flake gate on its empty-index cost (0.34 s, 72 MiB) while a
  // staged browser or workerd suite had it running up to six real suites beside the rest.
  test('a gate whose work is the staged index runs alone after the wave, never in it', () => {
    const schedule = tierSchedule(tierRun('commit'));
    const byIndex = tierRun('commit').filter((gate) => gate.inputs.kind === 'live' && gate.sizedByIndex !== undefined);

    expect(byIndex.map((gate) => gate.run)).toContain('bun scripts/flake-gate.ts');
    expect(schedule.last).toEqual(byIndex);
    expect(schedule.wave.filter((gate) => byIndex.includes(gate))).toEqual([]);
    expect([...schedule.first, ...schedule.wave, ...schedule.last]).toHaveLength(tierRun('commit').length);
  });

  const row = (threads: number, shared: WaveRow['shared'] = 'none', wall = 1, rssMb = 100): WaveRow => ({ threads, rssMb, wall, shared });

  /** Runs the wave over `rows`, each gate a few microtask turns long, and records what ran beside what. */
  async function waved(rows: readonly WaveRow[], stopAfter = Number.POSITIVE_INFINITY, caps = { threads: 8, rssMb: 1_000 }) {
    const running = new Set<number>();
    const beside: number[][] = [];
    const started: number[] = [];

    await tierWave(rows.map((entry, index) => ({ entry: index, row: entry })), async (index) => {
      started.push(index);
      running.add(index);
      beside.push([...running].sort((left, right) => left - right));

      for (let turn = 0; turn < 3; turn += 1) await Promise.resolve();
      running.delete(index);
    }, () => started.length >= stopAfter, caps);

    return { beside, started };
  }

  test('admits gates up to the thread cap and no further', async () => {
    const { beside } = await waved([row(4), row(4), row(4), row(4)]);

    expect(Math.max(...beside.map((set) => set.length))).toBe(2);
    expect(beside.flat().length).toBeGreaterThan(4);
  });

  // THE MEMORY DIMENSION DECIDES, not just the thread one: the gate self-tests row settled at 137 on 2026-09-16, the
  // kernel's status for a SIGKILL, which a wave that counts only threads cannot see coming.
  test('admits gates up to the resident-set cap and no further', async () => {
    const { beside } = await waved([row(1, 'none', 1, 400), row(1, 'none', 1, 400), row(1, 'none', 1, 400)]);

    expect(Math.max(...beside.map((set) => set.length))).toBe(2);
  });

  // How a deploy phase runs one gate, or `--serial`: the gate's output is live, so nothing may run beside it.
  test('caps of nothing run the wave one gate at a time, its longest measured rows first', async () => {
    const { beside, started } = await waved([row(1, 'none', 1), row(1, 'none', 3), row(1, 'none', 2)], Number.POSITIVE_INFINITY, { threads: 0, rssMb: 0 });

    expect(started).toEqual([1, 2, 0]);
    expect(Math.max(...beside.map((set) => set.length))).toBe(1);
  });

  test('the caps are the box: its CPUs and three quarters of MemAvailable, or the figures an operator names', () => {
    const named = { threads: process.env['KINU_DEPLOY_THREADS'], rssMb: process.env['KINU_DEPLOY_RSS_MB'] };

    try {
      delete process.env['KINU_DEPLOY_THREADS'];
      delete process.env['KINU_DEPLOY_RSS_MB'];
      const derived = waveCaps();
      // Read beside the caps, not before them: MemAvailable moves while other work shares the box.
      const availableMb = Number(/^MemAvailable:\s+(\d+) kB$/mu.exec(readFileSync('/proc/meminfo', 'utf8'))?.[1] ?? 0) / 1024;

      expect(derived.threads).toBe(cpus().length);
      expect(derived.rssMb).toBeGreaterThan(availableMb * 0.5);
      expect(derived.rssMb).toBeLessThan(availableMb);

      process.env['KINU_DEPLOY_THREADS'] = '7';
      process.env['KINU_DEPLOY_RSS_MB'] = '1234';
      expect(waveCaps()).toEqual({ threads: 7, rssMb: 1234 });
    } finally {
      for (const [name, value] of [['KINU_DEPLOY_THREADS', named.threads], ['KINU_DEPLOY_RSS_MB', named.rssMb]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test('never runs two gates that hold the browser at once', async () => {
    const { beside, started } = await waved([row(1, 'browser'), row(1, 'browser'), row(1), row(1, 'browser')]);

    expect([...started].sort((left, right) => left - right)).toEqual([0, 1, 2, 3]);
    expect(beside.every((set) => set.filter((index) => index !== 2).length <= 1)).toBe(true);
  });

  test('runs a gate with no measured cost alone', async () => {
    const { beside } = await waved([row(1), row(Number.POSITIVE_INFINITY, 'none', 9), row(1)]);

    expect(beside.filter((set) => set.includes(1))).toEqual([[1]]);
  });

  test('launches nothing more once a gate has failed', async () => {
    const { started } = await waved([row(8), row(8), row(8)], 1);

    expect(started).toEqual([0]);
  });
});

describe('CI verdicts belong to the exact pushed revision and the complete row plan', () => {
  const sha = 'a'.repeat(40);
  const first = { run: 'bun test a.test.ts', exitCode: 0, seconds: 1, output: '' };
  const second = { run: 'bun test b.test.ts', exitCode: 1, seconds: 2, output: 'a real failure' };
  const rows = [first, second];

  // armada graded the plan's every row before it stored the verdict; the ladder reads it through Kinu's pinned armada.
  test('the verdict armada stored for a commit is read as it is, none is null, and an error is never taken for none', () => {
    const directory = scratchDir('armada-verdict');
    const bin = join(directory, 'node_modules', '.bin');
    const answer = (stdout: string, exit: number) => writeFileSync(join(bin, 'armada'), `#!/bin/sh\nprintf '%s\\n' '${stdout}'\necho 'armada: the connection failed' >&2\nexit ${String(exit)}\n`, { mode: 0o755 });

    mkdirSync(bin, { recursive: true });
    answer(JSON.stringify({ sha, part: 'all', rows }), 1);
    const red = armadaVerdict(directory, sha);

    answer('null', 2);
    const none = armadaVerdict(directory, sha);

    answer('', 2);
    expect({ red: red?.rows.map((row) => row.exitCode), none }).toEqual({ red: [0, 1], none: null });
    expect(() => armadaVerdict(directory, sha)).toThrow(`armada verdict ${sha} exited 2: armada: the connection failed`);
  });

  test('a missing or red hammer run never verifies the revision', () => {
    const hammer = ciUnits().find((unit) => unit.gate.phase === 'hammer')?.gate.run ?? '';
    const proved = ciUnits().map((unit) => ({ run: unit.gate.run, exitCode: unit.gate.run === hammer ? 1 : 0, seconds: 1, output: '' }));

    expect(reportCIVerdicts({ sha, part: 'all', rows: proved }, 'armada verdict', '')).toBe(false);
    expect(reportCIVerdicts({ sha, part: 'all', rows }, 'armada verdict', '')).toBe(false);
  });

  test('CI runs the hammer six times, each a unit of its own, and leaves no CI source work in the deploy', () => {
    const hammer = ciUnits().filter((unit) => unit.gate.phase === 'hammer').map((unit) => unit.gate.run);

    expect(hammer).toEqual(Array.from({ length: HAMMER_REPEATS }, (_, index) => 'bun scripts/hammer.ts --run=' + String(index + 1)));
    const local = localDeployGates(deployOrder());
    const canonical = new Set(tierRun('ci').map((gate) => gate.run));

    expect(local.filter((gate) => gate.phase !== 'preflight').some((gate) => canonical.has(gate.run))).toBe(false);
    expect(local.some((gate) => gate.run === 'bun run gate:first-run')).toBe(true);
    expect(local.some((gate) => gate.run === 'bash scripts/eval-pass-tier.sh')).toBe(true);
  });

  test('a red live run provides resource admission but remains a red correctness verdict', () => {
    const costs = planCosts();
    const run = 'bash scripts/product-flows-tier.sh';
    const measured = costs.rows[run];

    if (measured === undefined) throw new Error('the product-flow resource measurement is absent');
    const red = { ...measured, exit: 1, cpuSeconds: 20, wallSeconds: 30, peakRssMb: 2048 };
    const live = phaseWave(['post-publish'], { ...costs, rows: { ...costs.rows, [run]: red } }).find((entry) => entry.gate.run === run);

    expect(live?.row.rssMb).toBe(2048);
    expect(live?.row.threads).toBe(1);
    expect(reportCIVerdicts({ sha, part: 'all', rows: [{ run, exitCode: 1, seconds: 30, output: 'failed live case' }] }, 'armada verdict', '')).toBe(false);
  });

  // The container runner (armada, `.armada.json`) runs the same units one task each, weighed by what it measured.
  test('the container runner\'s measurements weigh only the rows they name, over the hosted ones', () => {
    const hosted = readHostedCosts();
    const unit = ciUnits(hosted).find((each) => each.gate.phase !== 'hammer' && each.gate.ciShards === undefined);
    const run = unit?.gate.run ?? '';
    const measured = withRunnerCosts(hosted, { rows: { [run]: 1e6, 'a command no row runs': 5 }, files: { 'a.test.ts': 2 } }, new Map([[run, unit?.gate.label ?? '']]));
    const weights = new Map(ciUnits(measured).map((each) => [each.gate.run, each.seconds]));

    expect({ timed: weights.get(run), others: ciUnits(hosted).filter((each) => each.gate.run !== run).every((each) => weights.get(each.gate.run) === each.seconds), file: measured.files['a.test.ts'] })
      .toEqual({ timed: 1e6, others: true, file: 2 });
  });

  test('file partitions execute every original suite file once, each timed', () => {
    const directory = scratchDir('ci-file-partitions');
    const files = Array.from({ length: 5 }, (_, index) => join(directory, String(index) + '.test.ts'));

    for (const file of files) writeFileSync(file, 'import { test, expect } from "bun:test"; test("a settled case", () => expect(2 + 2).toBe(4));');
    const source = LADDER.find((gate) => gate.ciShards !== undefined);

    if (source === undefined) throw new Error('there is no hosted split-suite row');
    const gate: Gate = { ...source, run: 'bun test --timeout=0 ' + directory + '/', ciShards: 2 };
    const units = splitCIGate(gate, files, {});
    const seed = join(directory, 'seed.json');

    writeFileSync(seed, JSON.stringify({ version: 1, files: { 'scripts/not-selected.test.ts': 4000 } }));

    const observed = units.map((unit, index) => {
      const path = join(directory, 'timings-' + String(index) + '.json');
      const child = Bun.spawnSync([...runnableArgv(unit.run, files), '--shard=1/1', '--timings=' + path, '--timings=' + seed, '--update-timings'], { cwd: root, env: childEnv(), stdout: 'pipe', stderr: 'pipe' });

      expect(child.exitCode, child.stderr.toString()).toBe(0);

      return { run: unit.run, exitCode: child.exitCode, seconds: 1, output: '', timings: readFileTimings(path) ?? {} };
    });

    const measured = observed.flatMap((row) => Object.keys(row.timings));
    const expected = files.map((file) => relative(root, file));

    expect(measured.sort()).toEqual(expected.sort());
    expect(new Set(measured).size).toBe(expected.length);
  });

});

describe('Native suite isolation and product-dependent selection', () => {
  test('one suite cannot lend its mocked module or globals to another', () => {
    const directory = scratchDir('suite-isolation');
    const first = join(directory, 'a.test.ts');
    const second = join(directory, 'b.test.ts');

    writeFileSync(join(directory, 'provider.ts'), 'export const read = () => "real provider";');
    writeFileSync(first, `import { mock, test, expect } from 'bun:test';
globalThis.__suiteLeak = true;
mock.module('./provider.ts', () => ({ read: () => 'mock provider' }));
const { read } = await import('./provider.ts');
test('the first suite owns its state', () => expect(read()).toBe('mock provider'));`);
    writeFileSync(second, `import { test, expect } from 'bun:test';
import { read } from './provider.ts';
test('the second suite keeps its real provider', () => {
  expect(globalThis.__suiteLeak).toBeUndefined();
  expect(read()).toBe('real provider');
});`);
    const gate = LADDER.find((row) => row.label === 'Devbox durability decisions');

    if (gate === undefined) throw new Error('there is no broad devbox source row');
    const argv = runnableArgv(gate.run, tracked).slice(0, -1);
    const child = Bun.spawnSync([process.execPath, 'scripts/ladder.ts', '--run', ...argv, first, second], { cwd: root, env: childEnv(), stdout: 'pipe', stderr: 'pipe' });

    expect(child.exitCode, child.stdout.toString() + child.stderr.toString()).toBe(0);
  });

  test('a product change catches its unchanged consumer without running unrelated tests', () => {
    const directory = scratchDir('native-changed-tests');
    const affected = join(directory, 'value.test.ts');
    const unrelated = join(directory, 'unrelated.test.ts');
    const product = join(directory, 'product.ts');

    initRepo(directory);
    writeFileSync(product, 'export const value = 42;');
    writeFileSync(affected, `import { test, expect } from 'bun:test'; import { value } from './product'; test('consumer', () => expect(value).toBe(42));`);
    writeFileSync(unrelated, `import { test, expect } from 'bun:test'; test('unrelated', () => expect(1).toBe(0));`);
    git(directory, 'add', '-A');
    git(directory, 'commit', '-qm', 'test(fixtures): seed unchanged consumers');
    git(directory, 'branch', 'fixture/base');
    const source = LADDER.find((gate) => gate.run.startsWith('bun test '));

    if (source === undefined) throw new Error('there is no native Bun source row');
    const files = [affected, unrelated];
    const selected = changedTestGate({ ...source, run: 'bun test --timeout=0 --isolate ' + directory + '/*.test.ts' }, 'fixture/base', files);

    if (selected === undefined) throw new Error('the native consumer selection is absent');
    const report = join(directory, 'results.xml');

    for (const [text, exit] of [['export const value = 43;', 1], ['export const value = 41 + 1;', 0]] as const) {
      writeFileSync(product, text);
      const child = Bun.spawnSync([...runnableArgv(selected.run, files), '--reporter=junit', '--reporter-outfile=' + report], { cwd: directory, env: childEnv(), stdout: 'pipe', stderr: 'pipe' });

      expect(child.exitCode, child.stdout.toString() + child.stderr.toString()).toBe(exit);
      const observed = parseJUnit(readFileSync(report, 'utf8'));

      expect([...observed.files].map((file) => basename(file))).toEqual(['value.test.ts']);
      expect(observed.total).toBe(1);
      expect(observed.failed.length).toBe(exit);
    }
  });
});
