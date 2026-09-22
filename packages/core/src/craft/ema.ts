/**
 * Quality lives on the crafted_tools row, so a tool never exists without its score.
 * Formal spec: Evolution/FullCraftLifecycle.lean — ema_bounded, ema_nonneg
 * (over a scaled-integer model of the EMA update)
 */

import type { SqlExecutor } from '../types/primitives';
import { DEFAULT_CONFIG } from '../config';
import { nowMs } from '../utils/date';

const MS_PER_DAY = 86_400_000;

export function emaUpdate(
  oldScore: number,
  newObs: number,
  alpha = DEFAULT_CONFIG.craftStore.emaAlpha,
): number {
  return (1 - alpha) * oldScore + alpha * newObs;
}

/** Half-life decay; a never-used tool (last_used_at = 0) keeps its stored score. */
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

/** The single injection policy, shared by core and the CF eval sandbox so they cannot drift. */
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

/** Updates only existing rows, so an observation never resurrects a deleted tool. */
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
