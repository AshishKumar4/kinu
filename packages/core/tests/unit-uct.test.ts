/** UCT selection and the ln correction (log(x)/log(exp(1.0))). */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { makeSql, makeExecRaw } from './helpers';
import { createTestActors, present } from '@kinu.run/test-utils';
import { selectNode } from '../src/mcts/uct';
import { initSearchTables } from '../src/mcts/schemas';

/** `search_nodes` is keyed `(actor_id, id)`, so seeds and selection must name the same actor. */
function setup() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  initSearchTables(execRaw);
  const actor = createTestActors(sql, execRaw).main;

  return { db, sql, actor };
}

describe('UCT selection', () => {
  test('returns null on empty tree', () => {
    const { sql, actor } = setup();
    expect(selectNode(sql, actor, 'r')).toBeNull();
  });

  test('selects the only open node', () => {
    const { sql, actor } = setup();
    void sql`INSERT INTO search_nodes (actor_id, root_id, id, task, value, visits, status)
        VALUES (${actor.actorId}, 'r', 'root', 'test', 0, 0, 'open')`;
    const node = present(selectNode(sql, actor, 'r'), 'the selected node');
    expect(node.id).toBe('root');
  });

  // A closed status is never selectable; among open nodes with matching visits, value decides.
  const twoNodeCases = [
    {
      name: 'never selects pruned nodes',
      nodes: [['pruned1', 0.99, 100, 'pruned'], ['open1', 0.1, 1, 'open']],
      selects: 'open1',
    },
    {
      name: 'never selects failed nodes',
      nodes: [['failed1', 0.99, 100, 'failed'], ['open1', 0.1, 1, 'open']],
      selects: 'open1',
    },
    {
      name: 'selects higher-value node when exploration bonus is equal',
      nodes: [['low', 0.3, 5, 'open'], ['high', 0.9, 5, 'open']],
      selects: 'high',
    },
  ] satisfies ReadonlyArray<{ name: string; nodes: [string, number, number, string][]; selects: string }>;

  for (const c of twoNodeCases) {
    test(c.name, () => {
      const { sql, actor } = setup();

      for (const [id, value, visits, status] of c.nodes) {
        void sql`INSERT INTO search_nodes (actor_id, root_id, id, task, value, visits, status)
            VALUES (${actor.actorId}, 'r', ${id}, 'test', ${value}, ${visits}, ${status})`;
      }

      expect(present(selectNode(sql, actor, 'r'), 'the selected node').id).toBe(c.selects);
    });
  }

  test('#5: root keeps a non-zero exploration term so it can re-widen across iterations', () => {
    const { sql, actor } = setup();
    // The synthetic root parent-visit keeps the root's exploration bonus positive, so it can be
    // re-selected to add breadth once its children are well-visited.
    void sql`INSERT INTO search_nodes (actor_id, root_id, id, parent_id, task, value, visits, status)
        VALUES (${actor.actorId}, 'r', 'root', NULL, 't', 0.5, 2, 'open')`;
    void sql`INSERT INTO search_nodes (actor_id, root_id, id, parent_id, task, value, visits, status)
        VALUES (${actor.actorId}, 'r', 'c1', 'root', 't', 0.5, 1, 'open')`;
    void sql`INSERT INTO search_nodes (actor_id, root_id, id, parent_id, task, value, visits, status)
        VALUES (${actor.actorId}, 'r', 'c2', 'root', 't', 0.5, 1, 'open')`;

    // Once children are well-visited the root becomes the UCT-max and the tree re-widens.
    void sql`UPDATE search_nodes SET visits = 50 WHERE actor_id = ${actor.actorId} AND id IN ('c1','c2')`;
    const reselect = present(selectNode(sql, actor, 'r'), 'the selected node');
    expect(reselect.id).toBe('root');
  });

  test('WP-A4: depth-capped nodes are skipped, not fatal — a shallower node is still selected', () => {
    const { sql, actor } = setup();
    void sql`INSERT INTO search_nodes (actor_id, root_id, id, task, value, visits, status, depth)
        VALUES (${actor.actorId}, 'r', 'deep', 'test', 0.99, 1, 'open', 3)`;
    void sql`INSERT INTO search_nodes (actor_id, root_id, id, task, value, visits, status, depth)
        VALUES (${actor.actorId}, 'r', 'shallow', 'test', 0.1, 1, 'open', 1)`;
    // Selection skips the node at the depth cap instead of aborting the search.
    const node = present(selectNode(sql, actor, 'r', { maxDepth: 3 }), 'the selected node');
    expect(node.id).toBe('shallow');
  });

  test('WP-A4: returns null only when every open node is at/beyond the cap', () => {
    const { sql, actor } = setup();
    void sql`INSERT INTO search_nodes (actor_id, root_id, id, task, value, visits, status, depth)
        VALUES (${actor.actorId}, 'r', 'capped', 'test', 0.9, 1, 'open', 5)`;
    expect(selectNode(sql, actor, 'r', { maxDepth: 5 })).toBeNull();
    expect(present(selectNode(sql, actor, 'r', { maxDepth: 6 }), 'the selected node').id).toBe('capped');
  });

  test('exploration bonus favors less-visited nodes', () => {
    const { sql, actor } = setup();
    void sql`INSERT INTO search_nodes (actor_id, root_id, id, parent_id, task, value, visits, status)
        VALUES (${actor.actorId}, 'r', 'root', NULL, 'test', 0.5, 100, 'open')`;
    void sql`INSERT INTO search_nodes (actor_id, root_id, id, parent_id, task, value, visits, status)
        VALUES (${actor.actorId}, 'r', 'visited', 'root', 'test', 0.6, 50, 'open')`;
    void sql`INSERT INTO search_nodes (actor_id, root_id, id, parent_id, task, value, visits, status)
        VALUES (${actor.actorId}, 'r', 'fresh', 'root', 'test', 0.5, 1, 'open')`;

    const node = present(selectNode(sql, actor, 'r'), 'the selected node');
    // UCT(fresh) ≈ 0.5 + √2·√(ln(100)/1) ≈ 3.53
    // UCT(visited) ≈ 0.6 + √2·√(ln(100)/50) ≈ 1.03
    expect(node.id).toBe('fresh');
  });
});

describe('UCT log base — observed through selectNode, not re-derived', () => {
  /**
   * Siblings under a heavily-visited parent where only the log base decides explore vs exploit:
   * ln(10000)=9.21 vs log₁₀(10000)=4 moves the crossover by more than 2×.
   */
  const W = Math.SQRT2;

  function selectAmongSiblings(exploreVisits: number): string {
    const { sql, actor } = setup();
    void sql`INSERT INTO search_nodes (actor_id, root_id, id, parent_id, task, value, visits, status)
        VALUES (${actor.actorId}, 'r', 'root', NULL, 't', 0.9, 10000, 'terminal')`;
    void sql`INSERT INTO search_nodes (actor_id, root_id, id, parent_id, task, value, visits, status, depth)
        VALUES (${actor.actorId}, 'r', 'exploit', 'root', 't', 0.9, 10000, 'open', 1)`;
    void sql`INSERT INTO search_nodes (actor_id, root_id, id, parent_id, task, value, visits, status, depth)
        VALUES (${actor.actorId}, 'r', 'explore', 'root', 't', 0.1, ${exploreVisits}, 'open', 1)`;

    return present(selectNode(sql, actor, 'r', { explorationWeight: W }), 'the selected node').id;
  }

  test('a 20-visit low-value sibling still out-explores the exploited node (log₁₀ would not)', () => {
    // ln:    UCT(explore) = 0.1 + √2·√(9.21/20) ≈ 1.06  >  UCT(exploit) ≈ 0.943
    // log₁₀: UCT(explore) = 0.1 + √2·√(4.00/20) ≈ 0.732 <  UCT(exploit) ≈ 0.928
    expect(selectAmongSiblings(20)).toBe('explore');
  });

  test('both sides of the crossover are stable — the boundary is not an artifact of one sample', () => {
    expect(selectAmongSiblings(25)).toBe('explore');
    expect(selectAmongSiblings(27)).toBe('exploit');
  });
});
