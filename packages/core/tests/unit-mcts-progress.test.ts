/**
 * A running MCTS search has to be VISIBLE while it runs.
 *
 * `runMCTS` takes an `onProgress` sink and every live caller supplies one:
 * the lifetime evolution cycle passes `config.onMctsProgress` straight into
 * the engine (evolution/engine.ts) and the hosted backend broadcasts from
 * there. These tests pin the engine-side property that makes those broadcasts
 * worth watching: events arrive WHILE the search runs, carrying a tree that
 * has already grown — not one that settles whole at the end. Phase ordering,
 * failure reporting and grounding notices are covered in integration-mcts.
 *
 * The fork substrate's own dispatch-time resolution of this sink died with
 * `defaultOptions`, whose last reader was the removed `fork` action; nothing
 * consumed it any more.
 */
import { describe, test, expect } from 'bun:test';
import { runMCTS } from '../src/mcts/engine';
import { initSearchTables } from '../src/mcts/schemas';
import { initScaffoldTables } from '../src/scaffold/schemas';
import type { MCTSProgressEvent } from '../src/types/mcts';
import type { AgentRuntime } from '../src/types/agent-runtime';
import { createTestRuntime, createMockSession } from './helpers';

describe('runMCTS reports progress while the search runs', () => {
  test('events arrive per iteration, and the tree has already grown when they do', async () => {
    const { rt } = createTestRuntime();
    rt.spawnBranch = async () => ({
      explore: async () => ({ text: 'a candidate approach' }),
      generateReflection: async () => ({ text: 'n/a' }),
    });
    initTables(rt);

    const events: MCTSProgressEvent[] = [];
    // Node count observed at the moment each 'iteration-complete' was reported
    // — proof the broadcast a surface receives carries a tree that is actually
    // advancing, not one that only settles at the end. Sampled at the END of
    // the iteration and not at 'evaluate', because a node is recorded with the
    // observation its evaluation produced: at 'evaluate' the environment has
    // not answered yet and the children do not exist (mcts/engine.ts).
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
    // The first completed iteration has banked the root plus its two branches.
    expect(nodesAtIteration[0]).toBeGreaterThanOrEqual(3);
    // And the tree keeps growing across iterations rather than arriving whole.
    expect(nodesAtIteration.at(-1)).toBeGreaterThan(nodesAtIteration[0] ?? 0);
  });

  test('a call with no sink runs identically — the option is optional', async () => {
    const { rt } = createTestRuntime();
    rt.spawnBranch = async () => ({
      explore: async () => ({ text: 'a candidate approach' }),
      generateReflection: async () => ({ text: 'n/a' }),
    });
    initTables(rt);

    const result = await runMCTS(rt, createMockSession(), 'pick an approach', {
      budget: 1,
      branches: 1,
    });
    // A sunk call reports convergence with a winner and a banked tree. The
    // unsunk call must reach that same outcome through the same engine path.
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
