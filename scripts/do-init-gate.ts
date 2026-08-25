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
 * ## Two hooks share the name, and only one is a per-request gate
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
  blockBodyOf, classMembers, declaredName, functionOf, identifierCalleeName, isAsync,
  isFunctionLike, memberCalleeName, parse, returnTypeOf, superClassName,
  type SyntaxNode, walk,
} from './syntax';

/** Base classes whose `onStart` is the container-start hook rather than a
 *  per-request init gate. Pinned by equality, one entry, because widening it is
 *  the only way to widen the exemption and that must be a visible edit. */
const CONTAINER_START_BASES: readonly string[] = ['Sandbox'];

/** The bound a container-start hook must route its work through. */
const START_DEADLINE = 'withContainerStartDeadline';

const root = new URL('..', import.meta.url).pathname;

/** The deployment's own list of Durable Object classes. Read from
 *  `wrangler.jsonc` rather than restated here: Cloudflare requires every DO
 *  class to appear there, so it cannot drift, and a hand-kept list is the thing
 *  that drifts. Used only to prove the scan SAW them — the rule itself applies
 *  to every `onStart` in the backend; which of the two rules applies is decided
 *  by the base class the hook belongs to. */
function declaredDurableObjects(): string[] {
  const text = readFileSync(`${root}packages/cf-backend/wrangler.jsonc`, 'utf8');
  // Deduped: the `migrations` block names every class a second time.
  return [...new Set([...text.matchAll(/"class_name"\s*:\s*"(\w+)"/g)].map(([, name]) => name!))].sort();
}

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly owner: string;
  readonly reason: string;
}

export interface InitGateAudit {
  /** Every `onStart` member found — the denominator, split by which rule it was
   *  held to, so a hook silently reclassified into the narrower population is
   *  visible in the headline rather than hidden by it. */
  readonly inspected: readonly { file: string; owner: string; hook: HookKind }[];
  readonly violations: readonly Violation[];
}

/** Which framework runs this `onStart`, and therefore which rule it is held to. */
export type HookKind = 'per-request' | 'container-start';

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

export function auditFile(
  file: string,
  text: string,
  containerLineage: ReadonlySet<string> = new Set(CONTAINER_START_BASES),
): InitGateAudit {
  const parsed = parse(file, text);
  const inspected: { file: string; owner: string; hook: HookKind }[] = [];
  const violations: Violation[] = [];

  walk(parsed.root, (node) => {
    if (node.type !== 'ClassDeclaration') return;
    const owner = declaredName(node) ?? '(anonymous class)';
    const base = superClassName(node);
    const hook: HookKind = base !== undefined && containerLineage.has(base)
      ? 'container-start'
      : 'per-request';
    for (const member of classMembers(node)) {
      if (member.type !== 'MethodDefinition' || declaredName(member) !== 'onStart') continue;
      const line = parsed.lineAt(member.start);
      inspected.push({ file, owner, hook });
      const fail = (reason: string): void => void violations.push({ file, line, owner, reason });

      // Common to both: `async` is what lets an unbounded await into the gate,
      // and a nested gate is the same gate by another name.
      if (isAsync(member)) {
        fail('declared `async` — its promise is what `blockConcurrencyWhile` waits on');
      }
      // The annotation is not decoration: the base accepts
      // `void | Promise<void>`, so the return type silently changes the moment
      // `async` is added, and the widening is invisible in review. Which
      // annotation is required differs — a per-request hook must not hand the
      // gate a promise; a container-start hook must, or its work is detached and
      // the runtime drops it.
      const wanted = hook === 'container-start' ? 'Promise<void>' : 'void';
      const returns = returnTypeOf(member);
      const annotated = returns === undefined
        ? undefined
        : text.slice(returns.start, returns.end).replace(/\s+/g, '');
      if (annotated !== wanted) {
        fail(`must annotate \`: ${wanted}\` explicitly (found \`${annotated ?? 'no annotation'}\`)`);
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
    }
  });
  return { inspected, violations };
}

export function audit(sources: ReadonlyMap<string, string>): InitGateAudit {
  const inspected: { file: string; owner: string; hook: HookKind }[] = [];
  const violations: Violation[] = [];
  const lineage = sandboxLineage(sources);
  for (const [file, text] of sources) {
    if (!text.includes('onStart')) continue;
    const one = auditFile(file, text, lineage);
    inspected.push(...one.inspected);
    violations.push(...one.violations);
  }
  return { inspected, violations };
}

if (import.meta.main) {
  const sources = readSources();
  const { inspected, violations } = audit(sources);

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
    problems.push('found 0 `onStart` members — the matcher is not matching');
  }
  if (ours.length === 0) {
    problems.push('parsed none of the Durable Object classes wrangler.jsonc declares');
  }
  // Two rules, two denominators. The narrower rule is the one an exemption would
  // hide behind, so an empty container-start population is a gate failure: it
  // means either the base was renamed or `CONTAINER_START_BASES` stopped
  // matching, and in both cases nothing is holding that hook to anything.
  for (const hook of ['per-request', 'container-start'] as const) {
    if (inspected.some((i) => i.hook === hook)) continue;
    problems.push(`found 0 ${hook} \`onStart\` implementations — `
      + (hook === 'container-start'
        ? 'no class belongs to the Sandbox lineage'
        : 'the matcher is not matching'));
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`do-init-gate: ${problem}`);
    process.exit(1);
  }
  const perRequest = inspected.filter((i) => i.hook === 'per-request').length;
  const containerStart = inspected.length - perRequest;
  if (violations.length === 0) {
    console.log(
      `do-init-gate: ok — ${inspected.length} onStart implementation(s) across `
      + `${new Set(inspected.map((i) => i.owner)).size} class(es) `
      + `(${perRequest} per-request, ${containerStart} container-start); `
      + `${ours.length}/${declared.length} wrangler-declared DO classes defined here and parsed`
      + (vendor.length > 0 ? `; not ours: ${vendor.join(', ')}` : ''),
    );
    process.exit(0);
  }

  console.error(`do-init-gate: ${violations.length} violation(s) in the DO init gate\n`);
  for (const v of violations) console.error(`  ${v.file}:${v.line} ${v.owner}.onStart — ${v.reason}`);
  console.error(
    '\nAnything awaited in `onStart` stalls every request on the object, and at 30s'
    + '\nthe runtime cancels blockConcurrencyWhile and RESETS the Durable Object.'
    + '\nPer-request hook: preconditions that need I/O belong on the turn path'
    + `\n(ActorAgent.beforeTurn); recovery work that must reach the model is detached.`
    + `\nContainer-start hook: return \`${START_DEADLINE}(...)\` so the work is bounded.`,
  );
  process.exit(1);
}
