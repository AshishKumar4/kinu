/**
 * The pane store's shape is the vendor's, and this holds Kinu's copy to it.
 *
 * THE DEFECT. Every hosted workspace's snapshot threw `no such column:
 * actor_id` (2026-09-11): Kinu had put an actor column on `assistant_messages`
 * and read it in ten places, while `agents`' `AgentSessionProvider` creates
 * and writes that table with no such column. Every suite built the table from
 * Kinu's copy, so nothing red ever ran over the shape production has.
 *
 * WHAT IS COMPARED. Not text: two in-memory databases, one built from the
 * installed provider's own `ensureTable` statement and one from
 * `SDK_SESSION_DDL`, compared column by column as SQLite sees them. A
 * column Kinu adds, or a column a future SDK adds, fails here before any
 * reader names it — and every Kinu suite that seeds the table does so from
 * `SDK_SESSION_DDL`, so the reads are exercised over the vendor's shape.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as v from 'valibot';
import { SDK_SESSION_DDL } from '../../core/tests/helpers';

const ColumnSchema = v.object({
  name: v.string(), type: v.string(), notnull: v.number(), dflt_value: v.nullable(v.string()), pk: v.number(),
});

function columnsOf(ddl: string): readonly v.InferOutput<typeof ColumnSchema>[] {
  const db = new Database(':memory:');

  db.run(ddl);
  const rows = v.parse(v.array(ColumnSchema), db.query('PRAGMA table_info(assistant_messages)').all());

  db.close();

  return rows;
}

/** The DO provider's own statement, out of the installed package: the class
 *  body from `var AgentSessionProvider = class` to the next class, then its one
 *  `CREATE TABLE`. The Postgres provider in the same file carries a different
 *  shape (`text_content`) and must not be read by mistake. */
function installedProviderDdl(): string {
  const source = readFileSync(fileURLToPath(import.meta.resolve('agents/experimental/memory/session')), 'utf8');
  const start = source.indexOf('var AgentSessionProvider = class');

  if (start < 0) throw new Error('the installed `agents` no longer declares AgentSessionProvider where this pin reads it');
  const body = source.slice(start, source.indexOf(' = class', start + 32));
  const ddl = /CREATE TABLE IF NOT EXISTS assistant_messages \([^)]*\)/.exec(body)?.[0];

  if (ddl === undefined) throw new Error('AgentSessionProvider.ensureTable no longer creates assistant_messages in one statement');

  return ddl;
}

describe('the pane store is the vendor\'s shape', () => {
  test('SDK_SESSION_DDL builds the same columns as the installed AgentSessionProvider', () => {
    expect(columnsOf(SDK_SESSION_DDL)).toEqual(columnsOf(installedProviderDdl()));
  });

  test('the vendor keeps no actor column, so no Kinu read may name one', () => {
    expect(columnsOf(installedProviderDdl()).map((column) => column.name)).not.toContain('actor_id');
  });
});
