/**
 * Unit tests: MCTS pruning (WP-A2).
 *
 * The regression this guards: pruning used to be handed only the freshly-
 * expanded children (visits === 1) yet gated on a hardcoded `visits >= 2`, so
 * it could NEVER fire. Pruning now scans the full open population and honors
 * the `minVisitsForPrune` config, so a settled low-value node actually reaches
 * status='pruned' mid-search.
 */

import { describe, test, expect } from 'bun:test';
import { createTestRuntime } from './helpers.js';
import { pruneLowValueBranches } from '../src/mcts/pruning.js';
import { initSearchTables } from '../src/mcts/schemas.js';
import type { AgentRuntime } from '../src/types/agent-runtime.js';

function setup() {
  const { rt: base, db } = createTestRuntime();
  const sql = base.storage.sql;
  initSearchTables(base.storage.execRaw, base.storage.sql);
  const aborted: Array<{ key: string; reason?: string }> = [];
  const rt: AgentRuntime = {
    ...base,
    abortBranch: async (key: string, reason?: string) => { aborted.push({ key, reason }); },
  };
  return { db, sql, rt, aborted };
}

describe('pruneLowValueBranches — population + config-honoring gate', () => {
  test('a settled low-value node reaches status=pruned mid-search', async () => {
    const { sql, rt, aborted } = setup();
    // Mid-search state: this node was re-selected and backpropagated enough for
    // its running-mean value to settle below threshold (visits >= 2).
    void sql`INSERT INTO search_nodes (root_id, id, task, value, visits, status, branch_agent_key)
        VALUES ('r', 'doomed', 't', 0.1, 3, 'open', 'agent-doomed')`;
    await pruneLowValueBranches(rt, 'r', 0.25, 2);
    const row = sql<{ status: string; branch_agent_key: string | null }>`
      SELECT status, branch_agent_key FROM search_nodes WHERE id = 'doomed'`[0]!;
    expect(row.status).toBe('pruned');
    expect(row.branch_agent_key).toBeNull();
    expect(aborted).toEqual([{ key: 'agent-doomed', reason: 'pruned' }]);
  });

  test('a fresh single-visit node is protected by minVisitsForPrune', async () => {
    const { sql, rt, aborted } = setup();
    void sql`INSERT INTO search_nodes (root_id, id, task, value, visits, status)
        VALUES ('r', 'fresh', 't', 0.05, 1, 'open')`;
    await pruneLowValueBranches(rt, 'r', 0.25, 2);
    expect(sql<{ status: string }>`SELECT status FROM search_nodes WHERE id = 'fresh'`[0]!.status).toBe('open');
    expect(aborted).toHaveLength(0);
  });

  test('honors the minVisitsForPrune argument (was hardcoded 2)', async () => {
    const { sql, rt } = setup();
    void sql`INSERT INTO search_nodes (root_id, id, task, value, visits, status)
        VALUES ('r', 'n', 't', 0.05, 1, 'open')`;
    await pruneLowValueBranches(rt, 'r', 0.25, 1); // config says one visit is enough
    expect(sql<{ status: string }>`SELECT status FROM search_nodes WHERE id = 'n'`[0]!.status).toBe('pruned');
  });

  test('a healthy above-threshold node is never pruned, however many visits', async () => {
    const { sql, rt } = setup();
    void sql`INSERT INTO search_nodes (root_id, id, task, value, visits, status)
        VALUES ('r', 'good', 't', 0.9, 50, 'open')`;
    await pruneLowValueBranches(rt, 'r', 0.25, 2);
    expect(sql<{ status: string }>`SELECT status FROM search_nodes WHERE id = 'good'`[0]!.status).toBe('open');
  });

  test('never touches already-pruned or failed nodes', async () => {
    const { sql, rt } = setup();
    void sql`INSERT INTO search_nodes (root_id, id, task, value, visits, status)
        VALUES ('r', 'already', 't', 0.01, 9, 'pruned')`;
    void sql`INSERT INTO search_nodes (root_id, id, task, value, visits, status)
        VALUES ('r', 'failed', 't', 0.01, 9, 'failed')`;
    await pruneLowValueBranches(rt, 'r', 0.25, 2);
    expect(sql<{ status: string }>`SELECT status FROM search_nodes WHERE id = 'already'`[0]!.status).toBe('pruned');
    expect(sql<{ status: string }>`SELECT status FROM search_nodes WHERE id = 'failed'`[0]!.status).toBe('failed');
  });
});
