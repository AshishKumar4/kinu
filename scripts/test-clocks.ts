#!/usr/bin/env bun
/**
 * The test-clock gate: a test proves its property with an end condition, never
 * a wall clock.
 *
 * Five deploy runs went red on 2026-09-15 on five different tests that pass
 * alone and fail under the deploy wave's load. Each was a clock racing the
 * machine: bun's 5 s default over a test that copied the real repository, a
 * 20 ms budget on a real timer, a 15 s PTY deadline whose buffer already held
 * the awaited text, a memo keyed by a shared email, a lost-device swap on a
 * headless GPU. A wait bounded by a duration has two exits, and the second one
 * reads as a defect in whatever ran beside it. This gate refuses the shapes
 * that wait in test code, so the only exits left are the condition and the
 * process's own end (child exit, stream EOF, socket close, a settled promise).
 *
 * Four kinds, each structural:
 *
 *   sleep           a timer call: `setTimeout`, `setInterval`, `Bun.sleep`,
 *                   `Bun.sleepSync`, any binding imported from `timers` or
 *                   `timers/promises`, `scheduler.wait`, `AbortSignal.timeout`.
 *                   Any duration, zero included: a zero-delay timer stands in
 *                   for "let the event loop run", and the event it waits for is
 *                   the thing to await.
 *   clock-compare   `<`, `>`, `<=`, `>=` with a clock value on either side —
 *                   `Date.now()`, `performance.now()`, `Bun.nanoseconds()`,
 *                   `process.hrtime` — read directly, through a binding this
 *                   file initialised from one (the `deadline` variable), or
 *                   through `+`/`-` over either. Also an `expect(...)` whose
 *                   subject is a clock value: a timing assertion is a
 *                   comparison with the matcher spelled out.
 *   test-timeout    a duration handed to the runner: a numeric or identifier
 *                   argument after the callback, or a `{ timeout }` option, on
 *                   `test`/`it`/`describe` and the four hooks, through any
 *                   `.only`/`.skipIf()`/`.each()` chain; or `setDefaultTimeout`
 *                   with a value other than 0. The runner side is pinned by
 *                   `test-clocks.test.ts`: `scripts/test-preload.ts` disables
 *                   bun's per-test default, and every vitest config declares
 *                   `testTimeout: 0` and `hookTimeout: 0`. A hang then surfaces
 *                   where the ladder already kills a gate — at its deploy
 *                   deadline — and names the gate, rather than as a red on
 *                   whichever test lost the race.
 *   timeout-option  a duration handed to a wait written outside the corpus: a
 *                   `{ timeout }` option, other than the literal 0, on a
 *                   puppeteer wait or navigation method (`page.waitForSelector`,
 *                   `frame.waitForFunction`, `page.goto`, …) or on a bare
 *                   `child_process` call (`execFileSync`, `spawn`, …) or
 *                   `Bun.spawn`; or `page.setDefaultTimeout` with a value
 *                   other than 0. Zero is the disabled value on
 *                   both libraries (puppeteer 25.10: `if (options.timeout)`
 *                   guards every timer; node: `timeout <= 0` never kills). A
 *                   wait written INSIDE the corpus — this tree's own
 *                   `waitForText(p, s, { timeoutMs })` helpers — is read where
 *                   it is written, as the sleep or clock-compare its body
 *                   carries, so a `timeoutMs` option handed to a subject as
 *                   configuration is not a finding: the subject's own timer
 *                   under test is a value, not a wait, and the test advances a
 *                   clock the subject was handed.
 *
 * No allowlist and no per-file ignore. A site that must keep a clock is
 * redesigned so it does not: a poll becomes a wait that settles on the
 * condition or rejects with the state reached when the process ends; a "let
 * the loop run" sleep becomes an await on the signal; time inside the subject
 * becomes a clock the subject is handed and the test advances
 * (docs/DEVBOX-DECISIONS.md D19).
 *
 * Blind spots, printed on the green path: a clock value reaching a comparison
 * through a parameter or a return value; a timer wrapped by a module outside
 * the corpus and called by its wrapper's name; a duration handed as a bare
 * positional number to a helper this gate does not know; `setImmediate` and
 * `queueMicrotask`, which yield a turn without a duration and are not clocks;
 * a clock read used as a value (an id, a log field) and never compared. Each
 * of those is a shape an author would have to write on purpose, and none of
 * them is what went red.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as v from 'valibot';

import { assertMeasured, finding, type Finding } from './gate-ratchet';
import { isTestScaffold, readMatching, readTests } from './sources';
import {
  identifierCalleeName, identifierText, literalText, parse, walk, type SyntaxNode,
} from './syntax';

export const CLOCK_KINDS = ['sleep', 'clock-compare', 'test-timeout', 'timeout-option'] as const;

export type ClockKind = (typeof CLOCK_KINDS)[number];

export interface ClockSite {
  readonly file: string;
  readonly line: number;
  readonly kind: ClockKind;
  /** The offending node's first line of source, for the report. */
  readonly text: string;
}

/** Timer globals that take a duration. */
const TIMER_GLOBALS = { setTimeout: true, setInterval: true } satisfies Record<string, true>;

/** Modules whose every export is a timer. */
const TIMER_MODULES = {
  timers: true, 'node:timers': true, 'timers/promises': true, 'node:timers/promises': true,
} satisfies Record<string, true>;

/** `object.member(...)` calls that are timers. */
const TIMER_MEMBERS = {
  'Bun.sleep': true, 'Bun.sleepSync': true, 'globalThis.setTimeout': true, 'globalThis.setInterval': true,
  'window.setTimeout': true, 'window.setInterval': true, 'scheduler.wait': true, 'AbortSignal.timeout': true,
} satisfies Record<string, true>;

/** `object.member(...)` calls that read the wall clock. */
const CLOCK_MEMBERS = {
  'Date.now': true, 'performance.now': true, 'Bun.nanoseconds': true, 'process.hrtime': true,
  'process.hrtime.bigint': true,
} satisfies Record<string, true>;

const COMPARISONS = { '<': true, '>': true, '<=': true, '>=': true } satisfies Record<string, true>;

/** The runner's registration calls whose trailing argument is a timeout. */
const RUNNER_CALLS = {
  test: true, it: true, describe: true, beforeAll: true, beforeEach: true, afterAll: true, afterEach: true,
} satisfies Record<string, true>;

/** Registrations that take a name before the callback, so the timeout is the
 *  third argument rather than the second. */
const NAMED_RUNNER_CALLS = { test: true, it: true, describe: true } satisfies Record<string, true>;

/** The one call that sets the runner's default; `0` disables it and is the
 *  value the preload writes. */
const RUNNER_DEFAULT = 'setDefaultTimeout';

/** Puppeteer methods that take a `{ timeout }` option, read as the last name
 *  of a member call (`page.waitForSelector`, `frame.goto`). Their bodies are
 *  not in the corpus, so the option is read where it is handed over; a wait
 *  written inside the corpus is read where it is written. Only the methods
 *  that take the option: `click` and `type` take none, and `exec` on a subject
 *  of this tree's own is not a puppeteer call. */
const PUPPETEER_WAITS = {
  waitForSelector: true, waitForFunction: true, waitForNavigation: true, waitForNetworkIdle: true,
  waitForResponse: true, waitForRequest: true, waitForFrame: true, waitForTarget: true,
  waitForFileChooser: true, waitForDevicePrompt: true, waitHandle: true,
  goto: true, reload: true, goBack: true, goForward: true, setContent: true, pdf: true,
} satisfies Record<string, true>;

/** Node's `child_process` family, read as a bare imported name, and Bun's
 *  spawn by path. `{ timeout }` there kills the child on a clock; the child
 *  ends on its own exit instead, and a child that never exits is killed with
 *  the gate at the ladder's deadline. */
const PROCESS_WAITS = {
  execFileSync: true, execSync: true, spawnSync: true, execFile: true, exec: true, spawn: true,
  'Bun.spawn': true, 'Bun.spawnSync': true,
} satisfies Record<string, true>;

/** Puppeteer's per-page defaults, by member name; `0` disables them and is
 *  the value the gallery harness sets. */
const PAGE_DEFAULTS = { setDefaultTimeout: true, setDefaultNavigationTimeout: true } satisfies Record<string, true>;

/** The option key the two libraries above spell a wait bound with. */
const TIMEOUT_KEY = 'timeout';

/** A number-valued literal, decoded rather than shape-tested: every literal is
 *  `type: "Literal"` in ESTree and only `value` tells a number from a string. */
const NumberValued = v.object({ value: v.number() });

function literalNumber(node: SyntaxNode): number | undefined {
  if (node.raw.type !== 'Literal') return undefined;
  const decoded = v.safeParse(NumberValued, node.raw);

  return decoded.success ? decoded.output.value : undefined;
}

/** `a.b.c` for a member chain of identifiers, undefined for anything else. */
function memberPath(node: SyntaxNode): string | undefined {
  const { raw } = node;

  if (raw.type === 'Identifier') return raw.name;

  if (raw.type !== 'MemberExpression' || raw.computed) return undefined;
  const [object, property] = node.children;
  const head = object === undefined ? undefined : memberPath(object);
  const tail = property === undefined ? undefined : identifierText(property);

  return head === undefined || tail === undefined ? undefined : `${head}.${tail}`;
}

/** The callee of a call as a dotted path: `Bun.sleep`, `Date.now`. */
function calleePath(call: SyntaxNode): string | undefined {
  if (call.raw.type !== 'CallExpression') return undefined;
  const [callee] = call.children;

  return callee === undefined ? undefined : memberPath(callee);
}

/** The runner registration a chained callee resolves to: `test`, `test.skip`,
 *  `test.skipIf(cond)`, `it.each(rows)`, `describe.only`. */
function runnerOf(call: SyntaxNode): string | undefined {
  let [callee] = call.children;

  while (callee !== undefined) {
    if (callee.raw.type === 'Identifier') return Object.hasOwn(RUNNER_CALLS, callee.raw.name) ? callee.raw.name : undefined;

    if (callee.raw.type !== 'MemberExpression' && callee.raw.type !== 'CallExpression') return undefined;
    [callee] = callee.children;
  }

  return undefined;
}

/** The argument nodes of a call, in order. */
function argumentsOf(call: SyntaxNode): readonly SyntaxNode[] {
  if (call.raw.type !== 'CallExpression') return [];
  const { arguments: args } = call.raw;

  return call.children.filter((child) => args.some((argument) => argument === child.raw));
}

/** Whether an expression IS a clock value: a clock read, a binding this file
 *  initialised from one, or `+`/`-` arithmetic over either. Not an expression
 *  that merely passes a clock read somewhere inside: `run({ now: Date.now() })`
 *  is a subject being handed a clock, which is the repair, and reading its
 *  result is not a comparison. */
function isClockValue(node: SyntaxNode, clocks: ReadonlySet<string>): boolean {
  const { raw } = node;

  if (raw.type === 'CallExpression') {
    const path = calleePath(node);

    return path !== undefined && Object.hasOwn(CLOCK_MEMBERS, path);
  }

  if (raw.type === 'Identifier') return clocks.has(raw.name);

  if (raw.type === 'BinaryExpression' && (raw.operator === '+' || raw.operator === '-')) {
    return node.children.some((side) => isClockValue(side, clocks));
  }

  if (raw.type === 'ParenthesizedExpression' || raw.type === 'TSAsExpression'
    || raw.type === 'TSNonNullExpression' || raw.type === 'UnaryExpression') {
    const [inner] = node.children;

    return inner !== undefined && isClockValue(inner, clocks);
  }

  return false;
}

/** Bindings imported from a timer module, under whatever local name. */
function timerImports(root: SyntaxNode): ReadonlySet<string> {
  const names = new Set<string>();

  for (const statement of root.children) {
    const { raw } = statement;

    if (raw.type !== 'ImportDeclaration' || !Object.hasOwn(TIMER_MODULES, raw.source.value)) continue;

    for (const specifier of raw.specifiers) names.add(specifier.local.name);
  }

  return names;
}

/** Names this file binds to a clock value: `const deadline = Date.now() + 5000`,
 *  in source order so a binding over an earlier one is found too. */
function clockBindings(root: SyntaxNode): ReadonlySet<string> {
  const names = new Set<string>();

  walk(root, (node) => {
    if (node.raw.type !== 'VariableDeclarator' || node.raw.id.type !== 'Identifier') return;
    const init = node.children[1];

    if (init !== undefined && isClockValue(init, names)) names.add(node.raw.id.name);
  });

  return names;
}

/** Whether an object literal carries `timeout` with a value other than the
 *  literal 0. */
function carriesTimeout(argument: SyntaxNode): boolean {
  if (argument.raw.type !== 'ObjectExpression') return false;

  return argument.children.some((property) => {
    if (property.raw.type !== 'Property') return false;
    const [keyNode, value] = property.children;
    const key = keyNode === undefined ? undefined : identifierText(keyNode) ?? literalText(keyNode);

    return key === TIMEOUT_KEY && (value === undefined || literalNumber(value) !== 0);
  });
}

/** Whether a call is one of the outside-corpus waits: a puppeteer method by
 *  its member name, or a process spawn by its bare or `Bun.` name. */
function isOutsideWait(call: SyntaxNode): boolean {
  const path = calleePath(call);

  if (path === undefined) return false;

  if (Object.hasOwn(PROCESS_WAITS, path)) return true;

  return path.includes('.') && Object.hasOwn(PUPPETEER_WAITS, path.slice(path.lastIndexOf('.') + 1));
}

/** A trailing runner argument that is a duration: a number, a name standing
 *  for one, or an options object carrying `timeout`. */
function isRunnerTimeout(argument: SyntaxNode): boolean {
  const { raw } = argument;

  if (raw.type === 'Literal') return literalNumber(argument) !== undefined;

  if (raw.type === 'Identifier') return true;

  return carriesTimeout(argument);
}

/** Every call's clock kind, or undefined for a call that carries none. The
 *  kinds are ordered: a timer is a sleep before it is anything else, and a
 *  runner registration is inspected for its trailing argument only. */
function callKind(
  call: SyntaxNode, timers: ReadonlySet<string>, clocks: ReadonlySet<string>,
): readonly (readonly [SyntaxNode, ClockKind])[] {
  const name = identifierCalleeName(call);
  const path = calleePath(call);
  const args = argumentsOf(call);

  if ((name !== undefined && (Object.hasOwn(TIMER_GLOBALS, name) || timers.has(name))) || (path !== undefined && Object.hasOwn(TIMER_MEMBERS, path))) {
    return [[call, 'sleep']];
  }

  if (name === RUNNER_DEFAULT) {
    const [value] = args;

    return value !== undefined && literalNumber(value) === 0 ? [] : [[call, 'test-timeout']];
  }

  const runner = runnerOf(call);

  if (runner !== undefined) {
    return args.slice(Object.hasOwn(NAMED_RUNNER_CALLS, runner) ? 2 : 1)
      .filter(isRunnerTimeout)
      .map((argument) => [argument, 'test-timeout'] as const);
  }

  if (name === 'expect' && args[0] !== undefined && isClockValue(args[0], clocks)) return [[call, 'clock-compare']];

  if (path !== undefined && Object.hasOwn(PAGE_DEFAULTS, path.slice(path.lastIndexOf('.') + 1))) {
    const [value] = args;

    return value !== undefined && literalNumber(value) === 0 ? [] : [[call, 'timeout-option']];
  }

  if (!isOutsideWait(call)) return [];

  return args.filter(carriesTimeout).map((argument) => [argument, 'timeout-option'] as const);
}

export function auditFile(file: string, text: string): readonly ClockSite[] {
  const { root, lineAt } = parse(file, text);
  const timers = timerImports(root);
  const clocks = clockBindings(root);
  const sites: ClockSite[] = [];

  const add = (node: SyntaxNode, kind: ClockKind): void => {
    const slice = text.slice(node.start, node.end);
    const newline = slice.indexOf('\n');

    sites.push({
      file, line: lineAt(node.start), kind,
      text: (newline === -1 ? slice : `${slice.slice(0, newline)} …`).trim(),
    });
  };

  walk(root, (node) => {
    const { raw } = node;

    if (raw.type === 'CallExpression') {
      for (const [at, kind] of callKind(node, timers, clocks)) add(at, kind);

      return;
    }

    if (raw.type !== 'BinaryExpression' || !Object.hasOwn(COMPARISONS, raw.operator)) return;

    if (node.children.some((side) => isClockValue(side, clocks))) add(node, 'clock-compare');
  });

  return sites;
}

export function auditCorpus(sources: ReadonlyMap<string, string>): readonly ClockSite[] {
  const sites: ClockSite[] = [];

  for (const [file, text] of sources) sites.push(...auditFile(file, text));

  return sites.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
}

const DESCRIBED: Readonly<Record<ClockKind, Omit<Finding, 'at' | 'found'>>> = {
  sleep: {
    invariant: 'a test waits on a condition or on the process\'s own end, never on a duration',
    silently: 'passes alone and fails under load, on whichever test lost the race',
    fix: 'await the signal (the promise, the event, the child exit, the stream EOF), '
      + 'or hand the subject a clock and advance it',
  },
  'clock-compare': {
    invariant: 'no wall-clock value is compared in a test',
    silently: 'the deadline branch reads as a defect in whatever ran beside the test',
    fix: 'wait on the condition and reject with the state reached when the process ends; '
      + 'a duration under test is a clock the subject is handed',
  },
  'test-timeout': {
    invariant: 'no test carries its own duration; the runner default is disabled and the '
      + 'ladder kills a hung gate at its deadline',
    silently: 'a raised timeout hides the wait it was raised for and still loses under the next load',
    fix: 'drop the argument; make the test end on its condition',
  },
  'timeout-option': {
    invariant: 'no wait outside the corpus is handed a duration from a test',
    silently: 'the library\'s deadline fires under load with the awaited state already reached',
    fix: 'drop the option (the gallery harness sets the page default to 0); a child process ends on its own exit',
  },
};

/* ── The shrink-only lock ─────────────────────────────────────────────────
 *
 * The corpus carries the sites this gate found on the day it landed, and they
 * cannot all be redesigned in the commit that adds the gate. So, as every
 * paid-down class here is landed: the count per file and kind is recorded in a
 * machine-written lock, the gate fails on any file the lock does not name and
 * on any count above the locked one, and `--lock` refuses to write a total
 * higher than the one already locked. The only legal direction is smaller.
 * Keyed by path, so a moved file is re-keyed on the path half with its counts
 * byte-identical. */

export const LOCK = new URL('./test-clocks.lock.json', import.meta.url).pathname;

const CountsSchema = v.record(v.string(), v.pipe(v.number(), v.integer(), v.minValue(1)));

const LockSchema = v.object({
  measuredAt: v.string(),
  total: v.pipe(v.number(), v.integer(), v.minValue(0)),
  files: v.record(v.string(), CountsSchema),
});

export type ClockLock = v.InferOutput<typeof LockSchema>;

/** The lock's shape for a set of sites: counts per file and kind, and the total. */
export function tally(sites: readonly ClockSite[], measuredAt: string): ClockLock {
  const files: Record<string, Record<string, number>> = {};

  for (const site of sites) {
    const counts = files[site.file] ?? {};
    counts[site.kind] = (counts[site.kind] ?? 0) + 1;
    files[site.file] = counts;
  }

  const sorted = Object.fromEntries(Object.keys(files).sort().map((file) => [file, files[file] ?? {}]));

  return { measuredAt, total: sites.length, files: sorted };
}

export interface LockVerdict {
  /** Files with sites the lock does not name at all. */
  readonly unlocked: readonly string[];
  /** `file [kind]: found > locked` for every count above the lock. */
  readonly raised: readonly string[];
  /** Locked entries that no longer reproduce in full: the lock needs rewriting. */
  readonly stale: readonly string[];
}

/** The current sites held against the lock. */
export function reconcileLock(current: ClockLock, locked: ClockLock): LockVerdict {
  const unlocked: string[] = [];
  const raised: string[] = [];
  const stale: string[] = [];

  for (const [file, counts] of Object.entries(current.files)) {
    const held = locked.files[file];

    if (held === undefined) {
      unlocked.push(file);
      continue;
    }

    for (const [kind, found] of Object.entries(counts)) {
      const allowed = held[kind] ?? 0;

      if (found > allowed) raised.push(`${file} [${kind}]: ${String(found)} > ${String(allowed)}`);
      else if (found < allowed) stale.push(`${file} [${kind}]: ${String(found)} < ${String(allowed)}`);
    }

    for (const kind of Object.keys(held)) {
      if (!(kind in counts)) stale.push(`${file} [${kind}]: 0 < ${String(held[kind])}`);
    }
  }

  for (const file of Object.keys(locked.files)) {
    if (!(file in current.files)) stale.push(`${file}: no longer holds a site`);
  }

  return { unlocked, raised, stale };
}

export function readLock(path = LOCK): ClockLock {
  return v.parse(LockSchema, JSON.parse(readFileSync(path, 'utf8')));
}

/** Write the lock, refusing a total higher than the one already locked: the
 *  lock records a pay-down, never a raise. A first lock has nothing to shrink
 *  from and is written as found. */
export function writeShrinkingLock(next: ClockLock, path = LOCK): void {
  if (existsSync(path)) {
    const previous = readLock(path);

    if (next.total > previous.total) {
      throw new Error(`test-clocks --lock: refusing to raise the lock from ${String(previous.total)} to `
        + `${String(next.total)} site(s); the lock only shrinks. Redesign the new wait instead.`);
    }

    // Per file and kind, the same rule: an equal total that moved a site
    // from one file to another, or a new file that arrived as another was
    // paid down, is a new site the gate would refuse — so the lock refuses
    // to launder it, and names it the way the gate would.
    const verdict = reconcileLock(next, previous);
    const arrived = [...verdict.unlocked, ...verdict.raised];

    if (arrived.length > 0) {
      throw new Error(`test-clocks --lock: refusing a lock that adds a site: ${arrived.join(', ')}; `
        + 'the lock only shrinks, per file and kind. Redesign the new wait instead.');
    }
  }

  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
}

/** Test helpers that live outside a `tests/` directory and carry no test
 *  suffix, but are read where they are written the way a `tests/helpers/`
 *  file is: the browser harness the ux suites drive Chrome through. */
const HELPERS_OUTSIDE_TESTS: readonly string[] = ['scripts/gallery-harness.ts'];

/** The corpus: every test file, plus the helpers the tests wait through —
 *  `packages/test-utils` and the browser harness — so a wait moved out of a
 *  suite into a helper is still read, not hidden behind the helper's name. */
export function readClockCorpus(): Map<string, string> {
  const tests = readTests();

  for (const [file, text] of readMatching((file) => isTestScaffold(file) || HELPERS_OUTSIDE_TESTS.includes(file))) {
    if (file.endsWith('.ts') || file.endsWith('.tsx')) tests.set(file, text);
  }

  return tests;
}

async function main(): Promise<number> {
  const tests = readClockCorpus();
  const sites = auditCorpus(tests);

  const measured = assertMeasured('test-clocks', [
    ['test files', tests.size],
    ['kinds searched', CLOCK_KINDS.length],
  ]);

  const current = tally(sites, new Date().toISOString().slice(0, 10));

  if (process.argv.includes('--lock')) {
    writeShrinkingLock(current);
    console.log(`test-clocks: locked ${String(current.total)} site(s) over ${String(Object.keys(current.files).length)} file(s) — ${measured}`);

    return 0;
  }

  const locked = readLock();
  const verdict = reconcileLock(current, locked);
  const summary = `locked ${String(locked.total)} (${locked.measuredAt}), found ${String(current.total)} — ${measured}`;

  if (verdict.unlocked.length === 0 && verdict.raised.length === 0 && verdict.stale.length === 0) {
    console.log(`test-clocks: ok — ${summary}`);
    console.log('  blind to: a clock value reaching a comparison through a parameter or a return value; '
      + 'a timer wrapped outside the corpus (test-utils and the browser harness are inside it) and called by the wrapper\'s name; a duration handed as a '
      + 'bare positional number to an unknown helper; setImmediate and queueMicrotask; a clock read '
      + 'used as a value and never compared.');

    return 0;
  }

  console.error(`test-clocks: ${summary}`);

  const named = new Set([...verdict.unlocked, ...verdict.raised.map((line) => line.slice(0, line.indexOf(' [')))]);

  if (verdict.unlocked.length > 0 || verdict.raised.length > 0) {
    console.error(`  ${String(verdict.unlocked.length)} file(s) outside the lock, ${String(verdict.raised.length)} count(s) above it:`);

    for (const line of verdict.raised) console.error(`    ${line}`);

    for (const site of sites.filter((one) => named.has(one.file))) {
      console.error(finding({
        ...DESCRIBED[site.kind], at: `${site.file}:${String(site.line)}  [${site.kind}]`, found: site.text,
      }));
    }
  }

  if (verdict.stale.length > 0) {
    console.error(`  ${String(verdict.stale.length)} locked count(s) no longer reproduce; run \`bun scripts/test-clocks.ts --lock\` to record the pay-down:`);

    for (const line of verdict.stale) console.error(`    ${line}`);
  }

  return 1;
}

if (import.meta.main) process.exit(await main());
