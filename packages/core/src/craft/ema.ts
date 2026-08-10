/**
 * EMA scoring + time decay for CraftStore tools.
 *
 * Architecture reference: docs/EVOLUTION.md — "CraftStore Lifecycle"
 * Formal spec: Evolution/FullCraftLifecycle.lean — ema_bounded, ema_nonneg
 * (over a scaled-integer model of the EMA update)
 */

import type { SqlExecutor } from '../types/primitives.js';
import { DEFAULT_CONFIG } from '../config.js';
import { nowMs } from '../utils/date.js';

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
 */
export function effectiveScore(
  score: number,
  lastUsedAtMs: number,
  now = nowMs(),
  halfLifeDays = DEFAULT_CONFIG.craftStore.halfLifeDays,
): number {
  const daysSince = (now - lastUsedAtMs) / MS_PER_DAY;
  return score * Math.pow(0.5, daysSince / halfLifeDays);
}

/**
 * The ONE injection policy for crafted tools: drop tools whose time-decayed
 * effective score fell below the threshold. Unscored tools (no craft_scores
 * row yet) pass — a new tool must get the chance to earn a score. A missing
 * craft_scores table means nothing is scored yet, so everything passes.
 *
 * Used by both injection paths — core's buildCraftedToolSetFromExecute and
 * the CF PreambleCraftedExecutor — so the filter cannot drift between them.
 */
export function filterByEffectiveScore<T extends { name: string }>(
  sql: SqlExecutor,
  tools: readonly T[],
  minScore: number = DEFAULT_CONFIG.craftStore.minEffectiveScoreForInjection,
  now: number = nowMs(),
): T[] {
  let rows: Array<{ tool_name: string; score: number; last_used_at: number }>;
  try {
    rows = sql<{ tool_name: string; score: number; last_used_at: number }>`
      SELECT tool_name, score, last_used_at FROM craft_scores`;
  } catch {
    return [...tools];
  }
  const scores = new Map(rows.map((r) => [r.tool_name, r]));
  return tools.filter((t) => {
    const s = scores.get(t.name);
    return !s || effectiveScore(s.score, s.last_used_at, now) >= minScore;
  });
}

/** Update EMA score for tools used in a successful branch */
export function updateCraftScores(
  sql: SqlExecutor,
  usedToolNames: string[],
  outcome: number,
  alpha = DEFAULT_CONFIG.craftStore.emaAlpha,
): void {
  const now = nowMs();
  for (const name of usedToolNames) {
    const existing = sql<{ score: number; uses: number }>`
      SELECT score, uses FROM craft_scores WHERE tool_name = ${name}
    `[0];

    if (!existing) {
      sql`INSERT INTO craft_scores (tool_name, score, uses, last_used_at)
          VALUES (${name}, ${outcome}, 1, ${now})`;
    } else {
      const newScore = emaUpdate(existing.score, outcome, alpha);
      sql`UPDATE craft_scores
          SET score = ${newScore}, uses = uses + 1, last_used_at = ${now}
          WHERE tool_name = ${name}`;
    }
  }
}
