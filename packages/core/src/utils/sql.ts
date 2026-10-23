/** SQL primitives any store's DDL or reads use, owned by none of them. */

import type { SqlExecutor } from '../types/primitives';

/** Absence as a value: a catch cannot tell a missing table from other SQL errors. */
export function tableExists(sql: SqlExecutor, table: string): boolean {
  return sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}
  `.length > 0;
}

const STATEMENTS = new WeakMap<TemplateStringsArray, string>();

/** A tagged statement's text, joined once per call site: its strings are one array for the program's life, and a join on
 *  every execution was 2.1 of the 202 MB a 150-step turn allocated in its agent's isolate (heap gate, 2026-10-23). */
export function statementText(strings: TemplateStringsArray): string {
  const known = STATEMENTS.get(strings);

  if (known !== undefined) return known;
  const text = strings.join('?');

  STATEMENTS.set(strings, text);

  return text;
}

/** A vocabulary quoted for a DDL CHECK, so the CHECK derives from the same list as the type. */
export function sqlCheckList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(',');
}
