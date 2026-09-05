/**
 * The swarm-node spawn seam: bootstrap order, and the settle-before-reclaim split
 * that separates a reclaimed facet from a leaked one.
 *
 * A node's handle is the spawner's side of core's `NodeLoopHost` — one call, one
 * result — so what is worth pinning is not the loop (core owns and tests that) but
 * the lifecycle around it: the spec reaches the facet untouched, `run()` settles
 * BEFORE the storage is wiped, a failed wipe is reported rather than swallowed, and
 * `abort()` evicts without wiping. Collapsing the last pair either way is a
 * permanent leak one direction and data loss on a live node the other.
 */

import { describe, expect, test } from 'bun:test';
import type { HeadReport, NodeLoopResult, NodeRunSpec } from '@kinu.run/core';
import type { FacetHost } from '../src/facet-spawn';
import { mockAgentsSdk } from './helpers/agents-sdk';

mockAgentsSdk();
// Deferred deliberately: the Agent SDK must be mocked BEFORE the module graph that
// imports it is evaluated, which a static import would do first.
const { ExplorationAgent } = await import('../src/exploration');
const { spawnNodeFacet } = await import('../src/facet-spawn');

/** The class the fake host hands the spawner, and a DISTINCT identity from
 *  `ExplorationAgent` on purpose: the spawner must create whatever class its
 *  host supplies, and a class the spawner cannot name is what proves the
 *  argument is forwarded rather than hardcoded. A subclass because that is
 *  exactly what `SubAgentClass<ExplorationAgent>` admits — no cast needed. */
class FakeExplorationFacet extends ExplorationAgent {}

interface Call { method: string; args: unknown[] }

function nodeSpec(): NodeRunSpec {
  return {
    headInput: {
      id: 'node-1',
      rootId: 'root-1',
      parentId: null,
      depth: 1,
      task: 'probe the parser',
      mode: 'build',
      rationale: 'one angle',
      inheritedContext: [],
      budget: { maxDepth: 1, spawnedAt: 0 },
      mergeStrategy: 'synthesize',
    },
    base: 'you are one node of a search',
    messages: [{ role: 'user', content: 'probe the parser' }],
    isolation: 'shared-origin-plane',
    home: '/workspace',

    canPropose: false,
  };
}

const report: HeadReport = {
  id: 'node-1',
  status: 'completed',
  summary: 'the parser is generated',
  evidence: [],
  decisions: [],
  artifactRefs: [],
  fileChanges: [],
  childHeadIds: [],
  toolCalls: [],
  stepCount: 2,
  usage: { input: 1, output: 1 },
  wallClockMs: 1,
};

const nodeResult: NodeLoopResult = {
  report,
  reported: { status: 'completed', content: 'the parser is generated' },
  granted: null,
  produced: [],
};

/** A facet host whose stub records every RPC, in order. `abortSubAgent` and
 *  `deleteSubAgent` record under DISTINCT names because only the second wipes the
 *  facet's SQLite, and a test that cannot tell them apart cannot tell reclamation
 *  from a leak. */
function makeHost(options: { deleteSubAgentThrows?: boolean; runAsNodeRejects?: boolean } = {}) {
  const calls: Call[] = [];
  const stub = {
    setOwner: async (userId: string, capabilityToken: string | null) => {
      calls.push({ method: 'setOwner', args: [userId, capabilityToken] });
      return { ok: true as const };
    },
    setSharedParent: async (name: string) => {
      calls.push({ method: 'setSharedParent', args: [name] });
      return { ok: true as const };
    },
    initNode: async (spec: NodeRunSpec) => {
      calls.push({ method: 'initNode', args: [spec] });
      return { ok: true as const, id: spec.headInput.id };
    },
    runAsNode: async () => {
      calls.push({ method: 'runAsNode', args: [] });
      if (options.runAsNodeRejects) throw new Error('the node crashed mid-run');
      return nodeResult;
    },
  };
  const host = {
    subAgent: async (cls: { name: string }, name: string) => {
      calls.push({ method: 'subAgent', args: [cls, name] });
      return stub;
    },
    abortSubAgent: (cls: { name: string }, name: string, reason?: string) => {
      calls.push({ method: 'abortSubAgent', args: [cls, name, reason] });
    },
    deleteSubAgent: async (cls: { name: string }, name: string) => {
      calls.push({ method: 'deleteSubAgent', args: [cls, name] });
      if (options.deleteSubAgentThrows) throw new Error('facet storage is unreachable');
    },
    explorationFacet: () => FakeExplorationFacet,
    facetHomes: () => ({
      provision: async (kind: string, id: string) => {
        calls.push({ method: 'provisionFacetHome', args: [kind, id] });
        return { home: `/home/${kind}-${id}`, tmp: `/tmp/${kind}-${id}`, cred: { uid: 2000, gid: 2000, groups: [2000], umask: 0o022 } };
      },
      release: async (kind: string, id: string) => {
        calls.push({ method: 'releaseFacetHome', args: [kind, id] });
      },
    }),
    listSubAgents: () => [],
  };
  // SAFETY: this locally constructed host implements every member FacetHost
  // owns — the four SDK verbs plus `explorationFacet` — and the stub it returns
  // declares every exploration method the node spawner reaches, each recording
  // its exact argument list.
  return { host: host as FacetHost, calls };
}

const methods = (calls: Call[]) => calls.map((call) => call.method);

describe('swarm-node facet spawn', () => {
  test('a node is fully bootstrapped, in order, before its handle exists', async () => {
    const { host, calls } = makeHost();
    const spec = nodeSpec();

    const node = await spawnNodeFacet(host, spec, {
      ownerUserId: 'user-1',
      capabilityToken: 'pwc_parent',
      sharedParent: 'kinu-main',
    });

    expect(methods(calls)).toEqual(['subAgent', 'setOwner', 'setSharedParent', 'initNode']);
    // A node spawns the class its host supplies, keyed by the search's own node id.
    expect(calls[0]?.args).toEqual([FakeExplorationFacet, 'node-1']);
    expect(calls[1]?.args).toEqual(['user-1', 'pwc_parent']);
    // The ROOT workspace, unchanged: a node's file plane is the origin's, and the
    // search it reports to runs there.
    expect(calls[2]?.args).toEqual(['kinu-main']);
    // The spec crosses the RPC whole — the loop's every input is data.
    expect(calls[3]?.args).toEqual([spec]);
    expect(node.id).toBe('node-1');
  });

  test('a node RECLAIMS its facet when run() settles, and only EVICTS on abort()', async () => {
    const { host, calls } = makeHost();
    const node = await spawnNodeFacet(host, nodeSpec(), {
      ownerUserId: 'user-1', capabilityToken: 'pwc_parent', sharedParent: 'kinu-main',
    });
    calls.length = 0;

    expect(await node.run()).toEqual(nodeResult);
    node.abort('the search was aborted');

    expect(methods(calls)).toEqual(['runAsNode', 'deleteSubAgent', 'abortSubAgent']);
    expect(calls[1]?.args).toEqual([FakeExplorationFacet, 'node-1']);
    // Nothing is asked of the facet before eviction: a node has no abort callable,
    // so the reason rides the SDK's own abort channel.
    expect(calls[2]?.args).toEqual([FakeExplorationFacet, 'node-1', 'the search was aborted']);
  });

  test('a crashed node still reclaims its storage, and the run error reaches the caller', async () => {
    const { host, calls } = makeHost({ runAsNodeRejects: true });
    const node = await spawnNodeFacet(host, nodeSpec(), {
      ownerUserId: 'user-1', capabilityToken: 'pwc_parent', sharedParent: 'kinu-main',
    });
    calls.length = 0;

    await expect(node.run()).rejects.toThrow('the node crashed mid-run');
    expect(methods(calls)).toEqual(['runAsNode', 'deleteSubAgent']);
  });

  test('a reclamation failure is reported, never masked by the settled result', async () => {
    const { host } = makeHost({ deleteSubAgentThrows: true });
    const node = await spawnNodeFacet(host, nodeSpec(), {
      ownerUserId: 'user-1', capabilityToken: 'pwc_parent', sharedParent: 'kinu-main',
    });

    // The quota this leaks into overflows as an uncatchable reset, so a settled
    // result is deliberately NOT enough to let the failure pass quietly.
    await expect(node.run()).rejects.toThrow('Node facet node-1 settled but its storage was not reclaimed');
  });
});
