/**
 * A release that reshapes tables. Each Durable Object repairs its own database the first time the new build opens it,
 * before any call reads it (core state/schema-repair.ts), so no step here is needed for a database to be right. This is
 * the deploy's view of those repairs, before and after the upload.
 *
 * THE PLAN, before the upload. The genesis lock (scripts/schema-genesis.lock.json) of the build the deployment serves,
 * diffed against the candidate's: each table that changed, the class whose init makes it (scripts/schema-classes.json),
 * and what its repair does. A reshaped table is rebuilt keeping its rows; a removed one is dropped where it is held; one
 * gaining a NOT NULL column with no default cannot keep its rows, which a regenerable cache (its DDL says so, and what
 * refills it) gives up and any other table refuses. A changed table no class makes is repaired by no object, so it must
 * take this build's writes as it is. Every refusal stops the deploy before the upload; production confirms, in words
 * naming them, the tables whose rows go.
 *
 * THE WALK, after the upload: every object opened once under the candidate, so each repairs itself before a user waits
 * on it, and its census read back with what its repair did. It starts from the accounts `/ops/roots` names (the builtin
 * sign-in directory, every user the control plane has seen, the eval service's own), follows each account to its
 * workspaces and each workspace to its agents, and reaches besides every object Cloudflare lists, which names only
 * objects holding KV data and so misses a database that holds only SQL. A refused, unreachable or row-losing database
 * fails the walk; the census goes beside the record.
 *
 * THE PASS. `/ops/tables` and `/ops/roots` admit a one-time pass this step writes into the deployment's AUTH_KV with
 * wrangler, the authority `reset.ts wipe` deletes with, and deletes when it is done; no session reaches them.
 *
 *   bun scripts/reset.ts tables-plan <environment> <record> [--from <sha>]   the plan, and production's confirmation
 *   bun scripts/reset.ts tables <environment> <record>                      the walk
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import * as v from 'valibot';
import { OPS_OBJECTS_PER_REQUEST, REGENERABLE, sha256Hex, type TablesAnswer } from '@kinu.run/core';
import { restCall } from './cloudflare-rest';
import type { GenesisLock } from './schema-drift';

/** The classes the walk reaches, as `/ops/tables` names them. */
export const RESET_CLASSES = ['UserDO', 'OrchestratorAgent'] as const;

export type ResetClass = (typeof RESET_CLASSES)[number];

/** AUTH_KV's propagation: a pass written now may not be read at the edge for up to a minute. */
const PASS_PROPAGATION_MS = 90_000;

/** A table the release changed: `removed` from the candidate, or `reshaped` in it. */
export interface ChangedTable {
  readonly table: string;
  readonly change: 'removed' | 'reshaped';
}

/** What changed between two locks: the tables that changed, and those only the candidate declares. */
export interface ReleaseTables {
  readonly changed: ChangedTable[];
  readonly added: readonly string[];
}

/** Every table's genesis by name, and the file that declares it. A name two files declare differently is two tables
 *  in two databases, which a change to either could not be told apart in: it is named, and the plan refuses it. */
interface LockTables {
  readonly tables: Map<string, { readonly parts: readonly string[]; readonly file: string }>;
  readonly ambiguous: Set<string>;
}

function byTable(lock: GenesisLock): LockTables {
  const tables = new Map<string, { readonly parts: readonly string[]; readonly file: string }>();
  const ambiguous = new Set<string>();

  for (const [key, parts] of Object.entries(lock)) {
    const table = key.slice(0, key.indexOf('@'));
    const held = tables.get(table);

    if (held !== undefined && !sameParts(held.parts, parts)) ambiguous.add(table);
    tables.set(table, { parts, file: key.slice(key.indexOf('@') + 1) });
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

  for (const [table, { parts }] of [...before.tables].sort(([a], [b]) => a.localeCompare(b))) {
    const now = after.tables.get(table);

    if (now === undefined) changed.push({ table, change: 'removed' });
    else if (!sameParts(now.parts, parts)) changed.push({ table, change: 'reshaped' });
  }

  const added = [...after.tables.keys()].filter((table) => !before.tables.has(table)).sort();
  const touched = ambiguous.filter((table) => added.includes(table) || changed.some((entry) => entry.table === table));

  if (touched.length > 0) {
    throw new Error(`${touched.join(', ')} is declared differently by two files, two tables in two databases, and changed: `
      + 'no repair can tell which store holds which; that needs a full reset (deploy --reset)');
  }

  return { changed, added };
}

/** The word a genesis part starts with when it constrains the table, rather than declaring a column. */
const TABLE_CONSTRAINT = /^(?:PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)\b/iu;

/** A part's column, or null for a table constraint. */
function columnOf(part: string): string | null {
  return TABLE_CONSTRAINT.test(part) ? null : (part.split(/\s+/u)[0] ?? '').replaceAll('"', '');
}

/** A column a row cannot be written without: NOT NULL, no default (or a NULL one), not generated, not a rowid alias. */
function required(part: string): boolean {
  const defaulted = /\bDEFAULT\b/iu.test(part) && !/\bDEFAULT\s+\(?\s*NULL\b/iu.test(part);

  return /\bNOT NULL\b/iu.test(part) && !defaulted && !/\bGENERATED\b|^\S+\s+INTEGER\s+PRIMARY KEY\b/iu.test(part);
}

/** One changed table as the plan finds it. */
export interface TableVerdict {
  readonly table: string;
  /** The classes whose init makes it, in the candidate. */
  readonly classes: readonly string[];
  readonly does: 'rebuild' | 'retire' | 'refill' | 'as-is' | 'local' | 'refuse';
  /** For `refill`, what refills it; for `refuse`, why. */
  readonly why?: string;
}

/** What each repair does to `table`, from its genesis in both locks: `regenerable` is what refills it, when its
 *  candidate DDL declares it a cache. */
export function verdictOf(table: ChangedTable, at: { from: GenesisLock; to: GenesisLock; classes: Readonly<Record<string, readonly string[]>>; regenerable: string | null }): TableVerdict {
  const classes = Object.entries(at.classes).filter(([, tables]) => tables.includes(table.table)).map(([name]) => name);
  const before = byTable(at.from).tables.get(table.table)?.parts ?? [];
  const after = byTable(at.to).tables.get(table.table)?.parts ?? [];
  const held = new Set(before.map(columnOf));
  const added = after.filter((part) => columnOf(part) !== null && !held.has(columnOf(part)));
  const unfillable = added.filter(required).map(columnOf);
  const verdict = { table: table.table, classes };

  if (table.change === 'removed') return { ...verdict, does: 'retire' };

  if (classes.length > 0 && classes.every((name) => name === 'local')) return { ...verdict, does: 'local' };

  if (classes.length === 0) {
    // No object repairs it: it stays as the build before made it, which must take this build's writes.
    const kept = new Set(after.map(columnOf));
    const dropped = before.filter((part) => columnOf(part) !== null && !kept.has(columnOf(part)) && required(part)).map(columnOf);

    const reasons = [
      ...added.length > 0 ? [`it lacks this build's new column(s) ${added.map(columnOf).join(', ')}`] : [],
      ...dropped.length > 0 ? [`its old column(s) ${dropped.join(', ')} refuse this build's rows`] : [],
      ...after.some((part) => columnOf(part) === null && !before.includes(part)) ? ['its constraints changed'] : [],
      ...after.some((part) => columnOf(part) !== null && held.has(columnOf(part)) && !before.includes(part)) ? ['a column it keeps changed'] : [],
    ];

    return reasons.length === 0 ? { ...verdict, does: 'as-is' }
      : { ...verdict, does: 'refuse', why: `no class's init makes it, so no repair reaches it, and as the build before left it ${reasons.join('; ')}` };
  }

  if (unfillable.length === 0) return { ...verdict, does: 'rebuild' };

  return at.regenerable === null
    ? { ...verdict, does: 'refuse', why: `its new column(s) ${unfillable.join(', ')} have no default, so its rows cannot be kept, and its DDL does not declare it a regenerable cache` }
    : { ...verdict, does: 'refill', why: at.regenerable };
}

/** What refills `table`, read off its CREATE statement in `source` (its declaring file), or null for no cache. */
export function regenerableIn(source: string, table: string): string | null {
  const start = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([^\\n]*)`, 'u').exec(source);

  return start === null ? null : REGENERABLE.exec(start[1] ?? '')?.[1] ?? null;
}

/** The plan's lines: what each changed table's repair does, grouped, the tables whose rows go named first. */
export function planLines(verdicts: readonly TableVerdict[], added: readonly string[]): string[] {
  const named = (does: TableVerdict['does']) => verdicts.filter((verdict) => verdict.does === does);
  const line = (verdict: TableVerdict) => `  ${verdict.table} [${verdict.classes.join(', ') || 'no class'}]${verdict.why === undefined ? '' : `: ${verdict.why}`}`;
  const section = (title: string, does: TableVerdict['does']) => (named(does).length === 0 ? [] : [title, ...named(does).map(line)]);

  return [
    ...section('REFUSED (the deploy stops here):', 'refuse'),
    ...section('LOSES DATA, a regenerable cache made anew empty where its rows cannot be copied, then refilled by:', 'refill'),
    ...section('LOSES DATA, dropped where held (no build reads it):', 'retire'),
    ...section('rebuilt where held, every row kept:', 'rebuild'),
    ...section('left as the build before made it, which takes this build\'s writes (no class makes it):', 'as-is'),
    ...section('CLI-local, outside this deploy:', 'local'),
    ...added.length === 0 ? [] : [`added, made by each database's init: ${added.join(', ')}`],
  ];
}

/** The words a production deploy that loses rows is confirmed with, naming every table whose rows go; null where
 *  none does. */
export function confirmation(verdicts: readonly TableVerdict[]): string | null {
  const named = (does: TableVerdict['does']) => verdicts.filter((verdict) => verdict.does === does).map(({ table }) => table).sort().join(',');
  const refill = named('refill');
  const retire = named('retire');

  return refill === '' && retire === '' ? null : `repair tables refill ${refill || '-'} retire ${retire || '-'}`;
}

/** One object as the walk reached it. */
export interface Reached {
  readonly className: ResetClass;
  readonly id: string;
  readonly name?: string;
  readonly answer?: TablesAnswer;
  readonly error?: string;
}

/** One database the walk reached: an account's, a workspace's, or one of a workspace's agents' (`workspace/agent`). */
export interface Store {
  readonly kind: ResetClass | 'agent';
  readonly label: string;
  readonly answer: Pick<TablesAnswer, 'census' | 'repair' | 'refused'>;
}

/** Every database the answers name, a workspace's agents after it; an object that gave none is not one. */
export function storesOf(reached: readonly Reached[]): Store[] {
  return reached.flatMap((object) => {
    if (object.answer === undefined) return [];
    const label = object.answer.name ?? object.name ?? object.id;

    return [
      { kind: object.className, label, answer: object.answer },
      ...object.answer.agents.map((agent): Store => ({ kind: 'agent', label: `${label}/${agent.name}`, answer: agent })),
    ];
  });
}

/** Every table's rows per database, one tab-separated line each, sorted: two of these diff line by line. */
export function censusLines(reached: readonly Reached[]): string[] {
  const unreachable = reached.filter((object) => object.answer === undefined).map((object) => `${object.className}\t${object.name ?? object.id}\t!unreachable\t${object.error ?? ''}`);

  return [...unreachable, ...storesOf(reached).flatMap((store) => store.answer.census.map((row) => `${store.kind}\t${store.label}\t${row.table}\t${String(row.rows)}`))].sort();
}

/** What the walk found, to print, and the databases that fail it. */
export interface WalkReport {
  readonly lines: string[];
  readonly failed: string[];
}

/** What the walk found: each repair, each refusal, each object that did not answer, and each rebuilt table whose rows
 *  moved, which no repair should do. */
export function walkLines(reached: readonly Reached[], listed: number): WalkReport {
  const stores = storesOf(reached);
  const repaired = stores.filter((store) => store.answer.repair !== null && store.answer.refused === null);
  const refused = stores.filter((store) => store.answer.refused !== null).map((store) => `${store.kind} ${store.label}: ${store.answer.refused ?? ''}`);
  const unreached = reached.filter((object) => object.answer === undefined).map((object) => `${object.className} ${object.name ?? object.id}: ${object.error ?? ''}`);

  const moved = repaired.flatMap((store) => (store.answer.repair?.tables ?? [])
    .filter((row) => store.answer.repair?.rebuilt.includes(row.table) === true && row.before !== row.after)
    .map((row) => `${store.kind} ${store.label}: ${row.table} ${String(row.before)} → ${String(row.after)}`));

  const unchecked = stores.flatMap((store) => ((store.answer.repair?.unchecked.length ?? 0) > 0 ? [`${store.kind} ${store.label}: ${store.answer.repair?.unchecked.join(', ') ?? ''}`] : []));

  const did = (store: Store) => {
    const repair = store.answer.repair;
    const parts = [['rebuilt', repair?.rebuilt], ['refilled', repair?.refilled], ['retired', repair?.retired]] as const;

    return `  ${store.kind} ${store.label} (${String(repair?.ms ?? 0)} ms): ${parts.filter(([, tables]) => (tables?.length ?? 0) > 0).map(([what, tables]) => `${what} ${tables?.join(', ') ?? ''}`).join('; ') || 'stamped'}`;
  };

  const section = (title: string, lines: readonly string[]) => (lines.length === 0 ? [] : [title, ...lines.map((line) => `  ${line}`)]);

  return {
    lines: [
      `${String(stores.length)} database(s) in ${String(reached.length)} object(s), ${String(listed)} of them listed by Cloudflare; `
        + `${String(repaired.length)} repaired by this walk (the rest were already at this build, or repaired by a request first)`,
      ...repaired.map(did),
      ...section('UNCHECKED (held, but the init made no shape to compare; left as they are):', unchecked),
      ...section('REFUSED (kept as they are, refusing every call with why):', refused),
      ...section('ROWS MOVED in a rebuild:', moved),
      ...section('UNREACHED:', unreached),
    ],
    failed: [...refused, ...moved, ...unreached],
  };
}

/** What the walk reads and changes outside this file; a test passes its own. */
export interface TablesTarget {
  /** Every object id with stored data in `className`'s namespace, as Cloudflare lists them. */
  objects: (className: ResetClass) => Promise<readonly string[]>;
  /** Writes the pass's digest to AUTH_KV for hours; `forget` deletes it. */
  admit: (digest: string) => void;
  forget: (digest: string) => void;
  /** One `/ops/<path>` call; answers its status, body, and the version that answered (`x-kinu-version`). */
  ops: (pass: string, path: 'tables' | 'roots', body: OpsBody | null) => Promise<{ status: number; text: string; version: string | null }>;
  /** The version the walk must be answered by, and how long another may still answer at an edge after the upload
   *  (scripts/deploy-smoke.sh `ours`): null asks any. */
  candidate: { readonly version: string; readonly propagationMs: number } | null;
  /** How the walk waits between asks. */
  pause: (ms: number) => Promise<void>;
}

/** One `/ops/tables` batch. */
export interface OpsBody {
  readonly class: ResetClass;
  readonly ids: readonly string[];
  readonly names: readonly string[];
}

const RepairSchema = v.object({
  schema: v.picklist(['account', 'workspace', 'agent', 'local']),
  rebuilt: v.array(v.string()),
  refilled: v.array(v.string()),
  retired: v.array(v.string()),
  unchecked: v.array(v.string()),
  tables: v.array(v.object({ table: v.string(), before: v.nullable(v.number()), after: v.nullable(v.number()) })),
  refused: v.nullable(v.string()),
  ms: v.number(),
});

const StoreEntries = {
  census: v.array(v.object({ table: v.string(), rows: v.number() })),
  repair: v.nullable(RepairSchema),
  refused: v.nullable(v.string()),
};

const OpsAnswerSchema = v.object({
  objects: v.array(v.object({
    id: v.string(),
    name: v.optional(v.string()),
    answer: v.optional(v.object({
      name: v.nullable(v.string()),
      ...StoreEntries,
      workspaces: v.array(v.string()),
      accounts: v.array(v.string()),
      agents: v.array(v.object({ name: v.string(), ...StoreEntries })),
    })),
    error: v.optional(v.string()),
  })),
});

const RootsSchema = v.object({ accounts: v.array(v.string()) });

/** One call, asked again while the pass has not reached the edge that answers, and while a version other than the
 *  candidate answers (the build before has no `/ops`, so it answers 404). */
async function askAdmitted<T>(target: TablesTarget, pass: string, call: { path: 'tables' | 'roots'; body: OpsBody | null; schema: v.GenericSchema<T> }): Promise<T> {
  const started = Date.now();

  for (;;) {
    const { status, text, version } = await target.ops(pass, call.path, call.body);
    const elsewhere = target.candidate !== null && version !== target.candidate.version;
    const waited = Date.now() - started;

    if (status === 200 && !elsewhere) return v.parse(call.schema, JSON.parse(text));

    if (elsewhere && waited < (target.candidate?.propagationMs ?? 0)) {
      await target.pause(2_000);
      continue;
    }

    if (status !== 401 || waited > PASS_PROPAGATION_MS) {
      throw new Error(`/ops/${call.path} answered ${String(status)} from version ${version ?? 'none'}${target.candidate === null ? '' : `, not the candidate ${target.candidate.version}`}: ${text.slice(0, 300)}`);
    }

    await target.pause(5_000);
  }
}

/** One walk: the deployment, the pass it was admitted under, and every object it reached, by id. */
interface Walking {
  readonly target: TablesTarget;
  readonly pass: string;
  readonly reached: Map<string, Reached>;
}

/** The objects of `className` named or listed and not yet asked, asked in batches; each answer's leads, kept. */
async function reachEach({ target, pass, reached }: Walking, className: ResetClass, asked: { names: readonly string[]; ids: readonly string[] }): Promise<void> {
  const names = [...new Set(asked.names)].filter((name) => ![...reached.values()].some((object) => object.className === className && object.name === name));
  const ids = [...new Set(asked.ids)].filter((id) => !reached.has(id));
  const batches: OpsBody[] = [];

  for (let at = 0; at < names.length; at += OPS_OBJECTS_PER_REQUEST) batches.push({ class: className, ids: [], names: names.slice(at, at + OPS_OBJECTS_PER_REQUEST) });

  for (let at = 0; at < ids.length; at += OPS_OBJECTS_PER_REQUEST) batches.push({ class: className, ids: ids.slice(at, at + OPS_OBJECTS_PER_REQUEST), names: [] });

  for (const body of batches) {
    const answer = await askAdmitted(target, pass, { path: 'tables', body, schema: OpsAnswerSchema });

    for (const object of answer.objects) if (!reached.has(object.id)) reached.set(object.id, { className, ...object });
  }
}

/** The walk: every account the roots and the builtin directory name, each one's workspaces, and every object
 *  Cloudflare lists besides, each opened once under a pass written for this run and deleted after it. */
export async function walk(target: TablesTarget): Promise<{ readonly reached: Reached[]; readonly listed: number }> {
  const pass = randomBytes(32).toString('base64url');
  const digest = sha256Hex(pass);

  target.admit(digest);

  try {
    const reached = new Map<string, Reached>();
    const walking: Walking = { target, pass, reached };
    const answers = () => [...reached.values()].flatMap((object) => (object.answer === undefined ? [] : [object.answer]));
    const listed = { UserDO: await target.objects('UserDO'), OrchestratorAgent: await target.objects('OrchestratorAgent') };
    let accounts = (await askAdmitted(target, pass, { path: 'roots', body: null, schema: RootsSchema })).accounts;

    // The builtin directory names accounts no other root may: asked until no answer names a new one.
    while (accounts.length > 0) {
      const before = reached.size;

      await reachEach(walking, 'UserDO', { names: accounts, ids: [] });
      accounts = reached.size === before ? [] : answers().flatMap((answer) => answer.accounts);
    }

    await reachEach(walking, 'UserDO', { names: [], ids: listed.UserDO });
    await reachEach(walking, 'OrchestratorAgent', { names: answers().flatMap((answer) => answer.workspaces), ids: [] });
    await reachEach(walking, 'OrchestratorAgent', { names: [], ids: listed.OrchestratorAgent });

    return { reached: [...reached.values()], listed: listed.UserDO.length + listed.OrchestratorAgent.length };
  } finally {
    target.forget(digest);
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
