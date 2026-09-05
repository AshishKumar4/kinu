/**
 * KINU-065. The workerd layer loads the real decorated Kinu Agent classes.
 *
 * WHAT THE PREMISE IS. `@callable()` is a TC39 standard decorator. This
 * repository sets `target: ES2022` and never sets `experimentalDecorators`, so
 * every `@callable()` in `src/` is emitted by whichever bundler transforms the
 * Worker. The `agents` SDK's decorator is
 *
 *     function callable(metadata = {}) {
 *       return function callableDecorator(target, _context) {
 *         if (!callableMetadata.has(target)) callableMetadata.set(target, metadata);
 *         return target;
 *       };
 *     }
 *
 * `callableMetadata` is a WeakMap keyed by the METHOD FUNCTION, and dispatch is
 * `callableMetadata.has(this[method])`. Under standard decorator semantics
 * `target` is the method function and that key matches. Under legacy decorator
 * semantics `target` would be the prototype, every key would be wrong, and
 * `getCallableMethods()` would return an empty map. The browser would then get
 * "Method X is not callable" for all 127 declared RPCs, and nothing in this
 * repository would notice: `bun test` does not load these classes and the
 * workerd layer hosted only purpose-built probe classes.
 *
 * WHY THIS FILE IS IN THE WORKERD LAYER AND NOT IN `bun test`. The assertion is
 * about the SHIPPED transform. `bun test` runs its own TypeScript pipeline, so a
 * green run there says nothing about the bundle wrangler publishes. This layer
 * is transformed by the same vite/esbuild path the Worker build uses, at the
 * compatibility date `wrangler.jsonc` pins, so the class definitions here really
 * did execute their decorators inside workerd.
 *
 * HARNESS BOUNDARY. The oracle is the SDK's own public `getCallableMethods()`,
 * read through the real class prototypes. Nothing is instantiated: an Agent
 * constructor seals its RPC surface, opens SQLite and installs diagnostics, all
 * of which need bindings this layer deliberately does not declare, and none of
 * which is the premise. `getCallableMethods` walks `Object.getPrototypeOf(this)`
 * upward and reads the WeakMap, so an object whose prototype is the real class
 * prototype gives exactly the registry answer a live instance would give.
 *
 * BLIND SPOT. No browser client and no WebSocket. This proves the metadata
 * survived the transform and that dispatch would resolve; it does not prove the
 * wire protocol, the connection lifecycle, or hibernation. It also cannot see a
 * method that is callable and broken.
 */
import { describe, expect, test } from 'vitest';
import { Agent } from 'agents';
import { ActorAgent } from '../../src/actor-agent';
import { OrchestratorAgent } from '../../src/orchestrator';
import { SubordinateAgent } from '../../src/subordinate-agent';
import { UserDO } from '../../src/user/user-do';

/** What one real class prototype answers about its own browser RPC surface. */
interface CallableSurface {
  /** The names the SDK's registry answers for, sorted. */
  readonly callable: readonly string[];
  /** Whether the prototype chain resolves `name` to a callable function. */
  resolvesToFunction(name: string): boolean;
}

/**
 * The SDK's own reader, applied to a real class prototype.
 *
 * One accessor rather than a cast at each use site. The three earlier reads each
 * cast the same object again, twice into an index-signature type, which is how a
 * test grows a private copy of the thing it is measuring.
 *
 * The function-name walk is INSIDE, so nothing here takes a bare prototype or
 * hands back an unknown value. The chain is walked because a method declared on
 * `ActorAgent` is reached from `OrchestratorAgent` through inheritance, and
 * `getOwnPropertyDescriptors` reads one level. `src/rpc-surface.ts` keeps a
 * private `inheritedDescriptor` doing a similar walk for `sealRpcSurface`, and it
 * is deliberately not shared: that one implements a production authority policy,
 * this one answers a question about a prototype, and exporting production
 * internals into a test would couple them for no gain.
 */
function callableSurface(cls: { readonly prototype: object }): CallableSurface {
  const functions = new Set<string>();
  for (let level: object | null = cls.prototype; level !== null; level = Object.getPrototypeOf(level)) {
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(level))) {
      if (descriptor.value instanceof Function) functions.add(name);
    }
  }
  // Checked here, so the assertion below rests on an observation rather than on
  // the class hierarchy being what this file expects.
  if (!functions.has('getCallableMethods')) {
    throw new Error('the class prototype chain exposes no getCallableMethods');
  }
  // SAFETY: constructed, then checked. `Object.create(cls.prototype)` returns an
  // object whose prototype IS `cls.prototype` by construction, and the guard on
  // the line above has just observed `getCallableMethods` as a function on that
  // chain. That one member is all this receiver is used for: the SDK declares it
  // to start at `Object.getPrototypeOf(this)` and to read its own WeakMap, so it
  // returns the registry answer a live instance returns. Nothing further is
  // constructed on purpose, because an Agent constructor seals its RPC surface,
  // opens SQLite and installs diagnostics, none of which is the premise.
  const receiver = Object.create(cls.prototype) as Agent<never>;
  return {
    callable: [...receiver.getCallableMethods().keys()].sort(),
    resolvesToFunction: (name) => functions.has(name),
  };
}

/**
 * Every Durable Object class in this Worker that carries `@callable()`, with the
 * floor its surface must clear. A floor rather than an exact list: the exact set
 * moves whenever a feature adds an RPC, and a test that has to be edited for
 * every feature gets edited without being read. What must never happen is the
 * surface COLLAPSING, which is what a broken decorator transform does.
 *
 * `witness` is one method whose presence is checked by name, so an empty-map
 * regression cannot be hidden by a floor of zero. The numbers were read off a
 * real run of this layer, never guessed: the measured sets were 120, 16 and
 * 18, and the merged subordinate set adds the 9 exploration entries for 27 —
 * the floor holds two below it, and this layer's next real run re-pins it.
 */
const DECORATED = [
  { name: 'OrchestratorAgent', cls: OrchestratorAgent, floor: 100, witness: 'branchTurn' },
  { name: 'ActorAgent', cls: ActorAgent, floor: 14, witness: 'steerTurn' },
  { name: 'SubordinateAgent', cls: SubordinateAgent, floor: 25, witness: 'explore' },
] as const;

describe('KINU-065 — the real decorated classes load and keep their callable metadata', () => {
  test('the standard-decorator transform survives into workerd', () => {
    for (const { name, cls, floor, witness } of DECORATED) {
      const { callable } = callableSurface(cls);
      // The collapse assertion. Zero here is the whole defect.
      expect(callable.length, `${name} exposes no @callable RPC at all`).toBeGreaterThanOrEqual(floor);
      expect(callable, `${name} lost its witness RPC`).toContain(witness);
    }
  });

  // A test asserting that every REGISTERED name resolves to a function used to
  // sit here. It was vacuous and the lint pass is what made me look: the SDK's
  // `getCallableMethods` only records a name when `typeof prototype[name] ===
  // "function"` already holds, so the assertion restated its own oracle and
  // could not fail. `resolvesToFunction` survives because the NEGATIVE describe
  // below genuinely needs it: there, a method's absence and a method's
  // non-exposure are different defects and only one of them is acceptable.

  test('both actor roots inherit the shared surface rather than redeclaring it', () => {
    // ActorAgent declares the chat, approval and steering RPCs once, and the
    // orchestrator and the subordinate both reach them through the prototype
    // chain. `getCallableMethods` walks that chain, so this is the half of the
    // transform a single-class check cannot see: a per-class registry would
    // still pass the floor above and lose every inherited name here.
    const actor = callableSurface(ActorAgent).callable;
    expect(actor.length).toBeGreaterThan(0);
    for (const root of [
      { name: 'OrchestratorAgent', surface: callableSurface(OrchestratorAgent) },
      { name: 'SubordinateAgent', surface: callableSurface(SubordinateAgent) },
    ]) {
      for (const inherited of actor) {
        expect(root.surface.callable, `${root.name} lost inherited ${inherited}`).toContain(inherited);
      }
    }
  });
});

/**
 * The negative direction, and the reason this file replaces source-string
 * assertions rather than adding to them.
 *
 * `unit-do-routing-security.test.ts` used to assert these by reading our own
 * TypeScript and matching the literal `'@callable()\n  async <name>'`. That
 * oracle passes for the wrong reasons: reformat the decorator onto one line,
 * insert a blank line, add a JSDoc block between decorator and signature, or
 * rename the method, and the string stops matching while the method stays
 * exposed. It also cannot fail when a decorator is added somewhere the pattern
 * does not describe. The registry is the thing dispatch actually consults, so it
 * is the thing to assert.
 */
describe('KINU-065 — the privileged surface is absent from the runtime registry', () => {
  test('UserDO exposes no callable RPC', () => {
    // A browser holding a UserDO socket would reach account-level authority.
    // Native worker-side stub RPC does not need `@callable`, so the correct
    // surface here is empty, not reduced.
    expect(callableSurface(UserDO).callable).toEqual([]);
  });

  test('worker-only privileged methods exist and are not callable', () => {
    const forbidden = [
      { cls: OrchestratorAgent, names: [
        'rawCopyFromFork', 'claimOwner', 'acceptWebhookDelivery', 'acceptEmailDelivery',
        'receivePeerMessage', 'listPeersFromMcp', 'runTaskFromMcp', 'saveNoteFromMcp', 'sendPeerFromMcp',
      ] },
      { cls: ActorAgent, names: [
        'installWorkspaceCapability', 'getSubordinateBootstrapIdentity', 'receiveSubordinateEvent',
      ] },
    ] as const;

    for (const { cls, names } of forbidden) {
      const surface = callableSurface(cls);
      for (const method of names) {
        // Preserved: a worker-side stub holder still calls it by name over
        // native Durable Object RPC, which needs no decorator.
        expect(surface.resolvesToFunction(method), `${method} was deleted, not just unexposed`)
          .toBe(true);
        // Unexposed: no browser socket may dispatch it.
        expect(surface.callable, `${method} became browser-callable`).not.toContain(method);
      }
    }
  });

  test('the privileged names are checked against a surface that really exists', () => {
    // Non-vacuity. Every assertion above is a `not.toContain`, which an empty
    // registry satisfies. This is the guard that stops the whole describe from
    // passing on a collapsed transform.
    expect(callableSurface(OrchestratorAgent).callable.length).toBeGreaterThan(90);
    expect(callableSurface(ActorAgent).callable.length).toBeGreaterThan(10);
  });
});
