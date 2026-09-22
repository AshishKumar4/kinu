/**
 * Unit tests: CraftStore consolidation + BUG-2 non-empty guard.
 * Formal spec: Evolution/FullCraftLifecycle.lean — consolidation_never_empties,
 * consolidation_nonincreasing, below_threshold_filtered.
 */

import { describe, test, expect } from 'bun:test';
import { createTestRuntime } from './helpers';
import { periodicCraftConsolidation } from '../src/craft/consolidation';
import { initCraftedToolsTables } from '@kinu.run/agent-utils/stores';

describe('CraftStore consolidation', () => {
  test('does nothing with empty CraftStore', async () => {
    const { rt } = createTestRuntime();
    initCraftedToolsTables(rt.storage.sql);
    await periodicCraftConsolidation(rt);
    expect(rt.craftStore.list()).toHaveLength(0);
  });

  test('retires stale tools (low effective score, ≥2 uses)', async () => {
    const { rt } = createTestRuntime();
    initCraftedToolsTables(rt.storage.sql);

    // 120 days old → effective ≈ 0.0625
    rt.craftStore.create({ name: 'stale_tool', description: 'old', params: null, code: 'fn()', scope: 'local' });
    const hundredTwentyDaysAgo = Date.now() - 120 * 86_400_000;
        void rt.storage.sql`UPDATE crafted_tools SET score = 0.5, uses = 5, last_used_at = ${hundredTwentyDaysAgo} WHERE name = 'stale_tool'`;

    rt.craftStore.create({ name: 'fresh_tool', description: 'new', params: null, code: 'fn()', scope: 'local' });
        void rt.storage.sql`UPDATE crafted_tools SET score = 0.8, uses = 3, last_used_at = ${Date.now()} WHERE name = 'fresh_tool'`;

    await periodicCraftConsolidation(rt);

    const remaining = rt.craftStore.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].name).toBe('fresh_tool');
  });

  test('BUG-2: does NOT retire all tools when all are stale', async () => {
    const { rt } = createTestRuntime();
    initCraftedToolsTables(rt.storage.sql);

    const veryOld = Date.now() - 365 * 86_400_000;
    rt.craftStore.create({ name: 'stale1', description: 'old', params: null, code: 'fn()', scope: 'local' });
        void rt.storage.sql`UPDATE crafted_tools SET score = 0.3, uses = 5, last_used_at = ${veryOld} WHERE name = 'stale1'`;
    rt.craftStore.create({ name: 'stale2', description: 'old2', params: null, code: 'fn()', scope: 'local' });
        void rt.storage.sql`UPDATE crafted_tools SET score = 0.2, uses = 3, last_used_at = ${veryOld} WHERE name = 'stale2'`;

    await periodicCraftConsolidation(rt);

    const remaining = rt.craftStore.list();
    expect(remaining.length).toBeGreaterThan(0);
    expect(remaining).toHaveLength(2);
  });

  test('skips tools with fewer than 2 uses', async () => {
    const { rt } = createTestRuntime();
    initCraftedToolsTables(rt.storage.sql);

    const old = Date.now() - 120 * 86_400_000;
    rt.craftStore.create({ name: 'low_use', description: 'x', params: null, code: 'fn()', scope: 'local' });
        void rt.storage.sql`UPDATE crafted_tools SET score = 0.5, uses = 1, last_used_at = ${old} WHERE name = 'low_use'`;

    rt.craftStore.create({ name: 'fresh', description: 'y', params: null, code: 'fn()', scope: 'local' });
        void rt.storage.sql`UPDATE crafted_tools SET score = 0.9, uses = 10, last_used_at = ${Date.now()} WHERE name = 'fresh'`;

    await periodicCraftConsolidation(rt);

    // 1 use is below the 2-use minimum
    expect(rt.craftStore.list().map((tool) => tool.name).sort()).toEqual(['fresh', 'low_use']);
  });
});
