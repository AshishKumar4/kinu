import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type D1Binding = string | number | bigint | boolean | null | ArrayBuffer | Uint8Array;
type NativeD1Value = string | number | bigint | boolean | null | Uint8Array;
type NativeD1Row = Record<string, NativeD1Value>;

const EMPTY_META = {
  duration: 0,
  size_after: 0,
  rows_read: 0,
  rows_written: 0,
  last_row_id: 0,
  changed_db: false,
  changes: 0,
} satisfies D1Meta;

function nativeBinding(value: D1Binding): SQLQueryBindings {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return value;
}

type NativeD1Payload = NativeD1Value | NativeD1Row | NativeD1Row[] | NativeD1Value[][];

async function jsonClone<Result>(value: NativeD1Payload): Promise<Result> {
  return new Response(JSON.stringify(value)).json<Result>();
}

function result<Result>(results: Result[]) {
  return { success: true as const, meta: EMPTY_META, results };
}

/** `onQuery` fires before each statement executes — lets tests count
 *  statements or inject concurrent writes to simulate races. */
export function makeD1(db: Database, onQuery?: (query: string) => void): D1Database {
  const prepared = (query: string, bindings: D1Binding[] = []): D1PreparedStatement => {
    async function raw<Result = NativeD1Value[]>(options: { columnNames: true }): Promise<[string[], ...Result[]]>;
    async function raw<Result = NativeD1Value[]>(options?: { columnNames?: false }): Promise<Result[]>;
    async function raw<Result = NativeD1Value[]>(options?: { columnNames?: boolean }) {
      onQuery?.(query);
      const statement = db.prepare<NativeD1Row, SQLQueryBindings[]>(query);
      const rows = statement.values(...bindings.map(nativeBinding));
      const cloned = await jsonClone<Result[]>(rows);
      if (options?.columnNames) {
        const withNames: [string[], ...Result[]] = [statement.columnNames, ...cloned];
        return withNames;
      }
      return cloned;
    }
    return {
      bind(...values: D1Binding[]) {
        return prepared(query, values);
      },
      async run<Result = NativeD1Row>() {
        onQuery?.(query);
        db.prepare(query).run(...bindings.map(nativeBinding));
        return result<Result>([]);
      },
      async first<Result = NativeD1Row>(column?: string) {
        onQuery?.(query);
        const row = db.prepare<NativeD1Row, SQLQueryBindings[]>(query).get(...bindings.map(nativeBinding));
        if (!row) return null;
        return jsonClone<Result>(column === undefined ? row : row[column] ?? null);
      },
      async all<Result = NativeD1Row>() {
        onQuery?.(query);
        const rows = db.prepare<NativeD1Row, SQLQueryBindings[]>(query).all(...bindings.map(nativeBinding));
        return result(await jsonClone<Result[]>(rows));
      },
      raw,
    };
  };

  const session: D1DatabaseSession = {
    prepare: (query) => prepared(query),
    async batch<Result = unknown>(statements: D1PreparedStatement[]) {
      return Promise.all(statements.map((statement) => statement.run<Result>()));
    },
    getBookmark: () => null,
  };

  return {
    prepare: (query) => prepared(query),
    async batch<Result = unknown>(statements: D1PreparedStatement[]) {
      return Promise.all(statements.map((statement) => statement.run<Result>()));
    },
    async exec(query) {
      const before = performance.now();
      db.exec(query);
      return { count: 1, duration: performance.now() - before };
    },
    withSession: () => session,
    async dump() {
      const serialized = db.serialize();
      const copy = new Uint8Array(serialized.byteLength);
      copy.set(serialized);
      return copy.buffer;
    },
  };
}

export function createAuthDatabase(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(join(import.meta.dir, '../../migrations/auth/0001_auth_tables.sql'), 'utf8'));
  return db;
}
