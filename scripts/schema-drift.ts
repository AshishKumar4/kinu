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

/**
 * A `reconcileColumns(sql, execRaw, 'table', columns)` call site. `columns` is
 * captured raw: it is an inline object literal at most sites and a named,
 * exported constant where the same list also feeds a second init path.
 */
const RECONCILE_RE =
  /reconcileColumns\([^,]+,\s*[^,]+,\s*'(\w+)',\s*(\{[\s\S]*?\}|\w+)\s*\)/g;

/** `export const NAME = { col: 'TYPE', … }` — the named form's definition. */
const COLUMN_CONST_RE =
  /const\s+(\w+)\s*(?::[^=]+)?=\s*(\{[^}]*\})/g;

/** Column names out of an object literal's keys. */
function objectKeys(literal: string): string[] {
  return [...literal.matchAll(/(\w+)\s*:/g)].flatMap((m) => m[1] === undefined ? [] : [m[1]]);
}

/**
 * Every column named in a backfill call anywhere in the tracked sources.
 *
 * `reconcileColumns` changed shape once already — from
 * `(execRaw, table, ['col TYPE'])` to `(sql, execRaw, table, { col: 'TYPE' })` —
 * and the pattern here went on matching nothing, so this gate reported no drift
 * because it was reading no call sites rather than because there were none.
 * Hence `assertEveryCallSiteParsed`: the denominator is checked, not assumed.
 */
function backfilledColumns(sources: Map<string, string>): Set<string> {
  // Column lists named once and used by more than one init path, resolved
  // across files because the constant is exported from the module that owns
  // the table and imported by the unified initializer.
  const byConstName = new Map<string, string[]>();
  for (const source of sources.values()) {
    for (const m of source.matchAll(COLUMN_CONST_RE)) {
      if (m[1] !== undefined && m[2] !== undefined) byConstName.set(m[1], objectKeys(m[2]));
    }
  }

  const named = new Set<string>();
  for (const source of sources.values()) {
    for (const m of source.matchAll(/ALTER TABLE\s+(?:\$\{table\}|(\w+))\s+ADD COLUMN\s+(\w+)/g)) {
      if (m[1] !== undefined && m[2] !== undefined) named.add(`${m[1]}.${m[2]}`);
    }
    for (const m of source.matchAll(RECONCILE_RE)) {
      const table = m[1];
      const argument = m[2] ?? '';
      const columns = argument.startsWith('{')
        ? objectKeys(argument)
        : byConstName.get(argument) ?? [];
      for (const column of columns) named.add(`${table}.${column}`);
    }
    for (const m of source.matchAll(/ensureColumn\([^,]+,\s*'(\w+)',\s*'(\w+)'/g)) {
      named.add(`${m[1]}.${m[2]}`);
    }
  }
  return named;
}

/**
 * Every `reconcileColumns(` CALL in the tree must be one this gate could read,
 * and each must resolve to at least one column. A call it cannot parse — or one
 * whose named column list it cannot resolve — is a table whose backfill it
 * cannot see, which it would otherwise report as drift-free.
 *
 * The declaration in `identity/columns.ts` is excluded by name: it is the
 * definition, not a call.
 */
function assertEveryCallSiteParsed(sources: Map<string, string>): void {
  const byConstName = new Map<string, string[]>();
  for (const source of sources.values()) {
    for (const m of source.matchAll(COLUMN_CONST_RE)) {
      if (m[1] !== undefined && m[2] !== undefined) byConstName.set(m[1], objectKeys(m[2]));
    }
  }

  const faults: string[] = [];
  let callsSeen = 0;
  for (const [file, source] of sources) {
    const calls = (source.match(/(?<!function\s)\breconcileColumns\(/g) ?? []).length;
    if (calls === 0) continue;
    callsSeen += calls;
    const matches = [...source.matchAll(RECONCILE_RE)];
    if (matches.length !== calls) {
      faults.push(`${file}: ${calls} call(s), ${matches.length} parsed — update RECONCILE_RE`);
      continue;
    }
    for (const m of matches) {
      const argument = m[2] ?? '';
      const columns = argument.startsWith('{') ? objectKeys(argument) : byConstName.get(argument);
      if (columns === undefined || columns.length === 0) {
        faults.push(`${file}: reconcileColumns(… '${m[1]}', ${argument}) resolved to no columns`);
      }
    }
  }
  if (callsSeen === 0) {
    faults.push('no reconcileColumns call sites found at all — the gate examined nothing');
  }
  if (faults.length > 0) {
    throw new Error(
      'schema-drift cannot read every reconcileColumns call, so it would report ' +
      `drift-free on tables it never examined.\n  ${faults.join('\n  ')}`,
    );
  }
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

  assertEveryCallSiteParsed(sources);
  const backfilled = backfilledColumns(sources);
  const violations: Violation[] = [];

  for (const [file, source] of sources) {
    for (const m of source.matchAll(TABLE_RE)) {
      const table = m[1];
      if (table === undefined || HANDLED_ELSEWHERE[table] === true) continue;
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
