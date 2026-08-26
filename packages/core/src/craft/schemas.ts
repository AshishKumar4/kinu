/**
 * Crafted-tool quality columns — schema migration.
 *
 * Quality (score/uses/last_used_at) lives ON the crafted_tools row. The old
 * separate craft_scores table was one-to-one with it but written in separate
 * statements, so a half-write admitted an unscored or stale-scored tool; the
 * merge makes create/observe/retire single-statement atomic.
 */

import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import { reconcileColumns } from '../identity/columns';

/** Columns added to crafted_tools after its first release. */
const CRAFT_QUALITY_COLUMNS = {
  score: 'REAL NOT NULL DEFAULT 0.5',
  uses: 'INTEGER NOT NULL DEFAULT 0',
  last_used_at: 'INTEGER NOT NULL DEFAULT 0',
} as const;

export function initCraftQualityColumns(execRaw: RawSqlExec, sql: SqlExecutor): void {
  // Table creation first, reconciliation second, in the same call: the helper
  // CREATEs its own table before asking pragma_table_info which columns exist.
  execRaw(`CREATE TABLE IF NOT EXISTS crafted_tools (
    name        TEXT PRIMARY KEY,
    description TEXT NOT NULL DEFAULT '',
    params      TEXT,
    code        TEXT NOT NULL DEFAULT '',
    scope       TEXT NOT NULL DEFAULT 'local',
    created_at  INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL DEFAULT 0,
    score       REAL NOT NULL DEFAULT 0.5,
    uses        INTEGER NOT NULL DEFAULT 0,
    last_used_at INTEGER NOT NULL DEFAULT 0
  )`);
  reconcileColumns(sql, execRaw, 'crafted_tools', CRAFT_QUALITY_COLUMNS);
  backfillCraftScoresFromLegacy(sql, execRaw);
}

/**
 * One-shot cutover for workspaces created before the merge: each surviving
 * craft_scores row's quality moves onto the matching crafted_tools row (rows
 * without a match already carry the neutral prior the column default gave
 * them), and the legacy table dies.
 */
function backfillCraftScoresFromLegacy(sql: SqlExecutor, execRaw: RawSqlExec): void {
  const legacy = sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'craft_scores'`;
  if (legacy.length === 0) return;
  void sql`UPDATE crafted_tools
      SET (score, uses, last_used_at) = (
        SELECT cs.score, cs.uses, cs.last_used_at FROM craft_scores cs
        WHERE cs.tool_name = crafted_tools.name
      )
      WHERE EXISTS (SELECT 1 FROM craft_scores cs WHERE cs.tool_name = crafted_tools.name)`;
  execRaw(`DROP TABLE craft_scores`);
}
