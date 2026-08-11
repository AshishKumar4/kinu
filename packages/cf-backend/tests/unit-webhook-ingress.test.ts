import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readWebhookBodyText } from '../src/events/body.js';
import {
  initWebhookRateLimitTables,
  normalizeWebhookRateLimitPerMin,
  tryConsumeWebhookRateLimit,
} from '../src/events/webhook-rate-limit.js';
import type { SqlExec } from '@proteus/core';

function sqlFor(db: Database): SqlExec {
  return {
    exec(query: string, ...bindings: unknown[]) {
      const isRead = /^\s*(SELECT|WITH|PRAGMA)/i.test(query);
      if (isRead) {
        const rows = db.query(query).all(...bindings) as Array<Record<string, unknown>>;
        return { toArray: () => rows };
      }
      db.query(query).run(...bindings);
      return { toArray: () => [] };
    },
  };
}

describe('webhook body handling', () => {
  test('reads the exact body without app-level truncation or sentinels', async () => {
    const body = 'x'.repeat(1024 * 1024 + 17);
    const request = new Request('https://example.test/hook', { method: 'POST', body });

    expect(await readWebhookBodyText(request)).toBe(body);
  });
});

describe('webhook rate limits', () => {
  test('normalizes configured limits', () => {
    expect(normalizeWebhookRateLimitPerMin(undefined)).toBe(60);
    expect(normalizeWebhookRateLimitPerMin(1)).toBe(1);
    expect(normalizeWebhookRateLimitPerMin('42')).toBe(42);
    expect(() => normalizeWebhookRateLimitPerMin(0)).toThrow(/rate_limit_per_min/);
    expect(() => normalizeWebhookRateLimitPerMin(1.5)).toThrow(/rate_limit_per_min/);
    expect(() => normalizeWebhookRateLimitPerMin(10_001)).toThrow(/rate_limit_per_min/);
  });

  test('admits only the configured number of verified deliveries per trigger per minute', () => {
    const db = new Database(':memory:');
    const sql = sqlFor(db);
    initWebhookRateLimitTables(sql);

    expect(tryConsumeWebhookRateLimit(sql, 'trg-a', 2, 10_000)).toMatchObject({ allowed: true, remaining: 1 });
    expect(tryConsumeWebhookRateLimit(sql, 'trg-a', 2, 20_000)).toMatchObject({ allowed: true, remaining: 0 });
    expect(tryConsumeWebhookRateLimit(sql, 'trg-a', 2, 30_000)).toMatchObject({ allowed: false, remaining: 0 });

    expect(tryConsumeWebhookRateLimit(sql, 'trg-b', 2, 30_000)).toMatchObject({ allowed: true, remaining: 1 });
    expect(tryConsumeWebhookRateLimit(sql, 'trg-a', 2, 61_000)).toMatchObject({ allowed: true, remaining: 1 });
  });
});
