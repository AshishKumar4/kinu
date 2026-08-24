// buildStrategyForkDeps — the one builder both backends assemble the swarm
// substrate through. Its job is transport, and transport only:
//   - every host-injected member travels verbatim, so neither backend can end
//     up wiring a different substrate than the other;
//   - the lazy members stay factories — resolving a node home at build time
//     would boot a filesystem for every turn instead of for the searches
//     that need one.
//
// The strategy plumbing this builder used to assemble behind `defaultOptions`
// (the MCTS session/overrides/progress bag, the heads
// controller/inheritedContext/onPhase bag) died with the `fork` action: no
// reader was left, so the wiring had no consumer. The live properties moved to
// their surviving owners — MCTS progress visibility is pinned at the engine
// entry runMCTS (unit-mcts-progress.test.ts, integration-mcts.test.ts), head
// phase firing at the controller (unit-heads-controller.test.ts,
// unit-heads-grounding.test.ts), and the phase→ledger row shape plus its
// detached-run visibility at unit-steer-branch.test.ts /
// integration-cancelled-fork-visibility.test.ts.
import { describe, test, expect } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import { buildStrategyForkDeps } from '../src/orchestrator/fork-deps';
import type { AgentsForkDeps } from '../src/tools/agents-tool';
import type { NodeHomeHost } from '../src/strategy/node-workspace';
import { createTestRuntime } from './helpers';

describe('buildStrategyForkDeps — the substrate travels through the one builder', () => {
  test('every wired member reaches AgentsForkDeps verbatim', () => {
    const { rt } = createTestRuntime();
    const model = new MockLanguageModelV3();
    const costModel: AgentsForkDeps['costModel'] = () => { throw new Error('not exercised'); };
    const nodeHost: AgentsForkDeps['nodeHost'] = () => { throw new Error('not exercised'); };
    const compactShared: AgentsForkDeps['compactShared'] = async (messages) => messages;

    const deps = buildStrategyForkDeps({ rt, model, costModel, nodeHost, compactShared });

    expect(deps.rt).toBe(rt);
    expect(deps.model).toBe(model);
    expect(deps.costModel).toBe(costModel);
    expect(deps.nodeHost).toBe(nodeHost);
    expect(deps.compactShared).toBe(compactShared);
  });
});

/** A host whose members exist but are never reached: what this suite asserts is
 *  that the object TRAVELS, and a member that provisioned anything here would be
 *  a second, weaker copy of the substrate proof in cf-backend. */
function unreachedHost(sql: NodeHomeHost['sql']): NodeHomeHost {
  const refuse = (call: string) => (): never => {
    throw new Error(`fork-deps must not provision: ${call} was called`);
  };
  return {
    root: { mkdir: refuse('mkdir'), chown: refuse('chown'), chmod: refuse('chmod') },
    confiner: { confinePrincipal: refuse('confinePrincipal'), releasePrincipal: refuse('releasePrincipal') },
    sql,
  };
}

describe('buildStrategyForkDeps — the node home host travels through the one builder', () => {
  test('a wired host reaches AgentsForkDeps, unresolved', async () => {
    // Unresolved is the claim, not an implementation detail: both backends build
    // their deps once per turn, and resolving a home host there would boot a
    // filesystem for every turn instead of for the searches that need one.
    let resolutions = 0;
    const host = unreachedHost({ exec: () => [] });

    const deps = buildStrategyForkDeps({
      rt: createTestRuntime().rt,
      model: new MockLanguageModelV3(),
      nodeHome: async () => { resolutions += 1; return host; },
    });

    expect(resolutions).toBe(0);
    if (!deps.nodeHome) throw new Error('the builder dropped the node home host');
    expect(await deps.nodeHome()).toBe(host);
    expect(resolutions).toBe(1);
  });

  test('a backend that wires none leaves the member absent', () => {
    // The CLI wires one and the hosted backend cannot, so "absent" is a shipped
    // state rather than a test-only one — and `runSwarmAction` reads its presence
    // to decide whether a node gets a home at all.
    const { rt } = createTestRuntime();
    expect(buildStrategyForkDeps({ rt, model: new MockLanguageModelV3() }).nodeHome).toBeUndefined();
  });
});
