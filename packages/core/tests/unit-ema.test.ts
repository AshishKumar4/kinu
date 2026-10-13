/** EMA scoring, time decay and the shared injection filter. */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { effectiveScore, filterByEffectiveScore, updateCraftScores } from '../src/craft/ema';
import { initCraftedToolsTables } from '@kinu.run/agent-utils/stores';
import { makeSql } from './helpers';

describe('EMA scoring', () => {
  test('a use moves a tool\'s score alpha of the way to the outcome, and leaves an unstored tool unstored', () => {
    const db = new Database(':memory:');
    const sql = makeSql(db);
    initCraftedToolsTables(sql);
    void sql`INSERT INTO crafted_tools (name, code, score, uses, last_used_at) VALUES ('used', '', 0.2, 1, 0)`;

    updateCraftScores(sql, ['used', 'deleted'], 0.9, 0.3);

    const rows = sql<{ name: string; score: number; uses: number }>`SELECT name, score, uses FROM crafted_tools`;
    expect(rows.map(({ name, uses }) => ({ name, uses }))).toEqual([{ name: 'used', uses: 2 }]);
    // 0.7 of the old score and 0.3 of the outcome: 0.14 + 0.27.
    expect(rows[0]?.score).toBeCloseTo(0.41, 10);
  });
});

describe('Time decay', () => {
  test('zero days → full score', () => {
    const now = Date.now();
    expect(effectiveScore(0.8, now, now)).toBeCloseTo(0.8, 5);
  });

  test('score=0 stays 0 regardless of time', () => {
    expect(effectiveScore(0, 0, Date.now())).toBe(0);
  });
});

describe('filterByEffectiveScore — the one injection policy', () => {
  function setup() {
    const db = new Database(':memory:');
    initCraftedToolsTables(makeSql(db));

    return { db, sql: makeSql(db) };
  }

  const tools = [{ name: 'good' }, { name: 'stale' }, { name: 'unstored' }];

  const seedTool = (sql: ReturnType<typeof makeSql>, name: string, score: number, at: number): void => {
    // The quality columns live ON the tool row a real creation writes.
    void sql`INSERT INTO crafted_tools (name, code, score, uses, last_used_at)
        VALUES (${name}, '', ${score}, 1, ${at})`;
  };

  test('drops below-threshold tools, keeps healthy + unstored ones', () => {
    const { sql } = setup();
    const now = Date.now();
    seedTool(sql, 'good', 0.8, now);
    seedTool(sql, 'stale', 0.05, now);
    const kept = filterByEffectiveScore(sql, tools, 0.2, now);
    expect(kept.map((t) => t.name)).toEqual(['good', 'unstored']);
  });

  test('time decay retires a once-good tool', () => {
    const { sql } = setup();
    const now = Date.now();
    const ninetyDaysAgo = now - 90 * 86_400_000; // 3 half-lives → 0.8 → 0.1
    seedTool(sql, 'good', 0.8, ninetyDaysAgo);
    const kept = filterByEffectiveScore(sql, [{ name: 'good' }], 0.2, now);
    expect(kept).toEqual([]);
  });

  test('missing crafted_tools table is a fault, not an empty toolbox', () => {
    const db = new Database(':memory:');
    expect(() => filterByEffectiveScore(makeSql(db), tools)).toThrow('no such table: crafted_tools');
  });
});
