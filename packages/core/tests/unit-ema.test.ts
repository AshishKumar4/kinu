/**
 * Unit tests: EMA scoring + time decay + the shared injection filter.
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { emaUpdate, effectiveScore, filterByEffectiveScore } from '../src/craft/ema';
import { initCraftedToolsTables } from '@kinu.run/agent-utils/stores';
import { makeSql } from './helpers';

describe('EMA scoring', () => {
  test('emaUpdate with alpha=0.3', () => {
    expect(emaUpdate(0.5, 0.8)).toBeCloseTo(0.59, 2); // 0.7*0.5 + 0.3*0.8 = 0.59
  });

  test('emaUpdate preserves [0,1] range for inputs in [0,1]', () => {
    for (let old = 0; old <= 1; old += 0.25) {
      for (let obs = 0; obs <= 1; obs += 0.25) {
        const result = emaUpdate(old, obs);
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThanOrEqual(1);
      }
    }
  });

  test('emaUpdate contracts toward new observation', () => {
    const old = 0.2;
    const obs = 0.9;
    const result = emaUpdate(old, obs);
    // Result should be between old and obs
    expect(result).toBeGreaterThan(old);
    expect(result).toBeLessThan(obs);
  });
});

describe('Time decay', () => {
  test('zero days → full score', () => {
    const now = Date.now();
    expect(effectiveScore(0.8, now, now)).toBeCloseTo(0.8, 5);
  });

  test('30 days → half score (half-life)', () => {
    const now = Date.now();
    const thirtyDaysAgo = now - 30 * 86_400_000;
    expect(effectiveScore(0.8, thirtyDaysAgo, now)).toBeCloseTo(0.4, 1);
  });

  test('60 days → quarter score', () => {
    const now = Date.now();
    const sixtyDaysAgo = now - 60 * 86_400_000;
    expect(effectiveScore(0.8, sixtyDaysAgo, now)).toBeCloseTo(0.2, 1);
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
