/**
 * Container startup may restore only after the control listener is proven,
 * under the hook's raced budget. Per-request and recovery hooks keep their
 * own narrower rules. The September 13 probe disproved timer starvation.
 */

import { readFileSync } from 'node:fs';

import { readContainerInputBlockSources, readSources } from './sources';
import { sandboxLineage } from './egress-interception';
import {
  blockBodyOf, classMembers, declaredName, functionOf, identifierCalleeName, identifierText,
  isAsync, isFunctionLike, memberCalleeName, parse, returnTypeOf, superClassName,
  type Parsed, type SyntaxNode, walk,
} from './syntax';

/** Base classes whose `onStart` is the container-start hook rather than a
 *  per-request init gate. Pinned by equality, one entry, because widening it is
 *  the only way to widen the exemption and that must be a visible edit. */
const CONTAINER_START_BASES: readonly string[] = ['Sandbox'];

/** The bound a container-start hook must route its work through. */
const START_DEADLINE = 'runRestoreStep';

/**
 * Subclass hooks the vendored init chain AWAITS inside the same gate, each with
 * the call site that proves it. Pinned by equality for the same reason the
 * container bases are: this set is the governed surface, so widening it — or
 * failing to widen it when a vendor bump awaits a new hook — must be an edit
 * somebody makes here rather than a silent change of subject.
 *
 *   • `onFiberRecovered` — `agents/dist/index.js:2602`, awaited by
 *     `_runFiberRecoveryHook` per interrupted row, from `_checkRunFibers`
 *     (`:1033`), which `startAgent` awaits before it calls `onStart`. NOT timed
 *     out: the SDK's own docs say user hooks are not
 *     (`agent-tool-types-*.d.ts:3131`).
 *   • `_handleInternalFiberRecovery` — `:2601`, the framework's own half of the
 *     same hook, wrapped in `_withFiberRecoveryTimeout`. Governed anyway,
 *     because a timeout is not a bound: it abandons the work and leaves the gate
 *     held for however long the timeout is.
 */
const RECOVERY_HOOKS: readonly string[] = [
  'onFiberRecovered', '_handleInternalFiberRecovery',
];

/**
 * The seam a recovery hook must hand the gate, instead of the work.
 *
 * The replacement bound for this population, and the same kind of pin as
 * `withContainerStartDeadline` — with one more property, which is why this rule
 * can be complete without a call graph: the gate also requires the DECLARATION
 * of this name to be synchronous, and a synchronous function cannot await. So
 * "the gate waits on classification only" follows from two syntactic facts (a
 * non-async hook, a non-async classifier) rather than from a claim about
 * everything the classifier reaches.
 */
const RECOVERY_CLASSIFIER = 'classifyRecoveredFiber';

/**
 * Calls that reach OFF the machine, pinned by name — the class of work no
 * `onStart` may launch, awaited or not: provider round trips and external
 * delivery dispatch alike.
 *
 * Pinned by equality for the same reason {@link RECOVERY_HOOKS} is: this list
 * IS the rule, so widening it — or failing to widen it when a new model seam
 * arrives — must be an edit somebody makes here rather than a silent change of
 * subject. Each name either performs a provider round trip or is a lane whose
 * whole purpose is to make one:
 *
 *   • `suggestTitle`, `maybeAutoTitle`, `applyAutoTitle` — the titling chain
 *     that shipped inside `OrchestratorAgent.onStart`, ending in `generateText`.
 *   • `generateText`, `streamText`, `generateJson` — the provider entry points
 *     this repo calls, so a hook that skips the lanes and reaches the SDK
 *     directly is refused by the same rule.
 *   • `runDueSessionEvolution`, `reviewCompletedTurn` — the cadence and advisor
 *     passes, each a model call behind one name.
 *   • `resumeAll`, `replayOwedAndRearm`, `owedDeliveryWork` — the delivery
 *     lanes: owed event replies are external mail and an interrupted terminal
 *     transition replays SMTP and model work. An activation CLASSIFIES and
 *     ARMS the durable wake; the alarm frame dispatches.
 *
 * Names, not a call graph: "Why this shape" above applies unchanged, and the
 * honest limit — a hook that reaches a model under a name not on this list — is
 * printed on the success path rather than left implied. `import.meta.main` also
 * refuses a pin no source mentions, because a stale name is a rule every hook
 * passes.
 */
export const MODEL_SINKS: readonly string[] = [
  'suggestTitle', 'maybeAutoTitle', 'applyAutoTitle',
  'generateText', 'streamText', 'generateJson',
  'runDueSessionEvolution', 'reviewCompletedTurn',
  'resumeAll', 'replayOwedAndRearm', 'owedDeliveryWork',
];

const root = new URL('..', import.meta.url).pathname;

/** The deployment's own list of Durable Object classes. Read from
 *  `wrangler.jsonc` rather than restated here: Cloudflare requires every DO
 *  class to appear there, so it cannot drift, and a hand-kept list is the thing
 *  that drifts. Used only to prove the scan SAW them — the rule itself applies
 *  to every governed hook in the backend; which of the three rules applies is
 *  decided by the member name and the base class the hook belongs to. */
function declaredDurableObjects(): string[] {
  const text = readFileSync(`${root}packages/cf-backend/wrangler.jsonc`, 'utf8');

  // Deduped: the `migrations` block names every class a second time.
  return [...new Set([...text.matchAll(/"class_name"\s*:\s*"(\w+)"/g)].map(([, name]) => name!))].sort();
}

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly owner: string;
  /** The member the rule was applied to. Three populations share this gate now,
   *  so a printed violation that said `.onStart` for a recovery hook would send
   *  a reader to the wrong method. */
  readonly member: string;
  readonly reason: string;
}

/** Where the corpus declares {@link RECOVERY_CLASSIFIER}, and whether that
 *  declaration is synchronous — the second half of the recovery rule. */
export interface ClassifierDeclaration {
  readonly file: string;
  readonly line: number;
  readonly async: boolean;
}

/** Where the corpus declares {@link START_GATE_ARMS}, and the three facts the
 *  container-start rule needs about it. */
export interface ArmsDeclaration {
  readonly file: string;
  readonly line: number;
  readonly deadlineWrapped: boolean;
  readonly portProven: boolean;
  readonly reaches: readonly string[];
  readonly timers: readonly string[];
}

export interface InitGateAudit {
  /** Every governed hook found — the denominator, split by which rule it was
   *  held to, so a hook silently reclassified into a narrower population is
   *  visible in the headline rather than hidden by it. */
  readonly inspected: readonly { file: string; owner: string; member: string; hook: HookKind }[];
  readonly violations: readonly Violation[];
  /** The classification seam's declaration, or `null` when this corpus declares
   *  it nowhere. Null over the WHOLE tree is a stale pin and a gate failure: the
   *  hand-off rule would otherwise be satisfied by a name nothing declares. */
  readonly classifier: ClassifierDeclaration | null;
  /** The container-start hook's handed-back method, or `null` when this corpus
   *  declares it nowhere — which is a stale pin and a gate failure for the same
   *  reason a null classifier is: the hand-back rule would be satisfied by a
   *  name nothing declares. */
  readonly arms: ArmsDeclaration | null;
}

/** Which framework awaits this hook, and therefore which rule it is held to. */
export type HookKind = 'per-request' | 'container-start' | 'recovery';

/**
 * The awaits an ASYNC init gate is allowed to hold, verbatim after whitespace
 * collapse — the owner's 2026-08-31 ruling: bounded, once-per-start work stays
 * in the gate, and the workspace boot (this object's own SQLite: schema,
 * profile, session compose) is that work. Everything else still fails by
 * name, so growing this list is a conscious edit with its own review.
 *
 * PER-REQUEST HOOKS ONLY. Container startup has its own budgeted continuation.
 */
const ADMITTED_INIT_AWAITS: readonly string[] = [
  'await this.hostedWorkspace().bundle.session()',
];

/** The hook's one budgeted continuation. */
const START_GATE_ARMS = 'runStartHook';

const CONTAINER_REACHES: readonly string[] = [
  'exec', 'rawExec', 'containerFetch', 'mountBucket', 'unmountBucket', 'startProcess',
  'killProcess', 'exposePort', 'start', 'startAndWaitForPorts', 'destroy',
  'createBackup', 'restoreBackup', 'attach', 'checkpoint',
  'stampBootId', 'restoreNow', 'adoptOrTurnOver',
];

const DO_SIDE_TIMERS: readonly string[] = ['wait', 'setTimeout', 'setInterval', 'timeout'];

/** Statements that RUN THEIR BODY MORE THAN ONCE. An admitted await inside one
 *  spells exactly the admitted text and holds the gate N times, so the
 *  admission — bounded work owed once at the start of the object's life — would
 *  be satisfied by unbounded work. */
const LOOPS: readonly string[] = [
  'ForStatement', 'ForInStatement', 'ForOfStatement',
  'WhileStatement', 'DoWhileStatement',
];

/**
 * Every own-scope way this body can hold the gate, spelled as written.
 *
 * FOUR SHAPES, because `await` is only the commonest one:
 *   • `AwaitExpression` — admitted when its spelling is on the list AND it is
 *     not inside a loop, since a loop turns one admitted await into N.
 *   • a value-carrying `return` — an async function ADOPTS a returned promise,
 *     so `return this.slowThing()` holds the gate with zero AwaitExpression.
 *   • `for await (… of …)` — a `ForOfStatement` carrying `await: true`. It
 *     awaits once per iteration and contains no AwaitExpression node at all,
 *     which is exactly why the await scan could not see it.
 *   • `await using x = …` — a `VariableDeclaration` whose `kind` carries the
 *     await. Same blind spot, same reason: no AwaitExpression node.
 * A nested `async` function has its own scope and cannot extend the gate, so
 * the walk does not descend into one — descending would report the detached
 * task that IS the prescribed fix.
 */
function rejectedInitAwaits(text: string, body: SyntaxNode | undefined): string[] {
  if (body === undefined) return [];
  const rejected: string[] = [];

  const spell = (node: SyntaxNode): string =>
    text.slice(node.start, node.end).replace(/\s+/g, ' ').trim();

  const collect = (node: SyntaxNode, inLoop: boolean): void => {
    for (const child of node.children) {
      const looping = inLoop || LOOPS.includes(child.type);

      if (child.type === 'AwaitExpression') {
        const spelled = spell(child);

        if (!ADMITTED_INIT_AWAITS.includes(spelled)) rejected.push(spelled);
        else if (looping) rejected.push(`${spelled} inside a loop`);
        continue;
      }

      if (child.type === 'ReturnStatement' && child.children.length > 0) {
        rejected.push(spell(child));
        continue;
      }

      if (child.type === 'ForOfStatement' && child.raw.type === 'ForOfStatement'
        && child.raw.await === true) {
        rejected.push(`for await (…) at ${spell(child).slice(0, 40)}`);
      }

      if (child.type === 'VariableDeclaration' && child.raw.type === 'VariableDeclaration'
        && child.raw.kind.startsWith('await ')) {
        rejected.push(spell(child));
        continue;
      }

      if (isFunctionLike(child)) continue;
      collect(child, looping);
    }
  };

  collect(body, false);

  return rejected;
}

/** An admitted-async gate must actually HOLD one admitted await. `async` with
 *  none is a gate that gains nothing from being async while opting out of the
 *  synchronous population's own rules (no own-scope await, `: void`) — and a
 *  body whose only work is a detached `.then` chain is exactly that shape. */
function admittedInitAwaits(text: string, body: SyntaxNode | undefined): number {
  if (body === undefined) return 0;
  let held = 0;

  const collect = (node: SyntaxNode): void => {
    for (const child of node.children) {
      if (child.type === 'AwaitExpression') {
        if (ADMITTED_INIT_AWAITS.includes(text.slice(child.start, child.end).replace(/\s+/g, ' ').trim())) {
          held += 1;
        }

        continue;
      }

      if (isFunctionLike(child)) continue;
      collect(child);
    }
  };

  collect(body);

  return held;
}

function ownScopeAwait(body: SyntaxNode): SyntaxNode | undefined {
  for (const child of body.children) {
    if (child.type === 'AwaitExpression') return child;

    if (isFunctionLike(child)) continue;
    const nested = ownScopeAwait(child);

    if (nested !== undefined) return nested;
  }

  return undefined;
}

/** `blockConcurrencyWhile` called from inside `onStart`. A synchronous
 *  `onStart` cannot await, but it can still open a NESTED gate and hand it an
 *  async callback — the one way the defect survives an await-free hook. */
function nestedGate(body: SyntaxNode): SyntaxNode | undefined {
  let hit: SyntaxNode | undefined;
  walk(body, (node) => {
    if (hit !== undefined) return;

    if (memberCalleeName(node) === 'blockConcurrencyWhile') hit = node;
  });

  return hit;
}

/**
 * Every {@link MODEL_SINKS} call inside this hook, with the node it sits on.
 *
 * Unlike `ownScopeAwait` this DESCENDS into nested functions, and that is the
 * whole point: the shape it exists to catch is a task the hook SPAWNS, whose
 * own scope is where the model call lives. Work launched from an init hook is
 * still init-path work — the gate merely stops waiting for it.
 */
function modelSinkCalls(body: SyntaxNode): { readonly name: string; readonly node: SyntaxNode }[] {
  const found: { name: string; node: SyntaxNode }[] = [];
  walk(body, (node) => {
    const name = memberCalleeName(node) ?? identifierCalleeName(node);

    if (name !== undefined && MODEL_SINKS.includes(name)) found.push({ name, node });
  });

  return found;
}

/** Every expression this method's own scope hands back, unwrapped through one
 *  `Promise.resolve(…)`. A hook cannot await, so what it RETURNS is the only
 *  other thing the gate can end up waiting on — and `Promise.resolve` adopts a
 *  thenable, so the wrapper is transparent to the gate and must be transparent
 *  here too. Own scope only: a `return` inside a detached callback is that
 *  callback's. */
function handedBack(body: SyntaxNode): SyntaxNode[] {
  const handed: SyntaxNode[] = [];

  const collect = (node: SyntaxNode): void => {
    for (const child of node.children) {
      if (isFunctionLike(child)) continue;

      if (child.type === 'ReturnStatement') {
        const returned = child.children[0];

        if (returned === undefined) {
          handed.push(child);
          continue;
        }

        handed.push(memberCalleeName(returned) === 'resolve'
          && identifierText(returned.children[0]?.children[0] ?? returned) === 'Promise'
          ? returned.children[1] ?? returned
          : returned);
        continue;
      }

      collect(child);
    }
  };

  collect(body);

  return handed;
}

/** Direct reaches must sit under the raced budget, not beside it. */
function armsIn(parsed: Parsed, file: string): ArmsDeclaration | null {
  let found: ArmsDeclaration | null = null;
  let portProven = false;
  walk(parsed.root, (node) => {
    if (memberCalleeName(node) !== 'startAndWaitForPorts' || node.raw.type !== 'CallExpression') return;
    const argument = node.raw.arguments[0];

    if (argument?.type !== 'ObjectExpression') return;
    portProven ||= argument.properties.some((property) =>
      property.type === 'Property' && !property.computed
      && property.key.type === 'Identifier' && property.key.name === 'ports'
      && property.value.type === 'MemberExpression' && !property.value.computed
      && property.value.object.type === 'ThisExpression'
      && property.value.property.type === 'Identifier' && property.value.property.name === 'defaultPort');
  });
  walk(parsed.root, (node) => {
    if (found !== null || node.type !== 'MethodDefinition') return;

    if ((declaredName(node) ?? '').replace(/^#/, '') !== START_GATE_ARMS) return;
    const body = blockBodyOf(functionOf(node) ?? node);
    const timers: string[] = [];
    const reaches: string[] = [];
    let deadlineWrapped = false;

    const collect = (inner: SyntaxNode, budgeted: boolean): void => {
      const called = (memberCalleeName(inner) ?? identifierCalleeName(inner) ?? '').replace(/^#/, '');
      const inside = budgeted || called === START_DEADLINE;

      if (called === START_DEADLINE) deadlineWrapped = true;

      if (!inside && DO_SIDE_TIMERS.includes(called)) timers.push(called);

      if (!inside && CONTAINER_REACHES.includes(called)) reaches.push(called);

      for (const child of inner.children) collect(child, inside);
    };

    if (body !== undefined) collect(body, false);
    found = { file, line: parsed.lineAt(node.start), deadlineWrapped, portProven, timers, reaches };
  });

  return found;
}

/** The declaration of {@link RECOVERY_CLASSIFIER} in one file, if it is here.
 *  A top-level function only: the seam is a module function by design, so a
 *  method or an arrow-typed field of that name is not it. */
function classifierIn(parsed: Parsed, file: string): ClassifierDeclaration | null {
  let found: ClassifierDeclaration | null = null;
  walk(parsed.root, (node) => {
    if (found !== null || node.type !== 'FunctionDeclaration') return;

    if (declaredName(node) !== RECOVERY_CLASSIFIER) return;
    found = { file, line: parsed.lineAt(node.start), async: isAsync(node) };
  });

  return found;
}

/** The hook hands back exactly the singleflight budgeted restore. */
function containerStartBounds(body: SyntaxNode): string[] {
  const returned = handedBack(body);
  const reasons: string[] = [];

  if (returned.length !== 1
    || (memberCalleeName(returned[0]!) ?? '').replace(/^#/, '') !== 'restoreInStartGate') {
    reasons.push('must return this.#restoreInStartGate(): the sole budgeted restore path');
  }

  walk(body, (node) => {
    const called = memberCalleeName(node) ?? identifierCalleeName(node);

    if (called !== undefined && CONTAINER_REACHES.includes(called.replace(/^#/, ''))) {
      reasons.push(`reaches \`${called}\` outside the budgeted restore path`);
    }
  });

  return reasons;
}

function armsViolations(file: string, arms: ArmsDeclaration | null): Violation[] {
  if (arms === null) return [];
  const at = { file, line: arms.line, owner: START_GATE_ARMS, member: START_GATE_ARMS };
  const found: Violation[] = [];

  if (!arms.deadlineWrapped) {
    found.push({ ...at, reason: `must bound the hook with \`${START_DEADLINE}\`` });
  }

  if (!arms.portProven) {
    found.push({ ...at, reason: 'no port-proven startAndWaitForPorts({ports: this.defaultPort}) entry' });
  }

  for (const reached of [...arms.reaches, ...arms.timers]) {
    found.push({ ...at, reason: `reaches \`${reached}\` outside the budgeted restore path` });
  }

  return found;
}

/** A raw superclass start bypasses the required listener proof. */
function unprovenEntries(
  node: SyntaxNode,
  parsed: Parsed,
  context: { readonly file: string; readonly owner: string; readonly hook: HookKind },
): Violation[] {
  if (context.hook !== 'container-start') return [];
  const violations: Violation[] = [];
  walk(node, (call) => {
    if (memberCalleeName(call) !== 'start' || call.raw.type !== 'CallExpression') return;
    const callee = call.raw.callee;

    if (callee.type !== 'MemberExpression' || callee.object.type !== 'Super') return;
    violations.push({
      file: context.file, owner: context.owner, member: 'start', line: parsed.lineAt(call.start),
      reason: 'super.start bypasses control-listener proof before onStart',
    });
  });

  return violations;
}

export function auditFile(
  file: string,
  text: string,
  containerLineage: ReadonlySet<string> = new Set(CONTAINER_START_BASES),
): InitGateAudit {
  const parsed = parse(file, text);
  const inspected: { file: string; owner: string; member: string; hook: HookKind }[] = [];
  const violations: Violation[] = [];

  walk(parsed.root, (node) => {
    if (node.type !== 'ClassDeclaration') return;
    const owner = declaredName(node) ?? '(anonymous class)';
    const base = superClassName(node);

    const startHook: HookKind = base !== undefined && containerLineage.has(base)
      ? 'container-start'
      : 'per-request';

    violations.push(...unprovenEntries(node, parsed, { file, owner, hook: startHook }));

    for (const member of classMembers(node)) {
      if (member.type !== 'MethodDefinition') continue;
      const name = declaredName(member);

      if (name === undefined) continue;

      // Which rule this member is held to, decided by the member name first —
      // the recovery hooks are awaited in the same gate whatever the base is —
      // and then by the base class for the two `onStart` populations.
      const hook: HookKind | undefined = RECOVERY_HOOKS.includes(name)
        ? 'recovery'
        : name === 'onStart' ? startHook : undefined;

      if (hook === undefined) continue;
      const line = parsed.lineAt(member.start);
      inspected.push({ file, owner, member: name, hook });
      const fail = (reason: string): void => void violations.push({ file, line, owner, member: name, reason });

      // Common to all three: `async` is what lets an unbounded await into the
      // gate, and a nested gate is the same gate by another name. ONE admitted
      // exception, the owner's ruling: work that is provably bounded and owed
      // once at the start of the object's life STAYS in the gate — concretely
      // the workspace boot for a per-request hook (2026-08-31). An async
      // per-request gate is therefore legal exactly when every await in its
      // own scope is on the pinned list; any other await fails by name, so
      // admitting a new one is a conscious edit HERE.
      //
      // Container hooks return the pinned singleflight directly; their async
      // continuation carries the raced bound. Recovery hooks remain synchronous.
      const admittedAsyncGate = isAsync(member) && hook === 'per-request';

      if (admittedAsyncGate) {
        const gateBody = blockBodyOf(functionOf(member) ?? member);
        const rejected = rejectedInitAwaits(text, gateBody);

        for (const awaitText of rejected) {
          fail(`holds the gate with \`${awaitText}\` — not on the admitted init-await list `
            + '(ADMITTED_INIT_AWAITS); the gate admits the workspace boot alone, once, '
            + 'outside every loop, and returns nothing');
        }

        // `async` is the admission's own cost, so a gate that holds nothing
        // admitted has paid it for nothing — and has left the synchronous
        // population's rules (no own-scope await, annotated `: void`) while
        // gaining no reason to. The shape this refuses is an `async onStart`
        // whose work is a detached `.then` chain: no await, no return, nothing
        // the await scan can see, and every synchronous rule opted out of. Only
        // when nothing above fired, because a body already refused by name has
        // been told what to fix.
        if (rejected.length === 0 && admittedInitAwaits(text, gateBody) === 0) {
          fail('declared `async` while holding no admitted init await — drop `async` and the '
            + '`: void` rules apply again, or hold the admitted boot');
        }
      } else if (isAsync(member)) {
        fail(hook === 'container-start'
          ? 'declared `async` — return the singleflight restore promise directly'
          : 'declared `async` — its promise is what `blockConcurrencyWhile` waits on');
      }

      // The annotation is not decoration: the bases accept
      // `void | Promise<void>` and `Promise<void | FiberRecoveryResult>`, so the
      // return type silently changes the moment `async` is added, and the
      // widening is invisible in review. Which annotation is required differs — a
      // per-request hook must not hand the gate a promise; a container-start hook
      // must, or its work is detached and the runtime drops it; a recovery hook
      // has no choice about the promise (the SDK awaits it either way) and states
      // instead WHAT it resolves to, because a `void` recovery result leaves a
      // managed fiber row `interrupted` for good.
      const returns = returnTypeOf(member);

      const annotated = returns === undefined
        ? undefined
        : text.slice(returns.start, returns.end).replace(/\s+/g, '');

      if (admittedAsyncGate) {
        // An admitted-async gate annotates the promise it now returns.
        if (annotated !== 'Promise<void>') {
          fail(`must annotate \`: Promise<void>\` explicitly (found \`${annotated ?? 'no annotation'}\`)`);
        }
      } else if (hook === 'recovery') {
        if (annotated === undefined || !annotated.startsWith('Promise<')) {
          fail('must annotate what its promise resolves to, explicitly '
            + `(found \`${annotated ?? 'no annotation'}\`)`);
        }
      } else {
        const wanted = hook === 'container-start' ? 'Promise<void>' : 'void';

        if (annotated !== wanted) {
          fail(`must annotate \`: ${wanted}\` explicitly (found \`${annotated ?? 'no annotation'}\`)`);
        }
      }

      const body = blockBodyOf(functionOf(member) ?? member);

      if (body === undefined) continue;

      if (!admittedAsyncGate && ownScopeAwait(body) !== undefined) {
        fail(hook === 'container-start'
          ? `awaits in its own scope — hand the work to \`${START_DEADLINE}\` and return it, `
            + 'so gate occupancy is bounded below do.block_concurrency.cancel_ms'
          : 'awaits in its own scope — every request on this object waits with it');
      }

      if (nestedGate(body) !== undefined) {
        fail('opens a nested `blockConcurrencyWhile` — the same gate by another name');
      }

      // The class of work, not the shape of the wait. Every check above asks
      // what the gate waits on; this one asks what the hook LAUNCHES, and so it
      // descends into the nested function expression a detached task is written
      // as. The recovery population is exempt: handing a re-drive to a detached
      // durable carrier is its sanctioned answer, and a re-drive may reach the
      // model.
      if (hook !== 'recovery') {
        for (const sink of modelSinkCalls(body)) {
          fail(`reaches \`${sink.name}\` at line ${String(parsed.lineAt(sink.node.start))} — a `
            + 'model call on the init path. Detaching it does not move it off that path: the '
            + 'promise runs against an activation whose gate is still open, and eviction cancels '
            + 'it with its rejection swallowed. Run it from a request frame instead');
        }
      }

      if (hook === 'container-start') {
        for (const reason of containerStartBounds(body)) fail(reason);
      }

      if (hook !== 'recovery') continue;

      // What a non-async method hands back is the only other thing the gate can
      // wait on, and the SDK awaits it. A call to the pinned classifier is the
      // sanctioned answer; a value with nothing to await (a decision taken
      // inline) is the other. Anything else — `return this.reviewTurn(...)`,
      // `return someOtherLane(...)` — is the whole defect this population
      // exists for, and it is invisible to the `async`/`await` checks above.
      for (const returned of handedBack(body)) {
        if (identifierCalleeName(returned) === RECOVERY_CLASSIFIER) continue;

        if (returned.type === 'ObjectExpression' || returned.type === 'Literal') continue;
        fail(`must hand its work to \`${RECOVERY_CLASSIFIER}\` (or resolve a decision inline) — `
          + 'the SDK awaits whatever this returns, inside the init gate, with no timeout');
      }
    }
  });
  const arms = armsIn(parsed, file);
  violations.push(...armsViolations(file, arms));
  const classifier = classifierIn(parsed, file);

  if (classifier !== null && classifier.async) {
    violations.push({
      file, line: classifier.line, owner: RECOVERY_CLASSIFIER, member: RECOVERY_CLASSIFIER,
      reason: 'declared `async` — a recovery hook hands the gate whatever this returns, so an '
        + 'await here is an await inside `blockConcurrencyWhile`; classify synchronously and '
        + 'hand each re-drive to a detached durable carrier',
    });
  }

  return { inspected, violations, classifier, arms };
}

export function audit(sources: ReadonlyMap<string, string>): InitGateAudit {
  const inspected: { file: string; owner: string; member: string; hook: HookKind }[] = [];
  const violations: Violation[] = [];
  let classifier: ClassifierDeclaration | null = null;
  let arms: ArmsDeclaration | null = null;
  const lineage = sandboxLineage(sources);

  for (const [file, text] of sources) {
    // The corpus is narrowed by the names this gate governs, so a file that
    // declares none of them is not parsed. The classifier's own module is in the
    // set because its declaration is half of the recovery rule.
    if (!text.includes('onStart') && !RECOVERY_HOOKS.some((name) => text.includes(name))
      && !text.includes(RECOVERY_CLASSIFIER) && !text.includes(START_GATE_ARMS)) continue;
    const one = auditFile(file, text, lineage);
    inspected.push(...one.inspected);
    violations.push(...one.violations);
    classifier ??= one.classifier;
    arms ??= one.arms;
  }

  return { inspected, violations, classifier, arms };
}

/** 2026-09-13 cloud trace b20260913105359: container.js:641 held onStart
 * at :644 while Devbox's boot-id RPC (:3495) never received its reply.
 * Follow named local methods, including the virtual SDK onStart edge. */
export function auditBlockBodies(sources: ReadonlyMap<string, string>): Violation[] {
  const methods = new Map<string, SyntaxNode[]>();
  const parameters = new Map<string, readonly (string | undefined)[]>();
  const parsed = [...sources].map(([file, text]) => ({ file, text, tree: parse(file, text) }));

  for (const { tree } of parsed) walk(tree.root, node => {
    if (node.type !== 'MethodDefinition' && node.type !== 'FunctionDeclaration') return;
    const name = (declaredName(node) ?? '').replace(/^#/, '');
    const body = blockBodyOf(functionOf(node) ?? node);

    if (name && body) methods.set(name, [...methods.get(name) ?? [], body]);
    const fn = functionOf(node)?.raw;

    if (name && fn && (fn.type === 'FunctionExpression' || fn.type === 'FunctionDeclaration')) {
      parameters.set(name, fn.params.map(param => param.type === 'Identifier' ? param.name : undefined));
    }
  });

  // A recovery write passes its storage transaction as `apply`. That callback
  // is part of the block body too; follow every direct argument at its calls.
  for (const { tree } of parsed) walk(tree.root, node => {
    if (node.raw.type !== 'CallExpression') return;
    const called = (memberCalleeName(node) ?? identifierCalleeName(node) ?? '').replace(/^#/, '');
    const args = node.raw.arguments;
    (parameters.get(called) ?? []).forEach((parameter, index) => {
      if (!parameter) return;
      const argument = node.children.find(child => child.start === args[index]?.start);
      const body = argument && isFunctionLike(argument) ? blockBodyOf(argument) ?? argument : undefined;

      if (body) methods.set(parameter, [...methods.get(parameter) ?? [], body]);
    });
  });
  const violations: Violation[] = [];

  for (const { file, tree } of parsed) walk(tree.root, node => {
    if (node.raw.type !== 'CallExpression' || memberCalleeName(node) !== 'blockConcurrencyWhile') return;
    const rawArgument = node.raw.arguments[0];
    const argument = node.children.find(child => child.start === rawArgument?.start);

    if (!argument) return;
    const visited = new Set<SyntaxNode>();
    const reached = new Set<string>();

    const inspect = (body: SyntaxNode): void => {
      if (visited.has(body)) return;
      visited.add(body);

      const visit = (call: SyntaxNode): void => {
        if (call !== body && isFunctionLike(call)) return;
        const called = (memberCalleeName(call) ?? identifierCalleeName(call) ?? '').replace(/^#/, '');
        const raw = call.raw;

        if (raw.type === 'CallExpression' && raw.callee.type === 'MemberExpression') {
          const receiver = raw.callee.object;

          // SQLite's exec is not a container command.
          if (receiver.type === 'MemberExpression' && !receiver.computed
            && receiver.property.type === 'Identifier' && receiver.property.name === 'sql') return;

          if (CONTAINER_REACHES.includes(called) && called !== 'adoptOrTurnOver' && called !== 'restoreNow' && called !== 'stampBootId') reached.add(called);

          if (receiver.type === 'ThisExpression' || receiver.type === 'Super') {
            for (const target of methods.get(called) ?? []) inspect(target);
          }

          if (called === 'transaction' || called === 'then' || called === 'blockConcurrencyWhile') {
            for (const child of call.children) if (isFunctionLike(child)) inspect(child);
          }
        } else if (called) {
          for (const target of methods.get(called) ?? []) inspect(target);
        }

        if (called === START_DEADLINE) {
          for (const child of call.children) if (isFunctionLike(child)) inspect(child);
        }

        for (const child of call.children) visit(child);
      };

      visit(body);
    };

    inspect(argument);

    for (const sink of reached) violations.push({ file, line: tree.lineAt(node.start), owner: 'blockConcurrencyWhile', member: sink, reason: `input block reaches container RPC \`${sink}\`; release the storage block before container work` });
  });

  return violations;
}

/** Product corpus comes from sources.ts; SDK files come from the installed
 * packages that supply the input blocks, not a copied vendor fixture. */
export function containerBlockSources(sources: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  const selected = new Map([...sources].filter(([, text]) => text.includes('blockConcurrencyWhile') || text.includes('class Devbox')));

  for (const [file, text] of readContainerInputBlockSources()) selected.set(file, text);

  return selected;
}

if (import.meta.main) {
  const sources = readSources();
  const { inspected, violations, classifier, arms } = audit(sources);
  const blockViolations = auditBlockBodies(containerBlockSources(sources));

  // Denominator. A gate that finds nothing because it looked nowhere is the
  // failure this whole exercise is about.
  const declared = declaredDurableObjects();

  const ours = declared.filter((cls) =>
    [...sources].some(([, text]) => text.includes(`class ${cls} `)));

  // A class wrangler declares but this repo does not define is a vendor base
  // re-exported for the binding (NimbusSession). Its startup runs in the same
  // gate and does I/O we do not control; that is residual risk, not something
  // this gate can assert. Named, never silently dropped.
  const vendor = declared.filter((cls) => !ours.includes(cls));

  const problems: string[] = [];

  for (const found of blockViolations) problems.push(`${found.file}:${found.line}: ${found.reason}`);

  if (inspected.length === 0) {
    problems.push('found 0 governed hooks — the matcher is not matching');
  }

  if (ours.length === 0) {
    problems.push('parsed none of the Durable Object classes wrangler.jsonc declares');
  }

  // Three rules, three denominators. The narrow ones are what an exemption would
  // hide behind, so an empty population is a gate failure: it means a base was
  // renamed, or `CONTAINER_START_BASES` / `RECOVERY_HOOKS` stopped matching, and
  // in every one of those cases nothing is holding that hook to anything.
  const empty = {
    'per-request': 'the matcher is not matching',
    'container-start': 'no class belongs to the Sandbox lineage',
    recovery: `no class overrides one of ${RECOVERY_HOOKS.join(', ')}`,
  } satisfies Record<HookKind, string>;

  for (const hook of ['per-request', 'container-start', 'recovery'] as const) {
    if (inspected.some((i) => i.hook === hook)) continue;
    problems.push(`found 0 ${hook} hook implementations — ${empty[hook]}`);
  }

  // The recovery rule's other half. A pin nothing declares is a rule every hook
  // passes, which reads exactly like a rule every hook obeys.
  if (classifier === null) {
    problems.push(`no source declares \`${RECOVERY_CLASSIFIER}\` — the recovery hand-off rule `
      + 'is pinned to a name that no longer exists');
  }

  // The container-start rule's other half, and the same argument again: the ONE
  // call a marked hook may hand back is pinned by name, so a name nothing
  // declares would leave the marker's claim checked against nothing — and the
  // gate looking green while nothing at all was checked about the hook's work.
  if (arms === null) {
    problems.push(`no source declares \`${START_GATE_ARMS}\` — the container-start hook's `
      + 'handed-back method is pinned to a name that no longer exists');
  }

  // The sink rule's other half, and the same argument the classifier pin makes:
  // a name no source mentions is a rule every hook passes, which reads exactly
  // like a rule every hook obeys.
  const unmentioned = MODEL_SINKS.filter(
    (sink) => ![...sources].some(([, text]) => text.includes(sink)),
  );

  if (unmentioned.length > 0) {
    problems.push(`no source mentions ${unmentioned.join(', ')} — the model-sink pin is stale, `
      + 'so those names can no longer refuse anything');
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`do-init-gate: ${problem}`);
    process.exit(1);
  }

  const counted = (hook: HookKind): number => inspected.filter((i) => i.hook === hook).length;

  if (violations.length === 0) {
    console.log(
      `do-init-gate: ok — ${inspected.length} governed hook(s) across `
      + `${new Set(inspected.map((i) => i.owner)).size} class(es) `
      + `(${counted('per-request')} per-request onStart, ${counted('container-start')} `
      + `container-start onStart, ${counted('recovery')} SDK-awaited recovery); `
      + `${ours.length}/${declared.length} wrangler-declared DO classes defined here and parsed`
      + (vendor.length > 0 ? `; not ours: ${vendor.join(', ')}` : '')
      + '; input blocks reach no named container RPC through local/virtual methods'
      + '\n  block-call graph is blind to computed names, imported helpers and indirectly passed callbacks'
      // The blind spots, on the SUCCESS path, because a limitation visible only
      // in red output is invisible exactly when the tree is green.
      + `\ndo-init-gate: blind to — what \`${RECOVERY_CLASSIFIER}\``
      + ` (${classifier?.file ?? '(unknown)'}:${classifier?.line ?? 0}) CALLS: this gate proves`
      + ' it is synchronous, and a synchronous function cannot await, but the arms\' own'
      + '\n  discipline (hand every re-drive to a detached durable carrier, never join one) is'
      + ' held by packages/cf-backend/tests/unit-eviction-durability.test.ts, not here;'
      + `\n  recovery hooks outside \`RECOVERY_HOOKS\` — the set is pinned from the vendored`
      + ' Agent lifecycle chain, so a vendor bump that awaits a NEW subclass hook in the gate'
      + '\n  is ungoverned until the name is added here'
      + `;\n  what an onStart-spawned call REACHES beyond the ${String(MODEL_SINKS.length)} pinned`
      + ' `MODEL_SINKS` names: the rule is by NAME, so a helper spawned there that reaches a'
      + '\n  model under a name not on the list is ungoverned — and the recovery hooks are exempt'
      + ' from that rule outright, because their sanctioned answer hands a re-drive (which may'
      + '\n  reach the model) to a detached durable carrier'
      + `;\n  what \`${START_GATE_ARMS}\``
      + ` (${arms?.file ?? '(unknown)'}:${arms?.line ?? 0}) CALLS past its own body: this gate proves it`
      + ' places direct container calls under the raced budget and finds a control-port proof.'
      + '\n  Indirect calls, runtime entry ordering, cancellation and data-size bounds need lifecycle tests.'
      + (vendor.length > 0
        ? `;\n  the startup of vendor DO classes this repo re-exports (${vendor.join(', ')})`
        : ''),
    );
    process.exit(0);
  }

  console.error(`do-init-gate: ${violations.length} violation(s) in the DO init gate\n`);

  for (const v of violations) console.error(`  ${v.file}:${v.line} ${v.owner}.${v.member} — ${v.reason}`);
  console.error(
    '\nAnything the init chain awaits stalls every request on the object, and at 30s'
    + '\nthe runtime cancels blockConcurrencyWhile and RESETS the Durable Object.'
    + '\nPer-request hook: preconditions that need I/O belong on the turn path'
    + '\nContainer-start hook: return this.#restoreInStartGate(); prove the control listener first.'
    + '\nThe runStartHook continuation must race restore against its existing budget.'
    + `\nRecovery hook: classify synchronously through \`${RECOVERY_CLASSIFIER}\` and hand`
    + '\nevery re-drive to a detached durable carrier (ActorAgent.redriveRecoveredLane).'
    + '\nEither onStart, whatever the gate waits on: a call named in `MODEL_SINKS` is refused'
    + '\noutright — detaching a model call does not move it off the init path. Run it from a'
    + '\nrequest frame (a @callable or a turn).',
  );
  process.exit(1);
}
