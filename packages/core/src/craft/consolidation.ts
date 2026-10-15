/**
 * Formal spec: Evolution/FullCraftLifecycle.lean — consolidation_never_empties,
 * consolidation_nonincreasing, below_threshold_filtered
 */

import type { AgentRuntime } from '../types/agent-runtime';
import { craftScores, effectiveScore } from './ema';
import { isoDate, nowMs } from '../utils/date';
import { appendMemoryNote } from '../memory/note';
import { DEFAULT_CONFIG } from '../config';

const RETIREMENT_THRESHOLD = DEFAULT_CONFIG.craftStore.retirementThreshold;

const MIN_USES_BEFORE_RETIREMENT = DEFAULT_CONFIG.craftStore.minUsesBeforeRetirement;

export async function periodicCraftConsolidation(rt: AgentRuntime): Promise<void> {
  const allTools = rt.craftStore.list();

  if (allTools.length === 0) return;

  const now = nowMs();

  const scoreMap = craftScores(rt.storage.sql);

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

  // Never empty the store; mean effective score is non-decreasing only while non-empty.
  // Formal spec: Evolution/FullCraftLifecycle.lean:consolidation_never_empties
  if (toRetire.length >= allTools.length) {
    return;
  }

  if (toRetire.length === 0) return;

  for (const name of toRetire) {
    rt.craftStore.delete(name);
  }

  await appendMemoryNote(rt.memory, `Retired ${String(toRetire.length)} stale tools: ${toRetire.join(', ')}`, {
    heading: 'CraftStore consolidation', date: isoDate(),
  });
}
