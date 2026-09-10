/**
 * `db` — the workspace's structured data capability, as a program reaches it
 * inside `execute_tools`.
 *
 * WHAT THIS IS NOT: a SQL handle. No operation here accepts SQL text, and
 * nothing a program passes is ever concatenated into a statement. Every
 * statement is COMPILED by this module from typed arguments against the table's
 * own catalogued declaration, with every value bound positionally and every
 * identifier both validated against {@link IDENTIFIER} and quoted at the one
 * function that writes it. That is the enforceable boundary the product spec
 * asks for (§9.2): "A keyword filter or caller-supplied actor ID is not
 * sufficient authority." There is no keyword filter here because there are no
 * keywords to filter — a name that is not in the catalogue resolves to nothing,
 * so `messages`, `workspace_capability` and `sqlite_master` are not denied by a
 * list, they are unreachable by construction.
 *
 * The three walls, in the order an attempt meets them:
 *
 *   1. NAMESPACE. An agent table's physical name is `app_` + its logical name,
 *      and the logical name matches `^[a-z][a-z0-9_]{0,47}$`. No table this
 *      workspace's own schema creates carries that prefix, and the catalogue
 *      itself deliberately does not either ({@link AGENT_DATA_CATALOG}), so no
 *      logical name can address a host table, a view, a trigger, an index or
 *      the catalogue. There is no operation for `PRAGMA`, `ATTACH`, `CREATE
 *      VIEW`, `CREATE TRIGGER` or `ALTER`, so there is no indirect path either;
 *      `createTable` additionally refuses a physical name that already exists
 *      OUTSIDE the catalogue, which is what keeps a future host table called
 *      `app_*` — or a leftover of one — from being adopted as agent data.
 *
 *   2. AUTHORITY. Every operation calls `ActorHandle.assertCurrent()` before
 *      its statement, so a retired, re-parented or re-pathed actor stops
 *      writing at exactly the point its other stores stop serving. For a
 *      `scope: 'actor'` table the host injects `actor_id` from that validated
 *      handle into the DDL, into every predicate and into every inserted row.
 *      The program cannot name the column: `actor_id` is rejected as a declared
 *      column, and any column not in the table's declaration is `bad_input`.
 *
 *   3. SHAPE. Columns, types, predicates, ordering, projection and limits are
 *      parsed with valibot before compilation, and a value is decoded to the
 *      declared column type — so a `blob` column holds bytes, a `json` column
 *      holds a JSON document, and neither is a string that happens to look like
 *      one.
 *
 * Evidence and atomicity are one mechanism. A mutation's `db_op` run event is
 * INSERTed on the same connection inside the same `transactionSync` as the
 * mutation itself, and its live fan-out is deferred until after the commit — so
 * a rolled-back batch leaves neither rows nor a record of rows, a failing
 * evidence write rolls the data back with it, and no subscriber is ever told
 * about a mutation that did not happen.
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

/** The physical prefix of every agent-created data table. */
const APP_TABLE_PREFIX = 'app_';

/**
 * The catalogue of agent data tables.
 *
 * DELIBERATELY OUTSIDE {@link APP_TABLE_PREFIX}. A catalogue named `app_tables`
 * would be addressable as the logical name `tables`, which is the one physical
 * table an agent must never reach — every authority decision in this module is
 * read out of it. Sitting outside the prefix makes that structural rather than
 * a name on a deny list.
 */
const AGENT_DATA_CATALOG = 'agent_data_tables';

/**
 * The column the host owns on a `scope: 'actor'` table.
 *
 * Injected from the bound {@link ActorHandle}, never from an argument, and
 * rejected as a declared column name on either scope — so no program can
 * shadow it, filter on it, write it, or read it back.
 */
const ACTOR_COLUMN = 'actor_id';

/** Column types a declaration may use. */
const APP_COLUMN_TYPES = ['text', 'integer', 'real', 'blob', 'json'] as const;
export type AppColumnType = (typeof APP_COLUMN_TYPES)[number];

/** What each declared type is in SQLite. A JSON document is TEXT that this
 *  module encodes and decodes at the boundary — declaring it `JSON` in the DDL
 *  would name an affinity SQLite does not have. */
const SQLITE_TYPE = {
  text: 'TEXT',
  integer: 'INTEGER',
  real: 'REAL',
  blob: 'BLOB',
  json: 'TEXT',
} satisfies Readonly<Record<AppColumnType, string>>;

/** Whose rows a table holds. */
export const APP_TABLE_SCOPES = ['actor', 'workspace'] as const;
export type AppTableScope = (typeof APP_TABLE_SCOPES)[number];

/** Comparisons a predicate may name. */
const APP_COMPARISONS = ['=', '!=', '<', '<=', '>', '>=', 'like'] as const;

/**
 * Bounds. Each one is a refusal that names its own limit, never a silent clamp:
 * a program that asked for 5,000 rows and received 1,000 would draw a
 * conclusion from a truncation it was never told about.
 */
const MAX_TABLES = 64;
const MAX_COLUMNS = 32;
const MAX_ROWS_PER_INSERT = 200;
const MAX_BATCH_OPS = 100;
const MAX_IN_VALUES = 200;
const MAX_ORDER_TERMS = 8;
const SELECT_LIMIT_DEFAULT = 100;
const SELECT_LIMIT_MAX = 1000;
/** Bound values per compiled INSERT. SQLite's own ceiling is far higher; this
 *  keeps one multi-row insert inside a statement every driver prepares
 *  comfortably, and the compiler chunks a longer run rather than refusing it. */
const MAX_BINDINGS_PER_STATEMENT = 800;

/**
 * The one identifier grammar, applied twice: when a declaration is parsed, and
 * again inside {@link quoted} at the moment a name is written into SQL. The
 * second application is the load-bearing one — `quoted` is the only function in
 * this module that emits an identifier, so the check being there is what makes
 * "no unvalidated name reaches SQL" a property of the code rather than of every
 * call site remembering.
 */
const IDENTIFIER = /^[a-z][a-z0-9_]{0,47}$/u;

/**
 * `SQLITE_CONSTRAINT` and `SQLITE_MISMATCH`, by the only signature the drivers
 * expose: their message. Both backends surface SQLite failures as plain
 * `Error`s carrying no code, so this is the same mechanism
 * `obs/expected-failure.ts` uses for the sqlite messages IT has to recognise.
 * It CLASSIFIES rather than catches: the caught error stays the `cause`, its
 * text is carried into the refusal, and anything unrecognised is reported as
 * `io` rather than quietly re-labelled as the caller's fault.
 */
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

// `v.readonly()` on the declaration, not a second hand-written interface
// beside it: a table spec is data a CALLER holds — a program's argument, a
// test's `as const` fixture, a later owner surface's record — and a mutable
// array in the public type refuses every readonly one of those. Deriving the
// type from the schema keeps one declaration; adding the action is what makes
// that one declaration usable.
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

/** A predicate that names an operator. Parsed on its own inside the compiler,
 *  so `{ op: 'drop' }` is reported as a bad predicate rather than falling
 *  through to be compared as a JSON value. */
const PredicateOperationSchema = v.union([
  v.strictObject({ op: v.picklist(APP_COMPARISONS), value: JsonValueSchema }),
  v.strictObject({
    op: v.literal('in'),
    values: v.pipe(v.array(JsonValueSchema), v.maxLength(MAX_IN_VALUES, `\`in\` accepts at most ${MAX_IN_VALUES} values`)),
  }),
  v.strictObject({ op: v.picklist(['isNull', 'notNull']) }),
]);

/** JsonValue comes LAST, and the order is the contract: an object carrying an
 *  `op` property is a predicate, so a whole JSON document compared for equality
 *  is written `{ op: '=', value: { … } }`. The declaration says so. */
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

/** One row as a program sees it: `blob` columns as base64 text, `json` columns
 *  as the decoded document, everything else as its SQLite value. */
export type AppRow = Record<string, JsonValue>;

/** A catalogued table: its declaration, who declared it, and when. */
export interface AppTableRecord extends AppTableSpec {
  readonly createdBy: string;
  readonly createdAt: number;
}

/** What one mutation changed. */
export interface AppOpResult {
  readonly op: AppOp['op'];
  readonly table: string;
  readonly rowsAffected: number;
}

/**
 * The host-side data API. SQL lives here and nowhere above it: a caller — the
 * codemode provider, a test, a later owner surface — states an operation and
 * this store compiles it.
 */
export interface AppDataStore {
  /** Declare a table. Idempotent for an identical declaration; a different
   *  shape under a name that already exists is `denied` and writes nothing. */
  createTable(spec: AppTableSpec): AppTableRecord;
  /** Retire a table this actor declared, with its rows. Refused while another
   *  actor holds rows in it. */
  dropTable(name: string): void;
  /** Every catalogued table of this workspace, with its scope and declarer. */
  listTables(): readonly AppTableRecord[];
  /** One catalogued table's declaration. `missing` when there is none. */
  schema(name: string): AppTableRecord;
  select(table: string, query?: AppSelect): AppRow[];
  count(table: string, where?: AppWhere): number;
  /** One mutation in one transaction. */
  apply(op: AppOp): AppOpResult;
  /** Several mutations in ONE transaction: every one lands or none does. */
  batch(ops: readonly AppOp[]): AppOpResult[];
}

export interface AppDataStoreDeps {
  /**
   * The actor's own SQL handle — for the compiled statements AND for this
   * store's DDL.
   *
   * One handle rather than `sql` plus a {@link RawSqlExec}, because DDL through
   * the tag reaches the same engine call `execRaw` does on both backends (cf's
   * `execRaw` IS `ctx.storage.sql.exec(ddl)`; bun's `all()` "executes any
   * statement and returns its rows — DDL and plain writes simply have none",
   * cli-backend/src/runtime.ts) — and using the one handle is what makes a
   * `createTable`'s DDL and its catalogue row provably the same connection, and
   * therefore the same transaction.
   */
  readonly sql: SqlExecutor;
  readonly actor: ActorHandle;
  readonly transactionSync: <T>(write: () => T) => T;
  /** Where a mutation's evidence goes. A function because the recorder is
   *  memoised per actor and must not be forced when this store is built. */
  readonly events: () => RunEventRecorder;
  /** The run a mutation belongs to: the run of the turn it happened under. */
  readonly runId: () => string;
}

/**
 * A batch operation's failure, carrying WHICH operation failed.
 *
 * A `KinuError` subclass rather than a second failure vocabulary: it
 * classifies, chains and refuses exactly like every other refusal in the repo,
 * and the index rides beside the refusal the way `execution` does on a
 * branchable tool call (tools/outcome.ts).
 */
class AppBatchError extends KinuError {
  override readonly name = 'AppBatchError';
  constructor(readonly failedIndex: number, cause: KinuError) {
    super(cause.code, `batch operation ${failedIndex} was refused, so none of the batch landed`, { cause });
  }
}

/** The catalogue. Created with every workspace's schema, so a reader that finds
 *  no table is a fault rather than a workspace with no agent data. */
export function initAgentDataTables(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS ${AGENT_DATA_CATALOG} (
    name TEXT PRIMARY KEY,
    scope TEXT NOT NULL CHECK(scope IN ('actor','workspace')),
    columns TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
}

/**
 * Quote a validated identifier.
 *
 * The grammar is re-applied here rather than trusted from the caller, for the
 * reason {@link IDENTIFIER} gives. The grammar admits no quote character, so
 * quoting cannot be escaped out of — and a name that somehow arrived
 * unvalidated is a fault, not a query.
 */
function quoted(identifier: string): string {
  if (!IDENTIFIER.test(identifier)) {
    throw new KinuError('bad_input', `${identifier} is not a usable table or column name`);
  }
  return `"${identifier}"`;
}

/**
 * A statement being compiled: SQL text in fragments, values beside them.
 *
 * `SqlExecutor` is a tagged template because nearly every statement in this
 * repository is a literal. A compiled data operation is the exception — its
 * projection, its predicate and its parameter count are built per call — so
 * this class assembles the template object the tag is called with. Every
 * implementation of that tag (Durable Object `ctx.storage.sql`, bun:sqlite, the
 * test fixture) joins the strings and binds the values positionally, which is
 * what a prepared statement IS; building the template is therefore the same
 * operation as writing a literal one, and it needs no second SQL handle
 * threaded through every composition root.
 *
 * Text and values can only be appended through the two methods, so a value can
 * never land in the text and text can never be bound as a value.
 */
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

/** Run a compiled statement, classifying what SQLite says about it. */
/**
 * A statement whose ROWS are never read — a DDL, an insert, a delete.
 *
 * Named, rather than the previous spelling at three sites, which voided the
 * call. That was misleading twice over: the `void` operator is this tree's
 * marker for a promise deliberately not awaited, and {@link execute} is
 * synchronous and throws, so there was never a rejection to discard — only a
 * result set. Errors propagate exactly as they do for a read, because this is
 * the same call with the array dropped.
 */
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

/** A table resolved from the catalogue: what the compiler is allowed to write. */
interface Resolved {
  readonly record: AppTableRecord;
  readonly physical: string;
  readonly columns: ReadonlyMap<string, AppColumn>;
}

/** Two declarations are the same declaration, column ORDER included: the order
 *  is part of the physical shape, so accepting a reordering as identical would
 *  make the catalogue disagree with the table it describes. */
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

/** A declaration in the words the refusal needs, so a rejected redeclaration
 *  tells the model what the existing table actually is. */
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

/**
 * What each declared column ADMITS from a program, and what it says when the
 * value is not that.
 *
 * One schema per column type rather than a chain of runtime shape checks: the
 * column type IS the contract, so the boundary parses against it and the branch
 * below is on the domain — which is also what makes the refusal message a
 * statement about the column rather than about a JavaScript representation.
 */
const ADMITTED = {
  text: { schema: v.string(), takes: 'a string' },
  integer: { schema: v.pipe(v.number(), v.safeInteger()), takes: 'a safe integer (booleans are 0 and 1)' },
  real: { schema: v.pipe(v.number(), v.finite()), takes: 'a finite number' },
  blob: { schema: v.pipe(v.string(), v.base64()), takes: 'base64 text' },
  json: { schema: JsonValueSchema, takes: 'any JSON document' },
} satisfies Readonly<Record<AppColumnType, { readonly schema: v.GenericSchema; readonly takes: string }>>;

/** The bound-value vocabulary, as a schema: what a compiled statement may
 *  carry for a non-blob, non-json column once the column's own schema has
 *  admitted it. */
const SqlPrimitiveSchema = v.union([v.string(), v.number(), v.boolean(), v.null()]);

/** What a driver hands back for one column: the portable value vocabulary plus
 *  the `Uint8Array` bun:sqlite answers a BLOB with, and `undefined` for a
 *  column a projection did not select. */
type StoredValue = SqlValue | Uint8Array | undefined;

/** What a column of each type must read back as. A stored value outside it is
 *  corruption, which is named rather than coerced. */
const STORED = {
  text: v.string(),
  integer: v.number(),
  real: v.number(),
  // Both are real: a Durable Object answers BLOBs as ArrayBuffer, bun:sqlite as
  // Uint8Array.
  blob: v.union([v.instance(ArrayBuffer), v.instance(Uint8Array)]),
  json: v.string(),
} satisfies Readonly<Record<AppColumnType, v.GenericSchema>>;

/** Encode one program value for one declared column. */
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
  // A fresh ArrayBuffer of exactly the decoded length: handing over
  // `bytes.buffer` would pass whatever else its backing store holds.
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

/** Decode one stored value back into the program's vocabulary. */
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

/**
 * The mutations that leave evidence.
 *
 * Exported so the run-event union does not re-spell them: `db_op` is
 * `RunEventBase & { type: 'db_op' } & DbOpRecord`, the same way `file_edit`
 * carries `FileEditSnapshot` — one declaration, and a member added here cannot
 * fall out of step with the durable schema that records it.
 */
export const APP_MUTATIONS = ['createTable', 'dropTable', 'insert', 'update', 'delete'] as const;
export type AppMutation = (typeof APP_MUTATIONS)[number];

/** One applied mutation and the scope its evidence records. */
interface AppliedOp {
  readonly result: AppOpResult;
  readonly scope: AppTableScope;
}

/** One mutation's evidence, as the run-event union carries it. */
export interface DbOpRecord {
  readonly op: AppMutation;
  readonly table: string;
  readonly scope: AppTableScope;
  /** Rows the operation changed. Zero for a schema operation, which changes
   *  the table rather than any row. */
  readonly rowsAffected: number;
  /** How many operations the enclosing all-or-nothing batch held, or null when
   *  this was a single operation. Every row of one batch carries the same
   *  number, so a reader can tell one transaction from several. */
  readonly batch: number | null;
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
    // The actor LEADS the key on an actor-scoped table, so two agents holding
    // the same logical key are two rows and neither can reach the other's.
    columns.push(`PRIMARY KEY (${[...(scoped ? [ACTOR_COLUMN] : []), ...declaredKey].map(quoted).join(', ')})`);
  }
  for (const column of spec.columns) {
    if (column.unique !== true || column.primaryKey === true) continue;
    // Uniqueness is scoped for the same reason the key is, and for one more: a
    // workspace-wide UNIQUE over private rows would let one agent's value
    // refuse another agent's insert, and that refusal is itself a disclosure.
    columns.push(`UNIQUE (${[...(scoped ? [ACTOR_COLUMN] : []), column.name].map(quoted).join(', ')})`);
  }
  return `CREATE TABLE IF NOT EXISTS ${quoted(physical)} (\n  ${columns.join(',\n  ')}\n)`;
}

/** An actor-scoped table with no declared key still gets its scan scoped: the
 *  index states ownership in the physical schema rather than leaving it to
 *  every statement's predicate. */
function ownerIndexDdl(spec: AppTableSpec, physical: string): string | null {
  if (spec.scope !== 'actor') return null;
  if (spec.columns.some((column) => column.primaryKey === true)) return null;
  return `CREATE INDEX IF NOT EXISTS ${quoted(`idx_${physical}_owner`)} ON ${quoted(physical)} (${quoted(ACTOR_COLUMN)})`;
}

/** Parse one argument, reporting the issue and its path rather than the schema. */
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

  /** Re-validate the binding before every statement. */
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

  /**
   * Plan authority, per operation, from the resolved SCOPE rather than from the
   * member's name: an actor-scoped write is this agent's own research state,
   * which Plan explicitly permits (spec §9.1, the same status `state.*` has),
   * while a workspace-scoped write is a mutation other agents observe and Plan
   * does not. `currentWorkMode()` is the invocation's mode —
   * `providersInWorkMode` binds it around every codemode call — so the decision
   * is made where the scope is known and cannot be lost on the way there.
   */
  const requirePermission = (scope: AppTableScope, operation: string): void => {
    requireWorkModePermission(currentWorkMode(), scope === 'actor', operation);
  };

  /**
   * The actor predicate, and the reason it is compiled rather than passed: a
   * `scope: 'actor'` statement is not "filtered by an actor id the caller
   * supplied", it is built around the id of the handle this store was bound to.
   * No argument can change it and no operation omits it.
   *
   * Returns whether the statement still needs its first `WHERE`.
   */
  const compileScope = (resolved: Resolved, statement: Statement): boolean => {
    if (resolved.record.scope !== 'actor') return true;
    statement.text(` WHERE ${quoted(ACTOR_COLUMN)} = `).value(actorId);
    return false;
  };

  const compilePredicate = (column: AppColumn, predicate: AppPredicate, statement: Statement, where: string): void => {
    const name = quoted(column.name);
    if (!v.is(OperatorCarrierSchema, predicate)) {
      // Re-parsed rather than leaned on the guard's negative narrowing: what a
      // bare value may be is `JsonValue`, and that is a statement this reads
      // off the schema instead of off the compiler's arithmetic on a union.
      const bare = parseInput(JsonValueSchema, { value: predicate, where: where });
      statement.text(`${name} = `).value(encodeValue(column, bare, where));
      return;
    }
    const operation = parseInput(PredicateOperationSchema, { value: predicate, where: where });
    // A switch on the discriminant, so every operator is accounted for and the
    // comparison arm is reached with a variant that HAS a value — an `if`
    // chain leaves the compiler holding a wider union than the code can meet.
    switch (operation.op) {
      case 'isNull':
      case 'notNull':
        statement.text(`${name} IS ${operation.op === 'isNull' ? '' : 'NOT '}NULL`);
        return;
      case 'in': {
        if (operation.values.length === 0) {
          // An empty set matches nothing, and says so in SQL rather than by
          // being dropped: a dropped predicate would WIDEN the statement.
          statement.text('0 = 1');
          return;
        }
        statement.text(`${name} IN (`);
        operation.values.forEach((value, index) => {
          if (index > 0) statement.text(', ');
          statement.value(encodeValue(column, value, where));
        });
        statement.text(')');
        return;
      }
      case 'like':
        if (column.type !== 'text') {
          throw new KinuError('bad_input', `${where}: \`like\` compares text, and column \`${column.name}\` is ${column.type}`);
        }
        statement.text(`${name} LIKE `).value(encodeValue(column, operation.value, where)).text(` ESCAPE '\\'`);
        return;
      default:
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
    // Never `SELECT *`: the projection IS the declaration, so an actor-scoped
    // table's injected `actor_id` is not a column any read can return.
    const columns = query?.columns === undefined
      ? resolved.record.columns
      : query.columns.map((name) => columnOf(resolved, name, doing));
    const statement = new Statement()
      .text(`SELECT ${columns.map((column) => quoted(column.name)).join(', ')} FROM ${quoted(resolved.physical)}`);
    compileWhere(resolved, query?.where, statement, doing);
    const orderBy = query?.orderBy ?? [];
    if (orderBy.length > 0) {
      statement.text(' ORDER BY ');
      orderBy.forEach((term, index) => {
        const column = columnOf(resolved, term.column, doing);
        if (index > 0) statement.text(', ');
        statement.text(`${quoted(column.name)} ${term.dir === 'desc' ? 'DESC' : 'ASC'}`);
      });
    }
    statement.text(' LIMIT ').value(query?.limit ?? SELECT_LIMIT_DEFAULT);
    if (query?.offset !== undefined) statement.text(' OFFSET ').value(query.offset);
    return execute<Record<string, StoredValue>>(sql, statement, doing).map((row) => {
      const decoded: AppRow = {};
      for (const column of columns) decoded[column.name] = decodeValue(column, row[column.name]);
      return decoded;
    });
  };

  /**
   * One `INSERT` per consecutive run of rows sharing a column signature.
   *
   * The ordinary uniform insert is therefore one statement, rows that omit
   * different nullable columns are still accepted, and row ORDER is preserved
   * exactly — SQLite assigns rowids in statement order, so grouping
   * non-adjacent rows would silently reorder them.
   */
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
        columns.forEach((column, position) => {
          if (position > 0 || scoped) statement.text(', ');
          const value = row[column.name];
          statement.value(encodeValue(column, value === undefined ? null : value, `${doing}: row ${index}`));
        });
        statement.text(')');
        tuples += 1;
        index += 1;
      }
      // `RETURNING` is how a row count crosses the `SqlExecutor` seam: the tag
      // hands back rows, never a change count, and both backends run RETURNING
      // writes (cli-backend/src/runtime.ts documents exactly this).
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
      Object.entries(op.set).forEach(([name, value], position) => {
        const column = columnOf(resolved, name, doing);
        if (position > 0) statement.text(', ');
        statement.text(`${quoted(column.name)} = `).value(encodeValue(column, value, doing));
      });
    }
    else statement.text(`DELETE FROM ${quoted(resolved.physical)}`);
    compileWhere(resolved, op.where, statement, doing);
    statement.text(' RETURNING 1');
    return {
      result: { op: op.op, table: resolved.record.name, rowsAffected: execute<unknown>(sql, statement, doing).length },
      scope: resolved.record.scope,
    };
  };

  /**
   * One transaction, with the evidence inside it and the fan-out after it.
   *
   * The `db_op` rows are written on this connection within the same
   * `transactionSync` as the data, so they roll back with it and a failure to
   * write them rolls the data back too. Their live notification is held until
   * the transaction has RETURNED, so no subscriber is ever told about a
   * mutation that was undone.
   */
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
          // Nothing has been written on this path, so a rejected redeclaration
          // cannot leave the catalogue describing a table that disagrees with
          // it — the refusal happens before the transaction opens.
          throw new KinuError('denied', `table \`${declared.name}\` already exists as ${record.scope}-scope (${renderDeclaration(record)}) and re-declaring it does not migrate it; use another name`);
        }
        return commit(() => {
          // Idempotent, and self-healing: the catalogue's promise is that a
          // catalogued table exists physically.
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
        // The indirect-escape guard: a physical object under an agent name that
        // the catalogue does not know is NOT adopted as agent data.
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
      // Build-only on either scope: dropping retires a physical table the whole
      // workspace can see, which is not private research state whatever the
      // rows in it are.
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
        ops.forEach((op, index) => {
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
            // Rethrown, never absorbed: the throw is what rolls the whole
            // transaction back — the rows of the operations that had already
            // succeeded AND their `db_op` evidence with them.
            throw cause instanceof KinuError ? new AppBatchError(index, cause) : cause;
          }
        });
        return results;
      });
    },
  };
}

/**
 * The `db` namespace declaration the model reads.
 *
 * The doctrine lives HERE and not in a prompt section, for the reason
 * `CODE_EXECUTION_SECTION` records about `agent.*`: a section is unconditional
 * while a namespace is wired per root and per role, so prose in a section would
 * advertise `db.*` to an actor that does not have it. This block ships exactly
 * when the provider does, through the one `renderExecuteToolsDescription` both
 * backends compose.
 */
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
 * Tables in this workspace's own database. \`state.*\` keeps one JSON value per
 * key; \`db.*\` keeps rows you filter, sort, count and update in place, and is
 * where structured data a later turn has to query belongs.
 *
 * No operation takes SQL. The host compiles every statement from these
 * arguments against the table's declared columns, so a column the table never
 * declared is a refusal rather than a query, and there is no view, trigger,
 * index, PRAGMA or attached-database operation at all.
 *
 * \`scope: 'actor'\` rows are yours alone: the host binds your own actor id into
 * every statement, and no other agent's rows are reachable through any
 * argument you can pass. \`scope: 'workspace'\` rows are shared with every agent
 * of this workspace, and the table itself is visible to all of them either way.
 *
 * A refusal is \`{ reason, error }\` and is data you can branch on. \`where: {}\`
 * matches every row you can reach. An object carrying an \`op\` property is read
 * as a predicate, so a whole JSON document compared for equality is written
 * \`{ op: '=', value: { … } }\`.
 */
export declare const db: {
  /** Declare a table once. Re-declaring the identical shape does nothing; a
   *  DIFFERENT shape under a name that exists is refused rather than migrated,
   *  so pick another name. \`blob\` columns take and return base64 text; \`json\`
   *  columns take and return any JSON document. \`primaryKey\` and \`unique\` are
   *  scoped to you on an actor-scope table. */
  createTable(spec: { name: string; scope: 'actor' | 'workspace'; columns: DbColumn[] }): Promise<DbTable>;
  /** Every table this workspace holds, with who declared it. */
  listTables(): Promise<DbTable[]>;
  /** One table's column declaration. */
  schema(table: string): Promise<DbTable>;
  /** Read rows. Returns ${SELECT_LIMIT_DEFAULT} rows unless you say otherwise and at most ${SELECT_LIMIT_MAX}; page with \`offset\`. */
  select(table: string, query?: DbQuery): Promise<{ [column: string]: DbValue }[]>;
  /** How many rows match, without reading them. */
  count(table: string, where?: DbWhere): Promise<number>;
  /** Insert rows, up to ${MAX_ROWS_PER_INSERT} per call. Rows may omit different nullable columns. */
  insert(table: string, rows: { [column: string]: DbValue }[]): Promise<{ rowsAffected: number }>;
  /** Set columns on every matching row. */
  update(table: string, set: { [column: string]: DbValue }, where: DbWhere): Promise<{ rowsAffected: number }>;
  /** Delete every matching row. Spelled \`deleteRows\` and not \`delete\`
   *  because the hosted sandbox renames any member whose name is a JavaScript
   *  reserved word, which leaves the original spelling uncallable there — the
   *  BATCH operation is still \`{ op: 'delete' }\`, which is data and not a
   *  member name. */
  deleteRows(table: string, where: DbWhere): Promise<{ rowsAffected: number }>;
  /** Up to ${MAX_BATCH_OPS} writes in ONE transaction: all of them land or none does. A
   *  refusal names the operation that failed as \`failedIndex\`, and nothing the
   *  operations before it did survives. */
  batch(ops: DbWrite[]): Promise<{ rowsAffected: number }[] | { reason: string; error: string; failedIndex: number }>;
  /** Retire a table you declared, with its rows. Build turns only, and refused
   *  while another agent holds rows in an actor-scope table you share. */
  dropTable(table: string): Promise<{ ok: true }>;
};`;

/**
 * The `db` namespace as the sandbox binds it.
 *
 * `planAllowed` marks the members that CAN run on a Plan turn; which ones
 * actually may is decided per call from the resolved table scope inside the
 * store, because that answer depends on whose rows they are and not on the
 * member's name. `dropTable` is the one member with no Plan-safe form at all.
 */
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
      // NOT `delete`. `@cloudflare/codemode` sanitizes a tool name that is a
      // JavaScript reserved word before it registers the host dispatcher
      // (`sanitizeToolName` appends `_`), while the sandbox proxy dispatches
      // whatever the program typed — so a member called `delete` is registered
      // as `delete_` and every hosted call to it answers `Tool "delete" not
      // found`. Measured on the real runtime by
      // `cf-backend/tests/workerd/db-capability.test.ts`, which is the only
      // layer that can see it: the local factory binds the name verbatim and is
      // perfectly happy with `delete`. One name has to work on both backends.
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
            // `failedIndex` is why this member does not go through
            // `branchableToolCall`: the index is part of the refusal a program
            // branches on, and the shared helper carries reason/error only.
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
