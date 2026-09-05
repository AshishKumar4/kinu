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
 *    ONE alternative to the wrapper, narrower than the wrapper and named in the
 *    method: work this hook returns may instead be PLAINLY BOUNDED storage
 *    writes to this object's own `ctx.storage` when the method carries the
 *    `BOUNDED_STORAGE_ONLY` marker. The wrapper's timer is not delivered inside
 *    `blockConcurrencyWhile` (measured; see `lifecycle.ts`), so for that work a
 *    deadline is a paper bound — the platform's own cancel governs storage
 *    either way, and the genuinely external container admission must run OUTSIDE
 *    this gate, where its timer fires. The marker is the visible edit that says
 *    "nothing here reaches off-object", and it forbids the wrapper rather than
 *    merely omitting it: a wrapper that cannot fire would claim a bound that
 *    does not exist, which is the anti-pattern this gate exists to prevent.
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
 * ## The one thing the wait-shaped rules cannot see: WHAT the work is
 *
 * All three rules above are about the WAIT. `async`, an own-scope `await`, a
 * nested gate, what a recovery hook hands back — every one of them asks what
 * the gate ends up waiting on. `OrchestratorAgent.onStart` satisfied all of
 * them while spawning this:
 *
 *   autoTitleTask.promise = (async () => {
 *     await this.hydrateTitle();
 *     const soul = await readSoul(this.rt.storage.vfs);
 *     await this.maybeAutoTitle(summarizeSoul(soul ?? ''));
 *   })();
 *
 * — a fire-and-forget task, launched from inside `blockConcurrencyWhile`, whose
 * chain ends in `generateText`. The gate waits on none of it, so all three
 * rules were satisfied and the shape was still wrong: an LLM call on the init
 * path of every cold start of every claimed workspace, running against an
 * activation whose gate is still open, and cancelled on eviction with its
 * rejection swallowed by the runtime. Detaching work does not take it off the
 * init path. It only takes it out of the WAIT.
 *
 * So the fourth rule is about REACH, and it is the only one that descends into
 * what the hook SPAWNS: no call named in `MODEL_SINKS` may appear anywhere
 * inside a governed `onStart` — its own scope, or a function expression it
 * launches there. Model-reaching work belongs on a request frame (a `@callable`
 * or a turn), where it is ordinary agent work rather than init-path work.
 *
 * Recovery hooks are deliberately NOT held to this rule: their sanctioned shape
 * is to hand each re-drive to a detached durable carrier, and a re-drive may
 * legitimately reach the model. That exemption is printed on the success path
 * beside the other blind spots, not left to be discovered.
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

/** The marker that opts a container-start hook into the plainly-bounded
 * alternative: its returned work touches nothing but this object's own storage.
 * Sought as an identifier inside the method body, so it names the method, not
 * a comment elsewhere. */
const BOUNDED_STORAGE_MARKER = 'BOUNDED_STORAGE_ONLY';

/** True when the marker identifier appears anywhere in this method's body. */
function hasBoundedStorageMarker(body: SyntaxNode): boolean {
  for (const child of body.children) {
    if (child.raw.type === 'Identifier' && child.raw.name === BOUNDED_STORAGE_MARKER) return true;
    if (isFunctionLike(child)) continue;
    if (hasBoundedStorageMarker(child)) return true;
  }
  return false;
}

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

/** Where the corpus declares {@link START_GATE_ARMS}, and the two facts the
 *  container-start rule needs about it. */
export interface RestoreDeclaration {
  readonly file: string;
  readonly line: number;
  /** Routes its work through {@link START_DEADLINE} — a timer, and therefore a
   *  paper bound where this method runs. */
  readonly deadlineWrapped: boolean;
  /** Names of {@link CONTAINER_REACHES} calls found inside it. Each one is a hop
   *  that cannot complete while the gate is held. */
  readonly reaches: readonly string[];
  /** Names of {@link DO_SIDE_TIMERS} calls found inside it, nested functions
   *  included. Each one is a wait the runtime cannot deliver while the gate is
   *  held. */
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
  /** The in-gate restore's declaration, or `null` when this corpus declares it
   *  nowhere — which is a stale pin and a gate failure for the same reason a
   *  null classifier is: the admitted await would be satisfied by a name nothing
   *  declares. */
  readonly restore: RestoreDeclaration | null;
}

/** Which framework awaits this hook, and therefore which rule it is held to. */
export type HookKind = 'per-request' | 'container-start' | 'recovery';

/** `await` anywhere in the method's OWN scope. A nested `async` function has
 *  its own scope and cannot extend the gate, so the walk does not descend into
 *  one — descending would report a detached recovery task, which is precisely
 *  the shape the fix uses. */
/**
 * The awaits an ASYNC init gate is allowed to hold, verbatim after whitespace
 * collapse — the owner's 2026-08-31 ruling: bounded, once-per-start work stays
 * in the gate, and the workspace boot (this object's own SQLite: schema,
 * profile, session compose) is that work. Everything else still fails by
 * name, so growing this list is a conscious edit with its own review.
 */
const ADMITTED_INIT_AWAITS: readonly string[] = [
  'await this.hostedWorkspace().bundle.session()',
  'await this.#armContainerSchedules()',
];

/**
 * The container-start gate's ONE admitted await, and the method that must
 * declare it.
 *
 * A SECOND PIN, for the same reason {@link RECOVERY_CLASSIFIER} is one: the
 * admission is only as good as what the admitted call is allowed to do — and
 * what this one is allowed to do is now a COUNT rather than a budget. Deployed
 * probe `gp0902011918` measured the first container command issued inside the
 * gate never returning: reaching the container asks the SDK for a nested
 * `blockConcurrencyWhile` the runtime will not grant while the outer one is
 * held, so the activation ran to the cap `do.block_concurrency.cancel_ms` names
 * and the object was reset. A
 * bound on that work was never the missing piece; the work does not belong
 * there at all. Three properties of the declaration are decidable here with
 * zero type information:
 *
 *   • It must not route through {@link START_DEADLINE}. That bound is a timer,
 *     and a timer set inside `blockConcurrencyWhile` is not delivered until the
 *     block releases — so inside the gate it is a paper bound.
 *   • It must contain no {@link DO_SIDE_TIMERS} call, anywhere inside it,
 *     nested functions included. A sleep in the Durable Object cannot be
 *     delivered while the gate is held, so one on this path does not slow the
 *     hook down — it WEDGES the activation.
 *   • It must reach NOTHING on the container: no {@link CONTAINER_REACHES} call
 *     anywhere inside it. That is the property the probe bought, and it is the
 *     cheapest one this file can hold.
 *
 * WHAT IS NOT CHECKED, stated rather than implied: that the storage writes it
 * DOES make are few and small. The devbox package's own restore-out-of-gate
 * suite counts them against a container fake that answers nothing.
 */
const START_GATE_ARMS = 'armContainerSchedules';

/**
 * Calls that reach the CONTAINER, pinned by name.
 *
 * Any of them inside the admitted arming await is the refuted design coming
 * back: the SDK routes each through its own control connection, and
 * establishing that connection asks for a nested `blockConcurrencyWhile`.
 */
const CONTAINER_REACHES: readonly string[] = [
  'exec', 'containerFetch', 'mountBucket', 'unmountBucket', 'startProcess',
  'killProcess', 'exposePort', 'start', 'startAndWaitForPorts', 'destroy',
  'createBackup', 'restoreBackup', 'attach', 'checkpoint',
];

/**
 * Calls that make the Durable Object itself wait on a timer, pinned by name.
 *
 * Inside `blockConcurrencyWhile` none of them can be delivered. `scheduler.wait`
 * is this package's sleep, `setTimeout` and `setInterval` are the platform's,
 * and `AbortSignal.timeout` is the one that hides: it looks like a bound and is
 * a timer, so a caller that passes one into the gate has written a deadline that
 * cannot arrive.
 */
const DO_SIDE_TIMERS: readonly string[] = [
  'wait', 'setTimeout', 'setInterval', 'timeout',
];

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

/**
 * The declaration of {@link START_GATE_ARMS} in one file, if it is here, with
 * the two facts the container-start rule asks about it.
 *
 * A METHOD, not a module function — the mirror of {@link classifierIn}'s choice,
 * and for the same kind of reason: the gate's admitted await is spelled
 * `await this.restoreInStartGate()`, so the thing it names is a member of the
 * class that holds the gate, and a module function of that name is not it.
 *
 * BOTH SCANS DESCEND INTO NESTED FUNCTIONS, unlike the gate's own await scan.
 * That is deliberate and it is the opposite trade: a nested `async` function
 * cannot extend the gate, so descending would report a false positive THERE —
 * but a timer scheduled from inside one is still a timer this activation ends up
 * waiting on, so not descending would miss the real defect HERE.
 */
function restoreIn(parsed: Parsed, file: string): RestoreDeclaration | null {
  let found: RestoreDeclaration | null = null;
  walk(parsed.root, (node) => {
    if (found !== null || node.type !== 'MethodDefinition') return;
    if ((declaredName(node) ?? '').replace(/^#/, '') !== START_GATE_ARMS) return;
    const body = blockBodyOf(functionOf(node) ?? node);
    const timers: string[] = [];
    const reaches: string[] = [];
    let deadlineWrapped = false;
    if (body !== undefined) {
      walk(body, (inner) => {
        const called = memberCalleeName(inner) ?? identifierCalleeName(inner);
        if (called === undefined) return;
        if (called === START_DEADLINE) deadlineWrapped = true;
        else if (DO_SIDE_TIMERS.includes(called)) timers.push(called);
        else if (CONTAINER_REACHES.includes(called)) reaches.push(called);
      });
    }
    found = { file, line: parsed.lineAt(node.start), deadlineWrapped, timers, reaches };
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
      // gate, and a nested gate is the same gate by another name. TWO admitted
      // exceptions, both the owner's ruling: work that is provably bounded and
      // owed once at the start of the object's life STAYS in the gate —
      // concretely the workspace boot for a per-request hook (2026-08-31), and
      // the container restore for a container-start hook (2026-09-01). An async
      // gate is therefore legal exactly when every await in its own scope is on
      // the pinned list; any other await fails by name, so admitting a new one
      // is a conscious edit HERE.
      //
      // THE RECOVERY POPULATION IS NOT ADMITTED, and cannot be: its work is a
      // model-reaching re-drive, which is the class of work that has no bounded
      // form on an init path at all.
      const admittedAsyncGate = isAsync(member) && hook !== 'recovery';
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
      if (hook === 'container-start' && admittedAsyncGate) {
        // THE ADMITTED SHAPE, and it replaces BOTH arms below rather than
        // joining them. The gate holds the restore itself, so there is no
        // detached work for a deadline to bound and nothing storage-only to
        // mark: what has to be true is a property of the RESTORE'S
        // DECLARATION, checked once for the corpus in `restoreIn` and reported
        // by `import.meta.main`. Carrying either of the old markers here would
        // mean the hook was claiming a bound it no longer uses.
        if (boundedStart(body) !== undefined) {
          fail(`holds the admitted restore yet also routes through \`${START_DEADLINE}\` — a `
            + 'timer that cannot fire inside blockConcurrencyWhile is a paper bound, not a '
            + 'real one; the in-gate budget is polled instead');
        }
        if (hasBoundedStorageMarker(body)) {
          fail(`carries \`${BOUNDED_STORAGE_MARKER}\` yet holds the admitted restore — the `
            + 'restore reaches the container, so the marker is claiming something false');
        }
      } else if (hook === 'container-start') {
        const marked = hasBoundedStorageMarker(body);
        if (marked && boundedStart(body) !== undefined) {
          fail(`carries \`${BOUNDED_STORAGE_MARKER}\` yet routes through \`${START_DEADLINE}\` — `
            + 'a timer that cannot fire inside blockConcurrencyWhile is a paper bound, '
            + 'not a real one');
        }
        if (!marked && boundedStart(body) === undefined) {
          fail(`must route its work through \`${START_DEADLINE}\` — the container-start gate is `
            + 'cancelled at do.block_concurrency.cancel_ms by RESETTING the object, so the '
            + `work needs a budget of its own, carry \`${BOUNDED_STORAGE_MARKER}\` for `
            + `plainly bounded writes to this object own storage, or hold the admitted `
            + `\`${START_GATE_ARMS}\` await`);
        }
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
  const restore = restoreIn(parsed, file);
  if (restore !== null && restore.deadlineWrapped) {
    violations.push({
      file, line: restore.line, owner: START_GATE_ARMS, member: START_GATE_ARMS,
      reason: `routes through \`${START_DEADLINE}\` — this method runs inside the init gate, `
        + 'where a timer is not delivered until the block releases, so that bound cannot '
        + 'fire. Poll the budget instead is not the answer either: arm the schedule row and '
        + 'let a delivered frame do the work',
    });
  }
  for (const reached of restore?.reaches ?? []) {
    violations.push({
      file, line: restore?.line ?? 0, owner: START_GATE_ARMS, member: START_GATE_ARMS,
      reason: `reaches \`${reached}\` — this method runs inside the init gate, and a command `
        + 'sent to the container from there NEVER RETURNS: the SDK asks for a nested '
        + 'blockConcurrencyWhile the runtime will not grant while the outer one is held, so the '
        + 'activation reaches do.block_concurrency.cancel_ms and the object is RESET (measured, '
        + 'deployed probe gp0902011918). Arm a schedule row and restore on a delivered frame',
    });
  }
  for (const timer of restore?.timers ?? []) {
    violations.push({
      file, line: restore?.line ?? 0, owner: START_GATE_ARMS, member: START_GATE_ARMS,
      reason: `waits on \`${timer}\` — a Durable Object timer is not delivered while the init `
        + 'gate is held, so this does not slow the restore down, it WEDGES the activation and '
        + 'the platform answers by resetting the object. Wait inside the container, in one '
        + 'command, with a counted loop',
    });
  }
  const classifier = classifierIn(parsed, file);
  if (classifier !== null && classifier.async) {
    violations.push({
      file, line: classifier.line, owner: RECOVERY_CLASSIFIER, member: RECOVERY_CLASSIFIER,
      reason: 'declared `async` — a recovery hook hands the gate whatever this returns, so an '
        + 'await here is an await inside `blockConcurrencyWhile`; classify synchronously and '
        + 'hand each re-drive to a detached durable carrier',
    });
  }
  return { inspected, violations, classifier, restore };
}

export function audit(sources: ReadonlyMap<string, string>): InitGateAudit {
  const inspected: { file: string; owner: string; member: string; hook: HookKind }[] = [];
  const violations: Violation[] = [];
  let classifier: ClassifierDeclaration | null = null;
  let restore: RestoreDeclaration | null = null;
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
    restore ??= one.restore;
  }
  return { inspected, violations, classifier, restore };
}

if (import.meta.main) {
  const sources = readSources();
  const { inspected, violations, classifier, restore } = audit(sources);

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
  // The container-start rule's other half, and the same argument again: the ONE
  // await an activation may hold is admitted by name, so a name nothing declares
  // would admit a call that cannot happen — and leave the gate looking green
  // while nothing at all was checked about the restore.
  if (restore === null) {
    problems.push(`no source declares \`${START_GATE_ARMS}\` — the container-start gate's `
      + 'admitted await is pinned to a name that no longer exists');
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
      + `;\n  what an onStart-spawned call REACHES beyond the ${String(MODEL_SINKS.length)} pinned`
      + ' `MODEL_SINKS` names: the rule is by NAME, so a helper spawned there that reaches a'
      + '\n  model under a name not on the list is ungoverned — and the recovery hooks are exempt'
      + ' from that rule outright, because their sanctioned answer hands a re-drive (which may'
      + '\n  reach the model) to a detached durable carrier'
      + `;\n  what \`${START_GATE_ARMS}\``
      + ` (${restore?.file ?? '(unknown)'}:${restore?.line ?? 0}) CALLS: this gate proves it`
      + ' reaches no container, holds no paper bound and sleeps on no Durable Object timer —'
      + '\n  the three ways an activation stops completing. What it does NOT prove is that the'
      + ' storage writes it does make are few and small; the devbox package\'s own'
      + '\n  restore-out-of-gate suite counts them against a container fake that answers nothing'
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
    + `\nContainer-start hook: return \`${START_DEADLINE}(...)\` so the work is bounded, or hold`
    + `\nthe admitted \`await this.#${START_GATE_ARMS}()\`, which arms the schedule rows and`
    + '\nreaches no container: a command sent from inside the block never returns.'
    + `\nRecovery hook: classify synchronously through \`${RECOVERY_CLASSIFIER}\` and hand`
    + '\nevery re-drive to a detached durable carrier (ActorAgent.redriveRecoveredLane).'
    + '\nEither onStart, whatever the gate waits on: a call named in `MODEL_SINKS` is refused'
    + '\noutright — detaching a model call does not move it off the init path. Run it from a'
    + '\nrequest frame (a @callable or a turn).',
  );
  process.exit(1);
}
