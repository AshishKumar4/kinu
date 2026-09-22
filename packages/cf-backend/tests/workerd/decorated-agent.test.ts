/**
 * KINU-065: `@callable()` is a TC39 standard decorator (no `experimentalDecorators`); the SDK keys its registry
 * by the method function, so a legacy transform empties `getCallableMethods()`. Runs in workerd because only
 * the shipped vite/esbuild transform matters. Does not cover the wire protocol, connections or hibernation.
 */
import { describe, expect, test } from 'vitest';
import { Agent } from 'agents';
import { ActorAgent } from '../../src/actor-agent';
import { OrchestratorAgent } from '../../src/orchestrator';
import { UserDO } from '../../src/user/user-do';

/** What one real class prototype answers about its own browser RPC surface. */
interface CallableSurface {
  readonly callable: readonly string[];
  resolvesToFunction(name: string): boolean;
}

/** The SDK's own `getCallableMethods`, read through the real prototype chain (inherited RPCs included). */
function callableSurface(cls: { readonly prototype: object }): CallableSurface {
  const functions = new Set<string>();

  for (let level: object | null = cls.prototype; level !== null; level = Object.getPrototypeOf(level)) {
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(level))) {
      if (descriptor.value instanceof Function) functions.add(name);
    }
  }

  if (!functions.has('getCallableMethods')) {
    throw new Error('the class prototype chain exposes no getCallableMethods');
  }

  // SAFETY: the prototype is `cls.prototype` by construction and the guard just observed `getCallableMethods` on it;
  // no Agent is constructed because its constructor needs bindings this layer does not declare.
  const receiver: Agent<never> = Object.create(cls.prototype);

  return {
    callable: [...receiver.getCallableMethods().keys()].sort(),
    resolvesToFunction: (name) => functions.has(name),
  };
}

/**
 * Floors, not exact lists: the defect is the surface collapsing. `witness` stops a floor of zero hiding an empty map.
 * Only two decorated classes: hosted actors share the orchestrator's `@callable` surface.
 */
const DECORATED = [
  { name: 'OrchestratorAgent', cls: OrchestratorAgent, floor: 100, witness: 'branchTurn' },
  { name: 'ActorAgent', cls: ActorAgent, floor: 14, witness: 'send' },
] as const;

describe('KINU-065 — the real decorated classes load and keep their callable metadata', () => {
  test('the standard-decorator transform survives into workerd', () => {
    for (const { name, cls, floor, witness } of DECORATED) {
      const { callable } = callableSurface(cls);
      expect(callable.length, `${name} exposes no @callable RPC at all`).toBeGreaterThanOrEqual(floor);
      expect(callable, `${name} lost its witness RPC`).toContain(witness);
    }
  });

  // No "every registered name resolves" test: the SDK only registers function-valued names, so it could not fail.

  test('the one actor root inherits the shared surface rather than redeclaring it', () => {
    // ActorAgent's RPCs reach the orchestrator through inheritance; a per-class registry would lose them.
    const actor = callableSurface(ActorAgent).callable;
    expect(actor.length).toBeGreaterThan(0);
    const root = callableSurface(OrchestratorAgent);

    for (const inherited of actor) {
      expect(root.callable, `OrchestratorAgent lost inherited ${inherited}`).toContain(inherited);
    }
  });
});

/** Asserted against the runtime registry, not source text, which drifts with formatting. */
describe('KINU-065 — the privileged surface is absent from the runtime registry', () => {
  test('UserDO exposes no callable RPC', () => {
    // A browser holding a UserDO socket would reach account-level authority; native stub RPC needs no `@callable`.
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
        // Preserved for worker-side stub RPC, which needs no decorator.
        expect(surface.resolvesToFunction(method), `${method} was deleted, not just unexposed`)
          .toBe(true);
        expect(surface.callable, `${method} became browser-callable`).not.toContain(method);
      }
    }
  });

  test('the privileged names are checked against a surface that really exists', () => {
    // Non-vacuity: every assertion above is `not.toContain`, which an empty registry satisfies.
    expect(callableSurface(OrchestratorAgent).callable.length).toBeGreaterThan(90);
    expect(callableSurface(ActorAgent).callable.length).toBeGreaterThan(10);
  });
});
