/** SQL primitives any store's DDL or reads use, owned by none of them. */

import type { SqlExecutor } from '../types/primitives';

/** Absence as a value: a catch cannot tell a missing table from other SQL errors. */
export function tableExists(sql: SqlExecutor, table: string): boolean {
  return sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}
  `.length > 0;
}

/** A vocabulary quoted for a DDL CHECK, so the CHECK derives from the same list as the type. */
export function sqlCheckList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(',');
}
