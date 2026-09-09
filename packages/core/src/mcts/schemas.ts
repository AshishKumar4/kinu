/**
 * MCTS SQL schemas — the DDL for the search tree.
 * Architecture reference: docs/MCTS.md — "search_nodes Table".
 *
 * BUG-1 FIX: value defaults to 0, NOT 0.5.
 * Formal spec: MCTS/Backpropagation.lean:initial_in_range (a fresh node starts in range).
 *
 * `root_id` names the search run a node belongs to. Selection, pruning and
 * convergence are scoped by it, so a tree left behind by an interrupted or
 * failed search can never be selected into — or won by — a later one.
 *
 * This is the ONE definition of search_nodes. The unified workspace
 * initializer (identity/schema.ts) calls this rather than carrying a copy.
 *
 * ACTOR-SCOPED, in the primary key. One physical database holds every logical
 * actor of a workspace, a node id is minted per search, and selection walks
 * `parent_id` to `id` — so without the owner in the key one actor's tree could
 * be selected into by another's search. The self-referencing FOREIGN KEY on
 * `parent_id` is gone with the single-column key: a composite reference would
 * have to name `(actor_id, parent_id)`, and the edge it enforced is already
 * enforced by the writer, which only ever parents a node on one it just read
 * from this actor's rows.
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
