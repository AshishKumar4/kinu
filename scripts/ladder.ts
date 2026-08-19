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
      + 'three stale citations immediately; docs -> literature was the boundary still open, and a '
      + 'seven-number audit of `docs/EXPLORATION-SPEC.md` found six of seven DIGITS correct and '
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
    run: 'bun test scripts/gates.test.ts scripts/reachability.test.ts scripts/do-init-gate.test.ts scripts/platform-catalog.test.ts scripts/policy-drift.test.ts scripts/scratch-ownership.test.ts scripts/literature-citations.test.ts scripts/commit-hygiene.test.ts scripts/lean-citations.test.ts scripts/infra.test.ts scripts/patch-parity.test.ts',
    tier: 'push',
    seconds: 1.7,
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
      + 'its citation is still governed, and one past the bound is not. '
      + 'For infra, the three states a resource lookup can be in kept apart — a required '
      + 'resource absent, an OPTIONAL one absent, and a lookup that FAILED, the last of which '
      + 'fails the gate even on an optional resource because "we could not look" is not softened '
      + 'by the Worker tolerating the loss — plus provisioning issuing no argv at all on a second '
      + 'run, teardown refusing a phrase that names another deployment, and the two pins '
      + '(SUPPLY against the derived `Env` census, UNOBSERVABLE against the rows that came back '
      + 'blind) proven red in both directions.',
    blind: 'whether the gates are wired into any tier at all — that is ladder.test.ts. For infra, '
      + 'everything that needs an account: no test here proves a `wrangler d1 create` creates a '
      + 'database.',
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
    // The CREDENTIALED cost, because that is the cost this gate actually incurs
    // where it runs. `scripts/eval-tier.sh` borrows the signed-in CLI session
    // when the environment names no target, so a deploy from a machine that has
    // run `proteus auth` pays this — and it was declared at 0.3s, the
    // credential-free path where every live test skips. A deploy gate whose
    // declared cost is four orders of magnitude under its measured one makes the
    // tier-cost line below fiction, and the push budget above it unenforceable.
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
      + 'for a measurement for as long as that arm produced no report at all. '
      + 'Credential-free the whole tier is 3s across both arms, not the 0.3s once '
      + 'declared, which timed only the bun half; everything skips, which is the path '
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
      + 'census `gate:bench-corpus` runs at commit tier proven able to FAIL, which the '
      + 'committed assertion over a healthy corpus cannot do by itself: a patch whose '
      + 'anchor moved, and a patch file no tasks.jsonl line names, each driven from a '
      + 'fixture. No model, no credentials.',
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
  return [...words.filter((word) => !word.includes('*')), ...files];
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
