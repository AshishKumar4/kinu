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
 * Five kinds, each structural:
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
 *                   `.only`/`.skipIf()`/`.each()` chain or a name bound to one
 *                   (`const liveTest = test.skipIf(…)`); `setDefaultTimeout`
 *                   with a value other than 0; or a vitest config that does not
 *                   set `testTimeout` and `hookTimeout` to 0 (vitest's defaults
 *                   are 5 s and 10 s). `scripts/test-preload.ts` disables bun's
 *                   per-test default, and every bun row runs `--timeout=0`. A
 *                   hang then surfaces where the ladder already kills a gate —
 *                   at its silence deadline — and names the gate, rather than
 *                   as a red on whichever test lost the race.
 *   lap-poll        a wait bounded by a COUNT instead of a duration: a loop
 *                   whose test compares a counter with a number (a literal, a
 *                   binding this file sets to one, a parameter defaulting to
 *                   one), that awaits in its body, and that ends early on a
 *                   condition (a second clause in its test, or a `break` or
 *                   `return` in its body). `until(holds, what)` over 1000
 *                   event-loop laps and a theme read polled 40 times with a
 *                   25 ms sleep are the two this tree had: under load the laps
 *                   run out before the event lands, and the loop reports a
 *                   state it gave up on. Not a wait, and not this kind: a
 *                   fixed repetition with no early exit (`for (let i = 0; i <
 *                   3; i++) await send(i)`); a capped loop that hands the
 *                   subject data each lap (`step(orch, s)`), which runs it;
 *                   and a loop that advances the clock the subject was handed
 *                   (`setSystemTime`, `vi.advanceTimersByTime`), which is the
 *                   repair for a wait. A lap is a timer, a promise made on the
 *                   spot, or a call handing nothing but callbacks.
 *   timeout-option  a duration handed to a wait written outside the corpus: a
 *                   `{ timeout }` option, other than the literal 0, on a library
 *                   wait read by its method name on any receiver (every
 *                   `wait…` method, `vi.waitFor`, `page.goto` and the other
 *                   navigations), or on a bare `child_process` call
 *                   (`execFileSync`, `spawn`, …) or `Bun.spawn`, spelled inline
 *                   or through a name bound to the options; or
 *                   `page.setDefaultTimeout`, `locator.setTimeout` with a value
 *                   other than 0. Zero is the disabled value on both libraries
 *                   (puppeteer 25.10: `if (options.timeout)` guards every
 *                   timer; node: `timeout <= 0` never kills). A wait written
 *                   INSIDE the corpus — this tree's own
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
import { readAliases, readWorkspace, runtimeClosure, runtimeImports } from './import-graph';
import { REPO_ROOT } from './repo-root';
import {
  isManifest, isShippedSource, isTestScaffold, isTypescriptConfig, isVitestConfig, readMatching, readRepositoryFile, readTests,
  trackedFiles,
} from './sources';
import {
  identifierCalleeName, identifierText, literalText, parse, walk, type SyntaxNode,
} from './syntax';

export const CLOCK_KINDS = ['sleep', 'clock-compare', 'test-timeout', 'timeout-option', 'lap-poll'] as const;

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

/** The keys a vitest config sets its clocks with; vitest's own defaults are 5 s and 10 s, so each must be there, 0. */
const VITEST_CLOCKS = ['testTimeout', 'hookTimeout'] as const;

/** A library wait, read by the method's own name on any receiver, chained or
 *  not: every `wait…` method (puppeteer's `waitForSelector`, `waitHandle`,
 *  vitest's `vi.waitFor`) and the navigations, which wait for the load. Their
 *  bodies are not in the corpus, so the option is read where it is handed
 *  over; a wait written inside the corpus is read where it is written. */
const LIBRARY_WAIT = /^(?:wait[A-Z]\w*|waitFor|goto|reload|goBack|goForward|setContent)$/u;

/** A receiver's own wait bound, `locator.setTimeout(n)`; on the timer globals it is a sleep, read first. */
const RECEIVER_TIMEOUT = 'setTimeout';

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

/** The method name of a member call, on any receiver: `waitHandle` in `page.locator(s).waitHandle()`. */
function memberName(call: SyntaxNode): string | undefined {
  const [callee] = call.children;

  if (callee?.raw.type !== 'MemberExpression' || callee.raw.computed) return undefined;
  const property = callee.children[1];

  return property === undefined ? undefined : identifierText(property);
}

/** The runner registration an expression's chain resolves to: `test`, `test.skip`,
 *  `test.skipIf(cond)`, `it.each(rows)`, `describe.only`, or a name this file
 *  bound to one (`const liveTest = test.skipIf(…)`). */
function runnerRoot(node: SyntaxNode | undefined, runners: ReadonlyMap<string, string>): string | undefined {
  let at = node;

  while (at !== undefined) {
    if (at.raw.type === 'Identifier') return Object.hasOwn(RUNNER_CALLS, at.raw.name) ? at.raw.name : runners.get(at.raw.name);

    if (at.raw.type !== 'MemberExpression' && at.raw.type !== 'CallExpression') return undefined;
    [at] = at.children;
  }

  return undefined;
}

/** Names this file binds to a runner chain, in source order so an alias of an alias is found too. */
function runnerBindings(root: SyntaxNode): ReadonlyMap<string, string> {
  const names = new Map<string, string>();

  walk(root, (node) => {
    if (node.raw.type !== 'VariableDeclarator' || node.raw.id.type !== 'Identifier') return;
    const runner = runnerRoot(node.children[1], names);

    if (runner !== undefined) names.set(node.raw.id.name, runner);
  });

  return names;
}

/** Names this file binds to an options object carrying `timeout`: `const SOON = { timeout: 15_000 } as const`. */
function timeoutBindings(root: SyntaxNode): ReadonlySet<string> {
  const names = new Set<string>();

  walk(root, (node) => {
    if (node.raw.type !== 'VariableDeclarator' || node.raw.id.type !== 'Identifier') return;
    const init = node.children[1];

    if (init !== undefined && carriesTimeout(init, names)) names.add(node.raw.id.name);
  });

  return names;
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

/** Whether an options value carries `timeout` with a value other than the
 *  literal 0: an object literal, one spread into it, or a name this file bound
 *  to either. Read in property order, as the object is built, so a later
 *  `timeout: 0` disables a spread one. */
function carriesTimeout(argument: SyntaxNode, named: ReadonlySet<string>): boolean {
  const { raw } = argument;

  if (raw.type === 'Identifier') return named.has(raw.name);

  if (raw.type === 'TSAsExpression' || raw.type === 'TSSatisfiesExpression' || raw.type === 'ParenthesizedExpression') {
    const [inner] = argument.children;

    return inner !== undefined && carriesTimeout(inner, named);
  }

  if (raw.type !== 'ObjectExpression') return false;

  return argument.children.reduce((carried, property) => {
    if (property.raw.type === 'SpreadElement') {
      const [spread] = property.children;

      return spread !== undefined && carriesTimeout(spread, named) ? true : carried;
    }

    if (property.raw.type !== 'Property') return carried;
    const [keyNode, value] = property.children;
    const key = keyNode === undefined ? undefined : identifierText(keyNode) ?? literalText(keyNode);

    return key === TIMEOUT_KEY ? value === undefined || literalNumber(value) !== 0 : carried;
  }, false);
}

/** Whether a call is one of the outside-corpus waits: a library wait by its
 *  method name on any receiver, or a process spawn by its bare or `Bun.` name. */
function isOutsideWait(call: SyntaxNode): boolean {
  const path = calleePath(call);

  if (path !== undefined && Object.hasOwn(PROCESS_WAITS, path)) return true;
  const method = memberName(call);

  return method !== undefined && LIBRARY_WAIT.test(method);
}

/** A trailing runner argument that is a duration: a number other than 0 (the disabled value), a name standing for
 *  one, or an options object carrying `timeout`. */
function isRunnerTimeout(argument: SyntaxNode, named: ReadonlySet<string>): boolean {
  const { raw } = argument;

  if (raw.type === 'Literal') return (literalNumber(argument) ?? 0) !== 0;

  if (raw.type === 'Identifier') return true;

  return carriesTimeout(argument, named);
}

const isFunction = (node: SyntaxNode): boolean =>
  node.raw.type === 'ArrowFunctionExpression' || node.raw.type === 'FunctionExpression';

/** A registration's durations: an options object before the callback (`test(name, { timeout }, fn)`, vitest's
 *  order) and any duration after it (`test(name, fn, 5000)`, bun's). */
function runnerTimeouts(args: readonly SyntaxNode[], named: boolean, timeouts: ReadonlySet<string>): readonly SyntaxNode[] {
  const start = named ? 1 : 0;
  const found = args.findIndex((argument, index) => index >= start && isFunction(argument));
  const callback = found === -1 ? start : found;

  return [
    ...args.slice(start, callback).filter((argument) => carriesTimeout(argument, timeouts)),
    ...args.slice(callback + 1).filter((argument) => isRunnerTimeout(argument, timeouts)),
  ];
}

/** What a call is judged against: the file's timer imports, clock bindings,
 *  runner aliases and timeout-carrying option names. */
interface CallScope {
  readonly timers: ReadonlySet<string>;
  readonly clocks: ReadonlySet<string>;
  readonly runners: ReadonlyMap<string, string>;
  readonly timeouts: ReadonlySet<string>;
}

/** Every call's clock kind, or undefined for a call that carries none. The
 *  kinds are ordered: a timer is a sleep before it is anything else, and a
 *  runner registration is inspected for its trailing argument only. */
function callKind(call: SyntaxNode, scope: CallScope): readonly (readonly [SyntaxNode, ClockKind])[] {
  const { timers, clocks, runners, timeouts } = scope;
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

  const runner = call.raw.type === 'CallExpression' ? runnerRoot(call.children[0], runners) : undefined;

  if (runner !== undefined) {
    return runnerTimeouts(args, Object.hasOwn(NAMED_RUNNER_CALLS, runner), timeouts).map((argument) => [argument, 'test-timeout'] as const);
  }

  if (name === 'expect' && args[0] !== undefined && isClockValue(args[0], clocks)) return [[call, 'clock-compare']];
  const method = memberName(call);

  if (method !== undefined && (Object.hasOwn(PAGE_DEFAULTS, method) || method === RECEIVER_TIMEOUT)) {
    const [value] = args;

    return value !== undefined && literalNumber(value) === 0 ? [] : [[call, 'timeout-option']];
  }

  if (!isOutsideWait(call)) return [];

  return args.filter((argument) => carriesTimeout(argument, timeouts)).map((argument) => [argument, 'timeout-option'] as const);
}

/** Every `key: value` property spelling `key`, with its value. */
function propertiesNamed(root: SyntaxNode, key: string): readonly (readonly [SyntaxNode, SyntaxNode | undefined])[] {
  const found: (readonly [SyntaxNode, SyntaxNode | undefined])[] = [];

  walk(root, (node) => {
    if (node.raw.type !== 'Property') return;
    const [keyNode, value] = node.children;

    if (keyNode !== undefined && (identifierText(keyNode) ?? literalText(keyNode)) === key) found.push([node, value]);
  });

  return found;
}

/** Names this file fixes to a number: `const LAPS = 40`, and a parameter defaulting to one (`laps = 1000`). A `let`
 *  set to one is a counter, the other side of the comparison. */
function numberBindings(root: SyntaxNode): ReadonlySet<string> {
  const names = new Set<string>();

  const bind = (pair: SyntaxNode): void => {
    const [target, value] = pair.children;

    if (target?.raw.type === 'Identifier' && value !== undefined && literalNumber(value) !== undefined) names.add(target.raw.name);
  };

  walk(root, (node) => {
    const { raw } = node;

    if (raw.type === 'AssignmentPattern') bind(node);

    if (raw.type === 'VariableDeclaration' && raw.kind === 'const') {
      for (const declarator of node.children) bind(declarator);
    }
  });

  return names;
}

/** Whether `node` is a number: a numeric literal, or a name bound to one. */
function isNumber(node: SyntaxNode, numbers: ReadonlySet<string>): boolean {
  return literalNumber(node) !== undefined || (node.raw.type === 'Identifier' && numbers.has(node.raw.name));
}

/** Whether a loop test holds a counter bounded by a number: `lap < 1000`, `attempt < LAPS`, `laps-- > 0`. */
function countBounded(test: SyntaxNode, numbers: ReadonlySet<string>): boolean {
  let bounded = false;

  walk(test, (node) => {
    const { raw } = node;

    if (raw.type !== 'BinaryExpression' || !Object.hasOwn(COMPARISONS, raw.operator)) return;
    const [left, right] = node.children;

    if (left !== undefined && right !== undefined && (isNumber(left, numbers) !== isNumber(right, numbers))) bounded = true;
  });

  return bounded;
}

/** The nodes of a loop's own body, not of a function nested in it: an await or an exit there is the function's. */
function ownNodes(node: SyntaxNode, visit: (inner: SyntaxNode) => void): void {
  for (const child of node.children) {
    const { type } = child.raw;

    if (type === 'FunctionDeclaration' || type === 'FunctionExpression' || type === 'ArrowFunctionExpression') continue;
    visit(child);
    ownNodes(child, visit);
  }
}

/** Whether an awaited expression only lets time or other work pass, or reads a state: a timer, a promise made on
 *  the spot, or a call handing nothing but callbacks (`nextTurn()`, `read()`, `page.evaluate(() => …)`). A call
 *  handing the subject data (`step(orch, s)`, `backfill(store, 1)`) drives it, and a capped loop of those is a run
 *  of the subject, not a wait. */
function isLap(awaited: SyntaxNode | undefined, scope: CallScope): boolean {
  if (awaited === undefined) return false;
  const { raw } = awaited;

  if (raw.type === 'NewExpression') return true;

  if (raw.type !== 'CallExpression') return false;
  const path = calleePath(awaited);

  if (path === 'Promise.resolve' || callKind(awaited, scope).some(([, kind]) => kind === 'sleep')) return true;
  const handed = argumentsOf(awaited);

  return handed.every((argument) => argument.raw.type === 'ArrowFunctionExpression' || argument.raw.type === 'FunctionExpression');
}

/** `vi.` calls that move a fake clock the test holds. */
const CLOCK_ADVANCES = {
  'vi.setSystemTime': true, 'vi.advanceTimersByTime': true, 'vi.advanceTimersToNextTimer': true, 'vi.runAllTimers': true,
} satisfies Record<string, true>;

/** Names this file imports `setSystemTime` under, from `bun:test`. */
function clockSetters(root: SyntaxNode): ReadonlySet<string> {
  const names = new Set<string>();

  for (const statement of root.children) {
    const { raw } = statement;

    if (raw.type !== 'ImportDeclaration' || raw.source.value !== 'bun:test') continue;

    for (const specifier of raw.specifiers) {
      if (specifier.type !== 'ImportSpecifier') continue;
      const { imported } = specifier;

      if ((imported.type === 'Identifier' ? imported.name : imported.value) === 'setSystemTime') names.add(specifier.local.name);
    }
  }

  return names;
}

/** What a lap-poll is judged against: a call's scope, plus the file's numbers and clock setters. */
interface LapScope extends CallScope {
  readonly numbers: ReadonlySet<string>;
  readonly setters: ReadonlySet<string>;
}

/** Whether a loop moves the clock its subject was handed: a run the test drives, which is the repair for a wait. */
function advancesClock(loop: SyntaxNode, setters: ReadonlySet<string>): boolean {
  let advances = false;

  ownNodes(loop, (inner) => {
    const name = identifierCalleeName(inner);
    const path = calleePath(inner);

    if ((name !== undefined && setters.has(name)) || (path !== undefined && Object.hasOwn(CLOCK_ADVANCES, path))) advances = true;
  });

  return advances;
}

/** Whether a loop is a lap-capped poll: counted, ending early on a condition, awaiting only laps, and moving no
 *  clock the test holds. */
function isLapPoll(loop: SyntaxNode, scope: LapScope): boolean {
  const { numbers } = scope;
  const { raw } = loop;

  if (raw.type !== 'ForStatement' && raw.type !== 'WhileStatement' && raw.type !== 'DoWhileStatement') return false;
  const test = loop.children.find((child) => child.raw === raw.test);

  if (test === undefined || !countBounded(test, numbers)) return false;
  const awaited: SyntaxNode[] = [];
  let exits = test.raw.type === 'LogicalExpression' && test.raw.operator === '&&';

  ownNodes(loop, (inner) => {
    const { type } = inner.raw;

    if (type === 'AwaitExpression' && inner.children[0] !== undefined) awaited.push(inner.children[0]);

    if (type === 'IfStatement') {
      ownNodes(inner, (branch) => {
        if (branch.raw.type === 'BreakStatement' || branch.raw.type === 'ReturnStatement') exits = true;
      });
    }
  });

  return exits && awaited.length > 0 && awaited.every((each) => isLap(each, scope))
    && !advancesClock(loop, scope.setters);
}

export function auditFile(file: string, text: string): readonly ClockSite[] {
  const { root, lineAt } = parse(file, text);

  const calls: CallScope = {
    timers: timerImports(root), clocks: clockBindings(root), runners: runnerBindings(root), timeouts: timeoutBindings(root),
  };

  const laps: LapScope = { ...calls, numbers: numberBindings(root), setters: clockSetters(root) };
  const sites: ClockSite[] = [];

  const add = (node: SyntaxNode, kind: ClockKind): void => {
    const slice = text.slice(node.start, node.end);
    const newline = slice.indexOf('\n');

    sites.push({
      file, line: lineAt(node.start), kind,
      text: (newline === -1 ? slice : `${slice.slice(0, newline)} …`).trim(),
    });
  };

  if (isVitestConfig(file)) {
    for (const key of VITEST_CLOCKS) {
      const set = propertiesNamed(root, key);

      if (set.length === 0) add(root, 'test-timeout');

      for (const [property, value] of set) if (value === undefined || literalNumber(value) !== 0) add(property, 'test-timeout');
    }
  }

  walk(root, (node) => {
    const { raw } = node;

    if (raw.type === 'CallExpression') {
      for (const [at, kind] of callKind(node, calls)) add(at, kind);

      return;
    }

    if (isLapPoll(node, laps)) {
      add(node, 'lap-poll');

      return;
    }

    if (raw.type !== 'BinaryExpression' || !Object.hasOwn(COMPARISONS, raw.operator)) return;

    if (node.children.some((side) => isClockValue(side, calls.clocks))) add(node, 'clock-compare');
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
  'lap-poll': {
    invariant: 'a wait ends on its condition or on the process\'s own end, never after a count of laps',
    silently: 'under load the laps run out before the event lands, and the loop reports a state it gave up on',
    fix: 'await the event the condition waits for: the promise, the stored row, the emitted frame; the row\'s '
      + 'deadline is the hang detector',
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

/** The one way a lock grows: a kind this gate newly claims, recorded once at the sites it finds, in the commit
 *  that adds the kind. Refused for a kind the lock already holds, and refused when any other kind's count moves in
 *  the same run, so the record admits exactly the new kind's measured debt and launders nothing beside it. */
export function writeNewKindLock(next: ClockLock, kind: ClockKind, path = LOCK): void {
  const previous = readLock(path);
  const held = (lock: ClockLock, file: string, each: string): number => lock.files[file]?.[each] ?? 0;
  const kinds = (lock: ClockLock): Set<string> => new Set(Object.values(lock.files).flatMap((counts) => Object.keys(counts)));

  if (kinds(previous).has(kind)) {
    throw new Error(`test-clocks --new-kind=${kind}: the lock already holds ${kind}; it only shrinks now`);
  }

  const files = new Set([...Object.keys(previous.files), ...Object.keys(next.files)]);

  const moved = [...files].flatMap((file) => [...new Set([...Object.keys(previous.files[file] ?? {}), ...Object.keys(next.files[file] ?? {})])]
    .filter((each) => each !== kind && held(previous, file, each) !== held(next, file, each))
    .map((each) => `${file} [${each}]: ${String(held(previous, file, each))} -> ${String(held(next, file, each))}`));

  if (moved.length > 0) {
    throw new Error(`test-clocks --new-kind=${kind}: another kind's count moved in the same run: ${moved.join(', ')}; `
      + 'record a pay-down with --lock first, then the new kind alone');
  }

  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
}

/** The runners, whose clocks are theirs: the ladder ends a hung gate at its silence deadline (`scripts/deadline.ts`); the
 *  eval harness and the bench score a trial against budgets that are part of its verdict. */
const RUNNERS = ['scripts/ladder.ts', 'evals/src/harness.ts', 'scripts/bench.ts'];

/** A program: run by name (`import.meta.main`), or a module whose default export is a Worker or a config. */
const isProgram = (text: string): boolean => text.includes('import.meta.main') || /^export default\b/mu.test(text);

/** The suite beside a module, which names it as its subject (`reset.ts` and `reset.test.ts`). */
const ownSuites = (file: string): readonly string[] => {
  const stem = file.replace(/\.[cm]?[jt]sx?$/u, '');

  return [`${stem}.test.ts`, `${stem}.test.tsx`];
};

/** The corpus and what its walk could not follow. */
export interface ClockCorpus {
  readonly files: Map<string, string>;
  /** Edges the walk could not resolve to a file: a computed import, or a package entered by its export conditions. */
  readonly unfollowed: readonly string[];
}

/** The corpus: every test file, every vitest config, and what the tests load at runtime up to what they measure —
 *  test-utils, the browser harness, the live-app rows and every other helper a suite waits through — so a wait moved
 *  out of a suite into a helper is still read, not hidden behind the helper's name. The walk stops at shipped product
 *  source, at a runner's modules, at a program and at a module only its own suite imports. */
export function readClockCorpus(): ClockCorpus {
  const tests = readTests();
  const tracked = new Set(trackedFiles());
  const read = (file: string): string => tests.get(file) ?? readRepositoryFile(REPO_ROOT, file);

  const request = {
    universe: tracked,
    workspace: readWorkspace(readMatching(isManifest)),
    aliases: readAliases(readMatching(isTypescriptConfig)),
    read,
  };

  const importers = new Map<string, Set<string>>();

  for (const suite of tests.keys()) {
    for (const { path } of runtimeImports(suite, request).files) importers.set(path, (importers.get(path) ?? new Set()).add(suite));
  }

  const ownSuiteOnly = (file: string): boolean => importers.has(file) && [...importers.get(file) ?? []].every((suite) => ownSuites(file).includes(suite));
  const runners = runtimeClosure(RUNNERS, request, (file) => !isShippedSource(file));

  const helpers = runtimeClosure([...tests.keys()], request, (file) => tests.has(file) || isTestScaffold(file)
    || (!isShippedSource(file) && !runners.files.has(file) && !isProgram(read(file)) && !ownSuiteOnly(file)));

  return {
    files: new Map([...helpers.files, ...[...tracked].filter(isVitestConfig)].sort().map((file) => [file, read(file)])),
    unfollowed: helpers.unfollowed,
  };
}

async function main(): Promise<number> {
  const corpus = readClockCorpus();
  const tests = corpus.files;
  const sites = auditCorpus(tests);

  const measured = assertMeasured('test-clocks', [
    ['test files', tests.size],
    ['kinds searched', CLOCK_KINDS.length],
  ]);

  const current = tally(sites, new Date().toISOString().slice(0, 10));

  const newKind = process.argv.find((word) => word.startsWith('--new-kind='))?.slice('--new-kind='.length);

  if (newKind !== undefined) {
    const kind = CLOCK_KINDS.find((claimed) => claimed === newKind);

    if (kind === undefined) throw new Error(`--new-kind=${newKind}: not a kind this gate claims (${CLOCK_KINDS.join(', ')})`);
    writeNewKindLock(current, kind);
    const recorded = sites.filter((site) => site.kind === kind);
    console.log(`test-clocks: recorded ${String(recorded.length)} ${kind} site(s), the kind's measured debt — ${measured}`);

    for (const site of recorded) console.log(`  ${site.file}:${String(site.line)}  ${site.text}`);

    return 0;
  }

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
      + 'a timer wrapped in product source or a dependency and called by the wrapper\'s name; a duration handed as a '
      + 'bare positional number to an unknown helper; setImmediate and queueMicrotask; a clock read '
      + 'used as a value and never compared; a program\'s own body, its exports a test drives included (plan-demo-film\'s '
      + `walkthrough, which live-app-rows calls); the runners' modules (${RUNNERS.join(', ')}) and what they load.`);

    for (const edge of corpus.unfollowed) console.log(`  unfollowed: ${edge}`);

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
