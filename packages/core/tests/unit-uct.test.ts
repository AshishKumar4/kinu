/**
 * Unit tests: UCT selection + ln formula.
 * Verifies the critical log(x)/log(exp(1.0)) correction.
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { makeSql, makeExecRaw } from './helpers';
import { createTestActors } from '@kinu.run/test-utils';
import { selectNode } from '../src/mcts/uct';
import { initSearchTables } from '../src/mcts/schemas';

/** One search ledger and the actor that owns it. `search_nodes` is keyed
 *  `(actor_id, id)`, so the seeded rows and the selection have to name the
 *  same handle or the tree the selector walks is empty. */
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
    const node = selectNode(sql, actor, 'r');
    expect(node).not.toBeNull();
    expect(node!.id).toBe('root');
  });

  test('never selects pruned nodes', () => {
    const { sql, actor } = setup();
    void sql`INSERT INTO search_nodes (actor_id, root_id, id, task, value, visits, status)
        VALUES (${actor.actorId}, 'r', 'pruned1', 'test', 0.99, 100, 'pruned')`;
    void sql`INSERT INTO search_nodes (actor_id, root_id, id, task, value, visits, status)
        VALUES (${actor.actorId}, 'r', 'open1', 'test', 0.1, 1, 'open')`;
    const node = selectNode(sql, actor, 'r');
    expect(node!.id).toBe('open1');
  });

  test('never selects failed nodes', () => {
    const { sql, actor } = setup();
    void sql`INSERT INTO search_nodes (actor_id, root_id, id, task, value, visits, status)
        VALUES (${actor.actorId}, 'r', 'failed1', 'test', 0.99, 100, 'failed')`;
    void sql`INSERT INTO search_nodes (actor_id, root_id, id, task, value, visits, status)
        VALUES (${actor.actorId}, 'r', 'open1', 'test', 0.1, 1, 'open')`;
    const node = selectNode(sql, actor, 'r');
    expect(node!.id).toBe('open1');
  });

  // Platform contract, NOT a UCT test: SQLite's log() is log₁₀, which is the
  // whole reason uct.ts divides by log(exp(1.0)). selectNode's own use of ln is
  // covered behaviourally below.
  test('SQLite log() is log₁₀, so log(x)/log(exp(1.0)) is the ln conversion', () => {
    const { db } = setup();
    const result = db.query<{ ln10: number }, []>(
      'SELECT log(10.0) / log(exp(1.0)) as ln10',
    ).get();
    if (!result) throw new Error('SQLite logarithm query returned no row');
    expect(Math.abs(result.ln10 - 2.302585)).toBeLessThan(0.001);
  });

  test('selects higher-value node when exploration bonus is equal', () => {
    const { sql, actor } = setup();
    // Two nodes with same visits (so same exploration bonus)
    void sql`INSERT INTO search_nodes (actor_id, root_id, id, task, value, visits, status)
        VALUES (${actor.actorId}, 'r', 'low', 'test', 0.3, 5, 'open')`;
    void sql`INSERT INTO search_nodes (actor_id, root_id, id, task, value, visits, status)
        VALUES (${actor.actorId}, 'r', 'high', 'test', 0.9, 5, 'open')`;
    const node = selectNode(sql, actor, 'r');
    expect(node!.id).toBe('high');
  });

  test('#5: root keeps a non-zero exploration term so it can re-widen across iterations', () => {
    const { sql, actor } = setup();
    // After iteration 1: root visited, children already expanded. Under the old
    // ln(N(parent))=ln(1)=0 the root's UCT collapsed to its value and it could
    // never be re-selected to add MORE breadth (frozen at N=branches). With the
    // synthetic root parent-visit it retains a strictly-positive exploration
    // bonus and becomes selectable once its children are well-visited.
    void sql`INSERT INTO search_nodes (actor_id, root_id, id, parent_id, task, value, visits, status)
        VALUES (${actor.actorId}, 'r', 'root', NULL, 't', 0.5, 2, 'open')`;
    void sql`INSERT INTO search_nodes (actor_id, root_id, id, parent_id, task, value, visits, status)
        VALUES (${actor.actorId}, 'r', 'c1', 'root', 't', 0.5, 1, 'open')`;
    void sql`INSERT INTO search_nodes (actor_id, root_id, id, parent_id, task, value, visits, status)
        VALUES (${actor.actorId}, 'r', 'c2', 'root', 't', 0.5, 1, 'open')`;

    // Fresh children deepen first, but once they are well-visited the root's
    // surviving exploration term makes it the UCT-max → the tree re-widens.
    void sql`UPDATE search_nodes SET visits = 50 WHERE actor_id = ${actor.actorId} AND id IN ('c1','c2')`;
    const reselect = selectNode(sql, actor, 'r')!;
    expect(reselect.id).toBe('root');
  });

  test('WP-A4: depth-capped nodes are skipped, not fatal — a shallower node is still selected', () => {
    const { sql, actor } = setup();
    // The UCT-max node sits AT the depth cap; a lower-scoring node sits below it.
    void sql`INSERT INTO search_nodes (actor_id, root_id, id, task, value, visits, status, depth)
        VALUES (${actor.actorId}, 'r', 'deep', 'test', 0.99, 1, 'open', 3)`;
    void sql`INSERT INTO search_nodes (actor_id, root_id, id, task, value, visits, status, depth)
        VALUES (${actor.actorId}, 'r', 'shallow', 'test', 0.1, 1, 'open', 1)`;
    // Old behavior aborted the whole search on the deep argmax. Now selection
    // skips it and returns the shallower node so the budget keeps flowing.
    const node = selectNode(sql, actor, 'r', undefined, 3);
    expect(node!.id).toBe('shallow');
  });

  test('WP-A4: returns null only when every open node is at/beyond the cap', () => {
    const { sql, actor } = setup();
    void sql`INSERT INTO search_nodes (actor_id, root_id, id, task, value, visits, status, depth)
        VALUES (${actor.actorId}, 'r', 'capped', 'test', 0.9, 1, 'open', 5)`;
    expect(selectNode(sql, actor, 'r', undefined, 5)).toBeNull();
    expect(selectNode(sql, actor, 'r', undefined, 6)!.id).toBe('capped');
  });

  test('exploration bonus favors less-visited nodes', () => {
    const { sql, actor } = setup();
    // Root with many visits
    void sql`INSERT INTO search_nodes (actor_id, root_id, id, parent_id, task, value, visits, status)
        VALUES (${actor.actorId}, 'r', 'root', NULL, 'test', 0.5, 100, 'open')`;
    // Well-visited child
    void sql`INSERT INTO search_nodes (actor_id, root_id, id, parent_id, task, value, visits, status)
        VALUES (${actor.actorId}, 'r', 'visited', 'root', 'test', 0.6, 50, 'open')`;
    // Barely-visited child (should get higher exploration bonus)
    void sql`INSERT INTO search_nodes (actor_id, root_id, id, parent_id, task, value, visits, status)
        VALUES (${actor.actorId}, 'r', 'fresh', 'root', 'test', 0.5, 1, 'open')`;

    const node = selectNode(sql, actor, 'r');
    // fresh should be selected: it has visits=1 so exploration bonus is high
    // UCT(fresh) = 0.5 + √2 * √(ln(100)/1) ≈ 0.5 + 1.414 * √4.605 ≈ 0.5 + 3.03 = 3.53
    // UCT(visited) = 0.6 + √2 * √(ln(100)/50) ≈ 0.6 + 1.414 * √0.092 ≈ 0.6 + 0.43 = 1.03
    expect(node!.id).toBe('fresh');
  });
});

describe('UCT log base — observed through selectNode, not re-derived', () => {
  /**
   * Two siblings under a heavily-visited parent, tuned so the explore/exploit
   * ordering is decided purely by the base of the log in the exploration term:
   *
   *   exploit: value 0.9, visits 10000 → bonus ≈ 0, UCT ≈ 0.94 either way
   *   explore: value 0.1, visits N     → bonus = W·√(log(10000)/N)
   *
   * ln(10000)=9.21 vs log₁₀(10000)=4 — a 2.3× numerator gap that moves the
   * crossover by more than 2×, so a band of N separates the two formulas.
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
    return selectNode(sql, actor, 'r', W)!.id;
  }

  test('a 20-visit low-value sibling still out-explores the exploited node (log₁₀ would not)', () => {
    // ln:    UCT(explore) = 0.1 + √2·√(9.21/20) ≈ 1.06  >  UCT(exploit) ≈ 0.943
    // log₁₀: UCT(explore) = 0.1 + √2·√(4.00/20) ≈ 0.732 <  UCT(exploit) ≈ 0.928
    expect(selectAmongSiblings(20)).toBe('explore');
  });

  test('the explore→exploit crossover sits where ln puts it (~26 visits), not where log₁₀ would (~12)', () => {
    // Scanning the public entry point for its actual decision boundary. Under
    // log₁₀ the whole 12..25 band flips to 'exploit'.
    let crossover = 0;
    for (let visits = 1; visits <= 200; visits++) {
      if (selectAmongSiblings(visits) === 'exploit') { crossover = visits; break; }
    }
    expect(crossover).toBe(26);
  });

  test('both sides of the crossover are stable — the boundary is not an artifact of one sample', () => {
    expect(selectAmongSiblings(25)).toBe('explore');
    expect(selectAmongSiblings(27)).toBe('exploit');
  });
});
