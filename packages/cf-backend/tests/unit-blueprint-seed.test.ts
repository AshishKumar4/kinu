/**
 * A workspace installed from a blueprint opens as the blueprint says (owner, 2026-10-20: the assistant's Home read
 * "Main", in the workbench layout). Its main chat goes by the agent's name in the workspace's agents list, and its
 * status carries the layout its page draws, whichever isolate answers the read.
 */
import { describe, expect, setSystemTime, test } from 'bun:test';
import { fireSoonestWake, gatewayWorkspace, orchestratorHarness, until } from './helpers/actor-harness';
import { joinHarnessFibers } from './helpers/agents-sdk';
import { answeringGateway, openingOf } from './helpers/platform-gateway';

describe("a blueprint's seed", () => {
  test("names the main chat and sets the layout the workspace's reads answer", async () => {
    const { agent } = orchestratorHarness();

    await agent.setSoul('# Personal assistant\n\n## Mission\n\nBrief Ashish each morning.\n');
    await agent.seedBlueprint({ blueprint: 'personal-assistant', layout: 'focus', agent: 'Kinu', schedules: [] });

    expect((await agent.getAgentStatus()).layout).toBe('focus');
    expect((await agent.listWorkspaceAgents()).find((each) => each.category === 'main')?.label).toBe('Kinu');
    expect((await agent.getWorkspaceSnapshot()).status.layout).toBe('focus');
  });

  // The rc27 review: the woken turn read the schedule's title alone ("schedule (GitHub check): GitHub check").
  test('a schedule it seeds wakes the main agent with the schedule\'s prompt, not only its title', async () => {
    const gateway = answeringGateway('Nothing needs Ashish.');
    const workspace = gatewayWorkspace(gateway);
    const task = 'Check GitHub with your GitHub tools for reviews requested of Ashish since your last check.';

    await workspace.agent.activateActor();
    await workspace.agent.seedBlueprint({ blueprint: 'personal-assistant', layout: 'focus', agent: 'Kinu', schedules: [{ label: 'GitHub check', cron: '*/15 * * * *', prompt: task }] });
    setSystemTime(new Date(Date.now() + 16 * 60_000));

    try {
      await fireSoonestWake(workspace.agent, workspace.db);
      await until(() => gateway.runs.length > 0, 'the woken turn reached its model');
      await joinHarnessFibers();
    } finally {
      setSystemTime();
    }

    expect(gateway.runs.map(openingOf).join('\n')).toContain(task);
  });
});
