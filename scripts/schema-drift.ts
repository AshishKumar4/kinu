/**
 * Schema-drift gate — a shipped table's DDL is its genesis, and the two must
 * agree.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op on a table that already exists, so a
 * column added later never reaches storage created before it while every reader
 * still names it. Three live failures before this repository stopped carrying
 * column reconciles: `no such column: code_language` in a workspace,
 * `scaffold_versions` (`status`, `parent_version`) before it, and, 2026-09-01 in
 * production, `no such column: unstopped_at` from `GET /api/cli/devices`.
 *
 * This repository carries NO column reconcile, no rebuild and no mover. The
 * DDL a reset deployment ships is the shape every row it ever writes has, and
 * `scripts/schema-genesis.lock.json` records that shape per `table@file`. The
 * gate compares today's DDL against the lock in BOTH directions: a column the
 * DDL has and the lock does not never reaches storage created at genesis; a
 * column the lock has and the DDL does not is still in that storage, and a
 * NOT NULL one without a default refuses every insert that omits it.
 *
 * WHAT IT MEASURES and WHAT IT GOVERNS are the same set, and that is checked
 * rather than claimed: every `CREATE TABLE IF NOT EXISTS` in the product corpus
 * `scripts/sources.ts` enumerates. A DDL this cannot parse FAILS the gate. The
 * previous regex required the closing paren on its own line and read the table
 * name as `\w+`, so it measured 114 of 126 statements while reporting on all of
 * them: four real tables whose column list arrives through a `${DDL}` template
 * constant were invisible (`turn_outcomes`, `lessons`, `imported_experience`,
 * `experience_library`), and three prose sentences about this very mechanism
 * were counted as tables named `is`, `will` and `quietly`.
 *
 * `--lock` writes an entry for a table that has none and REFUSES to change one
 * that has: a genesis is a fact about deployed storage, and a gate whose
 * baseline the failing change may rewrite is an ignore list with extra steps.
 * A table whose shape must change therefore has two fixes: put the new columns
 * in a table of their own, or reset production and re-lock (delete the lock
 * file, run `--lock`, and state the reset in the commit body). The lock was
 * re-locked that way once, at the reset deployment this gate now describes.
 *
 * The lock is a HISTORY, not a debt ratchet, so it differs from
 * `gate-ratchet`'s rule on one point deliberately: an entry whose table is no
 * longer in the corpus is RETAINED and printed, never dropped. Storage created
 * under that DDL still exists, and re-adding the name later must inherit the
 * older genesis rather than a fresh one.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as v from 'valibot';
import { assertMeasured, finding } from './gate-ratchet';
import { isProductSource, readMatching } from './sources';

const root = new URL('..', import.meta.url).pathname;
const GENESIS_LOCK = `${root}scripts/schema-genesis.lock.json`;

/** The name and the opening of a table body: `(` for an inline column list,
 *  `${IDENT}` for the four DDLs whose body is a template constant. A prose
 *  mention of this statement has neither, which is what keeps `… IF NOT EXISTS
 *  is a no-op …` out of the table census. */
const DDL_RE = /CREATE TABLE IF NOT EXISTS\s+([a-z_][a-z0-9_]*)\s*(?:\(|\$\{\s*([A-Za-z_$][\w$]*)\s*\})/g;

/** A body part opening a table CONSTRAINT rather than naming a column. */
const CONSTRAINT_KEYWORD = {
  PRIMARY: true, UNIQUE: true, FOREIGN: true, CHECK: true, CONSTRAINT: true,
} satisfies Record<string, true>;

export interface Violation {
  readonly key: string;
  readonly detail: string;
}

/** One table's DDL as the corpus declares it. `columns` is DDL order. A table
 *  declared twice in one file carries the UNION: both statements reach the same
 *  storage, so a column in either one is a column a reader may name. */
export interface TableDdl {
  readonly table: string;
  readonly file: string;
  readonly columns: readonly string[];
}

/** The genesis lock's key. Table AND file, because three table names are
 *  declared in more than one module (`crafted_tools`, `traces`, `fibers`) and
 *  those are different databases with their own histories. */
export function lockKey(table: string, file: string): string {
  return `${table}@${file}`;
}

/** The text between `openIndex`'s paren and its match, so a nested `CHECK (…)`
 *  or `DEFAULT (unixepoch() * 1000)` cannot end the body early. */
function balancedBody(source: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, i);
    }
  }
  throw new Error('schema-drift: a CREATE TABLE body has no closing paren');
}

/** The template constant a `CREATE TABLE IF NOT EXISTS t ${DDL}` interpolates.
 *  Resolved textually and fail-closed: an unresolvable body is a parse failure,
 *  never a table quietly left out of the census. */
function interpolatedBody(source: string, file: string, table: string, name: string): string {
  const declaration = new RegExp(`(?:const|let|var)\\s+${name}\\s*(?::[^=]+)?=\\s*\`\\s*\\(`).exec(source);
  if (declaration === null) {
    throw new Error(
      `schema-drift: ${file} builds ${table} from \${${name}}, which is not a local template beginning with '('`,
    );
  }
  return balancedBody(source, source.indexOf('(', declaration.index));
}

/** The keys of an object literal declared in this file, in declaration order.
 *  A column block generated from an object IS that object's key set, so reading
 *  it is the only way to see those columns at all. */
function objectLiteralKeys(source: string, file: string, table: string, name: string): string[] {
  const declaration = new RegExp(`(?:const|let|var)\\s+${name}\\s*(?::[^=]+)?=\\s*\\{`).exec(source);
  if (declaration === null) {
    throw new Error(`schema-drift: ${file}: ${table} builds columns from ${name}, which is not a local object`);
  }
  const open = source.indexOf('{', declaration.index);
  let depth = 0;
  let end = source.length;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  // Keys at the object's own nesting level, so a one-line object reads the same
  // as a formatted one and a nested value's keys are never counted as columns.
  const keys: string[] = [];
  let level = 0;
  for (const part of source.slice(open + 1, end).split(',')) {
    if (level === 0) {
      const key = /^\s*([a-z_][a-z0-9_]*)\s*:/.exec(part)?.[1];
      if (key !== undefined) keys.push(key);
    }
    for (const ch of part) {
      if (ch === '{' || ch === '(' || ch === '[') level += 1;
      if (ch === '}' || ch === ')' || ch === ']') level -= 1;
    }
  }
  if (keys.length === 0) {
    throw new Error(`schema-drift: ${file}: ${table} builds columns from ${name}, which has no keys`);
  }
  return keys;
}

/** The declaration statement of `name`, so an indirection through a constant
 *  can be followed one step: `const IDENTITY_COLUMN_DDL = Object.entries(…)`. */
function declarationStatement(source: string, name: string): string | null {
  const declaration = new RegExp(`(?:const|let|var)\\s+${name}\\s*(?::[^=]+)?=`).exec(source);
  if (declaration === null) return null;
  let depth = 0;
  let quote = '';
  for (let i = declaration.index; i < source.length; i += 1) {
    const ch = source[i] ?? '';
    if (quote !== '') {
      if (ch === quote && source[i - 1] !== '\\') quote = '';
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '{' || ch === '[') depth += 1;
    if (ch === ')' || ch === '}' || ch === ']') depth -= 1;
    if (ch === ';' && depth === 0) return source.slice(declaration.index, i);
  }
  return source.slice(declaration.index);
}

/** A column block a template builds rather than spells: either
 *  `${Object.entries(OBJ).map(…)}` inline, or `${CONST}` where CONST is that
 *  expression. Fail-closed — an interpolation neither shape covers is a parse
 *  failure, never a table quietly left out of the census. */
function generatedColumns(source: string, file: string, table: string, part: string): string[] {
  const inline = /\$\{\s*Object\.(?:entries|keys)\(\s*([A-Za-z_$][\w$]*)\s*\)/.exec(part)?.[1];
  if (inline !== undefined) return objectLiteralKeys(source, file, table, inline);

  const constant = /^\$\{\s*([A-Za-z_$][\w$]*)\s*\}$/.exec(part)?.[1];
  const statement = constant === undefined ? null : declarationStatement(source, constant);
  const indirect = statement === null
    ? undefined
    : /Object\.(?:entries|keys)\(\s*([A-Za-z_$][\w$]*)\s*\)/.exec(statement)?.[1];
  if (indirect !== undefined) return objectLiteralKeys(source, file, table, indirect);

  throw new Error(
    `schema-drift: ${file}: ${table} has a body part this cannot read: ${part.slice(0, 60)}`,
  );
}

/** The index of the `}` that closes the `${` at `start`. Nested interpolations
 *  inside a template argument balance out, so plain brace counting is enough. */
function closingBrace(body: string, start: number): number {
  let depth = 0;
  for (let i = start; i < body.length; i += 1) {
    if (body[i] === '{') depth += 1;
    else if (body[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error('schema-drift: an interpolated DDL body has no closing brace');
}

/**
 * The body with every TOP-LEVEL interpolation replaced by the columns it
 * generates, so the comma split below reads generated and spelled columns
 * alike. Only top level: an interpolation INSIDE a column definition —
 * `CHECK (outcome IN (${TURN_OUTCOMES.map(…)}))` — is part of that column, not a
 * column list, and resolving it would fail on a DDL that is perfectly readable.
 */
function expandColumnBlocks(body: string, source: string, file: string, table: string): string {
  let out = '';
  let depth = 0;
  let i = 0;
  while (i < body.length) {
    const ch = body[i] ?? '';
    if (ch === '$' && body[i + 1] === '{') {
      const end = closingBrace(body, i + 1);
      const part = body.slice(i, end + 1);
      // A generated block already carries its own separators; the extra comma
      // only guarantees one, and an empty part is skipped below.
      out += depth === 0
        ? `${generatedColumns(source, file, table, part).map((column) => `${column} TEXT`).join(',')},`
        : part;
      i = end + 1;
      continue;
    }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    out += ch;
    i += 1;
  }
  return out;
}

function parseColumns(body: string, source: string, file: string, table: string): string[] {
  // Line comments first: their prose carries commas, and a comma is the column
  // separator below.
  const text = expandColumnBlocks(body.replace(/--[^\n]*/g, ''), source, file, table);
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);

  const columns: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(trimmed)?.[0];
    if (word === undefined) {
      throw new Error(
        `schema-drift: ${file}: ${table} has a body part this cannot read: ${trimmed.slice(0, 60)}`,
      );
    }
    if (Object.hasOwn(CONSTRAINT_KEYWORD, word.toUpperCase())) continue;
    columns.push(word);
  }
  if (columns.length === 0) throw new Error(`schema-drift: ${file}: ${table} parsed no columns`);
  return columns;
}

export function parseTables(file: string, source: string): TableDdl[] {
  const byTable = new Map<string, string[]>();
  for (const match of source.matchAll(DDL_RE)) {
    const table = match[1];
    if (table === undefined) continue;
    const constant = match[2];
    const body = constant === undefined
      ? balancedBody(source, source.indexOf('(', match.index + match[0].length - 1))
      : interpolatedBody(source, file, table, constant);
    const columns = byTable.get(table) ?? [];
    for (const column of parseColumns(body, source, file, table)) {
      if (!columns.includes(column)) columns.push(column);
    }
    byTable.set(table, columns);
  }
  return [...byTable].map(([table, columns]) => ({ table, file, columns }));
}

export function tablesIn(sources: ReadonlyMap<string, string>): TableDdl[] {
  return [...sources].flatMap(([file, source]) => parseTables(file, source));
}

const GenesisLockSchema = v.record(v.string(), v.array(v.string()));
export type GenesisLock = v.InferOutput<typeof GenesisLockSchema>;

export function readGenesisLock(path: string = GENESIS_LOCK): GenesisLock {
  return v.parse(GenesisLockSchema, JSON.parse(readFileSync(path, 'utf8')));
}

/** The two fixes every drift has, printed by name. This repository carries no
 *  column reconcile, so a shipped table's shape moves only with its storage. */
const DRIFT_FIX = 'put the new columns in a table of their own, or reset production and re-lock: '
  + 'delete scripts/schema-genesis.lock.json, run `bun scripts/schema-drift.ts --lock`, '
  + 'and state the reset in the commit body';

/**
 * Every table whose DDL and genesis disagree, in either direction. An unlocked
 * table is a violation too: a gate that reads "no baseline" as "nothing changed"
 * passes hardest on exactly the tables nobody has looked at.
 */
export function driftViolations(tables: readonly TableDdl[], lock: GenesisLock): Violation[] {
  const violations: Violation[] = [];
  for (const { table, file, columns } of tables) {
    const key = lockKey(table, file);
    const genesis = lock[key];
    if (genesis === undefined) {
      violations.push({
        key,
        detail: finding({
          invariant: 'every table in the corpus has a recorded genesis column set',
          at: `${file} (${table})`,
          found: 'no entry in scripts/schema-genesis.lock.json',
          silently: 'the gate compares today against nothing and passes over every column added since',
          fix: 'bun scripts/schema-drift.ts --lock',
        }),
      });
      continue;
    }
    const added = columns.filter((column) => !genesis.includes(column));
    const removed = genesis.filter((column) => !columns.includes(column));
    if (added.length === 0 && removed.length === 0) continue;
    const found = [
      added.length > 0 ? `[${added.join(', ')}] added after genesis` : '',
      removed.length > 0 ? `[${removed.join(', ')}] removed after genesis` : '',
    ].filter((part) => part !== '').join('; ');
    violations.push({
      key,
      detail: finding({
        invariant: 'a shipped table\'s DDL is the genesis its storage was created with',
        at: `${file} (${table})`,
        found,
        silently: 'a reader naming an added column answers "no such column" on storage created at '
          + 'genesis (the shape GET /api/cli/devices returned 500 in production); a removed '
          + 'NOT NULL column without a default refuses every insert on that storage',
        fix: DRIFT_FIX,
      }),
    });
  }
  return violations;
}

/**
 * The genesis to record for a table the lock does not know yet: today's DDL,
 * because a table that has never shipped has no storage older than its DDL.
 *
 * One hole, closed here: the same table MOVED to another file is a new key,
 * and locking it at today's shape would excuse every column the move carried
 * with it. So when the name is already locked elsewhere, the new entry inherits
 * the narrowest genesis recorded for it. Conservative in the safe direction: it
 * can report a genuinely separate table that happens to share a name.
 */
export function genesisForNewTable(table: TableDdl, lock: GenesisLock): readonly string[] {
  const siblings = Object.entries(lock)
    .filter(([key]) => key.startsWith(`${table.table}@`))
    .map(([, columns]) => columns);
  if (siblings.length === 0) return table.columns;
  return table.columns.filter((column) => siblings.every((columns) => columns.includes(column)));
}

export interface LockUpdate {
  readonly next: GenesisLock;
  readonly added: readonly string[];
  readonly refused: readonly string[];
}

/**
 * Add a genesis entry for a table that has none. An existing entry is NEVER
 * rewritten: widening it excuses exactly the columns this gate exists to catch,
 * and narrowing it reports columns the table shipped with. Both directions are
 * refused by the same rule, so the lock cannot be moved by the change it is
 * judging. A reset deployment re-locks by deleting the file first.
 */
export function lockUpdate(
  tables: readonly TableDdl[],
  lock: GenesisLock,
  genesis: (table: TableDdl) => readonly string[],
): LockUpdate {
  const next: Record<string, string[]> = Object.fromEntries(
    Object.entries(lock).map(([key, columns]) => [key, [...columns]]),
  );
  const added: string[] = [];
  const refused: string[] = [];
  for (const table of tables) {
    const key = lockKey(table.table, table.file);
    const existing = lock[key];
    if (existing === undefined) {
      next[key] = [...genesis(table)];
      added.push(key);
      continue;
    }
    const recomputed = genesis(table);
    if (existing.length === recomputed.length && existing.every((c, i) => c === recomputed[i])) continue;
    refused.push(`${key}: locked [${existing.join(', ')}], DDL now reads [${recomputed.join(', ')}]`);
  }
  return {
    next: Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b))),
    added: added.sort(),
    refused: refused.sort(),
  };
}

export interface Survey {
  /** Files ENUMERATED. Every product source, so the corpus is the same set the
   *  other gates hold. */
  readonly files: number;
  /** Files PARSED: those carrying a statement this gate reads. */
  readonly parsed: number;
  readonly tables: readonly TableDdl[];
  readonly lock: GenesisLock;
  readonly violations: readonly Violation[];
  /** Locked tables no longer in the corpus. Retained on purpose — see header. */
  readonly retired: readonly string[];
}

/** The one statement the gate reads. A product file without it declares no
 *  table, so parsing it is work with no possible verdict. The ENUMERATION stays
 *  whole — this narrows only what is handed to the parser, and both counts are
 *  printed, so the corpus cannot shrink behind the number. */
const READABLE_TOKEN = /CREATE TABLE IF NOT EXISTS/;

export function survey(lock: GenesisLock = readGenesisLock()): Survey {
  // Working tree, not HEAD: the gate must fail on the change being made, not on
  // the change already committed. `readMatching` reads the working tree, and it
  // is the ONLY enumeration — this line was
  // `git ls-files 'packages/*/src/**/*.ts'`, whose `**/` requires at least one
  // intervening directory, so it matched 454 of 616 product files and every file
  // sitting directly in a `src/` was invisible. `actor-agent.ts` among them: the
  // largest DDL surface in the repo, in a gate reporting drift-free over it.
  const sources = readMatching(isProductSource);
  const readable = new Map([...sources].filter(([, source]) => READABLE_TOKEN.test(source)));
  const tables = tablesIn(readable);
  const present = new Set(tables.map(({ table, file }) => lockKey(table, file)));
  return {
    files: sources.size,
    parsed: readable.size,
    tables,
    lock,
    violations: driftViolations(tables, lock),
    retired: Object.keys(lock).filter((key) => !present.has(key)).sort(),
  };
}

/** What this gate does NOT catch, printed on the GREEN path: a limitation
 *  visible only in red output is invisible exactly when the tree is green. */
export function blindSpots(state: Survey): string[] {
  return [
    'reads DDL text, never a database: nothing here runs a statement or opens storage',
    'names only. A changed column TYPE, CONSTRAINT or DEFAULT on a shipped table is invisible, '
      + 'and storage created at genesis keeps the old one',
    `${String(state.retired.length)} locked table(s) are no longer in the corpus and stay locked, `
      + 'never re-locked: storage created under that DDL may still exist',
    'a table created outside the product corpus — a test fixture, a statement typed into a shell — '
      + 'is not enumerated here',
    'the checking path reads the lock and never git, so it runs under a shallow clone and in 2s. '
      + 'A lock entry edited BY HAND is a diff a reviewer sees, and nothing here disputes it '
      + 'until the DDL disagrees with it',
  ];
}

if (import.meta.main) {
  const locking = process.argv.includes('--lock');
  // An absent lock is the one legitimate state `--lock` starts from: a reset
  // deployment deletes the file and re-locks every table at the DDL it ships.
  // The checking path never starts from nothing — with no baseline it would
  // report a drift-free tree while comparing every table against nothing — so
  // it reads the file and fails when the file is not there.
  const state = survey(locking && !existsSync(GENESIS_LOCK) ? {} : readGenesisLock());
  // The corpus counts are asserted on both paths. The LOCK COUNT is asserted
  // only on the checking path, for the same reason.
  const corpus: readonly (readonly [string, number])[] = [
    ['product files enumerated', state.files],
    ['of them parsed', state.parsed],
    ['tables', state.tables.length],
  ];
  if (locking) {
    const update = lockUpdate(state.tables, state.lock, (table) => genesisForNewTable(table, state.lock));
    if (update.refused.length > 0) {
      console.error(
        `schema-drift --lock: refusing to rewrite ${String(update.refused.length)} existing genesis entr(ies).\n`
        + 'A genesis is a fact about deployed storage. Move the columns to a table of their own, '
        + 'or reset production and delete the lock file before re-locking.\n',
      );
      for (const line of update.refused) console.error(`  ${line}`);
      process.exit(1);
    }
    writeFileSync(GENESIS_LOCK, `${JSON.stringify(update.next, null, 2)}\n`);
    console.log(
      `schema-drift: locked ${String(update.added.length)} new table(s) — `
      + assertMeasured('schema-drift', corpus),
    );
    for (const key of update.added) console.log(`  + ${key}`);
  } else if (state.violations.length > 0) {
    console.error(`schema-drift: ${String(state.violations.length)} violation(s)\n`);
    for (const violation of state.violations) console.error(violation.detail);
    process.exit(1);
  } else {
    const measured = assertMeasured('schema-drift', [
      ...corpus,
      ['locked genesis entries', Object.keys(state.lock).length],
    ]);
    console.log(`schema-drift: ok — ${measured}`);
    for (const spot of blindSpots(state)) console.log(`  blind: ${spot}`);
  }
}
