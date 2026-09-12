/**
 * Vendor-schema gate — every Kinu statement over a table a VENDOR creates
 * prepares against the vendor's own DDL, out of the installed package.
 *
 * On 2026-09-11 every hosted workspace failed to open: Kinu read `actor_id`
 * on `assistant_messages`, a table the Agents SDK creates and writes with no
 * such column. `schema-drift` never saw it (no Kinu `CREATE TABLE`), the
 * conformance census never saw it (tables, not columns), and every unit test
 * seeded the table from Kinu's OWN copy of the DDL, which carried the column.
 * The fixture and the code drifted together; nothing compared either against
 * what production has.
 *
 * Both sides here are DERIVED, nothing is hand-listed. The vendor side is
 * every `CREATE TABLE` in the installed `agents`, `@cloudflare/think` and
 * `@cloudflare/containers` dist, built in one in-memory SQLite. The Kinu side
 * is every SQL template literal in the product corpus that names one of those
 * tables, prepared against that database: SQLite refuses an unknown column at
 * prepare, so a read the vendor cannot satisfy fails here, and an SDK bump that
 * drops a column fails on install. A table both sides create (a Kinu DDL over
 * a vendor name) is reported as its own finding: two owners of one table is
 * the drift this gate exists to end.
 *
 * Kinu's own tables stand in the same database as untyped column lists, read
 * from the corpus by `schema-drift`'s parser, so a statement that JOINS a
 * vendor table to a Kinu one prepares instead of failing on the Kinu name.
 * Statements come from the syntax tree, not from the text: a backtick-fenced
 * `DELETE FROM …` in a doc comment is prose, not a read.
 */
import { Database } from 'bun:sqlite';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { assertMeasured } from './gate-ratchet';
import { tablesIn } from './schema-drift';
import { isParseable, isTestFile, readMatching } from './sources';
import { parse, walk } from './syntax';

const VENDORS = ['agents', '@cloudflare/think', '@cloudflare/containers'] as const;

export interface VendorTable {
  readonly table: string;
  readonly vendor: string;
  readonly ddl: string;
}

export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly table: string;
  readonly detail: string;
}

function* jsFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);

    if (statSync(path).isDirectory()) yield* jsFiles(path);
    else if (entry.endsWith('.js')) yield path;
  }
}

function balanced(source: string, open: number): string {
  let depth = 0;

  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')' && (depth -= 1) === 0) return source.slice(open, i + 1);
  }

  throw new Error('vendor-schema: an unterminated CREATE TABLE body');
}

/** Every table the installed vendors create, keyed by name. A name two vendors
 *  both create with different bodies is a finding, not a silent pick. */
export function vendorTables(nodeModules = 'node_modules'): Map<string, VendorTable> {
  const tables = new Map<string, VendorTable>();
  const head = /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+IF\s+NOT\s+EXISTS\s+([a-z_][a-z0-9_]*)\s*(?:USING\s+\w+\s*)?\(/gi;

  for (const vendor of VENDORS) {
    for (const file of jsFiles(join(nodeModules, vendor, 'dist'))) {
      const source = readFileSync(file, 'utf8');

      for (const match of source.matchAll(head)) {
        const table = match[1]?.toLowerCase();

        if (table === undefined) continue;
        const body = balanced(source, match.index + match[0].length - 1).replace(/\\n/g, ' ');
        const ddl = `${match[0].slice(0, -1)}${body}`;
        const known = tables.get(table);

        if (known !== undefined && known.ddl.replace(/\s+/g, ' ') !== ddl.replace(/\s+/g, ' ')) {
          throw new Error(`vendor-schema: ${table} is created by both ${known.vendor} and ${vendor} with different bodies`);
        }

        tables.set(table, { table, vendor, ddl });
      }
    }
  }

  return tables;
}

/** Every SQL template literal in one product file, off its syntax tree: the
 *  statement with each `${…}` bound as a parameter, and the line it starts on.
 *  A nested template inside an interpolation is its own literal and is read
 *  on its own; the outer statement sees it as one parameter. */
export function statementsOf(file: string, source: string): readonly { line: number; sql: string }[] {
  const out: { line: number; sql: string }[] = [];
  const parsed = parse(file, source);

  walk(parsed.root, (node) => {
    const { raw } = node;

    if (raw.type !== 'TemplateLiteral') return;
    const sql = raw.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join('?');

    if (!/^\s*(?:SELECT|WITH|INSERT|UPDATE|DELETE|CREATE|DROP)\b/i.test(sql)) return;
    out.push({ line: parsed.lineAt(node.start), sql });
  });

  return out;
}

/** Kinu's own tables as untyped column lists, so a statement that joins one to
 *  a vendor table has every name it needs. A name the vendor also creates is
 *  the vendor's: that collision is reported as a finding, never built twice. */
function kinuStandIns(vendor: ReadonlyMap<string, VendorTable>, sources: ReadonlyMap<string, string>): readonly string[] {
  const columns = new Map<string, Set<string>>();

  for (const table of tablesIn(sources)) {
    if (vendor.has(table.table)) continue;
    const known = columns.get(table.table) ?? new Set<string>();

    for (const column of table.columns) known.add(column);
    columns.set(table.table, known);
  }

  return [...columns].map(([table, names]) => `CREATE TABLE ${table} (${[...names].join(', ')})`);
}

/** What one pass measured: the findings, how many statements named a vendor
 *  table, and which vendor tables the corpus names at all. */
export interface Measurement {
  readonly findings: readonly Finding[];
  readonly statements: number;
  readonly tablesRead: ReadonlySet<string>;
}

export function findViolations(vendor: Map<string, VendorTable>, sources: Map<string, string>): Measurement {
  const db = new Database(':memory:');

  for (const { ddl } of vendor.values()) db.run(ddl);

  for (const ddl of kinuStandIns(vendor, sources)) db.run(ddl);
  const findings: Finding[] = [];
  const tablesRead = new Set<string>();
  let statements = 0;

  for (const [file, source] of sources) {
    for (const { line, sql } of statementsOf(file, source)) {
      const named = [...sql.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE|TABLE(?:\s+IF\s+NOT\s+EXISTS)?)\s+([a-z_][a-z0-9_]*)/gi)]
        .map((m) => m[1]?.toLowerCase() ?? '')
        .filter((name) => vendor.has(name));

      if (named.length === 0) continue;
      statements += 1;

      for (const name of named) tablesRead.add(name);

      if (/^\s*CREATE\s+TABLE/i.test(sql)) {
        findings.push({ file, line, table: named[0] ?? '', detail: 'Kinu declares a DDL for a table the vendor creates: two owners of one shape' });
        continue;
      }

      try {
        db.prepare(sql).finalize();
      } catch (error) {
        findings.push({ file, line, table: named.join(','), detail: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  db.close();

  return { findings, statements, tablesRead };
}

if (import.meta.main) {
  const vendor = vendorTables();
  const sources = readMatching((file) => isParseable(file) && file.startsWith('packages/') && !isTestFile(file));
  const { findings, statements, tablesRead } = findViolations(vendor, sources);

  const measured = assertMeasured('vendor-schema', [
    ['vendor tables built', vendor.size],
    ['product files read', sources.size],
    ['statements over vendor tables prepared', statements],
    ['vendor tables Kinu names', tablesRead.size],
  ]);

  if (findings.length > 0) {
    console.error(`vendor-schema: ${String(findings.length)} statement(s) the installed vendor cannot serve — ${measured}`);

    for (const f of findings) {
      console.error(`  ${f.file}:${String(f.line)} ${f.table}`);
      console.error(`    must:      every column Kinu names on a vendor table exists in the installed vendor's DDL`);
      console.error(`    found:     ${f.detail}`);
    }

    process.exit(1);
  }

  console.log(`vendor-schema: ok — ${measured}`);
  console.log('  blind: statements built at runtime from strings, and a vendor DDL whose text this cannot parse');
  console.log('  blind: a column that exists with a different TYPE or DEFAULT; prepare checks names, not semantics');
  console.log(`  blind: a vendor outside ${VENDORS.join(', ')}`);
}
