/**
 * EMA scoring + time decay for crafted tools.
 *
 * Quality lives ON the crafted_tools row (score, uses, last_used_at) — one
 * row per tool, written by the same statements that create and retire it, so
 * a tool can never exist without its quality state or outlive it.
 *
 * Architecture reference: docs/EVOLUTION.md — "CraftStore Lifecycle"
 * Formal spec: Evolution/FullCraftLifecycle.lean — ema_bounded, ema_nonneg
 * (over a scaled-integer model of the EMA update)
 */

import type { SqlExecutor } from '../types/primitives';
import { DEFAULT_CONFIG } from '../config';
import { nowMs } from '../utils/date';

const MS_PER_DAY = 86_400_000;

/** Exponential moving average update */
export function emaUpdate(
  oldScore: number,
  newObs: number,
  alpha = DEFAULT_CONFIG.craftStore.emaAlpha,
): number {
  return (1 - alpha) * oldScore + alpha * newObs;
}

/**
 * Time-decayed effective score. Unused tools decay toward 0.
 * After halfLifeDays: score * 0.5. After 2*halfLifeDays: score * 0.25.
 *
 * A tool never used carries last_used_at = 0 (the column default). There is
 * no usage clock to decay against, so it passes at its stored score — the
 * same chance a brand-new tool had when it simply had no row yet.
 */
export function effectiveScore(
  score: number,
  lastUsedAtMs: number,
  now = nowMs(),
  halfLifeDays = DEFAULT_CONFIG.craftStore.halfLifeDays,
): number {
  if (lastUsedAtMs <= 0) return score;
  const daysSince = (now - lastUsedAtMs) / MS_PER_DAY;
  return score * Math.pow(0.5, daysSince / halfLifeDays);
}

/**
 * The ONE injection policy for crafted tools: drop tools whose time-decayed
 * effective score fell below the threshold. Every tool is born scored at the
 * neutral prior (the crafted_tools column defaults), so "unscored" no longer
 * exists and nothing passes by accident of a missing row.
 *
 * Used by both injection paths — core's buildCraftedToolSetFromExecute and
 * the CF execute_tools sandbox — so the filter cannot drift between them.
 */
export function filterByEffectiveScore<T extends { name: string }>(
  sql: SqlExecutor,
  tools: readonly T[],
  minScore: number = DEFAULT_CONFIG.craftStore.minEffectiveScoreForInjection,
  now: number = nowMs(),
): T[] {
  const rows = sql<{ name: string; score: number; last_used_at: number }>`
    SELECT name, score, last_used_at FROM crafted_tools`;
  const scores = new Map(rows.map((r) => [r.name, r]));
  return tools.filter((t) => {
    const s = scores.get(t.name);
    return !s || effectiveScore(s.score, s.last_used_at, now) >= minScore;
  });
}

/** Record one execution-grounded observation against each named tool — ONE
 *  UPDATE per tool on the row the tool already occupies, so an observation can
 *  never strand a score beside a retired tool or resurrect a deleted one. */
export function updateCraftScores(
  sql: SqlExecutor,
  usedToolNames: readonly string[],
  outcome: number,
  alpha = DEFAULT_CONFIG.craftStore.emaAlpha,
): void {
  const now = nowMs();
  for (const name of usedToolNames) {
    const existing = sql<{ score: number }>`
      SELECT score FROM crafted_tools WHERE name = ${name}
    `[0];
    if (!existing) continue;
    const newScore = emaUpdate(existing.score, outcome, alpha);
    void sql`UPDATE crafted_tools
        SET score = ${newScore}, uses = uses + 1, last_used_at = ${now}
        WHERE name = ${name}`;
  }
}
