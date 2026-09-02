/**
 * Schema-drift gate — a column a shipped table gained must be reconciled into
 * the tables that predate it.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op on a table that already exists, so a
 * column added later never reaches storage created before it while every reader
 * still names it. Three live failures: `no such column: code_language` in a
 * workspace, `scaffold_versions` (`status`, `parent_version`) before it, and —
 * 2026-09-01, in production — `no such column: unstopped_at` from
 * `GET /api/cli/devices`, which also failed `kinu connect` on a machine whose
 * daemon had already connected. Staging answered the same route 500 on
 * `last_ip`, an older table again: one column is never the fix.
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
 * THE GENESIS of a table — the column set it first shipped with — is recorded in
 * `scripts/schema-genesis.lock.json`, keyed `table@file`. That replaced a
 * `git log -S` query per table per run, which was wrong in the direction that
 * matters: for a DDL that moved file the pickaxe finds the MOVE, reports today's
 * columns as the genesis, and every column added before the move excuses itself.
 * `--lock` writes an entry for a table that has none and REFUSES to change one
 * that has: a genesis is a historical fact, and a gate whose baseline the
 * failing change may rewrite is an ignore list with extra steps.
 *
 * The lock is a HISTORY, not a debt ratchet, so it differs from
 * `gate-ratchet`'s rule on one point deliberately: an entry whose table is no
 * longer in the corpus is RETAINED and printed, never dropped. Storage created
 * under that DDL still exists, and re-adding the name later must inherit the
 * older genesis rather than a fresh one.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import * as v from 'valibot';
import { assertMeasured, finding } from './gate-ratchet';
import { isProductSource, readMatching } from './sources';
import {
  identifierCalleeName,
  literalText,
  parse as parseSyntax,
  type SyntaxNode,
  walk,
} from './syntax';

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

/**
 * The ONE table whose post-genesis columns `ALTER TABLE ADD COLUMN` cannot
 * reach, with the runtime mover that carries them instead — and the mover is
 * ASSERTED, not merely named. `user_devices` and `user_cli_tokens` used to sit
 * beside it, excused by a destructive raw-token reset that no longer runs before
 * any reader; that whole-table excuse is why the production 500 shipped through
 * a green gate, and both tables carry real reconcile declarations now.
 *
 * `fork_lineage`: `source_agent_id`/`source_agent_name` were RENAMED to
 * `source_workspace_id`/`source_workspace_name`. The values live in the old
 * columns, so adding the new ones recovers nothing — `adoptLegacyForkLineage`
 * moves the row. `mover` must be CALLED in the module that declares the DDL,
 * and every module that calls `entry` must call `after` FIRST, which is the
 * ordering the excuse depends on: the table exists before the mover reads it.
 */
const RUNTIME_MOVERS = {
  fork_lineage: {
    declaredIn: 'packages/core/src/identity/schema.ts',
    mover: 'adoptLegacyForkLineage',
    entry: 'migrateWorkspaceStorage',
    after: 'initAllTables',
  },
} satisfies Record<string, {
  readonly declaredIn: string;
  readonly mover: string;
  readonly entry: string;
  readonly after: string;
}>;

export interface Violation {
  readonly key: string;
  readonly detail: string;
}

/** One table's DDL as the corpus declares it. `columns` is DDL order. A table
 *  declared twice in one file (a rebuild path beside the init path) carries the
 *  UNION: both statements reach the same storage, so a column in either one is a
 *  column a reader may name. */
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

function git(args: readonly string[]): string {
  const out = Bun.spawnSync(['git', ...args], { cwd: root });
  if (!out.success) {
    // A gate that reads '' from a broken git reports a drift-free tree over
    // nothing. `--lock` is the only path that asks git anything, and it asks
    // for a historical fact it cannot guess.
    throw new Error(
      `schema-drift: git ${args.join(' ')} failed — ${new TextDecoder().decode(out.stderr).trim()}`,
    );
  }
  return new TextDecoder().decode(out.stdout);
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

/** Parsed TypeScript facts for one product source. The gate reads call nodes,
 * not their formatting: multiline callbacks, trailing commas and type wrappers
 * are all the same call in the AST. */
interface SourceSyntax {
  readonly file: string;
  readonly source: string;
  readonly root: SyntaxNode;
  readonly constants: ReadonlyMap<string, SyntaxNode>;
}

interface SyntaxIndex {
  readonly files: ReadonlyMap<string, SourceSyntax>;
  readonly constantsByName: ReadonlyMap<string, readonly { file: string; value: SyntaxNode }[]>;
}

export interface BackfillInspection {
  readonly named: ReadonlySet<string>;
  readonly reconcileCalls: number;
}

/** The child that wraps one raw AST member. Identity is stable inside one Oxc
 * parse; a miss is a parser-contract failure and must never become an empty set. */
function childFor(parent: SyntaxNode, raw: SyntaxNode['raw']): SyntaxNode {
  const child = parent.children.find((candidate) => candidate.raw === raw);
  if (child === undefined) throw new Error(`schema-drift lost the ${raw.type} child of ${parent.type}`);
  return child;
}

/** Strip TypeScript-only wrappers while keeping the expression node Oxc parsed. */
function unwrapExpression(node: SyntaxNode): SyntaxNode {
  let current = node;
  for (;;) {
    const { raw } = current;
    if (raw.type !== 'TSAsExpression' && raw.type !== 'TSSatisfiesExpression'
      && raw.type !== 'TSNonNullExpression' && raw.type !== 'ParenthesizedExpression') return current;
    current = childFor(current, raw.expression);
  }
}

function argumentAt(call: SyntaxNode, index: number): SyntaxNode {
  if (call.raw.type !== 'CallExpression') throw new Error('schema-drift expected a CallExpression');
  const argument = call.raw.arguments[index];
  if (argument === undefined || argument.type === 'SpreadElement') {
    throw new Error(`schema-drift cannot read argument ${String(index + 1)} of this call`);
  }
  return childFor(call, argument);
}

function constantValue(node: SyntaxNode): { name: string; value: SyntaxNode } | null {
  if (node.raw.type !== 'VariableDeclarator' || node.raw.id.type !== 'Identifier'
    || node.raw.init === null) return null;
  return { name: node.raw.id.name, value: childFor(node, node.raw.init) };
}

/** Every product file parsed ONCE. Both the backfill census and the mover
 *  assertion read this index: at 863 files a second parse pass is the difference
 *  between a commit-tier gate and one nobody wants in a hook. */
export function syntaxIndex(sources: ReadonlyMap<string, string>): SyntaxIndex {
  const files = new Map<string, SourceSyntax>();
  const constantsByName = new Map<string, { file: string; value: SyntaxNode }[]>();
  for (const [file, source] of sources) {
    const rootNode = parseSyntax(file, source).root;
    const constants = new Map<string, SyntaxNode>();
    walk(rootNode, (node) => {
      const found = constantValue(node);
      if (found === null) return;
      constants.set(found.name, found.value);
      const definitions = constantsByName.get(found.name) ?? [];
      definitions.push({ file, value: found.value });
      constantsByName.set(found.name, definitions);
    });
    files.set(file, { file, source, root: rootNode, constants });
  }
  return { files, constantsByName };
}

function propertyName(property: SyntaxNode): string {
  if (property.raw.type !== 'Property') {
    throw new Error(`schema-drift expected an object Property, found ${property.type}`);
  }
  const { key } = property.raw;
  if (key.type === 'Identifier') return key.name;
  const value = literalText(childFor(property, key));
  if (value === undefined) throw new Error('schema-drift cannot resolve a computed column name');
  return value;
}

function columnObject(
  index: SyntaxIndex,
  file: SourceSyntax,
  expression: SyntaxNode,
  resolving: ReadonlySet<string> = new Set(),
): string[] {
  const node = unwrapExpression(expression);
  if (node.raw.type === 'Identifier') {
    const name = node.raw.name;
    const local = file.constants.get(name);
    const candidates = local === undefined ? index.constantsByName.get(name) ?? [] : [{ file: file.file, value: local }];
    const [candidate] = candidates;
    if (candidate === undefined || candidates.length !== 1) {
      throw new Error(
        `${file.file}: column object ${name} has ${String(candidates.length)} resolvable definitions`,
      );
    }
    const owner = index.files.get(candidate.file);
    if (owner === undefined) throw new Error(`schema-drift lost the source that declares ${name}`);
    const identity = `${candidate.file}#${name}`;
    if (resolving.has(identity)) throw new Error(`${file.file}: column object ${name} is recursive`);
    return columnObject(index, owner, candidate.value, new Set([...resolving, identity]));
  }
  if (node.raw.type !== 'ObjectExpression') {
    throw new Error(
      `${file.file}:${String(node.start)} column declaration is ${node.type}, not an object or named object`,
    );
  }
  const columns: string[] = [];
  for (const rawProperty of node.raw.properties) {
    const property = childFor(node, rawProperty);
    if (rawProperty.type === 'Property') {
      columns.push(propertyName(property));
      continue;
    }
    if (rawProperty.type === 'SpreadElement') {
      columns.push(...columnObject(index, file, childFor(property, rawProperty.argument), resolving));
      continue;
    }
  }
  return [...new Set(columns)];
}

/** Every backfill call the TypeScript AST can prove. SQL text still uses a SQL
 * pattern because SQL is the domain being parsed there; TypeScript never does. */
export function inspectBackfillCalls(sources: ReadonlyMap<string, string>): BackfillInspection {
  return inspectIndexedBackfills(syntaxIndex(sources));
}

function inspectIndexedBackfills(index: SyntaxIndex): BackfillInspection {
  const named = new Set<string>();
  let reconcileCalls = 0;
  for (const file of index.files.values()) {
    // Raw ALTER TABLE statements live inside SQL strings, where a SQL pattern is
    // the relevant parser rather than a source-code formatting assumption.
    for (const match of file.source.matchAll(/ALTER TABLE\s+(?:\$\{table\}|(\w+))\s+ADD COLUMN\s+(\w+)/g)) {
      if (match[1] !== undefined && match[2] !== undefined) named.add(`${match[1]}.${match[2]}`);
    }
    walk(file.root, (node) => {
      const callee = identifierCalleeName(node);
      if (callee === 'reconcileColumns' || callee === 'reconcileSqlExecColumns') {
        reconcileCalls += 1;
        const tableIndex = callee === 'reconcileColumns' ? 2 : 1;
        const columnsIndex = callee === 'reconcileColumns' ? 3 : 2;
        const table = literalText(argumentAt(node, tableIndex));
        if (table === undefined) throw new Error(`${file.file}: ${callee} table is not a string literal`);
        const columns = columnObject(index, file, argumentAt(node, columnsIndex));
        if (columns.length === 0) throw new Error(`${file.file}: ${callee}('${table}') names no columns`);
        for (const column of columns) named.add(`${table}.${column}`);
      }
      if (callee === 'ensureColumn') {
        const table = literalText(argumentAt(node, 1));
        const column = literalText(argumentAt(node, 2));
        if (table === undefined || column === undefined) {
          throw new Error(`${file.file}: ensureColumn table/column must be string literals`);
        }
        named.add(`${table}.${column}`);
      }
    });
  }
  if (reconcileCalls === 0) throw new Error('schema-drift parsed no column reconciliation calls');
  return { named, reconcileCalls };
}

/** Where a named function is CALLED in each file, by source offset. A
 *  declaration, an import and a mention in prose are not calls, which is the
 *  distinction the mover assertion rests on. */
function callOffsets(index: SyntaxIndex, name: string): Map<string, number[]> {
  const found = new Map<string, number[]>();
  for (const file of index.files.values()) {
    const offsets: number[] = [];
    walk(file.root, (node) => {
      if (identifierCalleeName(node) === name) offsets.push(node.start);
    });
    if (offsets.length > 0) found.set(file.file, offsets);
  }
  return found;
}

/**
 * The excuse in {@link RUNTIME_MOVERS} held to its own mechanism.
 *
 * A whole-table entry is honest only while the mover it names still runs before
 * a reader, so both halves are checked: the mover is CALLED in the module that
 * declares the DDL, and every module that calls the mover's entry point calls
 * the table's own initialiser at a lower offset first. A creation path that
 * never opens legacy storage needs no mover and is not required to call one.
 */
export function moverViolations(sources: ReadonlyMap<string, string>): Violation[] {
  return indexedMoverViolations(syntaxIndex(sources));
}

function indexedMoverViolations(index: SyntaxIndex): Violation[] {
  const violations: Violation[] = [];
  for (const [table, spec] of Object.entries(RUNTIME_MOVERS)) {
    if (!callOffsets(index, spec.mover).has(spec.declaredIn)) {
      violations.push({
        key: `${table}.mover`,
        detail: finding({
          invariant: `${table} is excused from column reconciliation only while ${spec.mover} runs`,
          at: spec.declaredIn,
          found: `no call to ${spec.mover} in the module that declares the ${table} DDL`,
          silently: 'a workspace created before the rename opens with the renamed columns empty, '
            + 'and readForkLineage reports no lineage for a fork that has one',
          fix: `restore the ${spec.mover} call, or give ${table} a reconcileColumns declaration `
            + 'and delete its RUNTIME_MOVERS entry',
        }),
      });
      continue;
    }
    const entryCalls = callOffsets(index, spec.entry);
    if (entryCalls.size === 0) {
      violations.push({
        key: `${table}.entry`,
        detail: finding({
          invariant: `${spec.entry} carries ${spec.mover} onto every workspace-open path`,
          at: 'the product corpus',
          found: `${spec.entry} is called nowhere`,
          silently: `${spec.mover} is dead code and every legacy ${table} stays unmoved`,
          fix: `call ${spec.entry} on the open path, or drop the ${table} RUNTIME_MOVERS entry`,
        }),
      });
      continue;
    }
    const initCalls = callOffsets(index, spec.after);
    for (const [file, offsets] of entryCalls) {
      const earliestInit = Math.min(...(initCalls.get(file) ?? [Number.POSITIVE_INFINITY]));
      if (earliestInit < Math.min(...offsets)) continue;
      violations.push({
        key: `${table}.order@${file}`,
        detail: finding({
          invariant: `${spec.after} runs before ${spec.entry}, so the table exists when the mover reads it`,
          at: file,
          found: `${spec.entry} is called with no earlier ${spec.after} call`,
          silently: `${spec.mover} asks pragma_table_info about a table that does not exist yet, `
            + 'finds nothing to move, and the legacy row is dropped by the CREATE that follows',
          fix: `call ${spec.after} before ${spec.entry} in ${file}`,
        }),
      });
    }
  }
  return violations;
}

const GenesisLockSchema = v.record(v.string(), v.array(v.string()));
export type GenesisLock = v.InferOutput<typeof GenesisLockSchema>;

export function readGenesisLock(path: string = GENESIS_LOCK): GenesisLock {
  return v.parse(GenesisLockSchema, JSON.parse(readFileSync(path, 'utf8')));
}

/**
 * Every column a table has today that its genesis did not, and that no backfill
 * names. An unlocked table is a violation too: a gate that reads "no baseline"
 * as "nothing added" passes hardest on exactly the tables nobody has looked at.
 */
export function driftViolations(
  tables: readonly TableDdl[],
  backfilled: ReadonlySet<string>,
  lock: GenesisLock,
): Violation[] {
  const violations: Violation[] = [];
  for (const { table, file, columns } of tables) {
    if (table in RUNTIME_MOVERS) continue;
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
    const missing = columns
      .filter((column) => !genesis.includes(column))
      .filter((column) => !backfilled.has(`${table}.${column}`));
    if (missing.length === 0) continue;
    violations.push({
      key,
      detail: finding({
        invariant: 'a column added after a table shipped is reconciled onto storage that predates it',
        at: `${file} (${table})`,
        found: `[${missing.join(', ')}] added after genesis with no backfill`,
        silently: 'every read naming one of them answers "no such column" on storage created earlier — '
          + 'the shape GET /api/cli/devices returned 500 in production',
        fix: `add them to a reconcileColumns(sql, execRaw, '${table}', { … }) call beside the DDL`,
      }),
    });
  }
  return violations;
}

/** A table's first-shipped column set, and whether history supplied it. */
export interface TableGenesis {
  readonly columns: readonly string[];
  readonly fromHistory: boolean;
}

/** The genesis of a table, from the commit that introduced its DDL. `--follow`
 *  because a pickaxe scoped to today's path reports a FILE MOVE as the table's
 *  origin, which credits every column added before the move. `fromHistory` is
 *  false when this path has no history for the statement at all. */
export function historicalGenesis(table: TableDdl): TableGenesis {
  const intro = git([
    'log', '--format=%H', '--reverse', '--follow', '-S',
    `CREATE TABLE IF NOT EXISTS ${table.table}`, '--', table.file,
  ]).split('\n')[0];
  if (intro === undefined || intro === '') return { columns: table.columns, fromHistory: false };
  const historical = parseTables(table.file, git(['show', `${intro}:${table.file}`]))
    .find((parsed) => parsed.table === table.table);
  if (historical === undefined) {
    throw new Error(
      `schema-drift --lock: ${intro} introduced ${table.table} in ${table.file} `
      + 'but its DDL does not parse there',
    );
  }
  return { columns: historical.columns, fromHistory: true };
}

/**
 * The genesis to record for a table the lock does not know yet.
 *
 * A DDL with history of its own gets that history. A DDL with NONE at this path
 * is either brand new — today's columns are its genesis — or the same table
 * moved to a file git cannot follow, and that second case is the hole: a moved
 * DDL would re-lock at today's shape and excuse every column added before the
 * move. So when the name is already locked elsewhere, the new entry inherits
 * the narrowest genesis recorded for it. Conservative in the safe direction: it
 * can ask for a reconcile declaration a genuinely separate table does not need.
 */
export function genesisForNewTable(table: TableDdl, lock: GenesisLock): readonly string[] {
  const found = historicalGenesis(table);
  if (found.fromHistory) return found.columns;
  const siblings = Object.entries(lock)
    .filter(([key]) => key.startsWith(`${table.table}@`))
    .map(([, columns]) => columns);
  if (siblings.length === 0) return found.columns;
  return found.columns.filter((column) => siblings.every((columns) => columns.includes(column)));
}

export interface LockUpdate {
  readonly next: GenesisLock;
  readonly added: readonly string[];
  readonly refused: readonly string[];
}

/**
 * Add a genesis entry for a table that has none. An existing entry is NEVER
 * rewritten: widening it excuses exactly the columns this gate exists to catch,
 * and narrowing it demands reconciliation of columns the table shipped with.
 * Both directions are refused by the same rule, so the lock cannot be moved by
 * the change it is judging.
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
    refused.push(`${key}: locked [${existing.join(', ')}], history now reads [${recomputed.join(', ')}]`);
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
  /** Files PARSED: those carrying a statement or call this gate reads. */
  readonly parsed: number;
  readonly tables: readonly TableDdl[];
  readonly backfill: BackfillInspection;
  readonly lock: GenesisLock;
  readonly violations: readonly Violation[];
  /** Locked tables no longer in the corpus. Retained on purpose — see header. */
  readonly retired: readonly string[];
}

/** Every statement and call the gate can read. A product file containing none
 *  of them declares no table, backfills no column and moves no row, so parsing
 *  it is work with no possible verdict. The ENUMERATION stays whole — this
 *  narrows only what is handed to the parser, and both counts are printed, so
 *  the corpus cannot shrink behind the number. */
const READABLE_TOKEN = /CREATE TABLE IF NOT EXISTS|reconcileColumns|reconcileSqlExecColumns|ensureColumn|ADD COLUMN|adoptLegacyForkLineage|migrateWorkspaceStorage|initAllTables/;

export function survey(lockPath: string = GENESIS_LOCK): Survey {
  // Working tree, not HEAD: the gate must fail on the change being made, not on
  // the change already committed. `readMatching` reads the working tree, and it
  // is the ONLY enumeration — this line was
  // `git ls-files 'packages/*/src/**/*.ts'`, whose `**/` requires at least one
  // intervening directory, so it matched 454 of 616 product files and every file
  // sitting directly in a `src/` was invisible. `actor-agent.ts` among them: the
  // largest DDL surface in the repo, in a gate reporting drift-free over it.
  const sources = readMatching(isProductSource);
  const readable = new Map([...sources].filter(([, source]) => READABLE_TOKEN.test(source)));
  const index = syntaxIndex(readable);
  const tables = tablesIn(readable);
  const backfill = inspectIndexedBackfills(index);
  const lock = readGenesisLock(lockPath);
  const present = new Set(tables.map(({ table, file }) => lockKey(table, file)));
  return {
    files: sources.size,
    parsed: readable.size,
    tables,
    backfill,
    lock,
    violations: [...driftViolations(tables, backfill.named, lock), ...indexedMoverViolations(index)],
    retired: Object.keys(lock).filter((key) => !present.has(key)).sort(),
  };
}

/** What this gate does NOT catch, printed on the GREEN path: a limitation
 *  visible only in red output is invisible exactly when the tree is green. */
export function blindSpots(state: Survey): string[] {
  return [
    'reads DDL text, never a database: a column credited to an ALTER TABLE string is credited by '
      + 'name, and nothing here runs the statement',
    'names only. A changed column TYPE or CONSTRAINT on a shipped table is invisible, and '
      + 'ALTER TABLE cannot repair either — heads/schema.ts documents that case',
    'a column REMOVED from a DDL that live storage still has stays unreported; that is dead-field '
      + 'territory',
    'genesis is the first-shipped column set recorded in the lock. Storage recreated after that '
      + '(a pre-production reset) still requires the declaration, which is the conservative '
      + `direction — ${String(state.retired.length)} locked table(s) are no longer in the corpus and `
      + 'stay locked, never re-locked',
    `the excuse list is asserted rather than trusted, and holds ${String(Object.keys(RUNTIME_MOVERS).length)} `
      + `table(s): ${Object.keys(RUNTIME_MOVERS).join(', ')}`,
    'a table created outside the product corpus — a test fixture, a statement typed into a shell — '
      + 'is not enumerated here',
    'the checking path reads the lock and never git, so it runs under a shallow clone and in 2s. '
      + 'A lock entry edited BY HAND disagrees with history until the next `--lock`, which refuses '
      + 'it and names both column sets; until then the diff is what a reviewer sees',
  ];
}

if (import.meta.main) {
  const state = survey();
  // The corpus counts are asserted on both paths. The LOCK COUNT is asserted
  // only on the checking path, because an empty lock is the one legitimate
  // state `--lock` starts from — and on the checking path it is the shape that
  // would report a drift-free tree while comparing every table against nothing.
  const corpus: readonly (readonly [string, number])[] = [
    ['product files enumerated', state.files],
    ['of them parsed', state.parsed],
    ['tables', state.tables.length],
    ['reconciliation calls', state.backfill.reconcileCalls],
  ];
  if (process.argv.includes('--lock')) {
    const update = lockUpdate(state.tables, state.lock, (table) => genesisForNewTable(table, state.lock));
    if (update.refused.length > 0) {
      console.error(
        `schema-drift --lock: refusing to rewrite ${String(update.refused.length)} existing genesis entr(ies).\n`
        + 'A genesis is a historical fact. Reconcile the added columns instead of moving the baseline.\n',
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
