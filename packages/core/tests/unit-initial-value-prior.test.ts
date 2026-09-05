/**
 * Unit tests: BUG-1 — a fresh search node's value prior is 0, NOT 0.5.
 *
 * Formal spec: MCTS/Backpropagation.lean:initial_in_range — `InRange S s` is
 * `0 ≤ scaledSum ∧ scaledSum ≤ S · visits`. At visits = 0 that pins scaledSum
 * (hence the derived mean `value`) to exactly 0; a 0.5 neutral prior is outside
 * the invariant, because a node that has received no rewards has no mean.
 *
 * Backpropagation itself cannot detect the prior — Lean's
 * `init_values_equal_at_first_step` proves the first update erases it. The
 * prior is only observable where an UNVISITED node is ranked against evaluated
 * ones, i.e. at convergence, so that is where it is tested from.
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createTestRuntime, createMockSession, makeExecRaw, makeSql } from './helpers';
import { recordNode, type SessionWriter } from '../src/mcts/record-node';
import { backpropagate } from '../src/mcts/backpropagation';
import { converge } from '../src/mcts/convergence';
import { initSearchTables } from '../src/mcts/schemas';
import { initActorTables } from '../src/identity/schema';
import type { SqlExecutor } from '../src/types/primitives';

/** Record a node the way the engine does — value/visits are never written, so
 *  the DDL default is what lands in the row. */
function record(session: SessionWriter, sql: SqlExecutor, nodeId: string): Promise<string> {
  return recordNode(session, sql, {
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
    await record(createMockSession(), rt.storage.sql, 'fresh');

    const node = rt.storage.sql<{ value: number; visits: number }>`
      SELECT value, visits FROM search_nodes WHERE id = 'fresh'`[0]!;
    // Lean initial_in_range: visits = 0 admits scaledSum = 0 only.
    expect(node.visits).toBe(0);
    expect(node.value).toBe(0);
  });

  test('a tree where nothing was ever evaluated does NOT converge', async () => {
    const { rt } = createTestRuntime();
    initSearchTables(rt.storage.execRaw);
    const session = createMockSession();
    await record(session, rt.storage.sql, 'a');
    await record(session, rt.storage.sql, 'b');

    // No backpropagate() call anywhere: no branch has earned a score.
    const result = await converge(rt, session, 'r');

    // A 0.5 prior would clear minAcceptableScore (0.3) on its own and report
    // success for a search that never scored a single branch.
    expect(result.winnerValue).toBe(0);
    expect(result.converged).toBe(false);
  });

  test('an unevaluated branch cannot out-rank a genuinely low-scored one', async () => {
    const { rt } = createTestRuntime();
    initSearchTables(rt.storage.execRaw);
    const session = createMockSession();
    await record(session, rt.storage.sql, 'scored');
    await record(session, rt.storage.sql, 'never-evaluated');

    // 0.35: a real but mediocre grounded score — above minAcceptableScore (0.3)
    // and below a 0.5 prior, so the prior would steal the win.
    backpropagate(rt.storage.sql, 'scored', 0.35);

    const result = await converge(rt, session, 'r');

    expect(result.winnerId).toBe('scored');
    expect(result.winnerValue).toBeCloseTo(0.35, 5);
  });

  test('the MCTS-only DDL and the unified actor DDL agree on the search_nodes column defaults', () => {
    // schemas.ts documents that it must stay in sync with identity/schema.ts.
    // CREATE TABLE IF NOT EXISTS means a drift between them silently depends on
    // whichever subsystem initialized the storage first.
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
