/**
 * Unit tests: EMA scoring + time decay + the shared injection filter.
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { emaUpdate, effectiveScore, filterByEffectiveScore } from '../src/craft/ema.js';
import { initCraftScoreTables } from '../src/craft/schemas.js';
import { makeSql, makeExecRaw } from './helpers.js';

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
    initCraftScoreTables(makeExecRaw(db));
    return { db, sql: makeSql(db) };
  }
  const tools = [{ name: 'good' }, { name: 'stale' }, { name: 'unscored' }];

  test('drops below-threshold tools, keeps healthy + unscored ones', () => {
    const { sql } = setup();
    const now = Date.now();
    void sql`INSERT INTO craft_scores (tool_name, score, uses, last_used_at) VALUES ('good', 0.8, 5, ${now})`;
    void sql`INSERT INTO craft_scores (tool_name, score, uses, last_used_at) VALUES ('stale', 0.05, 5, ${now})`;
    const kept = filterByEffectiveScore(sql, tools, 0.2, now);
    expect(kept.map((t) => t.name)).toEqual(['good', 'unscored']);
  });

  test('time decay retires a once-good tool', () => {
    const { sql } = setup();
    const now = Date.now();
    const ninetyDaysAgo = now - 90 * 86_400_000; // 3 half-lives → 0.8 → 0.1
    void sql`INSERT INTO craft_scores (tool_name, score, uses, last_used_at) VALUES ('good', 0.8, 5, ${ninetyDaysAgo})`;
    const kept = filterByEffectiveScore(sql, [{ name: 'good' }], 0.2, now);
    expect(kept).toEqual([]);
  });

  test('missing craft_scores table → everything passes', () => {
    const db = new Database(':memory:');
    const kept = filterByEffectiveScore(makeSql(db), tools);
    expect(kept.map((t) => t.name)).toEqual(['good', 'stale', 'unscored']);
  });
});
