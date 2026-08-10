/**
 * MCTS SQL schemas — the DDL for the search tree.
 *
 * BUG-1 FIX: value defaults to 0, NOT 0.5.
 * Formal spec: MCTS/Backpropagation.lean:initial_valid (the value=0 initial state is Valid).
 *
 * `root_id` names the search run a node belongs to. Selection, pruning and
 * convergence are scoped by it, so a tree left behind by an interrupted or
 * failed search can never be selected into — or won by — a later one. Legacy
 * rows written before the column have a NULL root_id and are therefore
 * invisible to every scoped query, which is the intended outcome.
 *
 * NOTE: This DDL must stay in sync with packages/core/src/identity/schema.ts
 * (the unified schema). Both are safe to run because of IF NOT EXISTS. The
 * duplicate exists so subsystems (MCTS engine, CLI) can self-initialize
 * without requiring the full unified schema init.
 */

import type { RawSqlExec } from '../types/primitives.js';

export function initSearchTables(execRaw: RawSqlExec): void {
  execRaw(`
    CREATE TABLE IF NOT EXISTS search_nodes (
      id               TEXT PRIMARY KEY,
      parent_id        TEXT REFERENCES search_nodes(id) ON DELETE CASCADE,
      root_id          TEXT,
      task             TEXT NOT NULL,
      action           TEXT NOT NULL DEFAULT '',
      observation      TEXT NOT NULL DEFAULT '',
      code_used        TEXT,
      visits           INTEGER NOT NULL DEFAULT 0,
      value            REAL NOT NULL DEFAULT 0,
      depth            INTEGER NOT NULL DEFAULT 0,
      status           TEXT NOT NULL DEFAULT 'open'
                       CHECK(status IN ('open','terminal','failed','pruned')),
      msg_id           TEXT,
      branch_agent_key TEXT,
      created_at       INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_sn_parent ON search_nodes(parent_id)`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_sn_status_value ON search_nodes(status, value DESC)`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_sn_root_status ON search_nodes(root_id, status)`);
}
