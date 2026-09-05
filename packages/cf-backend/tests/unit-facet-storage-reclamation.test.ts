/**
 * C3 — facet storage reclamation, counted.
 *
 * The defect this file exists to keep dead: exploration facets were only ever
 * EVICTED (`abortSubAgent`), never DELETED, so every head and every MCTS branch
 * left its SQLite database behind inside the root Durable Object forever. Facet
 * ids are never reused, so nothing ever overwrote them.
 *
 * The binding ceiling is facet COUNT, not bytes. A fresh facet database is
 * ~4 KiB, so the 65,536-facets-per-DO-lifetime wall arrives roughly an order of
 * magnitude before the ~10 GB storage quota is threatened — and the SDK's own
 * `cf_agents_sub_agents` registry is the counter, because `deleteSubAgent`
 * calls `_forgetSubAgent` and `abortSubAgent` does not. `liveFacets` below is
 * that registry: a map keyed by facet id that `subAgent` inserts into,
 * `abortSubAgent` deliberately leaves alone, and `deleteSubAgent` removes.
 *
 * Every test here therefore asserts TWO numbers: that reclamation returned the
 * live count to zero, AND a non-zero denominator proving facets were really
 * created. Zero-from-zero is not a proof of anything.
 */

import { describe, expect, test } from 'bun:test';
import type { HeadInput, HeadReport } from '@kinu.run/core';
import type { FacetHost } from '../src/facet-spawn';
import { mockAgentsSdk } from './helpers/agents-sdk';

mockAgentsSdk();
const { ExplorationAgent } = await import('../src/exploration');
const { abortExplorationFacet, deleteExplorationFacet, spawnBranchFacet, spawnHeadFacet } =
  await import('../src/facet-spawn');

function headReportFor(id: string): HeadReport {
  return {
    id,
    status: 'completed',
    summary: `${id} done`,
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
}

function headInput(id: string): HeadInput {
  return {
    id,
    rootId: 'root-1',
    parentId: null,
    depth: 1,
    task: `investigate ${id}`,
    mode: 'build',
    rationale: 'one angle',
    inheritedContext: [],
    budget: { maxDepth: 1, maxWallClockMs: 1000, spawnedAt: 0 },
    mergeStrategy: 'synthesize',
  };
}

const identity = { ownerUserId: 'user-1', capabilityToken: 'pwc_parent', sharedParent: 'kinu-main' };

/** The class this host creates facets as. Nothing below asserts on it — the
 *  count is keyed by facet id — but `FacetHost` requires the host to supply the
 *  class, because the spawner imports it type-only. A subclass because that is
 *  exactly what `SubAgentClass<ExplorationAgent>` admits — no cast needed. */
class FakeExplorationFacet extends ExplorationAgent {}

/**
 * A facet host that MODELS STORAGE rather than just recording calls.
 *
 * `liveFacets` stands in for the root DO's `cf_agents_sub_agents` registry and
 * the databases it accounts for. The three verbs move it exactly as the real
 * SDK does, which is what makes a count over it meaningful:
 *   subAgent       -> insert (a database now exists, charged to the root)
 *   abortSubAgent  -> NO CHANGE (the instance stops; the database survives)
 *   deleteSubAgent -> remove (`_cf_cleanupFacetPrefix` + `ctx.facets.delete`)
 */
function storageModelingHost(options: { runAsHeadRejects?: boolean } = {}) {
  const liveFacets = new Map<string, { evicted: boolean }>();
  let everCreated = 0;
  const liveHomes = new Set<string>();

  const stubFor = (id: string) => ({
    setOwner: async () => ({ ok: true }),
    setSharedParent: async () => ({ ok: true }),
    initHead: async () => ({ ok: true }),
    abortHead: async () => ({ ok: true }),
    // A running head provisions its own home on the owner before its loop;
    // the crash arm models a head that got that far and then died.
    runAsHead: async () => {
      liveHomes.add(`head-${id}`);
      if (options.runAsHeadRejects) throw new Error(`${id} crashed`);
      return headReportFor(id);
    },
    explore: async () => ({ text: `${id} approach` }),
    generateReflection: async () => ({ text: `${id} post-mortem` }),
  });

  const host = {
    subAgent: async (_cls: { name: string }, id: string) => {
      if (!liveFacets.has(id)) {
        liveFacets.set(id, { evicted: false });
        everCreated += 1;
      }
      return stubFor(id);
    },
    // Eviction only. The entry stays: this is precisely the leak.
    abortSubAgent: (_cls: { name: string }, id: string) => {
      const facet = liveFacets.get(id);
      if (facet) facet.evicted = true;
    },
    // Terminal reclamation. Idempotent, as the SDK's delete is.
    deleteSubAgent: async (_cls: { name: string }, id: string) => {
      liveFacets.delete(id);
    },
    explorationFacet: () => FakeExplorationFacet,
    // A head's home is reclaimed with its storage: a facet whose storage went
    // and whose home stayed would be a second leak the quota never shows.
    facetHomes: () => ({
      provision: async (kind: string, id: string) => {
        liveHomes.add(`${kind}-${id}`);
        return { home: `/home/${kind}-${id}`, tmp: `/tmp/${kind}-${id}`, cred: { uid: 2000, gid: 2000, groups: [2000], umask: 0o022 } };
      },
      release: async (kind: string, id: string) => {
        liveHomes.delete(`${kind}-${id}`);
      },
    }),
  };

  // SAFETY: this locally constructed host implements all four members FacetHost
  // owns — the three SDK verbs plus `explorationFacet` — and every stub method
  // spawnBranchFacet/spawnHeadFacet invokes.
  return {
    host: host as FacetHost,
    liveCount: () => liveFacets.size,
    everCreated: () => everCreated,
    liveIds: () => [...liveFacets.keys()].sort(),
    liveHomes: () => [...liveHomes].sort(),
  };
}

/** The MCTS engine's terminal sweep, verbatim in shape (mcts/engine.ts): every
 *  id the iteration spawned is released once reflection has read its traces,
 *  and `allSettled` means one failing release cannot strand the rest. */
async function releaseSweep(host: FacetHost, branchIds: readonly string[]): Promise<void> {
  await Promise.allSettled(branchIds.map((id) => deleteExplorationFacet(host, id)));
}

describe('C3 — exploration facet storage is reclaimed', () => {
  test('a head fan-out returns the live facet count to zero, from a non-zero denominator', async () => {
    const facets = storageModelingHost();
    const ids = ['head-a', 'head-b', 'head-c', 'head-d'];

    const heads = await Promise.all(
      ids.map((id) => spawnHeadFacet(facets.host, headInput(id), identity)),
    );
    // Mid-search: every head holds a live database.
    expect(facets.liveCount()).toBe(4);

    const reports = await Promise.all(heads.map((head) => head.run()));

    expect(reports.map((r) => r.id)).toEqual(ids);
    // DENOMINATOR: a fan-out that silently spawned nothing would reclaim
    // nothing and must not be allowed to pass as a reclamation proof.
    expect(facets.everCreated()).toBe(4);
    expect(facets.liveIds()).toEqual([]);
    expect(facets.liveCount()).toBe(0);
    // The homes went with the databases: a settled head's tree is as much a
    // leak as its SQLite, and neither survives the report.
    expect(facets.liveHomes()).toEqual([]);
  });

  test('an MCTS iteration returns every branch facet it spawned', async () => {
    const facets = storageModelingHost();
    const branchIds = ['branch-0', 'branch-1', 'branch-2', 'branch-3', 'branch-4'];

    const branches = await Promise.all(
      branchIds.map((id) => spawnBranchFacet(facets.host, id, identity)),
    );
    // The iteration explores and then reflects — the reflection reads the
    // branch's own traces, which is why release cannot happen any earlier.
    await Promise.all(branches.map((b) => b.explore([], [], ['javascript'], 'plan', [])));
    await Promise.all(branches.map((b) => b.generateReflection('the task')));
    expect(facets.liveCount()).toBe(5);

    await releaseSweep(facets.host, branchIds);

    expect(facets.everCreated()).toBe(5);
    expect(facets.liveCount()).toBe(0);
  });

  test('a recursive split reclaims depth-2 facets as well as depth-1', async () => {
    const facets = storageModelingHost();

    // A head that splits further spawns against the same facet substrate, so a
    // depth-2 database is charged to the same root and leaks the same way.
    const parent = await spawnHeadFacet(facets.host, headInput('head-root'), identity);
    const children = await Promise.all(
      ['head-root.a', 'head-root.b'].map((id) => spawnHeadFacet(facets.host, headInput(id), identity)),
    );
    expect(facets.liveCount()).toBe(3);

    await Promise.all(children.map((child) => child.run()));
    await parent.run();

    expect(facets.everCreated()).toBe(3);
    expect(facets.liveCount()).toBe(0);
  });

  test('the live count stays FLAT across repeated searches instead of growing', async () => {
    const facets = storageModelingHost();
    const highWater: number[] = [];

    for (let search = 0; search < 3; search += 1) {
      const branchIds = [0, 1, 2].map((n) => `s${search}-branch-${n}`);
      const branches = await Promise.all(
        branchIds.map((id) => spawnBranchFacet(facets.host, id, identity)),
      );
      await Promise.all(branches.map((b) => b.generateReflection('the task')));
      const head = await spawnHeadFacet(facets.host, headInput(`s${search}-head`), identity);
      await head.run();
      await releaseSweep(facets.host, branchIds);
      highWater.push(facets.liveCount());
    }

    // The acceptance signal for C3: monotonic growth here is the defect, and
    // 65,536 facets per DO lifetime is the wall it walks into.
    expect(highWater).toEqual([0, 0, 0]);
    expect(facets.everCreated()).toBe(12);
    expect(facets.liveCount()).toBe(0);
  });

  test('evicting is NOT reclaiming — the pre-fix verb provably leaks', async () => {
    const facets = storageModelingHost();
    const branchIds = ['branch-0', 'branch-1', 'branch-2'];

    await Promise.all(branchIds.map((id) => spawnBranchFacet(facets.host, id, identity)));
    // Exactly what the code did before C3 was fixed.
    for (const id of branchIds) abortExplorationFacet(facets.host, id);

    // Pins the sensitivity of every assertion above: if `abortSubAgent` also
    // reclaimed storage, the zeros elsewhere in this file would be vacuous.
    expect(facets.everCreated()).toBe(3);
    expect(facets.liveCount()).toBe(3);
    expect(facets.liveIds()).toEqual(branchIds);

    // And the terminal verb still collects them afterwards — an evicted facet
    // is reclaimable, it was simply never being reclaimed.
    await releaseSweep(facets.host, branchIds);
    expect(facets.liveCount()).toBe(0);
  });

  test('a head whose run fails still hands its database back', async () => {
    const facets = storageModelingHost({ runAsHeadRejects: true });

    const head = await spawnHeadFacet(facets.host, headInput('head-doomed'), identity);
    expect(facets.liveCount()).toBe(1);

    await expect(head.run()).rejects.toThrow('head-doomed crashed');

    // A crashed head is the case most likely to leak, because nothing on the
    // success path runs — the `finally` is the whole guarantee.
    expect(facets.everCreated()).toBe(1);
    expect(facets.liveCount()).toBe(0);
    expect(facets.liveHomes()).toEqual([]);
  });
});
