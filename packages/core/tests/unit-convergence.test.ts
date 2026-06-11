/**
 * Unit tests: convergence + BUG-4 all-low-score handling.
 */

import { describe, test, expect } from 'bun:test';
import { createTestRuntime, createMockSession } from './helpers.js';
import { converge } from '../src/mcts/convergence.js';
import { initSearchTables } from '../src/mcts/schemas.js';
import { initScaffoldTables } from '../src/scaffold/schemas.js';
import { initAlternateTakesTable, latestAlternateTakeSet, listAlternateTakeSets } from '../src/mcts/takes.js';

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

    // Failed search closes its open nodes so the next task starts fresh.
    const statuses = rt.storage.sql<{ id: string; status: string }>`
        SELECT id, status FROM search_nodes ORDER BY id`;
    expect(statuses.map((r) => r.status)).toEqual(['failed', 'failed']);
  });

  test('marks the winner terminal and other open nodes pruned after convergence', async () => {
    const { rt } = createTestRuntime();
    initSearchTables(rt.storage.execRaw);
    const session = createMockSession();

    rt.storage.sql`INSERT INTO search_nodes (id, task, value, visits, status)
        VALUES ('best', 'test', 0.9, 10, 'open')`;
    rt.storage.sql`INSERT INTO search_nodes (id, task, value, visits, status)
        VALUES ('other', 'test', 0.5, 5, 'open')`;

    await converge(rt, session);

    const best = rt.storage.sql<{ status: string }>`SELECT status FROM search_nodes WHERE id = 'best'`[0]!;
    const other = rt.storage.sql<{ status: string }>`SELECT status FROM search_nodes WHERE id = 'other'`[0]!;
    expect(best.status).toBe('terminal');
    expect(other.status).toBe('pruned');
  });

  test('captures near-tied rivals as Alternate Takes before pruning them', async () => {
    const { rt } = createTestRuntime();
    initSearchTables(rt.storage.execRaw);
    initAlternateTakesTable(rt.storage.execRaw);
    const session = createMockSession();

    rt.storage.sql`INSERT INTO search_nodes (id, task, value, visits, depth, status, observation)
        VALUES ('best', 'test', 0.9, 10, 1, 'open', 'winning plan')`;
    rt.storage.sql`INSERT INTO search_nodes (id, task, value, visits, depth, status, observation)
        VALUES ('rival', 'test', 0.85, 6, 1, 'open', 'near-tied plan')`;
    rt.storage.sql`INSERT INTO search_nodes (id, task, value, visits, depth, status, observation)
        VALUES ('weak', 'test', 0.4, 2, 1, 'open', 'weak plan')`;

    await converge(rt, session);

    // The set snapshots the choice the close erased: the rival is now pruned…
    const rival = rt.storage.sql<{ status: string }>`SELECT status FROM search_nodes WHERE id = 'rival'`[0]!;
    expect(rival.status).toBe('pruned');
    // …but lives on as a comparable take next to the winner.
    const set = latestAlternateTakeSet(rt.storage.sql)!;
    expect(set.winnerNodeId).toBe('best');
    expect(set.candidates.map((c) => c.nodeId)).toEqual(['best', 'rival']);
  });

  test('a clear winner converges without leaving a take set', async () => {
    const { rt } = createTestRuntime();
    initSearchTables(rt.storage.execRaw);
    initAlternateTakesTable(rt.storage.execRaw);
    const session = createMockSession();

    rt.storage.sql`INSERT INTO search_nodes (id, task, value, visits, depth, status, observation)
        VALUES ('best', 'test', 0.9, 10, 1, 'open', 'winning plan')`;
    rt.storage.sql`INSERT INTO search_nodes (id, task, value, visits, depth, status, observation)
        VALUES ('weak', 'test', 0.4, 2, 1, 'open', 'weak plan')`;

    await converge(rt, session);
    expect(listAlternateTakeSets(rt.storage.sql)).toHaveLength(0);
  });

  test('records the task outcome into task_history when the table exists', async () => {
    const { rt } = createTestRuntime();
    initSearchTables(rt.storage.execRaw);
    initScaffoldTables(rt.storage.execRaw);   // creates task_history
    const session = createMockSession();

    rt.storage.sql`INSERT INTO search_nodes (id, task, value, visits, status)
        VALUES ('w', 'ship the feature', 0.8, 4, 'open')`;
    await converge(rt, session);

    const rows = rt.storage.sql<{ task: string; outcome: string; score: number }>`
        SELECT task, outcome, score FROM task_history`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ task: 'ship the feature', outcome: 'success', score: 0.8 });
  });
});
