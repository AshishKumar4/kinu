/**
 * Schema-drift gate — every column added to a shipped table must be backfilled.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op on an existing table, so a column
 * added later never reaches a workspace created before it while every reader
 * still selects it by name. That reached a live workspace as
 * `no such column: code_language at offset 74`, and it had already happened
 * once before to `scaffold_versions` (`status`, `parent_version`).
 *
 * So this compares each table's current column list against the list in the
 * commit that introduced the table, and requires every column added since to
 * be named in a backfill — `reconcileColumns` in core, `ensureColumn` in the
 * cf user schema, or a documented one-shot reset.
 *
 * History is the source of truth here rather than a hand-maintained baseline
 * list, because a list is the thing that drifts.
 */

import { isProductSource, readMatching } from './sources';
import {
  identifierCalleeName,
  literalText,
  parse as parseSyntax,
  type SyntaxNode,
  walk,
} from './syntax';

const root = new URL('..', import.meta.url).pathname;

const TABLE_RE = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\n\s*\)/g;
const COLUMN_RE = /^([a-z_][a-z0-9_]*)\s+(TEXT|INTEGER|REAL|BLOB)/;

/** Tables whose post-release columns are reached another way, each with the
 *  reason. An entry here is a claim that a reader on an older workspace still
 *  works — not permission to skip the problem.
 *
 *  user_devices / user_cli_tokens: a documented destructive reset, because
 *  pre-release rows stored raw tokens and keeping them would preserve the
 *  security flaw (cf-backend user/schema.ts resetRawTokenTable).
 *
 *  fork_lineage: the columns were RENAMED, not added, so the values live in
 *  the old columns and ADD COLUMN cannot recover them — adoptLegacyForkLineage
 *  in core identity/schema.ts moves the row instead.
 *
 *  traces: `created_at` is WRITTEN BY NOBODY AND READ BY NOBODY. Both of this
 *  repo's `traces` tables (cf-backend exploration.ts, cli-backend
 *  branch-worker.ts) insert `(step, text)` and select `text ORDER BY step` and
 *  nothing else, so a branch DB created before the column still satisfies every
 *  statement issued against it. Surfaced only once this gate stopped enumerating
 *  with `git ls-files 'packages/*'`-style pathspecs: `branch-worker.ts` sits
 *  directly in a `src/`, which the old `**` glob could not match. */
const HANDLED_ELSEWHERE = {
  user_devices: true,
  user_cli_tokens: true,
  fork_lineage: true,
  traces: true,
} satisfies Record<string, true>;

export interface Violation {
  table: string;
  file: string;
  columns: string[];
}

function git(args: string[]): string {
  const out = Bun.spawnSync(['git', ...args], { cwd: root });
  return out.success ? new TextDecoder().decode(out.stdout) : '';
}

function columnsOf(source: string, table: string): string[] | null {
  const re = new RegExp(`CREATE TABLE IF NOT EXISTS\\s+${table}\\s*\\(([\\s\\S]*?)\\n\\s*\\)`);
  const body = re.exec(source)?.[1];
  if (body === undefined) return null;
  const columns: string[] = [];
  for (const line of body.split('\n')) {
    const name = COLUMN_RE.exec(line.trim())?.[1];
    if (name !== undefined) columns.push(name);
  }
  return columns;
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

function syntaxIndex(sources: Map<string, string>): SyntaxIndex {
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
export function inspectBackfillCalls(sources: Map<string, string>): BackfillInspection {
  const index = syntaxIndex(sources);
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

export function findSchemaDrift(): Violation[] {
  // Working tree, not HEAD: the gate must fail on the change being made, not on
  // the change already committed. `readMatching` reads the working tree, and it
  // is the ONLY enumeration — this line was
  // `git ls-files 'packages/*/src/**/*.ts'`, whose `**/` requires at least one
  // intervening directory, so it matched 454 of 616 product files and every file
  // sitting directly in a `src/` was invisible. `actor-agent.ts` among them: the
  // largest DDL surface in the repo, in a gate reporting drift-free over it.
  const sources = readMatching(isProductSource);

  const backfilled = inspectBackfillCalls(sources).named;
  const violations: Violation[] = [];

  for (const [file, source] of sources) {
    for (const m of source.matchAll(TABLE_RE)) {
      const table = m[1];
      if (table === undefined || table in HANDLED_ELSEWHERE) continue;
      const now = columnsOf(source, table);
      if (now === null) continue;

      const intro = git([
        'log', '--format=%H', '--reverse', '-S', `CREATE TABLE IF NOT EXISTS ${table}`, '--', file,
      ]).split('\n')[0];
      if (intro === undefined || intro === '') continue;

      const original = columnsOf(git(['show', `${intro}:${file}`]), table);
      if (original === null) continue;

      const missing = now
        .filter((column) => !original.includes(column))
        .filter((column) => !backfilled.has(`${table}.${column}`));
      if (missing.length > 0) violations.push({ table, file, columns: missing });
    }
  }
  return violations;
}

export function formatViolations(violations: Violation[]): string {
  return violations
    .map(({ table, file, columns }) =>
      `${table} (${file}) added [${columns.join(', ')}] after release with no backfill.\n` +
      `  Add them to a reconcileColumns(sql, execRaw, '${table}', { … }) call beside the DDL.`)
    .join('\n');
}

if (import.meta.main) {
  const violations = findSchemaDrift();
  if (violations.length > 0) {
    console.error(formatViolations(violations));
    process.exit(1);
  }
  console.log('schema-drift: every post-release column is backfilled');
}
