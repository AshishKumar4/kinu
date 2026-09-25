/**
 * A fresh search node's value prior is 0, not 0.5.
 * Formal spec: MCTS/Backpropagation.lean:initial_in_range — at visits = 0, scaledSum is exactly 0.
 * `init_values_equal_at_first_step` erases the prior at first update, so it is tested at convergence.
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createTestRuntime, createMockSession, makeExecRaw, makeSql } from './helpers';
import { recordNode, type SessionWriter } from '../src/mcts/record-node';
import { backpropagate } from '../src/mcts/backpropagation';
import { converge } from '../src/mcts/convergence';
import { initSearchTables } from '../src/mcts/schemas';
import { initActorTables } from '../src/state/workspace-schema';
import type { SqlExecutor } from '../src/types/primitives';
import type { ActorHandle } from '../src/identity/actor-handle';

/** Records a node as the engine does: value/visits come from the DDL default. */
function record(
  session: SessionWriter, sql: SqlExecutor, actor: ActorHandle, nodeId: string,
): Promise<string> {
  return recordNode(session, sql, actor, {
    nodeId,
    parentNodeId: null,
    parentMsgId: null,
    rootId: 'r',
    task: 'ship the thing',
    action: `approach ${nodeId}`,
    observation: 'some output',
    codeUsed: null,
    depth: 0,
  });
}

describe('BUG-1: the initial value prior', () => {
  test('a node that has never been backpropagated has value 0 and visits 0', async () => {
    const { rt } = createTestRuntime();
    initSearchTables(rt.storage.execRaw);
    await record(createMockSession(), rt.storage.sql, rt.actor, 'fresh');

    const node = rt.storage.sql<{ value: number; visits: number }>`
      SELECT value, visits FROM search_nodes
      WHERE actor_id = ${rt.actor.actorId} AND id = 'fresh'`[0];

    // Lean initial_in_range: visits = 0 admits scaledSum = 0 only.
    expect(node.visits).toBe(0);
    expect(node.value).toBe(0);
  });

  test('a tree where nothing was ever evaluated does NOT converge', async () => {
    const { rt } = createTestRuntime();
    initSearchTables(rt.storage.execRaw);
    const session = createMockSession();
    await record(session, rt.storage.sql, rt.actor, 'a');
    await record(session, rt.storage.sql, rt.actor, 'b');

    const result = await converge(rt, session, 'r');

    // A 0.5 prior would clear minAcceptableScore on its own.
    expect(result.winnerValue).toBe(0);
    expect(result.converged).toBe(false);
  });

  test('an unevaluated branch cannot out-rank a genuinely low-scored one', async () => {
    const { rt } = createTestRuntime();
    initSearchTables(rt.storage.execRaw);
    const session = createMockSession();
    await record(session, rt.storage.sql, rt.actor, 'scored');
    await record(session, rt.storage.sql, rt.actor, 'never-evaluated');

    // 0.35: above minAcceptableScore (0.3), below a 0.5 prior that would steal the win.
    backpropagate(rt.storage.sql, rt.actor, 'scored', 0.35);

    const result = await converge(rt, session, 'r');

    expect(result.winnerId).toBe('scored');
    expect(result.winnerValue).toBeCloseTo(0.35, 5);
  });

  test('the MCTS-only DDL and the unified actor DDL agree on the search_nodes column defaults', () => {
    // Must stay in sync with identity/schema.ts: `CREATE TABLE IF NOT EXISTS` makes drift depend on init order.
    const defaultsOf = (init: (db: Database) => void): Record<string, string | null> => {
      const db = new Database(':memory:');
      init(db);

      const cols = db.query<{ name: string; dflt_value: string | null }, []>(
        `PRAGMA table_info('search_nodes')`,
      ).all();

      return Object.fromEntries(cols.map((c) => [c.name, c.dflt_value]));
    };

    const mctsOnly = defaultsOf((db) => initSearchTables(makeExecRaw(db)));
    const unified = defaultsOf((db) => initActorTables(makeExecRaw(db), makeSql(db)));

    expect(mctsOnly).toEqual(unified);
    expect(mctsOnly.value).toBe('0');
    expect(mctsOnly.visits).toBe('0');
  });
});
