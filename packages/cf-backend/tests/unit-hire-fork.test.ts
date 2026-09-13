import { expect, test } from 'bun:test';
import { createProviderRegistry } from '@kinu.run/core';
import {
  HIRE_FORK_PARENT, HIRE_FORK_REQUEST, HIRE_FORK_PREFIX, HIRE_FORK_MISSION,
  hireForkModel, hireConversation,
} from '../../test-utils/src/hire-fork';
import { orchestratorHarness } from './helpers/actor-harness';

for (const context of ['inherit', 'fresh', undefined] as const) {
  test(`a cf hire context=${String(context)} starts from its birth-time conversation`, async () => {
    const { agent } = orchestratorHarness();
    const { model, childRequests } = hireForkModel(context);
    agent.modelFactory = () => model;
    await agent.onStart();
    agent.overrideProviderRegistry({
      registry: createProviderRegistry(),
      deps: { env: {}, getAuth: async () => null, hasCredential: async () => false },
      resolveModel: () => model,
      normalizeSpecSync: (spec) => spec ?? 'test/model',
    });
    await agent.runTurn({ input: HIRE_FORK_PARENT });
    await agent.runTurn({ input: HIRE_FORK_REQUEST });
    expect(model.doStreamCalls.flatMap(hireConversation)).toContainEqual(HIRE_FORK_PREFIX[2]);
    await agent._kinuTerminalRetryTick();
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
