/**
 * The gate ladder: which gate runs at commit, at push, on a pull request, and
 * before a deploy — as data, in one place, with the cost that decided it.
 *
 * It exists because the three lists we had disagreed and nobody could see it.
 * Measured 2026-08-17 at HEAD 5183d69d: `scripts/deploy.sh` claims 395 of the
 * 400 tracked test files, `.github/workflows/ci.yml` claims 339, and the delta
 * — agent-utils, compaction, pc-agent, 41 of 42 `cli` files, the root `tests/`
 * directory, and `bun run layergate` entirely — was invisible from a green CI
 * badge. A subset nobody declared is the same defect as a gate reporting green
 * over something it never looked at, one level up.
 *
 * Three rules make that impossible rather than merely fixed today.
 *
 *   1. The DEPLOY tier is not declared here. It is PARSED out of deploy.sh,
 *      which stays the single source of truth for what blocks a production
 *      publish and stays locked by `scripts/deploy.test.ts`'s exact-order
 *      assertion. This file never holds a second copy of that list, so the two
 *      cannot drift — there is only one.
 *   2. The ladder is MONOTONE: commit ⊆ push ⊆ ci ⊆ deploy, compared by the test
 *      files each gate claims rather than by command text, so a gate growing an
 *      argument does not read as a hole.
 *   3. Every deploy gate is claimed by the CI tier or carries a written reason
 *      why it cannot be. `ladder.test.ts` fails naming any gate with neither.
 *
 * Monotonicity is also what makes the standing "never `--no-verify`" rule
 * honest. A hook is a strict subset of CI, so skipping one cannot let anything
 * through — it only buys a slower failure. There is nothing to gain by
 * bypassing one, which is the only durable way to make a rule like that hold.
 *
 * Hooks are a latency optimisation over CI. They are never a unique gate, and
 * this file does not pretend a local hook is enforcement: a fresh clone has no
 * hooks installed at all.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cpus } from 'node:os';
import * as v from 'valibot';
import { assertMeasured, finding } from './gate-ratchet';
import { plantedInputs, readCensusLock } from './census-plants';
import { DEADLINE_EXIT_CODE, LEFTOVER_BLIND_SPOTS, runUnderDeadline } from './deadline';
import {
  CACHE_BLIND_SPOTS, defaultStoreDirectory, gateEnvironment, gateEnvNames, planGate, recordGreen, storeAt, toolVersions,
} from './ladder-cache';
import type { GateCacheRequest, Plan } from './ladder-cache';
import { auditClosure } from './ladder-audit';
import { deriveClosure, repoAt } from './ladder-closure';
import type { Inputs, Repo } from './ladder-closure';
import {
  isBunDiscoverableSuite, isParseable, isPythonSuite, isRunnableSuite, isVitestEvalSuite, readMatching,
  trackedFiles,
} from './sources';
import { CLI_TEST_ROOT } from './test-cli';
import { modulesReaching } from './import-closure';
import { AMBIENT_CREDENTIAL_ENV, AMBIENT_DECORATION_ENV, EVAL_IDENTITY_ENV, LIVE_MODEL_ENV } from '../packages/test-utils/src/index';
import { COST_TABLE, type CostTable, costRssMb, costThreads, machineName, readCosts } from './gate-cost';

/** DERIVED, because it was hardcoded as 21 while the config carried 22 — a stale count in the
 *  document that tells a reader what a rung catches. Read from the enabled rules rather than from the
 *  plugin's registry: a rule registered and not enabled catches nothing. Read when the row's text is,
 *  never at load: `--run` loads this module and reads no tracked file beyond its modules. */
function antiSlopRuleCount(): number {
  return Object.keys(
    v.parse(
      v.object({ rules: v.record(v.string(), v.unknown()) }),
      JSON.parse(readFileSync(new URL('../.oxlintrc.json', import.meta.url).pathname, 'utf8')),
    ).rules,
  ).filter((rule) => rule.startsWith('anti-slop/')).length;
}

const root = new URL('..', import.meta.url).pathname;

/** Where the tracked hooks live, RELATIVE so git resolves it against each
 *  worktree's own root — see `--install-hooks`. */
export const HOOKS_DIR = '.githooks';


/**
 * Tier order is containment order: a later tier runs everything before it.
 * `evals` sits LAST, after `deploy`, and that placement is its meaning:
 * live-model behavioural evidence that no hook, push or deploy waits on. A
 * deploy that ran the evals took over an hour and spent real tokens to ship a
 * build, so the evals run deliberately — `bun run test:live` and `bun run evals` —
 * and a full evals run still runs every cheaper tier first, which is what the containment
 * order buys. gate-set-equality exempts exactly this tier from the "every
 * LADDER entry is a deploy gate" rule and prints the exemption with the tier's
 * members, so an entry cannot hide from the deploy by wearing the tier
 * silently.
 */
export const TIERS = ['commit', 'push', 'ci', 'deploy', 'evals'] as const;

/**
 * The deploy's phases, in the order the runner walks them, with a barrier
 * after each. `source` is the one concurrent wave; every other phase holds
 * the gates that run alone, and `post-publish` runs after the upload and the
 * smoke test against the build that just shipped. The runner reads this
 * order out of `--plan`, so the order lives here and nowhere else.
 */
export const DEPLOY_PHASES = ['preflight', 'source', 'hammer', 'infra', 'post-publish'] as const;

export type DeployPhase = (typeof DEPLOY_PHASES)[number];

/** The shared process-tree deadline for a gate that declares none, seconds.
 *  Calibrated against the slowest source gate; a live probe that needs more
 *  declares its own on its row with the reason. */
export const GATE_DEADLINE_SECONDS = 480;

export type Tier = (typeof TIERS)[number];

/**
 * THE ONE RESOURCE THE COST MODEL CANNOT SEE — DECLARED AS A HYPOTHESIS.
 *
 * A row that boots a headless browser takes the box's browser lane whole: the
 * Chrome tree, the dev server behind it and — for the live-app row — the
 * workerd the Cloudflare vite plugin runs the product in. The wave admits at
 * most ONE holder of that lane at a time, and every row's declared seconds
 * were measured alone, which is what serial admission already assumed.
 *
 * WHAT IS MEASURED AND WHAT IS NOT. Measured 2026-09-18 on the 24-thread
 * workstation, quiet box (load 1.04 concurrent / 0.45 serial, 41.2 GiB
 * MemAvailable, both caps slack), the three browser rows of that day's red
 * wave:
 *
 * | row | concurrent | serial |
 * | --- | --- | --- |
 * | UI gate self-tests | 480.1 s, 124 | 480.2 s, 124 |
 * | Public pages render | 480.1 s, 124 | 480.2 s, 124 |
 * | Live app in a browser | 152.8 s, 1 | 149.7 s, 1 |
 *
 * So the overlap is NOT what reddened them: all three are red alone, on one
 * product defect (the plan-review surface never mounts — see L9). The lane is
 * therefore a hypothesis about contention, not a measured cause, and it is
 * enforced because the cost model provably cannot express it: those rows are
 * admitted at 1, 1 and 3 threads and 2,534, 2,458 and 6,446 MiB, so no cap
 * refuses the overlap at any value the box can carry. L9 in
 * docs/ARCHITECTURE-DECISIONS.md, which names the entry it amends (L6, the
 * measured-cost admission, B9 @719363154).
 */
export const SHARED_RESOURCES = ['browser'] as const;

export type SharedResource = (typeof SHARED_RESOURCES)[number];

export interface Gate {
  /** The exact command as invoked. */
  readonly run: string;
  /** The short human name the deploy runner prints beside its verdict. */
  readonly label: string;
  /** Where in the deploy the gate runs. Every phase but `source` runs its
   *  gates ALONE, one wave each, in {@link DEPLOY_PHASES} order; a row that
   *  declares none runs in the concurrent source wave. A row declaring a
   *  phase other than `source` carries `alone`: why nothing may run beside it. */
  readonly phase?: Exclude<DeployPhase, 'source'>;
  /** Why the gate runs alone. Required with `phase`. */
  readonly alone?: string;
  /** The machine resource the row takes WHOLE, where the derivation below
   *  cannot see it from the files the row claims. DERIVED for every row that
   *  claims a module reaching puppeteer ({@link sharedOf}); a declaration is
   *  for a row that takes the resource some other way, and a declaration no
   *  derivation confirms is refused by the census in `ladder.test.ts`. */
  readonly shared?: SharedResource;
  /** Seconds before the deploy runner kills the gate's process tree, where
   *  the shared `GATE_DEADLINE_SECONDS` does not fit; with the reason. */
  readonly deadline?: { readonly seconds: number; readonly why: string };
  /** The cheapest tier that runs it. Every later tier runs it too. */
  readonly tier: Tier;
  /** Measured wall clock in seconds. Every entry carries its own date and box beside it; re-validated 2026-09-05 on the 24-thread workstation. */
  readonly seconds: number;
  /** The defect class this makes impossible. Not what it "checks". */
  readonly catches: string;
  /** What it does NOT catch. A gate whose blind spot nobody wrote down gets
   *  trusted for things it never looked at — which this repo has shipped three
   *  times. */
  readonly blind: string;
  /** What the gate's verdict can depend on, for the cache: `derived` from the
   *  module graph plus the declared `reads` and `env`, or `live` with the
   *  reason a hash over the tree cannot stand for it. See
   *  `scripts/ladder-closure.ts`. */
  readonly inputs: Inputs;
}

/** The environment names the by-name projections in `packages/test-utils`
 *  can reach: the preload's credential strip, `ambientByName`, and the live
 *  model and eval identity resolvers. Every `bun test` gate loads the preload,
 *  so every such row declares this set, DERIVED from the lists those
 *  projections read rather than restated — a name added to `LIVE_MODEL_ENV`
 *  widens the cache key by itself. `KINU_EVAL_LIVE` is the preload's own
 *  consent switch. */
const AMBIENT_BY_NAME: Extract<Inputs, { kind: 'derived' }> = {
  kind: 'derived',
  env: [
    ...AMBIENT_CREDENTIAL_ENV, ...AMBIENT_DECORATION_ENV, ...Object.values(EVAL_IDENTITY_ENV),
    ...Object.values(LIVE_MODEL_ENV).flat(), 'KINU_EVAL_LIVE', 'KINU_EVAL_BACKEND',
  ],
};

/** A row that builds the client with vite: vite reads the client graph by
 *  path and Tailwind scans the tree for class names, so every tracked file is
 *  an input. Measured by `--audit-closure` 2026-09-23: React runtime identity
 *  opened 1,319 tracked files off its module graph. */
const CLIENT_BUILD: Inputs = { ...AMBIENT_BY_NAME, corpus: true };

/** A row vitest runs in a workers pool rooted at `base`: its config bundles
 *  with esbuild and writes by path inside the base, and the worker the config
 *  names is walked from it (`configNamedModules`, ladder-closure.ts). Measured
 *  by `--audit-closure` 2026-09-24 on the complexity row. */
function workersPool(base: string): Inputs {
  return { ...AMBIENT_BY_NAME, reads: [`${base}/`] };
}

/** Gates that run before the deploy tier. The deploy tier is parsed from
 *  deploy.sh — see the header. Cheapest first inside each tier, so the first
 *  failure is also the fastest to reproduce. */
export const LADDER: readonly Gate[] = [
  {
    run: 'bun scripts/preflight.ts',
    label: 'Environment preflight',
    phase: 'preflight',
    alone: 'runs alone and FIRST. Its subject is the environment every other gate reports through: '
      + 'an exhausted $TMPDIR inode table surfaces later as a 5-second timeout inside an '
      + 'unrelated filesystem test, which reads as a code regression and is not one. A gate '
      + 'running beside it could report that regression before the preflight had said the '
      + 'machine was unfit to be reported on.',
    tier: 'commit',
    seconds: 0.12,
    catches: 'a gate reporting on an environment nobody looked at: exhausted temp '
      + 'inodes, or a stray project marker that makes a checkpoint working directory '
      + 'unbounded. Both had already turned deploy gate 6 red for reasons unrelated to '
      + 'any change under test, and both presented as "this test timed out after 5000ms".',
    blind: 'anything inside the repository. It only reads the machine.',
    inputs: { kind: 'live', why: 'reads the machine — inode tables, temp roots, stray project markers — none of which a hash over the tree stands for.' },
  },
  {
    run: 'bun test --timeout=0 scripts/pattern-inventory.test.ts scripts/jsonc.test.ts scripts/syntax.test.ts',
    label: 'Pattern census and parser self-tests',
    tier: 'push',
    seconds: 0.2, // Measured 2026-09-06 on the 24-thread workstation.
    catches: 'a pattern census that mistakes strings for regexes, a JSONC parser that changes data, or a syntax tree '
      + 'kept alive after its caller drops it',
    blind: 'semantic quality of a reviewed parser candidate',
    inputs: AMBIENT_BY_NAME,
  },
  {
    run: 'bun scripts/pattern-inventory.ts',
    label: 'Pattern inventory',
    tier: 'commit',
    seconds: 2.5, // Measured 2026-09-23 on the 24-thread box at load 5: 2.50/2.51/2.63 s.
    catches: 'unclassified code-pattern and named scanner candidates in the shared source corpus',
    blind: 'runtime aliases, unnamed scanners, native source and embedded shell language tokens',
    inputs: { kind: 'derived' },
  },
  {
    run: 'bun run lint',
    label: 'Anti-slop lint',
    tier: 'commit',
    // Measured 2026-09-15 on the 24-thread workstation, quiet: 21.4 s solo
    // (test:anti-slop under node, then oxlint). Split out of `bun run check`
    // (37 s) so the lint's closure — the anti-slop tool tree and the corpus —
    // is keyed apart from the typecheck's. 2026-09-22: the trailing plain
    // `oxlint` is gone; `live-tree.gate.test.ts` lints the tree once and reads
    // its exit status. Interleaved at load 64-170: 149/181 CPU-s before,
    // 90/96 after. The 21.4 s stands until a quiet re-measure.
    seconds: 21.4,
    get catches() {
      return `the ${String(antiSlopRuleCount())} anti-slop rules across every file, every line, and the `
        + 'rule suites that prove each rule red-to-green under node.';
    },
    blind: 'types and behaviour. A lint-clean call to the wrong function passes.',
    // `anti-slop/rules.test.ts` imports every rule suite it discovers through
    // `sources.ts`; the suites are tracked under this directory.
    inputs: { kind: 'derived', imports: ['tools/oxlint/anti-slop/rules/'] },
  },
  {
    run: 'bun test --timeout=0 packages/agent-core/drift.test.ts scripts/mossaic-sdk.test.ts',
    label: 'Vendored upstream drift',
    tier: 'commit',
    // Measured 2026-09-20 on the 24-thread workstation, quiet: 0.18 s solo for
    // both files in one invocation — the same figure the agent-core file alone
    // carried, because the cost here is process start, not the digests.
    seconds: 0.2,
    catches: 'a byte of vendored upstream that no longer matches its digest-pinned commit — the '
      + 'agent-core runtime dist, and the Mossaic SDK source closure. The Mossaic half also holds '
      + 'the file SET, so a path in the tree that the manifest never pinned is a finding: that is '
      + 'what a declaration generator writing beside the sources looks like, and every digest '
      + 'still matches while it happens.',
    blind: 'whether the pinned upstream commit is the one that should ship.',
    inputs: AMBIENT_BY_NAME,
  },
  {
    run: 'bun run typecheck',
    label: 'TypeScript projects',
    tier: 'commit',
    // Measured 2026-09-15 on the 24-thread workstation, quiet: 18 tsc projects
    // sum to 11.9 s solo (largest cf-backend 1.4 s, scripts 1.25 s, core 1.0 s).
    // One row rather than eighteen: every project reads the corpus, so their
    // closures are one closure and a split would buy no cache hit.
    seconds: 12,
    catches: 'type errors across all the projects `package.json`\'s `typecheck` names, following '
      + '`bun run` transitively. The largest defect class by volume and the only total one.',
    blind: 'everything about behaviour. A well-typed call to the wrong function passes. '
      + 'Also the three `node --check` parses of the pc-agent daemon, which prove syntax only.',
    inputs: { kind: 'derived' },
  },
  {
    run: 'bun run gate:do-init',
    label: 'Durable Object cold start',
    tier: 'commit',
    // Measured 2026-09-05 on the 24-thread box (load 2.3): 0.71 s. Replaces 0.1 s.
    seconds: 0.71,
    catches: 'off-object I/O inside a Durable Object `onStart`, which put a pure SELECT '
      + 'at 25s and, past 31s, RESET the object. That invariant held at the method and '
      + 'was defeated at the object.',
    blind: 'I/O added on any other DO lifecycle path.',
    inputs: { kind: 'derived' },
  },
  {
    run: 'bun run gate:duplication',
    label: 'Duplicate implementations',
    tier: 'commit',
    // Re-measured 2026-09-05 on the 24-thread box: 1.6/1.6/1.7/1.7s. Replaces 1.1s.
    seconds: 1.7,
    catches: 'a second implementation of an existing function body, including one with '
      + 'every identifier renamed — the mechanism behind "X never worked in Y backend".',
    blind: 'duplication refactored enough to differ structurally, and duplicated '
      + '*policy* expressed in different code.',
    inputs: { kind: 'derived' },
  },
  {
    run: 'bun run gate:reachability',
    label: 'Unreachable RPC surface',
    tier: 'commit',
    // Measured 2026-09-05 on the 24-thread box (load 2.3): 2.27 s. Replaces 1 s.
    seconds: 2.27,
    catches: 'an @callable RPC no caller reaches — the "correct, wired, dead" class this '
      + 'codebase has shipped at least ten times.',
    blind: 'a reachable RPC whose result nobody reads.',
    inputs: { kind: 'derived' },
  },
  {
    run: 'bun run gate:platform',
    label: 'Platform fact catalog',
    tier: 'commit',
    // Measured 2026-09-05 on the 24-thread box (load 2.3): 0.22 s. Replaces 0.07 s.
    seconds: 0.22,
    catches: 'a platform number stated in prose with no catalog id behind it, and a '
      + 'catalog entry with no evidence label or provenance.',
    blind: 'whether the catalogued number is still true.',
    inputs: { kind: 'derived' },
  },
  {
    run: 'bun run gate:egress-interception',
    label: 'Egress interception totality',
    tier: 'commit',
    // Measured 2026-09-05 on the 24-thread box (load 2.3): 0.73 s. Replaces 0.1 s.
    seconds: 0.73,
    catches: 'a container class that lost `enableInternet = false` or '
      + '`interceptHttps = true`, a Worker entry that stopped exporting '
      + 'ContainerProxy, or a catch-all egress handler nobody binds — each one an '
      + 'un-intercepted way out of a container whose secrets have been replaced '
      + 'by placeholders.',
    blind: 'whether interception actually engages at runtime, and DNS, which '
      + 'leaves regardless and which the gate reports as a known residual '
      + 'rather than closing.',
    inputs: { kind: 'derived' },
  },
  {
    run: 'bun scripts/publication-egress.ts',
    label: 'Publication egress classified',
    tier: 'commit',
    // Measured 2026-09-24 on the 24-thread box (load 15): 0.09 s.
    seconds: 0.09,
    catches: 'a write, value import or writing helper on the MCTS settle path (mcts/convergence.ts) '
      + 'that nobody classified as a publication surface or a reasoned disclosure, so a sealed run '
      + 'could publish through it; and a classification whose egress is gone.',
    blind: 'what a classified import does in its own module, egress other than SQL tagged templates '
      + 'and memory writes, SQL assembled at runtime, whether a writer asks admitsPublication, and '
      + 'the rest of the settle path. The gate prints all five on its own green path.',
    inputs: { kind: 'derived', reads: ['packages/core/src/mcts/convergence.ts'] },
  },
  {
    run: 'bun run gate:typecheck-coverage',
    label: 'Typecheck coverage',
    tier: 'commit',
    seconds: 0.1,
    catches: 'a directory of tests that no tsconfig `bun run check` runs ever compiles. '
      + 'The root `tests/` directory was in that state: `check` named eight projects and '
      + 'not one included it, so the four suites that are the only evidence for '
      + 'multi-turn tool calling, memory across a reopen, MCTS evolution and '
      + 'cross-session transfer were never typechecked — on top of never having run. '
      + 'Pointed at the project compiler for the first time they produced 23 errors, '
      + 'including calls to `EvolutionEngine.onTurnComplete` and `BuiltinToolDeps.engine` '
      + 'long after both were deleted. The corpus is DISCOVERED on disk and the project '
      + 'list is PARSED from the `check` script (following `bun run` transitively), so '
      + 'neither side can be quietly narrowed.',
    blind: 'whether the tests in a covered directory assert anything. It proves they '
      + 'compile, which is exactly the signal that was missing.',
    inputs: { kind: 'derived' },
  },
  {
    run: 'bun run gate:set-equality',
    label: 'Measured set equals governed set',
    tier: 'commit',
    // Measured 2026-09-05 on the 24-thread box (load 2.3): 0.63 s. Replaces 0.2 s.
    seconds: 0.63,
    catches: 'a gate that measures a narrower set than the one it governs — the defect that '
      + 'appeared fifteen times across six subsystems on 2026-08-17, four of them committed BY '
      + 'the change written to close the previous one. Every gate program\'s corpus must come '
      + 'from `scripts/sources.ts` and be narrowed only by a named predicate exported there, so '
      + 'measurement cannot drift narrower than enforcement. It also refuses a `writeLock` or a '
      + '`report` that no `assertMeasured` precedes: a ratchet published before the corpus was '
      + 'proved non-empty states the HEALTHIEST possible number about a population nobody '
      + 'looked at. Its own denominator is the union of LADDER and deploy.sh, because those two '
      + 'disagree by one (`bun run verify:lean`) and reading either alone would certify 34 '
      + 'while governing 35.',
    blind: 'sets that are not repository files — temp-directory prefixes, sandbox copy '
      + 'exclusions, statistical denominators — and grounding failures, where a claim was '
      + 'relayed rather than read. Three of the fifteen were each of those and no set-equality '
      + 'assertion reaches them. Also blind to the 2 shell gate programs, which it counts and '
      + 'never parses.',
    inputs: AMBIENT_BY_NAME,
  },
  {
    run: 'bun run gate:literature-citations',
    label: 'External citation register',
    tier: 'commit',
    // Measured 2026-09-05 on the 24-thread box (load 2.3): 5.86 s. Replaces 1 s.
    seconds: 5.86,
    catches: 'a QUALIFIER lost crossing the one boundary nothing else checks — prose to a paper '
      + 'nobody in this process can open. `lean-citations` closed TypeScript -> Lean and caught '
      + 'three stale citations immediately; docs -> literature was the boundary still open, and '
      + 'a removed internal audit of seven numbers found six of seven DIGITS correct and '
      + 'four QUALIFIERS wrong, so a digit-comparing gate would have passed all seven. This one '
      + 'refuses the qualifier instead: an external number with no register entry and therefore '
      + 'no locator; a compute-dependent claim under a bare parity ADJECTIVE (`+12.5 at matched '
      + 'compute`, over a subtraction spanning a no-search row the same paper prices at 20x the '
      + 'LM calls); a hedge the source states and prose deletes (GEPA\'s `up to 11.33%`, which '
      + 'overstated its own justification by ~55%); a confusable unit left unnamed (`+25.4` is '
      + 'DISCRIMINATION accuracy, and read as task accuracy it argues the opposite); a locator '
      + 'naming a table that does not hold the number; and a WITHDRAWN number re-asserted as '
      + 'live. `scripts/literature.ts` is the one place an external number is written down, so '
      + 'the set is enumerable (`--list-claims`) with provenance DEPTH — first-hand, second-hand '
      + 'through an internal artifact, or read by nobody — which is what gives a '
      + 're-verification pass a worklist instead of a re-read.',
    blind: 'the digit itself, and whether a locator SUPPORTS its claim. It never opens a paper: '
      + 'prose and register can agree and both be wrong, and an author-declared `withdrawn` is '
      + 'trusted rather than verified. It governs a number only where a source is cited by '
      + 'author-or-arXiv form or by one of its own registered figures, so a number beside a bare '
      + 'product name is ungoverned — deliberately, since `GEPA` and `LATS` are modules here as '
      + 'often as papers. Reach is 4000 characters AND the structure holding the citation, so a '
      + 'claim further than that from its citation is ungoverned; the bound exists because a '
      + 'machine-written document has no paragraphs, and paragraph reach read one 206KB run '
      + 'recording as a single paragraph. Captured output declared by its own leading `ranAt` is '
      + 'read for quotations only and never judged — it asserts nothing and cannot be corrected '
      + 'without being falsified — but it earns no credit either, so a register entry whose only '
      + 'home is a recording is a finding. A citation inside a STRING LITERAL is not read at all, '
      + 'which is where the bare-parity defect in `scripts/axis-ergonomics/` was sitting. It '
      + 'cannot see a compressed QUOTATION, which is the one defect in this family that needed a '
      + 'human and the recorded source. It prints all of this on the GREEN path, because a blind '
      + 'spot visible only in red output is invisible exactly when the tree is clean.',
    inputs: { kind: 'derived' },
  },
  {
    run: 'bun run gate:commit-message',
    label: 'Commit message hygiene',
    tier: 'commit',
    seconds: 0.1,
    catches: 'a commit message that credits an orchestration subagent as if it were a human '
      + 'reviewer, narrates the session that produced it, or argues with a previous position in '
      + 'the first person — plus the absence of any prefix convention. Measured over all 1,898 '
      + 'commits of the pre-convention history: nine agent names landed as cited actors (`Main\'s '
      + 'ruling`, `FixtureZero\'s findings`, `SealSideDoor\'s publication-seal work`), an act '
      + 'credited to `the owner` in 118 commits, `this session` in 5, 84 lone `I`s across 49, and 187 distinct '
      + 'type-prefix tokens over 1,604 non-generated subjects with 627 carrying no prefix at all. '
      + 'Every commit here is authored under one person\'s name, so those lines read as him '
      + 'crediting colleagues who do not exist and contradicting himself. The subagent rule is '
      + 'DERIVED, not listed: a possessive-or-attribution to a CamelCase name that no tracked '
      + 'source file uses as an IDENTIFIER, read from the AST so the same name in a comment does '
      + 'not excuse it — which is exactly how nine of them are already spelled in this tree. Its '
      + 'sibling `.githooks/commit-msg` runs the same program over the message git is about to '
      + 'write, because a commit message is immutable the instant it exists; this tier covers the '
      + 'rebase and `--no-verify` paths, where git runs no commit-msg hook.'
      + ' `the owner` and `this session` are gated only where an ACT is credited or a session is '
      + 'used as work or time, because both are DOMAIN nouns here — `the owner` occurs in 119 '
      + 'tracked source files as a modelled entity with a UserDO, credentials and an approval '
      + 'queue. The bare phrase would have failed 27 of the 844 messages in the first rewritten '
      + 'history, all of them technically correct, and a gate wrong 3% of the time on day one is '
      + 'a gate somebody switches off. Past tense is the discriminator: `the owner asked` is a '
      + 'report of an instruction, `the owner asks what the WORKSPACE cost` is a product sentence.',
    blind: 'colon-reveal subjects (302 of 1,898, and the prefix rule rejects 298 of them for '
      + 'having no prefix rather than for their rhetoric — the 4 behind a legal prefix are '
      + 'invisible), binary contrasts (180 measured), em-dash density (3,234 across 61.4% of '
      + 'bodies) and sentence length (mean 26.6 words, 45.0% past ASD-STE100\'s ceiling). All '
      + 'four are real defects and all four have legitimate instances, so a gate on them would '
      + 'produce false positives and be disabled — they are review criteria and the gate prints '
      + 'them on its GREEN path. Also blind to the scope inside the parens (162 tokens in use), '
      + 'to a bare non-possessive mention of an agent, to an all-caps agent name (so that GEPA, '
      + 'LATS, MCTS and OpenAI are not findings), and to the DIFF — a well-formed subject '
      + 'describing a different commit passes every rule, and so does a pasted requester quotation '
      + 'with no attributing verb. History is not read as a standard: the '
      + 'governed range starts at the commit that added the gate.',
    inputs: { kind: 'live', why: 'reads git history from the gate-adding commit to HEAD; a new commit changes the verdict with no tracked file changed.' },
  },
  {
    run: 'bun run gate:install-scripts',
    label: 'Dependency install-script policy',
    tier: 'commit',
    // Measured 2026-09-05 on the 24-thread box (load 2.3): 0.05 s. Replaces 0.2 s.
    seconds: 0.05,
    catches: 'a third-party dependency lifecycle script executing on every `bun install` without '
      + 'a recorded reason. Measured 2026-09-12: eight installed dependencies declare `preinstall`/'
      + '`install`/`postinstall`; bun blocks five; THREE EXECUTE — esbuild, workerd, puppeteer — and '
      + 'the first two fetch a binary and run it (`fetch(`, `https.get`, `execFileSync` in their '
      + 'install.js). Nothing in this repository authorised that: `trustedDependencies` is absent, '
      + "so the allowlist doing the work is bun's own, compiled into bun and able to widen in a "
      + 'patch release. This gate subtracts `bun pm untrusted` from the declared set to learn what '
      + 'actually runs, and fails when that set is not exactly the allowlist — so a new dependency '
      + 'arriving with a hook, or a `trustedDependencies` entry appearing, is a deliberate edit '
      + 'with a stated reason rather than a default drifting underneath us.',
    blind: 'whether an allowed script is SAFE. It cannot judge that and does not pretend to; it '
      + 'only forces the set to be a decision. Also blind to what a script does at runtime, to '
      + 'transitive `bun.lock` integrity, and to CVEs — `bun run gate:dependency-advisories` '
      + 'is the gate for the last, and shares the reviewed-set shape with this one.',
    inputs: { kind: 'derived', reads: [] },
  },
  {
    run: 'bun run gate:patch-parity',
    label: 'Committed patches reproduce node_modules',
    tier: 'commit',
    seconds: 0.16,
    catches: 'a committed patch that does not reproduce the `node_modules` the suites ran '
      + 'against. Four dependencies are patched, so every green result in this repository stands '
      + 'on that equality, and nothing checked it. The incident: a core patch regenerated BEFORE '
      + 'its `.d.ts` hunks were written restored undeclared type files on a fresh install and '
      + 'failed `bun run check` — while `check` and the runtime parity test both read green, '
      + 'because one typechecked a tree that already held the edits and the other reads only '
      + '`dist/*.js`. Both directions are covered: a patch missing a hunk the tree has, and a '
      + 'patch carrying one it does not. The corpus is `patchedDependencies` itself, never a '
      + 'second list — a hand-maintained mirror is the defect class this closes.',
    blind: 'files the patch does NOT touch; whether the patch is a good idea; and WHICH CHECKOUT '
      + 'it answers for — `setup-worktree.sh` symlinks each node_modules entry to the main '
      + "checkout's, so one shared directory serves every worktree while `patches/` is per-commit, "
      + 'and at most one checkout can be truthful at a time. The gate prints its full blind-spot '
      + 'list on the GREEN path, where it is actually needed.',
    // Reads `package.json` (in the graph), `patches/` (in every closure) and
    // the installed tree behind the lock; nothing else in the tree.
    inputs: { ...AMBIENT_BY_NAME, reads: [] },
  },
  {
    run: 'bun run gate:ladder-budget',
    label: 'Tier-budget ratchet',
    // PUSH, beside `bun test scripts/ladder.test.ts` and for its reason: the ratchet
    // judges the declarations of BOTH cheap tiers, and every push runs every commit
    // gate — so one static check at push governs both hooks, while a commit-tier row
    // would judge push-tier membership from the faster hook. Like the other whole-tree
    // locks (`gate:complexity`, `gate:wired`) it lives at push because a gate's cost
    // cannot change between a commit and the push that follows it.
    // Measured 2026-09-05 on the 24-thread box: 0.07/0.08/0.08s; declared 0.2s so a
    // loaded machine has headroom.
    tier: 'push',
    seconds: 0.2,
    catches: 'a tier whose declared cost outgrew its measured figure — a new gate, a '
      + 're-measured row nobody re-locked, or a declaration edited by hand. The lock pins '
      + 'the measured seconds per gate, so the failure names the step that grew most.',
    blind: 'the wall clock itself. This compares declarations to the lock; a gate that '
      + 'slows without its row updated passes until somebody re-measures. Shrinkage '
      + 'passes deliberately: a faster tier is the ratchet working.',
    inputs: AMBIENT_BY_NAME,
  },

  {
    run: 'bun run gate:bench-corpus',
    label: 'Seeded bench defects still apply',
    // COMMIT. Held at push, it let comment-only commits on 2026-09-22 break 37
    // seeded patches and still commit cleanly: a comment reflow moves the
    // context a patch anchors on as surely as a rename does, and the author had
    // already moved on by push. At 0.34s over the whole corpus (measured
    // 2026-09-23 at load 20) the refusal belongs on the commit that moves the
    // anchor.
    tier: 'commit',
    seconds: 0.34,
    catches: 'a refactor that silently unruns a bench task. Each seeded defect is a '
      + 'context diff against source that keeps moving, so renaming or reflowing the code a '
      + 'patch anchors on stops it applying — and `prepare` then throws OUTSIDE the '
      + 'per-attempt catch, killing a whole compare/gain/validate run mid-flight with no '
      + 'partial report. All 16 re-anchors to date landed as a follow-up commit AFTER the '
      + 'change that caused them, because the only thing proving applicability was a pair of '
      + 'near-duplicate assertions at the ci tier. At 0.34s over the whole corpus there was no '
      + 'reason for that: the breaking change now fails on the machine that made it, while the '
      + 'person who moved the code is still holding it. It caught the branch that introduced '
      + 'it breaking sealed-validate-flags-the-good-tasks. Both enumerations, so an ORPHAN '
      + 'patch file no tasks.jsonl line names is named as one rather than passing as a file '
      + 'nobody loads.',
    blind: 'whether a patch that applies still BREAKS anything — a re-anchored hunk can land '
      + 'somewhere the defect no longer bites, and only `bun scripts/bench.ts validate --id '
      + '<id>` (one task, 93s, no model) answers that. Also whether the defect is still the '
      + 'one the task PROMPT describes, which no mechanical check can decide.',
    inputs: AMBIENT_BY_NAME,
  },
  {
    run: 'bun run gate:skip-ratchet',
    label: 'Declared skip ratchet',
    // MOVED commit -> push when its measured cost went 0.3s -> 2.9s. The 0.3s was
    // never right — `bun test ./tests/` alone is 1.2s — and covering the vitest arm
    // added a vite transform on top, so the commit tier's declared 15s budget was
    // being met on an understated number. Push rather than a raised budget: the
    // budget exists so nobody learns to bypass the hook, and a skip set is fully
    // recoverable at push. Nothing it asserts was narrowed to fit.
    tier: 'push',
    // Re-measured 2026-09-23 on the 24-thread box at load 5: 17.8/17.9/18.5 s; the
    // vitest arm has grown since the 12 s of 2026-09-05. Too slow for commit.
    seconds: 18,
    catches: 'a test that starts skipping, and a declared skip that has started running '
      + 'without the lock being tightened. Credential-free the live tier reports its skips '
      + 'and exits 0, and that exit code is all anyone reads — so the skipped set is locked '
      + 'with a written reason per entry. Locking the SET rather than a count is what makes it '
      + 'work: a count cannot tell you a different set is skipping now. It also asserts every '
      + 'target contributed a test, and a file satisfies only the NARROWEST target that claims '
      + 'it, so no target can answer for another\'s.',
    blind: 'whether a running test asserts anything real. A skip is visible now; a '
      + 'vacuous pass is the next tier\'s problem.',
    inputs: AMBIENT_BY_NAME,
  },

  {
    run: 'bun run gate:dead-code',
    label: 'Dead code',
    // COMMIT, moved from push 2026-09-10. The old reason was that nothing can
    // become dead between a commit and the push that follows it. That premise
    // holds for one developer who commits then pushes, and it is FALSE for a
    // lane: a subagent commits in its own worktree, yields, and the integrator
    // merges, with no push in between — so the violation travelled as an
    // artifact and surfaced at the merge. Measured that way four times in one
    // day (`stepPruneBatchTokens`, `SlateSummary.port`, a lazy default export,
    // `MOVIE_ASK`) plus `PLAN_MESSAGES` here, every one authored by a lane whose
    // own acceptance was green because `bun run check` does not contain this
    // gate. Here it cannot be handed on: the commit hook runs this tier.
    // 15.2s measured 2026-09-10 on this tree, against the 7s declared when two
    // knip runs were the whole cost.
    tier: 'commit',
    seconds: 15,
    catches: 'an export referenced only by its own test, a file no entry point reaches at '
      + 'all, and a MANIFEST DECLARATION nothing imports. `ensureActorSchema` was the first '
      + 'of ten; the dependency class deleted thirteen declarations across four manifests on '
      + '2026-09-01, `shell-quote` among them — carried for a quadratic `parse()` no tracked '
      + 'source calls, behind an advisory the security scanner had to accept by name. That '
      + 'class is derived here rather than taken from knip, which reported `vitest-evals` '
      + 'unused because its root `entry` glob (`scripts/*.ts!`) cannot see the eval suites '
      + 'that import it; `dead-code.test.ts` joins both answers so the single difference '
      + 'stays explained. A row that survives must carry the resolution fact that keeps it '
      + '(hoisting, a phantom type-import, a peer contract), and an unreasoned lock row or a '
      + 'reason outliving its row both fail.',
    blind: 'a symbol referenced from live code that does nothing, and a dependency imported '
      + 'only through a runtime-computed specifier — the census reads import FORMS, so '
      + '`await import(name)` over a variable is invisible to it.',
    inputs: { kind: 'derived' },
  },
  {
    run: 'bun run gate:undeclared-imports',
    label: 'Undeclared imports',
    // COMMIT, beside `gate:dead-code`, which holds the same boundary from the
    // other side. The push premise does not apply and the commit one does: an
    // undeclared import cannot appear BETWEEN a commit and the push that
    // follows it, but it does not have to — a lane adds the import in its own
    // worktree, `bun run check` and `bun run test` both pass because the
    // hoisted linker resolves it against the root `node_modules`, the lane
    // yields, and the integrator merges. There is no push in between, so the
    // violation travels to the integrator as an artifact. That is the exact
    // premise falsified for `gate:wired` and `gate:dead-code` on 2026-09-10,
    // and it is falsified harder here: those two at least go red in the lane's
    // own tree once it runs them, whereas an undeclared edge is INVISIBLE to
    // every suite by construction — resolution succeeds.
    tier: 'commit',
    // Three readings 2026-09-10 on the 24-thread box under load 40 (five lanes
    // building concurrently): 5.31/5.49/6.29s, interleaved with
    // `gate:reachability` (declared 2.27, measured 6.27/7.92/8.09) and
    // `gate:duplication` (declared 1.7, measured 5.54/5.35/6.46) so the load is
    // common to all three. Scaling the median 5.49s by each neighbour's own
    // ratio gives 1.57s and 1.68s; 2s is declared — the larger, rounded up,
    // because a budget must never be made stricter by a reading nobody can
    // reproduce on the reference box.
    seconds: 2,
    catches: 'a package that IMPORTS what its own manifest never declares, resolving only '
      + 'through `bunfig.toml`\'s hoisted linker. Measured at e5528c2e9: `packages/cli-backend` '
      + 'imported `@kinu.run/test-utils` from 32 test files — the `workspace-resolution.test.ts` '
      + 'AGENTS.md mandates among them — behind a manifest with NO `devDependencies` at all, and '
      + 'a human reading a lock diff is what found it. `gate:dead-code`\'s dependency census '
      + 'walks declarations and is structurally unable to see this: an undeclared edge is not a '
      + 'declaration. The edge lives exactly as long as the hoist does, `scripts/deploy.sh` '
      + 'installs `--frozen-lockfile` so what ships is whatever the lock carries for reasons no '
      + 'manifest states, and an empty `devDependencies` reads to every tool as a package with '
      + 'no test dependencies. 54 such edges were locked on the tree that introduced this gate, '
      + '`packages/devbox` -> `@kinu.run/test-utils` among them: the same defect as e5528c2e9, '
      + 'live in a second package.',
    blind: 'a specifier no import FORM carries — `await import(name)` over a variable, a '
      + '`require()` in the CommonJS daemon, a CSS `@import`, a binary a manifest script spawns, '
      + 'and an ambient `@types/…` the compiler loads by `types`. Also version RANGES: a '
      + 'declaration is judged present, never correct. It prints all four on the GREEN path with '
      + 'the count of locked edges still outstanding.',
    inputs: { kind: 'derived' },
  },
  {
    run: 'bun run gate:wired',
    label: 'Built but unwired',
    // COMMIT, moved from push 2026-09-10 beside `gate:dead-code` and for the
    // same falsified premise: "nothing can become unwired between a commit and
    // the push that follows it" assumes the author pushes. A lane commits in a
    // worktree and yields, and the integrator merges — the commit is the last
    // moment this tree governs before the symbol becomes someone else's
    // artifact. Cost is real and stated rather than hidden: 7.7-9.3s measured
    // against the 3.6s declared when it was cheaper, so the commit tier grows
    // by roughly this plus dead-code's 15s.
    tier: 'commit',
    seconds: 9,
    catches: 'a capability that was designed, built, TESTED, and connected to nothing — the '
      + 'class `gate:dead-code` is structurally unable to see, because knip\'s unit of "used" '
      + 'for a re-exported symbol is the TERMINUS of the re-export chain, and every export in '
      + '`packages/core` terminates at `src/index.ts`, which is the package `main` and '
      + 'therefore an entry. Measured 2026-08-19 on a four-file probe carrying this repository '
      + "own `knip` block: two leaf symbols called by nothing, published through `export *` "
      + "from the entry, were clean in knip's default run AND in `--production`, and importing "
      + 'one THROUGH the barrel from a test changed neither run. `ignoreExportsUsedInFile: '
      + 'true` closes the other half, which is `FORK_STRATEGY_ID` exactly: declared at '
      + '`strategy/heads.ts:36`, read at `:40`, never reported. This gate measures PRODUCTION '
      + 'REACHABILITY instead — a path from an entrypoint that passes through no test and does '
      + 'not consist solely of re-exports — over entrypoints DISCOVERED from the declarations '
      + 'that create them: a handler bound under a `BUILTIN_TOOLS` name, a `@callable()`, a '
      + '`.command()`, a method on a framework-rooted class that nothing here invokes, a module '
      + '`export default` property, a `createRoot` mount, a shebang. It also reports the shape '
      + 'reachability over exports cannot see: an OPTIONAL FIELD production reads that no '
      + 'visible construction site of its interface supplies — `SwarmRunDeps.mission` was one, '
      + 'and wiring it at f5c8dbd5 turned this gate red on a lock entry that no longer '
      + 'reproduced. 570 findings measured at 0fff343e, 569 locked at f5c8dbd5, against a '
      + '`dead-code` lock of 12 symbols over the same 646 governed files.',
    blind: 'dynamic dispatch through a registry or a string key — `strategy/heads.ts` reads as '
      + 'reached because `fork-deps.ts` names its factory, and whether anything SELECTS that '
      + 'strategy is a fact about the registry. A symbol named only in a config file, which '
      + 'fails as a FALSE POSITIVE rather than quietly. A field ASSIGNED and never read: '
      + '`StrategyResult.cost.selfMetered` is written at `heads.ts:119` and `mcts.ts:118` and '
      + 'read nowhere, and this gate is silent on it. A symbol wired for one arm of a union and '
      + 'unwired for another, which is how a toolless search came within one commit of running '
      + 'free. Per-backend reach, the same residual `gate:dead-code` states. And whether a '
      + 'reached symbol does anything at all. It prints every one of these on the GREEN path, '
      + 'with the count of locked findings still outstanding, because debt visible only in red '
      + 'output is invisible exactly when somebody is deciding how far to trust the tree.',
    inputs: { kind: 'derived' },
  },
  {
    run: 'bun run gate:client-graph',
    label: 'Client graph',
    // COMMIT. The 2026-09-06 barrel regression shipped because no commit-tier
    // gate reads the client module GRAPH: the root barrel gained SQLite-backed
    // slate stores importing the vendored agent-core runtime, dev died before
    // mount, and the build stayed green by tree-shaking the unreached exports.
    // A lane adds one barrel value import in its own worktree and every suite
    // passes — the same artifact-travels-to-the-integrator shape that moved
    // `gate:wired` and `gate:dead-code` here. 0.62/0.67/0.75s measured on this
    // tree, 1s declared, the larger rounded up.
    tier: 'commit',
    seconds: 1,
    catches: 'a client entry that can reach `@agent-core/core` or `bun:sqlite` '
      + 'through value imports — the edge that blanks `bun run dev` while the '
      + 'build stays green. Walks the runtime graph from the three browser '
      + 'entries and fails naming the entry-to-edge chain.',
    blind: 'a computed specifier `await import(name)` names its module where no '
      + 'literal carries it; a direct `node:` builtin import in client code, a '
      + 'different edge with the same symptom; and any resolution Vite sees '
      + 'that the walk does not model. It prints all three on the GREEN path.',
    inputs: { kind: 'derived' },
  },
  {
    run: 'bun run gate:core-layering',
    label: 'Core layering',
    // COMMIT. 40 of core's 42 directories are one import cycle, so no package
    // split can start; this declares the three layers and locks today's 177
    // upward edges shrink-only. 0.43s measured, 1s declared.
    tier: 'commit',
    seconds: 1,
    catches: 'a new import inside packages/core that points from platform to '
      + 'tools or harness, or from tools to harness — one more edge in the cycle '
      + 'that blocks the package split.',
    blind: 'the layer map itself is an assertion, a cross-package edge is '
      + '`gate:undeclared-imports`\'s, and a literal `import(…)` is not read. '
      + 'It prints all three on the GREEN path.',
    inputs: { kind: 'derived' },
  },
  {
    run: 'bun run gate:vendor-schema',
    label: 'Vendor schema',
    // COMMIT, beside schema-drift, for its reason: every statement that names a
    // vendor-owned table is PREPARED against the vendor's own DDL, and a column
    // that does not exist refuses at prepare — the `actor_id` read against the
    // vendor's `assistant_messages` failed every hosted workspace at once on
    // 2026-09-11, on the same tree every unit test had seeded from Kinu's own
    // copy of the DDL. Measured 2026-09-12: 0.80/0.80/0.82s; 1s declared.
    tier: 'commit',
    seconds: 1,
    catches: 'a Kinu statement over a vendor table whose columns the vendor '
      + 'does not declare — read, write or JOIN — and a Kinu CREATE TABLE that '
      + 'names a table the vendor creates, which is two owners for one schema.',
    blind: 'statements built at runtime from strings, a vendor DDL whose text '
      + 'the gate cannot parse, and a column that exists with a different TYPE '
      + 'or DEFAULT — prepare checks names, not semantics. It prints all three '
      + 'on the GREEN path.',
    inputs: { kind: 'derived' },
  },
  {
    run: 'bun scripts/test-census.ts --ratchet',
    label: 'Test census ratchet',
    // COMMIT, with the other static gates that take seconds: a coupled test
    // found at push is found after the lane has built on it (2026-09-23, Main).
    // Measured 2026-09-23 on the 24-thread box at load 5: 3.88/4.05/5.14 s.
    tier: 'commit',
    seconds: 4.1,
    catches: 'a coupled test, by the axes a test review judges on. BANNED, whatever the lock holds: '
      + "an assertion over the implementation's TEXT, a test function or constant restating the "
      + "product's own, a reach into a member production declares non-public, and a mock of an "
      + 'internal module. RATCHETED, the lock only shrinking: a matcher that cannot fail on the '
      + 'defect its title names, keyed by category, file, TEST TITLE and finding shape, each locked '
      + 'key naming the plants that turn it red. It also refuses a STALE key, so a repaired '
      + 'coupling is recorded as repaired rather than left in the lock as budget for the next one.',
    blind: 'everything in its own `BLIND_SPOTS` list, printed on the GREEN path: a mirror by '
      + 'DERIVATION rather than by a shared named literal, a restated function renamed past its '
      + 'structure, a path or asserted string built by concatenation, a table-driven suite counted '
      + 'as one test, a tautology through a stored value, a mock echo, and a test asserting over an '
      + "installed dependency's shipped text — resolution runs against the enumeration and "
      + '`node_modules` is not tracked. A `scripts/` suite a ladder row runs is a gate test and may '
      + 'read the tree it governs.',
    inputs: AMBIENT_BY_NAME,
  },
  {
    run: 'bun scripts/census-plants.ts packages/',
    label: 'Census suspects proven (packages/)',
    tier: 'push',
    // Measured 2026-09-25 on the 24-thread box at load 2.8: 9.6 s (gate-cost.json).
    seconds: 9.6,
    catches: 'a locked tautology suspect that no longer catches the defect its lock entry plants, '
      + 'a plant whose planted text is gone, and a suspect red before any plant.',
    blind: 'every defect a title claims beyond the planted ones, and a relational check nobody '
      + 'planted against because the lock only holds what the census flags.',
    // Read when a closure is derived, never at load: `--run` loads this table, and its closure holds no census lock.
    get inputs(): Inputs { return { kind: 'derived', ...plantedInputs(readCensusLock(), 'packages/') }; },
  },
  {
    run: 'bun scripts/census-plants.ts scripts/',
    label: 'Census suspects proven (scripts/)',
    tier: 'push',
    // Keyed to the corpus: bench.test.ts and infra.test.ts reach scripts/sources.ts.
    // Measured 2026-09-25 on the 24-thread box at load 3.7: 5.0 s (gate-cost.json).
    seconds: 5,
    catches: 'a locked tautology suspect that no longer catches the defect its lock entry plants, '
      + 'a plant whose planted text is gone, and a suspect red before any plant.',
    blind: 'every defect a title claims beyond the planted ones, and a relational check nobody '
      + 'planted against because the lock only holds what the census flags.',
    // Read when a closure is derived, never at load: `--run` loads this table, and its closure holds no census lock.
    get inputs(): Inputs { return { kind: 'derived', ...plantedInputs(readCensusLock(), 'scripts/') }; },
  },
  {
    run: 'bun run gate:complexity',
    label: 'Complexity budget',
    // COMMIT: at push, lanes had already committed functions over the line
    // (2026-09-23). Measured that day on the 24-thread box at load 5 over 2,575
    // files and 63,573 functions: 2.44/2.50/2.54 s.
    tier: 'commit',
    seconds: 2.5,
    catches: 'a new function at the hard end of this codebase, arriving unnamed. The budget is '
      + 'MEASURED rather than chosen: cyclomatic complexity for every function in the '
      + 'enumeration, a ceiling at the highest (126, `handleUserRequest`) and a budget line at '
      + 'the 99.9th percentile (39), with all 51 functions at or above the line pinned by name '
      + 'and number. Growth is what fails — a fresh 40-branch dispatcher scores 41 and is red, '
      + 'a locked function that gains one branch is red, and a locked one that is simplified '
      + 'goes stale so the cleanup is recorded rather than quietly absorbed. The number is not '
      + "this program's opinion: `complexity.test.ts` joins it to `oxlint`'s own "
      + '`eslint/complexity` over the same corpus, offset by offset, and 47,994 of 47,994 '
      + 'agree.',
    blind: 'nesting depth, which cyclomatic complexity does not model — a flat twenty-case '
      + 'dispatch and five conditionals nested five deep score the same. Complexity MOVED '
      + 'rather than removed: six 10-branch helpers pass where one 60-branch function failed, '
      + 'with the same branching in the same call path. Growth below the line, since only the '
      + '51 at or above 39 are pinned and 232 functions sit at 20 or more. A file\'s total, a '
      + 'type-level union, and runtime cost — one branch around a quadratic scan scores 2. All '
      + 'of them are printed on the gate\'s GREEN path.',
    inputs: { kind: 'derived' },
  },
  {
    run: 'bun run gate:silent-drop',
    label: 'Silently dropped failures',
    tier: 'commit',
    // Measured 2026-09-23 on the 24-thread box at load 5: 0.98/1.00/1.03 s.
    seconds: 1,
    catches: 'a failure destroyed in one of the six ways the four no-swallow lint rules are '
      + 'structurally blind to — a sentinel returned behind a log line (the rule fires on a '
      + 'ONE-statement handler only), a cause chain projected down to `error.message`, an '
      + 'inline rejection handler that absorbs, a `throw new Error` inside a `.catch()` (the '
      + 'rule needs a CatchClause ancestor), a `void`-ed promise, and a bare call to an async '
      + 'function that can reject. 272 instances over 210 sites at 2b7b020f, ratcheted, over '
      + "the same 665 sources and 709 `catch` occurrences no-swallow's own denominator counts.",
    blind: 'a rejection handler passed by NAME, a promise stored and never awaited (a '
      + 'type-level fact, and oxlint\'s type-aware pass is not enabled here), and a wrapper '
      + 'factory that drops `cause` inside itself.',
    inputs: { kind: 'derived' },
  },
  {
    run: 'bun run gate:test-clocks',
    label: 'Wall-clock waits in tests',
    tier: 'commit',
    // Measured 2026-09-23 on the 24-thread box at load 5: 1.41/1.44/1.46 s over
    // 1,248 test files, one oxc parse each.
    seconds: 1.5,
    catches: 'a test that waits on a duration instead of an end condition — a timer call '
      + '(`setTimeout`, `Bun.sleep`, `timers/promises`, `AbortSignal.timeout`), a comparison '
      + 'against `Date.now()`/`performance.now()` or a binding made from one, a per-test '
      + 'duration handed to `test`/`describe`/a hook or to `setDefaultTimeout`, and a `{ timeout }` '
      + 'handed to a puppeteer wait or a `child_process` call. Five deploy runs on 2026-09-15 '
      + 'went red on five such tests that pass alone and lose the race under the deploy wave; '
      + 'the framework per-test clock is off everywhere (preload, every vitest config and '
      + '`--timeout=0` on every bun test row, pinned by the self-test) and this row\'s own '
      + 'deadline is the one hang detector. The sites found on the day it landed are in a '
      + 'shrink-only lock keyed by file and kind: a file outside the lock or a count above it '
      + 'is red, and `--lock` refuses a higher total.',
    blind: 'a clock value reaching a comparison through a parameter or a return value; a timer '
      + 'wrapped by a module outside the test corpus and called by the wrapper\'s name; a '
      + 'duration handed as a bare positional number to a helper the gate does not know; '
      + '`setImmediate` and `queueMicrotask`, which yield a turn without a duration; a clock '
      + 'read used as a value and never compared. All printed on the green path.',
    inputs: { kind: 'derived' },
  },
  {
    run: 'bun scripts/secret-scan.ts',
    label: 'Secret scan',
    tier: 'push',
    // Measured 2026-08-30: the persistent cat-file reader made the history
    // phase 16.3 s; live/index adds under 1 s on the local-ref corpus then present.
    seconds: 18,
    catches: 'a credential about to leave the machine in live or index material — including '
      + 'a Cloudflare user token with its exact 48-character URL-safe body — and one that '
      + 'survives in a blob reachable from any locally stored branch, tag, remote-tracking, '
      + 'or other ref. Push is the last tier where the live half is recoverable without a '
      + 'rotation; the history half makes a removal claim observable rather than hopeful.',
    blind: 'unreachable or reflog-only objects, and blobs containing NUL or exceeding 1 MiB. '
      + 'The latter two are counted in the green denominator but not decoded; a number is a '
      + 'visible blind spot, not evidence that their contents were scanned.',
    inputs: { kind: 'derived' },
  },
  {
    run: 'bun scripts/schema-drift.ts',
    label: 'Schema drift',
    tier: 'commit',
    // Measured 2026-09-01, three runs: 0.47/0.52/0.44s over 863 enumerated
    // product files, 71 parsed, 118 tables. It was a PUSH gate at 2s while it
    // asked git for each table's origin on every run; the genesis lock replaced
    // those 118 pickaxe walks with one file read, and the parser is handed only
    // the files carrying a statement it reads. Both counts are printed, so the
    // corpus cannot shrink behind the number. The commit tier is where this
    // belongs: the defect is written in the same hunk as the DDL.
    // Re-measured 2026-09-05 on the 24-thread box (load 2.3): 0.23 s.
    seconds: 0.23,
    catches: 'a column added to a shipped table with no reconciliation onto storage that '
      + 'predates it. The shape `code_language` shipped in, and the shape that answered '
      + 'GET /api/cli/devices with 500 in production on 2026-09-01 — `unstopped_at` on a '
      + 'user_devices table created 2026-06-12, with staging 500ing on `last_ip` from an '
      + 'older one. Also the excuse itself: the ONE allowlisted table has to prove its '
      + 'runtime mover is still called, and called after the table exists.',
    blind: 'a column that exists and is never written, and a column REMOVED from a DDL that '
      + 'live storage still has — both dead-field territory. Column TYPES and CONSTRAINTS '
      + 'too: ALTER TABLE cannot repair either, so neither is checked. The gate prints all '
      + 'six of its blind spots on its own green path.',
    inputs: { kind: 'derived' },
  },
  {
    run: 'bun test --timeout=0 scripts/gates.test.ts scripts/worker-bundle-reach.test.ts scripts/schema-drift.test.ts scripts/reachability.test.ts scripts/do-init-gate.test.ts scripts/do-init-block-bodies.test.ts scripts/platform-catalog.test.ts scripts/policy-drift.test.ts scripts/scratch-ownership.test.ts scripts/literature-citations.test.ts scripts/commit-hygiene.test.ts scripts/lean-citations.test.ts scripts/infra.test.ts scripts/patch-parity.test.ts scripts/silent-drop.test.ts scripts/test-clocks.test.ts scripts/analytics-datasets.test.ts scripts/release-config.test.ts scripts/egress-forwarder.test.ts scripts/release-manifest.test.ts scripts/complexity.test.ts scripts/ast-duplication.test.ts scripts/dead-code.test.ts scripts/undeclared-imports.test.ts scripts/core-layering.test.ts scripts/vendor-schema.test.ts scripts/refuse-linked-install.test.ts scripts/eval-session-mint.test.ts scripts/scanner-bundle-gate.test.ts scripts/coverage-merge.test.ts scripts/test-census.test.ts scripts/capability-parity.test.ts scripts/client-graph.test.ts scripts/install-scripts-gate.test.ts scripts/tracing-gate.test.ts scripts/comment-only.test.ts scripts/bloat-budget.test.ts scripts/publication-egress.test.ts',
    label: 'Gate self-tests',
    tier: 'push',
    // Measured 2026-08-24 after analytics dataset parity joined: 11.08s; release
    // config adds 1.44s (2026-08-27). The census's own suite joins it here and
    // walls 10.85s alone on a 24-thread box under load ~70, against
    // `gate:complexity` walling 8.29s there for its declared 1.8s — the same
    // calibration the census gate row states, giving about 2.4s on the box the
    // rest of these figures came from.
    // Re-measured 2026-09-05 on the 24-thread box: 23.4/24.4s (in-tier plus solo,
    // 530 tests across 20 files). The 15.4s predates the census suite joining this
    // row. Replaces 15.4s.
    // `capability-parity.test.ts` joins 2026-09-08: it shipped claimed by no
    // tier at all, which is the defect ladder.test.ts exists to catch, and a
    // gate's own self-test belongs beside its twenty siblings here rather than
    // at a later tier. Measured solo three times on the 24-thread box under
    // load 12: 0.06/0.06/0.08s wall, 65/65/78ms in-suite, 9 tests. The row
    // stays 24s — that addition is an order of magnitude inside the 23.4/24.4s
    // spread already measured for the other twenty, and declaring 24.1s would
    // claim a resolution these figures do not have.
    // `client-graph.test.ts`, `install-scripts-gate.test.ts` and
    // `tracing-gate.test.ts` join 2026-09-12: three gates that had shipped with
    // no red proof at all. Measured solo on the 24-thread box: 0.7/0.4/0.2s.
    // `release-manifest.test.ts` joins 2026-09-18: it shipped with 166d34521
    // claimed by no tier at all — the same defect `capability-parity` was, and
    // the reason `bun test scripts/ladder.test.ts` was red on main that day.
    // Measured solo on the 24-thread box: 0.09s wall, 34ms in-suite, 14 tests.
    // The row stays 24s for the reason stated above.
    // `comment-only.test.ts` and `bloat-budget.test.ts` join 2026-09-22: the red
    // and green proofs of the comment-edit checker and of the comment budget.
    // Measured solo: 0.45s for 9 tests, 0.13s for 3. The row stays 24s.
    // `publication-egress.test.ts` joins 2026-09-24 with its gate, which left core's
    // contract-publication-seal test. Measured solo: 0.11s for 8 tests. The row stays 24s.
    // `worker-bundle-reach.test.ts` joins 2026-09-25, beside the advisory gate's own
    // self-tests: it proves the condition REVIEWED_ADVISORIES accepts extract-zip on,
    // and shipped with e20573386 claimed by no tier. Measured solo: 0.8s for 3 tests.
    // The row stays 24s.
    seconds: 24,
    catches: 'a gate whose decision boundary someone simplified. These are the tests '
      + 'that fail when a fingerprint stops distinguishing a renamed copy from a '
      + 'genuinely different body — and, for scratch-ownership, the three shapes that '
      + 'leaked 10,124 temp entries in one evening proven red against the historical '
      + 'source, plus the three it must NOT fire on: prose quoting the defect, a `/tmp/` '
      + 'path belonging to the SANDBOX rather than this box, and a program whose scratch '
      + 'outlives the run on purpose. For literature-citations, every red direction it '
      + 'claims proven against the drifted text that was actually in this tree — a bare '
      + 'parity adjective, a deleted `up to`, an unnamed confusable unit, a locator '
      + 'naming the wrong table, a withdrawn number re-asserted — plus the six false '
      + 'positives that shaped its corpus decision, each of which demanded a paper '
      + 'locator for one of our own numbers, and the REACH bound proven in both '
      + 'directions: a recorded 206KB blob yields nothing, the same bytes undeclared '
      + 'still refuse the parity adjective inside them, a claim three paragraphs from '
      + 'its citation is still governed, and one past the bound is not. For silent-drop, all '
      + 'six defect classes red on the shape as it appears in this tree and GREEN on its '
      + 'repair, plus the three judgements that keep the count honest: a handler that FORWARDS '
      + 'its error is not a drop, an async function whose whole body is a non-rethrowing try '
      + 'cannot reject, and a one-statement sentinel handler is left to no-sentinel-catch. '
      + 'For infra, the three states a resource lookup can be in kept apart — a required '
      + 'resource absent, an OPTIONAL one absent, and a lookup that FAILED, the last of which '
      + 'fails the gate even on an optional resource because "we could not look" is not softened '
      + 'by the Worker tolerating the loss — plus provisioning issuing no argv at all on a second '
      + 'run, teardown refusing a phrase that names another deployment, and the two pins '
      + '(SUPPLY against the derived `Env` census, UNOBSERVABLE against the rows that came back '
      + 'blind) proven red in both directions. For release config, the two facts about the '
      + 'DEPLOYED wrangler config that cannot be established after an incident: every deployable '
      + "environment names the sandbox container image by digest — refused in both directions, "
      + 'including the `tag@digest` form that pulls correctly and leaves a mutable tag in the '
      + 'file — against the `@cloudflare/sandbox` version that actually ships, and every one of '
      + 'them uploads source maps with the Vite half that produces them, called rather than read '
      + 'as text. For the release MANIFEST, two readers of one `wrangler.jsonc` held '
      + 'equal — the manifest\'s binding set against what `deriveInfrastructure()` reads '
      + 'out of the same file — and a var left unclassified until somebody says whether a '
      + 'stranger\'s Worker gets our value, computes its own, or must never see it. '
      + 'For capability-parity, the ATTRIBUTION boundary its whole count rests '
      + 'on: a literal missing a REQUIRED member is a DIFFERENT TYPE, never an adapter '
      + 'omitting an optional capability — a foreign turn config sharing two '
      + 'optional-looking names, a fetch options bag sharing `cache` and `signal`, and an '
      + 'override bag dropping its base requirements are each refused as the contract they '
      + 'resemble, and every one of those refusals is proven BESIDE a real omission that '
      + 'stays red, so widening the attribution cannot quietly empty the asymmetry set. A '
      + 'spread leaves a contract unreadable rather than absent, which is a skip and not a '
      + 'parity claim.',
    blind: 'whether the gates are wired into any tier at all — that is ladder.test.ts. For infra, '
      + 'everything that needs an account: no test here proves a `wrangler r2 bucket create` '
      + 'creates a bucket.',
    inputs: AMBIENT_BY_NAME,
  },
  {
    run: 'bun test --timeout=0 scripts/skip-ratchet.test.ts scripts/typecheck-coverage.test.ts scripts/python-suites.test.ts',
    label: 'Skip ratchet and typecheck coverage self-tests',
    tier: 'push',
    seconds: 0.1,
    catches: 'the two new gates\' own decision boundaries — including the one that '
      + 'matters most here: a JUnit parse that matched only self-closing `<testcase/>` '
      + 'elements would report every SKIPPED test as absent, so the ratchet would '
      + 'reconcile an empty set and pass forever. Also proves the coverage gate follows '
      + '`bun run` script references transitively, without which it demands an exclusion '
      + 'for `tools/oxlint/anti-slop`, which IS covered — a gate lying in the safe '
      + 'direction still teaches people to silence it.',
    blind: 'whether the locked skips are the RIGHT skips. That is a judgement in the '
      + 'lock\'s reason strings, which is why each entry has to carry one.',
    inputs: AMBIENT_BY_NAME,
  },
  {
    run: 'bun test --timeout=0 scripts/ladder.test.ts scripts/ladder-closure.test.ts scripts/ladder-cache.test.ts scripts/deadline.test.ts scripts/gate-cost.test.ts',
    label: 'Gate ladder wiring and cache soundness',
    tier: 'push',
    // Measured 2026-09-16 on the 24-thread workstation (load 8.1): 1.25/1.20 s
    // for the three files together. Replaces 1 s for the single file.
    seconds: 1.3,
    catches: 'a gate that runs at only one tier by accident, a deploy gate CI silently '
      + 'skips, and a test file no tier claims. The defect this whole file addresses. Beside '
      + 'it, the two proofs the cache stands on: a closure that errs narrow (a computed import, '
      + 'an environment read whole, an undeclared path read or an untracked file each refuse '
      + 'rather than shrink), and a store that never hits across a touched closure file, a red '
      + 'result, a tool version change, a live row or a closure that moved mid-run. And the '
      + 'cost table\'s one wait: a row is measured beside this checkout\'s own suites never, '
      + 'beside another checkout\'s always, as load.',
    blind: 'whether any individual gate can actually fail. That is each gate\'s own '
      + 'self-test, and the seeded tier nobody has paid for yet. For the cache: a `reads` or '
      + '`env` declaration is a claim these suites cannot check against a live gate; '
      + '`--audit-closure` is the measurement for that.',
    inputs: AMBIENT_BY_NAME,
  },
  {
    run: 'bun test --timeout=0 scripts/deploy.test.ts',
    label: 'Production deploy contract',
    tier: 'push',
    // Measured 2026-09-05 on the 24-thread box: 86.8/86.5s (33 tests). The 1s
    // predates the archive unpack-and-install tests; the suite really installs.
    // Replaces 1s.
    seconds: 87,
    catches: 'a deploy gate deleted, reordered, or made skippable, and a deploy from a '
      + 'dirty checkout. Cut-the-wire proven: remove one gate line and it fails.',
    blind: 'whether the gates it enumerates pass.',
    inputs: AMBIENT_BY_NAME,
  },
  {
    run: 'bun test --timeout=0 scripts/secret-scan.test.ts scripts/sources.test.ts scripts/preflight.test.ts scripts/gallery-harness.test.ts',
    label: 'Gate self-tests: secrets, corpus, preflight',
    tier: 'push',
    // 1.0 s declared 2026-08-24; the gallery-harness case adds 0.13 s, measured 2026-09-05.
    // Re-measured 2026-09-05 on the 24-thread box: 19.3/18.1s (42 tests). The slow file
    // is secret-scan.test.ts at 16.0s — the history walk grows with the object store —
    // plus workspace-name-ux at 1.9s. Replaces 1.2s.
    seconds: 19,
    catches: 'a secret scanner that stopped matching, an exact historical adjudication that '
      + 'widened into a path or test exemption, or an enumeration that stopped treating '
      + 'tracked-ness as authoritative. The red fixture puts a credential only on a non-current '
      + 'local branch, proves it fails unadjudicated and passes only for its exact '
      + '(blob OID, path, detector, count) tuple; the live fixture remains gitignored and '
      + 'gone from disk, which is how a re-added transcript with live tokens rode a green scan '
      + 'on 2026-08-18. Also two environment facts statfs cannot see: the preflight reports a '
      + 'temp write refused under a per-user quota as a finding that names the errno, and the '
      + 'gallery harness removes a build left by a killed process at the next build while a '
      + 'live owner\'s build stays (61 leaked builds exhausted the tmpfs quota on 2026-09-05).',
    blind: 'credential shapes nobody wrote a case for, and a history object the scanner '
      + 'intentionally counts but cannot decode because it contains NUL or exceeds its size cap. '
      + 'The remaining headroom under a per-user quota: the probe writes 1 MiB, so only an '
      + 'exhausted quota is red.',
    inputs: AMBIENT_BY_NAME,
  },
  {
    run: 'bun test --timeout=0 scripts/gate-set-equality.test.ts',
    label: 'Set-equality gate self-tests',
    tier: 'push',
    // Measured 2026-09-05 on the 24-thread box: 1.2/1.0s. Replaces 0.4s.
    seconds: 1.1,
    catches: 'the set-equality gate not being able to fail, and — the half that is harder — '
      + 'it firing on shapes that are legitimate. 24 cases: RED on each of the five defect '
      + 'shapes actually shipped (a private pattern, a private `git ls-files`, a private walk, '
      + 'a glob scan, a lock published before its measurement), GREEN on their corrected form, '
      + 'and SILENT on the four a naive reading mistakes for violations — a URL route, a model '
      + 'id prefix, a `.replace()` specifier rewrite, and `matchAll` over prose. Without those '
      + 'four the gate reports 40 findings of which 38 are `context.report` in an oxlint rule; a '
      + 'gate whose output is mostly noise trains people to ignore it.',
    blind: 'whether the predicates in sources.ts describe the right sets. It proves nothing '
      + 'else re-spells them.',
    inputs: AMBIENT_BY_NAME,
  },
  {
    run: 'bun test --timeout=0 scripts/wired.test.ts',
    label: 'Wired gate self-tests',
    tier: 'push',
    // Measured 2026-09-05 on the 24-thread box: 5.1/4.5s (31 tests). Replaces 3.8s.
    seconds: 5,
    catches: 'the wired gate firing on the shape that would get it switched off, and — the '
      + 'half nobody writes — not firing at all. 24 cases over a fixture repository shaped '
      + 'like this one: a barrel over a barrel over the declaring file, one entrypoint, one '
      + 'suite. RED on an export with no production consumer, GREEN on the same export once '
      + 'ONE production line calls it through the same barrel, and SILENT on a symbol a '
      + 'production module genuinely imports through that barrel — the last is the false '
      + 'positive that matters, because every export in `packages/core` is published this '
      + 'way. It also pins the four resolver rules whose absence produced phantom findings: '
      + 'the `@/*` alias (33 specifiers in one page, 3 resolved, 95 phantom components), a '
      + 'default export resolved to the name its declaration carries, `Object.assign` as a '
      + 'field supply, and a local import that resolves to nothing being FATAL rather than a '
      + 'dropped edge. Over the live tree it asserts every one of the seven entrypoint kinds '
      + 'still has an instance, so a detector that stops matching is red rather than '
      + 'permissive.',
    blind: 'whether the census is COMPLETE. Every case proves the gate does not lie about '
      + 'what it reports; none of them can prove it reports everything, and the blind-spot '
      + 'list the gate prints on its green path is the honest answer to that.',
    inputs: AMBIENT_BY_NAME,
  },
  {
    // Measured 2026-08-22 on the 24-thread workstation: 33.15s with four
    // isolated Bun workers, versus 78.16s in one shared process.
    run: 'bun run test:core',
    label: 'Core suite',
    tier: 'push',
    // Measured 2026-09-15 on the 24-thread workstation, quiet: 43.1 s solo,
    // 5,645 tests. Split out of `bun run test` (44 s) so a change under
    // `packages/core` re-runs this and a change elsewhere does not.
    seconds: 43,
    catches: 'behavioural regressions in core — the whole shared spine both backends run on. '
      + 'No test COUNT is quoted as a contract: the old row carried 3,105 against a measured '
      + '3,917. Spelled ROOT-RELATIVE (`bun test packages/x/`) rather than `--cwd packages/x`: '
      + 'measured 2026-08-17, `--cwd` makes bun read a bunfig.toml from THAT directory, so the '
      + 'root one is not loaded and both `preload` and `pathIgnorePatterns` are silently dropped.',
    blind: 'both backend composition roots, and every subprocess path. It also covers only '
      + 'core — see ROOT_TEST_OMISSIONS in ladder.test.ts, which pins every other package by '
      + 'equality with the gate that runs it.',
    // Measured by `--audit-closure` 2026-09-15: the suite opens hundreds of
    // tracked sources by path (it scans the tree), so its closure is the corpus.
    // `mutation-exploration-policy.test.ts` imports mutant copies of core
    // sources, written outside the tree, by computed specifier.
    inputs: { ...AMBIENT_BY_NAME, corpus: true, imports: ['packages/core/src/'] },
  },
  {
    run: 'bun run test:spine',
    label: 'Agent-utils, agent-core and compaction suites',
    tier: 'push',
    // Measured 2026-09-15 on the 24-thread workstation, quiet: agent-core 0.1 s,
    // agent-utils 0.3 s, compaction 1.1 s solo. One row: three suites under
    // two seconds together, each with a closure a core change does not touch.
    seconds: 1.5,
    catches: 'behavioural regressions in agent-utils and compaction, and the vendored runtime\'s '
      + 'own drift suite.',
    blind: 'core, which `bun run test:core` covers, and both backend composition roots.',
    inputs: AMBIENT_BY_NAME,
  },
  {
    run: 'bun run gate:python-suites',
    label: 'Bench Python suites',
    tier: 'push',
    // 0.23s: 77 tests over three `unittest discover` processes, measured
    // 2026-08-30. Cheap because the suites need no dependency and no harness
    // install — which is also why nothing noticed they were never run.
    seconds: 0.3,
    catches: 'the 77 Python tests under `bench/tests/`, `bench/harbor/tests/` and '
      + '`bench/clbench/tests/` — the shared KINU_HOME guard both bench adapters load by '
      + 'path, the model-endpoint adapter, harbor corpus identity and the clbench event '
      + 'mapping. Every one of them ran in NO pipeline: the ladder\'s denominator is '
      + '`isRunnableSuite`, a JS/TS basename rule, so "every test file is claimed by some '
      + 'runner" was a sentence about TypeScript and three suites sat outside it. It also '
      + 'catches the silent zero that made a naive fix worse: `unittest discover -t . -s '
      + 'bench` reports `Ran 0 tests` and exits 0, because those directories carry no '
      + '`__init__.py` and discovery will not recurse into them — the invocation each '
      + 'suite\'s own docstring documented. So the gate proves each root non-empty AND '
      + 'compares the MODULES discovery loaded against the enumerated files, because a '
      + 'root that silently loaded two of its three still reports a healthy count.',
    blind: 'everything about the Python the bench harness runs in anger — the corpus '
      + 'builder, the trajectory writer and the agent adapter have no suites at all, so '
      + 'this gate governs four files out of eleven. It is also blind to type errors: '
      + 'there is no Python typechecker in this repository.',
    inputs: { kind: 'derived' },
  },
  {
    run: 'bun test --timeout=0 packages/devbox/',
    label: 'Devbox durability decisions',
    tier: 'push',
    // Measured 2026-09-05 on the 24-thread box: 75.2/73.2s (961 tests). The 0.3s
    // predates the durability suite; the pins retry against unreachable hosts with
    // real backoff, which is structural. Replaces 0.3s.
    seconds: 74,
    catches: 'a durability decision that silently does nothing. Thirteen defects in this '
      + 'package were only findable on a real deployed container, and nine of them looked '
      + 'like success from inside the code: an attach that reported landing while nothing '
      + 'was mounted, a checkpoint that answered `unchanged` seconds after a write, a '
      + 'self-re-arming schedule that deleted its own successor. Every one is pinned here.',
    blind: 'anything that needs a real container: the mounts themselves, the object store, '
      + 'and the platform lifecycle. Those are the bench app under `packages/devbox/bench` '
      + 'and an ephemeral deployed Worker, not this gate.',
    // Measured by `--audit-closure` 2026-09-15: the suite opens manifests, the
    // worker source and its bench sources by path, so its closure is the corpus.
    inputs: { ...AMBIENT_BY_NAME, corpus: true },
  },
  {
    run: 'bun test --timeout=0 packages/test-utils/',
    label: 'Test-utils suite',
    tier: 'push',
    // Measured 2026-09-05 on the 24-thread box: 6.9/6.8s (229 tests, mostly the
    // hard-task compute, retired with the old eval framework on 2026-09-24; the
    // gate-cost measurement re-sizes it). The 0.2s named only the slicing helpers.
    seconds: 7,
    catches: 'a broken source-slicing helper. Three wiring suites once asserted against '
      + 'whole files instead of the members they named because this was untested.',
    blind: 'the suites that use it.',
    // Measured by `--audit-closure` 2026-09-23: git runs in the tree and reads
    // every `.gitignore` in it, beside `wrangler.jsonc` and `.mailmap`.
    inputs: { ...AMBIENT_BY_NAME, corpus: true },
  },
  {
    // Measured 2026-08-22: 6.43s, four isolated workers. Re-measured 2026-09-05 on the
    // 24-thread box: 12.8/13.1s (3,031 tests across 220 files) — the suite doubled.
    // Replaces 7s.
    run: 'bun test --timeout=0 --parallel=4 packages/cf-backend/',
    label: 'Cloudflare backend and conformance suite',
    tier: 'push',
    seconds: 13,
    catches: 'the Cloudflare composition root observed against the capability manifest '
      + '— the conformance gate.',
    blind: 'anything needing a Workers runtime rather than a composition root — every '
      + 'test here mocks the Agent SDK (`tests/helpers/agents-sdk.ts`) and runs under '
      + 'bun, which is why `bun run test:workerd` exists below.',
    // `unit-codemode-sandbox.test.ts` imports the node shim it wrote to scratch
    // from `KINU_NODE_MODULE_SOURCE`, whose bytes are this file's. Measured by
    // `--audit-closure` 2026-09-23: the suite opens 247 tracked files off its
    // graph, across docs/, public/ and src/components/, so it reads the tree.
    inputs: { ...AMBIENT_BY_NAME, corpus: true, imports: ['packages/core/src/execution/codemode-node-shim.ts'] },
  },

  {
    run: 'bun run gate:scanner-bundle',
    label: 'Install scanner bundle',
    tier: 'push',
    seconds: 0.3,
    catches: 'the install scanner Bun loads drifting from its source. Bun loads the scanner '
      + 'BEFORE it installs anything, so the file bunfig names cannot import a dependency — '
      + 'the source\'s one `valibot` import kept every GitHub workflow red at "Install '
      + 'dependencies" (measured 2026-09-02 on a depth-1 clone: SecurityScannerNotInDependencies '
      + 'after four tarballs). bunfig therefore names a committed `bun build` of the source, '
      + 'and this gate rebuilds it in memory and refuses a byte of difference, a bare import, '
      + 'or a bunfig that names anything else. At push rather than commit because the commit '
      + 'tier is the pre-commit hook and a stale bundle is fully recoverable at push; it '
      + 'still cannot reach main.',
    blind: 'whether the bundled decoder BEHAVES as the source over a real feed answer — that '
      + 'is gate:dependency-advisories below, over a real `bun pm scan`, at the ci tier.',
    // Measured by `--audit-closure` 2026-09-15: the gate rebuilds the scanner
    // source and reads the committed bundle, neither an import edge.
    inputs: { kind: 'derived', reads: ['scripts/security-scanner.ts', 'scripts/security-scanner.bundle.js'] },
  },
  {
    run: 'bun run gate:dependency-advisories',
    label: 'Dependency advisory policy',
    tier: 'ci',
    seconds: 0.3,
    catches: 'a dependency arriving with a known vulnerability nobody reviewed. `bun pm scan` '
      + 'was named as the tool for this in the note above and was invoked NOWHERE — and could '
      + 'not have helped if it had been, because bun ships no scanner and answers `error: no '
      + 'security scanner configured`. `bunfig.toml` now points at the built `scripts/security-scanner.bundle.js`, '
      + 'so every `bun install` checks all 1288 lockfile entries against npm\'s advisory feed '
      + 'before unpacking a tarball, and this gate asserts the exposures are EXACTLY the 54 ids '
      + 'over 19 packages reviewed in REVIEWED_ADVISORIES — failing both when a new one appears '
      + 'and when a recorded one stops reproducing, so a fixed advisory cannot keep its '
      + 'acceptance and pre-approve the next one. It is at `ci` and not at commit or push '
      + 'because it needs the network: a pre-push hook that did would fail every offline push, '
      + 'and `--no-verify` is not an option here.',
    blind: 'whether an accepted advisory is exploitable in this repository — it cannot judge '
      + 'that and does not pretend to, it only forces the set to be a decision. Also blind to a '
      + 'malicious package with no advisory filed, to anything the npm feed does not carry, and '
      + 'to what an install script DOES once bun runs it, which is `gate:install-scripts` above. '
      + 'An unreachable feed is reported as `unknown` via `blocked()`, never as a clean tree.',
    inputs: { kind: 'live', why: 'runs `bun pm scan`, which asks an advisory feed over the network; a new advisory changes the verdict with no file changed.' },
  },
  {
    // Measured 2026-08-22: 18.42s, four isolated workers.
    run: 'bun test --timeout=0 --parallel=4 packages/cli-backend/',
    label: 'CLI backend and conformance suite',
    tier: 'ci',
    seconds: 19,
    catches: 'the local composition root and its conformance gate, plus the real host '
      + 'filesystem and checkpoint paths.',
    blind: 'the CLI surface above it.',
    // Measured by `--audit-closure` 2026-09-23: 14 tracked files off its graph
    // in five packages and the repository root (git's ignore files, AGENTS.md,
    // spawned workers, sibling manifests), so it reads the tree.
    inputs: { ...AMBIENT_BY_NAME, corpus: true },
  },
  {
    // Measured 2026-08-23: 40.0s. `behavior.test.ts` alone took 23.36s and
    // the other 43 files took 16.64s at parallel=4. Putting the slow file in
    // that wave exceeded 180s through contention.
    run: 'bun run test:cli',
    label: 'Full production CLI suite',
    tier: 'ci',
    seconds: 41,
    catches: 'the production CLI end to end, including the PTY and subprocess paths. Every '
      + 'file it claims runs in no other tier. The runner derives all files in the directory, '
      + 'isolates the measured contention-sensitive file, then runs the remainder at parallel=4. '
      + 'scripts/test-scratch-home.ts strips ambient credentials, so the result does not depend '
      + 'on whose shell ran it.',
    blind: 'the deployed CLI archive and a real person\'s terminal outside the synthetic PTY. '
      + 'The download smoke and asset-integrity gates own the archive; neither proves terminal '
      + 'rendering on a user\'s emulator.',
    inputs: AMBIENT_BY_NAME,
  },
  {
    run: 'bun test --timeout=0 packages/pc-agent/',
    label: 'Local-device daemon suite',
    tier: 'ci',
    seconds: 0.3,
    catches: 'the local-device daemon. No count quoted, for the reason `bun run test` '
      + 'states: this entry said 6 against a measured 11. `bun run check` only '
      + '`node --check`s this package\'s syntax, so the suite is the only thing that '
      + 'reads it.',
    blind: 'the pairing and transport it talks to.',
    // Measured by `--audit-closure` 2026-09-23: git in the root reads these two.
    inputs: { ...AMBIENT_BY_NAME, reads: ['.gitattributes', '.gitignore'] },
  },
  {
    run: 'bun scripts/tracing-gate.ts',
    label: 'Tracing wired end to end',
    tier: 'ci',
    seconds: 0.3,
    catches: 'traces declared in code but switched off in a deployable environment. '
      + 'wrangler does NOT inherit `observability` into a named environment and `traces` '
      + 'is a separate switch from `logs`, so `env.staging` carried a bare '
      + '`enabled: true` and every span it opened reported isTraced false and was never '
      + 'recorded — with the worker still answering 200. It also proves the tracer is '
      + 'live by observing real spans under workerd with and without a tail sink, so a '
      + 'green here cannot come from an empty result. Ran in no tier at all until now: '
      + 'the script and its fixture existed and nothing invoked either.',
    blind: 'whether the platform RETAINED what it ingested. It observes the producing '
      + 'side only — the sink can still throw while the traced worker returns 200.',
    inputs: { kind: 'derived' },
  },
  {
    run: 'bun test --timeout=0 ./tests/',
    label: 'Live and first-run suites, credential-free',
    tier: 'ci',
    seconds: 1.3,
    catches: 'the live end-to-end suites parsing, constructing their workspaces and reaching '
      + 'their skip decision, plus the first-run tier\'s credential-free half: its wiring, its '
      + 'defect register and the observations its rows are judged by. Kept beside `test:live` '
      + 'deliberately: this is the run that needs no secret, so it is the one that '
      + 'reproduces anywhere, and `gate:skip-ratchet` is what turns its skips from an '
      + 'invisible exit 0 into a locked, reasoned list. The skip COUNT is not quoted '
      + 'here on purpose — `scripts/skip-ratchet.lock.json` governs it, and a second '
      + 'copy in prose is a number that rots while the lock stays right, which is how '
      + 'this entry came to advertise 27 tests and 23 skips against a measured 28 and '
      + '25. Note the path form: `bun test tests` silently matches NOTHING, and '
      + '`bun test tests/` also matches nothing — only `./tests/` selects them, which '
      + 'is exactly the kind of silent zero this ladder asserts against.',
    blind: 'everything it skips, which is most of it — declared, not hidden. It also '
      + 'cannot see a suite whose code no longer compiles, because bun strips types; '
      + 'that is `gate:typecheck-coverage` plus `tsc -p tests`, and the absence of both '
      + 'is how these four suites came to call two deleted APIs.',
    inputs: AMBIENT_BY_NAME,
  },
  {
    run: 'bun run test:live',
    label: 'Live tier',
    tier: 'evals',
    // The CREDENTIALED cost, because that is the cost this gate actually incurs
    // where it runs. `scripts/live-tier.sh` authenticates as `eval-service`
    // against the deployment from KINU_EVAL_TOKEN, so a run that holds that
    // credential pays this. It is the old eval tier's bun arm, the part that
    // remains: 2,745s / 48 calls and 3,843s / 49 calls in the two runs whose
    // spend files survive, and 3,228s from a third whose artifact does not, kept
    // as a CEILING rather than cited as a measurement anybody can open.
    seconds: 3228,
    catches: 'the live end-to-end evidence nothing else in this ladder produces on the '
      + 'in-process runtime: multi-turn tool calling and memory across a reopen (E2E '
      + 'Lifecycle), MCTS evolution and cross-session transfer (Evolution Proof, Deep '
      + 'Evolution), whether the agent reaches for a search and leaves a DURABLY ranked winner '
      + '(Exploration), and the hosted smoke. Each score reports its denominator, and each '
      + 'assertion checks that denominator is non-zero BEFORE anything else, because "0 of 0 '
      + 'searches were unranked" is the shape of a check that cannot fail. It also catches '
      + 'ITSELF running empty: with a target resolved, a run that reports no model call, or '
      + 'calls whose cost it cannot account for, exits non-zero rather than printing `TOTAL: 0 '
      + 'model call(s)` and passing. Credential-free every live test skips, which is the path '
      + 'that reproduces anywhere.',
    blind: 'the cf runtime, for everything except the Live Smoke hosted arm. The rest '
      + 'drive core and the CLI\'s local session in-process, so a defect that only '
      + 'appears in workerd — a rejected cross-DO RPC inside background work that only '
      + 'console.warns — is invisible to them by construction. That is the workerd '
      + 'layer\'s job. It is also blind to whether an assertion is STRONG: '
      + '`E2E Full Lifecycle` steps 4 and 5 assert only that the reply is non-empty, so '
      + 'they pass on any prose the model returns. And it cannot tell contention from a '
      + 'deployment fault: two live tiers on one account produce the same '
      + '`detached_work_failed / Request Timeout` signature as an outage.',
    inputs: { kind: 'live', why: 'spends live model turns as the eval identity; its evidence is behavioural and dated, never a function of the tree alone.' },
  },
  {
    run: 'bun run evals',
    label: 'Eval suite',
    tier: 'evals',
    // FIRST SIZING from the 2026-09-24 pilot on kinu.run: a trial took 12 to 26
    // minutes on the product model, three at once, so ten trials of one task are
    // four waves of about 26 minutes and the four tasks run one after another:
    // 4 x 4 x 26 min is about 25,000s. Re-sized from the first baseline's
    // per-task wall time, which `evals/scripts/validate.ts` prints.
    seconds: 25_000,
    catches: 'a regression in what the DEPLOYED product does for a user, task by task. Each '
      + 'file in evals/tasks is one multi-turn task on a fresh eval-service workspace, and every '
      + 'turn is checked black-box: the checker calls the slate the agent built over the slate '
      + 'RPC and compares every answer with its own reference implementation of the contract, so '
      + 'any correct build passes. Ten trials per task, compared with the latest complete report '
      + 'of an earlier deployed build by a two-sided Fisher exact test (evals/src/comparison.ts), '
      + 'with infrastructure failures and 429 waits reported apart from the agent\'s results.',
    blind: 'anything the tasks do not exercise, and a change smaller than ten trials can tell '
      + 'apart from noise. Its subject is the build kinu.run serves, not this checkout: '
      + '`bun run deploy:preflight` is what says whether the two are the same.',
    inputs: { kind: 'live', why: 'drives the DEPLOYED product as the eval identity and spends live model turns.' },
  },
  {
    run: 'bun test --timeout=0 ./evals/ scripts/deploy-preflight.test.ts',
    label: 'Eval framework logic',
    tier: 'ci',
    seconds: 1,
    catches: 'the eval framework\'s own logic, credential-free: the Fisher exact test and the '
      + 'verdict it feeds, a comparison refused across changed definitions, task versions, trial '
      + 'counts or infrastructure failures, a baseline refused when a trial is missing or a build '
      + 'changed under it, a check that throws failing alone, a slate call the deployment could '
      + 'not carry failing the trial as infrastructure rather than a check, and the session '
      + 'client\'s frame and socket handling. Plus the preflight that refuses to measure a '
      + 'deployment serving another revision.',
    blind: 'anything a model does, and whether a task\'s checker is right about its task. That '
      + 'is proved per task, before a baseline, against hand-written reference slates on the '
      + 'deployment: a correct build passes every check and each planted defect fails its own.',
    inputs: AMBIENT_BY_NAME,
  },
  {
    // The COMMAND deploy.sh runs, spelled identically. Stopping at the
    // `scripts/bench*` glob while deploy.sh also passes the core bench units leaves
    // the wider command matching no LADDER entry, `gatesFor('deploy')` synthesizes
    // it at a declared cost of ZERO, and the four core bench suites end up governed
    // by an entry that does not name them. The durability probe is explicit rather
    // than absorbed by that glob because its name is a contract: a real container
    // measurement that remains only in stdout is not evidence.
    //
    // The four rig self-tests after it are explicit for the same reason, and they
    // are on THIS row because each one guards a `scripts/bench-*.ts` rig or the
    // fixtures it runs on — the shared devbox fixture, bench-payload-transports,
    // and the r2-bench deploy substrate. Not one of their names starts with
    // `bench`, so all of them shipped tracked, passing by hand, and claimed by NO
    // tier: 89 tests that ran in no pipeline.
    run: 'bun test --timeout=0 scripts/bench*.test.ts scripts/sandbox-durability-probe.test.ts scripts/storage-matrix-cleanup.test.ts scripts/deploy-substrate.test.ts scripts/payload-transport.test.ts scripts/devbox-e2e.test.ts',
    label: 'Benchmark harness guarantees',
    tier: 'ci',
    // 7.00s: 221 tests over 15 files, median of 7.00 / 7.71 / 6.86 on the
    // 24-thread box at load 7-10, measured 2026-09-25 after the storage
    // strategy-comparison suites left. That is the corpus-absent basis every
    // fresh clone sees; a checkout with terminal-bench-2.1 on disk also pays the
    // sampler over the real corpus in bench-external.test.ts.
    seconds: 7.0,
    catches: 'the bench harness guarantees — sandbox isolation, the seal, '
      + 'anti-self-scoring, budget enforcement, corpus well-formedness, and the '
      + 'durability probe retaining complete or failed JSON evidence without '
      + 'overwriting a prior run — plus the census `gate:bench-corpus` runs at '
      + 'commit tier proven able to FAIL, which the committed assertion over a '
      + 'healthy corpus cannot do by itself: a patch whose anchor moved, and a '
      + 'patch file no tasks.jsonl line names, each driven from a fixture. And now '
      + 'the experiment rigs\' own teardown and judgment logic: a '
      + 'payload arm judged on an image or an operation it never started, and a '
      + 'Wrangler failure read as proof that an ephemeral worker is gone. No '
      + 'model, no credentials.',
    blind: 'anything about what the bench measures, and any live run: the rig '
      + 'suites drive planners, decisions, manifests and fixtures, never a real '
      + 'deploy or container. It only guards the instrument, which is what four '
      + 'independent instrument bugs cost us to learn.',
    inputs: AMBIENT_BY_NAME,
  },
  {
    run: 'bun test --timeout=0 scripts/chat-and-files-ux.test.ts',
    label: 'UI gate self-tests: chat and files',
    tier: 'ci',
    // Measured 2026-09-18 alone on the 24-thread workstation under the wave's
    // own wrapper (`bun scripts/gate-cost-measure.ts`), load 0.8 at start:
    // 155.6s wall, 34.4s CPU, 2356 MiB peak for 89 tests over one vite boot.
    // Declared with headroom for the load the wave runs it under; the two
    // figures the wave admits against are scripts/gate-cost.json's, not this.
    seconds: 175,
    catches: 'the workspace page as a browser lays it out — the four defects this suite '
      + 'was built for, each invisible to `tsc`, `oxlint` and every source-reading test '
      + 'here: the streaming caret sitting on a line of its OWN below the paragraph '
      + 'instead of riding the last line, a turn that finished its prose and went quiet '
      + 'between steps drawing no live affordance at all, "go to the parent directory" '
      + 'landing on the filesystem root because every environment reported its working '
      + 'directory as the literal `.` and the pane did string arithmetic on it, and the '
      + 'capability row rendering raw snake_case ids with no reading and no absences. '
      + 'Around them the whole WorkspacePage boundary: chat send admission, terminal '
      + 'workspace denial, the file-preview and history/roster request generations, the '
      + 'one composite file plane, the supervise view live, a revoked device whose '
      + 'command may still run, machine linking on the surface that asked for it, '
      + 'composer and message continuity, the tool preview redacting through the one '
      + 'canonical policy, WorkTab drawing a section only when it has something to '
      + 'show, the owner\'s model tiers with each model\'s own levels, the workbench '
      + 'type scale, the shell rails collapsing and reopening across a reload, and a '
      + 'hosted actor\'s cards staying out of the workspace\'s own chat. And the '
      + 'INSPECTOR COLUMN end to end: the account\'s width, the workspace\'s open or '
      + 'closed choice, a gesture outranking the arriving signal, and an anonymous '
      + 'session\'s column opening on the one signal that it has something to show — '
      + '`stored === null` read as "nothing keys this layout, so nothing is decided" '
      + 'kept that column shut for the page\'s life, and a browser is the only place '
      + 'that shows. And the Environment tab\'s LINE TERMINAL, which no gate read: a '
      + 'command output arrived as bare LF and every row of an `ls -la` started where '
      + 'the row above it ended, while a pasted two-line command ran its first line and '
      + 'dropped the second with no echo and no error. Both are measured by driving the '
      + 'real pane and reading the rows a browser drew.',
    blind: 'the gallery render itself, and every frame this suite does not open. It '
      + 'drives the workspace page and the home creation form through gallery fixtures '
      + 'over a locally built bundle — never a deployed session, a real OAuth flow or a '
      + 'live model — and nothing compares pixels. The diagnostics drive costs nothing '
      + 'measurable: 55.8s before and 55.6s after for this suite, 2026-09-01.',
    inputs: CLIENT_BUILD,
  },
  {
    run: 'bun test --timeout=0 --path-ignore-patterns=scripts/chat-and-files-ux.test.ts scripts/*-ux.test.ts scripts/computed-style.test.ts',
    label: 'UI gate self-tests',
    tier: 'ci',
    // Measured 2026-09-18 alone on the 24-thread workstation under the wave's
    // own wrapper, load 1.9 at start: 270.9s wall, 62.4s CPU, 2534 MiB peak
    // over the sixteen files this row runs — fifteen `*-ux` suites and
    // `computed-style`.
    //
    // The row is the `*-ux` FAMILY since 2026-09-15 rather than a list: a
    // fifteenth suite joined on 2026-09-14 by a hand edit in three files, and
    // a suite outside every family is what the orphan test below catches. The
    // client-failure trio (45 s, measured 13.84 s on 2026-09-06) and
    // `workspace-name-ux` fold in; their declared seconds are added here.
    //
    // Since 2026-09-18 it carves ONE suite back out of that family —
    // `chat-and-files-ux`, the row above — with bun's own
    // `--path-ignore-patterns`, so the family still claims every new `*-ux`
    // suite and a file is in exactly one of the two rows. The two together
    // are ~500s serial against the 480s shared deadline, which is a row that
    // reports a hang wherever the defect is: this row died at 124 in the
    // 2026-09-16 wave and again at 480.42s measured alone on 2026-09-18,
    // while its declared 420 was never a measurement of the set it had grown
    // into. Earlier figures for the unsplit row: 347.00s on 2026-09-14
    // (293.62s with app-background alone, 324.74s with account-ux alone,
    // 265.76s before either joined).
    seconds: 300,
    catches: 'the six UI gates\' own decision logic, including the one that would have '
      + 'caught `--radius` being undefined at `:root` while 191 `rounded-*` sites '
      + 'computed 0px. The original two self-tests ran in NO tier until this line: the gates were '
      + 'built, deliberately kept off the deploy path for their Chrome cost, and their '
      + 'logic was then guarded by nothing anywhere. Now also the THEME axis, which had '
      + 'no coverage at all: `gallery.html:7-22` resolves the initial `data-mode` and '
      + '`data-palette` from `prefers-color-scheme` and localStorage, and until 2026-09-24 '
      + 'the harness pinned neither, so every token assertion here was made against whichever '
      + 'scheme the desktop settings portal happened to answer — dark on this machine, and '
      + 'silently the other on a build or CI image that answered differently. The four '
      + 'cascade scenarios now pin the default theme AND assert they got it, since a pin '
      + 'nobody reads back is not a pin, and three further passes drive the real "Switch '
      + 'to light mode" and "Switch to the silk palette" controls to audit the other '
      + 'three themes: umber light (`index.css:300-388`), silk dark and silk light '
      + '(`index.css:389-589`). Each is a structurally distinct palette rather than a '
      + 'filter over another, umber light carries its own record of "three passes of '
      + 'complaint, all the same one", and in any of them an unmapped role token renders '
      + 'as Kumo\'s uncustomised brand colour instead of throwing. And the plan '
      + 'document AS A BROWSER LAYS IT OUT, which was authored and then run by '
      + 'nothing: `scripts/plan-review-ux.test.ts` was untracked and claimed by no row '
      + 'while this same table was edited for three other new suites, so the headline '
      + 'UI change of its slice shipped with its acceptance evidence never executed. It '
      + 'measures the two refusals the header owes the document — a later h1 stays '
      + 'where the agent wrote it, and an ANNOTATED h1 keeps its block, because the '
      + 'highlighter resolves an anchor inside the viewer\'s own article and a promoted '
      + 'block leaves the rail an entry that can never draw — plus the '
      + 'narrow-container scrim actually CLOSING the rail rather than dimming a '
      + 'document with no way back, and the action strip collapsing on a settled plan '
      + 'instead of spending a margin on buttons nobody can press. The models '
      + 'section\'s accessible names and the '
      + 'Phase 1 sharing surfaces are read the same way: every tier row and '
      + 'role field stays reachable by the name assistive technology announces, '
      + 'and the shared library, the blueprint page, the share dialog and the '
      + 'unmapped-bindings panel render at both widths in both themes with the '
      + 'warning and fork copy they owe and no rate or spend anywhere. The '
      + 'living background is measured on the shipped shell itself: it sits '
      + 'behind the rail and the page with pointer-events none and a negative '
      + 'z-index, stops its clock when the document is hidden, draws one still '
      + 'under reduced motion and on a phone width, never mounts under a '
      + 'workspace route, and follows the overview read model through idle, '
      + 'working and attention. The account surfaces '
      + 'join here: the setup modal over the home chrome, the settings providers '
      + 'section, the onboarding wizard at each of its four steps with only the '
      + 'active panel reachable, the account section whose delete button wakes '
      + 'only on the typed email, and the primary nav with the workspaces (list '
      + 'and tiled, searched), plugins and four-list shared pages behind it — all '
      + 'read through the shared account fixture at both widths in both themes.',
    blind: 'the gallery render itself. `gate:computed-style` boots vite and Chrome over '
      + '21 frames × 4 themes and stays a standalone run — a gate that fails because '
      + 'Chrome is missing fails for a reason unrelated to the change under test. Also '
      + 'MOST OF THE GALLERY: only `shell`, `streaming` and `environment` carry any '
      + 'assertion across the two UI rows, and the last two are the chat-and-files '
      + 'row\'s, while gallery.tsx dispatches ~29 frames — so the rest are proven '
      + 'to mount and nothing more. The three non-default themes are audited on `shell` '
      + 'alone. The control-plane and feedback frames use authenticated gallery fixtures, not '
      + 'a deployed OAuth flow. Browser capture fidelity outside those fixed frames remains '
      + 'unmeasured rather than green. For the plan document: one gallery plan and '
      + 'three variants of it, so the annotation ENGINE — selection, offsets, save, '
      + 'export — is exercised only as far as one stored anchor painting.'
      + ' Folded in from the former client-failure row: what the browser does when a '
      + 'client-side failure has nowhere to go — the error boundary reports to the server, a '
      + 'stalled report never leaves the page waiting, retry and navigation stay reachable, a '
      + 'rejected lazy chunk offers the one-shot reload, and a reconnect refreshes Files and '
      + 'memory after read faults. Those run over a local browser and a locally built bundle: '
      + 'a stale edge asset, a real network stall and whether a report reaches a deployed '
      + 'sink are outside it, and nothing compares pixels.',
    inputs: CLIENT_BUILD,
  },
  {
    run: 'bun test --timeout=0 scripts/public-pages.test.ts scripts/plan-demo-film.test.ts',
    label: 'Public pages render',
    tier: 'ci',
    // Measured 2026-08-24 after the bug-fix drive and six-width clipping sweep: 51.28s.
    seconds: 55,
    catches: 'the signed-out pages as a browser renders them: the hero tree grows and '
      + 'settles on the landing page, the sign-in and install pages carry the shell, '
      + 'and the landing landmarks and deploy link name the product Kinu. '
      + 'The gallery async_hooks stub regression lived exactly here: every frame '
      + 'rendered an empty document while the source-reading gates stayed green. '
      + 'Also the bug-fix demo timeline beat by beat, and the clipping class '
      + 'documentElement.scrollWidth cannot see: the landing root is overflow-x-clip, '
      + 'so a child wider than the viewport is cut with no scrollable overflow — the '
      + '390px hero shipped that way, its install row forcing a 519px track into a '
      + '350px shell.',
    blind: 'It renders the WORKER-built pages in a local browser, never the deployed '
      + 'edge — a stale cached object at Cloudflare (measured on staging 2026-08-21) '
      + 'passes here and serves anyway. No pixel is compared, so a legible-but-ugly '
      + 'regression passes, and copy quality is unread beyond those landmark labels. '
      + 'The old product name is not grepped here at all: that gate is '
      + 'packages/cf-backend/tests/unit-public-shell.test.ts, over the worker-built '
      + 'documents rather than the rendered page.',
    inputs: CLIENT_BUILD,
  },
  {
    run: 'bun test --timeout=0 scripts/react-runtime-identity.test.ts',
    label: 'React runtime identity',
    tier: 'ci',
    // Runs the real client build twice, then drives three routes in Chromium.
    // Measured 2026-08-27: 8.92s.
    seconds: 20,
    catches: 'which React the shipped bundle contains and which dispatcher the page '
      + 'runs on. It builds with the production Vite config the deploy uses, then '
      + 'asserts one React runtime module in one chunk, zero development-only text '
      + 'surviving, and, in Chromium, exactly one renderer with production bundleType '
      + 'and one dispatcher slot shared by react and react-dom. A second React copy '
      + 'or a development build reaching production is invisible to tsc, to oxlint '
      + 'and to every source-reading instrument here.',
    blind: 'the locally built artifact, not the object the edge serves. It cannot see a '
      + 'CDN serving an older bundle, and it says nothing about render correctness.',
    inputs: CLIENT_BUILD,
  },
  {
    run: 'bun test --timeout=0 scripts/nested-container-resolution.test.ts',
    label: 'Nested container resolution',
    tier: 'ci',
    // Walks the deployed module graph with the bundler as a pure resolver.
    // Measured 2026-08-27: 8.80s.
    seconds: 20,
    catches: 'which copy of a duplicated dependency the deployed artifact actually '
      + 'binds. Two Containers runtimes are installed and only the NESTED one reaches '
      + 'the artifact, so a manifest pin, a document and a gate can all name a version '
      + 'that never runs. It also resolves every relative specifier the reachable '
      + 'dependency modules import, which is what an extensionless ESM claim needs '
      + 'before it is a claim.',
    blind: 'module resolution, not runtime. A container cold start is a different '
      + 'premise and needs an image build. It reads the installed tree, so it cannot '
      + 'see what a fresh install on another lockfile resolution would produce.',
    inputs: AMBIENT_BY_NAME,
  },
  {
    run: 'bun test --timeout=0 scripts/swarm-tree-geometry.test.ts',
    label: 'Swarm-tree geometry',
    tier: 'ci',
    seconds: 29,
    catches: 'where the swarm trees LAND, at 640px and 1280px in both palettes — the '
      + 'class of defect no source-reading instrument in this repository can see. Six '
      + 'wires, each proven red by reverting it: a node label clipped at a flat 20 '
      + 'characters beside an empty column, the key floated over the branches it '
      + 'explains, a card of two short searches reserving a whole column of nothing, an '
      + 'unselected search receding to half opacity (illegible at 11px, and the '
      + 'comparison one canvas exists for), the run-count label taking two line boxes, '
      + 'and — the one that matters most — a FRAME THAT RENDERED NOTHING. `forkbig`, '
      + '`forkfull` and `forkswarmfull` all mounted the explorer page against a socket '
      + 'no worker answers and drew an empty body, while `gate:computed-style` lists '
      + '`forkfull` among its frames and reported clean over the empty document: a gate '
      + 'green because there was nothing left to find. The first assertion here is that '
      + 'the scene exists and that the 520-node probe still has 520 nodes.',
    blind: 'everything the picture MEANS. It measures boxes, not whether the ramp '
      + 'encodes the score it claims, whether the winning spine is the line the search '
      + 'paid for, or whether a fan-in vertex is the node that fanned a level in. It '
      + 'reads three frames of the ~29 gallery.tsx dispatches, so every other fork state '
      + '— the refused run, the named preset, the fan-in composition — is proven to mount '
      + 'by `gate:computed-style` and measured by nothing. Chrome cost keeps it out of '
      + 'the commit tier, so a geometry regression reaches a branch before it is caught.',
    inputs: CLIENT_BUILD,
  },
  {
    run: 'bun test --timeout=0 scripts/chat-scroll.test.ts',
    label: 'Chat infinite scroll',
    tier: 'ci',
    seconds: 34,
    catches: 'whether older history arriving above the viewport moves the message the '
      + 'reader is looking at — measured, in a real cascade, at 0px over four prepends '
      + 'of 1190px each. `gallery.tsx`\'s `chathistory` frame was built expressly to be '
      + 'measured, with `?latency= ?fail= ?depth=` and a `gallery:arrive` event so a '
      + 'live turn can be made to land while an older page is still in flight; it was '
      + 'then reachable from nothing outside gallery.tsx, which is this repository\'s '
      + 'own built-but-unwired shape applied to a test harness. Proven red by removing '
      + '`scrollTop += grew` from use-growing-scroll.ts: the first page then moved the '
      + 'anchor 5948px, and the walk consumed the whole history in one cascade because '
      + 'the prefetch re-arms on a view left pinned at the top edge. Also that the '
      + 'browser\'s own scroll anchoring is off, that each page is one request rather '
      + 'than a burst, that a FAILED page never renders "beginning of the '
      + 'conversation", and that the walk and the socket do not draw one message twice.',
    blind: 'everything about the SERVER half. The frame stubs `fetchPage`, so no rowid '
      + 'seek, no `limit + 1` over-read and no stale cursor is exercised here — those '
      + 'are unit-tested against the read model instead. Two hooks and one merge rule '
      + 'of the ~29 gallery frames; the subordinate column and the node transcript walk '
      + 'the same contract and are measured by neither this nor any other browser. '
      + 'Chrome cost keeps it out of the commit tier.',
    inputs: CLIENT_BUILD,
  },
  {
    run: 'bun run layergate',
    label: 'Layergate conformance',
    tier: 'ci',
    seconds: 25,
    catches: 'per-layer behavioural drift against a locked baseline, 17 measured layers.',
    blind: '`tool-construction`, declared and measured at 0/0 — and all three tool-surface '
      + 'defects live exactly there.',
    inputs: { kind: 'derived', reads: [] },
  },
  {
    run: 'bun run layergate --matrix',
    label: 'Layergate fault-localization matrix',
    tier: 'ci',
    seconds: 30,
    catches: 'a layer whose probes cannot localise a fault to it — cross-talk. Without '
      + 'this a layer at 100% may be scoring another layer\'s behaviour.',
    blind: 'a layer with no probes, which scores null and localises nothing.',
    inputs: { kind: 'derived', reads: [] },
  },
  {
    run: 'bun run gate:capability-parity',
    label: 'Cross-backend capability parity',
    tier: 'commit',
    // Measured 2026-09-05 on the 24-thread box: 1.5/1.6/1.6/1.7/1.8s. Replaces 1.2s.
    seconds: 1.7,
    catches: 'the two shapes of backend divergence. A core contract whose optional '
      + 'capability is wired on one backend only (30 locked on 2026-09-05, '
      + 'ShellApprovalPolicy.requestApproval absent on cf among them), and a module that '
      + 'would compile in a shared package sitting inside one adapter, so the other backend '
      + 'has no contract to under-wire and simply does without (99 locked on 2026-09-05; '
      + 'the lock is `scripts/capability-parity.lock.json`, and its count is the current '
      + 'figure). Its allowlist of importable libraries is DERIVED from what the '
      + 'shared packages already import, so it widens when core takes a dependency and '
      + 'never needs editing.',
    blind: 'a platform GLOBAL reached with no import — measured at zero occurrences over '
      + 'the reported modules, and caught in one second by `tsc -p packages/core` the '
      + 'moment anyone acts on the finding.',
    inputs: { kind: 'derived' },
  },
  {
    run: 'bun run test:workerd:cf',
    label: 'Durable Object semantics under workerd',
    tier: 'ci',
    // Measured 2026-09-16 on the 24-thread workstation beside `bun test
    // --timeout=0 --parallel=4 packages/cf-backend/` run back to back (load
    // 1.5 to 4.4): the whole cf-backend workerd tier, 36 files serial by design
    // (`fileParallelism: false`, wall-time gates), took 485 s — 130 s of it
    // module import, 228 s tests — and the deploy wave saw it past the 480 s
    // gate deadline. The deadline is the one hang detector and stays; the tier
    // is split by directory instead: the seven suites whose tests take half
    // the tier's test time (background-wake 81 s, preview-port excepted for
    // balance, chat-session-parity, do-retention, do-spend-aggregate,
    // files-eio, step-cap, stream-lifecycle) live under `tests/workerd/long/`
    // and run as the row below; this row is the other 29 files. Measured as
    // split, the same day under the same load: 335 s (29 files, 120 tests,
    // load 0.9 to 2.2). On 2026-09-18 the row had grown to 34 files and ran
    // past the deadline twice under the deploy wave; `isolate: false` in the
    // vitest config (one runner and one Miniflare per row instead of one per
    // file) brought it to 40 s for 29 files at load 6-8, measured the same day.
    seconds: 45,
    catches: 'Durable Object semantics no bun test can express, executed inside real '
      + 'workerd (1.20260811.1 — the pool\'s own nested copy, not the 1.20260601.1 the '
      + 'top-level miniflare serves `bun scripts/tracing-gate.ts` from) via '
      + '@cloudflare/vitest-pool-workers. Five surfaces, 18 tests. Two are defects we '
      + 'shipped and found only from production: `ctx.waitUntil` retains nothing in an '
      + 'actor and its write is cancelled on reset with the exception swallowed, and '
      + 'anything Durable Object init awaits stalls every later request on that object. '
      + 'Both were guarded before this only by a source-text grep and an AST walk — '
      + 'correct rules whose STATED REASON nothing re-established. Both reproduce red '
      + 'against the historical shape: 2ms instead of a held 700ms invocation, and 703ms '
      + 'for a `SELECT 1`. The other two were guarded by nothing at all. '
      + '`ctx.storage.transactionSync` is the atomicity core DECLARES it needs for the '
      + 'admit-plus-roster write and the fork snapshot, on a backend whose documented '
      + 'non-CF fallback runs the body directly — so a bun test passes whether it rolls '
      + 'back, commits partially, or is absent. And the device plane keeps its whole '
      + 'per-connection record in a socket ATTACHMENT, which the shared fake answers as '
      + '`null` unconditionally, so every bun test over it observes the failure state as '
      + 'green. And nothing had ever seen an ALARM fire: a second `setAlarm` replaces the '
      + 'first rather than queueing, which is what makes `armTimer`\'s soonest-wins dedup a '
      + 'collapse instead of a lost wake-up, and an uncaught throw out of `alarm()` is '
      + 'redelivered until it succeeds, which is the backstop the SDK rethrows platform '
      + 'errors to reach. Each polarity carries its own control, so a green cannot come '
      + 'from a write that never happened.',
    blind: 'everything above the platform. This tier is deliberately NOT a second home '
      + 'for unit tests: `include` is exactly packages/*/tests/workerd and bunfig excludes '
      + 'the same path, so the two runners cannot overlap. It cannot type '
      + '`ctx.facets.clone`, which needs @cloudflare/workers-types >= 5.20260804.1 against '
      + 'the installed 4.20260604.1 — the RUNTIME does carry it, so this is a types '
      + 'ceiling and not a platform one. Nor tailStream dispatch, absent platform-wide and '
      + 'refuted as a local pin. It fires an alarm but does NOT reach the SDK\'s own '
      + 'dispatch chain (`_cf_runAlarmBody`), so the shadowed-`alarm()` defect that once '
      + 'ran for two months is still only a regex\'s problem. And '
      + '`abortAllDurableObjects` is a hard reset, NOT a hibernation wake — it drops the '
      + 'sockets with the isolate, so what survives a real eviction is still unmeasured.',
    inputs: workersPool('packages/cf-backend'),
  },
  {
    run: 'bun run test:workerd:cf-long',
    label: 'Durable Object semantics under workerd, the long suites',
    tier: 'ci',
    // The `tests/workerd/long/` half of the row above: seven suites, 17 tests,
    // measured as split 2026-09-16 under the same load: 169 s (load 1.3 to
    // 2.2); an eighth (busy-chat, one test, 24.9 s alone on 2026-09-18) sits
    // here because the row above ran into the 480 s deadline under the deploy
    // wave that day. With `isolate: false` (see the row above) the whole half
    // measured 178 s on 2026-09-18 at load 6-8. Same runner, same config, same `include`; the split is by path
    // filter so no file can be in both halves or in neither — `bun run
    // test:workerd` still runs every workerd row in sequence for a hand
    // run, and ladder.test.ts holds the rows to a partition of it.
    seconds: 183,
    catches: 'the same defect classes as the row above, on the suites that hold a Durable '
      + 'Object across a real wake, a retention sweep, a spend aggregate over 20,000 rows, '
      + 'an EIO on files, a step cap and a stream lifecycle — the long-running half.',
    blind: 'the same as the row above.',
    inputs: workersPool('packages/cf-backend'),
  },
  {
    run: 'bun run test:workerd:devbox',
    label: 'Devbox admission under workerd',
    tier: 'ci',
    // Measured 2026-09-16 under the same load: 3 s, two files, seven tests.
    seconds: 3,
    catches: 'the devbox bench worker\'s admission and selected-arm guards as workerd runs '
      + 'them (`packages/devbox/tests/workerd`), which no bun test can express.',
    blind: 'everything above the platform, as the cf-backend row states.',
    inputs: workersPool('packages/devbox'),
  },
  {
    run: 'bun run test:workerd:cf-complexity',
    label: 'Storage cost grows no faster than declared, under workerd',
    tier: 'push',
    // 29 to 32 s at load 7 on 2026-09-24 (vitest boot, then four subjects: the 300-turn session and
    // the 10,000-file workspace are most of it); 59 s at load 16 under gate-cost-measure that night,
    // and 28 s at load 9 with the session subject on the full step pipeline.
    seconds: 32,
    catches: 'a storage path whose cost per operation grows faster with its size than it '
      + 'declares: the rows each table\'s statements read, write and scan past what they return, '
      + 'each table\'s stored rows and payload bytes, and the model request\'s bytes, counted in '
      + 'workerd on a Durable Object\'s own SQLite at two or three sizes, never timed. Four '
      + 'subjects: the session store per turn at 50 and 300 turns, through the step pipeline an '
      + 'Anthropic-bound turn runs (red on 2026-09-24 with the render-copy fix reverted, 631 -> '
      + '3,631 session rows written a turn, and with the context_message_members index dropped, '
      + '612 -> 3,612 membership rows scanned), Diffs per read at 10, 1,000 and 10,000 files, and '
      + 'a slate\'s versions and its fork.',
    blind: 'CPU, memory and wall time; storage outside the object\'s SQLite; growth past the '
      + 'largest size measured; which of the tables a statement names its rows came from; bytes '
      + 'rewritten in place; and a step that prunes, which the session subject\'s messages are '
      + 'too small to make. The suite prints the list with its figures after the file, which '
      + 'vitest\'s agent reporter shows only when the file fails.',
    inputs: workersPool('packages/cf-backend'),
  },
  {
    run: 'bun run gate:policy-drift',
    label: 'Duplicated policy constants',
    tier: 'commit',
    // Measured 2026-09-05 on the 24-thread box: 0.8/0.8/0.8/0.9/0.9s. Replaces 0.6s.
    seconds: 0.9,
    catches: 'one policy number written down twice. `RETRY_BASE_MS` is declared three '
      + 'times with three values (5s in core, 30s in the email outbox, 1s in a React '
      + 'hook) and `RETRY_MAX_MS` three times with two, so grepping either name returns '
      + 'a confident wrong answer. Values are folded before comparison, because five '
      + 'minutes is written `300_000` in one file and `5 * 60 * 1000` in three others. '
      + '12 findings over 277 named constants and 2,629 literals in a role position.',
    blind: 'a policy held in a lowercase local, and an unnamed literal whose role words '
      + 'only PARTIALLY match a constant — the partial-match version reported 12 and '
      + 'every one was two unrelated decisions picking the same round number, so exact '
      + 'is the rule and 0 is the honest count.',
    inputs: { kind: 'derived' },
  },
  {
    run: 'bun run gate:scratch-ownership',
    label: 'Test scratch ownership',
    tier: 'commit',
    // Measured 2026-09-05 on the 24-thread box (load 2.3): 0.42 s. Replaces 1.3 s.
    seconds: 0.42,
    catches: 'a suite that mints a temp directory and never removes it, at the mint site. '
      + 'Measured 2026-08-17: 10,124 of our own entries in the temp directory, from 2,434 '
      + 'earlier the same evening, and 5,489 of them were one eager `mkdirSync` that ran '
      + 'per `createCLIRuntime` — 107 per cli-backend suite run, whether MCTS branched or '
      + 'not. Three rules, each a shape that leaked: a temp path built from Date.now() '
      + '(unowned and unattributable — the name cannot say which suite made it), a mkdtemp '
      + 'prefix absent from the catalogue preflight counts by (so it is uncollected AND '
      + 'invisible, which under-reported our garbage by ~30%), and a suite file that mints '
      + 'without releasing through a throw.',
    blind: 'a directory minted by a program this repo merely runs (`external/` clones mint '
      + '`agent-core-*`), and the runtime COUNT, deliberately: preflight already argues '
      + 'that a ceiling on live scratch gets raised the first time it fires and deleted '
      + 'the second, so free inodes stay its invariant and ownership is this one.',
    inputs: AMBIENT_BY_NAME,
  },
  {
    run: 'bun run gate:agents-fields',
    label: 'Agents action/field relation',
    tier: 'commit',
    seconds: 0.34,
    catches: 'a field of the `agents` tool that the handler reads and nothing declares, or '
      + 'declares and nothing reads. The input was one flat `v.object`, and valibot\'s '
      + '`object` EXCLUDES an unknown entry rather than rejecting it, so '
      + '`{ action:"fork", task:"x", budgetUsd:5, wallClockMs:1000 }` parsed to '
      + '`{ action:"fork", task:"x" }` — measured against the shipped parser 2026-08-18. Both '
      + 'spend caps gone with no error and nothing recording the loss. The structural half is '
      + 'what this holds: an action can join AGENTS_TOOL_ACTIONS while its fields never join '
      + 'the schema, and every symptom is a field arriving ABSENT. Not a tautology — the two '
      + 'sides are the DECLARATION (the picklist in registry.ts, AGENTS_ACTION_FIELDS and the '
      + 'schema entries) and the CODE (the `input.<field>` reads each `case` arm of '
      + 'dispatchAgentsAction performs, followed through every whole-input hand-off, including '
      + 'across the module boundary into readMissionLimits where budget_usd is actually read). '
      + '31 reads over 7 arms and 6 hops today. An input handed somewhere it cannot follow '
      + 'fails the gate instead of being skipped, so a green cannot come from a walk that '
      + 'stopped early.',
    blind: 'what a read is USED for — a read whose value is discarded still counts — and field '
      + 'TYPES entirely. The advertised JSON Schema is bound to the same map at compile time '
      + '(the property types are derived from it) and asserted under full deps in '
      + 'unit-agents-tool.test.ts, so this gate deliberately does not build a tool.',
    inputs: { kind: 'derived' },
  },
  {
    run: 'bun run gate:bloat-budget',
    label: 'Comment budget',
    // Measured 2026-09-22 on the 24-thread box: 0.46/0.52/0.73s wall, 417 MB
    // peak, over 1,081 files. It reads oxc's comment list only, never the AST.
    tier: 'commit',
    seconds: 0.6,
    catches: 'comment growth in a package. The owner capped comments after the census measured '
      + 'them at 41% of the non-whitespace characters in product source (4,906,181 at '
      + '1dd25b3ad): each package holds one number, a package over it is red, a package the '
      + 'lock never held has a budget of zero, and `--lock` only lowers a number. A cut is '
      + 'green and printed as a stale row, so trimming comments never fails a commit.',
    blind: 'prose moved into a string literal, a doc or a commit body; comments in tests, '
      + 'scripts and tools; growth paid for by a cut elsewhere in the same package; whether a '
      + 'kept comment earns its place. All are printed on the gate\'s green path.',
    inputs: { kind: 'derived' },
  },
  {
    run: 'bun test --timeout=0 scripts/hammer.test.ts scripts/mutation-fences.test.ts',
    label: 'Hammer and fence gate self-tests',
    tier: 'push',
    seconds: 0.4,
    catches: 'the two adversarial gates\' own decision boundaries — the half that decides '
      + 'whether either is worth trusting. For the hammer: an output whose summary is missing '
      + 'reads as a silent zero rather than a pass, a governed suite file that reported '
      + 'nothing is a finding, a run killed at its deadline is a finding rather than a red '
      + 'test, and the parse that decides all three is exercised against bun\'s real output '
      + 'shapes. For the fences: a snippet that sits zero or twice in its file fails as a '
      + 'stale fixture, a mutant that PASSES fails naming the fence, a pristine baseline that '
      + 'fails is reported as a broken owner rather than as a proved fence, and a run that '
      + 'never settled is neither. Both gates are seeded with the shapes their own red proofs '
      + 'used, so a refactor that quietly stopped either from failing is caught here.',
    blind: 'whether the fences and the suite are the RIGHT ones to hammer. That is a '
      + 'judgement in the declarations, which is why each fence carries a `why` and the '
      + 'hammer prints its blind spots on the green path.',
    inputs: AMBIENT_BY_NAME,
  },
  {
    run: 'bun run gate:mutation-fences',
    label: 'Concurrency fences stay load-bearing',
    tier: 'deploy',
    // Four fences, each proved twice (pristine green, mutant red) inside one
    // sparse `git worktree add --detach` copy: 2.5s measured 2026-08-31 on the
    // 24-thread box, dominated by the eight `bun test` spawns.
    seconds: 2.5,
    catches: 'a concurrency fence whose red proof has rotted. A fence is a guard whose two '
      + 'readings both compile — `this.#owns(gen)` around a stale write, a `spawnedBefore` '
      + 'bound on a sweep, a terminal/resumable split — so stripping one changes no type, '
      + 'throws nothing, and leaves the suite green until the interleaving happens in '
      + 'production. Four are declared with file, snippet and owning test; each is stripped '
      + 'MECHANICALLY in an isolated copy and its owner is required to fail. Green with the '
      + 'fence stripped is the finding, because it names a fence nothing guards. A snippet '
      + 'that no longer sits in its file exactly once fails as a stale fixture rather than '
      + 'passing, which is the exploration-policy mutation suites\' rule applied to guards instead of policies.',
    blind: 'a fence nobody declared — the list is hand-written and nothing enumerates the '
      + 'guards a module contains. It proves ONE named strip per fence, never that the strip '
      + 'is the worst reading, and only that ONE test catches it. The copy is HEAD, so a '
      + 'fence in uncommitted work is invisible until it lands, and the owners run under bun, '
      + 'so an interleaving that needs workerd belongs to `bun run test:workerd`.',
    inputs: { kind: 'live', why: 'materialises `git worktree add --detach` at HEAD and runs suites there, so its subject is the commit, never the working tree the key hashes.' },
  },
  {
    run: 'bun run gate:hammer',
    label: 'Contended reruns of the Cloudflare suite',
    phase: 'hammer',
    alone: 'runs alone, and its SUBJECT is why. It saturates nproc/2 threads with CPU burners on '
      + 'purpose, so every gate beside it would be measured on a machine this one is '
      + 'deliberately starving: the five-suite UI batch is 198.5s solo against a 480s '
      + 'per-gate deadline, and a browser gate that times out under someone else\'s load '
      + 'fails for a reason unrelated to the change under test. It runs AFTER the source '
      + 'wave so a cheap source failure still fails first, and before the account gate.',
    tier: 'deploy',
    // 6 runs x ~11s contended = 65.8s measured 2026-08-31 (24 threads, 12
    // burners). Alone by construction — see its `phase` and `alone` below.
    seconds: 66,
    catches: 'a test that passes once on an idle box and fails when the machine is busy or '
      + 'when the suite runs again. Every other tier runs each suite ONCE and reads the exit '
      + 'code, which answers "does this pass" and cannot answer "does this pass reliably". '
      + 'This runs `bun test --parallel=4 packages/cf-backend/` six times with nproc/2 CPU '
      + 'burners alive throughout, keeps EVERY failing block in an artifact whose path is '
      + 'printed on both paths, and fails on any failure — no retry, no quarantine list, no '
      + 'known-flake allowance, because a lane that retried until green converts the only '
      + 'evidence of a race into a slower green. It also holds the set it MEASURES equal to '
      + 'the set the command GOVERNS, per run and in both directions: a governed suite file '
      + 'that reports nothing is the silent zero a green exit code hides. Its own fixture '
      + 'work found a live one — `unit-facet-reconciliation` pinned the facet registry read '
      + 'ORDER and came back red on 1 isolated run in 3 with `reclaimed: 4` every time.',
    blind: 'six runs sample six interleavings: greens raise confidence and prove nothing '
      + 'about absence. Contention is CPU-only — the burners allocate nothing, touch no disk '
      + 'and open no socket, so allocator pressure, IO starvation and network races are '
      + 'unperturbed. ONE suite is hammered; every other package runs once on an idle box. '
      + 'Which four files bun schedules together is bun\'s decision, so an interleaving it '
      + 'never picks is unmeasured — measured, a deliberately race-prone fixture PAIR passed '
      + 'because the two files were never co-scheduled, while an intermittently failing '
      + 'single file was caught on run 2 of 2.',
    inputs: { kind: 'live', why: 'measures the Cloudflare suite under deliberate CPU contention; its subject is the box\'s load at the moment it runs.' },
  },
  {
    run: 'bun run verify:lean',
    label: 'Lean proofs, consistency, and traceability',
    tier: 'deploy',
    // 10 s WARM: 10.1 and 9.3 s at 961dd0ab2 (lane/formal-proofs) in a detached
    // worktree on the 24-thread box, 2026-09-22, at load 20-21 with other lanes
    // running, after one cold run of 24.4 s. The growth from 2.2 s (2026-08-21,
    // warm, `lake build` a no-op) is the refinement fixtures regenerated and
    // diffed and 824 refinement cases under bun test (2.4 s of it).
    //
    // COLD IT IS ~15 MINUTES, and that is what CI pays: the lean-verify workflow
    // caches `~/.elan` and not the Lean build cache, so a runner rebuilds 330 theorems
    // every time. That is why CI_EXEMPT keeps it off the ci tier, and why both
    // figures are written down rather than averaged into one that describes
    // neither machine.
    //
    // Declared at ZERO until 2026-08-21, which made the deploy tier's cost line
    // fiction and its budget unenforceable.
    seconds: 10,
    catches: 'a Lean module that stops compiling, an axiom set that makes the model '
      + 'inconsistent, a requirement in lean/traceability.yaml with no theorem behind it, '
      + 'and a TypeScript comment citing a theorem no module defines. `check-no-false.sh` '
      + 'tries to derive False from the removed axioms and REQUIRES that attempt to fail, '
      + 'so the consistency claim cannot pass by proving nothing.',
    blind: 'whether a theorem models the thing its name says. 25 citations carry an '
      + 'author-declared CITATION_ILLUSTRATIVE category, which is trusted rather than '
      + 'checked, and a line citation is checked only for both endpoints being inside the '
      + 'module — an insertion above a cited range slides it onto different code and stays '
      + 'green. A theorem NAME is the only citation shape this can verify.',
    inputs: { kind: 'live', why: 'runs the elan/lake toolchain over the Lean tree, a compiler the key does not version and a shell entry the resolver does not read.' },
  },
  {
    run: 'bun test --timeout=0 scripts/live-app-tier.test.ts',
    label: 'Live app in a browser',
    tier: 'deploy',
    // Measured 2026-09-17 alone on the 24-thread workstation. Its solo wall is
    // 53.0s (twice, at load 1.4 and 1.9; 54.7s at load 2.15) for 12 rows driven
    // end to end — two of them red on the pane transcript leak they exist to
    // measure, which costs the wall nothing. No deadline of its own: 53s is an
    // eighth of the shared 480s wall.
    //
    // The figures in gate-cost.json are the pid-tree ones: 5112 MiB and 114.8
    // CPU seconds over a 59.1s wall, three threads. The session-basis sampler
    // read 203 MiB and 75.4s for the same row, because both of this row's heavy
    // children leave its session — live-app-harness spawns `vite dev` detached
    // (setsid, so the teardown signals workerd through the group) and puppeteer
    // spawns Chrome detached by default. The 6s of extra wall is the sampler's
    // own cost: it now walks Chrome's ~110 processes for their runnable tasks.
    // The tree basis is L7 in docs/ARCHITECTURE-DECISIONS.md.
    seconds: 53,
    catches: 'a defect in the SHIPPED workspace surfaces that every source-reading gate and '
      + 'every gallery gate here is structurally unable to see. The gallery serves a FROZEN '
      + 'pre-built bundle with fixtures answering `/api/*`, so a fault in the real Worker\'s '
      + 'data or socket path cannot appear in it; this row boots the product itself — `vite '
      + 'dev` in cf-backend, which is workerd with real Durable Objects behind the real client '
      + '— and drives it in Chrome at 1440x900, where the inspector column, its separator and '
      + 'the rail lane exist. Twelve rows, each a geometry, node-identity or count assertion '
      + 'off a real interaction: the Work surface keeps its DOM node AND its scroll offset '
      + 'across a chat-tab switch with zero workspace-scoped reads re-sent in either direction '
      + 'and the new tab\'s own actor socket answering its pane; at most one plan-bearing tab '
      + 'or filter in the column, so plans have one owner; the tab strip\'s rule continuous to '
      + 'the column\'s right edge with the active underline on it and the chat rule on the '
      + 'same line, in dark and in light; a column the reader collapsed reopening through the '
      + 'product\'s own control, found by role and accessible name, and the rail collapsing; '
      + 'and a marker sent in each pane staying out of the other, which is the transcript leak '
      + 'a shared store shows as green. Five of those were found by hand on a running build '
      + 'while the whole ladder was green.',
    blind: 'one workspace, one viewport, one model. The rows drive 1440x900 in two themes on '
      + 'the workspace route: every other route, width and theme is the gallery rows\' subject '
      + 'and unmeasured here. The model is a local scripted SSE server, so the content is '
      + 'live-rendered and says nothing about a real model\'s turn. And it is a LOCAL dev '
      + 'server: `vite dev`\'s workerd is not the production isolate, its Durable Objects are '
      + 'this box\'s, and the edge, the deployed assets and the real identity belong to '
      + '`gate:first-run` after the publish. No pixel is compared, so a legible-but-ugly '
      + 'regression passes, and the geometry rows read boxes rather than whether the layout is '
      + 'the right one. The deployed build\'s browser rows are the product flows\' '
      + '(`scripts/product-flows.ts`), which run against this dev server and against the '
      + 'deployment alike.',
    inputs: { kind: 'live', why: 'boots `vite dev` — workerd with real Durable Objects — on an ephemeral port and drives Chrome against it, with this box\'s own `.dev.vars` credentials in process env; a hash over the tracked tree stands for none of the three.' },
  },
  {
    run: 'bun scripts/with-dev-server.ts bun test --timeout=0 scripts/product-flows.test.ts',
    label: 'Product flows in a browser, on the local dev server',
    deadline: {
      seconds: 500,
      why: 'nine rows on the flows\' scripted model: 166s on 2026-09-25, the dev server\'s boot '
        + 'included. About three times the wall.',
    },
    tier: 'deploy',
    // 166s on 2026-09-25 (load 1.5 at start): the dev server's boot, then nine
    // rows on the scripted model, agent-return the longest at 31s.
    seconds: 166,
    catches: 'a flow a person runs in the page that breaks while every API, socket and '
      + 'fixture-backed browser gate stays green: the owner\'s #13, where every agent a '
      + 'workspace held was present over the API and the reloaded page showed none of them. '
      + 'Each row drives real Chrome through the product\'s own controls against `vite dev` '
      + '(the real Worker and Durable Objects, no fixtures) and asserts only what the page '
      + 'shows. The rows are the same file the deployment runs after the publish, here on the '
      + 'flows\' scripted model (`flowsModel`), so a flow red here is red before it ships.',
    blind: 'what `vite dev` is not: the production isolate, the edge and its preview zone (a '
      + 'slate\'s frame loads through vite-preview-zone.ts on loopback), the deployed assets and '
      + 'the real identity, which are the post-publish row\'s. One viewport, one theme. The '
      + 'model is a script, so a row tests what the product does with a known answer and never '
      + 'what a real model writes; the deployment\'s run of the same rows is on its real model.',
    inputs: { kind: 'live', why: 'boots `vite dev` on an ephemeral port with this box\'s `.dev.vars` credentials and drives Chrome against it, on a local scripted model; a hash over the tracked tree stands for none of them.' },
  },
  {
    run: 'bun run gate:infra',
    label: 'Declared infrastructure exists and is bound',
    phase: 'infra',
    alone: 'runs alone, after every source gate. It is the cheapest gate that talks to Cloudflare, '
      + '`npx wrangler whoami` is its precondition, and its place in the order carries meaning: '
      + 'everything before it proves the SOURCE is deployable and it proves the ACCOUNT is. '
      + 'Running it early would spend account calls on a tree that has not been shown to compile.',
    tier: 'deploy',
    seconds: 43,
    catches: 'a resource the binding manifest declares and the account does not hold, and a '
      + 'resource that exists while the deployed Worker is not bound to it. Nobody could show '
      + 'that a fresh account could be stood up at all: every external resource production binds '
      + 'was created by hand at some point, and nothing anywhere was the list. The inventory is '
      + 'DERIVED from wrangler.jsonc — 22 resources in production — so it cannot be short by one '
      + 'bucket, and requiredness is DERIVED from `env.d.ts`\'s `?`, which is the Worker\'s own '
      + 'statement about what it tolerates losing. It keeps three states apart where every other '
      + 'tool here keeps two: present, absent, and LOOKUP FAILED — the last always a failure, '
      + 'because creating a bucket on "the network was down" is how an account ends up with two '
      + 'answers to which bucket holds the snapshots. Secrets are checked by PRESENCE against a '
      + 'census pinned to `Env`, so a new secret is unclassifiable-and-red rather than absent-and '
      + '-quiet; that pin is what would have caught NIMBUS_RUNTIME_CACHE being typed `string` for '
      + 'months while being an R2 bucket. On its first live run it found four real things: no '
      + 'Email Routing rule delivers to this Worker (Mission Inbox receives nothing while every '
      + 'binding is present and correct), staging\'s deployed version predates the MonitorDO '
      + 'migration, staging has no root secret, and Google and GitHub sign-in are dark for want '
      + 'of two secrets nobody had recorded as missing. It also proves the admin control plane\'s '
      + 'OUTER gate: that a Cloudflare Access organization, a self-hosted application whose AUD '
      + 'the Worker pins, and an Allow policy naming identities all exist and cover BOTH '
      + '`kinu.run/control*` and `kinu.run/api/control*` — plus the NEGATIVE half, that no Access '
      + 'application covers the app host at large or any `*.kinu.run` preview hostname. Both '
      + 'directions are silent failures without it: the admin plane fails closed, so a missing '
      + 'application 404s its own operators and looks like an allowlist typo, while an '
      + 'over-broad one leaves the admin plane working perfectly and puts an interactive '
      + 'corporate login in front of every preview URL an agent hands out, the landing page and '
      + '/api/feedback.',
    blind: 'anything no CLI can observe, which it refuses to hide: the AI Gateway (wrangler 4.97 '
      + 'has no `ai-gateway` command and the OAuth session has no `aig` scope) and the cron '
      + 'trigger (writable, never readable) are DECLARED blind spots pinned by equality, so the '
      + 'list can only shrink and only on purpose, and an undeclared one fails. Also blind to '
      + 'whether a resource that exists is CORRECT beyond its name — a Vectorize geometry '
      + 'mismatch is reported, an R2 lifecycle rule is not. The four Access rows need an API token with `Access: Apps and Policies Read` '
      + 'rather than the wrangler login, which has no Access scope; without one they report '
      + 'UNKNOWN and fail, because a machine that could not look at the admin plane\'s outer gate '
      + 'has not verified it.',
    inputs: { kind: 'live', why: 'talks to the Cloudflare account through a wrangler session and proves resources exist there now.' },
  },
  {
    run: 'bun run gate:first-run',
    label: 'First-run tier',
    phase: 'post-publish',
    deadline: {
      seconds: 1_800,
      why: 'covers six deployed episodes. Three use a real model over a socket. '
        + 'Two attach real daemons; one drives Chrome against the deployed app. '
        + 'The six-case deployed wall is unmeasured. This configured bound stays unchanged '
        + 'until a deployed run measures it and the cost in LADDER.',
    },
    alone: 'runs alone, and AFTER the deploy — the only gate here whose subject is the DEPLOYED '
      + 'build rather than this tree. It attaches real machines to the account, opens a real '
      + 'browser session and creates workspaces as the same identity `gate:infra` '
      + 'authenticates with, so anything beside it would be inside the fleet one of its cases '
      + 'is measuring: the two-machines case asserts that exactly two machines are live and a '
      + "sibling's daemon would make that three.",
    tier: 'deploy',
    // On 2026-09-05, credential-free collection skipped six files and six tests.
    // `bun --bun vitest run --config vitest.first-run.config.ts` reported
    // 3.84s and took 4.07s wall time on the 24-thread box.
    // `bun test tests/first-run/wiring.test.ts` passed 14 tests in 253ms
    // and took 0.33s wall time. These runs measure collection and predicates.
    // The deployed six-case wall is unmeasured. Its deadline remains 1800s.
    // The declared deployed cost below remains unchanged.
    seconds: 197,
    catches: 'a product defect a USER meets on the build that just deployed, which every other '
      + 'gate in this ladder is structurally unable to see: they all run BEFORE the upload, on '
      + 'this tree, over inputs their own authors wrote. Between 2026-09-01 and 2026-09-03 the '
      + 'owner found four by hand — a crafted tool whose body would not run, an Approve button '
      + 're-ticking every box it had just cleared, two connected machines flapping on one '
      + 'executor slot, and Enter not sending in the TUI — and every one had a green test, '
      + 'because each test supplied an `async (args) =>` body, a fixture queue, ONE fake daemon '
      + 'and a CR byte. The model, the click, the second machine and the LF byte are what a '
      + 'user brings. This tier brings them: a fresh workspace per case over the public REST, '
      + 'the real model, a real click in Chrome, two real daemons under their own homes, and '
      + 'real pty bytes into the shipped TUI against a deployed workspace. Hard assertions '
      + 'only — a `tool_outcome` row that closed clean, a decided row GONE from the queue, the '
      + 'other machine\'s exec log EMPTY, a user turn durable in the deployment\'s own '
      + 'transcript, a file\'s exact bytes off the Files tab\'s own read. Three of the six red '
      + 'directions are proved against the deployed builds that had the bug (a85ce8793, '
      + '343e157df, daad4aeee).',
    blind: 'everything a first run does not reach, and the list is long on purpose: it drives '
      + 'six paths, not the product. It cannot see a defect on any surface no case names, a '
      + 'defect that needs a second user or a second account, or one that needs a machine that '
      + 'is not this one — both daemons are this host wearing two names, so a real '
      + 'cross-platform fleet is unmeasured. It runs AFTER the upload, so its red is a '
      + 'deployed red: the bad build is already serving when this fails, and the tier reports '
      + 'rather than prevents. It is not a regression net either — a green here says these '
      + 'six mechanisms work, never that the deploy is good. And its model cases depend on a '
      + 'model choosing to use the capability it was asked for, so a refusal is red and reads '
      + 'identically to a broken one until somebody reads the transcript the record keeps.',
    inputs: { kind: 'live', why: 'drives the DEPLOYED build with real machines, a real browser and live model turns.' },
  },
  {
    run: 'bash scripts/product-flows-tier.sh',
    label: 'Product flows in a browser, on the deployment',
    phase: 'post-publish',
    deadline: {
      seconds: 900,
      why: 'six rows, four of them waiting on a real model turn over the public edge: 329s '
        + 'against b220f59f8 on 2026-09-23, the slate turn alone 240s. About three times the '
        + 'wall, so a slow model answers rather than being killed as a hang.',
    },
    alone: 'runs in the post-publish wave, after the upload and the smoke gate, beside the '
      + 'other tiers whose subject is the build that just shipped. Its workspaces carry the '
      + 'eval prefix and are torn down by the row that made them, and it attaches no machine, '
      + 'so it stands outside the device fleet the first-run tier counts.',
    tier: 'deploy',
    // 329s against b220f59f8 on 2026-09-23 with the slate row (66s to 128s without
    // it); the model turns are the spread.
    seconds: 329,
    catches: 'a flow a person runs in the page that breaks on the DEPLOYED build: the same rows '
      + 'the pre-publish run drives against `vite dev`, in real Chrome against the deployment '
      + 'as the eval identity, asserting only what the page shows. The first-run tier reads '
      + 'the deployment over its API and socket and the eval suite drives the model, so '
      + 'neither loads the page a person loads; #13 was an API-green workspace whose reloaded '
      + 'page showed no agents.',
    blind: 'a flow no row drives, and the look of the page: rows read presence and text, never '
      + 'pixels. It reports on a build that is already serving, so a red here is a red users '
      + 'have now. The model is real, so a row that needs an answer reads that one arrived, '
      + 'never its words.',
    inputs: { kind: 'live', why: 'drives the DEPLOYED build in real Chrome as the eval identity and spends real model turns.' },
  },
];


/**
 * Every deploy-tier gate in the order the runner walks it: phases in
 * {@link DEPLOY_PHASES} order, ladder order inside a phase. The plan and the
 * command list are both projections of this, so the order lives once.
 */
export function deployOrder(): Gate[] {
  const gates = gatesFor('deploy').filter((gate) => gate.tier !== 'evals');

  return DEPLOY_PHASES.flatMap((phase) => gates.filter((gate) => (gate.phase ?? 'source') === phase));
}

/**
 * The deploy tier's commands, in the order the runner walks them. Until
 * 2026-09-15 this PARSED deploy.sh's `run_required_gate` lines, and deploy.sh
 * carried a second copy of every row's weight, deadline and phase in bash
 * tables `deploy.test.ts` held equal to this file. Now deploy.sh consumes
 * `--plan` and there is one copy: this one.
 *
 * Reads no cost, because its callers — `gate:set-equality` and the test
 * census — ask which gates exist and not what they take. A commit-tier gate
 * that needed the cost table would make an unmeasured row block a commit
 * rather than a deploy.
 */
export function deployGates(): string[] {
  return deployOrder().map((gate) => gate.run);
}

/** One row of the deploy plan, as the runner reads it. `threads` and `rssMb`
 *  are MEASURED (scripts/gate-cost.json), never declared: a row that says what
 *  it costs is the defect this replaced. */
export interface PlanRow {
  readonly phase: DeployPhase;
  readonly label: string;
  readonly threads: number;
  readonly rssMb: number;
  readonly deadline: number;
  /** The resource the row holds whole, or `none`. The wave admits one row
   *  holding a resource at a time; see {@link SHARED_RESOURCES}. */
  readonly shared: SharedResource | 'none';
  readonly run: string;
}

/**
 * The deploy plan: every deploy-tier gate with its phase, label, measured cost
 * and deadline, in phase order. This is what `bash scripts/deploy.sh`
 * schedules from — the single source of what blocks a publish.
 *
 * LONGEST FIRST inside the concurrent `source` wave, by the row's measured
 * solo wall: the runner launches the first row that fits, so a long row
 * listed late starts late and the wave waits on its tail. Every other phase
 * keeps ladder order; its rows run alone or are the two post-publish tiers.
 *
 * REFUSES rather than defaults. A `source` row is admitted CONCURRENTLY, so a
 * row there with no measurement is a row the wave would schedule against a
 * number nobody took: exactly the 2026-09-16 failure. Outside `source` every
 * phase's rows are declared to run alone or are the two post-publish live
 * probes whose cost is a network wait, so the cap is not what decides them and
 * an unmeasured row there carries one thread and one MiB.
 */
export function deployPlan(costs: CostTable = readCosts()): PlanRow[] {
  const tracked = trackedTestFiles();
  const browsers = sharedBrowserModules();

  const rows = deployOrder().map((gate): PlanRow => {
    const phase = gate.phase ?? 'source';
    const cost = costs.rows[gate.run];

    if (cost === undefined && phase === 'source') {
      throw new Error(
        `${gate.run} is scheduled in the concurrent source wave and has no measured cost in `
        + `${COST_TABLE}. Measure it alone — bun scripts/gate-cost-measure.ts --only="${gate.run}" `
        + '— and commit the figures. A row admitted against a number nobody took is how five rows '
        + 'died on their deadline on 2026-09-16.',
      );
    }

    return {
      phase,
      label: gate.label,
      threads: cost === undefined ? 1 : costThreads(cost, gate.seconds),
      rssMb: cost === undefined ? 1 : costRssMb(cost),
      deadline: gate.deadline?.seconds ?? GATE_DEADLINE_SECONDS,
      shared: sharedOf(gate, tracked, browsers) ?? 'none',
      run: gate.run,
    };
  });

  const wall = (row: PlanRow): number => costs.rows[row.run]?.wallSeconds ?? 0;

  return DEPLOY_PHASES.flatMap((phase) => {
    const inPhase = rows.filter((row) => row.phase === phase);

    return phase === 'source' ? inPhase.sort((left, right) => wall(right) - wall(left)) : inPhase;
  });
}

/** The plan as the runner reads it: one tab-separated line per row — phase,
 *  label, threads, resident MiB, deadline, shared resource, command. Tabs,
 *  because a command holds spaces and a label holds punctuation, and neither
 *  holds a tab; the command stays LAST, so a field added here cannot be eaten
 *  by the runner's `read` of it. */
export function printPlan(rows: readonly PlanRow[]): string {
  return rows
    .map((row) => [
      row.phase, row.label, String(row.threads), String(row.rssMb), String(row.deadline), row.shared, row.run,
    ].join('\t'))
    .join('\n');
}

/**
 * THE WAVE'S COST MODEL, AND WHY IT IS MEASURED.
 *
 * A row's cost is its measured peak parallelism and its measured peak resident
 * set ({@link costThreads}, {@link costRssMb} over scripts/gate-cost.json),
 * and the wave admits rows while the sum of both stays under a cap derived
 * from the box — `nproc` and `MemAvailable`, read by scripts/deploy.sh at the
 * start of each phase.
 *
 * It used to be a DECLARED thread figure, one unless a row said otherwise, and
 * no memory dimension at all. Two things followed.
 *
 * Measured 2026-08-23: a half-thread rule launched 12 outer gates and up to 48
 * inner workers here, turned a 23.67s CLI file into a 173.54s run and produced
 * nine false timeout failures. Measured 2026-09-16: a six-gate width — the
 * rule that replaced it — put the eleven-suite UI row beside two `--parallel=4`
 * package suites and failed every deploy that day on a puppeteer wall, while
 * the same row passed alone in 361s. Both are one defect: a count of gates is
 * not a measure of load.
 *
 * The declared figures that replaced the count were closer and still wrong.
 * The three rows that run workerd declared one thread each; measured alone on
 * 2026-09-17 they take far more, and they hold gigabytes nothing was counting.
 * A wave with no memory dimension cannot see a SIGKILL coming, and on
 * 2026-09-16 the gate self-tests row settled at 137 — the kernel's, not the
 * deadline's, which reports 124.
 *
 * So no row declares its cost any more. The deadline is unchanged and stays
 * what it always was: the hang detector.
 */

/** A row that reaches the workerd pool, a dev server or Chrome, matched
 *  against the row's command, the package script it resolves to, and the
 *  imports of every file it claims. Those are ONE machine resource shared by
 *  every worktree, so `gate-cost-measure.ts` waits another checkout's out rather
 *  than starting a second one beside it — and a browser row measured against a
 *  port another worktree's dev server holds is not a measurement at all. */
export const SHARED_POOL = /(?:vitest|workerd|vite )/u;

/** A module that reaches the browser ITSELF, as the seed of the closure
 *  below. One signal, never a list of suites: the harnesses are the only
 *  place puppeteer is imported, and a suite reaches Chrome by importing one
 *  of them — often two hops out (`computed-style.test.ts` →
 *  `computed-style.ts` → `gallery-harness.ts` → puppeteer). */
const BROWSER_IMPORT = /from ['"]puppeteer['"]/u;

/**
 * Every module in `sources` that reaches a headless browser: one that imports
 * puppeteer, or one that imports — however many hops out — a module that does.
 *
 * A CLOSURE AND NOT A TEXT MATCH ON THE SUITE. `SHARED_BROWSER` was one regex
 * over one file naming `./gallery-harness` or `puppeteer`, and six of the
 * sixteen suites in the UI row reach Chrome through neither string:
 * `provider-wait-ux`, `models-section-ux`, `workspace-snapshot-ux`,
 * `computed-style`, `plan-demo-film` and `gallery-harness`'s own self-test all
 * import a harness that imports another one. A row whose browser cost is
 * invisible to the derivation is a row the wave admits beside another browser
 * row, which is the 2026-09-18 failure.
 */
export function browserModules(sources: ReadonlyMap<string, string>): ReadonlySet<string> {
  return modulesReaching(sources, (_file, text) => BROWSER_IMPORT.test(text));
}

/** The corpus the closure reads: every parseable tracked file. Measured
 *  2026-09-18 on this box, 2,484 files and 35 MB read in 49 ms, so the plan
 *  reads the whole tree rather than a directory somebody expected the
 *  harnesses to stay in — narrowed to `scripts/` it missed
 *  `tests/live/live-smoke.test.ts`, which launches puppeteer itself inside the
 *  `Live and first-run suites, credential-free` row. */
let corpusBrowserModules: ReadonlySet<string> | null = null;

export function sharedBrowserModules(): ReadonlySet<string> {
  corpusBrowserModules ??= browserModules(readMatching(isParseable));

  return corpusBrowserModules;
}

/** The resource a row holds whole, DERIVED from the files it claims and
 *  overridden by nothing: a row may declare one the derivation cannot see,
 *  and `ladder.test.ts` refuses a declaration no browser module confirms. */
export function sharedOf(
  gate: Gate,
  tracked: readonly string[],
  browsers: ReadonlySet<string> = sharedBrowserModules(),
): SharedResource | undefined {
  if (claims(gate.run, tracked).some((file) => browsers.has(file))) return 'browser';

  return gate.shared;
}

/** The path of the Python suites' runner, as its gate spells it. */
export const PYTHON_SUITES_SCRIPT = 'scripts/python-suites.ts';

/** The path of the live tier's runner, as `bun run test:live` spells it. */
export const LIVE_TIER_SCRIPT = 'scripts/live-tier.sh';

/** The eval suite's vitest config, as `bun run evals` names it. */
export const EVALS_CONFIG = 'evals/vitest.config.ts';

/** The wrapper that boots the local dev server and runs a command against it,
 *  as a gate spells it. */
export const DEV_SERVER_WRAPPER = 'scripts/with-dev-server.ts';

/** `bun --bun vitest run --config evals/vitest.config.ts …`: the eval suite's runner, as `bun run evals` spells it. */
function runsEvalSuite(words: readonly string[]): boolean {
  return words.slice(0, 4).join(' ') === 'bun --bun vitest run' && words[words.indexOf('--config') + 1] === EVALS_CONFIG;
}

/**
 * The live tier's `bun test` argv for the default backend, read out of
 * `scripts/live-tier.sh`: a parse of the authoritative script, never a copy, for
 * the reason {@link deployGates} is one. The FIRST `TARGETS=(…)` only: the second
 * sits inside the `--backend cloud` branch, and a resolver that took the last one
 * would credit the default invocation with the cloud run's single file.
 */
export function liveTierTargets(source = readFileSync(resolve(root, LIVE_TIER_SCRIPT), 'utf8')): string[] {
  for (const line of source.split('\n')) {
    const targets = /^TARGETS=\(([^)]*)\)\s*$/.exec(line.trim());

    if (targets?.[1] !== undefined) return targets[1].split(/\s+/).filter((word) => word.length > 0);
  }

  return [];
}

/**
 * Deploy gates whose FILES the CI tier does not cover, each with the reason.
 * This map is the whole CI-vs-deploy delta, so "a green CI badge means
 * everything a deploy checks except these" is a sentence someone can check.
 *
 * One entry. That is the point: on 2026-08-17 the undeclared delta was five
 * packages, 41 of 42 CLI files, the root suites and both Layergate runs.
 */
export const CI_EXEMPT = {
  'bun run gate:infra':
    'needs a Cloudflare session. CI has none, and giving it one would put an account credential '
    + 'with write scope on every pull request. Without a session the gate reports BLOCKED and '
    + 'non-zero rather than skipping, so it cannot be run there and read as a pass — which is '
    + 'why it lives at the deploy tier, immediately after `wrangler whoami` has proved there is '
    + 'a session to use.',
  'bun run gate:hammer':
    'is minutes of deliberate CPU starvation. On a shared CI runner it would both take far '
    + 'longer than its 66s here and perturb every other job on the box, and its findings '
    + 'would be indistinguishable from runner noise — a gate whose reds cannot be trusted is '
    + 'a gate somebody disables. It runs at deploy, alone, on a machine whose load is known.',
  'bun run gate:mutation-fences':
    'materialises a `git worktree add --detach` copy and runs eight `bun test` processes '
    + 'inside it. On a CI runner with no local object store that checkout is a fresh clone '
    + 'per fence, and the proof it makes is about the tree being deployed rather than about '
    + 'a pull request — so it sits at deploy, beside the other gates that answer for what '
    + 'ships.',
  'bun run verify:lean':
    'needs the elan toolchain and a 15-minute Lean build. It runs in the path-filtered '
    + 'lean-verify workflow on pull requests and as a main-push gate, which is where '
    + 'that cost belongs.',
  'bun run gate:first-run':
    'has nothing to run against at CI. Its subject is the deployment that just went up, so it '
    + 'runs AFTER the upload and the smoke gate, on a build that exists — at CI there is no such '
    + 'build, and pointing it at the previous one would report the last deploy\'s product under '
    + "this pull request's name. It also creates workspaces, links real machines and spends "
    + 'model calls on a shared account, none of which belongs on a pull request.',
  'bun scripts/with-dev-server.ts bun test --timeout=0 scripts/product-flows.test.ts':
    'boots the same dev server the live-app row does, on the same `.dev.vars` credentials a '
    + 'pull request must not hold, and spends real model turns on the account through it.',
  'bash scripts/product-flows-tier.sh':
    'has nothing to run against at CI: its subject is the deployment that just went up, as the '
    + 'eval identity, whose secret no pull request holds.',
  'bun test --timeout=0 scripts/live-app-tier.test.ts':
    'needs the account\'s own dev credentials in PROCESS env for the product\'s dev server to '
    + 'boot at all — measured 2026-09-17, `vite dev` exits "error when starting dev server" '
    + 'with no CLOUDFLARE_API_TOKEN, and the credential path 503s without the cf-backend '
    + 'secrets. They live in `.dev.vars` on this box, and a write-scoped account token on '
    + 'every pull request is the objection `gate:infra` already carries. It also holds '
    + 'workerd, Chrome and a scripted model server at once, so it runs at deploy on a machine '
    + 'whose load is known.',
} satisfies Record<string, string>;

/** Every gate at or below `tier`. */
export function gatesFor(tier: Tier): Gate[] {
  const upto = TIERS.indexOf(tier);

  return LADDER.filter((gate) => TIERS.indexOf(gate.tier) <= upto);
}

/** Every file changed since `ref`, committed or not, and every addition not yet tracked. */
function changedSince(ref: string, repo: Repo): Set<string> {
  const run = Bun.spawnSync(['git', 'diff', '--name-only', '-z', ref], { cwd: root, stdout: 'pipe', stderr: 'pipe' });

  if (run.exitCode !== 0) throw new Error(`git diff ${ref} exited ${String(run.exitCode)}: ${run.stderr.toString()}`);
  const additions = repo.files.filter((file) => !repo.tracked.has(file));

  return new Set([...run.stdout.toString().split('\0').filter((file) => file !== ''), ...additions]);
}

/**
 * The source rows a change since `ref` can turn red, in deploy order: each whose
 * derived closure holds a changed file, and each whose closure cannot be
 * derived, which nothing proves unaffected. A live row has no closure to judge,
 * so it is named and left out.
 */
function affectedSince(ref: string, repo: Repo): Gate[] {
  const changed = changedSince(ref, repo);
  const affected: Gate[] = [];

  for (const gate of deployOrder().filter((row) => (row.phase ?? 'source') === 'source')) {
    const closure = deriveClosure(gate.run, gate.inputs, repo);

    if (closure.kind === 'live') console.log(`not judged, live: ${gate.run}`);
    else if (closure.kind === 'uncomputable' || closure.files.some((file) => changed.has(file))) affected.push(gate);
  }

  console.log(`affected since ${ref}: ${String(affected.length)} source row(s), by ${String(changed.size)} changed file(s)`);

  return affected;
}

/**
 * Every file a test runner would execute, from the one enumeration.
 *
 * This held its own `/\.test\.(ts|tsx|js)$/` and its own `git ls-files` spawn
 * with an unchecked exit code — a third spelling of a pattern the lint rule
 * owns, over a corpus that silently became empty if git failed. It counted 474
 * files while `no-ambient-git-in-tests` governed 661, so the ladder's
 * monotonicity and orphan assertions could not see an eval suite at all.
 * `isRunnableSuite` is the rule's own basename arm: narrower than the rule on
 * purpose, because `bun test` executes suffixed files and never the helpers
 * beside them, and narrower by IMPORT rather than by a private copy.
 *
 * `isPythonSuite` joins it because a denominator in one language answers the
 * question in one language. `bench/` ships 77 unittest tests across three
 * directories and the ladder's own "every test file is claimed by some runner"
 * assertion could not see any of them, so the answer was yes and the suites ran
 * nowhere. Two predicates, one union, and `bun run gate:python-suites` is what
 * claims the second.
 */
export function trackedTestFiles(): string[] {
  return trackedFiles().filter((file) => isRunnableSuite(file) || isPythonSuite(file));
}

/** The npm script bodies, so a `bun run <key>` gate resolves to what it runs
 *  rather than being treated as opaque. Parsed at the boundary, so a manifest
 *  without a scripts table fails here rather than making every `bun run` gate
 *  silently claim nothing. */
const ManifestSchema = v.object({ scripts: v.record(v.string(), v.string()) });

export function packageScripts() {
  const text = readFileSync(resolve(root, 'package.json'), 'utf8');

  return v.parse(ManifestSchema, JSON.parse(text)).scripts;
}

/**
 * The paths `bun test` refuses to walk into, read from bunfig.toml rather than
 * restated here. Without this, `bun test packages/cf-backend/` reads as
 * claiming `tests/workerd/*.test.ts` — files bun cannot even import, since they
 * pull `cloudflare:workers`. That is a green ladder over a suite that is not
 * executing, which is precisely the defect this file exists to make impossible.
 */
const BunfigSchema = v.object({ test: v.object({ pathIgnorePatterns: v.array(v.string()) }) });

export function bunIgnoredPatterns(): string[] {
  const text = readFileSync(resolve(root, 'bunfig.toml'), 'utf8');

  return v.parse(BunfigSchema, Bun.TOML.parse(text)).test.pathIgnorePatterns;
}

const bunIgnores = bunIgnoredPatterns().map((pattern) => new Bun.Glob(pattern));

export function bunWouldSkip(path: string): boolean {
  return bunIgnores.some((glob) => glob.match(path));
}

/** The flag a row carves a suite out of its own glob with, spelled as bun
 *  spells it. One token, read by {@link claims} and dropped by
 *  {@link runnableArgv}, which re-supplies the resolved set that already has
 *  the subtraction in it. */
export const PATH_IGNORE_FLAG = '--path-ignore-patterns';

/**
 * Which test files a command runs. This is how monotonicity and reachability are
 * decided — comparing command text would call a gate that gained an argument a
 * hole, and would call two spellings of the same suite two different gates.
 *
 * Only the invocation forms this repo actually uses are understood, and an
 * unrecognised form claims NOTHING rather than being assumed to claim
 * everything. An optimistic resolver here would recreate the defect: a gate
 * believed to cover files it never selected.
 */
export function claims(command: string, tracked: readonly string[]): string[] {
  const words = command.split(/\s+/).filter((word) => word.length > 0);

  // The deadline wrapper and the dev-server wrapper each run the command that
  // follows them and claim nothing of their own, so the claim is the wrapped
  // command's.
  if (words[0] === 'bun' && words[1] === 'scripts/ladder.ts' && words[2] === '--run') {
    return claims(words.slice(3).join(' '), tracked);
  }

  if (words[0] === 'bun' && words[1] === DEV_SERVER_WRAPPER) {
    return claims(words.slice(2).join(' '), tracked);
  }

  if (words[0] === 'bun' && words[1] === 'run') {
    const body = packageScripts()[words[2] ?? ''];

    if (body === undefined) return [];

    return [...new Set(body.split('&&').flatMap((part) => claims(part.trim(), tracked)))];
  }

  if (words[0] === 'bun' && words[1] === 'scripts/test-cli.ts') {
    return tracked.filter((path) => path.startsWith(`${CLI_TEST_ROOT}/`) && !bunWouldSkip(path));
  }

  // The PYTHON suites, whose runner is not a JS one. Named like the CLI form
  // above rather than parsed, because `python-suites.ts` derives its own
  // discovery roots from `isPythonSuite` over the same enumeration — so the set
  // this credits and the set that process runs come from one predicate.
  if (words[0] === 'bun' && words[1] === PYTHON_SUITES_SCRIPT) {
    return tracked.filter(isPythonSuite);
  }

  // The LIVE TIER: the bun argv its script runs by default, parsed rather than
  // assumed for the reason `deployGates` is.
  if (words[0] === 'bash' && words[1] === LIVE_TIER_SCRIPT) {
    return claims(['bun', 'test', ...liveTierTargets()].join(' '), tracked);
  }

  // The EVAL SUITE: vitest over the task files, which are exactly the runnable
  // suites no `bun test` can select. The config's `include` is the enforcing half.
  if (runsEvalSuite(words)) return tracked.filter(isVitestEvalSuite);

  if (words[0] === 'node') {
    return words.filter((word) => isRunnableSuite(word) && tracked.includes(word));
  }

  // `vitest run --root R <dir>/` — the workerd layer. Resolved from the command
  // text like every other form, so its files are monotonicity- and
  // reachability-checked rather than exempted. The positional is a filter on
  // top of the config's own `include`, which is the enforcing half; naming it
  // here is what lets this resolver answer without parsing a TS config.
  if (words[0] === 'vitest' && words[1] === 'run') {
    const rootAt = words.indexOf('--root');
    const base = rootAt === -1 ? undefined : words[rootAt + 1];
    // `--exclude <dir>` carves a subdirectory out of a target, which is how the
    // cf-backend workerd tier is split into two rows by path: a file is in
    // exactly one of them because the same prefix is excluded here and
    // targeted there.
    const excludedAt = words.flatMap((word, index) => (word === '--exclude' ? [index + 1] : []));
    const excluded = excludedAt.flatMap((index) => (words[index] === undefined ? [] : [words[index]]));
    const optionValues = new Set([rootAt + 1, ...excludedAt]);
    const targets = words.slice(2).filter((word, index) => !word.startsWith('-') && !optionValues.has(index + 2));

    if (base === undefined || targets.length === 0) return [];

    return tracked.filter((path) => targets.some((target) => path.startsWith(`${base}/${target}`))
      && !excluded.some((prefix) => path.startsWith(`${base}/${prefix}`)));
  }

  if (words[0] !== 'bun' || words[1] !== 'test') return [];
  // Root-relative only. `--cwd` is deliberately NOT understood: it makes bun
  // load a bunfig.toml from that directory instead of the repo root, dropping
  // `preload` and `pathIgnorePatterns` silently, so no gate may use it — and a
  // gate that does claims nothing and fails as an orphan rather than passing.

  // `--path-ignore-patterns=<glob>` carves a named suite out of a family glob,
  // which is how the UI self-tests are two rows: the family claims every
  // `*-ux` suite and this subtracts the one heavy enough to be a row of its
  // own. Matched with `Bun.Glob`, the matcher bun applies to the flag itself,
  // so the set credited here and the set bun runs are one set whether the row
  // reaches bun as resolved argv (this runner) or as bash-expanded words
  // (deploy.sh). A file is then in exactly one of the two rows.
  const ignored = words
    .filter((word) => word.startsWith(`${PATH_IGNORE_FLAG}=`))
    .map((word) => new Bun.Glob(word.slice(PATH_IGNORE_FLAG.length + 1)));

  const targets = words.slice(2).filter((word) => !word.startsWith('-'));
  const claimed: string[] = [];

  for (const target of targets) {
    const clean = target.replace(/^\.\//, '');

    if (clean.includes('*')) {
      const pattern = new RegExp(`^${clean.replace(/[.]/g, '\\.').replace(/\*/g, '[^/]*')}$`);
      claimed.push(...tracked.filter((path) => pattern.test(path)));
      continue;
    }

    if (clean.endsWith('/')) {
      claimed.push(...tracked.filter((path) => path.startsWith(clean)));
      continue;
    }

    if (tracked.includes(clean)) claimed.push(clean);
  }

  // TWO narrowings, and both are what bun would really run. `bunWouldSkip` is
  // the bunfig `pathIgnorePatterns` half; `isBunDiscoverableSuite` is the
  // MATCHER half, and its absence is how `bun test ./tests/` came to be
  // credited with four `.eval.ts` suites bun does not select. A
  // directory target sweeps every tracked path under it, so without this the
  // resolver answered "which files live here" where the question is "which
  // files does this command execute".
  return [...new Set(claimed)]
    .filter((path) => !bunWouldSkip(path) && isBunDiscoverableSuite(path)
      && !ignored.some((glob) => glob.match(path)));
}

/** What a red row that ran to its end found: its exit code, or the processes it left (named above). */
function ranRed(leftovers: readonly string[]): string {
  return leftovers.length === 0
    ? 'the command exited non-zero; its own output is immediately above'
    : `the run left ${String(leftovers.length)} process(es) running after it exited; the LEFT line above names them`;
}

/**
 * The argv to spawn for a gate. `Bun.spawnSync` runs no shell, so a
 * glob-spelled gate reaches `bun test` as a literal FILTER and matches nothing
 * — deploy.sh's globs are expanded by bash and this runner's never were, so
 * `bun test scripts/bench*.test.ts` at the ci tier could not run at all while
 * `claims()` credited it with three files. A gate that cannot run is worse than
 * a gate that cannot fail, because the second at least reports something.
 *
 * Expanded from the same `claims()` resolution the tier is MEASURED with, so
 * the set a gate runs and the set it is credited with are one set by
 * construction rather than two spellings that happen to agree. A glob matching
 * no tracked test file is a fault and says so, never an empty pass.
 */
/** The deadline a package script runs under: its ladder row's when a row runs
 *  `bun run <script>`, and the shared default otherwise. */
export interface ScriptDeadline { readonly seconds: number; readonly label: string }

export function scriptDeadline(script: string | undefined): ScriptDeadline {
  const row = script === undefined ? undefined : LADDER.find((gate) => gate.run === `bun run ${script}`);

  if (row !== undefined) return { seconds: row.deadline?.seconds ?? GATE_DEADLINE_SECONDS, label: row.label };

  return { seconds: GATE_DEADLINE_SECONDS, label: script ?? 'command' };
}

export function runnableArgv(run: string, tracked: readonly string[]): string[] {
  const words = run.split(' ');

  if (!words.some((word) => word.includes('*'))) return words;
  const files = claims(run, tracked);

  if (files.length === 0) throw new Error(`${run} — glob matched no tracked test file`);
  // Every path word is dropped and re-supplied from `claims()`, in that
  // resolution's own order. Hoisting literals ahead of the expansion instead
  // both REORDERED argv against the credited set and spawned an explicitly
  // named suite TWICE, once as the literal and once from the glob that also
  // matched it — so a row mixing a glob with a named file ran one suite twice
  // and compared unequal to the set it is measured as.
  //
  // `--path-ignore-patterns=<suite>` goes with them: its subtraction is
  // already in `claims()`'s answer, and passing it beside an explicit argv
  // would only ask bun to remove a file this list does not contain.
  const flags = words.filter((word) => !word.includes('/') && !word.startsWith(`${PATH_IGNORE_FLAG}=`));

  return [...flags, ...files];
}

/* ── The tier-budget ratchet ────────────────────────────────────────────
 *
 * The commit and push tiers are hooks, and a hook slow enough to tempt
 * `--no-verify` is a design failure — so each tier's declared cost is pinned in
 * `scripts/ladder.lock.json` and a tier that grows past BUDGET_TOLERANCE fails,
 * naming the step that grew most. A re-lock takes `--reason` and records it in
 * the lock, so raising a figure is a decision with a stated cause rather than a
 * number that moved.
 *
 * What the lock pins is the DECLARATION (this file's `seconds`), not a wall
 * clock: a test that ran both tiers and compared walls would take six minutes
 * and fail on machine noise. The declarations are the measured figures — every
 * row carries its own date and box — re-validated 2026-09-05 on the 24-thread
 * workstation (commit walls 36.9–38.0s against 53.24s declared; the push
 * per-gate walls sum to ~360s against 379.71s declared), and the ratchet holds
 * them to what was measured.
 */

/** Declared-cost growth past the locked figure that still passes: 20%.
 *
 * Machine noise on this workstation (12th Gen i9-12900K, 24 threads) measured
 * 2026-09-05 at ~3% across four commit-tier runs (38.0/36.9/37.4/37.7s, load
 * 2.4–4.7): 20% is six times that noise, so a breach means real growth — a new
 * gate, a slower suite — and never a loaded machine. Shrinkage always passes: a
 * tier that got faster is the ratchet working, and the lock is re-pinned
 * opportunistically with the next `--lock`.
 */
export const BUDGET_TOLERANCE = 0.2;

const BUDGET_LOCK = `${root}scripts/ladder.lock.json`;

/** The tiers with a pinned budget: the two hooks. */
const BUDGET_TIERS = ['commit', 'push'] as const;

export type BudgetTier = (typeof BUDGET_TIERS)[number];

const TierBudgetSchema = v.object({
  seconds: v.pipe(v.number(), v.minValue(0)),
  measuredAt: v.pipe(v.string(), v.minLength(1)),
  machine: v.pipe(v.string(), v.minLength(1)),
  steps: v.record(v.string(), v.pipe(v.number(), v.minValue(0))),
});

/**
 * The budget, machine-written by `--lock` and never edited by hand.
 *
 * `reason` is the `--reason` the re-lock was invoked with: what grew and why.
 * `steps` keys are the gate `run` strings, so a lock diff names the gates that
 * moved rather than reporting a bare total.
 */
const LadderBudgetSchema = v.object({
  reason: v.pipe(v.string(), v.minLength(1)),
  tiers: v.object({ commit: TierBudgetSchema, push: TierBudgetSchema }),
});

export type TierBudget = v.InferOutput<typeof TierBudgetSchema>;

export type LadderBudget = v.InferOutput<typeof LadderBudgetSchema>;

export function readBudget(path = BUDGET_LOCK): LadderBudget {
  return v.parse(LadderBudgetSchema, JSON.parse(readFileSync(path, 'utf8')));
}

export function writeBudget(budget: LadderBudget, path = BUDGET_LOCK): number {
  writeFileSync(path, `${JSON.stringify(budget, null, 2)}\n`);

  return Object.keys(budget.tiers.commit.steps).length
    + Object.keys(budget.tiers.push.steps).length;
}

/** Declared cost of one budgeted tier: the total and the per-gate table. */
export interface TierCost {
  readonly total: number;
  readonly steps: Record<string, number>;
}

export function declaredTierCost(tier: BudgetTier): TierCost {
  const steps: Record<string, number> = {};

  for (const gate of gatesFor(tier)) steps[gate.run] = gate.seconds;

  return {
    total: Object.values(steps).reduce((sum, seconds) => sum + seconds, 0),
    steps,
  };
}

/** One tier whose declared cost outgrew its locked figure. */
export interface BudgetBreach {
  readonly tier: BudgetTier;
  readonly locked: number;
  readonly declared: number;
  /** The locked step whose declaration grew most. */
  readonly step: string;
  readonly stepWas: number;
  readonly stepNow: number;
}

export function judgeBudgets(
  declared: Record<BudgetTier, TierCost>,
  budget: LadderBudget,
): BudgetBreach[] {
  const breaches: BudgetBreach[] = [];

  for (const tier of BUDGET_TIERS) {
    const locked = budget.tiers[tier];
    const current = declared[tier];
    // A lock that pins nothing cannot fail. See `assertMeasured`'s own
    // docstring: a gate over an empty corpus reports the healthiest number.
    assertMeasured(`ladder-budget (${tier})`, [
      ['declared steps', Object.keys(current.steps).length],
      ['locked steps', Object.keys(locked.steps).length],
      ['locked seconds', locked.seconds],
    ]);

    if (current.total <= locked.seconds * (1 + BUDGET_TOLERANCE)) continue;
    let step = '';
    let stepWas = 0;
    let stepNow = 0;
    let growth = Number.NEGATIVE_INFINITY;

    for (const [name, seconds] of Object.entries(current.steps)) {
      const was = locked.steps[name] ?? 0;

      if (seconds - was > growth) {
        growth = seconds - was;
        step = name;
        stepWas = was;
        stepNow = seconds;
      }
    }

    breaches.push({
      tier, locked: locked.seconds, declared: current.total, step, stepWas, stepNow,
    });
  }

  return breaches;
}

/**
 * What this check cannot see, printed on the GREEN path.
 *
 * A budget that reports a cheap tree while saying nothing about what it never
 * timed is how a number gets trusted for a property it never had.
 */
export const BUDGET_BLIND_SPOTS: readonly string[] = [
  'WALL CLOCK — NOT COMPARED. This judges declarations against the lock, so a gate '
  + 'that slows without its row updated passes until somebody re-measures. Run the tier '
  + '— the ladder prints each gate\'s own wall seconds — and re-lock with the reason.',
  'PER-GATE GROWTH — NOT BOUNDED, only reported. One gate may double while another '
  + 'shrinks and the tier still passes; the failure names the step that grew most, and '
  + 'reviewing the lock diff is what catches a quiet doubling.',
  'SHRINKAGE — DELIBERATELY UNGOVERNED. A faster tier passes, and the lock is re-pinned '
  + 'opportunistically rather than demanded: the ratchet points one way.',
  'COLD HOOKS — NOT MEASURED. The pinned figures are warm-cache walls on a quiet box; '
  + 'the first hook after a boot or under heavy contention can exceed them, and the '
  + '20% tolerance is what covers that instead of a second set of figures.',
];

function printMatrix(): void {
  const all = gatesFor('deploy');
  const tracked = trackedTestFiles();
  const width = Math.max(...all.map((gate) => gate.run.length));
  console.log(`${'gate'.padEnd(width)}  ${TIERS.map((tier) => tier.padEnd(7)).join('')}cost    files`);

  for (const gate of all) {
    const at = TIERS.indexOf(gate.tier);
    const cells = TIERS.map((_, index) => (index >= at ? 'yes    ' : '-      ')).join('');
    const note = gate.run in CI_EXEMPT ? '  ci-exempt' : '';
    const files = claims(gate.run, tracked).length;
    console.log(
      `${gate.run.padEnd(width)}  ${cells}${gate.seconds.toFixed(1)}s`.padEnd(width + 39)
      + `${String(files).padStart(4)}${note}`,
    );
  }

  console.log('');

  for (const tier of TIERS) {
    const gates = gatesFor(tier).filter((gate) => tier === 'deploy' || !(gate.run in CI_EXEMPT));
    const cost = gates.reduce((sum, gate) => sum + gate.seconds, 0);
    const files = new Set(gates.flatMap((gate) => claims(gate.run, tracked)));
    console.log(
      `${tier.padEnd(7)} ${String(gates.length).padStart(2)} gates  ${cost.toFixed(0).padStart(3)}s declared  `
      + `${String(files.size).padStart(3)}/${String(tracked.length)} test files`,
    );
  }
}

/** Record one green run, and name the cache's reason when it declines. */
function recordProof(
  plan: Extract<Plan, { kind: 'miss' }>,
  gate: GateCacheRequest,
  result: { readonly seconds: number; readonly revision: string },
): boolean {
  const refused = recordGreen(plan, gate, result);

  if (refused !== undefined) console.log(`      not recorded: ${refused}`);

  return refused === undefined;
}

if (import.meta.main) {
  // A CLOSED REPORTING CHANNEL IS NOT A FAILED TIER.
  //
  // Gates run with `stdout: 'inherit'`, so under `git push` the whole tier
  // writes into the pipe git gives its pre-push hook — 16,650 lines, measured
  // 2026-09-03. Git stops reading before the end, the next write raises EPIPE,
  // and the process dies of SIGPIPE with status 141. That refused a push whose
  // 42 gates had all just passed, three times in one evening, and it read as a
  // gate failure with no failing gate named.
  //
  // The tier's verdict lives in the gate exit codes below. Losing the reader
  // for the transcript is a value: reporting stops, the verdict stands.
  process.stdout.on('error', (cause: NodeJS.ErrnoException) => {
    if (cause.code !== 'EPIPE') throw cause;
  });
  process.stderr.on('error', (cause: NodeJS.ErrnoException) => {
    if (cause.code !== 'EPIPE') throw cause;
  });

  // `--run <argv…>`: run a package script's command under its own row's
  // deadline. `bun run` sets `npm_lifecycle_event` to the script's name, so
  // the script needs no argument to find its row; a script no row runs gets
  // the shared default. The hand run and the ladder row are one figure. It is
  // the first branch, so a wrapped command's closure is the wrapper's graph
  // loaded and nothing another mode reads (`RUNNER_SCRIPT`, ladder-closure.ts).
  const runAt = process.argv.indexOf('--run');

  if (runAt !== -1) {
    const argv = process.argv.slice(runAt + 1);

    if (argv.length === 0) {
      console.error('usage: bun scripts/ladder.ts --run <command…>');
      process.exit(2);
    }

    const outcome = await runUnderDeadline({ argv, ...scriptDeadline(process.env.npm_lifecycle_event) });
    process.exit(outcome.exitCode);
  }

  if (process.argv.includes('--plan')) {
    console.log(printPlan(deployPlan()));
    process.exit(0);
  }

  if (process.argv.includes('--matrix')) {
    printMatrix();
    process.exit(0);
  }

  // The measured table as a reader sees it, heaviest first, with the two
  // figures the wave admits against and the deadline each row's SOLO wall is
  // measured against. A row near its own deadline alone is reported, never
  // fixed by moving the deadline.
  if (process.argv.includes('--costs')) {
    const plan = deployPlan();
    const costs = readCosts();
    const width = Math.max(...plan.map((row) => row.label.length));
    console.log(`${costs.measuredAt}  ${costs.machine}`);
    console.log(`${'row'.padEnd(width)}  thr   MiB      wall      cpu   deadline`);

    for (const row of [...plan].sort((left, right) => right.rssMb - left.rssMb)) {
      const cost = costs.rows[row.run];

      if (cost === undefined) {
        console.log(`${row.label.padEnd(width)}    -     -         -        -   ${String(row.deadline).padStart(4)}s  unmeasured, runs alone`);
        continue;
      }

      console.log(
        `${row.label.padEnd(width)}  ${String(row.threads).padStart(3)}  ${String(row.rssMb).padStart(5)}  `
        + `${cost.wallSeconds.toFixed(1).padStart(8)}s ${cost.cpuSeconds.toFixed(1).padStart(8)}s  ${String(row.deadline).padStart(4)}s`
        + (cost.wallSeconds > row.deadline * 0.8 ? `  ⚠ ${(cost.wallSeconds / row.deadline * 100).toFixed(0)}% ALONE` : ''),
      );
    }

    const source = plan.filter((row) => row.phase === 'source');
    console.log(
      `\nsource wave: ${String(source.length)} rows, `
      + `${String(source.reduce((sum, row) => sum + row.threads, 0))} threads and `
      + `${String(source.reduce((sum, row) => sum + row.rssMb, 0))} MiB if every row ran at once; `
      + `this box offers ${String(cpus().length)} threads`,
    );
    process.exit(0);
  }

  // A hook nobody installs is a hook that does not exist. `core.hooksPath`
  // started out as an ABSOLUTE path to the main checkout's `.git/hooks`, which
  // is untracked and holds only samples — so all 42 worktrees pointed at one
  // empty directory and both cheap tiers were decorative.
  //
  // The path written here is RELATIVE on purpose, and that is the whole trick:
  // git resolves a relative core.hooksPath against each working tree's own
  // root, and worktrees SHARE this config, so one invocation makes the tiers
  // real in every checkout at once instead of in the one where somebody
  // remembered to run an installer. Proven: a probe hook placed in a
  // worktree's own .githooks ran and blocked a commit there, with the value set
  // only once, here.
  if (process.argv.includes('--install-hooks')) {
    const set = Bun.spawnSync(['git', 'config', 'core.hooksPath', HOOKS_DIR], { cwd: root });

    if (set.exitCode !== 0) {
      console.error('ladder: could not set core.hooksPath');
      process.exit(1);
    }

    console.log(
      `ladder: core.hooksPath = ${HOOKS_DIR} (relative, so every worktree resolves its own) `
      + '— pre-commit runs the commit tier, pre-push the push tier, commit-msg the message rules',
    );
    process.exit(0);
  }

  // THE CLOSURE AUDIT. Every cacheable gate in the tier — or the one row
  // `--gate` names — runs once under strace in the environment the ladder
  // gives it, and every tree file it opened that its closure does not hold is
  // a finding. This is the measurement behind a `reads` declaration, and the
  // red direction of the cache's soundness: a closure that errs narrow is a
  // stale green, and this is the one place that can see it.
  if (process.argv.includes('--audit-closure')) {
    const flag = process.argv.find((argument) => argument.startsWith('--tier='));
    const tier = TIERS.find((candidate) => candidate === flag?.slice('--tier='.length)) ?? 'push';
    const named = process.argv.indexOf('--gate');
    const repo = repoAt(root, (run, files) => claims(run, files));
    const tracked = trackedTestFiles();

    const gates = named === -1
      ? gatesFor(tier).filter((gate) => tier === 'deploy' || !(gate.run in CI_EXEMPT))
      : LADDER.filter((gate) => gate.run === process.argv[named + 1]);

    if (gates.length === 0) {
      console.error('ladder --audit-closure --gate: expected an exact command from the declared gate table');
      process.exit(2);
    }

    let holes = 0;
    let audited = 0;
    let unproven = 0;

    for (const gate of gates) {
      const closure = deriveClosure(gate.run, gate.inputs, repo);

      if (closure.kind !== 'derived') {
        console.log(`skip  ${gate.run}  (${closure.kind}: ${closure.why})`);
        continue;
      }

      const audit = auditClosure(runnableArgv(gate.run, tracked), root, closure, gateEnvironment(closure));
      audited += 1;

      // A run that failed stopped short of what a green one opens, so its trace proves nothing about one.
      if (audit.exitCode !== 0) {
        unproven += 1;
        console.error(`RED   ${gate.run}  exited ${String(audit.exitCode)} under the trace: a partial run's opens prove nothing`);
      }

      if (audit.undeclared.length > 0) {
        holes += 1;
        console.error(`HOLE  ${gate.run}  opened ${String(audit.undeclared.length)} file(s) its closure does not hold:\n`
          + audit.undeclared.map((file) => `        ${file}`).join('\n'));
      } else if (audit.exitCode === 0) {
        console.log(`ok    ${gate.run}  (${String(audit.covered)} closure files opened, ${String(audit.outside)} outside the tree)`);
      }
    }

    console.log(
      `\naudit-closure ${named === -1 ? `--tier=${tier}` : '--gate'}: ${String(audited)} gate(s) audited, `
      + `${String(holes)} with undeclared reads, ${String(unproven)} red under the trace`,
    );
    process.exit(holes === 0 && unproven === 0 ? 0 : 1);
  }

  if (process.argv.includes('--check-budget')) {
    const budget = readBudget();

    const declared = {
      commit: declaredTierCost('commit'),
      push: declaredTierCost('push'),
    };

    const breaches = judgeBudgets(declared, budget);

    for (const tier of BUDGET_TIERS) {
      console.log(
        `${tier}: ${declared[tier].total.toFixed(1)}s declared across `
        + `${String(Object.keys(declared[tier].steps).length)} gates, locked at `
        + `${budget.tiers[tier].seconds.toFixed(1)}s (${budget.tiers[tier].measuredAt})`,
      );
    }

    if (breaches.length === 0) {
      const stale = BUDGET_TIERS.flatMap((tier) => Object.entries(budget.tiers[tier].steps)
        .filter(([name]) => !(name in declared[tier].steps))
        .map(([name, was]) => `${tier}: ${name} (locked at ${String(was)}s, no longer a gate)`));

      console.log('\nladder-budget: ok — both tiers within tolerance of the locked figures');
      console.log(`  locked: ${budget.reason}`);

      for (const line of stale) console.log(`  stale: ${line} — re-lock to drop it`);

      for (const spot of BUDGET_BLIND_SPOTS) console.log(`  blind: ${spot}`);
      process.exit(0);
    }

    for (const breach of breaches) {
      console.error(finding({
        at: `${breach.tier} tier: ${breach.declared.toFixed(1)}s declared vs `
        + `${breach.locked.toFixed(1)}s locked`,
        invariant: 'a tier\'s declared cost stays within '
        + `${String(Math.round(BUDGET_TOLERANCE * 100))}% of its locked figure`,
        found: `${breach.step} declares ${String(breach.stepNow)}s, locked at ${String(breach.stepWas)}s`,
        silently: 'the hooks get slower one gate at a time and no reading of the tree ever '
        + 'says so, which is how the push tier reached 380s while the budget still read 126.4s',
        fix: 'take the growth back out, or re-lock with '
        + '`bun scripts/ladder.ts --lock --reason="<what grew and why>"` and argue the reason '
        + 'in the commit body',
      }));
    }

    process.exit(1);
  }

  if (process.argv.includes('--lock')) {
    const reason = process.argv
      .find((argument) => argument.startsWith('--reason='))
      ?.slice('--reason='.length)
      .trim() ?? '';

    if (reason.length === 0) {
      console.error(
        'ladder --lock: refusing without --reason=<what grew and why>. The reason lands in '
        + 'scripts/ladder.lock.json beside the new figures, so a re-lock is a decision with '
        + 'a stated cause rather than a number that moved.',
      );
      process.exit(2);
    }

    const machine = machineName();

    const today = new Date().toISOString().slice(0, 10);
    const commit = declaredTierCost('commit');
    const push = declaredTierCost('push');

    const count = writeBudget({
      reason,
      tiers: {
        commit: {
          seconds: Math.round(commit.total * 100) / 100,
          measuredAt: today,
          machine,
          steps: commit.steps,
        },
        push: {
          seconds: Math.round(push.total * 100) / 100,
          measuredAt: today,
          machine,
          steps: push.steps,
        },
      },
    });

    console.log(`ladder --lock: pinned ${String(count)} gate cost(s) — ${reason}`);
    process.exit(0);
  }

  const gateAt = process.argv.indexOf('--gate');
  const selectedGate = gateAt === -1 ? undefined : LADDER.find((gate) => gate.run === process.argv[gateAt + 1]);

  if (gateAt !== -1 && selectedGate === undefined) {
    console.error('ladder --gate: expected an exact command from the declared gate table');
    process.exit(2);
  }

  // `--affected=<ref>`: the source rows a change since `ref` can turn red, each
  // run as `--gate` runs one, so a lane proves a change before it sends it.
  const affectedFrom = process.argv.find((argument) => argument.startsWith('--affected='))?.slice('--affected='.length);
  const flag = process.argv.find((argument) => argument.startsWith('--tier='));
  const asked = selectedGate === undefined && affectedFrom === undefined ? flag?.slice('--tier='.length) : 'deploy';
  const tier = TIERS.find((candidate) => candidate === asked);

  if (tier === undefined || affectedFrom === '') {
    console.error(
      `usage: bun scripts/ladder.ts --tier=${TIERS.join('|')} [--no-cache] | --gate <declared-command> | --affected=<ref> | --plan | --audit-closure [--tier=<tier> | --gate <declared-command>] | --matrix | --costs | --install-hooks | --check-budget | --lock --reason="<what grew and why>"`,
    );
    process.exit(2);
  }

  const repo = repoAt(root, (run, files) => claims(run, files));

  const declared = selectedGate === undefined
    ? gatesFor(tier).filter((gate) => tier === 'deploy' || !(gate.run in CI_EXEMPT))
    : [selectedGate];

  const gates = affectedFrom === undefined ? declared : affectedSince(affectedFrom, repo);

  const measured = assertMeasured(`ladder --tier=${tier}`, [
    ['gates in this tier', gates.length],
    ['gates in the deploy plan', deployOrder().length],
  ]);

  // A ladder is a description; something has to make it true. This repo has
  // shipped seven gates that existed and were not wired, so the ladder states
  // whether its own two cheapest tiers actually execute rather than leaving
  // that green by absence. It is a report, not a verdict: a CI or deploy
  // checkout never commits, so an uninstalled hook there is not a fault, and a
  // gate that fails for a non-fault is a gate that gets weakened.
  const configured = Bun.spawnSync(['git', 'config', '--get', 'core.hooksPath'], {
    cwd: root, stdout: 'pipe',
  }).stdout.toString().trim();

  console.log(
    configured === HOOKS_DIR
      ? `hooks: installed (${HOOKS_DIR}) — pre-commit runs the commit tier, pre-push the push tier, commit-msg the message rules`
      : `hooks: NOT INSTALLED — core.hooksPath is "${configured}", so the commit and push `
        + 'tiers do not execute in this checkout. Fix: bun scripts/ladder.ts --install-hooks',
  );

  const started = performance.now();
  const tracked = trackedTestFiles();

  // THE CACHE. A green gate is skipped only on a proof that nothing it can
  // read has changed: a content hash over its derived input closure
  // (`ladder-closure.ts`) looked up in a store outside the tree
  // (`ladder-cache.ts`). `--no-cache` runs every gate regardless; nothing
  // else does, and there is no per-gate switch. A row declared `live`, or
  // whose closure cannot be computed, runs every time and the reason is
  // printed beside it, so an uncached gate is a visible fact rather than a
  // quiet one. A derived gate runs under exactly the environment its key
  // hashes, cache or `--no-cache`, so a recorded verdict and a fresh one are
  // taken in one environment.
  const caching = !process.argv.includes('--no-cache');
  const tools = toolVersions(root);
  const store = storeAt(defaultStoreDirectory());
  const revision = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { cwd: root, stdout: 'pipe' }).stdout.toString().trim();
  const skipped: string[] = [];
  const uncached: string[] = [];
  const recorded: string[] = [];
  const notes = new Set<string>();

  for (const [index, gate] of gates.entries()) {
    console.log(`\n── ${tier} ${String(index + 1)}/${String(gates.length)}: ${gate.run}`);
    const plan = caching ? planGate({ run: gate.run, inputs: gate.inputs, repo, tools, store }) : undefined;

    if (plan?.kind === 'hit') {
      // deploy.sh reads the `skip  ` prefix to mark the gate's line cached.
      console.log(
        `skip  ${gate.run}  hit ${plan.key.slice(0, 12)}, proved green on ${plan.entry.revision} `
        + `(${String(plan.entry.closureSize)} files in the closure, ${plan.entry.seconds.toFixed(1)}s then)`,
      );
      skipped.push(gate.run);
      continue;
    }

    if (plan?.kind === 'uncacheable') {
      console.log(`      never cached: ${plan.closure.why}`);
      uncached.push(`${gate.run} — ${plan.closure.why}`);
    } else if (plan?.kind === 'miss') {
      console.log(
        `      miss ${plan.key.slice(0, 12)} (${String(plan.closure.files.length)} files in the closure, `
        + `${String(gateEnvNames(plan.closure).length)} environment names given)`,
      );

      if (plan.unreadable !== undefined) console.log(`      the entry stored under this key proves nothing — ${plan.unreadable}`);

      for (const note of plan.closure.notes) notes.add(`${gate.run}: ${note}`);
    }

    const closure = plan?.closure ?? deriveClosure(gate.run, gate.inputs, repo);

    // Under the row's own deadline: the one hang detector this tier has,
    // now that no test carries a clock. A row that hangs is killed and named
    // here instead of holding the hook — and `git push` — open forever.
    const outcome = await runUnderDeadline({
      argv: runnableArgv(gate.run, tracked), cwd: root,
      seconds: gate.deadline?.seconds ?? GATE_DEADLINE_SECONDS, label: gate.label,
      env: closure.kind === 'derived' ? gateEnvironment(closure) : undefined,
    });

    const { seconds } = outcome;

    if (outcome.exitCode === 0) {
      console.log(`ok  ${gate.run}  (${seconds.toFixed(1)}s)`);

      // Only a miss re-enumerates the tree: `recordGreen` re-derives the
      // closure from what is on disk NOW, and no other path reads it.
      const proofRecorded = plan?.kind === 'miss' && recordProof(
        plan,
        { run: gate.run, inputs: gate.inputs, repo: repoAt(root, (run, files) => claims(run, files)), tools, store },
        { seconds, revision },
      );

      if (proofRecorded) recorded.push(gate.run);

      continue;
    }

    console.error(`\nFAILED  ${gate.run}  after ${seconds.toFixed(1)}s\n`);
    console.error(finding({
      at: gate.run,
      invariant: gate.catches,
      found: outcome.exitCode === DEADLINE_EXIT_CODE
        ? `the run hung and was killed at the row's ${String(gate.deadline?.seconds ?? GATE_DEADLINE_SECONDS)}s deadline; its own output is immediately above`
        : ranRed(outcome.leftovers),
      silently: `every later tier assumes this held. What this gate does NOT cover: ${gate.blind}`,
      fix: `${gate.run}   # reproduce exactly this, nothing else`,
    }));
    process.exit(1);
  }

  if (caching) {
    console.log(
      `\ncache: ${String(skipped.length)} hit, ${String(recorded.length)} recorded, `
      + `${String(uncached.length)} never cached, store ${store.directory}`,
    );

    for (const line of uncached) console.log(`  never: ${line}`);

    for (const note of notes) console.log(`  note: ${note}`);

    for (const spot of CACHE_BLIND_SPOTS) console.log(`  blind: ${spot}`);
  }

  for (const spot of LEFTOVER_BLIND_SPOTS) console.log(`  blind: ${spot}`);

  console.log(
    `\nladder --tier=${tier}: ok — ${measured}, ${((performance.now() - started) / 1000).toFixed(1)}s`,
  );
}
