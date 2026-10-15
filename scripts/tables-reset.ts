/**
 * A tables reset: a release that reshaped or removed some tables, and no others, drops just those on every object
 * that holds them, and each object's own init makes them in the new shape. Every other table, and every workspace's
 * chat and files, stays as it was. A full reset (`reset.ts wipe`) deletes every object; this is for a release that
 * changes so little that wiping would cost every workspace for it.
 *
 * WHICH TABLES. The genesis lock (scripts/schema-genesis.lock.json) of the build the deployment served before, diffed
 * against the candidate's: a table the candidate no longer declares is `removed`, one whose genesis moved is
 * `reshaped`, one only the candidate declares needs nothing (its object's init makes it). No list is written by hand.
 * Each database rebuilds a reshaped table keeping its rows where a rolled-back trial finds it can, and drops it only
 * where the copy fails (core state/tables-reset.ts).
 *
 * WHICH DATABASES. Every object Cloudflare lists in the UserDO and OrchestratorAgent namespaces
 * (`/workers/durable_objects/namespaces/{id}/objects`), reached by id through the candidate's `/ops/tables` route,
 * which asks each what it holds; each workspace asks every agent database it keeps (`workspace/agent`), a retired
 * agent's too. Which class holds a table is what the databases answer: measured, never assumed. A changed table no
 * database holds is said so (a CLI-local table is one), and an object that could not answer is named with why.
 *
 * STAMPS. Each database carries its class's stamp (core identity/schema-stamp.ts); one behind it answers every call
 * but this step's with why, so the step also brings up databases whose class's tables moved without a change it
 * drops, and stamps each it reaches.
 *
 * THE PASS. `/ops/tables` admits a one-time pass this step writes into the deployment's AUTH_KV with wrangler, the
 * authority `reset.ts wipe` deletes with, and deletes when it is done; no session reaches the route.
 *
 * SAFE TO STOP AND RUN AGAIN. A reshaped table is rebuilt only while its CREATE statement is not the candidate's, and a
 * removed one dropped only while it exists, so a rerun changes nothing a finished run made.
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
import type { GenesisLock } from './schema-drift';

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

/** Every table's genesis by name. A name two files declare differently is two tables in two databases, which a
 *  change to either could not be told apart in: it is named, and the step refuses it. */
interface LockTables {
  readonly tables: Map<string, readonly string[]>;
  readonly ambiguous: Set<string>;
}

function byTable(lock: GenesisLock): LockTables {
  const tables = new Map<string, readonly string[]>();
  const ambiguous = new Set<string>();

  for (const [key, parts] of Object.entries(lock)) {
    const table = key.slice(0, key.indexOf('@'));
    const held = tables.get(table);

    if (held !== undefined && !sameParts(held, parts)) ambiguous.add(table);
    tables.set(table, parts);
  }

  return { tables, ambiguous };
}

/** Two genesis part lists alike in any order, as the drift gate compares them. */
function sameParts(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}

/** The changed tables, by name, from the two locks; a name declared differently in two files throws. */
export function changedTables(from: GenesisLock, to: GenesisLock): ReleaseTables {
  const before = byTable(from);
  const after = byTable(to);
  const ambiguous = [...before.ambiguous, ...after.ambiguous].filter((table, at, all) => all.indexOf(table) === at);
  const changed: ChangedTable[] = [];

  for (const [table, parts] of [...before.tables].sort(([a], [b]) => a.localeCompare(b))) {
    const now = after.tables.get(table);

    if (now === undefined) changed.push({ table, change: 'removed' });
    else if (!sameParts(now, parts)) changed.push({ table, change: 'reshaped' });
  }

  const added = [...after.tables.keys()].filter((table) => !before.tables.has(table)).sort();
  const touched = ambiguous.filter((table) => added.includes(table) || changed.some((entry) => entry.table === table));

  if (touched.length > 0) {
    throw new Error(`${touched.join(', ')} is declared differently by two files, two tables in two databases, and changed: `
      + 'this step cannot tell which store holds which; that needs a full reset (deploy --reset)');
  }

  return { changed, added };
}

/** One object as a run reached it. */
export interface Reached {
  readonly className: ResetClass;
  readonly id: string;
  readonly answer?: TablesAnswer;
  readonly error?: string;
}

/** One database a run reached: an account's, a workspace's, or one of a workspace's agents' (`workspace/agent`). */
export interface Store {
  readonly kind: ResetClass | 'agent';
  readonly label: string;
  readonly answer: Omit<TablesAnswer, 'name' | 'agents'>;
}

/** Every database the answers name, a workspace's agents after it; an object that gave none is not one. */
export function storesOf(reached: readonly Reached[]): Store[] {
  return reached.flatMap((object) => {
    if (object.answer === undefined) return [];
    const label = object.answer.name ?? object.id;

    return [
      { kind: object.className, label, answer: object.answer },
      ...(object.answer.agents ?? []).map((agent): Store => ({ kind: 'agent', label: `${label}/${agent.name}`, answer: agent })),
    ];
  });
}

/** Every table's rows per database, one tab-separated line each, sorted: two of these diff line by line. */
export function censusLines(reached: readonly Reached[]): string[] {
  const unreachable = reached.filter((object) => object.answer === undefined).map((object) => `${object.className}\t${object.id}\t!unreachable\t${object.error ?? ''}`);

  return [...unreachable, ...storesOf(reached).flatMap((store) => store.answer.census.map((row) => `${store.kind}\t${store.label}\t${row.table}\t${String(row.rows)}`))].sort();
}

/** One changed table as the databases hold it: who holds it in the build before's form, and with how many rows. */
function holdersOf(table: ChangedTable, stores: readonly Store[]) {
  return stores.flatMap((store) => {
    const held = store.answer.held.find((entry) => entry.table === table.table);

    return held === undefined ? [] : [{ store, held }];
  });
}

/** What a run changes, lossless first, then what loses rows, then the stamps it brings up: each table with its class,
 *  and per database. */
export function planLines(changed: readonly ChangedTable[], added: readonly string[], reached: readonly Reached[]): string[] {
  const stores = storesOf(reached);
  const lossless: string[] = [];
  const losing: string[] = [];
  const nobody: string[] = [];

  for (const table of changed) {
    const holders = holdersOf(table, stores);
    const classes = [...new Set(holders.map(({ store }) => store.kind))].join(', ');

    if (holders.length === 0) nobody.push(`  ${table.table} (${table.change})`);

    for (const { store, held } of holders.filter((holder) => holder.held.stale)) {
      const where = `${store.kind} ${store.label}`;

      if (held.keepsRows) lossless.push(`  ${table.table} [${classes}]: rebuild on ${where}; its ${String(held.rows)} row(s) kept`);
      else {
        losing.push(`  ${table.table} [${classes}]: ${table.change === 'removed' ? 'drop the table' : 'drop and remake the table'} on ${where}: `
          + `${String(held.rows)} row(s) lost${held.refused === undefined ? '' : ` (${held.refused})`}`);
      }
    }
  }

  const behind = stores.filter((store) => store.answer.stamp === 'behind');
  const unreachable = reached.filter((object) => object.answer === undefined).map((object) => `  ${object.className} ${object.id}: ${object.error ?? ''}`);

  return [
    `LOSSLESS (rebuild, rows kept): ${lossless.length === 0 ? 'none' : ''}`, ...lossless,
    `LOSES DATA (tables dropped): ${losing.length === 0 ? 'none' : ''}`, ...losing,
    `STAMPED (behind this build, refused until reached): ${behindCounts(behind)}`,
    ...nobody.length === 0 ? [] : ['held by no account, workspace or agent database (a CLI-local table is outside this step):', ...nobody],
    ...added.length === 0 ? [] : [`added, made by each database's init: ${added.join(', ')}`],
    ...unreachable.length === 0 ? [] : ['UNREACHED:', ...unreachable],
  ];
}

/** How many databases of each class are behind this build's stamp. */
function behindCounts(behind: readonly Store[]): string {
  const counts = new Map<string, number>();

  for (const store of behind) counts.set(store.kind, (counts.get(store.kind) ?? 0) + 1);

  return counts.size === 0 ? 'none' : [...counts].map(([kind, count]) => `${String(count)} ${kind}`).join(', ');
}

/** Each stale table whose drop would reach rows of a table the release did not change, where: never dropped. */
export function cascadingDrops(reached: readonly Reached[]): string[] {
  return storesOf(reached).flatMap((store) => store.answer.held.filter((held) => (held.cascades?.length ?? 0) > 0)
    .map((held) => `${held.table} on ${store.kind} ${store.label}, whose rows ${held.cascades?.join(', ') ?? ''} refer to`));
}

/** A changed table some database holds that no class's stamp covers: made lazily, after its object started, so a
 *  database holding its old genesis is never refused, and this step cannot tell when it is done. */
export function unstampedTables(changed: readonly ChangedTable[], classes: Readonly<Record<string, readonly string[]>>, reached: readonly Reached[]): string[] {
  const stamped = new Set(Object.values(classes).flat());
  const stores = storesOf(reached);

  return changed.filter((table) => table.change !== 'removed' && !stamped.has(table.table) && holdersOf(table, stores).length > 0).map((table) => table.table);
}

/** The words a production tables reset is confirmed with: every table it rebuilds, and every one whose rows it drops. */
export function confirmation(reached: readonly Reached[]): string {
  const held = storesOf(reached).flatMap((store) => store.answer.held.filter((table) => table.stale));
  const named = (keeps: boolean) => [...new Set(held.filter((table) => table.keepsRows === keeps).map((table) => table.table))].sort().join(',') || '-';

  return `reset tables rebuild ${named(true)} drop ${named(false)}`;
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

const StoreAnswerEntries = {
  stamp: v.picklist(['current', 'unmade', 'behind']),
  rebuilt: v.array(v.string()),
  census: v.array(v.object({ table: v.string(), rows: v.number() })),
  held: v.array(v.object({
    table: v.string(), rows: v.number(), stale: v.boolean(), keepsRows: v.boolean(), refused: v.optional(v.string()), cascades: v.optional(v.array(v.string())),
  })),
  dropped: v.array(v.string()),
};

const OpsAnswerSchema = v.object({
  objects: v.array(v.object({
    id: v.string(),
    answer: v.optional(v.object({
      name: v.nullable(v.string()),
      ...StoreAnswerEntries,
      agents: v.optional(v.array(v.object({ name: v.string(), ...StoreAnswerEntries }))),
    })),
    error: v.optional(v.string()),
  })),
});

/** Every object of both classes asked `request`, under a pass written for this run and deleted after it: those the
 *  listing names, and every one in `met` besides, which an earlier pass reached and a later listing may not name. */
export async function reachAll(target: TablesTarget, request: TablesRequest, met: readonly Reached[] = []): Promise<Reached[]> {
  const pass = randomBytes(32).toString('base64url');
  const digest = sha256Hex(pass);

  target.admit(digest);

  try {
    const reached: Reached[] = [];

    for (const className of RESET_CLASSES) {
      const listed = await target.objects(className);
      const ids = [...new Set([...listed, ...met.filter((object) => object.className === className).map((object) => object.id)])];

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

/** The census lines two runs disagree on, as `table: before → after` per database; `changed` names the tables the
 *  release meant to change, so every other line is one it should not have moved. */
export interface CensusDiff {
  readonly meant: string[];
  readonly unmeant: string[];
}

export function censusDiff(before: readonly string[], after: readonly string[], changed: ReadonlySet<string>): CensusDiff {
  const rows = (lines: readonly string[]) => new Map(lines.map((line) => {
    const [kind, label, table, count] = line.split('\t');

    return [`${kind ?? ''}\t${label ?? ''}\t${table ?? ''}`, count ?? ''];
  }));

  const was = rows(before);
  const now = rows(after);
  const meant: string[] = [];
  const unmeant: string[] = [];

  for (const key of [...new Set([...was.keys(), ...now.keys()])].sort()) {
    if (was.get(key) === now.get(key)) continue;
    const line = `${key.replaceAll('\t', ' ')}: ${was.get(key) ?? '-'} → ${now.get(key) ?? '-'}`;

    (changed.has(key.split('\t')[2] ?? '') ? meant : unmeant).push(line);
  }

  return { meant, unmeant };
}

/** Writes `lines` to `file`, newline-ended. */
export function writeLines(file: string, lines: readonly string[]): void {
  writeFileSync(file, `${lines.join('\n')}\n`);
}
