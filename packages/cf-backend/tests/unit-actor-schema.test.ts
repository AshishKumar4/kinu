import { describe, expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import type { SqlExecutor, SqlValue, SqlExec } from '@proteus/core';
import { ensureActorSchema } from '../src/actor-schema.js';

function toBinding(value: unknown): SQLQueryBindings {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Uint8Array || value === null
    || typeof value === 'string' || typeof value === 'number'
    || typeof value === 'bigint' || typeof value === 'boolean') return value;
  throw new TypeError(`Unsupported SQLite binding: ${typeof value}`);
}

function createSql(db: Database): {
  storage: SqlExec;
  tagged: SqlExecutor;
} {
  const storage: SqlExec = {
    exec(query, ...bindings) {
      const statement = db.prepare(query);
      const sqlBindings = bindings.map(toBinding);
      const rows = /^\s*(SELECT|WITH|PRAGMA)/i.test(query)
        ? statement.all(...sqlBindings) as Array<Record<string, unknown>>
        : (statement.run(...sqlBindings), []);
      return { toArray: () => rows };
    },
  };
  const tagged = function <T = unknown>(
    strings: TemplateStringsArray,
    ...values: SqlValue[]
  ): T[] {
    const query = strings.reduce(
      (text, part, index) => text + part + (index < values.length ? '?' : ''),
      '',
    );
    const statement = db.prepare(query);
    const sqlBindings = values.map(toBinding);
    if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) {
      return statement.all(...sqlBindings) as T[];
    }
    statement.run(...sqlBindings);
    return [];
  } as SqlExecutor;
  return { storage, tagged };
}

describe('ensureActorSchema', () => {
  test('creates the full-loop actor substrate without workspace-only tables', () => {
    const db = new Database(':memory:');
    const { storage, tagged } = createSql(db);

    ensureActorSchema(storage, tagged);

    const names = db.query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type = 'table'`,
    ).all().map((row) => row.name);
    expect(names).toContain('agent_log');
    expect(names).toContain('background_jobs');
    expect(names).toContain('compaction_state');
    expect(names).toContain('agent_config');
    expect(names).not.toContain('workspace_identity');
    expect(names).not.toContain('fork_lineage');
  });
});
