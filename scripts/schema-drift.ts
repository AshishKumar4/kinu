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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
 *  in core identity/schema.ts moves the row instead. */
const HANDLED_ELSEWHERE = {
  user_devices: true,
  user_cli_tokens: true,
  fork_lineage: true,
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

/** Every column named in a backfill call anywhere in the tracked sources. */
function backfilledColumns(sources: Map<string, string>): Set<string> {
  const named = new Set<string>();
  for (const source of sources.values()) {
    for (const m of source.matchAll(/ALTER TABLE\s+(?:\$\{table\}|(\w+))\s+ADD COLUMN\s+(\w+)/g)) {
      if (m[1] !== undefined && m[2] !== undefined) named.add(`${m[1]}.${m[2]}`);
    }
    // reconcileColumns(execRaw, 'table', ['col TYPE', …]) and ensureColumn(sql, 'table', 'col', …)
    for (const m of source.matchAll(/reconcileColumns\([^,]+,\s*'(\w+)',\s*\[([\s\S]*?)\]\)/g)) {
      const table = m[1];
      for (const c of (m[2] ?? '').matchAll(/['"`](\w+)\s/g)) named.add(`${table}.${c[1]}`);
    }
    for (const m of source.matchAll(/ensureColumn\([^,]+,\s*'(\w+)',\s*'(\w+)'/g)) {
      named.add(`${m[1]}.${m[2]}`);
    }
  }
  return named;
}

export function findSchemaDrift(): Violation[] {
  const files = git(['ls-files', 'packages/*/src/**/*.ts']).split('\n').filter(Boolean);
  const sources = new Map<string, string>();
  // Working tree, not HEAD: the gate must fail on the change being made, not
  // on the change already committed.
  for (const file of files) sources.set(file, readFileSync(join(root, file), 'utf8'));

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
      `  Add them to a reconcileColumns(execRaw, '${table}', [...]) call beside the DDL.`)
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
