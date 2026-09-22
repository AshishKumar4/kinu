/**
 * MCTS SQL schemas: the one definition of search_nodes. Reference: docs/MCTS.md "search_nodes Table".
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
      task             TEXT NOT NULL,
      action           TEXT NOT NULL DEFAULT '',
      observation      TEXT NOT NULL DEFAULT '',
      code_used        TEXT,
      code_language    TEXT,
      visits           INTEGER NOT NULL DEFAULT 0,
      value            REAL NOT NULL DEFAULT 0,
      depth            INTEGER NOT NULL DEFAULT 0,
      status           TEXT NOT NULL DEFAULT 'open'
                       CHECK(status IN ('open','terminal','failed','pruned')),
      msg_id           TEXT,
      branch_agent_key TEXT,
      evaluation_json  TEXT,
      created_at       INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      PRIMARY KEY (actor_id, id)
    )
  `);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_sn_parent ON search_nodes(actor_id, parent_id)`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_sn_status_value ON search_nodes(actor_id, status, value DESC)`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_sn_root_status ON search_nodes(actor_id, root_id, status)`);
}
