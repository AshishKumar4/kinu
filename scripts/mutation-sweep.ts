/**
 * The mutation sweep: code no test defends.
 *
 * This is the other half of built-but-unwired, seen from the opposite side. An audit
 * found four features that were designed, built, tested and never called, and every
 * gate here missed all four because every gate here compares code to code. This
 * program compares code to BEHAVIOUR: it changes one decision, runs the suites, and
 * reports the decisions that changed with nothing turning red.
 *
 * A survivor is one of two different defects and they need different fixes, so each
 * one is classified:
 *   UNREACHED — no production caller. The mutant cannot be killed by any production
 *               path, only by a test that builds the seam itself. The fix is wiring
 *               or deletion, never a new test.
 *   UNTESTED  — reachable, and nothing asserts on it. The fix is an assertion.
 * The classifier is the check `gate:dead-code` gets wrong: it counts production USES
 * and it does not count a barrel re-export or a test reference. That is the whole
 * reason a feature with exports, tests and no caller passes every other check.
 *
 * WHY THE MUTATION IS APPLIED IN PLACE, AND WHY THAT IS SAFE ONLY HERE. In-place
 * mutation in a SHARED tree manufactures the mirror defect — a test that fails for a
 * reason that is not in the code — and every concurrent suite overlapping the window
 * produces a meaningless green or a misattributed red. So this program refuses to run
 * in the main checkout, and it refuses when a target file is dirty. Two alternatives
 * were tried and both were rejected on measurement, not on taste:
 *   - A Bun preload plugin rewriting the module on load, which would touch no disk at
 *     all. Measured on bun 1.3.14: `build.onLoad` is never invoked for a `.ts` file,
 *     so the suite ran against pristine source and reported a false survivor.
 *   - A sandbox copy of the tree, the way Stryker works. Measured 2026-08-19: 60 core
 *     suites and 23 core sources import `@kinu/*`, which inside a copy resolves
 *     through the donor's `node_modules` to the PRISTINE package. The mutation would
 *     be invisible to two thirds of its own defenders — a false-survivor generator,
 *     which is the exact defect this program exists to find.
 * The two hand-authored suites, `mutation-exploration-policy.test.ts` and
 * `mutation-merge-back.test.ts`, avoid all of this by loading an isolated mutant COPY
 * and running one named test's assertions against it. That is stronger evidence and it
 * does not scale: it needs a human to name the defending test in advance, which is
 * precisely what a sweep cannot know. Those suites stay; this program is the wide net
 * that says where the next one should be written.
 *
 * EVERY MUTATION ASSERTS IT LANDED, and this is inherited from those suites rather
 * than reinvented: a snippet must occur EXACTLY once or the sweep throws. A mutation
 * whose edit silently missed is a report that a decision is defended by never having
 * removed it.
 *
 * WHAT IT COSTS, MEASURED 2026-08-19 on a 12th Gen i9-12900K under bun 1.3.14, each
 * package in its own invocation: core 52.7 s (3807 pass, 3 skip), cli 76.4 s (312),
 * cli-backend 32.4 s (313), cf-backend 13.5 s (1353), compaction 1.5 s (95),
 * agent-utils 0.15 s (15). All six, 177 s.
 *
 * So a mutant costing the full repository is 177 s and a 30-mutant sweep costing that
 * every time is 89 minutes. It is scoped in three tiers instead, and the ordering is
 * chosen so that narrowing can only ever cost a KILL, never invent a survivor:
 *   1. The candidate defenders — suites importing the mutated file directly, or naming
 *      its symbol. Seconds. Most kills land here.
 *   2. Whole `packages/core`, for anything that survived tier 1.
 *   3. The five other packages that own suites, for anything that survived tier 2.
 * Every survivor therefore pays the full 177 s, and a survivor is a claim that no
 * suite in this repository defends the decision. Kills pay almost nothing. Measured
 * over the whole catalogue on 2026-08-19: 25 mutations in 2865 s, 12 killed and 13
 * surviving, which is 48 minutes rather than the 74 that 25 survivors would have cost.
 *
 * Transitive-import reachability was tried as the tier-1 filter and abandoned on
 * measurement: `@kinu/core`'s barrel puts 344 of 558 suites in the transitive
 * closure of `strategy/mcts.ts`, so the graph says two thirds of the repository is a
 * candidate defender of every core file. It is the same structural fact that makes
 * `gate:dead-code` treat a barrel line as a reference.
 *
 * A TIMEOUT IS NOT A KILL. A mutation can stop a loop terminating, and a clock cannot
 * tell a blocked suite from a slow one — a level watchdog was deleted for exactly that
 * confusion. So the deadline is a multiple of the baseline this run MEASURES rather
 * than a constant, and a mutant that outlives it is reported in its own class for a
 * human to read. It is never counted as evidence about the suite.
 *
 * NOT A GATE, and the number is the argument: at 177 s per survivor this belongs in no
 * tier that a hook or a deploy waits on. It is a program a human runs.
 *
 *   bun run sweep:mutation           # the whole catalogue
 *   bun run sweep:mutation --list    # the catalogue and its cost, running nothing
 *   bun run sweep:mutation --only heads-self-metered
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gitEnv } from '../packages/test-utils/src/git';
import { isProductSource, isRunnableSuite, readMatching, trackedFiles } from './sources';
import {
  declarationOf, isReExport, moduleSpecifiers, parse, type SyntaxNode, walk,
} from './syntax';
import { CATALOGUE, type Mutation } from './mutation-sweep.catalogue';

const root = new URL('..', import.meta.url).pathname;

/**
 * A suite root the sweep runs, with the seconds it took on the reference machine.
 * The number is documentation of the cost this program imposes, not a budget it
 * enforces — the deadline comes from the baseline each run measures.
 */
interface Tier {
  readonly root: string;
  readonly seconds: number;
}

/** Tier 2 is core alone; tier 3 is the rest. Split because a mutation lives in one
 *  package and its own package's suites are the likeliest defenders. */
const CORE_TIER: Tier = { root: 'packages/core/', seconds: 53 };

const OTHER_TIERS: readonly Tier[] = [
  { root: 'packages/agent-utils/', seconds: 1 },
  { root: 'packages/compaction/', seconds: 2 },
  { root: 'packages/cf-backend/', seconds: 14 },
  { root: 'packages/cli-backend/', seconds: 33 },
  { root: 'packages/cli/', seconds: 77 },
];

/**
 * Suite roots this sweep deliberately does not run, each with the reason.
 *
 * Declared rather than left implicit, and asserted below to partition the runnable
 * suites together with the tiers, because a sweep that silently governs less than it
 * enumerates is the defect thirteen of fifteen gates committed on 2026-08-17: it
 * measures one set and reports about another.
 */
const OUT_OF_SCOPE = {
  'tests/': 'e2e and eval suites that spend real inference; cost is unbounded per mutant',
  'scripts/': 'gate self-tests — they assert about gate programs, not about product behaviour',
  'packages/test-utils/': 'test scaffold, so every export there is legitimately test-only',
  'tools/': 'run by raw node under a separate entrypoint, not by `bun test`',
  'packages/pc-agent/': 'JavaScript checked by `node --check`, outside every mutation target',
} satisfies Record<string, string>;

/** How much longer than the pristine baseline a mutant may run before the sweep stops
 *  waiting. Four, because a mutation that makes work repeat rather than diverge is a
 *  real outcome worth catching, and the baseline already covers ordinary variance. */
const DEADLINE_FACTOR = 4;

type Outcome = 'killed' | 'survived' | 'timeout' | 'crashed';
type Reach = 'unreached' | 'untested';

interface Verdict {
  readonly mutation: Mutation;
  readonly outcome: Outcome;
  /** The suite root or file set that decided it. */
  readonly by: string;
  readonly reach: Reach;
  /** Production files that READ the mutation's symbol — the evidence behind `reach`. */
  readonly readers: readonly string[];
  readonly ms: number;
}

/* ── Refusals ─────────────────────────────────────────────────────────────── */

function git(...args: readonly string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    env: gitEnv(), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

/**
 * Refuse to run anywhere a concurrent reader could load a mutant.
 *
 * The main checkout is shared: other agents, other suites and the editor all read it.
 * A worktree is one branch's own tree, and `setup-worktree.sh` has already given it
 * its own workspace scope, so a mutation there is visible to this process only.
 */
function requireOwnWorktree(): void {
  const tree = git('rev-parse', '--show-toplevel');
  const main = dirname(git('rev-parse', '--path-format=absolute', '--git-common-dir'));
  if (tree === main) {
    throw new Error(
      `Refusing to mutate ${tree}: this is the main checkout, which every other agent, `
      + 'suite and editor reads. In-place mutation in a shared tree makes a test fail for '
      + 'a reason that is not in the code, and every concurrent suite overlapping the '
      + 'window reports a meaningless green or a misattributed red. Run this in a worktree:'
      + '\n  git worktree add ../Kinu-sweep -b test/my-sweep main'
      + '\n  cd ../Kinu-sweep && bash scripts/setup-worktree.sh',
    );
  }
}

/** Refuse when a target file already differs from HEAD. The sweep restores the exact
 *  pristine bytes it read, so a local edit would survive intact — but if this process
 *  is killed outright, `git checkout --` is the recovery, and that recovery must not be
 *  able to destroy work. */
function requireCleanTargets(files: readonly string[]): void {
  const dirty = git('status', '--porcelain', '--', ...files);
  if (dirty !== '') {
    throw new Error(
      `Refusing to mutate: these targets have uncommitted changes, and the recovery from `
      + `an interrupted sweep is 'git checkout --', which would discard them.\n${dirty}`,
    );
  }
}

/**
 * Assert the tiers and the declared exclusions cover every runnable suite.
 *
 * Without this the sweep's scope drifts every time a package is added: a new package's
 * suites would silently defend nothing, and a survivor would be a claim about a corpus
 * nobody selected.
 */
function requireTotalScope(): void {
  const roots = [CORE_TIER, ...OTHER_TIERS].map((tier) => tier.root);
  const orphans = trackedFiles()
    .filter(isRunnableSuite)
    .filter((suite) => !roots.some((r) => suite.startsWith(r)))
    .filter((suite) => !Object.keys(OUT_OF_SCOPE).some((r) => suite.startsWith(r)));
  if (orphans.length > 0) {
    throw new Error(
      `${String(orphans.length)} runnable suites sit under neither a sweep tier nor a `
      + 'declared exclusion, so a survivor would be a claim about a corpus nobody chose. '
      + `Add the root to a tier or to OUT_OF_SCOPE with its reason:\n  ${orphans.join('\n  ')}`,
    );
  }
}

/* ── The mutation, applied and taken back ─────────────────────────────────── */

/** The pristine text of every file this process has mutated, so an interrupt can put
 *  them all back. */
const pristine = new Map<string, string>();

function restoreAll(): void {
  for (const [file, text] of pristine) writeFileSync(join(root, file), text);
  pristine.clear();
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    restoreAll();
    process.exit(130);
  });
}

/**
 * The pristine text of the mutation's file, once it is certain the snippet lands.
 *
 * The exactly-once requirement is this program's own credibility. A snippet that has
 * moved leaves the file untouched, the suites green and the report saying the decision
 * is defended — a survivor that never existed and a kill that never happened. The
 * wording is the one the hand-authored suites use, because the instruction is the same:
 * fix the snippet, never the assertion.
 */
function readAndLocate(mutation: Mutation): string {
  const source = readFileSync(join(root, mutation.file), 'utf8');
  const occurrences = source.split(mutation.find).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `mutation "${mutation.id}" expected exactly one occurrence of `
      + `${JSON.stringify(mutation.find)} in ${mutation.file} and found `
      + `${String(occurrences)}. The snippet has moved, so this mutation would have proven `
      + 'nothing — update the snippet rather than the assertion.',
    );
  }
  return source;
}

function applyMutation(mutation: Mutation): void {
  const source = readAndLocate(mutation);
  pristine.set(mutation.file, source);
  writeFileSync(join(root, mutation.file), source.replace(mutation.find, mutation.replace));
}

function revertMutation(mutation: Mutation): void {
  const text = pristine.get(mutation.file);
  if (text === undefined) throw new Error(`${mutation.file} was never mutated`);
  const path = join(root, mutation.file);
  writeFileSync(path, text);
  pristine.delete(mutation.file);
  const now = readFileSync(path, 'utf8');
  if (now !== text) {
    throw new Error(
      `${mutation.file} did not restore to its pristine bytes after mutation `
      + `"${mutation.id}". Stopping so no later result is measured against a mutant. `
      + `Recover with: git -C ${root} checkout -- ${mutation.file}`,
    );
  }
}

/* ── Running suites ───────────────────────────────────────────────────────── */

interface Run {
  readonly failed: boolean;
  readonly timedOut: boolean;
  /** The runtime died by a signal well inside its deadline, so it says nothing about
   *  the mutation. */
  readonly crashed: boolean;
  readonly ms: number;
  readonly output: string;
}

/**
 * One `bun test` invocation, with a signal death told apart from a deadline.
 *
 * A SIGNAL IS NOT A CLOCK, and reading `exitCode === null` as "timed out" is the
 * mistake this function exists to not make. Measured 2026-08-19: the
 * `provider-options-override-wins` mutant reported TIMEOUT after 78 s against a 216 s
 * deadline, which is arithmetically impossible. The real cause was a Bun 1.3.14
 * segmentation fault in `packages/cli-backend`, and it did not reproduce on the next
 * run — an intermittent runtime crash wearing a clock's clothes. Both a deadline kill
 * and a crash leave `exitCode` null, so the elapsed time is what separates them, and a
 * crash is retried once because an intermittent fault is not a finding.
 */
function runSuites(paths: readonly string[], deadlineMs: number | undefined): Run {
  const started = Date.now();
  // `timeout: undefined` is how the baseline says it has no bound to derive one from —
  // it is the run that MEASURES the bound every later mutant is held to.
  const spawned = Bun.spawnSync({
    cmd: ['bun', 'test', ...paths],
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, FORCE_COLOR: '0' },
    timeout: deadlineMs,
    killSignal: 'SIGKILL',
  });
  const ms = Date.now() - started;
  const bySignal = spawned.exitCode === null;
  const reachedDeadline = deadlineMs !== undefined && ms >= deadlineMs;
  return {
    failed: spawned.exitCode !== 0,
    timedOut: bySignal && reachedDeadline,
    crashed: bySignal && !reachedDeadline,
    ms,
    output: `${spawned.stdout.toString()}${spawned.stderr.toString()}`,
  };
}

/**
 * Suites that could plausibly see this mutation, cheaply: the ones importing the
 * mutated file directly, and the ones naming its symbol.
 *
 * Only ever an optimisation. A mutation surviving this set is escalated to the whole
 * package and then to every other package, so an under-inclusive answer costs time on
 * a kill and can never invent a survivor.
 */
function candidateDefenders(mutation: Mutation): readonly string[] {
  const suites = readMatching((file) => isRunnableSuite(file) && file.endsWith('.ts'));
  const target = join(root, mutation.file);
  const found: string[] = [];
  for (const [file, text] of suites) {
    if (text.includes(mutation.symbol)) {
      found.push(file);
      continue;
    }
    const imports = moduleSpecifiers(parse(file, text).root)
      .filter((spec) => spec.startsWith('.'))
      .map((spec) => join(root, dirname(file), spec));
    if (imports.some((spec) => target === spec || target === `${spec}.ts`)) found.push(file);
  }
  return found;
}

/* ── Reach: the check `gate:dead-code` gets wrong ─────────────────────────── */

/**
 * Production files that READ `symbol`, which is not the same question as which files
 * mention it.
 *
 * An `import` line and a barrel `export … from` line are both references and neither is
 * a reader — counting them is exactly how `agentHomeNodeProvisioner`,
 * `AgentsForkDeps.registry`, `FORK_STRATEGY_ID` and `SwarmRunDeps.mission` passed every
 * check while nothing in production reached them. Test files are out for the same
 * reason: a seam whose only callers are its own tests is unreached, however green.
 *
 * Nor is a WRITE a read, and that distinction is what separates the two survivor
 * classes. `cost.selfMetered = true` and `{ selfMetered: … }` name the field in order to
 * fill it; an interface declares it. A field written by two modules, declared by a
 * third and read by none is dead wiring, and a classifier counting mentions would call
 * it well-connected. So a key, an assignment target and a type declaration are all
 * skipped, and what remains is somebody depending on the value.
 */
function productionReaders(symbol: string, mutatedIn: string): readonly string[] {
  const readers: string[] = [];
  for (const [file, text] of readMatching((f) => isProductSource(f) && f.endsWith('.ts'))) {
    if (file === mutatedIn || !text.includes(symbol)) continue;
    let reads = 0;
    for (const statement of parse(file, text).root.children) {
      if (statement.raw.type === 'ImportDeclaration' || isReExport(statement)) continue;
      // A type-only declaration names members without depending on any value.
      if (declarationOf(statement).node.raw.type.startsWith('TS')) continue;
      walk(statement, (node) => {
        if (node.raw.type !== 'Identifier' || node.raw.name !== symbol) return;
        if (isReadPosition(node)) reads += 1;
      });
    }
    if (reads > 0) readers.push(file);
  }
  return readers;
}

/** False where the identifier names a member in order to declare or fill it. */
function isReadPosition(node: SyntaxNode): boolean {
  const parent = node.parent;
  if (parent === undefined) return true;
  const raw = parent.raw;
  if ((raw.type === 'Property' || raw.type === 'PropertyDefinition'
    || raw.type === 'MethodDefinition' || raw.type === 'TSPropertySignature'
    || raw.type === 'TSMethodSignature') && raw.key === node.raw) {
    return false;
  }
  if (raw.type === 'AssignmentExpression' && raw.left === node.raw) return false;
  if (raw.type === 'MemberExpression' && raw.property === node.raw) {
    const grandparent = parent.parent?.raw;
    return !(grandparent?.type === 'AssignmentExpression' && grandparent.left === parent.raw);
  }
  return true;
}

/* ── The sweep ────────────────────────────────────────────────────────────── */

function sweepOne(mutation: Mutation, baselineMs: number): Verdict {
  const readers = productionReaders(mutation.symbol, mutation.file);
  const reach: Reach = readers.length === 0 ? 'unreached' : 'untested';
  const narrow = candidateDefenders(mutation);
  const stages: readonly { readonly label: string; readonly paths: readonly string[] }[] = [
    { label: `${String(narrow.length)} candidate defenders`, paths: narrow },
    { label: CORE_TIER.root, paths: [CORE_TIER.root] },
    ...OTHER_TIERS.map((tier) => ({ label: tier.root, paths: [tier.root] })),
  ];

  applyMutation(mutation);
  const deadlineMs = baselineMs * DEADLINE_FACTOR;
  let spent = 0;
  for (const stage of stages) {
    if (stage.paths.length === 0) continue;
    let run = runSuites(stage.paths, deadlineMs);
    spent += run.ms;
    // One retry, because an intermittent runtime fault is not a finding — and if it
    // reproduces, that is a fact about the runtime rather than about the mutation.
    if (run.crashed) {
      run = runSuites(stage.paths, deadlineMs);
      spent += run.ms;
    }
    if (run.crashed) {
      revertMutation(mutation);
      return { mutation, outcome: 'crashed', by: stage.label, reach, readers, ms: spent };
    }
    if (run.timedOut) {
      revertMutation(mutation);
      return { mutation, outcome: 'timeout', by: stage.label, reach, readers, ms: spent };
    }
    if (run.failed) {
      revertMutation(mutation);
      return { mutation, outcome: 'killed', by: stage.label, reach, readers, ms: spent };
    }
  }
  revertMutation(mutation);
  return { mutation, outcome: 'survived', by: 'every tier', reach, readers, ms: spent };
}

/**
 * The catalogue, its cost, and a check that every snippet still lands.
 *
 * The snippet check is here rather than only inside the run because a stale snippet
 * found forty minutes into a sweep is forty minutes of nothing. `--list` costs no
 * suites and answers the only question that can silently invalidate the whole report.
 */
function list(): void {
  const worst = CORE_TIER.seconds + OTHER_TIERS.reduce((sum, tier) => sum + tier.seconds, 0);
  const controls = CATALOGUE.filter((m) => m.control !== undefined).length;
  console.log(`${String(CATALOGUE.length)} mutations over `
    + `${String(new Set(CATALOGUE.map((m) => m.file)).size)} files, `
    + `${String(controls)} of them controls that must be killed.`);
  for (const mutation of CATALOGUE) {
    readAndLocate(mutation);
    const kind = mutation.control === undefined ? 'asks    ' : 'control ';
    console.log(`  ${kind} ${mutation.id.padEnd(32)} ${mutation.file}`);
    console.log(`  ${' '.repeat(41)} ${mutation.decision}`);
  }
  console.log('\nEvery snippet still occurs exactly once, so every mutation would land.');
  console.log(`\nA killed mutant costs seconds; a survivor costs ${String(worst)} s, `
    + 'the whole repository. Worst case, every mutation surviving: '
    + `${String(Math.round(CATALOGUE.length * worst / 60))} minutes.`);
}

function report(verdicts: readonly Verdict[], wallMs: number): number {
  const survivors = verdicts.filter((v) => v.outcome === 'survived');
  const timeouts = verdicts.filter((v) => v.outcome === 'timeout');
  const crashes = verdicts.filter((v) => v.outcome === 'crashed');
  const killed = verdicts.filter((v) => v.outcome === 'killed');

  console.log(`\n${String(verdicts.length)} mutations in `
    + `${String(Math.round(wallMs / 1000))} s: ${String(killed.length)} killed, `
    + `${String(survivors.length)} survived, ${String(timeouts.length)} timed out, `
    + `${String(crashes.length)} crashed the runtime.\n`);

  for (const verdict of killed) {
    console.log(`  KILLED    ${verdict.mutation.id.padEnd(34)} by ${verdict.by}`);
  }
  for (const verdict of timeouts) {
    console.log(`  TIMEOUT   ${verdict.mutation.id.padEnd(34)} in ${verdict.by} — read this `
      + 'by hand; a clock cannot tell a blocked suite from a slow one.');
  }
  for (const verdict of crashes) {
    console.log(`  CRASHED   ${verdict.mutation.id.padEnd(34)} in ${verdict.by} — the runtime `
      + 'died by a signal, twice, well inside the deadline. That is a fact about the runtime, '
      + 'not evidence about the suite, so this mutation is unmeasured rather than surviving.');
  }
  for (const verdict of survivors) {
    const where = verdict.reach === 'unreached'
      ? 'nothing in production reads it — wire it or delete it, because a new test would '
        + 'only defend a seam nothing reaches'
      : `read by ${String(verdict.readers.length)} production `
        + `file(s) and asserted by none — ${verdict.readers.slice(0, 3).join(', ')}`;
    console.log(`\n  SURVIVED  ${verdict.mutation.id}  [${verdict.reach.toUpperCase()}]`);
    console.log(`            ${verdict.mutation.file}: ${verdict.mutation.decision}`);
    console.log(`            ${verdict.mutation.find}`);
    console.log(`         -> ${verdict.mutation.replace}`);
    console.log(`            symbol \`${verdict.mutation.symbol}\`: ${where}`);
  }

  // A control that survives is not a finding, it is a broken harness — and every other
  // verdict in the same run was measured by the same broken thing.
  const brokenControls = survivors.filter((v) => v.mutation.control !== undefined);
  if (brokenControls.length > 0) {
    console.log(`\n${String(brokenControls.length)} CONTROL(S) SURVIVED, so this run proves `
      + 'nothing: a decision a named suite already pins came back undefended. Read these '
      + 'before reading any survivor above.');
    for (const verdict of brokenControls) {
      console.log(`  ${verdict.mutation.id} should have been killed by `
        + `${String(verdict.mutation.control)}`);
    }
    return 1;
  }
  if (survivors.length > 0 || timeouts.length > 0) {
    console.log('\nA survivor is undefended behaviour, not a failing build. This program '
      + 'reports; it does not gate.');
  }
  return 0;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes('--list')) {
    list();
    process.exit(0);
  }
  const only = args.indexOf('--only');
  const selected = only === -1
    ? CATALOGUE
    : CATALOGUE.filter((m) => m.id === args[only + 1]);
  if (selected.length === 0) {
    throw new Error(`no mutation matches --only ${String(args[only + 1])}`);
  }

  requireOwnWorktree();
  requireTotalScope();
  requireCleanTargets([...new Set(selected.map((m) => m.file))]);

  // The pristine baseline, measured rather than assumed. A red baseline makes every
  // kill meaningless — the suite was already failing — and it is also where the
  // mutant deadline comes from, so no clock in this program is a hardcoded guess.
  const baseline = runSuites([CORE_TIER.root], undefined);
  if (baseline.failed) {
    throw new Error(
      'The pristine baseline is not green, so a kill would prove nothing about the '
      + `mutation. Fix the suite first.\n${baseline.output.slice(-4000)}`,
    );
  }
  console.log(`baseline ${CORE_TIER.root} green in ${String(Math.round(baseline.ms / 1000))} s; `
    + `each mutant stops at ${String(DEADLINE_FACTOR)}x that.`);

  const started = Date.now();
  const verdicts = selected.map((mutation) => {
    const verdict = sweepOne(mutation, baseline.ms);
    console.log(`  ${verdict.outcome.padEnd(9)} ${verdict.mutation.id.padEnd(34)} `
      + `${String(Math.round(verdict.ms / 1000))} s`);
    return verdict;
  });
  process.exit(report(verdicts, Date.now() - started));
}
