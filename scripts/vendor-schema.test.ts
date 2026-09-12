import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { findViolations, vendorTables, type VendorTable } from './vendor-schema';

const vendor = (): Map<string, VendorTable> => new Map([
  ['v_rows', { table: 'v_rows', vendor: 'synthetic', ddl: 'CREATE TABLE IF NOT EXISTS v_rows (id TEXT PRIMARY KEY, body TEXT, created_at INTEGER)' }],
]);

const corpus = (files: Record<string, string>): Map<string, string> =>
  new Map(Object.entries(files).map(([f, t]) => [`packages/core/src/${f}`, t]));

const ColumnSchema = v.object({ name: v.string() });

describe('vendor-schema', () => {
  test('a read naming only columns the vendor DDL has is not a finding', () => {
    const { findings, statements } = findViolations(vendor(), corpus({
      'a.ts': 'const rows = sql`SELECT id, body FROM v_rows WHERE created_at > 0`;',
    }));

    expect(findings).toEqual([]);
    expect(statements).toBe(1);
  });

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

  test('a backtick-fenced statement inside a comment is prose, not a read', () => {
    const { findings, statements } = findViolations(vendor(), corpus({
      'a.ts': '/** The SDK runs `DELETE FROM v_rows WHERE gone = 1` after the callback. */\nexport const x = 1;',
    }));

    expect(findings).toEqual([]);
    expect(statements).toBe(0);
  });

  test('the installed vendors declare the pane store and the fiber runs, and the pane carries no actor column', () => {
    const tables = vendorTables();

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
