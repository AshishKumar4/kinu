/**
 * MCTS SQL schemas — the DDL for the search tree.
 * Architecture reference: docs/MCTS.md — "search_nodes Table".
 *
 * BUG-1 FIX: value defaults to 0, NOT 0.5.
 * Formal spec: MCTS/Backpropagation.lean:initial_in_range (a fresh node starts in range).
 *
 * `root_id` names the search run a node belongs to. Selection, pruning and
 * convergence are scoped by it, so a tree left behind by an interrupted or
 * failed search can never be selected into — or won by — a later one. Legacy
 * rows written before the column have a NULL root_id and are therefore
 * invisible to every scoped query, which is the intended outcome.
 *
 * This is the ONE definition of search_nodes. The unified workspace
 * initializer (identity/schema.ts) calls this rather than carrying a copy:
 * a second definition drifted, and workspaces created before a column landed
 * were missing it while every reader selected it by name.
 */

import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import { reconcileColumns } from '../identity/columns';

/**
 * Columns `search_nodes` gained after its first release, and the one place they are listed.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op on a workspace whose table predates one of them, while
 * every reader still selects it by name — which is how a live workspace failed with
 * `no such column: code_language at offset 74`.
 *
 * Exported because two initialisation orders both need it and neither may hold its own copy:
 * `initSearchTables` below reconciles them for the standalone MCTS path, and
 * `identity/workspace-schema.ts`'s legacy repair reconciles them BEFORE the unified CREATE pass,
 * because that pass builds `idx_sn_root_status` over `root_id` and fails on a table that lacks it.
 */
export const SEARCH_NODES_POST_RELEASE_COLUMNS = {
  code_used: 'TEXT',
  code_language: 'TEXT',
  root_id: 'TEXT',
} satisfies Readonly<Record<string, string>>;

export function initSearchTables(execRaw: RawSqlExec, sql: SqlExecutor): void {
  execRaw(`
    CREATE TABLE IF NOT EXISTS search_nodes (
      id               TEXT PRIMARY KEY,
      parent_id        TEXT REFERENCES search_nodes(id) ON DELETE CASCADE,
      root_id          TEXT,
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
      created_at       INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);
  reconcileColumns(sql, execRaw, 'search_nodes', SEARCH_NODES_POST_RELEASE_COLUMNS);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_sn_parent ON search_nodes(parent_id)`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_sn_status_value ON search_nodes(status, value DESC)`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_sn_root_status ON search_nodes(root_id, status)`);
}
