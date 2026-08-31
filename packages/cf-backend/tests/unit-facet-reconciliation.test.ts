/**
 * S13 — facets a reset left behind, reconciled against the ledgers that
 * already own their lifecycle. A terminal or superseded row proves its facet
 * has no reader left; an unledgered facet is reclaimed only when nothing live
 * claims exploration work, because MCTS creates a branch facet BEFORE it
 * writes the child node — treating every missing row as an orphan would
 * destroy an active rollout.
 */
import { describe, expect, test } from 'bun:test';
import {
  reconcileExplorationFacets,
  type ExplorationFacetRegistry,
} from '../src/facet-spawn';
import { orchestratorHarness } from './helpers/actor-harness';

function host(
  facets: string[],
  deleted: string[] = [],
): ExplorationFacetRegistry & { deleted: string[] } {
  return {
    list: () => facets.map((name) => ({ name })),
    delete: async (id) => { deleted.push(id); },
    deleted,
  };
}

const terminal = () => 'terminal' as const;
const resumable = () => 'resumable' as const;

describe('reconcileExplorationFacets', () => {
  test('a terminal-ledger facet is reclaimed', async () => {
    const h = host(['done-head']);
    const out = await reconcileExplorationFacets(h, terminal, () => false);
    expect(out).toEqual({ reclaimed: 1, retained: 0 });
    expect(h.deleted).toEqual(['done-head']);
  });

  test('a resumable-ledger facet is preserved even when idle', async () => {
    const h = host(['interrupted-search']);
    const out = await reconcileExplorationFacets(h, resumable, () => false);
    expect(out).toEqual({ reclaimed: 0, retained: 1 });
    expect(h.deleted).toEqual([]);
  });

  test('an unledgered facet is reclaimed only when no live exploration claims it', async () => {
    const idle = host(['branch-without-node-yet']);
    expect(await reconcileExplorationFacets(idle, () => 'unknown' as const, () => false))
      .toEqual({ reclaimed: 1, retained: 0 });
    const busy = host(['branch-without-node-yet']);
    expect(await reconcileExplorationFacets(busy, () => 'unknown' as const, () => true))
      .toEqual({ reclaimed: 0, retained: 1 });
    expect(busy.deleted).toEqual([]);
  });

  test('a mixed roster reclaims exactly the provably dead members', async () => {
    const h = host(['dead', 'live-rollout', 'unledgered']);
    const status = (id: string) =>
      id === 'dead' ? 'terminal' as const : id === 'live-rollout' ? 'resumable' as const : 'unknown' as const;
    const out = await reconcileExplorationFacets(h, status, () => true);
    // `unknown` is retained because the live rollout forbids guessing.
    expect(out).toEqual({ reclaimed: 1, retained: 2 });
    expect(h.deleted).toEqual(['dead']);
  });
});

/**
 * The same sweep over the REAL ledger, which is where the classification lives.
 *
 * The cases above hand `reconcileExplorationFacets` a status directly, so they
 * say nothing about which rows produce which status — and that mapping is where
 * the leak was: `errored` and `budget_exceeded` were classified `resumable`, so a
 * head that threw or blew its budget kept its facet. Because a facet id is never
 * reused that storage is never overwritten, which makes the retention permanent
 * for the life of the workspace.
 *
 * Every row here is written by the branch head's own producer (`startBranchHead`)
 * and every facet is registered by the same `subAgent` call `spawnHeadFacet`
 * makes, so what is classified is a real journal row under its real id.
 */
describe('the exploration-facet sweep over the head journal', () => {
  test('every terminal head loses its facet; only the executing ones keep theirs', async () => {
    const harness = orchestratorHarness();
    const settled = [
      ['branch-done', 'completed'],
      ['branch-threw', 'errored'],
      ['branch-spent', 'budget_exceeded'],
      ['branch-cut', 'aborted'],
    ] as const;
    for (const [id, status] of settled) {
      await harness.agent.harnessSpawnBranchHead(id, `settle as ${status}`, {
        status, summary: status === 'completed' ? 'the branch answer' : '',
      });
    }
    // Spawned with no report, then marked by the journal's own cold-activation
    // transition: the two statuses under which work can still continue.
    await harness.agent.harnessSpawnBranchHead('branch-stale', 'never reported', null);
    harness.agent.harnessMarkHeadsInterrupted();
    await harness.agent.harnessSpawnBranchHead('branch-live', 'still running', null);

    expect(harness.agent.harnessExplorationFacets().length).toBe(6);
    await harness.agent.harnessReclaimSettledExplorationFacets();

    // The four settled heads are gone whatever they settled AS; the interrupted
    // and the running one are held, and holding them is not a guess — a live
    // head is what makes the sweep refuse to reclaim an unledgered facet too.
    expect(harness.agent.harnessExplorationFacets()).toEqual([
      'branch-live-head', 'branch-stale-head',
    ]);
  });
});
