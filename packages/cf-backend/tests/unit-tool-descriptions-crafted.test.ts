/**
 * GitHub #5: every workspace open failed with `no such column: actor_id`.
 * `getToolDescriptions` is one of the reads the UI's open runs, and once a
 * workspace held ONE crafted tool the quality lookup filtered `crafted_tools`
 * by `actor_id`, a column that table has never had (it is workspace-wide by
 * design). The actor cutover `f9c0b3847` introduced the predicate. The UI
 * folds any rejected open read into "Couldn't open this workspace", so a
 * single crafted tool made the workspace look broken.
 */
import { describe, expect, test } from 'bun:test';
import { orchestratorHarness } from './helpers/actor-harness';

describe('getToolDescriptions over a workspace that holds a crafted tool', () => {
  test('reads the crafted quality row by name and does not throw', async () => {
    const { agent, db } = orchestratorHarness();
    // The row as the store writes it, through the production DDL: no actor_id.
    db.prepare(
      'INSERT INTO crafted_tools (name, description, params, code, scope, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?)',
    ).run('greet', 'says hello', 'return "hi"', 'local', 1, 1);
    const described = await agent.getToolDescriptions();
    const crafted = described.crafted.find((t) => t.name === 'greet');
    expect(crafted).toMatchObject({ isLearned: true, exposure: 'codemode', wired: true, usageCount: 0 });
    expect(crafted?.qualityScore).toBeGreaterThanOrEqual(0);
  });
});
