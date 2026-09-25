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
 * `scripts/schema-genesis.lock.json` records that shape per `table@file`: every
 * column definition and table constraint, normalized. The gate compares today's
 * DDL against the lock in BOTH directions: a column the DDL has and the lock
 * does not never reaches storage created at genesis; a column the lock has and
 * the DDL does not is still in that storage, and a NOT NULL one without a
 * default refuses every insert that omits it. A changed TYPE, CHECK or DEFAULT
 * is the same drift: storage keeps the constraint it was created with, which is
 * how a widened `name_origin` CHECK refused every mission-only create on the
 * accounts that predated it (2026-09-22).
 *
 * `CREATE VIEW IF NOT EXISTS` is the same no-op for a view: storage keeps the
 * definition that created it, so every later definition is one no reader gets.
 * A view is locked as its whole normalized definition, and any change is drift.
 *
 * WHAT IT MEASURES and WHAT IT GOVERNS are the same set: every persistent
 * `CREATE TABLE` and `CREATE VIEW` a string expression in the product corpus
 * (`scripts/sources.ts`) spells, the consts it names followed, parsed as SQLite
 * by `sql-parser-cst` (`scripts/sql-text.ts`). A string that opens as one and
 * does not parse FAILS the gate. Two regex readers came before. The first
 * measured 114 of 126 statements, missed four tables built from a `${DDL}`
 * constant and counted three prose sentences as tables `is`, `will` and
 * `quietly`. The second, until 2026-09-25, missed lower case, quoted names, a
 * comment between keywords, a name held in a const (`kinu_agent_identity`,
 * `kinu_workspace_generation`, `agent_data_tables`), and cut a body at a `--`
 * inside a string.
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
import type { CreateTableStmt, CreateViewStmt, Node as SqlNode } from 'sql-parser-cst';
import { isProductSource, readMatching } from './sources';
import {
  commentRanges, constInitializer, entityName, type Expand, holesAsNames, leadingKeywords, sqlProgram, sqlStrings, UNWRAPPED, writtenText,
} from './sql-text';
import { literalString, type SyntaxNode } from './syntax';

const root = new URL('..', import.meta.url).pathname;

const GENESIS_LOCK = `${root}scripts/schema-genesis.lock.json`;

/** A body part opening a table CONSTRAINT rather than naming a column. */
const CONSTRAINT_KEYWORD = {
  PRIMARY: true, UNIQUE: true, FOREIGN: true, CHECK: true, CONSTRAINT: true,
} satisfies Record<string, true>;

export interface Violation {
  readonly key: string;
  readonly detail: string;
}

/** One table's DDL as the corpus declares it: every body part — each column
 *  definition and table constraint — normalized, in DDL order. A table declared
 *  twice in one file carries the UNION: both statements reach the same
 *  storage, and whichever runs first is the shape it has. A view is recorded
 *  the same way under its own name, one part per definition declaring it. */
export interface TableDdl {
  readonly table: string;
  readonly file: string;
  readonly parts: readonly string[];
}

/** The columns a table's parts declare, in DDL order: each part's leading
 *  name, less the parts that open a table constraint. */
export function columnsOf(parts: readonly string[]): string[] {
  const columns: string[] = [];

  for (const part of parts) {
    const word = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(part)?.[0];

    if (word === undefined || Object.hasOwn(CONSTRAINT_KEYWORD, word.toUpperCase())) continue;

    if (!columns.includes(word)) columns.push(word);
  }

  return columns;
}

/** One body part as the lock records it: whitespace collapsed outside string
 *  literals, and none just inside a paren or before a comma. */
function normalizedPart(part: string): string {
  let out = '';
  let quoted = false;

  for (const ch of part.trim()) {
    if (ch === '\'') quoted = !quoted;

    if (!quoted && /\s/u.test(ch)) {
      if (!out.endsWith(' ')) out += ' ';
      continue;
    }

    out += ch;
  }

  return out.replace(/\( /gu, '(').replace(/ ([),])/gu, '$1');
}

/** Whether two part lists declare the same table. Order is not compared. */
function sameParts(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((part) => b.includes(part));
}

/** The genesis lock's key. Table AND file, because three table names are
 *  declared in more than one module (`crafted_tools`, `traces`, `fibers`) and
 *  those are different databases with their own histories. */
export function lockKey(table: string, file: string): string {
  return `${table}@${file}`;
}

/** A column block a template GENERATES: `Object.entries(OBJ)` or
 *  `Object.keys(OBJ)` at the root of a call chain (`.map(…).join(…)`), reached
 *  directly or through any number of consts. Its columns are OBJ's own keys;
 *  undefined for any other interpolation. */
function generatedKeys(expression: SyntaxNode): string[] | undefined {
  const seen = new Set<SyntaxNode>();
  let node: SyntaxNode | undefined = expression;

  while (node !== undefined && !seen.has(node)) {
    seen.add(node);
    const { raw } = node;

    if (raw.type === 'Identifier') {
      node = constInitializer(node, raw.name);
      continue;
    }

    if (raw.type !== 'CallExpression' || raw.callee.type !== 'MemberExpression') return undefined;
    const { callee } = raw;
    const method = callee.property.type === 'Identifier' ? callee.property.name : undefined;

    if (callee.object.type === 'Identifier' && callee.object.name === 'Object' && (method === 'entries' || method === 'keys')) {
      const argument = node.children.find((child) => child.raw === raw.arguments[0]);

      return argument === undefined ? undefined : objectKeys(argument);
    }

    node = node.children.find((child) => child.raw === callee)?.children.find((child) => child.raw === callee.object);
  }

  return undefined;
}

/** The own keys of the object literal `node` is, or names through consts;
 *  undefined for a spread, a computed key or anything but an object, which
 *  leaves the interpolation a parameter and the DDL unparseable. */
function objectKeys(node: SyntaxNode): string[] | undefined {
  const { raw } = node;
  const [inner] = node.children;

  if (raw.type === 'Identifier') {
    const init = constInitializer(node, raw.name);

    return init === undefined ? undefined : objectKeys(init);
  }

  if (Object.hasOwn(UNWRAPPED, raw.type)) return inner === undefined ? undefined : objectKeys(inner);

  if (raw.type !== 'ObjectExpression') return undefined;

  const keys = raw.properties.map((property) => {
    if (property.type !== 'Property' || property.computed) return undefined;

    return property.key.type === 'Identifier' ? property.key.name : literalString(property.key);
  });

  return keys.length === 0 || keys.includes(undefined) ? undefined : keys.filter((key) => key !== undefined);
}

/** A generated block spliced as `key TEXT` columns, with the separators its
 *  neighbours in the template do not already supply. */
const columnBlock: Expand = (expression, { before, after }) => {
  const keys = generatedKeys(expression);

  if (keys === undefined) return undefined;
  const last = before.trimEnd().at(-1);
  const next = after.trimStart()[0];
  const lead = last === undefined || last === ',' || last === '(' ? '' : ', ';
  const trail = next === undefined || next === ',' || next === ')' ? '' : ', ';

  return `${lead}${keys.map((key) => `${key} TEXT`).join(', ')}${trail}`;
};

/** Whether text SQLite's grammar refused was meant as a table or view this censuses. */
function spellsDdl(text: string): boolean {
  const [first, second] = leadingKeywords(text, 2);

  return first === 'CREATE' && (second === 'TABLE' || second === 'VIEW');
}

/** A persistent table: not TEMP (gone with the connection), not VIRTUAL (a
 *  module's arguments, not columns), not in the `temp` schema. */
function persists(statement: CreateTableStmt | CreateViewStmt): boolean {
  const kinds = statement.type === 'create_table_stmt' ? [statement.kind] : statement.kinds;
  const schema = statement.name.type === 'member_expr' ? entityName(statement.name.object) : undefined;

  return kinds.every((kind) => kind === undefined) && schema !== 'temp';
}

function rangeOf(file: string, line: number, node: SqlNode): [number, number] {
  if (node.range === undefined) throw new Error(`schema-drift: ${file}:${String(line)}: the SQL parser gave no range`);

  return node.range;
}

export interface Declared {
  readonly tables: readonly TableDdl[];
  readonly views: readonly TableDdl[];
  /** CREATE TABLE statements whose name is a runtime value: a table the product makes on request, not one it ships. */
  readonly runtimeNamed: number;
}

/**
 * Every table and view one file declares, each read as the statement SQLite
 * would run: every string expression the file spells, with its constants
 * followed, parsed as SQLite. Fail-closed: a string that begins as a CREATE
 * TABLE or VIEW and does not parse fails the gate, and so does a view whose
 * definition interpolates a value.
 */
export function ddlIn(file: string, source: string): Declared {
  const tables = new Map<string, string[]>();
  const views = new Map<string, string[]>();
  let runtimeNamed = 0;

  const union = (into: Map<string, string[]>, name: string, parts: readonly string[]) => {
    const known = into.get(name) ?? [];

    for (const part of parts) if (!known.includes(part)) known.push(part);
    into.set(name, known);
  };

  for (const sql of sqlStrings(file, source, columnBlock)) {
    // Only a string that spells CREATE can hold a CREATE statement.
    if (!sql.text.toUpperCase().includes('CREATE')) continue;
    const asParameters = sqlProgram(sql.text);
    const program = asParameters ?? sqlProgram(holesAsNames(sql));

    if (program === undefined) {
      if (spellsDdl(sql.text)) {
        throw new Error(`schema-drift: ${file}:${String(sql.line)} spells a CREATE this cannot parse as SQLite: `
          + `${sql.text.trim().slice(0, 80)}`);
      }

      continue;
    }

    const comments = commentRanges(program);
    const written = (node: SqlNode) => normalizedPart(writtenText(sql, rangeOf(file, sql.line, node), comments));

    for (const statement of program.statements) {
      if ((statement.type !== 'create_table_stmt' && statement.type !== 'create_view_stmt') || !persists(statement)) continue;
      const name = entityName(statement.name);

      const holed = (node: SqlNode) => {
        const [from, to] = rangeOf(file, sql.line, node);

        return sql.holes.some(({ at }) => at >= from && at < to);
      };

      if (name === undefined) throw new Error(`schema-drift: ${file}:${String(sql.line)}: a CREATE names no table`);

      if (holed(statement.name)) {
        runtimeNamed += 1;
        continue;
      }

      if (asParameters === undefined && holed(statement)) {
        throw new Error(`schema-drift: ${file}:${String(sql.line)}: ${name} has a body part this cannot read`);
      }

      if (statement.type === 'create_view_stmt') {
        const definition = statement.clauses.find((clause) => clause.type === 'as_clause');

        if (definition === undefined || holed(definition.expr)) {
          throw new Error(`schema-drift: ${file}: view ${name} has a definition this cannot read`);
        }

        union(views, name, [written(definition.expr)]);
        continue;
      }

      const items = statement.columns?.expr.items;

      if (items === undefined) throw new Error(`schema-drift: ${file}: ${name} has no column list this can read`);
      const parts = items.map(written);

      if (columnsOf(parts).length === 0) throw new Error(`schema-drift: ${file}: ${name} parsed no columns`);
      union(tables, name, parts);
    }
  }

  const listed = (declared: Map<string, string[]>) => [...declared].map(([table, parts]) => ({ table, file, parts }));

  return { tables: listed(tables), views: listed(views), runtimeNamed };
}

export function tablesIn(sources: ReadonlyMap<string, string>): TableDdl[] {
  return [...sources].flatMap(([file, source]) => ddlIn(file, source).tables);
}


const GenesisLockSchema = v.record(v.string(), v.array(v.string()));

export type GenesisLock = v.InferOutput<typeof GenesisLockSchema>;

export function readGenesisLock(path: string = GENESIS_LOCK): GenesisLock {
  return v.parse(GenesisLockSchema, JSON.parse(readFileSync(path, 'utf8')));
}

/** What a drifted table or view does while every test stays green. */
const DRIFT_SILENTLY = {
  table: 'CREATE TABLE IF NOT EXISTS never touches existing storage: a reader naming an added '
    + 'column answers "no such column" (GET /api/cli/devices, production 500), and a write the '
    + 'new DDL admits fails the old constraint (the widened name_origin CHECK refused every '
    + 'mission-only create on older accounts, 2026-09-22)',
  view: 'CREATE VIEW IF NOT EXISTS never replaces a view that exists: storage keeps the definition '
    + 'it was created with, and every reader gets that definition\'s rows and columns',
} as const;

type DdlKind = keyof typeof DRIFT_SILENTLY;

/** What moved between a table's genesis and its DDL: columns in either
 *  direction, then every other definition that is not what storage holds. */
function driftFound(genesis: readonly string[], parts: readonly string[]): string {
  const lockedColumns = columnsOf(genesis);
  const columns = columnsOf(parts);
  const added = columns.filter((column) => !lockedColumns.includes(column));
  const removed = lockedColumns.filter((column) => !columns.includes(column));
  const unreported = (part: string) => !columnsOf([part]).some((column) => added.includes(column) || removed.includes(column));
  const was = genesis.filter((part) => !parts.includes(part) && unreported(part));
  const now = parts.filter((part) => !genesis.includes(part) && unreported(part));

  return [
    added.length > 0 ? `[${added.join(', ')}] added after genesis` : '',
    removed.length > 0 ? `[${removed.join(', ')}] removed after genesis` : '',
    was.length + now.length > 0
      ? `a definition changed after genesis: storage holds [${was.join('; ')}], the DDL now reads [${now.join('; ')}]`
      : '',
  ].filter((part) => part !== '').join('; ');
}

/**
 * Every table whose DDL and genesis disagree, in either direction and in any
 * part: a column, its type, a CHECK, a DEFAULT, a table constraint. An unlocked
 * table is a violation too: a gate that reads "no baseline" as "nothing
 * changed" passes hardest on exactly the tables nobody has looked at.
 */
export function driftViolations(tables: readonly TableDdl[], lock: GenesisLock): Violation[] {
  return violationsOf('table', tables, lock);
}

/** Every view whose definition is not its genesis, or that has none. */
export function viewDriftViolations(views: readonly TableDdl[], lock: GenesisLock): Violation[] {
  return violationsOf('view', views, lock);
}

function violationsOf(kind: DdlKind, entries: readonly TableDdl[], lock: GenesisLock): Violation[] {
  const violations: Violation[] = [];

  for (const { table, file, parts } of entries) {
    const key = lockKey(table, file);
    const genesis = lock[key];

    if (genesis === undefined) {
      violations.push({
        key,
        detail: finding({
          invariant: `every ${kind} in the corpus has a recorded genesis DDL`,
          at: `${file} (${table})`,
          found: 'no entry in scripts/schema-genesis.lock.json',
          silently: 'the gate compares today against nothing and passes over every change made since',
          fix: 'bun scripts/schema-drift.ts --lock',
        }),
      });
      continue;
    }

    if (sameParts(genesis, parts)) continue;

    violations.push({
      key,
      detail: finding({
        invariant: `a shipped ${kind}'s DDL is the genesis its storage was created with`,
        at: `${file} (${table})`,
        found: driftFound(genesis, parts),
        silently: DRIFT_SILENTLY[kind],
        // The two fixes every drift has. This repository carries no reconcile, so a shipped shape
        // moves only with its storage: a schema change is a reset deployment (AGENTS.md).
        fix: `put the new shape in a ${kind} of its own, or make this a reset deployment and re-lock: `
          + 'delete scripts/schema-genesis.lock.json, run `bun scripts/schema-drift.ts --lock`, '
          + 'and state the reset in the commit body',
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
    .map(([, parts]) => parts);

  if (siblings.length === 0) return table.parts;

  return table.parts.filter((part) => siblings.every((parts) => parts.includes(part)));
}

export interface LockUpdate {
  readonly next: GenesisLock;
  readonly added: readonly string[];
  readonly refused: readonly string[];
}

/**
 * Add a genesis entry for a table that has none. An existing entry is NEVER
 * rewritten: widening it excuses exactly the change this gate exists to catch,
 * and narrowing it reports definitions the table shipped with. Both directions
 * are refused by the same rule, so the lock cannot be moved by the change it is
 * judging. A reset deployment re-locks by deleting the file first.
 */
export function lockUpdate(
  tables: readonly TableDdl[],
  lock: GenesisLock,
  genesis: (table: TableDdl) => readonly string[],
): LockUpdate {
  const next: Record<string, string[]> = Object.fromEntries(
    Object.entries(lock).map(([key, parts]) => [key, [...parts]]),
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

    // The verdict on an EXISTING entry is the DDL's own parts — never the
    // `genesis` callback. `genesisForNewTable` filters down to the locked
    // namesakes, so asking it about a table that already has an entry returns
    // that entry's own list and a changed DDL launders to "unchanged".
    // `genesis` answers only where to start a table that has none.
    if (sameParts(existing, table.parts)) continue;
    refused.push(`${key}: ${driftFound(existing, table.parts)}`);
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
  /** Files that declare at least one table or view. */
  readonly declaring: number;
  readonly runtimeNamed: number;
  readonly tables: readonly TableDdl[];
  readonly views: readonly TableDdl[];
  readonly lock: GenesisLock;
  readonly violations: readonly Violation[];
  /** Locked tables and views no longer in the corpus. Retained on purpose — see header. */
  readonly retired: readonly string[];
}

export function survey(lock: GenesisLock = readGenesisLock()): Survey {
  // Working tree, not HEAD: the gate must fail on the change being made, not on
  // the change already committed. `readMatching` reads the working tree, and it
  // is the ONLY enumeration — this line was
  // `git ls-files 'packages/*/src/**/*.ts'`, whose `**/` requires at least one
  // intervening directory, so it matched 454 of 616 product files and every file
  // sitting directly in a `src/` was invisible. `actor-agent.ts` among them: the
  // largest DDL surface in the repo, in a gate reporting drift-free over it.
  const sources = readMatching(isProductSource);
  const declared = [...sources].map(([file, source]) => ddlIn(file, source));
  const tables = declared.flatMap((file) => file.tables);
  const views = declared.flatMap((file) => file.views);
  const present = new Set([...tables, ...views].map(({ table, file }) => lockKey(table, file)));

  return {
    files: sources.size,
    declaring: declared.filter((file) => file.tables.length + file.views.length > 0).length,
    runtimeNamed: declared.reduce((sum, file) => sum + file.runtimeNamed, 0),
    tables,
    views,
    lock,
    violations: [...driftViolations(tables, lock), ...viewDriftViolations(views, lock)],
    retired: Object.keys(lock).filter((key) => !present.has(key)).sort(),
  };
}

/** What this gate does NOT catch, printed on the GREEN path: a limitation
 *  visible only in red output is invisible exactly when the tree is green. */
export function blindSpots(state: Survey): string[] {
  return [
    'reads DDL as SQLite\'s grammar, never a database: nothing here runs a statement or opens storage',
    'column ORDER is not compared, and a formatting-only edit to a definition reads as a change',
    'a column block a template GENERATES is compared by column name only; its types come from '
      + 'an object this reads the keys of',
    'an interpolation inside a definition (a CHECK list built from a function call) is compared as its '
      + 'source text, so a change to the value it names is invisible; a const string it names is followed',
    `${String(state.runtimeNamed)} CREATE TABLE statement(s) take their name at runtime (tables made on request) `
      + 'and are not censused',
    'a CREATE past the first statement of a string that does not parse as SQLite, a TEMP table and a '
      + 'VIRTUAL table are not censused; SQL built outside a string expression (a runtime join of '
      + 'parameters, a string from another module) is read as a parameter or not at all',
    `${String(state.retired.length)} locked table(s) and view(s) are no longer in the corpus and stay locked, `
      + 'never re-locked: storage created under that DDL may still exist',
    'a table created outside the product corpus — a test fixture, a statement typed into a shell — '
      + 'is not enumerated here',
    'a table a VENDOR creates and Kinu only reads has no DDL in the corpus, so a column Kinu names '
      + 'that the vendor never creates is invisible here; the first-run row `snapshot-after-turn` '
      + 'reads the deployed product\'s own tables',
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
    ['of them declaring a table or view', state.declaring],
    ['tables', state.tables.length],
    ['views', state.views.length],
  ];

  if (locking) {
    const update = lockUpdate(
      [...state.tables, ...state.views], state.lock, (entry) => genesisForNewTable(entry, state.lock),
    );

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
      `schema-drift: locked ${String(update.added.length)} new table(s) and view(s) — `
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
