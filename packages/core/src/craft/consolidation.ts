/**
 * Formal spec: Evolution/FullCraftLifecycle.lean — consolidation_never_empties,
 * consolidation_nonincreasing, below_threshold_filtered
 */

import type { AgentRuntime } from '../types/agent-runtime';
import { craftPreferences, unchosen } from './preference';
import { isoDate, nowMs } from '../utils/date';
import { appendMemoryNote } from '../memory/note';

/** Retires each tool offered often that no turn chose lately, never the whole store, and says so in memory. */
export async function periodicCraftConsolidation(rt: AgentRuntime): Promise<void> {
  const allTools = rt.craftStore.list();

  if (allTools.length === 0) return;

  const now = nowMs();
  const rows = craftPreferences(rt.storage.sql);

  const toRetire = allTools.flatMap((tool) => {
    const row = rows.get(tool.name);

    return row !== undefined && unchosen(row, now) ? [tool.name] : [];
  });

  // Never empty the store. Formal spec: Evolution/FullCraftLifecycle.lean:consolidation_never_empties
  if (toRetire.length === 0 || toRetire.length >= allTools.length) return;

  for (const name of toRetire) {
    rt.craftStore.delete(name);
  }

  await appendMemoryNote(rt.memory, `Retired ${String(toRetire.length)} tools no turn chose lately: ${toRetire.join(', ')}`, {
    heading: 'CraftStore consolidation', date: isoDate(),
  });
}
