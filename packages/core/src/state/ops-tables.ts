/**
 * The deploy's tables walk (`scripts/reset.ts tables`): every object of a deployment opened once under this build, so
 * each repairs itself (state/schema-repair.ts) before a user's request has to wait for it, and its census read. The walk
 * changes nothing itself; it is how a release sees what its repairs did, and which objects stayed refused.
 */
import { Effect } from 'effect';
import { createHash } from 'node:crypto';
import * as v from 'valibot';
import { KinuError } from '../obs/error';
import { settle } from '../obs/effect';
import { timingSafeEqual } from '../utils/crypto';
import { rowsOf, tableNames, type Repair } from './schema-repair';
import type { SqlExec, SqlExecRow, SqlValue } from '../types/primitives';

/** A table's rows, as a database held them when it was asked, and a digest of what they hold: two censuses of one
 *  database tell a table a reset left alone (its digest the same) from one it dropped. */
export interface TableRows {
  readonly table: string;
  readonly rows: number;
  readonly digest: string;
  /** For a table whose rows are written once and only ever added (`LEDGERS`), each row as `<ordinal>:<digest>`, oldest
   *  first: a later census tells rows added, and the oldest a full ring let go, from any earlier row lost or rewritten. */
  readonly ledger?: readonly string[];
}

/** Tables whose rows are written once, by the column that orders them. `workspace_activations` keeps 256 rows: the
 *  newest replaces the oldest slot (identity/activations.ts), so its rowids are no order; its ordinal is. */
const LEDGERS = new Map([['workspace_activations', 'ordinal']]);

/** Hex digits of each ledger row's digest: 48 bits, one table's few hundred rows never collide by chance. */
const LEDGER_DIGEST = 12;

/** One database as the walk found it: every table and its rows, what this activation's repair did (null where it found
 *  the database at this build, or an earlier activation repaired it), and why it is refused, if it is. */
export interface StoreCensus {
  readonly census: readonly TableRows[];
  readonly repair: Repair | null;
  readonly refused: string | null;
}

/** One object's answer: its own database, and the names of the objects it leads the walk to. */
export interface TablesAnswer extends StoreCensus {
  /** The workspace's name, for a workspace object; null for an account, which is reached by id or by its user. */
  readonly name: string | null;
  /** An account's workspaces, by the name each object is reached by. */
  readonly workspaces: readonly string[];
  /** The builtin sign-in directory's accounts, by user id. */
  readonly accounts: readonly string[];
  /** A born workspace's agents, each its own database, opened by the workspace. */
  readonly agents: readonly (StoreCensus & { readonly name: string })[];
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

/** Every table `sql` holds and its rows. */
export function censusOf(sql: SqlExec): TableRows[] {
  const keyed = new Set(sql.exec('PRAGMA table_list').toArray().map((row) => v.parse(ListedSchema, row)).filter((row) => row.wr === 1).map((row) => row.name));

  return tableNames(sql).map((table) => {
    const rows = rowsOf(sql, table);
    const digest = digestOf(sql, table, !keyed.has(table));
    const order = LEDGERS.get(table);

    return order === undefined ? { table, rows, digest } : { table, rows, digest, ledger: ledgerOf(sql, table, order) };
  });
}

/** Each row of `table` by `order`, as `<order>:<digest of its values>`; a row without a whole-number order is no ledger
 *  row, and reads as `?`, which no later census matches. */
function ledgerOf(sql: SqlExec, table: string, order: string): string[] {
  return sql.exec(`SELECT * FROM "${table}" ORDER BY "${order}"`).toArray().map((row) => {
    const at = row[order];
    const digest = createHash('sha256').update(JSON.stringify(Object.values(row).map(cellText))).digest('hex').slice(0, LEDGER_DIGEST);

    return `${typeof at === 'number' && Number.isInteger(at) ? String(at) : '?'}:${digest}`;
  });
}

const ListedSchema = v.object({ name: v.string(), wr: v.number() });

/** A value as the digest reads it: a blob by its bytes, so two blobs that differ never read alike. */
function cellText(value: SqlValue): SqlValue | { readonly blob: string } {
  if (value instanceof ArrayBuffer) return { blob: Buffer.from(value).toString('hex') };

  return ArrayBuffer.isView(value) ? { blob: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex') } : value;
}

/** Rows a digest reads at a time: a table is never held whole. */
const DIGEST_PAGE = 1000;

/** SHA-256 over every row of `table`, each row's columns in order: in rowid order a page at a time, or, for a WITHOUT
 *  ROWID table, in its own key order. */
function digestOf(sql: SqlExec, table: string, rowid: boolean): string {
  const hash = createHash('sha256');
  const add = (row: SqlExecRow) => { hash.update(`${JSON.stringify(Object.values(row).map(cellText))}\n`); };

  if (!rowid) {
    for (const row of sql.exec(`SELECT * FROM "${table}"`).toArray()) add(row);

    return hash.digest('hex');
  }

  for (let after = Number.MIN_SAFE_INTEGER; ;) {
    const page = sql.exec(`SELECT rowid AS kinu_rowid, * FROM "${table}" WHERE rowid > ? ORDER BY rowid LIMIT ${String(DIGEST_PAGE)}`, after).toArray();

    for (const row of page) add(row);
    const last = page.at(-1)?.['kinu_rowid'];

    if (page.length < DIGEST_PAGE || typeof last !== 'number') return hash.digest('hex');
    after = last;
  }
}
