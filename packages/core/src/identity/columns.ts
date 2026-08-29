/**
 * Column reconciliation — the half of "idempotent DDL" that CREATE TABLE
 * IF NOT EXISTS does not give you.
 *
 * IF NOT EXISTS is a no-op on a table that already exists, so a column added
 * to a shipped table never reaches a workspace created before it, while every
 * reader still selects that column by name. That is not a hypothetical: a live
 * workspace failed with `no such column: code_language` because `search_nodes`
 * gained the column after the workspace was created.
 *
 * So a table that has ever gained a column declares those columns here too,
 * and `reconcileColumns` asks which ones are missing and adds exactly those.
 * It does NOT add them speculatively and swallow the duplicate-column error:
 * SQLite reports `duplicate column name: x`, `no such table: t`, `attempt to
 * write a readonly database` and `database table is locked` through the same
 * throw, so a catch here would report success for all four.
 *
 * This is not a migration framework and must not become one: no versions, no
 * ordering, no down-steps, no data rewrites. It only makes an existing table
 * match the shape its own DDL already declares.
 */

import type { RawSqlExec, SqlExec, SqlExecutor } from '../types/primitives';

/**
 * Add the columns of `definitions` that `table` does not already have.
 *
 * `definitions` maps column name to the DDL fragment that follows it in the
 * table's CREATE statement (`{ code_language: 'TEXT' }`, `{ status: "TEXT NOT
 * NULL DEFAULT 'current'" }`). SQLite rejects ADD COLUMN for a NOT NULL column
 * with no default and for a non-constant default, so a column added
 * post-release must carry a constant default or be nullable.
 *
 * The caller creates the table first — every call site is the table's own
 * `CREATE TABLE IF NOT EXISTS` a few lines above. `pragma_table_info` returns
 * no rows for a table that does not exist rather than failing, so an absent
 * table is reported here instead of being read as "no columns present": doing
 * nothing would leave the caller believing the shape was reconciled, and
 * issuing the ALTERs would blame `no such table` on the column.
 */
export function reconcileColumns(
  sql: SqlExecutor,
  execRaw: RawSqlExec,
  table: string,
  definitions: Readonly<Record<string, string>>,
): void {
  // Bound argument to the table-valued form: a tagged template binds its
  // interpolations, and this is a value, not an identifier. Verified on both
  // backends — bun:sqlite and Durable Object SQLite under workerd.
  const present = sql<{ name: string }>`SELECT name FROM pragma_table_info(${table})`.map((row) => row.name);
  addMissingColumns(new Set(present), execRaw, table, definitions);
}

/** The same reconciliation over Durable Object/Bun positional SQL.
 *
 * UserDO owns a `SqlExec`, not the tagged `SqlExecutor` the workspace actors
 * expose. Keeping the policy here prevents a second ask-before-ALTER
 * implementation in the backend while preserving parameter binding for the
 * table-valued pragma query. */
export function reconcileSqlExecColumns(
  sql: SqlExec,
  table: string,
  definitions: Readonly<Record<string, string>>,
): void {
  const present = sql.exec('SELECT name FROM pragma_table_info(?)', table).toArray()
    .map((row) => String(row.name));
  addMissingColumns(new Set(present), (ddl) => { sql.exec(ddl); }, table, definitions);
}

function addMissingColumns(
  present: ReadonlySet<string>,
  execRaw: RawSqlExec,
  table: string,
  definitions: Readonly<Record<string, string>>,
): void {
  if (present.size === 0) {
    throw new Error(`reconcileColumns: table ${table} does not exist — create it before reconciling its columns`);
  }
  for (const [column, definition] of Object.entries(definitions)) {
    if (present.has(column)) continue;
    execRaw(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
