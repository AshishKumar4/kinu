// An idle agent's opening reads the account (its settings revision, facts and MCP descriptors) as the delivery that opens
// its work crosses, ahead of the tile that admission moves. On deployed objects the owner's object answers nothing after
// that tile's write until the write is durable, so a read asked behind it waits out its flush (about 50 ms measured).
import { expect, test } from 'bun:test';
import { catalogTurn, gatewayWorkspace } from './helpers/actor-harness';
import { createTestUserDO, provisionTestWorkspace } from './helpers/user-do';
import { chatCompletion, stubAiBinding } from './helpers/platform-gateway';

const OWNER = 'abcdef0123456789abcdef0123456789';

test("an idle agent's turn opens on account reads its tile's write does not hold", async () => {
  const user = createTestUserDO({ durableObjectId: OWNER });
  const token = await provisionTestWorkspace(user, 'opening', 'Opening');
  const gateway = stubAiBinding((run) => chatCompletion(run, 'Noted.'));
  const workspace = gatewayWorkspace(gateway, { userDO: user.userDO, workspace: 'opening', ownerUserId: OWNER });
  const { userDO } = user;
  const put = userDO.putWorkspaceOverview.bind(userDO);
  const firstTile = Promise.withResolvers<void>();

  Object.assign(userDO, {
    putWorkspaceOverview: async (...args: Parameters<typeof put>) => {
      await put(...args);
      firstTile.resolve();
    },
  });
  workspace.agent.harnessHoldsCapability(token);
  await catalogTurn(workspace.agent, 'First.');
  // The first turn's tile has landed: its fold loads the slate host, at the object's first slate read, so the turn
  // below starts with nothing in flight, as an object past its first turn does.
  await firstTile.promise;

  // The owner's object as deployed, from here: a call that arrives after a tile was asked is answered only once that
  // tile's write is durable, which here it never is.
  const unflushed = Promise.withResolvers<void>();
  const asked: string[] = [];
  let tileAsked = false;

  const gated = <A extends unknown[], R>(name: string, call: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
    const behind = tileAsked;

    asked.push(name);
    const answer = await call(...args);

    if (behind) await unflushed.promise;

    return answer;
  };

  Object.assign(userDO, {
    putWorkspaceOverview: async (...args: Parameters<typeof put>) => {
      tileAsked = true;
      asked.push('putWorkspaceOverview');
      await put(...args);
    },
    getSettingsRevision: gated('getSettingsRevision', userDO.getSettingsRevision.bind(userDO)),
    accountMemory_facts: gated('accountMemory_facts', userDO.accountMemory_facts.bind(userDO)),
    userMcp_toolDescriptors: gated('userMcp_toolDescriptors', userDO.userMcp_toolDescriptors.bind(userDO)),
  });
  const runs = gateway.runs.length;

  await catalogTurn(workspace.agent, 'Second.');

  expect(gateway.runs.length).toBeGreaterThan(runs);
  expect(asked.indexOf('getSettingsRevision')).toBeLessThan(asked.indexOf('putWorkspaceOverview'));
  await user.joinFibers();
  user.close();
});
