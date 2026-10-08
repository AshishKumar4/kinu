/**
 * `db`: structured workspace data for `eval`. Never a SQL handle: every statement is compiled
 * from typed arguments against the catalogued declaration, values bound, identifiers validated
 * and quoted (spec §9.2). Uncatalogued names are unreachable by construction. A mutation's
 * `db_op` evidence is written in the same `transactionSync`; fan-out waits for commit.
 */

import { Effect } from 'effect';
import * as v from 'valibot';
import type { CodemodeProvider } from '../types/codemode';
import { serve } from '../operations/operation';
import {
  ACTOR_COLUMN, ColumnSchema, DB, IDENTIFIER, OperatorCarrierSchema, OpSchema, PredicateOperationSchema, PredicateSchema,
  SELECT_LIMIT_DEFAULT, SelectSchema, TableNameSchema, TableSpecSchema, WhereSchema, type AppColumnType,
} from '../operations/db';
import { codemodeNamespace } from './operation-surfaces';
import type { RawSqlExec, SqlExecutor, SqlValue } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import type { DeferredRunEvent, RunEventRecorder } from '../events/recorder';
import { KinuError, renderCauseChain } from '../obs/error';
import { settleSync } from '../obs/effect';
import { currentWorkMode, workModeRefusal } from '../execution/work-mode';
import { JsonValueSchema, parseJsonValue, type JsonValue } from '../utils/json';
import { base64ToBytes, bytesToBase64 } from '../utils/base64';
import { APP_TABLE_SCOPES, type AppTableScope, type DbOpRecord } from '../types/app-store';
import type { ForkAppData } from '../identity/fork-sections';

export {
  APP_MUTATIONS, APP_TABLE_SCOPES,
  type AppMutation, type AppTableScope, type DbOpRecord,
} from '../types/app-store';

const APP_TABLE_PREFIX = 'app_';

/** Deliberately outside `app_`, so no logical name can address the catalogue. */
const AGENT_DATA_CATALOG = 'agent_data_tables';


/** `json` is TEXT encoded at the boundary; SQLite has no JSON affinity. */
const SQLITE_TYPE = {
  text: 'TEXT',
  integer: 'INTEGER',
  real: 'REAL',
  blob: 'BLOB',
  json: 'TEXT',
} satisfies Readonly<Record<AppColumnType, string>>;


/** Bounds refuse with their limit, never silently clamp. */
const MAX_TABLES = 64;


/** Bound values per INSERT; longer runs are chunked, not refused. */
const MAX_BINDINGS_PER_STATEMENT = 800;


/** Drivers expose SQLite failures only by message; unrecognised errors stay `io`. */
const SQLITE_REJECTED_VALUE = /\b(constraint failed|constraint|datatype mismatch)\b/iu;


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
  /** The store as a workspace fork reads and lands it. */
  readonly fork: ForkAppData;
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
function quoted(identifier: string): Effect.Effect<string, KinuError> {
  return IDENTIFIER.test(identifier)
    ? Effect.succeed(`"${identifier}"`)
    : Effect.fail(new KinuError('bad_input', `${identifier} is not a usable table or column name`));
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

function runStatement(sql: SqlExecutor, statement: Statement, doing: string): Effect.Effect<void, KinuError> {
  return Effect.asVoid(execute<unknown>(sql, statement, doing));
}

function classified<A>(call: () => A): Effect.Effect<A, KinuError> {
  return Effect.try({ try: call, catch: (cause) => ({ cause }) }).pipe(
    Effect.catch((failed) => (failed.cause instanceof KinuError ? Effect.fail(failed.cause) : Effect.die(failed.cause))),
  );
}

function execute<Row>(sql: SqlExecutor, statement: Statement, doing: string): Effect.Effect<Row[], KinuError> {
  return Effect.try({
    try: () => statement.run<Row>(sql),
    catch: (cause) => {
      if (cause instanceof KinuError) return cause;
      const rendered = cause instanceof Error ? renderCauseChain(cause) : String(cause);

      return new KinuError(SQLITE_REJECTED_VALUE.test(rendered) ? 'bad_input' : 'io', `${doing}: ${rendered}`, { cause });
    },
  });
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

function encodeValue(column: AppColumn, value: JsonValue, where: string): Effect.Effect<SqlValue, KinuError> {
  if (value === null) {
    return column.notNull === true
      ? Effect.fail(new KinuError('bad_input', `${where}: column \`${column.name}\` is declared not null`))
      : Effect.succeed(null);
  }

  const admitted = ADMITTED[column.type];
  const parsed = v.safeParse(admitted.schema, value);

  if (!parsed.success) {
    return Effect.fail(new KinuError('bad_input', `${where}: column \`${column.name}\` is ${column.type} and takes ${admitted.takes}`));
  }

  return Effect.sync((): SqlValue => {
    if (column.type === 'json') return JSON.stringify(parsed.output);

    if (column.type !== 'blob') return v.parse(SqlPrimitiveSchema, parsed.output);
    const bytes = base64ToBytes(v.parse(v.string(), parsed.output));
    // Copy: `bytes.buffer` may hold more than the decoded bytes.
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);

    return buffer;
  });
}

function decodeValue(column: AppColumn, stored: StoredValue): Effect.Effect<JsonValue, KinuError> {
  if (stored === null || stored === undefined) return Effect.succeed(null);
  const parsed = v.safeParse(STORED[column.type], stored);

  if (!parsed.success) {
    return Effect.fail(new KinuError('io', `column \`${column.name}\` is declared ${column.type} and holds something it cannot`));
  }

  switch (column.type) {
    case 'text':
      return Effect.sync(() => v.parse(v.string(), parsed.output));
    case 'integer':
    case 'real':
      return Effect.sync(() => v.parse(v.number(), parsed.output));
    case 'blob':
      return Effect.sync(() => {
        const bytes = v.parse(v.union([v.instance(ArrayBuffer), v.instance(Uint8Array)]), parsed.output);

        return bytesToBase64(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes);
      });
    case 'json':
      return Effect.try({
        try: () => v.parse(JsonValueSchema, JSON.parse(v.parse(v.string(), parsed.output))),
        catch: (cause) => new KinuError('io', `column \`${column.name}\` holds text that is not the JSON document it was stored as`, { cause }),
      });
  }
}

interface AppliedOp {
  readonly result: AppOpResult;
  readonly scope: AppTableScope;
}

const quotedAll = (names: readonly string[]): Effect.Effect<string, KinuError> =>
  Effect.map(Effect.forEach(names, quoted), (list) => list.join(', '));

function createTableDdl(spec: AppTableSpec, physical: string): Effect.Effect<string, KinuError> {
  return Effect.gen(function* () {
    const scoped = spec.scope === 'actor';
    const columns: string[] = [];

    if (scoped) columns.push(`${yield* quoted(ACTOR_COLUMN)} TEXT NOT NULL`);

    for (const column of spec.columns) {
      const notNull = column.notNull === true || column.primaryKey === true ? ' NOT NULL' : '';
      columns.push(`${yield* quoted(column.name)} ${SQLITE_TYPE[column.type]}${notNull}`);
    }

    const declaredKey = spec.columns.filter((column) => column.primaryKey === true).map((column) => column.name);

    if (declaredKey.length > 0) {
      // Actor leads the key so agents sharing a logical key get separate rows.
      columns.push(`PRIMARY KEY (${yield* quotedAll([...(scoped ? [ACTOR_COLUMN] : []), ...declaredKey])})`);
    }

    for (const column of spec.columns) {
      if (column.unique !== true || column.primaryKey === true) continue;
      // Scoped UNIQUE: a workspace-wide one would disclose other agents' private values.
      columns.push(`UNIQUE (${yield* quotedAll([...(scoped ? [ACTOR_COLUMN] : []), column.name])})`);
    }

    return `CREATE TABLE IF NOT EXISTS ${yield* quoted(physical)} (\n  ${columns.join(',\n  ')}\n)`;
  });
}

function ownerIndexDdl(spec: AppTableSpec, physical: string): Effect.Effect<string | null, KinuError> {
  if (spec.scope !== 'actor') return Effect.succeed(null);

  if (spec.columns.some((column) => column.primaryKey === true)) return Effect.succeed(null);

  return Effect.gen(function* () {
    return `CREATE INDEX IF NOT EXISTS ${yield* quoted(`idx_${physical}_owner`)} ON ${yield* quoted(physical)} (${yield* quoted(ACTOR_COLUMN)})`;
  });
}

function parseInput<Schema extends v.GenericSchema>(
  schema: Schema,
  input: { readonly value: unknown; readonly where: string },
): Effect.Effect<v.InferOutput<Schema>, KinuError> {
  const parsed = v.safeParse(schema, input.value);

  if (parsed.success) return Effect.succeed(parsed.output);
  const issue = parsed.issues[0];
  const path = issue?.path?.map((segment) => String(segment.key)).join('.') ?? '';

  return Effect.fail(new KinuError('bad_input', `${input.where}${path === '' ? '' : ` at \`${path}\``}: ${issue?.message ?? 'invalid argument'}`));
}

export function createAppDataStore(deps: AppDataStoreDeps): AppDataStore {
  const { sql, actor, transactionSync } = deps;
  const actorId = actor.actorId;
  const catalog = `"${AGENT_DATA_CATALOG}"`;

  const authorized = (): Effect.Effect<void, KinuError> => classified(() => actor.assertCurrent());

  const runDdl = (statement: string, doing: string): Effect.Effect<void, KinuError> =>
    runStatement(sql, new Statement().text(statement), doing);

  const catalogRow = (name: string): Effect.Effect<CatalogRow | undefined, KinuError> => Effect.map(execute<CatalogRow>(
    sql,
    new Statement()
      .text(`SELECT name, scope, columns, created_by, created_at FROM ${catalog} WHERE name = `)
      .value(name)
      .text(' LIMIT 1'),
    'read the agent-data catalogue',
  ), (rows) => rows[0]);

  const recordOf = (row: CatalogRow): AppTableRecord => ({
    name: row.name,
    scope: v.parse(StoredScopeSchema, row.scope),
    columns: v.parse(StoredColumnsSchema, JSON.parse(row.columns)),
    createdBy: row.created_by,
    createdAt: row.created_at,
  });

  const catalogRows = (doing: string): Effect.Effect<AppTableRecord[], KinuError> => Effect.map(execute<CatalogRow>(
    sql, new Statement().text(`SELECT name, scope, columns, created_by, created_at FROM ${catalog} ORDER BY created_at ASC, name ASC`), doing,
  ), (rows) => rows.map(recordOf));

  const resolve = (name: string): Effect.Effect<Resolved, KinuError> => Effect.gen(function* () {
    yield* authorized();
    const logical = yield* parseInput(TableNameSchema, { value: name, where: 'table name' });
    const row = yield* catalogRow(logical);

    if (row === undefined) {
      return yield* new KinuError('missing', `no table \`${logical}\`: declare it with db.createTable, or read db.listTables() to see what this workspace has`);
    }

    const record = recordOf(row);

    const resolved: Resolved = {
      record,
      physical: `${APP_TABLE_PREFIX}${record.name}`,
      columns: new Map(record.columns.map((column) => [column.name, column])),
    };

    return resolved;
  });

  const columnOf = (resolved: Resolved, name: string, where: string): Effect.Effect<AppColumn, KinuError> => {
    const column = resolved.columns.get(name);

    return column === undefined
      ? Effect.fail(new KinuError('bad_input', `${where}: table \`${resolved.record.name}\` declares no column \`${name}\` (it has ${[...resolved.columns.keys()].join(', ')})`))
      : Effect.succeed(column);
  };

  /** Plan permits actor-scoped writes (spec §9.1) but not workspace-scoped ones. */
  const permitted = (planAllowed: boolean, operation: string): Effect.Effect<void, KinuError> => {
    const refusal = workModeRefusal(currentWorkMode(), planAllowed, operation);

    return refusal === null ? Effect.void : Effect.fail(new KinuError(refusal.reason, refusal.error));
  };

  /** Scope predicate from the bound handle, never an argument. Returns whether `WHERE` is still needed. */
  const compileScope = (resolved: Resolved, statement: Statement): Effect.Effect<boolean, KinuError> => {
    if (resolved.record.scope !== 'actor') return Effect.succeed(true);

    return Effect.map(quoted(ACTOR_COLUMN), (column) => {
      statement.text(` WHERE ${column} = `).value(actorId);

      return false;
    });
  };

  const compilePredicate = (
    column: AppColumn,
    predicate: AppPredicate,
    statement: Statement,
    where: string,
  ): Effect.Effect<void, KinuError> => Effect.gen(function* () {
    const name = yield* quoted(column.name);

    if (!v.is(OperatorCarrierSchema, predicate)) {
      const bare = yield* parseInput(JsonValueSchema, { value: predicate, where: where });
      statement.text(`${name} = `).value(yield* encodeValue(column, bare, where));

      return;
    }

    const operation = yield* parseInput(PredicateOperationSchema, { value: predicate, where: where });

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
          statement.value(yield* encodeValue(column, value, where));
        }

        statement.text(')');

        return;
      }

      case 'like':
        if (column.type !== 'text') {
          return yield* new KinuError('bad_input', `${where}: \`like\` compares text, and column \`${column.name}\` is ${column.type}`);
        }

        statement.text(`${name} LIKE `).value(yield* encodeValue(column, operation.value, where)).text(` ESCAPE '\\'`);

        return;
      case '=':
      case '!=':
      case '<':
      case '<=':
      case '>':
      case '>=':
        statement.text(`${name} ${operation.op} `).value(yield* encodeValue(column, operation.value, where));

        return;
    }
  });

  const compileWhere = (resolved: Resolved, where: AppWhere | undefined, statement: Statement, doing: string): Effect.Effect<void, KinuError> => Effect.gen(function* () {
    let needsWhere = yield* compileScope(resolved, statement);

    for (const [name, predicate] of Object.entries(where ?? {})) {
      const column = yield* columnOf(resolved, name, doing);
      statement.text(needsWhere ? ' WHERE ' : ' AND ');
      needsWhere = false;
      yield* compilePredicate(column, predicate, statement, doing);
    }
  });

  const readRows = (resolved: Resolved, query: AppSelect | undefined, doing: string): Effect.Effect<AppRow[], KinuError> => Effect.gen(function* () {
    // Never `SELECT *`: injected `actor_id` must not be readable.
    const columns = query?.columns === undefined
      ? resolved.record.columns
      : yield* Effect.forEach(query.columns, (name) => columnOf(resolved, name, doing));

    const statement = new Statement()
      .text(`SELECT ${yield* quotedAll(columns.map((column) => column.name))} FROM ${yield* quoted(resolved.physical)}`);

    yield* compileWhere(resolved, query?.where, statement, doing);
    const orderBy = query?.orderBy ?? [];

    if (orderBy.length > 0) {
      statement.text(' ORDER BY ');

      for (const [index, term] of orderBy.entries()) {
        const column = yield* columnOf(resolved, term.column, doing);

        if (index > 0) statement.text(', ');
        statement.text(`${yield* quoted(column.name)} ${term.dir === 'desc' ? 'DESC' : 'ASC'}`);
      }
    }

    statement.text(' LIMIT ').value(query?.limit ?? SELECT_LIMIT_DEFAULT);

    if (query?.offset !== undefined) statement.text(' OFFSET ').value(query.offset);

    const rows = yield* execute<Record<string, StoredValue>>(sql, statement, doing);

    return yield* Effect.forEach(rows, (row) => decodedRow(columns, row));
  });

  const decodedRow = (columns: readonly AppColumn[], row: Readonly<Record<string, StoredValue>>): Effect.Effect<AppRow, KinuError> => Effect.gen(function* () {
    const decoded: AppRow = {};

    for (const column of columns) decoded[column.name] = yield* decodeValue(column, row[column.name]);

    return decoded;
  });

  /** One INSERT per consecutive run of same-signature rows; preserves rowid order. */
  const insertRows = (resolved: Resolved, rows: readonly AppRow[], doing: string): Effect.Effect<number, KinuError> => Effect.gen(function* () {
    const scoped = resolved.record.scope === 'actor';
    let written = 0;
    let index = 0;

    while (index < rows.length) {
      const first = rows[index];

      if (first === undefined) break;
      const names = Object.keys(first);
      const columns = yield* Effect.forEach(names, (name) => columnOf(resolved, name, doing));

      const absent = resolved.record.columns.find(
        (column) => column.notNull === true && !Object.hasOwn(first, column.name),
      );

      if (absent !== undefined) {
        return yield* new KinuError('bad_input', `${doing}: column \`${absent.name}\` is declared not null and row ${index} omits it`);
      }

      const signature = names.join('\u0000');
      const perRow = columns.length + (scoped ? 1 : 0);
      const maxTuples = Math.max(1, Math.floor(MAX_BINDINGS_PER_STATEMENT / Math.max(1, perRow)));
      const heading = yield* quotedAll([...(scoped ? [ACTOR_COLUMN] : []), ...columns.map((column) => column.name)]);

      const statement = new Statement()
        .text(`INSERT INTO ${yield* quoted(resolved.physical)} (${heading}) VALUES `);

      let tuples = 0;

      while (index < rows.length && tuples < maxTuples) {
        const row = rows[index];

        if (row === undefined || Object.keys(row).join('\u0000') !== signature) break;
        statement.text(tuples > 0 ? ', (' : '(');

        if (scoped) statement.value(actorId);

        for (const [position, column] of columns.entries()) {
          if (position > 0 || scoped) statement.text(', ');
          const value = row[column.name];

          statement.value(yield* encodeValue(column, value === undefined ? null : value, `${doing}: row ${index}`));
        }

        statement.text(')');
        tuples += 1;
        index += 1;
      }

      // `RETURNING` carries the row count; `SqlExecutor` returns no change count.
      statement.text(' RETURNING 1');
      written += (yield* execute<unknown>(sql, statement, doing)).length;
    }

    return written;
  });

  const applyOp = (op: AppOp, doing: string): Effect.Effect<AppliedOp, KinuError> => Effect.gen(function* () {
    const resolved = yield* resolve(op.table);
    yield* permitted(resolved.record.scope === 'actor', `db.${op.op} on a ${resolved.record.scope}-scope table`);

    if (op.op === 'insert') {
      const inserted: AppliedOp = {
        result: { op: 'insert', table: resolved.record.name, rowsAffected: yield* insertRows(resolved, op.rows, doing) },
        scope: resolved.record.scope,
      };

      return inserted;
    }

    const statement = new Statement();

    if (op.op === 'update') {
      statement.text(`UPDATE ${yield* quoted(resolved.physical)} SET `);

      for (const [position, [name, value]] of Object.entries(op.set).entries()) {
        const column = yield* columnOf(resolved, name, doing);

        if (position > 0) statement.text(', ');
        statement.text(`${yield* quoted(column.name)} = `).value(yield* encodeValue(column, value, doing));
      }
    }
    else statement.text(`DELETE FROM ${yield* quoted(resolved.physical)}`);
    yield* compileWhere(resolved, op.where, statement, doing);
    statement.text(' RETURNING 1');

    const applied: AppliedOp = {
      result: { op: op.op, table: resolved.record.name, rowsAffected: (yield* execute<unknown>(sql, statement, doing)).length },
      scope: resolved.record.scope,
    };

    return applied;
  });

  const commit = <T>(work: (record: (event: DbOpRecord) => void) => Effect.Effect<T, KinuError>): Effect.Effect<T> => Effect.sync(() => {
    const pending: DeferredRunEvent[] = [];
    let runId: string | undefined;

    const result = transactionSync(() => {
      pending.length = 0;

      return settleSync(work((event) => {
        runId ??= deps.runId();
        pending.push(deps.events().emitDeferred(runId, { type: 'db_op', ...event }));
      }));
    });

    for (const deferred of pending) deferred.publish();

    return result;
  });

  /** Never adopt an uncatalogued physical object as agent data. */
  const unclaimed = (physical: string, doing: string): Effect.Effect<void, KinuError> => Effect.gen(function* () {
    const claimed = yield* execute<{ name: string }>(
      sql,
      new Statement()
        .text(`SELECT name FROM sqlite_master WHERE type IN ('table', 'view', 'index', 'trigger') AND name = `)
        .value(physical),
      doing,
    );

    if (claimed.length > 0) {
      return yield* new KinuError('denied', `\`${physical}\` already exists in this database outside the agent-data catalogue, so it is not agent data and this will not adopt it as such`);
    }
  });

  /** A declared table's DDL and catalogue row, inside the caller's transaction. */
  const landed = (record: AppTableRecord, doing: string): Effect.Effect<void, KinuError> => Effect.gen(function* () {
    const physical = `${APP_TABLE_PREFIX}${record.name}`;
    yield* runDdl(yield* createTableDdl(record, physical), doing);
    const index = yield* ownerIndexDdl(record, physical);

    if (index !== null) yield* runDdl(index, doing);
    yield* runStatement(
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
  });

  const createdTable = (spec: AppTableSpec): Effect.Effect<AppTableRecord, KinuError> => Effect.gen(function* () {
    yield* authorized();
    const declared = yield* parseInput(TableSpecSchema, { value: spec, where: 'db.createTable(spec)' });
    const physical = `${APP_TABLE_PREFIX}${declared.name}`;
    const doing = `db.createTable(${declared.name})`;
    const existing = yield* catalogRow(declared.name);

    if (existing !== undefined) {
      const record = recordOf(existing);

      if (!sameDeclaration(record, declared)) {
        return yield* new KinuError('denied', `table \`${declared.name}\` already exists as ${record.scope}-scope (${renderDeclaration(record)}) and re-declaring it does not migrate it; use another name`);
      }

      return yield* commit(() => Effect.gen(function* () {
        // Self-healing: a catalogued table must exist physically.
        yield* runDdl(yield* createTableDdl(record, physical), doing);
        const index = yield* ownerIndexDdl(record, physical);

        if (index !== null) yield* runDdl(index, doing);

        return record;
      }));
    }

    yield* permitted(declared.scope === 'actor', `db.createTable of a ${declared.scope}-scope table`);

    const counted = yield* execute<{ n: number }>(sql, new Statement().text(`SELECT COUNT(*) AS n FROM ${catalog}`), doing);
    const tables = v.parse(CountSchema, counted[0]?.n ?? 0);

    if (tables >= MAX_TABLES) {
      return yield* new KinuError('denied', `this workspace already holds ${tables} agent tables, which is the maximum; drop one before declaring another`);
    }

    yield* unclaimed(physical, doing);
    const record: AppTableRecord = { ...declared, createdBy: actorId, createdAt: Date.now() };

    return yield* commit((record_) => Effect.gen(function* () {
      yield* landed(record, doing);
      record_({ op: 'createTable', table: record.name, scope: record.scope, rowsAffected: 0, batch: null });

      return record;
    }));
  });

  const droppedTable = (name: string): Effect.Effect<void, KinuError> => Effect.gen(function* () {
    const resolved = yield* resolve(name);
    const doing = `db.dropTable(${resolved.record.name})`;
    // Build-only on either scope: dropping affects the whole workspace.
    yield* permitted(false, doing);

    if (resolved.record.createdBy !== actorId) {
      return yield* new KinuError('denied', `table \`${resolved.record.name}\` was declared by another agent (${resolved.record.createdBy}); delete your own rows instead`);
    }

    if (resolved.record.scope === 'actor') {
      const counted = yield* execute<{ n: number }>(
        sql,
        new Statement()
          .text(`SELECT COUNT(*) AS n FROM ${yield* quoted(resolved.physical)} WHERE ${yield* quoted(ACTOR_COLUMN)} != `)
          .value(actorId),
        doing,
      );

      const siblings = v.parse(CountSchema, counted[0]?.n ?? 0);

      if (siblings > 0) {
        return yield* new KinuError('denied', `\`${resolved.record.name}\` is ONE physical table and holds ${siblings} row(s) belonging to other agents; dropping it would delete their private rows, so it stays. Delete your own rows instead`);
      }
    }

    yield* commit((record) => Effect.gen(function* () {
      yield* runDdl(`DROP TABLE IF EXISTS ${yield* quoted(resolved.physical)}`, doing);
      yield* runStatement(
        sql,
        new Statement().text(`DELETE FROM ${catalog} WHERE name = `).value(resolved.record.name),
        doing,
      );
      record({ op: 'dropTable', table: resolved.record.name, scope: resolved.record.scope, rowsAffected: 0, batch: null });
    }));
  });

  const counted = (table: string, where: AppWhere | undefined): Effect.Effect<number, KinuError> => Effect.gen(function* () {
    const doing = `db.count(${table})`;
    const resolved = yield* resolve(table);
    const statement = new Statement().text(`SELECT COUNT(*) AS n FROM ${yield* quoted(resolved.physical)}`);
    yield* compileWhere(resolved, where, statement, doing);
    const rows = yield* execute<{ n: number }>(sql, statement, doing);

    return v.parse(CountSchema, rows[0]?.n ?? 0);
  });

  const batched = (ops: readonly AppOp[]): Effect.Effect<AppOpResult[], KinuError> => Effect.flatMap(authorized(), () => commit((record) => Effect.gen(function* () {
    const results: AppOpResult[] = [];

    for (const [index, op] of ops.entries()) {
      const doing = `db.batch operation ${index} (${op.op} ${op.table})`;

      // A refusal fails the batch, which rolls it back, evidence included.
      const applied = yield* Effect.mapError(Effect.tap(applyOp(op, doing), (done) => classified(() => record({
        op: done.result.op,
        table: done.result.table,
        scope: done.scope,
        rowsAffected: done.result.rowsAffected,
        batch: ops.length,
      }))), (cause) => new AppBatchError(index, cause));

      results.push(applied.result);
    }

    return results;
  })));

  const fork: ForkAppData = {
    tables: () => settleSync(Effect.map(catalogRows('read the agent-data catalogue'), (records) => records.map(({ name, scope, columns, createdAt }) => ({
      declaration: JSON.stringify({ name, scope, columns }), createdAt,
    })))),
    page: (table, after, limit) => settleSync(Effect.gen(function* () {
      const resolved = yield* resolve(table);
      const doing = `export ${resolved.record.name}`;
      const columns = resolved.record.columns;

      // `_rowid_` and `_fork_rowid` are no declarable names (the grammar requires a leading letter), so neither is a
      // column's; a declared `rowid` would shadow SQLite's own. An integer key aliases it, so a row may be at or below 0.
      const statement = new Statement()
        .text(`SELECT _rowid_ AS _fork_rowid, ${yield* quotedAll(columns.map((column) => column.name))} FROM ${yield* quoted(resolved.physical)}`);

      const unscoped = yield* compileScope(resolved, statement);

      if (after !== null) statement.text(unscoped ? ' WHERE ' : ' AND ').text('_rowid_ > ').value(after);
      statement.text(' ORDER BY _rowid_ LIMIT ').value(limit);
      const rows = yield* execute<Record<string, StoredValue> & { _fork_rowid: number }>(sql, statement, doing);

      return {
        rows: yield* Effect.forEach(rows, (row) => decodedRow(columns, row)),
        next: rows.length === limit ? rows.at(-1)?._fork_rowid ?? null : null,
      };
    })),
    count: (table) => settleSync(counted(table, undefined)),
    create: (declaration, createdAt) => settleSync(Effect.gen(function* () {
      const declared = yield* parseInput(TableSpecSchema, { value: parseJsonValue(declaration), where: 'a forked table' });
      const doing = `fork ${declared.name}`;
      yield* unclaimed(`${APP_TABLE_PREFIX}${declared.name}`, doing);

      transactionSync(() => settleSync(landed({ ...declared, createdBy: actorId, createdAt }, doing)));
    })),
    insert: (table, rows) => settleSync(Effect.gen(function* () {
      const resolved = yield* resolve(table);

      transactionSync(() => settleSync(insertRows(resolved, rows, `fork ${resolved.record.name}`)));
    })),
    clear: () => settleSync(Effect.gen(function* () {
      const declared = yield* execute<{ name: string }>(sql, new Statement().text(`SELECT name FROM ${catalog}`), 'read the agent-data catalogue');

      for (const { name } of declared) yield* runDdl(`DROP TABLE IF EXISTS ${yield* quoted(`${APP_TABLE_PREFIX}${name}`)}`, `clear ${name}`);
      yield* runStatement(sql, new Statement().text(`DELETE FROM ${catalog}`), 'clear the agent-data catalogue');
    })),
  };

  return {
    fork,
    createTable(spec) {
      return settleSync(createdTable(spec));
    },

    dropTable(name) {
      return settleSync(droppedTable(name));
    },

    listTables() {
      return settleSync(Effect.flatMap(authorized(), () => catalogRows('db.listTables()')));
    },

    schema(name) {
      return settleSync(Effect.map(resolve(name), (resolved) => resolved.record));
    },

    select(table, query) {
      return settleSync(Effect.flatMap(resolve(table), (resolved) => readRows(resolved, query, `db.select(${table})`)));
    },

    count(table, where) {
      return settleSync(counted(table, where));
    },

    apply(op) {
      const doing = `db.${op.op}(${op.table})`;

      return settleSync(Effect.flatMap(authorized(), () => commit((record) => Effect.map(applyOp(op, doing), (applied) => {
        record({
          op: applied.result.op,
          table: applied.result.table,
          scope: applied.scope,
          rowsAffected: applied.result.rowsAffected,
          batch: null,
        });

        return applied.result;
      }))));
    },

    batch(ops) {
      return settleSync(batched(ops));
    },
  };
}

/** `db.*` for programs: the catalog's db operations over one actor's store. A refused batch names its operation. */
export function createDbCodemodeProvider(store: AppDataStore): CodemodeProvider {
  return codemodeNamespace('db', 'Tables of your own, in SQL.', [
    serve(DB.createTable, ({ spec }) => classified(() => store.createTable(spec))),
    serve(DB.listTables, () => classified(() => [...store.listTables()])),
    serve(DB.schema, ({ table }) => classified(() => store.schema(table))),
    serve(DB.select, ({ table, ...query }) => classified(() => store.select(table, query))),
    serve(DB.count, ({ table, where }) => classified(() => store.count(table, where))),
    serve(DB.insert, ({ table, rows }) => classified(() => ({ rowsAffected: store.apply({ op: 'insert', table, rows }).rowsAffected }))),
    serve(DB.update, ({ table, set, where }) => classified(() => ({ rowsAffected: store.apply({ op: 'update', table, set, where }).rowsAffected }))),
    serve(DB.deleteRows, ({ table, where }) => classified(() => ({ rowsAffected: store.apply({ op: 'delete', table, where }).rowsAffected }))),
    serve(DB.batch, ({ ops }) => classified(() => store.batch(ops).map(({ rowsAffected }) => ({ rowsAffected })))),
    serve(DB.dropTable, ({ table }) => classified(() => {
      store.dropTable(table);

      return null;
    })),
  ]);
}
