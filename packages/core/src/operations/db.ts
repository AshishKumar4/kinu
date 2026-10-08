/**
 * `db`: a workspace's structured data for programs. Never a SQL handle: each operation's arguments are typed here, and
 * the store compiles every statement from them against the catalogued declaration (spec §9.2).
 */
import * as v from 'valibot';
import { APP_TABLE_SCOPES } from '../types/app-store';
import { JsonValueSchema } from '../utils/json';
import { defineOperation, type Operation } from './operation';

/** Host-injected from the bound handle; rejected as a declared column on either scope. */
export const ACTOR_COLUMN = 'actor_id';

const APP_COLUMN_TYPES = ['text', 'integer', 'real', 'blob', 'json'] as const;

export type AppColumnType = (typeof APP_COLUMN_TYPES)[number];

const APP_COMPARISONS = ['=', '!=', '<', '<=', '>', '>=', 'like'] as const;

const MAX_COLUMNS = 32;

const MAX_ROWS_PER_INSERT = 200;

const MAX_BATCH_OPS = 100;

const MAX_IN_VALUES = 200;

const MAX_ORDER_TERMS = 8;

export const SELECT_LIMIT_DEFAULT = 100;

const SELECT_LIMIT_MAX = 1000;

/**
 * Re-applied in {@link quoted}, the only function that emits an identifier. No flag: JSON Schema's `pattern` carries
 * none, and an ASCII class needs none.
 */
export const IDENTIFIER = /^[a-z][a-z0-9_]{0,47}$/;

const IdentifierSchema = v.pipe(
  v.string(),
  v.regex(IDENTIFIER, 'a name must be lowercase letters, digits and underscores, start with a letter, and be at most 48 characters'),
);

export const TableNameSchema = IdentifierSchema;

const ColumnNameSchema = v.pipe(
  IdentifierSchema,
  v.check(
    (name) => name !== ACTOR_COLUMN,
    `\`${ACTOR_COLUMN}\` is the host's own column on an actor-scoped table and cannot be declared, read or written`,
  ),
);

// `v.readonly()` so readonly caller specs (e.g. `as const` fixtures) type-check.
export const ColumnSchema = v.pipe(v.strictObject({
  name: ColumnNameSchema,
  type: v.picklist(APP_COLUMN_TYPES),
  notNull: v.optional(v.boolean()),
  primaryKey: v.optional(v.boolean()),
  unique: v.optional(v.boolean()),
}), v.readonly());

export const TableSpecSchema = v.pipe(v.strictObject({
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
export const PredicateOperationSchema = v.union([
  v.strictObject({ op: v.picklist(APP_COMPARISONS), value: JsonValueSchema }),
  v.strictObject({
    op: v.literal('in'),
    values: v.pipe(v.array(JsonValueSchema), v.maxLength(MAX_IN_VALUES, `\`in\` accepts at most ${MAX_IN_VALUES} values`)),
  }),
  v.strictObject({ op: v.picklist(['isNull', 'notNull']) }),
]);

/** Order is the contract: an object with `op` is a predicate; compare documents via `{ op: '=', value }`. */
export const PredicateSchema = v.union([PredicateOperationSchema, JsonValueSchema]);

export const OperatorCarrierSchema = v.object({ op: v.string() });

export const WhereSchema = v.record(ColumnNameSchema, PredicateSchema);

export const SelectSchema = v.strictObject({
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

export const OpSchema = v.variant('op', [
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


const Table = v.pipe(TableNameSchema, v.description('A table name: lowercase letters, digits and underscores.'));

const TableRecord = v.strictObject({ ...TableSpecSchema.pipe[0].entries, createdBy: v.string(), createdAt: v.number() });

const Changed = v.strictObject({ rowsAffected: v.number() });

/** Every db operation runs on Plan: the store decides per call, by the table's scope, whether Plan may write it. */
const dbOp = <const I extends v.StrictObjectSchema<v.ObjectEntries, undefined>, const O extends v.GenericSchema>(
  op: Pick<Operation<I, O>, 'name' | 'help' | 'impact' | 'input' | 'output'> & { readonly plan?: boolean },
) => defineOperation({ ns: 'db', availability: 'code', slate: false, plan: true, ...op });

export const DB = {
  createTable: dbOp({
    name: 'createTable', impact: 'mutate',
    help: 'Declare a table; re-declaring the same shape does nothing, and a different shape under an existing name is refused. '
      + "`blob` columns take and return base64, `json` columns any JSON document. `scope: 'actor'` rows are yours alone, "
      + "`scope: 'workspace'` rows every agent's here.",
    input: v.strictObject({ spec: TableSpecSchema }), output: TableRecord,
  }),
  listTables: dbOp({ name: 'listTables', help: "This workspace's tables, with their scope and who declared each.", impact: 'observe', input: v.strictObject({}), output: v.array(TableRecord) }),
  schema: dbOp({ name: 'schema', help: "One table's declaration.", impact: 'observe', input: v.strictObject({ table: Table }), output: TableRecord }),
  select: dbOp({
    name: 'select', impact: 'observe',
    help: `Rows, ${String(SELECT_LIMIT_DEFAULT)} unless \`limit\` says otherwise and at most ${String(SELECT_LIMIT_MAX)}; page with \`offset\`. `
      + "`where: {}` matches every row you can reach; an object with `op` is a predicate, so compare a JSON document with `{ op: '=', value }`.",
    input: v.strictObject({ table: Table, ...SelectSchema.entries }), output: v.array(RowSchema),
  }),
  count: dbOp({ name: 'count', help: 'How many rows match.', impact: 'observe', input: v.strictObject({ table: Table, where: v.optional(WhereSchema) }), output: v.number() }),
  insert: dbOp({
    name: 'insert', help: `Insert up to ${String(MAX_ROWS_PER_INSERT)} rows.`, impact: 'mutate',
    input: v.strictObject({ table: Table, rows: OpSchema.options[0].entries.rows }), output: Changed,
  }),
  update: dbOp({
    name: 'update', help: 'Update the matching rows.', impact: 'mutate',
    input: v.strictObject({ table: Table, set: OpSchema.options[1].entries.set, where: WhereSchema }), output: Changed,
  }),
  // Not `delete`: codemode registers reserved words as `delete_`, breaking hosted calls.
  deleteRows: dbOp({ name: 'deleteRows', help: 'Delete the matching rows.', impact: 'mutate', input: v.strictObject({ table: Table, where: WhereSchema }), output: Changed }),
  batch: dbOp({
    name: 'batch', impact: 'mutate',
    help: `Up to ${String(MAX_BATCH_OPS)} writes in one transaction: all land or none does, and \`failedIndex\` names the one that failed.`,
    input: v.strictObject({ ops: BatchSchema }), output: v.array(Changed),
  }),
  dropTable: dbOp({
    name: 'dropTable', impact: 'mutate', plan: false,
    help: 'Drop a table you declared, with its rows; an actor-scope table is refused while another agent holds rows in it.',
    input: v.strictObject({ table: Table }), output: v.null(),
  }),
} as const;
