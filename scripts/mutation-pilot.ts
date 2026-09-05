/**
 * The mutation pilot: a mechanical search for decisions no suite defends.
 *
 * ## Where it sits between the two programs already here
 *
 * `scripts/mutation-fences.ts` is a GATE over four hand-declared fences. Each
 * one names a defect that already shipped, the exact lines that closed it, and
 * the test that must go red when they are stripped. It proves that four known
 * proofs have not rotted. Its own green output states the hole: "a fence nobody
 * declared" — nothing enumerates the guards a module contains.
 *
 * `scripts/mutation-sweep.ts` is a hand-authored CATALOGUE of 20 mutations over
 * `packages/core/src/strategy/` and `packages/core/src/tools/agents-tool.ts`, aimed where
 * an audit had already found four built-and-unwired features. Each entry is a decision
 * someone chose to question, with a sentence saying what it decides.
 *
 * Both need a human to name the line first. This program does not: it GENERATES
 * mutants from the syntax tree over a pinned scope, so the question "which
 * decisions here are undefended" is asked of every decision rather than of the
 * ones somebody thought of. That is the only difference that matters, and it is
 * why a survivor here is a candidate for a new fence rather than a finding about
 * an old one.
 *
 * ## Scope, and why this one
 *
 * `packages/core/src/{heads,events,mcts}` — 59 files, 865 generated mutants. The three
 * subsystems that own DURABLE, CONCURRENT state: the head journal that decides
 * which runs a sweep retires, the events hub that decides what a reader is
 * allowed to see, and the search that decides which node to expand next. Two of
 * the four declared fences live in `heads/journal.ts`, which is evidence that
 * this is where the class lives — and the sweep's catalogue deliberately does
 * not cover any of it.
 *
 * ## The budget, and what it buys
 *
 * The generator finds far more mutants than anyone will read: 865 over this
 * scope, measured 2026-09-01 — 393 negations, 233 guard drops, 138 logic swaps
 * and 101 boundary flips. So the run takes a
 * BUDGET (24 by default) and fills it by round-robin over operators and then
 * over files, deterministically: the same 24 come back every run, `--budget N`
 * moves the line, and `--all` takes the pool. A budget spent evenly across four
 * operators and as many files as possible is the sample that says most about the
 * scope; 24 consecutive mutants from one file would say a great deal about that
 * file and nothing about the rest of the scope.
 *
 * ## What a survivor claims here
 *
 * Two tiers, and the report keeps them apart:
 *   FOCUSED — the suites that import the mutated file, or name the mutated
 *             function. Seconds. Most kills land here.
 *   CORE    — every suite under `packages/core/`, for anything that survived
 *             the focused set. It is the escalation that makes a survivor
 *             credible: 112 of the 294 core suites import `../src/index`
 *             instead of the file, so a focused-only claim would report
 *             survivors the barrel's importers already kill.
 * A mutant that outlives both is a decision no suite in `packages/core` notices
 * changing. That is a statement about the suite, not about the code.
 *
 * WHAT IT COSTS, measured 2026-09-01 on a 12th Gen i9-12900K under bun 1.4.0:
 * the `packages/core/` baseline is 93 s, and on this scope the focused set is
 * frequently EMPTY — the events hub and the mcts internals are reached through
 * `../src/index` by 112 of the 294 core suites and imported directly by few — so
 * most mutants pay the escalation and cost about 92 s each. That is the price of
 * a survivor being credible, and it is why this is a nightly rather than a
 * gate.
 *
 * ## Why in place, and why never in the main checkout
 *
 * Inherited from `mutation-sweep.ts` rather than re-decided, because the
 * measurement behind it is recorded there: a sandbox COPY of this tree — which
 * is exactly how Stryker works — resolves `@kinu.run/*` through the donor's
 * `node_modules` to the PRISTINE package, and 60 core suites plus 23 core
 * sources import `@kinu.run/*`, so a mutant would be invisible to two thirds of
 * its own defenders. A Bun preload plugin was measured and rejected too:
 * `build.onLoad` never fires for a `.ts` under bun 1.3.14. So the mutation is
 * applied in place, this program refuses to run in the main checkout or over a
 * dirty target, every mutation is written and taken back within one mutant, and
 * the restore is verified byte for byte before the next one starts.
 *
 * A TIMEOUT IS NOT A KILL, also inherited: the deadline is a multiple of the
 * baseline this run measures, and a mutant that outlives it is reported in its
 * own class for a human to read.
 *
 * NOT A GATE, and deliberately not wired into any tier: it mutates the working
 * tree, it costs minutes, and its output is a reading list rather than a
 * verdict. `scripts/nightly-mutation.sh` is how it runs unattended.
 *
 *   bun scripts/mutation-pilot.ts --list        # the pool and the sample, running nothing
 *   bun scripts/mutation-pilot.ts               # the budget, killed/survived
 *   bun scripts/mutation-pilot.ts --budget 8
 *   bun scripts/mutation-pilot.ts --only packages/core/src/mcts/uct.ts:44:boundary
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { gitEnv } from '../packages/test-utils/src/git';
import { isProductSource, isRunnableSuite, readMatching, trackedFiles } from './sources';
import {
  functionOwner, isFunctionLike, moduleSpecifiers, ownerName, parse, walk,
  type SyntaxNode,
} from './syntax';

const root = new URL('..', import.meta.url).pathname;

/**
 * The pinned scope, as path prefixes under one package.
 *
 * A prefix list rather than a predicate in `sources.ts`, because this is not a
 * narrowing of the repository's governed set — it is one experiment's subject,
 * chosen for the reason in the header, and `scopeFiles()` derives it from the
 * ONE enumeration so the subject cannot drift wider than the tree.
 */
export const SCOPE: readonly string[] = [
  'packages/core/src/heads/',
  'packages/core/src/events/',
  'packages/core/src/mcts/',
] as const;

/** Every product source under the pinned scope, from the one enumeration. */
export function scopeFiles(): Map<string, string> {
  return readMatching((file) => isProductSource(file) && file.endsWith('.ts')
    && SCOPE.some((prefix) => file.startsWith(prefix)));
}

/* ── Generating mutants ───────────────────────────────────────────────── */

/**
 * The four operators, each a decision with a second plausible reading.
 *
 * Every one of them keeps the file COMPILING, which is the property that makes
 * a mutant evidence about the suite: a mutation `tsc` rejects is caught by the
 * typechecker and says nothing about what the tests assert.
 */
export type Operator = 'negate-condition' | 'boundary' | 'logic' | 'drop-guard';

export interface Mutant {
  /** `file:line:operator`, stable across runs so `--only` can name one. */
  readonly id: string;
  readonly file: string;
  readonly operator: Operator;
  /** The span replaced, in the file's own offsets. */
  readonly start: number;
  readonly end: number;
  readonly before: string;
  readonly after: string;
  readonly line: number;
  /** The function the decision sits in — the report's subject, and one arm of
   *  the defender search. */
  readonly enclosing: string;
}

/** The comparison each boundary flips to: the OTHER reading of the same edge. */
const FLIPPED = {
  '<': '<=', '<=': '<', '>': '>=', '>=': '>',
} satisfies Record<string, string>;

/** `&&` and `||` are each other's other reading. */
const SWAPPED = { '&&': '||', '||': '&&' } satisfies Record<string, string>;

/** A statement that leaves the function or the loop — what makes an `if` a
 *  GUARD rather than a branch, and therefore droppable as a whole. */
const EXITS: ReadonlySet<string> = new Set([
  'ReturnStatement', 'ThrowStatement', 'ContinueStatement', 'BreakStatement',
]);

/** The name of the function a node sits in, for the report. */
function enclosingName(node: SyntaxNode): string {
  let up: SyntaxNode | undefined = node;
  while (up !== undefined) {
    if (isFunctionLike(up)) return ownerName(functionOwner(up)) ?? '(anonymous)';
    up = up.parent;
  }
  return '(top level)';
}

/** Whether an `if` is a GUARD: one exiting statement, and no `else`.
 *  Read through the SPINE rather than through oxc's raw node, so the shape is
 *  the one `walk` already built and nothing here asserts a type it has not
 *  checked. */
function isGuard(node: SyntaxNode): boolean {
  const { raw } = node;
  if (raw.type !== 'IfStatement' || raw.alternate != null) return false;
  const consequent = node.children.find((child) => child.raw === raw.consequent);
  if (consequent === undefined) return false;
  if (EXITS.has(consequent.type)) return true;
  if (consequent.type !== 'BlockStatement' || consequent.children.length !== 1) return false;
  const only = consequent.children[0];
  return only !== undefined && EXITS.has(only.type);
}

/**
 * Every mutant one file offers.
 *
 * A condition is negated rather than replaced by a constant, because `if (true)`
 * is usually dead-code-eliminated by the reader as much as by the compiler:
 * negation keeps both arms reachable and asks the sharper question, which is
 * whether anything asserts on the arm the mutant takes.
 */
export function mutantsIn(file: string, text: string): Mutant[] {
  const parsed = parse(file, text);
  const found: Mutant[] = [];
  const add = (node: SyntaxNode, operator: Operator, start: number, end: number, after: string) => {
    found.push({
      id: `${file}:${parsed.lineAt(start)}:${operator}`,
      file,
      operator,
      start,
      end,
      before: text.slice(start, end),
      after,
      line: parsed.lineAt(start),
      enclosing: enclosingName(node),
    });
  };

  walk(parsed.root, (node) => {
    const { raw } = node;
    if (raw.type === 'IfStatement') {
      const test = node.children.find((child) => child.raw === raw.test);
      if (test !== undefined) {
        add(node, 'negate-condition', test.start, test.end, `!(${text.slice(test.start, test.end)})`);
      }
      // The guard as a whole: dropping it asks whether anything depends on the
      // early exit, which negating the condition cannot ask.
      if (isGuard(node)) add(node, 'drop-guard', node.start, node.end, ';');
      return;
    }
    if (raw.type === 'BinaryExpression' || raw.type === 'LogicalExpression') {
      // A lookup rather than an index: both tables keep their literal key type,
      // and an operator that is in neither is the common case here (`===`, `+`).
      const table = raw.type === 'BinaryExpression' ? FLIPPED : SWAPPED;
      const swapped = Object.entries(table)
        .find(([operator]) => operator === raw.operator)?.[1];
      if (swapped === undefined) return;
      // The operator token sits between the two operands; the left operand's end
      // is where to start looking for it.
      const left = node.children.find((child) => child.raw === raw.left);
      const right = node.children.find((child) => child.raw === raw.right);
      if (left === undefined || right === undefined) return;
      const between = text.slice(left.end, right.start);
      const at = between.indexOf(raw.operator);
      if (at === -1) return;
      const start = left.end + at;
      add(
        node,
        raw.type === 'BinaryExpression' ? 'boundary' : 'logic',
        start,
        start + raw.operator.length,
        swapped,
      );
    }
  });
  return found;
}

/** The whole pool over the pinned scope, in a stable order. */
export function pool(files: ReadonlyMap<string, string>): Mutant[] {
  return [...files]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([file, text]) => mutantsIn(file, text));
}

/**
 * The budget's sample: round-robin over operators, then over files.
 *
 * Deterministic and spread on purpose. The pool is dominated by whichever
 * operator the code happens to offer most of — on this scope that is
 * `negate-condition` — so a prefix of the pool would spend the whole budget on
 * one operator in the first few files, and the run would say nothing about the
 * other three operators or about the other files.
 */
export function select(all: readonly Mutant[], budget: number): Mutant[] {
  const byOperator = new Map<Operator, Mutant[]>();
  for (const mutant of all) {
    byOperator.set(mutant.operator, [...(byOperator.get(mutant.operator) ?? []), mutant]);
  }
  // Within an operator, walk files round-robin too, so one crowded file cannot
  // take the operator's whole share.
  const queues = [...byOperator.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, mutants]) => {
      const byFile = new Map<string, Mutant[]>();
      for (const mutant of mutants) {
        byFile.set(mutant.file, [...(byFile.get(mutant.file) ?? []), mutant]);
      }
      const files = [...byFile.values()];
      const spread: Mutant[] = [];
      for (let depth = 0; spread.length < mutants.length; depth += 1) {
        for (const inFile of files) {
          const next = inFile[depth];
          if (next !== undefined) spread.push(next);
        }
      }
      return spread;
    });

  const chosen: Mutant[] = [];
  for (let depth = 0; chosen.length < budget; depth += 1) {
    let progressed = false;
    for (const queue of queues) {
      const next = queue[depth];
      if (next === undefined) continue;
      progressed = true;
      chosen.push(next);
      if (chosen.length === budget) break;
    }
    if (!progressed) break;
  }
  return chosen;
}

/* ── Defenders ────────────────────────────────────────────────────────── */

/**
 * The suites that could plausibly see one mutant, cheaply: the ones importing
 * the mutated file, and the ones naming the mutated function.
 *
 * Only ever an optimisation, and the escalation below is what keeps it honest —
 * an under-inclusive answer costs seconds on a kill and cannot invent a
 * survivor, because a survivor is re-run against every core suite before it is
 * reported.
 */
export function defenders(
  mutant: Mutant,
  suites: ReadonlyMap<string, string>,
): readonly string[] {
  const target = join(root, mutant.file);
  const found: string[] = [];
  for (const [file, text] of suites) {
    if (mutant.enclosing !== '(anonymous)' && mutant.enclosing !== '(top level)'
      && text.includes(mutant.enclosing)) {
      found.push(file);
      continue;
    }
    const imports = moduleSpecifiers(parse(file, text).root)
      .filter((specifier) => specifier.startsWith('.'))
      .map((specifier) => join(root, dirname(file), specifier));
    if (imports.some((path) => target === path || target === `${path}.ts`)) found.push(file);
  }
  return found;
}

/* ── Applying one mutant, and taking it back ──────────────────────────── */

function git(...args: readonly string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    env: gitEnv(), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

/** Refuse the main checkout: it is shared with every other agent, suite and
 *  editor, and an in-place mutation there makes a test fail for a reason that is
 *  not in the code. `mutation-sweep.ts` states the same refusal for the same
 *  reason; this is the second caller, not a second rule. */
function requireOwnWorktree(): void {
  const tree = git('rev-parse', '--show-toplevel');
  const main = dirname(git('rev-parse', '--path-format=absolute', '--git-common-dir'));
  if (tree === main) {
    throw new Error(
      `Refusing to mutate ${tree}: this is the main checkout, which every other agent, `
      + 'suite and editor reads. Run this in a worktree:'
      + '\n  git worktree add ../Kinu-pilot -b test/my-pilot main'
      + '\n  cd ../Kinu-pilot && bash scripts/setup-worktree.sh',
    );
  }
}

/** Refuse a dirty target: the recovery from an interrupted run is
 *  `git checkout --`, and that recovery must not be able to destroy work. */
function requireCleanTargets(files: readonly string[]): void {
  const dirty = git('status', '--porcelain', '--', ...files);
  if (dirty !== '') {
    throw new Error(
      'Refusing to mutate: these targets have uncommitted changes, and the recovery from '
      + `an interrupted run is 'git checkout --', which would discard them.\n${dirty}`,
    );
  }
}

/** Pristine text of every file this process has touched, so an interrupt can put
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

/** Write the mutant, having proved the span still holds what was parsed. */
function apply(mutant: Mutant): void {
  const path = join(root, mutant.file);
  const source = readFileSync(path, 'utf8');
  const at = source.slice(mutant.start, mutant.end);
  if (at !== mutant.before) {
    throw new Error(
      `${mutant.id}: the span no longer holds ${JSON.stringify(mutant.before)} but `
      + `${JSON.stringify(at)}. The file changed under the run, so this mutant would have `
      + 'proven nothing.',
    );
  }
  pristine.set(mutant.file, source);
  writeFileSync(path, source.slice(0, mutant.start) + mutant.after + source.slice(mutant.end));
}

/** Put the file back, and prove it went back. */
function revert(mutant: Mutant): void {
  const text = pristine.get(mutant.file);
  if (text === undefined) throw new Error(`${mutant.file} was never mutated`);
  const path = join(root, mutant.file);
  writeFileSync(path, text);
  pristine.delete(mutant.file);
  if (readFileSync(path, 'utf8') !== text) {
    throw new Error(
      `${mutant.file} did not restore to its pristine bytes after ${mutant.id}. Stopping so `
      + `no later result is measured against a mutant. Recover with: git -C ${root} checkout `
      + `-- ${mutant.file}`,
    );
  }
}

/* ── Running suites ───────────────────────────────────────────────────── */

interface Run {
  readonly failed: boolean;
  readonly timedOut: boolean;
  readonly ms: number;
  readonly output: string;
}

function runSuites(paths: readonly string[], deadlineMs: number | undefined): Run {
  const started = Date.now();
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
  return {
    failed: spawned.exitCode !== 0,
    // A signal death inside the deadline is a runtime fault, not a clock: the
    // sweep measured one (a bun segfault reported as a 78 s "timeout" against a
    // 216 s deadline) and this program keeps the same distinction.
    timedOut: spawned.exitCode === null && deadlineMs !== undefined && ms >= deadlineMs,
    ms,
    output: `${spawned.stdout.toString()}${spawned.stderr.toString()}`,
  };
}

export type Outcome = 'killed-focused' | 'killed-core' | 'survived' | 'timeout' | 'unrunnable';

export interface Verdict {
  readonly mutant: Mutant;
  readonly outcome: Outcome;
  readonly defenders: readonly string[];
  readonly ms: number;
}

const CORE_TIER = 'packages/core/';

/** How much longer than the measured baseline a mutant may run. Four, because a
 *  mutation that makes work repeat rather than diverge is a real outcome worth
 *  catching, and the baseline already covers ordinary variance. */
const DEADLINE_FACTOR = 4;

function judge(mutant: Mutant, suites: ReadonlyMap<string, string>, baselineMs: number): Verdict {
  const focused = defenders(mutant, suites);
  const deadlineMs = baselineMs * DEADLINE_FACTOR;
  apply(mutant);
  let spent = 0;
  try {
    if (focused.length > 0) {
      const run = runSuites(focused, deadlineMs);
      spent += run.ms;
      if (run.timedOut) return { mutant, outcome: 'timeout', defenders: focused, ms: spent };
      if (run.failed) return { mutant, outcome: 'killed-focused', defenders: focused, ms: spent };
    }
    const escalated = runSuites([CORE_TIER], deadlineMs);
    spent += escalated.ms;
    if (escalated.timedOut) return { mutant, outcome: 'timeout', defenders: focused, ms: spent };
    if (escalated.failed) return { mutant, outcome: 'killed-core', defenders: focused, ms: spent };
    return { mutant, outcome: 'survived', defenders: focused, ms: spent };
  } finally {
    revert(mutant);
  }
}

/* ── The report ───────────────────────────────────────────────────────── */

/** What a survivor of each operator means, in the words a reader needs to write
 *  the missing assertion. */
const MISSING_ASSERTION = {
  'negate-condition': 'no suite distinguishes the two arms of this branch: assert the '
    + 'behaviour the condition selects, not only that the call returns',
  boundary: 'no suite exercises this edge exactly: assert the value AT the bound as well '
    + 'as one either side of it',
  logic: 'no suite supplies an input where the two operands disagree: assert the case '
    + 'where one holds and the other does not',
  'drop-guard': 'no suite reaches this guard: assert the refusal it performs, or delete '
    + 'the guard if nothing can reach it',
} satisfies Record<Operator, string>;

export function render(verdicts: readonly Verdict[], poolSize: number, wallMs: number): string {
  const of = (outcome: Outcome) => verdicts.filter((verdict) => verdict.outcome === outcome);
  const killed = [...of('killed-focused'), ...of('killed-core')];
  const survived = of('survived');
  const lines: string[] = [];

  lines.push(`\nmutation-pilot: ${verdicts.length} mutant(s) of ${poolSize} generated, `
    + `${Math.round(wallMs / 1000)} s — ${killed.length} killed `
    + `(${of('killed-focused').length} by focused suites, ${of('killed-core').length} on `
    + `escalation to ${CORE_TIER}), ${survived.length} survived, ${of('timeout').length} timed `
    + `out, ${of('unrunnable').length} unrunnable.\n`);

  for (const verdict of verdicts) {
    const mark = verdict.outcome.startsWith('killed') ? 'KILLED  ' : verdict.outcome.toUpperCase();
    lines.push(`  ${mark.padEnd(9)} ${verdict.mutant.id.padEnd(58)} `
      + `${String(Math.round(verdict.ms / 1000))} s  ${verdict.defenders.length} focused`);
  }

  for (const verdict of survived) {
    const { mutant } = verdict;
    lines.push(`\n  SURVIVED  ${mutant.id}`);
    lines.push(`            ${mutant.file}:${mutant.line} in ${mutant.enclosing}()`);
    lines.push(`            ${mutant.before}  ->  ${mutant.after}`);
    lines.push(`            ${verdict.defenders.length} focused suite(s) and every suite under `
      + `${CORE_TIER} stayed green.`);
    lines.push(`            missing: ${MISSING_ASSERTION[mutant.operator]}`);
  }

  if (survived.length > 0) {
    lines.push('\nA survivor is undefended behaviour, not a failing build. This program '
      + 'reports; it does not gate.');
  }
  lines.push('\nBlind spots, printed whatever the outcome:');
  lines.push('  - EQUIVALENT MUTANTS. A generated mutation can be a second spelling of the '
    + 'same behaviour, and no run can tell that from an undefended one. Read a survivor '
    + 'before writing its test.');
  lines.push('  - THE SAMPLE. This run judged '
    + `${verdicts.length} of ${poolSize} generated mutants; the rest are unmeasured.`);
  lines.push('  - FOUR OPERATORS. A wrong constant, a swapped argument, an off-by-one index '
    + 'and a dropped `await` are all outside them.');
  lines.push(`  - ONE PACKAGE'S SUITES. Escalation stops at ${CORE_TIER}: a decision defended `
    + 'only by a cf-backend or cli suite reads as a survivor here.');
  lines.push('  - THE WORKING TREE, not HEAD. Uncommitted work in the scope is refused '
    + 'outright rather than measured.');
  return lines.join('\n');
}

/* ── Entry ────────────────────────────────────────────────────────────── */

/** The default sample size. 24 because it covers all four operators across at
 *  least a dozen files while staying inside a nightly's minutes. */
export const BUDGET = 24;

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const value = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at === -1 ? undefined : argv[at + 1];
  };

  const files = scopeFiles();
  const all = pool(files);
  if (all.length === 0) {
    throw new Error(
      `The generator produced no mutants over ${SCOPE.join(', ')}. Either the scope is empty `
      + 'or the operators stopped matching — both are faults in this program, not a clean tree.',
    );
  }

  const only = value('--only');
  const budget = Number(value('--budget') ?? BUDGET);
  const selected = only !== undefined
    ? all.filter((mutant) => mutant.id === only)
    : (argv.includes('--all') ? all : select(all, budget));
  if (selected.length === 0) throw new Error(`no mutant matches --only ${String(only)}`);

  if (argv.includes('--list')) {
    const byOperator = new Map<Operator, number>();
    for (const mutant of all) {
      byOperator.set(mutant.operator, (byOperator.get(mutant.operator) ?? 0) + 1);
    }
    console.log(`${all.length} mutants over ${files.size} files in ${SCOPE.join(', ')}`);
    for (const [operator, count] of [...byOperator].sort()) {
      console.log(`  ${operator.padEnd(18)} ${count}`);
    }
    console.log(`\nthe sample this budget takes (${selected.length}):`);
    for (const mutant of selected) {
      console.log(`  ${mutant.id.padEnd(58)} ${mutant.before} -> ${mutant.after}`);
    }
    process.exit(0);
  }

  requireOwnWorktree();
  requireCleanTargets([...new Set(selected.map((mutant) => mutant.file))]);

  // The pristine baseline, measured rather than assumed. A red baseline makes
  // every kill meaningless, and it is also where the deadline comes from — no
  // clock in this program is a guess.
  const baseline = runSuites([CORE_TIER], undefined);
  if (baseline.failed) {
    throw new Error(
      'The pristine baseline is not green, so a kill would prove nothing about the mutant. '
      + `Fix the suite first.\n${baseline.output.slice(-4000)}`,
    );
  }
  console.log(`baseline ${CORE_TIER} green in ${Math.round(baseline.ms / 1000)} s; `
    + `each run stops at ${DEADLINE_FACTOR}x that.`);

  const suites = readMatching((file) => isRunnableSuite(file) && file.endsWith('.ts')
    && trackedFiles().includes(file));
  const started = Date.now();
  const verdicts: Verdict[] = [];
  for (const mutant of selected) {
    const verdict = judge(mutant, suites, baseline.ms);
    verdicts.push(verdict);
    console.log(`  ${verdict.outcome.padEnd(14)} ${verdict.mutant.id}`);
  }
  console.log(render(verdicts, all.length, Date.now() - started));
}
