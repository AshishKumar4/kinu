import { describe, expect, test } from 'bun:test';
import { inspectBackfillCalls } from './schema-drift';

describe('schema-drift TypeScript call discovery', () => {
  test('reads multiline callbacks, trailing commas, named objects and object spreads by AST', () => {
    const inspected = inspectBackfillCalls(new Map([['fixture.ts', `
      const SHARED = { first: 'TEXT' } as const;
      reconcileColumns(
        sql,
        (ddl) => { exec(ddl); },
        'alpha',
        { ...SHARED, second: 'INTEGER' },
      );
      reconcileSqlExecColumns(sql, 'beta', {
        third: 'TEXT',
      });
      ensureColumn(sql, 'gamma', 'fourth');
    `]]));

    expect(inspected.reconcileCalls).toBe(2);
    expect([...inspected.named].sort()).toEqual([
      'alpha.first', 'alpha.second', 'beta.third', 'gamma.fourth',
    ]);
  });

  test('fails closed when a column object is dynamically generated', () => {
    expect(() => inspectBackfillCalls(new Map([['fixture.ts', `
      const columns = Object.fromEntries([['added', 'TEXT']]);
      reconcileColumns(sql, execRaw, 'alpha', columns);
    `]]))).toThrow(/CallExpression, not an object or named object/u);
  });

  test('counts calls, never a same-named declaration or mention', () => {
    expect(() => inspectBackfillCalls(new Map([['fixture.ts', `
      function reconcileColumns() {}
      const mention = 'reconcileColumns(';
    `]]))).toThrow(/parsed no column reconciliation calls/u);
  });
});
