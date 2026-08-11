/**
 * Periodic CraftStore consolidation — retire stale tools.
 *
 * Architecture reference: docs/EVOLUTION.md — "CraftStore Lifecycle"
 * Formal spec: Evolution/FullCraftLifecycle.lean — consolidation_never_empties,
 * consolidation_nonincreasing, below_threshold_filtered
 *
 * BUG-2 FIX: The arch doc claims "consolidation cannot decrease mean effective score"
 * but this is ONLY true when the remaining list is non-empty. If ALL tools are stale,
 * consolidation empties the list and mean drops to 0. We add the non-empty guard.
 */

import type { AgentRuntime } from '../types/agent-runtime.js';
import type { CraftScoreEntry } from '../types/craft.js';
import { effectiveScore } from './ema.js';
import { isoDate, nowMs } from '../utils/date.js';
import { DEFAULT_CONFIG } from '../config.js';

const RETIREMENT_THRESHOLD = DEFAULT_CONFIG.craftStore.retirementThreshold;
const MIN_USES_BEFORE_RETIREMENT = DEFAULT_CONFIG.craftStore.minUsesBeforeRetirement;

/**
 * Consolidate the CraftStore: retire tools with low effective scores.
 *
 * BUG-2 GUARD: Check that not ALL tools are below threshold before retiring.
 * If all tools would be retired, skip consolidation (better to keep low-quality
 * tools than to have an empty toolbox).
 */
export async function periodicCraftConsolidation(rt: AgentRuntime): Promise<void> {
  const allTools = rt.craftStore.list();
  if (allTools.length === 0) return;

  const now = nowMs();

  const scores = rt.storage.sql<CraftScoreEntry>`
    SELECT * FROM craft_scores
  `;
  const scoreMap = new Map(scores.map(s => [s.tool_name, s]));

  const toRetire: string[] = [];
  for (const tool of allTools) {
    const scoreEntry = scoreMap.get(tool.name);
    if (!scoreEntry) continue;
    if (scoreEntry.uses < MIN_USES_BEFORE_RETIREMENT) continue;

    const effective = effectiveScore(scoreEntry.score, scoreEntry.last_used_at, now);
    if (effective < RETIREMENT_THRESHOLD) {
      toRetire.push(tool.name);
    }
  }

  // BUG-2 GUARD: don't retire ALL tools — that would empty the CraftStore
  // Formal spec: Evolution/FullCraftLifecycle.lean:consolidation_never_empties
  if (toRetire.length >= allTools.length) {
    // All tools are stale — skip consolidation, keep what we have
    return;
  }

  if (toRetire.length === 0) return;

  for (const name of toRetire) {
    rt.craftStore.delete(name);
    rt.storage.sql`DELETE FROM craft_scores WHERE tool_name = ${name}`;
  }

  await rt.memory.append(
    'memory/MEMORY.md',
    `\n### CraftStore consolidation (${isoDate()}): retired ${toRetire.length} stale tools: ${toRetire.join(', ')}\n`,
  );
  await rt.memory.index('memory/MEMORY.md');
}
