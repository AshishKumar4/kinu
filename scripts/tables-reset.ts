/**
 * A tables reset: a release that reshaped or removed some tables, and no others, drops just those on every object
 * that holds them, and each object's own init makes them in the new shape. Every other table, and every workspace's
 * chat and files, stays as it was. A full reset (`reset.ts wipe`) deletes every object; this is for a release that
 * changes so little that wiping would cost every workspace for it.
 *
 * WHICH TABLES. The genesis lock (scripts/schema-genesis.lock.json) of the build the deployment served before, diffed
 * against the candidate's: a table the candidate no longer declares is `removed`, one whose genesis moved is
 * `remade`, unless only columns left it, when they are dropped and its rows kept (`columns`); one only the candidate
 * declares needs nothing (its object's init makes it). No list is written by hand.
 *
 * WHICH OBJECTS. Every object Cloudflare lists in the UserDO and OrchestratorAgent namespaces
 * (`/workers/durable_objects/namespaces/{id}/objects`), reached by id through the candidate's `/ops/tables` route,
 * which asks each what it holds. The class that holds a table is the class whose objects answer with it: measured,
 * never assumed. A changed table no object holds is said so (a CLI-local table is one), and an object that could not
 * answer is named with why.
 *
 * THE PASS. `/ops/tables` admits a one-time pass this step writes into the deployment's AUTH_KV with wrangler, the
 * authority `reset.ts wipe` deletes with, and deletes when it is done; no session reaches the route.
 *
 * SAFE TO STOP AND RUN AGAIN. A remade table is dropped only while its columns differ from the candidate's, a column
 * only while it exists, and a removed table only while it exists, so a rerun changes nothing a finished run made. A
 * change that keeps every column name (a type or a CHECK) cannot be told from the candidate's, and is refused: that
 * needs a full reset. A column SQLite will not drop (a key, an index, a trigger names it) makes its table remade, as
 * a trial drop in a rolled-back transaction finds before the plan prints.
 *
 *   bun scripts/reset.ts census <environment> <out>             every table's rows per object, one line each, sorted
 *   bun scripts/reset.ts tables <environment> <record> [--from <sha>]
 *                                                             the plan, then the drops; production asks for the typed
 *                                                             confirmation that names the tables
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import * as v from 'valibot';
import { OPS_OBJECTS_PER_REQUEST, sha256Hex, type ChangedTable, type TablesAnswer, type TablesRequest } from '@kinu.run/core';
import { restCall } from './cloudflare-rest';
import { columnsOf, type GenesisLock } from './schema-drift';

/** The classes a tables reset reaches, as `/ops/tables` names them. */
export const RESET_CLASSES = ['UserDO', 'OrchestratorAgent'] as const;

export type ResetClass = (typeof RESET_CLASSES)[number];

/** AUTH_KV's propagation: a pass written now may not be read at the edge for up to a minute. */
const PASS_PROPAGATION_MS = 90_000;

/** What changed between two locks: the tables to drop or mend, and those only the candidate declares. */
export interface ReleaseTables {
  readonly changed: ChangedTable[];
  readonly added: readonly string[];
}

/** Every table's genesis by name: its parts across every file that declares it (`table@file`). */
function byTable(lock: GenesisLock): Map<string, string[]> {
  const tables = new Map<string, string[]>();

  for (const [key, parts] of Object.entries(lock)) {
    const table = key.slice(0, key.indexOf('@'));

    tables.set(table, [...tables.get(table) ?? [], ...parts]);
  }

  return tables;
}

/** How `table` moved from `before` to `now`: only columns left it (each part of the rest unchanged), or anything else. */
function change(table: string, before: readonly string[], now: readonly string[]): ChangedTable {
  const columns = columnsOf(now);
  const gone = columnsOf(before).filter((column) => !columns.includes(column));
  const kept = before.filter((part) => !gone.includes(columnsOf([part])[0] ?? ''));
  const onlyColumns = gone.length > 0 && JSON.stringify(kept) === JSON.stringify(now);

  return { table, change: onlyColumns ? 'columns' : 'remade', columns, dropped: onlyColumns ? gone : [] };
}

/** The changed tables, by name, from the two locks: a table's genesis being every file's parts. */
export function changedTables(from: GenesisLock, to: GenesisLock): ReleaseTables {
  const before = byTable(from);
  const after = byTable(to);
  const changed: ChangedTable[] = [];

  for (const [table, parts] of [...before].sort(([a], [b]) => a.localeCompare(b))) {
    const now = after.get(table);

    if (now === undefined) changed.push({ table, change: 'removed', columns: [], dropped: [] });
    else if (JSON.stringify(now) !== JSON.stringify(parts)) changed.push(change(table, parts, now));
  }

  return { changed, added: [...after.keys()].filter((table) => !before.has(table)).sort() };
}

/** A remade table whose column names all stayed (a type, default or constraint moved): no object's columns tell its
 *  old genesis from its new one, so no rerun could know it is done. */
export function undetectableChanges(changed: readonly ChangedTable[], from: GenesisLock): readonly string[] {
  const before = byTable(from);

  return changed.filter((table) => table.change === 'remade').filter((table) => {
    const named = columnsOf(before.get(table.table) ?? []);

    return named.length === table.columns.length && named.every((column) => table.columns.includes(column));
  }).map((table) => table.table);
}

/** One object as a run reached it. */
export interface Reached {
  readonly className: ResetClass;
  readonly id: string;
  readonly answer?: TablesAnswer;
  readonly error?: string;
}

/** The object as a line names it: a workspace by its name, an account by its id. */
function objectLabel(object: Reached): string {
  return object.answer?.name ?? object.id;
}

/** Every table's rows per object, one tab-separated line each, sorted: two of these diff line by line. */
export function censusLines(reached: readonly Reached[]): string[] {
  return reached.flatMap((object) => (object.answer === undefined
    ? [`${object.className}\t${object.id}\t!unreachable\t${object.error ?? ''}`]
    : object.answer.census.map((row) => `${object.className}\t${objectLabel(object)}\t${row.table}\t${String(row.rows)}`)))
    .sort();
}

/** One changed table as the objects hold it: who holds it in the build before's form, and with how many rows. */
function holdersOf(table: ChangedTable, reached: readonly Reached[]) {
  return reached.flatMap((object) => {
    const held = object.answer?.held.find((entry) => entry.table === table.table);

    return held === undefined ? [] : [{ object, held }];
  });
}

/** What a run changes, lossless first, then what loses rows: each table with its class, its change, and per object. */
export function planLines(changed: readonly ChangedTable[], added: readonly string[], reached: readonly Reached[]): string[] {
  const lossless: string[] = [];
  const losing: string[] = [];
  const nobody: string[] = [];

  for (const table of changed) {
    const holders = holdersOf(table, reached);
    const classes = [...new Set(holders.map(({ object }) => object.className))].join(', ');
    const stale = holders.filter(({ held }) => held.stale);

    if (holders.length === 0) nobody.push(`  ${table.table} (${table.change})`);

    for (const { object, held } of stale) {
      const where = `${object.className} ${objectLabel(object)}`;

      if (held.keepsRows) lossless.push(`  ${table.table} [${classes}]: drop column(s) ${table.dropped.join(', ')} on ${where}; its ${String(held.rows)} row(s) kept`);
      else {
        losing.push(`  ${table.table} [${classes}]: ${table.change === 'removed' ? 'drop the table' : 'drop and remake the table'} on ${where}: `
          + `${String(held.rows)} row(s) lost${held.refused === undefined ? '' : ` (SQLite refuses the column drop: ${held.refused})`}`);
      }
    }
  }

  const unreachable = reached.filter((object) => object.answer === undefined).map((object) => `  ${object.className} ${object.id}: ${object.error ?? ''}`);

  return [
    `LOSSLESS (columns dropped, rows kept): ${lossless.length === 0 ? 'none' : ''}`, ...lossless,
    `LOSES DATA (tables dropped): ${losing.length === 0 ? 'none' : ''}`, ...losing,
    ...nobody.length === 0 ? [] : ['held by no UserDO or OrchestratorAgent object (a table only a CLI-local database holds is outside this step):', ...nobody],
    ...added.length === 0 ? [] : [`added, made by each object's init: ${added.join(', ')}`],
    ...unreachable.length === 0 ? [] : ['UNREACHED:', ...unreachable],
  ];
}

/** The words a production tables reset is confirmed with: every table it drops or remakes, every column it drops. */
export function confirmation(changed: readonly ChangedTable[]): string {
  const tables = changed.filter((table) => table.change !== 'columns').map((table) => table.table);
  const columns = changed.filter((table) => table.change === 'columns').flatMap((table) => table.dropped.map((column) => `${table.table}.${column}`));

  return `reset tables ${tables.join(',') || '-'} columns ${columns.join(',') || '-'}`;
}

/** What a tables reset reads and changes outside this file; a test passes its own. */
export interface TablesTarget {
  /** Every object id with stored data in `className`'s namespace, as Cloudflare lists them. */
  objects: (className: ResetClass) => Promise<readonly string[]>;
  /** Writes the pass's digest to AUTH_KV for minutes; `forget` deletes it. */
  admit: (digest: string) => void;
  forget: (digest: string) => void;
  /** One `/ops/tables` call; answers its status and body. */
  ops: (pass: string, body: { readonly class: ResetClass; readonly ids: readonly string[]; readonly request: TablesRequest }) => Promise<{ status: number; text: string }>;
}

const OpsAnswerSchema = v.object({
  objects: v.array(v.object({
    id: v.string(),
    answer: v.optional(v.object({
      name: v.nullable(v.string()),
      census: v.array(v.object({ table: v.string(), rows: v.number() })),
      held: v.array(v.object({ table: v.string(), rows: v.number(), stale: v.boolean(), keepsRows: v.boolean(), refused: v.optional(v.string()) })),
      dropped: v.array(v.string()),
    })),
    error: v.optional(v.string()),
  })),
});

/** Every object of both classes asked `request`, under a pass written for this run and deleted after it. */
export async function reachAll(target: TablesTarget, request: TablesRequest): Promise<Reached[]> {
  const pass = randomBytes(32).toString('base64url');
  const digest = sha256Hex(pass);

  target.admit(digest);

  try {
    const reached: Reached[] = [];

    for (const className of RESET_CLASSES) {
      const ids = await target.objects(className);

      for (let at = 0; at < ids.length; at += OPS_OBJECTS_PER_REQUEST) {
        const answer = await askAdmitted(target, pass, { class: className, ids: ids.slice(at, at + OPS_OBJECTS_PER_REQUEST), request });

        reached.push(...answer.objects.map((object) => ({ className, ...object })));
      }
    }

    return reached;
  } finally {
    target.forget(digest);
  }
}

/** One batch, asked again while the pass has not reached the edge that answers. */
async function askAdmitted(target: TablesTarget, pass: string, body: Parameters<TablesTarget['ops']>[1]): Promise<v.InferOutput<typeof OpsAnswerSchema>> {
  const until = Date.now() + PASS_PROPAGATION_MS;

  for (;;) {
    const { status, text } = await target.ops(pass, body);

    if (status === 200) return v.parse(OpsAnswerSchema, JSON.parse(text));

    if (status !== 401 || Date.now() > until) throw new Error(`/ops/tables answered ${String(status)}: ${text.slice(0, 300)}`);
    await Bun.sleep(5_000);
  }
}

const ObjectsPageSchema = v.object({
  result: v.array(v.object({ id: v.string(), hasStoredData: v.optional(v.boolean()) })),
  result_info: v.optional(v.object({ cursor: v.optional(v.string()) })),
});

/** Every object id Cloudflare lists in `namespace`, page by page, with stored data. */
export async function listedObjects(account: string, namespace: string, token: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;

  do {
    const query = `limit=10000${cursor === undefined || cursor === '' ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
    const page = await restCall({ method: 'GET', path: `/accounts/${account}/workers/durable_objects/namespaces/${namespace}/objects?${query}`, token }, ObjectsPageSchema);

    ids.push(...page.result.filter((object) => object.hasStoredData !== false).map((object) => object.id));
    cursor = page.result.length === 0 ? undefined : page.result_info?.cursor;
  } while (cursor !== undefined && cursor !== '');

  return ids;
}

/** Writes `lines` to `file`, newline-ended. */
export function writeLines(file: string, lines: readonly string[]): void {
  writeFileSync(file, `${lines.join('\n')}\n`);
}
