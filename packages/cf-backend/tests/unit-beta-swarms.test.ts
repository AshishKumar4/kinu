/**
 * "Beta: swarms" on the cf backend: the account's catalog decides whether a turn's `agents` tool offers `swarm`, read
 * before the toolset is built (the CLI's twin is cli-backend/tests/beta-swarms.test.ts).
 */
import { describe, expect, test } from 'bun:test';
import { asSchema, type ToolSet } from 'ai';
import * as v from 'valibot';
import { toolExecute } from '@kinu.run/test-utils';
import { chatSessionTurns, jobsOver, orchestratorHarness } from './helpers/actor-harness';

function agentsActions(tools: ToolSet): readonly string[] {
  const agents = tools.agents;

  if (agents === undefined) throw new Error('the turn offered no agents tool');
  const schema = v.parse(v.object({ properties: v.object({ action: v.object({ enum: v.array(v.string()) }) }) }), asSchema(agents.inputSchema).jsonSchema);

  return schema.properties.action.enum;
}

async function turnTools(betaSwarms: boolean): Promise<ToolSet> {
  const { agent } = orchestratorHarness();
  agent.harnessInstallCatalog({ betaSwarms });
  await agent.activateActor();
  await chatSessionTurns(agent).prepare({ messages: [{ role: 'user', content: 'compare three caching designs' }] });

  return agent.harnessPreparedTools();
}

describe('a turn offers swarm only when the account turned the beta on', () => {
  test('off: no swarm in the tool, and a swarm call is refused naming the setting', async () => {
    const tools = await turnTools(false);

    expect(agentsActions(tools)).not.toContain('swarm');
    await expect(toolExecute<{ op: string; task: string }, unknown>(tools.agents)({ op: 'swarm', task: 'rank them' }))
      .rejects.toMatchObject({ code: 'denied', message: expect.stringContaining('"Beta: swarms"') });
  });

  test('on: the tool offers swarm', async () => {
    expect(agentsActions(await turnTools(true))).toContain('swarm');
  });
});

describe('a retried swarm job reads the setting as it stands, not as the toolset was last built', () => {
  test('turned off since the last turn, with no settings notification delivered, the retry is refused naming it', async () => {
    const { agent, db } = orchestratorHarness();
    agent.harnessInstallCatalog({ betaSwarms: true });
    await agent.activateActor();
    await chatSessionTurns(agent).prepare({ messages: [{ role: 'user', content: 'compare three caching designs' }] });

    // The account turns it off; the fan-out that would tell this object is lost.
    agent.harnessInstallCatalog({ betaSwarms: false });
    const jobs = jobsOver(db);
    jobs.create({ id: 'bgjob-swarm', kind: 'agents', workMode: 'build', now: Date.now(), label: 'swarm: rank designs', input: JSON.stringify({ op: 'swarm', task: 'rank them', preset: 'ideate' }) });
    jobs.fail('bgjob-swarm', 0, 'the first run was interrupted', Date.now());

    const retried = await agent.retryBackgroundJob('bgjob-swarm');
    await agent.harnessJoinDetachedFibers();

    expect(jobs.get(retried.jobId ?? '')).toMatchObject({ status: 'failed', error: expect.stringContaining('"Beta: swarms"') });
  });
});
