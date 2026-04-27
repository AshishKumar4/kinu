/**
 * Unit tests: convergence + BUG-4 all-low-score handling.
 */

import { describe, test, expect } from 'bun:test';
import { createTestRuntime, createMockSession } from './helpers.js';
import { converge } from '../src/mcts/convergence.js';
import { initSearchTables } from '../src/mcts/schemas.js';

describe('Convergence', () => {
  test('throws when no nodes exist', async () => {
    const { rt } = createTestRuntime();
    initSearchTables(rt.storage.execRaw);
    const session = createMockSession();

    await expect(converge(rt, session)).rejects.toThrow('No viable nodes');
  });

  test('converges with high-scoring winner', async () => {
    const { rt } = createTestRuntime();
    initSearchTables(rt.storage.execRaw);
    const session = createMockSession();

    rt.storage.sql`INSERT INTO search_nodes (id, task, value, visits, status, observation)
        VALUES ('winner', 'test task', 0.85, 5, 'open', 'good result')`;
    rt.storage.sql`INSERT INTO search_nodes (id, task, value, visits, status)
        VALUES ('loser', 'test task', 0.3, 3, 'open')`;

    const result = await converge(rt, session);
    expect(result.converged).toBe(true);
    expect(result.winnerId).toBe('winner');
    expect(result.winnerValue).toBeCloseTo(0.85, 2);
  });

  test('BUG-4: returns converged=false when all scores below threshold', async () => {
    const { rt } = createTestRuntime();
    initSearchTables(rt.storage.execRaw);
    const session = createMockSession();

    // All nodes have value < MIN_ACCEPTABLE_SCORE (0.3)
    rt.storage.sql`INSERT INTO search_nodes (id, task, value, visits, status)
        VALUES ('low1', 'test', 0.15, 3, 'open')`;
    rt.storage.sql`INSERT INTO search_nodes (id, task, value, visits, status)
        VALUES ('low2', 'test', 0.1, 2, 'open')`;

    const result = await converge(rt, session);
    expect(result.converged).toBe(false);
    expect(result.trajectory).toHaveLength(0);
  });

  test('marks non-winning open nodes as pruned after convergence', async () => {
    const { rt } = createTestRuntime();
    initSearchTables(rt.storage.execRaw);
    const session = createMockSession();

    rt.storage.sql`INSERT INTO search_nodes (id, task, value, visits, status)
        VALUES ('best', 'test', 0.9, 10, 'open')`;
    rt.storage.sql`INSERT INTO search_nodes (id, task, value, visits, status)
        VALUES ('other', 'test', 0.5, 5, 'open')`;

    await converge(rt, session);

    const other = rt.storage.sql<{ status: string }>`SELECT status FROM search_nodes WHERE id = 'other'`[0]!;
    expect(other.status).toBe('pruned');
  });
});
