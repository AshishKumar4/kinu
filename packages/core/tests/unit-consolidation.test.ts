/**
 * Unit tests: CraftStore consolidation + BUG-2 non-empty guard.
 * Formal spec: Evolution/FullCraftLifecycle.lean — consolidation_never_empties,
 * consolidation_nonincreasing, below_threshold_filtered.
 */

import { describe, test, expect } from 'bun:test';
import { createTestRuntime } from './helpers';
import { periodicCraftConsolidation } from '../src/craft/consolidation';
import { initCraftedToolsTables } from '@kinu.run/agent-utils/stores';
import { MEMORY_PATH, parseMemoryNotes } from '../src/memory/note';

describe('CraftStore consolidation', () => {
  test('does nothing with empty CraftStore', async () => {
    const { rt } = createTestRuntime();
    initCraftedToolsTables(rt.storage.sql);
    await periodicCraftConsolidation(rt);
    expect(rt.craftStore.list()).toHaveLength(0);
  });

  test('retires a tool offered 50 turns that no turn chose in 30 days, and says so in memory', async () => {
    const { rt } = createTestRuntime();
    initCraftedToolsTables(rt.storage.sql);
    const monthAgo = Date.now() - 31 * 86_400_000;

    rt.craftStore.create({ name: 'unchosen', description: 'old', code: 'fn()' });
    void rt.storage.sql`UPDATE crafted_tools SET offered = 50, chosen = 2, last_used_at = ${monthAgo} WHERE name = 'unchosen'`;
    rt.craftStore.create({ name: 'chosen_lately', description: 'new', code: 'fn()' });
    void rt.storage.sql`UPDATE crafted_tools SET offered = 80, chosen = 3, last_used_at = ${Date.now()} WHERE name = 'chosen_lately'`;

    await periodicCraftConsolidation(rt);

    expect(rt.craftStore.list().map((tool) => tool.name)).toEqual(['chosen_lately']);
    // core-rest review P1-2: the record was all heading and no body, so the memory reader dropped it.
    expect(parseMemoryNotes(await rt.memory.read(MEMORY_PATH) ?? '').map((note) => note.content)).toContain('Retired 1 tools no turn chose lately: unchosen');
  });

  test('BUG-2: does NOT retire all tools when all are stale', async () => {
    const { rt } = createTestRuntime();
    initCraftedToolsTables(rt.storage.sql);

    for (const name of ['stale1', 'stale2']) {
      rt.craftStore.create({ name, description: name, code: 'fn()' });
      void rt.storage.sql`UPDATE crafted_tools SET offered = 60 WHERE name = ${name}`;
    }

    await periodicCraftConsolidation(rt);

    expect(rt.craftStore.list()).toHaveLength(2);
  });

  test('a tool offered fewer than 50 turns stays, however long it waits', async () => {
    const { rt } = createTestRuntime();
    initCraftedToolsTables(rt.storage.sql);

    rt.craftStore.create({ name: 'new_tool', description: 'x', code: 'fn()' });
    void rt.storage.sql`UPDATE crafted_tools SET offered = 49 WHERE name = 'new_tool'`;
    rt.craftStore.create({ name: 'fresh', description: 'y', code: 'fn()' });

    await periodicCraftConsolidation(rt);

    expect(rt.craftStore.list().map((tool) => tool.name).sort()).toEqual(['fresh', 'new_tool']);
  });
});
