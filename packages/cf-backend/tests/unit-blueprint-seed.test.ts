/**
 * A workspace installed from a blueprint opens as the blueprint says (owner, 2026-10-20: the assistant's Home read
 * "Main", in the workbench layout). Its main chat goes by the agent's name in the workspace's agents list, and its
 * status carries the layout its page draws, whichever isolate answers the read.
 */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { orchestratorHarness } from './helpers/actor-harness';

describe("a blueprint's seed", () => {
  test("names the main chat and sets the layout the workspace's reads answer", async () => {
    const { agent } = orchestratorHarness();

    await agent.setSoul('# Personal assistant\n\n## Mission\n\nBrief Ashish each morning.\n');
    await agent.seedBlueprint({ blueprint: 'personal-assistant', layout: 'focus', agent: 'Kinu', schedules: [], connected: [] });

    expect((await agent.getAgentStatus()).layout).toBe('focus');
    expect((await agent.listWorkspaceAgents()).find((each) => each.category === 'main')?.label).toBe('Kinu');
    expect((await agent.getWorkspaceSnapshot()).status.layout).toBe('focus');
  });

  // The rc27 review: the assistant's GitHub and Gmail checks were armed at install without either connected, each a
  // turn every 15 minutes that found nothing (192 a day).
  test('arms a check of a connection only while the owner holds it, and keeps the rest of the seed as it is', async () => {
    const { agent } = orchestratorHarness();
    const schedule = (label: string, connection?: string) => ({ label, cron: '*/15 * * * *', ...(connection !== undefined && { connection }), prompt: `Run the ${label}.` });

    const armed = async () => (await agent.listTriggers()).triggers
      .filter((trigger) => trigger.state === 'active').map((trigger) => v.parse(v.object({ label: v.string() }), trigger.spec).label).sort();

    await agent.seedBlueprint({
      blueprint: 'personal-assistant', layout: 'focus', agent: 'Kinu', connected: ['google'],
      schedules: [schedule('Daily brief'), schedule('GitHub check', 'github'), schedule('Gmail check', 'google')],
    });
    expect(await armed()).toEqual(['Daily brief', 'Gmail check']);

    await agent.connectionsChanged(['google', 'github']);
    await agent.connectionsChanged(['google', 'github']);
    expect(await armed()).toEqual(['Daily brief', 'GitHub check', 'Gmail check']);

    await agent.connectionsChanged([]);
    expect(await armed()).toEqual(['Daily brief']);
  });
});
