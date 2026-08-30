/**
 * The exploration-facet spawn seam: bootstrap order, handle behaviour, and
 * teardown. Exercised for real, against a recording facet host — the Agent SDK
 * is the only thing stubbed.
 */

import { describe, expect, test } from 'bun:test';
import type { HeadInput, HeadReport } from '@kinu.run/core';
import type { FacetHost } from '../src/facet-spawn';
import { mockAgentsSdk } from './helpers/agents-sdk';

mockAgentsSdk();
const { ExplorationAgent } = await import('../src/exploration');
const { abortExplorationFacet, deleteExplorationFacet, spawnBranchFacet, spawnHeadFacet } =
  await import('../src/facet-spawn');

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
  usage: { input: 1, output: 1 },
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

/** The class the fake host hands the spawner, and a DISTINCT identity from
 *  `ExplorationAgent` on purpose: the spawner must create whatever class its
 *  host supplies, and a class the spawner cannot name is what proves the
 *  argument is forwarded rather than hardcoded. A subclass because that is
 *  exactly what `SubAgentClass<ExplorationAgent>` admits — no cast needed. */
class FakeExplorationFacet extends ExplorationAgent {}

/** A facet host whose stub records every RPC, in order. `failing` names the one
 *  bootstrap RPC that should reject, to exercise the discard path.
 *
 *  `abortSubAgent` and `deleteSubAgent` record under DISTINCT names on purpose:
 *  the first only evicts the instance, the second also wipes its SQLite, and a
 *  test that cannot tell them apart cannot tell reclamation from a leak. */
function makeHost(
  options: {
    failing?: string;
    abortSubAgentThrows?: boolean;
    deleteSubAgentThrows?: boolean;
    runAsHeadRejects?: boolean;
  } = {},
) {
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
    runAsHead: async () => {
      calls.push({ method: 'runAsHead', args: [] });
      if (options.runAsHeadRejects) throw new Error('the head crashed mid-run');
      return headReport;
    },
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
    deleteSubAgent: async (cls: { name: string }, name: string) => {
      calls.push({ method: 'deleteSubAgent', args: [cls, name] });
      if (options.deleteSubAgentThrows) throw new Error('facet storage is unreachable');
    },
    explorationFacet: () => FakeExplorationFacet,
    listSubAgents: () => [],
  };
  // SAFETY: this locally constructed host implements every member FacetHost
  // owns — the four SDK verbs plus `explorationFacet` — and every returned
  // exploration stub method is present and records its exact argument list
  // before returning the owner-shaped result above.
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
      sharedParent: 'kinu-main',
    });

    expect(methods(calls)).toEqual(['subAgent', 'setOwner', 'setSharedParent', 'initHead']);
    // The class comes from the HOST, keyed by the head's own id — the spawner has
    // none of its own to hardcode. That every real host supplies the bare
    // ExplorationAgent, never a class carrying the actor tool surface, is what
    // bounds the spawn tree (unit-exploration-containment.test.ts).
    expect(calls[0]?.args).toEqual([FakeExplorationFacet, 'head-1']);
    // The spawner's workspace capability token rides down with the owner, so
    // the head reaches the user's credentials AS the parent workspace and is
    // attenuated with it — no per-head identity to taint separately.
    expect(calls[1]?.args).toEqual(['user-1', 'pwc_parent']);
    expect(calls[2]?.args).toEqual(['kinu-main']);
    // The budget the caller derived reaches the facet untouched.
    expect(calls[3]?.args).toEqual([input]);
    expect(head.id).toBe('head-1');
  });

  test('a head RECLAIMS its facet when run() settles, and only EVICTS on abort()', async () => {
    const { host, calls } = makeHost();
    const head = await spawnHeadFacet(host, headInput(), {
      ownerUserId: 'user-1', capabilityToken: 'pwc_parent', sharedParent: 'kinu-main',
    });
    calls.length = 0;

    expect(await head.run()).toEqual(headReport);
    await head.abort('wall-clock timeout');

    // run() is the TERMINAL point, so it wipes the facet's storage; abort() is
    // mid-flight and must only evict the instance. Collapsing either into the
    // other is a leak one way and data loss the other.
    expect(methods(calls)).toEqual(['runAsHead', 'deleteSubAgent', 'abortHead', 'abortSubAgent']);
    expect(calls[1]?.args).toEqual([FakeExplorationFacet, 'head-1']);
    expect(calls[2]?.args).toEqual(['wall-clock timeout']);
    expect(calls[3]?.args).toEqual([FakeExplorationFacet, 'head-1']);
  });

  test('run() reclaims the facet even when runAsHead rejects, and the original error propagates', async () => {
    const { host, calls } = makeHost({ runAsHeadRejects: true });
    const head = await spawnHeadFacet(host, headInput(), {
      ownerUserId: 'user-1', capabilityToken: 'pwc_parent', sharedParent: 'kinu-main',
    });
    calls.length = 0;

    // A head that dies still holds a database; the `finally` is the only thing
    // that hands it back, and it must not mask why the head died.
    await expect(head.run()).rejects.toThrow('the head crashed mid-run');

    expect(methods(calls)).toEqual(['runAsHead', 'deleteSubAgent']);
    expect(calls[1]?.args).toEqual([FakeExplorationFacet, 'head-1']);
  });

  test('abort() on a live head never deletes — releasing there would wipe a head still writing', async () => {
    const { host, calls } = makeHost();
    const head = await spawnHeadFacet(host, headInput(), {
      ownerUserId: 'user-1', capabilityToken: 'pwc_parent', sharedParent: 'kinu-main',
    });
    calls.length = 0;

    await head.abort('superseded');

    expect(methods(calls)).toEqual(['abortHead', 'abortSubAgent']);
    expect(methods(calls)).not.toContain('deleteSubAgent');
  });

  test('a failing in-facet abort still evicts, and the failure is not discarded', async () => {
    const { host, calls } = makeHost({ failing: 'abortHead' });
    const head = await spawnHeadFacet(host, headInput(), {
      ownerUserId: 'user-1', capabilityToken: 'pwc_parent', sharedParent: 'kinu-main',
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
      ownerUserId: 'user-1', capabilityToken: 'pwc_parent', sharedParent: 'kinu-main',
    })).rejects.toThrow('initHead exploded');

    // The half-seeded facet is WIPED, not merely evicted: nothing will ever
    // read it, so leaving it behind is a pure leak into the root's quota.
    expect(methods(calls)).toEqual([
      'subAgent', 'setOwner', 'setSharedParent', 'initHead', 'deleteSubAgent',
    ]);
    expect(calls.at(-1)?.args).toEqual([FakeExplorationFacet, 'head-1']);
  });

  test('a branch seeds only its owner and exposes the MCTS rollout calls', async () => {
    const { host, calls } = makeHost();

    const branch = await spawnBranchFacet(host, 'branch-7', {
      ownerUserId: 'user-1', capabilityToken: 'pwc_parent',
    });

    expect(methods(calls)).toEqual(['subAgent', 'setOwner']);
    expect(calls[0]?.args).toEqual([FakeExplorationFacet, 'branch-7']);
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

    expect(methods(calls)).toEqual(['subAgent', 'setOwner', 'deleteSubAgent']);
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

  test("deleting a facet targets the host's exploration class and that id", async () => {
    const { host, calls } = makeHost();

    await deleteExplorationFacet(host, 'branch-7');

    expect(methods(calls)).toEqual(['deleteSubAgent']);
    expect(calls[0]?.args).toEqual([FakeExplorationFacet, 'branch-7']);
  });

  test('a bootstrap failure whose cleanup also fails names the leak and keeps the original cause', async () => {
    const { host, calls } = makeHost({ failing: 'setOwner', deleteSubAgentThrows: true });

    // Both facts matter and neither may hide the other: the spawn failed, AND
    // a database was stranded in the root's quota because of it.
    const thrown = await spawnBranchFacet(host, 'branch-7', {
      ownerUserId: 'user-1', capabilityToken: 'pwc_parent',
    }).then(() => null, (error: unknown) => {
      if (!(error instanceof Error)) throw error;
      return error;
    });

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown?.message).toContain('branch-7');
    expect(thrown?.message).toContain('could not be reclaimed');
    expect(thrown?.message).toContain('facet storage is unreachable');
    // The bootstrap error survives as the cause rather than being replaced.
    expect(thrown?.cause).toMatchObject({ message: 'setOwner exploded' });
    expect(methods(calls)).toEqual(['subAgent', 'setOwner', 'deleteSubAgent']);
  });
});
