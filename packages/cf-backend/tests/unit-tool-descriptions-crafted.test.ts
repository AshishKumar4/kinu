/** GitHub #5: with one crafted tool, `getToolDescriptions` filtered `crafted_tools` by `actor_id`, a column that
 *  workspace-wide table never had, so every workspace open failed. */
import { describe, expect, test } from 'bun:test';
import { orchestratorHarness } from './helpers/actor-harness';

describe('getToolDescriptions over a workspace that holds a crafted tool', () => {
  test('reads the crafted quality row by name and does not throw', async () => {
    const { agent, db } = orchestratorHarness();
    db.prepare(
      'INSERT INTO crafted_tools (name, description, params, code, scope, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?)',
    ).run('greet', 'says hello', 'return "hi"', 'local', 1, 1);
    const described = await agent.getToolDescriptions();
    const crafted = described.crafted.find((t) => t.name === 'greet');
    expect(crafted).toMatchObject({ isLearned: true, exposure: 'codemode', wired: true, usageCount: 0 });
    expect(crafted?.qualityScore).toBeGreaterThanOrEqual(0);
  });
});
