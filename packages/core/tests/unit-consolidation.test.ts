/**
 * Unit tests: CraftStore consolidation + BUG-2 non-empty guard.
 * Formal spec: CraftStore.lean — all_below_gives_empty, consolidation_requires_nonempty_guard.
 */

import { describe, test, expect } from 'bun:test';
import { createTestRuntime } from './helpers.js';
import { periodicCraftConsolidation } from '../src/craft/consolidation.js';
import { initCraftScoreTables } from '../src/craft/schemas.js';

describe('CraftStore consolidation', () => {
  test('does nothing with empty CraftStore', async () => {
    const { rt } = createTestRuntime();
    initCraftScoreTables(rt.storage.execRaw);
    await periodicCraftConsolidation(rt);
    expect(rt.craftStore.list()).toHaveLength(0);
  });

  test('retires stale tools (low effective score, ≥2 uses)', async () => {
    const { rt } = createTestRuntime();
    initCraftScoreTables(rt.storage.execRaw);

    // Add a tool with many uses but old timestamp (120 days ago → effective ≈ 0.0625)
    rt.craftStore.create({ name: 'stale_tool', description: 'old', params: null, code: 'fn()', scope: 'local' });
    const hundredTwentyDaysAgo = Date.now() - 120 * 86_400_000;
    void rt.storage.sql`INSERT INTO craft_scores (tool_name, score, uses, last_used_at) VALUES ('stale_tool', 0.5, 5, ${hundredTwentyDaysAgo})`;

    // Add a fresh tool
    rt.craftStore.create({ name: 'fresh_tool', description: 'new', params: null, code: 'fn()', scope: 'local' });
    void rt.storage.sql`INSERT INTO craft_scores (tool_name, score, uses, last_used_at) VALUES ('fresh_tool', 0.8, 3, ${Date.now()})`;

    await periodicCraftConsolidation(rt);

    const remaining = rt.craftStore.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.name).toBe('fresh_tool');
  });

  test('BUG-2: does NOT retire all tools when all are stale', async () => {
    const { rt } = createTestRuntime();
    initCraftScoreTables(rt.storage.execRaw);

    const veryOld = Date.now() - 365 * 86_400_000;
    rt.craftStore.create({ name: 'stale1', description: 'old', params: null, code: 'fn()', scope: 'local' });
    void rt.storage.sql`INSERT INTO craft_scores (tool_name, score, uses, last_used_at) VALUES ('stale1', 0.3, 5, ${veryOld})`;
    rt.craftStore.create({ name: 'stale2', description: 'old2', params: null, code: 'fn()', scope: 'local' });
    void rt.storage.sql`INSERT INTO craft_scores (tool_name, score, uses, last_used_at) VALUES ('stale2', 0.2, 3, ${veryOld})`;

    await periodicCraftConsolidation(rt);

    // BUG-2 guard: should NOT have retired everything
    const remaining = rt.craftStore.list();
    expect(remaining.length).toBeGreaterThan(0);
    expect(remaining).toHaveLength(2); // both kept because retiring all is blocked
  });

  test('skips tools with fewer than 2 uses', async () => {
    const { rt } = createTestRuntime();
    initCraftScoreTables(rt.storage.execRaw);

    const old = Date.now() - 120 * 86_400_000;
    rt.craftStore.create({ name: 'low_use', description: 'x', params: null, code: 'fn()', scope: 'local' });
    void rt.storage.sql`INSERT INTO craft_scores (tool_name, score, uses, last_used_at) VALUES ('low_use', 0.5, 1, ${old})`;

    // Also add a high-use fresh tool to avoid BUG-2 guard
    rt.craftStore.create({ name: 'fresh', description: 'y', params: null, code: 'fn()', scope: 'local' });
    void rt.storage.sql`INSERT INTO craft_scores (tool_name, score, uses, last_used_at) VALUES ('fresh', 0.9, 10, ${Date.now()})`;

    await periodicCraftConsolidation(rt);

    // low_use should NOT be retired (only 1 use < 2 minimum)
    expect(rt.craftStore.get('low_use')).toBeDefined();
  });
});
