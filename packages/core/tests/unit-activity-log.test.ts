// Reading back the agent's own running commentary.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initAllTables, readActivityLog } from '../src/index';
import { makeSql, makeExecRaw } from './helpers';
import { createTestActors } from '@kinu.run/test-utils';

function setup() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  initAllTables(execRaw, sql);
  // `activity_log` is keyed `(actor_id, id)`: the commentary is the running
  // account of ONE actor's turn, and the writer and the reader below have to
  // name the same handle or the read comes back empty.
  const actor = createTestActors(sql, execRaw).main;
  const write = (event: string, detail: string | null, createdAt: number): void => {
    void sql`INSERT INTO activity_log (actor_id, event, detail, elapsed_ms, created_at)
        VALUES (${actor.actorId}, ${event}, ${detail}, ${0}, ${createdAt})`;
  };
  return { sql, actor, write };
}

describe('readActivityLog', () => {
  test('returns the newest entries, oldest first', () => {
    const { sql, actor, write } = setup();
    write('first', 'a', 1000);
    write('second', 'b', 2000);
    write('third', 'c', 3000);
    expect(readActivityLog(sql, actor, 10).map((e) => e.event)).toEqual(['first', 'second', 'third']);
  });

  test('the limit keeps the newest entries, not the first ones written', () => {
    const { sql, actor, write } = setup();
    for (let i = 0; i < 10; i++) write(`e${i}`, null, 1000 + i);
    expect(readActivityLog(sql, actor, 3).map((e) => e.event)).toEqual(['e7', 'e8', 'e9']);
  });

  test('a null detail stays null rather than becoming an empty string', () => {
    const { sql, actor, write } = setup();
    write('bare', null, 1000);
    expect(readActivityLog(sql, actor, 1)[0]).toMatchObject({ event: 'bare', detail: null, elapsedMs: 0 });
  });

  test('an empty log reads empty', () => {
    const { sql, actor } = setup();
    expect(readActivityLog(sql, actor, 10)).toEqual([]);
  });
});
