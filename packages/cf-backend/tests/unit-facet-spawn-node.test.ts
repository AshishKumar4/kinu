/** Failed runs and failed reclamation remain distinct at the public node transport. */
import { describe, expect, test } from 'bun:test';
import type { NodeLoopResult, NodeRunSpec } from '@kinu.run/core';
import type { NodeFacetHost } from '../src/facet-spawn';
import { mockAgentsSdk } from './helpers/agents-sdk';

mockAgentsSdk();
// The platform mock must be installed before the actor module graph loads.
const { SubordinateAgent } = await import('../src/subordinate-agent');
const { hostNodeLoop } = await import('../src/facet-spawn');

const spec: NodeRunSpec = {
  headInput: {
    id: 'node-1', rootId: 'root-1', parentId: null, depth: 1,
    task: 'probe the parser', mode: 'build', rationale: 'one angle',
    inheritedContext: [], budget: { maxDepth: 0, spawnedAt: 0 },
    mergeStrategy: 'synthesize',
  },
  base: 'you are one node of a search',
  messages: [{ role: 'user', content: 'probe the parser' }],
  isolation: 'shared-origin-plane', home: '/workspace', canPropose: false,
};

const completed: NodeLoopResult = {
  report: {
    id: 'node-1', status: 'completed', summary: 'the parser is generated',
    evidence: [], decisions: [], artifactRefs: [], fileChanges: [], childHeadIds: [],
    toolCalls: [], stepCount: 2, usage: { input: 1, output: 1 }, wallClockMs: 1,
  },
  reported: { status: 'completed', content: 'the parser is generated' },
  granted: null, produced: [],
};

function transport(fault: { run?: Error; reclaim?: Error }) {
  const allocated = new Set<string>();
  let homeHeld = true;
  const host: NodeFacetHost = {
    subAgent: async (_cls, name) => {
      allocated.add(name);
      return {
        setOwner: async () => ({ ok: true }),
        setSharedParent: async () => ({ ok: true }),
        initNode: async (input) => ({ ok: true, id: input.headInput.id }),
        runAsNode: async () => {
          if (fault.run) throw fault.run;
          return completed;
        },
      };
    },
    abortSubAgent: () => { throw new Error('no cancellation was requested'); },
    deleteSubAgent: async (_cls, name) => {
      if (fault.reclaim) throw fault.reclaim;
      allocated.delete(name);
    },
    facetClass: () => SubordinateAgent,
    facetHomes: () => ({
      provision: async () => { throw new Error('the search already provisioned this home'); },
      release: async () => { homeHeld = false; },
    }),
  };
  const run = hostNodeLoop(host, {
    identity: () => ({ ownerUserId: 'user-1', capabilityToken: 'pwc_parent', sharedParent: 'kinu-main' }),
    registerArbiter: () => { throw new Error('this leaf has no arbiter'); },
  });
  return { run, allocated, homeHeld: () => homeHeld };
}

describe('hosted node failure cleanup', () => {
  test('a crashed node releases its storage and home while preserving the run error', async () => {
    const failure = new Error('the provider connection broke', { cause: new Error('socket reset') });
    const fixture = transport({ run: failure });
    await expect(fixture.run(spec, null, undefined)).rejects.toBe(failure);
    expect(fixture.allocated.has('exp:node-1')).toBe(false);
    expect(fixture.homeHeld()).toBe(false);
  });

  test('reclamation failure rejects a completed run instead of claiming success', async () => {
    const failure = new Error('facet storage is unreachable');
    const fixture = transport({ reclaim: failure });
    await expect(fixture.run(spec, null, undefined)).rejects.toMatchObject({ cause: failure });
    expect(fixture.allocated.has('exp:node-1')).toBe(true);
    expect(fixture.homeHeld()).toBe(false);
  });
});
