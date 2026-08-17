/**
 * Unit tests: backpropagation running mean + WITH RECURSIVE CTE.
 * Verifies the running mean formula against the formal spec.
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { makeSql, makeExecRaw } from './helpers.js';
import { backpropagate } from '../src/mcts/backpropagation.js';
import { initSearchTables } from '../src/mcts/schemas.js';

function setup() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  initSearchTables(execRaw, sql);
  return { db, sql };
}

describe('Backpropagation', () => {
  test('updates a single root node', () => {
    const { sql } = setup();
    void sql`INSERT INTO search_nodes (id, task, value, visits) VALUES ('root', 'test', 0, 0)`;

    backpropagate(sql, 'root', 0.8);

    const node = sql<{ value: number; visits: number }>`SELECT value, visits FROM search_nodes WHERE id = 'root'`[0]!;
    expect(node.visits).toBe(1);
    // (0 * 0 + 0.8) / (0 + 1) = 0.8
    expect(node.value).toBeCloseTo(0.8, 5);
  });

  test('running mean after two updates', () => {
    const { sql } = setup();
    void sql`INSERT INTO search_nodes (id, task, value, visits) VALUES ('root', 'test', 0, 0)`;

    backpropagate(sql, 'root', 0.8);
    backpropagate(sql, 'root', 0.4);

    const node = sql<{ value: number; visits: number }>`SELECT value, visits FROM search_nodes WHERE id = 'root'`[0]!;
    expect(node.visits).toBe(2);
    // After first: value = 0.8, visits = 1
    // After second: (0.8 * 1 + 0.4) / 2 = 0.6
    expect(node.value).toBeCloseTo(0.6, 5);
  });

  test('full ancestor chain update via WITH RECURSIVE', () => {
    const { sql } = setup();
    void sql`INSERT INTO search_nodes (id, parent_id, task, value, visits) VALUES ('root', NULL, 'test', 0, 0)`;
    void sql`INSERT INTO search_nodes (id, parent_id, task, value, visits) VALUES ('child', 'root', 'test', 0, 0)`;
    void sql`INSERT INTO search_nodes (id, parent_id, task, value, visits) VALUES ('leaf', 'child', 'test', 0, 0)`;

    backpropagate(sql, 'leaf', 0.9);

    // All three should be updated
    const root = sql<{ value: number; visits: number }>`SELECT value, visits FROM search_nodes WHERE id = 'root'`[0]!;
    const child = sql<{ value: number; visits: number }>`SELECT value, visits FROM search_nodes WHERE id = 'child'`[0]!;
    const leaf = sql<{ value: number; visits: number }>`SELECT value, visits FROM search_nodes WHERE id = 'leaf'`[0]!;

    expect(root.visits).toBe(1);
    expect(child.visits).toBe(1);
    expect(leaf.visits).toBe(1);
    expect(root.value).toBeCloseTo(0.9, 5);
    expect(child.value).toBeCloseTo(0.9, 5);
    expect(leaf.value).toBeCloseTo(0.9, 5);
  });

  test('preserves node IDs after backprop', () => {
    const { sql } = setup();
    void sql`INSERT INTO search_nodes (id, parent_id, task, value, visits) VALUES ('a', NULL, 'test', 0, 0)`;
    void sql`INSERT INTO search_nodes (id, parent_id, task, value, visits) VALUES ('b', 'a', 'test', 0, 0)`;

    backpropagate(sql, 'b', 0.5);

    const ids = sql<{ id: string }>`SELECT id FROM search_nodes ORDER BY id`;
    expect(ids.map(r => r.id)).toEqual(['a', 'b']);
  });

  // NOT a BUG-1 guard: Lean's init_values_equal_at_first_step proves the first
  // update erases the prior, so no backprop assertion can see value's default.
  // The prior is guarded behaviourally in unit-initial-value-prior.test.ts.
  test('running mean from a zero-valued node tracks the reward sequence', () => {
    const { sql } = setup();
    void sql`INSERT INTO search_nodes (id, task, value, visits) VALUES ('n', 'test', 0, 0)`;

    backpropagate(sql, 'n', 0.7);
    const after1 = sql<{ value: number }>`SELECT value FROM search_nodes WHERE id = 'n'`[0]!;
    expect(after1.value).toBeCloseTo(0.7, 5); // (0*0 + 0.7)/1 = 0.7

    backpropagate(sql, 'n', 0.3);
    const after2 = sql<{ value: number }>`SELECT value FROM search_nodes WHERE id = 'n'`[0]!;
    expect(after2.value).toBeCloseTo(0.5, 5); // (0.7*1 + 0.3)/2 = 0.5
  });
});
