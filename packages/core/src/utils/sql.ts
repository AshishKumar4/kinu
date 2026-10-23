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

/** SQLite's tokens: a quoted string or name (kept exactly), a comment, spacing, a paren, comma or dot, or a word. */
export const SQL_TOKEN = /'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|\s+|[(),.]|[^'"`[\s(),.\-/]+|./gu;

/** A token that is no part of a statement: a comment or spacing. */
const SQL_SPACE = /^(?:--|\/\*|\s)/u;

/** A name token as SQLite reads it: a quoted name unquoted, a bare word lowercased; null for a string or a symbol. */
function sqlName(token: string): string | null {
  const quote = token[0];

  if (quote === '"' || quote === '`') return token.slice(1, -1).replaceAll(quote + quote, quote).toLowerCase();

  if (token.startsWith('[')) return token.slice(1, -1).toLowerCase();

  return /^[A-Za-z_][\w$]*$/u.test(token) ? token.toLowerCase() : null;
}

/** Each verb that writes, and the kind of write it is: `REPLACE` is an insert. */
const VERB_BY_WORD: ReadonlyMap<string, 'insert' | 'update' | 'delete'> = new Map([['insert', 'insert'], ['replace', 'insert'], ['update', 'update'], ['delete', 'delete']]);

const WRITE_VERBS: ReadonlySet<string> = new Set(VERB_BY_WORD.keys());

/** A statement's tokens, its comments and spacing aside. */
function sqlTokens(statement: string): string[] {
  return (statement.match(SQL_TOKEN) ?? []).filter((token) => !SQL_SPACE.test(token));
}

/** Every name a statement holds, quoted or bare, a string literal's text aside: what a trigger or a view reads. */
export function sqlNames(statement: string): Set<string> {
  return new Set(sqlTokens(statement).flatMap((token) => sqlName(token) ?? []));
}

/** The table a statement writes and how, as SQLite reads it: `INSERT` (or `REPLACE`) `INTO`, `UPDATE` or `DELETE FROM`,
 *  past a leading `WITH` and any `OR` conflict clause, its schema (`main.`) set aside. Null for a statement that writes
 *  none. SQLite writes one table a statement. */
export function statementWrite(statement: string): { readonly verb: 'insert' | 'update' | 'delete'; readonly table: string } | null {
  const tokens = sqlTokens(statement);
  const first = tokens[0]?.toLowerCase() ?? '';

  if (!WRITE_VERBS.has(first) && first !== 'with') return null;
  let depth = 0;

  // The statement's own verb stands outside every parenthesis: a CTE's body, a subquery's, an upsert's are inside one.
  const at = tokens.findIndex((token) => {
    if (token === '(') depth += 1;
    else if (token === ')') depth -= 1;

    return depth === 0 && WRITE_VERBS.has(token.toLowerCase());
  });

  if (at === -1) return null;
  const verb = VERB_BY_WORD.get(tokens[at]?.toLowerCase() ?? '') ?? 'insert';
  let next = at + 1;

  if (tokens[next]?.toLowerCase() === 'or') next += 2;

  if (tokens[next]?.toLowerCase() === 'into' || tokens[next]?.toLowerCase() === 'from') next += 1;

  // `schema.table`: the table is the name after the dot.
  if (tokens[next + 1] === '.') next += 2;
  const table = sqlName(tokens[next] ?? '');

  return table === null ? null : { verb, table };
}

/** A vocabulary quoted for a DDL CHECK, so the CHECK derives from the same list as the type. */
export function sqlCheckList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(',');
}
