/**
 * A fresh search node's value prior is 0, not 0.5.
 * Formal spec: MCTS/Backpropagation.lean:initial_in_range — at visits = 0, scaledSum is exactly 0.
 */

import { describe, test, expect } from 'bun:test';
import { createTestRuntime } from './helpers';
import { insertSearchNode } from '../src/mcts/record-node';
import { initSearchTables } from '../src/mcts/schemas';

describe('BUG-1: the initial value prior', () => {
  test('a node that has never been backpropagated has value 0 and visits 0', () => {
    const { rt } = createTestRuntime();
    initSearchTables(rt.storage.execRaw);
    insertSearchNode(rt.storage.sql, rt.actor, {
      nodeId: 'fresh', parentNodeId: null, rootId: 'r', task: 'ship the thing',
      action: '', observation: 'some output', codeUsed: null, depth: 0, msgId: null,
    });

    const node = rt.storage.sql<{ value: number; visits: number }>`
      SELECT value, visits FROM search_nodes
      WHERE actor_id = ${rt.actor.actorId} AND id = 'fresh'`[0];

    // Lean initial_in_range: visits = 0 admits scaledSum = 0 only.
    expect(node.visits).toBe(0);
    expect(node.value).toBe(0);
  });
});
