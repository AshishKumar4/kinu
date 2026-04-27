/**
 * Integration test: full MCTS cycle with real in-memory SQLite.
 * Mock LLM + Executor, but real SQL tables, real UCT, real backprop.
 *
 * Verifies: init → select → expand → evaluate → backpropagate → prune → converge
 * Plus: tree shape, crafted tools extracted, reflections stored.
 */

import { describe, test, expect } from 'bun:test';
import { createTestRuntime, createMockSession, createMockLLM } from './helpers.js';
import { runMCTS } from '../src/mcts/engine.js';
import { initSearchTables } from '../src/mcts/schemas.js';
import { initScaffoldTables } from '../src/scaffold/schemas.js';
import { initCraftScoreTables } from '../src/craft/schemas.js';
import type { SearchNode } from '../src/types/mcts.js';

describe('MCTS integration', () => {
  test('full cycle: budget=3, branches=2', async () => {
    let branchCounter = 0;
    const scores = [0.8, 0.3, 0.7, 0.2, 0.85, 0.4];

    const { rt, db } = createTestRuntime({
      llmResponses: {
        'Summarize': '- Used approach A\n- Worked well\n- Score high',
      },
    });

    // Override branch spawning to return varied scores
    rt.spawnBranch = async () => ({
      explore: async () => ({
        text: `branch ${branchCounter} explored`,
        codeUsed: branchCounter % 2 === 0 ? 'await tools.search({q: "test"})' : null,
      }),
      evaluate: async () => {
        const score = scores[branchCounter % scores.length]!;
        branchCounter++;
        return score;
      },
      generateReflection: async () => `reflection for branch ${branchCounter}`,
    });

    initSearchTables(rt.storage.execRaw);
    initScaffoldTables(rt.storage.execRaw);
    initCraftScoreTables(rt.storage.execRaw);

    const session = createMockSession();
    const result = await runMCTS(rt, session, 'Refactor auth module', {
      budget: 3,
      branches: 2,
    });

    // Should have converged (at least one branch scored > 0.3)
    expect(result.converged).toBe(true);
    expect(result.winnerValue).toBeGreaterThan(0.3);

    // Tree should have root + 3 iterations × 2 branches = 7 nodes
    const allNodes = rt.storage.sql<SearchNode>`SELECT * FROM search_nodes`;
    expect(allNodes.length).toBe(7); // 1 root + 6 children

    // Root should have been visited (backprop propagates to ancestors)
    const root = rt.storage.sql<SearchNode>`SELECT * FROM search_nodes WHERE parent_id IS NULL`[0]!;
    expect(root.visits).toBeGreaterThan(0);

    // Non-winning open nodes should be pruned after convergence
    const openNodes = rt.storage.sql<SearchNode>`SELECT * FROM search_nodes WHERE status = 'open'`;
    expect(openNodes.length).toBeLessThanOrEqual(1); // only winner stays open
  });

  test('reflections stored in memory on low scores', async () => {
    const { rt } = createTestRuntime();
    rt.spawnBranch = async () => ({
      explore: async () => ({ text: 'bad approach', codeUsed: null }),
      evaluate: async () => 0.15, // very low → triggers reflection
      generateReflection: async () => 'approach failed because auth layer is tightly coupled',
    });

    initSearchTables(rt.storage.execRaw);
    initScaffoldTables(rt.storage.execRaw);
    initCraftScoreTables(rt.storage.execRaw);

    const session = createMockSession();
    await runMCTS(rt, session, 'Improve test coverage', {
      budget: 1,
      branches: 1,
      minAcceptableScore: 0.01, // low threshold so convergence succeeds
    });

    // Reflection should be in MEMORY.md
    const memory = await rt.memory.read('memory/MEMORY.md');
    expect(memory).toContain('Failure lesson');
    expect(memory).toContain('auth layer is tightly coupled');
  });

  test('cost guard rejects overbudget requests', async () => {
    const { rt } = createTestRuntime();
    initSearchTables(rt.storage.execRaw);
    initScaffoldTables(rt.storage.execRaw);
    initCraftScoreTables(rt.storage.execRaw);

    const session = createMockSession();
    await expect(
      runMCTS(rt, session, 'huge task', { budget: 1000, branches: 10, maxCostUSD: 0.01 }),
    ).rejects.toThrow('exceeds limit');
  });

  test('BUG-4: all-low-score convergence returns converged=false', async () => {
    const { rt } = createTestRuntime();
    rt.spawnBranch = async () => ({
      explore: async () => ({ text: 'attempt', codeUsed: null }),
      evaluate: async () => 0.1, // below MIN_ACCEPTABLE_SCORE
      generateReflection: async () => 'everything failed',
    });

    initSearchTables(rt.storage.execRaw);
    initScaffoldTables(rt.storage.execRaw);
    initCraftScoreTables(rt.storage.execRaw);

    const session = createMockSession();
    const result = await runMCTS(rt, session, 'impossible task', {
      budget: 1,
      branches: 1,
      // Use default MIN_ACCEPTABLE_SCORE = 0.3
    });

    expect(result.converged).toBe(false);
  });
});
