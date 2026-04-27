/**
 * Phase F evidence: one-time migration that merges case-collision duplicates
 * in crafted_tools + craft_scores, keeps highest-scored entry, sums uses.
 */

import { describe, test, expect } from 'bun:test';
import { createTestRuntime } from './helpers.js';
import { migrateCraftedToolDuplicates, initCraftScoreTables } from '../src/index.js';

describe('Phase F — crafted_tools duplicate migration', () => {
  test('merges case-collision duplicates keeping highest-score row', () => {
    const { rt } = createTestRuntime();
    initCraftScoreTables(rt.storage.execRaw);

    // Two case-collision rows for the same logical tool
    rt.craftStore.create({
      name: 'multiplynumbers',  // lowercased legacy entry
      description: 'legacy',
      params: null,
      code: 'async (a, b) => a * b',
      scope: 'local',
    });
    rt.craftStore.create({
      name: 'multiplyNumbers',  // camelCase current entry
      description: 'new',
      params: null,
      code: 'async (a, b) => a * b',
      scope: 'local',
    });

    // Scores — the legacy row has been used more but the new one scores higher
    rt.storage.sql`INSERT INTO craft_scores (tool_name, score, uses, last_used_at, created_at)
      VALUES ('multiplynumbers', 0.3, 20, ${Date.now() - 100000}, ${Date.now() - 200000})`;
    rt.storage.sql`INSERT INTO craft_scores (tool_name, score, uses, last_used_at, created_at)
      VALUES ('multiplyNumbers', 0.9, 5, ${Date.now()}, ${Date.now() - 50000})`;

    const r = migrateCraftedToolDuplicates(rt.storage.sql, rt.storage.execRaw);

    expect(r.ranMigration).toBe(true);
    expect(r.mergedGroups).toBe(1);
    expect(r.rowsDeletedCraftedTools).toBe(1);

    // The high-scoring camelCase row survived
    const remaining = rt.craftStore.list();
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.name).toBe('multiplyNumbers');

    // Merged craft_scores: MAX score, SUM uses, MAX last_used_at
    const scores = rt.storage.sql<{ score: number; uses: number }>`
      SELECT score, uses FROM craft_scores WHERE tool_name = 'multiplyNumbers'`;
    expect(scores.length).toBe(1);
    expect(scores[0]!.score).toBe(0.9);
    expect(scores[0]!.uses).toBe(25);  // 20 + 5

    // No orphan craft_scores rows for the dropped name
    const orphan = rt.storage.sql<{ c: number }>`
      SELECT COUNT(*) AS c FROM craft_scores WHERE LOWER(tool_name) = 'multiplynumbers'`;
    expect(orphan[0]!.c).toBe(1);  // merged row still matches under LOWER()
    const byExactName = rt.storage.sql<{ c: number }>`
      SELECT COUNT(*) AS c FROM craft_scores WHERE tool_name = 'multiplynumbers'`;
    expect(byExactName[0]!.c).toBe(0);  // lowercased name is gone
  });

  test('is idempotent — second call is a no-op', () => {
    const { rt } = createTestRuntime();
    initCraftScoreTables(rt.storage.execRaw);

    rt.craftStore.create({ name: 'FOO', description: 'a', params: null, code: 'async () => 1', scope: 'local' });
    rt.craftStore.create({ name: 'foo', description: 'b', params: null, code: 'async () => 2', scope: 'local' });

    const first = migrateCraftedToolDuplicates(rt.storage.sql, rt.storage.execRaw);
    expect(first.ranMigration).toBe(true);
    expect(first.mergedGroups).toBe(1);

    // Second invocation: marker row present → skip.
    const second = migrateCraftedToolDuplicates(rt.storage.sql, rt.storage.execRaw);
    expect(second.ranMigration).toBe(false);
    expect(second.mergedGroups).toBe(0);
    expect(second.rowsDeletedCraftedTools).toBe(0);
  });

  test('no-op when there are no duplicates', () => {
    const { rt } = createTestRuntime();
    initCraftScoreTables(rt.storage.execRaw);

    rt.craftStore.create({ name: 'unique', description: 'x', params: null, code: 'async () => 1', scope: 'local' });

    const r = migrateCraftedToolDuplicates(rt.storage.sql, rt.storage.execRaw);
    expect(r.ranMigration).toBe(true);  // marker written
    expect(r.mergedGroups).toBe(0);
    expect(r.rowsDeletedCraftedTools).toBe(0);
    expect(rt.craftStore.list().length).toBe(1);
  });
});
