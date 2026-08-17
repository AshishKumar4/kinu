/**
 * Column reconciliation — the half of "idempotent DDL" that CREATE TABLE
 * IF NOT EXISTS does not give you.
 *
 * IF NOT EXISTS is a no-op on a table that already exists, so a column added
 * to a shipped table never reaches a workspace created before it, while every
 * reader still selects that column by name. That is not a hypothetical: a live
 * workspace failed with `no such column: code_language at offset 74` because
 * `search_nodes` gained the column after the workspace was created.
 *
 * So a table that has ever gained a column declares those columns here too,
 * and `reconcileColumns` adds the missing ones in place. ALTER TABLE ADD
 * COLUMN throws when the column is already present, which is the common case
 * and is not an error.
 *
 * This is not a migration framework and must not become one: no versions, no
 * ordering, no down-steps, no data rewrites. It only makes an existing table
 * match the shape its own DDL already declares.
 */

import type { RawSqlExec } from '../types/primitives.js';

/**
 * Add any of `definitions` that the table is missing.
 *
 * Each entry is a column definition exactly as it appears in the table's
 * CREATE statement (`'code_language TEXT'`, `"status TEXT NOT NULL DEFAULT
 * 'current'"`). SQLite rejects ADD COLUMN for a NOT NULL column with no
 * default and for a non-constant default, so a column that has ever been
 * added post-release must carry a constant default or be nullable.
 */
export function reconcileColumns(
  execRaw: RawSqlExec,
  table: string,
  definitions: readonly string[],
): void {
  for (const definition of definitions) {
    try {
      execRaw(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
    } catch { /* already present — the expected outcome on a current workspace */ }
  }
}
