import type { Database, SQLQueryBindings } from 'bun:sqlite';
import type { WorkspaceOptions } from '@kinu.run/core/workspace';
import * as v from 'valibot';

interface NimbusSqlRow {
  [column: string]: string | number | bigint | null | ArrayBuffer | ArrayBufferView;
}

const sqlBindingSchema = v.union([
  v.string(), v.number(), v.bigint(), v.boolean(), v.null(),
  v.instance(ArrayBuffer), v.instance(Uint8Array),
]);

/** The filesystem binds BLOBs as ArrayBuffer (Cloudflare DO storage.sql's native type); bun:sqlite
 *  only binds TypedArrays, so an ArrayBuffer is viewed as one. */
export function bunSqlBinding(input: { value: unknown }): SQLQueryBindings {
  const value = v.parse(sqlBindingSchema, input.value);

  return value instanceof ArrayBuffer ? new Uint8Array(value) : value;
}

export function nimbusSql(db: Database): WorkspaceOptions['sql'] {
  const exec: WorkspaceOptions['sql']['exec'] = (query, ...bindings) => {
    const bound = bindings.map((value) => bunSqlBinding({ value }));
    const stmt = db.prepare<NimbusSqlRow, SQLQueryBindings[]>(query);

    if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) return stmt.all(...bound);
    stmt.run(...bound);

    return [];
  };

  return { exec };
}

/** `bun:sqlite` transactions; a database without one runs non-atomically, stated rather than pretended. */
export function localTransactions(db: Database): WorkspaceOptions['transactions'] {
  return {
    storage: {
      transactionSync: <T,>(callback: () => T): T => db.transaction(callback)(),
    },
  };
}
