/**
 * Complexity budget — the branching envelope of this tree, measured and pinned.
 *
 * ## What it measures, and why the number is comparable
 *
 * Cyclomatic complexity per FUNCTION: one, plus one for every decision the
 * function's own body makes. A nested function is its own function and its
 * branches belong to it, so a 3-branch handler inside a 40-branch dispatcher
 * scores 4 and 41 rather than 44 twice.
 *
 * The counted set is oxlint's `eslint/complexity`, construct for construct, and
 * that is a measurement rather than a design note. `complexity.test.ts` runs
 * `oxlint` with `complexity: max 0` over the SAME file list this gate reads and
 * joins the two results on the function's byte offset. Measured 2026-09-01,
 * oxlint 1.78.0: 47,994 functions here, every one of them reported by oxlint at
 * the same offset with the SAME number — 0 missing, 0 different. oxlint emits
 * 626 entries this census does not: 601 class field initializers (`readonly x =
 * 3` is not a function) and 25 bodiless declarations, TS overload signatures and
 * `abstract` members. All 626 score 1, so none of them can reach the budget.
 * Two independent implementations, one number. The constructs, each probed
 * against oxlint 1.78.0 on 2026-09-01:
 *
 *   if / for / for-in / for-of / while / do-while / catch / ternary   +1 each
 *   a `case` with a test (`default` adds nothing)                     +1 each
 *   `&&`, `||`, `??`                                                  +1 each
 *   `&&=`, `||=`, `??=`                                               +1 each
 *   a default value — parameter or destructuring (`{ a = 1 }`)        +1 each
 *   an optional link — `a?.b`, `f?.()`                                +1 each
 *
 * The last two are where oxlint is stricter than ESLint 9, and they are counted
 * here because the gate's number has to be the one a reader can reproduce with
 * the linter already in this repository.
 *
 * ## Why a census rather than a lint rule
 *
 * `oxlint -D complexity` answers "is anything over N". It cannot say what N
 * should be, and a threshold nobody measured is the aspirational number this
 * repository keeps finding in its own gates. So the corpus is read through
 * `sources.ts`, every function is measured, and the budget is two lines that
 * the measurement itself put there:
 *
 *   - THE BUDGET LINE is the 99.9th percentile — one function in a thousand.
 *     Every function at or above it is locked BY NAME with its number. A
 *     function that reaches the line names itself; a locked one that grows
 *     names itself; one that is simplified or deleted makes the lock stale,
 *     which forces the re-lock that keeps the list honest.
 *   - THE CEILING is the highest complexity in the tree. Nothing may exceed it,
 *     locked or not, so the envelope cannot widen without an argument.
 *
 * Measured 2026-09-01 over 1,906 parseable tracked files and 48,048 functions:
 * p50 1, p90 4, p99 14, p99.9 39, ceiling 126 (`handleUserRequest`). 47
 * functions sit at or above the line. So today's code passes by construction
 * and growth is what fails, which is the only shape of budget worth having on a
 * tree this size.
 *
 * WHY THE LINE IS p99.9 AND NOT THE TWENTIETH-WORST FUNCTION. The first draft
 * pinned the worst twenty, whose floor is 53. A 40-branch dispatcher injected
 * into `packages/core/src/config.ts` scored 41 and the gate stayed green: a
 * budget that admits a fresh 41-branch function is a budget in name only. p99.9
 * is measured the same way and lands at 39, so that injection is red and the
 * list stays short enough to read. The worst twenty are still printed on every
 * run; they are the head of the same inventory.
 *
 * ## The set it MEASURES and the set it GOVERNS
 *
 * Both are `isParseable` over the enumeration: every tracked file `syntax.ts`
 * can parse, tests and scripts and this gate's own source included. There is no
 * narrowing, so there is nothing to state about what fell out of scope. Tests
 * are in for the same reason product code is — a 60-branch test helper is worth
 * seeing — and they cannot dilute the budget: the worst function in a test file
 * scores 34 against a line of 39, measured the same day.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import * as v from 'valibot';

import { assertMeasured, finding } from './gate-ratchet';
import { isParseable, readMatching } from './sources';
import { declaredName, parse, type SyntaxNode } from './syntax';

const root = new URL('..', import.meta.url).pathname;
const LOCK = `${root}scripts/complexity.lock.json`;

/** How many of the inventory the report prints by name. Twenty is the list a
 *  reader will actually read; the budget itself governs the whole inventory. */
const TIER_SIZE = 20;

/** The three shapes that carry a body of their own. A `MethodDefinition` is not
 *  one: ESTree hangs a `FunctionExpression` off it, and counting both would
 *  measure every method twice. */
const CALLABLE = {
  ArrowFunctionExpression: true,
  FunctionDeclaration: true,
  FunctionExpression: true,
} satisfies Record<string, true>;

const isCallable = (type: string): boolean => Object.hasOwn(CALLABLE, type);

/** What one node adds to the function that encloses it. */
function decisions(node: SyntaxNode): number {
  const { raw } = node;
  switch (raw.type) {
    case 'CatchClause':
    case 'ConditionalExpression':
    case 'DoWhileStatement':
    case 'ForInStatement':
    case 'ForOfStatement':
    case 'ForStatement':
    case 'IfStatement':
    case 'WhileStatement':
      return 1;
    // A `default` clause is the fall-through, not a decision.
    case 'SwitchCase':
      return raw.test === null ? 0 : 1;
    // Every operator, `??` included: each one is a second path through the
    // expression.
    case 'LogicalExpression':
      return 1;
    case 'AssignmentExpression':
      return raw.operator === '&&=' || raw.operator === '||=' || raw.operator === '??=' ? 1 : 0;
    // A default value is a branch taken when the argument is absent.
    case 'AssignmentPattern':
      return 1;
    // `a?.b` and `f?.()` each carry their own short circuit.
    case 'MemberExpression':
    case 'CallExpression':
      return raw.optional ? 1 : 0;
    default:
      return 0;
  }
}

/** One measured function. */
export interface Measured {
  readonly file: string;
  readonly line: number;
  /** Byte offset of the function node, which is the key the equivalence check
   *  in `complexity.test.ts` joins on: oxlint reports the same offset for the
   *  same function, so the two measurements are compared per function rather
   *  than per line, where an overload pair or an inline callback would collide. */
  readonly offset: number;
  /** Qualified within its file: `Class.method`, `outer>inner`, `render>useMemo`. */
  readonly name: string;
  readonly complexity: number;
}

/** The name a class gives the method sitting inside it. */
function enclosingClassName(member: SyntaxNode): string | undefined {
  let up: SyntaxNode | undefined = member.parent;
  while (up !== undefined) {
    if (up.type === 'ClassDeclaration' || up.type === 'ClassExpression') {
      return declaredName(up) ?? '(class)';
    }
    up = up.parent;
  }
  return undefined;
}

/** The callee of the call this function is an argument to — `useKeyboard` for
 *  `useKeyboard((key) => …)`. That is what a reader calls such a callback, and
 *  it survives the line moving, which a `:1255` key does not. */
function calleeLabel(call: SyntaxNode): string | undefined {
  const { raw } = call;
  if (raw.type !== 'CallExpression') return undefined;
  if (raw.callee.type === 'Identifier') return raw.callee.name;
  if (raw.callee.type === 'MemberExpression' && !raw.callee.computed
    && raw.callee.property.type === 'Identifier') {
    return raw.callee.property.name;
  }
  return undefined;
}

/** What this function is called where it is written. */
function labelOf(fn: SyntaxNode): string {
  const own = declaredName(fn);
  const parent = fn.parent;
  if (parent === undefined) return own ?? 'fn';

  if (parent.type === 'MethodDefinition' || parent.type === 'TSAbstractMethodDefinition'
    || parent.type === 'PropertyDefinition') {
    const member = declaredName(parent) ?? 'member';
    const owner = enclosingClassName(parent);
    return owner === undefined ? member : `${owner}.${member}`;
  }
  if (parent.raw.type === 'Property') return declaredName(parent) ?? own ?? 'fn';
  if (parent.raw.type === 'VariableDeclarator') {
    return declaredName(parent) ?? own ?? 'fn';
  }
  if (own !== undefined) return own;
  if (parent.raw.type === 'ExportDefaultDeclaration') return 'default';
  const callee = calleeLabel(parent);
  if (callee !== undefined) return callee;
  if (parent.raw.type === 'JSXExpressionContainer' && parent.parent?.raw.type === 'JSXAttribute') {
    return declaredName(parent.parent) ?? 'prop';
  }
  return 'fn';
}

/**
 * Every function in one file, with its complexity.
 *
 * The walk descends once. A nested callable is visited as its own function and
 * its interior never reaches the enclosing counter, which is what makes the
 * number per-function rather than per-file.
 */
export function measureFile(file: string, text: string): Measured[] {
  const { root: tree, lineAt } = parse(file, text);
  const found: Measured[] = [];
  const used = new Map<string, number>();

  const visit = (node: SyntaxNode, enclosing: string | undefined): void => {
    if (!isCallable(node.type)) {
      for (const child of node.children) visit(child, enclosing);
      return;
    }
    const label = labelOf(node);
    const qualified = enclosing === undefined ? label : `${enclosing}>${label}`;
    // Two callbacks to the same function inside the same owner would otherwise
    // share a key, and a lock keyed on a name that names two things cannot say
    // which of them grew.
    const seen = (used.get(qualified) ?? 0) + 1;
    used.set(qualified, seen);
    const name = seen === 1 ? qualified : `${qualified}#${String(seen)}`;

    let complexity = 1;
    const inner = (current: SyntaxNode): void => {
      for (const child of current.children) {
        if (isCallable(child.type)) {
          visit(child, name);
          continue;
        }
        complexity += decisions(child);
        inner(child);
      }
    };
    inner(node);
    found.push({ file, line: lineAt(node.start), offset: node.start, name, complexity });
  };

  visit(tree, undefined);
  return found;
}

/** Every function in the corpus, worst first. */
export function census(files: ReadonlyMap<string, string>): Measured[] {
  const found: Measured[] = [];
  for (const [file, text] of files) found.push(...measureFile(file, text));
  return found.sort((a, b) => b.complexity - a.complexity
    || a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
}

export interface Distribution {
  readonly functions: number;
  readonly p50: number;
  readonly p90: number;
  readonly p99: number;
  /** The 99.9th percentile: one function in a thousand. This is the BUDGET
   *  LINE — see the header for why the line sits here and not at p99. */
  readonly line: number;
  readonly ceiling: number;
}

export function distribution(measured: readonly Measured[]): Distribution {
  const sorted = measured.map((entry) => entry.complexity).sort((a, b) => a - b);
  const at = (quantile: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))] ?? 0;
  return {
    functions: sorted.length,
    p50: at(0.5),
    p90: at(0.9),
    p99: at(0.99),
    line: at(0.999),
    ceiling: sorted.at(-1) ?? 0,
  };
}

/** The inventory: every function at or above the budget line. Defined by a
 *  complexity rather than by a rank, so a tie at the line admits both and the
 *  membership never depends on sort order. */
export function inventory(measured: readonly Measured[], line: number): Measured[] {
  return measured.filter((entry) => entry.complexity >= line);
}

/** The head of the same inventory: what a reader actually reads. */
export function topTier(measured: readonly Measured[]): Measured[] {
  return [...measured].sort((a, b) => b.complexity - a.complexity).slice(0, TIER_SIZE);
}

export const keyOf = (entry: Measured): string => `${entry.file}#${entry.name}`;

/* ── The lock ─────────────────────────────────────────────────────────── */

const LockEntrySchema = v.object({
  key: v.pipe(v.string(), v.minLength(1)),
  complexity: v.pipe(v.number(), v.minValue(1)),
});

/**
 * The budget, machine-written by `--lock` and never edited by hand.
 *
 * `ceiling` and `line` are recorded rather than derived at read time, so a run
 * states the budget it is holding the tree to and moving either one is a
 * visible diff rather than a silent consequence of the tree changing.
 */
const LockSchema = v.object({
  measuredAt: v.pipe(v.string(), v.minLength(1)),
  files: v.pipe(v.number(), v.minValue(1)),
  functions: v.pipe(v.number(), v.minValue(1)),
  ceiling: v.pipe(v.number(), v.minValue(1)),
  line: v.pipe(v.number(), v.minValue(1)),
  inventory: v.array(LockEntrySchema),
});

export type Budget = v.InferOutput<typeof LockSchema>;

export function readBudget(path = LOCK): Budget {
  return v.parse(LockSchema, JSON.parse(readFileSync(path, 'utf8')));
}

export function writeBudget(budget: Budget, path = LOCK): number {
  writeFileSync(path, `${JSON.stringify(budget, null, 2)}\n`);
  return budget.inventory.length;
}

/** One reason this run is not green. */
export interface Verdict {
  /** Above the recorded ceiling: growth past the envelope itself. */
  readonly over: readonly Measured[];
  /** At or above the budget line and named by no lock entry. */
  readonly entrants: readonly Measured[];
  /** Locked, and more complex than its locked number. */
  readonly grown: readonly { readonly entry: Measured; readonly was: number }[];
  /** Locked and no longer reproducing at its number: deleted, renamed, split,
   *  or simplified. The lock owes an update either way. */
  readonly stale: readonly string[];
}

export function judge(measured: readonly Measured[], budget: Budget): Verdict {
  const locked = new Map(budget.inventory.map((entry) => [entry.key, entry.complexity]));
  const current = new Map(measured.map((entry) => [keyOf(entry), entry]));

  return {
    over: measured.filter((entry) => entry.complexity > budget.ceiling),
    entrants: inventory(measured, budget.line).filter((entry) => !locked.has(keyOf(entry))),
    grown: [...locked].flatMap(([key, was]) => {
      const entry = current.get(key);
      return entry !== undefined && entry.complexity > was ? [{ entry, was }] : [];
    }),
    stale: [...locked]
      .filter(([key, was]) => (current.get(key)?.complexity ?? -1) !== was)
      .map(([key, was]) => `${key} (locked at ${String(was)}, now `
        + `${current.has(key) ? String(current.get(key)?.complexity) : 'absent'})`)
      .sort(),
  };
}

export const isGreen = (verdict: Verdict): boolean =>
  verdict.over.length === 0 && verdict.entrants.length === 0
  && verdict.grown.length === 0 && verdict.stale.length === 0;

/**
 * What this gate cannot see, printed on the GREEN path.
 *
 * A budget that reports a clean tree while saying nothing about what it never
 * counted is how a number gets trusted for a property it never had.
 */
export const BLIND_SPOTS: readonly string[] = [
  'NESTING DEPTH — NOT MEASURED. Cyclomatic complexity counts branches, not how deeply they '
  + 'sit: a flat twenty-case dispatch and five conditionals nested five deep score the same. '
  + 'Cognitive complexity is the measure that separates them and this gate does not compute it.',
  'COMPLEXITY MOVED RATHER THAN REMOVED — NOT DETECTED. Splitting one 60-branch function into '
  + 'six 10-branch helpers passes, with the same total branching in the same call path. That is '
  + 'usually the right refactor, which is exactly why the gate cannot tell it from hiding.',
  'GROWTH BELOW THE LINE — NOT DETECTED. A function at 20 may reach 38 without this gate '
  + 'saying anything, because only the population at or above the budget line is pinned by '
  + 'name. Measured 2026-09-01: 232 functions sit at 20 or more and 47 at the line, so the '
  + 'ungoverned middle is real and is the price of a lock a person can read.',
  'A FILE\'S TOTAL — OUT OF SCOPE. The unit is the function, so a 3,000-line module of 200 '
  + 'simple functions is invisible here. `gate:duplication` and code review own that class.',
  'DATA-DRIVEN DISPATCH — OUT OF SCOPE, and deliberately: a table of 60 handlers scores 1 '
  + 'because the branching moved into data. That is the shape this budget wants, so a gate that '
  + 'counted it would push code the wrong way.',
  'TYPE-LEVEL COMPLEXITY — NOT MEASURED. A conditional type with twelve arms, a 40-member union '
  + 'and a recursive mapped type all cost a reader real work and add nothing to any number here.',
  'RUNTIME COST — NOT MEASURED. Complexity is a count of paths, not of work: one branch around a '
  + 'quadratic scan scores 2.',
];

/* ── Verdict ──────────────────────────────────────────────────────────── */

function printDistribution(spread: Distribution, files: number): void {
  console.log(`complexity: ${String(files)} files, ${String(spread.functions)} functions — `
    + `p50 ${String(spread.p50)}, p90 ${String(spread.p90)}, p99 ${String(spread.p99)}, `
    + `p99.9 ${String(spread.line)}, max ${String(spread.ceiling)}`);
}

function printTier(measured: readonly Measured[], line: number): void {
  const held = inventory(measured, line);
  console.log(`\nthe worst ${String(TIER_SIZE)} functions, by name `
    + `(of ${String(held.length)} at or above the budget line of ${String(line)}):`);
  for (const entry of topTier(measured)) {
    console.log(`  ${String(entry.complexity).padStart(4)}  ${entry.file}:${String(entry.line)} `
      + `${entry.name}`);
  }
}

if (import.meta.main) {
  const files = readMatching(isParseable);
  const measured = census(files);
  const spread = distribution(measured);

  // Upstream of both write paths. An empty corpus, a parser that stopped
  // producing function nodes, or a counter stuck at 1 would each report a tree
  // inside its budget over a population nobody looked at.
  const summary = assertMeasured('complexity', [
    ['files parsed', files.size],
    ['functions measured', spread.functions],
    ['ceiling', spread.ceiling],
    ['budget line', spread.line],
    ['functions at or above the line', inventory(measured, spread.line).length],
  ]);

  if (process.argv.includes('--lock')) {
    const count = writeBudget({
      measuredAt: new Date().toISOString().slice(0, 10),
      files: files.size,
      functions: spread.functions,
      ceiling: spread.ceiling,
      line: spread.line,
      inventory: inventory(measured, spread.line).map((entry) => ({
        key: keyOf(entry), complexity: entry.complexity,
      })),
    });
    printDistribution(spread, files.size);
    console.log(`complexity: locked a ceiling of ${String(spread.ceiling)}, a budget line of `
      + `${String(spread.line)} and ${String(count)} function(s) at or above it, over ${summary}`);
    process.exit(0);
  }

  const budget = readBudget();
  const verdict = judge(measured, budget);
  printDistribution(spread, files.size);

  if (isGreen(verdict)) {
    printTier(measured, budget.line);
    console.log(`\ncomplexity: ok — ceiling ${String(budget.ceiling)}, budget line `
      + `${String(budget.line)}, ${String(budget.inventory.length)} function(s) pinned at or `
      + `above it, all measured ${budget.measuredAt} over ${String(budget.functions)} functions. `
      + `${summary}`);
    for (const spot of BLIND_SPOTS) console.log(`  blind: ${spot}`);
    process.exit(0);
  }

  const findings: string[] = [];
  for (const entry of verdict.over) {
    findings.push(finding({
      at: `${entry.file}:${String(entry.line)} ${entry.name}`,
      invariant: `no function exceeds the measured ceiling of ${String(budget.ceiling)}`,
      found: `complexity ${String(entry.complexity)}`,
      silently: 'the envelope moves by one commit at a time and no reading of the tree ever '
        + 'says so, which is how the worst function here reached 126',
      fix: 'split the decision out, or move the branching into data. Raising the ceiling is a '
        + 'decision to argue with evidence, never a way to clear a red gate',
    }));
  }
  for (const entry of verdict.entrants) {
    findings.push(finding({
      at: `${entry.file}:${String(entry.line)} ${entry.name}`,
      invariant: `every function at or above the budget line of ${String(budget.line)} is named `
        + 'in the lock with its number',
      found: `complexity ${String(entry.complexity)}, and the lock does not name it`,
      silently: 'the hardest functions in this tree change identity with nobody reading the new '
        + 'list, so "which functions are the hardest to change" stops being a question with an '
        + 'answer — and the next one lands beside it for the same reason',
      fix: `bring it under ${String(budget.line)}, or record it with `
        + '`bun scripts/complexity.ts --lock` and say in the commit body why it has to be there',
    }));
  }
  for (const { entry, was } of verdict.grown) {
    findings.push(finding({
      at: `${entry.file}:${String(entry.line)} ${entry.name}`,
      invariant: 'a locked function does not get more complex',
      found: `complexity ${String(entry.complexity)}, locked at ${String(was)}`,
      silently: 'the inventory ratchets the wrong way one branch at a time; every function in it '
        + 'is already at the hard end of this codebase',
      fix: 'take the growth back out, or re-lock with the number and the reason in the commit body',
    }));
  }
  if (verdict.stale.length > 0) {
    console.error(`\ncomplexity: ${String(verdict.stale.length)} locked entr(ies) no longer `
      + 'reproduce at their recorded number.');
    for (const line of verdict.stale) console.error(`  ${line}`);
    console.error('Run `bun scripts/complexity.ts --lock` to record it.');
  }
  if (findings.length > 0) {
    console.error(`\ncomplexity: ${String(findings.length)} finding(s)\n`);
    for (const line of findings) console.error(line);
  }
  process.exit(1);
}
