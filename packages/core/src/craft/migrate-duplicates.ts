/**
 * One-time per-agent migration that merges case-collision duplicates in
 * `crafted_tools` and `craft_scores`.
 *
 * Context: older code lowercased tool names on createTool; current code
 * preserves case. Existing agents can have both `multiplyNumbers` and
 * `multiplynumbers` as separate PRIMARY KEY rows. Left alone they'd bloat
 * getToolList and fight for craft_scores EMA credit.
 *
 * Policy: for each lowercased-name group with >1 row, KEEP the tool with
 * the highest craft_scores.score (tie-break: most-recent updated_at).
 * Delete the others. Merge craft_scores into the kept name by taking
 * MAX(score), SUM(uses), MAX(last_used_at), MIN(created_at).
 *
 * Idempotent: marker table `_v2_codegen_migration_done` gates re-runs.
 * Safe under DO single-writer semantics.
 */

import type { SqlExecutor, RawSqlExec } from '../types/primitives';

export interface MigrationReport {
  ranMigration: boolean;
  mergedGroups: number;
  rowsDeletedCraftedTools: number;
  rowsDeletedCraftScores: number;
}

export function migrateCraftedToolDuplicates(
  sql: SqlExecutor,
  execRaw: RawSqlExec,
): MigrationReport {
  const report: MigrationReport = {
    ranMigration: false,
    mergedGroups: 0,
    rowsDeletedCraftedTools: 0,
    rowsDeletedCraftScores: 0,
  };

  // Ensure marker table exists
  execRaw('CREATE TABLE IF NOT EXISTS _v2_codegen_migration_done (id INTEGER PRIMARY KEY)');

  // Skip if we've already run
  const done = sql<{ c: number }>`SELECT COUNT(*) AS c FROM _v2_codegen_migration_done`;
  if ((done[0]?.c ?? 0) > 0) return report;
  report.ranMigration = true;

  // Find case-collision groups in crafted_tools
  const dupGroups = sql<{ lower_name: string; cnt: number }>`
    SELECT LOWER(name) AS lower_name, COUNT(*) AS cnt
    FROM crafted_tools
    GROUP BY LOWER(name)
    HAVING cnt > 1`;

  for (const g of dupGroups) {
    // Get all rows + their scores. Score defaults to 0.5 if no row in
    // craft_scores yet. Tie-break on updated_at so a never-used recent
    // row wins over a never-used old row.
    const rows = sql<{
      name: string;
      updated_at: number;
      score: number;
    }>`
      SELECT ct.name, ct.updated_at, COALESCE(cs.score, 0.5) AS score
      FROM crafted_tools ct
      LEFT JOIN craft_scores cs ON cs.tool_name = ct.name
      WHERE LOWER(ct.name) = ${g.lower_name}
      ORDER BY COALESCE(cs.score, 0.5) DESC, ct.updated_at DESC`;

    if (rows.length < 2) continue;
    const keep = rows[0]!;
    const drop = rows.slice(1);

    for (const r of drop) {
      void sql`DELETE FROM crafted_tools WHERE name = ${r.name}`;
      report.rowsDeletedCraftedTools++;
    }

    // Merge craft_scores: aggregate across ALL names (kept + dropped), then
    // replace the kept row. Other names are deleted from craft_scores too.
    //
    // Uncaught: this block reads, deletes AND inserts, so the old
    // `catch { /* craft_scores may not exist yet */ }` reported a failed DELETE
    // or INSERT as an absent table — and line 117 then marks the migration done,
    // permanently, for a merge that half-happened. The table is part of the one
    // workspace schema, so it exists wherever this runs.
    const merged = sql<{
      score: number | null;
      uses: number | null;
      last_used_at: number | null;
      created_at: number | null;
    }>`
      SELECT MAX(score) AS score, COALESCE(SUM(uses), 0) AS uses,
             MAX(last_used_at) AS last_used_at, MIN(created_at) AS created_at
      FROM craft_scores WHERE LOWER(tool_name) = ${g.lower_name}`;
    const m = merged[0];
    if (m && m.score !== null) {
      const scoreRowsBefore = sql<{ c: number }>`
        SELECT COUNT(*) AS c FROM craft_scores WHERE LOWER(tool_name) = ${g.lower_name}`;
      const before = scoreRowsBefore[0]?.c ?? 0;
      void sql`DELETE FROM craft_scores WHERE LOWER(tool_name) = ${g.lower_name}`;
      void sql`INSERT INTO craft_scores (tool_name, score, uses, last_used_at, created_at)
        VALUES (${keep.name}, ${m.score}, ${m.uses ?? 0},
                ${m.last_used_at ?? Date.now()}, ${m.created_at ?? Date.now()})`;
      // Kept row replaced (1 delete+1 insert); the rest of deletes are the
      // duplicates we retired.
      report.rowsDeletedCraftScores += Math.max(0, before - 1);
    }

    report.mergedGroups++;
  }

  void sql`INSERT INTO _v2_codegen_migration_done (id) VALUES (1)`;
  return report;
}
