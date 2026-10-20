/**
 * A workspace installed from a blueprint opens as the blueprint says (owner, 2026-10-20: the assistant's Home read
 * "Main", in the workbench layout). Its main chat goes by the agent's name in the workspace's agents list, and its
 * status carries the layout its page draws, whichever isolate answers the read.
 */
import { describe, expect, test } from 'bun:test';
import { orchestratorHarness } from './helpers/actor-harness';

describe("a blueprint's seed", () => {
  test("names the main chat and sets the layout the workspace's reads answer", async () => {
    const { agent } = orchestratorHarness();

    await agent.setSoul('# Personal assistant\n\n## Mission\n\nBrief Ashish each morning.\n');
    await agent.seedBlueprint({ blueprint: 'personal-assistant', layout: 'focus', agent: 'Kinu', schedules: [] });

    expect((await agent.getAgentStatus()).layout).toBe('focus');
    expect((await agent.listWorkspaceAgents()).find((each) => each.category === 'main')?.label).toBe('Kinu');
    expect((await agent.getWorkspaceSnapshot()).status.layout).toBe('focus');
  });
});
