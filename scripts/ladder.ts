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

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as v from 'valibot';
import { assertMeasured, finding } from './gate-ratchet.ts';

const root = new URL('..', import.meta.url).pathname;
/** Where the tracked hooks live, RELATIVE so git resolves it against each
 *  worktree's own root — see `--install-hooks`. */
export const HOOKS_DIR = '.githooks';


export const TIERS = ['commit', 'push', 'ci', 'deploy'] as const;
export type Tier = (typeof TIERS)[number];

export interface Gate {
  /** The exact command as invoked. Where deploy.sh runs the same gate, spelled
   *  identically to its `run_required_gate` line. */
  readonly run: string;
  /** The cheapest tier that runs it. Every later tier runs it too. */
  readonly tier: Tier;
  /** Measured wall clock in seconds, 12-core box, 2026-08-17. */
  readonly seconds: number;
  /** The defect class this makes impossible. Not what it "checks". */
  readonly catches: string;
  /** What it does NOT catch. A gate whose blind spot nobody wrote down gets
   *  trusted for things it never looked at — which this repo has shipped three
   *  times. */
  readonly blind: string;
}

/** Gates that run before the deploy tier. The deploy tier is parsed from
 *  deploy.sh — see the header. Cheapest first inside each tier, so the first
 *  failure is also the fastest to reproduce. */
export const LADDER: readonly Gate[] = [
  {
    run: 'bun scripts/preflight.ts',
    tier: 'commit',
    seconds: 0.12,
    catches: 'a gate reporting on an environment nobody looked at: exhausted temp '
      + 'inodes, or a stray project marker that makes a checkpoint working directory '
      + 'unbounded. Both had already turned deploy gate 6 red for reasons unrelated to '
      + 'any change under test, and both presented as "this test timed out after 5000ms".',
    blind: 'anything inside the repository. It only reads the machine.',
  },
  {
    run: 'bun run check',
    tier: 'commit',
    seconds: 6.8,
    catches: 'type errors and the 15 anti-slop rules across all 8 projects. The largest '
      + 'defect class by volume and the only total one — every file, every line.',
    blind: 'everything about behaviour. A well-typed call to the wrong function passes.',
  },
  {
    run: 'bun run gate:do-init',
    tier: 'commit',
    seconds: 0.1,
    catches: 'off-object I/O inside a Durable Object `onStart`, which put a pure SELECT '
      + 'at 25s and, past 31s, RESET the object. That invariant held at the method and '
      + 'was defeated at the object.',
    blind: 'I/O added on any other DO lifecycle path.',
  },
  {
    run: 'bun run gate:duplication',
    tier: 'commit',
    seconds: 1.1,
    catches: 'a second implementation of an existing function body, including one with '
      + 'every identifier renamed — the mechanism behind "X never worked in Y backend".',
    blind: 'duplication refactored enough to differ structurally, and duplicated '
      + '*policy* expressed in different code.',
  },
  {
    run: 'bun run gate:reachability',
    tier: 'commit',
    seconds: 1,
    catches: 'an @callable RPC no caller reaches — the "correct, wired, dead" class this '
      + 'codebase has shipped at least ten times.',
    blind: 'a reachable RPC whose result nobody reads.',
  },
  {
    run: 'bun run gate:platform',
    tier: 'commit',
    seconds: 0.07,
    catches: 'a platform number stated in prose with no catalog id behind it, and a '
      + 'catalog entry with no evidence label or provenance.',
    blind: 'whether the catalogued number is still true.',
  },
  {
    run: 'bun run gate:egress-interception',
    tier: 'commit',
    seconds: 0.1,
    catches: 'a container class that lost `enableInternet = false` or '
      + '`interceptHttps = true`, a Worker entry that stopped exporting '
      + 'ContainerProxy, or a catch-all egress handler nobody binds — each one an '
      + 'un-intercepted way out of a container whose secrets have been replaced '
      + 'by placeholders.',
    blind: 'whether interception actually engages at runtime, and DNS, which '
      + 'leaves regardless and which the gate reports as a known residual '
      + 'rather than closing.',
  },
  {
    run: 'bun run gate:typecheck-coverage',
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
  },
  {
    run: 'bun run gate:skip-ratchet',
    tier: 'commit',
    seconds: 0.3,
    catches: 'a test that starts skipping, and a declared skip that has started running '
      + 'without the lock being tightened. `bun test ./tests/` reports 23 skips and exits '
      + '0, and that exit code is all anyone reads — so the skipped set is locked with a '
      + 'written reason per entry. Locking the SET rather than a count is what makes it '
      + 'work: a count of 23 cannot tell you a different 23 are skipping now. It also '
      + 'asserts every target contributed a test, because `bun test tests` and `bun test '
      + 'tests/` both match NOTHING here and only `./tests/` selects them.',
    blind: 'whether a running test asserts anything real. A skip is visible now; a '
      + 'vacuous pass is the next tier\'s problem.',
  },

  {
    run: 'bun run gate:dead-code',
    tier: 'push',
    seconds: 5.5,
    catches: 'an export referenced only by its own test, and a file no entry point '
      + 'reaches at all. `ensureActorSchema` was the first of ten.',
    blind: 'a symbol referenced from live code that does nothing.',
  },
  {
    run: 'bun scripts/secret-scan.ts',
    tier: 'push',
    seconds: 2,
    catches: 'a credential about to leave the machine. Push is the last tier where that '
      + 'is recoverable without a rotation.',
    blind: 'a secret already in history.',
  },
  {
    run: 'bun scripts/schema-drift.ts',
    tier: 'push',
    seconds: 2,
    catches: 'a table or column the code writes and the schema does not declare — the '
      + 'shape `code_language` shipped in, with no backfill.',
    blind: 'a column that exists and is never written; that is dead-field territory.',
  },
  {
    run: 'bun test scripts/gates.test.ts scripts/reachability.test.ts scripts/do-init-gate.test.ts scripts/platform-catalog.test.ts scripts/policy-drift.test.ts',
    tier: 'push',
    seconds: 1,
    catches: 'a gate whose decision boundary someone simplified. These are the tests '
      + 'that fail when a fingerprint stops distinguishing a renamed copy from a '
      + 'genuinely different body.',
    blind: 'whether the gates are wired into any tier at all — that is ladder.test.ts.',
  },
  {
    run: 'bun test scripts/skip-ratchet.test.ts scripts/typecheck-coverage.test.ts',
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
  },
  {
    run: 'bun test scripts/ladder.test.ts',
    tier: 'push',
    seconds: 1,
    catches: 'a gate that runs at only one tier by accident, a deploy gate CI silently '
      + 'skips, and a test file no tier claims. The defect this whole file addresses.',
    blind: 'whether any individual gate can actually fail. That is each gate\'s own '
      + 'self-test, and the seeded tier nobody has paid for yet.',
  },
  {
    run: 'bun test scripts/deploy.test.ts',
    tier: 'push',
    seconds: 1,
    catches: 'a deploy gate deleted, reordered, or made skippable, and a deploy from a '
      + 'dirty checkout. Cut-the-wire proven: remove one gate line and it fails.',
    blind: 'whether the gates it enumerates pass.',
  },
  {
    run: 'bun test scripts/secret-scan.test.ts',
    tier: 'push',
    seconds: 1,
    catches: 'a secret scanner that stopped matching. The scanner passing means nothing '
      + 'until this says it still recognises a planted credential.',
    blind: 'credential shapes nobody wrote a case for.',
  },
  {
    run: 'bun run test',
    tier: 'push',
    seconds: 24,
    catches: 'behavioural regressions in agent-utils, core and compaction: 3,105 tests, '
      + 'the whole shared spine both backends run on. Every gate on this list spells '
      + 'its suite ROOT-RELATIVE (`bun test packages/x/`) rather than `--cwd packages/x`: '
      + 'measured 2026-08-17, `--cwd` makes bun read a bunfig.toml from THAT directory, '
      + 'so the root one is not loaded and both `preload` and `pathIgnorePatterns` are '
      + 'silently dropped. A probe printed `PROTEUS_HOME= undefined` under `--cwd` and a '
      + 'real temp home root-relative — meaning the throwaway home that exists because '
      + 'cli-backend once wrote ~580 checkpoint stores into a developer\'s real ~/.proteus '
      + 'was reaching NO per-package gate.',
    blind: 'both backend composition roots, and every subprocess path. It also covers '
      + 'only 3 of the 8 workspace packages — see ROOT_TEST_OMISSIONS in ladder.test.ts, '
      + 'which pins the other 5 by equality with the gate that does run each.',
  },
  {
    run: 'bun test packages/test-utils/',
    tier: 'push',
    seconds: 0.2,
    catches: 'a broken source-slicing helper. Three wiring suites once asserted against '
      + 'whole files instead of the members they named because this was untested.',
    blind: 'the suites that use it.',
  },
  {
    run: 'bun test packages/cf-backend/',
    tier: 'push',
    seconds: 13,
    catches: 'the Cloudflare composition root observed against the capability manifest '
      + '— the conformance gate.',
    blind: 'anything needing a Workers runtime rather than a composition root — every '
      + 'test here mocks the Agent SDK (`tests/helpers/agents-sdk.ts`) and runs under '
      + 'bun, which is why `bun run test:workerd` exists below.',
  },

  {
    run: 'bun test packages/cli-backend/',
    tier: 'ci',
    seconds: 41,
    catches: 'the local composition root and its conformance gate, plus the real host '
      + 'filesystem and checkpoint paths.',
    blind: 'the CLI surface above it.',
  },
  {
    run: 'bun test packages/cli/',
    tier: 'ci',
    seconds: 92,
    catches: 'the production CLI end to end, including the PTY and subprocess paths. 41 '
      + 'of these 42 files run in no other tier today. Measured headless (setsid, no '
      + 'tty): 295 pass, 0 fail — the "PTY tests need a terminal" exclusion was stale, '
      + 'true only before 5183d69d.',
    blind: 'nothing in its own surface. It is the slowest thing here: 54% of the suite\'s '
      + 'wall clock for 7.5% of its tests, which is why it is not earlier.',
  },
  {
    run: 'bun test packages/pc-agent/',
    tier: 'ci',
    seconds: 0.3,
    catches: 'the local-device daemon, 6 tests. Runs in no tier today — `bun run check` '
      + 'only `node --check`s its syntax.',
    blind: 'the pairing and transport it talks to.',
  },
  {
    run: 'bun scripts/tracing-gate.ts',
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
  },
  {
    run: 'bun test ./tests/',
    tier: 'ci',
    seconds: 0.3,
    catches: 'the root end-to-end and eval suites parsing, constructing their workspaces '
      + 'and reaching their skip decision, credential-free — 27 tests, 23 of which skip '
      + 'without a live-model target. Kept beside `test:eval` deliberately: this is the '
      + 'run that needs no secret, so it is the one that reproduces anywhere, and '
      + '`gate:skip-ratchet` is what turns its 23 skips from an invisible exit 0 into a '
      + 'locked, reasoned list. Note the path form: `bun test tests` silently matches '
      + 'NOTHING, and `bun test tests/` also matches nothing — only `./tests/` selects '
      + 'them, which is exactly the kind of silent zero this ladder asserts against.',
    blind: 'everything it skips, which is most of it — declared, not hidden. It also '
      + 'cannot see a suite whose code no longer compiles, because bun strips types; '
      + 'that is `gate:typecheck-coverage` plus `tsc -p tests`, and the absence of both '
      + 'is how these four suites came to call two deleted APIs.',
  },
  {
    run: 'bun run test:eval',
    tier: 'ci',
    seconds: 0.3,
    catches: 'the behavioural evidence nothing else in this ladder can produce: whether '
      + 'the agent reaches for MCTS on a task that warrants it, whether a search opens '
      + 'more than one branch and leaves a DURABLY ranked winner, whether every settle '
      + 'mode writes where the Exploration reader reads, and what fraction of eligible '
      + 'turns convert to a delegation. Each score reports its denominator, and each '
      + 'assertion checks that denominator is non-zero BEFORE anything else, because '
      + '"0 of 0 searches were unranked" is the shape of a check that cannot fail. The '
      + '0.3s figure is the credential-free path where everything skips; with a target '
      + 'set it is minutes and the script prints the measured token cost.',
    blind: 'the cf runtime. These drive core and the CLI\'s local session in-process, so '
      + 'a defect that only appears in workerd — a rejected cross-DO RPC inside '
      + 'background work that only console.warns — is invisible here by construction. '
      + 'That is the workerd layer\'s job, not this one\'s.',
  },
  {
    run: 'bun test scripts/eval.test.ts',
    tier: 'ci',
    seconds: 1,
    catches: 'the eval gate\'s own logic, credential-free. The live-model benchmark runs '
      + 'in the separate gated eval.yml.',
    blind: 'anything a model actually does.',
  },
  {
    run: 'bun test scripts/bench*.test.ts',
    tier: 'ci',
    seconds: 5.2,
    catches: 'the bench harness guarantees — sandbox isolation, the seal, '
      + 'anti-self-scoring, budget enforcement, corpus well-formedness — plus the '
      + 'assertion that every seeded defect patch still applies to the tree it was '
      + 'measured against. 68 tests, no model, no credentials.',
    blind: 'anything about what the bench measures. It only guards the instrument, '
      + 'which is what four independent instrument bugs cost us to learn.',
  },
  {
    run: 'bun test scripts/chat-and-files-ux.test.ts scripts/computed-style.test.ts',
    tier: 'ci',
    seconds: 31.9,
    catches: 'the two UI gates\' own decision logic, including the one that would have '
      + 'caught `--radius` being undefined at `:root` while 191 `rounded-*` sites '
      + 'computed 0px. Both self-tests ran in NO tier until this line: the gates were '
      + 'built, deliberately kept off the deploy path for their Chrome cost, and their '
      + 'logic was then guarded by nothing anywhere.',
    blind: 'the gallery render itself. `gate:computed-style` boots vite and Chrome over '
      + '19 frames at ~68s and stays a standalone run — a gate that fails because Chrome '
      + 'is missing fails for a reason unrelated to the change under test.',
  },
  {
    run: 'bun run layergate',
    tier: 'ci',
    seconds: 25,
    catches: 'per-layer behavioural drift against a locked baseline, 18 measured layers. '
      + 'Runs in no tier today.',
    blind: '`tool-construction`, declared and measured at 0/0 — and all three tool-surface '
      + 'defects live exactly there.',
  },
  {
    run: 'bun run layergate --matrix',
    tier: 'ci',
    seconds: 30,
    catches: 'a layer whose probes cannot localise a fault to it — cross-talk. Without '
      + 'this a layer at 100% may be scoring another layer\'s behaviour.',
    blind: 'a layer with no probes, which scores null and localises nothing.',
  },
  {
    run: 'bun run gate:capability-parity',
    tier: 'commit',
    seconds: 1.2,
    catches: 'the two shapes of backend divergence. A core contract whose optional '
      + 'capability is wired on one backend only (25 today, including '
      + 'ShellApprovalPolicy.requestApproval, absent on cf), and a module that would '
      + 'compile in a shared package sitting inside one adapter, so the other backend '
      + 'has no contract to under-wire and simply does without — 62 today, 4,632 lines. '
      + 'The clearest is components/tool-call-summary.ts: 453 lines of tool-call '
      + 'vocabulary against which the CLI joins raw argument values and clips at 70 '
      + 'characters. Its allowlist of importable libraries is DERIVED from what the '
      + 'shared packages already import, so it widens when core takes a dependency and '
      + 'never needs editing.',
    blind: 'a platform GLOBAL reached with no import — measured at zero occurrences over '
      + 'the 62 reported modules, and caught in one second by `tsc -p packages/core` the '
      + 'moment anyone acts on the finding.',
  },
  {
    run: 'bun run test:workerd',
    tier: 'ci',
    seconds: 7,
    catches: 'Durable Object semantics no bun test can express, executed inside real '
      + 'workerd (1.20260811.1) via @cloudflare/vitest-pool-workers. Two of them are '
      + 'defects we shipped and found only from production: `ctx.waitUntil` retains '
      + 'nothing in an actor and its write is cancelled on reset with the exception '
      + 'swallowed, and anything Durable Object init awaits stalls every later request '
      + 'on that object. Both were guarded before this only by a source-text grep and an '
      + 'AST walk — correct rules whose STATED REASON nothing re-established. Both '
      + 'reproduce red here against the historical shape: 2ms instead of a held 700ms '
      + 'invocation, and 703ms for a `SELECT 1`. Each polarity carries its own control, '
      + 'so a green cannot come from a write that never happened.',
    blind: 'everything above the platform. This tier is deliberately NOT a second home '
      + 'for unit tests: `include` is exactly packages/*/tests/workerd and bunfig excludes '
      + 'the same path, so the two runners cannot overlap. It also cannot see '
      + '`ctx.facets.clone`, which needs @cloudflare/workers-types >= 5.20260804.1, nor '
      + 'tailStream dispatch, which is absent platform-wide and was refuted as a local pin.',
  },
  {
    run: 'bun run gate:policy-drift',
    tier: 'commit',
    seconds: 0.6,
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
  },
];

/**
 * The deploy tier, read out of deploy.sh. A parse of the authoritative list,
 * never a copy: a gate added there appears here on the next run, and
 * `ladder.test.ts` fails if this parse ever returns nothing — a parser that
 * silently matches no lines would make every parity assertion vacuous, which is
 * the exact failure this ladder exists to stop.
 */
export function deployGates(
  source = readFileSync(resolve(root, 'scripts/deploy.sh'), 'utf8'),
): string[] {
  const gates: string[] = [];
  for (const line of source.split('\n')) {
    const match = /^run_required_gate\s+"[^"]*"\s+(.+?)\s*$/.exec(line);
    if (match?.[1] !== undefined) gates.push(match[1]);
  }
  return gates;
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
  'bun run verify:lean':
    'needs the elan toolchain and a 15-minute Lean build. It runs in the path-filtered '
    + 'lean-verify workflow on pull requests and as a main-push gate, which is where '
    + 'that cost belongs.',
} satisfies Record<string, string>;

/** Every gate at or below `tier`. At `deploy`, anything deploy.sh runs that no
 *  earlier tier declares is appended verbatim, so the tier is exactly what the
 *  deploy path runs even while a new gate is still undescribed here. */
export function gatesFor(tier: Tier, deploy: readonly string[]): Gate[] {
  const upto = TIERS.indexOf(tier);
  const gates = LADDER.filter((gate) => TIERS.indexOf(gate.tier) <= upto);
  if (tier !== 'deploy') return gates;
  const declared = new Set(gates.map((gate) => gate.run));
  return [
    ...gates,
    ...deploy.filter((run) => !declared.has(run)).map((run): Gate => ({
      run, tier: 'deploy', seconds: 0,
      catches: 'declared by scripts/deploy.sh and not yet described in LADDER',
      blind: 'unknown — see scripts/deploy.sh',
    })),
  ];
}

const TEST_FILE = /\.test\.(ts|tsx|js)$/;

/** Every test file git tracks. The denominator every reachability claim divides
 *  by; `ladder.test.ts` fails if it is empty. */
export function trackedTestFiles(): string[] {
  const listed = Bun.spawnSync(['git', 'ls-files'], { cwd: root, stdout: 'pipe' });
  return listed.stdout.toString().split('\n').filter((path) => TEST_FILE.test(path));
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

  if (words[0] === 'bun' && words[1] === 'run') {
    const body = packageScripts()[words[2] ?? ''];
    if (body === undefined) return [];
    return [...new Set(body.split('&&').flatMap((part) => claims(part.trim(), tracked)))];
  }
  if (words[0] === 'node') {
    return words.filter((word) => TEST_FILE.test(word) && tracked.includes(word));
  }
  // `vitest run --root R <dir>/` — the workerd layer. Resolved from the command
  // text like every other form, so its files are monotonicity- and
  // reachability-checked rather than exempted. The positional is a filter on
  // top of the config's own `include`, which is the enforcing half; naming it
  // here is what lets this resolver answer without parsing a TS config.
  if (words[0] === 'vitest' && words[1] === 'run') {
    const rootAt = words.indexOf('--root');
    const base = rootAt === -1 ? undefined : words[rootAt + 1];
    const targets = words.slice(2).filter((word, index) => !word.startsWith('-') && index + 2 !== rootAt + 1);
    if (base === undefined || targets.length === 0) return [];
    return tracked.filter((path) => targets.some((target) => path.startsWith(`${base}/${target}`)));
  }
  if (words[0] !== 'bun' || words[1] !== 'test') return [];
  // Root-relative only. `--cwd` is deliberately NOT understood: it makes bun
  // load a bunfig.toml from that directory instead of the repo root, dropping
  // `preload` and `pathIgnorePatterns` silently, so no gate may use it — and a
  // gate that does claims nothing and fails as an orphan rather than passing.

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
  return [...new Set(claimed)].filter((path) => !bunWouldSkip(path));
}

function printMatrix(deploy: readonly string[]): void {
  const all = gatesFor('deploy', deploy);
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
    const gates = gatesFor(tier, deploy).filter((gate) => tier === 'deploy' || !(gate.run in CI_EXEMPT));
    const cost = gates.reduce((sum, gate) => sum + gate.seconds, 0);
    const files = new Set(gates.flatMap((gate) => claims(gate.run, tracked)));
    console.log(
      `${tier.padEnd(7)} ${String(gates.length).padStart(2)} gates  ${cost.toFixed(0).padStart(3)}s declared  `
      + `${String(files.size).padStart(3)}/${String(tracked.length)} test files`,
    );
  }
}

if (import.meta.main) {
  const deploy = deployGates();

  if (process.argv.includes('--matrix')) {
    printMatrix(deploy);
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
      + '— pre-commit runs the commit tier, pre-push the push tier',
    );
    process.exit(0);
  }

  const flag = process.argv.find((argument) => argument.startsWith('--tier='));
  const asked = flag?.slice('--tier='.length);
  const tier = TIERS.find((candidate) => candidate === asked);
  if (tier === undefined) {
    console.error(
      `usage: bun scripts/ladder.ts --tier=${TIERS.join('|')} | --matrix | --install-hooks`,
    );
    process.exit(2);
  }

  const gates = gatesFor(tier, deploy)
    .filter((gate) => tier === 'deploy' || !(gate.run in CI_EXEMPT));
  const measured = assertMeasured(`ladder --tier=${tier}`, [
    ['gates in this tier', gates.length],
    ['gates declared by deploy.sh', deploy.length],
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
      ? `hooks: installed (${HOOKS_DIR}) — pre-commit runs the commit tier, pre-push the push tier`
      : `hooks: NOT INSTALLED — core.hooksPath is "${configured}", so the commit and push `
        + 'tiers do not execute in this checkout. Fix: bun scripts/ladder.ts --install-hooks',
  );

  const started = performance.now();
  for (const [index, gate] of gates.entries()) {
    console.log(`\n── ${tier} ${String(index + 1)}/${String(gates.length)}: ${gate.run}`);
    const at = performance.now();
    const proc = Bun.spawnSync(gate.run.split(' '), { cwd: root, stdout: 'inherit', stderr: 'inherit' });
    const seconds = (performance.now() - at) / 1000;
    if (proc.exitCode === 0) {
      console.log(`ok  ${gate.run}  (${seconds.toFixed(1)}s)`);
      continue;
    }
    console.error(`\nFAILED  ${gate.run}  after ${seconds.toFixed(1)}s\n`);
    console.error(finding({
      at: gate.run,
      invariant: gate.catches,
      found: 'the command exited non-zero; its own output is immediately above',
      silently: `every later tier assumes this held. What this gate does NOT cover: ${gate.blind}`,
      fix: `${gate.run}   # reproduce exactly this, nothing else`,
    }));
    process.exit(1);
  }
  console.log(
    `\nladder --tier=${tier}: ok — ${measured}, ${((performance.now() - started) / 1000).toFixed(1)}s`,
  );
}
