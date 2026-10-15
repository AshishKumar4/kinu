/**
 * A database a release reshaped, repaired by its own object the first time this build opens it, before any other event
 * reads it (identity/schema-stamp.ts says when): each table its class's init makes is brought to the shape that init
 * declares now, keeping its rows. Nothing walks the fleet for this, so no database is missed: whatever opens one first
 * repairs it.
 *
 * - The shape is the init's own, read in a rolled-back trial (every table the class makes set aside by name, the init
 *   run over the rest): a table is stale while its CREATE statement is not the one the init makes, so a change no
 *   column name shows (a CHECK, a key, nullability) is seen too. Renames touch no row, so the trial costs the same on a
 *   transcript of a million rows as on an empty one.
 * - A stale table is rebuilt in one transaction with every table that refers to it by a foreign key (which would
 *   otherwise be left naming a dropped table, or lose rows to a cascade): set aside by name, made anew by the init, each
 *   row's columns both shapes hold copied back with its rowid, its triggers made after the copy, and its foreign keys
 *   checked. A failure rolls the group back whole.
 * - A table whose rows cannot be copied (a new NOT NULL column with no default, or rows the new constraints refuse)
 *   loses them only where its DDL declares it a regenerable cache ({@link REGENERABLE}). Any other refuses, in SQLite's
 *   words: the object stays refused with that reason, and the deploy's plan named the table before the upload.
 * - A table no build declares any longer (`SCHEMA_RETIRED`) is dropped, unless rows a kept table holds refer to it.
 *
 * Then the init runs, the database is stamped, and one event names every table touched with its rows before and after.
 */
import { Effect, Result } from 'effect';
import * as v from 'valibot';
import { KinuError } from '../obs/error';
import { diagnostics } from '../obs/log';
import { settleSync } from '../obs/effect';
import { readStamp, writeStamp, type SchemaClass, type StampStore } from '../identity/schema-stamp';
import { SCHEMA_RETIRED } from '../identity/schema-genesis';
import type { SqlExec } from '../types/primitives';

/** The marker a table's DDL carries inside its CREATE when its rows are a cache another path refills:
 *  `/* regenerable cache, refilled by <path> *\/`. SQLite keeps it in the statement it stores, so it is declared once. */
export const REGENERABLE = /\/\*\s*regenerable cache, refilled by ([^*]+?)\s*\*\//u;

/** A database as its object repairs it: its class and the tables that class makes (`SCHEMA_TABLES`), where its stamp
 *  is kept, its own transactions (only a synchronous throw from the callback rolls one back), and its own init, which
 *  makes its tables in this build's shape. */
export interface TableWrites {
  readonly schema: SchemaClass;
  readonly tables: readonly string[];
  readonly stamps: StampStore;
  readonly transactionSync: <A>(write: () => A) => A;
  readonly init: () => void;
}

/** A table a repair touched, and its rows before and after; null where it held none (made, or dropped). */
export interface TouchedTable {
  readonly table: string;
  readonly before: number | null;
  readonly after: number | null;
}

/** What one repair did. */
export interface Repair {
  readonly schema: SchemaClass;
  /** Tables rebuilt keeping their rows: those stale, and those rebuilt alongside to keep their foreign keys whole. */
  readonly rebuilt: readonly string[];
  /** Regenerable tables made anew, their rows dropped for their path to refill. */
  readonly refilled: readonly string[];
  /** Tables no build declares any longer, dropped. */
  readonly retired: readonly string[];
  /** Tables of its class it holds that its init did not make, so no shape could be read for them: left as they are. */
  readonly unchecked: readonly string[];
  readonly tables: readonly TouchedTable[];
  /** Why the database could not be brought to this build, in SQLite's words: it stays refused. */
  readonly refused: string | null;
}

const NameSchema = v.object({ name: v.string() });

const CountSchema = v.object({ rows: v.number() });

const ReferenceSchema = v.object({ table: v.string() });

const SchemaRowSchema = v.object({ type: v.string(), name: v.string(), tbl_name: v.string(), sql: v.nullable(v.string()) });

type SchemaRow = v.InferOutput<typeof SchemaRowSchema>;

/** The name a table is set aside under while its group is rebuilt, or while the trial reads the init's shape. */
const ASIDE = '__kinu_aside';

/** What a trial's transaction ends on, so nothing it did is kept. */
const TRIAL = new KinuError('cancelled', 'a trial of the schema repair, rolled back by design');

/** A transaction's answer, once its work finished. */
interface Kept<A> {
  answer?: { readonly value: A };
}

/** Runs `work` in one of `writes`' transactions; with `trial`, rolled back once it finished. */
function inTransaction<A>(writes: TableWrites, work: () => Effect.Effect<A, KinuError>, trial: boolean): Effect.Effect<A, KinuError> {
  const kept: Kept<A> = {};

  return Effect.try({
    try: () => writes.transactionSync(() => settleSync(Effect.gen(function* () {
      kept.answer = { value: yield* work() };

      if (trial) return yield* TRIAL;
    }))),
    catch: (cause) => (cause instanceof KinuError ? cause : new KinuError('unsupported', String(cause))),
  }).pipe(
    Effect.catch((failure) => (failure === TRIAL ? Effect.void : Effect.fail(failure))),
    Effect.flatMap(() => (kept.answer === undefined ? Effect.die(new Error('a repair transaction kept no answer')) : Effect.succeed(kept.answer.value))),
  );
}

/** One statement, SQLite's refusal its failure. */
function run(sql: SqlExec, statement: string): Effect.Effect<void, KinuError> {
  return Effect.try({ try: () => { sql.exec(statement).toArray(); }, catch: (cause) => new KinuError('unsupported', String(cause)) });
}

function schemaRows(sql: SqlExec): SchemaRow[] {
  return sql.exec(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'`)
    .toArray().map((row) => v.parse(SchemaRowSchema, row));
}

/** Every table `sql` holds, by name. */
export function tableNames(sql: SqlExec): string[] {
  return sql.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name`)
    .toArray().map((row) => v.parse(NameSchema, row).name);
}

export function rowsOf(sql: SqlExec, table: string): number {
  return v.parse(CountSchema, sql.exec(`SELECT COUNT(*) AS rows FROM "${table}"`).toArray()[0]).rows;
}

/** A statement's tokens: a quoted string or name (kept exactly), a comment, spacing, a paren or comma, or a word. */
const TOKEN = /'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|\s+|[(),]|[^'"`[\s(),\-/]+|./gu;

/** A statement as two builds may have spelled it alike: its comments, its spacing and `IF NOT EXISTS` aside. Quoted text
 *  (a string, a quoted name) is kept exactly, so a changed default is seen. */
function normal(statement: string | null | undefined): string {
  const tokens = ((statement ?? '').match(TOKEN) ?? []).map((token) => (/^(?:--|\/\*|\s)/u.test(token) ? ' ' : token));

  const kept = tokens.filter((token, at) => token !== ' '
    || !(at === 0 || at === tokens.length - 1 || /^[(), ]$/u.test(tokens[at - 1] ?? '') || /^[(),]$/u.test(tokens[at + 1] ?? '')));

  return kept.join('').replace(/^(CREATE (?:UNIQUE )?(?:TABLE|INDEX|TRIGGER|VIEW) )IF NOT EXISTS /iu, '$1');
}

/** Each table's parents: the tables its foreign keys name, read once. */
function parentsOf(sql: SqlExec, tables: readonly string[]): ReadonlyMap<string, readonly string[]> {
  return new Map(tables.map((table) => [table, [...new Set(sql.exec(`PRAGMA foreign_key_list("${table}")`).toArray()
    .map((row) => v.parse(ReferenceSchema, row).table).filter((parent) => parent !== table))]]));
}

/** The tables that refer to `table` by a foreign key. */
function referrers(parents: ReadonlyMap<string, readonly string[]>, table: string): string[] {
  return [...parents].filter(([, named]) => named.includes(table)).map(([child]) => child);
}

/** `tables`, parents before the tables that refer to them. */
function orderedGroup(parents: ReadonlyMap<string, readonly string[]>, tables: readonly string[]): string[] {
  const ordered: string[] = [];

  const place = (member: string, path: readonly string[]): void => {
    if (ordered.includes(member) || path.includes(member)) return;

    for (const parent of parents.get(member) ?? []) if (tables.includes(parent)) place(parent, [...path, member]);
    ordered.push(member);
  };

  for (const member of [...tables].sort()) place(member, []);

  return ordered;
}

/** `table` and every table that refers to it, transitively, parents first. */
function groupOf(parents: ReadonlyMap<string, readonly string[]>, table: string): string[] {
  const group = new Set([table]);

  for (const member of group) for (const child of referrers(parents, member)) group.add(child);

  return orderedGroup(parents, [...group]);
}

/** The triggers and views whose statement names one of `tables`, or a view that does, transitively, in the order the
 *  database holds them: a rename would rewrite them to the name set aside, or fail over a view it dropped. */
function dependents(rows: readonly SchemaRow[], tables: readonly string[]): SchemaRow[] {
  const names = new Set(tables);
  const found = new Set<SchemaRow>();
  const namesOne = (row: SchemaRow) => [...names].some((name) => row.tbl_name === name || new RegExp(`\\b${name}\\b`, 'iu').test(row.sql ?? ''));

  for (let grown = true; grown;) {
    const next = rows.filter((row) => (row.type === 'trigger' || row.type === 'view') && !found.has(row) && namesOne(row));

    for (const row of next) {
      found.add(row);

      if (row.type === 'view') names.add(row.name);
    }

    grown = next.length > 0;
  }

  return rows.filter((row) => found.has(row));
}

/** The statement each of `tables`, and each view, has as the init makes it now, read in a rolled-back trial. */
function initStatements(sql: SqlExec, writes: TableWrites, tables: readonly string[]): Effect.Effect<ReadonlyMap<string, string>, KinuError> {
  return inTransaction(writes, () => Effect.gen(function* () {
    yield* run(sql, 'PRAGMA defer_foreign_keys = ON');
    const rows = schemaRows(sql);
    const named = dependents(rows, tables);

    for (const row of [...named, ...rows.filter((view) => view.type === 'view' && !named.includes(view))]) yield* run(sql, `DROP ${row.type.toUpperCase()} "${row.name}"`);

    for (const table of tables) yield* run(sql, `ALTER TABLE "${table}" RENAME TO "${table}${ASIDE}"`);
    yield* Effect.try({ try: () => { writes.init(); }, catch: (cause) => new KinuError('unsupported', `the init refused: ${String(cause)}`) });

    return new Map(schemaRows(sql).filter((row) => (row.type === 'table' && tables.includes(row.name)) || row.type === 'view').map((row) => [row.name, row.sql ?? '']));
  }), true);
}

/** Each view whose statement is not the one the init declares now dropped, with what reads it, and made again by the
 *  init; what the init does not make is made again as it was. */
function remakeViews(sql: SqlExec, writes: TableWrites, declared: ReadonlyMap<string, string>): Effect.Effect<string[], KinuError> {
  const stale = schemaRows(sql).filter((row) => row.type === 'view' && declared.has(row.name) && normal(row.sql) !== normal(declared.get(row.name))).map((row) => row.name);

  if (stale.length === 0) return Effect.succeed([]);

  return inTransaction(writes, () => Effect.gen(function* () {
    const dropped = dependents(schemaRows(sql), stale);

    for (const row of [...dropped].reverse()) yield* run(sql, `DROP ${row.type.toUpperCase()} "${row.name}"`);
    yield* Effect.try({ try: () => { writes.init(); }, catch: (cause) => new KinuError('unsupported', `the init refused: ${String(cause)}`) });
    const made = new Set(schemaRows(sql).map((row) => row.name));

    for (const row of dropped.filter((view) => !made.has(view.name))) yield* run(sql, row.sql ?? '');

    return stale;
  }), false);
}

/** The columns a row of `table` stores, generated ones not among them. */
function storedColumns(sql: SqlExec, table: string): string[] {
  return sql.exec(`PRAGMA table_info("${table}")`).toArray().map((row) => v.parse(NameSchema, row).name);
}

/** Whether `table` keeps a rowid: a WITHOUT ROWID table refuses to name it. */
function keepsRowid(sql: SqlExec, table: string): Effect.Effect<boolean> {
  return Effect.match(run(sql, `SELECT rowid FROM "${table}" LIMIT 0`), { onSuccess: () => true, onFailure: () => false });
}

/** Each row of `table`'s set-aside copy put back in its new shape: the columns both hold, and its rowid where both
 *  keep one. */
function copyBack(sql: SqlExec, table: string): Effect.Effect<void, KinuError> {
  return Effect.gen(function* () {
    const aside = `${table}${ASIDE}`;
    const old = storedColumns(sql, aside);
    const columns = storedColumns(sql, table).filter((column) => old.includes(column)).map((column) => `"${column}"`);
    const rowid = (yield* keepsRowid(sql, aside)) && (yield* keepsRowid(sql, table));
    const names = [...rowid ? ['rowid'] : [], ...columns].join(', ');

    yield* run(sql, `INSERT INTO "${table}" (${names}) SELECT ${names} FROM "${aside}"`);
  });
}

/** `group` (parents first) rebuilt in the init's shape, keeping every row (unless `copy` is off, for a cache made anew
 *  empty): set aside by name, its indexes and the triggers and views that name it dropped, made anew by the init, copied
 *  back, its triggers made after the copy, and the set-aside copies dropped, in one transaction that ends on a foreign
 *  key check. A table of the group the init does not make (one that refers to a stale table, made after its object
 *  started) is made again as it was, with its indexes and triggers; so is every view, and every trigger of a table
 *  outside the group, that the init does not make. */
function rebuild(sql: SqlExec, writes: TableWrites, change: { readonly group: readonly string[]; readonly copy: boolean }): Effect.Effect<void, KinuError> {
  const { group, copy } = change;

  return inTransaction(writes, () => Effect.gen(function* () {
    yield* run(sql, 'PRAGMA defer_foreign_keys = ON');
    const before = schemaRows(sql);
    const named = dependents(before, group);
    const indexes = before.filter((row) => row.type === 'index' && row.sql !== null && group.includes(row.tbl_name));

    for (const row of [...named, ...indexes]) yield* run(sql, `DROP ${row.type.toUpperCase()} "${row.name}"`);

    for (const table of group) yield* run(sql, `ALTER TABLE "${table}" RENAME TO "${table}${ASIDE}"`);
    yield* Effect.try({ try: () => { writes.init(); }, catch: (cause) => new KinuError('unsupported', `the init refused: ${String(cause)}`) });
    const present = new Set(schemaRows(sql).filter((row) => row.type === 'table').map((row) => row.name));
    const remade = new Set(group.filter((table) => present.has(table)));

    for (const row of before.filter((table) => table.type === 'table' && group.includes(table.name) && !remade.has(table.name))) yield* run(sql, row.sql ?? '');
    const triggers = schemaRows(sql).filter((row) => row.type === 'trigger' && group.includes(row.tbl_name));

    for (const row of triggers) yield* run(sql, `DROP TRIGGER "${row.name}"`);

    // Rows the init seeded go: the copy brings the rows the database held, and the init after the repair seeds anew.
    for (const table of [...group].reverse()) yield* run(sql, `DELETE FROM "${table}"`);

    if (copy) for (const table of group) yield* copyBack(sql, table);

    for (const table of [...group].reverse()) yield* run(sql, `DROP TABLE "${table}${ASIDE}"`);

    for (const row of triggers) yield* run(sql, row.sql ?? '');
    const made = new Set(schemaRows(sql).map((row) => row.name));

    // What the init made anew is the init's; what it did not make is the database's own, made again as it was.
    for (const row of [...indexes, ...named].filter((dropped) => !made.has(dropped.name) && (dropped.type === 'view' || !remade.has(dropped.tbl_name)))) {
      yield* run(sql, row.sql ?? '');
    }

    const orphaned = sql.exec('PRAGMA foreign_key_check').toArray().length;

    if (orphaned > 0) return yield* new KinuError('unsupported', `the rebuilt rows break ${String(orphaned)} foreign key(s)`);
  }), false);
}

/** A retired table dropped, with the triggers and views that name it, which no build makes again either. */
function dropRetired(sql: SqlExec, writes: TableWrites, table: string): Effect.Effect<void, KinuError> {
  return inTransaction(writes, () => Effect.gen(function* () {
    yield* run(sql, 'PRAGMA defer_foreign_keys = ON');

    for (const row of dependents(schemaRows(sql), [table]).reverse()) yield* run(sql, `DROP ${row.type.toUpperCase()} "${row.name}"`);
    yield* run(sql, `DROP TABLE "${table}"`);
  }), false);
}

/** What a repair has done so far. */
interface Outcome {
  readonly rebuilt: string[];
  readonly refilled: string[];
  readonly retired: string[];
  readonly unchecked: string[];
  readonly tables: TouchedTable[];
  refused: string | null;
}

/** A stale table's group rebuilt; where its rows cannot be copied and every table in it holding rows is a regenerable
 *  cache, made anew empty; else refused with SQLite's reason. */
function bringUp(sql: SqlExec, writes: TableWrites, outcome: Outcome, stale: { readonly group: readonly string[]; readonly declared: ReadonlyMap<string, string> }): Effect.Effect<void> {
  return Effect.gen(function* () {
    const { group, declared } = stale;
    const before = group.map((table) => ({ table, rows: rowsOf(sql, table) }));
    const rebuilt = yield* Effect.result(rebuild(sql, writes, { group, copy: true }));
    const losing = before.filter(({ rows }) => rows > 0).map(({ table }) => table);

    const refilled = Result.isFailure(rebuilt) && losing.every((table) => REGENERABLE.test(declared.get(table) ?? ''))
      && Result.isSuccess(yield* Effect.result(rebuild(sql, writes, { group, copy: false })));

    if (Result.isFailure(rebuilt) && !refilled) {
      outcome.refused = `${group.join(', ')}: ${rebuilt.failure.message}`;

      return;
    }

    (refilled ? outcome.refilled : outcome.rebuilt).push(...group);
    outcome.tables.push(...before.map(({ table, rows }) => ({ table, before: rows, after: refilled ? 0 : rowsOf(sql, table) })));
  });
}

/** A retired table dropped, unless rows a kept table holds refer to it. */
function retire(sql: SqlExec, writes: TableWrites, table: string, outcome: Outcome): Effect.Effect<void> {
  return Effect.gen(function* () {
    const parents = parentsOf(sql, tableNames(sql));
    const rows = rowsOf(sql, table);

    if (referrers(parents, table).some((child) => rowsOf(sql, child) > 0)) return;

    if (Result.isFailure(yield* Effect.result(dropRetired(sql, writes, table)))) return;
    outcome.retired.push(table);
    outcome.tables.push({ table, before: rows, after: null });
  });
}

/** Every stale table's group brought up: all of them in one rebuild, which runs the init once; where that refuses,
 *  group by group, so the one that cannot be brought up is named and the rest are. The first refusal ends it. */
function bringUpTables(sql: SqlExec, writes: TableWrites, outcome: Outcome, declared: ReadonlyMap<string, string>): Effect.Effect<void> {
  return Effect.gen(function* () {
    const names = tableNames(sql);
    const current = new Map(schemaRows(sql).filter((row) => row.type === 'table').map((row) => [row.name, row.sql]));
    const stale = writes.tables.filter((table) => names.includes(table) && declared.has(table) && normal(current.get(table)) !== normal(declared.get(table)));
    const parents = parentsOf(sql, names);
    const groups: string[][] = [];

    for (const table of stale) if (!groups.some((group) => group.includes(table))) groups.push(groupOf(parents, table));
    const all = [...new Set(groups.flat())];
    const before = all.map((table) => ({ table, rows: rowsOf(sql, table) }));

    if (all.length > 0 && Result.isSuccess(yield* Effect.result(rebuild(sql, writes, { group: orderedGroup(parents, all), copy: true })))) {
      outcome.rebuilt.push(...all);
      outcome.tables.push(...before.map(({ table, rows }) => ({ table, before: rows, after: rowsOf(sql, table) })));

      return;
    }

    for (const group of groups) {
      yield* bringUp(sql, writes, outcome, { group, declared });

      if (outcome.refused !== null) return;
    }
  });
}

/** The init's statements read, then every stale table brought up, then every stale view made again. */
function bringUpStale(sql: SqlExec, writes: TableWrites, outcome: Outcome): Effect.Effect<void> {
  return Effect.gen(function* () {
    const names = tableNames(sql);
    const held = writes.tables.filter((table) => names.includes(table));

    if (held.length === 0) return;
    const declared = yield* Effect.result(initStatements(sql, writes, held));

    if (Result.isFailure(declared)) {
      outcome.refused = declared.failure.message;

      return;
    }

    outcome.unchecked.push(...held.filter((table) => !declared.success.has(table)));
    yield* bringUpTables(sql, writes, outcome, declared.success);

    if (outcome.refused !== null) return;
    const views = yield* Effect.result(remakeViews(sql, writes, declared.success));

    if (Result.isFailure(views)) outcome.refused = views.failure.message;
    else outcome.rebuilt.push(...views.success);
  });
}

/** Brings a database a release left behind to this build, as the module comment says, and answers what that did. A
 *  database at this build, or one nothing has made yet, needs no repair: it answers null, and its object's own init
 *  makes and stamps it as it would. */
export function repairSchema(sql: SqlExec, writes: TableWrites, database: string): Repair | null {
  return settleSync(Effect.gen(function* () {
    if (readStamp(writes.stamps, sql, writes.schema) !== 'behind') return null;
    const outcome: Outcome = { rebuilt: [], refilled: [], retired: [], unchecked: [], tables: [], refused: null };

    yield* bringUpStale(sql, writes, outcome);

    if (outcome.refused === null) {
      const held = tableNames(sql);

      for (const table of SCHEMA_RETIRED.filter((name) => held.includes(name))) yield* retire(sql, writes, table, outcome);
      writes.init();
      writeStamp(writes.stamps, writes.schema);
    }

    // No duration: a Durable Object's clock stands still while its code runs synchronously, so it would read 0; the
    // invocation's own CPU time in Workers Logs is the cost of a repair.
    const repair: Repair = { schema: writes.schema, ...outcome };

    diagnostics.event('schema.repaired', {
      schema: repair.schema, database, rebuilt: repair.rebuilt.join(','), refilled: repair.refilled.join(','),
      retired: repair.retired.join(','), unchecked: repair.unchecked.join(','), refused: repair.refused ?? '',
      tables: repair.tables.map(({ table, before, after }) => `${table}:${String(before)}->${String(after)}`).join(' '),
    });

    return repair;
  }));
}
