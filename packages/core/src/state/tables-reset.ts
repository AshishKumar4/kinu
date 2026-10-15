/**
 * A release's tables reset, as one object carries it out (`scripts/reset.ts tables`). Each table the genesis lock
 * changed between the build a deployment serves and the one it deploys is brought to the candidate's shape here:
 *
 * - a table the candidate no longer declares is dropped;
 * - a reshaped one is rebuilt keeping its rows when it can: its rows are set aside, the table is made anew by the
 *   object's own init, and each row's columns both shapes hold are copied back (its rowid with them), with every table
 *   that refers to it by a foreign key rebuilt alongside, so no cascade runs. A trial in a rolled-back transaction
 *   finds first whether it can; when the copy fails (a new NOT NULL column with no default and no source, or rows the
 *   new constraints refuse) the table is dropped and made anew, its rows lost, and SQLite's reason is the answer's.
 *
 * Which shape is current is read off the candidate's init itself, in a rolled-back transaction: a table is stale while
 * its CREATE statement is not the candidate's, so a rerun changes nothing a finished run made, and a change no column
 * name shows (a CHECK, a key, nullability) is still seen.
 *
 * Reached only with {@link opsCaller}'s capability, which the deployment's `/ops/tables` route mints once the step's
 * pass is presented. No session holds it.
 */
import { Effect } from 'effect';
import * as v from 'valibot';
import { KinuError } from '../obs/error';
import { settle, settleSync } from '../obs/effect';
import { timingSafeEqual } from '../utils/crypto';
import { readStamp, writeStamp, type SchemaClass, type StampReading, type StampStore } from '../identity/schema-stamp';
import type { SqlExec } from '../types/primitives';

const SqlName = v.pipe(v.string(), v.regex(/^[a-z_][a-z0-9_]*$/u));

/** A table the release changed: `removed` from the candidate, or `reshaped` in it. */
const ChangedTableSchema = v.object({ table: SqlName, change: v.picklist(['removed', 'reshaped']) });

export type ChangedTable = v.InferOutput<typeof ChangedTableSchema>;

export const TablesRequestSchema = v.object({ tables: v.array(ChangedTableSchema), drop: v.boolean() });

export type TablesRequest = v.InferOutput<typeof TablesRequestSchema>;

/** One changed table as an object holds it: its rows, whether it is still as the build before left it, and whether
 *  bringing it to the candidate keeps them (rebuilt) or loses them (dropped and made anew). */
export interface HeldTable {
  readonly table: string;
  readonly rows: number;
  readonly stale: boolean;
  readonly keepsRows: boolean;
  /** SQLite's reason the rebuild cannot keep its rows, from the trial. */
  readonly refused?: string;
  /** Tables the release did not change whose rows refer to this one, which dropping it would delete or orphan: it is
   *  left as it is, and the step refuses. */
  readonly cascades?: readonly string[];
}

/** A table's rows, as an object held them when it was asked. */
export interface TableRows {
  readonly table: string;
  readonly rows: number;
}

/** One object's answer: every table it held and its rows, which of the changed ones it held, and what it changed. */
export interface TablesAnswer {
  /** The workspace's name, for a workspace object; null for an account, which is reached by id alone. */
  readonly name: string | null;
  /** Its stamp before this call: `behind` is storage no call but the tables step reads until it is stamped. */
  readonly stamp: StampReading;
  /** Every table, before any drop: a rehearsal diffs two of these, so each count the release did not touch must hold. */
  readonly census: readonly TableRows[];
  readonly held: readonly HeldTable[];
  /** Tables dropped and made anew, their rows lost. */
  readonly dropped: readonly string[];
  /** Tables rebuilt keeping their rows: those changed, and those rebuilt alongside to keep their foreign keys whole. */
  readonly rebuilt: readonly string[];
  /** A workspace's agents, each its own database: by name, what each held and dropped. */
  readonly agents?: readonly AgentTables[];
}

/** One agent's database as its workspace's tables reset reached it. */
export type AgentTables = Omit<TablesAnswer, 'name' | 'agents'> & { readonly name: string };

const OPS_LABEL = 'kinu.deploy.tables.v1';

/** The AUTH_KV row a tables reset's pass is held under, by its digest: the step writes it, `/ops/tables` reads it. */
export const OPS_PASS_PREFIX = 'ops:tables:';

/** Objects per `/ops/tables` request: each is a subrequest, well under the Worker's limit. */
export const OPS_OBJECTS_PER_REQUEST = 50;

/** The capability `/ops/tables` passes each object it reaches. */
export interface OpsCaller {
  readonly opsToken: string;
}

export interface OpsSecretEnv {
  readonly CREDENTIAL_ENCRYPTION_KEY?: string;
}

/** HKDF-SHA-256 of the root secret under the step's own label: no other capability shares its key. */
function opsToken(env: OpsSecretEnv): Effect.Effect<string, KinuError> {
  const secret = (env.CREDENTIAL_ENCRYPTION_KEY ?? '').trim();

  if (secret === '') return Effect.fail(new KinuError('unavailable', 'A tables reset needs CREDENTIAL_ENCRYPTION_KEY, which this deployment does not set.'));
  const encoder = new TextEncoder();

  return Effect.promise(async () => {
    const root = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: encoder.encode(OPS_LABEL) }, root, 256);

    return [...new Uint8Array(bits)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  });
}

/** Only the `/ops/tables` route calls this, once the deployer's Cloudflare token was verified. */
export function opsCaller(env: OpsSecretEnv): Promise<OpsCaller> {
  return settle(Effect.map(opsToken(env), (token) => ({ opsToken: token })));
}

const OpsCallerSchema = v.object({ opsToken: v.pipe(v.string(), v.nonEmpty()) });

/** Fails closed: anything but the derived capability is refused. */
export function requireOps(env: OpsSecretEnv, caller: Partial<OpsCaller> | null | undefined): Promise<void> {
  return settle(Effect.gen(function* () {
    const presented = v.safeParse(OpsCallerSchema, caller);
    const token = yield* opsToken(env);

    if (!presented.success || !timingSafeEqual(presented.output.opsToken, token)) {
      return yield* new KinuError('denied', 'A tables reset is reached only through the deployment\'s /ops/tables route.');
    }
  }));
}

const ColumnSchema = v.object({ name: v.string() });

const CountSchema = v.object({ rows: v.number() });

const TableSchema = v.object({ name: v.string() });

const ReferenceSchema = v.object({ table: v.string() });

const SchemaRowSchema = v.object({ type: v.string(), name: v.string(), tbl_name: v.string(), sql: v.nullable(v.string()) });

type SchemaRow = v.InferOutput<typeof SchemaRowSchema>;

/** Every table `sql` holds and its rows: SQLite's own and the platform's (`_cf_`) are not the product's. */
function census(sql: SqlExec): TableRows[] {
  return sql.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name`)
    .toArray().map((row) => v.parse(TableSchema, row).name)
    .map((table) => ({ table, rows: v.parse(CountSchema, sql.exec(`SELECT COUNT(*) AS rows FROM "${table}"`).toArray()[0]).rows }));
}

/** How an object's own transactions run: only a synchronous throw from the callback rolls one back. */
export interface TableWrites {
  /** The class of database this is, whose stamp it carries, and where it keeps it. */
  schema: SchemaClass;
  stamps: StampStore;
  transactionSync: <A>(write: () => A) => A;
  /** The object's own init, which makes a dropped table anew. */
  init: () => void;
}

/** What a trial's transaction ends on, so nothing it did is kept. */
const TRIAL = new KinuError('cancelled', 'a trial of the tables step, rolled back by design');

/** Runs `work` in one of `writes`' transactions; with `trial`, rolled back once it finished. */
/** A transaction's answer, once its work finished. */
interface Kept<A> {
  answer?: { readonly value: A };
}

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
    Effect.flatMap(() => (kept.answer === undefined ? Effect.die(new Error('a tables transaction kept no answer')) : Effect.succeed(kept.answer.value))),
  );
}

/** One statement, SQLite's refusal its failure; the rows it answered, counted. */
function run(sql: SqlExec, statement: string): Effect.Effect<number, KinuError> {
  return Effect.try({ try: () => sql.exec(statement).toArray().length, catch: (cause) => new KinuError('unsupported', String(cause)) });
}

function schemaRows(sql: SqlExec): SchemaRow[] {
  return sql.exec('SELECT type, name, tbl_name, sql FROM sqlite_master').toArray().map((row) => v.parse(SchemaRowSchema, row));
}

/** A statement as SQLite holds it, with its whitespace made one: two builds' texts compare equal when they say one thing. */
function normal(statement: string | null | undefined): string {
  return (statement ?? '').replace(/\s+/gu, ' ').replace(/\s*([(),])\s*/gu, '$1').trim();
}

/** The tables `sql` holds that refer to `table` by a foreign key. */
function referrers(sql: SqlExec, table: string): string[] {
  return census(sql).map(({ table: other }) => other)
    .filter((other) => other !== table && sql.exec(`PRAGMA foreign_key_list("${other}")`).toArray().some((row) => v.parse(ReferenceSchema, row).table === table));
}

/** `tables` and every table that refers to one of them, transitively, parents before the tables that refer to them. */
function withReferrers(sql: SqlExec, tables: readonly string[]): string[] {
  const group = new Set(tables);

  for (const table of group) for (const other of referrers(sql, table)) group.add(other);

  const parents = (table: string) => sql.exec(`PRAGMA foreign_key_list("${table}")`).toArray()
    .map((row) => v.parse(ReferenceSchema, row).table).filter((parent) => parent !== table && group.has(parent));

  const ordered: string[] = [];

  const place = (table: string, path: readonly string[]): void => {
    if (ordered.includes(table) || path.includes(table)) return;

    for (const parent of parents(table)) place(parent, [...path, table]);
    ordered.push(table);
  };

  for (const table of [...group].sort()) place(table, []);

  return ordered;
}

/** The views whose statement names one of `tables`. */
function viewsOver(rows: readonly SchemaRow[], tables: readonly string[]): SchemaRow[] {
  return rows.filter((row) => row.type === 'view' && tables.some((table) => new RegExp(`\\b${table}\\b`, 'iu').test(row.sql ?? '')));
}

/** The candidate's schema for a group of tables: each table's statement, then its indexes, triggers and views. */
interface CandidateSchema {
  readonly tables: ReadonlyMap<string, string>;
  readonly after: readonly string[];
}

/** What the candidate's init makes of `group`, read in a rolled-back transaction: the group and the views over it
 *  dropped, children first, and the init run over what is left. */
function candidateSchema(sql: SqlExec, writes: TableWrites, group: readonly string[]): Effect.Effect<CandidateSchema, KinuError> {
  return inTransaction(writes, () => Effect.gen(function* () {
    yield* run(sql, 'PRAGMA defer_foreign_keys = ON');

    for (const view of viewsOver(schemaRows(sql), group)) yield* run(sql, `DROP VIEW "${view.name}"`);

    for (const table of [...group].reverse()) yield* run(sql, `DROP TABLE "${table}"`);
    yield* Effect.try({ try: () => { writes.init(); }, catch: (cause) => new KinuError('unsupported', `the init over the rest refused: ${String(cause)}`) });
    const made = schemaRows(sql);
    const on = (type: string) => made.filter((row) => row.type === type && group.includes(row.tbl_name) && row.sql !== null).map((row) => row.sql ?? '');

    return {
      tables: new Map(made.filter((row) => row.type === 'table' && group.includes(row.name)).map((row) => [row.name, row.sql ?? ''])),
      after: [...on('index'), ...on('trigger'), ...viewsOver(made, group).map((row) => row.sql ?? '')],
    };
  }), true);
}

/** The columns a row of `table` stores, generated ones not among them. */
function storedColumns(sql: SqlExec, table: string): string[] {
  return sql.exec(`PRAGMA table_info("${table}")`).toArray().map((row) => v.parse(ColumnSchema, row).name);
}

/** Whether `table` keeps a rowid: a WITHOUT ROWID table refuses to name it. */
function keepsRowid(sql: SqlExec, table: string): Effect.Effect<boolean> {
  return Effect.match(run(sql, `SELECT rowid FROM "${table}" LIMIT 0`), { onSuccess: () => true, onFailure: () => false });
}

/** What a table of a group held before its rebuild: the columns its rows store, and whether it keeps rowids. */
interface Before {
  readonly columns: readonly string[];
  readonly rowid: boolean;
}

/** `group` (parents first) rebuilt in `candidate`'s shape keeping every row's columns both shapes hold, in one
 *  transaction with its foreign keys checked at the end; with `trial`, rolled back. */
function rebuild(sql: SqlExec, writes: TableWrites, change: { group: readonly string[]; candidate: CandidateSchema; trial: boolean }): Effect.Effect<void, KinuError> {
  const { group, candidate, trial } = change;

  return inTransaction(writes, () => Effect.gen(function* () {
    yield* run(sql, 'PRAGMA defer_foreign_keys = ON');
    const before = new Map<string, Before>();

    for (const table of group) before.set(table, { columns: storedColumns(sql, table), rowid: yield* keepsRowid(sql, table) });

    for (const table of group) {
      const selected = before.get(table)?.rowid === true ? 'rowid AS "__kinu_rowid", *' : '*';

      yield* run(sql, `CREATE TABLE "${table}__kinu_rows" AS SELECT ${selected} FROM "${table}"`);
    }

    for (const view of viewsOver(schemaRows(sql), group)) yield* run(sql, `DROP VIEW "${view.name}"`);

    for (const table of [...group].reverse()) yield* run(sql, `DROP TABLE "${table}"`);

    for (const table of group) yield* run(sql, candidate.tables.get(table) ?? '');

    for (const table of group) {
      const old = before.get(table);
      const columns = storedColumns(sql, table).filter((column) => old?.columns.includes(column) === true).map((column) => `"${column}"`);
      const rowid = old?.rowid === true && (yield* keepsRowid(sql, table));
      const into = [...rowid ? ['rowid'] : [], ...columns].join(', ');
      const from = [...rowid ? ['"__kinu_rowid"'] : [], ...columns].join(', ');

      yield* run(sql, `INSERT INTO "${table}" (${into}) SELECT ${from} FROM "${table}__kinu_rows"`);
      yield* run(sql, `DROP TABLE "${table}__kinu_rows"`);
    }

    // After the copy, so a trigger the candidate makes does not run on rows it already accounts for.
    for (const statement of candidate.after) yield* run(sql, statement);
    const orphaned = yield* run(sql, 'PRAGMA foreign_key_check');

    if (orphaned > 0) return yield* new KinuError('unsupported', `the rebuilt rows break ${String(orphaned)} foreign key(s)`);
  }), trial);
}

/** A changed table as the object holds it, before anything is done to it. */
function heldNow(table: ChangedTable, tables: readonly TableRows[]): TableRows | null {
  return tables.find((row) => row.table === table.table) ?? null;
}

/** The plan for one object: what each changed table is, the group each stale altered table is rebuilt in, and whether
 *  that keeps its rows (asked of SQLite itself, in rolled-back transactions). */
function plan(sql: SqlExec, writes: TableWrites, request: TablesRequest, tables: readonly TableRows[]) {
  return Effect.gen(function* () {
    const named = new Set(request.tables.map((table) => table.table));
    const removed = request.tables.filter((table) => table.change === 'removed').flatMap((table) => heldNow(table, tables) ?? []);
    const altered = request.tables.filter((table) => table.change === 'reshaped').flatMap((table) => heldNow(table, tables) ?? []);
    const current = schemaRows(sql);

    const asked = altered.length === 0 ? null : candidateSchema(sql, writes, withReferrers(sql, altered.map(({ table }) => table)));

    const candidate = asked === null ? null : yield* Effect.match(asked, {
      onSuccess: (schema): CandidateSchema | KinuError => schema, onFailure: (failure): CandidateSchema | KinuError => failure,
    });

    const madeBy = candidate === null || candidate instanceof KinuError ? null : candidate;

    const stale = altered.filter(({ table }) => madeBy === null
      || normal(current.find((row) => row.type === 'table' && row.name === table)?.sql) !== normal(madeBy.tables.get(table)));

    const trials = new Map<string, KinuError | null>();

    for (const { table } of stale) {
      const group = withReferrers(sql, [table]);

      const outcome = madeBy === null ? Effect.fail(candidate instanceof KinuError ? candidate : new KinuError('unsupported', 'the candidate made no shape for it'))
        : rebuild(sql, writes, { group, candidate: madeBy, trial: true });

      trials.set(table, yield* Effect.match(outcome, { onSuccess: () => null, onFailure: (failure) => failure }));
    }

    const cascades = (table: string, rows: number) => (rows === 0 ? [] : referrers(sql, table)
      .filter((other) => !named.has(other) && (tables.find((row) => row.table === other)?.rows ?? 0) > 0));

    /** A table whose rows go: left as it is where that would reach rows the release did not change. */
    const losing = (entry: { table: string; rows: number; refused?: string }): HeldTable => {
      const blocked = cascades(entry.table, entry.rows);
      const lost: HeldTable = { ...entry, stale: true, keepsRows: false };

      return blocked.length === 0 ? lost : { ...lost, cascades: blocked };
    };

    const held: HeldTable[] = [
      ...removed.map(({ table, rows }) => losing({ table, rows })),
      ...altered.map(({ table, rows }): HeldTable => {
        if (!stale.some((entry) => entry.table === table)) return { table, rows, stale: false, keepsRows: true };
        const refusal = trials.get(table) ?? null;

        return refusal === null ? { table, rows, stale: true, keepsRows: true } : losing({ table, rows, refused: refusal.message });
      }),
    ];

    return { held, madeBy };
  });
}

/** What `sql` holds of `request`'s tables; with `drop`, each stale one brought to the candidate (rebuilt keeping its
 *  rows where the trial found it can, else dropped), `init` run to make what is missing, and the database stamped as
 *  this build's. A table whose drop would reach rows the release did not change is left as it is. */
export function resetTables(sql: SqlExec, request: TablesRequest, writes: TableWrites): Omit<TablesAnswer, 'name'> {
  return settleSync(Effect.gen(function* () {
    const stamp = readStamp(writes.stamps, sql, writes.schema);
    const tables = census(sql);
    const { held, madeBy } = yield* plan(sql, writes, request, tables);

    if (!request.drop) return { stamp, census: tables, held, dropped: [], rebuilt: [] };
    const kept = held.filter((table) => table.stale && table.keepsRows).map(({ table }) => table);
    const lost = held.filter((table) => table.stale && !table.keepsRows && table.cascades === undefined).map(({ table }) => table);
    const group = kept.length === 0 || madeBy === null ? [] : withReferrers(sql, kept);

    if (group.length > 0 && madeBy !== null) yield* rebuild(sql, writes, { group, candidate: madeBy, trial: false });

    yield* inTransaction(writes, () => Effect.gen(function* () {
      for (const table of lost) yield* run(sql, `DROP TABLE IF EXISTS "${table}"`);

      return lost;
    }), false);

    // Storage behind its stamp ran no init when its object started, so it runs now, whether or not a table changed.
    writes.init();
    writeStamp(writes.stamps, writes.schema);

    return { stamp, census: tables, held, dropped: lost, rebuilt: group };
  }));
}
