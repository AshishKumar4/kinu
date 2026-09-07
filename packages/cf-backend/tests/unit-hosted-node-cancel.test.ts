/**
 * Operator cancellation reaches a HOSTED swarm node.
 *
 * A node run in a facet is an RPC the search awaits; the search's own abort signal
 * lives on the search's side of that RPC. What this suite pins is the transport's
 * half of cancellation (`hostNodeLoop`): when the signal fires while the facet is
 * inside a provider step, the host evicts the facet through the SDK's own abort —
 * which is what rejects the pending `runAsNode` — the node settles as `aborted`
 * under its own journal row, its storage is reclaimed and its home released, and
 * nothing is left awaiting a facet nobody will answer.
 *
 * The facet is doubled at the SDK boundary and nowhere above it, the way the
 * spawner's own suite doubles it (unit-facet-spawn-node.test.ts): `subAgent` hands
 * back a stub whose `runAsNode` holds until `abortSubAgent` rejects it, which is the
 * `ctx.facets.abort` contract `facet-spawn.ts` cites (pending RPCs reject, storage
 * is kept). Everything from the search's `runNodeAgent` down to that verb is
 * production.
 */

import { describe, expect, test } from 'bun:test';
import type { NodeLoopResult, NodeRunSpec } from '@kinu.run/core';
import { runNodeAgent } from '@kinu.run/core';
import { scriptedTurnModel } from '@kinu.run/test-utils';
import type { NodeFacetHost } from '../src/facet-spawn';
import { mockAgentsSdk } from './helpers/agents-sdk';

mockAgentsSdk();
// Deferred deliberately: the Agent SDK must be mocked BEFORE the module graph that
// imports it is evaluated, which a static import would do first.
const { SubordinateAgent } = await import('../src/subordinate-agent');
const { hostNodeLoop } = await import('../src/facet-spawn');
const { nodeDeps, nodeInput } = await import('./helpers/three-kinds');

class FakeExplorationFacet extends SubordinateAgent {}

const NODE_ID = 'node-1';
const FACET_KEY = `exp:${NODE_ID}`;

const settledResult: NodeLoopResult = {
  report: {
    id: NODE_ID, status: 'completed', summary: 'the direct angle answers it',
    evidence: [], decisions: [], artifactRefs: [], fileChanges: [], childHeadIds: [],
    toolCalls: [], stepCount: 2, usage: { input: 1, output: 1 }, wallClockMs: 1,
  },
  reported: { status: 'completed', content: 'the direct angle answers it' },
  granted: null,
  produced: [],
};

/** A facet host at the SDK boundary: the stub `subAgent` hands back, and the
 *  `abortSubAgent` that rejects its in-flight RPC. Every verb is recorded in order,
 *  because the ORDER — abort before reclaim, reclaim before release — is the claim.
 *
 *  `holdBoot` keeps the bootstrap's last RPC unanswered until `boot()` — the window
 *  in which a facet exists but has not been told to run. */
function facetTransport(options: { holdBoot?: boolean } = {}) {
  const calls: string[] = [];
  const inFlight = Promise.withResolvers<NodeLoopResult>();
  const started = Promise.withResolvers<void>();
  const booting = Promise.withResolvers<void>();
  const booted = Promise.withResolvers<void>();
  if (!options.holdBoot) booted.resolve();
  const stub = {
    setOwner: async () => { calls.push('setOwner'); return { ok: true as const }; },
    setSharedParent: async () => { calls.push('setSharedParent'); return { ok: true as const }; },
    initNode: async (spec: NodeRunSpec) => {
      calls.push('initNode');
      booting.resolve();
      await booted.promise;
      return { ok: true as const, id: spec.headInput.id };
    },
    runAsNode: () => {
      calls.push('runAsNode');
      started.resolve();
      return inFlight.promise;
    },
  };
  const host: NodeFacetHost = {
    subAgent: async (_cls, name) => {
      calls.push(`subAgent ${name}`);
      return stub;
    },
    abortSubAgent: (_cls, name, reason) => {
      calls.push(`abortSubAgent ${name}`);
      inFlight.reject(new Error(`facet evicted: ${reason ?? 'no reason'}`));
    },
    deleteSubAgent: async (_cls, name) => {
      calls.push(`deleteSubAgent ${name}`);
    },
    facetClass: () => FakeExplorationFacet,
    facetHomes: () => ({
      provision: async () => { throw new Error('a node home is provisioned by the search, never by its transport'); },
      release: async (kind, id) => { calls.push(`releaseFacetHome ${kind}:${id}`); },
    }),
  };
  const loop = hostNodeLoop(host, {
    identity: () => ({ ownerUserId: 'user-1', capabilityToken: 'pwc_parent', sharedParent: 'kinu-main' }),
    registerArbiter: () => () => { calls.push('withdrawArbiter'); },
  });
  return {
    calls,
    loop,
    /** The facet is inside its bootstrap — `initNode` was sent and has not answered. */
    booting: booting.promise,
    /** Let a held bootstrap answer. */
    boot: () => { booted.resolve(); },
    /** The facet has entered its loop — the RPC is in flight. */
    started: started.promise,
    /** The facet finishes on its own, the way an uncancelled node does. */
    settle: () => { inFlight.resolve(settledResult); },
  };
}

/** A model the host path never calls: a hosted node resolves its own. */
const unusedModel = scriptedTurnModel({
  provider: 'fake', modelId: 'never-called',
  doGenerate: async () => { throw new Error('the search-side model must not run a hosted node'); },
});

function hostedNode(signal: AbortSignal, options: { holdBoot?: boolean } = {}) {
  const transport = facetTransport(options);
  const { deps, journal } = nodeDeps(unusedModel, { host: transport.loop, signal });
  return { transport, journal, running: runNodeAgent(nodeInput({ nodeId: NODE_ID }), deps) };
}

describe('cancelling a search reaches its hosted nodes', () => {
  test('an abort mid-step evicts the facet, settles the node as aborted, and reclaims it', async () => {
    const controller = new AbortController();
    const { transport, journal, running } = hostedNode(controller.signal);
    await transport.started;

    // The SDK's abort verb is synchronous, so the eviction is observable the moment
    // the signal fires — or it never is, which is the defect this pins.
    controller.abort(new Error('cancelled by operator'));
    expect(transport.calls).toContain(`abortSubAgent ${FACET_KEY}`);

    const run = await running;
    expect(run.report.status).toBe('aborted');
    expect(run.report.errorMessage).toContain('cancelled by operator');
    expect(journal.readHeadView(NODE_ID)).toMatchObject({ status: 'aborted' });
    expect(transport.calls.slice(transport.calls.indexOf('runAsNode'))).toEqual([
      'runAsNode',
      `abortSubAgent ${FACET_KEY}`,
      `deleteSubAgent ${FACET_KEY}`,
      `releaseFacetHome node:${NODE_ID}`,
    ]);
  });

  test('a node that finished before the abort is untouched by it', async () => {
    const controller = new AbortController();
    const { transport, journal, running } = hostedNode(controller.signal);
    await transport.started;
    transport.settle();
    const run = await running;
    expect(run.report.status).toBe('completed');

    controller.abort(new Error('cancelled by operator'));
    expect(transport.calls.some((call) => call.startsWith('abortSubAgent'))).toBe(false);
    expect(journal.readHeadView(NODE_ID)).toMatchObject({ status: 'completed' });
  });

  test('a search already cancelled never boots a facet for the node', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled by operator'));
    const { transport, journal, running } = hostedNode(controller.signal);

    const run = await running;
    expect(run.report.status).toBe('aborted');
    expect(journal.readHeadView(NODE_ID)).toMatchObject({ status: 'aborted' });
    expect(transport.calls.some((call) => call.startsWith('subAgent'))).toBe(false);
  });

  test('a search cancelled while the facet boots reclaims it without ever running it', async () => {
    // An evicted facet restarts on its next RPC, so a `runAsNode` sent after the
    // abort would run the node in full. The window is closed by not sending it.
    const controller = new AbortController();
    const { transport, journal, running } = hostedNode(controller.signal, { holdBoot: true });
    await transport.booting;
    controller.abort(new Error('cancelled by operator'));
    transport.boot();

    const run = await running;
    expect(run.report.status).toBe('aborted');
    expect(journal.readHeadView(NODE_ID)).toMatchObject({ status: 'aborted' });
    expect(transport.calls).not.toContain('runAsNode');
    expect(transport.calls.slice(transport.calls.indexOf('initNode'))).toEqual([
      'initNode',
      `deleteSubAgent ${FACET_KEY}`,
      `releaseFacetHome node:${NODE_ID}`,
    ]);
  });
});
