/**
 * Unit tests: backpropagation running mean + WITH RECURSIVE CTE.
 * Verifies the running mean formula against the formal spec.
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { makeSql, makeExecRaw } from './helpers';
import { createTestActors } from '@kinu.run/test-utils';
import { backpropagate } from '../src/mcts/backpropagation';
import { initSearchTables } from '../src/mcts/schemas';

/** One search ledger and the actor that owns it. `search_nodes` is keyed
 *  `(actor_id, id)`, so the owner is part of every write and every read here —
 *  a read under another handle finds nothing, which a running mean would
 *  report as an unvisited node rather than as a scoping fault. */
function setup() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  initSearchTables(execRaw);
  const actor = createTestActors(sql, execRaw).main;
  const insert = (node: { id: string; parentId?: string | null; rootId: string }): void => {
    void sql`INSERT INTO search_nodes (actor_id, id, parent_id, root_id, task, value, visits)
      VALUES (${actor.actorId}, ${node.id}, ${node.parentId ?? null}, ${node.rootId}, 'test', 0, 0)`;
  };
  /** One node's running mean. An absent row is a broken fixture, so it raises
   *  rather than reading as a node nobody visited. */
  const read = (id: string): { value: number; visits: number } => {
    const row = sql<{ value: number; visits: number }>`
      SELECT value, visits FROM search_nodes WHERE actor_id = ${actor.actorId} AND id = ${id}`[0];
    if (!row) throw new Error(`this actor holds no search node ${id}`);
    return row;
  };
  return { db, sql, actor, insert, read };
}

describe('Backpropagation', () => {
  test('updates a single root node', () => {
    const { sql, actor, insert, read } = setup();
    insert({ id: 'root', rootId: 'root' });

    backpropagate(sql, actor, 'root', 0.8);

    const node = read('root');
    expect(node.visits).toBe(1);
    // (0 * 0 + 0.8) / (0 + 1) = 0.8
    expect(node.value).toBeCloseTo(0.8, 5);
  });

  test('running mean after two updates', () => {
    const { sql, actor, insert, read } = setup();
    insert({ id: 'root', rootId: 'root' });

    backpropagate(sql, actor, 'root', 0.8);
    backpropagate(sql, actor, 'root', 0.4);

    const node = read('root');
    expect(node.visits).toBe(2);
    // After first: value = 0.8, visits = 1
    // After second: (0.8 * 1 + 0.4) / 2 = 0.6
    expect(node.value).toBeCloseTo(0.6, 5);
  });

  test('full ancestor chain update via WITH RECURSIVE', () => {
    const { sql, actor, insert, read } = setup();
    insert({ id: 'root', parentId: null, rootId: 'root' });
    insert({ id: 'child', parentId: 'root', rootId: 'root' });
    insert({ id: 'leaf', parentId: 'child', rootId: 'root' });

    backpropagate(sql, actor, 'leaf', 0.9);

    // All three should be updated
    const root = read('root');
    const child = read('child');
    const leaf = read('leaf');

    expect(root.visits).toBe(1);
    expect(child.visits).toBe(1);
    expect(leaf.visits).toBe(1);
    expect(root.value).toBeCloseTo(0.9, 5);
    expect(child.value).toBeCloseTo(0.9, 5);
    expect(leaf.value).toBeCloseTo(0.9, 5);
  });

  test('preserves node IDs after backprop', () => {
    const { sql, actor, insert } = setup();
    insert({ id: 'a', parentId: null, rootId: 'a' });
    insert({ id: 'b', parentId: 'a', rootId: 'a' });

    backpropagate(sql, actor, 'b', 0.5);

    const ids = sql<{ id: string }>`
      SELECT id FROM search_nodes WHERE actor_id = ${actor.actorId} ORDER BY id`;
    expect(ids.map(r => r.id)).toEqual(['a', 'b']);
  });

  // NOT a BUG-1 guard: Lean's init_values_equal_at_first_step proves the first
  // update erases the prior, so no backprop assertion can see value's default.
  // The prior is guarded behaviourally in unit-initial-value-prior.test.ts.
  test('running mean from a zero-valued node tracks the reward sequence', () => {
    const { sql, actor, insert, read } = setup();
    insert({ id: 'n', rootId: 'n' });

    backpropagate(sql, actor, 'n', 0.7);
    expect(read('n').value).toBeCloseTo(0.7, 5); // (0*0 + 0.7)/1 = 0.7

    backpropagate(sql, actor, 'n', 0.3);
    expect(read('n').value).toBeCloseTo(0.5, 5); // (0.7*1 + 0.3)/2 = 0.5
  });
});
