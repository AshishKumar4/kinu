/** Search-tree pruning (WP-A2) scans the full open population and honours `minVisitsForPrune`. */

import { describe, test, expect } from 'bun:test';
import { createTestRuntime } from './helpers';
import { pruneLowValueBranches } from '../src/mcts/pruning';
import { initSearchTables } from '../src/mcts/schemas';

function setup() {
  const { rt, db } = createTestRuntime();
  initSearchTables(rt.storage.execRaw);

  return { db, sql: rt.storage.sql, rt };
}

describe('pruneLowValueBranches — population + config-honoring gate', () => {
  test.each([
    { case: 'a settled low-value node reaches status=pruned mid-search', id: 'doomed', value: 0.1, visits: 3, status: 'pruned' },
    { case: 'a fresh single-visit node is protected by minVisitsForPrune', id: 'fresh', value: 0.05, visits: 1, status: 'open' },
  ])('$case', ({ id, value, visits, status }) => {
    const { sql, rt } = setup();
    void sql`INSERT INTO search_nodes (actor_id, root_id, id, task, value, visits, status)
        VALUES (${rt.actor.actorId}, 'r', ${id}, 't', ${value}, ${visits}, 'open')`;
    pruneLowValueBranches(rt, 'r', 0.25, 2);

    expect(sql<{ status: string }>`SELECT status FROM search_nodes WHERE id = ${id}`[0].status).toBe(status);
  });

  const ONE_NODE = [
    {
      name: 'honors the minVisitsForPrune argument (was hardcoded 2)',
      // config says one visit is enough
      id: 'n', value: 0.05, visits: 1, minVisits: 1, status: 'pruned',
    },
    {
      name: 'a healthy above-threshold node is never pruned, however many visits',
      id: 'good', value: 0.9, visits: 50, minVisits: 2, status: 'open',
    },
  ];

  for (const node of ONE_NODE) {
    test(node.name, () => {
      const { sql, rt } = setup();
      void sql`INSERT INTO search_nodes (actor_id, root_id, id, task, value, visits, status)
          VALUES (${rt.actor.actorId}, 'r', ${node.id}, 't', ${node.value}, ${node.visits}, 'open')`;
      pruneLowValueBranches(rt, 'r', 0.25, node.minVisits);

      expect(sql<{ status: string }>`SELECT status FROM search_nodes WHERE id = ${node.id}`[0].status)
        .toBe(node.status);
    });
  }

  test('never touches already-pruned or failed nodes', () => {
    const { sql, rt } = setup();
    void sql`INSERT INTO search_nodes (actor_id, root_id, id, task, value, visits, status)
        VALUES (${rt.actor.actorId}, 'r', 'already', 't', 0.01, 9, 'pruned')`;
    void sql`INSERT INTO search_nodes (actor_id, root_id, id, task, value, visits, status)
        VALUES (${rt.actor.actorId}, 'r', 'failed', 't', 0.01, 9, 'failed')`;
    pruneLowValueBranches(rt, 'r', 0.25, 2);
    expect(sql<{ status: string }>`SELECT status FROM search_nodes WHERE id = 'already'`[0].status).toBe('pruned');
    expect(sql<{ status: string }>`SELECT status FROM search_nodes WHERE id = 'failed'`[0].status).toBe('failed');
  });
});
