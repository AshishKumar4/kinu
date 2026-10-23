/**
 * A release that reshapes tables. Each Durable Object resets its own database the first time the new build opens it,
 * before any call reads it (core state/schema-repair.ts), so no step here is needed for a database to be right. This is
 * the deploy's view of those resets, before and after the upload.
 *
 * THE PLAN, before the upload. The genesis lock (scripts/schema-genesis.lock.json) of the build the deployment serves,
 * diffed against the candidate's: each table that changed, the class whose init makes it (scripts/schema-classes.json),
 * and what its reset does (the owner's rule, 2026-10-20). A reshaped table is dropped where it is held and made anew
 * empty, and so is every table that refers to it by a foreign key or declares itself derived from it, transitively,
 * named with it; a removed one is dropped where it is held. No row is carried over. A changed table no class makes is
 * reset by no object, so it is refused (the drift gate holds every table to a class). Every refusal stops the deploy
 * before the upload; production confirms, in words naming them, every table that is dropped.
 *
 * THE WALK, after the upload: every object opened once under the candidate, so each repairs itself before a user waits
 * on it, and its census read back with what its repair did. It starts from the accounts `/ops/roots` names (the builtin
 * sign-in directory, every user the control plane has seen, the eval service's own), follows each account to its
 * workspaces and each workspace to its agents, and opens every object by its name, never by an id: a workspace opened
 * by id that never recorded its name refuses to construct, and so throws (staging rc12, 2026-10-16). Cloudflare's list
 * of objects is only read beside it, never opened: an object it lists that no root names is counted as unnamed, and
 * repairs at its first request. A refused or row-losing database fails the walk; one it could not reach is a gap in
 * the census, named with why. The census goes beside the record.
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
import { ACTIVATION_SLOTS, derivedFrom, OPS_OBJECTS_PER_REQUEST, sha256Hex, type TablesAnswer } from '@kinu.run/core';
import { restCall } from './cloudflare-rest';
import type { GenesisLock } from './schema-drift';

/** The classes the walk reaches, as `/ops/tables` names them. */
export const RESET_CLASSES = ['UserDO', 'OrchestratorAgent', 'ControlPlaneDO'] as const;

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

/** What a release does to the served build's tables, and the tables it names. */
export interface SchemaChange {
  readonly kind: 'none' | 'additive' | 'changes';
  readonly tables: readonly string[];
}

/**
 * What a release does to the tables of the build a deployment serves, the one place deploys read it (`reset.ts
 * schema-change`, /mnt/local/kinu/bin/stage.sh): `none`; `additive`, tables made and none changed, which ships with
 * --reset-tables on its own, as no database drops anything; `changes`, a table reshaped or removed, which holds for
 * Main and, in production, the owner's migration rule. The tables it names are the added, or the changed with how.
 */
export function schemaChange({ changed, added }: ReleaseTables): SchemaChange {
  if (changed.length > 0) return { kind: 'changes', tables: changed.map(({ table, change }) => `${table} ${change}`) };

  return added.length > 0 ? { kind: 'additive', tables: [...added] } : { kind: 'none', tables: [] };
}

/**
 * Production's refusals of a plan that loses data (the owner, 2026-10-21: "once users come, we either have a one time
 * migration in the workspace onStart, or alter only tables where data loss is acceptable"): one line for each table the
 * plan drops or retires that holds user data, every table but those `acceptable` names (`scripts/schema-loss.json`, each
 * with why), unless the owner's `words` name it. A table no file classes holds user data, so a new one is never lost
 * by being forgotten.
 */
export function lossRefusals(
  verdicts: readonly TableVerdict[], { acceptable, words }: { readonly acceptable: Readonly<Record<string, string>>; readonly words: string | undefined },
): string[] {
  const named = new Set((words ?? '').split(/[^a-z0-9_]+/u));

  return verdicts.filter((verdict) => (verdict.does === 'drop' || verdict.does === 'retire') && !Object.hasOwn(acceptable, verdict.table) && !named.has(verdict.table))
    .map(({ table, classes, does }) => `${table} [${classes.join(', ')}] holds user data, and this release ${does === 'drop' ? 'drops' : 'retires'} it`);
}

/** One changed table as the plan finds it. */
export interface TableVerdict {
  readonly table: string;
  /** The classes whose init makes it, in the candidate. */
  readonly classes: readonly string[];
  readonly does: 'drop' | 'retire' | 'local' | 'refuse';
  /** For a `drop` the table did not change, the table it refers to; for `refuse`, why. */
  readonly why?: string;
}

/** What each reset does to `table`, from its genesis in both locks. */
export function verdictOf(table: ChangedTable, at: { to: GenesisLock; classes: Readonly<Record<string, readonly string[]>> }): TableVerdict {
  const classes = Object.entries(at.classes).filter(([, tables]) => tables.includes(table.table)).map(([name]) => name);
  const after = byTable(at.to).tables.get(table.table)?.parts ?? [];
  const verdict = { table: table.table, classes };

  if (table.change === 'removed') return { ...verdict, does: 'retire' };

  if (classes.length > 0 && classes.every((name) => name === 'local')) return { ...verdict, does: 'local' };

  // A view holds no rows: its class's reset makes it again from the init; none makes one no class's init does.
  if (after.length === 1 && /^SELECT\b/iu.test(after[0] ?? '')) {
    return classes.length > 0 ? { ...verdict, does: 'drop', why: 'a view, made again by its init' }
      : { ...verdict, does: 'refuse', why: 'a view no class\'s init makes, so no reset makes it again' };
  }

  if (classes.length > 0) return { ...verdict, does: 'drop' };

  // The drift gate holds every declared table to a class, so only a candidate it did not pass reaches this.
  return { ...verdict, does: 'refuse', why: 'no class in scripts/schema-classes.json makes it, so no object resets it' };
}

/** The tables `parts` name in a REFERENCES clause. */
function parentsIn(parts: readonly string[]): string[] {
  return parts.flatMap((part) => [...part.matchAll(/\bREFERENCES\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/giu)].map((match) => match[1] ?? ''));
}

/** Each table a candidate file declares derived from others, by the mark beside its DDL (`DERIVED_FROM`): a virtual
 *  table's (an FTS index) too, which the genesis lock does not hold. */
export function derivedIn(source: string): Map<string, string[]> {
  return new Map([...source.matchAll(/CREATE (?:VIRTUAL )?TABLE IF NOT EXISTS (\w+) (?:USING \w+ ?)?\(([^\n]*)/gu)]
    .map((match) => [match[1] ?? '', derivedFrom(match[2])] as const).filter(([, sources]) => sources.length > 0));
}

/** The tables the candidate holds that refer to a dropped one by a foreign key, or declare themselves derived from one
 *  (`derived`, from `derivedIn`), transitively, and are not dropped already: each object drops them with it (core
 *  state/schema-repair.ts), so the plan names each with the table it goes with. A virtual table no lock holds is named
 *  by its mark alone, in the classes of the table it is derived from. */
export function referrersOf(verdicts: readonly TableVerdict[], at: { to: GenesisLock; classes: Readonly<Record<string, readonly string[]>>; derived: ReadonlyMap<string, readonly string[]> }): TableVerdict[] {
  const tables = byTable(at.to).tables;
  const named = new Set(verdicts.filter((verdict) => verdict.does === 'drop' || verdict.does === 'retire').map((verdict) => verdict.table));
  const found: TableVerdict[] = [];
  const classesOf = (table: string) => Object.entries(at.classes).filter(([, held]) => held.includes(table)).map(([name]) => name);

  const held = [...new Set([...tables.keys(), ...at.derived.keys()])].sort();

  for (let grown = true; grown;) {
    grown = false;

    for (const table of held) {
      const parent = parentsIn(tables.get(table)?.parts ?? []).find((name) => named.has(name) && name !== table);
      const source = (at.derived.get(table) ?? []).find((name) => named.has(name) && name !== table);

      if (named.has(table) || (parent === undefined && source === undefined)) continue;
      named.add(table);
      const classes = tables.has(table) ? classesOf(table) : classesOf(source ?? '');

      found.push({ table, classes, does: 'drop', why: parent === undefined ? `dropped with ${source ?? ''}, which it is derived from` : `dropped with ${parent}, which it refers to` });
      grown = true;
    }
  }

  return found;
}

/** The plan's lines: what each changed table's reset does, grouped, the tables whose rows go named first. */
export function planLines(verdicts: readonly TableVerdict[], added: readonly string[]): string[] {
  const named = (does: TableVerdict['does']) => verdicts.filter((verdict) => verdict.does === does);
  const line = (verdict: TableVerdict) => `  ${verdict.table} [${verdict.classes.join(', ') || 'no class'}]${verdict.why === undefined ? '' : `: ${verdict.why}`}`;
  const section = (title: string, does: TableVerdict['does']) => (named(does).length === 0 ? [] : [title, ...named(does).map(line)]);

  return [
    ...section('REFUSED (the deploy stops here):', 'refuse'),
    ...section('LOSES DATA, dropped where held and made anew empty by its init:', 'drop'),
    ...section('LOSES DATA, dropped where held (no build reads it):', 'retire'),
    ...section('CLI-local, outside this deploy:', 'local'),
    ...added.length === 0 ? [] : [`added, made by each database's init: ${added.join(', ')}`],
  ];
}

/** The words a production deploy that drops tables is confirmed with, naming every one; null where none is. */
export function confirmation(verdicts: readonly TableVerdict[]): string | null {
  const named = (does: TableVerdict['does']) => verdicts.filter((verdict) => verdict.does === does).map(({ table }) => table).sort().join(',');
  const drop = named('drop');
  const retire = named('retire');

  return drop === '' && retire === '' ? null : `drop tables ${drop || '-'} retire ${retire || '-'}`;
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

/** Every table's rows and digest per database, one tab-separated line each, sorted: two of these diff line by line, so
 *  a census before a reset and one after show exactly the tables it dropped. */
export function censusLines(reached: readonly Reached[]): string[] {
  const unreachable = reached.filter((object) => object.answer === undefined).map((object) => `${object.className}\t${object.name ?? object.id}\t!unreachable\t${object.error ?? ''}`);

  return [...unreachable, ...storesOf(reached).flatMap((store) => store.answer.census.map((row) => (
    `${store.kind}\t${store.label}\t${row.table}\t${String(row.rows)}\t${row.digest}${row.ledger === undefined ? '' : `\t${row.ledger.join(',')}`}`
  )))].sort();
}

/** One table of one database, as a census line reads (`censusLines`). */
interface CensusRow {
  readonly database: string;
  readonly table: string;
  readonly rows: number;
  readonly digest: string;
  /** A ledger table's rows, ordinal to digest (`censusOf`); null where the census carried none. */
  readonly ledger: ReadonlyMap<number, string> | null;
}

/** The databases a census could not read, and every table of those it did. */
interface Census {
  readonly unreadable: readonly string[];
  readonly rows: ReadonlyMap<string, CensusRow>;
}

function censusOfLines(text: string): Census {
  const lines = text.split('\n').filter((line) => line !== '');
  const unreadable = lines.filter((line) => line.includes('\t!unreachable\t')).map((line) => line.split('\t').slice(0, 2).join('\t'));

  return {
    unreadable,
    rows: new Map(lines.filter((line) => !line.includes('\t!unreachable\t')).map((line): [string, CensusRow] => {
      const [kind = '', label = '', table = '', rows = '', digest = '', ...rest] = line.split('\t');
      const entries = rest.length === 0 ? null : (rest[0] ?? '').split(',').filter((entry) => entry !== '');
      const ledger = entries === null ? null : new Map(entries.map((entry): [number, string] => [Number(entry.split(':')[0]), entry]));

      return [`${kind}\t${label}\t${table}`, { database: `${kind}\t${label}`, table, rows: Number(rows), digest, ledger }];
    })),
  };
}

/** The table each activation of a hosted workspace counts in: one row, whose value moves. */
const GENERATION = 'kinu_workspace_generation';

/** The tables an FTS5 index keeps itself in, beside it: made with it, the rows its creation writes included. */
const FTS_SHADOWS = ['data', 'idx', 'content', 'docsize', 'config'];

/** The planned index whose own table `table` is in its database, by FTS5's names and only where that database holds the
 *  index's `_data` and `_idx`, as every FTS5 index does; undefined for any other table. */
function plannedIndexOf(row: CensusRow, rows: ReadonlyMap<string, CensusRow>, planned: ReadonlySet<string>): string | undefined {
  return [...planned].find((index) => FTS_SHADOWS.some((suffix) => row.table === `${index}_${suffix}`)
    && rows.has(`${row.database}\t${index}_data`) && rows.has(`${row.database}\t${index}_idx`));
}

/** What a census taken after a reset says of one taken before it: the proof a `--reset-tables` deploy keeps. */
export interface CensusDiff {
  readonly lines: readonly string[];
  /** What fails the deploy: on every target, the reset's own structure; on a frozen one, any change outside its plan. */
  readonly failed: readonly string[];
}

/** The rows each ledger table keeps before its newest replaces its oldest: the activations' ring (identity/activations.ts). */
const LEDGER_RING = new Map([['workspace_activations', ACTIVATION_SLOTS]]);

/** A ledger's rows after against before: how many were added, or why the earlier ones are not all there as they were.
 *  A ring at its size lets go exactly as many of its oldest as came past it, and no other row. */
function ledgerRead(was: ReadonlyMap<number, string>, now: ReadonlyMap<number, string>, ring: number): { readonly added: number } | { readonly wrong: string } {
  const newest = Math.max(Number.NEGATIVE_INFINITY, ...was.keys());
  const added = [...now.keys()].filter((at) => at > newest).length;
  const inserted = [...now.keys()].filter((at) => !was.has(at) && at <= newest);
  const rewritten = [...was].filter(([at, row]) => now.has(at) && now.get(at) !== row).map(([at]) => at);
  const gone = [...was.keys()].filter((at) => !now.has(at));
  const kept = [...was.keys()].filter((at) => now.has(at));

  if (rewritten.length > 0) return { wrong: `row(s) ${rewritten.join(', ')} rewritten` };

  if (inserted.length > 0 || [...now.keys()].some((at) => Number.isNaN(at))) return { wrong: 'a row added out of order' };

  if (gone.length !== Math.max(0, was.size + added - ring) || gone.some((at) => kept.some((held) => held < at))) return { wrong: `row(s) ${gone.join(', ')} lost` };

  return { added };
}

/**
 * A ledger read across the one release that crosses into it: the census before came from a build that kept no ledger,
 * so its rows are known by count and digest alone. Fewer rows, or as many with other contents below the ring's size,
 * is a loss; more than one added on a frozen target is a second open. What passes is named as counted only.
 */
function ledgerCounted(said: string, was: CensusRow, now: CensusRow, frozen: boolean): Judged | { readonly kind: 'alike' } {
  const added = now.rows - was.rows;

  if (added === 0 && now.digest === was.digest) return { kind: 'alike' };

  if (added < 0 || (added === 0 && was.rows < (LEDGER_RING.get(was.table) ?? Number.POSITIVE_INFINITY))) return { kind: 'hard', said: `${said}: row(s) lost or rewritten` };

  if (frozen && added > 1) return { kind: 'hard', said: `${said}: ${String(added)} rows added, where one walk opens it once` };

  return { kind: 'expected', said: `${said} (counted only: the census before came from a build before the ledger)` };
}

/** Why a ledger table after a reset is not its rows before and the ones added since; null when it is. On a frozen
 *  target the walk opened each object once, so one row at most is new. */
function ledgerBadly(was: CensusRow, now: CensusRow, frozen: boolean): string | null {
  if (was.ledger === null || now.ledger === null) return 'no row-by-row proof: a census on either side came from a build before the ledger';
  const read = ledgerRead(was.ledger, now.ledger, LEDGER_RING.get(was.table) ?? Number.POSITIVE_INFINITY);

  if ('wrong' in read) return read.wrong;

  return frozen && read.added > 1 ? `${String(read.added)} rows added, where one walk opens it once` : null;
}

/**
 * The census before the upload against the walk's after it. Fails, everywhere: a database either census could not read
 * (no proof of it); a planned table that kept rows (a reset leaves it empty, or gone where retired); a table outside
 * the plan that is gone; a workspace's generation table that holds other than one row; a ledger table (activations)
 * that lost or rewrote an earlier row. The writes a first open makes are named as such: a ledger's new rows, and a
 * generation's moved or made row on a database the walk reset. On a frozen target (staging during a release's eval)
 * every other change outside the plan fails too; on production, where people write all along, it is named only.
 */
export function censusDiff(before: string, after: string, planned: ReadonlySet<string>, frozen: boolean): CensusDiff {
  const was = censusOfLines(before);
  const now = censusOfLines(after);
  const reset = new Set([...was.rows.values()].filter((row) => planned.has(row.table)).map((row) => row.database));
  const found: Findings = { hard: [], soft: [], emptied: [], expected: [], alike: 0 };
  const unproven = (database: string, when: string) => `${database}: not read ${when}, so nothing of it is proven`;

  // A database a census could not read leaves nothing of it proven: no table of it can be judged.
  found.hard.push(...was.unreadable.map((database) => unproven(database, 'before the upload')), ...now.unreadable.map((database) => unproven(database, 'after the walk')));

  for (const [key, row] of was.rows) {
    const index = plannedIndexOf(row, was.rows, planned);
    const judged = index === undefined ? judgedBefore(key, row, now.rows.get(key), { planned, frozen, reset }) : null;

    if (index !== undefined) found.emptied.push(`${key}\tmade anew with ${index}`);
    else if (judged?.kind === 'alike') found.alike += 1;
    else if (judged !== null) found[judged.kind].push(judged.said);
  }

  for (const [key, row] of now.rows) {
    const judged = was.rows.has(key) || plannedIndexOf(row, now.rows, planned) !== undefined ? null : judgedNew(key, row, planned, reset);

    if (judged !== null) found[judged.kind].push(judged.said);
  }

  const section = (title: string, lines: readonly string[]) => (lines.length === 0 ? [] : [`${title} (${String(lines.length)}):`, ...lines.map((line) => `  ${line}`)]);

  return {
    lines: [
      `census-diff: ${String(found.alike)} table(s) as they were`,
      ...section('emptied or retired, as planned', found.emptied),
      ...section('written by a first open, as expected (activations added; a reset database\'s generation)', found.expected),
      ...section('REFUSED, the reset\'s structure', found.hard),
      ...section(frozen ? 'CHANGED OUTSIDE THE PLAN on a frozen target' : 'changed outside the plan, as people wrote (not a failure on production)', found.soft),
    ],
    failed: frozen ? [...found.hard, ...found.soft] : found.hard,
  };
}

/** What a census-diff found, as it goes: the tables that fail anywhere, those that fail on a frozen target, those
 *  the plan emptied, the writes a first open makes, and how many read as they were. */
interface Findings {
  readonly hard: string[];
  readonly soft: string[];
  readonly emptied: string[];
  readonly expected: string[];
  alike: number;
}

/** How one table a census before held reads after: `hard` fails anywhere, `soft` on a frozen target. */
interface Judged {
  readonly kind: 'hard' | 'soft' | 'emptied' | 'expected';
  readonly said: string;
}

interface Judging {
  readonly planned: ReadonlySet<string>;
  readonly frozen: boolean;
  /** The databases holding a planned table: the walk reset them, and their first open writes. */
  readonly reset: ReadonlySet<string>;
}

function judgedBefore(key: string, row: CensusRow, then: CensusRow | undefined, at: Judging): Judged | { readonly kind: 'alike' } {
  const said = `${key}\t${String(row.rows)} → ${then === undefined ? 'gone' : String(then.rows)}`;

  // A planned table is the reset's to drop: whatever it held, it holds nothing after.
  if (at.planned.has(row.table)) return then === undefined || then.rows === 0 ? { kind: 'emptied', said } : { kind: 'hard', said: `${said}: a planned table kept rows` };

  if (then === undefined) return { kind: 'hard', said: `${said}: a table outside the plan is gone` };

  if (row.table === GENERATION) return judgedGeneration(said, row, then, at.reset);

  // A ledger table by its name, whatever the census carried: one without its rows proves nothing of them.
  if (LEDGER_RING.has(row.table)) {
    if (row.ledger === null && then.ledger !== null) return ledgerCounted(said, row, then, at.frozen);
    const wrong = ledgerBadly(row, then, at.frozen);

    if (wrong !== null) return { kind: 'hard', said: `${said}: ${wrong}` };

    return then.rows === row.rows && then.digest === row.digest ? { kind: 'alike' } : { kind: 'expected', said };
  }

  if (then.digest === row.digest && row.digest !== '') return { kind: 'alike' };

  return { kind: 'soft', said: `${said}${row.digest === '' ? ' (no digest before)' : ''}` };
}

/** A workspace's generation is one row before and after; its value moves where the walk reset the database. */
function judgedGeneration(said: string, row: CensusRow, then: CensusRow, reset: ReadonlySet<string>): Judged | { readonly kind: 'alike' } {
  if (row.rows !== 1 || then.rows !== 1) return { kind: 'hard', said: `${said}: a workspace's generation is one row` };

  if (then.digest === row.digest) return { kind: 'alike' };

  return reset.has(row.database) ? { kind: 'expected', said } : { kind: 'soft', said };
}

/** A table only the census after holds: a planned one must be empty; a generation must be one row, made by the walk's
 *  first open on a database it reset. */
function judgedNew(key: string, row: CensusRow, planned: ReadonlySet<string>, reset: ReadonlySet<string>): Judged | null {
  const said = `${key}\tnew, ${String(row.rows)} row(s)`;

  if (planned.has(row.table)) return row.rows === 0 ? null : { kind: 'hard', said: `${said}: a planned table kept rows` };

  if (row.table !== GENERATION) return { kind: 'soft', said };

  if (row.rows !== 1) return { kind: 'hard', said: `${said}: a workspace's generation is one row` };

  return reset.has(row.database) ? { kind: 'expected', said } : { kind: 'soft', said };
}

/** What the walk found, to print, and the databases that fail it: a reset that refused. An object the walk did not reach is a gap in its census, never a failure: it repairs at its first
 *  request, which correctness waits on, and the walk only warms. */
export interface WalkReport {
  readonly lines: string[];
  readonly failed: string[];
}

/** What the walk found: each reset, each refusal, each object that did not answer, and each table a reset dropped. */
export function walkLines({ reached, unnamed }: Walked): WalkReport {
  const stores = storesOf(reached);
  const repaired = stores.filter((store) => store.answer.repair !== null && store.answer.refused === null);
  const refused = stores.filter((store) => store.answer.refused !== null).map((store) => `${store.kind} ${store.label}: ${store.answer.refused ?? ''}`);
  const unreached = reached.filter((object) => object.answer === undefined).map((object) => `${object.className} ${object.name ?? object.id}: ${object.error ?? ''}`);

  const dropped = repaired.flatMap((store) => (store.answer.repair?.tables ?? [])
    .filter((row) => store.answer.repair?.dropped.includes(row.table) === true)
    .map((row) => `${store.kind} ${store.label}: ${row.table} ${String(row.before)} → ${String(row.after)}`));

  const unchecked = stores.flatMap((store) => ((store.answer.repair?.unchecked.length ?? 0) > 0 ? [`${store.kind} ${store.label}: ${store.answer.repair?.unchecked.join(', ') ?? ''}`] : []));

  const did = (store: Store) => {
    const repair = store.answer.repair;
    const parts = [['dropped', repair?.dropped], ['retired', repair?.retired]] as const;

    return `  ${store.kind} ${store.label}: ${parts.filter(([, tables]) => (tables?.length ?? 0) > 0).map(([what, tables]) => `${what} ${tables?.join(', ') ?? ''}`).join('; ') || 'stamped'}`;
  };

  const section = (title: string, lines: readonly string[]) => (lines.length === 0 ? [] : [title, ...lines.map((line) => `  ${line}`)]);

  return {
    lines: [
      `${String(stores.length)} database(s) in ${String(reached.length)} object(s) opened by name; `
        + `${String(repaired.length)} repaired by this walk (the rest were already at this build, or repaired by a request first)`,
      ...repaired.map(did),
      ...section('UNCHECKED (held, but the init made no shape to compare; left as they are):', unchecked),
      ...section('REFUSED (kept as they are, refusing every call with why):', refused),
      ...section('DROPPED and made anew (rows before → after, as each init seeds):', dropped),
      ...section('UNREACHED, a gap in this census (each repairs at its first request on this build):', unreached),
      ...unnamed.length === 0 ? [] : [`${String(unnamed.length)} object(s) Cloudflare lists that no root names, not opened (each repairs at its first `
        + `request): ${unnamed.slice(0, 5).join(', ')}${unnamed.length > 5 ? `, and ${String(unnamed.length - 5)} more` : ''}`],
    ],
    failed: refused,
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

/** One `/ops/tables` batch: objects by name alone. */
export interface OpsBody {
  readonly class: ResetClass;
  readonly names: readonly string[];
}

const RepairSchema = v.object({
  schema: v.picklist(['account', 'workspace', 'agent', 'local', 'control']),
  dropped: v.array(v.string()),
  retired: v.array(v.string()),
  unchecked: v.array(v.string()),
  tables: v.array(v.object({ table: v.string(), before: v.nullable(v.number()), after: v.nullable(v.number()) })),
  refused: v.nullable(v.string()),
});

const StoreEntries = {
  // A build before the digest answers none.
  census: v.array(v.object({ table: v.string(), rows: v.number(), digest: v.optional(v.string(), ''), ledger: v.optional(v.array(v.string())) })),
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

const RootsSchema = v.object({ accounts: v.array(v.string()), control: v.array(v.string()) });

/** One call, asked again while the pass has not reached the edge that answers, and while a version other than the
 *  candidate answers (the build before has no `/ops`, so it answers 404). */
async function askAdmitted<T>(target: TablesTarget, pass: string, call: { path: 'tables' | 'roots'; body: OpsBody | null; schema: v.GenericSchema<unknown, T> }): Promise<T> {
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

/** What an object answers while its host still runs the build before, which has no `opsTables`: a new version reaches
 *  each machine on its own, so an object can start on the old one seconds after every edge serves the new (staging,
 *  2026-10-15: a workspace started on the build before 6 s after the edge served the candidate, in the very batch whose
 *  other workspaces started on the candidate). */
const BUILD_BEFORE = /does not implement the method "opsTables"/u;

/** How long the walk waits before asking such an object again. */
const ASK_AGAIN_MS = 2_000;

/** `names` of `className`, in batches; each answer kept, over any earlier one for the same object. */
async function askEach({ target, pass, reached }: Walking, className: ResetClass, names: readonly string[]): Promise<void> {
  for (let at = 0; at < names.length; at += OPS_OBJECTS_PER_REQUEST) {
    const body: OpsBody = { class: className, names: names.slice(at, at + OPS_OBJECTS_PER_REQUEST) };
    const answer = await askAdmitted(target, pass, { path: 'tables', body, schema: OpsAnswerSchema });

    for (const object of answer.objects) reached.set(object.id, { className, ...object });
  }
}

/** The objects of `className` named and not yet asked, asked in batches; each answer's leads, kept. One that started
 *  on the build before is asked again, for as long as a version may take to reach every machine (the smoke test's
 *  bound); past it, it is a gap in the census, which repairs at its first request on the candidate. */
async function reachEach(walking: Walking, className: ResetClass, named: readonly string[]): Promise<void> {
  const { target, reached } = walking;
  const asked = (name: string) => [...reached.values()].some((object) => object.className === className && object.name === name);

  await askEach(walking, className, [...new Set(named)].filter((name) => !asked(name)));

  for (let left = Math.ceil((target.candidate?.propagationMs ?? 0) / ASK_AGAIN_MS); left > 0; left -= 1) {
    const behind = [...reached.values()].filter((object) => object.className === className && BUILD_BEFORE.test(object.error ?? ''));

    if (behind.length === 0) return;
    await target.pause(ASK_AGAIN_MS);
    await askEach(walking, className, behind.flatMap((object) => object.name ?? []));
  }
}

/** The walk: every account the roots and the builtin directory name, each one's workspaces, and every object
 *  Cloudflare lists besides, each opened once under a pass written for this run and deleted after it. */
/** What the walk opened, and what Cloudflare lists that no root names: ids it read, and did not open. */
export interface Walked {
  readonly reached: Reached[];
  readonly unnamed: string[];
}

export async function walk(target: TablesTarget): Promise<Walked> {
  const pass = randomBytes(32).toString('base64url');
  const digest = sha256Hex(pass);

  target.admit(digest);

  try {
    const reached = new Map<string, Reached>();
    const walking: Walking = { target, pass, reached };
    const answers = () => [...reached.values()].flatMap((object) => (object.answer === undefined ? [] : [object.answer]));
    const listed = { UserDO: await target.objects('UserDO'), OrchestratorAgent: await target.objects('OrchestratorAgent') };
    const roots = await askAdmitted(target, pass, { path: 'roots', body: null, schema: RootsSchema });
    let { accounts } = roots;

    await reachEach(walking, 'ControlPlaneDO', roots.control);

    // The builtin directory names accounts no other root may: asked until no answer names a new one.
    while (accounts.length > 0) {
      const before = reached.size;

      await reachEach(walking, 'UserDO', accounts);
      accounts = reached.size === before ? [] : answers().flatMap((answer) => answer.accounts);
    }

    await reachEach(walking, 'OrchestratorAgent', answers().flatMap((answer) => answer.workspaces));

    return { reached: [...reached.values()], unnamed: [...listed.UserDO, ...listed.OrchestratorAgent].filter((id) => !reached.has(id)) };
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
