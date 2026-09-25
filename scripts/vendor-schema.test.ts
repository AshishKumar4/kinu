import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { scratchDir } from '@kinu.run/test-utils';
import { findViolations, vendorTables, type VendorTable } from './vendor-schema';

const vendor = (): Map<string, VendorTable> => new Map([
  ['v_rows', { table: 'v_rows', vendor: 'synthetic', ddl: 'CREATE TABLE IF NOT EXISTS v_rows (id TEXT PRIMARY KEY, body TEXT, created_at INTEGER)' }],
]);

const corpus = (files: Record<string, string>): Map<string, string> =>
  new Map(Object.entries(files).map(([f, t]) => [`packages/core/src/${f}`, t]));

const ColumnSchema = v.object({ name: v.string() });

describe('vendor-schema', () => {
  test('RED: a read naming a vendor table in any spelling SQLite accepts is prepared', () => {
    const { findings, statements } = findViolations(vendor(), corpus({
      'a.ts': [
        'const quoted = sql`SELECT actor_id FROM "v_rows"`;',
        'const bracketed = sql`SELECT actor_id FROM [v_rows]`;',
        'const qualified = sql`SELECT actor_id FROM main.v_rows`;',
        'const commented = sql`-- the pane\\nSELECT actor_id FROM v_rows`;',
        "execRaw('SELECT actor_id FROM v_rows WHERE 1');",
        'const owned = `CREATE TABLE IF NOT EXISTS "v_rows" (id TEXT)`;',
      ].join('\n'),
    }));

    expect(statements).toBe(6);
    expect(findings.map((f) => [f.line, f.detail.includes('two owners') ? 'owners' : f.detail])).toEqual([
      [1, 'no such column: actor_id'],
      [2, 'no such column: actor_id'],
      [3, 'no such column: actor_id'],
      [4, 'no such column: actor_id'],
      [5, 'no such column: actor_id'],
      [6, 'owners'],
    ]);
  });

  test('RED: a vendor CREATE TABLE is read whatever its spelling, and its body as SQL', () => {
    const modules = scratchDir('vendor-schema');
    const dist = join(modules, 'agents', 'dist');
    mkdirSync(dist, { recursive: true });
    mkdirSync(join(modules, '@cloudflare', 'containers', 'dist'), { recursive: true });
    writeFileSync(join(dist, 'index.js'), [
      'const TABLE = "cf_plain";',
      'export function init(sql) {',
      '  sql.exec(`create table ${TABLE} (id TEXT PRIMARY KEY, closer TEXT DEFAULT \')\', created_at INTEGER)`);',
      '}',
    ].join('\n'));
    const { tables, refused } = vendorTables(modules);

    expect([...tables.keys()]).toEqual(['cf_plain']);
    expect(refused).toBe(0);
    const db = new Database(':memory:');
    db.run(tables.get('cf_plain')?.ddl ?? '');
    const columns = v.parse(v.array(ColumnSchema), db.query('PRAGMA table_info(cf_plain)').all()).map((c) => c.name);
    db.close();

    expect(columns).toEqual(['id', 'closer', 'created_at']);
  });

  const clean = [
    {
      name: 'a read naming only columns the vendor DDL has is not a finding',
      source: 'const rows = sql`SELECT id, body FROM v_rows WHERE created_at > 0`;',
      statements: 1,
    },
    {
      name: 'a backtick-fenced statement inside a comment is prose, not a read',
      source: '/** The SDK runs `DELETE FROM v_rows WHERE gone = 1` after the callback. */\nexport const x = 1;',
      statements: 0,
    },
  ];

  for (const read of clean) {
    test(read.name, () => {
      const { findings, statements } = findViolations(vendor(), corpus({ 'a.ts': read.source }));

      expect(findings).toEqual([]);
      expect(statements).toBe(read.statements);
    });
  }

  test('a read naming a column the vendor lacks is one finding that says so', () => {
    const { findings } = findViolations(vendor(), corpus({
      'a.ts': 'const x = 1;\nconst rows = sql`SELECT actor_id, id FROM v_rows`;',
    }));

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ file: 'packages/core/src/a.ts', line: 2, table: 'v_rows' });
    expect(findings[0]?.detail).toContain('no such column');
  });

  test('a Kinu DDL over a vendor table name is a two-owners finding', () => {
    const { findings } = findViolations(vendor(), corpus({
      'a.ts': 'export const DDL = `CREATE TABLE IF NOT EXISTS v_rows (id TEXT PRIMARY KEY, body TEXT)`;',
    }));

    expect(findings).toHaveLength(1);
    expect(findings[0]?.detail).toContain('two owners');
  });

  test('a statement over a table no vendor creates is not counted', () => {
    const { findings, statements, tablesRead } = findViolations(vendor(), corpus({
      'a.ts': 'const rows = sql`SELECT nothing_here FROM kinu_only WHERE x = 1`;',
    }));

    expect(findings).toEqual([]);
    expect(statements).toBe(0);
    expect(tablesRead.size).toBe(0);
  });

  test('an interpolation binds as a parameter and does not break the prepare', () => {
    const { findings, statements } = findViolations(vendor(), corpus({
      'a.ts': [
        'const rows = sql`SELECT id FROM v_rows WHERE id = ${actor.id} AND created_at <= ${Date.now()}',
        '  LIMIT ${LIMIT}`;',
      ].join('\n'),
    }));

    expect(findings).toEqual([]);
    expect(statements).toBe(1);
  });

  test('a join to a Kinu table declared in the corpus prepares against its column list', () => {
    const { findings, statements } = findViolations(vendor(), corpus({
      'schema.ts': 'const DDL = `CREATE TABLE IF NOT EXISTS k_events (\n  actor_id TEXT NOT NULL,\n  turn_id TEXT\n)`;',
      'a.ts': 'const rows = sql`SELECT e.actor_id FROM k_events e JOIN v_rows r ON r.id = e.turn_id`;',
      'b.ts': 'const rows = sql`SELECT e.missing FROM k_events e JOIN v_rows r ON r.id = e.turn_id`;',
    }));

    expect(statements).toBe(2);
    expect(findings.map((f) => f.file)).toEqual(['packages/core/src/b.ts']);
    expect(findings[0]?.detail).toContain('no such column: e.missing');
  });

  test('the installed vendors declare the pane store and the fiber runs, and the pane carries no actor column', () => {
    const { tables } = vendorTables();

    expect(tables.has('assistant_messages')).toBe(true);
    expect(tables.has('cf_agents_runs')).toBe(true);
    const db = new Database(':memory:');

    db.run(tables.get('assistant_messages')?.ddl ?? '');
    const columns = v.parse(v.array(ColumnSchema), db.query('PRAGMA table_info(assistant_messages)').all()).map((c) => c.name);

    db.close();
    expect(columns).toContain('id');
    expect(columns).not.toContain('actor_id');
  });
});
