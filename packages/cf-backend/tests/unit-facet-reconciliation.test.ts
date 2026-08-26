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
