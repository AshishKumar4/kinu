/**
 * Per-trigger inbound rate limiting — a fixed one-minute window counted in
 * `webhook_rate_windows`, shared by webhook deliveries (keyed by trigger id)
 * and the inbound-email gate (one synthetic key for all senders).
 */

import * as v from 'valibot';
import type { SqlExec } from '../../types/primitives';

const WINDOW_MS = 60_000;
/** Exported so `hub/triggers.ts` stores the same default this gate enforces
 *  against. It does NOT share the range: 0 means "block" to a trigger and is
 *  illegal to this gate, so the two surfaces normalise differently on purpose. */
export const DEFAULT_RATE_LIMIT_PER_MIN = 60;
const MAX_RATE_LIMIT_PER_MIN = 10_000;
const RateLimitInputSchema = v.union([v.number(), v.string(), v.null(), v.undefined()]);

export interface WebhookRateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
}

export function initWebhookRateLimitTables(sql: SqlExec): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS webhook_rate_windows (
      trigger_id     TEXT NOT NULL,
      window_start   INTEGER NOT NULL,
      delivery_count INTEGER NOT NULL DEFAULT 0,
      updated_at     INTEGER NOT NULL,
      PRIMARY KEY (trigger_id, window_start)
    )
  `);
  sql.exec(`
    CREATE INDEX IF NOT EXISTS idx_webhook_rate_windows_gc
    ON webhook_rate_windows (window_start)
  `);
}

export function normalizeWebhookRateLimitPerMin<Value>(value: Value): number {
  const parsed = v.safeParse(RateLimitInputSchema, value);
  if (!parsed.success) {
    throw new Error(`rate_limit_per_min must be an integer between 1 and ${MAX_RATE_LIMIT_PER_MIN}`);
  }
  if (parsed.output === undefined || parsed.output === null) return DEFAULT_RATE_LIMIT_PER_MIN;
  const n = Number(parsed.output);
  if (!Number.isInteger(n) || n < 1 || n > MAX_RATE_LIMIT_PER_MIN) {
    throw new Error(`rate_limit_per_min must be an integer between 1 and ${MAX_RATE_LIMIT_PER_MIN}`);
  }
  return n;
}

export function tryConsumeWebhookRateLimit(
  sql: SqlExec,
  triggerId: string,
  rateLimitPerMin: number,
  now: number,
): WebhookRateLimitDecision {
  const limit = normalizeWebhookRateLimitPerMin(rateLimitPerMin);
  const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  const resetAt = windowStart + WINDOW_MS;

  sql.exec(`DELETE FROM webhook_rate_windows WHERE trigger_id = ? AND window_start < ?`, triggerId, windowStart);

  const existing = sql.exec(
    `SELECT delivery_count FROM webhook_rate_windows WHERE trigger_id = ? AND window_start = ?`,
    triggerId, windowStart,
  ).toArray()[0];
  const count = Number(existing?.delivery_count ?? 0);
  if (count >= limit) return { allowed: false, limit, remaining: 0, resetAt };

  const nextCount = count + 1;
  if (count === 0) {
    sql.exec(
      `INSERT INTO webhook_rate_windows (trigger_id, window_start, delivery_count, updated_at)
       VALUES (?, ?, ?, ?)`,
      triggerId, windowStart, nextCount, now,
    );
  } else {
    sql.exec(
      `UPDATE webhook_rate_windows
       SET delivery_count = ?, updated_at = ?
       WHERE trigger_id = ? AND window_start = ?`,
      nextCount, now, triggerId, windowStart,
    );
  }

  return { allowed: true, limit, remaining: Math.max(0, limit - nextCount), resetAt };
}
