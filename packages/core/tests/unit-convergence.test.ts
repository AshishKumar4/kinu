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
    initSearchTables(rt.storage.execRaw, rt.storage.sql);
    const session = createMockSession();

    await expect(converge(rt, session, 'r')).rejects.toThrow('No viable nodes');
  });

  test('converges with high-scoring winner', async () => {
    const { rt } = createTestRuntime();
    initSearchTables(rt.storage.execRaw, rt.storage.sql);
    const session = createMockSession();

    void rt.storage.sql`INSERT INTO search_nodes (root_id, id, task, value, visits, status, observation)
        VALUES ('r', 'winner', 'test task', 0.85, 5, 'open', 'good result')`;
    void rt.storage.sql`INSERT INTO search_nodes (root_id, id, task, value, visits, status)
        VALUES ('r', 'loser', 'test task', 0.3, 3, 'open')`;

    const result = await converge(rt, session, 'r');
    expect(result.converged).toBe(true);
    expect(result.winnerId).toBe('winner');
    expect(result.winnerValue).toBeCloseTo(0.85, 2);
  });

  test('BUG-4: returns converged=false when all scores below threshold', async () => {
    const { rt } = createTestRuntime();
    initSearchTables(rt.storage.execRaw, rt.storage.sql);
    const session = createMockSession();

    // All nodes have value < MIN_ACCEPTABLE_SCORE (0.3)
    void rt.storage.sql`INSERT INTO search_nodes (root_id, id, task, value, visits, status)
        VALUES ('r', 'low1', 'test', 0.15, 3, 'open')`;
    void rt.storage.sql`INSERT INTO search_nodes (root_id, id, task, value, visits, status)
        VALUES ('r', 'low2', 'test', 0.1, 2, 'open')`;

    const result = await converge(rt, session, 'r');
    expect(result.converged).toBe(false);
    expect(result.trajectory).toHaveLength(0);

    // Failed search closes its open nodes so the next task starts fresh.
    const statuses = rt.storage.sql<{ id: string; status: string }>`
        SELECT id, status FROM search_nodes ORDER BY id`;
    expect(statuses.map((r) => r.status)).toEqual(['failed', 'failed']);
  });

  // With no value signal every node carries the same number, so `ORDER BY value
  // DESC` degenerates to row order: the "winner" is whichever row came back
  // first, and it used to be handed over as a converged answer because the
  // shared value cleared minAcceptableScore.
  test('two DISTINCT approaches scoring identically is not a convergence', async () => {
    const { rt } = createTestRuntime();
    initSearchTables(rt.storage.execRaw, rt.storage.sql);
    initAlternateTakesTable(rt.storage.execRaw, rt.storage.sql);
    const session = createMockSession();

    void rt.storage.sql`INSERT INTO search_nodes (root_id, id, parent_id, task, value, visits, status, depth, observation)
        VALUES ('r', 'r', ${null}, 'test task', 0.6, 2, 'open', 0, 'test task')`;
    void rt.storage.sql`INSERT INTO search_nodes (root_id, id, parent_id, task, value, visits, status, depth, observation)
        VALUES ('r', 'a', 'r', 'test task', 0.6, 1, 'open', 1, 'approach A')`;
    void rt.storage.sql`INSERT INTO search_nodes (root_id, id, parent_id, task, value, visits, status, depth, observation)
        VALUES ('r', 'b', 'r', 'test task', 0.6, 1, 'open', 1, 'approach B')`;

    const result = await converge(rt, session, 'r', 0.3, 0.1, 'plan');
    // 0.6 clears minAcceptableScore — the old code shipped it as a winner.
    expect(result.winnerValue).toBeCloseTo(0.6, 10);
    expect(result.converged).toBe(false);
    expect(result.trajectory).toHaveLength(0);
  });

  // The guard must not fire on a real result. A genuine ordering — even a very
  // close one — is what the search is FOR, and the near-tie itself is what the
  // alternate-takes ledger records rather than a reason to refuse.
  test('a near-tie that is not an exact tie still converges', async () => {
    const { rt } = createTestRuntime();
    initSearchTables(rt.storage.execRaw, rt.storage.sql);
    initAlternateTakesTable(rt.storage.execRaw, rt.storage.sql);
    const session = createMockSession();

    void rt.storage.sql`INSERT INTO search_nodes (root_id, id, parent_id, task, value, visits, status, depth, observation)
        VALUES ('r', 'r', ${null}, 'test task', 0.6, 2, 'open', 0, 'test task')`;
    void rt.storage.sql`INSERT INTO search_nodes (root_id, id, parent_id, task, value, visits, status, depth, observation)
        VALUES ('r', 'a', 'r', 'test task', 0.61, 1, 'open', 1, 'approach A')`;
    void rt.storage.sql`INSERT INTO search_nodes (root_id, id, parent_id, task, value, visits, status, depth, observation)
        VALUES ('r', 'b', 'r', 'test task', 0.60, 1, 'open', 1, 'approach B')`;

    const result = await converge(rt, session, 'r', 0.3, 0.1, 'plan');
    expect(result.converged).toBe(true);
    expect(result.winnerId).toBe('a');
  });

  test('marks the winner terminal and other open nodes pruned after convergence', async () => {
    const { rt } = createTestRuntime();
    initSearchTables(rt.storage.execRaw, rt.storage.sql);
    const session = createMockSession();

    void rt.storage.sql`INSERT INTO search_nodes (root_id, id, task, value, visits, status)
        VALUES ('r', 'best', 'test', 0.9, 10, 'open')`;
    void rt.storage.sql`INSERT INTO search_nodes (root_id, id, task, value, visits, status)
        VALUES ('r', 'other', 'test', 0.5, 5, 'open')`;

    await converge(rt, session, 'r');

    const best = rt.storage.sql<{ status: string }>`SELECT status FROM search_nodes WHERE id = 'best'`[0]!;
    const other = rt.storage.sql<{ status: string }>`SELECT status FROM search_nodes WHERE id = 'other'`[0]!;
    expect(best.status).toBe('terminal');
    expect(other.status).toBe('pruned');
  });

  test('captures near-tied rivals as Alternate Takes before pruning them', async () => {
    const { rt } = createTestRuntime();
    initSearchTables(rt.storage.execRaw, rt.storage.sql);
    initAlternateTakesTable(rt.storage.execRaw, rt.storage.sql);
    const session = createMockSession();

    void rt.storage.sql`INSERT INTO search_nodes (root_id, id, task, value, visits, depth, status, observation)
        VALUES ('r', 'best', 'test', 0.9, 10, 1, 'open', 'winning plan')`;
    void rt.storage.sql`INSERT INTO search_nodes (root_id, id, task, value, visits, depth, status, observation)
        VALUES ('r', 'rival', 'test', 0.85, 6, 1, 'open', 'near-tied plan')`;
    void rt.storage.sql`INSERT INTO search_nodes (root_id, id, task, value, visits, depth, status, observation)
        VALUES ('r', 'weak', 'test', 0.4, 2, 1, 'open', 'weak plan')`;

    await converge(rt, session, 'r');

    // The set snapshots the choice the close erased: the rival is now pruned…
    const rival = rt.storage.sql<{ status: string }>`SELECT status FROM search_nodes WHERE id = 'rival'`[0]!;
    expect(rival.status).toBe('pruned');
    // …but lives on as a comparable take next to the winner.
    const set = latestAlternateTakeSet(rt.storage.sql);
    if (!set) throw new Error('expected alternate-takes set');
    expect(set.winnerNodeId).toBe('best');
    expect(set.candidates.map((c) => c.nodeId)).toEqual(['best', 'rival']);
  });

  test('DO-NOW #3: a near-tied candidate that PASSES the discriminating test wins over the marginally-higher-value argmax that FAILS it', async () => {
    const { rt } = createTestRuntime({
      // generateAssertionSuite asks for a verification harness — return a js block
      // so the discriminating test actually runs.
      llmResponses: { 'verification harness': '```js\ncheck();\n```' },
    });
    initSearchTables(rt.storage.execRaw, rt.storage.sql);
    initAlternateTakesTable(rt.storage.execRaw, rt.storage.sql);
    const session = createMockSession();

    // Marker executor: code containing FAIL_MARKER fails, everything else passes.
    rt.executor = {
      languages: ['javascript'],
      async execute(code: string) {
        return String(code).includes('FAIL_MARKER')
          ? { result: undefined, error: 'discriminating test failed' }
          : { result: true };
      },
    };

    // argmax winner: marginally higher value but its code FAILS the test.
    void rt.storage.sql`INSERT INTO search_nodes (root_id, id, task, value, visits, depth, status, observation, code_used, code_language)
        VALUES ('r', 'argmax', 'test', 0.85, 6, 1, 'open', 'plan A', 'const x = FAIL_MARKER;', 'javascript')`;
    // near-tied rival (within takesEpsilon=0.1): lower value but its code PASSES.
    void rt.storage.sql`INSERT INTO search_nodes (root_id, id, task, value, visits, depth, status, observation, code_used, code_language)
        VALUES ('r', 'passer', 'test', 0.80, 5, 1, 'open', 'plan B', 'const ok = 1;', 'javascript')`;

    const result = await converge(rt, session, 'r');

    // The test-passer wins regardless of the marginal value gap.
    expect(result.winnerId).toBe('passer');
    const passer = rt.storage.sql<{ status: string }>`SELECT status FROM search_nodes WHERE id = 'passer'`[0]!;
    const argmax = rt.storage.sql<{ status: string }>`SELECT status FROM search_nodes WHERE id = 'argmax'`[0]!;
    expect(passer.status).toBe('terminal');
    expect(argmax.status).toBe('pruned');
  });

  test('DO-NOW #3: argmax winner is kept when it ALSO passes the discriminating test (no needless churn)', async () => {
    const { rt } = createTestRuntime({
      llmResponses: { 'verification harness': '```js\ncheck();\n```' },
    });
    initSearchTables(rt.storage.execRaw, rt.storage.sql);
    initAlternateTakesTable(rt.storage.execRaw, rt.storage.sql);
    const session = createMockSession();
    rt.executor = {
      languages: ['javascript'],
      async execute(code: string) {
        return String(code).includes('FAIL_MARKER')
          ? { result: undefined, error: 'failed' }
          : { result: true };
      },
    };

    // Both pass; argmax has higher value → it stays the winner.
    void rt.storage.sql`INSERT INTO search_nodes (root_id, id, task, value, visits, depth, status, observation, code_used, code_language)
        VALUES ('r', 'argmax', 'test', 0.85, 6, 1, 'open', 'plan A', 'const a = 1;', 'javascript')`;
    void rt.storage.sql`INSERT INTO search_nodes (root_id, id, task, value, visits, depth, status, observation, code_used, code_language)
        VALUES ('r', 'passer', 'test', 0.80, 5, 1, 'open', 'plan B', 'const b = 2;', 'javascript')`;

    const result = await converge(rt, session, 'r');
    expect(result.winnerId).toBe('argmax');
  });

  test('a clear winner converges without leaving a take set', async () => {
    const { rt } = createTestRuntime();
    initSearchTables(rt.storage.execRaw, rt.storage.sql);
    initAlternateTakesTable(rt.storage.execRaw, rt.storage.sql);
    const session = createMockSession();

    void rt.storage.sql`INSERT INTO search_nodes (root_id, id, task, value, visits, depth, status, observation)
        VALUES ('r', 'best', 'test', 0.9, 10, 1, 'open', 'winning plan')`;
    void rt.storage.sql`INSERT INTO search_nodes (root_id, id, task, value, visits, depth, status, observation)
        VALUES ('r', 'weak', 'test', 0.4, 2, 1, 'open', 'weak plan')`;

    await converge(rt, session, 'r');
    expect(listAlternateTakeSets(rt.storage.sql)).toHaveLength(0);
  });

  test('records the task outcome into task_history when the table exists', async () => {
    const { rt } = createTestRuntime();
    initSearchTables(rt.storage.execRaw, rt.storage.sql);
    initScaffoldTables(rt.storage.execRaw, rt.storage.sql);   // creates task_history
    const session = createMockSession();

    void rt.storage.sql`INSERT INTO search_nodes (root_id, id, task, value, visits, status)
        VALUES ('r', 'w', 'ship the feature', 0.8, 4, 'open')`;
    await converge(rt, session, 'r');

    const rows = rt.storage.sql<{ task: string; outcome: string; score: number }>`
        SELECT task, outcome, score FROM task_history`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ task: 'ship the feature', outcome: 'success', score: 0.8 });
  });
});
