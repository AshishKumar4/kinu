import * as v from 'valibot';
import { KinuError } from '../obs/error';
import type { RawSqlExec, SqlExec } from '../types/primitives';

export class StoragePredatesResetError extends KinuError {
  override readonly name = 'StoragePredatesResetError';

  constructor(readonly table: string, readonly missing: readonly string[]) {
    super('unsupported', 'This workspace was created before a storage reset, and this version cannot run it: '
      + `its ${table} table has no ${missing.join(', ')}. Export the workspace, or create a new one.`);
  }
}

const CREATE_TABLE = /^\s*CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)\s*\(/i;

const TABLE_CONSTRAINT = /^(PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY|CONSTRAINT)\b/i;

function quoteEnd(text: string, from: number): number {
  let at = from + 1;

  while (at < text.length) {
    if (text[at] === text[from] && text[at + 1] === text[from]) at += 2;
    else if (text[at] === text[from]) return at;
    else at++;
  }

  return text.length;
}

function listItems(text: string, from: number): string[] {
  const items: string[] = [];
  let item = '';
  let depth = 0;

  for (let at = from; at < text.length; at++) {
    const char = text[at];

    if (char === "'" || char === '"' || char === '`') {
      const end = quoteEnd(text, at);
      item += text.slice(at, end + 1);
      at = end;
    } else if (char === '-' && text[at + 1] === '-') {
      const end = text.indexOf('\n', at);
      at = end === -1 ? text.length : end;
      item += ' ';
    } else if (char === '/' && text[at + 1] === '*') {
      const end = text.indexOf('*/', at + 2);
      at = end === -1 ? text.length : end + 1;
      item += ' ';
    } else if (char === ',' && depth === 0) {
      items.push(item);
      item = '';
    } else if (char === ')' && depth === 0) {
      break;
    } else {
      if (char === '(') depth++;
      else if (char === ')') depth--;
      item += char;
    }
  }

  items.push(item);

  return items;
}

function declaredTable(ddl: string): { readonly table: string; readonly columns: readonly string[] } | null {
  const head = CREATE_TABLE.exec(ddl);

  if (head === null) return null;

  const columns = listItems(ddl, head[0].length)
    .map((item) => item.trim())
    .filter((item) => item !== '' && !TABLE_CONSTRAINT.test(item))
    .map((item) => item.split(/\s+/, 1)[0].replace(/^["`]|["`]$/g, ''));

  return { table: head[1], columns };
}

const ColumnSchema = v.object({ name: v.string() });

// IF NOT EXISTS keeps an old table.
export function resetGuardedExec(exec: RawSqlExec, read: SqlExec): RawSqlExec {
  return (ddl) => {
    const declared = declaredTable(ddl);

    if (declared !== null) {
      const present = new Set(read.exec(`PRAGMA table_info("${declared.table}")`).toArray()
        .map((row) => v.parse(ColumnSchema, row).name));

      const missing = declared.columns.filter((column) => !present.has(column));

      if (present.size > 0 && missing.length > 0) throw new StoragePredatesResetError(declared.table, missing);
    }

    exec(ddl);
  };
}
