/**
 * `db`: structured workspace data for `eval`. Never a SQL handle: every statement is compiled
 * from typed arguments against the catalogued declaration, values bound, identifiers validated
 * and quoted (spec §9.2). Uncatalogued names are unreachable by construction. A mutation's
 * `db_op` evidence is written in the same `transactionSync`; fan-out waits for commit.
 */

import * as v from 'valibot';
import type { CodemodeProvider } from './sandbox-contract';
import { TOOL_REACH } from './registry';
import { branchableToolCall } from './outcome';
import type { RawSqlExec, SqlExecutor, SqlValue } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import type { DeferredRunEvent, RunEventRecorder } from '../events/recorder';
import { KinuError, refusalOf, renderCauseChain } from '../obs/error';
import { currentWorkMode, requireWorkModePermission } from '../execution/work-mode';
import { JsonValueSchema, type JsonValue } from '../utils/json';
import { base64ToBytes, bytesToBase64 } from '../utils/base64';
import { APP_TABLE_SCOPES, type AppTableScope, type DbOpRecord } from '../types/app-store';

export {
  APP_MUTATIONS, APP_TABLE_SCOPES,
  type AppMutation, type AppTableScope, type DbOpRecord,
} from '../types/app-store';

const APP_TABLE_PREFIX = 'app_';

/** Deliberately outside `app_`, so no logical name can address the catalogue. */
const AGENT_DATA_CATALOG = 'agent_data_tables';

/** Host-injected from the bound handle; rejected as a declared column on either scope. */
const ACTOR_COLUMN = 'actor_id';

const APP_COLUMN_TYPES = ['text', 'integer', 'real', 'blob', 'json'] as const;

export type AppColumnType = (typeof APP_COLUMN_TYPES)[number];

/** `json` is TEXT encoded at the boundary; SQLite has no JSON affinity. */
const SQLITE_TYPE = {
  text: 'TEXT',
  integer: 'INTEGER',
  real: 'REAL',
  blob: 'BLOB',
  json: 'TEXT',
} satisfies Readonly<Record<AppColumnType, string>>;

const APP_COMPARISONS = ['=', '!=', '<', '<=', '>', '>=', 'like'] as const;

/** Bounds refuse with their limit, never silently clamp. */
const MAX_TABLES = 64;

const MAX_COLUMNS = 32;

const MAX_ROWS_PER_INSERT = 200;

const MAX_BATCH_OPS = 100;

const MAX_IN_VALUES = 200;

const MAX_ORDER_TERMS = 8;

const SELECT_LIMIT_DEFAULT = 100;

const SELECT_LIMIT_MAX = 1000;

/** Bound values per INSERT; longer runs are chunked, not refused. */
const MAX_BINDINGS_PER_STATEMENT = 800;

/** Re-applied in {@link quoted}, the only function that emits an identifier. */
const IDENTIFIER = /^[a-z][a-z0-9_]{0,47}$/u;

/** Drivers expose SQLite failures only by message; unrecognised errors stay `io`. */
const SQLITE_REJECTED_VALUE = /\b(constraint failed|constraint|datatype mismatch)\b/iu;

const IdentifierSchema = v.pipe(
  v.string(),
  v.regex(IDENTIFIER, 'a name must be lowercase letters, digits and underscores, start with a letter, and be at most 48 characters'),
);

const TableNameSchema = IdentifierSchema;

const ColumnNameSchema = v.pipe(
  IdentifierSchema,
  v.check(
    (name) => name !== ACTOR_COLUMN,
    `\`${ACTOR_COLUMN}\` is the host's own column on an actor-scoped table and cannot be declared, read or written`,
  ),
);

// `v.readonly()` so readonly caller specs (e.g. `as const` fixtures) type-check.
const ColumnSchema = v.pipe(v.strictObject({
  name: ColumnNameSchema,
  type: v.picklist(APP_COLUMN_TYPES),
  notNull: v.optional(v.boolean()),
  primaryKey: v.optional(v.boolean()),
  unique: v.optional(v.boolean()),
}), v.readonly());

const TableSpecSchema = v.pipe(v.strictObject({
  name: TableNameSchema,
  scope: v.picklist(APP_TABLE_SCOPES),
  columns: v.pipe(
    v.array(ColumnSchema),
    v.minLength(1, 'a table needs at least one column'),
    v.maxLength(MAX_COLUMNS, `a table may declare at most ${MAX_COLUMNS} columns`),
    v.check(
      (columns) => new Set(columns.map((column) => column.name)).size === columns.length,
      'two columns cannot share a name',
    ),
    v.readonly(),
  ),
}), v.readonly());

/** Parsed separately so `{ op: 'drop' }` is a bad predicate, not a JSON value. */
const PredicateOperationSchema = v.union([
  v.strictObject({ op: v.picklist(APP_COMPARISONS), value: JsonValueSchema }),
  v.strictObject({
    op: v.literal('in'),
    values: v.pipe(v.array(JsonValueSchema), v.maxLength(MAX_IN_VALUES, `\`in\` accepts at most ${MAX_IN_VALUES} values`)),
  }),
  v.strictObject({ op: v.picklist(['isNull', 'notNull']) }),
]);

/** Order is the contract: an object with `op` is a predicate; compare documents via `{ op: '=', value }`. */
const PredicateSchema = v.union([PredicateOperationSchema, JsonValueSchema]);

const OperatorCarrierSchema = v.object({ op: v.string() });

const WhereSchema = v.record(ColumnNameSchema, PredicateSchema);

const SelectSchema = v.strictObject({
  where: v.optional(WhereSchema),
  columns: v.optional(v.pipe(
    v.array(ColumnNameSchema),
    v.minLength(1, 'name at least one column, or omit `columns` for all of them'),
  )),
  orderBy: v.optional(v.pipe(
    v.array(v.strictObject({ column: ColumnNameSchema, dir: v.optional(v.picklist(['asc', 'desc'])) })),
    v.maxLength(MAX_ORDER_TERMS, `order by at most ${MAX_ORDER_TERMS} columns`),
  )),
  limit: v.optional(v.pipe(
    v.number(), v.integer(), v.minValue(1),
    v.maxValue(SELECT_LIMIT_MAX, `one read returns at most ${SELECT_LIMIT_MAX} rows; page with \`offset\` or narrow the query`),
  )),
  offset: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
});

const RowSchema = v.record(ColumnNameSchema, JsonValueSchema);

const OpSchema = v.variant('op', [
  v.strictObject({
    op: v.literal('insert'),
    table: TableNameSchema,
    rows: v.pipe(
      v.array(RowSchema),
      v.minLength(1, 'insert at least one row'),
      v.maxLength(MAX_ROWS_PER_INSERT, `insert at most ${MAX_ROWS_PER_INSERT} rows per operation`),
    ),
  }),
  v.strictObject({
    op: v.literal('update'),
    table: TableNameSchema,
    set: v.pipe(RowSchema, v.check((set) => Object.keys(set).length > 0, 'update needs at least one column in `set`')),
    where: WhereSchema,
  }),
  v.strictObject({ op: v.literal('delete'), table: TableNameSchema, where: WhereSchema }),
]);

const BatchSchema = v.pipe(
  v.array(OpSchema),
  v.minLength(1, 'a batch needs at least one operation'),
  v.maxLength(MAX_BATCH_OPS, `a batch runs at most ${MAX_BATCH_OPS} operations`),
);

export type AppColumn = v.InferOutput<typeof ColumnSchema>;

export type AppTableSpec = v.InferOutput<typeof TableSpecSchema>;

export type AppPredicate = v.InferOutput<typeof PredicateSchema>;

export type AppWhere = v.InferOutput<typeof WhereSchema>;

export type AppSelect = v.InferOutput<typeof SelectSchema>;

export type AppOp = v.InferOutput<typeof OpSchema>;

/** `blob` columns as base64, `json` columns decoded. */
export type AppRow = Record<string, JsonValue>;

export interface AppTableRecord extends AppTableSpec {
  readonly createdBy: string;
  readonly createdAt: number;
}

export interface AppOpResult {
  readonly op: AppOp['op'];
  readonly table: string;
  readonly rowsAffected: number;
}

export interface AppDataStore {
  /** Idempotent for an identical declaration; a different shape is `denied`. */
  createTable(spec: AppTableSpec): AppTableRecord;
  /** Refused while another actor holds rows in it. */
  dropTable(name: string): void;
  listTables(): readonly AppTableRecord[];
  schema(name: string): AppTableRecord;
  select(table: string, query?: AppSelect): AppRow[];
  count(table: string, where?: AppWhere): number;
  apply(op: AppOp): AppOpResult;
  /** All mutations land or none do. */
  batch(ops: readonly AppOp[]): AppOpResult[];
}

export interface AppDataStoreDeps {
  /** Also carries DDL, so `createTable`'s DDL and catalogue row share one transaction. */
  readonly sql: SqlExecutor;
  readonly actor: ActorHandle;
  readonly transactionSync: <T>(write: () => T) => T;
  /** Lazy: the recorder is memoised per actor and must not be forced at build. */
  readonly events: () => RunEventRecorder;
  readonly runId: () => string;
}

/** A batch failure carrying the failing operation's index. */
class AppBatchError extends KinuError {
  override readonly name = 'AppBatchError';
  constructor(readonly failedIndex: number, cause: KinuError) {
    super(cause.code, `batch operation ${failedIndex} was refused, so none of the batch landed`, { cause });
  }
}

/** Created with every workspace schema; a missing table is a fault. */
export function initAgentDataTables(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS ${AGENT_DATA_CATALOG} (
    name TEXT PRIMARY KEY,
    scope TEXT NOT NULL CHECK(scope IN ('actor','workspace')),
    columns TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
}

/** Re-validates: the grammar admits no quote character. */
function quoted(identifier: string): string {
  if (!IDENTIFIER.test(identifier)) {
    throw new KinuError('bad_input', `${identifier} is not a usable table or column name`);
  }

  return `"${identifier}"`;
}

/** Builds the tagged-template object for `SqlExecutor`; values can never land in the text. */
class Statement {
  private readonly parts: string[] = [''];
  private readonly values: SqlValue[] = [];

  text(sql: string): this {
    this.parts[this.parts.length - 1] += sql;

    return this;
  }

  value(value: SqlValue): this {
    this.values.push(value);
    this.parts.push('');

    return this;
  }

  run<Row>(sql: SqlExecutor): Row[] {
    const strings = [...this.parts];

    return sql<Row>(Object.assign(strings, { raw: strings }), ...this.values);
  }
}

function runStatement(sql: SqlExecutor, statement: Statement, doing: string): void {
  execute<unknown>(sql, statement, doing);
}

function execute<Row>(sql: SqlExecutor, statement: Statement, doing: string): Row[] {
  try {
    return statement.run<Row>(sql);
  }
  catch (cause) {
    if (cause instanceof KinuError) throw cause;
    const rendered = cause instanceof Error ? renderCauseChain(cause) : String(cause);
    throw new KinuError(SQLITE_REJECTED_VALUE.test(rendered) ? 'bad_input' : 'io', `${doing}: ${rendered}`, { cause });
  }
}

interface CatalogRow {
  readonly name: string;
  readonly scope: string;
  readonly columns: string;
  readonly created_by: string;
  readonly created_at: number;
}

const StoredColumnsSchema = v.array(ColumnSchema);

const StoredScopeSchema = v.picklist(APP_TABLE_SCOPES);

const CountSchema = v.pipe(v.number(), v.integer());

interface Resolved {
  readonly record: AppTableRecord;
  readonly physical: string;
  readonly columns: ReadonlyMap<string, AppColumn>;
}

/** Column order counts: it is part of the physical shape. */
function sameDeclaration(left: AppTableSpec, right: AppTableSpec): boolean {
  if (left.scope !== right.scope || left.columns.length !== right.columns.length) return false;

  return left.columns.every((column, index) => {
    const other = right.columns[index];

    return other !== undefined
      && column.name === other.name
      && column.type === other.type
      && (column.notNull === true) === (other.notNull === true)
      && (column.primaryKey === true) === (other.primaryKey === true)
      && (column.unique === true) === (other.unique === true);
  });
}

function renderDeclaration(spec: AppTableSpec): string {
  return spec.columns
    .map((column) => [
      `${column.name} ${column.type}`,
      column.primaryKey === true ? ' primary key' : '',
      column.unique === true ? ' unique' : '',
      column.notNull === true ? ' not null' : '',
    ].join(''))
    .join(', ');
}

const ADMITTED = {
  text: { schema: v.string(), takes: 'a string' },
  integer: { schema: v.pipe(v.number(), v.safeInteger()), takes: 'a safe integer (booleans are 0 and 1)' },
  real: { schema: v.pipe(v.number(), v.finite()), takes: 'a finite number' },
  blob: { schema: v.pipe(v.string(), v.base64()), takes: 'base64 text' },
  json: { schema: JsonValueSchema, takes: 'any JSON document' },
} satisfies Readonly<Record<AppColumnType, { readonly schema: v.GenericSchema; readonly takes: string }>>;

const SqlPrimitiveSchema = v.union([v.string(), v.number(), v.boolean(), v.null()]);

/** bun:sqlite returns BLOBs as `Uint8Array`; `undefined` for unselected columns. */
type StoredValue = SqlValue | Uint8Array | undefined;

/** Stored values outside these are corruption, named not coerced. */
const STORED = {
  text: v.string(),
  integer: v.number(),
  real: v.number(),
  // Durable Object BLOBs are ArrayBuffer, bun:sqlite Uint8Array.
  blob: v.union([v.instance(ArrayBuffer), v.instance(Uint8Array)]),
  json: v.string(),
} satisfies Readonly<Record<AppColumnType, v.GenericSchema>>;

function encodeValue(column: AppColumn, value: JsonValue, where: string): SqlValue {
  if (value === null) {
    if (column.notNull === true) {
      throw new KinuError('bad_input', `${where}: column \`${column.name}\` is declared not null`);
    }

    return null;
  }

  const admitted = ADMITTED[column.type];
  const parsed = v.safeParse(admitted.schema, value);

  if (!parsed.success) {
    throw new KinuError('bad_input', `${where}: column \`${column.name}\` is ${column.type} and takes ${admitted.takes}`);
  }

  if (column.type === 'json') return JSON.stringify(parsed.output);

  if (column.type !== 'blob') return v.parse(SqlPrimitiveSchema, parsed.output);
  const bytes = base64ToBytes(v.parse(v.string(), parsed.output));
  // Copy: `bytes.buffer` may hold more than the decoded bytes.
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);

  return buffer;
}

function decodeValue(column: AppColumn, stored: StoredValue): JsonValue {
  if (stored === null || stored === undefined) return null;
  const parsed = v.safeParse(STORED[column.type], stored);

  if (!parsed.success) {
    throw new KinuError('io', `column \`${column.name}\` is declared ${column.type} and holds something it cannot`);
  }

  switch (column.type) {
    case 'text':
      return v.parse(v.string(), parsed.output);
    case 'integer':
    case 'real':
      return v.parse(v.number(), parsed.output);
    case 'blob': {
      const bytes = v.parse(v.union([v.instance(ArrayBuffer), v.instance(Uint8Array)]), parsed.output);

      return bytesToBase64(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes);
    }

    case 'json':
      try {
        return v.parse(JsonValueSchema, JSON.parse(v.parse(v.string(), parsed.output)));
      }
      catch (cause) {
        throw new KinuError('io', `column \`${column.name}\` holds text that is not the JSON document it was stored as`, { cause });
      }
  }
}

interface AppliedOp {
  readonly result: AppOpResult;
  readonly scope: AppTableScope;
}

function createTableDdl(spec: AppTableSpec, physical: string): string {
  const scoped = spec.scope === 'actor';
  const columns: string[] = [];

  if (scoped) columns.push(`${quoted(ACTOR_COLUMN)} TEXT NOT NULL`);

  for (const column of spec.columns) {
    const notNull = column.notNull === true || column.primaryKey === true ? ' NOT NULL' : '';
    columns.push(`${quoted(column.name)} ${SQLITE_TYPE[column.type]}${notNull}`);
  }

  const declaredKey = spec.columns.filter((column) => column.primaryKey === true).map((column) => column.name);

  if (declaredKey.length > 0) {
    // Actor leads the key so agents sharing a logical key get separate rows.
    columns.push(`PRIMARY KEY (${[...(scoped ? [ACTOR_COLUMN] : []), ...declaredKey].map(quoted).join(', ')})`);
  }

  for (const column of spec.columns) {
    if (column.unique !== true || column.primaryKey === true) continue;
    // Scoped UNIQUE: a workspace-wide one would disclose other agents' private values.
    columns.push(`UNIQUE (${[...(scoped ? [ACTOR_COLUMN] : []), column.name].map(quoted).join(', ')})`);
  }

  return `CREATE TABLE IF NOT EXISTS ${quoted(physical)} (\n  ${columns.join(',\n  ')}\n)`;
}

function ownerIndexDdl(spec: AppTableSpec, physical: string): string | null {
  if (spec.scope !== 'actor') return null;

  if (spec.columns.some((column) => column.primaryKey === true)) return null;

  return `CREATE INDEX IF NOT EXISTS ${quoted(`idx_${physical}_owner`)} ON ${quoted(physical)} (${quoted(ACTOR_COLUMN)})`;
}

function parseInput<Schema extends v.GenericSchema>(
  schema: Schema,
  input: { readonly value: unknown; readonly where: string },
): v.InferOutput<Schema> {
  const parsed = v.safeParse(schema, input.value);

  if (parsed.success) return parsed.output;
  const issue = parsed.issues[0];
  const path = issue?.path?.map((segment) => String(segment.key)).join('.') ?? '';
  throw new KinuError('bad_input', `${input.where}${path === '' ? '' : ` at \`${path}\``}: ${issue?.message ?? 'invalid argument'}`);
}

export function createAppDataStore(deps: AppDataStoreDeps): AppDataStore {
  const { sql, actor, transactionSync } = deps;
  const actorId = actor.actorId;
  const catalog = quoted(AGENT_DATA_CATALOG);

  const authorize = (): void => {
    actor.assertCurrent();
  };

  const runDdl = (statement: string, doing: string): void => {
    runStatement(sql, new Statement().text(statement), doing);
  };

  const catalogRow = (name: string): CatalogRow | undefined => execute<CatalogRow>(
    sql,
    new Statement()
      .text(`SELECT name, scope, columns, created_by, created_at FROM ${catalog} WHERE name = `)
      .value(name)
      .text(' LIMIT 1'),
    'read the agent-data catalogue',
  )[0];

  const recordOf = (row: CatalogRow): AppTableRecord => ({
    name: row.name,
    scope: v.parse(StoredScopeSchema, row.scope),
    columns: v.parse(StoredColumnsSchema, JSON.parse(row.columns)),
    createdBy: row.created_by,
    createdAt: row.created_at,
  });

  const resolve = (name: string): Resolved => {
    authorize();
    const logical = parseInput(TableNameSchema, { value: name, where: 'table name' });
    const row = catalogRow(logical);

    if (row === undefined) {
      throw new KinuError('missing', `no table \`${logical}\` — declare it with db.createTable, or read db.listTables() to see what this workspace has`);
    }

    const record = recordOf(row);

    return {
      record,
      physical: `${APP_TABLE_PREFIX}${record.name}`,
      columns: new Map(record.columns.map((column) => [column.name, column])),
    };
  };

  const columnOf = (resolved: Resolved, name: string, where: string): AppColumn => {
    const column = resolved.columns.get(name);

    if (column === undefined) {
      throw new KinuError('bad_input', `${where}: table \`${resolved.record.name}\` declares no column \`${name}\` (it has ${[...resolved.columns.keys()].join(', ')})`);
    }

    return column;
  };

  /** Plan permits actor-scoped writes (spec §9.1) but not workspace-scoped ones. */
  const requirePermission = (scope: AppTableScope, operation: string): void => {
    requireWorkModePermission(currentWorkMode(), scope === 'actor', operation);
  };

  /** Scope predicate from the bound handle, never an argument. Returns whether `WHERE` is still needed. */
  const compileScope = (resolved: Resolved, statement: Statement): boolean => {
    if (resolved.record.scope !== 'actor') return true;
    statement.text(` WHERE ${quoted(ACTOR_COLUMN)} = `).value(actorId);

    return false;
  };

  const compilePredicate = (column: AppColumn, predicate: AppPredicate, statement: Statement, where: string): void => {
    const name = quoted(column.name);

    if (!v.is(OperatorCarrierSchema, predicate)) {
      const bare = parseInput(JsonValueSchema, { value: predicate, where: where });
      statement.text(`${name} = `).value(encodeValue(column, bare, where));

      return;
    }

    const operation = parseInput(PredicateOperationSchema, { value: predicate, where: where });

    switch (operation.op) {
      case 'isNull':
      case 'notNull':
        statement.text(`${name} IS ${operation.op === 'isNull' ? '' : 'NOT '}NULL`);

        return;
      case 'in': {
        if (operation.values.length === 0) {
          // Empty set compiles to `0 = 1`; dropping it would widen the statement.
          statement.text('0 = 1');

          return;
        }

        statement.text(`${name} IN (`);

        for (const [index, value] of operation.values.entries()) {
          if (index > 0) statement.text(', ');
          statement.value(encodeValue(column, value, where));
        }

        statement.text(')');

        return;
      }

      case 'like':
        if (column.type !== 'text') {
          throw new KinuError('bad_input', `${where}: \`like\` compares text, and column \`${column.name}\` is ${column.type}`);
        }

        statement.text(`${name} LIKE `).value(encodeValue(column, operation.value, where)).text(` ESCAPE '\\'`);

        return;
      case '=':
      case '!=':
      case '<':
      case '<=':
      case '>':
      case '>=':
        statement.text(`${name} ${operation.op} `).value(encodeValue(column, operation.value, where));

        return;
    }
  };

  const compileWhere = (resolved: Resolved, where: AppWhere | undefined, statement: Statement, doing: string): void => {
    let needsWhere = compileScope(resolved, statement);

    for (const [name, predicate] of Object.entries(where ?? {})) {
      const column = columnOf(resolved, name, doing);
      statement.text(needsWhere ? ' WHERE ' : ' AND ');
      needsWhere = false;
      compilePredicate(column, predicate, statement, doing);
    }
  };

  const readRows = (resolved: Resolved, query: AppSelect | undefined, doing: string): AppRow[] => {
    // Never `SELECT *`: injected `actor_id` must not be readable.
    const columns = query?.columns === undefined
      ? resolved.record.columns
      : query.columns.map((name) => columnOf(resolved, name, doing));

    const statement = new Statement()
      .text(`SELECT ${columns.map((column) => quoted(column.name)).join(', ')} FROM ${quoted(resolved.physical)}`);

    compileWhere(resolved, query?.where, statement, doing);
    const orderBy = query?.orderBy ?? [];

    if (orderBy.length > 0) {
      statement.text(' ORDER BY ');

      for (const [index, term] of orderBy.entries()) {
        const column = columnOf(resolved, term.column, doing);

        if (index > 0) statement.text(', ');
        statement.text(`${quoted(column.name)} ${term.dir === 'desc' ? 'DESC' : 'ASC'}`);
      }
    }

    statement.text(' LIMIT ').value(query?.limit ?? SELECT_LIMIT_DEFAULT);

    if (query?.offset !== undefined) statement.text(' OFFSET ').value(query.offset);

    return execute<Record<string, StoredValue>>(sql, statement, doing).map((row) => {
      const decoded: AppRow = {};

      for (const column of columns) decoded[column.name] = decodeValue(column, row[column.name]);

      return decoded;
    });
  };

  /** One INSERT per consecutive run of same-signature rows; preserves rowid order. */
  const insertRows = (resolved: Resolved, rows: readonly AppRow[], doing: string): number => {
    const scoped = resolved.record.scope === 'actor';
    let written = 0;
    let index = 0;

    while (index < rows.length) {
      const first = rows[index];

      if (first === undefined) break;
      const names = Object.keys(first);
      const columns = names.map((name) => columnOf(resolved, name, doing));

      const absent = resolved.record.columns.find(
        (column) => column.notNull === true && !Object.hasOwn(first, column.name),
      );

      if (absent !== undefined) {
        throw new KinuError('bad_input', `${doing}: column \`${absent.name}\` is declared not null and row ${index} omits it`);
      }

      const signature = names.join('\u0000');
      const perRow = columns.length + (scoped ? 1 : 0);
      const maxTuples = Math.max(1, Math.floor(MAX_BINDINGS_PER_STATEMENT / Math.max(1, perRow)));
      const heading = [...(scoped ? [quoted(ACTOR_COLUMN)] : []), ...columns.map((column) => quoted(column.name))];

      const statement = new Statement()
        .text(`INSERT INTO ${quoted(resolved.physical)} (${heading.join(', ')}) VALUES `);

      let tuples = 0;

      while (index < rows.length && tuples < maxTuples) {
        const row = rows[index];

        if (row === undefined || Object.keys(row).join('\u0000') !== signature) break;
        statement.text(tuples > 0 ? ', (' : '(');

        if (scoped) statement.value(actorId);

        for (const [position, column] of columns.entries()) {
          if (position > 0 || scoped) statement.text(', ');
          const value = row[column.name];

          statement.value(encodeValue(column, value === undefined ? null : value, `${doing}: row ${index}`));
        }

        statement.text(')');
        tuples += 1;
        index += 1;
      }

      // `RETURNING` carries the row count; `SqlExecutor` returns no change count.
      statement.text(' RETURNING 1');
      written += execute<unknown>(sql, statement, doing).length;
    }

    return written;
  };

  const applyOp = (op: AppOp, doing: string): AppliedOp => {
    const resolved = resolve(op.table);
    requirePermission(resolved.record.scope, `db.${op.op} on a ${resolved.record.scope}-scope table`);

    if (op.op === 'insert') {
      return {
        result: { op: 'insert', table: resolved.record.name, rowsAffected: insertRows(resolved, op.rows, doing) },
        scope: resolved.record.scope,
      };
    }

    const statement = new Statement();

    if (op.op === 'update') {
      statement.text(`UPDATE ${quoted(resolved.physical)} SET `);

      for (const [position, [name, value]] of Object.entries(op.set).entries()) {
        const column = columnOf(resolved, name, doing);

        if (position > 0) statement.text(', ');
        statement.text(`${quoted(column.name)} = `).value(encodeValue(column, value, doing));
      }
    }
    else statement.text(`DELETE FROM ${quoted(resolved.physical)}`);
    compileWhere(resolved, op.where, statement, doing);
    statement.text(' RETURNING 1');

    return {
      result: { op: op.op, table: resolved.record.name, rowsAffected: execute<unknown>(sql, statement, doing).length },
      scope: resolved.record.scope,
    };
  };

  const commit = <T>(work: (record: (event: DbOpRecord) => void) => T): T => {
    const pending: DeferredRunEvent[] = [];
    let runId: string | undefined;

    const result = transactionSync(() => {
      pending.length = 0;

      return work((event) => {
        runId ??= deps.runId();
        pending.push(deps.events().emitDeferred(runId, { type: 'db_op', ...event }));
      });
    });

    for (const deferred of pending) deferred.publish();

    return result;
  };

  return {
    createTable(spec) {
      authorize();
      const declared = parseInput(TableSpecSchema, { value: spec, where: 'db.createTable(spec)' });
      const physical = `${APP_TABLE_PREFIX}${declared.name}`;
      const doing = `db.createTable(${declared.name})`;
      const existing = catalogRow(declared.name);

      if (existing !== undefined) {
        const record = recordOf(existing);

        if (!sameDeclaration(record, declared)) {
          throw new KinuError('denied', `table \`${declared.name}\` already exists as ${record.scope}-scope (${renderDeclaration(record)}) and re-declaring it does not migrate it; use another name`);
        }

        return commit(() => {
          // Self-healing: a catalogued table must exist physically.
          runDdl(createTableDdl(record, physical), doing);
          const index = ownerIndexDdl(record, physical);

          if (index !== null) runDdl(index, doing);

          return record;
        });
      }

      requirePermission(declared.scope, `db.createTable of a ${declared.scope}-scope table`);

      const tables = v.parse(
        CountSchema,
        execute<{ n: number }>(sql, new Statement().text(`SELECT COUNT(*) AS n FROM ${catalog}`), doing)[0]?.n ?? 0,
      );

      if (tables >= MAX_TABLES) {
        throw new KinuError('denied', `this workspace already holds ${tables} agent tables, which is the maximum; drop one before declaring another`);
      }

      const claimed = execute<{ name: string }>(
        sql,
        new Statement()
          .text(`SELECT name FROM sqlite_master WHERE type IN ('table', 'view', 'index', 'trigger') AND name = `)
          .value(physical),
        doing,
      );

      if (claimed.length > 0) {
        // Never adopt an uncatalogued physical object as agent data.
        throw new KinuError('denied', `\`${physical}\` already exists in this database outside the agent-data catalogue, so it is not agent data and this will not adopt it as such`);
      }

      const record: AppTableRecord = { ...declared, createdBy: actorId, createdAt: Date.now() };

      return commit((record_) => {
        runDdl(createTableDdl(record, physical), doing);
        const index = ownerIndexDdl(record, physical);

        if (index !== null) runDdl(index, doing);
        runStatement(
          sql,
          new Statement()
            .text(`INSERT INTO ${catalog} (name, scope, columns, created_by, created_at) VALUES (`)
            .value(record.name).text(', ')
            .value(record.scope).text(', ')
            .value(JSON.stringify(record.columns)).text(', ')
            .value(record.createdBy).text(', ')
            .value(record.createdAt).text(')'),
          doing,
        );
        record_({ op: 'createTable', table: record.name, scope: record.scope, rowsAffected: 0, batch: null });

        return record;
      });
    },

    dropTable(name) {
      const resolved = resolve(name);
      const doing = `db.dropTable(${resolved.record.name})`;
      // Build-only on either scope: dropping affects the whole workspace.
      requireWorkModePermission(currentWorkMode(), false, doing);

      if (resolved.record.createdBy !== actorId) {
        throw new KinuError('denied', `table \`${resolved.record.name}\` was declared by another agent (${resolved.record.createdBy}); delete your own rows instead`);
      }

      if (resolved.record.scope === 'actor') {
        const siblings = v.parse(CountSchema, execute<{ n: number }>(
          sql,
          new Statement()
            .text(`SELECT COUNT(*) AS n FROM ${quoted(resolved.physical)} WHERE ${quoted(ACTOR_COLUMN)} != `)
            .value(actorId),
          doing,
        )[0]?.n ?? 0);

        if (siblings > 0) {
          throw new KinuError('denied', `\`${resolved.record.name}\` is ONE physical table and holds ${siblings} row(s) belonging to other agents; dropping it would delete their private rows, so it stays. Delete your own rows instead`);
        }
      }

      commit((record) => {
        runDdl(`DROP TABLE IF EXISTS ${quoted(resolved.physical)}`, doing);
        runStatement(
          sql,
          new Statement().text(`DELETE FROM ${catalog} WHERE name = `).value(resolved.record.name),
          doing,
        );
        record({ op: 'dropTable', table: resolved.record.name, scope: resolved.record.scope, rowsAffected: 0, batch: null });
      });
    },

    listTables() {
      authorize();

      return execute<CatalogRow>(
        sql,
        new Statement().text(`SELECT name, scope, columns, created_by, created_at FROM ${catalog} ORDER BY created_at ASC, name ASC`),
        'db.listTables()',
      ).map(recordOf);
    },

    schema(name) {
      return resolve(name).record;
    },

    select(table, query) {
      const doing = `db.select(${table})`;

      return readRows(resolve(table), query, doing);
    },

    count(table, where) {
      const doing = `db.count(${table})`;
      const resolved = resolve(table);
      const statement = new Statement().text(`SELECT COUNT(*) AS n FROM ${quoted(resolved.physical)}`);
      compileWhere(resolved, where, statement, doing);

      return v.parse(CountSchema, execute<{ n: number }>(sql, statement, doing)[0]?.n ?? 0);
    },

    apply(op) {
      authorize();
      const doing = `db.${op.op}(${op.table})`;

      return commit((record) => {
        const applied = applyOp(op, doing);
        record({
          op: applied.result.op,
          table: applied.result.table,
          scope: applied.scope,
          rowsAffected: applied.result.rowsAffected,
          batch: null,
        });

        return applied.result;
      });
    },

    batch(ops) {
      authorize();

      return commit((record) => {
        const results: AppOpResult[] = [];

        for (const [index, op] of ops.entries()) {
          const doing = `db.batch operation ${index} (${op.op} ${op.table})`;

          try {
            const applied = applyOp(op, doing);
            record({
              op: applied.result.op,
              table: applied.result.table,
              scope: applied.scope,
              rowsAffected: applied.result.rowsAffected,
              batch: ops.length,
            });
            results.push(applied.result);
          }
          catch (cause) {
            // Rethrown: the throw rolls back the whole batch, evidence included.
            throw cause instanceof KinuError ? new AppBatchError(index, cause) : cause;
          }
        }

        return results;
      });
    },
  };
}

/** Lives here, not in a prompt section, so it ships only where the provider is wired. */
const DB_TYPES = `type DbValue = null | boolean | number | string | DbValue[] | { [key: string]: DbValue };
type DbColumnType = 'text' | 'integer' | 'real' | 'blob' | 'json';
type DbColumn = { name: string; type: DbColumnType; notNull?: boolean; primaryKey?: boolean; unique?: boolean };
type DbTable = { name: string; scope: 'actor' | 'workspace'; columns: DbColumn[]; createdBy: string; createdAt: number };
type DbPredicate = DbValue
  | { op: '=' | '!=' | '<' | '<=' | '>' | '>=' | 'like'; value: DbValue }
  | { op: 'in'; values: DbValue[] }
  | { op: 'isNull' | 'notNull' };
type DbWhere = { [column: string]: DbPredicate };
type DbQuery = { where?: DbWhere; columns?: string[]; orderBy?: { column: string; dir?: 'asc' | 'desc' }[]; limit?: number; offset?: number };
type DbWrite =
  | { op: 'insert'; table: string; rows: { [column: string]: DbValue }[] }
  | { op: 'update'; table: string; set: { [column: string]: DbValue }; where: DbWhere }
  | { op: 'delete'; table: string; where: DbWhere };
/**
 * Tables in this workspace's database: rows you filter, sort, count and update. No operation takes SQL;
 * each statement is built from these arguments against the table's declared columns. \`scope: 'actor'\`
 * rows are yours alone, \`scope: 'workspace'\` rows are shared with every agent here. A refusal is
 * \`{ reason, error }\`. \`where: {}\` matches every row you can reach; an object with \`op\` is a predicate,
 * so compare a JSON document with \`{ op: '=', value: { … } }\`.
 */
export declare const db: {
  /** Re-declaring the same shape does nothing; a different shape under an existing name is refused.
   *  \`blob\` columns take and return base64, \`json\` columns any JSON document. */
  createTable(spec: { name: string; scope: 'actor' | 'workspace'; columns: DbColumn[] }): Promise<DbTable>;
  listTables(): Promise<DbTable[]>;
  schema(table: string): Promise<DbTable>;
  /** ${SELECT_LIMIT_DEFAULT} rows unless \`limit\` says otherwise, at most ${SELECT_LIMIT_MAX}; page with \`offset\`. */
  select(table: string, query?: DbQuery): Promise<{ [column: string]: DbValue }[]>;
  count(table: string, where?: DbWhere): Promise<number>;
  /** Up to ${MAX_ROWS_PER_INSERT} rows per call. */
  insert(table: string, rows: { [column: string]: DbValue }[]): Promise<{ rowsAffected: number }>;
  update(table: string, set: { [column: string]: DbValue }, where: DbWhere): Promise<{ rowsAffected: number }>;
  deleteRows(table: string, where: DbWhere): Promise<{ rowsAffected: number }>;
  /** Up to ${MAX_BATCH_OPS} writes in one transaction: all land or none does; \`failedIndex\` names the one that failed. */
  batch(ops: DbWrite[]): Promise<{ rowsAffected: number }[] | { reason: string; error: string; failedIndex: number }>;
  /** Drop a table you declared, with its rows. */
  dropTable(table: string): Promise<{ ok: true }>;
};`;

/** `planAllowed` marks members that can run on Plan; the store decides per call by scope. */
export function createDbCodemodeProvider(store: AppDataStore): CodemodeProvider {
  return {
    name: TOOL_REACH.db.codemode,
    types: DB_TYPES,
    positionalArgs: true,
    tools: {
      createTable: {
        planAllowed: true,
        description: 'Declare a table: db.createTable({ name, scope: "actor" | "workspace", columns }).',
        execute: (...args) => branchableToolCall(async () => store.createTable(
          parseInput(TableSpecSchema, { value: args[0], where: 'db.createTable(spec)' }),
        )),
      },
      listTables: {
        planAllowed: true,
        description: 'List this workspace\'s tables with their scope and who declared each.',
        execute: () => branchableToolCall(async () => [...store.listTables()]),
      },
      schema: {
        planAllowed: true,
        description: 'Read one table\'s column declaration.',
        execute: (...args) => branchableToolCall(async () => store.schema(
          parseInput(TableNameSchema, { value: args[0], where: 'db.schema(table)' }),
        )),
      },
      select: {
        planAllowed: true,
        description: 'Read rows: db.select(table, { where?, columns?, orderBy?, limit?, offset? }).',
        execute: (...args) => branchableToolCall(async () => store.select(
          parseInput(TableNameSchema, { value: args[0], where: 'db.select(table, query?)' }),
          args[1] === undefined ? undefined : parseInput(SelectSchema, { value: args[1], where: 'db.select(table, query?)' }),
        )),
      },
      count: {
        planAllowed: true,
        description: 'Count matching rows: db.count(table, where?).',
        execute: (...args) => branchableToolCall(async () => store.count(
          parseInput(TableNameSchema, { value: args[0], where: 'db.count(table, where?)' }),
          args[1] === undefined ? undefined : parseInput(WhereSchema, { value: args[1], where: 'db.count(table, where?)' }),
        )),
      },
      insert: {
        planAllowed: true,
        description: 'Insert rows: db.insert(table, rows).',
        execute: (...args) => branchableToolCall(async () => ({
          rowsAffected: store.apply(parseInput(OpSchema, {
            value: { op: 'insert', table: args[0], rows: args[1] },
            where: 'db.insert(table, rows)',
          })).rowsAffected,
        })),
      },
      update: {
        planAllowed: true,
        description: 'Update matching rows: db.update(table, set, where).',
        execute: (...args) => branchableToolCall(async () => ({
          rowsAffected: store.apply(parseInput(OpSchema, {
            value: { op: 'update', table: args[0], set: args[1], where: args[2] },
            where: 'db.update(table, set, where)',
          })).rowsAffected,
        })),
      },
      // Not `delete`: codemode registers reserved words as `delete_`, breaking hosted calls
      // (see `cf-backend/tests/workerd/db-capability.test.ts`).
      deleteRows: {
        planAllowed: true,
        description: 'Delete matching rows: db.deleteRows(table, where).',
        execute: (...args) => branchableToolCall(async () => ({
          rowsAffected: store.apply(parseInput(OpSchema, {
            value: { op: 'delete', table: args[0], where: args[1] },
            where: 'db.deleteRows(table, where)',
          })).rowsAffected,
        })),
      },
      batch: {
        planAllowed: true,
        description: 'Run several writes in one all-or-nothing transaction: db.batch(ops).',
        execute: async (...args) => {
          try {
            return store.batch(parseInput(BatchSchema, { value: args[0], where: 'db.batch(ops)' }))
              .map((result) => ({ rowsAffected: result.rowsAffected }));
          }
          catch (cause) {
            // Not `branchableToolCall`: that helper cannot carry `failedIndex`.
            if (cause instanceof AppBatchError) return { ...refusalOf(cause), failedIndex: cause.failedIndex };

            if (cause instanceof KinuError) return refusalOf(cause);
            throw cause;
          }
        },
      },
      dropTable: {
        planAllowed: false,
        description: 'Retire a table you declared, with its rows.',
        execute: (...args) => branchableToolCall(async () => {
          store.dropTable(parseInput(TableNameSchema, { value: args[0], where: 'db.dropTable(table)' }));

          return { ok: true };
        }),
      },
    },
  };
}
