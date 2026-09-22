/**
 * A running MCTS search is visible while it runs: `onProgress` events carry a tree that has
 * already grown, not one that settles whole at the end. Phase ordering, failure reporting
 * and grounding notices are covered in integration-mcts.
 */
import { describe, test, expect } from 'bun:test';
import { runMCTS } from '../src/mcts/engine';
import { initSearchTables } from '../src/mcts/schemas';
import { initScaffoldTables } from '../src/scaffold/schemas';
import type { MCTSProgressEvent } from '../src/types/mcts';
import type { AgentRuntime } from '../src/types/agent-runtime';
import { createTestRuntime, createMockSession } from './helpers';

/** Answers one candidate and reflects on nothing; only the search's shape is read. */
function oneCandidateBranch(): AgentRuntime['spawnBranch'] {
  return async () => ({
    explore: async () => ({ text: 'a candidate approach' }),
    generateReflection: async () => ({ text: 'n/a' }),
    release: async () => {},
  });
}

describe('runMCTS reports progress while the search runs', () => {
  test('events arrive per iteration, and the tree has already grown when they do', async () => {
    const { rt } = createTestRuntime();
    rt.spawnBranch = oneCandidateBranch();
    initTables(rt);

    const events: MCTSProgressEvent[] = [];
    // Node count at each 'iteration-complete', not at 'evaluate': a node is recorded with its
    // evaluation's observation, so at 'evaluate' the children do not exist yet.
    const nodesAtIteration: number[] = [];

    await runMCTS(rt, createMockSession(), 'pick an approach', {
      budget: 2,
      branches: 2,
      onProgress: (event) => {
        events.push(event);

        if (event.type === 'iteration-complete') {
          nodesAtIteration.push(
            rt.storage.sql<{ n: number }>`SELECT COUNT(*) AS n FROM search_nodes`[0]?.n ?? 0,
          );
        }
      },
    });

    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === 'phase' && e.phase === 'explore')).toBe(true);
    expect(events.some((e) => e.type === 'iteration-complete')).toBe(true);
    expect(nodesAtIteration[0]).toBeGreaterThanOrEqual(3);
    expect(nodesAtIteration.at(-1)).toBeGreaterThan(nodesAtIteration[0] ?? 0);
  });

  test('a call with no sink runs identically — the option is optional', async () => {
    const { rt } = createTestRuntime();
    rt.spawnBranch = oneCandidateBranch();
    initTables(rt);

    const result = await runMCTS(rt, createMockSession(), 'pick an approach', {
      budget: 1,
      branches: 1,
    });

    // The unsunk call must reach the sunk call's outcome through the same engine path.
    expect(result.converged).toBe(true);
    expect(result.winnerId).not.toBeNull();
    expect(rt.storage.sql<{ n: number }>`SELECT COUNT(*) AS n FROM search_nodes`[0]?.n ?? 0)
      .toBeGreaterThanOrEqual(2);
  });
});

function initTables(rt: AgentRuntime) {
  initSearchTables(rt.storage.execRaw);
  initScaffoldTables(rt.storage.execRaw);
}
