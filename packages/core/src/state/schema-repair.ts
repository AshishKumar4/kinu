/**
 * A database a release reshaped, reset by its own object the first time this build opens it, before any other event
 * reads it (identity/schema-stamp.ts says when): each table whose shape changed is dropped and made anew, empty, by its
 * class's init (the owner's rule, 2026-10-20: a schema change drops exactly the tables it changed; no row is carried
 * over). Nothing walks the fleet for this, so no database is missed: whatever opens one first resets it.
 *
 * - The shape is the init's own, read in a rolled-back trial (every table the class makes set aside by name, the init
 *   run over the rest): a table is stale while its CREATE statement is not the one the init makes, so a change no
 *   column name shows (a CHECK, a key, nullability) is seen too.
 * - A stale table is dropped with every table that refers to it by a foreign key, or declares itself derived from it
 *   ({@link DERIVED_FROM}), a virtual table (an FTS index) included, transitively: rows left in a kept table would name rows that are gone. The tables and the triggers and views that name them go in one transaction,
 *   the init makes them anew, and a table or view of the group the init does not make is made again as it was, empty.
 * - A table no build declares any longer (`SCHEMA_RETIRED`) is dropped, unless rows a kept table holds refer to it.
 *
 * Then the init runs, the database is stamped, and one event names every table dropped with its rows before.
 * `scripts/tables-reset.ts` plans the same drops from the genesis locks before the upload.
 */
import { Effect, Result } from 'effect';
import * as v from 'valibot';
import { KinuError } from '../obs/error';
import { diagnostics } from '../obs/log';
import { settleSync } from '../obs/effect';
import { readStamp, writeStamp, type SchemaClass, type StampStore } from '../identity/schema-stamp';
import { SCHEMA_RETIRED } from '../identity/schema-genesis';
import type { SqlExec } from '../types/primitives';

/** The mark a table's DDL carries inside its CREATE when its rows are only valid against another table's of the same
 *  database, with no foreign key to say so (a fold over the other's rowids, a key the other's retained rows are judged
 *  by): `/* derived from <table>[, <table>] *\/`. A reset that drops the other drops it too, as it does a foreign key's
 *  referrer, and the plan names it (`scripts/tables-reset.ts`). */
const DERIVED_FROM = /\/\*\s*derived from ([a-z_][a-z0-9_]*(?:\s*,\s*[a-z_][a-z0-9_]*)*)[^*]*\*\//u;

/** The tables `statement` declares itself derived from. */
export function derivedFrom(statement: string | null | undefined): string[] {
  return (DERIVED_FROM.exec(statement ?? '')?.[1] ?? '').split(',').map((name) => name.trim()).filter((name) => name !== '');
}

/** A database as its object resets it: its class and the tables that class makes (`SCHEMA_TABLES`), where its stamp
 *  is kept, its own transactions (only a synchronous throw from the callback rolls one back), and its own init, which
 *  makes its tables in this build's shape. */
export interface TableWrites {
  readonly schema: SchemaClass;
  readonly tables: readonly string[];
  readonly stamps: StampStore;
  readonly transactionSync: <A>(write: () => A) => A;
  readonly init: () => void;
  /** Makes the tables of its class its init leaves to their first use, so the trial reads their shape too. A reset
   *  drops a stale one and leaves it to that first use, which makes it anew. */
  readonly later?: () => void;
}

/** A table a repair dropped, and its rows before and after: after is what the init seeded, null for a retired table. */
export interface TouchedTable {
  readonly table: string;
  readonly before: number | null;
  readonly after: number | null;
}

/** What one repair did. */
export interface Repair {
  readonly schema: SchemaClass;
  /** Tables dropped and made anew empty: those stale, and those dropped with them because they refer to one. */
  readonly dropped: readonly string[];
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

/** The name a table is set aside under while the trial reads the init's shape. */
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

/** Whether `row` is a virtual table: a module's (an FTS index), which no class lists and no foreign key can name. */
function isVirtual(row: SchemaRow): boolean {
  return row.type === 'table' && /^CREATE\s+VIRTUAL\s+TABLE\b/iu.test(row.sql ?? '');
}

/** The statement each of `tables`, each virtual table and each view has as the init (or, for one left to its first use,
 *  `later`) makes it now, read in a rolled-back trial; and which of them only `later` makes. A virtual table is set
 *  aside too, so its statement, and the mark that says what it is derived from, is this build's and not the one the
 *  database was made with. */
function initStatements(sql: SqlExec, writes: TableWrites, tables: readonly string[]): Effect.Effect<Declared, KinuError> {
  return inTransaction(writes, () => Effect.gen(function* () {
    yield* run(sql, 'PRAGMA defer_foreign_keys = ON');
    const rows = schemaRows(sql);
    const virtuals = rows.filter((row) => isVirtual(row) && !tables.includes(row.name)).map((row) => row.name);
    const read = [...tables, ...virtuals];
    const named = dependents(rows, read);

    for (const row of [...named, ...rows.filter((view) => view.type === 'view' && !named.includes(view))]) yield* run(sql, `DROP ${row.type.toUpperCase()} "${row.name}"`);

    for (const table of read) yield* run(sql, `ALTER TABLE "${table}" RENAME TO "${table}${ASIDE}"`);
    yield* Effect.try({ try: () => { writes.init(); }, catch: (cause) => new KinuError('unsupported', `the init refused: ${String(cause)}`) });
    const byInit = new Set(schemaRows(sql).map((row) => row.name));

    yield* Effect.try({ try: () => { writes.later?.(); }, catch: (cause) => new KinuError('unsupported', `a table's first use refused: ${String(cause)}`) });
    const made = schemaRows(sql).filter((row) => (row.type === 'table' && read.includes(row.name)) || row.type === 'view');

    return {
      statements: new Map(made.map((row) => [row.name, row.sql ?? ''])),
      lazy: new Set(made.filter((row) => !byInit.has(row.name)).map((row) => row.name)),
    };
  }), true);
}

/** What the trial read: each statement as this build makes it, and the tables only their first use makes. */
interface Declared {
  readonly statements: ReadonlyMap<string, string>;
  readonly lazy: ReadonlySet<string>;
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

/** `group` (parents first) dropped and made anew by the init, empty but for what the init seeds: the triggers and views
 *  that name it dropped first, the tables children first, the init run, and what of it the init does not make (a table
 *  made after its object started, a view, a trigger or an index of such a table) made again as it was. One transaction,
 *  ending on a foreign key check. */
function reset(sql: SqlExec, writes: TableWrites, group: readonly string[], lazy: ReadonlySet<string>): Effect.Effect<void, KinuError> {
  return inTransaction(writes, () => Effect.gen(function* () {
    yield* run(sql, 'PRAGMA defer_foreign_keys = ON');
    const before = schemaRows(sql);
    const named = dependents(before, group);
    const indexes = before.filter((row) => row.type === 'index' && row.sql !== null && group.includes(row.tbl_name));

    for (const row of [...named].reverse()) yield* run(sql, `DROP ${row.type.toUpperCase()} "${row.name}"`);

    for (const table of [...group].reverse()) yield* run(sql, `DROP TABLE "${table}"`);
    yield* Effect.try({ try: () => { writes.init(); }, catch: (cause) => new KinuError('unsupported', `the init refused: ${String(cause)}`) });
    const present = new Set(schemaRows(sql).filter((row) => row.type === 'table').map((row) => row.name));
    const remade = new Set(group.filter((table) => present.has(table)));

    // A table its first use makes is left to that use, which makes it in this build's shape; a retired one, to no build.
    const kept = (table: string): boolean => !lazy.has(table) && !SCHEMA_RETIRED.includes(table);

    for (const row of before.filter((table) => table.type === 'table' && group.includes(table.name) && !remade.has(table.name) && kept(table.name))) {
      yield* run(sql, row.sql ?? '');
    }

    const made = new Set(schemaRows(sql).map((row) => row.name));

    // What the init made anew is the init's; what it did not make is the database's own, made again as it was.
    for (const row of [...indexes, ...named].filter((dropped) => !made.has(dropped.name) && kept(dropped.tbl_name) && (dropped.type === 'view' || !remade.has(dropped.tbl_name)))) {
      yield* run(sql, row.sql ?? '');
    }

    const orphaned = sql.exec('PRAGMA foreign_key_check').toArray().length;

    if (orphaned > 0) return yield* new KinuError('unsupported', `the reset leaves ${String(orphaned)} foreign key(s) broken`);
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
  readonly dropped: string[];
  readonly retired: string[];
  readonly unchecked: string[];
  readonly tables: TouchedTable[];
  refused: string | null;
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

/** Every stale table, with each table that refers to one, dropped and made anew in one transaction, which runs the init
 *  once; a refusal names them all, in SQLite's words. */
function resetStale(sql: SqlExec, writes: TableWrites, outcome: Outcome, { statements: declared, lazy }: Declared): Effect.Effect<void> {
  return Effect.gen(function* () {
    const names = tableNames(sql);
    const current = new Map(schemaRows(sql).filter((row) => row.type === 'table').map((row) => [row.name, row.sql]));
    const stale = writes.tables.filter((table) => names.includes(table) && declared.has(table) && normal(current.get(table)) !== normal(declared.get(table)));
    // A table derived from another counts as referring to it, as a foreign key's referrer does.
    const parents = new Map([...parentsOf(sql, names)].map(([table, named]) => [table, [...named, ...derivedFrom(declared.get(table)).filter((source) => source !== table)]]));
    const group = orderedGroup(parents, [...new Set(stale.flatMap((table) => groupOf(parents, table)))]);

    if (group.length === 0) return;
    const before = group.map((table) => ({ table, rows: rowsOf(sql, table) }));
    const done = yield* Effect.result(reset(sql, writes, group, lazy));

    if (Result.isFailure(done)) {
      outcome.refused = `${group.join(', ')}: ${done.failure.message}`;

      return;
    }

    // A retired table the group took is retired, as the retire step would have said, and that step finds it gone.
    const retired = new Set(group.filter((table) => SCHEMA_RETIRED.includes(table)));

    outcome.dropped.push(...group.filter((table) => !retired.has(table)));
    outcome.retired.push(...retired);
    // A table left to its first use has no rows until then.
    outcome.tables.push(...before.map(({ table, rows }) => ({ table, before: rows, after: afterReset(sql, table, { lazy, retired }) })));
  });
}

/** A table's rows once a reset made it anew: none until its first use for a table left to it, none ever for a retired one. */
function afterReset(sql: SqlExec, table: string, { lazy, retired }: { lazy: ReadonlySet<string>; retired: ReadonlySet<string> }): number | null {
  if (retired.has(table)) return null;

  return lazy.has(table) ? 0 : rowsOf(sql, table);
}

/** The init's statements read, then every stale table reset, then every stale view made again. */
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

    outcome.unchecked.push(...held.filter((table) => !declared.success.statements.has(table)));
    yield* resetStale(sql, writes, outcome, declared.success);

    if (outcome.refused !== null) return;
    const views = yield* Effect.result(remakeViews(sql, writes, declared.success.statements));

    if (Result.isFailure(views)) outcome.refused = views.failure.message;
    else outcome.dropped.push(...views.success);
  });
}

/** Brings a database a release left behind to this build, as the module comment says, and answers what that did. A
 *  database at this build, or one nothing has made yet, needs no repair: it answers null, and its object's own init
 *  makes and stamps it as it would. */
export function repairSchema(sql: SqlExec, writes: TableWrites, database: string): Repair | null {
  return settleSync(Effect.gen(function* () {
    if (readStamp(writes.stamps, sql, writes.schema) !== 'behind') return null;
    const outcome: Outcome = { dropped: [], retired: [], unchecked: [], tables: [], refused: null };

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
      schema: repair.schema, database, dropped: repair.dropped.join(','),
      retired: repair.retired.join(','), unchecked: repair.unchecked.join(','), refused: repair.refused ?? '',
      tables: repair.tables.map(({ table, before, after }) => `${table}:${String(before)}->${String(after)}`).join(' '),
    });

    return repair;
  }));
}
