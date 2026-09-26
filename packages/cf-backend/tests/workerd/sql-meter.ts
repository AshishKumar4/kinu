/**
 * A metered `SqlStorage`: every statement run while an operation is measured is counted by the tables it names,
 * with its cursor's `rowsRead` and `rowsWritten`, beside each table's row count and payload before and after.
 * The complexity pool meters its own stores with it, and the two-turn probe meters a production orchestrator's.
 */
import * as v from 'valibot';

/** One table's share of an operation: the rows its statements read and wrote, how many ran, and the
 *  rows they read beyond those they returned. A statement that seeks reads what it returns; one that
 *  scans reads the rest as well, and that surplus is `rowsScanned`. */
export interface TableCost {
  readonly rowsRead: number;
  readonly rowsWritten: number;
  readonly statements: number;
  readonly rowsScanned: number;
}

/** One figure per table, after minus before, nonzero only. */
export type TableChange = Readonly<Record<string, number>>;

/** An operation's whole cost. `storedRows` and `storedBytes` are each table's row count and payload
 *  bytes; `dbBytes` is the database file's, by the page. */
export interface OperationCost {
  readonly tables: Readonly<Record<string, TableCost>>;
  readonly dbBytes: number;
  readonly storedRows: TableChange;
  readonly storedBytes: TableChange;
  /** The model request bytes the operation prepared, where it prepares any. */
  readonly requestBytes: number | null;
}

/** A table a statement names; an upsert's `DO UPDATE SET` names none. */
const NAMED = /\b(?:FROM|JOIN|INTO|UPDATE(?:\s+OR\s+[A-Za-z]+)?)\s+(?!SET\b)["`[]?([A-Za-z_]\w*)/giu;

const SCHEMA = /^\s*(?:CREATE|DROP|ALTER|PRAGMA)\b/iu;

/**
 * What a statement is charged to: every table it names, jointly (`a+b`). A cursor counts the rows
 * the whole statement read, subqueries and joins included, and nothing says which table each came
 * from, so charging the first name would pin one table's rows on another.
 */
function tableOf(query: string): string {
  if (SCHEMA.test(query)) return '(schema)';

  const names = new Set([...query.matchAll(NAMED)].flatMap((match) => (match[1] === undefined ? [] : [match[1]])));

  return names.size === 0 ? '(no table)' : [...names].sort().join('+');
}

const TableName = v.object({ name: v.string() });

const RowCount = v.object({ rows: v.number() });

const ColumnName = v.object({ name: v.string() });

const PayloadBytes = v.object({ bytes: v.nullable(v.number()) });

/** The two counts a cursor keeps as it runs; read once the operation has settled. */
interface CursorCounts {
  readonly rowsRead: number;
  readonly rowsWritten: number;
}

interface MeteredStatement {
  readonly table: string;
  readonly cursor: CursorCounts;
  /** Rows the caller took out of the cursor, by any of its reads. */
  readonly returned: { rows: number };
}

const CachedQuery = v.object({ reusedCachedQueryForTest: v.boolean() });

/** `cursor`, counting every row its caller takes out of it. A class, so it stands for the cursor under either
 *  workers-types flavour: the experimental one adds `reusedCachedQueryForTest`, read here by parse. */
class CountingCursor<T extends Record<string, SqlStorageValue>> {
  readonly columnNames: string[];

  constructor(private readonly cursor: SqlStorageCursor<T>, private readonly returned: { rows: number }) {
    this.columnNames = cursor.columnNames;
  }

  get rowsRead(): number { return this.cursor.rowsRead; }

  get rowsWritten(): number { return this.cursor.rowsWritten; }

  get reusedCachedQueryForTest(): boolean { return v.parse(CachedQuery, this.cursor).reusedCachedQueryForTest; }

  next(): ReturnType<SqlStorageCursor<T>['next']> {
    const step = this.cursor.next();

    if (step.done !== true) this.returned.rows += 1;

    return step;
  }

  toArray(): T[] {
    const rows = this.cursor.toArray();

    this.returned.rows += rows.length;

    return rows;
  }

  one(): T {
    const row = this.cursor.one();

    this.returned.rows += 1;

    return row;
  }

  raw<U extends SqlStorageValue[]>(): IterableIterator<U> {
    return this.counted(this.cursor.raw<U>());
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this.counted(this.cursor[Symbol.iterator]());
  }

  private counted<Row>(rows: IterableIterator<Row>): IterableIterator<Row> {
    const iterator: IterableIterator<Row> = {
      next: () => {
        const step = rows.next();

        if (step.done !== true) this.returned.rows += 1;

        return step;
      },
      [Symbol.iterator]: () => iterator,
    };

    return iterator;
  }
}

/** The database a meter reads through: its statements and its file size, nothing else. */
export type MeteredDatabase = Pick<SqlStorage, 'exec' | 'databaseSize'>;

/** Every statement run through {@link SqlMeter.exec} while an operation is measured, with the cursor that ran it. */
export class SqlMeter {
  private open: MeteredStatement[] | null = null;

  constructor(private readonly real: MeteredDatabase) {}

  /** Runs `query` on the real database, counted when a measurement is open. */
  exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): CountingCursor<T> {
    const cursor = this.real.exec<T>(query, ...bindings);
    const returned = { rows: 0 };

    this.open?.push({ table: tableOf(query), cursor, returned });

    return new CountingCursor(cursor, returned);
  }

  private tableNames(): string[] {
    return this.real.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite%' AND substr(name, 1, 4) <> '_cf_'`)
      .toArray().map((row) => v.parse(TableName, row).name);
  }

  private rowsByTable(): Map<string, number> {
    return new Map(this.tableNames().map((name) => [name, v.parse(RowCount, this.real.exec(`SELECT count(*) AS rows FROM "${name}"`).one()).rows]));
  }

  /** Each table's stored payload, exactly: every column's encoded bytes (`octet_length`, which
   *  reads a blob's size without its content), where the page count moves 4 KiB at a time. */
  private bytesByTable(): Map<string, number> {
    return new Map(this.tableNames().map((name) => {
      const columns = this.real.exec(`SELECT name FROM pragma_table_info('${name}')`).toArray().map((row) => v.parse(ColumnName, row).name);
      const sum = columns.map((column) => `coalesce(sum(octet_length("${column}")), 0)`).join(' + ');

      return [name, v.parse(PayloadBytes, this.real.exec(`SELECT ${sum || '0'} AS bytes FROM "${name}"`).one()).bytes ?? 0];
    }));
  }

  private static grown(before: ReadonlyMap<string, number>, after: ReadonlyMap<string, number>): TableChange {
    return Object.fromEntries([...after].flatMap(([table, value]) => {
      const change = value - (before.get(table) ?? 0);

      return change === 0 ? [] : [[table, change]];
    }));
  }

  private started: { readonly rows: Map<string, number>; readonly payload: Map<string, number>; readonly bytes: number } | null = null;

  /** Counts every statement from here to {@link end}; the operation may span calls, as a queued turn does. */
  begin(): void {
    this.started = { rows: this.rowsByTable(), payload: this.bytesByTable(), bytes: this.real.databaseSize };
    this.open = [];
  }

  /** Cursors are read here, after the operation settled, so a cursor it left half-read counts the rows it read. */
  end(prepared: number | null): OperationCost {
    const ran = this.open ?? [];
    const started = this.started;

    // A cursor stays readable after its statement; statements after the operation go uncounted.
    this.open = null;
    this.started = null;

    if (started === null) throw new Error('the meter was not started');
    const tables: Record<string, { rowsRead: number; rowsWritten: number; statements: number; rowsScanned: number }> = {};

    for (const { table, cursor, returned } of ran) {
      const entry = tables[table] ??= { rowsRead: 0, rowsWritten: 0, statements: 0, rowsScanned: 0 };
      entry.rowsRead += cursor.rowsRead;
      entry.rowsWritten += cursor.rowsWritten;
      entry.statements += 1;
      entry.rowsScanned += Math.max(0, cursor.rowsRead - returned.rows);
    }

    return {
      tables,
      dbBytes: this.real.databaseSize - started.bytes,
      storedRows: SqlMeter.grown(started.rows, this.rowsByTable()),
      storedBytes: SqlMeter.grown(started.payload, this.bytesByTable()),
      requestBytes: prepared,
    };
  }

  /** Runs `operation` with every statement counted. */
  async measure(operation: () => Promise<number | null>): Promise<OperationCost> {
    this.begin();

    try {
      return this.end(await operation());
    } finally {
      this.open = null;
      this.started = null;
    }
  }
}
