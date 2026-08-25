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
import { assertMeasured, finding } from './gate-ratchet';
import { isRunnableSuite, trackedFiles } from './sources';
import { CLI_TEST_ROOT } from './test-cli';

/** DERIVED, because it was hardcoded as 21 while the config carried 22 — a stale count in the
 *  document that tells a reader what a rung catches. Read from the enabled rules rather than from the
 *  plugin's registry: a rule registered and not enabled catches nothing. */
const ANTI_SLOP_RULE_COUNT = Object.keys(
  v.parse(
    v.object({ rules: v.record(v.string(), v.unknown()) }),
    JSON.parse(readFileSync(new URL('../.oxlintrc.json', import.meta.url).pathname, 'utf8')),
  ).rules,
).filter((rule) => rule.startsWith('anti-slop/')).length;

const root = new URL('..', import.meta.url).pathname;
/** Where the tracked hooks live, RELATIVE so git resolves it against each
 *  worktree's own root — see `--install-hooks`. */
export const HOOKS_DIR = '.githooks';


/**
 * Tier order is containment order: a later tier runs everything before it.
 * `evals` sits LAST, after `deploy`, and that placement is its meaning:
 * live-model behavioural evidence that no hook, push or deploy waits on. A
 * deploy that ran the evals took over an hour and spent real tokens to ship a
 * build, so the evals run deliberately — `bun run evals:full` — and a full
 * evals run still runs every cheaper tier first, which is what the containment
 * order buys. gate-set-equality exempts exactly this tier from the "every
 * LADDER entry is a deploy gate" rule and prints the exemption with the tier's
 * members, so an entry cannot hide from the deploy by wearing the tier
 * silently.
 */
export const TIERS = ['commit', 'push', 'ci', 'deploy', 'evals'] as const;
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
    catches: `type errors and the ${String(ANTI_SLOP_RULE_COUNT)} anti-slop rules across all 11 `
      + 'projects. The largest defect class by volume and the only total one — every file, every line.',
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
    run: 'bun run gate:set-equality',
    tier: 'commit',
    seconds: 0.2,
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
  },
  {
    run: 'bun run gate:literature-citations',
    tier: 'commit',
    seconds: 1,
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
  },
  {
    run: 'bun run gate:doc-claims',
    // `push`, not `commit`, and the reason is the index rather than the check: the
    // symbol arm needs an AST pass over every parseable file (1,372 at 0fff343e,
    // 1.2 s of the 2.1 s), and the commit tier has 2.5 s left inside a budget that
    // is a contract rather than an aspiration. Raising that budget to fit a new
    // gate is how a hook becomes slow enough to tempt `--no-verify`.
    tier: 'push',
    seconds: 2.1,
    catches: 'a DOCUMENT contradicting the code. Every other gate here compares code to code, '
      + 'which is how four features were designed, built, tested and never wired with nothing '
      + 'red — and the documents drifted the same way with nothing measuring them at all. '
      + '`FORMAL-SPEC.md` claimed 84 theorems against a measured 330; `TOOLS.md` claimed a '
      + '9,034-character tool schema against a measured 11,823, and called it a reduction from '
      + '10,201 when the surface had GROWN past both; `tasks` has four actions and two tables '
      + 'said three; a brief saying "seven named presets" reached three documents before anyone '
      + 'counted `NAMED_SWARM_PRESETS`, which is six. Three shapes are mechanically decidable '
      + 'and it governs exactly those: a named SYMBOL resolves against an identifier index '
      + 'built from the AST of every parseable file, a named PATH resolves against the one '
      + 'enumeration in the tree\'s own shorthands, and a stated COUNT matches an enumeration '
      + 'IMPORTED from the module that declares it — so this gate holds no number of its own '
      + 'and cannot be the thing that goes stale. Measured 2026-08-19 at 0fff343e over 31 '
      + 'documents: 378 path claims, 1,125 symbol claims and 15 count claims, with 36 false '
      + 'claims locked as recorded debt.',
    blind: 'every figure source does not enumerate, which is the boundary it is built around. A '
      + 'wall clock, a token count and a byte budget are the same token to a scanner as a '
      + 'configured limit, so the house rule that a figure carries its date is NOT enforced: '
      + 'measured 2026-08-19, the cheapest sound form of that rule produced 22 findings whose '
      + 'majority name no measurement at all — a heading\'s `5.1`, the `3` in `--3way`, a '
      + 'citation year — and it cannot tell WHICH number in a sentence was measured without '
      + 'guessing. Line numbers are ignored: 79 `path:line` locators landed in three documents '
      + 'on one day, and a line rots on the next insertion above it, so checking one fires on '
      + 'refactors that changed nothing. It checks EXISTENCE, never truth — `strategy/swarm.ts` '
      + 'lists six tested paths of which three refuse to resolve, and this gate passes that '
      + 'list. Model-facing strings in source are out of corpus, which is where '
      + '`tools/clamp.ts` told the model to hand work to a fork on a surface with no fork '
      + 'action. No vocabulary list: every verdict here is derived from code, so a banned '
      + 'phrase has no home in it. A string literal is deliberately not a resolution set — '
      + 'admitting one laundered five claims, four of them kept alive by a test asserting they '
      + 'are ABSENT. All of it prints on the GREEN path.',
  },
  {
    run: 'bun run gate:commit-message',
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
  },
  {
    run: 'bun run gate:install-scripts',
    tier: 'commit',
    seconds: 0.2,
    catches: 'a third-party dependency lifecycle script executing on every `bun install` without '
      + 'a recorded reason. Nine installed dependencies declare `preinstall`/`install`/'
      + '`postinstall`; bun blocks five; FOUR EXECUTE — esbuild, workerd, puppeteer, sharp — and '
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
  },
  {
    run: 'bun run gate:patch-parity',
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
  },
  {
    run: 'bun run gate:bench-corpus',
    // PUSH, not commit, and the reason is the commit budget rather than the gate: at
    // 15s with a stated purpose (a hook slow enough to tempt `--no-verify` is a design
    // failure) the commit tier has 0.5s of honest headroom, and a stale patch is fully
    // recoverable at push — which is still the author's machine, before the code leaves
    // it. That is what 'drift must fail on the same push that causes it' asked for.
    tier: 'push',
    seconds: 0.31,
    catches: 'a refactor that silently unruns a bench task. Each of the 159 seeded defects is a '
      + 'context diff against source that keeps moving, so renaming or reflowing the code a '
      + 'patch anchors on stops it applying — and `prepare` then throws OUTSIDE the '
      + 'per-attempt catch, killing a whole compare/gain/validate run mid-flight with no '
      + 'partial report. All 16 re-anchors to date landed as a follow-up commit AFTER the '
      + 'change that caused them, because the only thing proving applicability was a pair of '
      + 'near-duplicate assertions at the ci tier. At 0.31s over the whole corpus there was no '
      + 'reason for that: the breaking change now fails on the machine that made it, while the '
      + 'person who moved the code is still holding it. It caught the branch that introduced '
      + 'it breaking sealed-validate-flags-the-good-tasks. Both enumerations, so an ORPHAN '
      + 'patch file no tasks.jsonl line names is named as one rather than passing as a file '
      + 'nobody loads.',
    blind: 'whether a patch that applies still BREAKS anything — a re-anchored hunk can land '
      + 'somewhere the defect no longer bites, and only `bun scripts/bench.ts validate --id '
      + '<id>` (one task, 93s, no model) answers that. Also whether the defect is still the '
      + 'one the task PROMPT describes, which no mechanical check can decide.',
  },
  {
    run: 'bun run gate:skip-ratchet',
    // MOVED commit -> push when its measured cost went 0.3s -> 2.9s. The 0.3s was
    // never right — `bun test ./tests/` alone is 1.2s — and covering the vitest arm
    // added a vite transform on top, so the commit tier's declared 15s budget was
    // being met on an understated number. Push rather than a raised budget: the
    // budget exists so nobody learns to bypass the hook, and a skip set is fully
    // recoverable at push. Nothing it asserts was narrowed to fit.
    tier: 'push',
    seconds: 2.9,
    catches: 'a test that starts skipping, and a declared skip that has started running '
      + 'without the lock being tightened. Credential-free the eval tier reports 60 skips '
      + 'across its two runners and exits 0, and that exit code is all anyone reads — so the '
      + 'skipped set is locked with a written reason per entry. Locking the SET rather than a '
      + 'count is what makes it work: a count of 60 cannot tell you a different 60 are '
      + 'skipping now. BOTH RUNNERS, which is what the 2.9s buys over the previous 0.3s: this '
      + 'gate read `bun test ./tests/` alone while the tier also runs vitest over '
      + '`tests/evals/**/*.eval.ts`, and that arm reported 36 tests of which 35 skipped with '
      + 'nothing declaring any of them — the same false green, one runner over, inside the '
      + 'tier built to prevent it. It also asserts every target contributed a test, and a '
      + 'file satisfies only the NARROWEST target that claims it, so neither arm can answer '
      + "for the other's.",
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
    run: 'bun run gate:wired',
    // PUSH, beside `gate:dead-code` and for its reason: at 3.6s it is three times
    // the priciest commit-tier static gate, and nothing can become unwired
    // between a commit and the push that follows it.
    tier: 'push',
    seconds: 3.6,
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
  },
  {
    run: 'bun run gate:silent-drop',
    tier: 'push',
    seconds: 1.4,
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
    run: 'bun test scripts/gates.test.ts scripts/reachability.test.ts scripts/do-init-gate.test.ts scripts/platform-catalog.test.ts scripts/policy-drift.test.ts scripts/scratch-ownership.test.ts scripts/literature-citations.test.ts scripts/commit-hygiene.test.ts scripts/lean-citations.test.ts scripts/doc-claims.test.ts scripts/infra.test.ts scripts/patch-parity.test.ts scripts/silent-drop.test.ts scripts/analytics-datasets.test.ts',
    tier: 'push',
    // Measured 2026-08-24 after analytics dataset parity joined: 11.08s.
    seconds: 12,
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
      + 'blind) proven red in both directions.',
    blind: 'whether the gates are wired into any tier at all — that is ladder.test.ts. For infra, '
      + 'everything that needs an account: no test here proves a `wrangler r2 bucket create` '
      + 'creates a bucket.',
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
    run: 'bun test scripts/secret-scan.test.ts scripts/sources.test.ts',
    tier: 'push',
    seconds: 1,
    catches: 'a secret scanner that stopped matching, and an enumeration that stopped treating '
      + 'tracked-ness as authoritative. The scanner passing means nothing until this says it '
      + 'still recognises a planted credential — including one in a tracked file that is '
      + 'gitignored, or gone from the working tree, which is how a re-added transcript with '
      + 'live tokens rode a green scan on 2026-08-18.',
    blind: 'credential shapes nobody wrote a case for.',
  },
  {
    run: 'bun test scripts/gate-set-equality.test.ts',
    tier: 'push',
    seconds: 0.4,
    catches: 'the set-equality gate not being able to fail, and — the half that is harder — '
      + 'it firing on shapes that are legitimate. 24 cases: RED on each of the five defect '
      + 'shapes actually shipped (a private pattern, a private `git ls-files`, a private walk, '
      + 'a glob scan, a lock published before its measurement), GREEN on their corrected form, '
      + 'and SILENT on the four its first draft mistook for violations — a URL route, a model '
      + 'id prefix, a `.replace()` specifier rewrite, and `matchAll` over prose. That first '
      + 'draft reported 40 findings of which 38 were `context.report` in an oxlint rule; a gate '
      + 'whose first run is mostly noise trains people to ignore it.',
    blind: 'whether the predicates in sources.ts describe the right sets. It proves nothing '
      + 'else re-spells them.',
  },
  {
    run: 'bun test scripts/wired.test.ts',
    tier: 'push',
    seconds: 3.8,
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
  },
  {
    // Measured 2026-08-22 on the 24-thread workstation: 33.15s with four
    // isolated Bun workers, versus 78.16s in one shared process.
    run: 'bun run test',
    tier: 'push',
    seconds: 34,
    catches: 'behavioural regressions in agent-utils, core and compaction — the whole '
      + 'shared spine both backends run on. No test COUNT is quoted here: this entry '
      + 'carried 3,105 against a measured 3,917, and forty lines below it this same '
      + 'file records the CLI count being 17 tests out of date for months. A number '
      + 'copied into prose has nothing that re-runs it. Every gate on this list spells '
      + 'its suite ROOT-RELATIVE (`bun test packages/x/`) rather than `--cwd packages/x`: '
      + 'measured 2026-08-17, `--cwd` makes bun read a bunfig.toml from THAT directory, '
      + 'so the root one is not loaded and both `preload` and `pathIgnorePatterns` are '
      + 'silently dropped. A probe printed `KINU_HOME= undefined` under `--cwd` and a '
      + 'real temp home root-relative — meaning the throwaway home that exists because '
      + 'cli-backend once wrote ~580 checkpoint stores into a developer\'s real ~/.kinu '
      + 'was reaching NO per-package gate.',
    blind: 'both backend composition roots, and every subprocess path. It also covers '
      + 'only 3 of the 8 workspace packages — see ROOT_TEST_OMISSIONS in ladder.test.ts, '
      + 'which pins the other 5 by equality with the gate that does run each.',
  },
  {
    run: 'bun test packages/devbox/',
    tier: 'push',
    seconds: 0.3,
    catches: 'a durability decision that silently does nothing. Thirteen defects in this '
      + 'package were only findable on a real deployed container, and nine of them looked '
      + 'like success from inside the code: an attach that reported landing while nothing '
      + 'was mounted, a checkpoint that answered `unchanged` seconds after a write, a '
      + 'self-re-arming schedule that deleted its own successor. Every one is pinned here.',
    blind: 'anything that needs a real container: the mounts themselves, the object store, '
      + 'and the platform lifecycle. Those are the bench app under `packages/devbox/bench` '
      + 'and an ephemeral deployed Worker, not this gate.',
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
    // Measured 2026-08-22: 6.43s, four isolated workers.
    run: 'bun test --parallel=4 packages/cf-backend/',
    tier: 'push',
    seconds: 7,
    catches: 'the Cloudflare composition root observed against the capability manifest '
      + '— the conformance gate.',
    blind: 'anything needing a Workers runtime rather than a composition root — every '
      + 'test here mocks the Agent SDK (`tests/helpers/agents-sdk.ts`) and runs under '
      + 'bun, which is why `bun run test:workerd` exists below.',
  },
  {
    // THE TIER IS THE BUDGET'S DECISION AND NOT A PREFERENCE. Measured the way this file
    // measures — `performance.now()` around `Bun.spawnSync(['bun','run','test:mutation'])`,
    // seven samples, 2026-08-19: 0.178 0.186 0.190 0.197 0.199 0.206 0.207 — so the declared
    // cost is the MAXIMUM rather than the median, because a ceiling declared from a middle is
    // exceeded half the time. At `commit` that puts the tier's sum at 15.00s against a
    // ceiling of `< 15`: it satisfies `toBeLessThan` only by 1.8e-15, which is binary
    // floating point rather than headroom, so the commit tier is full and this belongs at
    // push, where the sum is 66.90s against 90.
    run: 'bun run test:mutation',
    tier: 'push',
    seconds: 0.21,
    catches: 'a policy decision inverted with nothing to notice. Seven of them — the archive '
      + 'novelty floor and the nearest-occupant search beside it, `isBetter`\'s direction and '
      + 'its strictness, the publication seal, the merge policy derived from settle, the cycle '
      + 'scan that makes a refusal all-or-nothing, budget conservation, and the clamp\'s '
      + 'head/tail split — are each mutated in an isolated copy of the module and the NAMED '
      + 'test that defends them is required to fail against the mutant. Every one of the nine '
      + 'mutations typechecks, throws nothing, and changes one comparison: measured 2026-08-19, '
      + 'admitting a tie reports the re-record as `recorded, displaced: true`, skipping the '
      + 'cycle scan reports `applied` where a refusal belongs, and giving the tail the whole '
      + 'cap returns 1796 characters against a budget of 1400. A suite that only ever asserts '
      + '"something was refused" is green through all nine, which is why this is a tier gate '
      + 'and not a comment.',
    blind: 'any decision not on the list, and the list is hand-written — nothing enumerates the '
      + 'comparisons a policy module contains, so a new threshold arrives uncovered and this '
      + 'gate stays green over it. It also proves only that ONE named test catches each '
      + 'mutation, never that the mutation is the worst reading available, and a mutant that '
      + 'merely crashed would satisfy a weaker harness: the rejection is required to be a '
      + 'failed `expect` rather than any throw.',
  },

  {
    run: 'bun run gate:dependency-advisories',
    tier: 'ci',
    seconds: 0.3,
    catches: 'a dependency arriving with a known vulnerability nobody reviewed. `bun pm scan` '
      + 'was named as the tool for this in the note above and was invoked NOWHERE — and could '
      + 'not have helped if it had been, because bun ships no scanner and answers `error: no '
      + 'security scanner configured`. `bunfig.toml` now points at `scripts/security-scanner.ts`, '
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
  },
  {
    // Measured 2026-08-22: 18.42s, four isolated workers.
    run: 'bun test --parallel=4 packages/cli-backend/',
    tier: 'ci',
    seconds: 19,
    catches: 'the local composition root and its conformance gate, plus the real host '
      + 'filesystem and checkpoint paths.',
    blind: 'the CLI surface above it.',
  },
  {
    // Measured 2026-08-23: 40.0s. `behavior.test.ts` alone took 23.36s and
    // the other 43 files took 16.64s at parallel=4. Putting the slow file in
    // that wave exceeded 180s through contention.
    run: 'bun run test:cli',
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
  },
  {
    run: 'bun test packages/pc-agent/',
    tier: 'ci',
    seconds: 0.3,
    catches: 'the local-device daemon. No count quoted, for the reason `bun run test` '
      + 'states: this entry said 6 against a measured 11. `bun run check` only '
      + '`node --check`s this package\'s syntax, so the suite is the only thing that '
      + 'reads it.',
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
    seconds: 1.3,
    catches: 'the root end-to-end and eval suites parsing, constructing their workspaces '
      + 'and reaching their skip decision, credential-free. Kept beside `test:eval` '
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
  },
  {
    run: 'bun run test:eval',
    tier: 'evals',
    // The CREDENTIALED cost, because that is the cost this gate actually incurs
    // where it runs. `scripts/eval-tier.sh` authenticates as `eval-service`
    // against staging from KINU_EVAL_TOKEN, so a run that holds that credential
    // pays this — and it was declared at 0.3s, the credential-free path where
    // every live test skips. A gate whose declared cost is four orders of
    // magnitude under its measured one makes the tier-cost line below fiction,
    // and the push budget above it unenforceable.
    seconds: 3228,
    catches: 'the behavioural evidence nothing else in this ladder can produce: whether '
      + 'the agent reaches for MCTS on a task that warrants it, whether a search opens '
      + 'more than one branch and leaves a DURABLY ranked winner, whether every settle '
      + 'mode writes where the Exploration reader reads, and what fraction of eligible '
      + 'turns convert to a delegation. Each score reports its denominator, and each '
      + 'assertion checks that denominator is non-zero BEFORE anything else, because '
      + '"0 of 0 searches were unranked" is the shape of a check that cannot fail. It '
      + 'also catches ITSELF running empty: with a target resolved, a run that reports '
      + 'no model call, or calls whose cost it cannot account for, now exits non-zero '
      + 'rather than printing `TOTAL: 0 model call(s)` and passing. BUN ARM ONLY, from the '
      + 'two runs whose spend files still exist: 2,745s / 48 calls / 601,582 in, and '
      + '3,843s / 49 calls / 600,843 in. The declared 3,228s / 64 calls / 967k came from '
      + 'a THIRD run whose artifact does not survive, and 64 calls / 967k is atypical '
      + 'against both that do — so it is kept as a CEILING, labelled as one, rather than '
      + 'cited as a measurement anybody can open. The second surviving run also contains '
      + '1,200s of tests being KILLED rather than working (a 900s exploration timeout and '
      + 'a 300s MCTS one, both since fixed, the same steps completing in 437s and 456s '
      + 'afterwards), so it overstates waste and understates work at once and no '
      + 'post-fix cost should be derived from it. The VITEST behaviour arm '
      + 'is 34 full agent episodes (17 corpus tasks x 2 repeats) and dominates the tier; '
      + 'the tier now reports each arm\'s own seconds and tokens, which is what replaced '
      + '"add roughly an hour for the vitest behaviour arm" — a sentence that stood in '
      + 'for a measurement for as long as that arm produced no report at all. Two more '
      + 'single-family vitest arms — research (a controlled MCP archive, exact-match '
      + 'scored) and optimization (a metered corpus instrument with a pre-registered '
      + 'threshold) — each hold their own spend file and their own liveness assertion, '
      + 'and each writes a run record `scripts/eval-report.ts` reads. '
      + 'Credential-free the whole tier is 9s across all five arms (measured '
      + '2026-08-19), not the 0.3s once declared, which timed only the bun half; '
      + 'everything skips, which is the path that reproduces anywhere.',
    blind: 'the cf runtime, for everything except the Live Smoke hosted arm. The rest '
      + 'drive core and the CLI\'s local session in-process, so a defect that only '
      + 'appears in workerd — a rejected cross-DO RPC inside background work that only '
      + 'console.warns — is invisible to them by construction. That is the workerd '
      + 'layer\'s job. It is also blind to whether an assertion is STRONG: '
      + '`E2E Full Lifecycle` steps 4 and 5 assert only that the reply is non-empty, so '
      + 'they pass on any prose the model returns. And it cannot tell contention from a '
      + 'deployment fault: two live tiers on one account produce the same '
      + '`detached_work_failed / Request Timeout` signature as an outage.',
  },
  {
    run: 'bun test scripts/eval.test.ts scripts/eval-triage.test.ts scripts/staging-preflight.test.ts',
    tier: 'ci',
    seconds: 1,
    catches: 'the eval gate\'s own logic, credential-free, plus how the triage instrument '
      + 'CLASSES a failure: which census part makes a failed call a product defect, that a '
      + 'correct refusal never enters the worklist, that dispersion counts only inside one '
      + 'commit and one arm, and — the one that would have mattered most — that a legacy '
      + '`tool_outcomes` detail carrying a tool USAGE histogram yields no attribution at all. '
      + 'Reading `run×29` as 29 broken calls would have filed the whole baseline corpus as a '
      + 'product defect. All three directions were proven red by mutation. The live-model '
      + 'benchmark runs in the separate gated eval.yml.',
    blind: 'anything a model actually does, and whether a hand VERDICT in '
      + 'scripts/eval-triage.verdicts.json is right. A verdict is a written argument about a '
      + 'trajectory, so nothing here can check one; what is checked is that a stale verdict '
      + 'and an unverified group both print.',
  },
  {
    // The COMMAND deploy.sh runs, spelled identically. It used to stop at the
    // `scripts/bench*` glob while deploy.sh also passed the core bench units, so
    // the wider command matched no LADDER entry, `gatesFor('deploy')` synthesized
    // it at a declared cost of ZERO, and the four core bench suites were governed
    // by an entry that did not name them. The durability probe is explicit rather
    // than absorbed by that glob because its name is a contract: a real container
    // measurement that remains only in stdout is not evidence.
    run: 'bun test scripts/bench*.test.ts packages/core/tests/unit-bench*.test.ts scripts/sandbox-durability-probe.test.ts',
    tier: 'ci',
    // 3.97s: 257 tests over 11 files, median of 3.94 / 3.97 / 3.99 on the
    // 24-thread box, measured 2026-08-24 after durability-artifact evidence
    // joined. That is the corpus-absent basis every fresh clone sees; a checkout
    // with terminal-bench-2.1 on disk also pays the sampler over the real corpus
    // in bench-external.test.ts.
    seconds: 3.97,
    catches: 'the bench harness guarantees — sandbox isolation, the seal, '
      + 'anti-self-scoring, budget enforcement, corpus well-formedness, and the '
      + 'durability probe retaining complete or failed JSON evidence without '
      + 'overwriting a prior run — plus the census `gate:bench-corpus` runs at '
      + 'commit tier proven able to FAIL, which the committed assertion over a '
      + 'healthy corpus cannot do by itself: a patch whose anchor moved, and a '
      + 'patch file no tasks.jsonl line names, each driven from a fixture. No '
      + 'model, no credentials.',
    blind: 'anything about what the bench measures. It only guards the instrument, '
      + 'which is what four independent instrument bugs cost us to learn.',
  },
  {
    run: 'bun test scripts/chat-and-files-ux.test.ts scripts/computed-style.test.ts scripts/control-plane-ux.test.ts scripts/feedback-ux.test.ts scripts/plan-review-ux.test.ts',
    tier: 'ci',
    // Measured 2026-08-24 after the six plan checks joined this row:
    // 177.63s and 175.02s over two runs.
    seconds: 190,
    catches: 'the five UI gates\' own decision logic, including the one that would have '
      + 'caught `--radius` being undefined at `:root` while 191 `rounded-*` sites '
      + 'computed 0px. The original two self-tests ran in NO tier until this line: the gates were '
      + 'built, deliberately kept off the deploy path for their Chrome cost, and their '
      + 'logic was then guarded by nothing anywhere. Now also the THEME axis, which had '
      + 'no coverage at all: `gallery.html:7-22` resolves the initial `data-mode` and '
      + '`data-palette` from `prefers-color-scheme` and localStorage, and the harness '
      + 'never pinned either, so every token assertion here was made against whichever '
      + 'theme the Chromium build happened to prefer — measured dark on this one, and '
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
      + 'instead of spending a margin on buttons nobody can press.',
    blind: 'the gallery render itself. `gate:computed-style` boots vite and Chrome over '
      + '21 frames × 4 themes and stays a standalone run — a gate that fails because '
      + 'Chrome is missing fails for a reason unrelated to the change under test. Also '
      + 'MOST OF THE GALLERY: only `shell`, `streaming` and `environment` carry any '
      + 'assertion here, while gallery.tsx dispatches ~29 frames, so the rest are proven '
      + 'to mount and nothing more. The three non-default themes are audited on `shell` '
      + 'alone. The control-plane and feedback frames use authenticated gallery fixtures, not '
      + 'a deployed OAuth flow. Browser capture fidelity outside those fixed frames remains '
      + 'unmeasured rather than green. For the plan document: one gallery plan and '
      + 'three variants of it, so the annotation ENGINE — selection, offsets, save, '
      + 'export — is exercised only as far as one stored anchor painting.',
  },
  {
    run: 'bun test scripts/public-pages.test.ts',
    tier: 'ci',
    // Measured 2026-08-24 after the bug-fix drive and six-width clipping sweep: 51.28s.
    seconds: 55,
    catches: 'the signed-out pages as a browser renders them: the hero tree grows and '
      + 'settles on the landing page, the sign-in and install pages carry the shell, '
      + 'and every public surface holds zero case-insensitive proteus in visible text. '
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
      + 'regression passes, and copy quality is unread beyond the zero-proteus grep.',
  },
  {
    run: 'bun test scripts/swarm-tree-geometry.test.ts',
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
  },
  {
    run: 'bun test scripts/chat-scroll.test.ts',
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
    seconds: 12.7,
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
  {
    run: 'bun run gate:scratch-ownership',
    tier: 'commit',
    seconds: 1.3,
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
  },
  {
    run: 'bun run gate:agents-fields',
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
  },
  {
    run: 'bun run verify:lean',
    tier: 'deploy',
    // 2.2s WARM, median of 2.19 / 2.20 on the 24-thread box, 2026-08-21: `lake
    // build` is a no-op once `lean/.lake` holds the build, so this figure sits on
    // the same basis as every other one here, a prepared checkout.
    //
    // COLD IT IS ~15 MINUTES, and that is what CI pays: the lean-verify workflow
    // caches `~/.elan` and not `lean/.lake`, so a runner rebuilds 330 theorems
    // every time. That is why CI_EXEMPT keeps it off the ci tier, and why both
    // figures are written down rather than averaged into one that describes
    // neither machine.
    //
    // Declared at ZERO until 2026-08-21, which made the deploy tier's cost line
    // fiction and its budget unenforceable.
    seconds: 2.2,
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
  },
  {
    run: 'bun run gate:infra',
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
      + 'of two secrets nobody had recorded as missing.',
    blind: 'anything no CLI can observe, which it refuses to hide: the AI Gateway (wrangler 4.97 '
      + 'has no `ai-gateway` command and the OAuth session has no `aig` scope) and the cron '
      + 'trigger (writable, never readable) are DECLARED blind spots pinned by equality, so the '
      + 'list can only shrink and only on purpose, and an undeclared one fails. Also blind to '
      + 'whether a resource that exists is CORRECT beyond its name — a Vectorize geometry '
      + 'mismatch is reported, an R2 lifecycle rule is not — and, deliberately, to every '
      + 'environment but the one named: staging is reported as not-checked with the command that '
      + 'checks it.',
  },
];

/**
 * The deploy gates that MUST NOT run beside another gate, each with the reason.
 *
 * Everything not named here or in {@link EXCLUSION_GROUPS} is independent, and
 * `scripts/deploy.sh` runs it concurrently. That claim is checkable rather than
 * hopeful: no gate writes into the working tree (`gate:bench-corpus` uses
 * `git apply --check`, `gate:patch-parity` copies into a throwaway tree, every
 * `tsc` is `--noEmit`), and every test process gets its own `mkdtemp` KINU_HOME
 * from scripts/test-scratch-home.ts.
 *
 * `deploy.test.ts` asserts deploy.sh puts a barrier around exactly these, so the
 * policy and the pipeline cannot drift apart.
 */
export const SERIAL_GATES = {
  'bun scripts/preflight.ts':
    'runs alone and FIRST. Its subject is the environment every other gate reports through: '
    + 'an exhausted $TMPDIR inode table surfaces later as a 5-second timeout inside an '
    + 'unrelated filesystem test, which reads as a code regression and is not one. A gate '
    + 'running beside it could report that regression before the preflight had said the '
    + 'machine was unfit to be reported on.',
  'bun run gate:infra':
    'runs alone and LAST. It is the only gate that talks to Cloudflare, `npx wrangler whoami` '
    + 'is its precondition, and its place in the order carries meaning: everything before it '
    + 'proves the SOURCE is deployable and it proves the ACCOUNT is. Running it early would '
    + 'spend account calls on a tree that has not been shown to compile.',
} satisfies Record<string, string>;

/**
 * Same-wave exclusions. Empty after the gallery harness moved to a
 * kernel-assigned port and per-process Vite cache, fixtures gained semantic
 * identities, and the chat anchor stopped re-pinning on page-settle commits.
 * `deploy.test.ts` holds this equal to deploy.sh's table.
 */
export interface ExclusionGroup {
  readonly why: string;
  readonly gates: readonly string[];
}
export const EXCLUSION_GROUPS: Readonly<Record<string, ExclusionGroup>> = {};

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
 * The deploy gates GROUPED BY THE WAVE THEY RUN IN, read out of the same file.
 *
 * deploy.sh enqueues gates and runs each queue at a `flush_gates` line, so a wave
 * is the run of gates between two flushes and every gate in one wave runs beside
 * the others. That makes "runs alone" a property of this grouping rather than of
 * a log, which matters: the first version of the assertion read the ORDER off a
 * stub log, and deleting a barrier left it green because the scheduler happened
 * to launch index 0 first. A test that cannot fail is not a gate.
 *
 * A trailing enqueue with no flush after it is a gate nobody runs, so it comes
 * back as its own final wave and `deploy.test.ts` refuses it.
 */
export function deployWaves(
  source = readFileSync(resolve(root, 'scripts/deploy.sh'), 'utf8'),
): string[][] {
  const waves: string[][] = [];
  let wave: string[] = [];
  for (const line of source.split('\n')) {
    if (/^flush_gates\s*$/.test(line)) {
      if (wave.length > 0) waves.push(wave);
      wave = [];
      continue;
    }
    const match = /^run_required_gate\s+"[^"]*"\s+(.+?)\s*$/.exec(line);
    if (match?.[1] !== undefined) wave.push(match[1]);
  }
  if (wave.length > 0) waves.push(wave);
  return waves;
}

/**
 * deploy.sh's own exclusion table, parsed. Held equal to {@link EXCLUSION_GROUPS}
 * by `deploy.test.ts`: the runner is bash and cannot import the declaration, so
 * the two are written twice and asserted once.
 */
export function deployExclusions(
  source = readFileSync(resolve(root, 'scripts/deploy.sh'), 'utf8'),
) {
  const groups: Record<string, string[]> = {};
  for (const line of source.split('\n')) {
    const match = /^\s*\['([^']+)'\]=(\S+)\s*$/.exec(line);
    const run = match?.[1];
    const group = match?.[2];
    if (run === undefined || group === undefined) continue;
    (groups[group] ??= []).push(run);
  }
  return groups;
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
 */
export function trackedTestFiles(): string[] {
  return trackedFiles().filter(isRunnableSuite);
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
  if (words[0] === 'bun' && words[1] === 'scripts/test-cli.ts') {
    return tracked.filter((path) => path.startsWith(`${CLI_TEST_ROOT}/`) && !bunWouldSkip(path));
  }
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
  const flags = words.filter((word) => !word.includes('/'));
  return [...flags, ...files];
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
      + '— pre-commit runs the commit tier, pre-push the push tier, commit-msg the message rules',
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
      ? `hooks: installed (${HOOKS_DIR}) — pre-commit runs the commit tier, pre-push the push tier, commit-msg the message rules`
      : `hooks: NOT INSTALLED — core.hooksPath is "${configured}", so the commit and push `
        + 'tiers do not execute in this checkout. Fix: bun scripts/ladder.ts --install-hooks',
  );

  const started = performance.now();
  const tracked = trackedTestFiles();
  for (const [index, gate] of gates.entries()) {
    console.log(`\n── ${tier} ${String(index + 1)}/${String(gates.length)}: ${gate.run}`);
    const at = performance.now();
    const proc = Bun.spawnSync(runnableArgv(gate.run, tracked), { cwd: root, stdout: 'inherit', stderr: 'inherit' });
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
