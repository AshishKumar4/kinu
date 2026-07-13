/**
 * Unit tests: UCT selection + ln formula.
 * Verifies the critical log(x)/log(exp(1.0)) correction.
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { makeSql, makeExecRaw } from './helpers.js';
import { selectNode } from '../src/mcts/uct.js';
import { initSearchTables } from '../src/mcts/schemas.js';

function setup() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  initSearchTables(execRaw);
  return { db, sql };
}

describe('UCT selection', () => {
  test('returns null on empty tree', () => {
    const { sql } = setup();
    expect(selectNode(sql)).toBeNull();
  });

  test('selects the only open node', () => {
    const { sql } = setup();
    sql`INSERT INTO search_nodes (id, task, value, visits, status)
        VALUES ('root', 'test', 0, 0, 'open')`;
    const node = selectNode(sql);
    expect(node).not.toBeNull();
    expect(node!.id).toBe('root');
  });

  test('never selects pruned nodes', () => {
    const { sql } = setup();
    sql`INSERT INTO search_nodes (id, task, value, visits, status)
        VALUES ('pruned1', 'test', 0.99, 100, 'pruned')`;
    sql`INSERT INTO search_nodes (id, task, value, visits, status)
        VALUES ('open1', 'test', 0.1, 1, 'open')`;
    const node = selectNode(sql);
    expect(node!.id).toBe('open1');
  });

  test('never selects failed nodes', () => {
    const { sql } = setup();
    sql`INSERT INTO search_nodes (id, task, value, visits, status)
        VALUES ('failed1', 'test', 0.99, 100, 'failed')`;
    sql`INSERT INTO search_nodes (id, task, value, visits, status)
        VALUES ('open1', 'test', 0.1, 1, 'open')`;
    const node = selectNode(sql);
    expect(node!.id).toBe('open1');
  });

  test('UCT uses natural log (ln), not log10', () => {
    const { db } = setup();
    // ln(10) ≈ 2.302, log10(10) = 1.0
    // If UCT used log10, the exploration bonus would be ~2.3x smaller
    const result = db.query('SELECT log(10.0) / log(exp(1.0)) as ln10').get() as { ln10: number };
    expect(Math.abs(result.ln10 - 2.302585)).toBeLessThan(0.001);
  });

  test('selects higher-value node when exploration bonus is equal', () => {
    const { sql } = setup();
    // Two nodes with same visits (so same exploration bonus)
    sql`INSERT INTO search_nodes (id, task, value, visits, status)
        VALUES ('low', 'test', 0.3, 5, 'open')`;
    sql`INSERT INTO search_nodes (id, task, value, visits, status)
        VALUES ('high', 'test', 0.9, 5, 'open')`;
    const node = selectNode(sql);
    expect(node!.id).toBe('high');
  });

  test('#5: root keeps a non-zero exploration term so it can re-widen across iterations', () => {
    const { sql } = setup();
    // After iteration 1: root visited, children already expanded. Under the old
    // ln(N(parent))=ln(1)=0 the root's UCT collapsed to its value and it could
    // never be re-selected to add MORE breadth (frozen at N=branches). With the
    // synthetic root parent-visit it retains a strictly-positive exploration
    // bonus and becomes selectable once its children are well-visited.
    sql`INSERT INTO search_nodes (id, parent_id, task, value, visits, status)
        VALUES ('root', NULL, 't', 0.5, 2, 'open')`;
    sql`INSERT INTO search_nodes (id, parent_id, task, value, visits, status)
        VALUES ('c1', 'root', 't', 0.5, 1, 'open')`;
    sql`INSERT INTO search_nodes (id, parent_id, task, value, visits, status)
        VALUES ('c2', 'root', 't', 0.5, 1, 'open')`;

    // Fresh children deepen first, but once they are well-visited the root's
    // surviving exploration term makes it the UCT-max → the tree re-widens.
    sql`UPDATE search_nodes SET visits = 50 WHERE id IN ('c1','c2')`;
    const reselect = selectNode(sql)!;
    expect(reselect.id).toBe('root');
  });

  test('WP-A4: depth-capped nodes are skipped, not fatal — a shallower node is still selected', () => {
    const { sql } = setup();
    // The UCT-max node sits AT the depth cap; a lower-scoring node sits below it.
    sql`INSERT INTO search_nodes (id, task, value, visits, status, depth)
        VALUES ('deep', 'test', 0.99, 1, 'open', 3)`;
    sql`INSERT INTO search_nodes (id, task, value, visits, status, depth)
        VALUES ('shallow', 'test', 0.1, 1, 'open', 1)`;
    // Old behavior aborted the whole search on the deep argmax. Now selection
    // skips it and returns the shallower node so the budget keeps flowing.
    const node = selectNode(sql, undefined, 3);
    expect(node!.id).toBe('shallow');
  });

  test('WP-A4: returns null only when every open node is at/beyond the cap', () => {
    const { sql } = setup();
    sql`INSERT INTO search_nodes (id, task, value, visits, status, depth)
        VALUES ('capped', 'test', 0.9, 1, 'open', 5)`;
    expect(selectNode(sql, undefined, 5)).toBeNull();
    expect(selectNode(sql, undefined, 6)!.id).toBe('capped');
  });

  test('exploration bonus favors less-visited nodes', () => {
    const { sql } = setup();
    // Root with many visits
    sql`INSERT INTO search_nodes (id, parent_id, task, value, visits, status)
        VALUES ('root', NULL, 'test', 0.5, 100, 'open')`;
    // Well-visited child
    sql`INSERT INTO search_nodes (id, parent_id, task, value, visits, status)
        VALUES ('visited', 'root', 'test', 0.6, 50, 'open')`;
    // Barely-visited child (should get higher exploration bonus)
    sql`INSERT INTO search_nodes (id, parent_id, task, value, visits, status)
        VALUES ('fresh', 'root', 'test', 0.5, 1, 'open')`;

    const node = selectNode(sql);
    // fresh should be selected: it has visits=1 so exploration bonus is high
    // UCT(fresh) = 0.5 + √2 * √(ln(100)/1) ≈ 0.5 + 1.414 * √4.605 ≈ 0.5 + 3.03 = 3.53
    // UCT(visited) = 0.6 + √2 * √(ln(100)/50) ≈ 0.6 + 1.414 * √0.092 ≈ 0.6 + 0.43 = 1.03
    expect(node!.id).toBe('fresh');
  });
});
