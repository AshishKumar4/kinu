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
 * every `CREATE TABLE` in the installed `agents` and
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
import { Database, SQLiteError } from 'bun:sqlite';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { assertMeasured } from './gate-ratchet';
import { columnsOf, tablesIn } from './schema-drift';
import { isParseable, isTestFile, readMatching } from './sources';
import {
  entityName, holesAsNames, leadingKeywords, type Names, namesIn, sqlProgram, type SqlStatement, sqlStrings,
} from './sql-text';

const VENDORS = ['agents', '@cloudflare/containers'] as const;

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

/** The tables and views one string leaves in an empty database, each with the
 *  statement SQLite stored for it; undefined when SQLite refuses the string. The
 *  string is RUN rather than parsed because a virtual table's module arguments
 *  (`fts5(… UNINDEXED, tokenize=…)`) belong to no grammar but the module's. */
function createdBy(text: string): { readonly name: string; readonly ddl: string }[] | undefined {
  const db = new Database(':memory:');

  try {
    db.run(text);

    return v.parse(v.array(v.object({ name: v.string(), ddl: v.string() })), db.query(
      `SELECT l.name AS name, m.sql AS ddl FROM pragma_table_list AS l JOIN sqlite_master AS m ON m.name = l.name
        WHERE l.schema = 'main' AND l.type IN ('table', 'virtual') AND substr(l.name, 1, 7) <> 'sqlite_'`,
    ).all());
  } catch (error) {
    // SQLite refusing the string is the answer: it is not DDL this database can run.
    if (error instanceof SQLiteError) return undefined;
    throw error;
  } finally {
    db.close();
  }
}

export interface Vendors {
  readonly tables: Map<string, VendorTable>;
  /** Vendor strings that begin as a CREATE TABLE and that SQLite refused: a hole it could not fold, or a broken DDL. */
  readonly refused: number;
}

/** Every table the installed vendors create, keyed by name: each string
 *  expression in the vendor's dist that spells CREATE, its constants folded off
 *  the syntax tree, run in its own empty database. A name two vendors both
 *  create with different bodies is a finding, not a silent pick. */
export function vendorTables(nodeModules = 'node_modules'): Vendors {
  const tables = new Map<string, VendorTable>();
  let refused = 0;

  const strings = VENDORS.flatMap((vendor) => [...jsFiles(join(nodeModules, vendor, 'dist'))]
    .flatMap((file) => sqlStrings(file, readFileSync(file, 'utf8')).map(({ text }) => ({ vendor, text }))));

  // Only a string that spells CREATE can create a table.
  for (const { vendor, text } of strings.filter((string) => string.text.toUpperCase().includes('CREATE'))) {
    const created = createdBy(text);

    if (created === undefined) {
      const [first, ...rest] = leadingKeywords(text, 3);

      if (first === 'CREATE' && rest.includes('TABLE')) refused += 1;
      continue;
    }

    for (const { name, ddl } of created) {
      const table = name.toLowerCase();
      const known = tables.get(table);

      if (known !== undefined && known.ddl !== ddl) {
        throw new Error(`vendor-schema: ${table} is created by both ${known.vendor} and ${vendor} with different bodies`);
      }

      tables.set(table, { table, vendor, ddl });
    }
  }

  return { tables, refused };
}

/** The words a string must open with to be read as SQL at all; the parser decides the rest. */
const STATEMENT_HEADS = {
  SELECT: true, WITH: true, VALUES: true, INSERT: true, REPLACE: true, UPDATE: true, DELETE: true,
  CREATE: true, DROP: true, ALTER: true, PRAGMA: true, EXPLAIN: true,
} satisfies Record<string, true>;

export interface Statement {
  readonly line: number;
  /** The statement's own text, each hole a parameter, or a name where a parameter cannot stand. */
  readonly sql: string;
  readonly program: SqlStatement;
  readonly names: Names;
}

/** Every SQL statement one file's string expressions spell, off its syntax
 *  tree: a backtick-fenced `DELETE FROM …` in a doc comment is prose, not a
 *  read. A hole is a bound parameter, or a name (`FROM ${table}`) where SQLite
 *  admits no parameter; a string SQLite reads neither way is not SQL. */
export function statementsOf(file: string, source: string): readonly Statement[] {
  return sqlStrings(file, source).flatMap((string) => {
    const [head] = leadingKeywords(string.text, 1);

    if (head === undefined || !Object.hasOwn(STATEMENT_HEADS, head)) return [];
    const asParameters = sqlProgram(string.text);
    const text = asParameters === undefined ? holesAsNames(string) : string.text;
    const program = asParameters ?? sqlProgram(text);

    return (program?.statements ?? []).flatMap((statement) => {
      if (statement.type === 'empty' || statement.range === undefined) return [];

      return [{ line: string.line, sql: text.slice(...statement.range), program: statement, names: namesIn(statement) }];
    });
  });
}

/** Kinu's own tables as untyped column lists, so a statement that joins one to
 *  a vendor table has every name it needs. A name the vendor also creates is
 *  the vendor's: that collision is reported as a finding, never built twice. */
function kinuStandIns(vendor: ReadonlyMap<string, VendorTable>, sources: ReadonlyMap<string, string>): readonly string[] {
  const columns = new Map<string, Set<string>>();

  for (const table of tablesIn(sources)) {
    if (vendor.has(table.table)) continue;
    const known = columns.get(table.table) ?? new Set<string>();

    for (const column of columnsOf(table.parts)) known.add(column);
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
    for (const { line, sql, program, names } of statementsOf(file, source)) {
      const named = [...names.tables].filter((name) => vendor.has(name));

      if (named.length === 0) continue;
      statements += 1;

      for (const name of named) tablesRead.add(name);
      const created = program.type === 'create_table_stmt' ? entityName(program.name) : undefined;

      if (created !== undefined && vendor.has(created)) {
        findings.push({ file, line, table: created, detail: 'Kinu declares a DDL for a table the vendor creates: two owners of one shape' });
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
  const { tables: vendor, refused } = vendorTables();
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
  console.log('  blind: SQL built at runtime beyond a string expression and the consts it names; a hole is read as a '
    + 'parameter, or as a name where SQLite admits no parameter');
  console.log(`  blind: ${String(refused)} vendor string(s) begin as a CREATE TABLE and SQLite refused them (an unfolded hole or a `
    + 'broken DDL), so any table they create is not built; a column a vendor adds by ALTER TABLE is not built either');
  console.log('  blind: a column that exists with a different TYPE or DEFAULT; prepare checks names, not semantics');
  console.log(`  blind: a vendor outside ${VENDORS.join(', ')}`);
}
