// Reading back the agent's own running commentary.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initAllTables, readActivityLog } from '../src/index.js';
import { makeSql, makeExecRaw } from './helpers.js';

function setup() {
  const db = new Database(':memory:');
  initAllTables(makeExecRaw(db));
  const sql = makeSql(db);
  const write = (event: string, detail: string | null, createdAt: number): void => {
    sql`INSERT INTO activity_log (event, detail, elapsed_ms, created_at)
        VALUES (${event}, ${detail}, ${0}, ${createdAt})`;
  };
  return { sql, write };
}

describe('readActivityLog', () => {
  test('returns the newest entries, oldest first', () => {
    const { sql, write } = setup();
    write('first', 'a', 1000);
    write('second', 'b', 2000);
    write('third', 'c', 3000);
    expect(readActivityLog(sql, 10).map((e) => e.event)).toEqual(['first', 'second', 'third']);
  });

  test('the limit keeps the newest entries, not the first ones written', () => {
    const { sql, write } = setup();
    for (let i = 0; i < 10; i++) write(`e${i}`, null, 1000 + i);
    expect(readActivityLog(sql, 3).map((e) => e.event)).toEqual(['e7', 'e8', 'e9']);
  });

  test('a null detail stays null rather than becoming an empty string', () => {
    const { sql, write } = setup();
    write('bare', null, 1000);
    expect(readActivityLog(sql, 1)[0]).toMatchObject({ event: 'bare', detail: null, elapsedMs: 0 });
  });

  test('an empty log reads empty', () => {
    const { sql } = setup();
    expect(readActivityLog(sql, 10)).toEqual([]);
  });
});
