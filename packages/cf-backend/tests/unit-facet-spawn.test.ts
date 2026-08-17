/**
 * The exploration-facet spawn seam: bootstrap order, handle behaviour, and
 * teardown. Exercised for real, against a recording facet host — the Agent SDK
 * is the only thing stubbed.
 */

import { describe, expect, test } from 'bun:test';
import type { HeadInput, HeadReport } from '@proteus/core';
import type { FacetHost } from '../src/facet-spawn.ts';
import { mockAgentsSdk } from './helpers/agents-sdk.js';

mockAgentsSdk();
const { ExplorationAgent } = await import('../src/exploration.ts');
const { abortExplorationFacet, spawnBranchFacet, spawnHeadFacet } =
  await import('../src/facet-spawn.ts');

interface Call { method: string; args: unknown[] }

const headReport: HeadReport = {
  id: 'head-1',
  status: 'completed',
  summary: 'done',
  evidence: [],
  decisions: [],
  artifactRefs: [],
  fileChanges: [],
  childHeadIds: [],
  toolCalls: [],
  stepCount: 0,
  tokenUsage: { input: 1, output: 1, total: 2 },
  wallClockMs: 1,
};

function headInput(): HeadInput {
  return {
    id: 'head-1',
    rootId: 'root-1',
    parentId: null,
    depth: 1,
    task: 'investigate',
    mode: 'build',
    rationale: 'one angle',
    inheritedContext: [],
    // The child budget HeadController already decremented for this depth.
    budget: { maxDepth: 1, maxWallClockMs: 1000, spawnedAt: 0 },
    mergeStrategy: 'synthesize',
  };
}

/** A facet host whose stub records every RPC, in order. `failing` names the one
 *  bootstrap RPC that should reject, to exercise the discard path. */
function makeHost(options: { failing?: string; abortSubAgentThrows?: boolean } = {}) {
  const calls: Call[] = [];
  const record = (method: string, args: unknown[]) => {
    calls.push({ method, args });
    if (options.failing === method) return Promise.reject(new Error(`${method} exploded`));
    return Promise.resolve({ ok: true });
  };
  const stub = {
    setOwner: (userId: string, capabilityToken: string | null) => record('setOwner', [userId, capabilityToken]),
    setSharedParent: (name: string) => record('setSharedParent', [name]),
    initHead: (input: HeadInput) => record('initHead', [input]),
    abortHead: (reason: string) => record('abortHead', [reason]),
    runAsHead: async () => { calls.push({ method: 'runAsHead', args: [] }); return headReport; },
    explore: async (...args: unknown[]) => {
      calls.push({ method: 'explore', args });
      return { text: 'an approach' };
    },
    generateReflection: async (task: string) => {
      calls.push({ method: 'generateReflection', args: [task] });
      return { text: 'went wrong' };
    },
  };
  const host = {
    subAgent: async (cls: { name: string }, name: string) => {
      calls.push({ method: 'subAgent', args: [cls, name] });
      return stub;
    },
    abortSubAgent: (cls: { name: string }, name: string) => {
      calls.push({ method: 'abortSubAgent', args: [cls, name] });
      if (options.abortSubAgentThrows) throw new Error('facet registry gone');
    },
  };
  // SAFETY: this locally constructed host implements both members FacetHost
  // owns; every returned exploration stub method is present and records its
  // exact argument list before returning the owner-shaped result above.
  return { host: host as FacetHost, calls };
}

const methods = (calls: Call[]) => calls.map((call) => call.method);

describe('exploration-facet spawn seam', () => {
  test('a head is fully bootstrapped, in order, before its handle exists', async () => {
    const { host, calls } = makeHost();
    const input = headInput();

    const head = await spawnHeadFacet(host, input, {
      ownerUserId: 'user-1',
      capabilityToken: 'pwc_parent',
      sharedParent: 'proteus-main',
    });

    expect(methods(calls)).toEqual(['subAgent', 'setOwner', 'setSharedParent', 'initHead']);
    // Heads spawn the bare ExplorationAgent — never a class carrying the actor
    // tool surface — which is what bounds the spawn tree.
    expect(calls[0]?.args).toEqual([ExplorationAgent, 'head-1']);
    // The spawner's workspace capability token rides down with the owner, so
    // the head reaches the user's credentials AS the parent workspace and is
    // attenuated with it — no per-head identity to taint separately.
    expect(calls[1]?.args).toEqual(['user-1', 'pwc_parent']);
    expect(calls[2]?.args).toEqual(['proteus-main']);
    // The budget the caller derived reaches the facet untouched.
    expect(calls[3]?.args).toEqual([input]);
    expect(head.id).toBe('head-1');
  });

  test('the head handle runs and tears down the facet it spawned', async () => {
    const { host, calls } = makeHost();
    const head = await spawnHeadFacet(host, headInput(), {
      ownerUserId: 'user-1', capabilityToken: 'pwc_parent', sharedParent: 'proteus-main',
    });
    calls.length = 0;

    expect(await head.run()).toEqual(headReport);
    await head.abort('wall-clock timeout');

    expect(methods(calls)).toEqual(['runAsHead', 'abortHead', 'abortSubAgent']);
    expect(calls[1]?.args).toEqual(['wall-clock timeout']);
    expect(calls[2]?.args).toEqual([ExplorationAgent, 'head-1']);
  });

  test('a head still evicts its facet when the in-facet abort fails', async () => {
    const { host, calls } = makeHost({ failing: 'abortHead' });
    const head = await spawnHeadFacet(host, headInput(), {
      ownerUserId: 'user-1', capabilityToken: 'pwc_parent', sharedParent: 'proteus-main',
    });
    calls.length = 0;

    // Eviction is unconditional AND the failed notify surfaces: `abortHead`'s
    // flags live only in the instance the eviction then discards, so a head that
    // survives its abort is a live facet nobody is waiting for — which is why
    // core's raceWithTimeout documents that this failure must not be absorbed.
    await expect(head.abort('wall-clock timeout')).rejects.toThrow('abortHead exploded');

    expect(methods(calls)).toEqual(['abortHead', 'abortSubAgent']);
  });

  test('a facet whose bootstrap fails is discarded, never handed out', async () => {
    const { host, calls } = makeHost({ failing: 'initHead' });

    await expect(spawnHeadFacet(host, headInput(), {
      ownerUserId: 'user-1', capabilityToken: 'pwc_parent', sharedParent: 'proteus-main',
    })).rejects.toThrow('initHead exploded');

    expect(methods(calls)).toEqual([
      'subAgent', 'setOwner', 'setSharedParent', 'initHead', 'abortSubAgent',
    ]);
    expect(calls.at(-1)?.args).toEqual([ExplorationAgent, 'head-1']);
  });

  test('a branch seeds only its owner and exposes the MCTS rollout calls', async () => {
    const { host, calls } = makeHost();

    const branch = await spawnBranchFacet(host, 'branch-7', {
      ownerUserId: 'user-1', capabilityToken: 'pwc_parent',
    });

    expect(methods(calls)).toEqual(['subAgent', 'setOwner']);
    expect(calls[0]?.args).toEqual([ExplorationAgent, 'branch-7']);
    expect(calls[1]?.args).toEqual(['user-1', 'pwc_parent']);

    expect(await branch.explore([{ role: 'user', content: 'hi' }], [], ['javascript'], 'plan')).toEqual({
      text: 'an approach',
    });
    // Siblings are always sent, so the facet's diversity directive is not
    // left to an RPC-side default.
    expect(calls[2]?.args).toEqual([[{ role: 'user', content: 'hi' }], [], ['javascript'], 'plan', []]);
    expect(await branch.generateReflection('the task')).toEqual({ text: 'went wrong' });
  });

  test('an unclaimed workspace spawns a branch without seeding an owner', async () => {
    const { host, calls } = makeHost();

    await spawnBranchFacet(host, 'branch-7', { ownerUserId: null, capabilityToken: null });

    expect(methods(calls)).toEqual(['subAgent']);
  });

  test('a branch whose owner seeding fails is discarded and the error propagates', async () => {
    const { host, calls } = makeHost({ failing: 'setOwner' });

    await expect(spawnBranchFacet(host, 'branch-7', { ownerUserId: 'user-1', capabilityToken: 'pwc_parent' }))
      .rejects.toThrow('setOwner exploded');

    expect(methods(calls)).toEqual(['subAgent', 'setOwner', 'abortSubAgent']);
  });

  test('aborting a facet that is already gone is not an error', () => {
    const { host, calls } = makeHost();

    // `ctx.facets.abort` shuts down a facet if it is running and is otherwise a
    // no-op, so "already gone" needs no tolerance at all.
    expect(() => abortExplorationFacet(host, 'branch-7')).not.toThrow();
    expect(methods(calls)).toEqual(['abortSubAgent']);

    // What abortSubAgent DOES throw for is a runtime with no facet registry at
    // all (the SDK's compatibility_date guard). Reading that as "already gone"
    // would report every discarded facet as evicted while all of them stayed
    // live, so it has to surface.
    const unsupported = makeHost({ abortSubAgentThrows: true });
    expect(() => abortExplorationFacet(unsupported.host, 'branch-7')).toThrow('facet registry gone');
  });
});
