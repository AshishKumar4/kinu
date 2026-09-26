// Every model call, the main actor's and its hire's, reaches the shared hire-fork fixture through the platform gateway.
import { expect, test } from 'bun:test';
import {
  HIRE_FORK_PARENT, HIRE_FORK_REQUEST, HIRE_FORK_PREFIX, HIRE_FORK_MISSION,
  hireForkModel, hireConversation,
  hireRetentionModel, HIRE_FORK_FOLLOWUP_REQUEST, HIRE_FORK_FOLLOWUP, HIRE_CHILD_CONTEXT,
} from '../../test-utils/src/hire-fork';
import { catalogTurn, GATEWAY_CATALOG, gatewayWorkspace, reactivateOrchestratorHarness } from './helpers/actor-harness';
import { modelGateway } from './helpers/platform-gateway';
import { joinHarnessFibers } from './helpers/agents-sdk';

for (const context of ['inherit', 'fresh', undefined] as const) {
  test(`a cf hire context=${String(context)} starts from its birth-time conversation`, async () => {
    const { model, childRequests } = hireForkModel(context);
    const { agent } = gatewayWorkspace(modelGateway(model));
    await agent.onStart();

    await catalogTurn(agent, HIRE_FORK_PARENT);
    await catalogTurn(agent, HIRE_FORK_REQUEST);
    expect(model.doGenerateCalls.flatMap(hireConversation)).toContainEqual(HIRE_FORK_PREFIX[2]);
    await agent.terminalRetryPass();
    await joinHarnessFibers();
    expect(childRequests).toHaveLength(1);
    const first = childRequests[0];

    if (!first) throw new Error('The hired child never reached its model.');
    const conversation = hireConversation(first);

    if (context === 'inherit') {
      expect(conversation.slice(0, 3)).toEqual(HIRE_FORK_PREFIX);
      expect(conversation[3]).toEqual({ role: 'user', content: HIRE_FORK_MISSION });
    } else {
      expect(conversation[0]).toEqual({ role: 'user', content: HIRE_FORK_MISSION });
      expect(conversation).not.toContainEqual(HIRE_FORK_PREFIX[1]);
    }
  });
}

for (const cold of [false, true]) {
  test(`a cf durable hire retains its working conversation on a later assignment, cold=${cold}`, async () => {
    const { model, childRequests } = hireRetentionModel();
    const gateway = modelGateway(model);
    const initial = gatewayWorkspace(gateway);
    await initial.agent.onStart();

    await catalogTurn(initial.agent, HIRE_FORK_PARENT);
    await catalogTurn(initial.agent, HIRE_FORK_REQUEST);
    await initial.agent.terminalRetryPass();
    await joinHarnessFibers();
    expect(childRequests).toHaveLength(2);
    const first = childRequests[1];

    if (!first) throw new Error('The first child turn did not consume its tool response.');
    const tool = first.prompt.find((message) => message.role === 'tool');

    if (!tool) throw new Error('The first child turn has no tool response.');
    expect(tool).toMatchObject({ content: [{ toolName: 'memory', output: {
      type: 'json', value: { ok: true, key: 'child-only-tool-context' },
    } }] });

    const { agent } = cold
      ? await reactivateOrchestratorHarness(initial.db, undefined, {
        world: { aiGateway: gateway },
        beforeStart: (restarted) => { restarted.harnessInstallCatalog(GATEWAY_CATALOG); },
      })
      : initial;

    if (cold) await agent.onStart();
    await catalogTurn(agent, HIRE_FORK_FOLLOWUP_REQUEST);
    await agent.terminalRetryPass();
    await joinHarnessFibers();
    const followup = childRequests[2];

    if (!followup) throw new Error('The second assignment never reached the child provider.');
    const conversation = hireConversation(followup);
    expect(conversation.slice(0, 3)).toEqual(HIRE_FORK_PREFIX);
    expect(conversation.filter((message) => message.content === HIRE_FORK_MISSION)).toHaveLength(1);
    expect(conversation).toContainEqual({ role: 'assistant', content: HIRE_CHILD_CONTEXT });
    expect(followup.prompt).toContainEqual(tool);
    const next = conversation.findIndex((message) => message.content.includes(HIRE_FORK_FOLLOWUP));
    expect(next).toBeGreaterThan(conversation.findIndex((message) => message.content === HIRE_CHILD_CONTEXT));
    expect(conversation.filter((message) => message.content.includes(HIRE_FORK_FOLLOWUP))).toHaveLength(1);
    await agent.terminalRetryPass();
    await joinHarnessFibers();
    expect(childRequests).toHaveLength(3);
  });
}
