/**
 * Durable Object init-gate purity — a per-request `onStart` must not await, and
 * a container-start `onStart` must not await anything unbounded.
 *
 * `partyserver` runs `onStart()` inside `ctx.blockConcurrencyWhile()`
 * (`partyserver/dist/index.js`, `#ensureInitialized`), and `fetch`,
 * `webSocketMessage`, `webSocketClose` and `alarm` all await that same gate. So
 * anything `onStart` awaits stalls EVERY request on the object — pure
 * `@callable` reads included — and at 30 s the runtime does not merely delay:
 * it cancels the block and RESETS the Durable Object, and the request 500s.
 *
 *   A call to blockConcurrencyWhile() in a Durable Object waited for too long.
 *   The call was canceled and the Durable Object was reset.
 *
 * Measured in workerd by `RpcTimeout`: a bare `SELECT` against an idle object
 * answers in 0-2 ms, and against an object whose `onStart` was awaiting a
 * second, busy Durable Object it took 2303 ms / 10215 ms / 25212 ms for a
 * 2 s / 10 s / 25 s answer, then reset at 31 s. That is the owner's
 * `listAgentTasks timed out after 30000ms`: cold start, not contention.
 *
 * ## Three hooks, one gate, and only one of them is called `onStart`
 *
 * This gate first said "no `onStart` awaits anything at all, because a Workers
 * codebase has no legitimate async one". That premise was true of every class it
 * was written against and is false of one that arrived later.
 * `@cloudflare/containers`' `Container.onStart` is a CONTAINER-start hook, not a
 * per-request one: `Container.start` and `Container.startAndWaitForPorts` await
 * it inside `blockConcurrencyWhile` (`@cloudflare/containers@0.3.5`
 * `dist/lib/container.js:577`, `:626`), and `Sandbox.containerFetch` enters that
 * path only when the container is not healthy or not running
 * (`@cloudflare/sandbox@0.12.7` `dist/sandbox-CcCJwCbh.js:8686-8698`). It does
 * not run on DO construction and it does not run per request.
 *
 * For that hook, returning a promise is the CORRECT behaviour and detaching the
 * work is the defect: the gate it extends is the only thing that stops an exec
 * from observing a container before its workspace is restored, and a promise
 * left floating in a Durable Object is cancelled on eviction with its rejection
 * swallowed by the runtime, so the work simply would not happen.
 *
 * So the rule is split, by the base class each hook belongs to — which is
 * decidable from the `extends` clause with no type information:
 *
 *  * per-request hook: unchanged. Not `async`, annotated `: void`, no `await` in
 *    its own scope, no nested `blockConcurrencyWhile`.
 *  * container-start hook: not `async` and no `await` in its own scope either —
 *    so every awaited thing must live inside something the method RETURNS — plus
 *    it must return `Promise<void>`, and it must hand its work to
 *    `withContainerStartDeadline`, which bounds gate occupancy below the
 *    `do.block_concurrency.cancel_ms` cancellation and fails the container start instead of resetting the object.
 *    That is a replacement bound, not an exemption: an unbounded await is still
 *    unreachable, because a non-async method cannot await at all.
 *
 * ## The hook that is not `onStart`, and how this gate was blind to it
 *
 * `onStart` is not the only thing the init chain awaits on the subclass. The
 * agents SDK's `startAgent` awaits `_checkRunFibers` BEFORE it calls `onStart`
 * (`agents/dist/index.js:1033`), and that scan awaits the subclass's
 * `onFiberRecovered` once per interrupted `cf_agents_runs` row (`:2602`), with
 * no timeout of its own. So the recovery hook is init-gate surface exactly as
 * `onStart` is — and this gate audited `onStart` bodies only, which is how
 * `ActorAgent.onFiberRecovered` came to await an advisor model call, a session
 * evolution pass, a settled job's wake (which resolves only when the turn it
 * queues ENDS) and a terminal replay of SMTP round trips, all inside
 * `blockConcurrencyWhile`, while this gate printed `ok`.
 *
 * That population's rule, `RECOVERY_HOOKS` for the names:
 *
 *  * not `async`, no `await` in its own scope, no nested gate — as above;
 *  * an explicit `Promise<…>` annotation, because a `void` recovery result
 *    leaves a managed fiber row `interrupted` for good;
 *  * and what it HANDS BACK must be a call to `RECOVERY_CLASSIFIER` or a value
 *    with nothing to await. This is the check the other two rules cannot make:
 *    the SDK awaits the returned promise, so `return this.reviewTurn(ctx)` holds
 *    the gate for a model call from a method that is neither `async` nor
 *    contains an `await`.
 *
 * The classifier is the replacement bound, and it carries the same completeness
 * argument the container deadline does — plus one more: the gate requires the
 * classifier's own DECLARATION to be synchronous, and a synchronous function
 * cannot await. Two syntactic facts, no call graph, and the gate says so on its
 * success path.
 *
 * ## Why this shape, and not a call-graph gate
 *
 * The obvious gate — walk what `onStart` transitively awaits and look for
 * off-object I/O — cannot work here and would be worse than nothing. The proven
 * chain was `onStart` → `this.ensureOwnedScaffold()` →
 * `this.rt.identity.scaffold.exists()` → a closure over a constructor parameter
 * → `env.NIMBUS_SESSION.get(...)`, and every hop after the first is a call on a
 * VALUE: a property of a property of an injected field, whose `exists` is
 * created by a factory over an argument. There is no declaration a syntactic
 * walk can reach, and TypeScript 7 ships no type checker (nor does oxc), so
 * there will be no checker to ask. A walk like that reports green and proves
 * nothing — the vacuous-gate pattern.
 *
 * The properties above are decidable with zero type information: a non-async
 * method cannot contain `await`, so an off-object dependency cannot be
 * re-introduced without first widening the signature — which is two tokens, in
 * one place, read directly here. Complete rather than approximate.
 *
 * ## Why `tsc` does not already do this
 *
 * `orchestrator.ts:1522` calls the `void` return type "the enforcement". It is
 * not. The base declares `onStart(props?: Props): void | Promise<void>`
 * (`partyserver/dist/index.d.ts:339`), so `async onStart(): Promise<void>`
 * typechecks, lints, passes 4,530 tests, satisfies layergate and conformance,
 * and resets the owner's workspace under load. The contract was real and its
 * enforcement was a comment.
 */

import { readFileSync } from 'node:fs';

import { readSources } from './sources';
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
const START_DEADLINE = 'withContainerStartDeadline';

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
 *   • `onChatRecovery` — `@cloudflare/think/dist/think.js:7824`, invoked from
 *     that internal handler while the gate is held. No Kinu class overrides it
 *     today; the name is here so the first one that does is governed.
 */
const RECOVERY_HOOKS: readonly string[] = [
  'onFiberRecovered', '_handleInternalFiberRecovery', 'onChatRecovery',
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
}

/** Which framework awaits this hook, and therefore which rule it is held to. */
export type HookKind = 'per-request' | 'container-start' | 'recovery';

/** `await` anywhere in the method's OWN scope. A nested `async` function has
 *  its own scope and cannot extend the gate, so the walk does not descend into
 *  one — descending would report a detached recovery task, which is precisely
 *  the shape the fix uses. */
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

/** The bounded-start call this hook hands its work to, if any. Own scope only:
 *  a call buried in a nested callback is not this method's bound. */
function boundedStart(body: SyntaxNode): SyntaxNode | undefined {
  for (const child of body.children) {
    if (identifierCalleeName(child) === START_DEADLINE) return child;
    if (isFunctionLike(child)) continue;
    const nested = boundedStart(child);
    if (nested !== undefined) return nested;
  }
  return undefined;
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
      // gate, and a nested gate is the same gate by another name.
      if (isAsync(member)) {
        fail('declared `async` — its promise is what `blockConcurrencyWhile` waits on');
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
      if (hook === 'recovery') {
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
      if (ownScopeAwait(body) !== undefined) {
        fail(hook === 'container-start'
          ? `awaits in its own scope — hand the work to \`${START_DEADLINE}\` and return it, `
            + 'so gate occupancy is bounded below do.block_concurrency.cancel_ms'
          : 'awaits in its own scope — every request on this object waits with it');
      }
      if (nestedGate(body) !== undefined) {
        fail('opens a nested `blockConcurrencyWhile` — the same gate by another name');
      }
      if (hook === 'container-start' && boundedStart(body) === undefined) {
        fail(`must route its work through \`${START_DEADLINE}\` — the container-start gate is `
          + 'cancelled at do.block_concurrency.cancel_ms by RESETTING the object, so the '
          + 'work needs a budget of its own');
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
  const classifier = classifierIn(parsed, file);
  if (classifier !== null && classifier.async) {
    violations.push({
      file, line: classifier.line, owner: RECOVERY_CLASSIFIER, member: RECOVERY_CLASSIFIER,
      reason: 'declared `async` — a recovery hook hands the gate whatever this returns, so an '
        + 'await here is an await inside `blockConcurrencyWhile`; classify synchronously and '
        + 'hand each re-drive to a detached durable carrier',
    });
  }
  return { inspected, violations, classifier };
}

export function audit(sources: ReadonlyMap<string, string>): InitGateAudit {
  const inspected: { file: string; owner: string; member: string; hook: HookKind }[] = [];
  const violations: Violation[] = [];
  let classifier: ClassifierDeclaration | null = null;
  const lineage = sandboxLineage(sources);
  for (const [file, text] of sources) {
    // The corpus is narrowed by the names this gate governs, so a file that
    // declares none of them is not parsed. The classifier's own module is in the
    // set because its declaration is half of the recovery rule.
    if (!text.includes('onStart') && !RECOVERY_HOOKS.some((name) => text.includes(name))
      && !text.includes(RECOVERY_CLASSIFIER)) continue;
    const one = auditFile(file, text, lineage);
    inspected.push(...one.inspected);
    violations.push(...one.violations);
    classifier ??= one.classifier;
  }
  return { inspected, violations, classifier };
}

if (import.meta.main) {
  const sources = readSources();
  const { inspected, violations, classifier } = audit(sources);

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
      // The blind spots, on the SUCCESS path, because a limitation visible only
      // in red output is invisible exactly when the tree is green.
      + `\ndo-init-gate: blind to — what \`${RECOVERY_CLASSIFIER}\``
      + ` (${classifier?.file ?? '(unknown)'}:${classifier?.line ?? 0}) CALLS: this gate proves`
      + ' it is synchronous, and a synchronous function cannot await, but the arms\' own'
      + '\n  discipline (hand every re-drive to a detached durable carrier, never join one) is'
      + ' held by packages/cf-backend/tests/unit-eviction-durability.test.ts, not here;'
      + `\n  recovery hooks outside \`RECOVERY_HOOKS\` — the set is pinned from the vendored`
      + ' agents/think chains, so a vendor bump that awaits a NEW subclass hook in the gate'
      + '\n  is ungoverned until the name is added here'
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
    + '\n(ActorAgent.beforeTurn); recovery work that must reach the model is detached.'
    + `\nContainer-start hook: return \`${START_DEADLINE}(...)\` so the work is bounded.`
    + `\nRecovery hook: classify synchronously through \`${RECOVERY_CLASSIFIER}\` and hand`
    + '\nevery re-drive to a detached durable carrier (ActorAgent.redriveRecoveredLane).',
  );
  process.exit(1);
}
