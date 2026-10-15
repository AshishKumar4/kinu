/**
 * A release's tables reset, as one object carries it out (`scripts/reset.ts tables`). The tables the genesis lock
 * changed between the build a deployment serves and the one it deploys are counted here, and dropped only while they
 * still hold the old shape, so a stopped run can be run again; the object's own init then makes them in the new one.
 * Nothing else is touched: no column is moved, no row is kept.
 *
 * Reached only with {@link opsCaller}'s capability, which the deployment's `/ops/tables` route mints after the
 * deployer's Cloudflare token proved it administers this account's Workers. No session holds it.
 */
import { Effect } from 'effect';
import * as v from 'valibot';
import { KinuError } from '../obs/error';
import { settle, settleSync } from '../obs/effect';
import { timingSafeEqual } from '../utils/crypto';
import type { SqlExec } from '../types/primitives';

const SqlName = v.pipe(v.string(), v.regex(/^[a-z_][a-z0-9_]*$/u));

/**
 * A table the release changed. `removed`: the candidate declares it no more, so it is dropped. `columns`: only
 * `dropped` columns left it, so they are dropped and every row kept, unless SQLite refuses (a key, an index, a
 * trigger names one), when it is remade. `remade`: any other change, so it is dropped and its init makes it anew, its
 * rows lost. `columns` is what the candidate gives it, by name; empty if removed.
 */
const ChangedTableSchema = v.object({
  table: SqlName,
  change: v.picklist(['removed', 'columns', 'remade']),
  columns: v.array(SqlName),
  dropped: v.array(SqlName),
});

export type ChangedTable = v.InferOutput<typeof ChangedTableSchema>;

export const TablesRequestSchema = v.object({ tables: v.array(ChangedTableSchema), drop: v.boolean() });

export type TablesRequest = v.InferOutput<typeof TablesRequestSchema>;

/** One changed table as an object holds it: its rows, whether it is still as the build before left it, and whether
 *  bringing it to the candidate keeps those rows (its columns dropped) or loses them (it is dropped and made anew). */
export interface HeldTable {
  readonly table: string;
  readonly rows: number;
  readonly stale: boolean;
  readonly keepsRows: boolean;
  /** Why SQLite refused to drop a column here, which makes the table one remade. */
  readonly refused?: string;
}

/** A table's rows, as an object held them when it was asked. */
export interface TableRows {
  readonly table: string;
  readonly rows: number;
}

/** One object's answer: every table it held and its rows, which of the changed ones it held, and what it changed:
 *  `table` for a table dropped, `table.column` for a column. */
export interface TablesAnswer {
  /** The workspace's name, for a workspace object; null for an account, which is reached by id alone. */
  readonly name: string | null;
  /** Every table, before any drop: a rehearsal diffs two of these, so each count the release did not touch must hold. */
  readonly census: readonly TableRows[];
  readonly held: readonly HeldTable[];
  readonly dropped: readonly string[];
}

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

/** Every table `sql` holds and its rows: SQLite's own and the platform's (`_cf_`) are not the product's. */
function census(sql: SqlExec): TableRows[] {
  return sql.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name`)
    .toArray().map((row) => v.parse(TableSchema, row).name)
    .map((table) => ({ table, rows: v.parse(CountSchema, sql.exec(`SELECT COUNT(*) AS rows FROM "${table}"`).toArray()[0]).rows }));
}

/** How an object's own transactions run: only a synchronous throw from the callback rolls one back. */
export interface TableWrites {
  transactionSync: <A>(write: () => A) => A;
  /** The object's own init, which makes a dropped table anew. */
  init: () => void;
}

/** The answer a trial's transaction ends on, so nothing it did is kept. */
const TRIAL = new KinuError('cancelled', 'a trial drop of columns, rolled back by design');

/** `columns` dropped from `table` in `writes`' transaction; with `trial`, rolled back once they all were. SQLite's
 *  refusal (a key, an index, a trigger names one) is the answer's failure. */
function dropColumns(sql: SqlExec, writes: TableWrites, change: { table: string; columns: readonly string[]; trial: boolean }): Effect.Effect<void, KinuError> {
  const { table, columns, trial } = change;

  return Effect.try({
    try: () => writes.transactionSync(() => settleSync(Effect.gen(function* () {
      for (const column of columns) {
        yield* Effect.try({ try: () => sql.exec(`ALTER TABLE "${table}" DROP COLUMN "${column}"`), catch: (cause) => new KinuError('unsupported', `${table}.${column}: ${String(cause)}`) });
      }

      if (trial) return yield* TRIAL;
    }))),
    catch: (cause) => (cause instanceof KinuError ? cause : new KinuError('unsupported', String(cause))),
  }).pipe(Effect.catch((failure) => (failure === TRIAL ? Effect.void : Effect.fail(failure))));
}

/** `table` as `sql` holds it: absent, or its rows, whether the build before left it so, and whether that is mended
 *  keeping its rows (asked of SQLite itself, in a transaction rolled back). */
function held(sql: SqlExec, writes: TableWrites, changed: ChangedTable): Effect.Effect<HeldTable | null> {
  return Effect.suspend(() => {
    const columns = sql.exec(`PRAGMA table_info("${changed.table}")`).toArray().map((row) => v.parse(ColumnSchema, row).name);

    if (columns.length === 0) return Effect.succeed(null);
    const rows = v.parse(CountSchema, sql.exec(`SELECT COUNT(*) AS rows FROM "${changed.table}"`).toArray()[0]).rows;
    const wanted = new Set(changed.columns);
    const present = changed.dropped.filter((column) => columns.includes(column));

    if (changed.change === 'removed') return Effect.succeed({ table: changed.table, rows, stale: true, keepsRows: false });

    if (changed.change === 'remade') {
      const stale = columns.length !== wanted.size || columns.some((column) => !wanted.has(column));

      return Effect.succeed({ table: changed.table, rows, stale, keepsRows: !stale });
    }

    if (present.length === 0) return Effect.succeed({ table: changed.table, rows, stale: false, keepsRows: true });

    return Effect.match(dropColumns(sql, writes, { table: changed.table, columns: present, trial: true }), {
      onSuccess: (): HeldTable => ({ table: changed.table, rows, stale: true, keepsRows: true }),
      onFailure: (refusal): HeldTable => ({ table: changed.table, rows, stale: true, keepsRows: false, refused: refusal.message }),
    });
  });
}

/** One stale table brought to the candidate: its columns dropped where SQLite allows, else the table dropped. */
function mend(sql: SqlExec, writes: TableWrites, changed: ChangedTable, table: HeldTable): Effect.Effect<string[]> {
  const present = changed.dropped.filter((column) => sql.exec(`PRAGMA table_info("${changed.table}")`).toArray()
    .some((row) => v.parse(ColumnSchema, row).name === column));

  const dropTable = Effect.sync(() => {
    writes.transactionSync(() => sql.exec(`DROP TABLE IF EXISTS "${changed.table}"`));

    return [changed.table];
  });

  if (!table.keepsRows) return dropTable;

  return Effect.match(dropColumns(sql, writes, { table: changed.table, columns: present, trial: false }), {
    onSuccess: () => present.map((column) => `${changed.table}.${column}`),
    onFailure: (): string[] => [],
  }).pipe(Effect.flatMap((dropped) => (dropped.length > 0 || present.length === 0 ? Effect.succeed(dropped) : dropTable)));
}

/** What `sql` holds of `request`'s tables; with `drop`, each stale one mended (columns dropped, or the table dropped,
 *  and `init` run to make it anew). */
export function resetTables(sql: SqlExec, request: TablesRequest, writes: TableWrites): Omit<TablesAnswer, 'name'> {
  return settleSync(Effect.gen(function* () {
    const tables = census(sql);
    const changed = new Map(request.tables.map((table) => [table.table, table]));
    const before = (yield* Effect.forEach(request.tables, (table) => held(sql, writes, table))).flatMap((table) => table ?? []);
    const stale = before.filter((table) => table.stale);

    if (!request.drop || stale.length === 0) return { census: tables, held: before, dropped: [] };

    const dropped = (yield* Effect.forEach(stale, (table) => {
      const declared = changed.get(table.table);

      return declared === undefined ? Effect.succeed([]) : mend(sql, writes, declared, table);
    })).flat();

    if (dropped.some((name) => !name.includes('.'))) writes.init();

    return { census: tables, held: before, dropped };
  }));
}
