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
import { createTestRuntime } from './helpers';
import { pruneLowValueBranches } from '../src/mcts/pruning';
import { initSearchTables } from '../src/mcts/schemas';
import type { AgentRuntime } from '../src/types/agent-runtime';

function setup() {
  const { rt: base, db } = createTestRuntime();
  const sql = base.storage.sql;
  initSearchTables(base.storage.execRaw);
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

describe('pruneLowValueBranches — one abort failure never ends the sweep', () => {
  test('a throwing abortBranch is recorded per node and the rest still prune', async () => {
    const { sql, rt, aborted } = setup();
    void sql`INSERT INTO search_nodes (root_id, id, task, value, visits, status, branch_agent_key)
        VALUES ('r', 'first', 't', 0.1, 3, 'open', 'agent-first')`;
    void sql`INSERT INTO search_nodes (root_id, id, task, value, visits, status, branch_agent_key)
        VALUES ('r', 'second', 't', 0.1, 3, 'open', 'agent-second')`;
    const failing: AgentRuntime = {
      ...rt,
      abortBranch: async (key: string, reason?: string) => {
        if (key === 'agent-first') throw new Error('platform abort blew up');
        aborted.push({ key, reason });
      },
    };

    // The recorded failure lands on console.error — the only sink this far
    // inside core — so it is read where it lands.
    const original = console.error;
    const lines: string[] = [];
    console.error = (...args: unknown[]) => { lines.push(String(args[0])); };
    try {
      await pruneLowValueBranches(failing, 'r', 0.25, 2);
    } finally {
      console.error = original;
    }

    // The sweep continued past the throw: both nodes pruned, the survivor
    // aborted, the failure named rather than propagated.
    const rows = sql<{ id: string; status: string }>`
      SELECT id, status FROM search_nodes ORDER BY id`;
    expect(rows).toEqual([
      { id: 'first', status: 'pruned' },
      { id: 'second', status: 'pruned' },
    ]);
    expect(aborted).toEqual([{ key: 'agent-second', reason: 'pruned' }]);
    expect(lines.some((line) => line.includes('mcts.prune_abort_failed'))).toBe(true);
  });
});
