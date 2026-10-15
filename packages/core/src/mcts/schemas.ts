/**
 * The one definition of search_nodes.
 * `value` defaults to 0, not 0.5.
 * Formal spec: MCTS/Backpropagation.lean:initial_in_range (a fresh node starts in range).
 * Selection, pruning and convergence scope by `root_id`; `actor_id` is in the primary key
 * because one database holds every actor's trees.
 */

import type { RawSqlExec } from '../types/primitives';

export function initSearchTables(execRaw: RawSqlExec): void {
  execRaw(`
    CREATE TABLE IF NOT EXISTS search_nodes (
      actor_id         TEXT NOT NULL,
      id               TEXT NOT NULL,
      parent_id        TEXT,
      root_id          TEXT NOT NULL,
      -- The search's task, on its root; a child's is its root's, read through search_node_scores.
      task             TEXT,
      action           TEXT NOT NULL DEFAULT '',
      observation      TEXT NOT NULL DEFAULT '',
      visits           INTEGER NOT NULL DEFAULT 0,
      value            REAL NOT NULL DEFAULT 0,
      depth            INTEGER NOT NULL DEFAULT 0,
      status           TEXT NOT NULL DEFAULT 'open'
                       CHECK(status IN ('open','terminal','failed','pruned')),
      created_at       INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      PRIMARY KEY (actor_id, id),
      CHECK(parent_id IS NOT NULL OR task IS NOT NULL)
    )
  `);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_sn_parent ON search_nodes(actor_id, parent_id)`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_sn_status_value ON search_nodes(actor_id, status, value DESC)`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_sn_root_status ON search_nodes(actor_id, root_id, status)`);
  // Each node with its search's task and its own score; every reader of either reads it here.
  execRaw(`CREATE VIEW IF NOT EXISTS search_node_scores AS
    SELECT n.actor_id, n.id, n.parent_id, n.root_id, t.task, n.action, n.observation, n.visits, n.value, n.depth,
      n.status, n.created_at, CASE
      WHEN n.parent_id IS NULL THEN n.value
      WHEN r.record_json IS NOT NULL THEN json_extract(r.record_json, '$.outcome.score')
      ELSE 0 END AS own_score
    FROM search_nodes n
    LEFT JOIN search_nodes t ON t.actor_id = n.actor_id AND t.id = n.root_id
    LEFT JOIN swarm_node_records r ON r.actor_id = n.actor_id AND r.node_id = n.id`);
}
